// Pure, store-agnostic subscription logic. No Firestore here so it stays unit-testable.

export type StoreName = "app_store" | "play_store" | "stripe" | "promotional";
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
}

export type EventType =
  | "INITIAL_PURCHASE" | "RENEWAL" | "TRIAL_STARTED" | "TRIAL_CONVERTED" | "CANCELLATION" | "UNCANCELLATION"
  | "EXPIRATION" | "BILLING_ISSUE" | "BILLING_RECOVERED" | "REFUND" | "PRODUCT_CHANGE" | "NON_RENEWING_PURCHASE"
  | "PAUSED" | "REVOKED" | "GRANT";

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
    if (next.status === "refunded") ev.push("REFUND");
    else if (next.status === "revoked") ev.push("REVOKED");
    else if (next.status === "expired") ev.push("EXPIRATION");
    else if (next.status === "paused") ev.push("PAUSED");
    else if ((next.status === "billing_retry" || next.status === "grace") && !prev.billingIssue) ev.push("BILLING_ISSUE");
    else if (next.status === "active" && (prev.status === "billing_retry" || prev.status === "grace")) ev.push("BILLING_RECOVERED");
  }
  if (prev.willRenew && !next.willRenew && isPurchaseActive(next)) ev.push("CANCELLATION");
  if (!prev.willRenew && next.willRenew && isPurchaseActive(next)) ev.push("UNCANCELLATION");
  return [...new Set(ev)];
}

/** Approximate FX table (units of currency per 1 EUR). Only used for dashboard aggregation. */
export const FX_PER_EUR: Record<string, number> = {
  EUR: 1, USD: 1.08, GBP: 0.85, CHF: 0.95, CAD: 1.47, AUD: 1.63, JPY: 162, CNY: 7.8, INR: 90, BRL: 5.9,
  MXN: 19.5, SEK: 11.4, NOK: 11.6, DKK: 7.46, PLN: 4.3, CZK: 25, HUF: 395, TRY: 37, MAD: 10.8, AED: 3.97,
  SAR: 4.05, KRW: 1480, SGD: 1.45, HKD: 8.4, NZD: 1.78, ZAR: 19.8, ILS: 4.0, RON: 4.97, IDR: 17300, THB: 38,
};

export function convertMicros(micros: number, from: string, to: string): number {
  const f = FX_PER_EUR[from.toUpperCase()], t = FX_PER_EUR[to.toUpperCase()];
  if (!f || !t) return from.toUpperCase() === to.toUpperCase() ? micros : 0;
  return Math.round((micros / f) * t);
}

/** Monthly recurring revenue contributed by a purchase, in micro-units of `currency`. */
export function mrrMicros(p: Purchase, currency: string, now = Date.now()): number {
  if (p.type !== "subscription" || p.isTrial || p.isSandbox || !isPurchaseActive(p, now) || !p.periodMonths) return 0;
  return Math.round(convertMicros(p.priceMicros, p.currency, currency) / p.periodMonths);
}

export interface Metrics {
  currency: string;
  mrrMicros: number;
  arrMicros: number;
  activeSubscriptions: number;
  activeTrials: number;
  activeCustomers: number;
  willNotRenew: number;
  billingIssues: number;
  byStore: Record<string, { mrrMicros: number; active: number }>;
  byProduct: Record<string, { mrrMicros: number; active: number }>;
}

export function computeMetrics(purchases: Purchase[], customerOf: (p: Purchase) => string, currency: string, now = Date.now()): Metrics {
  const m: Metrics = {
    currency, mrrMicros: 0, arrMicros: 0, activeSubscriptions: 0, activeTrials: 0, activeCustomers: 0,
    willNotRenew: 0, billingIssues: 0, byStore: {}, byProduct: {},
  };
  const customers = new Set<string>();
  for (const p of purchases) {
    if (p.isSandbox || !isPurchaseActive(p, now)) continue;
    customers.add(customerOf(p));
    if (p.type !== "subscription") continue;
    const mrr = mrrMicros(p, currency, now);
    if (p.isTrial) m.activeTrials++; else m.activeSubscriptions++;
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
