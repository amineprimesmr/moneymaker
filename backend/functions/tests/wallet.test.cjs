const test = require("node:test");
const assert = require("node:assert");
const W = require("../lib/wallet");

const cur = W.sanitizeVirtualCurrencies([{ code: "gems", name: "Gemmes", grants: { gems_100: 100, "pro.monthly": 50 } }]);
const p = (o = {}) => ({ id: "tx1", store: "app_store", productId: "gems_100", type: "consumable", status: "active", purchasedAt: 1, latestPurchaseAt: 1000,
  expiresAt: null, willRenew: false, isTrial: false, isSandbox: false, priceMicros: 1990000, currency: "EUR", periodMonths: 0, billingIssue: false, updatedAt: 1, ...o });

test("config validation", () => {
  assert.equal(cur[0].code, "GEMS");
  assert.throws(() => W.sanitizeVirtualCurrencies([{ code: "a b", name: "x" }]), /invalid_currency_code/);
  assert.throws(() => W.sanitizeVirtualCurrencies([{ code: "A", name: "x", grants: { p: -1 } }]), /invalid_currency_grants/);
  assert.throws(() => W.sanitizeVirtualCurrencies([{ code: "A", name: "x" }, { code: "a", name: "y" }]), /duplicate_currency_code/);
});

test("credits on purchase/renewal, debits on refund, idempotent keys", () => {
  const [g] = W.walletOpsFor(cur, p(), ["NON_RENEWING_PURCHASE"]);
  assert.equal(g.amount, 100);
  assert.equal(g.code, "GEMS");
  const [g2] = W.walletOpsFor(cur, p(), ["NON_RENEWING_PURCHASE"]);
  assert.equal(g.key, g2.key, "same transaction → same ledger key");
  const [r1] = W.walletOpsFor(cur, p({ productId: "pro.monthly", type: "subscription" }), ["RENEWAL"]);
  const [r2] = W.walletOpsFor(cur, p({ productId: "pro.monthly", type: "subscription", latestPurchaseAt: 2000 }), ["RENEWAL"]);
  assert.notEqual(r1.key, r2.key, "each renewal credits once");
  const [refund] = W.walletOpsFor(cur, p(), ["REFUND"]);
  assert.equal(refund.amount, -100);
  assert.notEqual(refund.key, g.key);
  assert.deepEqual(W.walletOpsFor(cur, p({ productId: "other" }), ["INITIAL_PURCHASE"]), []);
  assert.deepEqual(W.walletOpsFor(cur, p({ isTrial: true }), ["TRIAL_STARTED"]), []);
  assert.deepEqual(W.walletOpsFor(cur, p(), ["CANCELLATION"]), []);
  assert.deepEqual(W.walletOpsFor(cur, p({ store: "promotional" }), ["GRANT"]), []);
  assert.deepEqual(W.walletOpsFor(undefined, p(), ["INITIAL_PURCHASE"]), []);
});

test("spend guards", () => {
  assert.equal(W.canSpend(10, 10), true);
  assert.equal(W.canSpend(9, 10), false);
  assert.throws(() => W.parseAmount(0), /invalid_amount/);
  assert.throws(() => W.parseAmount(1.5), /invalid_amount/);
  assert.equal(W.parseAmount("5"), 5);
  assert.throws(() => W.parseIdempotencyKey("short"), /invalid_idempotency_key/);
  assert.equal(W.parseIdempotencyKey("order-12345"), "order-12345");
});
