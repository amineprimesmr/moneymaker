const test = require("node:test");
const assert = require("node:assert");
const A = require("../lib/anomalies");

const P = { id: "p1", name: "MonApp" }, DAY = 86400000;
const row = (o = {}) => ({ revenue: 100e6, newSubscriptions: 10, trials: 20, refunds: 1, billingIssues: 1, churn: 5, ...o });
const history = Array.from({ length: 28 }, (_, i) => row({ revenue: 100e6 + (i % 5) * 4e6, newSubscriptions: 9 + (i % 3) }));

test("normal day: nothing", () => {
  assert.deepEqual(A.detectAnomalies(P, history, row(), "2026-10-01", "EUR"), []);
});

test("revenue crash and refund spike are flagged with direction and severity", () => {
  const out = A.detectAnomalies(P, history, row({ revenue: 10e6, refunds: 12 }), "2026-10-01", "EUR");
  const rev = out.find(a => a.metric === "revenue"), ref = out.find(a => a.metric === "refunds");
  assert.equal(rev.direction, "down");
  assert.equal(rev.good, false);
  assert.equal(rev.type, "ANOMALY_REVENUE_DOWN");
  assert.ok(rev.zScore <= -3);
  assert.equal(ref.direction, "up");
  assert.equal(ref.good, false);
  assert.equal(ref.severity, "critical");
  assert.match(rev.title, /Revenu/);
});

test("small volumes and short history are ignored; flat series do not explode", () => {
  const tiny = Array.from({ length: 28 }, () => row({ refunds: 0 }));
  assert.equal(A.detectAnomalies(P, tiny, row({ refunds: 2 }), "d", "EUR").length, 0);
  assert.equal(A.detectAnomalies(P, history.slice(0, 10), row({ revenue: 0 }), "d", "EUR").length, 0);
  const flat = Array.from({ length: 28 }, () => row());
  assert.equal(A.detectAnomalies(P, flat, row({ newSubscriptions: 12 }), "d", "EUR").length, 0, "Poisson floor");
  assert.equal(A.detectAnomalies(P, flat, row({ newSubscriptions: 25 }), "d", "EUR")[0].good, true);
});

test("dailyRows + weekly summary", () => {
  const now = Date.UTC(2026, 9, 12, 8); // lundi
  const end = Date.UTC(2026, 9, 12), start = end - 7 * DAY;
  const txs = [
    { at: start + 1000, amountMicrosProject: 30e6, country: "FR" }, { at: start + 2 * DAY, amountMicrosProject: 20e6, country: "US" },
    { at: start + 3 * DAY, amountMicrosProject: 15e6, country: "US" }, { at: start - 2 * DAY, amountMicrosProject: 50e6, country: "FR" },
    { at: start + DAY, amountMicrosProject: 999e6, isSandbox: true }, { at: start + DAY, amountMicrosProject: -5e6 },
  ];
  const events = [{ at: start + 10, type: "INITIAL_PURCHASE" }, { at: start + 20, type: "INITIAL_PURCHASE", isTrial: true }, { at: start + 30, type: "TRIAL_CONVERTED" }, { at: start + 40, type: "REFUND" }];
  const rows = A.dailyRows(txs, events, start, 7);
  assert.equal(rows[0].revenue, 30e6);
  assert.equal(rows[0].newSubscriptions, 2);
  assert.equal(rows[0].refunds, 1);
  const w = A.weeklySummary(P, txs, events, 400e6, "EUR", now);
  assert.equal(w.revenueMicros, 65e6);
  assert.equal(w.previousRevenueMicros, 50e6);
  assert.equal(w.revenueChange, 0.3);
  assert.equal(w.topCountry, "US");
  assert.equal(w.newSubscriptions, 2);
  assert.equal(w.weekStart, "2026-10-05");
  assert.match(w.body, /\+30 %/);
});
