// Third-party fan-out for subscription events and App Store alerts (RevenueCat-style integrations).
import { Project, Credentials } from "./store";

export interface IntegrationSecrets {
  slackWebhookUrl?: string;
  discordWebhookUrl?: string;
  mixpanelToken?: string;
  amplitudeApiKey?: string;
  segmentWriteKey?: string;
  posthog?: { apiKey: string; host?: string };
}

const LABELS: Record<string, string> = {
  INITIAL_PURCHASE: "💰 Nouvel abonné", RENEWAL: "🔁 Renouvellement", TRIAL_STARTED: "✨ Essai démarré", TRIAL_CONVERTED: "🎉 Essai converti",
  CANCELLATION: "⚠️ Annulation", UNCANCELLATION: "↩️ Réactivation", EXPIRATION: "⌛ Expiration", BILLING_ISSUE: "💳 Problème de paiement",
  BILLING_RECOVERED: "✅ Paiement récupéré", REFUND: "↩️ Remboursement", PRODUCT_CHANGE: "🔀 Changement d'offre", NON_RENEWING_PURCHASE: "💰 Achat",
  REVOKED: "⛔ Révoqué", PAUSED: "⏸️ En pause", GRANT: "🎁 Accès offert", TEST: "🧪 Test",
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
  await Promise.all(jobs);
  return status;
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
  return JSON.parse(JSON.stringify(next));
}
