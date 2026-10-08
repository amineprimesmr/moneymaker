// RevenueCat-compatible surface so existing backends migrate by changing a base URL and a key:
//  - GET  {base}/v1/subscribers/{id}                                  → RevenueCat v1 "subscriber" shape
//  - POST {base}/v1/subscribers/{id}/entitlements/{e}/promotional    → { duration } grants
//  - webhooks with `format: "revenuecat"` → { api_version, event: {...} } bodies + custom Authorization header
import { Purchase } from "./engine";

const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString());
const RC_STORE: Record<string, string> = { app_store: "app_store", play_store: "play_store", stripe: "stripe", promotional: "promotional" };

/** MoneyMaker purchases + entitlements → RevenueCat v1 `{ subscriber }` payload. Pure — unit-tested. */
export function toRevenueCatSubscriber(appUserId: string, purchases: Purchase[], entitlements: Record<string, any>, firstSeenAt?: number | null) {
  const subscriptions: Record<string, any> = {};
  const nonSubscriptions: Record<string, any[]> = {};
  for (const p of purchases) {
    if (p.type === "subscription" || p.store === "promotional") {
      const prev = subscriptions[p.productId];
      if (prev && Date.parse(prev.expires_date ?? "0") > (p.expiresAt ?? Infinity)) continue;
      subscriptions[p.productId] = {
        expires_date: iso(p.expiresAt), purchase_date: iso(p.latestPurchaseAt), original_purchase_date: iso(p.purchasedAt),
        period_type: p.store === "promotional" ? "promotional" : p.isTrial ? "trial" : "normal",
        store: RC_STORE[p.store] ?? p.store, is_sandbox: p.isSandbox,
        unsubscribe_detected_at: !p.willRenew && p.type === "subscription" ? iso(p.updatedAt) : null,
        billing_issues_detected_at: p.billingIssue ? iso(p.updatedAt) : null,
        refunded_at: p.status === "refunded" ? iso(p.updatedAt) : null,
        grace_period_expires_date: p.status === "grace" ? iso(p.expiresAt) : null,
        ownership_type: "PURCHASED", store_transaction_id: p.id,
        price: p.priceMicros ? { amount: p.priceMicros / 1e6, currency: p.currency } : null,
      };
    } else if (p.type !== "consumable" || p.status !== "refunded") {
      (nonSubscriptions[p.productId] ??= []).push({
        id: p.id, store_transaction_id: p.id, purchase_date: iso(p.purchasedAt), original_purchase_date: iso(p.purchasedAt),
        store: RC_STORE[p.store] ?? p.store, is_sandbox: p.isSandbox,
      });
    }
  }
  const ents: Record<string, any> = {};
  for (const [id, e] of Object.entries<any>(entitlements)) {
    // RevenueCat keeps expired entitlements in the payload with their past expiry: clients compare dates.
    ents[id] = { expires_date: iso(e.expiresAt), product_identifier: e.productId, purchase_date: iso(e.purchasedAt), grace_period_expires_date: null };
  }
  return {
    request_date: new Date().toISOString(), request_date_ms: Date.now(),
    subscriber: {
      original_app_user_id: appUserId, first_seen: iso(firstSeenAt ?? Date.now()), last_seen: new Date().toISOString(),
      entitlements: ents, subscriptions, non_subscriptions: nonSubscriptions, other_purchases: {}, subscriber_attributes: {},
      management_url: null, original_application_version: null, original_purchase_date: null,
    },
  };
}

const DURATION_DAYS: Record<string, number | null> = {
  daily: 1, three_day: 3, weekly: 7, two_week: 14, monthly: 31, two_month: 62, three_month: 92, six_month: 183, yearly: 366, lifetime: null,
};
export function promotionalDays(duration: unknown): number | null | undefined {
  return typeof duration === "string" && duration in DURATION_DAYS ? DURATION_DAYS[duration] : undefined;
}

/** MoneyMaker lifecycle event → RevenueCat webhook event. Returns null for events RevenueCat has no equivalent for. */
export function toRevenueCatEvent(e: Record<string, any>, eventId: string, entitlementIds: string[]) {
  const base = {
    id: eventId, app_user_id: e.appUserId, original_app_user_id: e.appUserId, aliases: [e.appUserId],
    product_id: e.productId, entitlement_ids: entitlementIds, entitlement_id: entitlementIds[0] ?? null,
    period_type: e.isTrial ? "TRIAL" : "NORMAL", purchased_at_ms: e.at, expiration_at_ms: e.expiresAt ?? null,
    event_timestamp_ms: e.at, environment: e.isSandbox ? "SANDBOX" : "PRODUCTION",
    store: String(e.store ?? "").toUpperCase(), currency: e.currency ?? null,
    price: e.isTrial ? 0 : (e.priceMicros ?? 0) / 1e6, price_in_purchased_currency: e.isTrial ? 0 : (e.priceMicros ?? 0) / 1e6,
    country_code: e.country ?? null, is_trial_conversion: false, transaction_id: e.purchaseId ?? null, original_transaction_id: e.purchaseId ?? null,
  };
  switch (e.type) {
    case "INITIAL_PURCHASE": return { ...base, type: "INITIAL_PURCHASE" };
    case "TRIAL_STARTED": return { ...base, type: "INITIAL_PURCHASE", period_type: "TRIAL", price: 0, price_in_purchased_currency: 0 };
    case "TRIAL_CONVERTED": return { ...base, type: "RENEWAL", period_type: "NORMAL", is_trial_conversion: true };
    case "RENEWAL": return { ...base, type: "RENEWAL" };
    case "NON_RENEWING_PURCHASE": return { ...base, type: "NON_RENEWING_PURCHASE" };
    case "CANCELLATION": return { ...base, type: "CANCELLATION", cancel_reason: "UNSUBSCRIBE" };
    case "REFUND": return { ...base, type: "CANCELLATION", cancel_reason: "CUSTOMER_SUPPORT" };
    case "UNCANCELLATION": return { ...base, type: "UNCANCELLATION" };
    case "EXPIRATION": return { ...base, type: "EXPIRATION", expiration_reason: "UNSUBSCRIBE" };
    case "BILLING_ISSUE": return { ...base, type: "BILLING_ISSUE" };
    case "PRODUCT_CHANGE": return { ...base, type: "PRODUCT_CHANGE", new_product_id: e.productId };
    case "PAUSED": return { ...base, type: "SUBSCRIPTION_PAUSED" };
    case "TEST": return { ...base, type: "TEST" };
    default: return null;
  }
}
