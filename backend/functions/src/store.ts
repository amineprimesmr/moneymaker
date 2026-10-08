import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Firestore, Transaction } from "firebase-admin/firestore";
import { createHash, randomBytes } from "crypto";
import {
  Purchase, EventType, computeEntitlements, diffEvents, convertMicros, HttpError, isPurchaseActive, StoreName,
} from "./engine";

if (!getApps().length) initializeApp();
export const db: Firestore = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

export interface ProjectConfig {
  currency: string;
  entitlements: Record<string, string[]>;
  offerings: Record<string, { description?: string; packages: { id: string; productIds: Partial<Record<StoreName, string>>; metadata?: Record<string, unknown> }[] }>;
  currentOffering?: string;
  webhooks: { id: string; url: string; events?: string[] }[];
  apple?: { bundleId?: string; appAppleId?: number };
  google?: { packageName?: string };
  stripe?: { enabled?: boolean; prices?: Record<string, { productId: string; periodMonths: number }> };
}

export interface Project {
  id: string;
  name: string;
  members: string[];
  config: ProjectConfig;
  createdAt?: unknown;
}

export interface Credentials {
  apple?: { issuerId: string; keyId: string; privateKey: string };
  google?: { serviceAccount: { client_email: string; private_key: string } };
  stripe?: { secretKey?: string; webhookSecret?: string };
  googleRtdnToken: string;
  webhookSigningSecret: string;
}

export const DEFAULT_CONFIG: ProjectConfig = { currency: "EUR", entitlements: {}, offerings: {}, webhooks: [] };

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const token = (prefix: string, bytes = 24) => `${prefix}_${randomBytes(bytes).toString("base64url")}`;

export type KeyKind = "public" | "secret" | "pat";
export interface KeyRecord { kind: KeyKind; projectId?: string; uid?: string; }

export async function resolveKey(raw: string): Promise<KeyRecord | null> {
  const snap = await db.doc(`apiKeys/${sha256(raw)}`).get();
  return snap.exists ? (snap.data() as KeyRecord) : null;
}

export async function issueKey(rec: KeyRecord & { label?: string }): Promise<string> {
  const prefix = rec.kind === "public" ? "mm_pub" : rec.kind === "secret" ? "mm_sk" : "mm_pat";
  const raw = token(prefix);
  await db.doc(`apiKeys/${sha256(raw)}`).set({ ...rec, hint: raw.slice(0, 10) + "…" + raw.slice(-4), createdAt: FieldValue.serverTimestamp() });
  return raw;
}

export async function revokeProjectKeys(projectId: string, kind: KeyKind) {
  const snap = await db.collection("apiKeys").where("projectId", "==", projectId).where("kind", "==", kind).get();
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
}

export async function getProject(id: string): Promise<Project> {
  const snap = await db.doc(`projects/${id}`).get();
  if (!snap.exists) throw new HttpError(404, "project_not_found");
  const data = snap.data()!;
  return { id, name: data.name, members: data.members ?? [], config: { ...DEFAULT_CONFIG, ...data.config }, createdAt: data.createdAt };
}

export async function getCredentials(projectId: string): Promise<Credentials> {
  const snap = await db.doc(`projects/${projectId}/private/credentials`).get();
  if (!snap.exists) throw new HttpError(500, "credentials_missing");
  return snap.data() as Credentials;
}

export async function createProject(name: string, uid: string) {
  const ref = db.collection("projects").doc();
  await ref.set({ name, members: [uid], ownerUid: uid, config: DEFAULT_CONFIG, createdAt: FieldValue.serverTimestamp() });
  await ref.collection("private").doc("credentials").set({
    googleRtdnToken: token("rtdn", 18), webhookSigningSecret: token("whsec", 24),
  });
  const [publicKey, secretKey] = await Promise.all([
    issueKey({ kind: "public", projectId: ref.id }), issueKey({ kind: "secret", projectId: ref.id }),
  ]);
  return { projectId: ref.id, publicKey, secretKey };
}

// ── Customer identity indexes ──────────────────────────────────────────────

export const indexRef = (pid: string, key: string) => db.doc(`projects/${pid}/index/${sha256(key)}`);

export async function lookupIndex(pid: string, ...keys: (string | undefined | null)[]): Promise<string | null> {
  for (const key of keys) {
    if (!key) continue;
    const snap = await indexRef(pid, key).get();
    if (snap.exists) return snap.get("appUserId");
  }
  return null;
}

/** Deterministic UUID the SDKs send as StoreKit appAccountToken / Play obfuscatedAccountId source. */
export function accountUUID(appUserId: string): string {
  const h = sha256(`moneymaker:${appUserId}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function touchCustomer(pid: string, appUserId: string) {
  const ref = db.doc(`projects/${pid}/customers/${appUserId}`);
  const batch = db.batch();
  batch.set(ref, { appUserId, lastSeenAt: Date.now() }, { merge: true });
  batch.set(indexRef(pid, `acct:${accountUUID(appUserId)}`), { appUserId });
  batch.set(indexRef(pid, `acct:${sha256(appUserId)}`), { appUserId });
  await batch.commit();
  const snap = await ref.get();
  if (!snap.get("firstSeenAt")) await ref.set({ firstSeenAt: Date.now() }, { merge: true });
}

// ── Purchases ──────────────────────────────────────────────────────────────

const REVENUE_EVENTS: EventType[] = ["INITIAL_PURCHASE", "RENEWAL", "TRIAL_CONVERTED", "NON_RENEWING_PURCHASE"];

export async function upsertPurchase(
  project: Project, appUserId: string, purchase: Purchase, indexKeys: string[] = [], opts: { silent?: boolean } = {},
) {
  const pid = project.id;
  const customerRef = db.doc(`projects/${pid}/customers/${appUserId}`);
  const purchaseRef = customerRef.collection("purchases").doc(purchase.id);
  const now = Date.now();

  return db.runTransaction(async (tx: Transaction) => {
    const [prevSnap, allSnap, customerSnap] = await Promise.all([
      tx.get(purchaseRef), tx.get(customerRef.collection("purchases")), tx.get(customerRef),
    ]);
    const prev = prevSnap.exists ? (prevSnap.data() as Purchase) : undefined;
    // Out-of-order notifications must never roll state back.
    if (prev && prev.updatedAt > purchase.updatedAt && prev.latestPurchaseAt >= purchase.latestPurchaseAt) {
      return { events: [] as EventType[], entitlements: customerSnap.get("entitlements") ?? {} };
    }
    const events = opts.silent ? [] : diffEvents(prev, purchase);
    const purchases = allSnap.docs.map(d => d.data() as Purchase).filter(p => p.id !== purchase.id).concat(purchase);
    const entitlements = computeEntitlements(purchases, project.config.entitlements, now);

    tx.set(purchaseRef, { ...purchase, projectId: pid, appUserId });
    let spent = 0;
    for (const type of events) {
      const eventRef = db.collection(`projects/${pid}/events`).doc();
      tx.set(eventRef, {
        type, appUserId, productId: purchase.productId, store: purchase.store, purchaseId: purchase.id,
        priceMicros: purchase.priceMicros, currency: purchase.currency, isSandbox: purchase.isSandbox,
        isTrial: purchase.isTrial, expiresAt: purchase.expiresAt, at: now, delivered: false,
      });
      const isRevenue = REVENUE_EVENTS.includes(type) && !purchase.isTrial && purchase.priceMicros > 0;
      if (isRevenue || type === "REFUND") {
        const sign = type === "REFUND" ? -1 : 1;
        const amountProject = sign * convertMicros(purchase.priceMicros, purchase.currency, project.config.currency);
        tx.set(db.doc(`projects/${pid}/transactions/${sha256(`${purchase.id}:${purchase.latestPurchaseAt}:${type === "REFUND" ? "r" : "p"}`)}`), {
          appUserId, store: purchase.store, productId: purchase.productId, purchaseId: purchase.id,
          kind: type === "REFUND" ? "refund" : type === "RENEWAL" ? "renewal" : "purchase",
          amountMicros: sign * purchase.priceMicros, currency: purchase.currency, amountMicrosProject: amountProject,
          isSandbox: purchase.isSandbox, at: type === "REFUND" ? now : purchase.latestPurchaseAt,
        });
        if (!purchase.isSandbox) spent += amountProject;
      }
    }
    tx.set(customerRef, {
      appUserId, entitlements,
      activeEntitlements: Object.values(entitlements).filter(e => e.active).map(e => e.id),
      isPaying: purchases.some(p => isPurchaseActive(p, now) && !p.isTrial && !p.isSandbox),
      lastSeenAt: customerSnap.get("lastSeenAt") ?? now,
      firstSeenAt: customerSnap.get("firstSeenAt") ?? now,
      updatedAt: now,
      ...(spent ? { totalSpentMicros: FieldValue.increment(spent) } : {}),
    }, { merge: true });
    for (const key of indexKeys) tx.set(indexRef(pid, key), { appUserId });
    return { events, entitlements };
  });
}

export async function customerInfo(project: Project, appUserId: string) {
  const ref = db.doc(`projects/${project.id}/customers/${appUserId}`);
  const [snap, purchases] = await Promise.all([ref.get(), ref.collection("purchases").get()]);
  const list = purchases.docs.map(d => d.data() as Purchase);
  const entitlements = computeEntitlements(list, project.config.entitlements);
  return {
    appUserId,
    accountToken: accountUUID(appUserId),
    entitlements,
    activeEntitlements: Object.values(entitlements).filter(e => e.active).map(e => e.id),
    purchases: list.map(p => ({
      id: p.id, store: p.store, productId: p.productId, type: p.type, status: p.status, active: isPurchaseActive(p),
      purchasedAt: p.purchasedAt, expiresAt: p.expiresAt, willRenew: p.willRenew, isTrial: p.isTrial,
      isSandbox: p.isSandbox, billingIssue: p.billingIssue,
    })),
    attributes: snap.get("attributes") ?? {},
    firstSeenAt: snap.get("firstSeenAt") ?? null,
    requestedAt: Date.now(),
  };
}

/** Moves every purchase from `fromId` (e.g. anonymous) to `toId` (logged-in) and re-points indexes. */
export async function mergeCustomers(project: Project, fromId: string, toId: string) {
  if (fromId === toId) return;
  const from = db.doc(`projects/${project.id}/customers/${fromId}`);
  const purchases = await from.collection("purchases").get();
  for (const doc of purchases.docs) {
    const p = doc.data() as Purchase;
    await upsertPurchase(project, toId, { ...p, updatedAt: Date.now() }, [], { silent: true });
    await doc.ref.delete();
  }
  const idx = await db.collection(`projects/${project.id}/index`).where("appUserId", "==", fromId).get();
  const batch = db.batch();
  idx.docs.forEach(d => batch.set(d.ref, { appUserId: toId }));
  batch.set(from, { mergedInto: toId, entitlements: {}, activeEntitlements: [] }, { merge: true });
  batch.set(db.doc(`projects/${project.id}/customers/${toId}`), { aliases: FieldValue.arrayUnion(fromId) }, { merge: true });
  await batch.commit();
}
