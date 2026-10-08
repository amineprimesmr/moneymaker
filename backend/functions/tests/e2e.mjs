// Run against emulators: firebase emulators:exec --only functions,firestore,auth,hosting "node backend/functions/tests/e2e.mjs"
import assert from "node:assert";
import Stripe from "stripe";
const BASE = "http://127.0.0.1:5100/v1", AUTH = "http://127.0.0.1:9199";
const j = async (path, { key, method = "GET", body, headers = {}, raw } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json", ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const t = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(`${method} ${path} ${r.status} ${JSON.stringify(t)}`), { status: r.status }); return t;
};
const signUp = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `t${Date.now()}@x.io`, password: "password123", returnSecureToken: true }) }).then(r => r.json());
const idToken = signUp.idToken; assert(idToken, "auth emulator sign-up");

assert.equal((await j("/health")).ok, true);
const created = await j("/projects", { key: idToken, method: "POST", body: { name: "V2", config: { currency: "EUR", entitlements: { premium: ["monthly", "price_monthly"] } } } });
const { projectId: pid, publicKey, secretKey } = created;
assert.match(publicKey, /^mm_pub_/); assert.match(secretKey, /^mm_sk_/);
const { token: pat } = await j("/tokens", { key: idToken, method: "POST", body: { label: "e2e" } });
assert.equal((await j("/projects", { key: pat })).projects.length, 1);

// public key cannot manage projects; secret key of another project cannot read this one
await assert.rejects(j(`/projects/${pid}/metrics`, { key: publicKey }), e => e.status === 403);
await assert.rejects(j("/projects", { key: "mm_sk_nope" }), e => e.status === 401);

// customer lifecycle
let info = await j("/customers/%24anon%3Aabc", { key: publicKey });
assert.equal(info.activeEntitlements.length, 0);
await j(`/projects/${pid}/customers/%24anon%3Aabc/grant`, { key: secretKey, method: "POST", body: { entitlement: "premium", days: 7 } });
info = await j("/customers/%24anon%3Aabc", { key: publicKey });
assert.deepEqual(info.activeEntitlements, ["premium"]);
info = await j("/customers/%24anon%3Aabc/alias", { key: publicKey, method: "POST", body: { newAppUserId: "user_42" } });
assert.equal(info.appUserId, "user_42"); assert.deepEqual(info.activeEntitlements, ["premium"]);
assert.equal((await j("/customers/%24anon%3Aabc", { key: publicKey })).activeEntitlements.length, 0);
await j("/customers/user_42/attributes", { key: publicKey, method: "POST", body: { attributes: { email: "a@b.c" } } });

// stripe webhook with real signature (no API key configured → uses payload object)
await j(`/projects/${pid}/credentials`, { key: secretKey, method: "PUT", body: { stripe: { webhookSecret: "whsec_test123" } } });
const now = Math.floor(Date.now() / 1000);
const sub = { id: "sub_e2e", object: "subscription", status: "active", customer: "cus_1", start_date: now, livemode: true, cancel_at_period_end: false, metadata: { app_user_id: "user_99" },
  items: { data: [{ quantity: 1, current_period_start: now, current_period_end: now + 30 * 86400, price: { id: "price_monthly", unit_amount: 999, currency: "eur", recurring: { interval: "month", interval_count: 1 } } }] } };
const send = async (type, object, id) => {
  const payload = JSON.stringify({ id, object: "event", type, data: { object } });
  const sig = Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_test123" });
  return j(`/webhooks/stripe/${pid}`, { method: "POST", raw: payload, headers: { "Stripe-Signature": sig } });
};
await send("customer.subscription.created", sub, "evt_1");
assert.deepEqual((await j("/customers/user_99", { key: publicKey })).activeEntitlements, ["premium"]);
assert.equal((await send("customer.subscription.created", sub, "evt_1")).duplicate, true);
await assert.rejects(j(`/webhooks/stripe/${pid}`, { method: "POST", body: { id: "x" }, headers: { "Stripe-Signature": "t=1,v1=bad" } }), e => e.status === 400);
await send("customer.subscription.updated", { ...sub, cancel_at_period_end: true }, "evt_2");
await send("customer.subscription.deleted", { ...sub, status: "canceled", ended_at: now }, "evt_3");
assert.equal((await j("/customers/user_99", { key: publicKey })).activeEntitlements.length, 0);

const events = (await j(`/projects/${pid}/events`, { key: secretKey })).events.map(e => e.type).sort();
assert.deepEqual(events, ["CANCELLATION", "EXPIRATION", "GRANT", "INITIAL_PURCHASE"]);
const m = await j(`/projects/${pid}/metrics?days=30`, { key: secretKey });
assert.equal(m.revenueMicros, 9_990_000); assert.equal(m.activeSubscriptions, 0);
await j(`/projects/${pid}`, { key: secretKey, method: "PATCH", body: { config: { offerings: { default: { packages: [{ id: "monthly", productIds: { app_store: "monthly" } }] } }, currentOffering: "default" } } });
assert.equal((await j("/offerings", { key: publicKey })).current, "default");
const ov = await j("/overview", { key: pat });
assert.equal(ov.projects.length, 1);
const detail = await j(`/projects/${pid}`, { key: pat });
assert.match(detail.endpoints.appleNotifications, /webhooks\/apple\//);
assert.equal(JSON.stringify(detail).includes("whsec_test123"), false, "secrets never leak");
// placeholder owner → real user on login (migration path)
await j(`/projects/${pid}/customers/%24apple%3A123/grant`, { key: secretKey, method: "POST", body: { entitlement: "premium" } });
info = await j("/customers/%24apple%3A123/alias", { key: publicKey, method: "POST", body: { newAppUserId: "migrated_user" } });
assert.deepEqual(info.activeEntitlements, ["premium"]);
console.log("E2E OK", { pid, events, revenue: m.revenueMicros });
