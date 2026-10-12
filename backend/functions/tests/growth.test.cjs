const test = require("node:test");
const assert = require("node:assert");
const g = require("../lib/growth");

const offerings = { default: { packages: [] }, promo: { packages: [] }, fr: { packages: [] }, b: { packages: [] } };
const ids = new Set(Object.keys(offerings));
const code = c => e => e.code === c;

test("version comparison", () => {
  assert.equal(g.compareVersions("1.10", "1.9"), 1);
  assert.equal(g.compareVersions("2.0", "2.0.0"), 0);
  assert.equal(g.compareVersions("1.2.3", "1.3"), -1);
});

test("rule matching", () => {
  const c = { countries: ["FR", "BE"], platforms: ["ios"], appVersionMin: "2.0", appVersionMax: "3.0", attributes: { plan: "pro" }, newCustomersOnly: true };
  const ok = { country: "fr", platform: "ios", appVersion: "2.5.1", attributes: { plan: "pro" }, isNewCustomer: true };
  assert.equal(g.matchConditions(c, ok), true);
  assert.equal(g.matchConditions(c, { ...ok, country: "US" }), false);
  assert.equal(g.matchConditions(c, { ...ok, platform: "android" }), false);
  assert.equal(g.matchConditions(c, { ...ok, appVersion: "1.9" }), false);
  assert.equal(g.matchConditions(c, { ...ok, appVersion: "3.0.1" }), false);
  assert.equal(g.matchConditions(c, { ...ok, attributes: {} }), false);
  assert.equal(g.matchConditions(c, { ...ok, isNewCustomer: false }), false);
  assert.equal(g.matchConditions(c, { ...ok, country: undefined }), false, "missing context never matches");
  assert.equal(g.matchConditions({}, {}), true);
});

test("targeting: first match wins, placements fall back", () => {
  const targeting = g.sanitizeTargeting({
    rules: [{ id: "r1", conditions: { countries: ["fr"] }, offeringId: "fr" }, { id: "r2", conditions: { platforms: ["ios"] }, offeringId: "promo" }],
    placements: { onboarding: { offeringId: "promo" }, settings: { rules: [{ id: "p1", conditions: { platforms: ["android"] }, offeringId: "b" }] }, empty: {} },
  }, ids);
  const cfg = { offerings, currentOffering: "default", targeting };
  let r = g.resolveOfferings(cfg, { country: "FR", platform: "ios" });
  assert.equal(r.current, "fr");
  assert.deepEqual(r.placements, { onboarding: "promo", settings: "fr", empty: "fr" });
  r = g.resolveOfferings(cfg, { country: "US", platform: "android" });
  assert.equal(r.current, "default");
  assert.equal(r.placements.settings, "b");
  assert.throws(() => g.sanitizeTargeting({ rules: [{ offeringId: "nope" }] }, ids), code("unknown_offering"));
});

test("assignment is deterministic and respects weights", () => {
  const exp = { id: "exp1", variants: [{ id: "a", offeringId: "default", weight: 1 }, { id: "b", offeringId: "b", weight: 3 }] };
  assert.equal(g.assignVariant("user-42", exp).id, g.assignVariant("user-42", exp).id);
  const n = 20000, counts = { a: 0, b: 0 };
  for (let i = 0; i < n; i++) counts[g.assignVariant(`u${i}`, exp).id]++;
  assert.ok(Math.abs(counts.b / n - 0.75) < 0.02, `b share ${counts.b / n}`);
  const zero = { id: "e", variants: [{ id: "a", offeringId: "default", weight: 0 }, { id: "b", offeringId: "b", weight: 1 }] };
  for (let i = 0; i < 200; i++) assert.equal(g.assignVariant(`u${i}`, zero).id, "b");
  // Independent across experiments
  const other = { ...exp, id: "exp2" };
  let same = 0;
  for (let i = 0; i < 2000; i++) same += g.assignVariant(`u${i}`, exp).id === g.assignVariant(`u${i}`, other).id ? 1 : 0;
  assert.ok(same < 1900);
});

test("experiments override targeting for enrolled users", () => {
  const experiments = g.sanitizeExperiments([{ id: "x", name: "Prix", status: "running", variants: [{ id: "ctrl", offeringId: "default", weight: 1 }, { id: "test", offeringId: "b", weight: 1 }] }], ids, [], 1000);
  assert.equal(experiments[0].startedAt, 1000);
  const targeting = { rules: [{ id: "r", conditions: {}, offeringId: "promo" }], placements: {} };
  const r = g.resolveOfferings({ offerings, targeting, experiments }, { appUserId: "u1" });
  assert.ok(["default", "b"].includes(r.current));
  assert.equal(r.experiments.length, 1);
  assert.equal(g.resolveOfferings({ offerings, targeting, experiments }, {}).current, "promo", "no appUserId → no experiment");
});

test("experiment validation", () => {
  const base = { id: "x", status: "running", variants: [{ id: "a", offeringId: "default" }, { id: "b", offeringId: "b" }] };
  const prev = g.sanitizeExperiments([base], ids, [], 5);
  assert.throws(() => g.sanitizeExperiments([{ ...base, variants: [{ id: "a", offeringId: "default" }, { id: "b", offeringId: "promo" }] }], ids, prev), code("experiment_locked"));
  assert.throws(() => g.sanitizeExperiments([base, { ...base, id: "y" }], ids), code("experiment_conflict"));
  const stopped = g.sanitizeExperiments([{ ...base, status: "stopped" }], ids, prev, 99);
  assert.equal(stopped[0].startedAt, 5);
  assert.equal(stopped[0].stoppedAt, 99);
  assert.throws(() => g.sanitizeExperiments([{ ...base, status: "running" }], ids, stopped), code("experiment_stopped"));
  assert.throws(() => g.sanitizeExperiments([{ ...base, variants: [base.variants[0]] }], ids), code("invalid_variants"));
});

test("paywall validation", () => {
  const p = g.sanitizePaywall({ template: "cards", title: "Pro", features: [{ icon: "star.fill", text: "Illimité" }], colors: { accent: "#00d084" }, localizations: { en: { title: "Pro" } }, closeDelay: 3 });
  assert.equal(p.template, "cards");
  assert.equal(p.showCloseButton, true);
  assert.throws(() => g.sanitizePaywall({ template: "fancy" }), code("invalid_paywall_template"));
  assert.throws(() => g.sanitizePaywall({ colors: { accent: "red" } }), code("invalid_paywall_color"));
  assert.throws(() => g.sanitizePaywall({ heroImage: "http://x" }), code("invalid_paywall_hero_image"));
  assert.throws(() => g.sanitizeOfferings({ x: { packages: [], paywall: { closeDelay: 99 } } }), code("invalid_paywall_close_delay"));
});

test("results attribution and stats", () => {
  const variants = [{ id: "a", offeringId: "default", weight: 1 }, { id: "b", offeringId: "b", weight: 1 }];
  const enrollments = [{ appUserId: "u1", variant: "a", at: 100 }, { appUserId: "u2", variant: "a", at: 100 }, { appUserId: "u3", variant: "b", at: 100 }, { appUserId: "u4", variant: "b", at: 100 }];
  const tx = [
    { appUserId: "u1", at: 50, kind: "purchase", amountMicrosProject: 9e6 }, // before enrollment
    { appUserId: "u3", at: 150, kind: "purchase", amountMicrosProject: 10e6 },
    { appUserId: "u3", at: 250, kind: "renewal", amountMicrosProject: 10e6 },
    { appUserId: "u4", at: 150, kind: "purchase", amountMicrosProject: 10e6, isSandbox: true },
    { appUserId: "zz", at: 150, kind: "purchase", amountMicrosProject: 10e6 },
  ];
  const [a, b] = g.aggregateResults(variants, enrollments, tx, { a: 10, b: 8 });
  assert.deepEqual([a.enrolled, a.conversions, a.revenueMicros, a.impressions], [2, 0, 0, 10]);
  assert.deepEqual([b.enrolled, b.conversions, b.revenueMicros], [2, 1, 20e6]);
  assert.equal(b.conversionRate, 0.5);
  assert.equal(b.arpuMicros, 10e6);
  assert.ok(b.probabilityToBeBest > a.probabilityToBeBest);
});

test("probability to be best", () => {
  const eq = g.probabilityToBeBest([{ enrolled: 1000, conversions: 50 }, { enrolled: 1000, conversions: 50 }]);
  assert.ok(Math.abs(eq[0] - 0.5) < 0.01);
  const clear = g.probabilityToBeBest([{ enrolled: 5000, conversions: 250 }, { enrolled: 5000, conversions: 350 }]);
  assert.ok(clear[1] > 0.99);
  const three = g.probabilityToBeBest([{ enrolled: 100, conversions: 5 }, { enrolled: 100, conversions: 6 }, { enrolled: 100, conversions: 7 }]);
  assert.ok(Math.abs(three.reduce((s, x) => s + x, 0) - 1) < 1e-9);
  assert.ok(three[2] > three[1] && three[1] > three[0]);
});
