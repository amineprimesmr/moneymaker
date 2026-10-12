// Pure chart computation (RevenueCat "Charts" parity). No Firestore here: unit-tested against lib/.
import { convertMicros } from "./engine";

const DAY = 86400000;

export type Resolution = "day" | "week" | "month";
export type Unit = "count" | "micros" | "ratio";

export interface ChartPurchase {
  appUserId: string; store: string; productId: string; type: string; status: string;
  purchasedAt: number; latestPurchaseAt?: number; expiresAt: number | null; willRenew?: boolean;
  isTrial?: boolean; isSandbox?: boolean; priceMicros?: number; currency?: string; periodMonths?: number;
  billingIssue?: boolean; updatedAt?: number; country?: string | null;
}
export interface ChartTx { appUserId: string; store: string; productId: string; kind: string; amountMicrosProject: number; isSandbox?: boolean; country?: string | null; periodMonths?: number; at: number }
export interface ChartEvent { type: string; appUserId: string; productId: string; store: string; priceMicros?: number; currency?: string; periodMonths?: number; isSandbox?: boolean; isTrial?: boolean; country?: string | null; at: number }
export interface ChartCustomer { id: string; firstSeenAt?: number; country?: string | null }
export interface ChartDaily { date: string; mrrMicros?: number; activeSubscriptions?: number; activeTrials?: number }
export interface ChartPaywallEvent { type: string; at: number; paywallId?: string; offeringId?: string; isSandbox?: boolean }

export interface ChartData {
  purchases: ChartPurchase[]; txs: ChartTx[]; events: ChartEvent[]; customers: ChartCustomer[];
  daily?: ChartDaily[]; paywallEvents?: ChartPaywallEvent[] | null;
}
export interface ChartFilters { store?: string; country?: string; product?: string }
export interface ChartOptions {
  start: number; end: number; resolution: Resolution; currency: string; now: number;
  filters?: ChartFilters; conversionDays?: number; retentionPeriods?: number;
}
export interface ChartPoint { date: string; value: number | null; [k: string]: number | string | null }
export interface ChartResult { name: string; unit: Unit; resolution: Resolution; currency: string; series: ChartPoint[]; summary: Record<string, number | string | null>; note?: string }

export const CHART_NAMES = [
  "active_subscriptions", "active_subscriptions_movement", "active_trials", "active_trials_movement",
  "mrr", "mrr_movement", "arr", "revenue", "new_customers", "conversion_to_paying", "initial_conversion",
  "trial_conversion_funnel", "trial_conversion_rate", "trial_cancellation_rate", "subscription_retention",
  "churn", "refund_rate", "refunds", "realized_ltv_per_customer", "realized_ltv_per_paying_customer",
  "non_subscription_purchases", "subscription_status", "paywall",
] as const;
export type ChartName = typeof CHART_NAMES[number];

// ── Buckets ────────────────────────────────────────────────────────────────
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

export function bucketStart(t: number, r: Resolution): number {
  const d = new Date(t);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (r === "day") return day;
  if (r === "week") return day - ((d.getUTCDay() + 6) % 7) * DAY; // ISO week, Monday
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
function nextBucket(t: number, r: Resolution): number {
  if (r === "day") return t + DAY;
  if (r === "week") return t + 7 * DAY;
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}
export interface Bucket { date: string; start: number; end: number }
/** Buckets covering [start, end]; `end` of each bucket is exclusive. */
export function buckets(start: number, end: number, r: Resolution): Bucket[] {
  const out: Bucket[] = [];
  for (let s = bucketStart(start, r); s <= end && out.length < 2000; s = nextBucket(s, r)) out.push({ date: iso(s), start: s, end: nextBucket(s, r) });
  return out;
}
const indexOf = (bs: Bucket[], t: number) => {
  if (!bs.length || t < bs[0].start || t >= bs[bs.length - 1].end) return -1;
  let lo = 0, hi = bs.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bs[mid].start <= t) lo = mid; else hi = mid - 1; }
  return lo;
};

// ── Helpers ────────────────────────────────────────────────────────────────
const ratio = (a: number, b: number) => (b ? a / b : null);
const isSub = (p: { periodMonths?: number; type?: string }) => (p.type ? p.type === "subscription" : (p.periodMonths ?? 0) > 0);

function matches(x: { store?: string; country?: string | null; productId?: string }, f?: ChartFilters) {
  if (!f) return true;
  if (f.store && x.store !== f.store) return false;
  if (f.country && (x.country ?? "??") !== f.country) return false;
  if (f.product && x.productId !== f.product) return false;
  return true;
}
const hasFilters = (f?: ChartFilters) => Boolean(f && (f.store || f.country || f.product));

/** End of a purchase's entitlement as known today (refund/revoke cut it at updatedAt). */
function endOf(p: ChartPurchase): number {
  let end = p.expiresAt === null ? Infinity : p.expiresAt;
  if ((p.status === "refunded" || p.status === "revoked") && p.updatedAt) end = Math.min(end, p.updatedAt);
  return end;
}
const paidActiveAt = (p: ChartPurchase, t: number) => !p.isTrial && p.purchasedAt <= t && endOf(p) > t;
const trialActiveAt = (p: ChartPurchase, t: number) => Boolean(p.isTrial) && p.purchasedAt <= t && endOf(p) > t;
const monthlyMicros = (priceMicros: number | undefined, currency: string | undefined, periodMonths: number | undefined, to: string) =>
  periodMonths ? convertMicros(priceMicros ?? 0, currency ?? to, to) / periodMonths : 0;

const CHURN_TYPES = new Set(["EXPIRATION", "REVOKED"]);
const pointAt = (b: Bucket, now: number) => Math.min(b.end - 1, now);

function clean(d: ChartData, f?: ChartFilters) {
  return {
    purchases: d.purchases.filter(p => !p.isSandbox && p.store !== "promotional" && matches(p, f)),
    txs: d.txs.filter(t => !t.isSandbox && matches(t, f)),
    events: d.events.filter(e => !e.isSandbox && e.type !== "TEST" && matches(e, f)).sort((a, b) => a.at - b.at),
    customers: hasFilters(f) && f?.country ? d.customers.filter(c => (c.country ?? "??") === f.country) : d.customers,
  };
}

/** Subscription starts classified as new vs reactivation (user had a prior paid churn). */
function subscriptionStarts(events: ChartEvent[]) {
  const churnedBefore = new Set<string>();
  const out: { e: ChartEvent; reactivation: boolean }[] = [];
  const churns: ChartEvent[] = [];
  for (const e of events) {
    const isStart = (e.type === "INITIAL_PURCHASE" && !e.isTrial && (e.periodMonths ?? 0) > 0) || e.type === "TRIAL_CONVERTED";
    if (isStart) out.push({ e, reactivation: churnedBefore.has(e.appUserId) });
    if (CHURN_TYPES.has(e.type) && !e.isTrial && (e.periodMonths ?? 1) > 0) { churnedBefore.add(e.appUserId); churns.push(e); }
    if (e.type === "REFUND" && (e.periodMonths ?? 0) > 0) { churnedBefore.add(e.appUserId); churns.push(e); }
  }
  return { starts: out, churns };
}

function sumSummary(series: ChartPoint[], keys: string[]) {
  const s: Record<string, number> = {};
  for (const k of keys) s[k] = series.reduce((a, p) => a + (typeof p[k] === "number" ? (p[k] as number) : 0), 0);
  return s;
}
const last = (series: ChartPoint[]) => (series.length ? series[series.length - 1].value : null);

// ── Main ───────────────────────────────────────────────────────────────────
export function computeChart(name: string, data: ChartData, o: ChartOptions): ChartResult {
  if (!(CHART_NAMES as readonly string[]).includes(name)) throw new Error("unknown_chart");
  const bs = buckets(o.start, o.end, o.resolution);
  const d = clean(data, o.filters);
  const cur = o.currency;
  const res = (unit: Unit, series: ChartPoint[], summary: Record<string, number | string | null>, note?: string): ChartResult =>
    ({ name, unit, resolution: o.resolution, currency: cur, series, summary, ...(note ? { note } : {}) });
  const empty = (): any[] => bs.map(b => ({ date: b.date }));

  // Daily snapshots win over reconstruction when present and unfiltered.
  const snap = new Map<string, ChartDaily>();
  if (!hasFilters(o.filters)) for (const s of data.daily ?? []) snap.set(s.date, s);
  const snapFor = (b: Bucket) => snap.get(iso(pointAt(b, o.now)));

  const subs = d.purchases.filter(p => isSub(p));
  const activeCount = (t: number) => subs.reduce((n, p) => n + (paidActiveAt(p, t) ? 1 : 0), 0);
  const trialCount = (t: number) => subs.reduce((n, p) => n + (trialActiveAt(p, t) ? 1 : 0), 0);
  const mrrAt = (t: number) => Math.round(subs.reduce((n, p) => n + (paidActiveAt(p, t) ? monthlyMicros(p.priceMicros, p.currency, p.periodMonths, cur) : 0), 0));

  switch (name as ChartName) {
    case "active_subscriptions": {
      const series = bs.map(b => ({ date: b.date, value: snapFor(b)?.activeSubscriptions ?? activeCount(pointAt(b, o.now)) }));
      return res("count", series, { value: last(series) });
    }
    case "active_trials": {
      const series = bs.map(b => ({ date: b.date, value: snapFor(b)?.activeTrials ?? trialCount(pointAt(b, o.now)) }));
      return res("count", series, { value: last(series) });
    }
    case "mrr":
    case "arr": {
      const k = name === "arr" ? 12 : 1;
      const series = bs.map(b => ({ date: b.date, value: k * (snapFor(b)?.mrrMicros ?? mrrAt(pointAt(b, o.now))) }));
      return res("micros", series, { value: last(series) });
    }
    case "active_subscriptions_movement":
    case "mrr_movement": {
      const mrr = name === "mrr_movement";
      const rows = empty().map(r => ({ ...r, new: 0, reactivated: 0, churned: 0 }));
      const amount = (e: ChartEvent) => (mrr ? monthlyMicros(e.priceMicros, e.currency, e.periodMonths, cur) : 1);
      const { starts, churns } = subscriptionStarts(d.events);
      for (const { e, reactivation } of starts) { const i = indexOf(bs, e.at); if (i >= 0) rows[i][reactivation ? "reactivated" : "new"] += amount(e); }
      for (const e of churns) { const i = indexOf(bs, e.at); if (i >= 0) rows[i].churned -= amount(e); }
      const series = rows.map(r => {
        const out: ChartPoint = { date: r.date, value: 0, new: Math.round(r.new), reactivated: Math.round(r.reactivated), churned: Math.round(r.churned) };
        out.value = (out.new as number) + (out.reactivated as number) + (out.churned as number);
        return out;
      });
      const s = sumSummary(series, ["new", "reactivated", "churned", "value"]);
      return res(mrr ? "micros" : "count", series, { ...s, net: s.value },
        mrr ? "Expansion/contraction non suivies : un changement de produit est compté comme churn + nouveau." : undefined);
    }
    case "active_trials_movement": {
      const rows = empty().map(r => ({ ...r, new: 0, converted: 0, expired: 0, cancelled: 0 }));
      for (const e of d.events) {
        const i = indexOf(bs, e.at); if (i < 0) continue;
        if (e.type === "TRIAL_STARTED") rows[i].new++;
        else if (e.type === "TRIAL_CONVERTED") rows[i].converted--;
        else if (e.type === "EXPIRATION" && e.isTrial) rows[i].expired--;
        else if (e.type === "CANCELLATION" && e.isTrial) rows[i].cancelled++;
      }
      const series = rows.map(r => ({ ...r, value: r.new + r.converted + r.expired } as ChartPoint));
      return res("count", series, sumSummary(series, ["new", "converted", "expired", "cancelled", "value"]));
    }
    case "revenue":
    case "refunds":
    case "refund_rate":
    case "non_subscription_purchases": {
      const rows = empty().map(r => ({ ...r, revenue: 0, refunds: 0, transactions: 0, refundCount: 0 }));
      for (const t of d.txs) {
        if (name === "non_subscription_purchases" && (t.periodMonths ?? 0) > 0) continue;
        const i = indexOf(bs, t.at); if (i < 0) continue;
        if (t.amountMicrosProject < 0 || t.kind === "refund") { rows[i].refunds += Math.abs(t.amountMicrosProject); rows[i].refundCount++; }
        else { rows[i].revenue += t.amountMicrosProject; rows[i].transactions++; }
      }
      if (name === "revenue") {
        const series = rows.map(r => ({ date: r.date, value: r.revenue, revenue: r.revenue, refunds: r.refunds, net: r.revenue - r.refunds, transactions: r.transactions } as ChartPoint));
        return res("micros", series, sumSummary(series, ["value", "revenue", "refunds", "net", "transactions"]));
      }
      if (name === "refunds") {
        const series = rows.map(r => ({ date: r.date, value: r.refundCount, amount: r.refunds } as ChartPoint));
        return res("count", series, sumSummary(series, ["value", "amount"]));
      }
      if (name === "refund_rate") {
        const series = rows.map(r => ({ date: r.date, value: ratio(r.refunds, r.revenue), refunds: r.refunds, revenue: r.revenue } as ChartPoint));
        const s = sumSummary(series, ["refunds", "revenue"]);
        return res("ratio", series, { ...s, value: ratio(s.refunds, s.revenue) });
      }
      const series = rows.map(r => ({ date: r.date, value: r.transactions, revenue: r.revenue } as ChartPoint));
      return res("count", series, sumSummary(series, ["value", "revenue"]));
    }
    case "new_customers": {
      const series = empty().map(r => ({ ...r, value: 0 } as ChartPoint));
      for (const c of d.customers) { if (!c.firstSeenAt) continue; const i = indexOf(bs, c.firstSeenAt); if (i >= 0) (series[i].value as number)++; }
      return res("count", series, sumSummary(series, ["value"]));
    }
    case "conversion_to_paying":
    case "initial_conversion": {
      const days = Math.max(0, o.conversionDays ?? 7);
      const first = new Map<string, number>();
      if (name === "conversion_to_paying") {
        for (const t of [...d.txs].sort((a, b) => a.at - b.at)) if (t.amountMicrosProject > 0 && !first.has(t.appUserId)) first.set(t.appUserId, t.at);
      } else {
        for (const e of d.events) if (["INITIAL_PURCHASE", "TRIAL_STARTED", "NON_RENEWING_PURCHASE"].includes(e.type) && !first.has(e.appUserId)) first.set(e.appUserId, e.at);
      }
      const rows = empty().map(r => ({ ...r, customers: 0, converted: 0, immature: 0 }));
      for (const c of d.customers) {
        if (!c.firstSeenAt) continue;
        const i = indexOf(bs, c.firstSeenAt); if (i < 0) continue;
        rows[i].customers++;
        if (c.firstSeenAt + days * DAY > o.now) rows[i].immature++;
        const f = first.get(c.id);
        if (f !== undefined && f <= c.firstSeenAt + days * DAY) rows[i].converted++;
      }
      const series = rows.map(r => ({ ...r, value: ratio(r.converted, r.customers) } as ChartPoint));
      const s = sumSummary(series, ["customers", "converted", "immature"]);
      return res("ratio", series, { ...s, value: ratio(s.converted, s.customers), conversionDays: days });
    }
    case "trial_conversion_funnel":
    case "trial_conversion_rate":
    case "trial_cancellation_rate": {
      const key = (e: { appUserId: string; productId: string }) => `${e.appUserId}\u0000${e.productId}`;
      const after = (type: string, pred: (e: ChartEvent) => boolean = () => true) => {
        const m = new Map<string, number[]>();
        for (const e of d.events) if (e.type === type && pred(e)) (m.get(key(e)) ?? m.set(key(e), []).get(key(e))!).push(e.at);
        return (k: string, t: number) => (m.get(k) ?? []).some(x => x >= t);
      };
      const converted = after("TRIAL_CONVERTED");
      const cancelled = after("CANCELLATION", e => Boolean(e.isTrial));
      const activeNow = new Set(subs.filter(p => paidActiveAt(p, o.now)).map(key));
      const rows = empty().map(r => ({ ...r, started: 0, converted: 0, stillActive: 0, cancelled: 0, pending: 0 }));
      for (const e of d.events) {
        if (e.type !== "TRIAL_STARTED") continue;
        const i = indexOf(bs, e.at); if (i < 0) continue;
        const k = key(e), r = rows[i];
        r.started++;
        const conv = converted(k, e.at);
        if (conv) { r.converted++; if (activeNow.has(k)) r.stillActive++; }
        if (cancelled(k, e.at)) r.cancelled++;
        if (!conv && subs.some(p => key(p) === k && trialActiveAt(p, o.now))) r.pending++;
      }
      const field = name === "trial_cancellation_rate" ? "cancelled" : "converted";
      const series = rows.map(r => ({ ...r, value: ratio(r[field], r.started) } as ChartPoint));
      const s = sumSummary(series, ["started", "converted", "stillActive", "cancelled", "pending"]);
      return res("ratio", series, { ...s, value: ratio(s[field], s.started) });
    }
    case "subscription_retention": {
      // Monthly cohorts by first paid subscription payment; % of the cohort still paying k periods later.
      const periods = Math.min(36, Math.max(1, o.retentionPeriods ?? 12));
      const mIdx = (t: number) => { const x = new Date(t); return x.getUTCFullYear() * 12 + x.getUTCMonth(); };
      const subTx = d.txs.filter(t => (t.periodMonths ?? 0) > 0 && t.amountMicrosProject > 0).sort((a, b) => a.at - b.at);
      const firstPay = new Map<string, number>();
      for (const t of subTx) if (!firstPay.has(t.appUserId)) firstPay.set(t.appUserId, t.at);
      const cohorts = new Map<number, { size: number; active: Set<string>[] }>();
      for (const [, at] of firstPay) {
        if (at < bucketStart(o.start, "month") || at > o.end) continue;
        const c = cohorts.get(mIdx(at)) ?? cohorts.set(mIdx(at), { size: 0, active: [] }).get(mIdx(at))!;
        c.size++;
      }
      for (const t of subTx) {
        const f = firstPay.get(t.appUserId)!; const c = cohorts.get(mIdx(f)); if (!c) continue;
        const k = mIdx(t.at) - mIdx(f);
        const span = Math.max(1, Math.round(t.periodMonths ?? 1));
        for (let j = k; j < Math.min(periods, k + span); j++) if (j >= 0) (c.active[j] ??= new Set()).add(t.appUserId);
      }
      const nowIdx = mIdx(o.now);
      const series = [...cohorts.entries()].sort(([a], [b]) => a - b).map(([m, c]) => {
        const p: ChartPoint = { date: iso(Date.UTC(Math.floor(m / 12), m % 12, 1)), value: c.size, size: c.size };
        for (let k = 0; k < periods; k++) p[`p${k}`] = m + k > nowIdx ? null : (c.active[k]?.size ?? 0) / c.size;
        return p;
      });
      const summary: Record<string, number | null> = { cohorts: series.length, customers: series.reduce((a, p) => a + (p.size as number), 0) };
      for (let k = 0; k < periods; k++) {
        let num = 0, den = 0;
        for (const p of series) if (p[`p${k}`] !== null) { num += (p[`p${k}`] as number) * (p.size as number); den += p.size as number; }
        summary[`p${k}`] = ratio(num, den);
      }
      return res("ratio", series, summary, "value = taille de la cohorte ; pK = part encore abonnée K mois après le premier paiement.");
    }
    case "churn": {
      const { churns } = subscriptionStarts(d.events);
      const rows = empty().map(r => ({ ...r, churned: 0, activeAtStart: 0 }));
      bs.forEach((b, i) => { rows[i].activeAtStart = snap.get(iso(b.start - 1))?.activeSubscriptions ?? activeCount(b.start - 1); });
      for (const e of churns) { const i = indexOf(bs, e.at); if (i >= 0) rows[i].churned++; }
      const series = rows.map(r => ({ ...r, value: ratio(r.churned, r.activeAtStart + 0) } as ChartPoint));
      const s = sumSummary(series, ["churned"]);
      const avgBase = series.length ? series.reduce((a, p) => a + (p.activeAtStart as number), 0) / series.length : 0;
      return res("ratio", series, { churned: s.churned, value: ratio(s.churned / Math.max(1, series.length), avgBase) });
    }
    case "realized_ltv_per_customer":
    case "realized_ltv_per_paying_customer": {
      const revenueBy = new Map<string, number>();
      for (const t of d.txs) revenueBy.set(t.appUserId, (revenueBy.get(t.appUserId) ?? 0) + t.amountMicrosProject);
      const rows = empty().map(r => ({ ...r, customers: 0, payingCustomers: 0, revenue: 0 }));
      for (const c of d.customers) {
        if (!c.firstSeenAt) continue;
        const i = indexOf(bs, c.firstSeenAt); if (i < 0) continue;
        const rev = revenueBy.get(c.id) ?? 0;
        rows[i].customers++; rows[i].revenue += rev; if (rev > 0) rows[i].payingCustomers++;
      }
      const den = name === "realized_ltv_per_customer" ? "customers" : "payingCustomers";
      const ltv = (rev: number, n: number) => (n ? Math.round(rev / n) : null);
      const series = rows.map(r => ({ ...r, value: ltv(r.revenue, r[den]) } as ChartPoint));
      const s = sumSummary(series, ["customers", "payingCustomers", "revenue"]);
      return res("micros", series, { ...s, value: ltv(s.revenue, s[den]) });
    }
    case "subscription_status": {
      // Store state is only known as of now: historical points are reconstructed as active/expired only.
      const series = bs.map(b => {
        const t = pointAt(b, o.now), isNow = b.end > o.now;
        const p: ChartPoint = { date: b.date, value: 0, active: 0, grace: 0, billing_retry: 0, cancelled_active: 0, expired: 0 };
        for (const s of subs) {
          if (s.isTrial || s.purchasedAt > t) continue;
          if (endOf(s) <= t && !(isNow && (s.status === "grace" || s.status === "billing_retry"))) { (p.expired as number)++; continue; }
          if (isNow && s.status === "grace") (p.grace as number)++;
          else if (isNow && s.status === "billing_retry") (p.billing_retry as number)++;
          else if (isNow && s.willRenew === false) (p.cancelled_active as number)++;
          else (p.active as number)++;
        }
        p.value = (p.active as number) + (p.grace as number) + (p.billing_retry as number) + (p.cancelled_active as number);
        return p;
      });
      const lastP = series[series.length - 1] ?? { value: null };
      const { date: _d, ...summary } = lastP as ChartPoint;
      return res("count", series, summary, "Grace / relance de paiement / annulé-mais-actif ne sont connus que pour le point courant.");
    }
    case "paywall": {
      if (!data.paywallEvents) return res("ratio", bs.map(b => ({ date: b.date, value: null, impressions: 0, conversions: 0 })), { impressions: 0, conversions: 0, value: null, available: "false" }, "Aucun événement de paywall enregistré pour ce projet.");
      const rows = empty().map(r => ({ ...r, impressions: 0, purchaseStarts: 0, conversions: 0, closes: 0 }));
      for (const e of data.paywallEvents) {
        if (e.isSandbox) continue;
        const i = indexOf(bs, e.at); if (i < 0) continue;
        const ty = String(e.type).toLowerCase();
        if (ty === "impression") rows[i].impressions++;
        else if (ty === "purchase_start") rows[i].purchaseStarts++;
        else if (ty === "purchase") rows[i].conversions++;
        else if (ty === "close" || ty === "cancel") rows[i].closes++;
      }
      const series = rows.map(r => ({ ...r, value: ratio(r.conversions, r.impressions) } as ChartPoint));
      const s = sumSummary(series, ["impressions", "purchaseStarts", "conversions", "closes"]);
      return res("ratio", series, { ...s, value: ratio(s.conversions, s.impressions) });
    }
  }
  throw new Error("unknown_chart");
}

export function chartToCsv(r: ChartResult): string {
  const cols = ["date", "value", ...[...new Set(r.series.flatMap(p => Object.keys(p)))].filter(k => k !== "date" && k !== "value")];
  return [cols.join(","), ...r.series.map(p => cols.map(c => (p[c] ?? "") as string | number).join(","))].join("\n");
}
