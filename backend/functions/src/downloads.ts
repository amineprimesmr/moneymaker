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
    await col.doc(date).set({ date, ...r, source: "sales", syncedAt: Date.now() });
    synced++;
  }
  return { synced };
}

// ── Sans numéro de fournisseur : rapports Analytics d'App Store Connect ─────────
// La clé App Store Connect du business suffit. On demande à Apple deux rapports (historique complet une fois,
// puis quotidien) ; Apple les produit sous 24 à 48 h, ensuite chaque jour. On lit « App Downloads Standard ».

const ASC = "https://api.appstoreconnect.apple.com/v1";
type AscCreds = { issuerId: string; keyId: string; privateKey: string };

async function ascGet(creds: AscCreds, pathOrUrl: string) {
  const res = await fetch(pathOrUrl.startsWith("https://") ? pathOrUrl : `${ASC}${pathOrUrl}`, {
    headers: { Authorization: `Bearer ${ascToken(creds)}` }, signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`asc ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<any>;
}

/** Crée (une seule fois) les demandes de rapports Analytics : historique + quotidien. Renvoie leurs identifiants. */
export async function ensureAnalyticsRequests(creds: AscCreds, appAppleId: string | number): Promise<string[]> {
  const list = await ascGet(creds, `/apps/${appAppleId}/analyticsReportRequests?limit=50`);
  const have = new Map<string, string>((list.data ?? []).filter((r: any) => !r.attributes?.stoppedDueToInactivity)
    .map((r: any) => [r.attributes?.accessType, r.id]));
  for (const accessType of ["ONE_TIME_SNAPSHOT", "ONGOING"]) {
    if (have.has(accessType)) continue;
    const res = await fetch(`${ASC}/analyticsReportRequests`, {
      method: "POST", headers: { Authorization: `Bearer ${ascToken(creds)}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ data: { type: "analyticsReportRequests", attributes: { accessType }, relationships: { app: { data: { type: "apps", id: String(appAppleId) } } } } }),
    });
    if (res.ok) have.set(accessType, (await res.json() as any).data.id);
    else if (res.status !== 409) throw new Error(`analyticsReportRequests ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return [...have.values()];
}

/** Rapport « App Downloads » (TSV) → premiers téléchargements par jour et par pays. Pure — unit-tested. */
export function parseAnalyticsDownloads(tsv: string, appAppleId?: string | number) {
  const [head, ...rows] = tsv.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  const cols = head.split("\t").map(c => c.trim().toLowerCase());
  const find = (...names: string[]) => cols.findIndex(c => names.includes(c));
  const iDate = find("date"), iType = find("download type"), iTerr = find("territory", "storefront", "country code"),
    iCount = find("counts", "count", "total downloads"), iApp = find("app apple identifier", "app id");
  const days: Record<string, { units: number; byCountry: Record<string, number> }> = {};
  if (iDate < 0 || iCount < 0) return days;
  for (const r of rows) {
    const c = r.split("\t");
    if (appAppleId !== undefined && iApp >= 0 && c[iApp] && String(c[iApp]).trim() !== String(appAppleId)) continue;
    if (iType >= 0 && !/first/i.test(c[iType] ?? "")) continue; // premiers téléchargements seulement (pas les mises à jour ni les retéléchargements)
    const n = Number(c[iCount]) || 0;
    if (n <= 0) continue;
    const date = String(c[iDate]).trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const cc = (iTerr >= 0 ? String(c[iTerr]).trim().toUpperCase() : "") || "??";
    const d = (days[date] ??= { units: 0, byCountry: {} });
    d.units += n; d.byCountry[cc] = (d.byCountry[cc] ?? 0) + n;
  }
  return days;
}

/** Lit les instances quotidiennes pas encore traitées et remplit projects/{pid}/downloads. */
export async function syncAnalyticsDownloads(project: Project): Promise<{ synced: number; pending?: boolean; skipped?: string }> {
  const appId = project.config.apple?.appAppleId;
  const creds = (await getCredentials(project.id)).appStoreConnect as AscCreds | undefined;
  if (!appId) return { synced: 0, skipped: "missing_app_id" };
  if (!creds) return { synced: 0, skipped: "no_app_store_connect_key" };
  const requests = await ensureAnalyticsRequests(creds, appId);
  const doneCol = db.collection(`projects/${project.id}/downloadsInstances`);
  const done = new Set((await doneCol.select().get()).docs.map(d => d.id));
  const merged: Record<string, { units: number; byCountry: Record<string, number> }> = {};
  let instancesRead = 0, reportsFound = 0;
  for (const rid of requests) {
    const reports = await ascGet(creds, `/analyticsReportRequests/${rid}/reports?filter[name]=App%20Downloads%20Standard&limit=10`).catch(() => ({ data: [] }));
    for (const rep of reports.data ?? []) {
      reportsFound++;
      let next: string | null = `/analyticsReports/${rep.id}/instances?filter[granularity]=DAILY&limit=200`;
      while (next && instancesRead < 400) {
        const page: any = await ascGet(creds, next);
        for (const inst of page.data ?? []) {
          if (done.has(inst.id)) continue;
          const segs = await ascGet(creds, `/analyticsReportInstances/${inst.id}/segments?limit=50`);
          const inInstance: Record<string, { units: number; byCountry: Record<string, number> }> = {};
          for (const seg of segs.data ?? []) {
            const url = seg.attributes?.url;
            if (!url) continue;
            const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
            if (!res.ok) continue;
            const buf = Buffer.from(await res.arrayBuffer());
            const text = (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString("utf8");
            for (const [date, v] of Object.entries(parseAnalyticsDownloads(text, appId))) {
              const m = (inInstance[date] ??= { units: 0, byCountry: {} }); // segments d'une même instance : on additionne
              m.units += v.units;
              for (const [cc, n] of Object.entries(v.byCountry)) m.byCountry[cc] = (m.byCountry[cc] ?? 0) + n;
            }
          }
          for (const [date, v] of Object.entries(inInstance)) if (!merged[date] || v.units > merged[date].units) merged[date] = v;
          await doneCol.doc(inst.id).set({ at: Date.now(), processingDate: inst.attributes?.processingDate ?? null });
          done.add(inst.id); instancesRead++;
        }
        next = page.links?.next ?? null;
      }
    }
  }
  // Une journée peut figurer dans plusieurs instances (historique + quotidien) : on additionne dans l'instance,
  // puis on garde la valeur la plus haute par jour (jamais un double comptage entre rapports).
  const col = db.collection(`projects/${project.id}/downloads`);
  let synced = 0;
  for (const [date, v] of Object.entries(merged)) {
    const prev = (await col.doc(date).get()).data();
    if (prev?.source === "sales" || (prev && prev.units >= v.units)) continue; // le rapport de ventes (numéro de fournisseur) prime
    await col.doc(date).set({ date, units: v.units, byCountry: v.byCountry, source: "analytics", syncedAt: Date.now() });
    synced++;
  }
  return { synced, ...(reportsFound ? {} : { pending: true }) };
}

/** Téléchargements : rapport de ventes si un numéro de fournisseur est connu, sinon rapports Analytics. */
export async function syncAllDownloads(project: Project, days = 30) {
  if ((project.config.apple as any)?.vendorNumber) return syncDownloads(project, days);
  return syncAnalyticsDownloads(project);
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
