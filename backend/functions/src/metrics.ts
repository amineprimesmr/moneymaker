import { computeMetrics, Purchase } from "./engine";
import { Project, db } from "./store";

const DAY = 86400000;
export const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

export async function projectMetrics(project: Project, days = 30) {
  const now = Date.now();
  const since = now - days * DAY;
  const [purchasesSnap, txSnap, eventsSnap, customersSnap, dailySnap] = await Promise.all([
    db.collectionGroup("purchases").where("projectId", "==", project.id).where("expiresAt", ">", now - 60 * DAY).get(),
    db.collection(`projects/${project.id}/transactions`).where("at", ">=", since).get(),
    db.collection(`projects/${project.id}/events`).where("at", ">=", since).get(),
    db.collection(`projects/${project.id}/customers`).where("firstSeenAt", ">=", since).count().get(),
    db.collection(`projects/${project.id}/daily`).orderBy("date", "desc").limit(days).get(),
  ]);
  // Lifetime purchases have expiresAt == null and are excluded by the range filter; fetch them separately.
  const lifetime = await db.collectionGroup("purchases").where("projectId", "==", project.id).where("expiresAt", "==", null).get();
  const purchases = [...purchasesSnap.docs, ...lifetime.docs].map(d => ({ ...(d.data() as Purchase), appUserId: d.get("appUserId") as string }));
  const current = computeMetrics(purchases, p => (p as any).appUserId, project.config.currency, now);

  const revenueByDay: Record<string, number> = {};
  let revenue = 0, refunds = 0;
  for (const d of txSnap.docs) {
    const t = d.data();
    if (t.isSandbox) continue;
    revenueByDay[dayKey(t.at)] = (revenueByDay[dayKey(t.at)] ?? 0) + t.amountMicrosProject;
    if (t.amountMicrosProject < 0) refunds += -t.amountMicrosProject; else revenue += t.amountMicrosProject;
  }
  const counts: Record<string, number> = {};
  for (const d of eventsSnap.docs) {
    if (d.get("isSandbox")) continue;
    counts[d.get("type")] = (counts[d.get("type")] ?? 0) + 1;
  }
  const started = (counts.TRIAL_STARTED ?? 0);
  const converted = (counts.TRIAL_CONVERTED ?? 0);
  const churned = (counts.EXPIRATION ?? 0);
  const base = current.activeSubscriptions + churned;

  return {
    projectId: project.id,
    name: project.name,
    ...current,
    periodDays: days,
    revenueMicros: revenue,
    refundsMicros: refunds,
    netRevenueMicros: revenue - refunds,
    newCustomers: customersSnap.data().count,
    newSubscriptions: (counts.INITIAL_PURCHASE ?? 0) + converted,
    trialsStarted: started,
    trialConversionRate: started ? converted / started : null,
    churnRate: base ? churned / base : null,
    eventCounts: counts,
    revenueByDay,
    history: dailySnap.docs.map(d => d.data()).reverse(),
    generatedAt: now,
  };
}

export async function snapshotProject(project: Project) {
  const m = await projectMetrics(project, 1);
  const date = dayKey(Date.now() - 60000);
  await db.doc(`projects/${project.id}/daily/${date}`).set({
    date, mrrMicros: m.mrrMicros, activeSubscriptions: m.activeSubscriptions, activeTrials: m.activeTrials,
    activeCustomers: m.activeCustomers, revenueMicros: m.revenueMicros, refundsMicros: m.refundsMicros, currency: m.currency,
  });
}
