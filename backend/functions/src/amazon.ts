// Amazon Appstore: Receipt Verification Service (RVS) + Real-Time Notifications (RTN, delivered by Amazon SNS).
// Docs: https://developer.amazon.com/docs/in-app-purchasing/iap-rvs-for-android-apps.html
//       https://developer.amazon.com/docs/in-app-purchasing/real-time-notifications.html
//       https://developer.amazon.com/docs/in-app-purchasing/use-rtn.html
//       SNS signatures: https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
// Pure functions first (unit-tested against lib/), Firestore I/O below via a lazy import of ./store.
import { createHash, createVerify } from "crypto";
import { Purchase, PurchaseStatus, HttpError } from "./engine";
import { toAlpha2 } from "./countries";
import type { Project } from "./store";

const store = () => import("./store");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export const RVS_HOST = "https://appstore-sdk.amazon.com";

export function amazonRvsUrl(sharedSecret: string, userId: string, receiptId: string, sandbox = false): string {
  const e = encodeURIComponent;
  return `${RVS_HOST}${sandbox ? "/sandbox" : ""}/version/1.0/verifyReceiptId/developer/${e(sharedSecret)}/user/${e(userId)}/receiptId/${e(receiptId)}`;
}

/** RVS `term` ("1 Week", "3 Months", "1 Year"…) → months. */
export function amazonTermToMonths(term: unknown): number {
  const m = /^\s*(\d+)\s*(day|week|month|year)s?\s*$/i.exec(String(term ?? ""));
  if (!m) return 0;
  const n = Number(m[1]), u = m[2].toLowerCase();
  return u === "year" ? n * 12 : u === "month" ? n : u === "week" ? (n * 7) / 30.4375 : n / 30.4375;
}

export const amazonPurchaseId = (receiptId: string) => `amz_${sha(receiptId).slice(0, 40)}`;

export interface AmazonHints { priceMicros?: number; currency?: string; sandbox?: boolean; }

/** RVS JSON (HTTP 200) → Purchase. `gone` = RVS answered 410 (treat as canceled receipt). */
export function amazonReceiptPurchase(r: any, hints: AmazonHints = {}, now = Date.now(), gone = false): Purchase {
  const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
  const purchaseDate = num(r.purchaseDate) ?? now;
  const cancelDate = num(r.cancelDate), renewalDate = num(r.renewalDate), grace = num(r.gracePeriodEndDate), trialEnd = num(r.freeTrialEndDate);
  const isSandbox = Boolean(r.testTransaction || r.betaProduct || hints.sandbox);
  const base = {
    id: amazonPurchaseId(String(r.receiptId)), store: "amazon" as const, isSandbox, updatedAt: now,
    priceMicros: hints.priceMicros ?? 0, currency: hints.currency ?? "USD", country: toAlpha2(r.countryCode),
  };
  if (r.productType === "SUBSCRIPTION") {
    const periodMonths = amazonTermToMonths(r.term) || 1;
    // cancelDate = canceled/expired; renewalDate = next renewal (auto-renewing only); grace end when in grace.
    let expiresAt = cancelDate ?? renewalDate ?? grace ?? null;
    if (expiresAt === null) expiresAt = purchaseDate + periodMonths * 30.4375 * 86400000; // undocumented case: no date at all
    let status: PurchaseStatus = "active";
    if (gone) status = "expired";
    else if (grace && grace > now && (!renewalDate || renewalDate <= now)) status = "grace";
    else if (expiresAt <= now) status = "expired";
    const willRenew = Boolean(r.autoRenewing) && !cancelDate && !gone;
    const latest = renewalDate && renewalDate > purchaseDate ? Math.max(purchaseDate, renewalDate - periodMonths * 30.4375 * 86400000) : purchaseDate;
    return {
      ...base, productId: String(r.termSku ?? r.productId ?? "unknown"), type: "subscription", status,
      purchasedAt: purchaseDate, latestPurchaseAt: Math.round(latest), expiresAt, willRenew,
      isTrial: trialEnd !== null && trialEnd > now, periodMonths, billingIssue: status === "grace",
    };
  }
  const canceled = gone || cancelDate !== null;
  return {
    ...base, productId: String(r.productId ?? "unknown"), type: r.productType === "CONSUMABLE" ? "consumable" : "non_consumable",
    status: canceled ? "refunded" : "active", purchasedAt: purchaseDate, latestPurchaseAt: purchaseDate, expiresAt: null,
    willRenew: false, isTrial: false, periodMonths: 0, billingIssue: false,
  };
}

// ── SNS envelope (RTN) ──────────────────────────────────────────────────────
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

/** Only accept certificate / SubscribeURL links that point to an SNS endpoint over HTTPS. */
export function isSnsUrl(raw: unknown, pem = false): boolean {
  try {
    const u = new URL(String(raw));
    return u.protocol === "https:" && SNS_HOST.test(u.hostname) && (!pem || u.pathname.endsWith(".pem"));
  } catch { return false; }
}

/** Canonical string AWS signs (keys in byte order, each "Key\nValue\n"). */
export function snsStringToSign(m: Record<string, any>): string {
  const keys = m.Type === "Notification"
    ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
    : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  return keys.filter(k => m[k] !== undefined && m[k] !== null).map(k => `${k}\n${m[k]}\n`).join("");
}

export function verifySnsSignature(m: Record<string, any>, certPem: string): boolean {
  const algo = String(m.SignatureVersion) === "2" ? "RSA-SHA256" : String(m.SignatureVersion) === "1" ? "RSA-SHA1" : null;
  if (!algo || typeof m.Signature !== "string") return false;
  try { return createVerify(algo).update(snsStringToSign(m), "utf8").verify(certPem, m.Signature, "base64"); }
  catch { return false; }
}

/** RTN `Message` (escaped JSON inside the SNS envelope). */
export function parseAmazonRtn(m: Record<string, any>) {
  const msg = typeof m.Message === "string" ? JSON.parse(m.Message) : m.Message ?? {};
  return {
    receiptId: msg.receiptId ? String(msg.receiptId) : null, appUserId: msg.appUserId ? String(msg.appUserId) : null,
    notificationType: String(msg.notificationType ?? ""), appPackageName: msg.appPackageName ?? null,
    timestamp: Number(msg.timestamp ?? 0), beta: Boolean(msg.betaProductTransaction),
    cancelledReceiptId: msg.relatedReceipts?.cancelledReceiptId ? String(msg.relatedReceipts.cancelledReceiptId) : null,
  };
}

// ── I/O ─────────────────────────────────────────────────────────────────────
interface AmazonCreds { sharedSecret: string; allowSandbox?: boolean; packageName?: string }

async function amazonCreds(project: Project): Promise<AmazonCreds> {
  const c = ((await (await store()).getCredentials(project.id)) as any).amazon as AmazonCreds | undefined;
  if (!c?.sharedSecret) throw new HttpError(400, "amazon_credentials_missing", "Set the Amazon Appstore shared secret first");
  return c;
}

async function verifyReceipt(creds: AmazonCreds, userId: string, receiptId: string, sandbox: boolean) {
  const res = await fetch(amazonRvsUrl(creds.sharedSecret, userId, receiptId, sandbox), { signal: AbortSignal.timeout(15000), headers: { Accept: "application/json" } });
  const text = await res.text();
  if (res.status === 410) return { gone: true, body: { receiptId, productType: "ENTITLED" } as any };
  if (res.status === 496) throw new HttpError(400, "amazon_invalid_shared_secret");
  if (res.status === 497) throw new HttpError(400, "amazon_invalid_user_id");
  if (res.status === 400) throw new HttpError(400, "amazon_invalid_receipt", text.slice(0, 300));
  if (!res.ok) throw new HttpError(502, "amazon_rvs_error", `${res.status} ${text.slice(0, 300)}`);
  return { gone: false, body: JSON.parse(text) };
}

async function fetchAndStore(project: Project, receiptId: string, amazonUserId: string, appUserId: string | null, hints: AmazonHints) {
  const S = await store();
  const creds = await amazonCreds(project);
  const sandbox = Boolean(hints.sandbox);
  if (sandbox && !creds.allowSandbox) throw new HttpError(403, "amazon_sandbox_disabled", "Enable the Amazon sandbox (App Tester) in credentials first");
  const { gone, body } = await verifyReceipt(creds, amazonUserId, receiptId, sandbox);
  if (gone) {
    // 410 = no longer valid: keep the previous record and mark it canceled.
    const owner = await S.lookupIndex(project.id, `amazon:${receiptId}`);
    if (!owner) return { appUserId: appUserId ?? null, ignored: "gone" };
    const prev = (await S.db.doc(`projects/${project.id}/customers/${owner}/purchases/${amazonPurchaseId(receiptId)}`).get()).data() as Purchase | undefined;
    if (!prev) return { appUserId: owner, ignored: "gone" };
    const status: PurchaseStatus = prev.type === "subscription" ? "expired" : "refunded";
    await S.upsertPurchase(project, owner, { ...prev, status, willRenew: false, expiresAt: prev.type === "subscription" ? Math.min(prev.expiresAt ?? Date.now(), Date.now()) : null, updatedAt: Date.now() });
    return { appUserId: owner };
  }
  const purchase = amazonReceiptPurchase({ ...body, receiptId: body.receiptId ?? receiptId }, hints);
  const userKey = `amazonUser:${amazonUserId}`;
  let owner = await S.lookupIndex(project.id, `amazon:${receiptId}`, userKey);
  if (owner && appUserId && owner !== appUserId && owner.startsWith("$") && !appUserId.startsWith("$")) {
    await S.mergeCustomers(project, owner, appUserId);
    owner = appUserId;
  }
  const target = owner ?? appUserId ?? `$amazon:${sha(amazonUserId).slice(0, 24)}`;
  await S.db.doc(`projects/${project.id}/amazonReceipts/${sha(receiptId)}`).set({ receiptId, amazonUserId, sandbox, hints, appUserId: target, updatedAt: Date.now() }, { merge: true });
  const result = await S.upsertPurchase(project, target, purchase, [`amazon:${receiptId}`, userKey]);
  return { appUserId: target, purchase, ...result };
}

/** Client path: POST /v1/customers/:id/amazon { receiptId, amazonUserId, productId?, sandbox?, priceMicros?, currency? }. */
export async function ingestAmazonPurchase(project: Project, appUserId: string, body: any) {
  const receiptId = String(body?.receiptId ?? ""), amazonUserId = String(body?.amazonUserId ?? body?.userId ?? "");
  if (!receiptId || receiptId.length > 200 || !amazonUserId || amazonUserId.length > 128) throw new HttpError(400, "invalid_purchase", "receiptId and amazonUserId are required");
  return fetchAndStore(project, receiptId, amazonUserId, appUserId, {
    priceMicros: Number(body.priceMicros) || undefined, currency: body.currency, sandbox: body.sandbox === true,
  });
}

const certCache = new Map<string, string>();
async function snsCert(url: string): Promise<string> {
  if (!certCache.has(url)) {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new HttpError(400, "sns_cert_unavailable");
    certCache.set(url, await res.text());
  }
  return certCache.get(url)!;
}

/** Server path: RTN via SNS HTTPS subscription. Body arrives as text/plain JSON. */
export async function ingestAmazonNotification(project: Project, raw: Buffer | string | undefined, parsed?: any) {
  const S = await store();
  let m: any = parsed && typeof parsed === "object" && parsed.Type ? parsed : null;
  if (!m) { try { m = JSON.parse(String(raw ?? "")); } catch { throw new HttpError(400, "invalid_sns_message"); } }
  if (!isSnsUrl(m.SigningCertURL ?? m.SigningCertUrl, true)) throw new HttpError(400, "invalid_sns_cert_url");
  if (!verifySnsSignature(m, await snsCert(m.SigningCertURL ?? m.SigningCertUrl))) throw new HttpError(401, "invalid_sns_signature");
  if (m.Type === "SubscriptionConfirmation") {
    if (!isSnsUrl(m.SubscribeURL)) throw new HttpError(400, "invalid_subscribe_url");
    const res = await fetch(m.SubscribeURL, { signal: AbortSignal.timeout(10000) }).catch(() => null);
    // Amazon's console may also ask for the confirmation token: keep it visible in the dashboard.
    await S.db.doc(`projects/${project.id}`).set({ health: { amazonNotifications: { confirmationToken: String(m.Token ?? "").slice(0, 500), confirmedAt: res?.ok ? Date.now() : null, lastAt: Date.now() } } }, { merge: true });
    return { confirmed: Boolean(res?.ok) };
  }
  if (m.Type !== "Notification") return { ignored: m.Type };
  const n = parseAmazonRtn(m);
  if (!n.receiptId || !n.appUserId) return { ignored: true };
  const creds = await amazonCreds(project);
  if (creds.packageName && n.appPackageName && n.appPackageName !== creds.packageName) return { ignored: "other_package" };
  const known = (await S.db.doc(`projects/${project.id}/amazonReceipts/${sha(n.receiptId)}`).get()).data() ?? {};
  // RTN data can be stale: always re-verify with RVS (authoritative). Forged messages can only trigger a refresh.
  const r = await fetchAndStore(project, n.receiptId, n.appUserId, null, { ...(known.hints ?? {}), sandbox: known.sandbox ?? false });
  if (n.cancelledReceiptId) await fetchAndStore(project, n.cancelledReceiptId, n.appUserId, null, { sandbox: known.sandbox ?? false }).catch(() => null);
  return { notificationType: n.notificationType, appUserId: (r as any).appUserId };
}
