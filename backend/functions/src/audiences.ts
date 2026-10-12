// Audiences : segments de clients enregistrés dans la config du projet (`config.audiences`).
// Validation + filtrage purs (tests/audiences.test.cjs) ; chargement Firestore dans `audienceCustomers`.

import { isPurchaseActive, Purchase } from "./engine";

export type AudienceStatus = "active" | "trial" | "churned" | "billing_issue" | "never_paid";
export const AUDIENCE_STATUSES: AudienceStatus[] = ["active", "trial", "churned", "billing_issue", "never_paid"];
const STORES = ["app_store", "play_store", "stripe", "promotional"];

export interface AudienceFilters {
  store?: string; country?: string; productId?: string; entitlement?: string; status?: AudienceStatus;
  firstSeenAfter?: number; firstSeenBefore?: number; spentMinMicros?: number;
  attributes?: Record<string, string>; appleAdsCampaign?: string;
}
export interface Audience { id: string; name: string; filters: AudienceFilters }

const bad = (code: string) => { throw new Error(code); };
const str = (v: unknown, max: number, code: string) => {
  if (typeof v !== "string" || !v.trim() || v.length > max) bad(code);
  return (v as string).trim();
};
const time = (v: unknown, code: string) => {
  const n = typeof v === "string" && !/^\d+$/.test(v) ? Date.parse(v) : Number(v);
  if (!Number.isFinite(n) || n < 0) bad(code);
  return n;
};

export function sanitizeFilters(f: any): AudienceFilters {
  if (f === undefined || f === null) return {};
  if (typeof f !== "object" || Array.isArray(f)) bad("invalid_audience_filters");
  const out: AudienceFilters = {};
  if (f.store != null && f.store !== "") { if (!STORES.includes(f.store)) bad("invalid_audience_store"); out.store = f.store; }
  if (f.country != null && f.country !== "") { if (!/^[A-Za-z]{2}$/.test(String(f.country))) bad("invalid_audience_country"); out.country = String(f.country).toUpperCase(); }
  if (f.productId != null && f.productId !== "") out.productId = str(f.productId, 200, "invalid_audience_product");
  if (f.entitlement != null && f.entitlement !== "") out.entitlement = str(f.entitlement, 64, "invalid_audience_entitlement");
  if (f.status != null && f.status !== "") { if (!AUDIENCE_STATUSES.includes(f.status)) bad("invalid_audience_status"); out.status = f.status; }
  if (f.firstSeenAfter != null && f.firstSeenAfter !== "") out.firstSeenAfter = time(f.firstSeenAfter, "invalid_audience_date");
  if (f.firstSeenBefore != null && f.firstSeenBefore !== "") out.firstSeenBefore = time(f.firstSeenBefore, "invalid_audience_date");
  if (f.spentMinMicros != null && f.spentMinMicros !== "") {
    const n = Number(f.spentMinMicros);
    if (!Number.isFinite(n) || n < 0) bad("invalid_audience_spent");
    out.spentMinMicros = Math.round(n);
  }
  if (f.attributes != null) {
    if (typeof f.attributes !== "object" || Array.isArray(f.attributes) || Object.keys(f.attributes).length > 10) bad("invalid_audience_attributes");
    const entries = Object.entries(f.attributes).map(([k, v]) => [str(k, 64, "invalid_audience_attributes"), String(v).slice(0, 500)]);
    if (entries.length) out.attributes = Object.fromEntries(entries);
  }
  if (f.appleAdsCampaign != null && f.appleAdsCampaign !== "") out.appleAdsCampaign = str(String(f.appleAdsCampaign), 64, "invalid_audience_campaign");
  return out;
}

export function sanitizeAudiences(input: any): Audience[] {
  if (!Array.isArray(input) || input.length > 50) bad("invalid_audiences");
  const seen = new Set<string>();
  return input.map((a: any, i: number) => {
    if (!a || typeof a !== "object") bad("invalid_audiences");
    const id = a.id == null || a.id === "" ? `aud_${i + 1}` : String(a.id);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) bad("invalid_audience_id");
    if (seen.has(id)) bad("duplicate_audience_id");
    seen.add(id);
    return { id, name: str(a.name, 80, "invalid_audience_name"), filters: sanitizeFilters(a.filters) };
  });
}

export interface CustomerRow {
  id: string; country?: string | null; firstSeenAt?: number | null; totalSpentMicros?: number;
  attributes?: Record<string, string>; appleAds?: { campaignId?: string | number } | null; activeEntitlements?: string[];
  purchases: Purchase[];
}

/** Statut de cycle de vie à partir des achats (sandbox ignoré). */
export function customerStatus(purchases: Purchase[], now = Date.now()): AudienceStatus {
  const real = purchases.filter(p => !p.isSandbox && p.store !== "promotional");
  const active = real.filter(p => isPurchaseActive(p, now));
  // billing_retry n'est pas « actif » côté droits, mais l'abonnement n'est pas encore perdu.
  if (real.some(p => p.status === "billing_retry" || p.status === "grace" || (p.billingIssue && isPurchaseActive(p, now)))) return "billing_issue";
  if (active.some(p => !p.isTrial)) return "active";
  if (active.some(p => p.isTrial)) return "trial";
  if (real.some(p => !p.isTrial && p.priceMicros > 0)) return "churned";
  return "never_paid";
}

export function matchAudience(f: AudienceFilters, c: CustomerRow, now = Date.now()): boolean {
  if (f.country && (c.country ?? "").toUpperCase() !== f.country) return false;
  if (f.store && !c.purchases.some(p => p.store === f.store)) return false;
  if (f.productId && !c.purchases.some(p => p.productId === f.productId)) return false;
  if (f.entitlement && !(c.activeEntitlements ?? []).includes(f.entitlement)) return false;
  if (f.firstSeenAfter != null && !((c.firstSeenAt ?? 0) >= f.firstSeenAfter)) return false;
  if (f.firstSeenBefore != null && !(c.firstSeenAt != null && c.firstSeenAt < f.firstSeenBefore)) return false;
  if (f.spentMinMicros != null && (c.totalSpentMicros ?? 0) < f.spentMinMicros) return false;
  if (f.attributes) for (const [k, v] of Object.entries(f.attributes)) if (String(c.attributes?.[k] ?? "") !== v) return false;
  if (f.appleAdsCampaign && String(c.appleAds?.campaignId ?? "") !== f.appleAdsCampaign) return false;
  if (f.status && customerStatus(c.purchases, now) !== f.status) return false;
  return true;
}

const csvCell = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function audienceCsv(rows: CustomerRow[], now = Date.now()): string {
  const head = ["app_user_id", "status", "country", "first_seen_at", "total_spent_micros", "active_entitlements", "stores", "products", "apple_ads_campaign"];
  const lines = rows.map(c => [c.id, customerStatus(c.purchases, now), c.country ?? "", c.firstSeenAt ? new Date(c.firstSeenAt).toISOString() : "",
    c.totalSpentMicros ?? 0, (c.activeEntitlements ?? []).join("|"), [...new Set(c.purchases.map(p => p.store))].join("|"),
    [...new Set(c.purchases.map(p => p.productId))].join("|"), c.appleAds?.campaignId ?? ""].map(csvCell).join(","));
  return [head.join(","), ...lines].join("\n") + "\n";
}
