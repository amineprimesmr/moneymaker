// Seeds the emulators with realistic demo data for dashboard checks. Usage (emulators running):
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8181 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9199 GCLOUD_PROJECT=demo-moneymaker node tests/seed-demo.cjs
const { db, createProject, upsertPurchase, getProject, sha256 } = require("../lib/store");
const { getAuth } = require("firebase-admin/auth");
const DAY = 86400000;
(async () => {
  const user = await getAuth().createUser({ email: "demo@moneymaker.test", password: "demo-password-123", emailVerified: true }).catch(() => getAuth().getUserByEmail("demo@moneymaker.test"));
  const { projectId } = await createProject("Demo Fitness", user.uid);
  await db.doc(`projects/${projectId}`).update({ "config.entitlements": { premium: ["monthly", "annual"] }, "config.appStore": { apps: [{ appId: "1458351041", own: true }] } });
  const project = await getProject(projectId);
  const countries = ["FR", "FR", "FR", "US", "US", "DE", "GB", "CA", "ES", "IT", "BR", "JP", "MA", "BE", "CH"];
  let n = 0;
  for (let i = 0; i < 60; i++) {
    const annual = i % 3 === 0, start = Date.now() - (i * 5 + 3) * DAY, cc = countries[i % countries.length];
    const p = { id: `demo_${i}`, store: i % 4 === 0 ? "stripe" : "app_store", productId: annual ? "annual" : "monthly", type: "subscription",
      status: "active", purchasedAt: start, latestPurchaseAt: start, expiresAt: start + (annual ? 365 : 30) * DAY, willRenew: i % 5 !== 0,
      isTrial: false, isSandbox: false, priceMicros: annual ? 49_990_000 : 9_990_000, currency: "EUR", periodMonths: annual ? 12 : 1,
      billingIssue: false, updatedAt: start, country: cc };
    await upsertPurchase(project, `user_${i}`, p);
    if (!annual && start + 30 * DAY < Date.now()) await upsertPurchase(project, `user_${i}`, { ...p, latestPurchaseAt: start + 30 * DAY, expiresAt: start + 60 * DAY, updatedAt: start + 30 * DAY });
    if (i % 9 === 0) await upsertPurchase(project, `user_${i}`, { ...p, status: "expired", expiresAt: Date.now() - DAY, updatedAt: Date.now() });
    n++;
  }
  // a few daily snapshots so the MRR chart has a shape
  for (let d = 30; d >= 1; d--) {
    const date = new Date(Date.now() - d * DAY).toISOString().slice(0, 10);
    await db.doc(`projects/${projectId}/daily/${date}`).set({ date, mrrMicros: (200 + (30 - d) * 9) * 1e6, activeSubscriptions: 25 + (30 - d), activeTrials: 4, revenueMicros: 30e6, currency: "EUR" });
  }
  // tracked app + rankings + alerts + reviews for the App Store tabs (synthetic, no network)
  await db.doc("apps/1458351041").set({ appId: "1458351041", name: "Carte Vitale", icon: "https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/3b/0e/5a/3b0e5a4e-0b2e-6a1b-4f5f-1e0b3c5c1a3e/AppIcon-0-0-1x_U007emarketing-0-8-0-85-220.png/512x512bb.jpg", developer: "CNAM", genreId: "6013", genreName: "Health & Fitness", trackers: [projectId], countriesRanked: 6, bestRank: 1, rating: 4.69, ratingCount: 74687 });
  const ranks = [["FR", "free", "genre", 1, 2], ["FR", "free", "all", 9, 12], ["BE", "free", "genre", 3, 5], ["CH", "free", "genre", 7, null], ["MA", "free", "genre", 14, 30], ["LU", "free", "genre", 22, 21], ["CA", "free", "genre", 61, 70]];
  for (const [cc, chart, scope, rank, prev] of ranks) {
    const history = Array.from({ length: 12 }, (_, k) => ({ t: Date.now() - (12 - k) * 6 * 3600000, r: Math.max(1, rank + Math.round(Math.sin(k) * 3)) }));
    await db.doc(`apps/1458351041/ranks/${cc}_${chart}_${scope}`).set({ cc, chart, scope, rank, prevRank: prev, bestRank: Math.min(rank, prev ?? rank), history, updatedAt: Date.now(), firstRankedAt: Date.now() - 30 * DAY });
  }
  for (const [type, cc, rank, prev] of [["TOP_1", "FR", 1, 2], ["NEW_COUNTRY", "CH", 7, null], ["JUMP", "MA", 14, 30]]) {
    await db.collection(`projects/${projectId}/alerts`).add({ type, appId: "1458351041", appName: "Carte Vitale", cc, chart: "free", scope: "genre", rank, prevRank: prev, own: true, at: Date.now() - Math.random() * DAY, delivered: true });
  }
  for (const [cc, count, avg] of [["FR", 70110, 4.7], ["BE", 2100, 4.5], ["CH", 980, 4.6], ["MA", 120, 3.9]]) await db.doc(`apps/1458351041/ratings/${cc}`).set({ cc, count, average: avg, at: Date.now() });
  for (let r = 0; r < 6; r++) await db.doc(`apps/1458351041/reviews/rv${r}`).set({ id: `rv${r}`, country: r % 2 ? "BE" : "FR", rating: [5, 4, 1, 5, 3, 2][r], title: ["Top", "Pratique", "Impossible à utiliser", "Parfait", "Bof", "Bugs"][r], content: "Exemple d'avis de démonstration pour vérifier l'affichage, les filtres et le partage.", author: `user${r}`, version: "9.2.3", at: Date.now() - r * DAY });
  console.log(JSON.stringify({ projectId, customers: n, login: "demo@moneymaker.test" }));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
