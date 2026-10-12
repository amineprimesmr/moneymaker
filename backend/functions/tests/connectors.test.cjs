const test = require("node:test");
const assert = require("node:assert");
const C = require("../lib/connectors");
const { sanitizeIntegrations, sanitizeConnector } = require("../lib/integrations");
const X = require("../lib/exports");

const sale = { id: "ev1", type: "INITIAL_PURCHASE", appUserId: "u1", productId: "monthly", priceMicros: 9_990_000, currency: "EUR", store: "app_store", country: "FR", isTrial: false, isSandbox: false, at: 1_800_000_000_000 };
const trial = { ...sale, id: "ev2", type: "TRIAL_STARTED", isTrial: true, priceMicros: 0 };
const ios = { $idfa: "IDFA-1", $idfv: "IDFV-1", $fbAnonId: "XZ1", $attConsentStatus: "authorized", $ip: "1.2.3.4", $adjustId: "adj1", $firebaseAppInstanceId: "fai1", $email: "A@B.co", $osVersion: "18.0" };
const app = { bundleId: "com.x.app", packageName: "com.x.app" };

test("meta: Subscribe with ATE, hashed ids, extinfo; trial → StartTrial; no ids → null", () => {
  const r = C.buildMeta({ datasetId: "123", accessToken: "tok" }, sale, ios, app);
  assert.match(r.url, /graph\.facebook\.com\/v\d+\.0\/123\/events$/);
  const d = r.body.data[0];
  assert.equal(d.event_name, "Subscribe"); assert.equal(d.action_source, "app");
  assert.equal(d.app_data.advertiser_tracking_enabled, 1); assert.equal(d.app_data.extinfo.length, 16); assert.equal(d.app_data.extinfo[0], "i2");
  assert.equal(d.user_data.madid, "IDFA-1"); assert.equal(d.user_data.external_id[0].length, 64);
  assert.equal(d.custom_data.value, 9.99);
  assert.equal(C.buildMeta({ datasetId: "1", accessToken: "t" }, trial, ios, app).body.data[0].event_name, "StartTrial");
  const noAtt = C.buildMeta({ datasetId: "1", accessToken: "t" }, sale, { ...ios, $attConsentStatus: "denied" }, app).body.data[0];
  assert.equal(noAtt.app_data.advertiser_tracking_enabled, 0); assert.equal(noAtt.user_data.madid, undefined);
  assert.equal(C.buildMeta({ datasetId: "1", accessToken: "t" }, sale, {}, app), null);
  assert.equal(C.buildMeta({ datasetId: "1", accessToken: "t" }, { ...sale, type: "CANCELLATION" }, ios, app), null);
});

test("adjust: mapped token only, revenue, env, ids", () => {
  const cfg = { appToken: "app123", s2sToken: "s2stoken", eventTokens: { INITIAL_PURCHASE: "abc123" } };
  const r = C.buildAdjust(cfg, sale, ios);
  assert.equal(r.url, "https://s2s.adjust.com/event"); assert.equal(r.headers.Authorization, "Bearer s2stoken");
  assert.equal(r.form.event_token, "abc123"); assert.equal(r.form.revenue, "9.99"); assert.equal(r.form.environment, "production"); assert.equal(r.form.idfa, "IDFA-1");
  assert.equal(C.buildAdjust(cfg, trial, ios), null);
  assert.equal(C.buildAdjust(cfg, sale, {}), null);
});

test("branch: standard vs custom events", () => {
  const r = C.buildBranch({ branchKey: "key_live_x" }, sale, ios);
  assert.match(r.url, /\/v2\/event\/standard$/); assert.equal(r.body.name, "SUBSCRIBE"); assert.equal(r.body.user_data.os, "iOS"); assert.equal(r.body.event_data.revenue, 9.99);
  const c = C.buildBranch({ branchKey: "key_live_x" }, { ...sale, type: "CANCELLATION" }, ios);
  assert.match(c.url, /\/custom$/); assert.equal(c.body.name, "mm_cancellation");
  assert.equal(C.buildBranch({ branchKey: "k" }, trial, ios).body.name, "START_TRIAL");
});

test("singular, kochava, tenjin", () => {
  const s = C.buildSingular({ sdkKey: "sdk" }, sale, ios, app);
  assert.equal(s.method, "GET"); assert.match(s.url, /is_revenue_event=true/); assert.match(s.url, /amt=9.99/); assert.match(s.url, /p=iOS/);
  assert.equal(C.buildSingular({ sdkKey: "sdk" }, sale, { $idfa: "x" }, app), null); // ip required
  assert.equal(C.buildKochava({ appGuid: "ko" }, sale, ios), null);
  assert.equal(C.buildKochava({ appGuid: "ko" }, sale, { ...ios, $kochavaDeviceId: "KD" }).body.data.event_data.sum, 9.99);
  assert.equal(C.buildTenjin({ apiKey: "k" }, sale, ios, app).form.price, "9.99");
  assert.equal(C.buildTenjin({ apiKey: "k" }, trial, ios, app), null);
});

test("braze, onesignal, iterable, customer.io, clevertap, airship, intercom", () => {
  const b = C.buildBraze({ restEndpoint: "https://rest.fra-01.braze.eu", apiKey: "k" }, sale, ios);
  assert.equal(b.url, "https://rest.fra-01.braze.eu/users/track"); assert.equal(b.body.purchases[0].price, 9.99); assert.equal(b.body.events[0].name, "mm_initial_purchase");
  assert.equal(C.buildBraze({ restEndpoint: "https://x.braze.com", apiKey: "k" }, trial, ios).body.purchases, undefined);
  const o = C.buildOneSignal({ appId: "app", restApiKey: "k" }, sale, {});
  assert.equal(o.method, "PATCH"); assert.match(o.url, /users\/by\/external_id\/u1$/); assert.equal(o.body.properties.tags.mm_is_subscriber, "true");
  assert.match(C.buildOneSignal({ appId: "app", restApiKey: "k" }, sale, { $onesignalId: "os1" }).url, /by\/onesignal_id\/os1$/);
  assert.match(C.buildIterable({ apiKey: "k" }, sale, ios).url, /commerce\/trackPurchase$/);
  assert.match(C.buildIterable({ apiKey: "k", region: "eu" }, trial, ios).url, /api\.eu\.iterable\.com\/api\/events\/track$/);
  const cio = C.buildCustomerIo({ siteId: "s", apiKey: "k", region: "eu" }, sale, {});
  assert.equal(cio.url, "https://track-eu.customer.io/api/v1/customers/u1/events"); assert.match(cio.headers.Authorization, /^Basic /);
  assert.equal(C.buildCleverTap({ accountId: "a", passcode: "p" }, sale, {}).body.d[0].evtName, "Charged");
  assert.equal(C.buildAirship({ token: "t" }, sale, {}).body[0].user.named_user_id, "u1");
  assert.equal(C.buildIntercomEvent({ accessToken: "t" }, sale, {}).body.user_id, "u1");
});

test("ga4, mparticle, statsig, telemetrydeck", () => {
  const g = C.buildGa4({ firebaseAppId: "1:2:ios:3", apiSecret: "sec" }, sale, ios);
  assert.match(g.url, /mp\/collect\?firebase_app_id=1%3A2%3Aios%3A3&api_secret=sec/); assert.equal(g.body.app_instance_id, "fai1"); assert.equal(g.body.events[0].name, "purchase");
  assert.equal(C.buildGa4({ firebaseAppId: "x", apiSecret: "s" }, sale, {}), null);
  assert.equal(C.buildMParticle({ apiKey: "k", apiSecret: "s", pod: "eu1" }, sale, {}).url, "https://s2s.eu1.mparticle.com/v2/events");
  assert.equal(C.buildStatsig({ serverSecret: "secret-x" }, sale).body.events[0].user.userID, "u1");
  assert.equal(C.buildTelemetryDeck({ appId: "A" }, sale).body[0].clientUser.length, 64);
});

test("apple ads parse", () => {
  assert.deepEqual(C.parseAppleAds({ attribution: false }), { attribution: false });
  const p = C.parseAppleAds({ attribution: true, orgId: 1, campaignId: 2, adGroupId: 3, keywordId: 4, conversionType: "Download", junk: 1 });
  assert.equal(p.campaignId, 2); assert.equal(p.junk, undefined);
});

test("sanitize connectors: required fields, merge blanks, sandbox, removal", () => {
  assert.throws(() => sanitizeConnector("meta", { datasetId: "1" }), /missing_meta_accessToken/);
  assert.throws(() => sanitizeConnector("braze", { restEndpoint: "https://evil.com", apiKey: "12345678" }), /invalid_braze_restEndpoint/);
  assert.throws(() => sanitizeConnector("adjust", { appToken: "a", s2sToken: "12345678", eventTokens: { INITIAL_PURCHASE: "!!" } }), /invalid_adjust/);
  const s = sanitizeIntegrations({ meta: { datasetId: "123", accessToken: "EAAB12345678", sandbox: true } });
  assert.equal(s.meta.sandbox, true);
  const s2 = sanitizeIntegrations({ meta: { datasetId: "456", accessToken: "" } }, s);
  assert.equal(s2.meta.accessToken, "EAAB12345678"); assert.equal(s2.meta.datasetId, "456");
  assert.equal(sanitizeIntegrations({ meta: null }, s2).meta, undefined);
});

test("exports: config, secrets, csv/jsonl, sigv4", () => {
  const [e] = X.sanitizeExports([{ id: "daily-s3", destination: "s3", schedule: "daily", datasets: ["events", "bogus"], format: "csv", s3: { bucket: "my-bucket", region: "eu-west-3", prefix: "mm" } }]);
  assert.deepEqual(e.datasets, ["events"]); assert.equal(e.s3.prefix, "mm/");
  assert.throws(() => X.sanitizeExports([{ id: "x", destination: "ftp" }]), /destination/);
  assert.throws(() => X.sanitizeExports([{ id: "x", destination: "webhook", webhook: { url: "http://a.b" } }]), /webhook/);
  assert.equal(X.objectKey(e, "p1", "events", Date.UTC(2026, 9, 12)), "mm/p1/events/2026-10-12.csv");
  assert.equal(X.isDue({ schedule: "weekly" }, Date.UTC(2026, 9, 12)), true); // Monday
  assert.equal(X.isDue({ schedule: "weekly" }, Date.UTC(2026, 9, 13)), false);
  assert.throws(() => X.sanitizeExportSecrets({ a: { s3: { accessKeyId: "x", secretAccessKey: "y" } } }), /s3_keys/);
  assert.equal(X.toCsv([{ a: 1, b: 'x,"y"' }, { a: 2, c: { z: 1 } }]), 'a,b,c\n1,"x,""y""",\n2,,"{""z"":1}"\n');
  assert.equal(X.toJsonl([{ a: 1 }, { b: 2 }]), '{"a":1}\n{"b":2}\n');
  // AWS SigV4 reference: signing key derivation from the AWS docs example (secret wJalr..., 20120215, us-east-1, iam).
  const r = X.signS3Put({ bucket: "examplebucket", region: "us-east-1", key: "test$file.text", body: "Welcome to Amazon S3.", contentType: "text/plain",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", now: Date.UTC(2013, 4, 24) });
  assert.equal(r.url, "https://examplebucket.s3.us-east-1.amazonaws.com/test%24file.text");
  assert.equal(r.headers["x-amz-content-sha256"], "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
  assert.match(r.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
});
