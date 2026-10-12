const test = require("node:test");
const assert = require("node:assert");
const s = require("../lib/signing");

const body = JSON.stringify({ entitlements: { pro: { active: true } } });

test("sign / verify round trip", () => {
  const kp = s.generateSigningKeyPair();
  assert.equal(Buffer.from(kp.publicKey, "base64").length, 32);
  const key = s.parsePrivateKey(kp.privateKey);
  assert.equal(s.rawPublicKey(key), kp.publicKey);
  const sig = s.signResponse(key, "nonce123", 1700000000000, body);
  assert.match(sig, /^v1=/);
  assert.ok(s.verifyResponse(kp.publicKey, sig, "nonce123", 1700000000000, body));
  assert.ok(s.verifyResponse(kp.publicKey, sig, "nonce123", "1700000000000", Buffer.from(body)));
});

test("tampering is rejected", () => {
  const kp = s.generateSigningKeyPair();
  const key = s.parsePrivateKey(kp.privateKey);
  const sig = s.signResponse(key, "n", 1, body);
  assert.equal(s.verifyResponse(kp.publicKey, sig, "other", 1, body), false);
  assert.equal(s.verifyResponse(kp.publicKey, sig, "n", 2, body), false);
  assert.equal(s.verifyResponse(kp.publicKey, sig, "n", 1, body.replace("true", "false")), false);
  assert.equal(s.verifyResponse(s.generateSigningKeyPair().publicKey, sig, "n", 1, body), false);
  assert.equal(s.verifyResponse(kp.publicKey, undefined, "n", 1, body), false);
  assert.equal(s.verifyResponse(kp.publicKey, "v2=abc", "n", 1, body), false);
  assert.equal(s.verifyResponse("bad", sig, "n", 1, body), false);
});

test("message format and key formats", () => {
  const h = require("crypto").createHash("sha256").update(body).digest("hex");
  assert.equal(s.signedMessage("abc", 42, body), `abc.42.${h}`);
  const kp = s.generateSigningKeyPair();
  const k = s.parsePrivateKey(kp.privateKey);
  const pem = k.export({ format: "pem", type: "pkcs8" });
  assert.equal(s.rawPublicKey(s.parsePrivateKey(pem)), kp.publicKey);
  const seed = k.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64");
  assert.equal(s.rawPublicKey(s.parsePrivateKey(seed)), kp.publicKey);
});

test("env key is used by getSigningKey", async () => {
  const kp = s.generateSigningKeyPair();
  process.env.MM_SIGNING_KEY = kp.privateKey;
  const k = await s.getSigningKey();
  assert.equal(k.publicKeyRaw, kp.publicKey);
});
