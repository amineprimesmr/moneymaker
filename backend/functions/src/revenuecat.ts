// Migration from RevenueCat: imports current subscriptions/purchases of every customer.
// v2 secret keys list customers by themselves; legacy v1 keys need the app's user ids.
import { HttpError, Purchase, PurchaseStatus, StoreName } from "./engine";
import { Project, upsertPurchase, db } from "./store";

const STORE: Record<string, StoreName> = { app_store: "app_store", mac_app_store: "app_store", play_store: "play_store", stripe: "stripe", promotional: "promotional", rc_billing: "stripe" };
const ms = (d?: string | number | null) => (d == null ? null : typeof d === "number" ? d : Date.parse(d) || null);
const KNOWN = [0.25, 1, 2, 3, 6, 12];
const months = (start: number | null, end: number | null) => {
  if (!start || !end || end <= start) return 0;
  const m = (end - start) / (30.4375 * 86400000);
  return KNOWN.reduce((b, p) => (Math.abs(p - m) < Math.abs(b - m) ? p : b), 1);
};

/** Maps one v1 `subscriber` payload to MoneyMaker purchases. Pure — unit-tested. */
export function purchasesFromV1(subscriber: any, now = Date.now()): Purchase[] {
  const out: Purchase[] = [];
  for (const [productId, s] of Object.entries<any>(subscriber?.subscriptions ?? {})) {
    const expiresAt = ms(s.expires_date), purchasedAt = ms(s.original_purchase_date) ?? ms(s.purchase_date) ?? now;
    const grace = ms(s.grace_period_expires_date);
    let status: PurchaseStatus = expiresAt === null || expiresAt > now ? "active" : "expired";
    if (s.refunded_at) status = "refunded";
    else if (grace && grace > now) status = "grace";
    else if (s.billing_issues_detected_at && status === "expired") status = "billing_retry";
    out.push({
      id: `rc_${productId}_${purchasedAt}`, store: STORE[s.store] ?? "app_store", productId, type: "subscription", status,
      purchasedAt, latestPurchaseAt: ms(s.purchase_date) ?? purchasedAt,
      expiresAt: status === "grace" && grace ? grace : expiresAt,
      willRenew: !s.unsubscribe_detected_at && !s.refunded_at && status !== "expired",
      isTrial: s.period_type === "trial", isSandbox: Boolean(s.is_sandbox),
      priceMicros: Math.round(Number(s.price?.amount ?? 0) * 1e6), currency: String(s.price?.currency ?? "USD").toUpperCase(),
      periodMonths: months(ms(s.purchase_date), expiresAt), billingIssue: Boolean(s.billing_issues_detected_at), updatedAt: now,
    });
  }
  for (const [productId, list] of Object.entries<any[]>(subscriber?.non_subscriptions ?? {})) {
    for (const p of list ?? []) {
      const at = ms(p.purchase_date) ?? now;
      out.push({
        id: `rc_${productId}_${at}`, store: STORE[p.store] ?? "app_store", productId, type: "non_consumable", status: "active",
        purchasedAt: at, latestPurchaseAt: at, expiresAt: null, willRenew: false, isTrial: false, isSandbox: Boolean(p.is_sandbox),
        priceMicros: Math.round(Number(p.price?.amount ?? 0) * 1e6), currency: String(p.price?.currency ?? "USD").toUpperCase(),
        periodMonths: 0, billingIssue: false, updatedAt: now,
      });
    }
  }
  return out;
}

async function rc(url: string, key: string) {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    if (res.status === 429) { await new Promise(r => setTimeout(r, 1500 * (i + 1))); continue; }
    if (res.status === 404) return null;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(400, "revenuecat_error", String(body.message ?? res.status));
    return body;
  }
  throw new HttpError(503, "revenuecat_rate_limited");
}

async function importCustomer(project: Project, appUserId: string, purchases: Purchase[]) {
  let n = 0;
  for (const p of purchases) {
    if (p.isSandbox) continue;
    await upsertPurchase(project, appUserId, { ...p }, [], { silent: true });
    n++;
  }
  if (n) await db.doc(`projects/${project.id}/customers/${appUserId}`).set({ migratedFrom: "revenuecat" }, { merge: true });
  return n;
}

/** Imports from RevenueCat. v2 key: everything. v1 key: the given app user ids. */
export async function importRevenueCat(project: Project, body: any) {
  const key = String(body?.secretKey ?? "");
  if (!/^sk_/.test(key)) throw new HttpError(400, "invalid_revenuecat_key", "Use a RevenueCat secret key (sk_…)");
  let customers = 0, purchases = 0;
  const v2 = await fetch("https://api.revenuecat.com/v2/projects", { headers: { Authorization: `Bearer ${key}` } }).then(r => r.json()).catch(() => ({}));
  if (Array.isArray(v2.items)) {
    const rcProject = body.revenueCatProjectId ?? v2.items[0]?.id;
    let url: string | null = `https://api.revenuecat.com/v2/projects/${rcProject}/customers?limit=200`;
    while (url) {
      const page = await rc(url, key);
      for (const c of page?.items ?? []) {
        if (String(c.id).startsWith("$RCAnonymousID")) continue;
        const v1 = await rc(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(c.id)}`, key);
        const n = await importCustomer(project, c.id, purchasesFromV1(v1?.subscriber));
        customers++; purchases += n;
      }
      url = page?.next_page ? `https://api.revenuecat.com${page.next_page}` : null;
    }
    return { mode: "v2", customers, purchases };
  }
  const ids: string[] = (Array.isArray(body?.appUserIds) ? body.appUserIds : []).map(String).filter((x: string) => x && !x.startsWith("$RCAnonymousID"));
  if (!ids.length) throw new HttpError(400, "app_user_ids_required", "Legacy (v1) RevenueCat key: pass appUserIds, or create a v2 secret key in RevenueCat → API keys");
  for (const id of ids.slice(0, 20000)) {
    const v1 = await rc(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(id)}`, key);
    const n = await importCustomer(project, id, purchasesFromV1(v1?.subscriber));
    customers++; purchases += n;
  }
  return { mode: "v1", customers, purchases };
}

/** When the real store purchase arrives (SDK / notification), drop the imported RevenueCat copy of it. */
export async function dropImportedDuplicates(projectId: string, appUserId: string, productId: string, store: StoreName) {
  const snap = await db.collection(`projects/${projectId}/customers/${appUserId}/purchases`).where("productId", "==", productId).get();
  await Promise.all(snap.docs.filter(d => d.id.startsWith("rc_") && d.get("store") === store).map(d => d.ref.delete()));
}
