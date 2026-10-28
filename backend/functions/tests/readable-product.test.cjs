const test = require("node:test");
const assert = require("node:assert/strict");

test("readable product labels hide placeholders and raw Stripe ids", () => {
  const { readableProductId } = require("../lib/engine.js");
  assert.equal(readableProductId("stripe_payment"), null);
  assert.equal(readableProductId("stripe_one_time"), null);
  assert.equal(readableProductId("price_1AbC23"), null);
  assert.equal(readableProductId(""), null);
  assert.equal(readableProductId("Process à vie"), "Process à vie");
  assert.equal(readableProductId("annual"), "annual");
});
