// Détection d'anomalies (z-score sur 28 jours) et résumé hebdomadaire.
// Complète plan.ts/detectInsights (seuils fixes) : ici, chaque métrique est comparée à sa propre
// variabilité. Le job quotidien (index.ts › insightsDaily) écrit projects/{pid}/anomalies/{date}-{metric}
// et pousse via pushInsight + fanOut (Slack/Discord). Parties pures testées : tests/anomalies.test.cjs.

import { db, Project } from "./store";
import { anomalyText, weeklyText, money as fmtMoney } from "./i18n";
import { startOfDay } from "./push";

const DAY = 86400000;

// ── Jours civils ─────────────────────────────────────────────────────────────
// Les alertes comptent en jours du fuseau du business (Paris par défaut), pas en jours UTC : une vente à 0 h 30
// à Paris appartient à ce jour-là. Un jour civil est un entier (jours depuis 1970), insensible aux changements d'heure.

export const DEFAULT_TZ = "Europe/Paris";
export const projectTz = (config: any) => typeof config?.timezone === "string" && config.timezone ? config.timezone : DEFAULT_TZ;
const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** Jour civil d'un instant dans `tz`. */
export function civilDay(at: number, tz = "UTC"): number {
  if (tz === "UTC") return Math.floor(at / DAY);
  let f = dayFormats.get(tz);
  if (!f) dayFormats.set(tz, f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }));
  const [y, m, d] = f.format(new Date(at)).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY;
}

/** Instant où commence le jour civil `day` dans `tz`. */
export function civilDayStart(day: number, tz = "UTC"): number {
  if (tz === "UTC") return day * DAY;
  let t = day * DAY + 12 * 3600000;
  t += (day - civilDay(t, tz)) * DAY; // midi UTC peut tomber la veille ou le lendemain loin de Greenwich
  return startOfDay(tz, t);
}

/** Date AAAA-MM-JJ d'un jour civil. */
export const civilDate = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);

/** Première vente réelle du business : les jours d'avant ne comptent pas dans les moyennes (sinon elles sont diluées). */
export async function firstSaleAt(pid: string): Promise<number | null> {
  const snap = await db.collection(`projects/${pid}/transactions`).orderBy("at").limit(50).select("at", "isSandbox").get();
  const real = snap.docs.find(d => !d.get("isSandbox"));
  // Que des achats de test parmi les 50 premiers : l'historique réel commence au plus tôt après eux.
  return real ? Number(real.get("at")) : snap.size === 50 ? Number(snap.docs[49].get("at")) : null;
}

export const ANOMALY_METRICS = ["revenue", "newSubscriptions", "trials", "refunds", "billingIssues", "churn"] as const;
export type AnomalyMetric = typeof ANOMALY_METRICS[number];
/** Sens « mauvais » d'une hausse : pour les remboursements, une hausse est négative. */
const UP_IS_BAD: Record<AnomalyMetric, boolean> = { revenue: false, newSubscriptions: false, trials: false, refunds: true, billingIssues: true, churn: true };
/** Volume minimal (moyenne ou valeur du jour) sous lequel on ne signale rien : bruit des petits nombres. */
const MIN_VOLUME: Record<AnomalyMetric, number> = { revenue: 20e6, newSubscriptions: 3, trials: 3, refunds: 3, billingIssues: 3, churn: 3 };

export interface DayRow { revenue: number; newSubscriptions: number; trials: number; refunds: number; billingIssues: number; churn: number }
export interface Anomaly {
  metric: AnomalyMetric; date: string; value: number; mean: number; std: number; zScore: number;
  direction: "up" | "down"; severity: "warning" | "critical"; good: boolean; projectId: string; projectName: string;
  type: string; title: string; body: string; titleEn: string; bodyEn: string; at: number;
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
    const fmt = (lang: "fr" | "en", v: number) => metric === "revenue" ? fmtMoney(lang, v, currency, 0) : (Math.round(v * 10) / 10).toLocaleString(lang === "fr" ? "fr-FR" : "en-US");
    const fr = anomalyText("fr", metric, direction === "up", project.name, fmt("fr", value), fmt("fr", mean), z);
    const en = anomalyText("en", metric, direction === "up", project.name, fmt("en", value), fmt("en", mean), z);
    out.push({
      metric, date, value, mean: Math.round(mean * 100) / 100, std: Math.round(std * 100) / 100, zScore: Math.round(z * 100) / 100,
      direction, severity: Math.abs(z) >= threshold + 2 ? "critical" : "warning", good, projectId: project.id, projectName: project.name,
      type: `ANOMALY_${metric.toUpperCase()}_${direction.toUpperCase()}`,
      title: fr.title, body: fr.body, titleEn: en.title, bodyEn: en.body, at: now,
    });
  }
  return out;
}

export interface TxLite { at: number; amountMicrosProject?: number; isSandbox?: boolean; country?: string | null }
export interface EvLite { at: number; type: string; isTrial?: boolean; isSandbox?: boolean }

/** Pure : agrège transactions et événements en `days` lignes quotidiennes, à partir du jour civil de `start` dans `tz`. */
export function dailyRows(txs: TxLite[], events: EvLite[], start: number, days: number, tz = "UTC"): DayRow[] {
  const rows: DayRow[] = Array.from({ length: days }, () => ({ revenue: 0, newSubscriptions: 0, trials: 0, refunds: 0, billingIssues: 0, churn: 0 }));
  const first = civilDay(start, tz), idx = (t: number) => civilDay(t, tz) - first;
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
  revenueChange: number | null; mrrMicros: number; newSubscriptions: number; topCountry: string | null; title: string; body: string; titleEn: string; bodyEn: string }

/** Pure : semaine écoulée (7 jours civils dans `tz`) vs semaine d'avant. */
export function weeklySummary(project: { id: string; name: string }, txs: TxLite[], events: EvLite[], mrrMicros: number, currency: string, now = Date.now(), tz = "UTC"): WeeklySummary {
  const today = civilDay(now, tz);
  const end = civilDayStart(today, tz), start = civilDayStart(today - 7, tz), prevStart = civilDayStart(today - 14, tz);
  const cur = dailyRows(txs, events, start, 7, tz), prev = dailyRows(txs, events, prevStart, 7, tz);
  const revenue = cur.reduce((a, d) => a + d.revenue, 0), previous = prev.reduce((a, d) => a + d.revenue, 0);
  const newSubs = cur.reduce((a, d) => a + d.newSubscriptions, 0);
  const byCountry = new Map<string, number>();
  for (const t of txs) if (!t.isSandbox && t.at >= start && t.at < end && Number(t.amountMicrosProject) > 0)
    byCountry.set(t.country ?? "??", (byCountry.get(t.country ?? "??") ?? 0) + Number(t.amountMicrosProject));
  const top = [...byCountry.entries()].filter(([c]) => c !== "??").sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const change = previous > 0 ? (revenue - previous) / previous : null;
  const fr = weeklyText("fr", project.name, fmtMoney("fr", revenue, currency, 0), fmtMoney("fr", mrrMicros, currency, 0), change, newSubs, top);
  const en = weeklyText("en", project.name, fmtMoney("en", revenue, currency, 0), fmtMoney("en", mrrMicros, currency, 0), change, newSubs, top);
  return {
    projectId: project.id, projectName: project.name, currency, weekStart: civilDate(today - 7),
    revenueMicros: Math.round(revenue), previousRevenueMicros: Math.round(previous), revenueChange: change === null ? null : Math.round(change * 1000) / 1000,
    mrrMicros: Math.round(mrrMicros), newSubscriptions: newSubs, topCountry: top,
    title: fr.title, body: fr.body, titleEn: en.title, bodyEn: en.body,
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
  const cfg = (project.config as any).anomalies ?? {};
  if (cfg.enabled === false) return [];
  const tz = projectTz(project.config), today = civilDay(now, tz), from = today - 29;
  const [{ txs, events }, first] = await Promise.all([loadWindow(project.id, civilDayStart(from, tz), civilDayStart(today, tz)), firstSaleAt(project.id)]);
  const rows = dailyRows(txs, events, civilDayStart(from, tz), 29, tz);
  const y = rows.pop()!;
  // Jours d'avant la première vente : pas des zéros, de l'absence d'historique (detectAnomalies exige 14 jours).
  const history = first === null ? [] : rows.slice(Math.max(0, civilDay(first, tz) - from));
  return detectAnomalies(project, history, y, civilDate(today - 1), project.config.currency,
    { threshold: Number(cfg.threshold) >= 2 && Number(cfg.threshold) <= 6 ? Number(cfg.threshold) : 3, now });
}

export async function weeklySummaryForProject(project: Project, now = Date.now()): Promise<WeeklySummary> {
  const tz = projectTz(project.config), today = civilDay(now, tz);
  const { txs, events } = await loadWindow(project.id, civilDayStart(today - 14, tz), civilDayStart(today, tz));
  const last = await db.collection(`projects/${project.id}/daily`).orderBy("date", "desc").limit(1).get();
  return weeklySummary(project, txs, events, Number(last.docs[0]?.get("mrrMicros") ?? 0), project.config.currency, now, tz);
}
