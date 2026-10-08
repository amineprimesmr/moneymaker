// Live check against Apple's public feeds (run inside the Firestore emulator).
const { db } = require("../lib/store");
const { syncTrackers, scanRankings, scanRatings, scanReviews } = require("../lib/appstore");
(async () => {
  const t0 = Date.now();
  await db.doc("projects/demo").set({ name: "Demo", members: [], config: { currency: "EUR", entitlements: {}, offerings: {}, webhooks: [], appStore: { apps: [{ appId: "1458351041" }] } } });
  await syncTrackers("demo", [{ appId: "1458351041" }]);
  const r = await scanRankings(["1458351041"]);
  const ranks = await db.collection("apps/1458351041/ranks").where("rank", "!=", null).get();
  const best = ranks.docs.map(d => d.data()).sort((a, b) => a.rank - b.rank).slice(0, 3).map(d => `${d.cc}/${d.chart}/${d.scope}#${d.rank}`);
  console.log("scan", r, "ranked docs", ranks.size, "best", best, `${((Date.now() - t0) / 1000).toFixed(0)}s`);
  const t1 = Date.now(); await scanRatings("1458351041");
  const app = (await db.doc("apps/1458351041").get()).data();
  console.log("ratings", app.ratingCount, app.rating?.toFixed(2), `${((Date.now() - t1) / 1000).toFixed(0)}s`);
  const t2 = Date.now(); const fresh = await scanReviews("1458351041");
  console.log("reviews", fresh.length, `${((Date.now() - t2) / 1000).toFixed(0)}s`);
  // second scan must produce alerts only for real changes, never a flood
  await scanRankings(["1458351041"]);
  console.log("alerts after 2nd scan", (await db.collection("projects/demo/alerts").get()).size);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
