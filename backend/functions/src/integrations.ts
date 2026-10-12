// Third-party fan-out for subscription events and App Store alerts (RevenueCat-style integrations).
import { Project, Credentials } from "./store";
import * as C from "./connectors";

export interface IntegrationSecrets {
  slackWebhookUrl?: string;
  discordWebhookUrl?: string;
  mixpanelToken?: string;
  amplitudeApiKey?: string;
  segmentWriteKey?: string;
  posthog?: { apiKey: string; host?: string };
  // Server-side connectors (see connectors.ts). Each accepts `sandbox: true` to also forward sandbox events.
  meta?: C.MetaCfg & Sbx; adjust?: C.AdjustCfg & Sbx; branch?: C.BranchCfg & Sbx; singular?: C.SingularCfg & Sbx;
  kochava?: C.KochavaCfg & Sbx; tenjin?: C.TenjinCfg & Sbx; braze?: C.BrazeCfg & Sbx; onesignal?: C.OneSignalCfg & Sbx;
  iterable?: C.IterableCfg & Sbx; customerio?: C.CustomerIoCfg & Sbx; clevertap?: C.CleverTapCfg & Sbx; airship?: C.AirshipCfg & Sbx;
  intercom?: C.IntercomCfg & Sbx; ga4?: C.Ga4Cfg & Sbx; mparticle?: C.MParticleCfg & Sbx; statsig?: C.StatsigCfg & Sbx;
  telemetrydeck?: C.TelemetryDeckCfg & Sbx;
}
type Sbx = { sandbox?: boolean };

/** Field schema for connectors: "k" = secret/key (8..300 chars), "s" = id string, "u" = https URL, "e:a|b" = enum, "m" = event→token map. */
const SCHEMA: Record<string, Record<string, string>> = {
  meta: { datasetId: "!s", accessToken: "!k", apiVersion: "s", testEventCode: "s" },
  adjust: { appToken: "!s", s2sToken: "!k", eventTokens: "!m" },
  branch: { branchKey: "!k" }, singular: { sdkKey: "!k" }, kochava: { appGuid: "!s" }, tenjin: { apiKey: "!k" },
  braze: { restEndpoint: "!u:braze", apiKey: "!k" }, onesignal: { appId: "!s", restApiKey: "!k" },
  iterable: { apiKey: "!k", region: "e:us|eu" }, customerio: { siteId: "!s", apiKey: "!k", region: "e:us|eu" },
  clevertap: { accountId: "!s", passcode: "!k", region: "s" }, airship: { token: "!k", region: "e:us|eu" },
  intercom: { accessToken: "!k", region: "e:us|eu|au" }, ga4: { firebaseAppId: "!s", apiSecret: "!k", androidFirebaseAppId: "s" },
  mparticle: { apiKey: "!k", apiSecret: "!k", pod: "e:us1|us2|eu1|au1" }, statsig: { serverSecret: "!k" }, telemetrydeck: { appId: "!s" },
};
export const CONNECTORS = Object.keys(SCHEMA);

const LABELS: Record<string, string> = {
  INITIAL_PURCHASE: "💰 Nouvel abonné", RENEWAL: "🔁 Renouvellement", TRIAL_STARTED: "✨ Essai démarré", TRIAL_CONVERTED: "🎉 Essai converti",
  CANCELLATION: "⚠️ Annulation", UNCANCELLATION: "↩️ Réactivation", EXPIRATION: "⌛ Expiration", BILLING_ISSUE: "💳 Problème de paiement",
  BILLING_RECOVERED: "✅ Paiement récupéré", REFUND: "↩️ Remboursement", PRODUCT_CHANGE: "🔀 Changement d'offre", NON_RENEWING_PURCHASE: "💰 Achat",
  REVOKED: "⛔ Révoqué", PAUSED: "⏸️ En pause", GRANT: "🎁 Accès offert", CUSTOMER_CENTER_FEEDBACK: "📝 Retour Customer Center", TEST: "🧪 Test",
  NEW_COUNTRY: "🌍 Nouveau pays", TOP_100: "📈 Entrée dans le top 100", TOP_10: "🏆 Top 10", TOP_1: "🥇 Numéro 1", JUMP: "🚀 Forte hausse", DROP: "📉 Forte baisse",
};
const CHART_LABEL: Record<string, string> = { free: "Gratuites", paid: "Payantes", grossing: "Revenus" };

const money = (micros: number, currency: string) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: currency || "EUR" }).format((micros ?? 0) / 1e6);

/** Human one-liner used by Slack / Discord. Pure — unit-tested. */
export function describe(project: Project, e: Record<string, any>): string {
  const label = LABELS[e.type] ?? e.type;
  if (e.cc && e.chart) {
    const where = `${e.cc} · ${CHART_LABEL[e.chart] ?? e.chart}${e.scope === "genre" ? " (catégorie)" : ""}`;
    const move = e.prevRank ? ` (avant #${e.prevRank})` : "";
    return `${label} — *${e.appName ?? e.appId}* #${e.rank ?? "–"} ${where}${move}`;
  }
  // Anomalies et résumé hebdomadaire (anomalies.ts) : titre + texte déjà rédigés.
  if (typeof e.title === "string" && typeof e.body === "string" && (String(e.type).startsWith("ANOMALY_") || e.type === "WEEKLY_SUMMARY")) return `*${e.title}* — ${e.body}`;
  if (e.type === "CUSTOMER_CENTER_FEEDBACK") return `${label} — *${project.name}* · ${e.action} · « ${e.reason} »${e.comment ? ` — ${String(e.comment).slice(0, 300)}` : ""}`;
  const amount = e.priceMicros && !e.isTrial ? ` · ${money(e.priceMicros, e.currency)}` : "";
  const where = e.country ? ` · ${e.country}` : "";
  return `${label} — *${project.name}* · ${e.productId ?? ""}${amount}${where} · ${e.store ?? ""}${e.isSandbox ? " (sandbox)" : ""}`;
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${new URL(url).hostname} ${res.status}`);
}

/** Sends one event to every configured integration. Returns per-integration status; never throws. */
export async function fanOut(project: Project, creds: Credentials, e: Record<string, any>, kind: "event" | "alert") {
  const s = (creds as any).integrations as IntegrationSecrets | undefined;
  if (!s) return {};
  const status: Record<string, string> = {};
  const run = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); status[name] = "sent"; } catch (err) { status[name] = `error: ${(err as Error).message}`; }
  };
  const text = describe(project, e);
  const jobs: Promise<void>[] = [];
  if (s.slackWebhookUrl) jobs.push(run("slack", () => post(s.slackWebhookUrl!, { text })));
  if (s.discordWebhookUrl) jobs.push(run("discord", () => post(s.discordWebhookUrl!, { content: text.replace(/\*/g, "**") })));

  // Analytics tools only get real subscription events (not ranking alerts, not sandbox).
  if (kind === "event" && !e.isSandbox && e.type !== "TEST") {
    const props = {
      product_id: e.productId, store: e.store, price: e.priceMicros ? e.priceMicros / 1e6 : 0, currency: e.currency,
      country: e.country ?? undefined, is_trial: Boolean(e.isTrial), project: project.name,
    };
    const name = `mm_${String(e.type).toLowerCase()}`;
    const time = Number(e.at ?? Date.now());
    if (s.mixpanelToken) jobs.push(run("mixpanel", () => post("https://api.mixpanel.com/track", [{
      event: name, properties: { ...props, token: s.mixpanelToken, distinct_id: e.appUserId, time: Math.floor(time / 1000), $insert_id: e.id },
    }])));
    if (s.amplitudeApiKey) jobs.push(run("amplitude", () => post("https://api2.amplitude.com/2/httpapi", {
      api_key: s.amplitudeApiKey, events: [{ user_id: e.appUserId, event_type: name, time, insert_id: e.id, event_properties: props,
        ...(e.priceMicros && !e.isTrial ? { revenue: e.priceMicros / 1e6, productId: e.productId } : {}) }],
    })));
    if (s.segmentWriteKey) jobs.push(run("segment", () => post("https://api.segment.io/v1/track", {
      userId: e.appUserId, event: name, properties: { ...props, revenue: props.price }, timestamp: new Date(time).toISOString(), messageId: e.id,
    }, { Authorization: `Basic ${Buffer.from(`${s.segmentWriteKey}:`).toString("base64")}` })));
    if (s.posthog?.apiKey) jobs.push(run("posthog", () => post(`${(s.posthog!.host ?? "https://eu.i.posthog.com").replace(/\/$/, "")}/capture/`, {
      api_key: s.posthog!.apiKey, event: name, distinct_id: e.appUserId, properties: { ...props, $insert_id: e.id }, timestamp: new Date(time).toISOString(),
    })));
  }
  if (kind === "event" && e.type !== "TEST") jobs.push(sendConnectors(project, s, e, status));
  await Promise.all(jobs);
  return status;
}

/** Sends to every configured server-side connector. Failures are recorded in `status` (and logged), never thrown. */
async function sendConnectors(project: Project, s: IntegrationSecrets, e: Record<string, any>, status: Record<string, string>) {
  const active = CONNECTORS.filter(k => (s as any)[k] && (!e.isSandbox || (s as any)[k].sandbox));
  if (!active.length) return;
  let attrs: C.Attrs = {};
  try {
    const { db } = await import("./store");
    attrs = (await db.doc(`projects/${project.id}/customers/${e.appUserId}`).get()).get("attributes") ?? {};
  } catch (err) { console.warn("connectors: customer read failed", (err as Error).message); }
  const app: C.AppIds = { bundleId: project.config.apple?.bundleId, packageName: project.config.google?.packageName };
  const x = s as any;
  const builders: Record<string, () => C.Req | null> = {
    meta: () => C.buildMeta(x.meta, e, attrs, app), adjust: () => C.buildAdjust(x.adjust, e, attrs), branch: () => C.buildBranch(x.branch, e, attrs),
    singular: () => C.buildSingular(x.singular, e, attrs, app), kochava: () => C.buildKochava(x.kochava, e, attrs), tenjin: () => C.buildTenjin(x.tenjin, e, attrs, app),
    braze: () => C.buildBraze(x.braze, e, attrs), onesignal: () => C.buildOneSignal(x.onesignal, e, attrs), iterable: () => C.buildIterable(x.iterable, e, attrs),
    customerio: () => C.buildCustomerIo(x.customerio, e, attrs), clevertap: () => C.buildCleverTap(x.clevertap, e, attrs), airship: () => C.buildAirship(x.airship, e, attrs),
    intercom: () => C.buildIntercomEvent(x.intercom, e, attrs), ga4: () => C.buildGa4(x.ga4, e, attrs), mparticle: () => C.buildMParticle(x.mparticle, e, attrs),
    statsig: () => C.buildStatsig(x.statsig, e), telemetrydeck: () => C.buildTelemetryDeck(x.telemetrydeck, e),
  };
  await Promise.all(active.map(async name => {
    try {
      const req = builders[name]();
      if (!req) { status[name] = "skipped"; return; }
      await send(req);
      if (name === "intercom") await intercomAttributes(x.intercom, e, attrs);
      status[name] = "sent";
    } catch (err) {
      status[name] = `error: ${(err as Error).message}`;
      console.warn(`connector ${name} failed`, project.id, e.id, (err as Error).message);
    }
  }));
}

async function send(r: C.Req) {
  const isForm = Boolean(r.form);
  const res = await fetch(r.url, {
    method: r.method ?? "POST", redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { ...(r.method === "GET" ? {} : { "Content-Type": isForm ? "application/x-www-form-urlencoded" : "application/json" }), ...r.headers },
    body: r.method === "GET" ? undefined : isForm ? new URLSearchParams(Object.entries(r.form!).filter(([, v]) => v !== undefined) as [string, string][]).toString() : JSON.stringify(r.body),
  });
  if (!res.ok) throw new Error(`${new URL(r.url).hostname} ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** Intercom: find the contact by external_id, then set custom attributes (they must exist in the Intercom workspace). */
async function intercomAttributes(cfg: C.IntercomCfg, e: any, a: C.Attrs) {
  const headers = { Authorization: `Bearer ${cfg.accessToken}`, "Intercom-Version": "2.11", "Content-Type": "application/json", Accept: "application/json" };
  const host = C.intercomHost(cfg);
  const r = await fetch(`${host}/contacts/search`, { method: "POST", headers, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ query: { field: "external_id", operator: "=", value: a.$intercomId ?? e.appUserId } }) });
  const id = r.ok ? (await r.json() as any).data?.[0]?.id : undefined;
  if (!id) return;
  const u = await fetch(`${host}/contacts/${id}`, { method: "PUT", headers, signal: AbortSignal.timeout(10000), body: JSON.stringify({ custom_attributes: C.intercomAttributes(e) }) });
  if (!u.ok) console.warn("intercom attributes", u.status);
}

/** Validates one connector config against SCHEMA. Pure — unit-tested. */
export function sanitizeConnector(name: string, v: any): any {
  const schema = SCHEMA[name];
  if (!schema) throw new Error("unknown_integration");
  if (v === null || v === undefined || v === false) return undefined;
  if (typeof v !== "object") throw new Error(`invalid_${name}`);
  const out: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(schema)) {
    const required = spec.startsWith("!"), kind = spec.replace(/^!/, "");
    const raw = v[field];
    if (raw === undefined || raw === null || raw === "") { if (required) throw new Error(`missing_${name}_${field}`); continue; }
    if (kind === "k") { if (typeof raw !== "string" || raw.length < 8 || raw.length > 600) throw new Error(`invalid_${name}_${field}`); out[field] = raw.trim(); }
    else if (kind === "s") { if (typeof raw !== "string" || !/^[\w.:\-]{1,200}$/.test(raw.trim())) throw new Error(`invalid_${name}_${field}`); out[field] = raw.trim(); }
    else if (kind.startsWith("u")) {
      const host = kind.split(":")[1];
      let u: URL; try { u = new URL(String(raw)); } catch { throw new Error(`invalid_${name}_${field}`); }
      if (u.protocol !== "https:" || (host && !u.hostname.includes(host))) throw new Error(`invalid_${name}_${field}`);
      out[field] = u.origin;
    } else if (kind.startsWith("e:")) { if (!kind.slice(2).split("|").includes(raw)) throw new Error(`invalid_${name}_${field}`); out[field] = raw; }
    else if (kind === "m") {
      if (typeof raw !== "object") throw new Error(`invalid_${name}_${field}`);
      const m = Object.fromEntries(Object.entries<any>(raw).filter(([, t]) => t).map(([k, t]) => {
        if (!/^[A-Z_]{3,40}$/.test(k) || !/^[a-z0-9]{4,20}$/i.test(String(t))) throw new Error(`invalid_${name}_${field}`);
        return [k, String(t)];
      }));
      if (required && !Object.keys(m).length) throw new Error(`missing_${name}_${field}`);
      out[field] = m;
    }
  }
  if (v.sandbox) out.sandbox = true;
  return out;
}

/** Validates and normalises integration secrets sent from the dashboard / API. */
export function sanitizeIntegrations(input: any, current: IntegrationSecrets = {}): IntegrationSecrets {
  const next: IntegrationSecrets = { ...current };
  const url = (v: unknown, host: RegExp) => {
    if (v === null || v === "") return undefined;
    if (typeof v !== "string" || !/^https:\/\//.test(v) || !host.test(new URL(v).hostname)) throw new Error("invalid_url");
    return v;
  };
  const key = (v: unknown) => (v === null || v === "" ? undefined : typeof v === "string" && v.length >= 8 && v.length < 300 ? v : (() => { throw new Error("invalid_key"); })());
  if ("slackWebhookUrl" in input) next.slackWebhookUrl = url(input.slackWebhookUrl, /(^|\.)slack\.com$/);
  if ("discordWebhookUrl" in input) next.discordWebhookUrl = url(input.discordWebhookUrl, /(^|\.)discord(app)?\.com$/);
  if ("mixpanelToken" in input) next.mixpanelToken = key(input.mixpanelToken);
  if ("amplitudeApiKey" in input) next.amplitudeApiKey = key(input.amplitudeApiKey);
  if ("segmentWriteKey" in input) next.segmentWriteKey = key(input.segmentWriteKey);
  if ("posthog" in input) next.posthog = input.posthog?.apiKey
    ? { apiKey: key(input.posthog.apiKey)!, host: input.posthog.host ? url(input.posthog.host, /posthog/) : undefined } : undefined;
  // Blank fields keep the stored value, so the dashboard never needs to re-display secrets. `null` removes the connector.
  for (const name of CONNECTORS) if (name in input) {
    const v = input[name];
    const merged = v && typeof v === "object" ? { ...((current as any)[name] ?? {}), ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== "" && x !== undefined)) } : v;
    if (v && typeof v === "object" && "sandbox" in v) merged.sandbox = Boolean(v.sandbox);
    (next as any)[name] = sanitizeConnector(name, merged);
  }
  return JSON.parse(JSON.stringify(next));
}
