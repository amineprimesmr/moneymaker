import { computeMetrics, convertMicros, Purchase } from "./engine";
import { Project, db } from "./store";
import { downloadsFor } from "./downloads";

const DAY = 86400000;
export const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
const monthKey = (t: number) => new Date(t).toISOString().slice(0, 7);
const ratio = (a: number, b: number) => (b ? a / b : null);

interface Tx { appUserId: string; store: string; productId: string; kind: string; amountMicrosProject: number; isSandbox?: boolean; country?: string | null; periodMonths?: number; at: number }
interface Ev { type: string; appUserId: string; productId: string; store: string; priceMicros?: number; currency?: string; periodMonths?: number; isSandbox?: boolean; isTrial?: boolean; country?: string | null; at: number }

/** Pure aggregation over one window of transactions/events — unit-tested. */
export function summarizeWindow(txs: Tx[], events: Ev[], currency: string) {
  let revenue = 0, refunds = 0, newRevenue = 0, renewalRevenue = 0;
  const payers = new Set<string>();
  const revenueByDay: Record<string, number> = {}, revenueByCountry: Record<string, number> = {};
  const revenueByStore: Record<string, number> = {}, revenueByProduct: Record<string, number> = {};
  for (const t of txs) {
    if (t.isSandbox) continue;
    const v = t.amountMicrosProject;
    revenueByDay[dayKey(t.at)] = (revenueByDay[dayKey(t.at)] ?? 0) + v;
    const cc = t.country ?? "??";
    revenueByCountry[cc] = (revenueByCountry[cc] ?? 0) + v;
    revenueByStore[t.store] = (revenueByStore[t.store] ?? 0) + v;
    revenueByProduct[t.productId] = (revenueByProduct[t.productId] ?? 0) + v;
    if (v < 0) { refunds += -v; continue; }
    revenue += v;
    payers.add(t.appUserId);
    if (t.kind === "renewal") renewalRevenue += v; else newRevenue += v;
  }
  const counts: Record<string, number> = {};
  const trialsByProduct: Record<string, { started: number; converted: number }> = {};
  let newMrr = 0, churnedMrr = 0;
  const monthly = (e: Ev) => e.periodMonths ? convertMicros(e.priceMicros ?? 0, e.currency ?? currency, currency) / e.periodMonths : 0;
  for (const e of events) {
    if (e.isSandbox) continue;
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (e.type === "TRIAL_STARTED" || e.type === "TRIAL_CONVERTED") {
      trialsByProduct[e.productId] ??= { started: 0, converted: 0 };
      trialsByProduct[e.productId][e.type === "TRIAL_STARTED" ? "started" : "converted"]++;
    }
    if (e.type === "INITIAL_PURCHASE" || e.type === "TRIAL_CONVERTED" || e.type === "UNCANCELLATION") newMrr += monthly(e);
    if ((e.type === "EXPIRATION" || e.type === "REFUND" || e.type === "REVOKED") && !e.isTrial) churnedMrr += monthly(e);
  }
  return {
    revenueMicros: revenue, refundsMicros: refunds, netRevenueMicros: revenue - refunds,
    newRevenueMicros: newRevenue, renewalRevenueMicros: renewalRevenue,
    payingCustomers: payers.size, arppuMicros: payers.size ? Math.round(revenue / payers.size) : 0,
    refundRate: ratio(refunds, revenue),
    revenueByDay, revenueByCountry, revenueByStore, revenueByProduct,
    eventCounts: counts, trialsByProduct,
    mrrMovement: { newMicros: Math.round(newMrr), churnedMicros: Math.round(churnedMrr), netMicros: Math.round(newMrr - churnedMrr) },
  };
}

export async function projectMetrics(project: Project, days = 30) {
  const now = Date.now();
  const since = now - days * DAY, prevSince = now - 2 * days * DAY;
  const pid = project.id;
  const [purchasesSnap, lifetime, txSnap, eventsSnap, newCustomers, newCustomersPrev, totalCustomers, dailySnap] = await Promise.all([
    db.collectionGroup("purchases").where("projectId", "==", pid).where("expiresAt", ">", now - 60 * DAY).get(),
    db.collectionGroup("purchases").where("projectId", "==", pid).where("expiresAt", "==", null).get(),
    db.collection(`projects/${pid}/transactions`).where("at", ">=", prevSince).get(),
    db.collection(`projects/${pid}/events`).where("at", ">=", prevSince).get(),
    db.collection(`projects/${pid}/customers`).where("firstSeenAt", ">=", since).count().get(),
    db.collection(`projects/${pid}/customers`).where("firstSeenAt", ">=", prevSince).where("firstSeenAt", "<", since).count().get(),
    db.collection(`projects/${pid}/customers`).count().get(),
    db.collection(`projects/${pid}/daily`).orderBy("date", "desc").limit(Math.min(days, 400)).get(),
  ]);
  const dl = await downloadsFor(pid, since).catch(() => ({ total: 0, byDay: {}, byCountry: {}, available: false }));
  const purchases = [...purchasesSnap.docs, ...lifetime.docs].map(d => ({ ...(d.data() as Purchase), appUserId: d.get("appUserId") as string }));
  const current = computeMetrics(purchases, p => (p as any).appUserId, project.config.currency, now);

  const activeByCountry: Record<string, number> = {};
  for (const p of purchases) {
    if (p.isSandbox || p.type !== "subscription" || p.isTrial) continue;
    if (!(p.status === "active" || p.status === "grace") || (p.expiresAt !== null && p.expiresAt <= now)) continue;
    const cc = p.country ?? "??";
    activeByCountry[cc] = (activeByCountry[cc] ?? 0) + 1;
  }

  const txs = txSnap.docs.map(d => d.data() as Tx), evs = eventsSnap.docs.map(d => d.data() as Ev);
  const cur = summarizeWindow(txs.filter(t => t.at >= since), evs.filter(e => e.at >= since), project.config.currency);
  const prev = summarizeWindow(txs.filter(t => t.at < since), evs.filter(e => e.at < since), project.config.currency);

  const started = cur.eventCounts.TRIAL_STARTED ?? 0, converted = cur.eventCounts.TRIAL_CONVERTED ?? 0;
  const churned = cur.eventCounts.EXPIRATION ?? 0;
  const base = current.activeSubscriptions + churned;
  const churnRate = ratio(churned, base);
  const monthlyChurn = churnRate === null ? null : 1 - Math.pow(1 - churnRate, 30 / days);
  const arpsMonthly = current.activeSubscriptions ? current.mrrMicros / current.activeSubscriptions : 0;

  return {
    projectId: pid,
    name: project.name,
    ...current,
    periodDays: days,
    ...cur,
    activeByCountry,
    newCustomers: newCustomers.data().count,
    totalCustomers: totalCustomers.data().count,
    newSubscriptions: (cur.eventCounts.INITIAL_PURCHASE ?? 0) + converted,
    trialsStarted: started,
    trialConversionRate: ratio(converted, started),
    churnRate,
    monthlyChurnRate: monthlyChurn,
    arpuMicros: totalCustomers.data().count ? Math.round(cur.revenueMicros / totalCustomers.data().count) : 0,
    ltvMicros: monthlyChurn ? Math.round(arpsMonthly / monthlyChurn) : null,
    previous: {
      netRevenueMicros: prev.netRevenueMicros, revenueMicros: prev.revenueMicros, newCustomers: newCustomersPrev.data().count,
      newSubscriptions: (prev.eventCounts.INITIAL_PURCHASE ?? 0) + (prev.eventCounts.TRIAL_CONVERTED ?? 0),
      trialsStarted: prev.eventCounts.TRIAL_STARTED ?? 0, payingCustomers: prev.payingCustomers,
    },
    downloads: dl.available ? dl.total : null,
    downloadsByDay: dl.byDay,
    downloadsByCountry: dl.byCountry,
    /** Trials exist for this project (offer has a free trial or trials happened recently). */
    hasTrials: current.activeTrials > 0 || started > 0 || (prev.eventCounts.TRIAL_STARTED ?? 0) > 0,
    history: dailySnap.docs.map(d => d.data()).reverse(),
    generatedAt: now,
  };
}

/** Monthly cohorts by first payment: retention (share of payers paying again in month k) and cumulative revenue. */
export function buildCohorts(txs: Tx[], months = 12) {
  const firstPay = new Map<string, number>();
  const sorted = txs.filter(t => !t.isSandbox && t.amountMicrosProject > 0).sort((a, b) => a.at - b.at);
  for (const t of sorted) if (!firstPay.has(t.appUserId)) firstPay.set(t.appUserId, t.at);
  const idx = (k: string) => { const [y, m] = k.split("-").map(Number); return y * 12 + m; };
  const cohorts: Record<string, { size: number; active: Set<string>[]; revenue: number[] }> = {};
  for (const [user, at] of firstPay) {
    const c = (cohorts[monthKey(at)] ??= { size: 0, active: [], revenue: [] });
    c.size++;
  }
  for (const t of txs) {
    if (t.isSandbox) continue;
    const first = firstPay.get(t.appUserId);
    if (first === undefined) continue;
    const c = cohorts[monthKey(first)];
    const k = idx(monthKey(t.at)) - idx(monthKey(first));
    if (k < 0 || k >= months) continue;
    // A payment keeps the customer retained for every month its billing period covers (annual = 12).
    if (t.amountMicrosProject > 0) {
      const span = Math.max(1, Math.round(t.periodMonths ?? 1));
      for (let j = k; j < Math.min(months, k + span); j++) (c.active[j] ??= new Set()).add(t.appUserId);
    }
    c.revenue[k] = (c.revenue[k] ?? 0) + t.amountMicrosProject;
  }
  return Object.entries(cohorts).sort(([a], [b]) => a.localeCompare(b)).slice(-months).map(([month, c]) => {
    let cumulative = 0;
    return {
      month, size: c.size,
      retention: Array.from({ length: months }, (_, k) => (c.active[k] ? c.active[k].size / c.size : 0)),
      cumulativeRevenuePerUserMicros: Array.from({ length: months }, (_, k) => { cumulative += c.revenue[k] ?? 0; return Math.round(cumulative / c.size); }),
    };
  });
}

export async function projectCohorts(project: Project, months = 12) {
  const since = Date.now() - months * 31 * DAY;
  const snap = await db.collection(`projects/${project.id}/transactions`).where("at", ">=", since).get();
  return { currency: project.config.currency, cohorts: buildCohorts(snap.docs.map(d => d.data() as Tx), months) };
}

export async function snapshotProject(project: Project) {
  const m = await projectMetrics(project, 1);
  const date = dayKey(Date.now() - 60000);
  await db.doc(`projects/${project.id}/daily/${date}`).set({
    date, mrrMicros: m.mrrMicros, activeSubscriptions: m.activeSubscriptions, activeTrials: m.activeTrials,
    activeCustomers: m.activeCustomers, revenueMicros: m.revenueMicros, refundsMicros: m.refundsMicros, currency: m.currency,
    totalCustomers: m.totalCustomers,
  });
}
