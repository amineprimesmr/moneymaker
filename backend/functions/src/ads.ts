// Monétisation publicitaire (AdMob, AppLovin, ironSource…).
//
// (a) Revenu publicitaire au niveau de l'impression, envoyé par le SDK (POST /v1/customers/:id/ad-events, clé publique)
//     avec les valeurs du « paid event handler » de Google Mobile Ads (valueMicros, currencyCode, precision).
//     Brut : projects/{pid}/adEvents/{auto} ; agrégats : projects/{pid}/adDaily/{YYYY-MM-DD}.
// (b) AdMob Server-Side Verification (récompenses) : GET /v1/admob/ssv/:pid. Signature ECDSA P-256 / SHA-256 (DER,
//     base64 web-safe) sur la query string brute précédant « &signature= », clé choisie par key_id dans
//     https://www.gstatic.com/admob/reward/verifier-keys.json (cache ≤ 24 h). Crédit idempotent par transaction_id
//     via wallet.moveWallet si config.admob.rewards[adUnit] mappe une monnaie virtuelle.
// (c) Graphiques ad_revenue, ad_impressions, ad_ecpm, arpdau (DAU = snapshot quotidien de customers.lastSeenAt).

import { createPublicKey, verify as cryptoVerify, KeyObject } from "crypto";
import { convertMicros } from "./engine";
import type { Resolution } from "./charts";

export const AD_EVENT_TYPES = ["impression", "click", "rewarded"] as const;
export type AdEventType = typeof AD_EVENT_TYPES[number];
/** Valeurs de AdValue.PrecisionType (Google Mobile Ads) : 0 UNKNOWN, 1 ESTIMATED, 2 PUBLISHER_PROVIDED, 3 PRECISE. */
export const AD_PRECISIONS = ["unknown", "estimated", "publisher_provided", "precise"] as const;

export interface AdEvent {
  type: AdEventType; network: string; adUnitId: string; placement: string | null;
  revenueMicros: number; currency: string; precision: string; appUserId: string; at: number;
}

const bad = (code: string): never => { throw new Error(code); };
const cleanStr = (v: unknown, max: number, code: string, required = true): string | null => {
  if (v === undefined || v === null || v === "") return required ? bad(code) : null;
  const s = String(v).trim();
  if (!s || s.length > max || /[\u0000-\u001f]/.test(s)) bad(code);
  return s;
};

export function parsePrecision(v: unknown): string {
  if (v === undefined || v === null || v === "") return "unknown";
  if (typeof v === "number" || /^\d$/.test(String(v))) return AD_PRECISIONS[Number(v)] ?? bad("invalid_precision");
  const s = String(v).toLowerCase().replace(/[\s-]/g, "_");
  if ((AD_PRECISIONS as readonly string[]).includes(s)) return s;
  return bad("invalid_precision");
}

/** Pure : valide le corps de POST /ad-events. */
export function sanitizeAdEvent(b: any, appUserId: string, now: number): AdEvent {
  const type = String(b?.type ?? "impression") as AdEventType;
  if (!AD_EVENT_TYPES.includes(type)) bad("invalid_type");
  const network = cleanStr(b?.network ?? "admob", 64, "invalid_network")!.toLowerCase();
  const adUnitId = cleanStr(b?.adUnitId, 200, "invalid_ad_unit")!;
  const placement = cleanStr(b?.placement, 100, "invalid_placement", false);
  const raw = b?.revenueMicros ?? b?.valueMicros ?? 0;
  const revenueMicros = Number(raw);
  if (!Number.isFinite(revenueMicros) || revenueMicros < 0 || revenueMicros > 1e11) bad("invalid_revenue");
  const currency = String(b?.currency ?? b?.currencyCode ?? "USD").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) bad("invalid_currency");
  return { type, network, adUnitId, placement, revenueMicros: Math.round(revenueMicros), currency, precision: parsePrecision(b?.precision), appUserId, at: now };
}

export interface AdDay {
  date: string; revenueMicros: number; impressions: number; clicks: number; rewarded: number;
  byNetwork?: Record<string, { revenueMicros: number; impressions: number }>;
}

/** Pure : incréments du document quotidien pour un événement (revenu converti dans la devise du projet). */
export function dailyIncrements(e: AdEvent, projectCurrency: string) {
  const rev = convertMicros(e.revenueMicros, e.currency, projectCurrency);
  const net = e.network.replace(/[.\/]/g, "_");
  return {
    revenueMicros: rev,
    impressions: e.type === "impression" ? 1 : 0, clicks: e.type === "click" ? 1 : 0, rewarded: e.type === "rewarded" ? 1 : 0,
    network: net,
  };
}

/** Pure : agrège des événements bruts en jours (même logique que les incréments Firestore). */
export function aggregateAdEvents(events: AdEvent[], projectCurrency: string): Record<string, AdDay> {
  const out: Record<string, AdDay> = {};
  for (const e of events) {
    const date = new Date(e.at).toISOString().slice(0, 10);
    const inc = dailyIncrements(e, projectCurrency);
    const d = (out[date] ??= { date, revenueMicros: 0, impressions: 0, clicks: 0, rewarded: 0, byNetwork: {} });
    d.revenueMicros += inc.revenueMicros; d.impressions += inc.impressions; d.clicks += inc.clicks; d.rewarded += inc.rewarded;
    const n = (d.byNetwork![inc.network] ??= { revenueMicros: 0, impressions: 0 });
    n.revenueMicros += inc.revenueMicros; n.impressions += inc.impressions;
  }
  return out;
}

// ── Graphiques ───────────────────────────────────────────────────────────────
export const AD_CHART_NAMES = ["ad_revenue", "ad_impressions", "ad_ecpm", "arpdau"] as const;

/** Pure : graphique pub sur des buckets (charts.buckets). `dau` = date → utilisateurs actifs ce jour-là. */
export function computeAdChart(name: string, days: AdDay[], dau: Record<string, number>, bs: { date: string; start: number; end: number }[], currency: string, resolution: Resolution) {
  if (!(AD_CHART_NAMES as readonly string[]).includes(name)) bad("unknown_chart");
  const rows = bs.map(b => ({ date: b.date, revenue: 0, impressions: 0, dau: 0, dauDays: 0 }));
  const idx = (date: string) => { const t = Date.parse(date + "T00:00:00Z"); return bs.findIndex(b => t >= b.start && t < b.end); };
  for (const d of days) { const i = idx(d.date); if (i < 0) continue; rows[i].revenue += d.revenueMicros ?? 0; rows[i].impressions += d.impressions ?? 0; }
  for (const [date, n] of Object.entries(dau)) { const i = idx(date); if (i < 0 || !(n > 0)) continue; rows[i].dau += n; rows[i].dauDays++; }
  const tot = rows.reduce((a, r) => ({ revenue: a.revenue + r.revenue, impressions: a.impressions + r.impressions, dau: a.dau + r.dau }), { revenue: 0, impressions: 0, dau: 0 });
  const ecpm = (rev: number, imp: number) => (imp ? Math.round((rev / imp) * 1000) : null);
  // ARPDAU d'un bucket = revenu des jours avec DAU connu / somme des DAU de ces jours.
  const revWithDau = (r: typeof rows[number], i: number) => days.filter(d => idx(d.date) === i && dau[d.date] > 0).reduce((a, d) => a + d.revenueMicros, 0);
  let unit: "micros" | "count", series: any[], summary: Record<string, number | string | null>, note: string | undefined;
  switch (name) {
    case "ad_revenue":
      unit = "micros"; series = rows.map(r => ({ date: r.date, value: r.revenue, revenue: r.revenue, impressions: r.impressions }));
      summary = { value: tot.revenue, revenue: tot.revenue, impressions: tot.impressions }; break;
    case "ad_impressions":
      unit = "count"; series = rows.map(r => ({ date: r.date, value: r.impressions }));
      summary = { value: tot.impressions }; break;
    case "ad_ecpm":
      unit = "micros"; series = rows.map(r => ({ date: r.date, value: ecpm(r.revenue, r.impressions), revenue: r.revenue, impressions: r.impressions }));
      summary = { value: ecpm(tot.revenue, tot.impressions), revenue: tot.revenue, impressions: tot.impressions }; break;
    default: {
      unit = "micros";
      let rSum = 0;
      series = rows.map((r, i) => { const rv = r.dau ? revWithDau(r, i) : 0; rSum += rv; return { date: r.date, value: r.dau ? Math.round(rv / r.dau) : null, revenue: rv, dau: r.dauDays ? Math.round(r.dau / r.dauDays) : null }; });
      summary = { value: tot.dau ? Math.round(rSum / tot.dau) : null, revenue: rSum };
      if (!tot.dau) note = "DAU inconnu : il est relevé chaque nuit à partir de customers.lastSeenAt (snapshot quotidien).";
    }
  }
  return { name, unit, resolution, currency, series, summary, ...(note ? { note } : {}) };
}

// ── AdMob SSV ────────────────────────────────────────────────────────────────
export const ADMOB_KEYS_URL = "https://www.gstatic.com/admob/reward/verifier-keys.json";

export interface SsvParams {
  content: string; signature: Buffer; keyId: string;
  adNetwork: string | null; adUnit: string | null; customData: string | null; rewardAmount: number; rewardItem: string | null;
  timestamp: number | null; transactionId: string | null; userId: string | null;
}

/**
 * Pure : découpe la query string brute d'un callback SSV. Le contenu signé est tout ce qui précède « &signature= »
 * (Google garantit que signature et key_id sont les derniers paramètres).
 */
export function parseSsvQuery(rawQuery: string): SsvParams {
  const q = rawQuery.startsWith("?") ? rawQuery.slice(1) : rawQuery;
  const i = q.indexOf("&signature=");
  if (i < 0) bad("missing_signature");
  const content = q.slice(0, i);
  const params = new URLSearchParams(q);
  const sig = params.get("signature"), keyId = params.get("key_id");
  if (!sig) bad("missing_signature");
  if (!keyId || !/^\d{1,20}$/.test(keyId)) bad("missing_key_id");
  const c = new URLSearchParams(content);
  const num = (v: string | null) => (v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    content, signature: Buffer.from(sig!.replace(/-/g, "+").replace(/_/g, "/"), "base64"), keyId: keyId!,
    adNetwork: c.get("ad_network"), adUnit: c.get("ad_unit"), customData: c.get("custom_data"),
    rewardAmount: num(c.get("reward_amount")) ?? 0, rewardItem: c.get("reward_item"),
    timestamp: num(c.get("timestamp")), transactionId: c.get("transaction_id"), userId: c.get("user_id"),
  };
}

export type KeyMap = Map<string, KeyObject>;

/** Pure : clés publiques depuis le JSON du serveur de clés AdMob ({ keys: [{ keyId, pem, base64 }] }). */
export function parseVerifierKeys(json: any): KeyMap {
  const m: KeyMap = new Map();
  for (const k of json?.keys ?? []) {
    try {
      const key = k.pem ? createPublicKey(k.pem) : createPublicKey({ key: Buffer.from(String(k.base64), "base64"), format: "der", type: "spki" });
      m.set(String(k.keyId), key);
    } catch { /* clé illisible ignorée */ }
  }
  return m;
}

/** Pure : vérifie la signature ECDSA-SHA256 (DER) du contenu. */
export function verifySsv(p: SsvParams, keys: KeyMap): boolean {
  const key = keys.get(p.keyId);
  if (!key) bad("unknown_key_id");
  try { return cryptoVerify("sha256", Buffer.from(p.content, "utf8"), { key: key!, dsaEncoding: "der" }, p.signature); }
  catch { return false; }
}

let keyCache: { keys: KeyMap; at: number } | null = null;
const KEY_TTL = 12 * 3600000; // Google : ne pas garder plus de 24 h (rotation).

export async function admobKeys(force = false, fetchImpl: typeof fetch = fetch): Promise<KeyMap> {
  if (!force && keyCache && Date.now() - keyCache.at < KEY_TTL) return keyCache.keys;
  const res = await fetchImpl(ADMOB_KEYS_URL, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) bad("admob_keys_unavailable");
  keyCache = { keys: parseVerifierKeys(await res.json()), at: Date.now() };
  return keyCache.keys;
}
export function _setKeyCacheForTests(keys: KeyMap | null) { keyCache = keys ? { keys, at: Date.now() } : null; }

export interface AdRewardRule { currency: string; amount?: number }
/** config.admob = { rewards: { [adUnitId]: { currency: "GEMS", amount?: 10 } } } (amount absent → reward_amount du callback). */
export function sanitizeAdmobConfig(input: any, currencyCodes: string[]): { rewards: Record<string, AdRewardRule> } {
  const r = input?.rewards ?? {};
  if (typeof r !== "object" || Array.isArray(r) || Object.keys(r).length > 100) bad("invalid_admob_rewards");
  const rewards: Record<string, AdRewardRule> = {};
  for (const [unit, v] of Object.entries<any>(r)) {
    if (!unit || unit.length > 200) bad("invalid_admob_rewards");
    const currency = String(v?.currency ?? "").toUpperCase();
    if (!currencyCodes.includes(currency)) bad("unknown_virtual_currency");
    const amount = v?.amount === undefined || v?.amount === null ? undefined : Number(v.amount);
    if (amount !== undefined && (!Number.isInteger(amount) || amount <= 0 || amount > 1e9)) bad("invalid_admob_rewards");
    rewards[unit] = { currency, ...(amount ? { amount } : {}) };
  }
  return { rewards };
}

/** Pure : récompense à créditer (null si l'ad unit n'est pas mappée ou le montant est nul). */
export function rewardFor(p: SsvParams, rules: Record<string, AdRewardRule> | undefined) {
  const rule = p.adUnit ? rules?.[p.adUnit] : undefined;
  if (!rule) return null;
  const amount = rule.amount ?? Math.floor(p.rewardAmount);
  if (!Number.isInteger(amount) || amount <= 0 || amount > 1e9) return null;
  return { currency: rule.currency, amount };
}

// ── Firestore ────────────────────────────────────────────────────────────────

export async function recordAdEvent(project: import("./store").Project, e: AdEvent) {
  const { db } = await import("./store");
  const { FieldValue } = await import("firebase-admin/firestore");
  const inc = dailyIncrements(e, project.config.currency);
  const date = new Date(e.at).toISOString().slice(0, 10);
  const batch = db.batch();
  batch.set(db.collection(`projects/${project.id}/adEvents`).doc(), { ...e, revenueMicrosProject: inc.revenueMicros });
  batch.set(db.doc(`projects/${project.id}/adDaily/${date}`), {
    date, currency: project.config.currency,
    revenueMicros: FieldValue.increment(inc.revenueMicros), impressions: FieldValue.increment(inc.impressions),
    clicks: FieldValue.increment(inc.clicks), rewarded: FieldValue.increment(inc.rewarded),
    byNetwork: { [inc.network]: { revenueMicros: FieldValue.increment(inc.revenueMicros), impressions: FieldValue.increment(inc.impressions) } },
  }, { merge: true });
  batch.set(db.doc(`projects/${project.id}/customers/${e.appUserId}`), { appUserId: e.appUserId, lastSeenAt: e.at }, { merge: true });
  await batch.commit();
}

/** Traite un callback SSV : vérifie, journalise (idempotent) et crédite le portefeuille. */
export async function handleSsv(project: import("./store").Project, rawQuery: string) {
  const { db } = await import("./store");
  const { moveWallet } = await import("./wallet");
  const p = parseSsvQuery(rawQuery);
  let keys = await admobKeys();
  if (!keys.has(p.keyId)) keys = await admobKeys(true); // rotation : nouvelle clé pas encore en cache
  if (!verifySsv(p, keys)) bad("invalid_signature");
  // Le testeur AdMob envoie un callback sans transaction_id ni user_id : signature valide, rien à créditer.
  if (!p.transactionId) return { ok: true, verified: true, credited: false, reason: "no_transaction_id" };
  const txid = p.transactionId.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 128);
  const ref = db.doc(`projects/${project.id}/adRewards/${txid}`);
  const reward = rewardFor(p, (project.config as any).admob?.rewards);
  const userId = p.userId ? p.userId.slice(0, 200) : null;
  const base = { transactionId: txid, adUnit: p.adUnit, adNetwork: p.adNetwork, rewardItem: p.rewardItem, rewardAmount: p.rewardAmount, customData: p.customData?.slice(0, 500) ?? null, appUserId: userId, timestamp: p.timestamp, at: Date.now() };
  if (!reward || !userId) {
    await ref.set({ ...base, credited: false, reason: !userId ? "no_user_id" : "unmapped_ad_unit" }, { merge: true });
    return { ok: true, verified: true, credited: false, reason: !userId ? "no_user_id" : "unmapped_ad_unit" };
  }
  // Idempotence portée par le journal du portefeuille (clé = admob:{transaction_id}).
  const r = await moveWallet(project.id, userId, reward.currency, reward.amount, "grant", `admob:${txid}`, "admob_reward");
  await ref.set({ ...base, credited: true, currency: reward.currency, amount: reward.amount, replayed: r.replayed }, { merge: true });
  return { ok: true, verified: true, credited: !r.replayed, replayed: r.replayed, currency: reward.currency, amount: reward.amount, balance: r.balance };
}

/** Graphique pub (lecture adDaily + DAU des snapshots quotidiens). */
export async function projectAdChart(project: import("./store").Project, name: string, q: Record<string, unknown>) {
  const { db } = await import("./store");
  const { buckets } = await import("./charts");
  const DAY = 86400000, now = Date.now();
  const days = Math.min(1095, Math.max(1, Number(q.days ?? 30) || 30));
  const resolution: Resolution = q.resolution === "week" || q.resolution === "month" ? q.resolution : "day";
  const start = now - (days - 1) * DAY;
  const from = new Date(start).toISOString().slice(0, 10);
  const [adSnap, dailySnap] = await Promise.all([
    db.collection(`projects/${project.id}/adDaily`).where("date", ">=", from).get(),
    db.collection(`projects/${project.id}/daily`).where("date", ">=", from).get(),
  ]);
  const dau: Record<string, number> = {};
  dailySnap.docs.forEach(d => { const n = Number(d.get("dau")); if (n > 0) dau[d.get("date")] = n; });
  const r = computeAdChart(name, adSnap.docs.map(d => d.data() as AdDay), dau, buckets(start, now, resolution), project.config.currency, resolution);
  return { ...r, days, filters: {} };
}

/** Revenu pub d'une fenêtre (devise du projet) — pour « revenu pub inclus ». */
export async function adRevenueSince(projectId: string, since: number) {
  const { db } = await import("./store");
  const snap = await db.collection(`projects/${projectId}/adDaily`).where("date", ">=", new Date(since).toISOString().slice(0, 10)).get();
  return snap.docs.reduce((a, d) => ({ revenueMicros: a.revenueMicros + Number(d.get("revenueMicros") ?? 0), impressions: a.impressions + Number(d.get("impressions") ?? 0) }), { revenueMicros: 0, impressions: 0 });
}
