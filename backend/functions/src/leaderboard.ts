// Classement public des business (façon TrustMRR) : chaque business choisit d'y figurer,
// et ses chiffres viennent des stores (App Store, Google Play, Stripe), jamais d'une saisie.
// Le classement est recalculé au plus toutes les 10 minutes et mis en cache dans Firestore.

import { HttpError } from "./engine";
import { db, getProject } from "./store";
import { projectMetrics } from "./metrics";
import { DEMO_UID } from "./demo";

export const LEADERBOARD_CURRENCY = "EUR";
const CACHE_DOC = "leaderboard/current";
const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 500;

export type LeaderboardSort = "mrr" | "revenue" | "growth" | "subscribers";
export const LEADERBOARD_SORTS: LeaderboardSort[] = ["mrr", "revenue"];

export interface PublicListing {
  listed: boolean;
  listedAt?: number;
  tagline?: string;
  website?: string;
  /** Masque les montants exacts (tranches) tout en restant classé. */
  hideAmounts?: boolean;
}

export interface LeaderboardEntry {
  projectId: string;
  name: string;
  tagline: string | null;
  website: string | null;
  iconUrl: string | null;
  mrrMicros: number;
  revenue30dMicros: number;
  /** Revenu net des 30 derniers jours vs les 30 précédents, null sans historique. */
  growth30d: number | null;
  activeSubscriptions: number;
  /** Sources vérifiées : "appstore", "googleplay", "stripe"… */
  sources: string[];
  hideAmounts: boolean;
  listedAt: number;
}

export function sanitizeListing(body: any, prev?: PublicListing): PublicListing {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "invalid_listing");
  const listed = body.listed === undefined ? prev?.listed !== false : Boolean(body.listed);
  const out: PublicListing = { listed, listedAt: listed ? (prev?.listed !== false ? prev?.listedAt ?? Date.now() : Date.now()) : undefined };
  const tagline = body.tagline ?? prev?.tagline;
  if (typeof tagline === "string" && tagline.trim()) out.tagline = tagline.trim().slice(0, 120);
  const website = body.website ?? prev?.website;
  if (typeof website === "string" && website.trim()) {
    const w = website.trim();
    if (!/^https:\/\/[^\s/$.?#][^\s]*$/i.test(w) || w.length > 200) throw new HttpError(400, "invalid_website", "L'adresse doit commencer par https://");
    out.website = w;
  }
  out.hideAmounts = Boolean(body.hideAmounts ?? prev?.hideAmounts);
  if (!out.listedAt) delete out.listedAt;
  return out;
}

/** Tranche affichée quand le business masque ses montants : « 1 k – 5 k € ». */
export function amountBucket(micros: number): string {
  const v = micros / 1_000_000;
  const steps = [0, 100, 500, 1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 1_000_000];
  const fmt = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000} M` : n >= 1000 ? `${n / 1000} k` : `${n}`);
  for (let i = steps.length - 1; i >= 0; i--) {
    if (v >= steps[i]) return i === steps.length - 1 ? `${fmt(steps[i])} € +` : `${fmt(steps[i])} – ${fmt(steps[i + 1])} €`;
  }
  return "0 €";
}

export function sortEntries(entries: LeaderboardEntry[], sort: LeaderboardSort): LeaderboardEntry[] {
  const key: Record<LeaderboardSort, (e: LeaderboardEntry) => number> = {
    mrr: e => e.mrrMicros,
    revenue: e => e.revenue30dMicros,
    growth: e => e.growth30d ?? -Infinity,
    subscribers: e => e.activeSubscriptions,
  };
  return [...entries].sort((a, b) => key[sort](b) - key[sort](a) || b.mrrMicros - a.mrrMicros || a.listedAt - b.listedAt);
}

/** Ce que voit le public : montants exacts, ou tranches si le business les masque. */
export function publicEntry(e: LeaderboardEntry, rank: number) {
  const { hideAmounts, ...rest } = e;
  return hideAmounts
    ? { ...rest, rank, mrrMicros: null, revenue30dMicros: null, mrrRange: amountBucket(e.mrrMicros), revenueRange: amountBucket(e.revenue30dMicros) }
    : { ...rest, rank };
}

/** Ce que le système sait déjà du business : lien App Store / Google Play / site Stripe et catégorie.
 *  Le propriétaire n'a rien à saisir ; une valeur qu'il a lui-même renseignée reste prioritaire. */
async function knownPresence(config: any): Promise<{ website: string | null; tagline: string | null }> {
  const own = (config?.appStore?.apps ?? []).find((a: any) => a.own) ?? config?.appStore?.apps?.[0];
  const appId = own?.appId ?? (config?.apple?.appAppleId ? String(config.apple.appAppleId) : null);
  const app = appId ? (await db.doc(`apps/${appId}`).get().catch(() => null))?.data() : undefined;
  const site = (u?: string) => { try { return u ? new URL(u).origin : null; } catch { return null; } };
  const website = app?.url ?? (appId ? `https://apps.apple.com/app/id${appId}` : null)
    ?? (config?.google?.packageName ? `https://play.google.com/store/apps/details?id=${config.google.packageName}` : null)
    ?? site(config?.web?.successUrl) ?? site(config?.web?.redemptionUrl);
  return { website, tagline: app?.genreName ?? null };
}

function sourcesOf(config: any, health: any): string[] {
  const out: string[] = [];
  if (config?.apple?.bundleId || health?.appleNotifications) out.push("appstore");
  if (config?.google?.packageName || health?.googleRtdn) out.push("googleplay");
  if (health?.stripeWebhook || config?.stripe) out.push("stripe");
  return out;
}

async function compute(publicBase: string): Promise<LeaderboardEntry[]> {
  const { convertMicros } = await import("./engine");
  // Tous les business sont au classement par défaut ; seuls ceux retirés par leur
  // propriétaire (listed: false) et les business de démonstration en sont exclus.
  const all = await db.collection("projects").limit(MAX_ENTRIES * 2).get();
  const docs = all.docs.filter(d => d.get("publicListing.listed") !== false && !(d.get("members") ?? []).includes(DEMO_UID)).slice(0, MAX_ENTRIES);
  const rows = await Promise.all(docs.map(async d => {
    try {
      const pr = await getProject(d.id);
      const m = await projectMetrics(pr, 30);
      const listing = (d.get("publicListing") ?? { listed: true }) as PublicListing;
      const eur = (v: number) => convertMicros(v, m.currency, LEADERBOARD_CURRENCY);
      const prev = m.previous.netRevenueMicros;
      const v = d.get("iconVersion") as number | null | undefined;
      const known = await knownPresence(pr.config);
      const entry: LeaderboardEntry = {
        projectId: d.id, name: pr.name, tagline: listing.tagline ?? known.tagline, website: listing.website ?? known.website,
        iconUrl: v ? `${publicBase}/v1/icons/${d.id}?v=${v}` : null,
        mrrMicros: eur(m.mrrMicros), revenue30dMicros: eur(m.netRevenueMicros),
        growth30d: prev > 0 ? (m.netRevenueMicros - prev) / prev : null,
        activeSubscriptions: m.activeSubscriptions,
        sources: sourcesOf(pr.config, d.get("health")),
        hideAmounts: Boolean(listing.hideAmounts), listedAt: listing.listedAt ?? 0,
      };
      return entry;
    } catch (e) {
      console.error("leaderboard", d.id, e);
      return null;
    }
  }));
  // Un business inscrit apparaît toujours, même à 0 € : il est classé en fin de liste
  // (le cacher faisait croire que l'inscription n'avait pas marché).
  return rows.filter((r): r is LeaderboardEntry => r !== null);
}

export async function leaderboard(publicBase: string, force = false): Promise<{ entries: LeaderboardEntry[]; updatedAt: number }> {
  const ref = db.doc(CACHE_DOC);
  const cached = (await ref.get()).data() as { entries: LeaderboardEntry[]; updatedAt: number } | undefined;
  if (!force && cached && Date.now() - cached.updatedAt < TTL_MS) return cached;
  const fresh = { entries: await compute(publicBase), updatedAt: Date.now() };
  await ref.set(fresh);
  return fresh;
}

/** Invalide le cache après un changement d'inscription, pour que le business apparaisse tout de suite. */
export const invalidateLeaderboard = () => db.doc(CACHE_DOC).set({ updatedAt: 0 }, { merge: true });
