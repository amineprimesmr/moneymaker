import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { HttpError, cleanId, Purchase } from "./engine";
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
import { searchApps, syncTrackers, translateReview, TrackedApp } from "./appstore";

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
      return { id: String(w.id ?? `wh_${i}`), url: w.url, ...(Array.isArray(w.events) ? { events: w.events.map(String) } : {}) };
    });
  }
  if (input.apple !== undefined) next.apple = {
    bundleId: input.apple.bundleId ? cleanId(input.apple.bundleId, 200) : undefined,
    appAppleId: input.apple.appAppleId ? Number(input.apple.appAppleId) : undefined,
  };
  if (input.google !== undefined) next.google = { packageName: input.google.packageName ? cleanId(input.google.packageName, 200) : undefined };
  if (input.integrations !== undefined) {
    const af = input.integrations?.appsflyer;
    next.integrations = af ? { appsflyer: { appId: cleanId(af.appId, 64), ...(af.androidAppId ? { androidAppId: cleanId(af.androidAppId, 200) } : {}) } } : {};
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
route("POST", "/v1/webhooks/apple/:pid", async (req, _res, [pid]) =>
  ingestAppleNotification(await getProject(cleanId(pid)), req.body?.signedPayload));

route("POST", "/v1/webhooks/google/:pid", async (req, _res, [pid]) => {
  const project = await getProject(cleanId(pid));
  const creds = await getCredentials(project.id);
  if (req.query.token !== creds.googleRtdnToken) throw new HttpError(401, "invalid_rtdn_token");
  return ingestGoogleNotification(project, req.body);
});

route("POST", "/v1/webhooks/stripe/:pid", async (req, _res, [pid]) =>
  ingestStripeWebhook(await getProject(cleanId(pid)), req.rawBody, req.get("stripe-signature")));

// ── Client SDK (public key) ────────────────────────────────────────────────
async function clientProject(req: Request) {
  const caller = await authenticate(req);
  if (caller.kind === "user") throw new HttpError(403, "project_key_required");
  return getProject(caller.projectId);
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
  if (req.body?.config) await db.doc(`projects/${project.id}`).update({ config: sanitizeConfig(req.body.config, project.config) });
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
  const projects = await Promise.all(snap.docs.map(async d => projectMetrics(await getProject(d.id), days)));
  const currency = String(req.query.currency ?? projects[0]?.currency ?? "EUR");
  const { convertMicros } = await import("./engine");
  const sum = (f: (p: typeof projects[number]) => number) => projects.reduce((a, p) => a + convertMicros(f(p), p.currency, currency), 0);
  return {
    currency, periodDays: days,
    mrrMicros: sum(p => p.mrrMicros), revenueMicros: sum(p => p.netRevenueMicros),
    activeSubscriptions: projects.reduce((a, p) => a + p.activeSubscriptions, 0),
    activeTrials: projects.reduce((a, p) => a + p.activeTrials, 0),
    newCustomers: projects.reduce((a, p) => a + p.newCustomers, 0),
    projects: projects.map(({ history, revenueByDay, ...p }) => ({ ...p, revenueByDay })),
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
