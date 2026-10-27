const test = require("node:test");
const assert = require("node:assert");
const L = require("../lib/leaderboard");

const e = (id, mrr, rev, growth, subs, extra = {}) => ({ projectId: id, name: id, tagline: null, website: null, iconUrl: null,
  mrrMicros: mrr, revenue30dMicros: rev, growth30d: growth, activeSubscriptions: subs, sources: [], hideAmounts: false, listedAt: 1, ...extra });

test("classement trié selon le critère choisi", () => {
  const list = [e("a", 100, 900, 0.1, 5), e("b", 300, 100, null, 50), e("c", 200, 500, 0.9, 1)];
  assert.deepStrictEqual(L.sortEntries(list, "mrr").map(x => x.projectId), ["b", "c", "a"]);
  assert.deepStrictEqual(L.sortEntries(list, "revenue").map(x => x.projectId), ["a", "c", "b"]);
  assert.deepStrictEqual(L.sortEntries(list, "growth").map(x => x.projectId), ["c", "a", "b"]);
  assert.deepStrictEqual(L.sortEntries(list, "subscribers").map(x => x.projectId), ["b", "a", "c"]);
});

test("montants masqués remplacés par des tranches", () => {
  const p = L.publicEntry(e("a", 2_500_000_000, 0, null, 1, { hideAmounts: true }), 1);
  assert.strictEqual(p.mrrMicros, null);
  assert.strictEqual(p.mrrRange, "1 k – 5 k €");
  assert.strictEqual(p.hideAmounts, undefined);
});

test("inscription : site en https, date d'inscription conservée", () => {
  assert.throws(() => L.sanitizeListing({ listed: true, website: "http://x.com" }));
  const first = L.sanitizeListing({ listed: true, tagline: "  Coach IA  " });
  assert.strictEqual(first.tagline, "Coach IA");
  const again = L.sanitizeListing({ hideAmounts: true }, { ...first, listedAt: 42 });
  assert.strictEqual(again.listedAt, 42);
  assert.strictEqual(L.sanitizeListing({ listed: false }, again).listedAt, undefined);
  assert.strictEqual(L.sanitizeListing({}).listed, true);
});
