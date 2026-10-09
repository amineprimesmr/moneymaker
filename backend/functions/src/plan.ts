// Pilotage financier : ce qu'il faut mettre de côté, quand l'argent arrive, échéances,
// dépenses réelles, objectif de MRR, alertes intelligentes et export comptable.
//
// Repères (modifiables dans les réglages finance, indicatifs, pas un conseil fiscal) :
//   • Apple verse les « proceeds » d'un mois fiscal ≈ 33 jours après sa fin.
//   • Google Play verse les gains d'un mois vers le 15 du mois suivant.
//   • Stripe verse en continu, avec un délai glissant (7 jours par défaut en France).
//   • Échéances FR : URSSAF micro (fin du mois suivant), acomptes d'IS (15/03, 15/06, 15/09, 15/12),
//     TVA OSS sur les ventes Stripe UE (fin du mois qui suit chaque trimestre).

import { db } from "./store";
import { convertMicros } from "./engine";
import { computeWaterfall, financeSettings, FinanceSettings, Tx, VAT } from "./finance";

const DAY = 86400000;

// ── Dépenses réelles ────────────────────────────────────────────────────────

export interface Expense { id: string; name: string; amountMicros: number; currency: string; every: "month" | "year"; projectId?: string | null; category?: string }

export function sanitizeExpense(id: string, b: any): Expense {
  const name = String(b?.name ?? "").trim().slice(0, 80);
  const amount = Number(b?.amount);
  if (!name) throw new Error("name_required");
  if (!Number.isFinite(amount) || amount < 0 || amount > 1e7) throw new Error("invalid_amount");
  const currency = typeof b?.currency === "string" && /^[A-Z]{3}$/.test(b.currency) ? b.currency : "EUR";
  return { id, name, amountMicros: Math.round(amount * 1e6), currency, every: b?.every === "year" ? "year" : "month",
    projectId: typeof b?.projectId === "string" ? b.projectId : null, category: typeof b?.category === "string" ? b.category.slice(0, 40) : undefined };
}

export async function expensesFor(uid: string): Promise<Expense[]> {
  return (await db.collection(`users/${uid}/expenses`).get()).docs.map(d => ({ ...(d.data() as Expense), id: d.id }));
}

/** Dépenses ramenées à une période de `days` jours, pour les business affichés. Pure. */
export function expensesOverPeriod(list: Expense[], days: number, currency: string, projectIds?: string[]) {
  return Math.round(list.filter(e => !projectIds?.length || !e.projectId || projectIds.includes(e.projectId))
    .reduce((a, e) => a + convertMicros(e.amountMicros, e.currency, currency) * (e.every === "year" ? days / 365 : days / 30.44), 0));
}

// ── Versements attendus ─────────────────────────────────────────────────────

export interface Payout { store: string; date: number; amountMicros: number; label: string }

/** Pure : regroupe les transactions encore non versées en virements à venir — unit-tested. */
export function upcomingPayouts(txs: Tx[], s: FinanceSettings, currency: string, now = Date.now(), stripeDelayDays = 7): Payout[] {
  const buckets = new Map<string, Payout>();
  for (const t of txs) {
    if (t.isSandbox) continue;
    const w = computeWaterfall([t], s, currency, 30);
    const net = w.netRevenueMicros + (t.store === "stripe" ? w.vatMicros : 0); // Stripe verse la TVA avec le reste (à reverser ensuite)
    const d = new Date(t.at);
    let date: number, key: string, label: string;
    if (t.store === "app_store") {
      const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      date = end + 33 * DAY; key = `app_store|${end}`; label = `Apple · ventes de ${d.toLocaleDateString("fr-FR", { month: "long", timeZone: "UTC" })}`;
    } else if (t.store === "play_store") {
      date = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 15); key = `play_store|${date}`; label = `Google Play · ventes de ${d.toLocaleDateString("fr-FR", { month: "long", timeZone: "UTC" })}`;
    } else if (t.store === "stripe") {
      const day = Math.floor(t.at / DAY) * DAY + stripeDelayDays * DAY;
      date = day; key = `stripe|${day}`; label = "Stripe";
    } else continue;
    if (date < now - DAY) continue; // déjà versé
    const p = buckets.get(key) ?? { store: t.store, date, amountMicros: 0, label };
    p.amountMicros += net;
    buckets.set(key, p);
  }
  return [...buckets.values()].map(p => ({ ...p, amountMicros: Math.round(p.amountMicros) })).filter(p => p.amountMicros > 0).sort((a, b) => a.date - b.date);
}

// ── Échéances fiscales ──────────────────────────────────────────────────────

export interface Deadline { date: number; label: string; amountMicros: number; kind: "urssaf" | "is" | "vat" }

/** Pure : prochaines échéances selon le montage, avec le montant estimé à provisionner. */
export function deadlines(structure: FinanceSettings["structure"], monthly: { social: number; corporate: number; vat: number }, now = Date.now()): Deadline[] {
  const out: Deadline[] = [];
  const d = new Date(now), y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (structure.startsWith("micro") && monthly.social > 0) {
    out.push({ date: Date.UTC(y, m + 2, 0), kind: "urssaf", amountMicros: Math.round(monthly.social), label: "Déclaration URSSAF du mois" });
  }
  if ((structure === "sasu_is" || structure === "eurl_is") && monthly.corporate > 0) {
    const next = [2, 5, 8, 11].map(mm => Date.UTC(mm <= m && !(mm === m && d.getUTCDate() < 15) ? y + 1 : y, mm, 15)).sort((a, b) => a - b)[0];
    out.push({ date: next, kind: "is", amountMicros: Math.round(monthly.corporate * 3), label: "Acompte d'impôt sur les sociétés" });
  }
  if (monthly.vat > 0) {
    const q = Math.floor(m / 3);
    out.push({ date: Date.UTC(y, (q + 1) * 3 + 1, 0), kind: "vat", amountMicros: Math.round(monthly.vat * 3), label: "TVA OSS (ventes Stripe UE) du trimestre" });
  }
  return out.sort((a, b) => a.date - b.date);
}

// ── Objectif de MRR ─────────────────────────────────────────────────────────

/** Pure : régression linéaire sur l'historique de MRR → date estimée d'atteinte. */
export function goalProjection(history: { t: number; mrr: number }[], goalMicros: number, now = Date.now()) {
  const pts = history.filter(h => Number.isFinite(h.mrr)).sort((a, b) => a.t - b.t);
  if (pts.length < 7) return { slopePerMonthMicros: null, etaDate: null, reached: false };
  const n = pts.length, mx = pts.reduce((a, p) => a + p.t, 0) / n, my = pts.reduce((a, p) => a + p.mrr, 0) / n;
  const num = pts.reduce((a, p) => a + (p.t - mx) * (p.mrr - my), 0), den = pts.reduce((a, p) => a + (p.t - mx) ** 2, 0);
  const slopePerMs = den ? num / den : 0;
  const current = pts[n - 1].mrr;
  const reached = current >= goalMicros;
  const eta = !reached && slopePerMs > 0 ? now + (goalMicros - current) / slopePerMs : null;
  return { slopePerMonthMicros: Math.round(slopePerMs * 30.44 * DAY), etaDate: eta && eta - now < 20 * 365 * DAY ? Math.round(eta) : null, reached };
}

// ── Plan complet ────────────────────────────────────────────────────────────

export async function planFor(uid: string, days: number, projectIds?: string[], goalMicros?: number) {
  const snap = await db.collection("projects").where("members", "array-contains", uid).select("config.currency").get();
  const docs = projectIds?.length ? snap.docs.filter(d => projectIds.includes(d.id)) : snap.docs;
  const cur = docs[0]?.get("config.currency") ?? "EUR";
  const s = await financeSettings(uid);
  const since = Date.now() - Math.max(days, 75) * DAY; // assez d'historique pour les virements Apple en attente
  const [txs, history, expenses] = await Promise.all([
    Promise.all(docs.map(async p => (await db.collection(`projects/${p.id}/transactions`).where("at", ">=", since)
      .select("store", "amountMicros", "currency", "country", "kind", "isSandbox", "at").get()).docs.map(d => d.data() as Tx))).then(a => a.flat()),
    Promise.all(docs.map(async p => (await db.collection(`projects/${p.id}/daily`).orderBy("date", "desc").limit(90).get()).docs.map(d => d.data()))).then(a => a.flat()),
    expensesFor(uid),
  ]);
  const periodTx = txs.filter(t => t.at >= Date.now() - days * DAY);
  const realExpenses = expensesOverPeriod(expenses, days, cur, projectIds);
  const w = computeWaterfall(periodTx, expenses.length ? { ...s, expensesRate: 0 } : s, cur, days);
  if (expenses.length) {
    // Dépenses réelles à la place de l'estimation en % : on recalcule la suite de la cascade.
    const adjusted = computeWaterfall(periodTx, { ...s, expensesRate: w.netRevenueMicros > 0 ? Math.min(1, realExpenses / w.netRevenueMicros) : 0 }, cur, days);
    Object.assign(w, adjusted, { settings: s });
  }
  const perMonth = (v: number) => v * 30.44 / Math.max(1, days);
  const stripeVat = periodTx.filter(t => t.store === "stripe" && !t.isSandbox && (VAT[(t.country ?? "").toUpperCase()] ?? 0) > 0 && ["AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE"].includes((t.country ?? "").toUpperCase()))
    .reduce((a, t) => { const g = convertMicros(t.amountMicros, t.currency, cur); const r = VAT[(t.country ?? "").toUpperCase()]; return a + (s.stripePricesIncludeVat ? g - g / (1 + r) : g * r); }, 0);
  const monthly = { social: perMonth(w.socialMicros), corporate: perMonth(w.corporateTaxMicros), vat: perMonth(stripeVat) };
  // Historique de MRR agrégé par date.
  const byDate = new Map<string, number>();
  for (const h of history) if (h.date) byDate.set(h.date, (byDate.get(h.date) ?? 0) + convertMicros(h.mrrMicros ?? 0, h.currency ?? cur, cur));
  const mrrHistory = [...byDate.entries()].map(([d, mrr]) => ({ t: Date.parse(d + "T00:00:00Z"), mrr }));
  return {
    currency: cur, days,
    waterfall: w,
    expenses: { list: expenses, periodMicros: realExpenses, monthlyMicros: expensesOverPeriod(expenses, 30.44, cur, projectIds) },
    setAside: {
      // À mettre de côté sur la période : tout ce qui n'est pas à toi (TVA Stripe à reverser + impôts).
      totalMicros: Math.round(stripeVat + w.socialMicros + w.corporateTaxMicros + w.dividendTaxMicros),
      vatMicros: Math.round(stripeVat), socialMicros: w.socialMicros, corporateMicros: w.corporateTaxMicros, dividendMicros: w.dividendTaxMicros,
      shareOfNet: w.netRevenueMicros > 0 ? (stripeVat + w.socialMicros + w.corporateTaxMicros) / (w.netRevenueMicros + stripeVat) : null,
    },
    payouts: upcomingPayouts(txs, s, cur).slice(0, 12),
    deadlines: deadlines(s.structure, monthly),
    goal: goalMicros ? { goalMicros, ...goalProjection(mrrHistory, goalMicros) } : null,
    mrrHistory: mrrHistory.sort((a, b) => a.t - b.t).slice(-90),
  };
}

// ── Export comptable (CSV) ──────────────────────────────────────────────────

export async function accountingCsv(uid: string, month: string, projectIds?: string[]) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("invalid_month");
  const [y, m] = month.split("-").map(Number);
  const from = Date.UTC(y, m - 1, 1), to = Date.UTC(y, m, 1);
  const snap = await db.collection("projects").where("members", "array-contains", uid).select("name", "config.currency").get();
  const docs = projectIds?.length ? snap.docs.filter(d => projectIds.includes(d.id)) : snap.docs;
  const s = await financeSettings(uid);
  const cur = docs[0]?.get("config.currency") ?? "EUR";
  const rows: string[][] = [["date", "business", "store", "pays", "type", "devise_origine", "montant_origine", `brut_ttc_${cur}`, "taux_tva", `tva_${cur}`, `ht_${cur}`, `commission_frais_${cur}`, `net_${cur}`]];
  const byCountry = new Map<string, { ht: number; vat: number; gross: number }>();
  for (const p of docs) {
    const tx = await db.collection(`projects/${p.id}/transactions`).where("at", ">=", from).where("at", "<", to).get();
    for (const d of tx.docs) {
      const t = d.data() as Tx & { productId?: string };
      if (t.isSandbox) continue;
      const w = computeWaterfall([t], s, cur, 30);
      const cc = (t.country ?? "??").toUpperCase();
      const rate = t.store === "stripe" && !s.stripePricesIncludeVat ? 0 : VAT[cc] ?? 0;
      const ht = w.grossMicros - w.vatMicros;
      const c = byCountry.get(cc) ?? { ht: 0, vat: 0, gross: 0 };
      c.ht += ht; c.vat += w.vatMicros; c.gross += w.grossMicros; byCountry.set(cc, c);
      const e = (v: number) => (v / 1e6).toFixed(2);
      rows.push([new Date(t.at).toISOString().slice(0, 10), String(p.get("name") ?? ""), t.store, cc, t.kind, t.currency, e(t.amountMicros),
        e(w.grossMicros), String(rate), e(w.vatMicros), e(ht), e(w.storeFeesMicros + w.paymentFeesMicros), e(w.netRevenueMicros)]);
    }
  }
  rows.push([], ["récapitulatif par pays", "", "", "pays", "", "", "", `brut_ttc_${cur}`, "", `tva_${cur}`, `ht_${cur}`]);
  for (const [cc, c] of [...byCountry.entries()].sort((a, b) => b[1].gross - a[1].gross)) {
    rows.push(["", "", "", cc, "", "", "", (c.gross / 1e6).toFixed(2), String(VAT[cc] ?? 0), (c.vat / 1e6).toFixed(2), (c.ht / 1e6).toFixed(2)]);
  }
  const esc = (v: string) => /[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return "﻿" + rows.map(r => r.map(esc).join(";")).join("\n");
}

// ── Alertes intelligentes ───────────────────────────────────────────────────

export interface Insight { type: "SALES_DROP" | "SALES_SPIKE" | "REFUND_SPIKE" | "BILLING_FAILURES" | "FIRST_SALE_COUNTRY"; projectId: string; projectName: string; title: string; body: string; at: number }

/** Pure : compare la veille aux 28 jours précédents — unit-tested. */
export function detectInsights(project: { id: string; name: string }, yesterday: { revenue: number; refunds: number; billing: number; countries: string[] },
  baseline: { revenuePerDay: number; refundsPerDay: number; billingPerDay: number; knownCountries: Set<string> }, currency: string, now = Date.now()): Insight[] {
  const out: Insight[] = [];
  const money = (v: number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency, maximumFractionDigits: 0 }).format(v / 1e6);
  const base = { projectId: project.id, projectName: project.name, at: now };
  if (baseline.revenuePerDay >= 20e6 && yesterday.revenue < baseline.revenuePerDay * 0.4)
    out.push({ ...base, type: "SALES_DROP", title: `Ventes en baisse · ${project.name}`, body: `Hier ${money(yesterday.revenue)} contre ${money(baseline.revenuePerDay)} en moyenne. À vérifier : paywall, prix, classement.` });
  if (baseline.revenuePerDay > 0 && yesterday.revenue >= Math.max(baseline.revenuePerDay * 2.5, 50e6))
    out.push({ ...base, type: "SALES_SPIKE", title: `Journée record · ${project.name}`, body: `Hier ${money(yesterday.revenue)}, soit ${(yesterday.revenue / baseline.revenuePerDay).toFixed(1)}× ta moyenne.` });
  if (yesterday.refunds >= 3 && yesterday.refunds > baseline.refundsPerDay * 3)
    out.push({ ...base, type: "REFUND_SPIKE", title: `Pic de remboursements · ${project.name}`, body: `${yesterday.refunds} remboursements hier (moyenne ${baseline.refundsPerDay.toFixed(1)}/jour).` });
  if (yesterday.billing >= 3 && yesterday.billing > baseline.billingPerDay * 3)
    out.push({ ...base, type: "BILLING_FAILURES", title: `Paiements en échec · ${project.name}`, body: `${yesterday.billing} problèmes de paiement hier : vérifie ta relance et le délai de grâce.` });
  for (const cc of yesterday.countries) if (!baseline.knownCountries.has(cc) && cc !== "??")
    out.push({ ...base, type: "FIRST_SALE_COUNTRY", title: `Première vente en ${cc} · ${project.name}`, body: `Nouveau pays : ${cc}. Pense à localiser ta fiche App Store.` });
  return out;
}

export async function insightsForProject(projectId: string, now = Date.now()) {
  const p = await db.doc(`projects/${projectId}`).get();
  const cur = p.get("config.currency") ?? "EUR";
  const dayStart = Math.floor(now / DAY) * DAY, yStart = dayStart - DAY, bStart = yStart - 28 * DAY;
  const [tx, ev, allCountries] = await Promise.all([
    db.collection(`projects/${projectId}/transactions`).where("at", ">=", bStart).where("at", "<", dayStart).select("amountMicrosProject", "isSandbox", "at", "country", "kind").get(),
    db.collection(`projects/${projectId}/events`).where("at", ">=", bStart).where("at", "<", dayStart).select("type", "isSandbox", "at").get(),
    db.collection(`projects/${projectId}/transactions`).where("at", "<", yStart).select("country").limit(5000).get(),
  ]);
  const y = { revenue: 0, refunds: 0, billing: 0, countries: [] as string[] }, b = { revenue: 0, refunds: 0, billing: 0 };
  const yCountries = new Set<string>();
  for (const d of tx.docs) {
    const t = d.data(); if (t.isSandbox) continue;
    const inY = t.at >= yStart, v = Number(t.amountMicrosProject ?? 0);
    if (v > 0) { if (inY) { y.revenue += v; yCountries.add(t.country ?? "??"); } else b.revenue += v; }
  }
  for (const d of ev.docs) {
    const e = d.data(); if (e.isSandbox) continue;
    const inY = e.at >= yStart;
    if (e.type === "REFUND") inY ? y.refunds++ : b.refunds++;
    if (e.type === "BILLING_ISSUE") inY ? y.billing++ : b.billing++;
  }
  y.countries = [...yCountries];
  const known = new Set(allCountries.docs.map(d => d.get("country") ?? "??"));
  return detectInsights({ id: projectId, name: String(p.get("name") ?? "") }, y,
    { revenuePerDay: b.revenue / 28, refundsPerDay: b.refunds / 28, billingPerDay: b.billing / 28, knownCountries: known }, cur, now);
}
