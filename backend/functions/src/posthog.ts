// Lecture de PostHog : entonnoir (ouverture → onboarding → paywall → essai → achat), conversion
// du paywall, installation → payant, utilisateurs actifs et rétention, pour chaque business.
// La clé personnelle (lecture seule, droit « Query ») reste côté serveur dans les credentials.
// Les résultats sont mis en cache 10 minutes dans projects/{pid}/posthog/summary.

import { HttpError } from "./engine";
import { db } from "./store";

const TTL_MS = 10 * 60 * 1000;
export const POSTHOG_STEPS = ["open", "onboarding", "paywall", "trial", "purchase"] as const;
export type PosthogStep = (typeof POSTHOG_STEPS)[number];

export interface PosthogConfig {
  host: string;
  projectId: string;
  /** Événement PostHog pour chaque étape ; une étape absente est sautée. */
  events: Partial<Record<PosthogStep, string>>;
}

export interface PosthogSummary {
  days: number;
  funnel: { step: PosthogStep; event: string; users: number; medianSeconds: number | null }[];
  paywallConversion: number | null;
  installToPaid: number | null;
  dau: number;
  wau: number;
  mau: number;
  retentionD1: number | null;
  retentionD7: number | null;
  updatedAt: number;
}

const HOSTS: Record<string, string> = { eu: "https://eu.posthog.com", us: "https://us.posthog.com" };

export function sanitizePosthog(body: any, prev?: PosthogConfig): { config: PosthogConfig; apiKey?: string } {
  if (typeof body !== "object" || body === null) throw new HttpError(400, "invalid_posthog");
  const rawHost = String(body.host ?? prev?.host ?? "eu").trim();
  const host = HOSTS[rawHost] ?? rawHost.replace(/\/$/, "");
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(host)) throw new HttpError(400, "invalid_host", "Serveur PostHog invalide");
  const projectId = String(body.projectId ?? prev?.projectId ?? "").trim();
  if (!/^\d{1,12}$/.test(projectId)) throw new HttpError(400, "invalid_project_id", "L'identifiant du projet PostHog est un nombre");
  const events: PosthogConfig["events"] = { ...(prev?.events ?? {}) };
  if (body.events && typeof body.events === "object") {
    for (const s of POSTHOG_STEPS) if (s in body.events) {
      const e = body.events[s];
      if (e === null || e === "") delete events[s];
      else if (typeof e === "string" && e.length <= 200) events[s] = e;
    }
  }
  const apiKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : undefined;
  if (apiKey && !/^phx_[A-Za-z0-9]{20,}$/.test(apiKey)) throw new HttpError(400, "invalid_key", "La clé personnelle PostHog commence par phx_");
  return { config: { host, projectId, events }, apiKey };
}

async function query(cfg: PosthogConfig, apiKey: string, q: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${cfg.host}/api/projects/${cfg.projectId}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: q }),
  });
  if (r.status === 401 || r.status === 403) throw new HttpError(400, "posthog_unauthorized", "Clé PostHog refusée : il faut une clé personnelle avec le droit Query");
  if (r.status === 404) throw new HttpError(400, "posthog_project_not_found", "Projet PostHog introuvable");
  if (!r.ok) throw new HttpError(502, "posthog_error", `PostHog a répondu ${r.status}`);
  return r.json();
}

const hogql = (cfg: PosthogConfig, key: string, sql: string) => query(cfg, key, { kind: "HogQLQuery", query: sql }).then(r => (r.results ?? []) as any[][]);

/** Événements des 30 derniers jours, du plus fréquent au moins fréquent. */
export async function listEvents(cfg: PosthogConfig, apiKey: string): Promise<{ event: string; count: number }[]> {
  const rows = await hogql(cfg, apiKey,
    "SELECT event, count() AS c FROM events WHERE timestamp > now() - INTERVAL 30 DAY GROUP BY event ORDER BY c DESC LIMIT 300");
  return rows.map(([event, count]) => ({ event: String(event), count: Number(count) }));
}

const PATTERNS: Record<PosthogStep, RegExp[]> = {
  open: [/^\$?app[_ ]?(installed)$/i, /^application installed$/i, /^\$?app[_ ]?open(ed)?$/i, /^application opened$/i, /first[_ ]?open/i, /^\$screen$/i, /^\$pageview$/i],
  onboarding: [/onboarding.*(complete|finish|done|end)/i, /(complete|finish)(ed)?.*onboarding/i, /onboarding/i],
  paywall: [/paywall.*(view|show|open|present|seen|impression)/i, /(view|show|open|present)(ed)?.*paywall/i, /paywall/i],
  trial: [/trial.*(start|began)/i, /start(ed)?.*trial/i, /rc_trial_started/i],
  purchase: [/^(purchase|subscription)[_ ]?(completed?|success|succeeded|made)$/i, /rc_initial_purchase/i, /purchase/i, /subscri(be|bed|ption)/i, /paid/i],
};

/** Correspondance proposée pour chaque étape, d'après les noms d'événements. */
export function suggestMapping(events: { event: string }[]): PosthogConfig["events"] {
  const out: PosthogConfig["events"] = {};
  const used = new Set<string>();
  for (const step of POSTHOG_STEPS) {
    for (const re of PATTERNS[step]) {
      const hit = events.find(e => re.test(e.event) && !used.has(e.event));
      if (hit) { out[step] = hit.event; used.add(hit.event); break; }
    }
  }
  return out;
}

async function compute(cfg: PosthogConfig, apiKey: string, days: number): Promise<PosthogSummary> {
  const steps = POSTHOG_STEPS.filter(s => cfg.events[s]);
  const funnelP = steps.length >= 2
    ? query(cfg, apiKey, {
        kind: "FunnelsQuery",
        series: steps.map(s => ({ kind: "EventsNode", event: cfg.events[s], name: cfg.events[s] })),
        dateRange: { date_from: `-${days}d` },
        funnelsFilter: { funnelWindowInterval: 14, funnelWindowIntervalUnit: "day", funnelVizType: "steps" },
      }).then(r => (Array.isArray(r.results?.[0]) ? r.results[0] : r.results) as any[])
    : Promise.resolve([] as any[]);
  const activeP = hogql(cfg, apiKey, `SELECT
      uniqIf(person_id, timestamp > now() - INTERVAL 1 DAY),
      uniqIf(person_id, timestamp > now() - INTERVAL 7 DAY),
      uniq(person_id)
    FROM events WHERE timestamp > now() - INTERVAL 30 DAY`);
  // Rétention : parmi les personnes vues pour la première fois il y a 8 à 37 jours,
  // part de celles revenues au moins 1 jour (J1) / 7 jours (J7) après leur premier événement.
  const retentionP = hogql(cfg, apiKey, `SELECT
      countIf(last >= first + INTERVAL 1 DAY) / count(),
      countIf(last >= first + INTERVAL 7 DAY) / count()
    FROM (SELECT person_id, min(timestamp) AS first, max(timestamp) AS last
          FROM events WHERE timestamp > now() - INTERVAL 60 DAY GROUP BY person_id)
    WHERE first BETWEEN now() - INTERVAL 37 DAY AND now() - INTERVAL 8 DAY`);
  const [funnelRows, active, retention] = await Promise.all([funnelP, activeP, retentionP.catch(() => [[null, null]])]);

  const funnel = steps.map((step, i) => {
    const r = funnelRows[i] ?? {};
    return { step, event: cfg.events[step]!, users: Number(r.count ?? 0), medianSeconds: r.median_conversion_time ?? null };
  });
  const at = (s: PosthogStep) => funnel.find(f => f.step === s)?.users;
  const ratio = (a?: number, b?: number) => (a !== undefined && b !== undefined && a > 0 ? b / a : null);
  const num = (v: unknown) => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
  return {
    days,
    funnel,
    paywallConversion: ratio(at("paywall"), at("purchase")),
    installToPaid: ratio(at("open") ?? funnel[0]?.users, at("purchase")),
    dau: Number(active[0]?.[0] ?? 0), wau: Number(active[0]?.[1] ?? 0), mau: Number(active[0]?.[2] ?? 0),
    retentionD1: num(retention[0]?.[0]), retentionD7: num(retention[0]?.[1]),
    updatedAt: Date.now(),
  };
}

export async function posthogState(pid: string): Promise<{ config: PosthogConfig | null; apiKey: string | null }> {
  const [p, c] = await Promise.all([db.doc(`projects/${pid}`).get(), db.doc(`projects/${pid}/private/credentials`).get()]);
  return { config: (p.get("posthog") as PosthogConfig | undefined) ?? null, apiKey: (c.get("posthogRead.apiKey") as string | undefined) ?? null };
}

export async function posthogSummary(pid: string, force = false, days = 30): Promise<PosthogSummary | null> {
  const { config, apiKey } = await posthogState(pid);
  if (!config || !apiKey) return null;
  const ref = db.doc(`projects/${pid}/posthog/summary`);
  const cached = (await ref.get()).data() as PosthogSummary | undefined;
  if (!force && cached && cached.days === days && Date.now() - cached.updatedAt < TTL_MS) return cached;
  const fresh = await compute(config, apiKey, days);
  await ref.set(fresh);
  return fresh;
}

export const invalidatePosthog = (pid: string) => db.doc(`projects/${pid}/posthog/summary`).delete().catch(() => undefined);
