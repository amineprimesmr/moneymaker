// Refund Control (RevenueCat-like): on an App Store CONSUMPTION_REQUEST notification, MoneyMaker
// answers Apple automatically through the App Store Server API
// `PUT /inApps/v2/transactions/consumption/{transactionId}` (Send Consumption Information, v2 —
// fields customerConsented, consumptionPercentage, deliveryStatus, refundPreference, sampleContentProvided).
// Apple gives 12 h to answer: we reply synchronously while handling the notification.
// Each request is stored in projects/{pid}/refundRequests/{transactionId}; REFUND / REFUND_DECLINED
// notifications record the outcome.

import { AppStoreServerAPIClient, Environment, ConsumptionRequest } from "@apple/app-store-server-library";
import { db, getCredentials, Project } from "./store";
import type { Purchase } from "./engine";

export type RefundPreferenceSetting = "decline" | "grant" | "none";
export interface RefundControlConfig { enabled: boolean; preference: RefundPreferenceSetting; customerConsented: boolean }

export const DEFAULT_REFUND_CONTROL: RefundControlConfig = { enabled: false, preference: "decline", customerConsented: false };

export interface ConsumptionContext {
  config: RefundControlConfig;
  purchase?: Pick<Purchase, "type" | "status" | "purchasedAt" | "latestPurchaseAt" | "expiresAt"> | null;
  customer?: { firstSeenAt?: number; totalSpentMicros?: number; activeEntitlements?: string[] } | null;
  refundsCount?: number;
  now?: number;
}

const DAY = 86400000;

/** Account tenure bucket, same thresholds as Apple's AccountTenure (v1): 0 unknown, 1 0–3 d, 2 3–10 d, 3 10–30 d, 4 30–90 d, 5 90–180 d, 6 180–365 d, 7 > 365 d. */
export function tenureBucket(firstSeenAt: number | undefined, now: number): number {
  if (!firstSeenAt || firstSeenAt > now) return 0;
  const d = (now - firstSeenAt) / DAY;
  return d < 3 ? 1 : d < 10 ? 2 : d < 30 ? 3 : d < 90 ? 4 : d < 180 ? 5 : d < 365 ? 6 : 7;
}

/** Share of the purchase consumed, in milliunits (0–100000) as Apple expects. */
export function consumptionPercentage(p: ConsumptionContext["purchase"], now: number): number | undefined {
  if (!p) return undefined;
  if (p.type === "non_consumable") return 100000;
  if (p.type === "subscription" && p.expiresAt && p.expiresAt > p.latestPurchaseAt) {
    const ratio = (Math.min(now, p.expiresAt) - p.latestPurchaseAt) / (p.expiresAt - p.latestPurchaseAt);
    return Math.round(Math.max(0, Math.min(1, ratio)) * 100000);
  }
  return undefined; // consumables: MoneyMaker does not know how much was used
}

/**
 * Pure: builds the v2 ConsumptionRequest body plus a summary of the signals used.
 * Returns `body: null` with a `skipped` reason when nothing must be sent (Apple requires customer consent).
 */
export function buildConsumptionRequest(ctx: ConsumptionContext) {
  const now = ctx.now ?? Date.now();
  const signals = {
    accountTenure: tenureBucket(ctx.customer?.firstSeenAt, now),
    totalSpentMicros: Math.max(0, ctx.customer?.totalSpentMicros ?? 0),
    refundsCount: ctx.refundsCount ?? 0,
    entitlementActive: (ctx.customer?.activeEntitlements?.length ?? 0) > 0,
  };
  if (!ctx.config.enabled) return { body: null, skipped: "disabled", signals };
  if (!ctx.config.customerConsented) return { body: null, skipped: "no_customer_consent", signals };
  const delivered = !!ctx.purchase && (signals.entitlementActive || ctx.purchase.status !== "revoked");
  const body: ConsumptionRequest = {
    customerConsented: true,
    deliveryStatus: delivered ? "DELIVERED" : "UNDELIVERED_OTHER",
    sampleContentProvided: false,
  };
  const pct = consumptionPercentage(ctx.purchase, now);
  if (pct !== undefined) body.consumptionPercentage = pct;
  if (ctx.config.preference === "decline") body.refundPreference = "DECLINE";
  else if (ctx.config.preference === "grant") body.refundPreference = "GRANT_FULL";
  return { body, skipped: null as string | null, signals };
}

export function sanitizeRefundControl(input: any): RefundControlConfig {
  if (input === null || typeof input !== "object") throw new Error("invalid_refund_control");
  const preference = input.preference ?? DEFAULT_REFUND_CONTROL.preference;
  if (!["decline", "grant", "none"].includes(preference)) throw new Error("invalid_refund_preference");
  return { enabled: Boolean(input.enabled), preference, customerConsented: Boolean(input.customerConsented) };
}

/** Handles a CONSUMPTION_REQUEST: computes, sends to Apple (same environment as the notification), stores. */
export async function handleConsumptionRequest(
  project: Project, env: Environment, transactionId: string, originalTransactionId: string, appUserId: string,
  reason: string | undefined, productId: string,
) {
  const config: RefundControlConfig = { ...DEFAULT_REFUND_CONTROL, ...((project.config as any).refundControl ?? {}) };
  const customerRef = db.doc(`projects/${project.id}/customers/${appUserId}`);
  const [customerSnap, purchaseSnap, refunds] = await Promise.all([
    customerRef.get(), customerRef.collection("purchases").doc(originalTransactionId).get(),
    customerRef.collection("purchases").where("status", "==", "refunded").get(),
  ]);
  const built = buildConsumptionRequest({
    config, purchase: purchaseSnap.exists ? purchaseSnap.data() as Purchase : null,
    customer: customerSnap.exists ? customerSnap.data() as any : null, refundsCount: refunds.size,
  });
  let status = built.skipped ? "skipped" : "sent";
  let error: string | null = null;
  if (built.body) {
    const creds = await getCredentials(project.id).catch(() => null);
    const bundleId = project.config.apple?.bundleId;
    if (!creds?.apple || !bundleId) { status = "failed"; error = "missing_app_store_server_api_key"; }
    else {
      try {
        const { issuerId, keyId, privateKey } = creds.apple;
        await new AppStoreServerAPIClient(privateKey, keyId, issuerId, bundleId, env).sendConsumptionInformation(transactionId, built.body);
      } catch (e) { status = "failed"; error = String((e as any)?.apiError ?? (e as Error)?.message ?? e).slice(0, 300); }
    }
  }
  await db.doc(`projects/${project.id}/refundRequests/${transactionId}`).set({
    transactionId, originalTransactionId, appUserId, productId, reason: reason ?? null,
    environment: String(env), isSandbox: env !== Environment.PRODUCTION,
    requestedAt: Date.now(), status, skipped: built.skipped, error, request: built.body, signals: built.signals,
    preference: config.preference, outcome: "pending",
  }, { merge: true });
  return { refundControl: status, ...(error ? { error } : {}) };
}

/** REFUND → "refunded", REFUND_DECLINED → "declined". No-op if no consumption request was recorded. */
export async function recordRefundOutcome(project: Project, transactionId: string, outcome: "refunded" | "declined") {
  const ref = db.doc(`projects/${project.id}/refundRequests/${transactionId}`);
  const snap = await ref.get();
  if (!snap.exists) return;
  await ref.update({ outcome, outcomeAt: Date.now() });
}

/** Pure aggregation for GET /v1/projects/:pid/refund-requests. */
export function refundStats(rows: { status?: string; outcome?: string; preference?: string; isSandbox?: boolean }[]) {
  const s = { total: rows.length, sent: 0, skipped: 0, failed: 0, pending: 0, refunded: 0, declined: 0, refundRate: null as number | null };
  for (const r of rows) {
    if (r.status === "sent") s.sent++; else if (r.status === "failed") s.failed++; else s.skipped++;
    if (r.outcome === "refunded") s.refunded++; else if (r.outcome === "declined") s.declined++; else s.pending++;
  }
  const decided = s.refunded + s.declined;
  s.refundRate = decided ? s.refunded / decided : null;
  return s;
}
