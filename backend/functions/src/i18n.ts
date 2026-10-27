// Textes générés côté serveur (push APNs, alertes, étapes de configuration) en français et en anglais.
// Chaque appareil enregistre sa langue (`lang` dans users/{uid}/devices/{id}) ; les documents stockés
// (insights, anomalies, résumés) gardent `title`/`body` en français et ajoutent `titleEn`/`bodyEn`.

export type Lang = "fr" | "en";

/** "fr" → fr, toute autre valeur → en ; absent → `fallback` (fr par défaut, compatibilité). */
export function normLang(v: unknown, fallback: Lang = "fr"): Lang {
  if (v === undefined || v === null || v === "") return fallback;
  return String(v).toLowerCase().startsWith("fr") ? "fr" : "en";
}

export const LOCALE: Record<Lang, string> = { fr: "fr-FR", en: "en-US" };

/** Montant en micros, formaté à la manière de la langue (9,99 € / €9.99). */
export function money(lang: Lang, micros: number, currency: string, maxFrac?: number) {
  const v = micros / 1e6;
  return new Intl.NumberFormat(LOCALE[lang], { style: "currency", currency: currency || "EUR", maximumFractionDigits: maxFrac ?? (Math.abs(v) >= 1000 ? 0 : 2) }).format(v);
}

/** Pluriel simple : fr = singulier pour 0 et 1, en = singulier pour 1. */
export const plural = (lang: Lang, n: number, one: string, many: string) => (lang === "fr" ? n > 1 : n !== 1) ? many : one;

// ── Notifications d'événements ──────────────────────────────────────────────

export const EVENT_TITLES: Record<Lang, Record<string, string>> = {
  fr: {
    INITIAL_PURCHASE: "Nouvel abonné", NON_RENEWING_PURCHASE: "Nouvel achat", TRIAL_CONVERTED: "Essai converti", RENEWAL: "Renouvellement",
    TRIAL_STARTED: "Essai démarré", CANCELLATION: "Annulation", EXPIRATION: "Abonnement expiré", BILLING_ISSUE: "Problème de paiement",
    BILLING_RECOVERED: "Paiement récupéré", REFUND: "Remboursement", REVOKED: "Accès révoqué", UNCANCELLATION: "Réactivation", TEST: "Notification de test",
  },
  en: {
    INITIAL_PURCHASE: "New subscriber", NON_RENEWING_PURCHASE: "New purchase", TRIAL_CONVERTED: "Trial converted", RENEWAL: "Renewal",
    TRIAL_STARTED: "Trial started", CANCELLATION: "Cancellation", EXPIRATION: "Subscription expired", BILLING_ISSUE: "Billing issue",
    BILLING_RECOVERED: "Payment recovered", REFUND: "Refund", REVOKED: "Access revoked", UNCANCELLATION: "Reactivation", TEST: "Test notification",
  },
};

export function periodLabel(lang: Lang, m?: number) {
  const fr: Record<string, string> = { "12": "annuel", "1": "mensuel", "3": "trimestriel", "6": "semestriel", "0.25": "hebdo" };
  const en: Record<string, string> = { "12": "yearly", "1": "monthly", "3": "quarterly", "6": "6-month", "0.25": "weekly" };
  return m === undefined ? "" : (lang === "fr" ? fr : en)[String(m)] ?? "";
}

export const todayLabel = (lang: Lang) => lang === "fr" ? "Aujourd'hui" : "Today";
export const todayLine = (lang: Lang, amount: string) => lang === "fr" ? `Aujourd'hui : ${amount}` : `Today: ${amount}`;
export const liveActivityStart = (lang: Lang) => lang === "fr" ? "Revenus du jour en direct" : "Today's revenue, live";

// ── Classements ─────────────────────────────────────────────────────────────

export const RANK_TITLES: Record<Lang, Record<string, string>> = {
  fr: { NEW_COUNTRY: "Nouveau pays", TOP_100: "Retour dans le top 100", TOP_10: "Top 10", TOP_1: "Numéro 1 🥇", JUMP: "Forte hausse", DROP: "Forte baisse" },
  en: { NEW_COUNTRY: "New country", TOP_100: "Back in the top 100", TOP_10: "Top 10", TOP_1: "Number 1 🥇", JUMP: "Big jump", DROP: "Big drop" },
};
export const CHART_NAMES: Record<Lang, Record<string, string>> = {
  fr: { free: "Gratuites", paid: "Payantes", grossing: "Revenus" },
  en: { free: "Free", paid: "Paid", grossing: "Top Grossing" },
};
export const categoryLabel = (lang: Lang) => lang === "fr" ? "catégorie" : "category";
export const previousRank = (lang: Lang, r: number | string) => lang === "fr" ? `avant #${r}` : `was #${r}`;

// ── Récap quotidien ─────────────────────────────────────────────────────────

export function dailySummaryText(lang: Lang, t: { sales: number; renewals: number; trials: number }, net: number, currency: string) {
  const title = lang === "fr" ? `Ta journée : ${money(lang, net, currency)}` : `Your day: ${money(lang, net, currency)}`;
  let body: string;
  if (net > 0) {
    body = (lang === "fr"
      ? [`${t.sales} ${plural(lang, t.sales, "vente", "ventes")}`, t.renewals ? `${t.renewals} ${plural(lang, t.renewals, "renouvellement", "renouvellements")}` : "", t.trials ? `${t.trials} ${plural(lang, t.trials, "essai", "essais")}` : ""]
      : [`${t.sales} ${plural(lang, t.sales, "sale", "sales")}`, t.renewals ? `${t.renewals} ${plural(lang, t.renewals, "renewal", "renewals")}` : "", t.trials ? `${t.trials} ${plural(lang, t.trials, "trial", "trials")}` : ""])
      .filter(Boolean).join(" · ");
  } else if (t.trials) {
    body = lang === "fr"
      ? `${t.trials} ${plural(lang, t.trials, "essai démarré", "essais démarrés")}, pas encore de vente`
      : `${t.trials} ${plural(lang, t.trials, "trial", "trials")} started, no sales yet`;
  } else {
    body = lang === "fr" ? "Pas de vente aujourd'hui — demain sera meilleur." : "No sales today — tomorrow will be better.";
  }
  return { title, body };
}

// ── Test push ───────────────────────────────────────────────────────────────

export function testPush(lang: Lang) {
  return lang === "fr"
    ? { title: `+${money("fr", 9.99e6, "EUR")} · MoneyMaker`, subtitle: "Notification de test", body: "Nouvel abonné · mensuel · 🇫🇷 FR" }
    : { title: `+${money("en", 9.99e6, "USD")} · MoneyMaker`, subtitle: "Test notification", body: "New subscriber · monthly · 🇺🇸 US" };
}

// ── Alertes intelligentes (plan.ts) ─────────────────────────────────────────

export const insightText = {
  SALES_DROP: (lang: Lang, name: string, y: string, avg: string) => lang === "fr"
    ? { title: `Ventes en baisse · ${name}`, body: `Hier ${y} contre ${avg} en moyenne. À vérifier : paywall, prix, classement.` }
    : { title: `Sales down · ${name}`, body: `Yesterday ${y} vs. ${avg} on average. Worth checking: paywall, pricing, rankings.` },
  SALES_SPIKE: (lang: Lang, name: string, y: string, ratio: number) => lang === "fr"
    ? { title: `Journée record · ${name}`, body: `Hier ${y}, soit ${ratio.toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}× ta moyenne.` }
    : { title: `Record day · ${name}`, body: `Yesterday ${y}, ${ratio.toFixed(1)}× your average.` },
  REFUND_SPIKE: (lang: Lang, name: string, n: number, avg: number) => lang === "fr"
    ? { title: `Pic de remboursements · ${name}`, body: `${n} remboursements hier (moyenne ${avg.toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}/jour).` }
    : { title: `Refund spike · ${name}`, body: `${n} refunds yesterday (average ${avg.toFixed(1)}/day).` },
  BILLING_FAILURES: (lang: Lang, name: string, n: number) => lang === "fr"
    ? { title: `Paiements en échec · ${name}`, body: `${n} problèmes de paiement hier : vérifie ta relance et le délai de grâce.` }
    : { title: `Failed payments · ${name}`, body: `${n} billing issues yesterday: check your dunning and grace period.` },
  FIRST_SALE_COUNTRY: (lang: Lang, name: string, cc: string) => lang === "fr"
    ? { title: `Première vente en ${cc} · ${name}`, body: `Nouveau pays : ${cc}. Pense à localiser ta fiche App Store.` }
    : { title: `First sale in ${cc} · ${name}`, body: `New country: ${cc}. Consider localizing your App Store listing.` },
};

// ── Anomalies et résumé hebdo (anomalies.ts) ────────────────────────────────

export const ANOMALY_LABEL: Record<Lang, Record<string, string>> = {
  fr: { revenue: "Revenu", newSubscriptions: "Nouveaux abonnés", trials: "Essais", refunds: "Remboursements", billingIssues: "Problèmes de paiement", churn: "Abonnements perdus" },
  en: { revenue: "Revenue", newSubscriptions: "New subscribers", trials: "Trials", refunds: "Refunds", billingIssues: "Billing issues", churn: "Lost subscriptions" },
};

export function anomalyText(lang: Lang, metric: string, up: boolean, name: string, value: string, mean: string, z: number) {
  return lang === "fr"
    ? { title: `${ANOMALY_LABEL.fr[metric]} ${up ? "inhabituellement haut" : "inhabituellement bas"} · ${name}`,
        body: `Hier ${value} contre ${mean} en moyenne sur 28 jours (z = ${z.toFixed(1)}).` }
    : { title: `${ANOMALY_LABEL.en[metric]} unusually ${up ? "high" : "low"} · ${name}`,
        body: `Yesterday ${value} vs. ${mean} on average over 28 days (z = ${z.toFixed(1)}).` };
}

export function weeklyText(lang: Lang, name: string, revenue: string, mrr: string, change: number | null, newSubs: number, top: string | null) {
  const pct = change === null ? null : `${change >= 0 ? "+" : "−"}${Math.abs(Math.round(change * 100))}`;
  if (lang === "fr") return {
    title: `Ta semaine · ${name} : ${revenue}`,
    body: [`Revenu ${revenue}${pct ? ` (${pct} % vs semaine précédente)` : ""}`, `MRR ${mrr}`, `${newSubs} ${plural("fr", newSubs, "nouvel abonné", "nouveaux abonnés")}`, top ? `top pays ${top}` : ""].filter(Boolean).join(" · "),
  };
  return {
    title: `Your week · ${name}: ${revenue}`,
    body: [`Revenue ${revenue}${pct ? ` (${pct}% vs. last week)` : ""}`, `MRR ${mrr}`, `${newSubs} ${plural("en", newSubs, "new subscriber", "new subscribers")}`, top ? `top country ${top}` : ""].filter(Boolean).join(" · "),
  };
}

// ── Pilotage (plan.ts) : versements et échéances ────────────────────────────

export function payoutLabel(lang: Lang, store: string, at?: number) {
  if (store === "stripe") return "Stripe";
  const month = at === undefined ? "" : new Date(at).toLocaleDateString(LOCALE[lang], { month: "long", timeZone: "UTC" });
  const brand = store === "app_store" ? "Apple" : "Google Play";
  return lang === "fr" ? `${brand} · ventes de ${month}` : `${brand} · ${month} sales`;
}

export const DEADLINE_LABEL: Record<Lang, Record<"urssaf" | "is" | "vat", string>> = {
  fr: { urssaf: "Déclaration URSSAF du mois", is: "Acompte d'impôt sur les sociétés", vat: "TVA OSS (ventes Stripe UE) du trimestre" },
  en: { urssaf: "Monthly URSSAF declaration", is: "Corporate tax installment", vat: "Quarterly OSS VAT (EU Stripe sales)" },
};

// ── Préréglages fiscaux (finance.ts) ────────────────────────────────────────

export const PRESET_EN: Record<string, { label: string; note: string }> = {
  micro_services: { label: "Micro-enterprise (services)", note: "URSSAF contributions ≈ 21.2% of revenue (24.6% for BNC liberal professions). VAT exemption. 1.7% flat-rate income tax only if you opted in." },
  micro_liberal: { label: "Micro-enterprise (BNC liberal)", note: "URSSAF contributions ≈ 24.6% of revenue (liberal professions). VAT exemption. 2.2% flat-rate income tax only if you opted in." },
  micro_vente: { label: "Micro-enterprise (sales)", note: "URSSAF contributions ≈ 12.3% of revenue. VAT exemption. 1% flat-rate income tax only if you opted in." },
  sasu_is: { label: "SASU (corporate tax)", note: "Corporate tax 15% up to €42,500 of profit, then 25%; dividends at the 31.4% flat tax (2026)." },
  eurl_is: { label: "EURL (corporate tax)", note: "Same as SASU; dividends above 10% of share capital are subject to TNS social contributions (not modeled)." },
  llc_us: { label: "US LLC (non-resident)", note: "0% federal tax with no US activity; you're taxed in your country of residence — set the rates accordingly." },
  uae_freezone: { label: "UAE Free Zone", note: "0% on qualifying income, otherwise 9% above AED 375,000 (≈ €94,000)." },
  custom: { label: "Custom", note: "Enter your own rates." },
};

// ── Étapes de configuration (api.ts › setupSteps) ───────────────────────────

export const SETUP_EN: Record<string, { group: string; title: string; help: string }> = {
  products: { group: "Basics", title: "Define premium access and its products", help: "List the product IDs (App Store, Play, Stripe) that unlock access. Connecting App Store Connect or Google Play imports them automatically." },
  sdk: { group: "Basics", title: "Plug the SDK into your app", help: "Copy the prompt from the Connections tab into Claude. This step completes as soon as the app calls MoneyMaker." },
  asc: { group: "App Store", title: "Connect App Store Connect", help: "App Store Connect API key (App Manager role): imports products, enables rankings and sets the notification URL." },
  appleNotifications: { group: "App Store", title: "Receive Apple server notifications", help: "V2 URL for production and sandbox (set automatically by the App Store Connect connection if it was empty). Completes on the first notification received." },
  iap: { group: "App Store", title: "Add the In-App Purchase key", help: "Recommended: MoneyMaker asks Apple for the exact status (grace period, renewal) instead of relying on the receipt alone." },
  google: { group: "Google Play", title: "Connect Google Play", help: "Service account with \"Financial data\" access in Play Console." },
  googleNotifications: { group: "Google Play", title: "Receive Play notifications (RTDN)", help: "Pub/Sub topic + push subscription to the provided URL, then set the topic in Play Console → Monetization." },
  stripe: { group: "Stripe", title: "Connect Stripe", help: "One key is enough: the webhook is created and history is imported automatically." },
  firstPurchase: { group: "Validation", title: "First purchase received (sandbox or real)", help: "Make a sandbox purchase in the app: it should show up in Events within seconds." },
  appstore: { group: "Bonus", title: "Track App Store rankings", help: "Add your app and your competitors: rankings in 177 countries, alerts, reviews." },
  integrations: { group: "Bonus", title: "Connect Slack or your tools", help: "Slack/Discord to get notified of every sale, Mixpanel/Amplitude/Segment/PostHog for analytics, webhooks for your backend." },
};
