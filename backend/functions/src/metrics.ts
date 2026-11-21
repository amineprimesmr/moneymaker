import { computeMetrics, convertMicros, mrrMovements, Purchase } from "./engine";
import { Project, db } from "./store";
import { downloadsFor } from "./downloads";
import { installsFor } from "./store";

const DAY = 86400000;
/** Téléchargements affichés : chiffres Apple quand ils existent (J+1 à J+2), complétés en direct par les installations
 *  vues par le SDK pour les jours qu'Apple n'a pas encore publiés. Sans données Apple : installations seules. Pure, testée. */
export function mergeDownloads(
  apple: { total: number; byDay: Record<string, number>; byCountry: Record<string, number>; available: boolean },
  installs: { total: number; byDay: Record<string, number> },
) {
  const appleDays = Object.keys(apple.byDay).sort();
  const lastApple = appleDays[appleDays.length - 1];
  const byDay: Record<string, number> = { ...apple.byDay };
  let live = false;
  for (const [d, n] of Object.entries(installs.byDay)) if (!n) continue; else if (!lastApple || d > lastApple) { byDay[d] = n; live = true; }
  const total = Object.values(byDay).reduce((a, b) => a + b, 0);
  const available = apple.available || installs.total > 0;
  const source: "apple" | "live" | "mixed" | null = !available ? null : !apple.available ? "live" : live ? "mixed" : "apple";
  return { total, byDay, byCountry: apple.byCountry, available, source };
}

export const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
const monthKey = (t: number) => new Date(t).toISOString().slice(0, 7);
const ratio = (a: number, b: number) => (b ? a / b : null);

interface Tx { appUserId: string; store: string; productId: string; kind: string; amountMicrosProject: number; isSandbox?: boolean; country?: string | null; periodMonths?: number; at: number }
interface Ev { type: string; appUserId: string; productId: string; store: string; priceMicros?: number; currency?: string; periodMonths?: number; isSandbox?: boolean; isTrial?: boolean; wasRenewing?: boolean | null; country?: string | null; at: number }

/** Pure aggregation over one window of transactions/events — unit-tested. */
export function summarizeWindow(txs: Tx[], events: Ev[], currency: string, campaignOf: Record<string, string> = {}) {
  let revenue = 0, refunds = 0, newRevenue = 0, renewalRevenue = 0;
  const payers = new Set<string>();
  const revenueByDay: Record<string, number> = {}, revenueByCountry: Record<string, number> = {};
  const revenueByStore: Record<string, number> = {}, revenueByProduct: Record<string, number> = {};
  const revenueByCampaign: Record<string, number> = {}; // Apple Search Ads campaign id, "organic" otherwise
  const refundsByDay: Record<string, number> = {};
  for (const t of txs) {
    if (t.isSandbox) continue;
    const v = t.amountMicrosProject;
    // Les remboursements sont comptés à part : un jour ou un pays n'affiche jamais un revenu négatif.
    if (v < 0) { refunds += -v; refundsByDay[dayKey(t.at)] = (refundsByDay[dayKey(t.at)] ?? 0) - v; continue; }
    revenueByDay[dayKey(t.at)] = (revenueByDay[dayKey(t.at)] ?? 0) + v;
    const cc = t.country ?? "??";
    revenueByCountry[cc] = (revenueByCountry[cc] ?? 0) + v;
    revenueByStore[t.store] = (revenueByStore[t.store] ?? 0) + v;
    revenueByProduct[t.productId] = (revenueByProduct[t.productId] ?? 0) + v;
    const camp = campaignOf[t.appUserId] ?? "organic";
    revenueByCampaign[camp] = (revenueByCampaign[camp] ?? 0) + v;
    revenue += v;
    payers.add(t.appUserId);
    if (t.kind === "renewal") renewalRevenue += v; else newRevenue += v;
  }
  const counts: Record<string, number> = {};
  const trialsByProduct: Record<string, { started: number; converted: number }> = {};
  let newMrr = 0, churnedMrr = 0, paidExpirations = 0;
  const monthly = (e: Ev) => e.periodMonths ? convertMicros(e.priceMicros ?? 0, e.currency ?? currency, currency) / e.periodMonths : 0;
  for (const e of events) {
    if (e.isSandbox) continue;
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (e.type === "TRIAL_STARTED" || e.type === "TRIAL_CONVERTED") {
      trialsByProduct[e.productId] ??= { started: 0, converted: 0 };
      trialsByProduct[e.productId][e.type === "TRIAL_STARTED" ? "started" : "converted"]++;
    }
    if (e.type === "EXPIRATION" && !e.isTrial) paidExpirations++;
  }
  const moves = mrrMovements(events.filter(e => !e.isSandbox));
  for (const { e } of moves.starts) newMrr += monthly(e);
  for (const e of moves.churns) churnedMrr += monthly(e);
  return {
    revenueMicros: revenue, refundsMicros: refunds, netRevenueMicros: revenue - refunds,
    newRevenueMicros: newRevenue, renewalRevenueMicros: renewalRevenue,
    payingCustomers: payers.size, arppuMicros: payers.size ? Math.round(revenue / payers.size) : 0,
    refundRate: ratio(refunds, revenue),
    revenueByDay, refundsByDay, revenueByCountry, revenueByStore, revenueByProduct, revenueByCampaign,
    eventCounts: counts, trialsByProduct, paidExpirations,
    mrrMovement: { newMicros: Math.round(newMrr), churnedMicros: Math.round(churnedMrr), netMicros: Math.round(newMrr - churnedMrr) },
  };
}

/** `sinceAt` : début de période imposé (mois calendaire, depuis le 1er à minuit chez l'utilisateur).
 *  La période précédente est alors le mois d'avant, jusqu'au même jour. */
export async function projectMetrics(project: Project, days = 30, sinceAt?: number) {
  const now = Date.now();
  let since = now - days * DAY, prevSince = now - 2 * days * DAY;
  if (sinceAt && sinceAt < now && now - sinceAt <= 31 * DAY) {
    since = sinceAt;
    days = Math.max(1, Math.ceil((now - since) / DAY));
    const prevStart = new Date(since); prevStart.setUTCMonth(prevStart.getUTCMonth() - 1);
    prevSince = prevStart.getTime();
  }
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
  const ads = await import("./ads").then(a => a.adRevenueSince(pid, since)).catch(() => ({ revenueMicros: 0, impressions: 0 }));
  const [appleDl, inst] = await Promise.all([
    downloadsFor(pid, since).catch(() => ({ total: 0, byDay: {}, byCountry: {}, available: false })),
    installsFor(pid, since).catch(() => ({ total: 0, byDay: {}, byPlatform: {} })),
  ]);
  const dl = mergeDownloads(appleDl, inst);
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
  // Apple Search Ads campaigns resolved from AdServices tokens (see appleads.ts).
  const campaignOf: Record<string, string> = {};
  const attributed = await db.collection(`projects/${pid}/customers`).where("appleAds.attribution", "==", true).select("appleAds").get().catch(() => null);
  attributed?.docs.forEach(d => { const c = d.get("appleAds"); if (c?.campaignId) campaignOf[d.id] = `apple_ads:${c.campaignName ?? c.campaignId}`; });
  const cur = summarizeWindow(txs.filter(t => t.at >= since), evs.filter(e => e.at >= since), project.config.currency, campaignOf);
  const prev = summarizeWindow(txs.filter(t => t.at < since), evs.filter(e => e.at < since), project.config.currency, campaignOf);

  const started = cur.eventCounts.TRIAL_STARTED ?? 0, converted = cur.eventCounts.TRIAL_CONVERTED ?? 0;
  // Un essai gratuit qui se termine sans paiement n'est pas un abonné perdu : seules les expirations payantes comptent.
  const churned = cur.paidExpirations ?? cur.eventCounts.EXPIRATION ?? 0;
  const base = current.activeSubscriptions + churned;
  const churnRate = ratio(churned, base);
  const monthlyChurn = churnRate === null ? null : 1 - Math.pow(1 - churnRate, 30 / days);
  const arpsMonthly = current.renewingSubscriptions ? current.mrrMicros / current.renewingSubscriptions : 0; // MRR actif ÷ abonnés qui renouvellent

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
    /** Revenu publicitaire (ads.ts, devise du projet) et revenu « pub incluse ». */
    adRevenueMicros: ads.revenueMicros, adImpressions: ads.impressions,
    revenueInclAdsMicros: cur.revenueMicros + ads.revenueMicros, // ventes brutes + pub (remboursements à part)
    downloads: dl.available ? dl.total : null,
    downloadsByDay: dl.byDay,
    downloadsByCountry: dl.byCountry,
    /** "apple" (chiffres officiels), "live" (installations vues par le SDK), "mixed" (Apple, complété en direct depuis son dernier jour publié). */
    downloadsSource: dl.source,
    installs: inst.total, installsByDay: inst.byDay, installsByPlatform: inst.byPlatform,
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
  // DAU de la veille : clients vus (customers.lastSeenAt) dans les dernières 24 h — sert à l'ARPDAU (ads.ts).
  const dau = await db.collection(`projects/${project.id}/customers`).where("lastSeenAt", ">=", Date.now() - DAY).count().get().then(s => s.data().count).catch(() => null);
  await db.doc(`projects/${project.id}/daily/${date}`).set({
    date, mrrMicros: m.mrrMicros, activeSubscriptions: m.activeSubscriptions, activeTrials: m.activeTrials,
    activeCustomers: m.activeCustomers, revenueMicros: m.revenueMicros, refundsMicros: m.refundsMicros, currency: m.currency,
    totalCustomers: m.totalCustomers, ...(dau !== null ? { dau } : {}),
  });
}
