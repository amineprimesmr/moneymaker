// App Store downloads from Apple's daily Sales & Trends reports (SALES / SUMMARY / DAILY).
// One report covers every app of the vendor account; we keep the rows of the project's app.
// Stored per project and day: projects/{pid}/downloads/{yyyy-mm-dd} = { units, byCountry }.

import { gunzipSync } from "zlib";
import { db, getCredentials, Project } from "./store";
import { ascToken } from "./connect";

const DAY = 86400000;
/** First-time downloads (free or paid), excluding updates (7, 7F, 7T) and in-app purchases. */
const DOWNLOAD_TYPES = new Set(["1", "1F", "1T", "F1", "1E", "1EP", "1EU"]);

/** Pure TSV parser — unit-tested. Returns units by country for one Apple app id. */
export function parseSalesReport(tsv: string, appAppleId: number | string) {
  const [head, ...rows] = tsv.trim().split(/\r?\n/);
  const cols = head.split("\t");
  const at = (name: string) => cols.indexOf(name);
  const iUnits = at("Units"), iType = at("Product Type Identifier"), iApp = at("Apple Identifier"), iCc = at("Country Code");
  let units = 0;
  const byCountry: Record<string, number> = {};
  for (const r of rows) {
    const c = r.split("\t");
    if (String(c[iApp]) !== String(appAppleId) || !DOWNLOAD_TYPES.has(c[iType])) continue;
    const u = Number(c[iUnits]) || 0;
    if (u <= 0) continue;
    units += u;
    byCountry[c[iCc] || "??"] = (byCountry[c[iCc] || "??"] ?? 0) + u;
  }
  return { units, byCountry };
}

async function fetchReport(creds: { issuerId: string; keyId: string; privateKey: string }, vendor: string, date: string): Promise<string | null> {
  const q = new URLSearchParams({
    "filter[frequency]": "DAILY", "filter[reportType]": "SALES", "filter[reportSubType]": "SUMMARY",
    "filter[vendorNumber]": vendor, "filter[reportDate]": date, "filter[version]": "1_1",
  });
  const res = await fetch(`https://api.appstoreconnect.apple.com/v1/salesReports?${q}`, {
    headers: { Authorization: `Bearer ${ascToken(creds)}`, Accept: "application/a-gzip" }, signal: AbortSignal.timeout(30000),
  });
  if (res.status === 404) return null; // no sales that day, or report not published yet
  if (!res.ok) throw new Error(`salesReports ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8");
}

/** Fills the last `days` days that are missing. Reports are published the next day (~8:00 PT). */
export async function syncDownloads(project: Project, days = 30): Promise<{ synced: number; skipped?: string }> {
  const appId = project.config.apple?.appAppleId;
  const vendor = (project.config.apple as any)?.vendorNumber;
  if (!appId || !vendor) return { synced: 0, skipped: "missing_app_id_or_vendor" };
  const creds = (await getCredentials(project.id)).appStoreConnect;
  if (!creds) return { synced: 0, skipped: "no_app_store_connect_key" };
  const col = db.collection(`projects/${project.id}/downloads`);
  const have = new Set((await col.select().get()).docs.map(d => d.id));
  let synced = 0;
  for (let i = days; i >= 1; i--) {
    const date = new Date(Date.now() - i * DAY).toISOString().slice(0, 10);
    if (have.has(date) && i > 2) continue; // the last two days can still be revised by Apple
    const tsv = await fetchReport(creds, String(vendor), date).catch(e => { console.error("downloads", project.id, date, e.message); return undefined; });
    if (tsv === undefined) continue;
    const r = tsv ? parseSalesReport(tsv, appId) : { units: 0, byCountry: {} };
    if (tsv === null && i <= 2) continue; // not published yet — retry tomorrow
    await col.doc(date).set({ date, ...r, syncedAt: Date.now() });
    synced++;
  }
  return { synced };
}

export async function downloadsFor(projectId: string, since: number) {
  const snap = await db.collection(`projects/${projectId}/downloads`).where("date", ">=", new Date(since).toISOString().slice(0, 10)).get();
  const byDay: Record<string, number> = {}, byCountry: Record<string, number> = {};
  let total = 0;
  for (const d of snap.docs) {
    const x = d.data();
    byDay[x.date] = x.units; total += x.units;
    for (const [cc, u] of Object.entries(x.byCountry ?? {})) byCountry[cc] = (byCountry[cc] ?? 0) + (u as number);
  }
  return { total, byDay, byCountry, available: snap.size > 0 };
}
