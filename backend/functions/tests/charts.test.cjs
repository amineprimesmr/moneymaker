const test = require("node:test");
const assert = require("node:assert");
const { computeChart, buckets, bucketStart, chartToCsv, CHART_NAMES } = require("../lib/charts");

const DAY = 86400000;
const T0 = Date.UTC(2026, 0, 1); // Thursday
const now = T0 + 9 * DAY + 12 * 3600000;
const opts = (o = {}) => ({ start: T0, end: now, now, resolution: "day", currency: "EUR", ...o });
const sub = (o) => ({ store: "app_store", productId: "pro_m", type: "subscription", status: "active", isTrial: false, isSandbox: false, priceMicros: 10_000_000, currency: "EUR", periodMonths: 1, willRenew: true, ...o });
const ev = (type, appUserId, at, o = {}) => ({ type, appUserId, at, productId: "pro_m", store: "app_store", priceMicros: 10_000_000, currency: "EUR", periodMonths: 1, ...o });
const tx = (appUserId, at, amount, o = {}) => ({ appUserId, at, amountMicrosProject: amount, kind: amount < 0 ? "refund" : "purchase", productId: "pro_m", store: "app_store", periodMonths: 1, ...o });
const empty = { purchases: [], txs: [], events: [], customers: [] };

test("buckets: day / week (Monday) / month", () => {
  assert.equal(buckets(T0, now, "day").length, 10);
  assert.equal(new Date(bucketStart(T0, "week")).toISOString().slice(0, 10), "2025-12-29");
  assert.deepEqual(buckets(T0, T0 + 40 * DAY, "month").map(b => b.date), ["2026-01-01", "2026-02-01"]);
});

test("active subscriptions + MRR reconstructed from purchases, snapshots win", () => {
  const purchases = [
    sub({ appUserId: "a", purchasedAt: T0 + 2 * DAY, expiresAt: T0 + 40 * DAY }),
    sub({ appUserId: "b", purchasedAt: T0 - 5 * DAY, expiresAt: T0 + 5 * DAY }),
    sub({ appUserId: "c", purchasedAt: T0, expiresAt: T0 + 30 * DAY, priceMicros: 120_000_000, periodMonths: 12 }),
    sub({ appUserId: "d", purchasedAt: T0, expiresAt: T0 + 30 * DAY, isTrial: true }),
    sub({ appUserId: "e", purchasedAt: T0, expiresAt: T0 + 30 * DAY, isSandbox: true }),
    sub({ appUserId: "f", purchasedAt: T0, expiresAt: T0 + 30 * DAY, status: "refunded", updatedAt: T0 + 3 * DAY }),
  ];
  const r = computeChart("active_subscriptions", { ...empty, purchases }, opts());
  assert.equal(r.series[0].value, 3); // b, c, f
  assert.equal(r.series[9].value, 2); // a, c
  const mrr = computeChart("mrr", { ...empty, purchases }, opts());
  assert.equal(mrr.series[9].value, 20_000_000);
  assert.equal(computeChart("arr", { ...empty, purchases }, opts()).summary.value, 240_000_000);
  assert.equal(computeChart("active_trials", { ...empty, purchases }, opts()).summary.value, 1);
  const snap = computeChart("active_subscriptions", { ...empty, purchases, daily: [{ date: "2026-01-01", activeSubscriptions: 42 }] }, opts());
  assert.equal(snap.series[0].value, 42);
  const filtered = computeChart("active_subscriptions", { ...empty, purchases, daily: [{ date: "2026-01-01", activeSubscriptions: 42 }] }, opts({ filters: { store: "play_store" } }));
  assert.equal(filtered.series[0].value, 0);
});

test("movement: new, reactivated, churned", () => {
  const events = [
    ev("INITIAL_PURCHASE", "a", T0 + DAY),
    ev("EXPIRATION", "a", T0 + 3 * DAY),
    ev("INITIAL_PURCHASE", "a", T0 + 5 * DAY),
    ev("TRIAL_CONVERTED", "b", T0 + 5 * DAY),
    ev("INITIAL_PURCHASE", "t", T0 + 5 * DAY, { isTrial: true }),
  ];
  const r = computeChart("active_subscriptions_movement", { ...empty, events }, opts());
  assert.deepEqual(r.summary, { new: 2, reactivated: 1, churned: -1, value: 2, net: 2 });
  assert.equal(r.series[5].new, 1);
  assert.equal(r.series[5].reactivated, 1);
  const m = computeChart("mrr_movement", { ...empty, events }, opts());
  assert.equal(m.summary.net, 20_000_000);
});

test("revenue, refunds, refund rate, non-subscription", () => {
  const txs = [tx("a", T0, 10_000_000), tx("b", T0 + DAY, 30_000_000, { periodMonths: 0 }), tx("a", T0 + 2 * DAY, -10_000_000), tx("s", T0, 99, { isSandbox: true })];
  const r = computeChart("revenue", { ...empty, txs }, opts());
  assert.equal(r.summary.revenue, 40_000_000);
  assert.equal(r.summary.net, 30_000_000);
  assert.equal(computeChart("refunds", { ...empty, txs }, opts()).summary.value, 1);
  assert.equal(computeChart("refund_rate", { ...empty, txs }, opts()).summary.value, 0.25);
  const ns = computeChart("non_subscription_purchases", { ...empty, txs }, opts());
  assert.equal(ns.summary.value, 1);
  assert.equal(ns.summary.revenue, 30_000_000);
});

test("customers: new, conversion to paying, realized LTV", () => {
  const customers = [{ id: "a", firstSeenAt: T0 }, { id: "b", firstSeenAt: T0 }, { id: "c", firstSeenAt: T0 + DAY }, { id: "d", firstSeenAt: T0 + DAY }];
  const txs = [tx("a", T0 + DAY, 10_000_000), tx("c", T0 + 9 * DAY, 20_000_000)];
  assert.equal(computeChart("new_customers", { ...empty, customers }, opts()).summary.value, 4);
  const c = computeChart("conversion_to_paying", { ...empty, customers, txs }, opts({ conversionDays: 7 }));
  assert.equal(c.summary.converted, 1);
  assert.equal(c.summary.value, 0.25);
  const ltv = computeChart("realized_ltv_per_customer", { ...empty, customers, txs }, opts());
  assert.equal(ltv.summary.value, 7_500_000);
  assert.equal(computeChart("realized_ltv_per_paying_customer", { ...empty, customers, txs }, opts()).summary.value, 15_000_000);
  const ic = computeChart("initial_conversion", { ...empty, customers, events: [ev("TRIAL_STARTED", "b", T0 + DAY)] }, opts());
  assert.equal(ic.summary.value, 0.25);
});

test("trial funnel / conversion / cancellation", () => {
  const events = [
    ev("TRIAL_STARTED", "a", T0), ev("TRIAL_CONVERTED", "a", T0 + 7 * DAY),
    ev("TRIAL_STARTED", "b", T0), ev("CANCELLATION", "b", T0 + DAY, { isTrial: true }),
    ev("TRIAL_STARTED", "c", T0 + DAY), ev("TRIAL_CONVERTED", "c", T0 + 8 * DAY),
  ];
  const purchases = [sub({ appUserId: "a", purchasedAt: T0, expiresAt: T0 + 60 * DAY })];
  const f = computeChart("trial_conversion_funnel", { ...empty, events, purchases }, opts());
  assert.equal(f.summary.started, 3);
  assert.equal(f.summary.converted, 2);
  assert.equal(f.summary.stillActive, 1);
  assert.equal(computeChart("trial_conversion_rate", { ...empty, events }, opts()).summary.value, 2 / 3);
  assert.equal(computeChart("trial_cancellation_rate", { ...empty, events }, opts()).summary.value, 1 / 3);
  const mv = computeChart("active_trials_movement", { ...empty, events }, opts());
  assert.equal(mv.summary.new, 3);
  assert.equal(mv.summary.converted, -2);
});

test("subscription retention by monthly cohort", () => {
  const M = (m) => Date.UTC(2026, m, 5);
  const txs = [tx("a", M(0), 1), tx("a", M(1), 1), tx("a", M(2), 1), tx("b", M(0), 1), tx("c", M(1), 12, { periodMonths: 12 })];
  const r = computeChart("subscription_retention", { ...empty, txs }, { start: M(0), end: M(2), now: M(2), resolution: "month", currency: "EUR", retentionPeriods: 4 });
  assert.equal(r.series.length, 2);
  assert.deepEqual([r.series[0].p0, r.series[0].p1, r.series[0].p2, r.series[0].p3], [1, 0.5, 0.5, null]);
  assert.deepEqual([r.series[1].p0, r.series[1].p1, r.series[1].p2], [1, 1, null]);
});

test("churn rate uses active base at bucket start", () => {
  const purchases = [sub({ appUserId: "a", purchasedAt: T0 - 10 * DAY, expiresAt: T0 + 2 * DAY }), sub({ appUserId: "b", purchasedAt: T0 - 10 * DAY, expiresAt: T0 + 40 * DAY })];
  const events = [ev("EXPIRATION", "a", T0 + 2 * DAY)];
  const r = computeChart("churn", { ...empty, purchases, events }, opts());
  assert.equal(r.series[2].value, 0.5);
  assert.equal(r.summary.churned, 1);
});

test("subscription status + paywall (missing and present)", () => {
  const purchases = [
    sub({ appUserId: "a", purchasedAt: T0, expiresAt: now + DAY }),
    sub({ appUserId: "b", purchasedAt: T0, expiresAt: now + DAY, willRenew: false }),
    sub({ appUserId: "c", purchasedAt: T0, expiresAt: now - DAY, status: "billing_retry" }),
    sub({ appUserId: "d", purchasedAt: T0, expiresAt: now + DAY, status: "grace" }),
    sub({ appUserId: "e", purchasedAt: T0, expiresAt: T0 + DAY, status: "expired" }),
  ];
  const s = computeChart("subscription_status", { ...empty, purchases }, opts());
  assert.deepEqual(s.summary, { value: 4, active: 1, grace: 1, billing_retry: 1, cancelled_active: 1, expired: 1 });
  const none = computeChart("paywall", { ...empty, paywallEvents: null }, opts());
  assert.equal(none.summary.value, null);
  const pe = [{ type: "impression", at: T0 }, { type: "impression", at: T0 }, { type: "purchase_start", at: T0 }, { type: "purchase", at: T0 }];
  assert.equal(computeChart("paywall", { ...empty, paywallEvents: pe }, opts()).summary.value, 0.5);
});

test("every chart computes on empty data; csv; unknown chart throws", () => {
  for (const n of CHART_NAMES) {
    const r = computeChart(n, empty, opts({ resolution: "week" }));
    assert.equal(r.name, n);
    assert.ok(Array.isArray(r.series));
  }
  assert.throws(() => computeChart("nope", empty, opts()), /unknown_chart/);
  const csv = chartToCsv(computeChart("revenue", { ...empty, txs: [tx("a", T0, 5)] }, opts()));
  assert.equal(csv.split("\n")[0], "date,value,revenue,refunds,net,transactions");
  assert.equal(csv.split("\n")[1], "2026-01-01,5,5,0,5,1");
});
