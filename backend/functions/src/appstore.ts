// App Store intelligence (Toplify-style): chart rankings in every storefront, alerts, ratings, reviews.
// Data comes from Apple's public feeds, so it also works for competitors' apps.
import { FieldValue } from "firebase-admin/firestore";
import { GoogleAuth } from "google-auth-library";
import { ALL_COUNTRIES } from "./countries";

/** Biggest App Store markets: refreshed every hour. The rest rotate in slices (each every ~6 h). */
export const PRIORITY_COUNTRIES = ["US", "GB", "FR", "DE", "JP", "CN", "KR", "CA", "AU", "IT", "ES", "BR", "MX", "NL", "SE", "CH", "IN", "RU", "TR", "SA", "AE", "TW", "HK", "BE", "PL"];
export const ROTATION_SLICES = 6;

/** Countries to scan on a given hourly run. Pure — unit-tested. */
export function countriesForRun(runIndex: number): string[] {
  const rest = ALL_COUNTRIES.filter(c => !PRIORITY_COUNTRIES.includes(c));
  const slice = rest.filter((_, i) => i % ROTATION_SLICES === ((runIndex % ROTATION_SLICES) + ROTATION_SLICES) % ROTATION_SLICES);
  return [...PRIORITY_COUNTRIES, ...slice];
}
import { HttpError } from "./engine";
import { db } from "./store";

export type Chart = "free" | "paid" | "grossing";
export const CHARTS: Chart[] = ["free", "paid", "grossing"];
const FEED: Record<Chart, string> = { free: "topfreeapplications", paid: "toppaidapplications", grossing: "topgrossingapplications" };
const HISTORY_POINTS = 120;

export interface TrackedApp { appId: string; own?: boolean }

/** Apple throttles bursts with 403/429: every caller shares this cool-down. */
const coolDownUntil = new Map<string, number>(); // per host
const refusals = new Map<string, number>();     // per host, reset each scan
const MAX_REFUSALS = 5;
let throttled = 0;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function getJSON(url: string, attempts = 3): Promise<any> {
  for (let i = 0; i < attempts; i++) {
    const host = new URL(url).host;
    if ((refusals.get(host) ?? 0) >= MAX_REFUSALS) return null; // circuit open for this scan
    const wait = (coolDownUntil.get(host) ?? 0) - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": "MoneyMaker/1 (+https://moneymaker-io.web.app)" } });
      if (res.status === 404) return null;
      if (res.status === 403 || res.status === 429) {
        throttled++;
        refusals.set(host, (refusals.get(host) ?? 0) + 1);
        if ((refusals.get(host) ?? 0) >= MAX_REFUSALS) return null;
        coolDownUntil.set(host, Math.max(coolDownUntil.get(host) ?? 0, Date.now() + 5000 * (i + 1)));
        continue;
      }
      if (res.ok) return await res.json();
    } catch { /* retry */ }
    await sleep(400 * (i + 1));
  }
  return null;
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

const entries = (feed: any): any[] => {
  const e = feed?.feed?.entry;
  return !e ? [] : Array.isArray(e) ? e : [e];
};

/** appId → rank (1-based) for one chart feed. */
export function parseChart(feed: any): Map<string, number> {
  const out = new Map<string, number>();
  entries(feed).forEach((e, i) => {
    const id = e?.id?.attributes?.["im:id"];
    if (id) out.set(String(id), i + 1);
  });
  return out;
}

/** Apple's newer marketing-tools feed (top free / top paid, overall only) — used when the legacy feed is throttled. */
export function parseChartV2(feed: any): Map<string, number> {
  const out = new Map<string, number>();
  (feed?.feed?.results ?? []).forEach((r: any, i: number) => r?.id && out.set(String(r.id), i + 1));
  return out;
}

export function parseReviews(feed: any, country: string) {
  return entries(feed).filter(e => e?.["im:rating"]).map(e => ({
    id: String(e.id?.label ?? ""), country,
    rating: Number(e["im:rating"]?.label ?? 0), title: String(e.title?.label ?? ""), content: String(e.content?.label ?? ""),
    author: String(e.author?.name?.label ?? ""), version: String(e["im:version"]?.label ?? ""),
    at: Date.parse(e.updated?.label ?? "") || Date.now(), votes: Number(e["im:voteCount"]?.label ?? 0),
  })).filter(r => r.id);
}

export async function lookupApp(appId: string, country = "us") {
  const r = (await getJSON(`https://itunes.apple.com/lookup?id=${encodeURIComponent(appId)}&country=${country}`))?.results?.[0];
  if (!r) return null;
  return {
    appId: String(r.trackId), name: r.trackName, icon: r.artworkUrl512 ?? r.artworkUrl100, developer: r.artistName,
    bundleId: r.bundleId, genreId: String(r.primaryGenreId), genreName: r.primaryGenreName, price: r.price ?? 0,
    rating: r.averageUserRating ?? null, ratingCount: r.userRatingCount ?? 0, version: r.version, url: r.trackViewUrl,
  };
}

export async function searchApps(term: string, country = "us") {
  if (!term || term.length > 100) throw new HttpError(400, "invalid_term");
  const res = await getJSON(`https://itunes.apple.com/search?entity=software&limit=15&country=${encodeURIComponent(country)}&term=${encodeURIComponent(term)}`);
  return (res?.results ?? []).map((r: any) => ({
    appId: String(r.trackId), name: r.trackName, icon: r.artworkUrl100, developer: r.artistName, genreName: r.primaryGenreName,
    rating: r.averageUserRating ?? null, ratingCount: r.userRatingCount ?? 0,
  }));
}

/** Registers the project's tracked apps in the shared `apps` registry (ranks are shared across projects). */
export async function syncTrackers(projectId: string, apps: TrackedApp[], previous: TrackedApp[] = []) {
  const keep = new Set(apps.map(a => a.appId));
  for (const a of previous) if (!keep.has(a.appId)) {
    await db.doc(`apps/${a.appId}`).set({ trackers: FieldValue.arrayRemove(projectId) }, { merge: true });
  }
  for (const a of apps) {
    const ref = db.doc(`apps/${a.appId}`);
    const snap = await ref.get();
    const meta = snap.exists && snap.get("name") ? {} : (await lookupApp(a.appId) ?? {});
    await ref.set({ appId: a.appId, ...meta, trackers: FieldValue.arrayUnion(projectId), trackedAt: Date.now() }, { merge: true });
  }
}

interface RankDoc { cc: string; chart: Chart; scope: string; rank: number | null; prevRank: number | null; bestRank: number | null; bestAt: number | null; history: { t: number; r: number | null }[]; updatedAt: number; firstRankedAt?: number | null }

export interface Alert { type: "NEW_COUNTRY" | "TOP_100" | "TOP_10" | "TOP_1" | "JUMP" | "DROP" | "LEFT_CHART"; appId: string; cc: string; chart: Chart; scope: string; rank: number | null; prevRank: number | null }

/** Decides which alerts a rank change deserves. Pure — unit-tested. */
export function rankAlerts(prev: RankDoc | undefined, rank: number | null, appId: string, cc: string, chart: Chart, scope: string, everRankedInCountry: boolean): Alert[] {
  const prevRank = prev?.rank ?? null;
  const base = { appId, cc, chart, scope, rank, prevRank };
  if (rank === null) return prevRank !== null ? [{ ...base, type: "LEFT_CHART" }] : [];
  const out: Alert[] = [];
  if (prevRank === null) out.push({ ...base, type: everRankedInCountry ? "TOP_100" : "NEW_COUNTRY" });
  if (rank === 1 && prevRank !== 1) out.push({ ...base, type: "TOP_1" });
  else if (rank <= 10 && (prevRank === null || prevRank > 10)) out.push({ ...base, type: "TOP_10" });
  if (prevRank !== null && prevRank - rank >= 10) out.push({ ...base, type: "JUMP" });
  if (prevRank !== null && rank - prevRank >= 15) out.push({ ...base, type: "DROP" });
  return out;
}

/** One full ranking scan for the given apps (default: every tracked app). */
export async function scanRankings(onlyAppIds?: string[], countries: string[] = ALL_COUNTRIES) {
  throttled = 0;
  refusals.clear();
  coolDownUntil.clear();
  const appsSnap = await db.collection("apps").get();
  const apps = appsSnap.docs.map(d => d.data()).filter(a => (a.trackers ?? []).length && (!onlyAppIds || onlyAppIds.includes(a.appId)));
  if (!apps.length) return { apps: 0, feeds: 0 };
  const genres = [...new Set(apps.map(a => a.genreId).filter(Boolean))] as string[];
  const scopes = ["all", ...genres];
  const jobs: { cc: string; chart: Chart; scope: string }[] = [];
  for (const cc of countries) for (const chart of CHARTS) for (const scope of scopes) jobs.push({ cc, chart, scope });

  const results = new Map<string, Map<string, number>>(); // key cc|chart|scope
  let ok = 0;
  await pool(jobs, 4, async j => {
    const url = `https://itunes.apple.com/${j.cc.toLowerCase()}/rss/${FEED[j.chart]}/limit=100${j.scope === "all" ? "" : `/genre=${j.scope}`}/json`;
    const feed = await getJSON(url, j.scope === "all" && j.chart !== "grossing" ? 1 : 3);
    if (feed) { results.set(`${j.cc}|${j.chart}|${j.scope}`, parseChart(feed)); ok++; return; }
    if (j.scope === "all" && j.chart !== "grossing") {
      const v2 = await getJSON(`https://rss.marketingtools.apple.com/api/v2/${j.cc.toLowerCase()}/apps/top-${j.chart}/100/apps.json`);
      if (v2?.feed?.results) { results.set(`${j.cc}|${j.chart}|${j.scope}`, parseChartV2(v2)); ok++; }
    }
  });

  const now = Date.now();
  for (const app of apps) {
    const appScopes = ["all", app.genreId].filter(Boolean) as string[];
    const existing = await db.collection(`apps/${app.appId}/ranks`).get();
    const prevDocs = new Map(existing.docs.map(d => [d.id, d.data() as RankDoc]));
    const rankedCountries = new Set(existing.docs.filter(d => d.get("firstRankedAt")).map(d => d.get("cc")));
    const alerts: Alert[] = [];
    let writer = db.batch(), pending = 0;
    let countriesRanked = 0, bestOverall: number | null = null;
    const seenCountry = new Set<string>();
    for (const cc of countries) for (const chart of CHARTS) for (const scope of appScopes) {
      const chartMap = results.get(`${cc}|${chart}|${scope}`);
      if (!chartMap) continue; // feed failed: keep last known state, no false "left chart" alert
      const rank = chartMap.get(String(app.appId)) ?? null;
      const id = `${cc}_${chart}_${scope === "all" ? "all" : "genre"}`;
      const prev = prevDocs.get(id);
      if (!prev && rank === null) continue;
      alerts.push(...rankAlerts(prev, rank, app.appId, cc, chart, scope === "all" ? "all" : "genre", rankedCountries.has(cc) || seenCountry.has(cc)));
      if (rank !== null) {
        seenCountry.add(cc);
        bestOverall = bestOverall === null ? rank : Math.min(bestOverall, rank);
      }
      const history = [...(prev?.history ?? [])];
      const last = history[history.length - 1];
      // Keep one point per ~6h unless the rank moved, to bound document size.
      if (!last || last.r !== rank || now - last.t > 6 * 3600000) history.push({ t: now, r: rank });
      const best = rank !== null && (prev?.bestRank == null || rank < prev.bestRank);
      writer.set(db.doc(`apps/${app.appId}/ranks/${id}`), {
        cc, chart, scope: scope === "all" ? "all" : "genre", rank, prevRank: prev?.rank ?? null,
        bestRank: best ? rank : prev?.bestRank ?? null, bestAt: best ? now : prev?.bestAt ?? null,
        firstRankedAt: prev?.firstRankedAt ?? (rank !== null ? now : null),
        history: history.slice(-HISTORY_POINTS), updatedAt: now,
      });
      if (++pending >= 400) { await writer.commit(); writer = db.batch(); pending = 0; }
    }
    if (pending) await writer.commit();
    const stillRanked = new Set(existing.docs.filter(d => d.get("rank") !== null && !countries.includes(d.get("cc"))).map(d => d.get("cc")));
    countriesRanked = new Set([...seenCountry, ...stillRanked]).size;
    await db.doc(`apps/${app.appId}`).set({ countriesRanked, bestRank: bestOverall, rankedAt: now }, { merge: true });
    // First scan of an app is a baseline: every country would otherwise look "new".
    if (!existing.empty) await fanOutAlerts(app, alerts);
  }
  return { apps: apps.length, feeds: ok, of: jobs.length, throttled };
}

async function fanOutAlerts(app: any, alerts: Alert[]) {
  if (!alerts.length) return;
  // LEFT_CHART is noisy for own apps outside top countries; keep it in history but don't notify.
  const notify = alerts.filter(a => a.type !== "LEFT_CHART");
  for (const pid of app.trackers ?? []) {
    const project = (await db.doc(`projects/${pid}`).get()).data();
    const tracked: TrackedApp[] = project?.config?.appStore?.apps ?? [];
    const own = tracked.find(t => t.appId === app.appId)?.own !== false;
    const batch = db.batch();
    for (const a of notify.slice(0, 200)) {
      batch.set(db.collection(`projects/${pid}/alerts`).doc(), {
        ...a, appName: app.name ?? a.appId, appIcon: app.icon ?? null, own, at: Date.now(), delivered: false, read: false,
      });
    }
    await batch.commit();
  }
}

/** Ratings per storefront (daily). */
export async function scanRatings(appId: string) {
  let totalCount = 0, weighted = 0;
  const batch = db.batch();
  await pool(ALL_COUNTRIES, 4, async cc => {
    const r = (await getJSON(`https://itunes.apple.com/lookup?id=${appId}&country=${cc.toLowerCase()}`))?.results?.[0];
    if (!r) return;
    const count = r.userRatingCount ?? 0, avg = r.averageUserRating ?? null;
    totalCount += count; if (avg) weighted += avg * count;
    batch.set(db.doc(`apps/${appId}/ratings/${cc}`), { cc, average: avg, count, version: r.version ?? null, at: Date.now() });
  });
  await batch.commit();
  await db.doc(`apps/${appId}`).set({ ratingCount: totalCount, rating: totalCount ? weighted / totalCount : null, ratingsAt: Date.now() }, { merge: true });
}

/** Most recent reviews in every storefront that has ratings. Returns newly seen reviews. */
export async function scanReviews(appId: string) {
  const ratings = await db.collection(`apps/${appId}/ratings`).where("count", ">", 0).get();
  const countries = ratings.empty ? ALL_COUNTRIES : ratings.docs.map(d => d.get("cc"));
  const fresh: ReturnType<typeof parseReviews> = [];
  await pool(countries, 3, async cc => {
    const feed = await getJSON(`https://itunes.apple.com/${cc.toLowerCase()}/rss/customerreviews/page=1/id=${appId}/sortby=mostrecent/json`);
    const reviews = parseReviews(feed, cc);
    if (!reviews.length) return;
    const refs = reviews.map(r => db.doc(`apps/${appId}/reviews/${r.id}`));
    const existing = await db.getAll(...refs);
    const batch = db.batch();
    reviews.forEach((r, i) => {
      if (existing[i].exists) return;
      batch.set(refs[i], r);
      fresh.push(r);
    });
    await batch.commit();
  });
  return fresh;
}

/** Translates a review with Cloud Translation (cached per language on the review). */
export async function translateReview(appId: string, reviewId: string, target: string) {
  if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(target)) throw new HttpError(400, "invalid_language");
  const ref = db.doc(`apps/${appId}/reviews/${reviewId}`);
  const r = (await ref.get()).data();
  if (!r) throw new HttpError(404, "review_not_found");
  if (r.translations?.[target]) return r.translations[target];
  const client = await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-translation"] }).getClient();
  const res = await client.request<any>({
    url: "https://translation.googleapis.com/language/translate/v2", method: "POST",
    data: { q: [r.title, r.content], target, format: "text" },
  });
  const [title, content] = res.data.data.translations.map((t: any) => t.translatedText);
  const out = { title, content, from: res.data.data.translations[0].detectedSourceLanguage ?? null };
  await ref.set({ translations: { [target]: out } }, { merge: true });
  return out;
}
