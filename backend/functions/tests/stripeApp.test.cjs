const test = require("node:test");
const assert = require("node:assert");
const s = require("../lib/stripeApp");

const secret = "absec_test_123";
const payload = s.stripeAppPayload("usr_K6yd2CbXLO9A5G", "acct_1JSkf6FRwUQjTSJE");
const now = 1_760_000_000_000;
const t = Math.floor(now / 1000);
const header = (sec = secret, ts = t, p = payload) => `t=${ts},v1=${s.computeStripeSignature(p, sec, ts)}`;

test("payload keeps Stripe's key order (user_id, account_id)", () => {
  assert.equal(payload, '{"user_id":"usr_K6yd2CbXLO9A5G","account_id":"acct_1JSkf6FRwUQjTSJE"}');
});

test("matches Stripe's reference HMAC (t.payload, sha256 hex)", () => {
  const crypto = require("crypto");
  const ref = crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  assert.equal(s.computeStripeSignature(payload, secret, t), ref);
});

test("valid signature accepted, incl. rotation and extra v0/v1 entries", () => {
  assert.deepEqual(s.verifyStripeAppSignature(header(), payload, [secret], { now }), { ok: true });
  assert.ok(s.verifyStripeAppSignature(header(), payload, ["absec_old", secret], { now }).ok);
  const multi = `t=${t},v0=deadbeef,v1=${"00".repeat(32)},v1=${s.computeStripeSignature(payload, secret, t)}`;
  assert.ok(s.verifyStripeAppSignature(multi, payload, [secret], { now }).ok);
});

test("rejections", () => {
  const r = (h, p = payload, secrets = [secret]) => s.verifyStripeAppSignature(h, p, secrets, { now }).reason;
  assert.equal(r(undefined), "missing_header");
  assert.equal(r("garbage"), "malformed_header");
  assert.equal(r(`t=${t}`), "malformed_header");
  assert.equal(r(header(), payload, []), "no_secret");
  assert.equal(r(header("absec_other")), "signature_mismatch");
  assert.equal(r(header(), s.stripeAppPayload("usr_other", "acct_1JSkf6FRwUQjTSJE")), "signature_mismatch");
  assert.equal(r(`t=${t},v1=abc`), "signature_mismatch");
  assert.equal(r(header(secret, t - 301)), "timestamp_out_of_tolerance");
  assert.equal(r(header(secret, t + 301)), "timestamp_out_of_tolerance");
  assert.ok(s.verifyStripeAppSignature(header(secret, t - 299), payload, [secret], { now }).ok);
});

test("grant durations and customer ids", () => {
  assert.equal(s.parseGrantDays(30), 30);
  assert.equal(s.parseGrantDays("7"), 7);
  assert.equal(s.parseGrantDays(null), null);
  assert.equal(s.parseGrantDays("lifetime"), null);
  assert.equal(s.parseGrantDays(31), undefined);
  assert.equal(s.parseGrantDays("abc"), undefined);
  assert.ok(s.isStripeCustomerId("cus_NffrFeUfNV2Hib"));
  assert.ok(!s.isStripeCustomerId("cus_../x"));
  assert.ok(!s.isStripeCustomerId("acct_123456"));
});
