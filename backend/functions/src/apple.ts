import {
  SignedDataVerifier, Environment, AppStoreServerAPIClient, JWSTransactionDecodedPayload,
  JWSRenewalInfoDecodedPayload, ResponseBodyV2DecodedPayload,
} from "@apple/app-store-server-library";
import { APPLE_ROOT_CERTIFICATES } from "./appleRootCertificates";
import { toAlpha2 } from "./countries";
import { dropImportedDuplicates } from "./revenuecat";
import { Purchase, PurchaseStatus, PurchaseType, HttpError } from "./engine";
import { Project, getCredentials, lookupIndex, upsertPurchase, mergeCustomers } from "./store";

const ROOTS = APPLE_ROOT_CERTIFICATES;

function verifiers(project: Project) {
  const bundleId = project.config.apple?.bundleId;
  if (!bundleId) throw new HttpError(400, "apple_not_configured", "Set config.apple.bundleId first");
  const appAppleId = project.config.apple?.appAppleId;
  const list: { env: Environment; v: SignedDataVerifier }[] = [];
  if (appAppleId) list.push({ env: Environment.PRODUCTION, v: new SignedDataVerifier(ROOTS, true, Environment.PRODUCTION, bundleId, appAppleId) });
  list.push({ env: Environment.SANDBOX, v: new SignedDataVerifier(ROOTS, true, Environment.SANDBOX, bundleId) });
  return list;
}

async function tryAll<T>(project: Project, fn: (v: SignedDataVerifier) => Promise<T>): Promise<{ value: T; env: Environment }> {
  let lastError: unknown;
  for (const { env, v } of verifiers(project)) {
    try { return { value: await fn(v), env }; } catch (e) { lastError = e; }
  }
  throw new HttpError(400, "invalid_apple_signature", String((lastError as Error)?.message ?? lastError));
}

const KNOWN_PERIODS = [0.25, 1, 2, 3, 6, 12];
function periodFromDates(start?: number, end?: number): number {
  if (!start || !end || end <= start) return 0;
  const months = (end - start) / (30.4375 * 86400000);
  return KNOWN_PERIODS.reduce((best, p) => Math.abs(p - months) < Math.abs(best - months) ? p : best, 1);
}

function typeOf(t: JWSTransactionDecodedPayload): PurchaseType {
  switch (String(t.type)) {
    case "Auto-Renewable Subscription": return "subscription";
    case "Consumable": return "consumable";
    default: return "non_consumable"; // Non-Consumable, Non-Renewing Subscription (expiresDate still honoured)
  }
}

/** Apple subscription status codes: 1 active, 2 expired, 3 billing retry, 4 grace, 5 revoked. */
export function applePurchase(
  t: JWSTransactionDecodedPayload, renewal?: JWSRenewalInfoDecodedPayload, statusCode?: number, now = Date.now(),
): Purchase {
  const type = typeOf(t);
  const expiresAt = t.expiresDate ?? null;
  let status: PurchaseStatus;
  if (t.revocationDate) status = "refunded";
  else if (statusCode === 5) status = "revoked";
  else if (statusCode === 4) status = "grace";
  else if (statusCode === 3) status = "billing_retry";
  else if (statusCode === 2) status = "expired";
  else if (statusCode === 1) status = "active";
  else if (renewal?.gracePeriodExpiresDate && renewal.gracePeriodExpiresDate > now && renewal.isInBillingRetryPeriod) status = "grace";
  else if (renewal?.isInBillingRetryPeriod) status = "billing_retry";
  else status = expiresAt === null || expiresAt > now ? "active" : "expired";

  const graceEnd = renewal?.gracePeriodExpiresDate;
  return {
    id: String(t.originalTransactionId),
    store: "app_store",
    productId: String(t.productId),
    type,
    status,
    purchasedAt: t.originalPurchaseDate ?? t.purchaseDate ?? now,
    latestPurchaseAt: t.purchaseDate ?? now,
    expiresAt: status === "grace" && graceEnd ? Math.max(graceEnd, expiresAt ?? 0) : expiresAt,
    willRenew: type === "subscription" && renewal ? renewal.autoRenewStatus === 1 : false,
    isTrial: Number(t.offerType) === 1 && (String(t.offerDiscountType ?? "") === "FREE_TRIAL" || !t.price),
    isSandbox: String(t.environment) !== "Production",
    priceMicros: (t.price ?? 0) * 1000,
    currency: t.currency ?? "USD",
    periodMonths: type === "subscription" ? periodFromDates(t.purchaseDate, t.expiresDate) : 0,
    billingIssue: status === "grace" || status === "billing_retry",
    updatedAt: t.signedDate ?? now,
    country: toAlpha2(t.storefront),
  };
}

/** Uses the App Store Server API (if a key is configured) to get the authoritative renewal state. */
async function refreshFromServer(project: Project, originalTransactionId: string, env: Environment) {
  const creds = await getCredentials(project.id).catch(() => null);
  if (!creds?.apple || !project.config.apple?.bundleId) return null;
  const { issuerId, keyId, privateKey } = creds.apple;
  const client = new AppStoreServerAPIClient(privateKey, keyId, issuerId, project.config.apple.bundleId, env);
  const res = await client.getAllSubscriptionStatuses(originalTransactionId);
  const item = res.data?.flatMap(g => g.lastTransactions ?? []).find(l => l.originalTransactionId === originalTransactionId)
    ?? res.data?.[0]?.lastTransactions?.[0];
  if (!item?.signedTransactionInfo) return null;
  const v = verifiers(project).find(x => x.env === env)?.v ?? verifiers(project)[0].v;
  const tx = await v.verifyAndDecodeTransaction(item.signedTransactionInfo);
  const renewal = item.signedRenewalInfo ? await v.verifyAndDecodeRenewalInfo(item.signedRenewalInfo) : undefined;
  return applePurchase(tx, renewal, Number(item.status));
}

/** Client path: the SDK posts StoreKit 2's `jwsRepresentation` right after a purchase / on restore. */
export async function ingestAppleTransaction(project: Project, appUserId: string, signedTransaction: string, signedRenewal?: string) {
  if (typeof signedTransaction !== "string" || signedTransaction.length > 20000) throw new HttpError(400, "invalid_transaction");
  const { value: tx, env } = await tryAll(project, v => v.verifyAndDecodeTransaction(signedTransaction));
  let renewal: JWSRenewalInfoDecodedPayload | undefined;
  if (signedRenewal) renewal = (await tryAll(project, v => v.verifyAndDecodeRenewalInfo(signedRenewal)).catch(() => null))?.value;
  let purchase = applePurchase(tx, renewal);
  if (purchase.type === "subscription") {
    purchase = (await refreshFromServer(project, purchase.id, env).catch(() => null)) ?? purchase;
  }
  // A transaction already bound to another user (shared Apple ID) stays with its first owner unless restoring.
  let owner = await lookupIndex(project.id, `apple:${purchase.id}`);
  // A placeholder owner ($apple:…, $anon:…) — e.g. a renewal notified before the user ever opened
  // the migrated app — always hands the purchase over to the real account.
  if (owner && owner !== appUserId && owner.startsWith("$") && !appUserId.startsWith("$")) {
    await mergeCustomers(project, owner, appUserId);
    owner = appUserId;
  }
  const target = owner ?? appUserId;
  await dropImportedDuplicates(project.id, target, purchase.productId, "app_store");
  const result = await upsertPurchase(project, target, purchase, [`apple:${purchase.id}`]);
  return { appUserId: target, transferredFrom: owner && owner !== appUserId ? owner : null, purchase, ...result };
}

/** Server path: App Store Server Notifications V2. */
export async function ingestAppleNotification(project: Project, signedPayload: string) {
  if (typeof signedPayload !== "string" || signedPayload.length > 250000) throw new HttpError(400, "invalid_payload");
  const { value: n, env } = await tryAll(project, v => v.verifyAndDecodeNotification(signedPayload)) as
    { value: ResponseBodyV2DecodedPayload; env: Environment };
  const data = n.data;
  if (!data?.signedTransactionInfo) return { ignored: String(n.notificationType) };
  const v = verifiers(project).find(x => x.env === env)!.v;
  const tx = await v.verifyAndDecodeTransaction(data.signedTransactionInfo);
  const renewal = data.signedRenewalInfo ? await v.verifyAndDecodeRenewalInfo(data.signedRenewalInfo) : undefined;
  let purchase = applePurchase(tx, renewal, data.status ? Number(data.status) : undefined);
  if (String(n.notificationType) === "REFUND" || String(n.notificationType) === "REVOKE") {
    purchase = { ...purchase, status: String(n.notificationType) === "REFUND" ? "refunded" : "revoked" };
  }
  purchase.updatedAt = n.signedDate ?? Date.now();
  const appUserId = await lookupIndex(project.id, `apple:${purchase.id}`, tx.appAccountToken ? `acct:${tx.appAccountToken.toLowerCase()}` : null)
    ?? `$apple:${purchase.id}`;
  if (!appUserId.startsWith("$")) await dropImportedDuplicates(project.id, appUserId, purchase.productId, "app_store");
  const result = await upsertPurchase(project, appUserId, purchase, [`apple:${purchase.id}`]);
  return { notificationType: n.notificationType, subtype: n.subtype, appUserId, ...result };
}
