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

const { summarizeWindow, buildCohorts } = require("../lib/metrics");
const { rankAlerts, parseChart, parseReviews } = require("../lib/appstore");
const { describe: describeEvent, sanitizeIntegrations } = require("../lib/integrations");
const { toAlpha2 } = require("../lib/countries");

test("window summary: revenue split, refunds, countries, MRR movement", () => {
  const t0 = Date.parse("2026-09-01");
  const txs = [
    { appUserId: "a", store: "app_store", productId: "m", kind: "purchase", amountMicrosProject: 10e6, country: "FR", at: t0 },
    { appUserId: "a", store: "app_store", productId: "m", kind: "renewal", amountMicrosProject: 10e6, country: "FR", at: t0 + 30 * DAY },
    { appUserId: "b", store: "stripe", productId: "y", kind: "purchase", amountMicrosProject: 60e6, country: "US", at: t0 },
    { appUserId: "b", store: "stripe", productId: "y", kind: "refund", amountMicrosProject: -60e6, country: "US", at: t0 + DAY },
    { appUserId: "c", store: "stripe", productId: "y", kind: "purchase", amountMicrosProject: 5e6, isSandbox: true, at: t0 },
  ];
  const evs = [
    { type: "INITIAL_PURCHASE", appUserId: "a", productId: "m", store: "app_store", priceMicros: 10e6, currency: "EUR", periodMonths: 1, at: t0 },
    { type: "EXPIRATION", appUserId: "b", productId: "y", store: "stripe", priceMicros: 60e6, currency: "EUR", periodMonths: 12, at: t0 },
    { type: "TRIAL_STARTED", appUserId: "d", productId: "m", store: "app_store", isTrial: true, at: t0 },
  ];
  const w = summarizeWindow(txs, evs, "EUR");
  assert.equal(w.revenueMicros, 80e6); assert.equal(w.refundsMicros, 60e6); assert.equal(w.netRevenueMicros, 20e6);
  assert.equal(w.newRevenueMicros, 70e6); assert.equal(w.renewalRevenueMicros, 10e6);
  assert.equal(w.payingCustomers, 2); assert.equal(w.revenueByCountry.FR, 20e6); assert.equal(w.revenueByCountry.US, 0);
  assert.equal(w.mrrMovement.newMicros, 10e6); assert.equal(w.mrrMovement.churnedMicros, 5e6);
  assert.deepEqual(w.trialsByProduct.m, { started: 1, converted: 0 });
});

test("cohorts: retention by month offset", () => {
  const m = k => Date.parse(`2026-0${k}-10`);
  const c = buildCohorts([
    { appUserId: "a", amountMicrosProject: 1e6, at: m(1) }, { appUserId: "a", amountMicrosProject: 1e6, at: m(2) },
    { appUserId: "b", amountMicrosProject: 1e6, at: m(1) }, { appUserId: "c", amountMicrosProject: 1e6, at: m(2) },
  ], 3);
  assert.equal(c[0].month, "2026-01"); assert.equal(c[0].size, 2);
  assert.deepEqual(c[0].retention, [1, 0.5, 0]); assert.equal(c[1].size, 1);
  const annual = buildCohorts([{ appUserId: "y", amountMicrosProject: 50e6, periodMonths: 12, at: m(1) }], 3);
  assert.deepEqual(annual[0].retention, [1, 1, 1]);
});

test("ranking alerts", () => {
  const prev = r => (r === undefined ? undefined : { rank: r });
  assert.deepEqual(rankAlerts(prev(undefined), 40, "1", "FR", "free", "all", false).map(a => a.type), ["NEW_COUNTRY"]);
  assert.deepEqual(rankAlerts(prev(null), 40, "1", "FR", "free", "all", true).map(a => a.type), ["TOP_100"]);
  assert.deepEqual(rankAlerts(prev(14), 3, "1", "FR", "free", "all", true).map(a => a.type), ["TOP_10", "JUMP"]);
  assert.deepEqual(rankAlerts(prev(2), 1, "1", "FR", "free", "all", true).map(a => a.type), ["TOP_1"]);
  assert.deepEqual(rankAlerts(prev(5), 30, "1", "FR", "free", "all", true).map(a => a.type), ["DROP"]);
  assert.deepEqual(rankAlerts(prev(5), null, "1", "FR", "free", "all", true).map(a => a.type), ["LEFT_CHART"]);
  assert.deepEqual(rankAlerts(prev(5), 6, "1", "FR", "free", "all", true), []);
});

test("feed parsing + countries + integrations", () => {
  const feed = { feed: { entry: [{ id: { attributes: { "im:id": "11" } } }, { id: { attributes: { "im:id": "22" } } }] } };
  assert.equal(parseChart(feed).get("22"), 2);
  const r = parseReviews({ feed: { entry: { id: { label: "9" }, "im:rating": { label: "5" }, title: { label: "Top" }, content: { label: "Super" }, author: { name: { label: "x" } }, "im:version": { label: "1.0" }, updated: { label: "2026-10-01T10:00:00-07:00" } } } }, "FR");
  assert.equal(r[0].rating, 5); assert.equal(r[0].country, "FR");
  assert.equal(toAlpha2("FRA"), "FR"); assert.equal(toAlpha2("us"), "US"); assert.equal(toAlpha2("ZZZ"), null);
  assert.match(describeEvent({ name: "V2" }, { type: "TOP_10", appName: "V2", rank: 4, cc: "FR", chart: "free", scope: "all" }), /Top 10.*#4 FR/);
  assert.throws(() => sanitizeIntegrations({ slackWebhookUrl: "https://evil.com/x" }));
  assert.equal(sanitizeIntegrations({ slackWebhookUrl: "https://hooks.slack.com/services/a" }).slackWebhookUrl, "https://hooks.slack.com/services/a");
});

test("country rotation covers every storefront within 6 runs", () => {
  const { countriesForRun, PRIORITY_COUNTRIES } = require("../lib/appstore");
  const { ALL_COUNTRIES } = require("../lib/countries");
  const seen = new Set();
  for (let i = 0; i < 6; i++) countriesForRun(i).forEach(c => seen.add(c));
  assert.equal(seen.size, ALL_COUNTRIES.length);
  for (const c of PRIORITY_COUNTRIES) assert.ok(countriesForRun(3).includes(c));
  assert.ok(countriesForRun(0).length < 60);
});

test("v2 marketing feed parsing", () => {
  const { parseChartV2 } = require("../lib/appstore");
  const m = parseChartV2({ feed: { results: [{ id: "5" }, { id: "7" }] } });
  assert.equal(m.get("7"), 2); assert.equal(parseChartV2({}).size, 0);
});

test("setup checklist detects progress", () => {
  const { setupSteps } = require("../lib/api");
  const empty = setupSteps({ config: { entitlements: {} } }, {}, { customers: 0, purchases: 0 });
  assert.equal(empty.next, "products"); assert.equal(empty.progress, 0);
  const ios = setupSteps({ config: { entitlements: { premium: ["m"] }, apple: { bundleId: "a" } }, health: { sdk: { lastAt: 1 } } }, { appStoreConnect: {} }, { customers: 3, purchases: 0 });
  assert.equal(ios.next, "appleNotifications");
  assert.ok(ios.steps.find(s => s.id === "google").optional);
  const done = setupSteps({ config: { entitlements: { premium: ["m"] }, apple: { bundleId: "a" } }, health: { sdk: { lastAt: 1 }, appleNotifications: { lastAt: 1 } } }, { appStoreConnect: {} }, { customers: 3, purchases: 1 });
  assert.equal(done.progress, 1); assert.equal(done.next, null);
});

test("RevenueCat v1 subscriber import mapping", () => {
  const { purchasesFromV1 } = require("../lib/revenuecat");
  const now = Date.parse("2026-10-08T12:00:00Z");
  const ps = purchasesFromV1({
    subscriptions: {
      "com.app.annual": { store: "app_store", purchase_date: "2026-03-01T00:00:00Z", original_purchase_date: "2025-03-01T00:00:00Z", expires_date: "2027-03-01T00:00:00Z", period_type: "normal", is_sandbox: false, price: { amount: 34.99, currency: "eur" } },
      "com.app.monthly": { store: "app_store", purchase_date: "2026-08-01T00:00:00Z", expires_date: "2026-09-01T00:00:00Z", unsubscribe_detected_at: "2026-08-10T00:00:00Z", is_sandbox: false },
      "com.app.trial": { store: "play_store", purchase_date: "2026-10-05T00:00:00Z", expires_date: "2026-10-12T00:00:00Z", period_type: "trial", is_sandbox: false },
    },
    non_subscriptions: { "com.app.lifetime": [{ store: "app_store", purchase_date: "2025-01-01T00:00:00Z", is_sandbox: false }] },
  }, now);
  const by = Object.fromEntries(ps.map(p => [p.productId, p]));
  assert.equal(by["com.app.annual"].status, "active"); assert.equal(by["com.app.annual"].periodMonths, 12); assert.equal(by["com.app.annual"].priceMicros, 34_990_000); assert.equal(by["com.app.annual"].currency, "EUR");
  assert.equal(by["com.app.monthly"].status, "expired"); assert.equal(by["com.app.monthly"].willRenew, false);
  assert.equal(by["com.app.trial"].isTrial, true); assert.equal(by["com.app.trial"].store, "play_store");
  assert.equal(by["com.app.lifetime"].expiresAt, null); assert.ok(by["com.app.lifetime"].id.startsWith("rc_"));
});

test("stripe one-time payment mapping", () => {
  const { stripeOneTimePurchase, appUserIdFrom } = require("../lib/stripe");
  const p = stripeOneTimePurchase({ id: "ch_1", payment_intent: "pi_1", amount_captured: 1599, amount_refunded: 0, created: 1700000000, currency: "eur", livemode: true, paid: true, refunded: false, description: "Carnet", metadata: {}, billing_details: { address: { country: "fr" } } });
  assert.equal(p.id, "pi_1"); assert.equal(p.priceMicros, 15_990_000); assert.equal(p.country, "FR"); assert.equal(p.type, "non_consumable");
  assert.equal(appUserIdFrom({ firebaseUID: "abc" }), "abc"); assert.equal(appUserIdFrom({ foo: "x" }), null);
});
