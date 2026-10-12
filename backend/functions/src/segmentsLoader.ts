// Chargement Firestore pour la prédiction de LTV (ltv.ts) et les audiences (audiences.ts).
import { db, Project } from "./store";
import { HttpError, Purchase } from "./engine";
import { predictLtv, LtvPayment } from "./ltv";
import { Audience, CustomerRow, matchAudience } from "./audiences";

export const LTV_GROUPS = ["product", "country", "store"] as const;

export async function projectLtv(project: Project, groupBy: string, now = Date.now()) {
  if (!(LTV_GROUPS as readonly string[]).includes(groupBy)) throw new HttpError(400, "invalid_group_by", `groupBy ∈ ${LTV_GROUPS.join(", ")}`);
  const snap = await db.collection(`projects/${project.id}/transactions`).orderBy("at", "desc").limit(100000)
    .select("appUserId", "productId", "store", "country", "amountMicrosProject", "periodMonths", "isSandbox", "at").get();
  const payments: LtvPayment[] = [];
  for (const d of snap.docs) {
    const t = d.data();
    if (t.isSandbox || !t.appUserId) continue;
    const group = groupBy === "product" ? t.productId : groupBy === "store" ? t.store : (t.country ?? "??");
    payments.push({ customerId: String(t.appUserId), group: String(group ?? "??"), at: Number(t.at), amountMicros: Number(t.amountMicrosProject ?? 0), periodMonths: Number(t.periodMonths ?? 0) });
  }
  return { currency: project.config.currency, groupBy, transactions: payments.length, truncated: snap.size >= 100000, groups: predictLtv(payments, now), generatedAt: now };
}

export function audienceById(project: Project, aid: string): Audience {
  const a = ((project.config as any).audiences ?? []).find((x: Audience) => x.id === aid);
  if (!a) throw new HttpError(404, "audience_not_found");
  return a;
}

/** Charge les clients du projet (max 20 000 les plus récents) avec leurs achats. */
export async function loadCustomerRows(project: Project) {
  const pid = project.id;
  const [custSnap, purSnap] = await Promise.all([
    db.collection(`projects/${pid}/customers`).orderBy("lastSeenAt", "desc").limit(20000).get(),
    db.collectionGroup("purchases").where("projectId", "==", pid).get(),
  ]);
  const byCustomer = new Map<string, Purchase[]>();
  for (const d of purSnap.docs) {
    const uid = String(d.get("appUserId") ?? d.ref.parent.parent?.id);
    (byCustomer.get(uid) ?? byCustomer.set(uid, []).get(uid)!).push(d.data() as Purchase);
  }
  const rows: (CustomerRow & { lastSeenAt?: number })[] = [];
  for (const d of custSnap.docs) {
    const c = d.data();
    if (c.mergedInto) continue;
    rows.push({
      id: d.id, country: c.country ?? null, firstSeenAt: c.firstSeenAt ?? null, totalSpentMicros: c.totalSpentMicros ?? 0,
      attributes: c.attributes ?? {}, appleAds: c.appleAds ?? null, activeEntitlements: c.activeEntitlements ?? [],
      purchases: byCustomer.get(d.id) ?? [], lastSeenAt: c.lastSeenAt,
    });
  }
  return { rows, truncated: custSnap.size >= 20000 };
}

export async function audienceCustomers(project: Project, a: Pick<Audience, "filters">, now = Date.now()) {
  const { rows, truncated } = await loadCustomerRows(project);
  return { rows: rows.filter(r => matchAudience(a.filters, r, now)), scanned: rows.length, truncated };
}
