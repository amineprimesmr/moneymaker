// Pure, store-agnostic subscription logic. No Firestore here so it stays unit-testable.

export type StoreName = "app_store" | "play_store" | "stripe" | "paddle" | "promotional" | "test" | "amazon" | "galaxy" | "roku"; // "test" = Test Store (mm_test_ keys), always isSandbox
export type PurchaseType = "subscription" | "non_consumable" | "consumable";
export type PurchaseStatus = "active" | "grace" | "billing_retry" | "paused" | "expired" | "refunded" | "revoked";

export interface Purchase {
  id: string;                 // store-unique id (apple originalTransactionId, google token hash, stripe sub id)
  store: StoreName;
  productId: string;
  type: PurchaseType;
  status: PurchaseStatus;
  purchasedAt: number;        // ms epoch (original purchase)
  latestPurchaseAt: number;   // ms epoch (last renewal)
  expiresAt: number | null;   // ms epoch, null = lifetime
  willRenew: boolean;
  isTrial: boolean;
  isSandbox: boolean;
  priceMicros: number;        // price of the current period, in micro-units of `currency`
  currency: string;
  periodMonths: number;       // 1, 12, 0.25 (weekly)… 0 for non-subscriptions
  billingIssue: boolean;
  updatedAt: number;
  country?: string | null;   // ISO alpha-2 of the storefront / billing address
  affiliate?: boolean;       // vente apportée par un affilié (code de parrainage dans les métadonnées Stripe)
  productName?: string | null; // nom lisible du produit (Stripe : nom du produit), affiché à la place de l'identifiant
}

export type EventType =
  | "INITIAL_PURCHASE" | "RENEWAL" | "TRIAL_STARTED" | "TRIAL_CONVERTED" | "CANCELLATION" | "UNCANCELLATION"
  | "EXPIRATION" | "BILLING_ISSUE" | "BILLING_RECOVERED" | "REFUND" | "PRODUCT_CHANGE" | "NON_RENEWING_PURCHASE"
  | "PAUSED" | "REVOKED" | "GRANT" | "REFUND_REQUESTED" | "REFUND_DECLINED" | "REFUND_REVERSED";

export interface Entitlement {
  id: string;
  active: boolean;
  productId: string;
  store: StoreName;
  expiresAt: number | null;
  willRenew: boolean;
  isTrial: boolean;
  billingIssue: boolean;
  purchasedAt: number;
}

const ACTIVE: PurchaseStatus[] = ["active", "grace"];

export function isPurchaseActive(p: Purchase, now = Date.now()): boolean {
  if (p.type === "consumable") return false;
  if (!ACTIVE.includes(p.status)) return false;
  return p.expiresAt === null || p.expiresAt > now;
}

/** entitlementMap: { premium: ["com.app.monthly", "com.app.annual"], ... }. "*" grants for any product. */
export function computeEntitlements(
  purchases: Purchase[], entitlementMap: Record<string, string[]>, now = Date.now(),
): Record<string, Entitlement> {
  const out: Record<string, Entitlement> = {};
  for (const [id, products] of Object.entries(entitlementMap)) {
    const matching = purchases.filter(p => p.type !== "consumable" &&
      (products.includes("*") || products.includes(p.productId) || (p.store === "promotional" && p.productId === `promo:${id}`)));
    if (!matching.length) continue;
    // Best candidate: active first, then latest expiry (null = forever wins).
    const ranked = matching.sort((a, b) => {
      const aa = isPurchaseActive(a, now) ? 1 : 0, ba = isPurchaseActive(b, now) ? 1 : 0;
      if (aa !== ba) return ba - aa;
      return (b.expiresAt ?? Infinity) - (a.expiresAt ?? Infinity);
    });
    const best = ranked[0];
    out[id] = {
      id, active: isPurchaseActive(best, now), productId: best.productId, store: best.store,
      expiresAt: best.expiresAt, willRenew: best.willRenew, isTrial: best.isTrial,
      billingIssue: best.billingIssue, purchasedAt: best.purchasedAt,
    };
  }
  return out;
}

/** Derives lifecycle events by diffing the previous and new state of one purchase. */
export function diffEvents(prev: Purchase | undefined, next: Purchase): EventType[] {
  if (next.store === "promotional") return !prev || prev.status !== next.status || prev.expiresAt !== next.expiresAt ? ["GRANT"] : [];
  if (!prev) {
    if (next.type !== "subscription") return next.status === "refunded" ? ["REFUND"] : ["NON_RENEWING_PURCHASE"];
    const ev: EventType[] = [next.isTrial ? "TRIAL_STARTED" : "INITIAL_PURCHASE"];
    if (next.status === "refunded") ev.push("REFUND");
    else if (next.status === "revoked") ev.push("REVOKED");
    else if (next.status === "expired") ev.push("EXPIRATION");
    return ev;
  }
  const ev: EventType[] = [];
  if (prev.productId !== next.productId) ev.push("PRODUCT_CHANGE");
  if (next.latestPurchaseAt > prev.latestPurchaseAt && next.type === "subscription") {
    ev.push(prev.isTrial && !next.isTrial ? "TRIAL_CONVERTED" : "RENEWAL");
  }
  if (prev.status !== next.status) {
    if ((prev.status === "refunded" || prev.status === "revoked") && (next.status === "active" || next.status === "grace")) ev.push("REFUND_REVERSED");
    else if (next.status === "refunded") ev.push("REFUND");
    else if (next.status === "revoked") ev.push("REVOKED");
    else if (next.status === "expired") ev.push("EXPIRATION");
    else if (next.status === "paused") ev.push("PAUSED");
    else if ((next.status === "billing_retry" || next.status === "grace") && !prev.billingIssue) ev.push("BILLING_ISSUE");
    else if (next.status === "active" && (prev.status === "billing_retry" || prev.status === "grace")) ev.push("BILLING_RECOVERED");
  }
  if (prev.willRenew && !next.willRenew && isPurchaseActive(next)) ev.push("CANCELLATION");
  // Réabonnement : seulement après une vraie résiliation, pas quand le store confirme le renouvellement
  // automatique juste après l'achat (doublon « Réactivation » avec « Nouvel abonné »).
  if (!prev.willRenew && next.willRenew && isPurchaseActive(next) && next.updatedAt - prev.latestPurchaseAt > 15 * 60000) ev.push("UNCANCELLATION");
  return [...new Set(ev)];
}

/** Approximate FX table (units of currency per 1 EUR). Only used for dashboard aggregation. */
export const FX_PER_EUR: Record<string, number> = {
  EUR: 1, USD: 1.08, GBP: 0.85, CHF: 0.95, CAD: 1.47, AUD: 1.63, JPY: 162, CNY: 7.8, INR: 90, BRL: 5.9,
  MXN: 19.5, SEK: 11.4, NOK: 11.6, DKK: 7.46, PLN: 4.3, CZK: 25, HUF: 395, TRY: 37, MAD: 10.8, AED: 3.97,
  SAR: 4.05, KRW: 1480, SGD: 1.45, HKD: 8.4, NZD: 1.78, ZAR: 19.8, ILS: 4.0, RON: 4.97, IDR: 17300, THB: 38,
  // Devises des stores absentes de la BCE : taux approchés (les taux BCE du jour remplacent les autres, voir loadFx).
  TWD: 35, PHP: 63, VND: 28000, EGP: 53, NGN: 1700, PKR: 305, CLP: 1030, COP: 4500, PEN: 4.1, QAR: 3.93, KZT: 540,
  UAH: 45, RUB: 95, ARS: 1300, BGN: 1.956, ISK: 150, MYR: 4.9, BDT: 130, LKR: 330, KES: 140, GHS: 15, TZS: 2900,
  UGX: 4000, XOF: 655.957, XAF: 655.957, DZD: 145, TND: 3.35, JOD: 0.77, KWD: 0.33, BHD: 0.41, OMR: 0.42, GEL: 2.95,
  AMD: 420, AZN: 1.84, RSD: 117, MKD: 61.5, BAM: 1.956, MDL: 19.5, MNT: 3700, KHR: 4400, NPR: 145, BOB: 7.5,
  PYG: 8400, UYU: 45, DOP: 66, CRC: 550, GTQ: 8.4, HNL: 27, JMD: 170, TTD: 7.3, LBP: 97000, IQD: 1415, MOP: 8.7,
};

/** Remplace les taux par ceux du jour (BCE), sans retirer les devises que la BCE ne publie pas. */
export function applyFxRates(rates: Record<string, number>) {
  for (const [k, v] of Object.entries(rates)) if (/^[A-Z]{3}$/.test(k) && Number.isFinite(v) && v > 0) FX_PER_EUR[k] = v;
}

/** Devises sans unité mineure / à trois décimales chez Stripe (et la plupart des PSP). */
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
const THREE_DECIMAL = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);
/** Montant en unité mineure (centimes, ou yen pour JPY) → micro-unités. Pure — unit-tested. */
export function minorToMicros(minor: unknown, currency: string): number {
  const c = String(currency ?? "").toUpperCase(), n = Number(minor ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * (ZERO_DECIMAL.has(c) ? 1e6 : THREE_DECIMAL.has(c) ? 1e3 : 1e4));
}

export function convertMicros(micros: number, from: string, to: string): number {
  const f = FX_PER_EUR[from.toUpperCase()], t = FX_PER_EUR[to.toUpperCase()];
  if (!f || !t) return from.toUpperCase() === to.toUpperCase() ? micros : 0;
  return Math.round((micros / f) * t);
}

/** Monthly recurring revenue contributed by a purchase, in micro-units of `currency`. */
/** MRR actif : un abonnement résilié (renouvellement coupé) sort du MRR dès la résiliation, même s'il reste
 *  payé jusqu'à la fin de sa période. Il revient s'il est réactivé. */
export function mrrMicros(p: Purchase, currency: string, now = Date.now()): number {
  if (p.type !== "subscription" || p.isTrial || p.isSandbox || !p.willRenew || !isPurchaseActive(p, now) || !p.periodMonths) return 0;
  return Math.round(convertMicros(p.priceMicros, p.currency, currency) / p.periodMonths);
}

export interface Metrics {
  currency: string;
  mrrMicros: number;
  arrMicros: number;
  activeSubscriptions: number;
  /** Abonnés payants qui vont renouveler : ceux qui portent le MRR actif. */
  renewingSubscriptions: number;
  activeTrials: number;
  activeCustomers: number;
  willNotRenew: number;
  billingIssues: number;
  byStore: Record<string, { mrrMicros: number; active: number }>;
  byProduct: Record<string, { mrrMicros: number; active: number }>;
}

export function computeMetrics(purchases: Purchase[], customerOf: (p: Purchase) => string, currency: string, now = Date.now()): Metrics {
  const m: Metrics = {
    currency, mrrMicros: 0, arrMicros: 0, activeSubscriptions: 0, renewingSubscriptions: 0, activeTrials: 0, activeCustomers: 0,
    willNotRenew: 0, billingIssues: 0, byStore: {}, byProduct: {},
  };
  const customers = new Set<string>();
  for (const p of purchases) {
    if (p.isSandbox || !isPurchaseActive(p, now)) continue;
    customers.add(customerOf(p));
    if (p.type !== "subscription") continue;
    const mrr = mrrMicros(p, currency, now);
    if (p.isTrial) m.activeTrials++; else { m.activeSubscriptions++; if (p.willRenew) m.renewingSubscriptions++; }
    if (!p.willRenew) m.willNotRenew++;
    if (p.billingIssue) m.billingIssues++;
    m.mrrMicros += mrr;
    for (const [bucket, key] of [[m.byStore, p.store], [m.byProduct, p.productId]] as const) {
      bucket[key] ??= { mrrMicros: 0, active: 0 };
      bucket[key].mrrMicros += mrr;
      bucket[key].active++;
    }
  }
  m.activeCustomers = customers.size;
  m.arrMicros = m.mrrMicros * 12;
  return m;
}

/** Mouvements de MRR (MRR actif) : la résiliation retire le MRR le jour même, la réactivation le rend, et la fin
 *  de période d'un abonnement déjà résilié ne le retire pas une deuxième fois. Une expiration, un remboursement ou
 *  une révocation sans résiliation préalable (échec de paiement, remboursement direct) retire le MRR à ce moment-là. */
export interface MrrEv { type: string; appUserId: string; productId: string; isTrial?: boolean; periodMonths?: number; wasRenewing?: boolean | null; at: number }
export function mrrMovements<E extends MrrEv>(events: E[]): { starts: { e: E; reactivation: boolean }[]; churns: E[] } {
  const cancelled = new Set<string>(), churnedBefore = new Set<string>();
  const starts: { e: E; reactivation: boolean }[] = [], churns: E[] = [];
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    if (e.isTrial || !((e.periodMonths ?? 0) > 0)) continue;
    const k = `${e.appUserId}\u0000${e.productId}`;
    if (e.type === "INITIAL_PURCHASE" || e.type === "TRIAL_CONVERTED") { cancelled.delete(k); starts.push({ e, reactivation: churnedBefore.has(e.appUserId) }); }
    else if (e.type === "UNCANCELLATION") { if (cancelled.delete(k)) starts.push({ e, reactivation: true }); }
    else if (e.type === "CANCELLATION") { if (!cancelled.has(k)) { cancelled.add(k); churnedBefore.add(e.appUserId); churns.push(e); } }
    else if (e.type === "EXPIRATION" || e.type === "REFUND" || e.type === "REVOKED") {
      const already = cancelled.has(k) || e.wasRenewing === false;
      cancelled.delete(k);
      if (!already) { churnedBefore.add(e.appUserId); churns.push(e); }
    }
  }
  return { starts, churns };
}

/** ISO-8601 duration ("P1M", "P1Y", "P1W", "P3M", "P7D") to months. */
export function isoPeriodToMonths(period: string | undefined | null): number {
  if (!period) return 0;
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/.exec(period);
  if (!m) return 0;
  const [, y, mo, w, d] = m.map(x => Number(x ?? 0));
  return y * 12 + mo + (w * 7 + d) / 30.4375;
}

export function cleanId(raw: unknown, max = 128): string {
  if (typeof raw !== "string") throw new HttpError(400, "invalid_id");
  const s = raw.trim();
  if (!s || s.length > max || /[\/\u0000-\u001f]/.test(s) || s === "." || s === "..") throw new HttpError(400, "invalid_id");
  return s;
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) { super(message ?? code); }
}

/** Product label worth showing: null for placeholders and raw Stripe ids (the business name is shown instead). Pure — unit-tested. */
export function readableProductId(id: unknown): string | null {
  const s = typeof id === "string" ? id.trim() : "";
  if (!s || /^stripe_(payment|one_time)$/i.test(s) || /^(prod|price|plink|cs|pi|ch|py|in)_[A-Za-z0-9]+$/.test(s)) return null;
  return s;
}
