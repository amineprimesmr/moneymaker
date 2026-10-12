// Client REST MoneyMaker partagé par le serveur MCP et la CLI `mm`. Aucune dépendance (fetch de Node ≥ 18).
// Auth : jeton d'accès personnel (mm_pat_…) dans MM_TOKEN. Base : MM_API_URL (défaut https://moneymaker-io.web.app).

export const BASE = (process.env.MM_API_URL ?? "https://moneymaker-io.web.app").replace(/\/$/, "");

export async function call(method, path, { query, body, raw = false } = {}) {
  const token = process.env.MM_TOKEN;
  if (!token) throw new Error("MM_TOKEN manquant : crée un jeton (mm_pat_…) dans le dashboard › Compte, puis export MM_TOKEN=…");
  const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, String(v)])).toString() : "";
  const res = await fetch(`${BASE}${path}${qs ? `?${qs}` : ""}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "moneymaker-tools/1" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text; try { const j = JSON.parse(text); msg = `${j.error}${j.message && j.message !== j.error ? `: ${j.message}` : ""}`; } catch {}
    throw new Error(`HTTP ${res.status} ${msg}`);
  }
  if (raw) return text;
  try { return JSON.parse(text); } catch { return text; }
}

const pid = a => { if (!a.projectId) throw new Error("projectId requis (voir list_projects)"); return encodeURIComponent(a.projectId); };
const id = v => { if (!v) throw new Error("customerId requis"); return encodeURIComponent(v); };

/** Commandes communes : nom → { description, params (JSON Schema properties), required, run(args) }. */
export const COMMANDS = {
  list_projects: { description: "Liste les business (projets) accessibles avec le jeton.", params: {}, required: [],
    run: async () => (await call("GET", "/v1/projects")).projects.map(p => ({ id: p.id, name: p.name, role: p.role, currency: p.config?.currency })) },
  get_overview: { description: "Vue d'ensemble tous business confondus : MRR, revenu, abonnés, essais, nouveaux clients.", params: { days: { type: "number", description: "Période en jours (1-365, défaut 30)" } }, required: [],
    run: a => call("GET", "/v1/overview", { query: { days: a.days } }) },
  get_metrics: { description: "Métriques d'un business : MRR, ARR, revenu, churn, conversion d'essai, LTV, ARPU, historique.",
    params: { projectId: { type: "string" }, days: { type: "number", description: "Période en jours (défaut 30)" } }, required: ["projectId"],
    run: a => call("GET", `/v1/projects/${pid(a)}/metrics`, { query: { days: a.days } }) },
  get_chart: { description: "Un graphique (parité RevenueCat Charts) : mrr, revenue, actives, trials, churn, conversion, retention… (liste via name=list).",
    params: { projectId: { type: "string" }, name: { type: "string", description: "Nom du graphique, ou 'list'" }, days: { type: "number" }, resolution: { type: "string", enum: ["day", "week", "month"] },
      store: { type: "string" }, country: { type: "string" }, product: { type: "string" } }, required: ["projectId", "name"],
    run: a => a.name === "list" ? call("GET", "/v1/charts") : call("GET", `/v1/projects/${pid(a)}/charts/${encodeURIComponent(a.name)}`, { query: { days: a.days, resolution: a.resolution, store: a.store, country: a.country, product: a.product } }) },
  get_ltv_prediction: { description: "LTV prédite à 12/24 mois par produit, pays ou store (modèle sBG sur la rétention des cohortes).",
    params: { projectId: { type: "string" }, groupBy: { type: "string", enum: ["product", "country", "store"] } }, required: ["projectId"],
    run: a => call("GET", `/v1/projects/${pid(a)}/ltv-prediction`, { query: { groupBy: a.groupBy } }) },
  list_customers: { description: "Clients récents d'un business (accès, payant, dépensé).",
    params: { projectId: { type: "string" }, limit: { type: "number", description: "max 200" }, paying: { type: "boolean", description: "Seulement les payants" } }, required: ["projectId"],
    run: a => call("GET", `/v1/projects/${pid(a)}/customers`, { query: { limit: a.limit, paying: a.paying ? "true" : undefined } }) },
  get_customer: { description: "Fiche client : accès, achats, attributs, attribution Apple Ads, 100 derniers événements.",
    params: { projectId: { type: "string" }, customerId: { type: "string", description: "appUserId" } }, required: ["projectId", "customerId"],
    run: a => call("GET", `/v1/projects/${pid(a)}/customers/${id(a.customerId)}`) },
  grant_entitlement: { description: "Offre (ou retire avec days=0) un accès promotionnel à un client. Sans days : à vie.",
    params: { projectId: { type: "string" }, customerId: { type: "string" }, entitlement: { type: "string" }, days: { type: "number" } }, required: ["projectId", "customerId", "entitlement"],
    run: a => call("POST", `/v1/projects/${pid(a)}/customers/${id(a.customerId)}/grant`, { body: { entitlement: a.entitlement, ...(a.days !== undefined ? { days: Number(a.days) } : {}) } }) },
  list_events: { description: "Derniers événements de cycle de vie (achats, renouvellements, résiliations, remboursements…).",
    params: { projectId: { type: "string" }, limit: { type: "number", description: "max 500" }, before: { type: "number", description: "Pagination : timestamp ms du dernier événement reçu" } }, required: ["projectId"],
    run: a => call("GET", `/v1/projects/${pid(a)}/events`, { query: { limit: a.limit, before: a.before } }) },
  get_offerings: { description: "Offres (paywalls), offre courante, ciblage, expériences et accès d'un business.",
    params: { projectId: { type: "string" } }, required: ["projectId"],
    run: async a => { const p = await call("GET", `/v1/projects/${pid(a)}`); const c = p.config ?? {};
      return { currentOffering: c.currentOffering ?? null, offerings: c.offerings ?? {}, targeting: c.targeting ?? null, experiments: c.experiments ?? [], entitlements: c.entitlements ?? {} }; } },
  update_offerings: { description: "Remplace les offres (objet complet { id: { description?, packages: [{ id, productIds: { app_store?, play_store?, stripe? } }] } }) et/ou l'offre courante.",
    params: { projectId: { type: "string" }, offerings: { type: "object" }, currentOffering: { type: "string" } }, required: ["projectId"],
    run: async a => {
      const config = {};
      if (a.offerings !== undefined) config.offerings = typeof a.offerings === "string" ? JSON.parse(a.offerings) : a.offerings;
      if (a.currentOffering !== undefined) config.currentOffering = a.currentOffering;
      if (!Object.keys(config).length) throw new Error("offerings ou currentOffering requis");
      const p = await call("PATCH", `/v1/projects/${pid(a)}`, { body: { config } });
      return { currentOffering: p.config?.currentOffering ?? null, offerings: p.config?.offerings ?? {} };
    } },
};
