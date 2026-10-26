// Catalogue des outils MCP MoneyMaker. Chaque outil appelle une route /v1 existante (mêmes rôles, mêmes
// validations, même journal d'audit) : aucune logique métier n'est dupliquée ici.

export type Call = (method: string, path: string, opts?: { query?: Record<string, unknown>; body?: unknown }) => Promise<any>;
type Props = Record<string, Record<string, unknown>>;
export interface Tool {
  name: string; title: string; description: string;
  props?: Props; required?: string[];
  /** write : modifie des données (scope moneymaker:write). destructive : suppression → `confirm: true` obligatoire. */
  write?: boolean; destructive?: boolean;
  run: (a: Record<string, any>, call: Call) => Promise<unknown>;
}

const enc = encodeURIComponent;
const P = (a: Record<string, any>) => `/v1/projects/${enc(String(a.projectId))}`;
const projectId = { type: "string", description: "Identifiant du business (voir list_projects)" };
const days = (d: number, max = 365) => ({ type: "integer", minimum: 1, maximum: max, description: `Période en jours (défaut ${d})` });
const limit = (d: number, max: number) => ({ type: "integer", minimum: 1, maximum: max, description: `Nombre maximum (défaut ${d}, max ${max})` });
const projectIds = { type: "array", items: { type: "string" }, description: "Limiter à ces business (par défaut : tous)" };
const ids = (v: unknown) => Array.isArray(v) && v.length ? v.join(",") : undefined;
const confirm = { type: "boolean", description: "true uniquement après accord explicite de l'utilisateur pour cette suppression" };
const appId = { type: "string", description: "Identifiant App Store numérique (voir list_tracked_apps)" };

/** Retire les secrets et jetons que l'API renvoie au dashboard mais qui n'ont rien à faire dans une conversation. */
function redactProject(p: any) {
  if (!p || typeof p !== "object") return p;
  const { webhookSigningSecret, amazonConfirmationToken, ...rest } = p;
  if (rest.endpoints) rest.endpoints = Object.fromEntries(Object.entries(rest.endpoints).map(([k, v]) => [k, String(v).replace(/token=[^&]+/, "token=…")]));
  return { ...rest, webhookSigningSecret: webhookSigningSecret ? "(masqué : visible dans le dashboard)" : undefined };
}
/** Configuration du business ; repli sur la liste des projets si la fiche complète est indisponible. */
async function configOf(a: Record<string, any>, call: Call): Promise<Record<string, any>> {
  try { return (await call("GET", P(a))).config ?? {}; }
  catch (e) {
    const p = (await call("GET", "/v1/projects")).projects.find((x: any) => x.id === a.projectId);
    if (!p) throw e;
    return p.config ?? {};
  }
}
const csvHead = (text: unknown, rows: number) => {
  const lines = String(text ?? "").split("\n");
  return { rows: Math.max(0, lines.length - 1), truncated: lines.length - 1 > rows, csv: lines.slice(0, rows + 1).join("\n") };
};

export const TOOLS: Tool[] = [
  // ── Compte et vue d'ensemble ─────────────────────────────────────────────
  { name: "list_projects", title: "Lister les business", description: "Liste les business (projets) accessibles : id, nom, rôle, devise, mode. Point de départ pour obtenir les projectId.",
    run: async (_a, call) => (await call("GET", "/v1/projects")).projects.map((p: any) => ({ id: p.id, name: p.name, role: p.role,
      currency: p.config?.currency, mode: p.config?.mode ?? "subscriptions", category: p.config?.category ?? null, iconUrl: p.iconUrl ?? null })) },
  { name: "get_overview", title: "Vue d'ensemble multi-business", description: "Tous business confondus : revenu, MRR, abonnés actifs, essais, clients payants, churn, téléchargements, revenu par pays et séries quotidiennes par business.",
    props: { days: days(30), currency: { type: "string", description: "Devise de conversion ISO (ex. EUR)" } },
    run: (a, call) => call("GET", "/v1/overview", { query: { days: a.days, currency: a.currency } }) },
  { name: "get_today", title: "Aujourd'hui", description: "Le jour en cours (fuseau donné) : revenu du jour, ventes, essais, comparaison à hier, par business.",
    props: { tz: { type: "string", description: "Fuseau IANA (ex. Europe/Paris)" }, currency: { type: "string" }, projectIds },
    run: (a, call) => call("GET", "/v1/today", { query: { tz: a.tz ?? "Europe/Paris", currency: a.currency, projectIds: ids(a.projectIds) } }) },
  { name: "get_feed", title: "Flux des ventes", description: "Flux en direct des transactions et événements de tous les business (achats, renouvellements, essais, remboursements).",
    props: { limit: limit(30, 300), projectIds },
    run: (a, call) => call("GET", "/v1/feed", { query: { limit: a.limit, projectIds: ids(a.projectIds) } }) },

  // ── Métriques d'un business ──────────────────────────────────────────────
  { name: "get_metrics", title: "Métriques d'un business", description: "MRR, ARR, revenu, abonnés, essais, clients payants, churn, conversion d'essai, LTV, ARPU, téléchargements, campagnes Apple Ads, revenu par pays (globe) et séries quotidiennes.",
    props: { projectId, days: days(30) }, required: ["projectId"],
    run: (a, call) => call("GET", `${P(a)}/metrics`, { query: { days: a.days } }) },
  { name: "get_chart", title: "Graphique", description: "Un graphique de croissance avec ses points et son résumé (parité RevenueCat Charts). Filtres store/pays/produit.",
    props: { projectId, name: { type: "string", enum: ["active_subscriptions", "active_subscriptions_movement", "active_trials", "active_trials_movement",
      "mrr", "mrr_movement", "arr", "revenue", "new_customers", "conversion_to_paying", "initial_conversion", "trial_conversion_funnel", "trial_conversion_rate",
      "trial_cancellation_rate", "subscription_retention", "churn", "refund_rate", "refunds", "realized_ltv_per_customer", "realized_ltv_per_paying_customer",
      "non_subscription_purchases", "subscription_status", "paywall"] },
      days: days(30, 1095), resolution: { type: "string", enum: ["day", "week", "month"] },
      store: { type: "string", description: "app_store, play_store, stripe, paddle, amazon, roku, promotional…" },
      country: { type: "string", description: "Code pays ISO à 2 lettres" }, product: { type: "string", description: "Identifiant produit" } },
    required: ["projectId", "name"],
    run: (a, call) => call("GET", `${P(a)}/charts/${enc(a.name)}`, { query: { days: a.days, resolution: a.resolution, store: a.store, country: a.country, product: a.product } }) },
  { name: "get_cohorts", title: "Cohortes", description: "Rétention et revenu par cohorte mensuelle d'abonnés.",
    props: { projectId, months: { type: "integer", minimum: 3, maximum: 24, description: "Nombre de mois (défaut 12)" } }, required: ["projectId"],
    run: (a, call) => call("GET", `${P(a)}/cohorts`, { query: { months: a.months } }) },
  { name: "get_ltv_prediction", title: "LTV prédite", description: "LTV prédite à 12/24 mois par produit, pays ou store (modèle sBG sur la rétention des cohortes).",
    props: { projectId, groupBy: { type: "string", enum: ["product", "country", "store"] } }, required: ["projectId"],
    run: (a, call) => call("GET", `${P(a)}/ltv-prediction`, { query: { groupBy: a.groupBy } }) },
  { name: "get_benchmarks", title: "Benchmarks", description: "Compare le business aux autres de sa catégorie (conversion, churn, ARPU…).",
    props: { projectId }, required: ["projectId"], run: (a, call) => call("GET", `${P(a)}/benchmarks`) },
  { name: "get_paywall_stats", title: "Stats des paywalls", description: "Impressions, conversions et revenu par paywall/offre.",
    props: { projectId, days: days(30) }, required: ["projectId"], run: (a, call) => call("GET", `${P(a)}/paywall-stats`, { query: { days: a.days } }) },
  { name: "get_experiment_results", title: "Résultats d'expérience", description: "Résultats d'un test A/B de paywall (inscrits, conversions, revenu par variante, significativité).",
    props: { projectId, experimentId: { type: "string" } }, required: ["projectId", "experimentId"],
    run: (a, call) => call("GET", `${P(a)}/experiments/${enc(a.experimentId)}/results`) },

  // ── Clients et transactions ──────────────────────────────────────────────
  { name: "list_customers", title: "Clients", description: "Clients récents (accès actifs, payant, total dépensé, pays). Pagination avec after = lastSeenAt du dernier.",
    props: { projectId, limit: limit(50, 200), paying: { type: "boolean", description: "Seulement les clients payants" }, after: { type: "number" } }, required: ["projectId"],
    run: (a, call) => call("GET", `${P(a)}/customers`, { query: { limit: a.limit, paying: a.paying ? "true" : undefined, after: a.after } }) },
  { name: "get_customer", title: "Fiche client", description: "Fiche client complète : accès, achats, attributs, attribution Apple Ads, portefeuille, 100 derniers événements.",
    props: { projectId, customerId: { type: "string", description: "appUserId" } }, required: ["projectId", "customerId"],
    run: async (a, call) => {
      const [customer, wallet] = await Promise.all([call("GET", `${P(a)}/customers/${enc(a.customerId)}`),
        call("GET", `${P(a)}/customers/${enc(a.customerId)}/wallet`).catch(() => null)]);
      return wallet ? { ...customer, wallet } : customer;
    } },
  { name: "list_transactions", title: "Transactions", description: "Dernières transactions (montant, devise, store, produit, pays, bac à sable).",
    props: { projectId, limit: limit(100, 500) }, required: ["projectId"], run: (a, call) => call("GET", `${P(a)}/transactions`, { query: { limit: a.limit } }) },
  { name: "list_events", title: "Événements", description: "Derniers événements de cycle de vie (achat, renouvellement, essai, résiliation, remboursement, problème de facturation…). Pagination : before = timestamp ms.",
    props: { projectId, limit: limit(100, 500), before: { type: "number" } }, required: ["projectId"],
    run: (a, call) => call("GET", `${P(a)}/events`, { query: { limit: a.limit, before: a.before } }) },
  { name: "list_refund_requests", title: "Demandes de remboursement", description: "Demandes de remboursement App Store reçues et réponses envoyées.",
    props: { projectId, limit: limit(200, 500), sandbox: { type: "boolean" } }, required: ["projectId"],
    run: (a, call) => call("GET", `${P(a)}/refund-requests`, { query: { limit: a.limit, sandbox: a.sandbox ? "true" : undefined } }) },
  { name: "export_csv", title: "Export CSV", description: "Export CSV brut (clients, transactions ou événements), tronqué à maxRows lignes.",
    props: { projectId, kind: { type: "string", enum: ["customers", "transactions", "events"] }, maxRows: limit(500, 5000) }, required: ["projectId", "kind"],
    run: async (a, call) => csvHead(await call("GET", `${P(a)}/export/${enc(a.kind)}`), Math.min(5000, Number(a.maxRows ?? 500))) },
  { name: "list_audiences", title: "Audiences", description: "Segments de clients enregistrés et leur taille.",
    props: { projectId }, required: ["projectId"], run: (a, call) => call("GET", `${P(a)}/audiences`) },
  { name: "preview_audience", title: "Tester un segment", description: "Compte les clients correspondant à des filtres (store, pays, produit, statut, dépense…) sans rien enregistrer.",
    props: { projectId, filters: { type: "object", description: "Filtres d'audience (même format que le dashboard)" } }, required: ["projectId", "filters"],
    run: (a, call) => call("POST", `${P(a)}/audiences/preview`, { body: { filters: a.filters } }) },
  { name: "list_audience_customers", title: "Clients d'une audience", description: "Clients d'une audience enregistrée (pagination par cursor).",
    props: { projectId, audienceId: { type: "string" }, limit: limit(100, 500), cursor: { type: "integer" } }, required: ["projectId", "audienceId"],
    run: (a, call) => call("GET", `${P(a)}/audiences/${enc(a.audienceId)}/customers`, { query: { limit: a.limit, cursor: a.cursor } }) },

  // ── Alertes, anomalies, insights ─────────────────────────────────────────
  { name: "list_alerts", title: "Alertes", description: "Alertes (ventes, classements, avis, problèmes de facturation…) d'un business, ou de tous si projectId est omis.",
    props: { projectId: { type: "string", description: "Optionnel : un seul business" }, limit: limit(100, 300) },
    run: (a, call) => a.projectId ? call("GET", `${P(a)}/alerts`, { query: { limit: a.limit } }) : call("GET", "/v1/alerts") },
  { name: "list_anomalies", title: "Anomalies", description: "Anomalies détectées (pics ou chutes de revenu, essais, churn) avec leur écart statistique.",
    props: { projectId, limit: limit(50, 200) }, required: ["projectId"], run: (a, call) => call("GET", `${P(a)}/anomalies`, { query: { limit: a.limit } }) },
  { name: "list_insights", title: "Insights", description: "Insights générés pour tous les business (tendances, opportunités, conseils).",
    run: (_a, call) => call("GET", "/v1/insights") },

  // ── Finance ──────────────────────────────────────────────────────────────
  { name: "get_finance", title: "Finance", description: "Du brut au net : commissions des stores, TVA, charges sociales, impôts, dépenses, net en poche, versements attendus.",
    props: { days: days(28), projectIds }, run: (a, call) => call("GET", "/v1/finance", { query: { days: a.days, projectIds: ids(a.projectIds) } }) },
  { name: "get_finance_plan", title: "Plan financier", description: "Projection et plan pour atteindre un objectif de revenu net mensuel.",
    props: { days: days(28), goal: { type: "number", description: "Objectif net mensuel (unités de devise, ex. 10000)" }, projectIds },
    run: (a, call) => call("GET", "/v1/finance/plan", { query: { days: a.days, goal: a.goal, projectIds: ids(a.projectIds) } }) },
  { name: "get_accounting_export", title: "Export comptable", description: "Export CSV comptable d'un mois (ventes, commissions, TVA).",
    props: { month: { type: "string", pattern: "^\\d{4}-\\d{2}$", description: "AAAA-MM (défaut : mois en cours)" }, projectIds },
    run: async (a, call) => csvHead(await call("GET", "/v1/finance/export", { query: { month: a.month, projectIds: ids(a.projectIds) } }), 2000) },
  { name: "list_expenses", title: "Dépenses", description: "Dépenses récurrentes déclarées (abonnements, outils…).", run: (_a, call) => call("GET", "/v1/expenses") },

  // ── App Store ────────────────────────────────────────────────────────────
  { name: "list_tracked_apps", title: "Apps suivies", description: "Apps App Store suivies (les siennes et les concurrents) avec note, nombre d'avis et meilleurs classements.",
    props: { projectId }, required: ["projectId"], run: (a, call) => call("GET", `${P(a)}/appstore`) },
  { name: "get_app_rankings", title: "Classements App Store", description: "Classements d'une app suivie par pays et catégorie (rang, rang précédent, historique).",
    props: { projectId, appId }, required: ["projectId", "appId"], run: (a, call) => call("GET", `${P(a)}/appstore/${enc(a.appId)}/ranks`) },
  { name: "get_app_ratings", title: "Notes App Store", description: "Notes moyennes et nombre d'avis d'une app suivie, par pays.",
    props: { projectId, appId }, required: ["projectId", "appId"], run: (a, call) => call("GET", `${P(a)}/appstore/${enc(a.appId)}/ratings`) },
  { name: "list_app_reviews", title: "Avis App Store", description: "Derniers avis d'une app suivie, filtrables par pays et par note.",
    props: { projectId, appId, country: { type: "string" }, rating: { type: "integer", minimum: 1, maximum: 5 }, limit: limit(50, 200) }, required: ["projectId", "appId"],
    run: (a, call) => call("GET", `${P(a)}/appstore/${enc(a.appId)}/reviews`, { query: { country: a.country, rating: a.rating, limit: a.limit } }) },
  { name: "translate_review", title: "Traduire un avis", description: "Traduit un avis App Store (mis en cache).",
    props: { projectId, appId, reviewId: { type: "string" }, target: { type: "string", description: "Langue cible (défaut fr)" } }, required: ["projectId", "appId", "reviewId"],
    run: (a, call) => call("POST", `${P(a)}/appstore/${enc(a.appId)}/reviews/${enc(a.reviewId)}/translate`, { body: { target: a.target ?? "fr" } }) },
  { name: "search_app_store", title: "Chercher sur l'App Store", description: "Recherche d'apps sur l'App Store (pour en suivre une : add_tracked_app).",
    props: { term: { type: "string" }, country: { type: "string", description: "Code pays (défaut us)" } }, required: ["term"],
    run: (a, call) => call("GET", "/v1/appstore/search", { query: { term: a.term, country: a.country } }) },

  // ── PostHog ──────────────────────────────────────────────────────────────
  { name: "get_posthog", title: "PostHog", description: "État de la connexion PostHog et résumé produit (utilisateurs actifs, entonnoir d'activation, rétention).",
    props: { projectId, refresh: { type: "boolean", description: "Forcer le recalcul du résumé" } }, required: ["projectId"],
    run: async (a, call) => {
      const state = await call("GET", `${P(a)}/posthog`);
      if (!state.connected) return state;
      return { ...state, ...(await call("GET", `${P(a)}/posthog/summary`, { query: { force: a.refresh ? "1" : undefined } })) };
    } },
  { name: "list_posthog_events", title: "Événements PostHog", description: "Événements PostHog disponibles et proposition d'entonnoir (rôle admin).",
    props: { projectId }, required: ["projectId"], run: (a, call) => call("GET", `${P(a)}/posthog/events`) },

  // ── Configuration et intégrations ────────────────────────────────────────
  { name: "get_project", title: "Configuration du business", description: "Configuration complète : produits et entitlements, offerings, ciblage, expériences, webhooks, apps suivies, alertes, connecteurs (Stripe, App Store, Google Play, RevenueCat, Paddle, AppsFlyer, Amazon, Roku, Galaxy — présence des identifiants, jamais leur valeur) et URL de notifications.",
    props: { projectId }, required: ["projectId"], run: async (a, call) => redactProject(await call("GET", P(a))) },
  { name: "get_setup_checklist", title: "Checklist d'installation", description: "Étapes d'installation détectées automatiquement (SDK, notifications des stores, connecteurs) et prochaine étape.",
    props: { projectId }, required: ["projectId"], run: (a, call) => call("GET", `${P(a)}/setup`) },
  { name: "get_offerings", title: "Offerings", description: "Offres (paywalls), offre courante, ciblage, expériences et entitlements.",
    props: { projectId }, required: ["projectId"],
    run: async (a, call) => { const c = await configOf(a, call);
      return { currentOffering: c.currentOffering ?? null, offerings: c.offerings ?? {}, targeting: c.targeting ?? null, experiments: c.experiments ?? [], entitlements: c.entitlements ?? {} }; } },
  { name: "get_public_listing", title: "Fiche du classement public", description: "Inscription au classement public MoneyMaker (affiché, accroche, site, montants masqués).",
    props: { projectId }, required: ["projectId"], run: (a, call) => call("GET", `${P(a)}/public`) },
  { name: "get_leaderboard", title: "Classement public", description: "Classement public des business vérifiés par les stores.",
    props: { sort: { type: "string", enum: ["mrr", "revenue"] }, limit: limit(100, 500) },
    run: (a, call) => call("GET", "/v1/leaderboard", { query: { sort: a.sort, limit: a.limit } }) },

  // ── Équipe ───────────────────────────────────────────────────────────────
  { name: "list_members", title: "Membres", description: "Membres du business et leur rôle (owner, admin, developer, viewer), et invitations en attente si admin.",
    props: { projectId }, required: ["projectId"],
    run: async (a, call) => {
      const members = await call("GET", `${P(a)}/members`);
      const invites = await call("GET", `${P(a)}/invites`).catch(() => null);
      return invites ? { ...members, invites: invites.invites } : members;
    } },
  { name: "get_audit_log", title: "Journal d'audit", description: "Qui a modifié quoi et quand dans le business (pagination : before = timestamp ms).",
    props: { projectId, limit: limit(100, 500), before: { type: "number" } }, required: ["projectId"],
    run: (a, call) => call("GET", `${P(a)}/audit`, { query: { limit: a.limit, before: a.before } }) },

  // ══ Écritures ═══════════════════════════════════════════════════════════
  { name: "create_project", title: "Créer un business", write: true,
    description: "Crée un business. Avec appStoreAppId, pré-remplit bundle id et Apple ID et suit l'app. Renvoie la clé publique du SDK ; la clé secrète n'est jamais affichée ici (la régénérer dans le dashboard si besoin).",
    props: { name: { type: "string" }, appStoreAppId: { type: "string", description: "ID App Store numérique (search_app_store)" },
      googlePackageName: { type: "string" }, currency: { type: "string", description: "Devise ISO (défaut EUR)" } }, required: ["name"],
    run: async (a, call) => {
      const out = await call("POST", "/v1/projects", { body: { name: a.name, appStoreAppId: a.appStoreAppId, googlePackageName: a.googlePackageName,
        ...(a.currency ? { config: { currency: a.currency } } : {}) } });
      const { secretKey, note, ...rest } = out ?? {};
      return { ...rest, secretKey: secretKey ? "(générée, non affichée : dashboard › Clés pour en créer une nouvelle)" : undefined };
    } },
  { name: "update_project", title: "Modifier la configuration", write: true,
    description: "Met à jour le nom et/ou des champs de configuration (currency, entitlements, webhooks, apple, google, website, category, mode, customerCenter, audiences, virtualCurrencies, targeting, experiments, refundControl, integrations.appsflyer). Chaque champ fourni REMPLACE la valeur entière : lire get_project d'abord et renvoyer la liste complète. Pour les offerings, utiliser update_offerings.",
    props: { projectId, name: { type: "string" }, config: { type: "object", description: "Champs de configuration à remplacer" } }, required: ["projectId"],
    run: async (a, call) => {
      if (!a.name && !a.config) throw new Error("name ou config requis");
      if (a.config && ("offerings" in a.config || "currentOffering" in a.config)) throw new Error("Utilise update_offerings pour les offerings");
      return redactProject(await call("PATCH", P(a), { body: { name: a.name, config: a.config ?? {} } }));
    } },
  { name: "update_offerings", title: "Modifier les offerings", write: true,
    description: "Remplace les offres (objet complet { id: { description?, packages: [{ id, productIds: { app_store?, play_store?, stripe? } }] } }) et/ou l'offre courante. Lire get_offerings d'abord.",
    props: { projectId, offerings: { type: "object" }, currentOffering: { type: "string" } }, required: ["projectId"],
    run: async (a, call) => {
      const config: Record<string, unknown> = {};
      if (a.offerings !== undefined) config.offerings = typeof a.offerings === "string" ? JSON.parse(a.offerings) : a.offerings;
      if (a.currentOffering !== undefined) config.currentOffering = a.currentOffering;
      if (!Object.keys(config).length) throw new Error("offerings ou currentOffering requis");
      const p = await call("PATCH", P(a), { body: { config } });
      return { currentOffering: p.config?.currentOffering ?? null, offerings: p.config?.offerings ?? {} };
    } },
  { name: "set_alert_preferences", title: "Préférences d'alertes", write: true,
    description: "Réglages de détection d'anomalies : activée, seuil (2 à 6 écarts-types, défaut 3), résumé hebdomadaire.",
    props: { projectId, enabled: { type: "boolean" }, threshold: { type: "number", minimum: 2, maximum: 6 }, weeklySummary: { type: "boolean" } }, required: ["projectId"],
    run: async (a, call) => {
      const cur = (await configOf(a, call)).anomalies ?? {};
      const anomalies = { enabled: a.enabled ?? cur.enabled ?? true, threshold: a.threshold ?? cur.threshold ?? 3, weeklySummary: a.weeklySummary ?? cur.weeklySummary ?? true };
      return { anomalies: (await call("PATCH", P(a), { body: { config: { anomalies } } })).config?.anomalies };
    } },
  { name: "add_tracked_app", title: "Suivre une app", write: true, description: "Ajoute une app App Store au suivi (classements, notes, avis) et lance un premier scan.",
    props: { projectId, appId, own: { type: "boolean", description: "true : app du business ; false : concurrent (défaut true)" } }, required: ["projectId", "appId"],
    run: async (a, call) => {
      const apps = ((await configOf(a, call)).appStore?.apps ?? []).filter((x: any) => x.appId !== String(a.appId));
      return call("PUT", `${P(a)}/appstore`, { body: { apps: [...apps, { appId: String(a.appId), own: a.own !== false }] } });
    } },
  { name: "remove_tracked_app", title: "Ne plus suivre une app", write: true, destructive: true, description: "Retire une app du suivi App Store (son historique de classements n'est plus mis à jour).",
    props: { projectId, appId, confirm }, required: ["projectId", "appId"],
    run: async (a, call) => {
      const apps = (await configOf(a, call)).appStore?.apps ?? [];
      if (!apps.some((x: any) => x.appId === String(a.appId))) throw new Error("app_not_tracked");
      return call("PUT", `${P(a)}/appstore`, { body: { apps: apps.filter((x: any) => x.appId !== String(a.appId)) } });
    } },
  { name: "refresh_app_store", title: "Relancer un scan App Store", write: true, description: "Relance le scan des classements, notes et avis des apps suivies.",
    props: { projectId }, required: ["projectId"], run: (a, call) => call("POST", `${P(a)}/appstore/refresh`) },
  { name: "grant_entitlement", title: "Offrir un accès", write: true,
    description: "Offre un accès promotionnel à un client (days jours, ou à vie sans days). days=0 retire l'accès : demande alors confirm=true.",
    props: { projectId, customerId: { type: "string" }, entitlement: { type: "string" }, days: { type: "integer", minimum: 0 }, confirm }, required: ["projectId", "customerId", "entitlement"],
    run: async (a, call) => {
      if (a.days === 0 && a.confirm !== true) return needsConfirm(`Retirer l'accès « ${a.entitlement} » au client ${a.customerId}`);
      return call("POST", `${P(a)}/customers/${enc(a.customerId)}/grant`, { body: { entitlement: a.entitlement, ...(a.days !== undefined ? { days: Number(a.days) } : {}) } });
    } },
  { name: "send_test_webhook", title: "Tester les webhooks", write: true, description: "Envoie un événement TEST aux webhooks et intégrations configurés.",
    props: { projectId }, required: ["projectId"], run: (a, call) => call("POST", `${P(a)}/webhooks/test`) },
  { name: "update_public_listing", title: "Modifier la fiche publique", write: true, description: "Inscription au classement public : affiché ou non, accroche, site, montants masqués (rôle admin).",
    props: { projectId, listed: { type: "boolean" }, tagline: { type: "string", maxLength: 120 }, website: { type: "string" }, hideAmounts: { type: "boolean" } }, required: ["projectId"],
    run: (a, call) => call("PUT", `${P(a)}/public`, { body: { listed: a.listed, tagline: a.tagline, website: a.website, hideAmounts: a.hideAmounts } }) },
  { name: "update_finance_settings", title: "Réglages finance", write: true,
    description: "Statut fiscal et taux (structure : micro_services, micro_vente, micro_liberal, sasu_is, eurl_is, llc_us, uae_freezone, custom ; taux 0–1 : incomeTaxRate, socialRate, googleRate, stripePercent… ; booléens : vatFranchise, appleSmallBusiness, showNet ; country, companyName).",
    props: { settings: { type: "object" } }, required: ["settings"], run: (a, call) => call("PUT", "/v1/finance/settings", { body: a.settings }) },
  { name: "upsert_expense", title: "Ajouter/modifier une dépense", write: true, description: "Crée ou remplace une dépense récurrente (montant en unités de devise).",
    props: { id: { type: "string", description: "Identifiant court (ex. figma)" }, name: { type: "string" }, amount: { type: "number" }, currency: { type: "string" },
      every: { type: "string", enum: ["month", "year"] }, projectId: { type: "string", description: "Optionnel : rattacher à un business" }, category: { type: "string" } },
    required: ["id", "name", "amount"],
    run: (a, call) => call("PUT", `/v1/expenses/${enc(a.id)}`, { body: { name: a.name, amount: a.amount, currency: a.currency, every: a.every, projectId: a.projectId, category: a.category } }) },
  { name: "delete_expense", title: "Supprimer une dépense", write: true, destructive: true, description: "Supprime une dépense récurrente.",
    props: { id: { type: "string" }, confirm }, required: ["id"], run: (a, call) => call("DELETE", `/v1/expenses/${enc(a.id)}`) },
  { name: "invite_member", title: "Inviter un membre", write: true, description: "Crée un lien d'invitation (aucun e-mail n'est envoyé : partager le lien). Rôles : admin, developer, viewer.",
    props: { projectId, email: { type: "string" }, role: { type: "string", enum: ["admin", "developer", "viewer"] } }, required: ["projectId", "email"],
    run: (a, call) => call("POST", `${P(a)}/invites`, { body: { email: a.email, role: a.role ?? "viewer" } }) },
  { name: "update_member_role", title: "Changer un rôle", write: true, description: "Change le rôle d'un membre (admin, developer, viewer).",
    props: { projectId, uid: { type: "string" }, role: { type: "string", enum: ["admin", "developer", "viewer"] } }, required: ["projectId", "uid", "role"],
    run: (a, call) => call("PATCH", `${P(a)}/members/${enc(a.uid)}`, { body: { role: a.role } }) },
  { name: "remove_member", title: "Retirer un membre", write: true, destructive: true, description: "Retire un membre du business (il perd l'accès).",
    props: { projectId, uid: { type: "string" }, confirm }, required: ["projectId", "uid"], run: (a, call) => call("DELETE", `${P(a)}/members/${enc(a.uid)}`) },
  { name: "revoke_invite", title: "Annuler une invitation", write: true, destructive: true, description: "Annule une invitation en attente.",
    props: { projectId, inviteId: { type: "string" }, confirm }, required: ["projectId", "inviteId"], run: (a, call) => call("DELETE", `${P(a)}/invites/${enc(a.inviteId)}`) },
  // ── Connexions (onboarding depuis l'assistant) : les secrets vont à l'API, jamais renvoyés ──
  { name: "connect_stripe", title: "Connecter Stripe", write: true,
    description: "Branche Stripe avec une clé secrète (sk_live_/sk_test_) ou restreinte (rk_ : lecture Abonnements, Factures, Clients, Paiements + écriture Webhook Endpoints) : crée le webhook et importe l'historique. La clé n'est jamais renvoyée.",
    props: { projectId, secretKey: { type: "string", description: "sk_… ou rk_…" } }, required: ["projectId", "secretKey"],
    run: (a, call) => call("POST", `${P(a)}/connect/stripe`, { body: { secretKey: a.secretKey } }) },
  { name: "connect_app_store", title: "Connecter App Store Connect", write: true,
    description: "Branche App Store Connect avec une clé API (rôle App Manager ou Admin : issuerId, keyId, contenu du .p8). Trouve l'app (appAppleId ou bundle id du business), règle les notifications serveur V2 si l'URL est vide (ou si setNotificationUrl=true), importe les produits et suit l'app.",
    props: { projectId, issuerId: { type: "string" }, keyId: { type: "string" }, privateKey: { type: "string", description: "Contenu complet du fichier .p8 (BEGIN PRIVATE KEY)" },
      appAppleId: { type: "string", description: "Apple ID numérique de l'app" }, setNotificationUrl: { type: "boolean", description: "Remplacer une URL de notifications existante (demander à l'utilisateur)" } },
    required: ["projectId", "issuerId", "keyId", "privateKey"],
    run: (a, call) => call("POST", `${P(a)}/connect/appstore`, { body: { issuerId: a.issuerId, keyId: a.keyId, privateKey: a.privateKey, appAppleId: a.appAppleId, setNotificationUrl: a.setNotificationUrl } }) },
  { name: "connect_google_play", title: "Connecter Google Play", write: true,
    description: "Branche Google Play avec le JSON d'un compte de service invité dans la Play Console (droits « Voir les données financières » et « Gérer les commandes »). Importe les abonnements et renvoie l'endpoint Pub/Sub RTDN à configurer.",
    props: { projectId, packageName: { type: "string" }, serviceAccount: { type: "string", description: "Contenu JSON du compte de service" } }, required: ["projectId", "packageName", "serviceAccount"],
    run: (a, call) => call("POST", `${P(a)}/connect/google`, { body: { packageName: a.packageName, serviceAccount: a.serviceAccount } }) },
  { name: "import_revenuecat", title: "Importer depuis RevenueCat", write: true,
    description: "Lance l'import en arrière-plan de l'historique RevenueCat (clé secrète sk_, effacée après l'import). Suivre avec get_import_status.",
    props: { projectId, secretKey: { type: "string", description: "Clé secrète RevenueCat sk_…" }, revenueCatProjectId: { type: "string" },
      appUserIds: { type: "array", items: { type: "string" }, description: "Optionnel : limiter à ces clients" } }, required: ["projectId", "secretKey"],
    run: (a, call) => call("POST", `${P(a)}/import/revenuecat`, { body: { secretKey: a.secretKey, revenueCatProjectId: a.revenueCatProjectId, appUserIds: a.appUserIds } }) },
  { name: "get_import_status", title: "Suivre un import", description: "État d'un import (queued, running, done, failed) et son résultat.",
    props: { projectId, jobId: { type: "string" } }, required: ["projectId", "jobId"], run: (a, call) => call("GET", `${P(a)}/import/${enc(a.jobId)}`) },
  { name: "connect_posthog", title: "Connecter PostHog", write: true,
    description: "Branche PostHog (clé personnelle phx_ avec lecture query/project, host eu ou us ou URL, projectId numérique) et propose l'entonnoir d'événements (rôle admin).",
    props: { projectId, apiKey: { type: "string" }, host: { type: "string", description: "eu, us ou https://…" }, posthogProjectId: { type: "string" },
      events: { type: "object", description: "Optionnel : étape de l'entonnoir → nom d'événement" } }, required: ["projectId", "posthogProjectId"],
    run: async (a, call) => { const r = await call("PUT", `${P(a)}/posthog`, { body: { apiKey: a.apiKey, host: a.host, projectId: a.posthogProjectId, events: a.events } }); return { connected: r.connected, config: r.config, events: r.events?.slice(0, 40) }; } },
  { name: "set_store_credentials", title: "Enregistrer des clés de store", write: true,
    description: "Enregistre côté serveur d'autres secrets (rôle admin) : apple { issuerId, keyId, privateKey } (clé In-App Purchase), stripe { webhookSecret }, paddle { apiKey, webhookSecret, environment }, amazon { sharedSecret, packageName }, roku { devApiKey }, appsflyer { devKey }. Renvoie seulement les noms enregistrés.",
    props: { projectId, credentials: { type: "object" } }, required: ["projectId", "credentials"],
    run: (a, call) => call("PUT", `${P(a)}/credentials`, { body: a.credentials }) },
  { name: "send_test_push", title: "Push de test", write: true, description: "Envoie une notification de test sur les iPhone où l'app MoneyMaker est connectée au compte.",
    run: (_a, call) => call("POST", "/v1/devices/test") },
  { name: "disconnect_posthog", title: "Déconnecter PostHog", write: true, destructive: true, description: "Supprime la connexion PostHog et sa clé (rôle admin).",
    props: { projectId, confirm }, required: ["projectId"], run: (a, call) => call("DELETE", `${P(a)}/posthog`) },
];

export function needsConfirm(action: string) {
  return { confirmationRequired: true, action,
    message: "Action destructive : rien n'a été fait. Demande l'accord explicite de l'utilisateur, puis rappelle l'outil avec confirm=true." };
}

/** Format MCP tools/list. */
export function toolList(writeAllowed: boolean) {
  return TOOLS.filter(t => writeAllowed || !t.write).map(t => ({
    name: t.name, title: t.title, description: t.description,
    inputSchema: { type: "object", properties: t.props ?? {}, required: t.required ?? [], additionalProperties: false },
    annotations: { title: t.title, readOnlyHint: !t.write, destructiveHint: Boolean(t.destructive), idempotentHint: !t.write, openWorldHint: false },
  }));
}
