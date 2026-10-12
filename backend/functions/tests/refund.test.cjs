const test = require("node:test");
const assert = require("node:assert");
const { buildConsumptionRequest, tenureBucket, consumptionPercentage, sanitizeRefundControl, refundStats } = require("../lib/refund");

const DAY = 86400000, now = 1_800_000_000_000;
const on = { enabled: true, preference: "decline", customerConsented: true };
const sub = { type: "subscription", status: "active", purchasedAt: now - 40 * DAY, latestPurchaseAt: now - 10 * DAY, expiresAt: now + 20 * DAY };

test("tenure buckets", () => {
  assert.equal(tenureBucket(undefined, now), 0);
  assert.equal(tenureBucket(now - 1 * DAY, now), 1);
  assert.equal(tenureBucket(now - 5 * DAY, now), 2);
  assert.equal(tenureBucket(now - 20 * DAY, now), 3);
  assert.equal(tenureBucket(now - 60 * DAY, now), 4);
  assert.equal(tenureBucket(now - 100 * DAY, now), 5);
  assert.equal(tenureBucket(now - 200 * DAY, now), 6);
  assert.equal(tenureBucket(now - 400 * DAY, now), 7);
});

test("consumption percentage", () => {
  assert.equal(consumptionPercentage(sub, now), 33333);
  assert.equal(consumptionPercentage({ ...sub, type: "non_consumable", expiresAt: null }, now), 100000);
  assert.equal(consumptionPercentage({ ...sub, type: "consumable", expiresAt: null }, now), undefined);
  assert.equal(consumptionPercentage(null, now), undefined);
});

test("build: decline, delivered, signals", () => {
  const r = buildConsumptionRequest({ config: on, purchase: sub, customer: { firstSeenAt: now - 60 * DAY, totalSpentMicros: 9_990_000, activeEntitlements: ["pro"] }, refundsCount: 1, now });
  assert.deepEqual(r.body, { customerConsented: true, deliveryStatus: "DELIVERED", sampleContentProvided: false, consumptionPercentage: 33333, refundPreference: "DECLINE" });
  assert.deepEqual(r.signals, { accountTenure: 4, totalSpentMicros: 9_990_000, refundsCount: 1, entitlementActive: true });
});

test("build: grant / none / undelivered / skipped", () => {
  assert.equal(buildConsumptionRequest({ config: { ...on, preference: "grant" }, purchase: sub, now }).body.refundPreference, "GRANT_FULL");
  assert.equal(buildConsumptionRequest({ config: { ...on, preference: "none" }, purchase: sub, now }).body.refundPreference, undefined);
  assert.equal(buildConsumptionRequest({ config: on, purchase: null, now }).body.deliveryStatus, "UNDELIVERED_OTHER");
  assert.equal(buildConsumptionRequest({ config: { ...on, enabled: false }, purchase: sub, now }).skipped, "disabled");
  const nc = buildConsumptionRequest({ config: { ...on, customerConsented: false }, purchase: sub, now });
  assert.equal(nc.body, null);
  assert.equal(nc.skipped, "no_customer_consent");
});

test("config sanitize and stats", () => {
  assert.deepEqual(sanitizeRefundControl({ enabled: 1, preference: "grant" }), { enabled: true, preference: "grant", customerConsented: false });
  assert.throws(() => sanitizeRefundControl({ preference: "maybe" }), /invalid_refund_preference/);
  assert.throws(() => sanitizeRefundControl("x"), /invalid_refund_control/);
  const s = refundStats([{ status: "sent", outcome: "declined" }, { status: "sent", outcome: "refunded" }, { status: "sent", outcome: "declined" }, { status: "skipped", outcome: "pending" }]);
  assert.equal(s.total, 4); assert.equal(s.sent, 3); assert.equal(s.skipped, 1); assert.equal(s.declined, 2); assert.equal(s.pending, 1);
  assert.equal(s.refundRate, 1 / 3);
});
