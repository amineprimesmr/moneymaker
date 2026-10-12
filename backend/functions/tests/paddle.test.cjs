const test = require("node:test");
const assert = require("node:assert");
const { createHmac } = require("crypto");
const { verifyPaddleSignature, paddleSubscriptionPurchase, paddleTransactionPurchase, paddleAppUserId, periodMonthsOf } = require("../lib/paddleCore");

const secret = "pdl_ntfset_test_secret";
const body = JSON.stringify({ event_id: "evt_1", event_type: "subscription.created", data: { id: "sub_1" } });
const now = 1_800_000_000_000, ts = Math.floor(now / 1000);
const sig = (t, b, k = secret) => createHmac("sha256", k).update(`${t}:${b}`).digest("hex");

test("paddle signature: valid, tampered, wrong secret, stale, malformed, rotation", () => {
  assert.equal(verifyPaddleSignature(Buffer.from(body), `ts=${ts};h1=${sig(ts, body)}`, secret, now), true);
  assert.equal(verifyPaddleSignature(Buffer.from(body + " "), `ts=${ts};h1=${sig(ts, body)}`, secret, now), false);
  assert.equal(verifyPaddleSignature(body, `ts=${ts};h1=${sig(ts, body, "other")}`, secret, now), false);
  assert.equal(verifyPaddleSignature(body, `ts=${ts - 3600};h1=${sig(ts - 3600, body)}`, secret, now), false);
  assert.equal(verifyPaddleSignature(body, `h1=${sig(ts, body)}`, secret, now), false);
  assert.equal(verifyPaddleSignature(body, undefined, secret, now), false);
  assert.equal(verifyPaddleSignature(body, `ts=${ts};h1=zz`, secret, now), false);
  assert.equal(verifyPaddleSignature(body, `ts=${ts};h1=${sig(ts, body, "old")};h1=${sig(ts, body)}`, secret, now), true);
});

const sub = {
  id: "sub_01", status: "active", customer_id: "ctm_01", currency_code: "eur", started_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z",
  current_billing_period: { starts_at: "2026-02-01T00:00:00Z", ends_at: "2026-03-01T00:00:00Z" },
  billing_cycle: { interval: "month", frequency: 1 }, scheduled_change: null, custom_data: { app_user_id: "user_42" },
  items: [{ quantity: 1, price: { id: "pri_01", unit_price: { amount: "999", currency_code: "EUR" } } }],
};

test("paddle subscription mapping", () => {
  const p = paddleSubscriptionPurchase(sub, Date.parse("2026-02-10T00:00:00Z"));
  assert.equal(p.store, "paddle"); assert.equal(p.productId, "pri_01"); assert.equal(p.status, "active");
  assert.equal(p.priceMicros, 9_990_000); assert.equal(p.currency, "EUR"); assert.equal(p.periodMonths, 1);
  assert.equal(p.expiresAt, Date.parse("2026-03-01T00:00:00Z")); assert.equal(p.willRenew, true); assert.equal(p.isTrial, false);
  assert.equal(paddleAppUserId(sub.custom_data), "user_42");
  assert.equal(paddleAppUserId(null), null);
});

test("paddle statuses: trialing, past_due, scheduled cancel, canceled, paused", () => {
  const at = Date.parse("2026-02-10T00:00:00Z");
  assert.equal(paddleSubscriptionPurchase({ ...sub, status: "trialing" }, at).isTrial, true);
  const pd = paddleSubscriptionPurchase({ ...sub, status: "past_due" }, at);
  assert.equal(pd.status, "billing_retry"); assert.equal(pd.billingIssue, true);
  assert.equal(paddleSubscriptionPurchase({ ...sub, scheduled_change: { action: "cancel", effective_at: "2026-03-01T00:00:00Z" } }, at).willRenew, false);
  const c = paddleSubscriptionPurchase({ ...sub, status: "canceled", canceled_at: "2026-02-05T00:00:00Z" }, at);
  assert.equal(c.status, "expired"); assert.equal(c.willRenew, false); assert.equal(c.expiresAt, Date.parse("2026-02-05T00:00:00Z"));
  assert.equal(paddleSubscriptionPurchase({ ...sub, status: "paused" }, at).status, "paused");
  assert.equal(periodMonthsOf({ interval: "year", frequency: 1 }), 12);
  assert.equal(periodMonthsOf({ interval: "week", frequency: 2 }), 0.5);
});

test("paddle one-time transaction mapping", () => {
  const p = paddleTransactionPurchase({ id: "txn_01", currency_code: "USD", billed_at: "2026-02-01T00:00:00Z", details: { totals: { grand_total: "4999" } }, items: [{ price: { id: "pri_life" } }], address: { country_code: "US" } });
  assert.equal(p.type, "non_consumable"); assert.equal(p.expiresAt, null); assert.equal(p.priceMicros, 49_990_000);
  assert.equal(p.productId, "pri_life"); assert.equal(p.country, "US");
  // JPY has no minor unit: "4999" = ¥4,999.
  assert.equal(paddleTransactionPurchase({ id: "txn_02", currency_code: "JPY", details: { totals: { grand_total: "4999" } }, items: [] }).priceMicros, 4_999_000_000);
});
