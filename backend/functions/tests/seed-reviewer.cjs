// Compte relecteur pour les annuaires Claude / ChatGPT : un utilisateur e-mail + mot de passe (sans 2FA)
// propriétaire d'un business fictif. Idempotent. Production : GCLOUD_PROJECT=moneymaker-io node tests/seed-reviewer.cjs
// Le mot de passe est écrit dans submission/reviewer-credentials.txt (ignoré par git), jamais affiché.
const { randomBytes } = require("crypto");
const fs = require("fs"), path = require("path");
const { db, createProject, upsertPurchase, getProject } = require("../lib/store");
const { getAuth } = require("firebase-admin/auth");
const DAY = 86400000, EMAIL = "reviewer@moneymaker-io.web.app", NAME = "Focus Timer (demo)";
const APP = "1000000001"; // identifiant fictif : aucune vraie app n'est touchée
const OUT = path.join(__dirname, "../../../submission/reviewer-credentials.txt");
(async () => {
  const password = `Mm-${randomBytes(9).toString("base64url")}`;
  let user = await getAuth().getUserByEmail(EMAIL).catch(() => null);
  user = user ? await getAuth().updateUser(user.uid, { password, emailVerified: true, disabled: false })
    : await getAuth().createUser({ email: EMAIL, password, emailVerified: true, displayName: "MoneyMaker Reviewer" });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `Connexion : https://usemoneymaker.com/connect (e-mail + mot de passe, pas de 2FA)\nE-mail : ${EMAIL}\nMot de passe : ${password}\n`, { mode: 0o600 });
  const existing = await db.collection("projects").where("ownerUid", "==", user.uid).get();
  if (existing.docs.some(d => d.get("name") === NAME)) { console.log(JSON.stringify({ uid: user.uid, project: "déjà présent", credentials: OUT })); process.exit(0); }
  const { projectId } = await createProject(NAME, user.uid);
  await db.doc(`projects/${projectId}`).update({ "config.entitlements": { premium: ["focus_monthly", "focus_annual"] }, "config.category": "productivity",
    "config.offerings": { default: { description: "Paywall principal", packages: [{ id: "$rc_monthly", productIds: { app_store: "focus_monthly" } }, { id: "$rc_annual", productIds: { app_store: "focus_annual" } }] } },
    "config.currentOffering": "default", "config.appStore": { apps: [{ appId: APP, own: true }] } });
  const project = await getProject(projectId);
  const countries = ["FR", "FR", "US", "US", "US", "DE", "GB", "CA", "ES", "IT", "BR", "JP", "BE", "CH", "AU"];
  let n = 0;
  for (let i = 0; i < 80; i++) {
    const annual = i % 3 === 0, start = Date.now() - (i * 4 + 2) * DAY, cc = countries[i % countries.length], trial = i % 7 === 0 && i < 20;
    const p = { id: `rv_${i}`, store: i % 5 === 0 ? "stripe" : i % 6 === 0 ? "play_store" : "app_store", productId: annual ? "focus_annual" : "focus_monthly", type: "subscription",
      status: "active", purchasedAt: start, latestPurchaseAt: start, expiresAt: start + (trial ? 7 : annual ? 365 : 30) * DAY, willRenew: i % 5 !== 0,
      isTrial: trial, isSandbox: false, priceMicros: trial ? 0 : annual ? 39_990_000 : 6_990_000, currency: "EUR", periodMonths: annual ? 12 : 1,
      billingIssue: i === 11, updatedAt: start, country: cc };
    await upsertPurchase(project, `reviewer_user_${i}`, p);
    if (!annual && !trial && start + 30 * DAY < Date.now()) await upsertPurchase(project, `reviewer_user_${i}`, { ...p, latestPurchaseAt: start + 30 * DAY, expiresAt: start + 60 * DAY, updatedAt: start + 30 * DAY });
    if (i % 9 === 0) await upsertPurchase(project, `reviewer_user_${i}`, { ...p, status: "expired", willRenew: false, expiresAt: Date.now() - DAY, updatedAt: Date.now() });
    n++;
  }
  for (let d = 60; d >= 1; d--) {
    const date = new Date(Date.now() - d * DAY).toISOString().slice(0, 10);
    await db.doc(`projects/${projectId}/daily/${date}`).set({ date, mrrMicros: (180 + (60 - d) * 6) * 1e6, activeSubscriptions: 30 + Math.round((60 - d) * 0.8), activeTrials: 3 + (d % 4), revenueMicros: (20 + (d % 7) * 4) * 1e6, currency: "EUR" });
  }
  await db.doc(`apps/${APP}`).set({ appId: APP, name: "Focus Timer (demo)", developer: "MoneyMaker Demo", genreId: "6007", genreName: "Productivity", trackers: [projectId], countriesRanked: 4, bestRank: 3, rating: 4.6, ratingCount: 1834, demo: true });
  for (const [cc, rank, prev] of [["FR", 3, 5], ["BE", 8, 8], ["CH", 12, null], ["CA", 41, 55]]) {
    const history = Array.from({ length: 12 }, (_, k) => ({ t: Date.now() - (12 - k) * 6 * 3600000, r: Math.max(1, rank + Math.round(Math.sin(k) * 2)) }));
    await db.doc(`apps/${APP}/ranks/${cc}_free_genre`).set({ cc, chart: "free", scope: "genre", rank, prevRank: prev, bestRank: Math.min(rank, prev ?? rank), history, updatedAt: Date.now(), firstRankedAt: Date.now() - 30 * DAY });
  }
  for (const [cc, count, avg] of [["FR", 1200, 4.7], ["BE", 310, 4.5], ["US", 324, 4.4]]) await db.doc(`apps/${APP}/ratings/${cc}`).set({ cc, count, average: avg, at: Date.now() });
  const reviews = [[5, "Great focus app", "Helps me study every day."], [4, "Pratique", "Simple et efficace."], [1, "Crash", "Crashes when I start a session."], [5, "Perfect", "Exactly what I needed."], [2, "Too expensive", "The yearly plan is pricey."]];
  for (const [r, [rating, title, content]] of reviews.entries()) await db.doc(`apps/${APP}/reviews/rv${r}`).set({ id: `rv${r}`, country: r % 2 ? "FR" : "US", rating, title, content, author: `reviewer${r}`, version: "2.1", at: Date.now() - r * DAY });
  for (const [type, cc, rank, prev] of [["TOP_3", "FR", 3, 5], ["NEW_COUNTRY", "CH", 12, null]]) await db.collection(`projects/${projectId}/alerts`).add({ type, appId: APP, appName: "Focus Timer (demo)", cc, chart: "free", scope: "genre", rank, prevRank: prev, own: true, at: Date.now() - DAY / 2, delivered: true });
  await db.doc(`users/${user.uid}/expenses/hosting`).set({ id: "hosting", name: "Hosting", amountMicros: 20e6, currency: "EUR", every: "month", projectId: null });
  console.log(JSON.stringify({ uid: user.uid, projectId, customers: n, credentials: OUT }));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
