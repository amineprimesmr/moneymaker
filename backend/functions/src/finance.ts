// Du chiffre d'affaires brut à l'argent « en poche ».
//
//   Brut TTC payé par les clients
//   − TVA / taxes de vente (selon le pays de l'acheteur ; Apple et Google la reversent pour toi)
//   − commission du store (App Store 15 % / 30 %, Google Play 15 %)
//   − frais de paiement Stripe (% + fixe)
//   = CA net HT encaissé (≈ « Proceeds » de RevenueCat)
//   − cotisations sociales / impôt sur le revenu (micro-entreprise) ou impôt sur les sociétés
//   − impôt sur les dividendes (part distribuée)
//   = net en poche
//
// Les taux par défaut sont des repères 2026 modifiables : ce n'est pas un conseil fiscal.

import { db } from "./store";
import { convertMicros } from "./engine";

// ── TVA standard B2C (prix affichés TTC sur les stores) ─────────────────────
export const VAT: Record<string, number> = {
  AT: 0.20, BE: 0.21, BG: 0.20, HR: 0.25, CY: 0.19, CZ: 0.21, DK: 0.25, EE: 0.24, FI: 0.255, FR: 0.20, DE: 0.19, GR: 0.24,
  HU: 0.27, IE: 0.23, IT: 0.22, LV: 0.21, LT: 0.21, LU: 0.17, MT: 0.18, NL: 0.21, PL: 0.23, PT: 0.23, RO: 0.21, SK: 0.23,
  SI: 0.22, ES: 0.21, SE: 0.25, GB: 0.20, NO: 0.25, CH: 0.081, IS: 0.24, TR: 0.20, RU: 0.20, UA: 0.20, JP: 0.10, KR: 0.10,
  AU: 0.10, NZ: 0.15, IN: 0.18, ZA: 0.15, SG: 0.09, TW: 0.05, ID: 0.12, TH: 0.07, MY: 0.08, PH: 0.12, VN: 0.10, SA: 0.15,
  AE: 0.05, IL: 0.18, EG: 0.14, MA: 0.20, NG: 0.075, KE: 0.16, MX: 0.16, CL: 0.19, CO: 0.19, AR: 0.21, PE: 0.18, BR: 0,
  // Prix hors taxe sur les stores (taxes de vente ajoutées ou inexistantes) : US, CA, HK…
  US: 0, CA: 0, HK: 0,
};

export interface FinanceSettings {
  /** L'utilisateur a choisi d'afficher le net (et rempli son profil). */
  showNet: boolean;
  /** Profil : nom de l'entreprise, pays, moyens d'encaissement utilisés. */
  companyName: string;
  country: string;
  processors: { appStore: boolean; googlePlay: boolean; stripe: boolean };
  structure: "micro_services" | "micro_vente" | "micro_liberal" | "sasu_is" | "eurl_is" | "llc_us" | "uae_freezone" | "custom";
  /** Programme Small Business d'Apple (15 %) — sinon 30 % la 1re année d'abonnement. */
  appleSmallBusiness: boolean;
  googleRate: number;
  stripePercent: number;   // ex. 0.015
  stripeFixed: number;     // en unités de la devise de reporting, ex. 0.25
  stripePricesIncludeVat: boolean;
  /** Franchise en base de TVA (micro-entreprise sous les seuils) : aucune TVA facturée sur tes ventes directes (Stripe).
   *  Apple et Google collectent quand même la TVA du client avant de te payer. */
  vatFranchise: boolean;
  /** Micro : cotisations sociales sur le CA ; IS : charges/salaire ≈ 0 par défaut. */
  socialRate: number;
  /** Micro : versement libératoire de l'impôt sur le revenu (sur le CA). */
  incomeTaxRate: number;
  /** Charges déductibles estimées (% du CA net) — serveurs, outils… (sociétés uniquement). */
  expensesRate: number;
  /** IS : taux réduit jusqu'au seuil, puis taux normal (annuel). */
  corporateReducedRate: number; corporateReducedCap: number; corporateRate: number;
  /** Part du bénéfice distribuée en dividendes, et impôt dessus (PFU en France). */
  payoutShare: number; dividendTaxRate: number;
}

export const PRESETS: Record<FinanceSettings["structure"], Partial<FinanceSettings> & { label: string; note: string }> = {
  micro_services: { label: "Micro-entreprise (services)", note: "Cotisations URSSAF ≈ 21,2 % du CA (24,6 % en libéral BNC). Franchise de TVA. Versement libératoire 1,7 % seulement si tu l'as choisi.",
    vatFranchise: true, socialRate: 0.212, incomeTaxRate: 0, expensesRate: 0, corporateReducedRate: 0, corporateRate: 0, payoutShare: 1, dividendTaxRate: 0 },
  micro_liberal: { label: "Micro-entreprise (libéral BNC)", note: "Cotisations URSSAF ≈ 24,6 % du CA (professions libérales). Franchise de TVA. Versement libératoire 2,2 % seulement si tu l'as choisi.",
    vatFranchise: true, socialRate: 0.246, incomeTaxRate: 0, expensesRate: 0, corporateReducedRate: 0, corporateRate: 0, payoutShare: 1, dividendTaxRate: 0 },
  micro_vente: { label: "Micro-entreprise (vente)", note: "Cotisations URSSAF ≈ 12,3 % du CA. Franchise de TVA. Versement libératoire 1 % seulement si tu l'as choisi.",
    vatFranchise: true, socialRate: 0.123, incomeTaxRate: 0, expensesRate: 0, corporateReducedRate: 0, corporateRate: 0, payoutShare: 1, dividendTaxRate: 0 },
  sasu_is: { label: "SASU à l'IS", note: "IS 15 % jusqu'à 42 500 € de bénéfice puis 25 %, dividendes au PFU 31,4 % (2026).",
    vatFranchise: false, socialRate: 0, incomeTaxRate: 0, expensesRate: 0.05, corporateReducedRate: 0.15, corporateReducedCap: 42500, corporateRate: 0.25, payoutShare: 1, dividendTaxRate: 0.314 },
  eurl_is: { label: "EURL à l'IS", note: "Comme la SASU ; dividendes au-delà de 10 % du capital soumis aux cotisations TNS (non modélisé).",
    vatFranchise: false, socialRate: 0, incomeTaxRate: 0, expensesRate: 0.05, corporateReducedRate: 0.15, corporateReducedCap: 42500, corporateRate: 0.25, payoutShare: 1, dividendTaxRate: 0.314 },
  llc_us: { label: "LLC américaine (non-résident)", note: "0 % d'impôt fédéral sans activité aux USA ; l'imposition se fait dans ton pays de résidence — règle les taux.",
    vatFranchise: false, socialRate: 0, incomeTaxRate: 0, expensesRate: 0.05, corporateReducedRate: 0, corporateRate: 0, payoutShare: 1, dividendTaxRate: 0 },
  uae_freezone: { label: "Free Zone aux Émirats", note: "0 % sur le revenu qualifiant, 9 % au-delà de 375 000 AED (≈ 94 000 €) sinon.",
    vatFranchise: false, socialRate: 0, incomeTaxRate: 0, expensesRate: 0.05, corporateReducedRate: 0, corporateReducedCap: 94000, corporateRate: 0.09, payoutShare: 1, dividendTaxRate: 0 },
  custom: { label: "Personnalisé", note: "Renseigne tes propres taux." },
};

export const DEFAULT_FINANCE: FinanceSettings = {
  showNet: false, companyName: "", country: "FR", processors: { appStore: true, googlePlay: false, stripe: true },
  structure: "sasu_is", appleSmallBusiness: true, googleRate: 0.15, stripePercent: 0.015, stripeFixed: 0.25, stripePricesIncludeVat: true, vatFranchise: false,
  socialRate: 0, incomeTaxRate: 0, expensesRate: 0.05, corporateReducedRate: 0.15, corporateReducedCap: 42500, corporateRate: 0.25, payoutShare: 1, dividendTaxRate: 0.314,
};

/** Valide les réglages envoyés (taux entre 0 et 1). Pure — unit-tested. */
export function sanitizeFinance(input: any, current: FinanceSettings = DEFAULT_FINANCE): FinanceSettings {
  const next: FinanceSettings = { ...current };
  if (input?.structure && input.structure in PRESETS) {
    const { label, note, ...rates } = PRESETS[input.structure as FinanceSettings["structure"]];
    Object.assign(next, rates, { structure: input.structure });
  }
  const rate = (k: keyof FinanceSettings, max = 1) => {
    if (input?.[k] === undefined) return;
    const v = Number(input[k]);
    if (!Number.isFinite(v) || v < 0 || v > max) throw new Error(`invalid_${String(k)}`);
    (next as any)[k] = v;
  };
  for (const k of ["googleRate", "stripePercent", "socialRate", "incomeTaxRate", "expensesRate", "corporateReducedRate", "corporateRate", "payoutShare", "dividendTaxRate"] as const) rate(k);
  rate("stripeFixed", 10); rate("corporateReducedCap", 10_000_000);
  for (const k of ["appleSmallBusiness", "stripePricesIncludeVat", "vatFranchise", "showNet"] as const) if (typeof input?.[k] === "boolean") (next as any)[k] = input[k];
  if (typeof input?.companyName === "string") next.companyName = input.companyName.trim().slice(0, 80);
  if (typeof input?.country === "string" && /^[A-Z]{2}$/.test(input.country)) next.country = input.country;
  if (input?.processors && typeof input.processors === "object") {
    next.processors = { ...next.processors };
    for (const k of ["appStore", "googlePlay", "stripe"] as const) if (typeof input.processors[k] === "boolean") next.processors[k] = input.processors[k];
  }
  return next;
}

export interface Tx { store: string; amountMicros: number; currency: string; country?: string | null; kind: string; isSandbox?: boolean; at: number; periodMonths?: number }

export interface Waterfall {
  currency: string; days: number;
  grossMicros: number; vatMicros: number; storeFeesMicros: number; paymentFeesMicros: number; refundsMicros: number;
  netRevenueMicros: number;   // CA net HT encaissé
  expensesMicros: number; socialMicros: number; corporateTaxMicros: number; dividendTaxMicros: number;
  pocketMicros: number;       // net en poche
  byStore: Record<string, { grossMicros: number; vatMicros: number; feesMicros: number; netMicros: number }>;
  annualized: { netRevenueMicros: number; pocketMicros: number };
  settings: FinanceSettings;
}

/** Pure : cascade brut → en poche sur une liste de transactions — unit-tested. */
export function computeWaterfall(txs: Tx[], s: FinanceSettings, currency: string, days: number): Waterfall {
  const w: Waterfall = {
    currency, days, grossMicros: 0, vatMicros: 0, storeFeesMicros: 0, paymentFeesMicros: 0, refundsMicros: 0, netRevenueMicros: 0,
    expensesMicros: 0, socialMicros: 0, corporateTaxMicros: 0, dividendTaxMicros: 0, pocketMicros: 0, byStore: {},
    annualized: { netRevenueMicros: 0, pocketMicros: 0 }, settings: s,
  };
  for (const t of txs) {
    if (t.isSandbox) continue;
    const gross = convertMicros(t.amountMicros, t.currency, currency);
    const vatRate = VAT[(t.country ?? "").toUpperCase()] ?? 0;
    // Stripe = vente directe : TVA seulement si tu en factures (pas en franchise, prix TTC).
    // Stores : Apple / Google collectent la TVA du client quoi qu'il arrive.
    const storeVat = t.store === "stripe" ? (!s.vatFranchise && s.stripePricesIncludeVat ? vatRate : 0) : vatRate;
    const vat = gross - gross / (1 + storeVat);
    const ht = gross - vat;
    let fee = 0, pay = 0;
    if (t.store === "app_store") fee = ht * (s.appleSmallBusiness ? 0.15 : 0.30);
    else if (t.store === "play_store") fee = ht * s.googleRate;
    else if (t.store === "stripe" && gross > 0) pay = gross * s.stripePercent + s.stripeFixed * 1e6;
    const b = (w.byStore[t.store] ??= { grossMicros: 0, vatMicros: 0, feesMicros: 0, netMicros: 0 });
    b.grossMicros += gross; b.vatMicros += vat; b.feesMicros += fee + pay; b.netMicros += ht - fee - pay;
    if (gross < 0) w.refundsMicros += -gross;
    w.grossMicros += gross; w.vatMicros += vat; w.storeFeesMicros += fee; w.paymentFeesMicros += pay;
  }
  w.netRevenueMicros = w.grossMicros - w.vatMicros - w.storeFeesMicros - w.paymentFeesMicros;
  const net = Math.max(0, w.netRevenueMicros);
  // Micro : prélèvements sur le CA encaissé. Société : IS sur le bénéfice (barème annualisé, ramené à la période).
  w.socialMicros = net * (s.socialRate + s.incomeTaxRate);
  w.expensesMicros = net * s.expensesRate;
  const profit = Math.max(0, net - w.expensesMicros - w.socialMicros);
  const yearFactor = 365 / Math.max(1, days);
  const annualProfit = profit * yearFactor / 1e6;
  const reduced = Math.min(annualProfit, s.corporateReducedCap || 0);
  const annualIs = reduced * s.corporateReducedRate + Math.max(0, annualProfit - reduced) * s.corporateRate;
  w.corporateTaxMicros = (annualIs / yearFactor) * 1e6;
  const distributable = Math.max(0, profit - w.corporateTaxMicros);
  w.dividendTaxMicros = distributable * s.payoutShare * s.dividendTaxRate;
  w.pocketMicros = distributable * s.payoutShare - w.dividendTaxMicros;
  // Arrondis : tout en micros entiers.
  for (const k of ["grossMicros", "vatMicros", "storeFeesMicros", "paymentFeesMicros", "refundsMicros", "netRevenueMicros", "expensesMicros", "socialMicros", "corporateTaxMicros", "dividendTaxMicros", "pocketMicros"] as const) (w as any)[k] = Math.round((w as any)[k]);
  for (const b of Object.values(w.byStore)) for (const k of Object.keys(b) as (keyof typeof b)[]) b[k] = Math.round(b[k]);
  w.annualized = { netRevenueMicros: Math.round(w.netRevenueMicros * yearFactor), pocketMicros: Math.round(w.pocketMicros * yearFactor) };
  return w;
}

export async function financeSettings(uid: string): Promise<FinanceSettings> {
  const d = (await db.doc(`users/${uid}/settings/finance`).get()).data() ?? {};
  const s = { ...DEFAULT_FINANCE, ...d } as FinanceSettings;
  // Réglages enregistrés avant l'option : une micro-entreprise est en franchise par défaut.
  if (d.vatFranchise === undefined) s.vatFranchise = String(s.structure).startsWith("micro");
  return s;
}

export async function waterfallFor(uid: string, days: number, projectIds?: string[], currency?: string) {
  const snap = await db.collection("projects").where("members", "array-contains", uid).select("config.currency").get();
  const docs = projectIds?.length ? snap.docs.filter(d => projectIds.includes(d.id)) : snap.docs;
  const cur = currency ?? docs[0]?.get("config.currency") ?? "EUR";
  const since = Date.now() - days * 86400000;
  const txs = (await Promise.all(docs.map(async p =>
    (await db.collection(`projects/${p.id}/transactions`).where("at", ">=", since)
      .select("store", "amountMicros", "currency", "country", "kind", "isSandbox", "at", "periodMonths").get()).docs.map(d => d.data() as Tx)))).flat();
  return computeWaterfall(txs, await financeSettings(uid), cur, days);
}
