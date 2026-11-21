// Requêtes sortantes vers des URL fournies par les utilisateurs (icônes, sites, webhooks) :
// jamais vers le réseau interne (métadonnées Google Cloud, localhost, adresses privées).
import { lookup } from "dns/promises";
import { isIP } from "net";

/** Adresse privée, locale, de lien local ou réservée. Pure — unit-tested. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x.startsWith("::ffff:")) return isPrivateAddress(x.slice(7));
    return x === "::" || x === "::1" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe80") || x.startsWith("ff");
  }
  return true;
}

/** L'URL vise-t-elle un hôte public en http(s) ? */
export async function isPublicUrl(raw: string): Promise<boolean> {
  let u: URL; try { u = new URL(raw); } catch { return false; }
  if (process.env.MM_ALLOW_PRIVATE_FETCH === "1" && !process.env.K_SERVICE) return true; // tests locaux uniquement (jamais sur Cloud Run)
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|metadata(\.google\.internal)?)$/i.test(host) || host.endsWith(".internal") || host.endsWith(".local")) return false;
  try {
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    return addrs.length > 0 && addrs.every(a => !isPrivateAddress(a.address));
  } catch { return false; }
}

/** fetch qui suit au plus 3 redirections en revérifiant chaque hôte. */
export async function safeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    if (!(await isPublicUrl(current))) throw new Error("blocked_url");
    const r = await fetch(current, { ...init, redirect: "manual" });
    const loc = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
    if (!loc) return r;
    current = new URL(loc, current).toString();
  }
  throw new Error("too_many_redirects");
}
