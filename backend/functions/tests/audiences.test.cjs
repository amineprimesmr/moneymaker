const test = require("node:test");
const assert = require("node:assert");
const A = require("../lib/audiences");

const NOW = Date.UTC(2026, 9, 1);
const sub = (o = {}) => ({ id: "p", store: "app_store", productId: "monthly", type: "subscription", status: "active", purchasedAt: NOW - 1e9, latestPurchaseAt: NOW - 1e8,
  expiresAt: NOW + 1e9, willRenew: true, isTrial: false, isSandbox: false, priceMicros: 9990000, currency: "EUR", periodMonths: 1, billingIssue: false, updatedAt: NOW, ...o });

test("sanitize: validates and normalises", () => {
  const [a] = A.sanitizeAudiences([{ id: "fr_payers", name: " Payeurs FR ", filters: { country: "fr", status: "active", spentMinMicros: "1000000", firstSeenAfter: "2026-01-01", attributes: { plan: "pro" }, store: "" } }]);
  assert.equal(a.name, "Payeurs FR");
  assert.equal(a.filters.country, "FR");
  assert.equal(a.filters.spentMinMicros, 1000000);
  assert.equal(a.filters.firstSeenAfter, Date.UTC(2026, 0, 1));
  assert.equal(a.filters.store, undefined);
  assert.throws(() => A.sanitizeAudiences([{ name: "x", filters: { status: "vip" } }]), /invalid_audience_status/);
  assert.throws(() => A.sanitizeAudiences([{ id: "a", name: "x" }, { id: "a", name: "y" }]), /duplicate_audience_id/);
  assert.throws(() => A.sanitizeAudiences([{ name: "" }]), /invalid_audience_name/);
  assert.throws(() => A.sanitizeAudiences([{ name: "x", filters: { store: "amazon" } }]), /invalid_audience_store/);
  assert.equal(A.sanitizeAudiences([{ name: "x" }])[0].id, "aud_1");
});

test("status derivation", () => {
  assert.equal(A.customerStatus([sub()], NOW), "active");
  assert.equal(A.customerStatus([sub({ isTrial: true, priceMicros: 0 })], NOW), "trial");
  assert.equal(A.customerStatus([sub({ status: "billing_retry" })], NOW), "billing_issue");
  assert.equal(A.customerStatus([sub({ status: "expired", expiresAt: NOW - 1 })], NOW), "churned");
  assert.equal(A.customerStatus([sub({ status: "expired", expiresAt: NOW - 1, isTrial: true, priceMicros: 0 })], NOW), "never_paid");
  assert.equal(A.customerStatus([], NOW), "never_paid");
  assert.equal(A.customerStatus([sub({ isSandbox: true })], NOW), "never_paid");
});

test("matching", () => {
  const c = { id: "u1", country: "FR", firstSeenAt: NOW - 86400000, totalSpentMicros: 20e6, attributes: { plan: "pro" }, appleAds: { campaignId: 123 }, activeEntitlements: ["premium"], purchases: [sub()] };
  const m = f => A.matchAudience(A.sanitizeFilters(f), c, NOW);
  assert.equal(m({}), true);
  assert.equal(m({ country: "fr", status: "active", store: "app_store", productId: "monthly", entitlement: "premium" }), true);
  assert.equal(m({ country: "US" }), false);
  assert.equal(m({ store: "stripe" }), false);
  assert.equal(m({ status: "churned" }), false);
  assert.equal(m({ spentMinMicros: 30e6 }), false);
  assert.equal(m({ attributes: { plan: "free" } }), false);
  assert.equal(m({ appleAdsCampaign: "123" }), true);
  assert.equal(m({ firstSeenAfter: NOW - 3600000 }), false);
  assert.equal(m({ firstSeenBefore: NOW }), true);
});

test("csv export", () => {
  const csv = A.audienceCsv([{ id: 'a,"b"', country: "FR", firstSeenAt: NOW, totalSpentMicros: 5, purchases: [sub()], activeEntitlements: ["premium"] }], NOW);
  const [head, row] = csv.trim().split("\n");
  assert.ok(head.startsWith("app_user_id,status"));
  assert.ok(row.startsWith('"a,""b""",active,FR,2026-10-01T00:00:00.000Z,5,premium,app_store,monthly'));
});
