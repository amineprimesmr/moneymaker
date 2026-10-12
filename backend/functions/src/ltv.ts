// Prédiction de LTV par cohorte (produit / pays / store).
//
// 1. Pour chaque client d'un groupe : durée de vie observée en mois (D mois payés), et s'il est encore actif
//    (censuré à droite) ou parti (churn au mois D).
// 2. Ajustement d'un modèle shifted-beta-geometric (Fader & Hardie 2007) par maximum de vraisemblance avec
//    censure : hazard h_t = α / (α + β + t − 1), survie S(t) = Π (1 − h_k). Repli géométrique (hazard constant)
//    quand les données sont trop maigres ou que l'ajustement échoue.
// 3. LTV_H = revenu net par mois payé (remboursements déduits) × Σ_{t=0}^{H−1} S(t).
//
// Tout ce qui suit `predictLtv` est pur et testé (tests/ltv.test.cjs).

const DAY = 86400000;
export const MONTH = 30.44 * DAY;

export interface LtvPayment { customerId: string; group: string; at: number; amountMicros: number; periodMonths: number }
export interface Lifetime { duration: number; churned: boolean; paidMonths: number; revenueMicros: number; firstAt: number }
export interface ChurnParams { model: "sbg" | "geometric"; alpha?: number; beta?: number; monthlyChurn: number; logLikelihood: number }
export interface LtvGroup {
  key: string; customers: number; observedMonths: number; retentionCurve: number[]; predictedCurve: number[];
  churnParams: ChurnParams; arpuMonthMicros: number; ltv12: number; ltv24: number; confidence: "low" | "medium" | "high";
}

/** Durée de vie d'un client à partir de ses paiements (montants négatifs = remboursements). */
export function lifetimeOf(payments: LtvPayment[], now: number): Lifetime | null {
  const paid = payments.filter(p => p.amountMicros > 0).sort((a, b) => a.at - b.at);
  if (!paid.length) return null;
  const first = paid[0].at;
  let end = first;
  for (const p of paid) end = Math.max(end, p.at + Math.max(p.periodMonths > 0 ? p.periodMonths : 1, 0.25) * MONTH);
  const paidMonths = Math.max(1, Math.round((end - first) / MONTH));
  const revenueMicros = payments.reduce((a, p) => a + p.amountMicros, 0);
  const churned = end <= now;
  // Actif : on sait qu'il a survécu jusqu'au mois écoulé (censure). Parti : churn au mois paidMonths.
  const duration = churned ? paidMonths : Math.max(0, Math.floor((now - first) / MONTH));
  return { duration, churned, paidMonths, revenueMicros, firstAt: first };
}

/** Effectifs à risque / churns par mois t = 1..T (censure à droite). */
export function riskTable(lives: Lifetime[]) {
  const T = lives.reduce((a, l) => Math.max(a, l.duration), 0);
  const atRisk = new Array(T + 1).fill(0), churns = new Array(T + 1).fill(0);
  for (const l of lives) {
    for (let t = 1; t <= l.duration; t++) atRisk[t]++;
    if (l.churned && l.duration >= 1) churns[l.duration]++;
  }
  return { T, atRisk, churns };
}

/** Courbe de survie observée (Kaplan-Meier) : S(0) = 1. */
export function observedCurve(atRisk: number[], churns: number[]): number[] {
  const s = [1];
  for (let t = 1; t < atRisk.length; t++) { if (!atRisk[t]) break; s.push(s[t - 1] * (1 - churns[t] / atRisk[t])); }
  return s.map(v => Math.round(v * 10000) / 10000);
}

const sbgHazard = (a: number, b: number, t: number) => a / (a + b + t - 1);

export function sbgLogLik(a: number, b: number, atRisk: number[], churns: number[]) {
  let ll = 0;
  for (let t = 1; t < atRisk.length; t++) {
    if (!atRisk[t]) continue;
    const h = Math.min(1 - 1e-12, Math.max(1e-12, sbgHazard(a, b, t)));
    ll += churns[t] * Math.log(h) + (atRisk[t] - churns[t]) * Math.log(1 - h);
  }
  return ll;
}

/** MLE de (α, β) par recherche en grille log puis affinage par descente de coordonnées. */
export function fitSbg(atRisk: number[], churns: number[]): { alpha: number; beta: number; ll: number } | null {
  let best = { la: 0, lb: 0, ll: -Infinity };
  for (let la = -4; la <= 5; la += 0.5) for (let lb = -4; lb <= 7; lb += 0.5) {
    const ll = sbgLogLik(Math.exp(la), Math.exp(lb), atRisk, churns);
    if (ll > best.ll) best = { la, lb, ll };
  }
  for (let step = 0.25; step > 1e-4; step /= 2) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const [da, db] of [[step, 0], [-step, 0], [0, step], [0, -step], [step, step], [-step, -step]]) {
        const la = best.la + da, lb = best.lb + db;
        if (Math.abs(la) > 12 || Math.abs(lb) > 14) continue;
        const ll = sbgLogLik(Math.exp(la), Math.exp(lb), atRisk, churns);
        if (ll > best.ll + 1e-12) { best = { la, lb, ll }; improved = true; }
      }
    }
  }
  return Number.isFinite(best.ll) ? { alpha: Math.exp(best.la), beta: Math.exp(best.lb), ll: best.ll } : null;
}

export function fitGeometric(atRisk: number[], churns: number[]): ChurnParams {
  const r = atRisk.reduce((a, v) => a + v, 0), d = churns.reduce((a, v) => a + v, 0);
  // Lissage (prior faible, ~10 % de churn mensuel) pour éviter 0 % ou 100 % avec peu de données.
  const h = (d + 1) / (r + 10);
  const ll = atRisk.reduce((a, n, t) => t && n ? a + churns[t] * Math.log(h) + (n - churns[t]) * Math.log(1 - h) : a, 0);
  return { model: "geometric", monthlyChurn: round4(h), logLikelihood: round4(ll) };
}

/** Survie prédite S(0..H−1). */
export function predictedCurve(p: ChurnParams, months: number): number[] {
  const s = [1];
  for (let t = 1; t < months; t++) {
    const h = p.model === "sbg" ? sbgHazard(p.alpha!, p.beta!, t) : p.monthlyChurn;
    s.push(s[t - 1] * (1 - h));
  }
  return s;
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;

export function chooseModel(atRisk: number[], churns: number[]): ChurnParams {
  const geo = fitGeometric(atRisk, churns);
  const periods = atRisk.filter((n, t) => t && n > 0).length;
  const exposure = atRisk.reduce((a, v) => a + v, 0), events = churns.reduce((a, v) => a + v, 0);
  if (periods < 3 || exposure < 20 || events < 3) return geo;
  const sbg = fitSbg(atRisk, churns);
  if (!sbg) return geo;
  const h1 = sbgHazard(sbg.alpha, sbg.beta, 1);
  return { model: "sbg", alpha: round4(sbg.alpha), beta: round4(sbg.beta), monthlyChurn: round4(h1), logLikelihood: round4(sbg.ll) };
}

export function confidenceOf(customers: number, observedMonths: number): LtvGroup["confidence"] {
  if (customers >= 200 && observedMonths >= 6) return "high";
  if (customers >= 50 && observedMonths >= 3) return "medium";
  return "low";
}

/** Point d'entrée pur : paiements → prédiction par groupe, triée par nombre de clients. */
export function predictLtv(payments: LtvPayment[], now = Date.now()): LtvGroup[] {
  const byGroup = new Map<string, Map<string, LtvPayment[]>>();
  for (const p of payments) {
    if (!p.group || !p.customerId) continue;
    const g = byGroup.get(p.group) ?? new Map<string, LtvPayment[]>();
    (g.get(p.customerId) ?? g.set(p.customerId, []).get(p.customerId)!).push(p);
    byGroup.set(p.group, g);
  }
  const out: LtvGroup[] = [];
  for (const [key, customers] of byGroup) {
    const lives = [...customers.values()].map(ps => lifetimeOf(ps, now)).filter((l): l is Lifetime => !!l);
    if (!lives.length) continue;
    const { T, atRisk, churns } = riskTable(lives);
    const params = chooseModel(atRisk, churns);
    const paidMonths = lives.reduce((a, l) => a + l.paidMonths, 0);
    const revenue = lives.reduce((a, l) => a + l.revenueMicros, 0);
    const arpu = paidMonths ? Math.max(0, revenue / paidMonths) : 0;
    const curve = predictedCurve(params, 24);
    const sum = (h: number) => curve.slice(0, h).reduce((a, v) => a + v, 0);
    const retention = observedCurve(atRisk, churns);
    out.push({
      key, customers: lives.length, observedMonths: Math.max(0, retention.length - 1), retentionCurve: retention,
      predictedCurve: curve.map(round4), churnParams: params, arpuMonthMicros: Math.round(arpu),
      ltv12: Math.round(arpu * sum(12)), ltv24: Math.round(arpu * sum(24)), confidence: confidenceOf(lives.length, T),
    });
  }
  return out.sort((a, b) => b.customers - a.customers);
}
