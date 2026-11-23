const test = require("node:test");
const assert = require("node:assert");
const A = require("../lib/anomalies");
const plan = require("../lib/plan");
const { isSubscriptionCharge } = require("../lib/stripe");

const P = { id: "p", name: "App" };

test("a sale at 00:30 in Paris belongs to that Paris day, across the DST change", () => {
  // 25 oct. 2026 22:30 UTC = 26 oct. 00:30 à Paris (heure d'hiver depuis le 25).
  const at = Date.parse("2026-10-25T23:30:00Z");
  assert.equal(A.civilDate(A.civilDay(at, "Europe/Paris")), "2026-10-26");
  assert.equal(A.civilDate(A.civilDay(at)), "2026-10-25");
  const day = A.civilDay(Date.parse("2026-10-25T12:00:00Z"), "Europe/Paris");
  // Le 25 octobre dure 25 h à Paris.
  assert.equal(A.civilDayStart(day + 1, "Europe/Paris") - A.civilDayStart(day, "Europe/Paris"), 25 * 3600000);
  assert.equal(new Date(A.civilDayStart(day, "Europe/Paris")).toISOString(), "2026-10-24T22:00:00.000Z");
  // Passage à l'heure d'été (29 mars 2026) : la journée dure 23 h.
  const spring = A.civilDay(Date.parse("2026-03-29T12:00:00Z"), "Europe/Paris");
  assert.equal(new Date(A.civilDayStart(spring, "Europe/Paris")).toISOString(), "2026-03-28T23:00:00.000Z");
  assert.equal(A.civilDayStart(spring + 1, "Europe/Paris") - A.civilDayStart(spring, "Europe/Paris"), 23 * 3600000);
});

test("daily rows follow Paris days", () => {
  const start = A.civilDayStart(A.civilDay(Date.parse("2026-10-20T12:00:00Z"), "Europe/Paris"), "Europe/Paris");
  const txs = [{ at: Date.parse("2026-10-20T22:30:00Z"), amountMicrosProject: 59e6 }]; // 21 oct. 00:30 à Paris
  const rows = A.dailyRows(txs, [], start, 3, "Europe/Paris");
  assert.deepEqual(rows.map(r => r.revenue), [0, 59e6, 0]);
});

test("the average is per day over the real history, not always 28 days", () => {
  const y = { revenue: 0, refunds: 0, billing: 0, countries: [] };
  // 10 jours d'historique à 590 € au total : 59 €/jour, pas 21 €/jour.
  const out = plan.detectInsights(P, y, { revenuePerDay: 59e6, refundsPerDay: 0, billingPerDay: 0, knownCountries: new Set(), days: 10 }, "EUR");
  assert.equal(out[0].type, "SALES_DROP");
  assert.match(out[0].body, /59\s€ par jour en moyenne sur les 10 jours d'avant/);
  // Moins d'une semaine d'historique : pas d'alerte de ventes.
  assert.equal(plan.detectInsights(P, y, { revenuePerDay: 59e6, refundsPerDay: 0, billingPerDay: 0, knownCountries: new Set(), days: 3 }, "EUR").length, 0);
});

test("history before the first sale is not counted as zero days", () => {
  const history = Array.from({ length: 20 }, () => ({ revenue: 100e6, newSubscriptions: 0, trials: 0, refunds: 0, billingIssues: 0, churn: 0 }));
  const zero = { revenue: 0, newSubscriptions: 0, trials: 0, refunds: 0, billingIssues: 0, churn: 0 };
  assert.ok(A.detectAnomalies(P, history, zero, "2026-10-30", "EUR").some(a => a.metric === "revenue" && a.direction === "down"));
  assert.equal(A.detectAnomalies(P, history.slice(0, 10), zero, "2026-10-30", "EUR").length, 0);
});

test("a one-time Checkout with an invoice is a sale, a subscription invoice is not", async () => {
  const stripe = inv => ({
    invoicePayments: { list: async () => ({ data: [{ invoice: "in_1" }] }) },
    invoices: { retrieve: async () => inv },
  });
  const ch = { payment_intent: "pi_1", description: null };
  assert.equal(await isSubscriptionCharge(stripe({ id: "in_1", parent: { type: "subscription_details", subscription_details: null } }), ch), false);
  assert.equal(await isSubscriptionCharge(stripe({ id: "in_1", parent: { subscription_details: { subscription: "sub_1" } } }), ch), true);
  assert.equal(await isSubscriptionCharge(stripe({ id: "in_1", subscription: "sub_2" }), ch), true);
  const none = { invoicePayments: { list: async () => ({ data: [] }) } };
  assert.equal(await isSubscriptionCharge(none, ch), false);
});

test("a sale caught up late says when it happened, not « Aujourd'hui »", () => {
  const { eventNotification, DEFAULT_PREFS } = require("../lib/push");
  const project = { id: "p", name: "Process" };
  const purchasedAt = Date.parse("2026-10-29T13:05:18Z");
  const late = { type: "NON_RENEWING_PURCHASE", priceMicros: 30e6, currency: "EUR", country: "CA", at: Date.parse("2026-10-31T11:19:16Z"), purchasedAt };
  const n = eventNotification(project, late, DEFAULT_PREFS, 0, "EUR", "fr");
  assert.match(n.aps.alert.body, /Vente du 29 oct\. rattrapée/);
  assert.equal(n.aps.sound, undefined);
  assert.equal(n.aps["interruption-level"], "passive");
  const live = eventNotification(project, { ...late, at: purchasedAt + 5000 }, DEFAULT_PREFS, 30e6, "EUR", "fr");
  assert.equal(live.aps.alert.subtitle, "Process");
  assert.doesNotMatch(live.aps.alert.body, /rattrapée/);
});
