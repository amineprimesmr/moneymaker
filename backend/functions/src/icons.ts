// Icône d'un business, résolue côté serveur et mémorisée sur le projet (projects/{id}.iconUrl).
// Ordre : icône App Store de l'app du business → icône du site web (apple-touch-icon, puis la plus
// grande PNG, variante sombre de préférence) → icône du domaine (service favicon) → rien.
// Le site vient de config.website, sinon du profil Stripe (business_profile.url).

import { db, getCredentials, Project } from "./store";

const UA = { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) MoneyMaker/1" };

/** Pure : meilleure icône déclarée dans le <head> d'une page — unit-tested. */
export function pickIconFromHtml(html: string, base: string): string | null {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map(m => m[0]);
  const attr = (tag: string, name: string) => new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag)?.[1];
  const cands = links.flatMap(tag => {
    const rel = (attr(tag, "rel") ?? "").toLowerCase(), href = attr(tag, "href");
    if (!href || !/(^|\s)(apple-touch-icon|icon|shortcut icon)(\s|$)/.test(rel)) return [];
    const url = new URL(href, base).toString();
    const type = (attr(tag, "type") ?? "").toLowerCase();
    if (/\.svg(\?|$)/i.test(url) || /\.ico(\?|$)/i.test(url) || type.includes("svg") || type.includes("icon")) return []; // pas lisibles par AsyncImage
    const size = Math.max(0, ...(attr(tag, "sizes") ?? "").split(/\s+/).map(s => Number(s.split("x")[0]) || 0));
    const media = (attr(tag, "media") ?? "").toLowerCase();
    let score = (rel.includes("apple-touch-icon") ? 1000 : 0) + (size || (rel.includes("apple-touch-icon") ? 180 : 32));
    if (media.includes("dark")) score += 1500; else if (media.includes("light")) score -= 100;
    return [{ url, score }];
  });
  return cands.sort((a, b) => b.score - a.score)[0]?.url ?? null;
}

async function reachableImage(url: string) {
  try {
    const r = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(8000) });
    return r.ok && (r.headers.get("content-type") ?? "").startsWith("image/") && !/svg|icon/.test(r.headers.get("content-type") ?? "");
  } catch { return false; }
}

async function websiteFor(project: Project): Promise<string | null> {
  const own = (project.config as any).website as string | undefined;
  if (own) return own;
  try {
    const key = (await getCredentials(project.id)).stripe?.secretKey;
    if (!key) return null;
    const r = await fetch("https://api.stripe.com/v1/account", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    const a = await r.json() as any;
    return a.business_profile?.url ?? null;
  } catch { return null; }
}

async function appStoreIcon(project: Project): Promise<string | null> {
  const appId = (project.config.appStore?.apps ?? []).find(a => a.own !== false)?.appId ?? project.config.apple?.appAppleId;
  if (!appId) return null;
  const stored = (await db.doc(`apps/${appId}`).get()).get("icon") as string | undefined;
  if (stored) return stored;
  try {
    const r = await fetch(`https://itunes.apple.com/lookup?id=${appId}`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json() as any;
    return j.results?.[0]?.artworkUrl512 ?? null;
  } catch { return null; }
}

export async function resolveIcon(project: Project): Promise<{ url: string | null; source: string }> {
  const store = await appStoreIcon(project);
  if (store) return { url: store, source: "app_store" };
  const site = await websiteFor(project);
  if (site) {
    const base = /^https?:\/\//.test(site) ? site : `https://${site}`;
    try {
      const html = await (await fetch(base, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(10000) })).text();
      const picked = pickIconFromHtml(html.slice(0, 200_000), base);
      if (picked && await reachableImage(picked)) return { url: picked, source: "website" };
      const touch = new URL("/apple-touch-icon.png", base).toString();
      if (await reachableImage(touch)) return { url: touch, source: "website" };
    } catch { /* site injoignable : on tente le service favicon */ }
    const host = new URL(base).hostname;
    return { url: `https://www.google.com/s2/favicons?domain=${host}&sz=256`, source: "favicon" };
  }
  return { url: null, source: "none" };
}

/** Résout et mémorise l'icône si elle a changé. */
export async function refreshIcon(project: Project) {
  const r = await resolveIcon(project);
  const ref = db.doc(`projects/${project.id}`);
  const cur = (await ref.get()).get("iconUrl") ?? null;
  if (cur !== r.url) await ref.update({ iconUrl: r.url, iconSource: r.source, iconAt: Date.now() });
  return r;
}
