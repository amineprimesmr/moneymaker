// Benchmarks anonymisés inter-projets.
//
// Job nocturne (index.ts → benchmarksNightly) : pour chaque projet éligible (≥ 30 clients payants hors sandbox,
// pas le projet démo), on calcule 7 KPI, ramenés en EUR pour les montants, puis on regroupe par
// catégorie App Store (primaryGenre de l'app suivie « own », sinon "all") et palier de prix.
// Seules les tables de percentiles (p10…p90) sont stockées, jamais les valeurs par projet,
// et un bucket n'est publié que s'il contient ≥ MIN_PROJECTS projets.
// Stockage : benchmarks/{metric}__{category}__{tier}.

export const BENCHMARK_METRICS = [
  "trial_conversion_rate", "monthly_churn", "refund_rate", "arppu", "realized_ltv_12m", "initial_conversion", "mrr_growth_30d",
] as const;
export type BenchmarkMetric = typeof BENCHMARK_METRICS[number];
/** Pour ces métriques, une valeur basse est meilleure. */
export const LOWER_IS_BETTER: ReadonlySet<BenchmarkMetric> = new Set(["monthly_churn", "refund_rate"]);
export const MIN_PROJECTS = 5;
export const MIN_PAYING_CUSTOMERS = 30;
export const EXCLUDED_PROJECTS = new Set(["demo-focus"]);
export const PERCENTILES = [10, 25, 50, 75, 90] as const;

export type Percentiles = { p10: number; p25: number; p50: number; p75: number; p90: number };
export type ProjectKpis = Partial<Record<BenchmarkMetric, number | null>>;
export interface ProjectSample { projectId: string; category: string; tier: string; kpis: ProjectKpis }
export interface BenchmarkBucket { metric: BenchmarkMetric; category: string; tier: string; n: number; percentiles: Percentiles }

/** Percentile par interpolation linéaire (méthode « R-7 », celle d'Excel PERCENTILE.INC). */
export function percentile(values: number[], p: number): number {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) throw new Error("empty");
  if (p <= 0) return v[0];
  if (p >= 100) return v[v.length - 1];
  const h = (v.length - 1) * (p / 100), lo = Math.floor(h), hi = Math.ceil(h);
  return v[lo] + (v[hi] - v[lo]) * (h - lo);
}

export function percentileTable(values: number[]): Percentiles {
  const [p10, p25, p50, p75, p90] = PERCENTILES.map(p => percentile(values, p));
  return { p10, p25, p50, p75, p90 };
}

/**
 * Rang percentile approximatif (0–100) d'une valeur, interpolé entre les points publiés
 * (on ne garde pas les valeurs brutes). Plafonné à [0, 100] par extrapolation bornée hors p10/p90.
 */
export function percentileRank(value: number, t: Percentiles): number {
  const pts: [number, number][] = [[t.p10, 10], [t.p25, 25], [t.p50, 50], [t.p75, 75], [t.p90, 90]];
  const eq = pts.filter(([v]) => v === value);
  if (eq.length > 1) return (eq[0][1] + eq[eq.length - 1][1]) / 2; // plateau : milieu des rangs couverts
  if (value <= pts[0][0]) {
    const w = pts[1][0] - pts[0][0];
    return w > 0 ? Math.max(0, 10 - ((pts[0][0] - value) / w) * 15) : value < pts[0][0] ? 0 : 10;
  }
  if (value >= pts[4][0]) {
    const w = pts[4][0] - pts[3][0];
    return w > 0 ? Math.min(100, 90 + ((value - pts[4][0]) / w) * 15) : value > pts[4][0] ? 100 : 90;
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, pa] = pts[i], [b, pb] = pts[i + 1];
    if (value >= a && value <= b) {
      if (b === a) return pa;
      return pa + ((value - a) / (b - a)) * (pb - pa);
    }
  }
  return 50;
}

/** Palier de prix à partir du revenu mensuel moyen par abonnement actif (EUR). */
export function priceTier(monthlyArpsEur: number | null | undefined): string {
  if (monthlyArpsEur == null || !Number.isFinite(monthlyArpsEur) || monthlyArpsEur <= 0) return "unknown";
  if (monthlyArpsEur < 3) return "lt3";
  if (monthlyArpsEur < 8) return "3to8";
  if (monthlyArpsEur < 15) return "8to15";
  return "gte15";
}

export const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "all";
export const bucketId = (metric: string, category: string, tier: string) => `${metric}__${slug(category)}__${tier}`;

/** Projet éligible au panel ? */
export function eligible(projectId: string, payingCustomers: number, sandboxOnly: boolean) {
  return !EXCLUDED_PROJECTS.has(projectId) && !sandboxOnly && payingCustomers >= MIN_PAYING_CUSTOMERS;
}

/**
 * Pure : regroupe les échantillons dans tous les buckets (catégorie × palier, catégorie × all, all × palier, all × all)
 * et ne publie que ceux qui ont ≥ minProjects valeurs.
 */
export function buildBenchmarks(samples: ProjectSample[], minProjects = MIN_PROJECTS): BenchmarkBucket[] {
  const groups = new Map<string, { metric: BenchmarkMetric; category: string; tier: string; values: number[] }>();
  for (const s of samples) {
    const cats = [...new Set([s.category || "all", "all"])], tiers = [...new Set([s.tier || "unknown", "all"])];
    for (const metric of BENCHMARK_METRICS) {
      const v = s.kpis[metric];
      if (v == null || !Number.isFinite(v)) continue;
      for (const category of cats) for (const tier of tiers) {
        if (tier === "unknown") continue;
        const k = bucketId(metric, category, tier);
        const g = groups.get(k) ?? { metric, category: category === "all" ? "all" : category, tier, values: [] };
        g.values.push(v);
        groups.set(k, g);
      }
    }
  }
  const out: BenchmarkBucket[] = [];
  for (const g of groups.values()) if (g.values.length >= minProjects) out.push({ metric: g.metric, category: g.category, tier: g.tier, n: g.values.length, percentiles: percentileTable(g.values) });
  return out;
}

/** Ordre de préférence des buckets pour un projet : le plus précis d'abord. */
export function bucketCandidates(category: string, tier: string): [string, string][] {
  const c: [string, string][] = [[category, tier], [category, "all"], ["all", tier], ["all", "all"]];
  const seen = new Set<string>();
  return c.filter(([a, b]) => { const k = `${a}|${b}`; if (b === "unknown" || seen.has(k)) return false; seen.add(k); return true; });
}

/** Pure : compare les KPI d'un projet aux buckets publiés. */
export function compareToBenchmarks(kpis: ProjectKpis, category: string, tier: string, published: Map<string, BenchmarkBucket>) {
  const metrics: Record<string, any> = {};
  for (const metric of BENCHMARK_METRICS) {
    const value = kpis[metric] ?? null;
    const b = bucketCandidates(category, tier).map(([c, t]) => published.get(bucketId(metric, c, t))).find(Boolean);
    if (!b) { metrics[metric] = { value, status: "insufficient_data", bucket: null }; continue; }
    const rank = value == null ? null : Math.round(percentileRank(value, b.percentiles));
    metrics[metric] = {
      value, status: "ok", bucket: { category: b.category, tier: b.tier, projects: b.n }, percentiles: b.percentiles,
      percentileRank: rank, higherIsBetter: !LOWER_IS_BETTER.has(metric),
      /** Rang « plus c'est haut, mieux c'est » (inversé pour churn et remboursements). */
      score: rank == null ? null : LOWER_IS_BETTER.has(metric) ? 100 - rank : rank,
    };
  }
  return metrics;
}

// ── Firestore ────────────────────────────────────────────────────────────────
const DAY = 86400000;

/** KPI d'un projet (montants en EUR micros) + catégorie + palier. */
export async function projectSample(project: import("./store").Project): Promise<ProjectSample & { payingCustomers: number; sandboxOnly: boolean }> {
  const { db } = await import("./store");
  const { projectMetrics } = await import("./metrics");
  const { projectChart } = await import("./chartsLoader");
  const { convertMicros } = await import("./engine");
  const cur = project.config.currency;
  const eur = (m: number | null | undefined) => (m == null ? null : convertMicros(m, cur, "EUR"));
  const m: any = await projectMetrics(project, 30);
  const [ltv, ic] = await Promise.all([
    projectChart(project, "realized_ltv_per_paying_customer", { days: 365, resolution: "month" }).catch(() => null),
    projectChart(project, "initial_conversion", { days: 60, resolution: "month" }).catch(() => null),
  ]);
  const hist: any[] = m.history ?? [];
  const old = hist.find(h => h.date <= new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10)) ?? hist[0];
  const mrrGrowth = old?.mrrMicros ? (m.mrrMicros - old.mrrMicros) / old.mrrMicros : null;
  // Sandbox seulement : aucune transaction réelle ; payingCustomers ignore déjà la sandbox.
  const sandboxOnly = !m.payingCustomers && !m.activeSubscriptions;
  return {
    projectId: project.id,
    category: await projectCategory(project, db),
    tier: priceTier(m.activeSubscriptions ? (eur(m.mrrMicros)! / m.activeSubscriptions) / 1e6 : null),
    payingCustomers: m.payingCustomers ?? 0, sandboxOnly,
    kpis: {
      trial_conversion_rate: m.trialConversionRate, monthly_churn: m.monthlyChurnRate, refund_rate: m.refundRate,
      arppu: m.payingCustomers ? eur(m.arppuMicros) : null,
      realized_ltv_12m: typeof ltv?.summary?.value === "number" ? eur(ltv.summary.value as number) : null,
      initial_conversion: typeof ic?.summary?.value === "number" ? (ic.summary.value as number) : null,
      mrr_growth_30d: mrrGrowth,
    },
  };
}

/** Catégorie : `config.category` explicite, sinon primaryGenre de l'app App Store « own » suivie, sinon "all". */
export async function projectCategory(project: import("./store").Project, db: FirebaseFirestore.Firestore): Promise<string> {
  const explicit = (project.config as any).category;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const apps = project.config.appStore?.apps ?? [];
  const own = apps.find(a => a.own) ?? apps[0];
  if (!own) return "all";
  const snap = await db.doc(`apps/${own.appId}`).get().catch(() => null);
  return (snap?.get("genreName") as string | undefined) || "all";
}

export async function runBenchmarks() {
  const { db, getProject } = await import("./store");
  const docs = (await db.collection("projects").select().get()).docs;
  const samples: ProjectSample[] = [];
  for (const d of docs) {
    if (EXCLUDED_PROJECTS.has(d.id)) continue;
    try {
      const s = await projectSample(await getProject(d.id));
      if (eligible(s.projectId, s.payingCustomers, s.sandboxOnly)) samples.push({ projectId: s.projectId, category: s.category, tier: s.tier, kpis: s.kpis });
    } catch (e) { console.error("benchmarks", d.id, (e as Error).message); }
  }
  const buckets = buildBenchmarks(samples);
  const now = Date.now();
  const keep = new Set(buckets.map(b => bucketId(b.metric, b.category, b.tier)));
  const writer = db.bulkWriter();
  for (const b of buckets) writer.set(db.doc(`benchmarks/${bucketId(b.metric, b.category, b.tier)}`), { ...b, updatedAt: now });
  // Un bucket qui passe sous le seuil n'est plus publié.
  for (const old of (await db.collection("benchmarks").select().get()).docs) if (!keep.has(old.id)) writer.delete(old.ref);
  await writer.close();
  return { projects: samples.length, buckets: buckets.length };
}

export async function projectBenchmarks(project: import("./store").Project) {
  const { db } = await import("./store");
  const s = await projectSample(project);
  const ids = BENCHMARK_METRICS.flatMap(metric => bucketCandidates(s.category, s.tier).map(([c, t]) => bucketId(metric, c, t)));
  const snaps = await db.getAll(...ids.map(id => db.doc(`benchmarks/${id}`)));
  const published = new Map<string, BenchmarkBucket>();
  let updatedAt: number | null = null;
  for (const sn of snaps) if (sn.exists) { published.set(sn.id, sn.data() as BenchmarkBucket); updatedAt = Math.max(updatedAt ?? 0, Number(sn.get("updatedAt") ?? 0)); }
  return {
    projectId: project.id, category: s.category, priceTier: s.tier, currency: "EUR",
    eligible: eligible(project.id, s.payingCustomers, s.sandboxOnly),
    metrics: compareToBenchmarks(s.kpis, s.category, s.tier, published),
    updatedAt,
  };
}
