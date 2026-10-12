const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const A = require("../lib/ads");
const C = require("../lib/charts");

const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = publicKey.export({ type: "spki", format: "pem" });
const keys = A.parseVerifierKeys({ keys: [{ keyId: 3335741209, pem, base64: "" }] });
const websafe = b => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function signedQuery(content, keyId = "3335741209") {
  const sig = crypto.sign("sha256", Buffer.from(content), { key: privateKey, dsaEncoding: "der" });
  return `${content}&signature=${websafe(sig)}&key_id=${keyId}`;
}
const content = "ad_network=5450213213286189855&ad_unit=ca-app-pub-1%2F2&custom_data=x&reward_amount=10&reward_item=coins&timestamp=1507770365237823&transaction_id=18fa792de1bca816048293fc71035638&user_id=user_1";

test("SSV: valid signature over the raw query string before &signature=", () => {
  const p = A.parseSsvQuery(signedQuery(content));
  assert.equal(p.content, content);
  assert.equal(p.adUnit, "ca-app-pub-1/2");
  assert.equal(p.rewardAmount, 10);
  assert.equal(p.transactionId, "18fa792de1bca816048293fc71035638");
  assert.equal(p.userId, "user_1");
  assert.equal(A.verifySsv(p, keys), true);
});

test("SSV: tampered content, wrong key, unknown key id, missing signature", () => {
  const q = signedQuery(content).replace("reward_amount=10", "reward_amount=99");
  assert.equal(A.verifySsv(A.parseSsvQuery(q), keys), false);
  const other = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const sig = crypto.sign("sha256", Buffer.from(content), { key: other.privateKey, dsaEncoding: "der" });
  assert.equal(A.verifySsv(A.parseSsvQuery(`${content}&signature=${websafe(sig)}&key_id=3335741209`), keys), false);
  assert.throws(() => A.verifySsv(A.parseSsvQuery(signedQuery(content, "42")), keys), /unknown_key_id/);
  assert.throws(() => A.parseSsvQuery(content), /missing_signature/);
  assert.throws(() => A.parseSsvQuery(`${content}&signature=abc`), /missing_key_id/);
});

test("SSV: base64 DER keys from the key server also parse", () => {
  const der = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const k = A.parseVerifierKeys({ keys: [{ keyId: 1, base64: der }, { keyId: 2, pem: "garbage" }] });
  assert.equal(k.size, 1);
  assert.equal(A.verifySsv(A.parseSsvQuery(signedQuery(content, "1")), k), true);
});

test("SSV reward mapping", () => {
  const p = A.parseSsvQuery(signedQuery(content));
  assert.deepEqual(A.rewardFor(p, { "ca-app-pub-1/2": { currency: "GEMS" } }), { currency: "GEMS", amount: 10 });
  assert.deepEqual(A.rewardFor(p, { "ca-app-pub-1/2": { currency: "GEMS", amount: 3 } }), { currency: "GEMS", amount: 3 });
  assert.equal(A.rewardFor(p, {}), null);
  assert.deepEqual(A.sanitizeAdmobConfig({ rewards: { u: { currency: "gems" } } }, ["GEMS"]), { rewards: { u: { currency: "GEMS" } } });
  assert.throws(() => A.sanitizeAdmobConfig({ rewards: { u: { currency: "X" } } }, ["GEMS"]), /unknown_virtual_currency/);
});

test("ad event validation (Google Mobile Ads paid event values)", () => {
  const e = A.sanitizeAdEvent({ type: "impression", network: "AdMob", adUnitId: "ca-app-pub-1/2", valueMicros: 1234, currencyCode: "usd", precision: 3 }, "u1", 1000);
  assert.deepEqual([e.network, e.revenueMicros, e.currency, e.precision, e.placement], ["admob", 1234, "USD", "precise", null]);
  assert.equal(A.sanitizeAdEvent({ adUnitId: "x", precision: "ESTIMATED" }, "u", 1).precision, "estimated");
  assert.throws(() => A.sanitizeAdEvent({ type: "view", adUnitId: "x" }, "u", 1), /invalid_type/);
  assert.throws(() => A.sanitizeAdEvent({ adUnitId: "x", revenueMicros: -1 }, "u", 1), /invalid_revenue/);
  assert.throws(() => A.sanitizeAdEvent({}, "u", 1), /invalid_ad_unit/);
});

test("daily aggregation and ad charts", () => {
  const day = Date.UTC(2026, 9, 1);
  const ev = (o) => A.sanitizeAdEvent({ adUnitId: "x", currency: "EUR", ...o }, "u", o.at ?? day);
  const events = [ev({ revenueMicros: 2000 }), ev({ revenueMicros: 3000, network: "applovin" }), ev({ type: "click", revenueMicros: 0 }), ev({ revenueMicros: 5000, at: day + 86400000 })];
  const agg = A.aggregateAdEvents(events, "EUR");
  assert.deepEqual(Object.keys(agg).sort(), ["2026-10-01", "2026-10-02"]);
  assert.equal(agg["2026-10-01"].revenueMicros, 5000);
  assert.equal(agg["2026-10-01"].impressions, 2);
  assert.equal(agg["2026-10-01"].clicks, 1);
  assert.equal(agg["2026-10-01"].byNetwork.applovin.revenueMicros, 3000);
  const bs = C.buckets(day, day + 86400000, "day");
  const days = Object.values(agg);
  const rev = A.computeAdChart("ad_revenue", days, {}, bs, "EUR", "day");
  assert.equal(rev.summary.value, 10000);
  const ecpm = A.computeAdChart("ad_ecpm", days, {}, bs, "EUR", "day");
  assert.equal(ecpm.series[0].value, 2500000, "5000 µ / 2 impressions × 1000");
  assert.equal(ecpm.summary.value, Math.round(10000 / 3 * 1000));
  const arp = A.computeAdChart("arpdau", days, { "2026-10-01": 10 }, bs, "EUR", "day");
  assert.equal(arp.series[0].value, 500);
  assert.equal(arp.series[1].value, null, "no DAU → null");
  assert.equal(arp.summary.value, 500);
  assert.ok(A.computeAdChart("arpdau", days, {}, bs, "EUR", "day").note);
  const week = A.computeAdChart("ad_impressions", days, {}, C.buckets(day, day + 86400000, "week"), "EUR", "week");
  assert.equal(week.summary.value, 3);
});
