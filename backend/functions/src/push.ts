// Native iOS push: APNs over HTTP/2 with a token-based (.p8) key. No third-party SDK.
//
// Four kinds of pushes leave from here, all to the MoneyMaker iOS app (io.moneymaker.app):
//   alert         — "cha-ching" sale / trial / churn / ranking notifications
//   liveactivity  — update (or push-to-start) the "Aujourd'hui" Live Activity
//   widgets       — iOS 26 WidgetKit push: tells every widget to reload now
//   background    — content-available nudge for older iOS (app reloads widgets)
//
// Devices live in users/{uid}/devices/{id}. Dead tokens (410 / BadDeviceToken) are pruned on the spot.

import { connect, ClientHttp2Session, constants } from "http2";
import { createPrivateKey, sign, KeyObject } from "crypto";
import { db, Project } from "./store";
import { convertMicros } from "./engine";

export const BUNDLE_ID = "io.moneymaker.app";

// ── Device registry ─────────────────────────────────────────────────────────

export interface PushPrefs {
  sales: boolean;       // INITIAL_PURCHASE, NON_RENEWING_PURCHASE, TRIAL_CONVERTED
  renewals: boolean;    // RENEWAL
  trials: boolean;      // TRIAL_STARTED
  churn: boolean;       // CANCELLATION, EXPIRATION
  billing: boolean;     // BILLING_ISSUE, BILLING_RECOVERED
  refunds: boolean;     // REFUND, REVOKED
  rankings: boolean;    // App Store ranking alerts
  dailySummary: boolean;
  sandbox: boolean;     // also notify for sandbox purchases (testing)
  sound: boolean;       // cha-ching vs default sound
  liveActivityAuto: boolean; // server starts the Live Activity on the first sale of the day
  mutedProjects: string[];
}

export const DEFAULT_PREFS: PushPrefs = {
  sales: true, renewals: true, trials: true, churn: false, billing: true, refunds: true, rankings: true,
  dailySummary: true, sandbox: false, sound: true, liveActivityAuto: true, mutedProjects: [],
};

export interface Device {
  id: string;
  apnsToken?: string;
  env: "sandbox" | "production";
  widgetPushToken?: string;
  liveActivity?: { pushToStartToken?: string; updateToken?: string; startedAt?: number };
  prefs: PushPrefs;
  tz: string;
  currency: string;
  updatedAt: number;
}

const HEX = /^[0-9a-f]{32,400}$/i;

/** Validates a device payload from the app. Pure — unit-tested. */
export function sanitizeDevice(id: string, body: any, current?: Partial<Device>): Device {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw new Error("invalid_device_id");
  const tok = (v: unknown, prev?: string) => v === undefined ? prev : v === null || v === "" ? undefined
    : typeof v === "string" && HEX.test(v) ? v.toLowerCase() : (() => { throw new Error("invalid_token"); })();
  const prefsIn = body?.prefs ?? {};
  const prev = { ...DEFAULT_PREFS, ...(current?.prefs ?? {}) };
  const prefs = Object.fromEntries(Object.entries(prev).map(([k, v]) =>
    [k, k === "mutedProjects"
      ? (Array.isArray(prefsIn.mutedProjects) ? prefsIn.mutedProjects.map(String).slice(0, 100) : v)
      : typeof prefsIn[k] === "boolean" ? prefsIn[k] : v])) as unknown as PushPrefs;
  const la = body?.liveActivity ?? {};
  let tz = typeof body?.tz === "string" ? body.tz : current?.tz ?? "UTC";
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { tz = "UTC"; }
  return JSON.parse(JSON.stringify({
    id,
    apnsToken: tok(body?.apnsToken, current?.apnsToken),
    env: body?.env === "sandbox" || body?.env === "production" ? body.env : current?.env ?? "production",
    widgetPushToken: tok(body?.widgetPushToken, current?.widgetPushToken),
    liveActivity: {
      pushToStartToken: tok(la.pushToStartToken, current?.liveActivity?.pushToStartToken),
      updateToken: tok(la.updateToken, current?.liveActivity?.updateToken),
      startedAt: la.updateToken ? Date.now() : la.updateToken === null ? undefined : current?.liveActivity?.startedAt,
    },
    prefs, tz,
    currency: typeof body?.currency === "string" && /^[A-Z]{3}$/.test(body.currency) ? body.currency : current?.currency ?? "EUR",
    updatedAt: Date.now(),
  }));
}

export async function devicesFor(uids: string[]): Promise<(Device & { uid: string })[]> {
  const lists = await Promise.all(uids.map(async uid =>
    (await db.collection(`users/${uid}/devices`).get()).docs.map(d => ({ ...(d.data() as Device), uid }))));
  return lists.flat();
}

// ── Event → notification ────────────────────────────────────────────────────

const PREF_FOR: Record<string, keyof PushPrefs> = {
  INITIAL_PURCHASE: "sales", NON_RENEWING_PURCHASE: "sales", TRIAL_CONVERTED: "sales", RENEWAL: "renewals",
  TRIAL_STARTED: "trials", CANCELLATION: "churn", EXPIRATION: "churn", BILLING_ISSUE: "billing", BILLING_RECOVERED: "billing",
  REFUND: "refunds", REVOKED: "refunds", UNCANCELLATION: "sales", TEST: "sales",
};

const TITLES: Record<string, string> = {
  INITIAL_PURCHASE: "Nouvel abonné", NON_RENEWING_PURCHASE: "Nouvel achat", TRIAL_CONVERTED: "Essai converti", RENEWAL: "Renouvellement",
  TRIAL_STARTED: "Essai démarré", CANCELLATION: "Annulation", EXPIRATION: "Abonnement expiré", BILLING_ISSUE: "Problème de paiement",
  BILLING_RECOVERED: "Paiement récupéré", REFUND: "Remboursement", REVOKED: "Accès révoqué", UNCANCELLATION: "Réactivation", TEST: "Notification de test",
};

const REVENUE = new Set(["INITIAL_PURCHASE", "NON_RENEWING_PURCHASE", "TRIAL_CONVERTED", "RENEWAL"]);

export function formatMoney(micros: number, currency: string) {
  const v = micros / 1e6;
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: currency || "EUR", maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 }).format(v);
}

const flag = (cc?: string | null) => cc && /^[A-Z]{2}$/i.test(cc)
  ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1f1a5 + c.charCodeAt(0))) : "";

const period = (m?: number) => m === 12 ? "annuel" : m === 1 ? "mensuel" : m === 3 ? "trimestriel" : m === 6 ? "semestriel" : m === 0.25 ? "hebdo" : "";

/** Whether this device wants this event. Pure — unit-tested. */
export function wants(prefs: PushPrefs, projectId: string, e: Record<string, any>): boolean {
  if (prefs.mutedProjects.includes(projectId)) return false;
  if (e.isSandbox && e.type !== "TEST" && !prefs.sandbox) return false;
  const key = PREF_FOR[e.type];
  return Boolean(key && prefs[key]);
}

/** APNs alert payload for a subscription event. Pure — unit-tested. */
export function eventNotification(project: Project, e: Record<string, any>, prefs: PushPrefs, todayMicros?: number, currency = "EUR") {
  const isRevenue = REVENUE.has(e.type) && !e.isTrial && e.priceMicros > 0;
  const amount = e.priceMicros > 0 && !e.isTrial ? formatMoney(e.type === "REFUND" ? -e.priceMicros : e.priceMicros, e.currency) : "";
  const title = isRevenue ? `+${amount} · ${project.name}` : `${TITLES[e.type] ?? e.type} · ${project.name}`;
  const bits = [isRevenue ? TITLES[e.type] : amount, period(e.periodMonths), e.productId, `${flag(e.country)} ${e.country ?? ""}`.trim(), e.isSandbox ? "sandbox" : ""]
    .filter(Boolean);
  const subtitle = isRevenue && todayMicros !== undefined ? `Aujourd'hui : ${formatMoney(todayMicros, currency)}` : undefined;
  const loud = isRevenue || e.type === "BILLING_ISSUE" || e.type === "REFUND";
  return {
    aps: {
      alert: { title, ...(subtitle ? { subtitle } : {}), body: bits.join(" · ") },
      sound: loud && prefs.sound ? (isRevenue ? "cash.caf" : "default") : undefined,
      "thread-id": `project-${project.id}`,
      "interruption-level": isRevenue ? "time-sensitive" : "active",
      "relevance-score": isRevenue ? Math.min(1, 0.5 + (e.priceMicros ?? 0) / 200e6) : 0.3,
      "mutable-content": 1,
      category: isRevenue ? "SALE" : "EVENT",
    },
    projectId: project.id, eventType: e.type, url: `moneymaker://project/${project.id}`,
  };
}

export function rankingNotification(project: Project, a: Record<string, any>) {
  const titles: Record<string, string> = { NEW_COUNTRY: "Nouveau pays", TOP_100: "Retour dans le top 100", TOP_10: "Top 10", TOP_1: "Numéro 1 🥇", JUMP: "Forte hausse", DROP: "Forte baisse" };
  const charts: Record<string, string> = { free: "Gratuites", paid: "Payantes", grossing: "Revenus" };
  return {
    aps: {
      alert: { title: `${titles[a.type] ?? a.type} · ${a.appName ?? project.name}`, body: `#${a.rank ?? "–"} ${flag(a.cc)} ${a.cc} · ${charts[a.chart] ?? a.chart}${a.scope === "genre" ? " · catégorie" : ""}${a.prevRank ? ` (avant #${a.prevRank})` : ""}` },
      sound: a.type === "TOP_1" || a.type === "TOP_10" ? "default" : undefined,
      "thread-id": `rankings-${project.id}`, "interruption-level": "active", category: "RANKING",
    },
    projectId: project.id, url: `moneymaker://project/${project.id}`,
  };
}

// ── Today aggregation (shared by /v1/today, Live Activity and summaries) ────

export interface Today {
  currency: string; tz: string; dayStart: number;
  revenueMicros: number; refundsMicros: number; sales: number; renewals: number; trials: number; newSubscribers: number;
  hourly: number[];             // cumulative net revenue per local hour, 24 values
  last?: { projectName: string; amountMicros: number; currency: string; productId?: string; country?: string | null; at: number };
}

/** Start of the current day in `tz`, as a UTC timestamp. */
export function startOfDay(tz: string, now = Date.now()): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(now)).reduce((o, p) => ({ ...o, [p.type]: p.value }), {} as Record<string, string>);
  const elapsed = ((Number(parts.hour) * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000 + (now % 1000);
  return now - elapsed;
}

/** Pure fold over the day's transactions and events — unit-tested. */
export function foldToday(
  rows: { projectName: string; tx: { amountMicros: number; currency: string; at: number; kind: string; productId?: string; country?: string | null; isSandbox?: boolean }[]; events: { type: string; at: number; isSandbox?: boolean; isTrial?: boolean }[] }[],
  currency: string, tz: string, dayStart: number,
): Today {
  const t: Today = { currency, tz, dayStart, revenueMicros: 0, refundsMicros: 0, sales: 0, renewals: 0, trials: 0, newSubscribers: 0, hourly: new Array(24).fill(0) };
  const hourly = new Array(24).fill(0);
  for (const r of rows) {
    for (const x of r.tx) {
      if (x.isSandbox || x.at < dayStart) continue;
      const v = convertMicros(x.amountMicros, x.currency, currency);
      const h = Math.min(23, Math.max(0, Math.floor((x.at - dayStart) / 3600000)));
      hourly[h] += v;
      if (x.kind === "refund") t.refundsMicros += -v; else {
        t.revenueMicros += v;
        if (x.kind === "renewal") t.renewals++; else t.sales++;
        if (!t.last || x.at > t.last.at) t.last = { projectName: r.projectName, amountMicros: x.amountMicros, currency: x.currency, productId: x.productId, country: x.country, at: x.at };
      }
    }
    for (const e of r.events) {
      if (e.isSandbox || e.at < dayStart) continue;
      if (e.type === "TRIAL_STARTED") t.trials++;
      if (e.type === "INITIAL_PURCHASE" || e.type === "TRIAL_CONVERTED") t.newSubscribers++;
    }
  }
  let acc = 0;
  t.hourly = hourly.map(v => (acc += v));
  return t;
}

export async function todayFor(uid: string, tz: string, currency?: string, projectId?: string): Promise<Today> {
  const snap = await db.collection("projects").where("members", "array-contains", uid).select("name", "config.currency").get();
  const docs = projectId ? snap.docs.filter(d => d.id === projectId) : snap.docs;
  const cur = currency ?? docs[0]?.get("config.currency") ?? "EUR";
  const dayStart = startOfDay(tz);
  const rows = await Promise.all(docs.map(async p => {
    const [tx, ev] = await Promise.all([
      db.collection(`projects/${p.id}/transactions`).where("at", ">=", dayStart).select("amountMicros", "currency", "at", "kind", "productId", "country", "isSandbox").get(),
      db.collection(`projects/${p.id}/events`).where("at", ">=", dayStart).select("type", "at", "isSandbox", "isTrial").get(),
    ]);
    return { projectName: String(p.get("name") ?? ""), tx: tx.docs.map(d => d.data() as any), events: ev.docs.map(d => d.data() as any) };
  }));
  return foldToday(rows, cur, tz, dayStart);
}

/** Live Activity content-state — mirrors `RevenueActivityAttributes.ContentState` in the app. */
export function liveActivityState(t: Today) {
  return {
    revenueMicros: t.revenueMicros - t.refundsMicros, currency: t.currency, sales: t.sales + t.renewals, trials: t.trials,
    lastProject: t.last?.projectName ?? null, lastAmountMicros: t.last?.amountMicros ?? 0, lastCurrency: t.last?.currency ?? t.currency,
    hourly: t.hourly.map(v => Math.round(v / 10000) / 100), updatedAt: Math.floor(Date.now() / 1000),
  };
}

// ── APNs transport ──────────────────────────────────────────────────────────

let jwtCache: { token: string; at: number } | null = null;
let keyObj: KeyObject | null = null;
const sessions = new Map<string, ClientHttp2Session>();

/** APNs .p8 key: env (APNS_KEY / APNS_KEY_ID / APNS_TEAM_ID) or the server-only doc `system/apns` {key, keyId, teamId}. */
let apnsCfg: { key: string; keyId: string; teamId: string } | null | undefined;
let apnsCfgAt = 0;

async function loadApns() {
  if (apnsCfg && Date.now() - apnsCfgAt < 10 * 60000) return apnsCfg;
  if (process.env.APNS_KEY && process.env.APNS_KEY_ID) {
    apnsCfg = { key: process.env.APNS_KEY, keyId: process.env.APNS_KEY_ID, teamId: process.env.APNS_TEAM_ID || "F2CJGJ69XU" };
  } else {
    const d = (await db.doc("system/apns").get().catch(() => null))?.data();
    apnsCfg = d?.key && d?.keyId ? { key: String(d.key), keyId: String(d.keyId), teamId: String(d.teamId ?? "F2CJGJ69XU") } : null;
  }
  if (apnsCfg?.keyId !== jwtKid) { keyObj = null; jwtCache = null; }
  apnsCfgAt = Date.now();
  return apnsCfg;
}
let jwtKid: string | undefined;

export async function apnsConfigured() {
  return Boolean(await loadApns());
}

function providerToken(cfg: { key: string; keyId: string; teamId: string }): string {
  if (jwtCache && Date.now() - jwtCache.at < 45 * 60000) return jwtCache.token;
  keyObj ??= createPrivateKey(cfg.key.replace(/\\n/g, "\n"));
  jwtKid = cfg.keyId;
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "ES256", kid: cfg.keyId })}.${b64({ iss: cfg.teamId, iat: Math.floor(Date.now() / 1000) })}`;
  const sig = sign("sha256", Buffer.from(unsigned), { key: keyObj, dsaEncoding: "ieee-p1363" }).toString("base64url");
  jwtCache = { token: `${unsigned}.${sig}`, at: Date.now() };
  return jwtCache.token;
}

function session(env: Device["env"]): ClientHttp2Session {
  const host = env === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  let s = sessions.get(host);
  if (!s || s.closed || s.destroyed) {
    s = connect(host);
    s.on("error", () => sessions.delete(host));
    s.on("close", () => sessions.delete(host));
    s.unref();
    sessions.set(host, s);
  }
  return s;
}

export type PushType = "alert" | "liveactivity" | "widgets" | "background";

export interface PushResult { status: number; reason?: string }

export async function apnsSend(env: Device["env"], token: string, type: PushType, payload: object, opts: { priority?: 5 | 10; collapseId?: string; expiration?: number } = {}): Promise<PushResult> {
  const cfg = await loadApns();
  if (!cfg) return { status: 0, reason: "apns_not_configured" };
  const topic = type === "liveactivity" ? `${BUNDLE_ID}.push-type.liveactivity` : type === "widgets" ? `${BUNDLE_ID}.push-type.widgets` : BUNDLE_ID;
  return new Promise(resolve => {
    let req;
    try {
      req = session(env).request({
        [constants.HTTP2_HEADER_METHOD]: "POST", [constants.HTTP2_HEADER_PATH]: `/3/device/${token}`,
        authorization: `bearer ${providerToken(cfg)}`, "apns-topic": topic, "apns-push-type": type,
        "apns-priority": String(opts.priority ?? (type === "background" ? 5 : 10)),
        ...(opts.collapseId ? { "apns-collapse-id": opts.collapseId.slice(0, 64) } : {}),
        ...(opts.expiration !== undefined ? { "apns-expiration": String(opts.expiration) } : {}),
      });
    } catch (e) { resolve({ status: 0, reason: (e as Error).message }); return; }
    let status = 0, body = "";
    req.setTimeout(10000, () => { req.close(); resolve({ status: 0, reason: "timeout" }); });
    req.on("response", h => { status = Number(h[":status"]); });
    req.on("data", c => { body += c; });
    req.on("end", () => resolve({ status, reason: body ? JSON.parse(body).reason : undefined }));
    req.on("error", e => resolve({ status: 0, reason: e.message }));
    req.end(JSON.stringify(payload));
  });
}

const DEAD = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic", "ExpiredToken"]);

async function prune(d: Device & { uid: string }, field: "apnsToken" | "widgetPushToken" | "liveActivity.updateToken" | "liveActivity.pushToStartToken", r: PushResult) {
  if (r.status === 410 || (r.reason && DEAD.has(r.reason))) {
    const { FieldValue } = await import("firebase-admin/firestore");
    await db.doc(`users/${d.uid}/devices/${d.id}`).update({ [field]: FieldValue.delete() }).catch(() => null);
  }
}

// ── Orchestration ───────────────────────────────────────────────────────────

/** Every push a subscription event triggers: alert, widget reload, Live Activity. Never throws. */
export async function pushEvent(project: Project, e: Record<string, any>): Promise<Record<string, number>> {
  const devices = await devicesFor(project.members);
  if (!devices.length) return {};
  const stats = { alerts: 0, widgets: 0, live: 0, failed: 0 };
  const isRevenue = REVENUE.has(e.type) || e.type === "REFUND";
  const todayCache = new Map<string, Promise<Today>>();
  const today = (d: Device & { uid: string }) => {
    const k = `${d.uid}|${d.tz}|${d.currency}`;
    if (!todayCache.has(k)) todayCache.set(k, todayFor(d.uid, d.tz, d.currency));
    return todayCache.get(k)!;
  };
  await Promise.all(devices.map(async d => {
    const prefs = { ...DEFAULT_PREFS, ...d.prefs };
    const t = isRevenue && !e.isSandbox ? await today(d).catch(() => undefined) : undefined;
    const jobs: Promise<void>[] = [];
    if (d.apnsToken && wants(prefs, project.id, e)) jobs.push(apnsSend(d.env, d.apnsToken, "alert", eventNotification(project, e, prefs, t ? t.revenueMicros - t.refundsMicros : undefined, d.currency))
      .then(async r => { r.status === 200 ? stats.alerts++ : stats.failed++; await prune(d, "apnsToken", r); }));
    if (isRevenue && !e.isSandbox) {
      if (d.widgetPushToken) jobs.push(apnsSend(d.env, d.widgetPushToken, "widgets", { aps: { "content-changed": true } })
        .then(async r => { if (r.status === 200) stats.widgets++; await prune(d, "widgetPushToken", r); }));
      else if (d.apnsToken) jobs.push(apnsSend(d.env, d.apnsToken, "background", { aps: { "content-available": 1 }, refresh: "widgets" }, { priority: 5, collapseId: "refresh" })
        .then(() => undefined));
      if (t) jobs.push(updateLiveActivity(d, t, prefs, e).then(n => { stats.live += n; }));
    }
    await Promise.all(jobs);
  }));
  return stats;
}

async function updateLiveActivity(d: Device & { uid: string }, t: Today, prefs: PushPrefs, e: Record<string, any>): Promise<number> {
  const state = liveActivityState(t);
  const now = Math.floor(Date.now() / 1000);
  const alert = e.priceMicros > 0 ? { title: `+${formatMoney(e.priceMicros, e.currency)}`, body: `Aujourd'hui : ${formatMoney(state.revenueMicros, t.currency)}` } : undefined;
  const la = d.liveActivity ?? {};
  const fresh = la.updateToken && la.startedAt && Date.now() - la.startedAt < 8 * 3600000;
  if (fresh) {
    const r = await apnsSend(d.env, la.updateToken!, "liveactivity", {
      aps: { timestamp: now, event: "update", "content-state": state, "stale-date": now + 3 * 3600, "relevance-score": 100, ...(alert ? { alert } : {}) },
    }, { priority: 10 });
    await prune(d, "liveActivity.updateToken", r);
    return r.status === 200 ? 1 : 0;
  }
  // Push-to-start (iOS 17.2+): open today's activity on the first sale when the user opted in.
  if (prefs.liveActivityAuto && la.pushToStartToken) {
    const r = await apnsSend(d.env, la.pushToStartToken, "liveactivity", {
      aps: { timestamp: now, event: "start", "content-state": state, "attributes-type": "RevenueActivityAttributes",
        attributes: { title: "Aujourd'hui" }, "stale-date": now + 3 * 3600, ...(alert ? { alert } : { alert: { title: "MoneyMaker", body: "Revenus du jour en direct" } }) },
    }, { priority: 10 });
    await prune(d, "liveActivity.pushToStartToken", r);
    return r.status === 200 ? 1 : 0;
  }
  return 0;
}

export async function pushRanking(project: Project, a: Record<string, any>): Promise<number> {
  const devices = await devicesFor(project.members);
  let sent = 0;
  await Promise.all(devices.filter(d => d.apnsToken && { ...DEFAULT_PREFS, ...d.prefs }.rankings && !(d.prefs?.mutedProjects ?? []).includes(project.id) && (a.own !== false))
    .map(async d => { const r = await apnsSend(d.env, d.apnsToken!, "alert", rankingNotification(project, a)); if (r.status === 200) sent++; await prune(d, "apnsToken", r); }));
  return sent;
}

/** Daily recap at 21:00 local time for every device that wants it. Run hourly. */
export async function sendDailySummaries(now = Date.now()): Promise<number> {
  const snap = await db.collectionGroup("devices").where("prefs.dailySummary", "==", true).get();
  let sent = 0;
  await Promise.all(snap.docs.map(async doc => {
    const d = doc.data() as Device;
    const uid = doc.ref.parent.parent!.id;
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: d.tz, hour: "numeric", hourCycle: "h23" }).format(new Date(now)));
    if (hour !== 21 || !d.apnsToken) return;
    const t = await todayFor(uid, d.tz, d.currency);
    const net = t.revenueMicros - t.refundsMicros;
    const body = net > 0
      ? [`${t.sales} vente${t.sales > 1 ? "s" : ""}`, t.renewals ? `${t.renewals} renouvellement${t.renewals > 1 ? "s" : ""}` : "", t.trials ? `${t.trials} essai${t.trials > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ")
      : t.trials ? `${t.trials} essai${t.trials > 1 ? "s" : ""} démarré${t.trials > 1 ? "s" : ""}, pas encore de vente` : "Pas de vente aujourd'hui — demain sera meilleur.";
    const r = await apnsSend(d.env, d.apnsToken, "alert", {
      aps: { alert: { title: `Ta journée : ${formatMoney(net, t.currency)}`, body }, "thread-id": "daily", "interruption-level": "passive", category: "SUMMARY" },
      url: "moneymaker://today",
    });
    if (r.status === 200) sent++;
    await prune({ ...d, uid }, "apnsToken", r);
  }));
  return sent;
}
