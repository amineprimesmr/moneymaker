/**
 * Growth tools: remote paywalls, targeting rules, placements, A/B experiments.
 * Pure functions only (no Firestore) — unit-tested in tests/growth.test.cjs.
 *
 * Resolution order (documented in llms.txt):
 *   1. A running experiment on the placement (or on "default" for `current`) wins for every user with an appUserId:
 *      the user is deterministically assigned to a variant (sha256(appUserId + ":" + experimentId)), weights respected.
 *   2. Otherwise the first matching targeting rule (placement rules for a placement, global rules for `current`).
 *   3. Otherwise the placement's fixed offeringId, then config.currentOffering, then the first offering.
 */
import { createHash } from "crypto";
import { HttpError, cleanId } from "./engine";

export type Platform = "ios" | "android" | "web";
export interface Conditions {
  countries?: string[]; platforms?: Platform[]; appVersionMin?: string; appVersionMax?: string;
  attributes?: Record<string, string>; newCustomersOnly?: boolean;
}
export interface TargetingRule { id: string; name?: string; conditions: Conditions; offeringId: string }
export interface Placement { offeringId?: string; rules?: TargetingRule[] }
export interface Targeting { rules: TargetingRule[]; placements: Record<string, Placement> }
export interface Variant { id: string; offeringId: string; weight: number }
export interface Experiment {
  id: string; name: string; status: "draft" | "running" | "stopped"; placement?: string;
  variants: Variant[]; startedAt?: number; stoppedAt?: number;
}
export interface Context {
  appUserId?: string; platform?: string; appVersion?: string; country?: string;
  attributes?: Record<string, string>; isNewCustomer?: boolean;
}

// ── Paywall config ─────────────────────────────────────────────────────────
const TEMPLATES = ["stack", "cards", "minimal"];
const str = (v: unknown, max: number, code: string): string | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || v.length > max) throw new HttpError(400, code);
  return v;
};
const color = (v: unknown, code: string) => {
  const s = str(v, 9, code);
  if (s !== undefined && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s)) throw new HttpError(400, code, "Couleur #RRGGBB attendue");
  return s;
};
const url = (v: unknown, code: string) => {
  const s = str(v, 1000, code);
  if (s !== undefined && !/^https:\/\/\S+$/.test(s)) throw new HttpError(400, code, "URL https:// attendue");
  return s;
};
const compact = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

function paywallTexts(p: any) {
  if (p.features !== undefined && (!Array.isArray(p.features) || p.features.length > 12)) throw new HttpError(400, "invalid_paywall_features");
  if (p.footerLinks !== undefined && (!Array.isArray(p.footerLinks) || p.footerLinks.length > 6)) throw new HttpError(400, "invalid_paywall_footer_links");
  return compact({
    title: str(p.title, 200, "invalid_paywall_title"),
    subtitle: str(p.subtitle, 500, "invalid_paywall_subtitle"),
    cta: str(p.cta, 80, "invalid_paywall_cta"),
    features: p.features?.map((f: any) => {
      if (typeof f !== "object" || !f) throw new HttpError(400, "invalid_paywall_features");
      return compact({ icon: str(f.icon, 80, "invalid_paywall_feature_icon"), text: str(f.text, 200, "invalid_paywall_feature_text") ?? (() => { throw new HttpError(400, "invalid_paywall_feature_text"); })() });
    }),
    footerLinks: p.footerLinks?.map((l: any) => ({
      title: str(l?.title, 80, "invalid_paywall_footer_link") ?? (() => { throw new HttpError(400, "invalid_paywall_footer_link"); })(),
      url: url(l?.url, "invalid_paywall_footer_link") ?? (() => { throw new HttpError(400, "invalid_paywall_footer_link"); })(),
    })),
  });
}

export function sanitizePaywall(p: any) {
  if (p === null || p === undefined) return undefined;
  if (typeof p !== "object" || Array.isArray(p)) throw new HttpError(400, "invalid_paywall");
  const template = p.template ?? "stack";
  if (!TEMPLATES.includes(template)) throw new HttpError(400, "invalid_paywall_template", `template ∈ ${TEMPLATES.join(", ")}`);
  const closeDelay = p.closeDelay === undefined ? undefined : Number(p.closeDelay);
  if (closeDelay !== undefined && (!Number.isFinite(closeDelay) || closeDelay < 0 || closeDelay > 30)) throw new HttpError(400, "invalid_paywall_close_delay", "0–30 s");
  let localizations: Record<string, any> | undefined;
  if (p.localizations !== undefined) {
    if (typeof p.localizations !== "object" || Array.isArray(p.localizations) || Object.keys(p.localizations).length > 40) throw new HttpError(400, "invalid_paywall_localizations");
    localizations = Object.fromEntries(Object.entries<any>(p.localizations).map(([loc, v]) => {
      if (!/^[a-z]{2,3}([-_][A-Za-z0-9]{2,4})?$/.test(loc) || typeof v !== "object" || !v) throw new HttpError(400, "invalid_paywall_localizations");
      return [loc, paywallTexts(v)];
    }));
  }
  const c = p.colors ?? {};
  return compact({
    template,
    ...paywallTexts(p),
    heroImage: url(p.heroImage, "invalid_paywall_hero_image"),
    colors: compact({ background: color(c.background, "invalid_paywall_color"), accent: color(c.accent, "invalid_paywall_color"), text: color(c.text, "invalid_paywall_color") }),
    showCloseButton: p.showCloseButton === undefined ? true : Boolean(p.showCloseButton),
    closeDelay,
    localizations,
  });
}

/** Validates offerings (structure + optional paywall). */
export function sanitizeOfferings(input: any) {
  if (typeof input !== "object" || input === null || Array.isArray(input) || Object.keys(input).length > 50) throw new HttpError(400, "invalid_offerings");
  return Object.fromEntries(Object.entries<any>(input).map(([id, o]) => {
    if (typeof o !== "object" || !o || !Array.isArray(o.packages) || o.packages.length > 20) throw new HttpError(400, "invalid_offerings", `Offre ${id} : packages[] attendu`);
    const paywall = sanitizePaywall(o.paywall);
    return [cleanId(id, 64), compact({ ...o, paywall })];
  }));
}

// ── Targeting ──────────────────────────────────────────────────────────────
const PLATFORMS: Platform[] = ["ios", "android", "web"];
function sanitizeConditions(c: any): Conditions {
  if (c === undefined || c === null) return {};
  if (typeof c !== "object" || Array.isArray(c)) throw new HttpError(400, "invalid_conditions");
  const out: Conditions = {};
  if (c.countries?.length) {
    if (!Array.isArray(c.countries) || c.countries.some((x: any) => typeof x !== "string" || !/^[A-Za-z]{2}$/.test(x))) throw new HttpError(400, "invalid_countries", "Codes pays ISO à 2 lettres");
    out.countries = c.countries.map((x: string) => x.toUpperCase());
  }
  if (c.platforms?.length) {
    if (!Array.isArray(c.platforms) || c.platforms.some((x: any) => !PLATFORMS.includes(x))) throw new HttpError(400, "invalid_platforms", "ios | android | web");
    out.platforms = c.platforms;
  }
  for (const k of ["appVersionMin", "appVersionMax"] as const) if (c[k]) {
    if (typeof c[k] !== "string" || !/^\d+(\.\d+){0,3}$/.test(c[k])) throw new HttpError(400, "invalid_app_version", "Format 1.2.3");
    out[k] = c[k];
  }
  if (c.attributes && Object.keys(c.attributes).length) {
    if (typeof c.attributes !== "object" || Object.keys(c.attributes).length > 10) throw new HttpError(400, "invalid_attributes");
    out.attributes = Object.fromEntries(Object.entries(c.attributes).map(([k, v]) => [cleanId(k, 64), String(v).slice(0, 500)]));
  }
  if (c.newCustomersOnly) out.newCustomersOnly = true;
  return out;
}

function sanitizeRules(rules: any, offeringIds: Set<string>): TargetingRule[] {
  if (rules === undefined || rules === null) return [];
  if (!Array.isArray(rules) || rules.length > 50) throw new HttpError(400, "invalid_rules");
  return rules.map((r: any, i: number) => {
    const offeringId = cleanId(r?.offeringId, 64);
    if (!offeringIds.has(offeringId)) throw new HttpError(400, "unknown_offering", `Règle ${r?.name ?? i} : offre « ${offeringId} » inconnue`);
    return compact({ id: cleanId(String(r.id ?? `rule_${i}`), 64), name: str(r.name, 100, "invalid_rule_name"), conditions: sanitizeConditions(r.conditions), offeringId });
  });
}

export function sanitizeTargeting(t: any, offeringIds: Set<string>): Targeting {
  if (typeof t !== "object" || t === null || Array.isArray(t)) throw new HttpError(400, "invalid_targeting");
  const placements = t.placements ?? {};
  if (typeof placements !== "object" || Array.isArray(placements) || Object.keys(placements).length > 50) throw new HttpError(400, "invalid_placements");
  return {
    rules: sanitizeRules(t.rules, offeringIds),
    placements: Object.fromEntries(Object.entries<any>(placements).map(([id, p]) => {
      const pid = cleanId(id, 64);
      if (p?.offeringId && !offeringIds.has(p.offeringId)) throw new HttpError(400, "unknown_offering", `Placement ${pid} : offre « ${p.offeringId} » inconnue`);
      return [pid, compact({ offeringId: p?.offeringId || undefined, rules: p?.rules?.length ? sanitizeRules(p.rules, offeringIds) : undefined })];
    })),
  };
}

/** Compares dotted versions: -1, 0, 1. "1.10" > "1.9". */
export function compareVersions(a: string, b: string) {
  const pa = a.split(".").map(n => parseInt(n, 10) || 0), pb = b.split(".").map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** A condition that needs context the caller did not send does NOT match (safe default). */
export function matchConditions(c: Conditions, ctx: Context): boolean {
  if (c.countries?.length && (!ctx.country || !c.countries.includes(ctx.country.toUpperCase()))) return false;
  if (c.platforms?.length && (!ctx.platform || !c.platforms.includes(ctx.platform as Platform))) return false;
  if (c.appVersionMin && (!ctx.appVersion || compareVersions(ctx.appVersion, c.appVersionMin) < 0)) return false;
  if (c.appVersionMax && (!ctx.appVersion || compareVersions(ctx.appVersion, c.appVersionMax) > 0)) return false;
  if (c.attributes) for (const [k, v] of Object.entries(c.attributes)) if (ctx.attributes?.[k] !== v) return false;
  if (c.newCustomersOnly && ctx.isNewCustomer !== true) return false;
  return true;
}

export const firstMatch = (rules: TargetingRule[] | undefined, ctx: Context) => rules?.find(r => matchConditions(r.conditions, ctx));

// ── Experiments ────────────────────────────────────────────────────────────
export function sanitizeExperiments(list: any, offeringIds: Set<string>, previous: Experiment[] = [], now = Date.now()): Experiment[] {
  if (!Array.isArray(list) || list.length > 50) throw new HttpError(400, "invalid_experiments");
  const prev = new Map(previous.map(e => [e.id, e]));
  const out = list.map((e: any): Experiment => {
    const id = cleanId(e?.id, 64);
    const status = e.status ?? "draft";
    if (!["draft", "running", "stopped"].includes(status)) throw new HttpError(400, "invalid_experiment_status");
    if (!Array.isArray(e.variants) || e.variants.length < 2 || e.variants.length > 5) throw new HttpError(400, "invalid_variants", `Expérience ${id} : 2 à 5 variantes`);
    const variants = e.variants.map((v: any) => {
      const offeringId = cleanId(v?.offeringId, 64);
      if (!offeringIds.has(offeringId)) throw new HttpError(400, "unknown_offering", `Expérience ${id} : offre « ${offeringId} » inconnue`);
      const weight = Number(v.weight ?? 1);
      if (!Number.isFinite(weight) || weight < 0 || weight > 1000) throw new HttpError(400, "invalid_weight");
      return { id: cleanId(v.id, 64), offeringId, weight };
    });
    if (new Set(variants.map((v: Variant) => v.id)).size !== variants.length) throw new HttpError(400, "duplicate_variant");
    if (!variants.some((v: Variant) => v.weight > 0)) throw new HttpError(400, "invalid_weight", "Au moins un poids > 0");
    const before = prev.get(id);
    // Variants of a running/stopped experiment are frozen (changing them would corrupt results).
    if (before && before.status !== "draft" && JSON.stringify(before.variants) !== JSON.stringify(variants)) throw new HttpError(400, "experiment_locked", `Expérience ${id} : variantes figées une fois lancée`);
    if (before?.status === "stopped" && status !== "stopped") throw new HttpError(400, "experiment_stopped", `Expérience ${id} : terminée, crée-en une nouvelle`);
    const placement = e.placement && e.placement !== "default" ? cleanId(e.placement, 64) : undefined;
    return compact({
      id, name: str(e.name, 100, "invalid_experiment_name") ?? id, status, placement, variants,
      startedAt: status === "draft" ? undefined : before?.startedAt ?? (typeof e.startedAt === "number" ? e.startedAt : now),
      stoppedAt: status === "stopped" ? before?.stoppedAt ?? now : undefined,
    });
  });
  if (new Set(out.map(e => e.id)).size !== out.length) throw new HttpError(400, "duplicate_experiment");
  const running = out.filter(e => e.status === "running").map(e => e.placement ?? "default");
  if (new Set(running).size !== running.length) throw new HttpError(400, "experiment_conflict", "Une seule expérience active par placement");
  return out;
}

/** Uniform float in [0,1) from sha256(appUserId:experimentId) — stable across devices and releases. */
export function bucket(appUserId: string, experimentId: string) {
  return parseInt(createHash("sha256").update(`${appUserId}:${experimentId}`).digest("hex").slice(0, 13), 16) / 2 ** 52;
}

export function assignVariant(appUserId: string, exp: Pick<Experiment, "id" | "variants">): Variant {
  const total = exp.variants.reduce((s, v) => s + v.weight, 0);
  let x = bucket(appUserId, exp.id) * total;
  for (const v of exp.variants) { if (x < v.weight) return v; x -= v.weight; }
  const pos = exp.variants.filter(v => v.weight > 0); return pos[pos.length - 1];
}

// ── Resolution ─────────────────────────────────────────────────────────────
export interface Resolution {
  current: string | null;
  placements: Record<string, string | null>;
  experiments: { experimentId: string; variant: string; placement: string; offeringId: string }[];
}

export function resolveOfferings(
  config: { offerings: Record<string, unknown>; currentOffering?: string; targeting?: Targeting; experiments?: Experiment[] },
  ctx: Context,
): Resolution {
  const exists = (id?: string) => (id && config.offerings[id] ? id : undefined);
  const experiments: Resolution["experiments"] = [];
  const fromExperiment = (placement: string) => {
    if (!ctx.appUserId) return undefined;
    const exp = config.experiments?.find(e => e.status === "running" && (e.placement ?? "default") === placement);
    if (!exp) return undefined;
    const v = assignVariant(ctx.appUserId, exp);
    if (!exists(v.offeringId)) return undefined;
    experiments.push({ experimentId: exp.id, variant: v.id, placement, offeringId: v.offeringId });
    return v.offeringId;
  };
  const fallback = exists(config.currentOffering) ?? Object.keys(config.offerings)[0] ?? null;
  const current = fromExperiment("default") ?? exists(firstMatch(config.targeting?.rules, ctx)?.offeringId) ?? fallback;
  const placements = Object.fromEntries(Object.entries(config.targeting?.placements ?? {}).map(([id, p]) => [id,
    fromExperiment(id) ?? exists(firstMatch(p.rules, ctx)?.offeringId) ?? exists(p.offeringId) ?? current]));
  return { current, placements, experiments };
}

// ── Results statistics ─────────────────────────────────────────────────────
export interface VariantInput { id: string; offeringId: string; enrolled: number; impressions: number; conversions: number; revenueMicros: number }

const normCdf = (x: number) => {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
};

/**
 * Probability that each variant has the best conversion rate.
 * Posterior Beta(1 + conversions, 1 + enrolled − conversions), approximated by a normal, integrated numerically:
 * P(i best) = ∫ φ_i(x) Π_{j≠i} Φ_j(x) dx.
 */
export function probabilityToBeBest(vs: { enrolled: number; conversions: number }[]): number[] {
  const post = vs.map(v => {
    const a = 1 + v.conversions, b = 1 + Math.max(0, v.enrolled - v.conversions);
    return { m: a / (a + b), s: Math.max(1e-6, Math.sqrt(a * b / ((a + b) ** 2 * (a + b + 1)))) };
  });
  const lo = Math.min(...post.map(p => p.m - 6 * p.s)), hi = Math.max(...post.map(p => p.m + 6 * p.s));
  const steps = 4000, dx = (hi - lo) / steps;
  const raw = post.map((pi, i) => {
    let sum = 0;
    for (let k = 0; k <= steps; k++) {
      const x = lo + k * dx, z = (x - pi.m) / pi.s;
      let prod = Math.exp(-z * z / 2) / (pi.s * Math.sqrt(2 * Math.PI));
      for (let j = 0; j < post.length; j++) if (j !== i) prod *= normCdf((x - post[j].m) / post[j].s);
      sum += prod * dx;
    }
    return sum;
  });
  const total = raw.reduce((s, x) => s + x, 0) || 1;
  return raw.map(x => x / total);
}

export function experimentStats(variants: VariantInput[]) {
  const p = probabilityToBeBest(variants);
  return variants.map((v, i) => ({
    ...v,
    conversionRate: v.enrolled ? v.conversions / v.enrolled : 0,
    impressionConversionRate: v.impressions ? v.conversions / v.impressions : null,
    arpuMicros: v.enrolled ? Math.round(v.revenueMicros / v.enrolled) : 0,
    probabilityToBeBest: p[i],
  }));
}

/**
 * Attributes transactions to variants: only transactions by enrolled users at/after their enrollment, non-sandbox.
 * conversions = distinct users with at least one "purchase"; revenue = net (purchases + renewals − refunds).
 */
export function aggregateResults(
  variants: Variant[],
  enrollments: { appUserId: string; variant: string; at: number }[],
  transactions: { appUserId: string; at: number; kind: string; amountMicrosProject?: number; isSandbox?: boolean }[],
  impressions: Record<string, number> = {},
) {
  const byUser = new Map(enrollments.map(e => [e.appUserId, e]));
  const acc = new Map(variants.map(v => [v.id, { enrolled: 0, conv: new Set<string>(), revenue: 0 }]));
  for (const e of enrollments) { const a = acc.get(e.variant); if (a) a.enrolled++; }
  for (const t of transactions) {
    const e = byUser.get(t.appUserId);
    if (!e || t.isSandbox || t.at < e.at) continue;
    const a = acc.get(e.variant);
    if (!a) continue;
    if (t.kind === "purchase") a.conv.add(t.appUserId);
    a.revenue += t.amountMicrosProject ?? 0;
  }
  return experimentStats(variants.map(v => {
    const a = acc.get(v.id)!;
    return { id: v.id, offeringId: v.offeringId, enrolled: a.enrolled, impressions: impressions[v.id] ?? 0, conversions: a.conv.size, revenueMicros: a.revenue };
  }));
}

export const PAYWALL_EVENT_TYPES = ["impression", "close", "purchase_start", "purchase", "cancel"];
