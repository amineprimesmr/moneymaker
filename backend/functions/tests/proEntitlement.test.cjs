const test = require("node:test");
const assert = require("node:assert");
const { proSources, proState, withSource, proFields, testerOverride, normalizeGiftCode, isFullDiscount, giftAttempts } = require("../lib/proEntitlement");

const web = { since: 1, ref: "pi_1" }, ios = { since: 2, ref: "2000000123", environment: "Production" };

test("an account with no purchase is free", () => {
  assert.deepEqual(proState(undefined), { pro: false, sources: [] });
  assert.deepEqual(proState({}), { pro: false, sources: [] });
});

test("bought on the web or on iPhone: the same account is Pro everywhere", () => {
  assert.deepEqual(proState(proFields(withSource({}, "stripe", web))), { pro: true, sources: ["stripe"] });
  assert.deepEqual(proState(proFields(withSource({}, "app_store", ios))), { pro: true, sources: ["app_store"] });
});

test("refunding one purchase keeps Pro while another one is active", () => {
  const both = proFields(withSource({ proSources: { stripe: web } }, "app_store", ios));
  assert.deepEqual(proState(both).sources.sort(), ["app_store", "stripe"]);
  const refunded = proFields(withSource(both, "stripe", null));
  assert.deepEqual(proState(refunded), { pro: true, sources: ["app_store"] });
  assert.equal(proState(proFields(withSource(refunded, "app_store", null))).pro, false);
});

test("accounts from before the sources keep their Pro", () => {
  assert.deepEqual(proSources({ pro: true, proSince: 5, proPaymentIntent: "pi_old" }), { stripe: { since: 5, ref: "pi_old" } });
  assert.deepEqual(proSources({ pro: true, proSince: 6, proOriginalTransactionId: "200" }), { app_store: { since: 6, ref: "200" } });
  assert.deepEqual(proSources({ pro: true, proSince: 7, proChannel: "apple_pay_ios", proPaymentIntent: "pi_ap" }), { stripe: { since: 7, ref: "pi_ap" } });
  assert.deepEqual(proSources({ pro: true }), { granted: { since: 0 } });
  assert.deepEqual(proSources({ pro: false, proPaymentIntent: "pi_refunded" }), {});
});

test("tester switch overrides the display without touching purchases", () => {
  const bought = { proSources: { app_store: ios } };
  const off = proFields(bought.proSources, false);
  assert.deepEqual(proState(off), { pro: false, sources: ["app_store"] });
  assert.equal(proState(proFields(off.proSources, true)).pro, true);
  // Old switch wrote pro directly.
  assert.equal(testerOverride({ pro: true, proTestToggledAt: 1 }), true);
  assert.deepEqual(proState({ pro: false, proTestToggledAt: 1 }), { pro: false, sources: [] });
});

test("a gift code is compared without spaces and in upper case", () => {
  assert.equal(normalizeGiftCode(" process 9961274f66 "), "PROCESS9961274F66");
  assert.equal(normalizeGiftCode("AB-12_cd"), "AB-12_CD");
  for (const bad of [undefined, 42, "", "abc", "x".repeat(41), "code/../x", "-LEADING"]) assert.equal(normalizeGiftCode(bad), null);
});

test("only a valid 100 % coupon gives Pro", () => {
  assert.equal(isFullDiscount({ percent_off: 100, valid: true }), true);
  assert.equal(isFullDiscount({ percent_off: 100 }), true);
  for (const c of [null, undefined, { percent_off: 50 }, { amount_off: 2900 }, { percent_off: 100, valid: false }]) assert.equal(isFullDiscount(c), false);
});

test("a redeemed gift code is a Pro source that survives a web refund", () => {
  const gifted = proFields(withSource({ proSources: { stripe: web } }, "granted", { since: 3, ref: "code:PROCESS1" }));
  assert.deepEqual(proState(proFields(withSource(gifted, "stripe", null))), { pro: true, sources: ["granted"] });
});

test("failed gift attempts are counted per day", () => {
  assert.equal(giftAttempts(undefined, "2026-11-11"), 0);
  assert.equal(giftAttempts({ giftAttempts: { day: "2026-11-11", n: 4 } }, "2026-11-11"), 4);
  assert.equal(giftAttempts({ giftAttempts: { day: "2026-11-10", n: 9 } }, "2026-11-11"), 0);
});
