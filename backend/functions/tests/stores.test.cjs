const test = require("node:test");
const assert = require("node:assert");
const { generateKeyPairSync, createSign, createVerify } = require("crypto");
const amazon = require("../lib/amazon");
const galaxy = require("../lib/galaxy");
const roku = require("../lib/roku");

const DAY = 86400000;
const now = Date.parse("2026-06-15T00:00:00Z");

test("amazon: RVS url (prod + sandbox) and term parsing", () => {
  assert.equal(amazon.amazonRvsUrl("sec/ret", "u1", "r:1"),
    "https://appstore-sdk.amazon.com/version/1.0/verifyReceiptId/developer/sec%2Fret/user/u1/receiptId/r%3A1");
  assert.match(amazon.amazonRvsUrl("s", "u", "r", true), /^https:\/\/appstore-sdk\.amazon\.com\/sandbox\/version\/1\.0\//);
  assert.equal(amazon.amazonTermToMonths("1 Month"), 1);
  assert.equal(amazon.amazonTermToMonths("1 Year"), 12);
  assert.equal(amazon.amazonTermToMonths("3 Months"), 3);
  assert.ok(Math.abs(amazon.amazonTermToMonths("1 Week") - 7 / 30.4375) < 1e-9);
  assert.equal(amazon.amazonTermToMonths("weird"), 0);
});

test("amazon: active auto-renewing subscription in free trial", () => {
  const p = amazon.amazonReceiptPurchase({
    receiptId: "R1", productType: "SUBSCRIPTION", productId: "premium", termSku: "premium_monthly", term: "1 Month",
    purchaseDate: now - 5 * DAY, renewalDate: now + 2 * DAY, freeTrialEndDate: now + 2 * DAY, autoRenewing: true,
    cancelDate: null, testTransaction: false, countryCode: "US",
  }, { priceMicros: 4990000, currency: "USD" }, now);
  assert.equal(p.store, "amazon");
  assert.equal(p.productId, "premium_monthly");
  assert.equal(p.status, "active");
  assert.equal(p.expiresAt, now + 2 * DAY);
  assert.equal(p.willRenew, true);
  assert.equal(p.isTrial, true);
  assert.equal(p.periodMonths, 1);
  assert.equal(p.country, "US");
  assert.match(p.id, /^amz_[0-9a-f]{40}$/);
});

test("amazon: canceled, grace, 410, consumable refund, sandbox", () => {
  const sub = { receiptId: "R2", productType: "SUBSCRIPTION", termSku: "y", term: "1 Year", purchaseDate: now - 400 * DAY };
  const canceled = amazon.amazonReceiptPurchase({ ...sub, cancelDate: now - DAY, cancelReason: 1, autoRenewing: false }, {}, now);
  assert.equal(canceled.status, "expired");
  assert.equal(canceled.willRenew, false);
  const scheduled = amazon.amazonReceiptPurchase({ ...sub, cancelDate: now + 10 * DAY, autoRenewing: false }, {}, now);
  assert.equal(scheduled.status, "active");
  assert.equal(scheduled.willRenew, false);
  const grace = amazon.amazonReceiptPurchase({ ...sub, gracePeriodEndDate: now + 3 * DAY, autoRenewing: true }, {}, now);
  assert.equal(grace.status, "grace");
  assert.equal(grace.billingIssue, true);
  assert.equal(amazon.amazonReceiptPurchase({ ...sub, renewalDate: now + DAY }, {}, now, true).status, "expired");
  const c = amazon.amazonReceiptPurchase({ receiptId: "C", productType: "CONSUMABLE", productId: "coins", purchaseDate: now, cancelDate: now }, {}, now);
  assert.equal(c.type, "consumable");
  assert.equal(c.status, "refunded");
  const e = amazon.amazonReceiptPurchase({ receiptId: "E", productType: "ENTITLED", productId: "pro", purchaseDate: now, testTransaction: true }, {}, now);
  assert.deepEqual([e.type, e.status, e.isSandbox, e.expiresAt], ["non_consumable", "active", true, null]);
});

test("amazon: SNS url guard, string-to-sign, signature v1/v2, RTN parse", () => {
  assert.equal(amazon.isSnsUrl("https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem", true), true);
  assert.equal(amazon.isSnsUrl("https://evil.com/sns.us-east-1.amazonaws.com.pem", true), false);
  assert.equal(amazon.isSnsUrl("http://sns.us-east-1.amazonaws.com/x.pem", true), false);
  assert.equal(amazon.isSnsUrl("https://sns.us-east-1.amazonaws.com.evil.com/x.pem", true), false);
  const message = JSON.stringify({ receiptId: "R1", appUserId: "AU1", notificationType: "SUBSCRIPTION_RENEWED", appPackageName: "com.x", timestamp: 1, betaProductTransaction: false, relatedReceipts: {} });
  const m = { Type: "Notification", MessageId: "id1", TopicArn: "arn:t", Message: message, Timestamp: "2026-06-15T00:00:00.000Z" };
  assert.equal(amazon.snsStringToSign(m), `Message\n${message}\nMessageId\nid1\nTimestamp\n2026-06-15T00:00:00.000Z\nTopicArn\narn:t\nType\nNotification\n`);
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = publicKey.export({ type: "spki", format: "pem" });
  for (const [v, algo] of [["1", "RSA-SHA1"], ["2", "RSA-SHA256"]]) {
    const signed = { ...m, SignatureVersion: v, Signature: createSign(algo).update(amazon.snsStringToSign(m)).sign(privateKey, "base64") };
    assert.equal(amazon.verifySnsSignature(signed, pem), true);
    assert.equal(amazon.verifySnsSignature({ ...signed, Message: message.replace("R1", "R9") }, pem), false);
  }
  assert.equal(amazon.verifySnsSignature({ ...m, SignatureVersion: "3", Signature: "x" }, pem), false);
  const n = amazon.parseAmazonRtn(m);
  assert.deepEqual([n.receiptId, n.appUserId, n.notificationType, n.appPackageName], ["R1", "AU1", "SUBSCRIPTION_RENEWED", "com.x"]);
});

test("galaxy: date parsing, item receipt, subscription status", () => {
  assert.equal(galaxy.parseSamsungDate("2026-06-01 10:00:00 GMT"), Date.parse("2026-06-01T10:00:00Z"));
  assert.equal(galaxy.parseSamsungDate(null), null);
  const item = galaxy.galaxyItemPurchase("abc123", {
    itemId: "no_ads", itemType: "Item", status: "success", mode: "TEST", purchaseDate: "2026-06-01 10:00:00 GMT",
    paymentAmount: "2.99", currencyCode: "EUR", countryCode: "FRA",
  }, {}, now);
  assert.deepEqual([item.id, item.store, item.type, item.status, item.isSandbox, item.priceMicros, item.currency, item.country],
    ["gs_abc123", "galaxy", "non_consumable", "active", true, 2990000, "EUR", "FR"]);
  assert.equal(galaxy.galaxyItemPurchase("c", { itemId: "coins", consumeYN: "N", status: "cancel" }, {}, now).type, "consumable");
  assert.equal(galaxy.galaxyItemPurchase("c", { itemId: "coins", status: "cancel" }, {}, now).status, "refunded");
  const s = {
    subscriptionPurchaseDate: "2026-05-01 00:00:00 GMT", subscriptionEndDate: "2026-07-01 00:00:00 GMT", subscriptionStatus: "ACTIVE",
    subscriptionFirstPurchaseID: "first1", countryCode: "KOR", price: { localCurrencyCode: "KRW", localPrice: 9900, supplyPrice: 10890 },
    itemID: "monthly", freeTrial: "N", realMode: "Y", latestRenewalDate: "2026-06-01 00:00:00 GMT", currentPaymentPlan: "R", gracePeriodYN: "N",
  };
  const p = galaxy.galaxySubscriptionPurchase("latest9", s, { period: "P1M" }, now);
  assert.deepEqual([p.id, p.productId, p.status, p.willRenew, p.isTrial, p.isSandbox, p.priceMicros, p.currency, p.country, p.periodMonths],
    ["gs_first1", "monthly", "active", true, false, false, 9900000000, "KRW", "KR", 1]);
  assert.equal(p.expiresAt, Date.parse("2026-07-01T00:00:00Z"));
  assert.equal(p.latestPurchaseAt, Date.parse("2026-06-01T00:00:00Z"));
  const cancel = galaxy.galaxySubscriptionPurchase("x", { ...s, subscriptionStatus: "CANCEL" }, {}, now);
  assert.deepEqual([cancel.status, cancel.willRenew], ["active", false]);
  assert.equal(galaxy.galaxySubscriptionPurchase("x", { ...s, subscriptionEndDate: "2026-06-01 00:00:00 GMT", subscriptionStatus: "CANCEL" }, {}, now).status, "expired");
  const g = galaxy.galaxySubscriptionPurchase("x", { ...s, subscriptionEndDate: "2026-06-10 00:00:00 GMT", gracePeriodYN: "Y", gracePeriodEndDate: "2026-06-20 00:00:00 GMT" }, {}, now);
  assert.deepEqual([g.status, g.billingIssue, g.expiresAt], ["grace", true, Date.parse("2026-06-20T00:00:00Z")]);
  assert.equal(galaxy.galaxySubscriptionPurchase("x", { ...s, freeTrial: "Y", realMode: "N" }, {}, now).isTrial, true);
});

test("galaxy: service-account JWT is RS256 with publishing scope and ≤ 20 min", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwt = galaxy.galaxyServiceJwt("sa-1", privateKey.export({ type: "pkcs8", format: "pem" }), 1000);
  const [h, b, sig] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(b, "base64url"));
  assert.deepEqual(claims, { iss: "sa-1", scopes: ["publishing"], iat: 1000, exp: 2140 });
  assert.equal(createVerify("RSA-SHA256").update(`${h}.${b}`).verify(publicKey, Buffer.from(sig, "base64url")), true);
});

test("roku: dates, validate url, subscription states", () => {
  assert.equal(roku.parseRokuDate("/Date(1581033062000+0000)/"), 1581033062000);
  assert.equal(roku.parseRokuDate("2020-02-06T23:51:02"), Date.parse("2020-02-06T23:51:02Z"));
  assert.equal(roku.rokuValidateUrl("KEY", "tx 1"), "https://apipub.roku.com/listen/transaction-service.svc/validate-transaction/KEY/tx%201");
  const ms = d => `/Date(${d}+0000)/`;
  const t = {
    transactionId: "tx2", OriginalTransactionId: "tx1", productId: "roku_monthly", amount: 4.99, currency: "usd",
    purchaseDate: ms(now - 5 * DAY), originalPurchaseDate: ms(now - 65 * DAY), expirationDate: ms(now + 25 * DAY),
    isEntitled: true, cancelled: false, purchaseStatus: "Active", rokuCustomerId: "cust1", status: 0, errorMessage: "",
  };
  const p = roku.rokuTransactionPurchase(t, {}, now);
  assert.deepEqual([p.id, p.store, p.type, p.status, p.willRenew, p.priceMicros, p.currency, p.periodMonths],
    ["roku_tx1", "roku", "subscription", "active", true, 4990000, "USD", 1]);
  assert.equal(p.purchasedAt, now - 65 * DAY);
  assert.equal(p.latestPurchaseAt, now - 5 * DAY);
  assert.equal(roku.rokuTransactionPurchase({ ...t, cancelled: true }, {}, now).willRenew, false);
  assert.equal(roku.rokuTransactionPurchase({ ...t, expirationDate: ms(now - DAY) }, {}, now).status, "billing_retry");
  assert.equal(roku.rokuTransactionPurchase({ ...t, expirationDate: ms(now - DAY), isEntitled: false }, {}, now).status, "expired");
  assert.equal(roku.rokuTransactionPurchase({ ...t, expirationDate: ms(now + 360 * DAY), purchaseDate: ms(now - 5 * DAY) }, {}, now).periodMonths, 12);
  const one = roku.rokuTransactionPurchase({ ...t, expirationDate: null }, {}, now);
  assert.deepEqual([one.type, one.status, one.expiresAt], ["non_consumable", "active", null]);
});

test("roku: push JWT verification (RS256 + JWKS kid)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "ROKU-TEST" };
  const enc = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const msg = { transactionType: "Sale", transactionId: "tx9", responseKey: "rk" };
  const make = (claims, kid = "ROKU-TEST", key = privateKey) => {
    const body = `${enc({ typ: "JWT", alg: "RS256", kid })}.${enc(claims)}`;
    return `${body}.${createSign("RSA-SHA256").update(body).sign(key).toString("base64url")}`;
  };
  const claims = { iss: "Roku", exp: 2000, nbf: 0, "x-Roku-message": Buffer.from(JSON.stringify(msg)).toString("base64url"), "x-Roku-message-type": "roku.rpay.push", "x-Roku-message-key": "k1" };
  const r = roku.verifyRokuPush(make(claims), { keys: [jwk] }, 1000);
  assert.deepEqual(r.message, msg);
  assert.equal(r.key, "k1");
  assert.throws(() => roku.verifyRokuPush(make(claims), { keys: [jwk] }, 3000), /expired/);
  assert.throws(() => roku.verifyRokuPush(make(claims, "OTHER"), { keys: [jwk] }, 1000), /unknown_roku_kid/);
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  assert.throws(() => roku.verifyRokuPush(make(claims, "ROKU-TEST", other), { keys: [jwk] }, 1000), /invalid_roku_signature/);
});
