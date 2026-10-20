/**
 * Mode démo : un business fictif (« Focus Timer ») consultable sans compte depuis l'app,
 * avec le jeton public `mm_demo`. Lecture seule. Les données sont générées ici et
 * alimentées chaque heure pour que « Aujourd'hui » et le flux restent vivants.
 */
import { db, DEFAULT_CONFIG } from "./store";

export const DEMO_TOKEN = "mm_demo";
export const DEMO_UID = "demo";
export const DEMO_PID = "demo-focus";

const DAY = 86400000;
const PRODUCTS = [
  { id: "focus.monthly", price: 4.99, months: 1, w: 55 },
  { id: "focus.annual", price: 39.99, months: 12, w: 35 },
  { id: "focus.lifetime", price: 79.99, months: 0, w: 10 },
];
const STORES = [["app_store", 85], ["stripe", 15]] as const;
const SEED_VERSION = 2;   // à incrémenter pour forcer la régénération
const COUNTRIES = [["FR", 34], ["US", 18], ["DE", 9], ["GB", 8], ["CA", 6], ["BE", 6], ["CH", 5], ["ES", 4], ["IT", 4], ["JP", 3], ["NL", 3]] as const;

function pick<T>(rnd: () => number, items: readonly (readonly [T, number])[]): T {
  let r = rnd() * items.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of items) { r -= w; if (r <= 0) return v; }
  return items[0][0];
}
function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }

type Writer = ReturnType<typeof db.bulkWriter>;

function addSale(w: Writer, rnd: () => number, now: number, start: number, i: string, churn = true) {
  const p = pick(rnd, PRODUCTS.map(x => [x, x.w] as const));
  const store = pick(rnd, STORES), country = pick(rnd, COUNTRIES);
  const uid = `demo_user_${i}`, pid = `demo_${i}`;
  const base = `projects/${DEMO_PID}`;
  const price = Math.round(p.price * 1e6);
  const trial = p.months === 12 && rnd() < 0.5;
  const paidAt = trial ? start + 7 * DAY : start;
  const churned = churn && p.months > 0 && rnd() < 0.12;
  const ev = (type: string, at: number) => w.set(db.collection(`${base}/events`).doc(), {
    type, appUserId: uid, productId: p.id, store, purchaseId: pid, priceMicros: price, currency: "EUR", isSandbox: false,
    isTrial: type === "TRIAL_STARTED", expiresAt: null, country, periodMonths: p.months, at, delivered: true,
  });
  const tx = (at: number, kind: string, n: number) => w.set(db.doc(`${base}/transactions/${pid}_${n}`), {
    appUserId: uid, store, productId: p.id, purchaseId: pid, kind, amountMicros: price, currency: "EUR", amountMicrosProject: price,
    isSandbox: false, country, periodMonths: p.months, at,
  });
  if (trial) ev("TRIAL_STARTED", start);
  if (paidAt <= now) { ev(trial ? "TRIAL_CONVERTED" : p.months ? "INITIAL_PURCHASE" : "NON_RENEWING_PURCHASE", paidAt); tx(paidAt, "purchase", 0); }
  let last = paidAt, n = 1;
  if (p.months === 1) {
    const stop = churned ? paidAt + Math.floor(1 + rnd() * 3) * 30 * DAY : Infinity;
    for (let t = paidAt + 30 * DAY; t <= now && t < stop; t += 30 * DAY) { ev("RENEWAL", t); tx(t, "renewal", n++); last = t; }
  }
  const expiresAt = p.months === 0 ? null : last + p.months * 30 * DAY;
  const expired = churned && expiresAt !== null && expiresAt <= now;
  if (expired) ev("EXPIRATION", expiresAt!);
  w.set(db.doc(`${base}/customers/${uid}/purchases/${pid}`), {
    id: pid, store, productId: p.id, type: p.months ? "subscription" : "non_subscription", status: expired ? "expired" : "active",
    purchasedAt: start, latestPurchaseAt: last, expiresAt: expired ? expiresAt : expiresAt === null ? null : Math.max(expiresAt, now + 30 * DAY),
    willRenew: !churned, isTrial: trial && paidAt > now, isSandbox: false, priceMicros: price, currency: "EUR", periodMonths: p.months,
    billingIssue: false, updatedAt: now, country, projectId: DEMO_PID, appUserId: uid,
  });
  w.set(db.doc(`${base}/customers/${uid}`), {
    appUserId: uid, entitlements: {}, activeEntitlements: expired ? [] : ["pro"], isPaying: !expired && paidAt <= now,
    firstSeenAt: start, lastSeenAt: now, updatedAt: now, country, totalSpentMicros: price * n,
  });
}

/** Recrée entièrement le business démo (≈ 4 mois d'historique, croissance régulière). */
export async function seedDemo(now = Date.now()) {
  const ref = db.doc(`projects/${DEMO_PID}`);
  await db.recursiveDelete(ref);
  await ref.set({
    name: "Focus Timer", members: [DEMO_UID], ownerUid: DEMO_UID, demo: true, seededAt: now, seedVersion: SEED_VERSION,
    config: { ...DEFAULT_CONFIG, currency: "EUR" },
  });
  const rnd = rng(42), w = db.bulkWriter();
  for (let i = 0; i < 260; i++) {
    const start = now - 120 * DAY * Math.pow(rnd(), 0.75);   // plus de clients récents : croissance
    addSale(w, rnd, now, start, String(i));
  }
  await w.close();
}

/** Toutes les heures : 0 à 2 nouvelles ventes ; régénère tout tous les 30 jours. */
export async function demoTick(now = Date.now()) {
  const snap = await db.doc(`projects/${DEMO_PID}`).get();
  if (!snap.exists || now - (snap.get("seededAt") ?? 0) > 30 * DAY || snap.get("seedVersion") !== SEED_VERSION) return seedDemo(now);
  const rnd = rng(now % 4294967296), w = db.bulkWriter();
  const count = rnd() < 0.3 ? 0 : rnd() < 0.7 ? 1 : 2;
  for (let k = 0; k < count; k++) addSale(w, rnd, now, now - Math.floor(rnd() * 3600000), `t${now}_${k}`, false);
  await w.close();
}
