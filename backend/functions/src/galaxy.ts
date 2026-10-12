// Samsung Galaxy Store (Samsung IAP) server-side verification.
// Docs: https://developer.samsung.com/iap/programming-guide/samsung-iap-server-api.html   (GET iap/v6/receipt?purchaseID=)
//       https://developer.samsung.com/iap/api/iap-subscription-api.html                    (Check status of subscription)
//       https://developer.samsung.com/iap/api/get-started.html                             (Authorization + service-account-id headers)
//       https://developer.samsung.com/galaxy-store/galaxy-store-developer-api/create-an-access-token.html
import { createHash, createSign } from "crypto";
import { Purchase, PurchaseStatus, HttpError, isoPeriodToMonths } from "./engine";
import { toAlpha2 } from "./countries";
import type { Project } from "./store";

const store = () => import("./store");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export const RECEIPT_URL = "https://iap.samsungapps.com/iap/v6/receipt";
export const DEVAPI = "https://devapi.samsungapps.com";

/** Samsung dates: "YYYY-MM-DD HH:mm:ss GMT" (also tolerates ISO). */
export function parseSamsungDate(v: unknown): number | null {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

const safeId = (s: string) => (/^[A-Za-z0-9_-]{1,100}$/.test(s) ? s : sha(s).slice(0, 40));
export const galaxyPurchaseId = (purchaseId: string) => `gs_${safeId(purchaseId)}`;

export interface GalaxyHints { priceMicros?: number; currency?: string; period?: string; consumable?: boolean; }

/** v6/receipt response for a one-time item → Purchase. */
export function galaxyItemPurchase(purchaseId: string, r: any, hints: GalaxyHints = {}, now = Date.now()): Purchase {
  const at = parseSamsungDate(r.purchaseDate) ?? now;
  const consumable = hints.consumable ?? r.consumeYN !== undefined;
  const amount = Number(r.paymentAmount);
  return {
    id: galaxyPurchaseId(purchaseId), store: "galaxy", productId: String(r.itemId ?? "unknown"),
    type: consumable ? "consumable" : "non_consumable", status: r.status === "cancel" || r.cancelDate ? "refunded" : "active",
    purchasedAt: at, latestPurchaseAt: at, expiresAt: null, willRenew: false, isTrial: false, isSandbox: r.mode === "TEST",
    priceMicros: Number.isFinite(amount) && amount > 0 ? Math.round(amount * 1e6) : hints.priceMicros ?? 0,
    currency: String(r.currencyCode ?? hints.currency ?? "USD").toUpperCase(), periodMonths: 0, billingIssue: false,
    updatedAt: now, country: toAlpha2(r.countryCode),
  };
}

/** "Check status of subscription" response → Purchase. The stable id is subscriptionFirstPurchaseID. */
export function galaxySubscriptionPurchase(purchaseId: string, s: any, hints: GalaxyHints = {}, now = Date.now()): Purchase {
  const end = parseSamsungDate(s.subscriptionEndDate);
  const graceEnd = parseSamsungDate(s.gracePeriodEndDate);
  let status: PurchaseStatus = "active";
  if (s.gracePeriodYN === "Y" && (graceEnd ?? 0) > now) status = "grace";
  else if (end !== null && end <= now) status = "expired";
  const price = Array.isArray(s.price) ? s.price[0] : s.price;
  const local = Number(price?.localPrice);
  const purchasedAt = parseSamsungDate(s.subscriptionPurchaseDate) ?? now;
  return {
    id: galaxyPurchaseId(String(s.subscriptionFirstPurchaseID ?? purchaseId)), store: "galaxy", productId: String(s.itemID ?? s.itemId ?? "unknown"),
    type: "subscription", status, purchasedAt, latestPurchaseAt: parseSamsungDate(s.latestRenewalDate) ?? purchasedAt,
    expiresAt: status === "grace" ? graceEnd : end, willRenew: s.subscriptionStatus === "ACTIVE" && status !== "expired",
    isTrial: s.freeTrial === "Y" || s.currentPaymentPlan === "F", isSandbox: s.realMode === "N",
    priceMicros: Number.isFinite(local) && local > 0 ? Math.round(local * 1e6) : hints.priceMicros ?? 0,
    currency: String(price?.localCurrencyCode ?? hints.currency ?? "USD").toUpperCase(),
    periodMonths: isoPeriodToMonths(hints.period) || 1, billingIssue: status === "grace", updatedAt: now, country: toAlpha2(s.countryCode),
  };
}

/** RS256 JWT for POST /auth/accessToken (iss = service account id, scopes, exp ≤ 20 min). */
export function galaxyServiceJwt(serviceAccountId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: serviceAccountId, scopes: ["publishing"], iat: nowSec, exp: nowSec + 1140 })}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(privateKeyPem).toString("base64url")}`;
}

// ── I/O ─────────────────────────────────────────────────────────────────────
interface GalaxyCreds { serviceAccountId?: string; privateKey?: string; packageName?: string }
const tokens = new Map<string, { token: string; at: number }>();

async function accessToken(c: GalaxyCreds): Promise<string> {
  const hit = tokens.get(c.serviceAccountId!);
  if (hit && Date.now() - hit.at < 3600000) return hit.token;
  const res = await fetch(`${DEVAPI}/auth/accessToken`, {
    method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${galaxyServiceJwt(c.serviceAccountId!, c.privateKey!)}` },
    signal: AbortSignal.timeout(15000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j?.createdItem?.accessToken) throw new HttpError(502, "galaxy_auth_error", JSON.stringify(j).slice(0, 300));
  tokens.set(c.serviceAccountId!, { token: j.createdItem.accessToken, at: Date.now() });
  return j.createdItem.accessToken;
}

export async function ingestGalaxyPurchase(project: Project, appUserId: string, body: any) {
  const S = await store();
  const purchaseId = String(body?.purchaseId ?? body?.purchaseID ?? "");
  if (!purchaseId || purchaseId.length > 200) throw new HttpError(400, "invalid_purchase", "purchaseId is required");
  const creds = (((await S.getCredentials(project.id)) as any).galaxy ?? {}) as GalaxyCreds;
  const res = await fetch(`${RECEIPT_URL}?purchaseID=${encodeURIComponent(purchaseId)}`, { signal: AbortSignal.timeout(15000) });
  const r: any = await res.json().catch(() => ({}));
  if (!res.ok || r.status === "fail" || !r.itemId) throw new HttpError(400, "galaxy_invalid_purchase", `${r.errorCode ?? res.status} ${r.errorMessage ?? ""}`.trim());
  if (creds.packageName && r.packageName && r.packageName !== creds.packageName) throw new HttpError(400, "galaxy_package_mismatch");
  if (body.productId && String(body.productId) !== String(r.itemId)) throw new HttpError(400, "galaxy_product_mismatch");
  const hints: GalaxyHints = { priceMicros: Number(body.priceMicros) || undefined, currency: body.currency, period: body.period, consumable: body.type === "consumable" ? true : body.type ? false : undefined };
  let purchase: Purchase;
  if (r.itemType === "Subscription") {
    if (!creds.serviceAccountId || !creds.privateKey || !creds.packageName) throw new HttpError(400, "galaxy_credentials_missing", "Subscriptions need a Seller Portal service account (id + private key) and the package name");
    const token = await accessToken(creds);
    const sres = await fetch(`${DEVAPI}/iap/seller/v6/applications/${encodeURIComponent(creds.packageName)}/purchases/subscriptions/${encodeURIComponent(purchaseId)}`, {
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}`, "service-account-id": creds.serviceAccountId }, signal: AbortSignal.timeout(15000),
    });
    const s: any = await sres.json().catch(() => ({}));
    if (!sres.ok) throw new HttpError(502, "galaxy_api_error", JSON.stringify(s).slice(0, 300));
    purchase = galaxySubscriptionPurchase(purchaseId, s, hints);
  } else {
    purchase = galaxyItemPurchase(purchaseId, r, hints);
  }
  const keys = [`galaxy:${purchase.id}`, ...(r.obfuscatedAccountId ? [`acct:${r.obfuscatedAccountId}`] : [])];
  let owner = await S.lookupIndex(project.id, ...keys);
  if (owner && owner !== appUserId && owner.startsWith("$") && !appUserId.startsWith("$")) { await S.mergeCustomers(project, owner, appUserId); owner = appUserId; }
  const target = owner ?? appUserId;
  await S.db.doc(`projects/${project.id}/galaxyPurchases/${purchase.id}`).set({ purchaseId, hints, appUserId: target, updatedAt: Date.now() }, { merge: true });
  const result = await S.upsertPurchase(project, target, purchase, [`galaxy:${purchase.id}`]);
  return { appUserId: target, purchase, ...result };
}
