const test = require("node:test");
const assert = require("node:assert");
const { computeEntitlements, diffEvents, computeMetrics, mrrMicros, isoPeriodToMonths, convertMicros } = require("../lib/engine");
const { googleSubscriptionPurchase } = require("../lib/google");
const { stripeSubscriptionPurchase } = require("../lib/stripe");
const { applePurchase } = require("../lib/apple");

const now = Date.now(), DAY = 86400000;
const base = { id: "1", store: "app_store", productId: "monthly", type: "subscription", status: "active", purchasedAt: now - 10 * DAY,
  latestPurchaseAt: now - 10 * DAY, expiresAt: now + 20 * DAY, willRenew: true, isTrial: false, isSandbox: false,
  priceMicros: 9_990_000, currency: "EUR", periodMonths: 1, billingIssue: false, updatedAt: now };

test("entitlements: active, expired, lifetime, grace", () => {
  const map = { premium: ["monthly", "lifetime"] };
  assert.equal(computeEntitlements([base], map).premium.active, true);
  assert.equal(computeEntitlements([{ ...base, expiresAt: now - 1 }], map).premium.active, false);
  assert.equal(computeEntitlements([{ ...base, status: "grace" }], map).premium.active, true);
  assert.equal(computeEntitlements([{ ...base, status: "billing_retry" }], map).premium.active, false);
  const e = computeEntitlements([{ ...base, expiresAt: now - 1 }, { ...base, id: "2", productId: "lifetime", type: "non_consumable", expiresAt: null }], map);
  assert.equal(e.premium.active, true); assert.equal(e.premium.productId, "lifetime");
  assert.equal(computeEntitlements([{ ...base, productId: "other" }], map).premium, undefined);
  assert.equal(computeEntitlements([{ ...base, store: "promotional", productId: "promo:premium", type: "non_consumable", expiresAt: null }], map).premium.active, true);
});

test("lifecycle events", () => {
  assert.deepEqual(diffEvents(undefined, base), ["INITIAL_PURCHASE"]);
  assert.deepEqual(diffEvents(undefined, { ...base, isTrial: true }), ["TRIAL_STARTED"]);
  assert.deepEqual(diffEvents({ ...base, isTrial: true }, { ...base, latestPurchaseAt: now }), ["TRIAL_CONVERTED"]);
  assert.deepEqual(diffEvents(base, { ...base, latestPurchaseAt: now }), ["RENEWAL"]);
  assert.deepEqual(diffEvents(base, { ...base, willRenew: false }), ["CANCELLATION"]);
  assert.deepEqual(diffEvents(base, { ...base, status: "expired" }), ["EXPIRATION"]);
  assert.deepEqual(diffEvents(base, { ...base, status: "refunded" }), ["REFUND"]);
  assert.deepEqual(diffEvents(base, { ...base, status: "billing_retry", billingIssue: true }), ["BILLING_ISSUE"]);
  assert.deepEqual(diffEvents({ ...base, status: "billing_retry", billingIssue: true }, { ...base, latestPurchaseAt: now }), ["RENEWAL", "BILLING_RECOVERED"]);
});

test("metrics + MRR normalisation", () => {
  assert.equal(mrrMicros({ ...base, priceMicros: 59_990_000, periodMonths: 12 }, "EUR"), Math.round(59_990_000 / 12));
  assert.equal(mrrMicros({ ...base, isTrial: true }, "EUR"), 0);
  assert.equal(mrrMicros({ ...base, isSandbox: true }, "EUR"), 0);
  assert.equal(convertMicros(1_080_000, "USD", "EUR"), 1_000_000);
  const m = computeMetrics([base, { ...base, id: "2", isTrial: true }, { ...base, id: "3", expiresAt: now - 1 }], p => p.id, "EUR");
  assert.equal(m.activeSubscriptions, 1); assert.equal(m.activeTrials, 1); assert.equal(m.mrrMicros, 9_990_000);
  assert.equal(m.activeCustomers, 2);
  assert.equal(isoPeriodToMonths("P1Y"), 12); assert.equal(isoPeriodToMonths("P1M"), 1);
});

test("apple mapping", () => {
  const t = { originalTransactionId: "100", transactionId: "101", productId: "monthly", type: "Auto-Renewable Subscription",
    purchaseDate: now - DAY, originalPurchaseDate: now - 40 * DAY, expiresDate: now + 29 * DAY, environment: "Production",
    price: 9990, currency: "EUR", signedDate: now };
  const p = applePurchase(t, { autoRenewStatus: 1 });
  assert.equal(p.status, "active"); assert.equal(p.periodMonths, 1); assert.equal(p.priceMicros, 9_990_000); assert.equal(p.willRenew, true);
  assert.equal(applePurchase(t, undefined, 4).status, "grace");
  assert.equal(applePurchase({ ...t, revocationDate: now }).status, "refunded");
  assert.equal(applePurchase({ ...t, offerType: 1, offerDiscountType: "FREE_TRIAL", price: 0 }).isTrial, true);
  assert.equal(applePurchase({ ...t, type: "Non-Consumable", expiresDate: undefined }).expiresAt, null);
});

test("google mapping", () => {
  const sub = { subscriptionState: "SUBSCRIPTION_STATE_CANCELED", startTime: new Date(now - DAY).toISOString(),
    lineItems: [{ productId: "annual", expiryTime: new Date(now + 300 * DAY).toISOString(), autoRenewingPlan: { autoRenewEnabled: false } }] };
  const p = googleSubscriptionPurchase("tok", sub, { priceMicros: 49_990_000, currency: "EUR", period: "P1Y" });
  assert.equal(p.status, "active"); assert.equal(p.willRenew, false); assert.equal(p.periodMonths, 12); assert.equal(p.priceMicros, 49_990_000);
});

test("stripe mapping", () => {
  const s = { id: "sub_1", status: "trialing", start_date: (now - DAY) / 1000, cancel_at_period_end: false, livemode: true, metadata: {},
    items: { data: [{ quantity: 1, current_period_start: (now - DAY) / 1000, current_period_end: (now + 6 * DAY) / 1000,
      price: { id: "price_1", unit_amount: 999, currency: "eur", recurring: { interval: "month", interval_count: 1 } } }] } };
  const p = stripeSubscriptionPurchase(s);
  assert.equal(p.isTrial, true); assert.equal(p.priceMicros, 9_990_000); assert.equal(p.currency, "EUR"); assert.equal(p.status, "active");
});
