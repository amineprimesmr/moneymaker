const test = require("node:test");
const assert = require("node:assert");
const L = require("../lib/ltv");

const M = L.MONTH, NOW = Date.UTC(2026, 9, 1);

test("lifetime: churned vs active (censored), refunds reduce revenue", () => {
  const first = NOW - 10 * M;
  const pays = [0, 1, 2].map(i => ({ customerId: "a", group: "g", at: first + i * M, amountMicros: 10e6, periodMonths: 1 }));
  const l = L.lifetimeOf(pays, NOW);
  assert.equal(l.churned, true);
  assert.equal(l.duration, 3);
  assert.equal(l.paidMonths, 3);
  const active = L.lifetimeOf([{ customerId: "b", group: "g", at: NOW - 2.5 * M, amountMicros: 10e6, periodMonths: 1 }, { customerId: "b", group: "g", at: NOW - 0.5 * M, amountMicros: 10e6, periodMonths: 1 }], NOW);
  assert.equal(active.churned, false);
  assert.equal(active.duration, 2);
  const refunded = L.lifetimeOf([pays[0], { ...pays[0], amountMicros: -10e6 }], NOW);
  assert.equal(refunded.revenueMicros, 0);
  assert.equal(L.lifetimeOf([{ customerId: "c", group: "g", at: NOW, amountMicros: -1, periodMonths: 1 }], NOW), null);
});

test("risk table and Kaplan-Meier curve", () => {
  const lives = [{ duration: 1, churned: true }, { duration: 2, churned: true }, { duration: 3, churned: false }, { duration: 3, churned: false }];
  const { atRisk, churns } = L.riskTable(lives);
  assert.deepEqual(atRisk, [0, 4, 3, 2]);
  assert.deepEqual(churns, [0, 1, 1, 0]);
  const s = L.observedCurve(atRisk, churns);
  assert.equal(s[0], 1);
  assert.equal(s[1], 0.75);
  assert.equal(s[2], 0.5);
  assert.equal(s[3], 0.5);
});

// Simulates a heterogeneous population (sBG truth α=2, β=6 → h1 = 0.25, decreasing hazard).
function simulate(alpha, beta, n, months) {
  const atRisk = new Array(months + 1).fill(0), churns = new Array(months + 1).fill(0);
  let alive = n;
  for (let t = 1; t <= months; t++) {
    atRisk[t] = alive;
    const d = Math.round(alive * alpha / (alpha + beta + t - 1));
    churns[t] = d; alive -= d;
  }
  return { atRisk, churns };
}

test("sBG fit recovers a decreasing hazard and beats geometric", () => {
  const { atRisk, churns } = simulate(2, 6, 10000, 12);
  const fit = L.fitSbg(atRisk, churns);
  const h1 = fit.alpha / (fit.alpha + fit.beta), h10 = fit.alpha / (fit.alpha + fit.beta + 9);
  assert.ok(Math.abs(h1 - 0.25) < 0.01, `h1=${h1}`);
  assert.ok(h10 < h1 / 2, "hazard decreases");
  const p = L.chooseModel(atRisk, churns);
  assert.equal(p.model, "sbg");
  assert.ok(p.logLikelihood > L.fitGeometric(atRisk, churns).logLikelihood);
});

test("geometric fallback with little data", () => {
  const p = L.chooseModel([0, 5, 4], [0, 1, 0]);
  assert.equal(p.model, "geometric");
  assert.ok(p.monthlyChurn > 0 && p.monthlyChurn < 1);
  const curve = L.predictedCurve(p, 12);
  assert.equal(curve.length, 12);
  assert.ok(curve.every((v, i) => i === 0 || v <= curve[i - 1]));
});

test("predictLtv: groups, ltv24 ≥ ltv12, ARPU net of refunds, confidence", () => {
  const pays = [];
  // product A: 60 monthly customers at 10 €, half churn after 2 months, others still active.
  for (let i = 0; i < 60; i++) {
    const first = NOW - 8 * M;
    const n = i % 2 ? 2 : 8;
    for (let k = 0; k < n; k++) pays.push({ customerId: `a${i}`, group: "A", at: first + k * M + 1000, amountMicros: 10e6, periodMonths: 1 });
  }
  // product B: 3 customers, one refunded.
  pays.push({ customerId: "b1", group: "B", at: NOW - M / 2, amountMicros: 50e6, periodMonths: 12 });
  pays.push({ customerId: "b2", group: "B", at: NOW - M / 2, amountMicros: 50e6, periodMonths: 12 });
  pays.push({ customerId: "b2", group: "B", at: NOW - M / 3, amountMicros: -50e6, periodMonths: 12 });
  const out = L.predictLtv(pays, NOW);
  assert.deepEqual(out.map(g => g.key), ["A", "B"]);
  const a = out[0];
  assert.equal(a.customers, 60);
  assert.equal(a.arpuMonthMicros, 10e6);
  assert.ok(a.ltv12 > 10e6 && a.ltv12 <= 120e6);
  assert.ok(a.ltv24 >= a.ltv12);
  assert.ok(a.observedMonths >= 7);
  assert.equal(a.confidence, "medium");
  assert.equal(a.retentionCurve[0], 1);
  assert.ok(Math.abs(a.retentionCurve[3] - 0.5) < 1e-9);
  const b = out[1];
  assert.equal(b.confidence, "low");
  assert.ok(Math.abs(b.arpuMonthMicros - 50e6 / 24) < 1, "refund halves revenue over 24 paid months");
});
