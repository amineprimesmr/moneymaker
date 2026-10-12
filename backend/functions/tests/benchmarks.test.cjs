const test = require("node:test");
const assert = require("node:assert");
const B = require("../lib/benchmarks");

test("percentile (linear interpolation, R-7)", () => {
  const v = [1, 2, 3, 4, 5];
  assert.equal(B.percentile(v, 50), 3);
  assert.equal(B.percentile(v, 25), 2);
  assert.equal(B.percentile(v, 10), 1.4);
  assert.equal(B.percentile(v, 90), 4.6);
  assert.equal(B.percentile([5, 1, 3, 2, 4], 75), 4, "order-independent");
  assert.equal(B.percentile([7], 90), 7);
  assert.throws(() => B.percentile([], 50), /empty/);
  assert.deepEqual(B.percentileTable([10, 20, 30, 40, 50]), { p10: 14, p25: 20, p50: 30, p75: 40, p90: 46 });
});

test("percentile rank interpolates between published points and is bounded", () => {
  const t = { p10: 10, p25: 20, p50: 30, p75: 40, p90: 50 };
  assert.equal(B.percentileRank(30, t), 50);
  assert.equal(B.percentileRank(35, t), 62.5);
  assert.equal(B.percentileRank(10, t), 10);
  assert.ok(B.percentileRank(-1000, t) === 0);
  assert.ok(B.percentileRank(1000, t) === 100);
  assert.ok(B.percentileRank(55, t) > 90 && B.percentileRank(55, t) < 100);
  const flat = { p10: 0, p25: 0, p50: 0, p75: 1, p90: 2 };
  assert.equal(B.percentileRank(0, flat), 30, "plateau → middle of covered ranks");
});

test("price tiers and eligibility", () => {
  assert.equal(B.priceTier(null), "unknown");
  assert.equal(B.priceTier(2.5), "lt3");
  assert.equal(B.priceTier(9.99), "8to15");
  assert.equal(B.priceTier(40), "gte15");
  assert.equal(B.eligible("demo-focus", 1000, false), false);
  assert.equal(B.eligible("p", 29, false), false);
  assert.equal(B.eligible("p", 30, true), false);
  assert.equal(B.eligible("p", 30, false), true);
});

test("buckets require ≥ 5 projects; fallbacks to category/all", () => {
  const s = (id, category, tier, v) => ({ projectId: id, category, tier, kpis: { monthly_churn: v, arppu: v * 1e6, trial_conversion_rate: null } });
  const samples = [1, 2, 3, 4].map(i => s(`g${i}`, "Games", "3to8", i / 100)).concat([5, 6].map(i => s(`h${i}`, "Health & Fitness", "8to15", i / 100)));
  const out = B.buildBenchmarks(samples);
  const ids = new Set(out.map(b => B.bucketId(b.metric, b.category, b.tier)));
  assert.ok(!ids.has("monthly_churn__games__3to8"), "4 projects → not published");
  assert.ok(ids.has("monthly_churn__all__all"));
  assert.ok(!out.some(b => b.metric === "trial_conversion_rate"), "null KPIs are skipped");
  assert.equal(out.find(b => b.metric === "monthly_churn" && b.category === "all" && b.tier === "all").n, 6);
  assert.ok(out.every(b => b.n >= 5));
  const published = new Map(out.map(b => [B.bucketId(b.metric, b.category, b.tier), b]));
  const r = B.compareToBenchmarks({ monthly_churn: 0.01, arppu: 6e6, refund_rate: 0.1 }, "Games", "3to8", published);
  assert.equal(r.monthly_churn.status, "ok");
  assert.deepEqual(r.monthly_churn.bucket, { category: "all", tier: "all", projects: 6 });
  assert.equal(r.monthly_churn.higherIsBetter, false);
  assert.equal(r.monthly_churn.score, 100 - r.monthly_churn.percentileRank);
  assert.equal(r.refund_rate.status, "insufficient_data");
  assert.deepEqual(B.bucketCandidates("Games", "unknown"), [["Games", "all"], ["all", "all"]]);
  assert.equal(B.slug("Health & Fitness"), "health-fitness");
});
