import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { HttpError, cleanId, Purchase } from "./engine";
import type { Credentials } from "./store";
import {
  db, getProject, createProject, customerInfo, mergeCustomers, touchCustomer, resolveKey, issueKey, revokeProjectKeys,
  upsertPurchase, Project, ProjectConfig, getCredentials, KeyRecord, DEFAULT_CONFIG,
} from "./store";
import { ingestAppleTransaction, ingestAppleNotification } from "./apple";
import { ingestGooglePurchase, ingestGoogleNotification } from "./google";
import { ingestStripeWebhook, createCheckout, createPortal } from "./stripe";
import { projectMetrics, projectCohorts } from "./metrics";
import { connectStripe, connectAppStore, connectGooglePlay, markConnected } from "./connect";
import { sanitizeIntegrations } from "./integrations";
import { toRevenueCatSubscriber, promotionalDays } from "./rccompat";
import { searchApps, syncTrackers, translateReview, lookupApp, TrackedApp } from "./appstore";

/** Public base URL used in store webhook endpoints (stable, behind Firebase Hosting). */
export const PUBLIC_BASE = process.env.MONEYMAKER_PUBLIC_BASE ?? "https://moneymaker-io.web.app";

type Caller =
  | { kind: "public"; projectId: string }
  | { kind: "secret"; projectId: string }
  | { kind: "user"; uid: string; email?: string; emailVerified?: boolean };

async function authenticate(req: Request): Promise<Caller> {
  const header = req.get("authorization") ?? "";
  const raw = header.replace(/^Bearer\s+/i, "").trim();
  if (!raw) throw new HttpError(401, "missing_api_key");
  if (raw.startsWith("mm_")) {
    const rec: KeyRecord | null = await resolveKey(raw);
    if (!rec) throw new HttpError(401, "invalid_api_key");
    if (rec.kind === "pat") return { kind: "user", uid: rec.uid! };
    return { kind: rec.kind, projectId: rec.projectId! };
  }
  try {
    const decoded = await getAuth().verifyIdToken(raw);
    return { kind: "user", uid: decoded.uid, email: decoded.email, emailVerified: decoded.email_verified };
  } catch {
    throw new HttpError(401, "invalid_token");
  }
}

async function projectFor(caller: Caller, pid: string, allowPublic = false): Promise<Project> {
  const project = await getProject(cleanId(pid));
  if (caller.kind === "user" && project.members.includes(caller.uid)) return project;
  if (caller.kind === "secret" && caller.projectId === project.id) return project;
  if (allowPublic && caller.kind === "public" && caller.projectId === project.id) return project;
  throw new HttpError(403, "forbidden");
}

/** Projects provisioned server-side for an email are attached on the owner's first verified sign-in. */
async function claimPendingProjects(caller: Caller) {
  if (caller.kind !== "user" || !caller.email || !caller.emailVerified) return;
  const pending = await db.collection("projects").where("pendingOwnerEmail", "==", caller.email.toLowerCase()).get();
  await Promise.all(pending.docs.map(d => d.ref.update({
    members: FieldValue.arrayUnion(caller.uid), ownerUid: caller.uid, pendingOwnerEmail: FieldValue.delete(),
  })));
}

function requireUser(caller: Caller) {
  if (caller.kind !== "user") throw new HttpError(403, "user_token_required", "Use a dashboard session or a personal access token (mm_pat_…)");
  return caller.uid;
}

function sanitizeConfig(input: any, current: ProjectConfig): ProjectConfig {
  const next: ProjectConfig = { ...DEFAULT_CONFIG, ...current };
  if (input.currency !== undefined) {
    if (!/^[A-Z]{3}$/.test(input.currency)) throw new HttpError(400, "invalid_currency");
    next.currency = input.currency;
  }
  if (input.entitlements !== undefined) {
    if (typeof input.entitlements !== "object") throw new HttpError(400, "invalid_entitlements");
    next.entitlements = Object.fromEntries(Object.entries(input.entitlements).map(([k, v]) => {
      if (!Array.isArray(v)) throw new HttpError(400, "invalid_entitlements");
      return [cleanId(k, 64), v.map(x => cleanId(x, 200))];
    }));
  }
  if (input.offerings !== undefined) next.offerings = input.offerings;
  if (input.currentOffering !== undefined) next.currentOffering = input.currentOffering;
  if (input.webhooks !== undefined) {
    if (!Array.isArray(input.webhooks) || input.webhooks.length > 10) throw new HttpError(400, "invalid_webhooks");
    next.webhooks = input.webhooks.map((w: any, i: number) => {
      if (typeof w.url !== "string" || !/^https:\/\//.test(w.url)) throw new HttpError(400, "webhook_must_be_https");
      const format = w.format === "revenuecat" ? "revenuecat" : undefined;
      return { id: String(w.id ?? `wh_${i}`), url: w.url, ...(format ? { format } : {}), ...(Array.isArray(w.events) ? { events: w.events.map(String) } : {}) };
    });
  }
  if (input.apple !== undefined) next.apple = {
    bundleId: input.apple.bundleId ? cleanId(input.apple.bundleId, 200) : undefined,
    appAppleId: input.apple.appAppleId ? Number(input.apple.appAppleId) : undefined,
    ...(input.apple.vendorNumber ? { vendorNumber: (() => { const v = String(input.apple.vendorNumber).trim(); if (!/^\d{6,12}$/.test(v)) throw new HttpError(400, "invalid_vendor_number"); return v; })() } : {}),
  } as any;
  if (input.google !== undefined) next.google = { packageName: input.google.packageName ? cleanId(input.google.packageName, 200) : undefined };
  if (input.integrations !== undefined) {
    const af = input.integrations?.appsflyer;
    next.integrations = af ? { appsflyer: { appId: cleanId(af.appId, 64), ...(af.androidAppId ? { androidAppId: cleanId(af.androidAppId, 200) } : {}) } } : {};
  }
  if (input.website !== undefined) {
    if (input.website === null || input.website === "") delete (next as any).website;
    else {
      const w = String(input.website).trim();
      if (!/^https:\/\/[^\s]+$/.test(w)) throw new HttpError(400, "invalid_website", "URL https:// attendue");
      (next as any).website = w;
    }
  }
  if (input.mode !== undefined) {
    if (!["subscriptions", "rankings"].includes(input.mode)) throw new HttpError(400, "invalid_mode");
    (next as any).mode = input.mode;
  }
  if (input.stripe !== undefined) next.stripe = { enabled: Boolean(input.stripe.enabled), prices: input.stripe.prices };
  if (JSON.stringify(next).length > 200000) throw new HttpError(400, "config_too_large");
  return next;
}

function offeringsFor(project: Project) {
  const { offerings, currentOffering } = project.config;
  return { current: currentOffering ?? Object.keys(offerings)[0] ?? null, offerings };
}

type Handler = (req: Request, res: Response, params: string[]) => Promise<unknown>;
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, pattern: string, handler: Handler) =>
  routes.push([method, new RegExp("^" + pattern.replace(/:[a-zA-Z]+/g, "([^/]+)") + "/?$"), handler]);

// ── Health ─────────────────────────────────────────────────────────────────
route("GET", "/v1/health", async () => ({ ok: true, service: "moneymaker", time: Date.now() }));

// ── Store webhooks (no API key: authenticated by store signatures) ─────────
/** Remembers the last successful delivery per source: drives the setup checklist ("is it really wired?"). */
const markHealth = (pid: string, source: string, extra: Record<string, unknown> = {}) =>
  db.doc(`projects/${pid}`).set({ health: { [source]: { lastAt: Date.now(), ...extra } } }, { merge: true }).catch(() => null);

route("POST", "/v1/webhooks/apple/:pid", async (req, _res, [pid]) => {
  const project = await getProject(cleanId(pid));
  const r = await ingestAppleNotification(project, req.body?.signedPayload);
  await markHealth(project.id, "appleNotifications", { type: String((r as any).notificationType ?? "") });
  return r;
});

route("POST", "/v1/webhooks/google/:pid", async (req, _res, [pid]) => {
  const project = await getProject(cleanId(pid));
  const creds = await getCredentials(project.id);
  if (req.query.token !== creds.googleRtdnToken) throw new HttpError(401, "invalid_rtdn_token");
  const r = await ingestGoogleNotification(project, req.body);
  await markHealth(project.id, "googleNotifications");
  return r;
});

route("POST", "/v1/webhooks/stripe/:pid", async (req, _res, [pid]) => {
  const project = await getProject(cleanId(pid));
  const r = await ingestStripeWebhook(project, req.rawBody, req.get("stripe-signature"));
  await markHealth(project.id, "stripeWebhook");
  return r;
});

// ── Client SDK (public key) ────────────────────────────────────────────────
const sdkSeen = new Map<string, number>();
async function clientProject(req: Request) {
  const caller = await authenticate(req);
  if (caller.kind === "user") throw new HttpError(403, "project_key_required");
  const project = await getProject(caller.projectId);
  if (caller.kind === "public" && Date.now() - (sdkSeen.get(project.id) ?? 0) > 600000) {
    sdkSeen.set(project.id, Date.now());
    const ua = String(req.get("user-agent") ?? "");
    await markHealth(project.id, "sdk", { platform: /Android/i.test(ua) ? "android" : /iOS|CFNetwork|Darwin/i.test(ua) ? "ios" : "web" });
  }
  return project;
}

route("GET", "/v1/offerings", async req => offeringsFor(await clientProject(req)));

route("GET", "/v1/customers/:id", async (req, _res, [id]) => {
  const project = await clientProject(req);
  const appUserId = cleanId(decodeURIComponent(id));
  await touchCustomer(project.id, appUserId);
  return customerInfo(project, appUserId);
});

route("POST", "/v1/customers/:id/apple", async (req, _res, [id]) => {
  const project = await clientProject(req);
  const r = await ingestAppleTransaction(project, cleanId(decodeURIComponent(id)), req.body?.signedTransaction, req.body?.signedRenewalInfo);
  return customerInfo(project, r.appUserId);
});

route("POST", "/v1/customers/:id/google", async (req, _res, [id]) => {
  const project = await clientProject(req);
  const r = await ingestGooglePurchase(project, cleanId(decodeURIComponent(id)), req.body);
  return customerInfo(project, r.appUserId);
});

route("POST", "/v1/customers/:id/alias", async (req, _res, [id]) => {
  const project = await clientProject(req);
  const from = cleanId(decodeURIComponent(id)), to = cleanId(req.body?.newAppUserId);
  await mergeCustomers(project, from, to);
  await touchCustomer(project.id, to);
  return customerInfo(project, to);
});

route("POST", "/v1/customers/:id/attributes", async (req, _res, [id]) => {
  const project = await clientProject(req);
  const appUserId = cleanId(decodeURIComponent(id));
  const attrs = req.body?.attributes ?? {};
  if (typeof attrs !== "object" || Object.keys(attrs).length > 50) throw new HttpError(400, "invalid_attributes");
  const clean = Object.fromEntries(Object.entries(attrs).map(([k, v]) => [cleanId(k, 64), v === null ? FieldValue.delete() : String(v).slice(0, 500)]));
  await db.doc(`projects/${project.id}/customers/${appUserId}`).set({ attributes: clean, lastSeenAt: Date.now() }, { merge: true });
  return { ok: true };
});

route("POST", "/v1/customers/:id/stripe/checkout", async (req, _res, [id]) =>
  createCheckout(await clientProject(req), cleanId(decodeURIComponent(id)), req.body));

route("POST", "/v1/customers/:id/stripe/portal", async (req, _res, [id]) =>
  createPortal(await clientProject(req), cleanId(decodeURIComponent(id)), String(req.body?.returnUrl ?? "")));

// ── Account (dashboard session or personal access token) ──────────────────
route("GET", "/v1/projects", async req => {
  const caller = await authenticate(req);
  const uid = requireUser(caller);
  await claimPendingProjects(caller);
  const snap = await db.collection("projects").where("members", "array-contains", uid).get();
  return { projects: snap.docs.map(d => ({ id: d.id, name: d.get("name"), config: d.get("config") })) };
});

route("POST", "/v1/projects", async req => {
  const uid = requireUser(await authenticate(req));
  const name = String(req.body?.name ?? "").trim().slice(0, 80);
  if (!name) throw new HttpError(400, "name_required");
  const created = await createProject(name, uid);
  const project = await getProject(created.projectId);
  let config = req.body?.config ? sanitizeConfig(req.body.config, project.config) : project.config;
  // Pre-fill from the App Store listing: bundle id, Apple ID, ranking tracking.
  const appStoreAppId = req.body?.appStoreAppId ? String(req.body.appStoreAppId) : null;
  if (appStoreAppId && /^\d{5,12}$/.test(appStoreAppId)) {
    const app = await lookupApp(appStoreAppId, "fr").catch(() => null) ?? await lookupApp(appStoreAppId, "us").catch(() => null);
    if (app) {
      config = { ...config, apple: { bundleId: app.bundleId, appAppleId: Number(app.appId) }, appStore: { apps: [{ appId: app.appId, own: true }] } };
      await syncTrackers(project.id, config.appStore!.apps);
      await db.collection("scanRequests").add({ appIds: [app.appId], at: Date.now() });
    }
  }
  if (req.body?.googlePackageName) config = { ...config, google: { packageName: cleanId(req.body.googlePackageName, 200) } };
  await db.doc(`projects/${project.id}`).update({ config });
  return { ...created, note: "Store the secret key now: it is never shown again." };
});

route("POST", "/v1/tokens", async req => {
  const uid = requireUser(await authenticate(req));
  return { token: await issueKey({ kind: "pat", uid, label: String(req.body?.label ?? "token").slice(0, 60) }) };
});

route("GET", "/v1/overview", async req => {
  const uid = requireUser(await authenticate(req));
  const days = Math.min(365, Math.max(1, Number(req.query.days ?? 30)));
  const snap = await db.collection("projects").where("members", "array-contains", uid).get();
  const projects = await Promise.all(snap.docs.map(async d => {
    const pr = await getProject(d.id);
    const m = await projectMetrics(pr, days);
    // Logo hébergé par MoneyMaker (icons.ts) : toujours un PNG 256 px lisible par l'app, versionné.
    const v = d.get("iconVersion") as number | null | undefined;
    return { ...m, iconUrl: v ? `${PUBLIC_BASE}/v1/icons/${d.id}?v=${v}` : null };
  }));
  const currency = String(req.query.currency ?? projects[0]?.currency ?? "EUR");
  const { convertMicros } = await import("./engine");
  const sum = (f: (p: typeof projects[number]) => number) => projects.reduce((a, p) => a + convertMicros(f(p), p.currency, currency), 0);
  return {
    currency, periodDays: days,
    mrrMicros: sum(p => p.mrrMicros), revenueMicros: sum(p => p.netRevenueMicros),
    activeSubscriptions: projects.reduce((a, p) => a + p.activeSubscriptions, 0),
    activeTrials: projects.reduce((a, p) => a + p.activeTrials, 0),
    newCustomers: projects.reduce((a, p) => a + p.newCustomers, 0),
    payingCustomers: projects.reduce((a, p) => a + p.payingCustomers, 0),
    downloads: projects.some(p => p.downloads !== null) ? projects.reduce((a, p) => a + (p.downloads ?? 0), 0) : null,
    hasTrials: projects.some(p => p.hasTrials),
    projects: projects.map(({ history, revenueByDay, downloadsByDay, ...p }) => ({
      projectId: p.projectId, name: p.name, currency: p.currency, mrrMicros: p.mrrMicros, netRevenueMicros: p.netRevenueMicros,
      activeSubscriptions: p.activeSubscriptions, activeTrials: p.activeTrials, newCustomers: p.newCustomers, trialConversionRate: p.trialConversionRate,
      churnRate: p.churnRate, billingIssues: p.billingIssues, payingCustomers: p.payingCustomers, downloads: p.downloads,
      hasTrials: p.hasTrials, revenueByCountry: p.revenueByCountry, iconUrl: p.iconUrl, downloadsByDay, revenueByDay,
    })),
    generatedAt: Date.now(),
  };
});

// ── Project management (secret key or member) ──────────────────────────────
route("GET", "/v1/projects/:pid", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  const creds = await getCredentials(project.id);
  const base = PUBLIC_BASE;
  return {
    ...project,
    credentials: { integrations: Object.keys(creds.integrations ?? {}), appStoreConnect: Boolean(creds.appStoreConnect), appsflyer: Boolean(creds.appsflyer), apple: Boolean(creds.apple), google: Boolean(creds.google), stripeKey: Boolean(creds.stripe?.secretKey), stripeWebhook: Boolean(creds.stripe?.webhookSecret) },
    endpoints: {
      appleNotifications: `${base}/v1/webhooks/apple/${project.id}`,
      googleRtdn: `${base}/v1/webhooks/google/${project.id}?token=${creds.googleRtdnToken}`,
      stripeWebhook: `${base}/v1/webhooks/stripe/${project.id}`,
    },
    webhookSigningSecret: creds.webhookSigningSecret,
  };
});

route("PATCH", "/v1/projects/:pid", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  const config = sanitizeConfig(req.body?.config ?? {}, project.config);
  const update: Record<string, unknown> = { config };
  if (typeof req.body?.name === "string" && req.body.name.trim()) update.name = req.body.name.trim().slice(0, 80);
  await db.doc(`projects/${project.id}`).update(update);
  return { ...project, ...update };
});

route("PUT", "/v1/projects/:pid/credentials", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  const b = req.body ?? {};
  const update: Record<string, unknown> = {};
  if (b.apple) {
    const { issuerId, keyId, privateKey } = b.apple;
    if (!issuerId || !keyId || !/BEGIN PRIVATE KEY/.test(String(privateKey))) throw new HttpError(400, "invalid_apple_credentials");
    update.apple = { issuerId: String(issuerId), keyId: String(keyId), privateKey: String(privateKey) };
  }
  if (b.google) {
    const sa = typeof b.google.serviceAccount === "string" ? JSON.parse(b.google.serviceAccount) : b.google.serviceAccount;
    if (!sa?.client_email || !sa?.private_key) throw new HttpError(400, "invalid_service_account");
    update.google = { serviceAccount: { client_email: sa.client_email, private_key: sa.private_key } };
  }
  if (b.webhookAuthorization) {
    // Authorization header values for outgoing webhooks, per webhook id (e.g. a RevenueCat-format receiver's Bearer secret).
    if (typeof b.webhookAuthorization !== "object") throw new HttpError(400, "invalid_webhook_authorization");
    const current = (await getCredentials(project.id)) as any;
    const next = { ...(current.webhookAuthorization ?? {}) };
    for (const [id, v] of Object.entries(b.webhookAuthorization)) { if (v === null) delete next[id]; else next[cleanId(id, 64)] = String(v).slice(0, 500); }
    update.webhookAuthorization = next;
  }
  if (b.integrations) {
    try { update.integrations = sanitizeIntegrations(b.integrations, (await getCredentials(project.id)).integrations); }
    catch (e) { throw new HttpError(400, (e as Error).message); }
  }
  if (b.appsflyer) {
    if (typeof b.appsflyer.devKey !== "string" || b.appsflyer.devKey.length < 10) throw new HttpError(400, "invalid_appsflyer_dev_key");
    update.appsflyer = { devKey: b.appsflyer.devKey };
  }
  if (b.stripe) {
    const s: Record<string, string> = {};
    if (b.stripe.secretKey) { if (!/^(sk|rk)_(live|test)_/.test(b.stripe.secretKey)) throw new HttpError(400, "invalid_stripe_key"); s.secretKey = b.stripe.secretKey; }
    if (b.stripe.webhookSecret) { if (!/^whsec_/.test(b.stripe.webhookSecret)) throw new HttpError(400, "invalid_stripe_webhook_secret"); s.webhookSecret = b.stripe.webhookSecret; }
    const current = (await getCredentials(project.id)).stripe ?? {};
    update.stripe = { ...current, ...s };
  }
  await db.doc(`projects/${project.id}/private/credentials`).set(update, { merge: true });
  return { ok: true, updated: Object.keys(update) };
});

route("POST", "/v1/projects/:pid/keys", async (req, _res, [pid]) => {
  const caller = await authenticate(req);
  const project = await projectFor(caller, pid);
  const kind = req.body?.kind === "public" ? "public" : "secret";
  if (req.body?.revokeExisting) await revokeProjectKeys(project.id, kind);
  return { kind, key: await issueKey({ kind, projectId: project.id }) };
});

route("GET", "/v1/projects/:pid/metrics", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  return projectMetrics(project, Math.min(365, Math.max(1, Number(req.query.days ?? 30))));
});

route("GET", "/v1/projects/:pid/customers", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  let q = db.collection(`projects/${project.id}/customers`).orderBy("lastSeenAt", "desc").limit(Math.min(200, Number(req.query.limit ?? 50)));
  if (req.query.paying === "true") q = q.where("isPaying", "==", true);
  if (req.query.after) q = q.startAfter(Number(req.query.after));
  const snap = await q.get();
  return { customers: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
});

route("GET", "/v1/projects/:pid/customers/:id", async (req, _res, [pid, id]) => {
  const project = await projectFor(await authenticate(req), pid);
  const appUserId = cleanId(decodeURIComponent(id));
  const [info, events] = await Promise.all([
    customerInfo(project, appUserId),
    db.collection(`projects/${project.id}/events`).where("appUserId", "==", appUserId).orderBy("at", "desc").limit(100).get(),
  ]);
  return { ...info, events: events.docs.map(d => ({ id: d.id, ...d.data() })) };
});

route("POST", "/v1/projects/:pid/customers/:id/grant", async (req, _res, [pid, id]) => {
  const project = await projectFor(await authenticate(req), pid);
  const appUserId = cleanId(decodeURIComponent(id));
  const entitlement = cleanId(req.body?.entitlement, 64);
  const days = req.body?.days === undefined ? null : Number(req.body.days);
  const now = Date.now();
  const purchase: Purchase = {
    id: `promo_${entitlement}`, store: "promotional", productId: `promo:${entitlement}`, type: "non_consumable",
    status: days === 0 ? "revoked" : "active", purchasedAt: now, latestPurchaseAt: now,
    expiresAt: days === null ? null : now + days * 86400000, willRenew: false, isTrial: false, isSandbox: false,
    priceMicros: 0, currency: project.config.currency, periodMonths: 0, billingIssue: false, updatedAt: now,
  };
  await upsertPurchase(project, appUserId, purchase);
  return customerInfo(project, appUserId);
});

route("GET", "/v1/projects/:pid/events", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  let q = db.collection(`projects/${project.id}/events`).orderBy("at", "desc").limit(Math.min(500, Number(req.query.limit ?? 100)));
  if (req.query.before) q = q.startAfter(Number(req.query.before));
  const snap = await q.get();
  return { events: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
});

route("GET", "/v1/projects/:pid/transactions", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  const snap = await db.collection(`projects/${project.id}/transactions`).orderBy("at", "desc").limit(Math.min(500, Number(req.query.limit ?? 100))).get();
  return { transactions: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
});

route("POST", "/v1/projects/:pid/webhooks/test", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  const ref = await db.collection(`projects/${project.id}/events`).add({
    type: "TEST", appUserId: "test_user", productId: "test_product", store: "promotional", at: Date.now(), isSandbox: true, delivered: false,
  });
  return { eventId: ref.id };
});

// ── Setup checklist (auto-detected) ────────────────────────────────────────
export function setupSteps(project: any, creds: Credentials, counts: { customers: number; purchases: number }) {
  const h = project.health ?? {}, c = project.config ?? {};
  const apple = Boolean(c.apple?.bundleId), google = Boolean(c.google?.packageName), stripe = Boolean(creds.stripe?.secretKey);
  const steps = [
    { id: "products", group: "Base", title: "Définir l'accès premium et ses produits", done: Object.values(c.entitlements ?? {}).some((v: any) => v.length), tab: "products",
      help: "Liste les identifiants produits (App Store, Play, Stripe) qui débloquent l'accès. Connecter App Store Connect ou Google Play les importe automatiquement." },
    // Le SDK est la librairie iOS/Android : sans app (business 100 % Stripe sur le web), l'étape ne s'applique pas.
    { id: "sdk", group: "Base", title: "Brancher le SDK dans l'app", done: Boolean(h.sdk?.lastAt), optional: !apple && !google && stripe, tab: "connect", detail: h.sdk ? `dernier appel ${h.sdk.platform ?? ""}` : null,
      help: "Copie le prompt de l'onglet Connexions dans ton agent (Claude Code, Cursor…). L'étape se valide dès que l'app appelle MoneyMaker." },
    { id: "asc", group: "App Store", title: "Connecter App Store Connect", done: Boolean(creds.appStoreConnect), optional: !apple, tab: "connect",
      help: "Clé API App Store Connect (rôle App Manager) : importe les produits, active les classements et règle l'URL des notifications." },
    { id: "appleNotifications", group: "App Store", title: "Recevoir les notifications serveur Apple", done: Boolean(h.appleNotifications?.lastAt), optional: !apple, tab: "connect",
      help: "URL V2 en production et en sandbox (réglée automatiquement par la connexion App Store Connect si elle était vide). Se valide à la première notification reçue." },
    { id: "iap", group: "App Store", title: "Ajouter la clé In-App Purchase", done: Boolean(creds.apple), optional: true, tab: "settings",
      help: "Recommandé : MoneyMaker interroge Apple pour le statut exact (période de grâce, renouvellement) au lieu de se fier au seul reçu." },
    { id: "google", group: "Google Play", title: "Connecter Google Play", done: Boolean(creds.google), optional: !google, tab: "connect",
      help: "Compte de service avec l'accès « Finances » dans Play Console." },
    { id: "googleNotifications", group: "Google Play", title: "Recevoir les notifications Play (RTDN)", done: Boolean(h.googleNotifications?.lastAt), optional: !google, tab: "connect",
      help: "Topic Pub/Sub + abonnement push vers l'URL fournie, puis topic renseigné dans Play Console → Monétisation." },
    { id: "stripe", group: "Stripe", title: "Connecter Stripe", done: stripe && Boolean(creds.stripe?.webhookSecret), optional: !stripe, tab: "connect",
      help: "Une clé suffit : le webhook est créé et l'historique importé automatiquement." },
    { id: "firstPurchase", group: "Validation", title: "Premier achat reçu (sandbox ou réel)", done: counts.purchases > 0, tab: "events",
      help: "Fais un achat sandbox dans l'app : il doit apparaître dans Événements en quelques secondes." },
    { id: "appstore", group: "Bonus", title: "Suivre les classements App Store", done: (c.appStore?.apps ?? []).length > 0, optional: true, tab: "appstore",
      help: "Ajoute ton app et tes concurrents : classements dans 177 pays, alertes, avis." },
    { id: "integrations", group: "Bonus", title: "Brancher Slack ou tes outils", done: Object.keys(creds.integrations ?? {}).length > 0 || (c.webhooks ?? []).length > 0, optional: true, tab: "connect",
      help: "Slack/Discord pour être notifié de chaque vente, Mixpanel/Amplitude/Segment/PostHog pour l'analytique, webhooks pour ton backend." },
  ];
  // Rankings-only businesses (no in-app sales): only App Store tracking matters.
  if (c.mode === "rankings") {
    const only = steps.filter(s => s.id === "appstore").map(s => ({ ...s, optional: false }));
    return { steps: only, progress: only.every(s => s.done) ? 1 : 0, next: only.find(s => !s.done)?.id ?? null };
  }
  const required = steps.filter(s => !s.optional);
  return { steps, progress: required.length ? required.filter(s => s.done).length / required.length : 1, next: required.find(s => !s.done)?.id ?? null };
}

route("GET", "/v1/projects/:pid/setup", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  const [snap, creds, customers, purchases] = await Promise.all([
    db.doc(`projects/${project.id}`).get(), getCredentials(project.id),
    db.collection(`projects/${project.id}/customers`).count().get(),
    db.collection(`projects/${project.id}/transactions`).limit(1).get(),
  ]);
  const events = purchases.empty ? await db.collection(`projects/${project.id}/events`).where("type", "!=", "TEST").limit(1).get() : null;
  // Imported history (RevenueCat, Stripe) counts as "purchases received" too.
  const imported = purchases.empty && events?.empty ? await db.collectionGroup("purchases").where("projectId", "==", project.id).limit(1).get() : null;
  return setupSteps(snap.data(), creds, { customers: customers.data().count, purchases: purchases.size + (events?.size ?? 0) + (imported?.size ?? 0) });
});

// ── RevenueCat-compatible API (secret key): existing backends switch base URL + key ──
route("GET", "/v1/rc/v1/subscribers/:id", async (req, _res, [id]) => {
  const caller = await authenticate(req);
  if (caller.kind !== "secret") throw new HttpError(403, "secret_key_required");
  const project = await getProject(caller.projectId);
  const appUserId = cleanId(decodeURIComponent(id));
  const ref = db.doc(`projects/${project.id}/customers/${appUserId}`);
  const [snap, purchases] = await Promise.all([ref.get(), ref.collection("purchases").get()]);
  const list = purchases.docs.map(d => d.data() as Purchase);
  const { computeEntitlements } = await import("./engine");
  return toRevenueCatSubscriber(appUserId, list, computeEntitlements(list, project.config.entitlements), snap.get("firstSeenAt"));
});

route("POST", "/v1/rc/v1/subscribers/:id/entitlements/:ent/promotional", async (req, _res, [id, ent]) => {
  const caller = await authenticate(req);
  if (caller.kind !== "secret") throw new HttpError(403, "secret_key_required");
  const project = await getProject(caller.projectId);
  const appUserId = cleanId(decodeURIComponent(id)), entitlement = cleanId(decodeURIComponent(ent), 64);
  const days = promotionalDays(req.body?.duration);
  if (days === undefined) throw new HttpError(400, "invalid_duration");
  const now = Date.now();
  const ref = db.doc(`projects/${project.id}/customers/${appUserId}/purchases/promo_${entitlement}`);
  const prev = (await ref.get()).data() as Purchase | undefined;
  // Stack like RevenueCat: a new grant extends from the current promotional expiry when still running.
  const from = prev?.expiresAt && prev.expiresAt > now ? prev.expiresAt : now;
  await upsertPurchase(project, appUserId, {
    id: `promo_${entitlement}`, store: "promotional", productId: `promo:${entitlement}`, type: "non_consumable", status: "active",
    purchasedAt: prev?.purchasedAt ?? now, latestPurchaseAt: now, expiresAt: days === null ? null : from + days * 86400000,
    willRenew: false, isTrial: false, isSandbox: false, priceMicros: 0, currency: project.config.currency, periodMonths: 0, billingIssue: false, updatedAt: now,
  });
  const purchases = (await db.collection(`projects/${project.id}/customers/${appUserId}/purchases`).get()).docs.map(d => d.data() as Purchase);
  const { computeEntitlements } = await import("./engine");
  return toRevenueCatSubscriber(appUserId, purchases, computeEntitlements(purchases, project.config.entitlements));
});

// ── Connections (one step per store) ──────────────────────────────────────
route("POST", "/v1/projects/:pid/connect/stripe", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  const r = await connectStripe(project, PUBLIC_BASE, String(req.body?.secretKey ?? ""));
  await markConnected(project.id, "stripe");
  return r;
});

route("POST", "/v1/projects/:pid/connect/appstore", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  const r = await connectAppStore(project, PUBLIC_BASE, req.body);
  await markConnected(project.id, "app_store");
  await db.collection("scanRequests").add({ appIds: [r.app.id], at: Date.now() });
  return r;
});

route("POST", "/v1/projects/:pid/connect/google", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  const r = await connectGooglePlay(project, req.body);
  await markConnected(project.id, "play_store");
  return { ...r, rtdn: { pushEndpoint: PUBLIC_BASE + r.rtdn.pushEndpoint } };
});

// Imports run in the background (Hosting caps requests at 60 s); the RevenueCat key is erased once done.
route("POST", "/v1/projects/:pid/import/revenuecat", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  if (!/^sk_/.test(String(req.body?.secretKey ?? ""))) throw new HttpError(400, "invalid_revenuecat_key", "Use a RevenueCat secret key (sk_…)");
  const ids = Array.isArray(req.body?.appUserIds) ? req.body.appUserIds.slice(0, 20000).map(String) : [];
  const job = await db.collection("importJobs").add({
    projectId: project.id, source: "revenuecat", status: "queued", createdAt: Date.now(),
    secretKey: String(req.body.secretKey), appUserIds: ids, revenueCatProjectId: req.body?.revenueCatProjectId ?? null,
  });
  return { jobId: job.id, status: "queued" };
});

route("GET", "/v1/projects/:pid/import/:jid", async (req, _res, [pid, jid]) => {
  const project = await projectFor(await authenticate(req), pid);
  const job = (await db.doc(`importJobs/${cleanId(jid)}`).get()).data();
  if (!job || job.projectId !== project.id) throw new HttpError(404, "job_not_found");
  return { status: job.status, result: job.result ?? null, error: job.error ?? null, createdAt: job.createdAt, doneAt: job.doneAt ?? null };
});

// ── Advanced analytics ─────────────────────────────────────────────────────
route("GET", "/v1/projects/:pid/cohorts", async (req, _res, [pid]) =>
  projectCohorts(await projectFor(await authenticate(req), pid), Math.min(24, Math.max(3, Number(req.query.months ?? 12)))));

const csv = (rows: Record<string, unknown>[], cols: string[]) =>
  [cols.join(","), ...rows.map(r => cols.map(c => {
    const v = r[c] ?? "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(","))].join("\n");

route("GET", "/v1/projects/:pid/export/:kind", async (req, res, [pid, kind]) => {
  const project = await projectFor(await authenticate(req), pid);
  const specs: Record<string, [string, string, string[]]> = {
    customers: ["customers", "lastSeenAt", ["appUserId", "activeEntitlements", "isPaying", "totalSpentMicros", "country", "firstSeenAt", "lastSeenAt"]],
    transactions: ["transactions", "at", ["at", "appUserId", "store", "productId", "kind", "amountMicros", "currency", "amountMicrosProject", "country", "isSandbox"]],
    events: ["events", "at", ["at", "type", "appUserId", "store", "productId", "priceMicros", "currency", "country", "isTrial", "isSandbox"]],
  };
  const spec = specs[kind.replace(/\.csv$/, "")];
  if (!spec) throw new HttpError(404, "unknown_export");
  const snap = await db.collection(`projects/${project.id}/${spec[0]}`).orderBy(spec[1], "desc").limit(50000).get();
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="${project.name}-${spec[0]}.csv"`);
  res.status(200).send(csv(snap.docs.map(d => d.data()), spec[2]));
});

// ── App Store intelligence ────────────────────────────────────────────────
route("GET", "/v1/appstore/search", async req => {
  await authenticate(req);
  return { results: await searchApps(String(req.query.term ?? ""), String(req.query.country ?? "us")) };
});

route("PUT", "/v1/projects/:pid/appstore", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  const apps: TrackedApp[] = (Array.isArray(req.body?.apps) ? req.body.apps : []).slice(0, 25).map((a: any) => {
    if (!/^\d{5,12}$/.test(String(a?.appId))) throw new HttpError(400, "invalid_app_id");
    return { appId: String(a.appId), own: a.own !== false };
  });
  const previous = project.config.appStore?.apps ?? [];
  await db.doc(`projects/${project.id}`).update({ "config.appStore": { apps } });
  await syncTrackers(project.id, apps, previous);
  const added = apps.filter(a => !previous.some(p => p.appId === a.appId)).map(a => a.appId);
  if (added.length) await db.collection("scanRequests").add({ appIds: added, at: Date.now() });
  return { apps, scanning: added };
});

route("POST", "/v1/projects/:pid/appstore/refresh", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  const appIds = (project.config.appStore?.apps ?? []).map(a => a.appId);
  if (!appIds.length) throw new HttpError(400, "no_tracked_apps");
  await db.collection("scanRequests").add({ appIds, at: Date.now() });
  return { scanning: appIds };
});

route("GET", "/v1/projects/:pid/appstore", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  const tracked = project.config.appStore?.apps ?? [];
  const apps = await Promise.all(tracked.map(async t => {
    const [app, ranks] = await Promise.all([db.doc(`apps/${t.appId}`).get(), db.collection(`apps/${t.appId}/ranks`).where("rank", "!=", null).get()]);
    const live = ranks.docs.map(d => d.data());
    const top = live.sort((a, b) => a.rank - b.rank).slice(0, 8).map(r => ({ cc: r.cc, chart: r.chart, scope: r.scope, rank: r.rank, prevRank: r.prevRank }));
    return { ...t, ...app.data(), trackers: undefined, liveRankings: live.length, topRankings: top };
  }));
  return { apps };
});

route("GET", "/v1/projects/:pid/appstore/:appId/ranks", async (req, _res, [pid, appId]) => {
  const project = await projectFor(await authenticate(req), pid);
  if (!(project.config.appStore?.apps ?? []).some(a => a.appId === appId)) throw new HttpError(404, "app_not_tracked");
  const snap = await db.collection(`apps/${appId}/ranks`).get();
  return { ranks: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
});

route("GET", "/v1/projects/:pid/appstore/:appId/ratings", async (req, _res, [pid, appId]) => {
  const project = await projectFor(await authenticate(req), pid);
  if (!(project.config.appStore?.apps ?? []).some(a => a.appId === appId)) throw new HttpError(404, "app_not_tracked");
  const snap = await db.collection(`apps/${appId}/ratings`).where("count", ">", 0).get();
  return { ratings: snap.docs.map(d => d.data()).sort((a, b) => b.count - a.count) };
});

route("GET", "/v1/projects/:pid/appstore/:appId/reviews", async (req, _res, [pid, appId]) => {
  const project = await projectFor(await authenticate(req), pid);
  if (!(project.config.appStore?.apps ?? []).some(a => a.appId === appId)) throw new HttpError(404, "app_not_tracked");
  let q = db.collection(`apps/${appId}/reviews`).orderBy("at", "desc").limit(Math.min(200, Number(req.query.limit ?? 50)));
  if (req.query.country) q = q.where("country", "==", String(req.query.country).toUpperCase());
  if (req.query.rating) q = q.where("rating", "==", Number(req.query.rating));
  const snap = await q.get();
  return { reviews: snap.docs.map(d => d.data()) };
});

route("POST", "/v1/projects/:pid/appstore/:appId/reviews/:rid/translate", async (req, _res, [pid, appId, rid]) => {
  const project = await projectFor(await authenticate(req), pid);
  if (!(project.config.appStore?.apps ?? []).some(a => a.appId === appId)) throw new HttpError(404, "app_not_tracked");
  return translateReview(appId, cleanId(rid), String(req.body?.target ?? req.query.target ?? "fr"));
});

route("GET", "/v1/projects/:pid/alerts", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  const snap = await db.collection(`projects/${project.id}/alerts`).orderBy("at", "desc").limit(Math.min(300, Number(req.query.limit ?? 100))).get();
  return { alerts: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
});

route("GET", "/v1/alerts", async req => {
  const uid = requireUser(await authenticate(req));
  const projects = await db.collection("projects").where("members", "array-contains", uid).get();
  const all = (await Promise.all(projects.docs.map(async p =>
    (await db.collection(`projects/${p.id}/alerts`).orderBy("at", "desc").limit(50).get()).docs.map(d => ({ id: d.id, projectId: p.id, projectName: p.get("name"), ...d.data() })),
  ))).flat().sort((a: any, b: any) => b.at - a.at).slice(0, 100);
  return { alerts: all };
});

// ── iOS devices, today, live feed ──────────────────────────────────────────
route("PUT", "/v1/devices/:id", async (req, _res, [id]) => {
  const uid = requireUser(await authenticate(req));
  const { sanitizeDevice } = await import("./push");
  const ref = db.doc(`users/${uid}/devices/${cleanId(id, 80)}`);
  const current = (await ref.get()).data();
  let device;
  try { device = sanitizeDevice(id, req.body ?? {}, current as any); } catch (e) { throw new HttpError(400, (e as Error).message); }
  await ref.set(device);
  return { device: { ...device, apnsToken: undefined, widgetPushToken: undefined, liveActivity: undefined } };
});

route("DELETE", "/v1/devices/:id", async (req, _res, [id]) => {
  const uid = requireUser(await authenticate(req));
  await db.doc(`users/${uid}/devices/${cleanId(id, 80)}`).delete();
  return { ok: true };
});

route("POST", "/v1/devices/:id/test", async (req, _res, [id]) => {
  const uid = requireUser(await authenticate(req));
  const { apnsSend, apnsConfigured } = await import("./push");
  const d = (await db.doc(`users/${uid}/devices/${cleanId(id, 80)}`).get()).data();
  if (!d?.apnsToken) throw new HttpError(400, "no_apns_token");
  if (!(await apnsConfigured())) throw new HttpError(503, "apns_not_configured", "La clé APNs n'est pas encore configurée côté serveur.");
  const r = await apnsSend(d.env, d.apnsToken, "alert", {
    aps: { alert: { title: "+9,99 € · MoneyMaker", subtitle: "Notification de test", body: "Nouvel abonné · mensuel · 🇫🇷 FR" }, sound: d.prefs?.sound === false ? "default" : "cash.caf", "thread-id": "test", category: "SALE" },
  });
  if (r.status !== 200) throw new HttpError(502, "apns_failed", r.reason ?? String(r.status));
  return { ok: true };
});

route("POST", "/v1/projects/:pid/icon/refresh", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  const { refreshIcon } = await import("./icons");
  return refreshIcon(project);
});

/** Logo personnalisé (PNG/JPEG/WebP/SVG, base64 ou data URL) ; `null` revient à la détection automatique. */
route("PUT", "/v1/projects/:pid/icon", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  const { setCustomIcon, refreshIcon } = await import("./icons");
  if (req.body?.image === null) {
    await db.doc(`iconCache/${project.id}`).delete();
    return refreshIcon(project);
  }
  if (typeof req.body?.image !== "string") throw new HttpError(400, "image_required");
  try { return await setCustomIcon(project.id, req.body.image); } catch (e) { throw new HttpError(400, "invalid_image", (e as Error).message); }
});

/** Sert le logo hébergé (public : c'est le logo affiché d'une app, rien de confidentiel). */
route("GET", "/v1/icons/:pid", async (req, res, [pid]) => {
  const d = await db.doc(`iconCache/${cleanId(pid)}`).get();
  const b64 = d.get("png") as string | undefined;
  if (!b64) throw new HttpError(404, "icon_not_found");
  res.set("Content-Type", "image/png");
  res.set("Cache-Control", "public, max-age=86400, s-maxage=604800, immutable");
  res.status(200).send(Buffer.from(b64, "base64"));
});

/** `projectIds=a,b` (ou `projectId=a`) : restreint aux business choisis ; absent = tous. */
function projectIdsParam(req: Request): string[] | undefined {
  const raw = [req.query.projectIds, req.query.projectId].filter(v => typeof v === "string" && v).join(",");
  const ids = raw.split(",").map(s => s.trim()).filter(Boolean).slice(0, 50).map(s => cleanId(s));
  return ids.length ? ids : undefined;
}

route("GET", "/v1/today", async req => {
  const uid = requireUser(await authenticate(req));
  const { todayFor, liveActivityState } = await import("./push");
  let tz = String(req.query.tz ?? "UTC");
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { tz = "UTC"; }
  const cur = typeof req.query.currency === "string" && /^[A-Z]{3}$/.test(req.query.currency) ? req.query.currency : undefined;
  const t = await todayFor(uid, tz, cur, projectIdsParam(req));
  return { ...t, liveActivity: liveActivityState(t), generatedAt: Date.now() };
});

route("GET", "/v1/feed", async req => {
  const uid = requireUser(await authenticate(req));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 30)));
  const projects = await db.collection("projects").where("members", "array-contains", uid).select("name").get();
  const only = projectIdsParam(req);
  const all = (await Promise.all(projects.docs.filter(p => !only?.length || only.includes(p.id)).map(async p =>
    (await db.collection(`projects/${p.id}/events`).orderBy("at", "desc").limit(limit).select("type", "productId", "priceMicros", "currency", "country", "store", "isSandbox", "isTrial", "periodMonths", "at").get())
      .docs.map(d => ({ id: d.id, projectId: p.id, projectName: p.get("name"), ...d.data() })),
  ))).flat().filter((e: any) => e.type !== "TEST").sort((a: any, b: any) => b.at - a.at).slice(0, limit);
  return { events: all };
});

// ── Dispatcher ─────────────────────────────────────────────────────────────
export async function handle(req: Request, res: Response) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  const path = req.path.replace(/^\/api(?=\/)/, "");
  try {
    for (const [method, re, handler] of routes) {
      const m = re.exec(path);
      if (!m || method !== req.method) continue;
      const out = await handler(req, res, m.slice(1));
      if (!res.headersSent) res.status(200).json(out ?? { ok: true });
      return;
    }
    throw new HttpError(404, "route_not_found");
  } catch (e) {
    const err = e instanceof HttpError ? e : new HttpError(500, "internal_error");
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) res.status(err.status).json({ error: err.code, message: err.message });
  }
}
