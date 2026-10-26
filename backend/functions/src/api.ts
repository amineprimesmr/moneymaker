import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { HttpError, cleanId, Purchase } from "./engine";
import type { Credentials } from "./store";
import {
  db, getProject, createProject, customerInfo, mergeCustomers, touchCustomer, resolveKey, issueKey, revokeProjectKeys,
  upsertPurchase, lookupIndex, accountUUID, Project, ProjectConfig, getCredentials, KeyRecord, DEFAULT_CONFIG, CustomerCenterConfig,
} from "./store";
import { ingestAppleTransaction, ingestAppleNotification } from "./apple";
import { sanitizeRefundControl, refundStats, DEFAULT_REFUND_CONTROL } from "./refund";
import { ingestGooglePurchase, ingestGoogleNotification } from "./google";
import { ingestStripeWebhook, createCheckout, createPortal } from "./stripe";
import { sanitizeWeb, publicOffering, withPrices, webCheckout, webSuccess, webPortal, manageLink, redeemWebPurchase } from "./web";
import { ingestPaddleWebhook } from "./paddle";
import { ingestAmazonPurchase, ingestAmazonNotification } from "./amazon";
import { ingestGalaxyPurchase } from "./galaxy";
import { ingestRokuPurchase, ingestRokuNotification } from "./roku";
import { projectMetrics, projectCohorts } from "./metrics";
import { connectStripe, connectAppStore, connectGooglePlay, markConnected } from "./connect";
import { sanitizeIntegrations, fanOut } from "./integrations";
import { resolveAppleAds } from "./appleads";
import { sanitizeExports, sanitizeExportSecrets } from "./exports";
import { toRevenueCatSubscriber, promotionalDays } from "./rccompat";
import { DEMO_TOKEN, DEMO_UID } from "./demo";
import { AsyncLocalStorage } from "async_hooks";
import { getSigningKey, signResponse, SIGNATURE_HEADER, REQUEST_TIME_HEADER, NONCE_HEADER } from "./signing";
import { Role, roleOf, atLeast, defaultRequired } from "./roles";
import { audit, listAudit, listMembers, createInvite, deleteInvite, peekInvite, acceptInvite, setMemberRole, removeMember } from "./team";
import { projectChart } from "./chartsLoader";
import { chartToCsv, CHART_NAMES } from "./charts";
import { sanitizeOfferings, sanitizeTargeting, sanitizeExperiments, resolveOfferings, aggregateResults, PAYWALL_EVENT_TYPES, Context } from "./growth";
import { searchApps, syncTrackers, translateReview, lookupApp, TrackedApp } from "./appstore";
import { sanitizeAudiences, sanitizeFilters, audienceCsv, customerStatus } from "./audiences";
import { sanitizeAdmobConfig, sanitizeAdEvent, recordAdEvent, handleSsv } from "./ads";
import { projectBenchmarks } from "./benchmarks";
import { sanitizeVirtualCurrencies, readWallet, moveWallet, parseAmount, parseIdempotencyKey } from "./wallet";
import { projectLtv, audienceById, audienceCustomers, loadCustomerRows } from "./segmentsLoader";
import { isMcpPath, handleMcp } from "./mcp/server";
import { resolveAccessToken } from "./mcp/oauth";
import { ACCESS_PREFIX } from "./mcp/policy";
import { verifyStripeAppSignature, stripeAppPayload, parseGrantDays, isStripeCustomerId, STRIPE_APP_GRANT_DAYS } from "./stripeApp";

/** Public base URL used in store webhook endpoints (stable, behind Firebase Hosting). */
export const PUBLIC_BASE = process.env.MONEYMAKER_PUBLIC_BASE ?? "https://moneymaker-io.web.app";

type Caller =
  | { kind: "public"; projectId: string; test?: boolean }
  | { kind: "secret"; projectId: string }
  | { kind: "user"; uid: string; email?: string; emailVerified?: boolean };

/** POST sans effet sur les données (aperçu d'audience, traduction mise en cache) : permis en lecture seule. */
const READ_ONLY_POSTS = /^\/v1\/projects\/[^/]+\/(audiences\/preview|appstore\/[^/]+\/reviews\/[^/]+\/translate)\/?$/;

async function authenticate(req: Request): Promise<Caller> {
  const header = req.get("authorization") ?? "";
  const raw = header.replace(/^Bearer\s+/i, "").trim();
  if (!raw) throw new HttpError(401, "missing_api_key");
  if (raw === DEMO_TOKEN) return { kind: "user", uid: DEMO_UID };
  // Jeton OAuth du connecteur MCP : agit comme l'utilisateur, en lecture seule sans le scope d'écriture.
  if (raw.startsWith(ACCESS_PREFIX)) {
    const t = await resolveAccessToken(raw);
    if (!t) throw new HttpError(401, "invalid_token");
    if (!t.scopes.includes("moneymaker:write") && req.method !== "GET" && !READ_ONLY_POSTS.test(req.path)) throw new HttpError(403, "insufficient_scope", "Connexion en lecture seule");
    return { kind: "user", uid: t.uid };
  }
  if (raw.startsWith("mm_")) {
    const rec: KeyRecord | null = await resolveKey(raw);
    if (!rec) throw new HttpError(401, "invalid_api_key");
    if (rec.kind === "pat") return { kind: "user", uid: rec.uid! };
    if (rec.kind === "test") return { kind: "public", projectId: rec.projectId!, test: true };
    return { kind: rec.kind, projectId: rec.projectId! };
  }
  try {
    const decoded = await getAuth().verifyIdToken(raw);
    return { kind: "user", uid: decoded.uid, email: decoded.email, emailVerified: decoded.email_verified };
  } catch {
    throw new HttpError(401, "invalid_token");
  }
}

/** Per-request context (method, acting uid, resolved project) for central role checks and the audit log. */
interface RequestCtx { method: string; actor?: string; projectId?: string; role?: Role; auditAction?: string; auditDetails?: Record<string, unknown>; skipAudit?: boolean }
const requestCtx = new AsyncLocalStorage<RequestCtx>();

/** Resolves a project the caller may access. Role enforcement: `required` if given, otherwise
 *  viewer for GET and developer for writes. Secret keys act as admin; owner-only actions need a user. */
async function projectFor(caller: Caller, pid: string, allowPublic = false, required?: Role): Promise<Project & { role?: Role }> {
  const project = await getProject(cleanId(pid));
  const ctx = requestCtx.getStore();
  const needed = required ?? defaultRequired(ctx?.method ?? "GET");
  const ok = (role: Role, actor: string) => {
    if (!atLeast(role, needed)) throw new HttpError(403, "insufficient_role", `Rôle « ${needed} » requis (le tien : ${role})`);
    if (ctx) { ctx.projectId = project.id; ctx.role = role; ctx.actor = actor; }
    return { ...project, role };
  };
  if (caller.kind === "user") { const role = roleOf(project, caller.uid); if (role) return ok(role, caller.uid); }
  if (caller.kind === "secret" && caller.projectId === project.id) return ok("admin", "key:secret");
  if (allowPublic && caller.kind === "public" && caller.projectId === project.id) return { ...project, role: "viewer" };
  throw new HttpError(403, "forbidden");
}

/** Adds details (never secret values) to the automatic audit entry of the current request. */
function auditNote(action: string, details: Record<string, unknown> = {}) {
  const ctx = requestCtx.getStore();
  if (ctx) { ctx.auditAction = action; ctx.auditDetails = { ...(ctx.auditDetails ?? {}), ...details }; }
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
  // Growth (paywalls / targeting / experiments) — see growth.ts.
  if (input.offerings !== undefined) next.offerings = sanitizeOfferings(input.offerings) as any;
  {
    const ids = new Set(Object.keys(next.offerings ?? {}));
    if (input.targeting !== undefined) { if (input.targeting === null) delete next.targeting; else next.targeting = sanitizeTargeting(input.targeting, ids); }
    if (input.experiments !== undefined) next.experiments = sanitizeExperiments(input.experiments ?? [], ids, current.experiments ?? []);
  }
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
  if (input.exports !== undefined) {
    try { (next as any).exports = sanitizeExports(input.exports); } catch (e) { throw new HttpError(400, (e as Error).message); }
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
  if (input.customerCenter !== undefined) {
    if (input.customerCenter === null) delete next.customerCenter;
    else next.customerCenter = sanitizeCustomerCenter(input.customerCenter);
  }
  if (input.audiences !== undefined) {
    try { (next as any).audiences = sanitizeAudiences(input.audiences ?? []); } catch (e) { throw new HttpError(400, (e as Error).message); }
  }
  if (input.virtualCurrencies !== undefined) {
    try { (next as any).virtualCurrencies = sanitizeVirtualCurrencies(input.virtualCurrencies ?? []); } catch (e) { throw new HttpError(400, (e as Error).message); }
  }
  if (input.admob !== undefined) {
    if (input.admob === null) delete (next as any).admob;
    else try { (next as any).admob = sanitizeAdmobConfig(input.admob, (((next as any).virtualCurrencies ?? []) as { code: string }[]).map(c => c.code)); }
    catch (e) { throw new HttpError(400, (e as Error).message); }
  }
  if (input.category !== undefined) {
    if (input.category === null || input.category === "") delete (next as any).category;
    else (next as any).category = text(input.category, 60, "invalid_category");
  }
  if (input.anomalies !== undefined) {
    const a = input.anomalies ?? {};
    const threshold = a.threshold === undefined ? 3 : Number(a.threshold);
    if (!Number.isFinite(threshold) || threshold < 2 || threshold > 6) throw new HttpError(400, "invalid_anomaly_threshold");
    (next as any).anomalies = { enabled: a.enabled !== false, threshold, weeklySummary: a.weeklySummary !== false };
  }
  if (input.refundControl !== undefined) {
    try { (next as any).refundControl = sanitizeRefundControl(input.refundControl); }
    catch (e) { throw new HttpError(400, (e as Error).message); }
  }
  if (input.web !== undefined) { const w = sanitizeWeb(input.web); if (w) (next as any).web = w; else delete (next as any).web; }
  if (input.stripe !== undefined) next.stripe = { enabled: Boolean(input.stripe.enabled), prices: input.stripe.prices };
  if (JSON.stringify(next).length > 200000) throw new HttpError(400, "config_too_large");
  return next;
}

const text = (v: unknown, max: number, code: string) => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new HttpError(400, code);
  return v.trim();
};

function sanitizeCustomerCenter(c: any): CustomerCenterConfig {
  if (typeof c !== "object" || Array.isArray(c)) throw new HttpError(400, "invalid_customer_center");
  const out: CustomerCenterConfig = {
    enabled: Boolean(c.enabled),
    survey: { question: "Pourquoi souhaitez-vous annuler ?", options: ["Trop cher", "Je ne l'utilise pas assez", "Il manque une fonctionnalité", "Problème technique", "Autre"] },
  };
  if (c.supportEmail) {
    const email = String(c.supportEmail).trim();
    if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "invalid_support_email");
    out.supportEmail = email;
  }
  if (c.survey !== undefined) {
    const opts = c.survey?.options;
    if (!Array.isArray(opts) || opts.length < 1 || opts.length > 10) throw new HttpError(400, "invalid_survey_options");
    out.survey = { question: text(c.survey.question, 200, "invalid_survey_question"), options: opts.map(o => text(o, 100, "invalid_survey_option")) };
  }
  if (c.retentionOffer) {
    const r = c.retentionOffer;
    out.retentionOffer = {
      message: text(r.message, 500, "invalid_retention_message"),
      ...(r.productIdApple ? { productIdApple: cleanId(r.productIdApple, 200) } : {}),
      ...(r.offerIdApple ? { offerIdApple: cleanId(r.offerIdApple, 200) } : {}),
      ...(r.googleOfferId ? { googleOfferId: cleanId(r.googleOfferId, 200) } : {}),
    };
  }
  return out;
}

function offeringsFor(project: Project) {
  const { offerings, currentOffering } = project.config;
  return { current: currentOffering ?? Object.keys(offerings)[0] ?? null, offerings };
}

type Handler = (req: Request, res: Response, params: string[]) => Promise<unknown>;
const routes: [string, RegExp, Handler, string][] = [];
const route = (method: string, pattern: string, handler: Handler) =>
  routes.push([method, new RegExp("^" + pattern.replace(/:[a-zA-Z]+/g, "([^/]+)") + "/?$"), handler, pattern]);

/** Audit action name for a mutating route: known ones get a stable name, others "METHOD /pattern". */
const AUDIT_ACTIONS: Record<string, string> = {
  "PATCH /v1/projects/:pid": "config.update",
  "PUT /v1/projects/:pid/credentials": "credentials.update",
  "POST /v1/projects/:pid/keys": "keys.issue",
  "POST /v1/projects/:pid/customers/:id/grant": "grant.update",
  "POST /v1/projects/:pid/invites": "invite.create",
  "DELETE /v1/projects/:pid/invites/:id": "invite.revoke",
  "PATCH /v1/projects/:pid/members/:uid": "member.role",
  "DELETE /v1/projects/:pid/members/:uid": "member.remove",
};
const auditActionFor = (method: string, pattern: string) => AUDIT_ACTIONS[`${method} ${pattern}`] ?? `${method} ${pattern.replace(/^\/v1\/projects\/:pid/, "") || "/"}`;

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

// Amazon Appstore RTN (SNS HTTPS subscription; SNS signature verified, then the receipt is re-verified with RVS).
route("POST", "/v1/webhooks/amazon/:pid", async (req, _res, [pid]) => {
  const project = await getProject(cleanId(pid));
  const creds = await getCredentials(project.id);
  if (req.query.token !== creds.googleRtdnToken) throw new HttpError(401, "invalid_notification_token");
  const r = await ingestAmazonNotification(project, req.rawBody, req.body);
  await markHealth(project.id, "amazonNotifications", { type: String((r as any).notificationType ?? ((r as any).confirmed !== undefined ? "confirmation" : "")) });
  return r;
});

// Roku Pay push notifications (signed JWT, or legacy JSON whose responseKey must be echoed as the body).
route("POST", "/v1/webhooks/roku/:pid", async (req, res, [pid]) => {
  const project = await getProject(cleanId(pid));
  const creds = await getCredentials(project.id);
  if (req.query.token !== creds.googleRtdnToken) throw new HttpError(401, "invalid_notification_token");
  const r = await ingestRokuNotification(project, String(req.rawBody ?? ""), typeof req.body === "object" ? req.body : {}, req.get("authorization"));
  await markHealth(project.id, "rokuNotifications", { type: String(r.transactionType ?? "") });
  if (r.responseKey) { res.status(200).type("text/plain").send(String(r.responseKey)); return; }
  return { ok: true };
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

route("GET", "/v1/offerings", async req => resolvedOfferings(req, await clientProject(req)));

// ── Customer Center ──
route("GET", "/v1/customer-center", async req => {
  const cc = (await clientProject(req)).config.customerCenter;
  return cc ?? { enabled: false, survey: { question: "", options: [] } };
});

const FEEDBACK_ACTIONS = ["cancel", "accepted_offer", "refund", "dismissed", "contact_support"];
route("POST", "/v1/customers/:id/customer-center/feedback", async (req, _res, [id]) => {
  const project = await clientProject(req);
  const appUserId = cleanId(decodeURIComponent(id));
  const action = String(req.body?.action ?? "");
  if (!FEEDBACK_ACTIONS.includes(action)) throw new HttpError(400, "invalid_action", `action ∈ ${FEEDBACK_ACTIONS.join(", ")}`);
  const reason = text(req.body?.reason, 200, "invalid_reason");
  const comment = req.body?.comment ? String(req.body.comment).slice(0, 2000) : undefined;
  const ref = db.collection(`projects/${project.id}/feedback`).doc();
  const entry = { appUserId, reason, action, ...(comment ? { comment } : {}), createdAt: Date.now() };
  await ref.set(entry);
  const creds = await getCredentials(project.id).catch(() => null);
  if (creds) await fanOut(project, creds, { id: ref.id, type: "CUSTOMER_CENTER_FEEDBACK", ...entry }, "event");
  return { ok: true, id: ref.id };
});

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

/** Test Store: only with a `mm_test_` key. Grants a sandbox purchase (store "test") without StoreKit / Play. */
route("POST", "/v1/customers/:id/test-purchase", async (req, _res, [id]) => {
  const caller = await authenticate(req);
  if (caller.kind !== "public" || !caller.test) throw new HttpError(403, "test_key_required", "Use a Test Store key (mm_test_…)");
  const project = await clientProject(req);
  const appUserId = cleanId(decodeURIComponent(id));
  const productId = cleanId(String(req.body?.productId ?? ""), 200);
  const type: Purchase["type"] = ["subscription", "non_consumable", "consumable"].includes(req.body?.type) ? req.body.type : "subscription";
  const periodMonths = type === "subscription" ? Math.min(12, Math.max(0.25, Number(req.body?.periodMonths ?? 1) || 1)) : 0;
  const now = Date.now();
  const { randomUUID } = await import("crypto");
  const purchase: Purchase = {
    id: `test_${randomUUID()}`, store: "test", productId, type, status: "active", purchasedAt: now, latestPurchaseAt: now,
    expiresAt: type === "subscription" ? now + Math.round(periodMonths * 30 * 86400000) : null,
    willRenew: false, isTrial: false, isSandbox: true, priceMicros: 0, currency: project.config.currency, periodMonths,
    billingIssue: false, updatedAt: now,
  };
  await touchCustomer(project.id, appUserId);
  await upsertPurchase(project, appUserId, purchase, []);
  return customerInfo(project, appUserId);
});

/** Public Ed25519 key that verifies `X-MoneyMaker-Signature` (trusted entitlements). No auth. */
route("GET", "/v1/signing-key", async () => {
  const k = await getSigningKey();
  return { algorithm: "Ed25519", format: "raw", publicKey: k.publicKeyRaw, message: "${nonce}.${X-Request-Time}.${sha256hex(body)}" };
});

route("POST", "/v1/customers/:id/google", async (req, _res, [id]) => {
  const project = await clientProject(req);
  const r = await ingestGooglePurchase(project, cleanId(decodeURIComponent(id)), req.body);
  return customerInfo(project, r.appUserId);
});

route("POST", "/v1/customers/:id/amazon", async (req, _res, [id]) => {
  const project = await clientProject(req);
  const r = await ingestAmazonPurchase(project, cleanId(decodeURIComponent(id)), req.body);
  return customerInfo(project, (r as any).appUserId ?? cleanId(decodeURIComponent(id)));
});

route("POST", "/v1/customers/:id/galaxy", async (req, _res, [id]) => {
  const project = await clientProject(req);
  const r = await ingestGalaxyPurchase(project, cleanId(decodeURIComponent(id)), req.body);
  return customerInfo(project, r.appUserId);
});

route("POST", "/v1/customers/:id/roku", async (req, _res, [id]) => {
  const project = await clientProject(req);
  const r = await ingestRokuPurchase(project, cleanId(decodeURIComponent(id)), req.body);
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
  if (typeof clean.$appleAdsToken === "string") await resolveAppleAds(project.id, appUserId, clean.$appleAdsToken);
  return { ok: true };
});

/** Signs an Apple promotional offer (retention / win-back) with the project's In-App Purchase key. */
route("POST", "/v1/customers/:id/offers/apple/sign", async (req, _res, [id]) => {
  const project = await clientProject(req);
  const appUserId = cleanId(decodeURIComponent(id));
  const productId = cleanId(String(req.body?.productId ?? ""), 200), offerId = cleanId(String(req.body?.offerId ?? ""), 200);
  const bundleId = project.config.apple?.bundleId;
  const creds = await getCredentials(project.id);
  if (!creds.apple?.privateKey || !bundleId) throw new HttpError(400, "apple_not_configured", "Upload the In-App Purchase key and set the bundle id");
  const { PromotionalOfferSignatureCreator } = await import("@apple/app-store-server-library");
  const { randomUUID } = await import("crypto");
  const nonce = randomUUID().toLowerCase(), timestamp = Date.now();
  const appAccountToken = accountUUID(appUserId).toLowerCase();
  const signature = new PromotionalOfferSignatureCreator(creds.apple.privateKey, creds.apple.keyId, bundleId)
    .createSignature(productId, offerId, appAccountToken, nonce, timestamp);
  return { keyIdentifier: creds.apple.keyId, nonce, timestamp, signature, appAccountToken };
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
  return { projects: snap.docs.map(d => ({ id: d.id, name: d.get("name"), config: d.get("config"), role: roleOf(d.data(), uid) })) };
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

/** Suppression du compte (exigence App Store 5.1.1(v)) : business dont on est seul membre, clés,
 *  jetons, appareils, réglages, dépenses, puis l'utilisateur Firebase. Les business partagés sont quittés. */
route("DELETE", "/v1/account", async req => {
  const uid = requireUser(await authenticate(req));
  if (req.body?.confirm !== "SUPPRIMER") throw new HttpError(400, "confirmation_required", "Envoie {\"confirm\":\"SUPPRIMER\"}");
  const projects = await db.collection("projects").where("members", "array-contains", uid).get();
  let deleted = 0, left = 0;
  for (const p of projects.docs) {
    const members: string[] = p.get("members") ?? [];
    if (members.length <= 1) {
      const keys = await db.collection("apiKeys").where("projectId", "==", p.id).get();
      await Promise.all(keys.docs.map(k => k.ref.delete()));
      await db.recursiveDelete(p.ref);
      await db.doc(`iconCache/${p.id}`).delete().catch(() => null);
      deleted++;
    } else {
      await p.ref.update({ members: FieldValue.arrayRemove(uid) });
      left++;
    }
  }
  const pats = await db.collection("apiKeys").where("uid", "==", uid).get();
  await Promise.all(pats.docs.map(k => k.ref.delete()));
  await db.recursiveDelete(db.doc(`users/${uid}`));
  await getAuth().deleteUser(uid).catch(() => null);
  return { ok: true, deletedProjects: deleted, leftProjects: left };
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
    adRevenueMicros: sum(p => p.adRevenueMicros ?? 0), revenueInclAdsMicros: sum(p => p.revenueInclAdsMicros ?? p.netRevenueMicros),
    activeSubscriptions: projects.reduce((a, p) => a + p.activeSubscriptions, 0),
    activeTrials: projects.reduce((a, p) => a + p.activeTrials, 0),
    newCustomers: projects.reduce((a, p) => a + p.newCustomers, 0),
    payingCustomers: projects.reduce((a, p) => a + p.payingCustomers, 0),
    downloads: projects.some(p => p.downloads !== null) ? projects.reduce((a, p) => a + (p.downloads ?? 0), 0) : null,
    hasTrials: projects.some(p => p.hasTrials),
    projects: projects.map(({ history, revenueByDay, downloadsByDay, ...p }) => ({
      projectId: p.projectId, name: p.name, currency: p.currency, mrrMicros: p.mrrMicros, netRevenueMicros: p.netRevenueMicros,
      activeSubscriptions: p.activeSubscriptions, activeTrials: p.activeTrials, newCustomers: p.newCustomers, trialConversionRate: p.trialConversionRate,
      adRevenueMicros: p.adRevenueMicros, revenueInclAdsMicros: p.revenueInclAdsMicros,
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
    credentials: { integrations: Object.keys(creds.integrations ?? {}), exports: Object.keys((creds as any).exports ?? {}), appStoreConnect: Boolean(creds.appStoreConnect), appsflyer: Boolean(creds.appsflyer), apple: Boolean(creds.apple), google: Boolean(creds.google), stripeKey: Boolean(creds.stripe?.secretKey), stripeWebhook: Boolean(creds.stripe?.webhookSecret), paddle: Boolean((creds as any).paddle?.webhookSecret), amazon: Boolean((creds as any).amazon?.sharedSecret), galaxy: Boolean((creds as any).galaxy?.serviceAccountId), roku: Boolean((creds as any).roku?.devApiKey) },
    endpoints: {
      appleNotifications: `${base}/v1/webhooks/apple/${project.id}`,
      googleRtdn: `${base}/v1/webhooks/google/${project.id}?token=${creds.googleRtdnToken}`,
      stripeWebhook: `${base}/v1/webhooks/stripe/${project.id}`,
      paddleWebhook: `${base}/v1/webhooks/paddle/${project.id}`,
      amazonNotifications: `${base}/v1/webhooks/amazon/${project.id}?token=${creds.googleRtdnToken}`,
      rokuNotifications: `${base}/v1/webhooks/roku/${project.id}?token=${creds.googleRtdnToken}`,
    },
    webhookSigningSecret: project.role === "viewer" ? undefined : creds.webhookSigningSecret,
    amazonConfirmationToken: (creds as any).amazon ? ((await db.doc(`projects/${project.id}`).get()).get("health.amazonNotifications.confirmationToken") ?? null) : null,
  };
});

route("PATCH", "/v1/projects/:pid", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  const config = sanitizeConfig(req.body?.config ?? {}, project.config);
  auditNote("config.update", { configKeys: Object.keys(req.body?.config ?? {}).slice(0, 30) });
  const update: Record<string, unknown> = { config };
  if (typeof req.body?.name === "string" && req.body.name.trim()) update.name = req.body.name.trim().slice(0, 80);
  await db.doc(`projects/${project.id}`).update(update);
  return { ...project, ...update };
});

route("PUT", "/v1/projects/:pid/credentials", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid, false, "admin");
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
  if (b.exports) {
    try { update.exports = sanitizeExportSecrets(b.exports, ((await getCredentials(project.id)) as any).exports); }
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
  if (b.paddle) {
    const s: Record<string, string> = {};
    if (b.paddle.apiKey) { if (typeof b.paddle.apiKey !== "string" || b.paddle.apiKey.length < 20 || b.paddle.apiKey.length > 300) throw new HttpError(400, "invalid_paddle_api_key"); s.apiKey = b.paddle.apiKey.trim(); }
    if (b.paddle.webhookSecret) { if (!/^pdl_ntfset_|^[A-Za-z0-9_]{16,}$/.test(String(b.paddle.webhookSecret))) throw new HttpError(400, "invalid_paddle_webhook_secret"); s.webhookSecret = String(b.paddle.webhookSecret).trim(); }
    if (b.paddle.environment) s.environment = b.paddle.environment === "sandbox" ? "sandbox" : "production";
    const current = ((await getCredentials(project.id)) as any).paddle ?? {};
    update.paddle = { ...current, ...s };
  }
  if (b.amazon) {
    const cur = ((await getCredentials(project.id)) as any).amazon ?? {};
    const a: Record<string, unknown> = { ...cur };
    if (b.amazon.sharedSecret) { if (typeof b.amazon.sharedSecret !== "string" || b.amazon.sharedSecret.length < 8 || b.amazon.sharedSecret.length > 300) throw new HttpError(400, "invalid_amazon_shared_secret"); a.sharedSecret = b.amazon.sharedSecret.trim(); }
    if (b.amazon.packageName !== undefined) a.packageName = b.amazon.packageName ? cleanId(String(b.amazon.packageName), 200) : null;
    if (b.amazon.allowSandbox !== undefined) a.allowSandbox = b.amazon.allowSandbox === true;
    if (!a.sharedSecret) throw new HttpError(400, "invalid_amazon_shared_secret");
    update.amazon = a;
  }
  if (b.galaxy) {
    const cur = ((await getCredentials(project.id)) as any).galaxy ?? {};
    const g: Record<string, unknown> = { ...cur };
    if (b.galaxy.serviceAccountId) g.serviceAccountId = cleanId(String(b.galaxy.serviceAccountId), 200);
    if (b.galaxy.privateKey) { if (!/BEGIN (RSA )?PRIVATE KEY/.test(String(b.galaxy.privateKey))) throw new HttpError(400, "invalid_galaxy_private_key"); g.privateKey = String(b.galaxy.privateKey); }
    if (b.galaxy.packageName) g.packageName = cleanId(String(b.galaxy.packageName), 200);
    update.galaxy = g;
  }
  if (b.roku) {
    if (typeof b.roku.devApiKey !== "string" || b.roku.devApiKey.trim().length < 8 || b.roku.devApiKey.length > 300) throw new HttpError(400, "invalid_roku_api_key");
    update.roku = { devApiKey: b.roku.devApiKey.trim() };
  }
  await db.doc(`projects/${project.id}/private/credentials`).set(update, { merge: true });
  return { ok: true, updated: Object.keys(update) };
});

route("POST", "/v1/projects/:pid/keys", async (req, _res, [pid]) => {
  const caller = await authenticate(req);
  const project = await projectFor(caller, pid, false, req.body?.revokeExisting ? "admin" : undefined);
  const kind = req.body?.kind === "public" ? "public" : req.body?.kind === "test" ? "test" : "secret";
  auditNote("keys.issue", { kind, revokeExisting: Boolean(req.body?.revokeExisting) });
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
  auditNote("grant.update", { appUserId, entitlement, days });
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

route("GET", "/v1/projects/:pid/refund-requests", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  const snap = await db.collection(`projects/${project.id}/refundRequests`).orderBy("requestedAt", "desc").limit(Math.min(500, Number(req.query.limit ?? 200))).get();
  const all = snap.docs.map(d => ({ id: d.id, ...d.data() })) as any[];
  const rows = req.query.sandbox === "true" ? all : all.filter(r => !r.isSandbox);
  return { config: { ...DEFAULT_REFUND_CONTROL, ...((project.config as any).refundControl ?? {}) }, stats: refundStats(rows), requests: rows };
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
// ── RevenueCat REST API v1 compatibility ──────────────────────────────────
// Mounted at /v1/rc/v1/* and at /v1/* (so RevenueCat's SDK `proxyURL` / server code can point here).
// Public key: read subscriber, offerings, attributes, receipts. Secret key: everything.
async function rcProject(req: Request, secretOnly = false) {
  const caller = await authenticate(req);
  if (caller.kind === "user" || (secretOnly && caller.kind !== "secret")) throw new HttpError(403, "secret_key_required");
  return getProject(caller.projectId);
}

async function rcSubscriber(project: Project, appUserId: string) {
  const ref = db.doc(`projects/${project.id}/customers/${appUserId}`);
  const [snap, purchases] = await Promise.all([ref.get(), ref.collection("purchases").get()]);
  const list = purchases.docs.map(d => d.data() as Purchase);
  const { computeEntitlements } = await import("./engine");
  const out = toRevenueCatSubscriber(appUserId, list, computeEntitlements(list, project.config.entitlements), snap.get("firstSeenAt"));
  const updated = snap.get("attributesUpdatedAt") ?? {};
  out.subscriber.subscriber_attributes = Object.fromEntries(Object.entries<any>(snap.get("attributes") ?? {})
    .map(([k, v]) => [k, { value: v, updated_at_ms: updated[k] ?? snap.get("updatedAt") ?? Date.now() }]));
  return out;
}

const rcRoute = (method: string, path: string, h: Handler) => { route(method, `/v1/rc/v1${path}`, h); route(method, `/v1${path}`, h); };

rcRoute("GET", "/subscribers/:id", async (req, _res, [id]) => {
  const project = await rcProject(req);
  const appUserId = cleanId(decodeURIComponent(id));
  await touchCustomer(project.id, appUserId);
  return rcSubscriber(project, appUserId);
});

rcRoute("DELETE", "/subscribers/:id", async (req, _res, [id]) => {
  const project = await rcProject(req, true);
  const appUserId = cleanId(decodeURIComponent(id));
  await db.recursiveDelete(db.doc(`projects/${project.id}/customers/${appUserId}`));
  return { app_user_id: appUserId, deleted: true };
});

rcRoute("POST", "/subscribers/:id/attributes", async (req, _res, [id]) => {
  const project = await rcProject(req);
  const appUserId = cleanId(decodeURIComponent(id));
  const attrs = req.body?.attributes;
  if (!attrs || typeof attrs !== "object" || Object.keys(attrs).length > 50) throw new HttpError(400, "invalid_attributes");
  const values: Record<string, unknown> = {}, times: Record<string, number> = {};
  for (const [k, raw] of Object.entries<any>(attrs)) {
    const key = cleanId(k, 64), v = raw && typeof raw === "object" && "value" in raw ? raw.value : raw;
    values[key] = v === null || v === "" ? FieldValue.delete() : String(v).slice(0, 500);
    times[key] = Number(raw?.updated_at_ms) || Date.now();
  }
  await db.doc(`projects/${project.id}/customers/${appUserId}`).set({ attributes: values, attributesUpdatedAt: times, lastSeenAt: Date.now() }, { merge: true });
  if (typeof values.$appleAdsToken === "string") await resolveAppleAds(project.id, appUserId, values.$appleAdsToken);
  return {};
});

rcRoute("GET", "/subscribers/:id/offerings", async (req, _res, [id]) => {
  const project = await rcProject(req);
  await touchCustomer(project.id, cleanId(decodeURIComponent(id)));
  const { current, offerings } = offeringsFor(project);
  const xp = String(req.get("x-platform") ?? "");
  const platform = /amazon/i.test(xp) ? "amazon" : /galaxy|samsung/i.test(xp) ? "galaxy" : /roku/i.test(xp) ? "roku" : /android/i.test(xp) ? "play_store" : /stripe|web/i.test(String(req.get("x-platform") ?? "")) ? "stripe" : "app_store";
  return {
    current_offering_id: current,
    offerings: Object.entries<any>(offerings ?? {}).map(([identifier, o]) => ({
      identifier, description: o?.description ?? identifier, metadata: o?.metadata ?? null,
      packages: (o?.packages ?? []).map((p: any) => ({
        identifier: p.id, platform_product_identifier: p.productIds?.[platform] ?? Object.values(p.productIds ?? {})[0] ?? null,
      })),
    })),
  };
});

rcRoute("POST", "/subscribers/:id/alias", async (req, _res, [id]) => {
  const project = await rcProject(req);
  const from = cleanId(decodeURIComponent(id)), to = cleanId(String(req.body?.new_app_user_id ?? ""));
  await mergeCustomers(project, from, to);
  return rcSubscriber(project, to);
});

/** RevenueCat `POST /receipts`: store detected from X-Platform or the token shape. */
rcRoute("POST", "/receipts", async req => {
  const project = await rcProject(req);
  const b = req.body ?? {};
  const appUserId = cleanId(String(b.app_user_id ?? ""));
  const token = String(b.fetch_token ?? "");
  if (!appUserId || !token) throw new HttpError(400, "invalid_receipt", "app_user_id and fetch_token are required");
  const platform = String(req.get("x-platform") ?? "").toLowerCase();
  if (b.attributes && typeof b.attributes === "object") {
    const vals = Object.fromEntries(Object.entries<any>(b.attributes).slice(0, 50).map(([k, v]) => [cleanId(k, 64), String(v?.value ?? v).slice(0, 500)]));
    await db.doc(`projects/${project.id}/customers/${appUserId}`).set({ attributes: vals }, { merge: true });
  }
  if (/amazon/.test(platform)) {
    await ingestAmazonPurchase(project, appUserId, { receiptId: token, amazonUserId: b.store_user_id ?? b.store_user_ID ?? b.amazon_user_id,
      productId: b.product_ids?.[0] ?? b.product_id, priceMicros: b.price ? Math.round(Number(b.price) * 1e6) : undefined, currency: b.currency });
  } else if (/galaxy|samsung/.test(platform)) {
    await ingestGalaxyPurchase(project, appUserId, { purchaseId: token, productId: b.product_ids?.[0] ?? b.product_id, priceMicros: b.price ? Math.round(Number(b.price) * 1e6) : undefined, currency: b.currency });
  } else if (/roku/.test(platform)) {
    await ingestRokuPurchase(project, appUserId, { transactionId: token });
  } else if (platform === "stripe" || /^(sub|cs)_/.test(token)) {
    const { ingestStripeFetchToken } = await import("./stripe");
    await ingestStripeFetchToken(project, appUserId, token);
  } else if (platform === "android" || b.product_ids || b.product_id && !/^ey/.test(token)) {
    const g = { purchaseToken: token, productId: String(b.product_ids?.[0] ?? b.product_id ?? ""),
      priceMicros: b.price ? Math.round(Number(b.price) * 1e6) : undefined, currency: b.currency };
    // RevenueCat's Android SDK doesn't say whether the token is a subscription: try both.
    const first = b.normal_duration || b.product_type === "subs" ? "subscription" : "inapp";
    await ingestGooglePurchase(project, appUserId, { ...g, type: first })
      .catch(() => ingestGooglePurchase(project, appUserId, { ...g, type: first === "inapp" ? "subscription" : "inapp" }));
  } else if (token.split(".").length === 3) {
    await ingestAppleTransaction(project, appUserId, token);
  } else {
    throw new HttpError(422, "legacy_receipt_unsupported", "Send the StoreKit 2 signed transaction (JWS) as fetch_token; base64 app receipts are not supported");
  }
  return rcSubscriber(project, appUserId);
});

rcRoute("POST", "/subscribers/:id/entitlements/:ent/promotional", async (req, _res, [id, ent]) => {
  const project = await rcProject(req, true);
  const appUserId = cleanId(decodeURIComponent(id)), entitlement = cleanId(decodeURIComponent(ent), 64);
  const days = promotionalDays(req.body?.duration);
  const endMs = Number(req.body?.end_time_ms);
  if (days === undefined && !endMs) throw new HttpError(400, "invalid_duration");
  const now = Date.now();
  const ref = db.doc(`projects/${project.id}/customers/${appUserId}/purchases/promo_${entitlement}`);
  const prev = (await ref.get()).data() as Purchase | undefined;
  // Stack like RevenueCat: a new grant extends from the current promotional expiry when still running.
  const from = prev?.expiresAt && prev.expiresAt > now ? prev.expiresAt : now;
  await upsertPurchase(project, appUserId, {
    id: `promo_${entitlement}`, store: "promotional", productId: `promo:${entitlement}`, type: "non_consumable", status: "active",
    purchasedAt: prev?.purchasedAt ?? now, latestPurchaseAt: now, expiresAt: endMs || (days === null ? null : from + days! * 86400000),
    willRenew: false, isTrial: false, isSandbox: false, priceMicros: 0, currency: project.config.currency, periodMonths: 0, billingIssue: false, updatedAt: now,
  });
  return rcSubscriber(project, appUserId);
});

rcRoute("POST", "/subscribers/:id/entitlements/:ent/revoke_promotionals", async (req, _res, [id, ent]) => {
  const project = await rcProject(req, true);
  const appUserId = cleanId(decodeURIComponent(id)), entitlement = cleanId(decodeURIComponent(ent), 64);
  const ref = db.doc(`projects/${project.id}/customers/${appUserId}/purchases/promo_${entitlement}`);
  const prev = (await ref.get()).data() as Purchase | undefined;
  if (prev) {
    const now = Date.now();
    await upsertPurchase(project, appUserId, { ...prev, status: "revoked", expiresAt: now, updatedAt: now });
  }
  return rcSubscriber(project, appUserId);
});

for (const action of ["revoke", "refund", "defer"]) {
  rcRoute("POST", `/subscribers/:id/subscriptions/:pid/${action}`, async () => {
    throw new HttpError(501, "not_supported", `Use the store console to ${action} this subscription; MoneyMaker picks the change up from store notifications.`);
  });
}

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
    aps: { alert: { title: "+9,99 € · MoneyMaker", subtitle: "Notification de test", body: "Nouvel abonné · mensuel · 🇫🇷 FR" }, sound: saleSoundFile(d.prefs ?? {}), "thread-id": "test", category: "SALE" },
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

// ── Finance : du brut au net en poche ───────────────────────────────────────
route("GET", "/v1/finance", async req => {
  const uid = requireUser(await authenticate(req));
  const { waterfallFor, PRESETS } = await import("./finance");
  const days = Math.min(365, Math.max(1, Number(req.query.days ?? 28)));
  const w = await waterfallFor(uid, days, projectIdsParam(req));
  return { ...w, presets: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, { label: v.label, note: v.note }])) };
});

route("PUT", "/v1/finance/settings", async req => {
  const uid = requireUser(await authenticate(req));
  const { sanitizeFinance, financeSettings } = await import("./finance");
  let next;
  try { next = sanitizeFinance(req.body ?? {}, await financeSettings(uid)); } catch (e) { throw new HttpError(400, (e as Error).message); }
  await db.doc(`users/${uid}/settings/finance`).set(next);
  return { settings: next };
});

route("GET", "/v1/finance/plan", async req => {
  const uid = requireUser(await authenticate(req));
  const { planFor } = await import("./plan");
  const days = Math.min(365, Math.max(1, Number(req.query.days ?? 28)));
  const goal = Number(req.query.goal ?? 0);
  return planFor(uid, days, projectIdsParam(req), goal > 0 ? Math.round(goal * 1e6) : undefined);
});

route("GET", "/v1/finance/export", async (req, res) => {
  const uid = requireUser(await authenticate(req));
  const { accountingCsv } = await import("./plan");
  const month = String(req.query.month ?? new Date().toISOString().slice(0, 7));
  let csv;
  try { csv = await accountingCsv(uid, month, projectIdsParam(req)); } catch (e) { throw new HttpError(400, (e as Error).message); }
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="moneymaker-${month}.csv"`);
  res.status(200).send(csv);
});

route("GET", "/v1/expenses", async req => {
  const uid = requireUser(await authenticate(req));
  const { expensesFor } = await import("./plan");
  return { expenses: await expensesFor(uid) };
});

route("PUT", "/v1/expenses/:id", async (req, _res, [id]) => {
  const uid = requireUser(await authenticate(req));
  const { sanitizeExpense } = await import("./plan");
  let e;
  try { e = sanitizeExpense(cleanId(id, 60), req.body); } catch (err) { throw new HttpError(400, (err as Error).message); }
  await db.doc(`users/${uid}/expenses/${e.id}`).set(JSON.parse(JSON.stringify(e)));
  return { expense: e };
});

route("DELETE", "/v1/expenses/:id", async (req, _res, [id]) => {
  const uid = requireUser(await authenticate(req));
  await db.doc(`users/${uid}/expenses/${cleanId(id, 60)}`).delete();
  return { ok: true };
});

route("GET", "/v1/insights", async req => {
  const uid = requireUser(await authenticate(req));
  const projects = await db.collection("projects").where("members", "array-contains", uid).select().get();
  const all = (await Promise.all(projects.docs.map(async p =>
    (await db.collection(`projects/${p.id}/insights`).orderBy("at", "desc").limit(20).get()).docs.map(d => ({ id: d.id, ...d.data() }))))).flat()
    .sort((a: any, b: any) => b.at - a.at).slice(0, 40);
  return { insights: all };
});

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

// ══ Growth: remote paywalls, targeting, placements, experiments (growth.ts) ══════════════
const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

/** GET /v1/offerings — resolves `current` + `placements` for the calling user, enrolls them in running experiments. */
async function resolvedOfferings(req: Request, project: Project) {
  const q = req.query as Record<string, string | undefined>;
  const ua = String(req.get("user-agent") ?? "");
  const cfg = project.config;
  const appUserId = q.appUserId ? cleanId(String(q.appUserId)) : undefined;
  const ctx: Context = {
    appUserId,
    platform: q.platform ? String(q.platform).toLowerCase() : /Android/i.test(ua) ? "android" : /iOS|CFNetwork|Darwin/i.test(ua) ? "ios" : undefined,
    appVersion: q.appVersion ? String(q.appVersion).slice(0, 20) : undefined,
    country: q.country ? String(q.country).slice(0, 2).toUpperCase() : (req.get("x-country-code") ?? undefined),
  };
  const allRules = [...(cfg.targeting?.rules ?? []), ...Object.values(cfg.targeting?.placements ?? {}).flatMap(p => p.rules ?? [])];
  const needsCustomer = allRules.some(r => r.conditions.attributes || r.conditions.newCustomersOnly);
  if (appUserId && needsCustomer) {
    const snap = await db.doc(`projects/${project.id}/customers/${appUserId}`).get();
    ctx.attributes = snap.get("attributes") ?? {};
    ctx.isNewCustomer = !snap.exists || Object.keys(snap.get("entitlements") ?? {}).length === 0;
  }
  const r = resolveOfferings(cfg, ctx);
  if (appUserId) await Promise.all(r.experiments.map(e =>
    db.doc(`projects/${project.id}/experimentEnrollments/${e.experimentId}_${encodeURIComponent(appUserId)}`)
      .create({ experimentId: e.experimentId, variant: e.variant, offeringId: e.offeringId, placement: e.placement, appUserId, at: Date.now(), platform: ctx.platform ?? null, country: ctx.country ?? null })
      .catch(() => null)));
  // `entitlements` (entitlement → product ids) lets SDKs compute entitlements offline from local store transactions.
  return { current: r.current, offerings: cfg.offerings, placements: r.placements, experiments: r.experiments, entitlements: cfg.entitlements ?? {} };
}

route("POST", "/v1/customers/:id/paywall-events", async (req, _res, [id]) => {
  const project = await clientProject(req);
  const appUserId = cleanId(decodeURIComponent(id));
  const b = req.body ?? {};
  const type = String(b.type ?? "");
  if (!PAYWALL_EVENT_TYPES.includes(type)) throw new HttpError(400, "invalid_type", `type ∈ ${PAYWALL_EVENT_TYPES.join(", ")}`);
  const offeringId = cleanId(String(b.offeringId ?? ""), 64);
  const opt = (v: unknown) => (v === undefined || v === null || v === "" ? null : cleanId(String(v), 64));
  const ev = { type, offeringId, appUserId, placement: opt(b.placement), experimentId: opt(b.experimentId), variant: opt(b.variant), at: Date.now() };
  const batch = db.batch();
  batch.set(db.collection(`projects/${project.id}/paywallEvents`).doc(), ev);
  batch.set(db.doc(`projects/${project.id}/paywallStats/${dayKey()}`), { day: dayKey(), counts: { [offeringId]: { [type]: FieldValue.increment(1) } } }, { merge: true });
  if (ev.experimentId && ev.variant) batch.set(db.doc(`projects/${project.id}/experimentStats/${ev.experimentId}`), { variants: { [ev.variant]: { [type]: FieldValue.increment(1) } } }, { merge: true });
  await batch.commit();
  return { ok: true };
});

/** Daily paywall counters per offering (dashboard). */
route("GET", "/v1/projects/:pid/paywall-stats", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  const days = Math.min(365, Math.max(1, Number(req.query.days ?? 30)));
  const since = dayKey(Date.now() - (days - 1) * 86400000);
  const snap = await db.collection(`projects/${project.id}/paywallStats`).where("day", ">=", since).get();
  const totals: Record<string, Record<string, number>> = {};
  for (const d of snap.docs) for (const [off, c] of Object.entries<any>(d.get("counts") ?? {}))
    for (const [t, n] of Object.entries<number>(c)) (totals[off] ??= {})[t] = (totals[off][t] ?? 0) + n;
  return { days, byDay: snap.docs.map(d => d.data()).sort((a: any, b: any) => a.day.localeCompare(b.day)), totals };
});

route("GET", "/v1/projects/:pid/experiments/:eid/results", async (req, _res, [pid, eid]) => {
  const project = await projectFor(await authenticate(req), pid);
  const exp = (project.config.experiments ?? []).find(e => e.id === decodeURIComponent(eid));
  if (!exp) throw new HttpError(404, "experiment_not_found");
  const [enr, stats] = await Promise.all([
    db.collection(`projects/${project.id}/experimentEnrollments`).where("experimentId", "==", exp.id).limit(50000).get(),
    db.doc(`projects/${project.id}/experimentStats/${exp.id}`).get(),
  ]);
  const enrollments = enr.docs.map(d => d.data() as { appUserId: string; variant: string; at: number });
  const since = Math.min(exp.startedAt ?? Date.now(), ...enrollments.map(e => e.at));
  let txQuery = db.collection(`projects/${project.id}/transactions`).where("at", ">=", since);
  if (exp.stoppedAt) txQuery = txQuery.where("at", "<=", exp.stoppedAt);
  const tx = enrollments.length ? (await txQuery.limit(100000).get()).docs.map(d => d.data() as any) : [];
  const impressions = Object.fromEntries(Object.entries<any>(stats.get("variants") ?? {}).map(([v, c]) => [v, c.impression ?? 0]));
  return { experiment: exp, currency: project.config.currency, variants: aggregateResults(exp.variants, enrollments, tx, impressions), paywallEvents: stats.get("variants") ?? {} };
});
// ══ end Growth ═════════════════════════════════════════════════════════════════════════

// ── Prédiction de LTV (ltv.ts) ─────────────────────────────────────────────
route("GET", "/v1/projects/:pid/ltv-prediction", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  return projectLtv(project, String(req.query.groupBy ?? "product"));
});

// ── Audiences (audiences.ts) ───────────────────────────────────────────────
const audienceRow = (r: any, now: number) => ({ id: r.id, status: customerStatus(r.purchases, now), country: r.country, firstSeenAt: r.firstSeenAt,
  lastSeenAt: r.lastSeenAt ?? null, totalSpentMicros: r.totalSpentMicros, activeEntitlements: r.activeEntitlements, appleAdsCampaign: r.appleAds?.campaignId ?? null,
  products: [...new Set(r.purchases.map((p: any) => p.productId))], stores: [...new Set(r.purchases.map((p: any) => p.store))] });

route("GET", "/v1/projects/:pid/audiences", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  const audiences = ((project.config as any).audiences ?? []) as any[];
  if (req.query.counts === "false" || !audiences.length) return { audiences };
  const { rows, truncated } = await loadCustomerRows(project);
  const now = Date.now();
  const { matchAudience } = await import("./audiences");
  return { audiences: audiences.map(a => ({ ...a, count: rows.filter(r => matchAudience(a.filters, r, now)).length })), truncated };
});

/** Filtres non enregistrés (constructeur du dashboard) : nombre + premier aperçu. */
route("POST", "/v1/projects/:pid/audiences/preview", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid, false, "viewer");
  const requestCtxStore = requestCtx.getStore(); if (requestCtxStore) requestCtxStore.skipAudit = true;
  let filters;
  try { filters = sanitizeFilters(req.body?.filters ?? {}); } catch (e) { throw new HttpError(400, (e as Error).message); }
  const now = Date.now();
  const { rows, scanned, truncated } = await audienceCustomers(project, { filters }, now);
  return { filters, count: rows.length, scanned, truncated, customers: rows.slice(0, 50).map(r => audienceRow(r, now)) };
});

route("GET", "/v1/projects/:pid/audiences/:aid/customers", async (req, res, [pid, aid]) => {
  const project = await projectFor(await authenticate(req), pid);
  const audience = audienceById(project, cleanId(aid, 64));
  const now = Date.now();
  const { rows, scanned, truncated } = await audienceCustomers(project, audience, now);
  if (req.query.format === "csv") {
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="${audience.id}.csv"`);
    res.status(200).send(audienceCsv(rows, now));
    return;
  }
  const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100) || 100));
  const offset = Math.max(0, Number(req.query.cursor ?? 0) || 0);
  const page = rows.slice(offset, offset + limit);
  return { audience, count: rows.length, scanned, truncated, customers: page.map(r => audienceRow(r, now)), nextCursor: offset + limit < rows.length ? String(offset + limit) : null };
});

// ── Publicité (ads.ts) ─────────────────────────────────────────────────────
/** SDK (clé publique) : revenu publicitaire au niveau de l'impression (paid event handler Google Mobile Ads). */
route("POST", "/v1/customers/:id/ad-events", async (req, _res, [id]) => {
  const project = await clientProject(req);
  const appUserId = cleanId(decodeURIComponent(id));
  let ev;
  try { ev = sanitizeAdEvent(req.body ?? {}, appUserId, Date.now()); } catch (e) { throw new HttpError(400, (e as Error).message); }
  await recordAdEvent(project, ev);
  return { ok: true };
});

/** AdMob Server-Side Verification (récompenses) : URL de callback à saisir dans AdMob → ad unit → SSV. */
route("GET", "/v1/admob/ssv/:pid", async (req, _res, [pid]) => {
  const project = await getProject(cleanId(decodeURIComponent(pid), 128)).catch(() => { throw new HttpError(404, "project_not_found"); });
  const raw = String(req.originalUrl ?? req.url ?? "");
  const qi = raw.indexOf("?");
  try { return await handleSsv(project, qi >= 0 ? raw.slice(qi + 1) : ""); }
  catch (e) {
    const m = (e as Error).message;
    if (["missing_signature", "missing_key_id", "unknown_key_id", "invalid_signature"].includes(m)) throw new HttpError(m === "invalid_signature" || m === "unknown_key_id" ? 403 : 400, m);
    if (m === "admob_keys_unavailable") throw new HttpError(503, m);
    throw e;
  }
});

// ── Benchmarks (benchmarks.ts) ─────────────────────────────────────────────
route("GET", "/v1/projects/:pid/benchmarks", async (req, _res, [pid]) => projectBenchmarks(await projectFor(await authenticate(req), pid)));

// ── Monnaie virtuelle (wallet.ts) ──────────────────────────────────────────
const currenciesOf = (project: Project) => ((project.config as any).virtualCurrencies ?? []) as { code: string; name: string }[];
function walletCode(project: Project, raw: string) {
  const code = decodeURIComponent(raw).toUpperCase();
  if (!currenciesOf(project).some(c => c.code === code)) throw new HttpError(404, "unknown_virtual_currency");
  return code;
}
async function walletMove(req: Request, id: string, rawCode: string, kind: "spend" | "grant") {
  const caller = await authenticate(req);
  if (caller.kind !== "secret") throw new HttpError(403, "secret_key_required", "Server-side only: use the project's secret key (mm_sk_…)");
  const project = await getProject(caller.projectId);
  const ctx = requestCtx.getStore(); if (ctx) { ctx.projectId = project.id; ctx.actor = "key:secret"; }
  const appUserId = cleanId(decodeURIComponent(id)), code = walletCode(project, rawCode);
  let amount: number, key: string | undefined;
  try {
    amount = parseAmount(req.body?.amount);
    key = kind === "spend" || req.body?.idempotencyKey !== undefined ? parseIdempotencyKey(req.body?.idempotencyKey) : undefined;
  } catch (e) { throw new HttpError(400, (e as Error).message); }
  auditNote(`wallet.${kind}`, { appUserId, code, amount });
  try {
    const r = await moveWallet(project.id, appUserId, code, amount, kind, key, req.body?.reason ? String(req.body.reason).slice(0, 100) : undefined);
    return { ...r, wallet: await readWallet(project.id, appUserId, currenciesOf(project) as any) };
  } catch (e) {
    const m = (e as Error).message;
    if (m === "insufficient_balance") throw new HttpError(402, m, "Solde insuffisant");
    if (m === "idempotency_key_reused") throw new HttpError(409, m, "Clé d'idempotence déjà utilisée pour une autre opération");
    throw e;
  }
}

route("GET", "/v1/customers/:id/wallet", async (req, _res, [id]) => {
  const project = await clientProject(req);
  return readWallet(project.id, cleanId(decodeURIComponent(id)), currenciesOf(project) as any);
});
route("POST", "/v1/customers/:id/wallet/:code/spend", async (req, _res, [id, code]) => walletMove(req, id, code, "spend"));
route("POST", "/v1/customers/:id/wallet/:code/grant", async (req, _res, [id, code]) => walletMove(req, id, code, "grant"));

/** Dashboard : solde d'un client vu depuis le projet. */
route("GET", "/v1/projects/:pid/customers/:id/wallet", async (req, _res, [pid, id]) => {
  const project = await projectFor(await authenticate(req), pid);
  return readWallet(project.id, cleanId(decodeURIComponent(id)), currenciesOf(project) as any);
});

// ── Anomalies (anomalies.ts) ───────────────────────────────────────────────
route("GET", "/v1/projects/:pid/anomalies", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  const snap = await db.collection(`projects/${project.id}/anomalies`).orderBy("at", "desc").limit(Math.min(200, Number(req.query.limit ?? 50) || 50)).get();
  return { anomalies: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
});

// ── Charts (RevenueCat parity) ─────────────────────────────────────────────
route("GET", "/v1/charts", async () => ({ charts: CHART_NAMES }));

route("GET", "/v1/projects/:pid/charts/:name", async (req, res, [pid, name]) => {
  const project = await projectFor(await authenticate(req), pid);
  const csvOut = /\.csv$/.test(name) || req.query.format === "csv";
  const chart = await projectChart(project, name.replace(/\.csv$/, ""), req.query as Record<string, unknown>);
  if (!csvOut) return chart;
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="${project.name}-${chart.name}.csv"`);
  res.status(200).send(chartToCsv(chart));
});

// ── Team: members, roles, invitations, audit log ──────────────────────────
route("GET", "/v1/projects/:pid/members", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid);
  return { role: project.role, ...(await listMembers(project, PUBLIC_BASE, atLeast(project.role ?? "viewer", "admin"))) };
});

route("PATCH", "/v1/projects/:pid/members/:uid", async (req, _res, [pid, uid]) => {
  const caller = await authenticate(req);
  const actorUid = requireUser(caller);
  const project = await projectFor(caller, pid, false, "admin");
  const out = await setMemberRole(project, project.role!, actorUid, cleanId(uid, 128), String(req.body?.role ?? ""));
  auditNote("member.role", { target: out.uid, role: out.role, previous: out.previous });
  return out;
});

route("DELETE", "/v1/projects/:pid/members/:uid", async (req, _res, [pid, uid]) => {
  const caller = await authenticate(req);
  const actorUid = requireUser(caller);
  const target = cleanId(uid, 128);
  // Anyone can leave; removing someone else needs admin (checked again in removeMember).
  const project = await projectFor(caller, pid, false, target === actorUid ? "viewer" : "admin");
  const out = await removeMember(project, project.role!, actorUid, target);
  auditNote("member.remove", { target, previous: out.previous });
  return out;
});

route("GET", "/v1/projects/:pid/invites", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid, false, "admin");
  return { invites: (await listMembers(project, PUBLIC_BASE, true)).invites };
});

route("POST", "/v1/projects/:pid/invites", async (req, _res, [pid]) => {
  const caller = await authenticate(req);
  const uid = requireUser(caller);
  const project = await projectFor(caller, pid, false, "admin");
  const inv = await createInvite(project, uid, req.body, PUBLIC_BASE);
  auditNote("invite.create", { email: inv.email, role: inv.role, inviteId: inv.id });
  return { ...inv, note: "Aucun e-mail n'est envoyé : partage ce lien avec la personne invitée." };
});

route("DELETE", "/v1/projects/:pid/invites/:id", async (req, _res, [pid, id]) => {
  const caller = await authenticate(req);
  requireUser(caller);
  const project = await projectFor(caller, pid, false, "admin");
  const out = await deleteInvite(project, cleanId(id, 64));
  auditNote("invite.revoke", { inviteId: id, email: out.email });
  return { ok: true };
});

route("GET", "/v1/invites/:token", async (req, _res, [token]) => {
  requireUser(await authenticate(req));
  return peekInvite(cleanId(token, 100));
});

route("POST", "/v1/invites/:token/accept", async (req, _res, [token]) => {
  const caller = await authenticate(req);
  const uid = requireUser(caller);
  return acceptInvite(cleanId(token, 100), uid, caller.kind === "user" ? caller.email : undefined);
});

route("GET", "/v1/projects/:pid/audit", async (req, _res, [pid]) => {
  const project = await projectFor(await authenticate(req), pid, false, "admin");
  return listAudit(project.id, Number(req.query.limit ?? 100), req.query.before ? Number(req.query.before) : undefined);
});

// ══ Web ══════════════════════════════════════════════════════════════════
// Hosted web paywall /pay/{pid}/{oid}, success + redemption, customer portal /manage/{pid}, Paddle Billing.
route("POST", "/v1/webhooks/paddle/:pid", async (req, _res, [pid]) => {
  const project = await getProject(cleanId(pid));
  const r = await ingestPaddleWebhook(project, req.rawBody, req.get("paddle-signature"));
  await markHealth(project.id, "paddleWebhook");
  return r;
});

// Public (no key: the hosted page has none). Only sanitized offering + paywall + Stripe price display info.
route("GET", "/v1/web/:pid/offering/:oid", async (req, _res, [pid, oid]) => {
  const project = await getProject(cleanId(pid));
  return withPrices(project, publicOffering(project, cleanId(decodeURIComponent(oid), 64)));
});
// Checkout only for a package of that offering (price id never taken from the client).
route("POST", "/v1/web/:pid/offering/:oid/checkout", async (req, _res, [pid, oid]) =>
  webCheckout(await getProject(cleanId(pid)), decodeURIComponent(oid), req.body, PUBLIC_BASE));
route("GET", "/v1/web/:pid/success", async (req, _res, [pid]) =>
  webSuccess(await getProject(cleanId(pid)), String(req.query.session_id ?? ""), PUBLIC_BASE));
route("POST", "/v1/web/:pid/portal", async (req, _res, [pid]) => webPortal(await getProject(cleanId(pid)), req.body, PUBLIC_BASE));

// SDK (public key).
route("POST", "/v1/customers/:id/redeem", async (req, _res, [id]) => {
  const project = await clientProject(req);
  const appUserId = cleanId(decodeURIComponent(id));
  await redeemWebPurchase(project, appUserId, String(req.body?.token ?? ""));
  return customerInfo(project, appUserId);
});
route("POST", "/v1/customers/:id/manage-link", async (req, _res, [id]) =>
  manageLink(await clientProject(req), cleanId(decodeURIComponent(id)), PUBLIC_BASE));
// ══ /Web ═════════════════════════════════════════════════════════════════

// ── Dispatcher ─────────────────────────────────────────────────────────────
/** Routes returning customer info are signed (trusted entitlements, see signing.ts). */

// ══ Stripe App ══ ═══════════════════════════════════════════════════════════
// Routes appelées par l'app MoneyMaker installée dans le Dashboard Stripe (stripe-app/).
// Double authentification :
//   1. Stripe-Signature (fetchStripeSignature) vérifiée avec le secret de signature de l'app
//      (env STRIPE_APP_SECRET, virgules pour une rotation, ou Firestore system/stripeApp { signingSecret }) ;
//      payload signé = {"user_id","account_id"} transmis dans X-Stripe-User-Id / X-Stripe-Account-Id ;
//   2. Authorization: Bearer mm_sk_… (clé secrète MoneyMaker du marchand, lue dans le Secret Store Stripe).
// Si le projet connaît son compte Stripe (config.stripe.accountId), le compte signé doit être le même.
let stripeAppSecretsCache: { at: number; secrets: string[] } | null = null;
async function stripeAppSecrets(): Promise<string[]> {
  const env = (process.env.STRIPE_APP_SECRET ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (env.length) return env;
  if (stripeAppSecretsCache && Date.now() - stripeAppSecretsCache.at < 300_000) return stripeAppSecretsCache.secrets;
  const doc = await db.doc("system/stripeApp").get();
  const secrets = [doc.get("signingSecret"), ...((doc.get("signingSecrets") as string[] | undefined) ?? [])].filter((s): s is string => typeof s === "string" && !!s);
  stripeAppSecretsCache = { at: Date.now(), secrets };
  return secrets;
}

async function stripeAppProject(req: Request): Promise<{ project: Project & { role?: Role }; accountId: string; userId: string }> {
  const userId = String(req.get("x-stripe-user-id") ?? req.body?.user_id ?? "");
  const accountId = String(req.get("x-stripe-account-id") ?? req.body?.account_id ?? "");
  if (!/^usr_\w+$/.test(userId) || !/^acct_\w+$/.test(accountId)) throw new HttpError(400, "stripe_app_context_missing", "X-Stripe-User-Id / X-Stripe-Account-Id requis");
  const secrets = await stripeAppSecrets();
  if (!secrets.length) throw new HttpError(503, "stripe_app_not_configured", "Secret de signature de l'app Stripe absent côté serveur (STRIPE_APP_SECRET)");
  const check = verifyStripeAppSignature(req.get("stripe-signature"), stripeAppPayload(userId, accountId), secrets);
  if (!check.ok) throw new HttpError(401, "invalid_stripe_signature", check.reason);
  const caller = await authenticate(req);
  if (caller.kind !== "secret") throw new HttpError(403, "secret_key_required", "Colle ta clé secrète MoneyMaker (mm_sk_…) dans les réglages de l'app");
  const project = await projectFor(caller, caller.projectId);
  const known = (project.config as any).stripe?.accountId as string | undefined;
  if (known && known !== accountId) throw new HttpError(403, "stripe_account_mismatch", "Cette clé MoneyMaker appartient à un projet relié à un autre compte Stripe");
  return { project, accountId, userId };
}

const dashboardCustomerUrl = (pid: string, appUserId?: string) =>
  `${PUBLIC_BASE}/#${encodeURIComponent(pid)}/customers${appUserId ? `/${encodeURIComponent(appUserId)}` : ""}`;

async function stripeAppCustomer(project: Project, stripeCustomerId: string) {
  const appUserId = await lookupIndex(project.id, `stripe_cus:${stripeCustomerId}`);
  const entitlementIds = Object.keys(project.config.entitlements ?? {});
  const base = { project: { id: project.id, name: project.name, currency: project.config.currency }, stripeCustomerId, entitlementIds, grantDays: STRIPE_APP_GRANT_DAYS };
  if (!appUserId) return { ...base, linked: false as const, dashboardUrl: dashboardCustomerUrl(project.id) };
  const [info, snap, events] = await Promise.all([
    customerInfo(project, appUserId),
    db.doc(`projects/${project.id}/customers/${appUserId}`).get(),
    db.collection(`projects/${project.id}/events`).where("appUserId", "==", appUserId).orderBy("at", "desc").limit(15).get(),
  ]);
  return {
    ...base, linked: true as const, appUserId, dashboardUrl: dashboardCustomerUrl(project.id, appUserId),
    entitlements: Object.values(info.entitlements), activeEntitlements: info.activeEntitlements,
    purchases: info.purchases.sort((a, b) => (b.purchasedAt ?? 0) - (a.purchasedAt ?? 0)),
    stores: [...new Set(info.purchases.map(p => p.store))],
    totalSpentMicros: snap.get("totalSpentMicros") ?? 0,
    isPaying: snap.get("isPaying") ?? false,
    firstSeenAt: info.firstSeenAt, lastSeenAt: snap.get("lastSeenAt") ?? null, country: snap.get("country") ?? null,
    attributes: Object.fromEntries(Object.entries(info.attributes ?? {}).slice(0, 20)),
    events: events.docs.map(d => { const e = d.data(); return { id: d.id, type: e.type, store: e.store, productId: e.productId, priceMicros: e.priceMicros ?? null, currency: e.currency ?? null, isSandbox: !!e.isSandbox, at: e.at }; }),
  };
}

route("GET", "/v1/stripe-app/customer/:sc", async (req, _res, [sc]) => {
  const { project } = await stripeAppProject(req);
  const stripeCustomerId = decodeURIComponent(sc);
  if (!isStripeCustomerId(stripeCustomerId)) throw new HttpError(400, "invalid_stripe_customer");
  return stripeAppCustomer(project, stripeCustomerId);
});

route("GET", "/v1/stripe-app/overview", async req => {
  const { project, accountId } = await stripeAppProject(req);
  const m: any = await projectMetrics(project, 28);
  return {
    project: { id: project.id, name: project.name, currency: project.config.currency }, accountId,
    dashboardUrl: `${PUBLIC_BASE}/#${encodeURIComponent(project.id)}/metrics`,
    mrrMicros: m.mrrMicros, revenue28dMicros: m.revenueMicros, netRevenue28dMicros: m.netRevenueMicros,
    previousRevenue28dMicros: m.previous?.revenueMicros ?? null,
    activeSubscriptions: m.activeSubscriptions, activeTrials: m.activeTrials, activeCustomers: m.activeCustomers,
    newCustomers28d: m.newCustomers, trialConversionRate: m.trialConversionRate,
    byStore: m.byStore, revenueByStore: m.revenueByStore ?? {}, generatedAt: m.generatedAt,
  };
});

route("POST", "/v1/stripe-app/customer/:sc/grant", async (req, _res, [sc]) => {
  const { project, userId } = await stripeAppProject(req);
  const stripeCustomerId = decodeURIComponent(sc);
  if (!isStripeCustomerId(stripeCustomerId)) throw new HttpError(400, "invalid_stripe_customer");
  const appUserId = await lookupIndex(project.id, `stripe_cus:${stripeCustomerId}`);
  if (!appUserId) throw new HttpError(404, "customer_not_linked", "Client Stripe non relié à un utilisateur MoneyMaker");
  const entitlement = cleanId(req.body?.entitlement, 64);
  if (!(entitlement in (project.config.entitlements ?? {}))) throw new HttpError(400, "unknown_entitlement");
  const days = parseGrantDays(req.body?.days);
  if (days === undefined) throw new HttpError(400, "invalid_duration");
  auditNote("grant.update", { appUserId, entitlement, days, via: "stripe_app", stripeUser: userId });
  const now = Date.now();
  const ref = db.doc(`projects/${project.id}/customers/${appUserId}/purchases/promo_${entitlement}`);
  const prev = (await ref.get()).data() as Purchase | undefined;
  // Cumul comme RevenueCat : un nouvel accès prolonge l'accès promotionnel encore en cours.
  const from = prev?.status === "active" && prev.expiresAt && prev.expiresAt > now ? prev.expiresAt : now;
  await upsertPurchase(project, appUserId, {
    id: `promo_${entitlement}`, store: "promotional", productId: `promo:${entitlement}`, type: "non_consumable", status: "active",
    purchasedAt: prev?.purchasedAt ?? now, latestPurchaseAt: now, expiresAt: days === null ? null : from + days * 86400000,
    willRenew: false, isTrial: false, isSandbox: false, priceMicros: 0, currency: project.config.currency, periodMonths: 0, billingIssue: false, updatedAt: now,
  });
  return stripeAppCustomer(project, stripeCustomerId);
});
// ══ fin Stripe App ══ ═══════════════════════════════════════════════════════

const SIGNED_ROUTES = new Set([
  "GET /v1/customers/:id", "POST /v1/customers/:id/apple", "POST /v1/customers/:id/google",
  "POST /v1/customers/:id/alias", "POST /v1/customers/:id/test-purchase", "POST /v1/customers/:id/redeem",
]);
async function sendSigned(req: Request, res: Response, out: unknown) {
  const body = JSON.stringify(out);
  const time = Date.now();
  const nonce = String(req.get(NONCE_HEADER) ?? "").slice(0, 128);
  res.set(REQUEST_TIME_HEADER, String(time));
  try { res.set(SIGNATURE_HEADER, signResponse((await getSigningKey()).privateKey, nonce, time, body)); }
  catch (e) { console.error("signing_failed", e); }
  res.status(200).type("application/json").send(body);
}

export async function handle(req: Request, res: Response) {
  const mcpPath = req.path.length > 1 ? req.path.replace(/\/$/, "") : req.path;
  if (isMcpPath(mcpPath)) return handleMcp(req, res, mcpPath, dispatch);
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Nonce, Stripe-Signature, X-Stripe-User-Id, X-Stripe-Account-Id");
  res.set("Access-Control-Expose-Headers", "X-MoneyMaker-Signature, X-Request-Time");
  res.set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  const path = req.path.replace(/^\/api(?=\/)/, "");
  try {
    // Mode démo : lecture seule.
    if (req.method !== "GET" && /^Bearer\s+mm_demo\s*$/i.test(req.get("authorization") ?? "")) throw new HttpError(403, "demo_read_only", "Mode démo : lecture seule");
    for (const [method, re, handler, pattern] of routes) {
      const m = re.exec(path);
      if (!m || method !== req.method) continue;
      const ctx: RequestCtx = { method: req.method };
      const out = await requestCtx.run(ctx, () => handler(req, res, m.slice(1)));
      if (req.method !== "GET" && ctx.projectId && ctx.actor && !ctx.skipAudit) {
        await audit(ctx.projectId, ctx.actor, ctx.auditAction ?? auditActionFor(method, pattern), {
          path, ...(req.body && typeof req.body === "object" && !Array.isArray(req.body) ? { fields: Object.keys(req.body).slice(0, 30) } : {}),
          ...(ctx.auditDetails ?? {}),
        });
      }
      if (!res.headersSent && SIGNED_ROUTES.has(`${method} ${pattern}`)) { await sendSigned(req, res, out ?? { ok: true }); return; }
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

/** Exécute une route /v1 en mémoire (outils MCP) : mêmes contrôles de rôle et même audit qu'un appel HTTP. */
export async function dispatch(method: string, path: string, opts: { query?: Record<string, unknown>; body?: unknown; authorization: string; ip?: string }) {
  const headers: Record<string, string> = { authorization: opts.authorization, "content-type": "application/json", "user-agent": "moneymaker-mcp" };
  const req = { method, path, url: path, originalUrl: path, query: opts.query ?? {}, body: opts.body ?? {}, ip: opts.ip, headers,
    get: (name: string) => headers[name.toLowerCase()], header: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
  let status = 200, payload: unknown, sent = false;
  const res: any = {
    get headersSent() { return sent; },
    set: () => res, setHeader: () => res, type: () => res, vary: () => res,
    status: (s: number) => { status = s; return res; },
    json: (b: unknown) => { payload = b; sent = true; return res; },
    send: (b: unknown) => { payload = b; sent = true; return res; },
    end: () => { sent = true; return res; },
    redirect: (_s: number, url: string) => { payload = { redirect: url }; sent = true; return res; },
  };
  await handle(req, res as Response);
  let body = payload;
  if (typeof body === "string" && /^[[{]/.test(body)) try { body = JSON.parse(body); } catch { /* CSV ou texte */ }
  if (Buffer.isBuffer(body)) body = body.toString("utf8");
  return { status, body: body as any };
}
