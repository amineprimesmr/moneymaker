// Roku Pay web services + push notifications.
// Docs: https://developer.roku.com/dev/docs/roku-web-service        (validate-transaction, JSON dates "/Date(ms+0000)/")
//       https://developer.roku.com/dev/docs/push-notifications-jwt  (RS256 JWT, JWKS at assets.cs.roku.com)
import { createHash, createPublicKey, createVerify } from "crypto";
import { Purchase, PurchaseStatus, HttpError, isoPeriodToMonths } from "./engine";
import type { Project } from "./store";

const store = () => import("./store");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export const ROKU_API = "https://apipub.roku.com/listen/transaction-service.svc";
export const ROKU_JWKS = "https://assets.cs.roku.com/keys/partner-jwks.json";

export const rokuValidateUrl = (devApiKey: string, transactionId: string) =>
  `${ROKU_API}/validate-transaction/${encodeURIComponent(devApiKey)}/${encodeURIComponent(transactionId)}`;

/** "/Date(1581033062000+0000)/" (JSON) or "2020-02-06T23:51:02" (XML, UTC) → ms. */
export function parseRokuDate(v: unknown): number | null {
  if (v == null || v === "") return null;
  const m = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(String(v));
  if (m) return Number(m[1]);
  const s = String(v);
  const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(t) ? t : null;
}

const safe = (s: string) => (/^[A-Za-z0-9_-]{1,100}$/.test(s) ? s : sha(s).slice(0, 40));
export interface RokuHints { period?: string; type?: string; }

/** validate-transaction JSON → Purchase. id keyed on OriginalTransactionId so renewals update one record. */
export function rokuTransactionPurchase(t: any, hints: RokuHints = {}, now = Date.now()): Purchase {
  const original = String(t.OriginalTransactionId ?? t.originalTransactionId ?? t.transactionId);
  const expiresAt = parseRokuDate(t.expirationDate);
  const purchasedAt = parseRokuDate(t.originalPurchaseDate) ?? parseRokuDate(t.purchaseDate) ?? now;
  const latest = parseRokuDate(t.purchaseDate) ?? purchasedAt;
  const isSub = hints.type ? hints.type === "subscription" : expiresAt !== null;
  const amount = Number(t.amount);
  const base = {
    id: `roku_${safe(original)}`, store: "roku" as const, productId: String(t.productId ?? t.productCode ?? "unknown"),
    purchasedAt, latestPurchaseAt: latest, isSandbox: false, updatedAt: now,
    priceMicros: Number.isFinite(amount) && amount > 0 ? Math.round(amount * 1e6) : 0, currency: String(t.currency ?? "USD").toUpperCase(),
  };
  if (!isSub) {
    return { ...base, type: hints.type === "consumable" ? "consumable" : "non_consumable", status: t.cancelled || t.isEntitled === false ? "refunded" : "active",
      expiresAt: null, willRenew: false, isTrial: false, periodMonths: 0, billingIssue: false };
  }
  const entitled = t.isEntitled === true || t.isEntitled === "true";
  const ps = String(t.purchaseStatus ?? "").toLowerCase().replace(/_/g, "");
  let status: PurchaseStatus;
  if (!entitled) status = "expired";
  else if (expiresAt !== null && expiresAt <= now) status = "billing_retry"; // Roku "recovery": entitled with past expiration
  else status = "active";
  const periodMonths = isoPeriodToMonths(hints.period) || (expiresAt && latest < expiresAt ? Math.max(0.23, Math.round(((expiresAt - latest) / (30.4375 * 86400000)) * 4) / 4) : 1);
  return {
    ...base, type: "subscription", status, expiresAt, isTrial: false, periodMonths, billingIssue: status === "billing_retry",
    willRenew: entitled && !t.cancelled && ps !== "inactive" && ps !== "pendinginactive",
  };
}

/** Decodes and verifies a Roku push JWT; returns the decoded `x-Roku-message` JSON. Pure given the JWKS. */
export function verifyRokuPush(jwt: string, jwks: { keys: any[] }, nowSec = Math.floor(Date.now() / 1000)): any {
  const parts = jwt.trim().split(".");
  if (parts.length !== 3) throw new HttpError(401, "invalid_roku_jwt");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  if (header.alg !== "RS256") throw new HttpError(401, "invalid_roku_jwt_alg");
  if (header.jku && header.jku !== ROKU_JWKS && header.jku !== ROKU_JWKS.replace(".json", "-test.json")) throw new HttpError(401, "invalid_roku_jwt_jku");
  const jwk = jwks.keys.find(k => k.kid === header.kid);
  if (!jwk) throw new HttpError(401, "unknown_roku_kid");
  const ok = createVerify("RSA-SHA256").update(`${parts[0]}.${parts[1]}`).verify(createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2], "base64url"));
  if (!ok) throw new HttpError(401, "invalid_roku_signature");
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  if ((claims.exp && claims.exp < nowSec) || (claims.nbf && claims.nbf > nowSec + 300)) throw new HttpError(401, "expired_roku_jwt");
  if (claims["x-Roku-message-type"] && claims["x-Roku-message-type"] !== "roku.rpay.push") throw new HttpError(400, "unexpected_roku_message_type");
  const msg = Buffer.from(String(claims["x-Roku-message"] ?? ""), "base64url").toString("utf8");
  return { message: msg ? JSON.parse(msg) : {}, key: claims["x-Roku-message-key"] ?? null };
}

// ── I/O ─────────────────────────────────────────────────────────────────────
async function devApiKey(project: Project): Promise<string> {
  const k = ((await (await store()).getCredentials(project.id)) as any).roku?.devApiKey;
  if (!k) throw new HttpError(400, "roku_credentials_missing", "Set the Roku Pay web services API key first");
  return k;
}

async function validate(key: string, transactionId: string) {
  const res = await fetch(rokuValidateUrl(key, transactionId), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  const t: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status === 429 ? 429 : 502, "roku_api_error", JSON.stringify(t).slice(0, 300));
  const okStatus = t.status === 0 || t.status === "0" || /success/i.test(String(t.status ?? ""));
  if (!okStatus || t.errorMessage || !t.transactionId) throw new HttpError(400, "roku_invalid_transaction", String(t.errorMessage || t.errorDetails || "").slice(0, 300));
  return t;
}

async function fetchAndStore(project: Project, transactionId: string, appUserId: string | null, hints: RokuHints) {
  const S = await store();
  const t = await validate(await devApiKey(project), transactionId);
  const purchase = rokuTransactionPurchase(t, hints);
  const customerKey = t.rokuCustomerId ? `rokuCustomer:${t.rokuCustomerId}` : null;
  let owner = await S.lookupIndex(project.id, `roku:${purchase.id}`, customerKey);
  if (owner && appUserId && owner !== appUserId && owner.startsWith("$") && !appUserId.startsWith("$")) { await S.mergeCustomers(project, owner, appUserId); owner = appUserId; }
  const target = owner ?? appUserId ?? `$roku:${safe(String(t.rokuCustomerId ?? purchase.id))}`;
  await S.db.doc(`projects/${project.id}/rokuTransactions/${purchase.id}`).set({ transactionId, hints, appUserId: target, updatedAt: Date.now() }, { merge: true });
  const result = await S.upsertPurchase(project, target, purchase, [`roku:${purchase.id}`, ...(customerKey ? [customerKey] : [])]);
  // Upgrade / downgrade: the replaced subscriptions are re-validated so they stop granting access.
  for (const old of (Array.isArray(t.cancelledTransactionIds) ? t.cancelledTransactionIds : []).slice(0, 5)) {
    if (String(old) !== transactionId) await fetchAndStore(project, String(old), target, hints).catch(() => null);
  }
  return { appUserId: target, purchase, ...result };
}

/** Client path: POST /v1/customers/:id/roku { transactionId, period?, type? }. */
export async function ingestRokuPurchase(project: Project, appUserId: string, body: any) {
  const transactionId = String(body?.transactionId ?? "");
  if (!transactionId || transactionId.length > 1024) throw new HttpError(400, "invalid_purchase", "transactionId is required");
  return fetchAndStore(project, transactionId, appUserId, { period: body.period, type: body.type });
}

let jwksCache: { at: number; keys: any[] } | null = null;
async function rokuJwks() {
  if (!jwksCache || Date.now() - jwksCache.at > 3600000) {
    const res = await fetch(ROKU_JWKS, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new HttpError(502, "roku_jwks_unavailable");
    jwksCache = { at: Date.now(), keys: ((await res.json()) as any).keys ?? [] };
  }
  return { keys: jwksCache.keys };
}

/**
 * Server path: Roku Pay push. Accepts the signed JWT (raw body, `jwt` field or Bearer header) and the legacy
 * unsigned JSON (`responseKey` echoed back). Either way the transaction is re-validated with the API, so the
 * push only acts as a trigger. Returns { responseKey } to echo.
 */
export async function ingestRokuNotification(project: Project, raw: string, body: any, authorization?: string) {
  const S = await store();
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1];
  const jwt = bearer ?? (typeof body?.jwt === "string" ? body.jwt : raw.trim().split(".").length === 3 && !raw.trim().startsWith("{") ? raw.trim() : null);
  let msg: any = body ?? {};
  if (jwt) msg = verifyRokuPush(jwt, await rokuJwks()).message;
  const transactionId = String(msg.transactionId ?? msg.TransactionId ?? "");
  if (!transactionId) return { responseKey: msg.responseKey ?? null, ignored: true };
  const known = (await S.db.doc(`projects/${project.id}/rokuTransactions/roku_${safe(String(msg.originalTransactionId ?? transactionId))}`).get()).data() ?? {};
  await fetchAndStore(project, transactionId, null, known.hints ?? {});
  return { responseKey: msg.responseKey ?? null, transactionType: msg.transactionType ?? null };
}
