import { Project, db } from "./store";
import { computeChart, ChartData, ChartFilters, Resolution, CHART_NAMES } from "./charts";
import { HttpError, Purchase } from "./engine";

const DAY = 86400000;
const LOOKBACK = 400 * DAY; // first-payment / prior-churn context before the window

/** Loads the collections a chart needs and runs the pure computation (charts.ts). */
export async function projectChart(project: Project, name: string, q: Record<string, unknown>) {
  // Graphiques publicitaires (ads.ts) : agrégats adDaily, pas de reconstruction depuis les achats.
  const { AD_CHART_NAMES, projectAdChart } = await import("./ads");
  if ((AD_CHART_NAMES as readonly string[]).includes(name)) return projectAdChart(project, name, q);
  if (!(CHART_NAMES as readonly string[]).includes(name)) throw new HttpError(404, "unknown_chart", `Graphiques : ${[...CHART_NAMES, ...AD_CHART_NAMES].join(", ")}`);
  const now = Date.now();
  const days = Math.min(1095, Math.max(1, Number(q.days ?? 30) || 30));
  const resolution: Resolution = q.resolution === "week" || q.resolution === "month" ? q.resolution : "day";
  const end = now, start = now - (days - 1) * DAY;
  const filters: ChartFilters = {
    ...(q.store ? { store: String(q.store) } : {}), ...(q.country ? { country: String(q.country).toUpperCase() } : {}),
    ...(q.product ? { product: String(q.product) } : {}),
  };
  const pid = project.id;
  const from = start - LOOKBACK;
  const [subsSnap, lifetimeSnap, txSnap, evSnap, custSnap, dailySnap, paywallSnap] = await Promise.all([
    db.collectionGroup("purchases").where("projectId", "==", pid).where("expiresAt", ">", start - DAY).get(),
    db.collectionGroup("purchases").where("projectId", "==", pid).where("expiresAt", "==", null).get(),
    db.collection(`projects/${pid}/transactions`).where("at", ">=", from).get(),
    db.collection(`projects/${pid}/events`).where("at", ">=", from).get(),
    db.collection(`projects/${pid}/customers`).where("firstSeenAt", ">=", start - 31 * DAY).select("firstSeenAt", "country").get(),
    db.collection(`projects/${pid}/daily`).where("date", ">=", new Date(start).toISOString().slice(0, 10)).get(),
    db.collection(`projects/${pid}/paywallEvents`).where("at", ">=", start - 31 * DAY).get().catch(() => null),
  ]);
  const data: ChartData = {
    purchases: [...subsSnap.docs, ...lifetimeSnap.docs].map(d => ({ ...(d.data() as Purchase), appUserId: d.get("appUserId") as string })),
    txs: txSnap.docs.map(d => d.data() as any),
    events: evSnap.docs.map(d => d.data() as any),
    customers: custSnap.docs.map(d => ({ id: d.id, firstSeenAt: d.get("firstSeenAt"), country: d.get("country") ?? null })),
    daily: dailySnap.docs.map(d => d.data() as any),
    paywallEvents: paywallSnap && !paywallSnap.empty ? paywallSnap.docs.map(d => d.data() as any) : null,
  };
  try {
    return {
      ...computeChart(name, data, {
        start, end, now, resolution, currency: project.config.currency, filters,
        conversionDays: q.conversionDays !== undefined ? Number(q.conversionDays) : undefined,
        retentionPeriods: q.periods !== undefined ? Number(q.periods) : undefined,
      }),
      days, filters,
    };
  } catch (e) { throw new HttpError(400, (e as Error).message); }
}
