// Détection d'anomalies (z-score sur 28 jours) et résumé hebdomadaire.
// Complète plan.ts/detectInsights (seuils fixes) : ici, chaque métrique est comparée à sa propre
// variabilité. Le job quotidien (index.ts › insightsDaily) écrit projects/{pid}/anomalies/{date}-{metric}
// et pousse via pushInsight + fanOut (Slack/Discord). Parties pures testées : tests/anomalies.test.cjs.

import { db, Project } from "./store";

const DAY = 86400000;

export const ANOMALY_METRICS = ["revenue", "newSubscriptions", "trials", "refunds", "billingIssues", "churn"] as const;
export type AnomalyMetric = typeof ANOMALY_METRICS[number];
/** Sens « mauvais » d'une hausse : pour les remboursements, une hausse est négative. */
const UP_IS_BAD: Record<AnomalyMetric, boolean> = { revenue: false, newSubscriptions: false, trials: false, refunds: true, billingIssues: true, churn: true };
const LABEL: Record<AnomalyMetric, string> = { revenue: "Revenu", newSubscriptions: "Nouveaux abonnés", trials: "Essais", refunds: "Remboursements", billingIssues: "Problèmes de paiement", churn: "Abonnements perdus" };
/** Volume minimal (moyenne ou valeur du jour) sous lequel on ne signale rien : bruit des petits nombres. */
const MIN_VOLUME: Record<AnomalyMetric, number> = { revenue: 20e6, newSubscriptions: 3, trials: 3, refunds: 3, billingIssues: 3, churn: 3 };

export interface DayRow { revenue: number; newSubscriptions: number; trials: number; refunds: number; billingIssues: number; churn: number }
export interface Anomaly {
  metric: AnomalyMetric; date: string; value: number; mean: number; std: number; zScore: number;
  direction: "up" | "down"; severity: "warning" | "critical"; good: boolean; projectId: string; projectName: string;
  type: string; title: string; body: string; at: number;
}

export function meanStd(xs: number[]) {
  const n = xs.length;
  if (!n) return { mean: 0, std: 0 };
  const mean = xs.reduce((a, v) => a + v, 0) / n;
  const std = Math.sqrt(xs.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, n - 1));
  return { mean, std };
}

/** Pure : `history` = 28 jours précédents (ordre indifférent), `yesterday` = le jour testé. */
export function detectAnomalies(project: { id: string; name: string }, history: DayRow[], yesterday: DayRow, date: string, currency: string,
  opts: { threshold?: number; now?: number } = {}): Anomaly[] {
  const threshold = opts.threshold ?? 3, now = opts.now ?? Date.now();
  if (history.length < 14) return [];
  const money = (v: number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency, maximumFractionDigits: 0 }).format(v / 1e6);
  const out: Anomaly[] = [];
  for (const metric of ANOMALY_METRICS) {
    const xs = history.map(d => d[metric] ?? 0), value = yesterday[metric] ?? 0;
    const { mean, std } = meanStd(xs);
    if (Math.max(mean, value) < MIN_VOLUME[metric]) continue;
    // Plancher d'écart-type (Poisson pour les comptages, 10 % de la moyenne pour le revenu) : une série plate ne doit pas exploser.
    const floor = metric === "revenue" ? Math.max(mean * 0.1, 5e6) : Math.max(Math.sqrt(Math.max(mean, 1)), 1);
    const z = (value - mean) / Math.max(std, floor);
    if (Math.abs(z) < threshold) continue;
    const direction = z > 0 ? "up" : "down";
    const good = (direction === "up") !== UP_IS_BAD[metric];
    const fmt = (v: number) => metric === "revenue" ? money(v) : (Math.round(v * 10) / 10).toString();
    const verb = direction === "up" ? "inhabituellement haut" : "inhabituellement bas";
    out.push({
      metric, date, value, mean: Math.round(mean * 100) / 100, std: Math.round(std * 100) / 100, zScore: Math.round(z * 100) / 100,
      direction, severity: Math.abs(z) >= threshold + 2 ? "critical" : "warning", good, projectId: project.id, projectName: project.name,
      type: `ANOMALY_${metric.toUpperCase()}_${direction.toUpperCase()}`,
      title: `${LABEL[metric]} ${verb} · ${project.name}`,
      body: `Hier ${fmt(value)} contre ${fmt(mean)} en moyenne sur 28 jours (z = ${z.toFixed(1)}).`, at: now,
    });
  }
  return out;
}

export interface TxLite { at: number; amountMicrosProject?: number; isSandbox?: boolean; country?: string | null }
export interface EvLite { at: number; type: string; isTrial?: boolean; isSandbox?: boolean }

/** Pure : agrège transactions et événements en lignes quotidiennes [start, start + days·DAY). */
export function dailyRows(txs: TxLite[], events: EvLite[], start: number, days: number): DayRow[] {
  const rows: DayRow[] = Array.from({ length: days }, () => ({ revenue: 0, newSubscriptions: 0, trials: 0, refunds: 0, billingIssues: 0, churn: 0 }));
  const idx = (t: number) => Math.floor((t - start) / DAY);
  for (const t of txs) {
    const i = idx(t.at); if (t.isSandbox || i < 0 || i >= days) continue;
    const v = Number(t.amountMicrosProject ?? 0); if (v > 0) rows[i].revenue += v;
  }
  for (const e of events) {
    const i = idx(e.at); if (e.isSandbox || i < 0 || i >= days) continue;
    if ((e.type === "INITIAL_PURCHASE" && !e.isTrial) || e.type === "TRIAL_CONVERTED") rows[i].newSubscriptions++;
    else if (e.type === "TRIAL_STARTED") rows[i].trials++;
    else if (e.type === "REFUND") rows[i].refunds++;
    else if (e.type === "BILLING_ISSUE") rows[i].billingIssues++;
    else if (e.type === "EXPIRATION") rows[i].churn++;
  }
  return rows;
}

export interface WeeklySummary { projectId: string; projectName: string; currency: string; weekStart: string; revenueMicros: number; previousRevenueMicros: number;
  revenueChange: number | null; mrrMicros: number; newSubscriptions: number; topCountry: string | null; title: string; body: string }

/** Pure : semaine écoulée (7 j) vs semaine d'avant. */
export function weeklySummary(project: { id: string; name: string }, txs: TxLite[], events: EvLite[], mrrMicros: number, currency: string, now = Date.now()): WeeklySummary {
  const end = Math.floor(now / DAY) * DAY, start = end - 7 * DAY, prevStart = start - 7 * DAY;
  const cur = dailyRows(txs, events, start, 7), prev = dailyRows(txs, events, prevStart, 7);
  const revenue = cur.reduce((a, d) => a + d.revenue, 0), previous = prev.reduce((a, d) => a + d.revenue, 0);
  const newSubs = cur.reduce((a, d) => a + d.newSubscriptions, 0);
  const byCountry = new Map<string, number>();
  for (const t of txs) if (!t.isSandbox && t.at >= start && t.at < end && Number(t.amountMicrosProject) > 0)
    byCountry.set(t.country ?? "??", (byCountry.get(t.country ?? "??") ?? 0) + Number(t.amountMicrosProject));
  const top = [...byCountry.entries()].filter(([c]) => c !== "??").sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const change = previous > 0 ? (revenue - previous) / previous : null;
  const money = (v: number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency, maximumFractionDigits: 0 }).format(v / 1e6);
  const wow = change === null ? "" : ` (${change >= 0 ? "+" : "−"}${Math.abs(Math.round(change * 100))} % vs semaine précédente)`;
  return {
    projectId: project.id, projectName: project.name, currency, weekStart: new Date(start).toISOString().slice(0, 10),
    revenueMicros: Math.round(revenue), previousRevenueMicros: Math.round(previous), revenueChange: change === null ? null : Math.round(change * 1000) / 1000,
    mrrMicros: Math.round(mrrMicros), newSubscriptions: newSubs, topCountry: top,
    title: `Ta semaine · ${project.name} : ${money(revenue)}`,
    body: [`Revenu ${money(revenue)}${wow}`, `MRR ${money(mrrMicros)}`, `${newSubs} nouvel${newSubs > 1 ? "s" : ""} abonné${newSubs > 1 ? "s" : ""}`, top ? `top pays ${top}` : ""].filter(Boolean).join(" · "),
  };
}

// ── Chargement Firestore ─────────────────────────────────────────────────────

async function loadWindow(pid: string, from: number, to: number) {
  const [tx, ev] = await Promise.all([
    db.collection(`projects/${pid}/transactions`).where("at", ">=", from).where("at", "<", to).select("amountMicrosProject", "isSandbox", "at", "country").get(),
    db.collection(`projects/${pid}/events`).where("at", ">=", from).where("at", "<", to).select("type", "isTrial", "isSandbox", "at").get(),
  ]);
  return { txs: tx.docs.map(d => d.data() as TxLite), events: ev.docs.map(d => d.data() as EvLite) };
}

export async function anomaliesForProject(project: Project, now = Date.now()): Promise<Anomaly[]> {
  const dayStart = Math.floor(now / DAY) * DAY, bStart = dayStart - 29 * DAY;
  const { txs, events } = await loadWindow(project.id, bStart, dayStart);
  const rows = dailyRows(txs, events, bStart, 29);
  const y = rows.pop()!;
  const cfg = (project.config as any).anomalies ?? {};
  if (cfg.enabled === false) return [];
  return detectAnomalies(project, rows, y, new Date(dayStart - DAY).toISOString().slice(0, 10), project.config.currency,
    { threshold: Number(cfg.threshold) >= 2 && Number(cfg.threshold) <= 6 ? Number(cfg.threshold) : 3, now });
}

export async function weeklySummaryForProject(project: Project, now = Date.now()): Promise<WeeklySummary> {
  const end = Math.floor(now / DAY) * DAY;
  const { txs, events } = await loadWindow(project.id, end - 14 * DAY, end);
  const last = await db.collection(`projects/${project.id}/daily`).orderBy("date", "desc").limit(1).get();
  return weeklySummary(project, txs, events, Number(last.docs[0]?.get("mrrMicros") ?? 0), project.config.currency, now);
}
