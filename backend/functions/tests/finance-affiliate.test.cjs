const test = require("node:test");
const assert = require("node:assert");
const { computeWaterfall, DEFAULT_FINANCE, sanitizeFinance } = require("../lib/finance");
const { isAffiliateSale } = require("../lib/stripe");

const sale = (affiliate) => ({ store: "stripe", amountMicros: 99e6, currency: "EUR", country: "US", kind: "purchase", at: Date.now(), affiliate });

test("commission d'affiliation déduite seulement si l'option est active", () => {
  const off = computeWaterfall([sale(true), sale(false)], { ...DEFAULT_FINANCE }, "EUR", 30);
  assert.equal(off.affiliateMicros, 0);
  const on = computeWaterfall([sale(true), sale(false)], { ...DEFAULT_FINANCE, deductAffiliates: true }, "EUR", 30);
  assert.equal(on.affiliateMicros, Math.round(99e6 * 0.4));
  assert.equal(on.affiliateSales, 1);
  assert.equal(on.netRevenueMicros, off.netRevenueMicros - on.affiliateMicros);
});

test("réglages : taux d'affiliation validé", () => {
  assert.equal(sanitizeFinance({ deductAffiliates: true, affiliateRate: 0.3 }).affiliateRate, 0.3);
  assert.throws(() => sanitizeFinance({ affiliateRate: 2 }));
});

test("vente affiliée reconnue par ses métadonnées", () => {
  assert.equal(isAffiliateSale({ sk_ref: "4nrjg8s" }), true);
  assert.equal(isAffiliateSale({ sk_plan: "lifetime" }, null), false);
});
