// Logo d'un business — résolu, téléchargé et hébergé par MoneyMaker.
//
// Pourquoi héberger : les URL tierces cassent (hotlink, redirections, .ico/.svg illisibles par
// l'app, images de 700 Ko). On télécharge la meilleure source, on la normalise en PNG carré
// 256 px (sharp), on la garde dans iconCache/{projectId} et on la sert sur /v1/icons/{projectId}.
//
// Sources, dans l'ordre :
//   1. logo personnalisé envoyé depuis le dashboard
//   2. App Store  : Apple ID de l'app suivie / configurée, sinon recherche par bundle ID
//   3. Google Play : page de l'app (package Android)
//   4. Stripe      : logo / icône de marque du compte (Settings → Branding)
//   5. Site web    : config.website, profil Stripe, ou site déclaré sur l'App Store
//                    (apple-touch-icon, puis la plus grande icône, variante sombre de préférence)
//   6. Icône du domaine (service favicon), en dernier recours

import sharp from "sharp";
import { db, getCredentials, Project } from "./store";

const UA = { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 MoneyMaker/1" };
const SIZE = 256;

type Candidate = { url: string; source: string; headers?: Record<string, string> };

/** Pure : meilleures icônes déclarées dans une page, de la plus pertinente à la moins — unit-tested. */
export function iconsFromHtml(html: string, base: string): string[] {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map(m => m[0]);
  const attr = (tag: string, name: string) => new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag)?.[1];
  const cands = links.flatMap(tag => {
    const rel = (attr(tag, "rel") ?? "").toLowerCase(), href = attr(tag, "href");
    if (!href || !/(^|\s)(apple-touch-icon|apple-touch-icon-precomposed|icon|shortcut icon|mask-icon)(\s|$)/.test(rel) || rel.includes("mask-icon")) return [];
    let url: string;
    try { url = new URL(href, base).toString(); } catch { return []; }
    const size = Math.max(0, ...(attr(tag, "sizes") ?? "").split(/\s+/).map(s => Number(s.split("x")[0]) || 0));
    const media = (attr(tag, "media") ?? "").toLowerCase();
    const isIco = /\.ico(\?|$)/i.test(url);
    const isSvg = /\.svg(\?|$)/i.test(url) || (attr(tag, "type") ?? "").includes("svg");
    let score = (rel.includes("apple-touch-icon") ? 1000 : 0) + (size || (rel.includes("apple-touch-icon") ? 180 : isSvg ? 512 : 32));
    if (media.includes("dark")) score += 1500; else if (media.includes("light")) score -= 100;
    if (isIco) score -= 2000; // sharp ne lit pas l'ICO : tout le reste passe avant
    return [{ url, score }];
  });
  return cands.sort((a, b) => b.score - a.score).map(c => c.url);
}

/** Compat : la meilleure icône lisible (sans .ico). */
export function pickIconFromHtml(html: string, base: string): string | null {
  return iconsFromHtml(html, base).find(u => !/\.ico(\?|$)/i.test(u)) ?? null;
}

async function getJson(url: string, headers: Record<string, string> = {}) {
  const r = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(8000) });
  return r.ok ? r.json() as Promise<any> : null;
}

async function getText(url: string) {
  const r = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(10000) });
  return r.ok ? (await r.text()).slice(0, 300_000) : null;
}

const normalize = (u: string) => (/^https?:\/\//.test(u) ? u : `https://${u}`);

// ── Sources ─────────────────────────────────────────────────────────────────

async function appStoreCandidates(project: Project): Promise<{ list: Candidate[]; sellerUrl?: string }> {
  const ids = [
    ...(project.config.appStore?.apps ?? []).filter(a => a.own !== false).map(a => a.appId),
    project.config.apple?.appAppleId ? String(project.config.apple.appAppleId) : null,
  ].filter(Boolean) as string[];
  const list: Candidate[] = [];
  let sellerUrl: string | undefined;
  for (const id of [...new Set(ids)]) {
    const stored = (await db.doc(`apps/${id}`).get()).get("icon") as string | undefined;
    if (stored) list.push({ url: stored, source: "app_store" });
  }
  const lookups = [...new Set(ids)].map(id => `https://itunes.apple.com/lookup?id=${id}`);
  if (project.config.apple?.bundleId) lookups.push(`https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(project.config.apple.bundleId)}`);
  for (const u of lookups) {
    const r = (await getJson(u).catch(() => null))?.results?.[0];
    if (r?.artworkUrl512) list.push({ url: r.artworkUrl512, source: "app_store" });
    sellerUrl ??= r?.sellerUrl;
  }
  return { list, sellerUrl };
}

async function googlePlayCandidates(project: Project): Promise<Candidate[]> {
  const pkg = project.config.google?.packageName;
  if (!pkg) return [];
  const html = await getText(`https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}&hl=fr`).catch(() => null);
  const img = html && /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1];
  // og:image du Play Store = l'icône de l'app (googleusercontent). On demande 512 px.
  return img ? [{ url: img.replace(/=w\d+.*$|=s\d+.*$/, "") + "=s512", source: "google_play" }] : [];
}

async function stripeCandidates(project: Project): Promise<{ list: Candidate[]; website?: string }> {
  const key = (await getCredentials(project.id).catch(() => null))?.stripe?.secretKey;
  if (!key) return { list: [] };
  const auth = { Authorization: `Bearer ${key}` };
  const acct = await getJson("https://api.stripe.com/v1/account", auth).catch(() => null);
  if (!acct) return { list: [] };
  const list: Candidate[] = [];
  for (const fileId of [acct.settings?.branding?.icon, acct.settings?.branding?.logo].filter(Boolean)) {
    const f = await getJson(`https://api.stripe.com/v1/files/${fileId}`, auth).catch(() => null);
    if (f?.url) list.push({ url: f.url, source: "stripe", headers: auth });
  }
  return { list, website: acct.business_profile?.url ?? undefined };
}

async function websiteCandidates(site: string): Promise<Candidate[]> {
  const base = normalize(site);
  const html = await getText(base).catch(() => null);
  const urls = html ? iconsFromHtml(html, base) : [];
  urls.push(new URL("/apple-touch-icon.png", base).toString());
  return urls.map(url => ({ url, source: "website" }));
}

// ── Téléchargement + normalisation ──────────────────────────────────────────

/** Télécharge une image et la ramène à un PNG carré 256 px sur fond noir (icônes transparentes comprises). */
export async function fetchIcon(c: Candidate): Promise<Buffer | null> {
  try {
    const r = await fetch(c.url, { headers: { ...UA, ...(c.headers ?? {}) }, redirect: "follow", signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const type = r.headers.get("content-type") ?? "";
    if (!/^image\//.test(type) && !/octet-stream/.test(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 100 || buf.length > 8_000_000) return null;
    const img = sharp(buf, { density: 300 }); // density : rendu net des SVG
    const meta = await img.metadata();
    if (!meta.width || !meta.height || Math.min(meta.width, meta.height) < 32) return null; // favicons minuscules = flous
    return await img
      .resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 1 } })
      .flatten({ background: "#000000" })
      .png({ compressionLevel: 9, palette: true, quality: 90 })
      .toBuffer();
  } catch { return null; }
}

export async function resolveIcon(project: Project): Promise<{ png: Buffer | null; source: string; url?: string }> {
  // 1. Logo personnalisé (déjà normalisé à l'envoi).
  const custom = await db.doc(`iconCache/${project.id}`).get();
  if (custom.get("source") === "custom" && custom.get("png")) return { png: Buffer.from(custom.get("png"), "base64"), source: "custom" };

  const [store, play, stripe] = await Promise.all([appStoreCandidates(project), googlePlayCandidates(project), stripeCandidates(project)]);
  const sites = [...new Set([(project.config as any).website, stripe.website, store.sellerUrl].filter(Boolean).map(s => normalize(String(s))))];
  const siteCands = (await Promise.all(sites.map(s => websiteCandidates(s).catch(() => [])))).flat();
  const favicons: Candidate[] = sites.map(s => ({ url: `https://www.google.com/s2/favicons?domain=${new URL(s).hostname}&sz=256`, source: "favicon" }));

  for (const c of [...store.list, ...play, ...stripe.list, ...siteCands, ...favicons]) {
    const png = await fetchIcon(c);
    if (png) return { png, source: c.source, url: c.url };
  }
  return { png: null, source: "none" };
}

/** Résout, normalise et mémorise le logo. Retourne la version (horodatage) pour invalider les caches. */
export async function refreshIcon(project: Project) {
  const r = await resolveIcon(project);
  const ref = db.doc(`iconCache/${project.id}`);
  if (!r.png) {
    await ref.set({ source: "none", at: Date.now() }, { merge: false });
    await db.doc(`projects/${project.id}`).update({ iconVersion: null, iconSource: "none" });
    return { source: "none" };
  }
  const b64 = r.png.toString("base64");
  const prev = await ref.get();
  const version = prev.get("png") === b64 ? (prev.get("at") ?? Date.now()) : Date.now();
  await ref.set({ png: b64, source: r.source, origin: r.url ?? null, at: version });
  await db.doc(`projects/${project.id}`).update({ iconVersion: version, iconSource: r.source });
  return { source: r.source, origin: r.url, bytes: r.png.length };
}

/** Logo envoyé depuis le dashboard (data URL ou base64). */
export async function setCustomIcon(projectId: string, data: string) {
  const b64 = data.replace(/^data:[^;]+;base64,/, "");
  const buf = Buffer.from(b64, "base64");
  if (buf.length > 5_000_000) throw new Error("icon_too_large");
  const png = await sharp(buf, { density: 300 })
    .resize(SIZE, SIZE, { fit: "cover" })
    .flatten({ background: "#000000" })
    .png({ compressionLevel: 9, palette: true, quality: 90 })
    .toBuffer();
  const version = Date.now();
  await db.doc(`iconCache/${projectId}`).set({ png: png.toString("base64"), source: "custom", at: version });
  await db.doc(`projects/${projectId}`).update({ iconVersion: version, iconSource: "custom" });
  return { source: "custom", bytes: png.length };
}
