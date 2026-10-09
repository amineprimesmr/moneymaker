const test = require("node:test");
const assert = require("node:assert");
const { sanitizeDevice, wants, eventNotification, foldToday, startOfDay, DEFAULT_PREFS, liveActivityState, rankingNotification } = require("../lib/push");

const project = { id: "p1", name: "MonApp", members: ["u1"], config: {} };
const sale = { type: "INITIAL_PURCHASE", priceMicros: 9_990_000, currency: "EUR", productId: "monthly", periodMonths: 1, country: "FR", isSandbox: false, isTrial: false };

test("device: validates tokens, merges prefs, keeps previous tokens", () => {
  const d = sanitizeDevice("abcdef12-3456", { apnsToken: "AB".repeat(32), env: "sandbox", tz: "Europe/Paris", prefs: { churn: true, bogus: 1 } });
  assert.equal(d.apnsToken, "ab".repeat(32));
  assert.equal(d.env, "sandbox");
  assert.equal(d.prefs.churn, true);
  assert.equal(d.prefs.sales, true);
  assert.equal(d.prefs.bogus, undefined);
  const d2 = sanitizeDevice("abcdef12-3456", { prefs: { sales: false } }, d);
  assert.equal(d2.apnsToken, d.apnsToken);
  assert.equal(d2.prefs.sales, false);
  assert.equal(d2.prefs.churn, true);
  assert.equal(sanitizeDevice("abcdef12-3456", { tz: "Mars/Olympus" }).tz, "UTC");
  assert.throws(() => sanitizeDevice("x", {}), /invalid_device_id/);
  assert.throws(() => sanitizeDevice("abcdef12-3456", { apnsToken: "not hex!" }), /invalid_token/);
  assert.equal(sanitizeDevice("abcdef12-3456", { apnsToken: null }, d).apnsToken, undefined);
});

test("wants: prefs, sandbox, muted projects", () => {
  assert.equal(wants(DEFAULT_PREFS, "p1", sale), true);
  assert.equal(wants({ ...DEFAULT_PREFS, sales: false }, "p1", sale), false);
  assert.equal(wants(DEFAULT_PREFS, "p1", { ...sale, isSandbox: true }), false);
  assert.equal(wants({ ...DEFAULT_PREFS, sandbox: true }, "p1", { ...sale, isSandbox: true }), true);
  assert.equal(wants({ ...DEFAULT_PREFS, mutedProjects: ["p1"] }, "p1", sale), false);
  assert.equal(wants(DEFAULT_PREFS, "p1", { type: "CANCELLATION" }), false); // churn off by default
  assert.equal(wants(DEFAULT_PREFS, "p1", { type: "TEST", isSandbox: true }), true);
});

test("notification: sale is loud, time-sensitive, grouped, with today subtitle", () => {
  const n = eventNotification(project, sale, DEFAULT_PREFS, 120_000_000, "EUR");
  assert.match(n.aps.alert.title, /^\+9,99\s€ · MonApp$/);
  assert.match(n.aps.alert.subtitle, /Aujourd'hui : 120,00\s€/);
  assert.match(n.aps.alert.body, /Nouvel abonné · mensuel · monthly · 🇫🇷 FR/);
  assert.equal(n.aps.sound, "cash.caf");
  assert.equal(n.aps["interruption-level"], "time-sensitive");
  assert.equal(n.aps["thread-id"], "project-p1");
  assert.equal(eventNotification(project, sale, { ...DEFAULT_PREFS, sound: false }).aps.sound, undefined);
  const trial = eventNotification(project, { ...sale, type: "TRIAL_STARTED", isTrial: true }, DEFAULT_PREFS);
  assert.equal(trial.aps.alert.title, "Essai démarré · MonApp");
  assert.equal(trial.aps.sound, undefined);
  assert.equal(rankingNotification(project, { type: "TOP_1", rank: 1, cc: "FR", chart: "free", appName: "X" }).aps.alert.body, "#1 🇫🇷 FR · Gratuites");
});

test("today: local day start, hourly cumulative, refunds, sandbox ignored", () => {
  const tz = "Europe/Paris", now = Date.UTC(2026, 9, 9, 13, 30); // 15:30 Paris
  const start = startOfDay(tz, now);
  assert.equal(start, Date.UTC(2026, 9, 8, 22, 0));
  const H = 3600000;
  const t = foldToday([{ projectName: "A", tx: [
    { amountMicros: 10e6, currency: "EUR", at: start + 1 * H, kind: "purchase", productId: "m" },
    { amountMicros: 5e6, currency: "EUR", at: start + 3 * H, kind: "renewal" },
    { amountMicros: -10e6, currency: "EUR", at: start + 4 * H, kind: "refund" },
    { amountMicros: 99e6, currency: "EUR", at: start + 2 * H, kind: "purchase", isSandbox: true },
    { amountMicros: 7e6, currency: "EUR", at: start - H, kind: "purchase" },
  ], events: [{ type: "TRIAL_STARTED", at: start + H }, { type: "INITIAL_PURCHASE", at: start + H }, { type: "TRIAL_STARTED", at: start - H }] }], "EUR", tz, start);
  assert.equal(t.revenueMicros, 15e6);
  assert.equal(t.refundsMicros, 10e6);
  assert.equal(t.sales, 1); assert.equal(t.renewals, 1); assert.equal(t.trials, 1); assert.equal(t.newSubscribers, 1);
  assert.equal(t.hourly[0], 0); assert.equal(t.hourly[1], 10e6); assert.equal(t.hourly[3], 15e6); assert.equal(t.hourly[23], 5e6);
  assert.equal(t.last.amountMicros, 5e6);
  const s = liveActivityState(t);
  assert.equal(s.revenueMicros, 5e6); assert.equal(s.sales, 2); assert.equal(s.hourly.length, 24); assert.equal(s.hourly[3], 15);
});

test("downloads: sales report parsing keeps first downloads of the app only", () => {
  const { parseSalesReport } = require("../lib/downloads");
  const tsv = ["Provider\tSKU\tUnits\tProduct Type Identifier\tCountry Code\tApple Identifier",
    "APPLE\tx\t12\t1F\tFR\t123", "APPLE\tx\t3\t1F\tUS\t123", "APPLE\tx\t40\t7F\tFR\t123", "APPLE\tx\t5\tIA1\tFR\t123", "APPLE\tx\t9\t1F\tFR\t999"].join("\n");
  const r = parseSalesReport(tsv, 123);
  assert.equal(r.units, 15); assert.deepEqual(r.byCountry, { FR: 12, US: 3 });
});
