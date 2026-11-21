import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Firestore, Transaction } from "firebase-admin/firestore";
import { createHash, randomBytes } from "crypto";
import {
  Purchase, EventType, computeEntitlements, diffEvents, convertMicros, HttpError, isPurchaseActive, StoreName, applyFxRates,
} from "./engine";
import { walletOpsFor, readWalletOps, writeWalletOps } from "./wallet";

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
  integrations?: { appsflyer?: { appId: string; androidAppId?: string } };
  appStore?: { apps: { appId: string; own?: boolean }[] };
  customerCenter?: CustomerCenterConfig;
  targeting?: import("./growth").Targeting;
  experiments?: import("./growth").Experiment[];
}

export interface CustomerCenterConfig {
  enabled: boolean;
  supportEmail?: string;
  retentionOffer?: { productIdApple?: string; offerIdApple?: string; googleOfferId?: string; message: string };
  survey: { question: string; options: string[] };
}

export interface Project {
  id: string;
  name: string;
  members: string[];
  /** uid → role ("admin" | "developer" | "viewer"); members absent from the map are owners. */
  roles?: Record<string, string>;
  ownerUid?: string;
  config: ProjectConfig;
  createdAt?: unknown;
}

export interface Credentials {
  apple?: { issuerId: string; keyId: string; privateKey: string };
  google?: { serviceAccount: { client_email: string; private_key: string } };
  stripe?: { secretKey?: string; webhookSecret?: string };
  appsflyer?: { devKey: string };
  appStoreConnect?: { issuerId: string; keyId: string; privateKey: string };
  integrations?: import("./integrations").IntegrationSecrets;
  googleRtdnToken: string;
  /** Jetons distincts par webhook : une URL qui fuit n'ouvre pas les autres. */
  amazonNotificationToken?: string;
  rokuNotificationToken?: string;
  webhookSigningSecret: string;
}

export const DEFAULT_CONFIG: ProjectConfig = { currency: "EUR", entitlements: {}, offerings: {}, webhooks: [] };

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const token = (prefix: string, bytes = 24) => `${prefix}_${randomBytes(bytes).toString("base64url")}`;

export type KeyKind = "public" | "secret" | "pat" | "test";
export interface KeyRecord { kind: KeyKind; projectId?: string; uid?: string; issuedBy?: string; }

export async function resolveKey(raw: string): Promise<KeyRecord | null> {
  const snap = await db.doc(`apiKeys/${sha256(raw)}`).get();
  return snap.exists ? (snap.data() as KeyRecord) : null;
}

export async function issueKey(rec: KeyRecord & { label?: string }): Promise<string> {
  const prefix = rec.kind === "public" ? "mm_pub" : rec.kind === "secret" ? "mm_sk" : rec.kind === "test" ? "mm_test" : "mm_pat";
  const raw = token(prefix);
  await db.doc(`apiKeys/${sha256(raw)}`).set({ ...rec, hint: raw.slice(0, 10) + "…" + raw.slice(-4), createdAt: FieldValue.serverTimestamp() });
  return raw;
}

/** Clés d'un business émises par un membre (révoquées quand il quitte l'équipe). */
export async function revokeKeysIssuedBy(projectId: string, uid: string) {
  const snap = await db.collection("apiKeys").where("projectId", "==", projectId).where("issuedBy", "==", uid).get();
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
  return snap.size;
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
  return { id, name: data.name, members: data.members ?? [], roles: data.roles ?? {}, ownerUid: data.ownerUid, config: { ...DEFAULT_CONFIG, ...data.config }, createdAt: data.createdAt };
}

const newWebhookTokens = () => ({
  googleRtdnToken: token("rtdn", 18), amazonNotificationToken: token("amzn", 18), rokuNotificationToken: token("roku", 18),
  webhookSigningSecret: token("whsec", 24),
});

/** Identifiants privés du business. Créés à la volée s'ils manquent (business créé hors API),
 *  et complétés des jetons de webhook apparus depuis : plus d'erreur 500 « credentials_missing ». */
export async function getCredentials(projectId: string): Promise<Credentials> {
  const ref = db.doc(`projects/${projectId}/private/credentials`);
  const snap = await ref.get();
  const data = (snap.exists ? snap.data() : {}) as Partial<Credentials>;
  const fresh = newWebhookTokens();
  const missing = Object.fromEntries(Object.entries(fresh).filter(([k]) => !(data as any)[k]));
  if (!Object.keys(missing).length) return data as Credentials;
  await ref.set(missing, { merge: true });
  return { ...data, ...missing } as Credentials;
}

export async function createProject(name: string, uid: string) {
  const ref = db.collection("projects").doc();
  await ref.set({ name, members: [uid], ownerUid: uid, config: DEFAULT_CONFIG, createdAt: FieldValue.serverTimestamp() });
  await ref.collection("private").doc("credentials").set(newWebhookTokens());
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

/** Plateforme d'un appel SDK, d'après l'en-tête X-Platform puis le User-Agent. */
export function sdkPlatform(xPlatform?: string, userAgent?: string): "ios" | "android" | "web" | "other" {
  const s = `${xPlatform ?? ""} ${userAgent ?? ""}`.toLowerCase();
  if (/android|amazon|galaxy|samsung|play_store/.test(s)) return "android";
  if (/ios|iphone|ipad|ipados|macos|darwin|cfnetwork|watchos|tvos|visionos|app_store/.test(s)) return "ios";
  if (/web|stripe|mozilla/.test(s)) return "web";
  return "other";
}

/** Id créé par une boutique ou un paiement web, pas par l'ouverture de l'app. */
export const isStoreOnlyId = (id: string) => /^\$(stripe|apple|google|paddle|amazon|roku|galaxy|web):/.test(id);

/** Installation = premier passage d'un appareil dans le SDK (comme « New Customers » chez RevenueCat).
 *  Compteur du jour (UTC) pour les graphiques ; `installAt` sur le client pour « aujourd'hui » dans le fuseau de l'utilisateur. */
export async function recordInstall(pid: string, platform: string, at = Date.now()) {
  const date = new Date(at).toISOString().slice(0, 10);
  await db.doc(`projects/${pid}/installs/${date}`).set({
    date, units: FieldValue.increment(1), byPlatform: { [platform]: FieldValue.increment(1) },
    byHour: { [String(new Date(at).getUTCHours())]: FieldValue.increment(1) }, updatedAt: at,
  }, { merge: true });
}

/** `install` : appel du SDK depuis l'app (pas une fusion d'identifiants, ni un paiement web). */
export async function touchCustomer(pid: string, appUserId: string, ctx: { install?: boolean; platform?: string } = {}) {
  const ref = db.doc(`projects/${pid}/customers/${appUserId}`);
  const batch = db.batch();
  batch.set(ref, { appUserId, lastSeenAt: Date.now() }, { merge: true });
  batch.set(indexRef(pid, `acct:${accountUUID(appUserId)}`), { appUserId });
  batch.set(indexRef(pid, `acct:${sha256(appUserId)}`), { appUserId });
  await batch.commit();
  // Transaction : deux appels simultanés au premier lancement ne comptent qu'une installation.
  const first = await db.runTransaction(async t => {
    const snap = await t.get(ref);
    if (snap.get("firstSeenAt") || snap.get("mergedInto")) return null; // identifiant fusionné : compté dans le compte cible
    const now = Date.now();
    const install = !!ctx.install && !isStoreOnlyId(appUserId);
    t.set(ref, { firstSeenAt: now, ...(install ? { installAt: now, platform: ctx.platform ?? "other" } : {}) }, { merge: true });
    return install ? now : null;
  });
  if (first) await recordInstall(pid, ctx.platform ?? "other", first).catch(e => console.error("install", pid, e));
}

/** Installations depuis `since` (graphiques) ; jours UTC. */
export async function installsFor(projectId: string, since: number) {
  const snap = await db.collection(`projects/${projectId}/installs`).where("date", ">=", new Date(since).toISOString().slice(0, 10)).get();
  const byDay: Record<string, number> = {}, byPlatform: Record<string, number> = {};
  let total = 0;
  for (const d of snap.docs) {
    const x = d.data();
    byDay[x.date] = x.units ?? 0; total += x.units ?? 0;
    for (const [k, v] of Object.entries(x.byPlatform ?? {})) byPlatform[k] = (byPlatform[k] ?? 0) + (v as number);
  }
  return { total, byDay, byPlatform };
}

/** Installations depuis `since` à la milliseconde près (« aujourd'hui » dans le fuseau de l'utilisateur). */
export async function installsSince(projectId: string, since: number): Promise<number> {
  return (await db.collection(`projects/${projectId}/customers`).where("installAt", ">=", since).count().get()).data().count;
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
    // Monnaie virtuelle (wallet.ts) : lectures du journal avant toute écriture de la transaction.
    const walletOps = await readWalletOps(tx, customerRef, walletOpsFor((project.config as any).virtualCurrencies, purchase, events));
    const purchases = allSnap.docs.map(d => d.data() as Purchase).filter(p => p.id !== purchase.id).concat(purchase);
    const entitlements = computeEntitlements(purchases, project.config.entitlements, now);

    tx.set(purchaseRef, { ...purchase, projectId: pid, appUserId });
    let spent = 0;
    for (const type of events) {
      const eventRef = db.collection(`projects/${pid}/events`).doc();
      tx.set(eventRef, {
        type, appUserId, productId: purchase.productId, productName: purchase.productName ?? null, store: purchase.store, purchaseId: purchase.id,
        priceMicros: purchase.priceMicros, currency: purchase.currency, isSandbox: purchase.isSandbox,
        isTrial: purchase.isTrial, expiresAt: purchase.expiresAt, country: purchase.country ?? null, periodMonths: purchase.periodMonths, at: now, delivered: false,
        purchasedAt: purchase.latestPurchaseAt, // date réelle de l'achat : un événement rattrapé (webhook en retard, resync) n'est pas une vente du jour
      });
      const isRevenue = REVENUE_EVENTS.includes(type) && !purchase.isTrial && purchase.priceMicros > 0;
      if (isRevenue || type === "REFUND" || (type === "REFUND_REVERSED" && purchase.priceMicros > 0)) {
        const sign = type === "REFUND" ? -1 : 1; // remboursement annulé : le montant revient
        const amountProject = sign * convertMicros(purchase.priceMicros, purchase.currency, project.config.currency);
        tx.set(db.doc(`projects/${pid}/transactions/${sha256(`${purchase.id}:${purchase.latestPurchaseAt}:${type === "REFUND" ? "r" : type === "REFUND_REVERSED" ? `rr${now}` : "p"}`)}`), {
          appUserId, store: purchase.store, productId: purchase.productId, productName: purchase.productName ?? null, purchaseId: purchase.id,
          kind: type === "REFUND" ? "refund" : type === "RENEWAL" ? "renewal" : "purchase",
          amountMicros: sign * purchase.priceMicros, currency: purchase.currency, amountMicrosProject: amountProject,
          isSandbox: purchase.isSandbox, country: purchase.country ?? null, periodMonths: purchase.periodMonths, at: type === "REFUND" ? now : purchase.latestPurchaseAt,
          affiliate: !!purchase.affiliate,
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
      ...(purchase.country ? { country: purchase.country } : {}),
      ...(spent ? { totalSpentMicros: FieldValue.increment(spent) } : {}),
    }, { merge: true });
    for (const key of indexKeys) tx.set(indexRef(pid, key), { appUserId });
    writeWalletOps(tx, customerRef, walletOps, now);
    return { events, entitlements };
  });
}

/** Événement sans changement d'état de l'achat (demande de remboursement, refus d'Apple, litige Stripe,
 *  remboursement partiel) : écrit dans le flux, il part en notification et vers les webhooks comme les autres.
 *  `refundMicros` > 0 enregistre aussi la transaction négative correspondante (idempotente via `key`). */
export async function recordEvent(project: Project, appUserId: string, purchase: Partial<Purchase> & { id: string; productId: string },
  type: EventType, extra: { reason?: string | null; refundMicros?: number; key?: string } = {}) {
  const pid = project.id, now = Date.now();
  const key = extra.key ?? `${purchase.id}:${type}:${now}`;
  const eventRef = db.doc(`projects/${pid}/events/${sha256(`ev:${key}`).slice(0, 40)}`);
  if ((await eventRef.get()).exists) return { duplicate: true };
  const batch = db.batch();
  batch.set(eventRef, {
    type, appUserId, productId: purchase.productId, productName: purchase.productName ?? null, store: purchase.store ?? null, purchaseId: purchase.id,
    priceMicros: extra.refundMicros ?? purchase.priceMicros ?? 0, currency: purchase.currency ?? project.config.currency, isSandbox: !!purchase.isSandbox,
    isTrial: !!purchase.isTrial, expiresAt: purchase.expiresAt ?? null, country: purchase.country ?? null, periodMonths: purchase.periodMonths ?? 0,
    at: now, delivered: false, ...(extra.reason ? { reason: extra.reason } : {}),
  });
  if (extra.refundMicros && extra.refundMicros > 0) {
    const cur = purchase.currency ?? project.config.currency;
    batch.set(db.doc(`projects/${pid}/transactions/${sha256(`refund:${key}`)}`), {
      appUserId, store: purchase.store ?? null, productId: purchase.productId, productName: purchase.productName ?? null, purchaseId: purchase.id,
      kind: "refund", amountMicros: -extra.refundMicros, currency: cur, amountMicrosProject: -convertMicros(extra.refundMicros, cur, project.config.currency),
      isSandbox: !!purchase.isSandbox, country: purchase.country ?? null, periodMonths: purchase.periodMonths ?? 0, at: now,
    });
  }
  await batch.commit();
  return { recorded: type };
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
    appleAds: snap.get("appleAds") ?? null,
    firstSeenAt: snap.get("firstSeenAt") ?? null,
    requestedAt: Date.now(),
  };
}

/** Moves every purchase from `fromId` (e.g. anonymous) to `toId` (logged-in) and re-points indexes. */
/** Anonymous ids generated by the SDKs (MoneyMaker `$anon:`, RevenueCat `$RCAnonymousID:`). */
export const isAnonymousId = (id: string) => /^\$(anon:|RCAnonymousID:)/.test(id);

export async function mergeCustomers(project: Project, fromId: string, toId: string) {
  if (fromId === toId) return;
  if (!toId) throw new HttpError(400, "new_app_user_id_required");
  const from = db.doc(`projects/${project.id}/customers/${fromId}`);
  const toRef = db.doc(`projects/${project.id}/customers/${toId}`);
  const [fromSnap, toSnap] = await Promise.all([from.get(), toRef.get()]);
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
  batch.set(toRef, { aliases: FieldValue.arrayUnion(fromId) }, { merge: true });
  await batch.commit();
  await mergeCohort(project.id, fromSnap, toSnap, toRef, from);
}

/** Comme RevenueCat : des identifiants fusionnés comptent pour un seul client, daté du premier passage
 *  (le plus ancien des deux). Une installation anonyme rattachée à un compte qui existait déjà
 *  (réinstallation, puis connexion) n'est plus comptée ; sinon elle passe au compte. */
export function cohortAfterMerge(from: { firstSeenAt?: number; installAt?: number }, to: { firstSeenAt?: number; installAt?: number } | null) {
  const seen = [from.firstSeenAt, to?.firstSeenAt].filter((x): x is number => typeof x === "number");
  const firstSeenAt = seen.length ? Math.min(...seen) : undefined;
  if (!from.installAt) return { firstSeenAt, installAt: to?.installAt, dropInstall: false };
  const returning = !!to && (typeof to.installAt === "number" || (typeof to.firstSeenAt === "number" && to.firstSeenAt < from.installAt));
  return returning ? { firstSeenAt, installAt: to!.installAt, dropInstall: true } : { firstSeenAt, installAt: from.installAt, dropInstall: false };
}

async function mergeCohort(pid: string, fromSnap: FirebaseFirestore.DocumentSnapshot, toSnap: FirebaseFirestore.DocumentSnapshot,
  toRef: FirebaseFirestore.DocumentReference, fromRef: FirebaseFirestore.DocumentReference) {
  const f = { firstSeenAt: fromSnap.get("firstSeenAt") as number | undefined, installAt: fromSnap.get("installAt") as number | undefined };
  const t = toSnap.exists ? { firstSeenAt: toSnap.get("firstSeenAt") as number | undefined, installAt: toSnap.get("installAt") as number | undefined } : null;
  const r = cohortAfterMerge(f, t);
  const platform = fromSnap.get("platform") ?? "other";
  await toRef.set({
    ...(r.firstSeenAt ? { firstSeenAt: r.firstSeenAt } : {}),
    ...(r.installAt && r.installAt !== t?.installAt ? { installAt: r.installAt, platform } : {}),
  }, { merge: true });
  // L'identifiant anonyme fusionné ne compte plus ni comme client, ni comme installation.
  await fromRef.set({ firstSeenAt: FieldValue.delete(), installAt: FieldValue.delete(), mergedFirstSeenAt: f.firstSeenAt ?? null }, { merge: true });
  if (r.dropInstall && f.installAt) {
    const date = new Date(f.installAt).toISOString().slice(0, 10);
    await db.doc(`projects/${pid}/installs/${date}`).set({
      units: FieldValue.increment(-1), byPlatform: { [platform]: FieldValue.increment(-1) },
      byHour: { [String(new Date(f.installAt).getUTCHours())]: FieldValue.increment(-1) }, reinstalls: FieldValue.increment(1),
    }, { merge: true }).catch(e => console.error("install merge", pid, e));
  }
}


// ── Taux de change ─────────────────────────────────────────────────────────
// Taux du jour de la BCE (system/fx), relus toutes les 6 h par chaque instance ; la table de engine.ts sert de repli.
let fxLoadedAt = 0;
export async function loadFx(force = false) {
  if (!force && Date.now() - fxLoadedAt < 6 * 3600000) return;
  fxLoadedAt = Date.now();
  const d = (await db.doc("system/fx").get().catch(() => null))?.data();
  if (d?.rates && typeof d.rates === "object") applyFxRates(d.rates);
}

/** Récupère les taux de référence BCE (Frankfurter) et les enregistre. Appelé une fois par jour. */
export async function refreshFxFromEcb() {
  const r = await fetch("https://api.frankfurter.dev/v1/latest?base=EUR", { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`fx ${r.status}`);
  const j = await r.json() as { date?: string; rates?: Record<string, number> };
  if (!j.rates || !Object.keys(j.rates).length) throw new Error("fx_empty");
  await db.doc("system/fx").set({ rates: j.rates, date: j.date ?? null, source: "ECB", at: Date.now() });
  applyFxRates(j.rates);
  fxLoadedAt = Date.now();
}
