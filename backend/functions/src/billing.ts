// MoneyMaker Pro : licence à vie à 29 €, payée une fois, attachée au compte MoneyMaker.
//
//   • Gratuit : un business. Pro : business illimités, sur le web comme sur l'iPhone.
//   • Un seul droit par compte, alimenté par deux achats possibles (voir proEntitlement.ts) :
//       – web : Stripe Checkout. Le compte Stripe est lu dans Firestore system/billing
//         { secretKey, webhookSecret, priceId } (jamais renvoyé par l'API). Le webhook
//         POST /v1/webhooks/billing ajoute la source « stripe » et la retire au remboursement ;
//       – iPhone : achat intégré d'Apple (non consommable io.moneymaker.pro.lifetime). L'app envoie la
//         transaction signée à POST /v1/billing/appstore, qui ajoute la source « app_store ». Une
//         transaction ne débloque qu'un seul compte (appStorePurchases/{originalTransactionId}).
//   • Un compte déjà Pro ne peut pas repayer : le web refuse le paiement, l'app affiche « Actif ».

import { randomUUID } from "crypto";
import Stripe from "stripe";
import { SignedDataVerifier, Environment, JWSTransactionDecodedPayload } from "@apple/app-store-server-library";
import { APPLE_ROOT_CERTIFICATES } from "./appleRootCertificates";
import { HttpError } from "./engine";
import { db } from "./store";
import { DEMO_UID } from "./demo";
import { GIFT_ATTEMPTS_PER_DAY, ProGrant, ProSource, giftAttempts, isFullDiscount, normalizeGiftCode, proFields, proSources, proState, testerOverride, withSource } from "./proEntitlement";

export const FREE_PROJECTS = 1;
/** Lancement : tout est gratuit pour les premiers utilisateurs. Aucun achat proposé, aucune limite de
 *  business, sur l'app (toutes versions) comme sur le web. Remettre à false pour rouvrir Pro. */
export const FREE_LAUNCH = true;
export const PRO_PRICE = { amount: 29, currency: "EUR" };
export const PRO_PRODUCT_ID = "io.moneymaker.pro.lifetime";

interface BillingConfig { secretKey: string; webhookSecret: string; priceId: string; mode: "test" | "live"; testers: string[] }
let cache: { at: number; cfg: BillingConfig | null } | null = null;

async function config(): Promise<BillingConfig | null> {
  if (cache && Date.now() - cache.at < 60_000) return cache.cfg;
  const d = (await db.doc("system/billing").get()).data();
  const cfg: BillingConfig | null = d?.secretKey && d?.priceId ? {
    secretKey: d.secretKey, webhookSecret: d.webhookSecret ?? "", priceId: d.priceId,
    mode: d.mode === "live" ? "live" : "test", testers: Array.isArray(d.testers) ? d.testers : [],
  } : null;
  cache = { at: Date.now(), cfg };
  return cfg;
}

/** En mode test, seuls les testeurs voient l'offre : personne n'obtient Pro avec une carte de test. */
async function configFor(uid: string) {
  if (FREE_LAUNCH) return null;
  const cfg = await config();
  return cfg && (cfg.mode === "live" || cfg.testers.includes(uid)) ? cfg : null;
}

async function stripe() {
  const cfg = await config();
  if (!cfg) throw new HttpError(503, "billing_unavailable", "Le paiement n'est pas encore configuré.");
  return { cfg, stripe: new Stripe(cfg.secretKey) };
}

export async function isPro(uid: string) {
  return proState((await db.doc(`users/${uid}`).get()).data()).pro;
}

/** Ajoute (grant) ou retire (null) une source d'achat, puis recalcule pro, dans une transaction. */
/** Achat confirmé par le serveur, vers PostHog (MoneyMaker lui-même). Ne bloque jamais le paiement. */
async function trackPurchase(uid: string, source: ProSource) {
  try {
    await fetch("https://eu.i.posthog.com/capture/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: "phc_kjnwF7TNPN9QtCYGQjUAbGH7KsGGgQvLgK6o4WXZ563H",
        event: "purchase_confirmed",
        distinct_id: await appAccountToken(uid),
        properties: { source, product_id: PRO_PRODUCT_ID },
      }),
    });
  } catch { /* mesure seulement */ }
}

async function setProSource(uid: string, source: ProSource, grant: ProGrant | null, tx?: FirebaseFirestore.Transaction) {
  const ref = db.doc(`users/${uid}`);
  const apply = async (t: FirebaseFirestore.Transaction) => {
    const u = (await t.get(ref)).data();
    const fields = proFields(withSource(u, source, grant), testerOverride(u));
    t.set(ref, fields, { mergeFields: Object.keys(fields) });
  };
  if (tx) await apply(tx); else await db.runTransaction(apply);
}

async function ownedProjects(uid: string) {
  return (await db.collection("projects").where("ownerUid", "==", uid).count().get()).data().count;
}

/** Identifiant opaque passé à StoreKit (appAccountToken) : relie un achat Apple à ce compte. */
async function appAccountToken(uid: string) {
  const ref = db.doc(`users/${uid}`);
  const existing = (await ref.get()).get("appAccountToken");
  if (typeof existing === "string") return existing;
  const token = randomUUID();
  await ref.set({ appAccountToken: token }, { merge: true });
  return token;
}

/** Statut lu par l'app et le dashboard : pro, d'où il vient (sources) et de quoi acheter sur iPhone. */
export async function billingStatus(uid: string) {
  const [user, owned, token] = await Promise.all([db.doc(`users/${uid}`).get(), ownedProjects(uid), appAccountToken(uid)]);
  const { pro, sources } = proState(user.data());
  const tester = !!(await config())?.testers.includes(uid);
  return {
    pro, sources, ownedProjects: owned, freeProjects: FREE_PROJECTS, price: PRO_PRICE, available: !!(await configFor(uid)), tester, freeLaunch: FREE_LAUNCH,
    productId: PRO_PRODUCT_ID, appAccountToken: token,
  };
}

/** Testeurs (system/billing.testers) : bascule Pro / gratuit sur leur propre compte, pour voir les deux versions. */
export async function setTesterPro(uid: string, pro: unknown) {
  if (!(await config())?.testers.includes(uid)) throw new HttpError(403, "forbidden");
  if (typeof pro !== "boolean") throw new HttpError(400, "invalid_pro");
  const ref = db.doc(`users/${uid}`);
  await db.runTransaction(async tx => {
    const u = (await tx.get(ref)).data();
    const fields = proFields(proSources(u), pro);
    tx.set(ref, fields, { mergeFields: Object.keys(fields) });
  });
  return billingStatus(uid);
}

/** Bloque la création au-delà du quota gratuit (402 : l'appelant propose l'achat). */
export async function assertCanCreateProject(uid: string) {
  // Tant que le paiement n'est pas configuré, personne n'est bloqué sans pouvoir payer.
  if (!(await configFor(uid)) || await isPro(uid)) return;
  if (await ownedProjects(uid) >= FREE_PROJECTS) {
    throw new HttpError(402, "pro_required", `Le plan gratuit inclut ${FREE_PROJECTS} business. MoneyMaker Pro (achat unique) les débloque tous.`);
  }
}

// ── Code cadeau : Pro offert, sans paiement ────────────────────────────────
//
// Un code est valable s'il figure dans system/billing.giftCodes (liste de codes en majuscules) ou s'il
// est, dans le compte Stripe de MoneyMaker, un code promo actif à 100 %. Il ajoute la source « granted »
// au compte : le droit tient donc que le paiement soit ouvert ou non (FREE_LAUNCH), sur le web comme
// sur l'iPhone. Les essais ratés sont comptés par compte et par jour.

/** Code valable et nombre d'utilisations permises (null = illimité).
 *  system/billing.giftCodes : "CODE" (illimité) ou { code: "CODE", max: 50 }.
 *  Code promo Stripe à 100 % : sa limite `max_redemptions` est respectée (décomptée ici, car aucun paiement Stripe n'a lieu). */
async function giftCodeLimit(code: string): Promise<{ valid: boolean; max: number | null }> {
  const listed = (await db.doc("system/billing").get()).get("giftCodes");
  if (Array.isArray(listed)) {
    for (const c of listed) {
      if (typeof c === "string" && c.toUpperCase() === code) return { valid: true, max: null };
      if (c && typeof c === "object" && String(c.code ?? "").toUpperCase() === code) return { valid: true, max: Number.isFinite(c.max) ? Number(c.max) : null };
    }
  }
  const cfg = await config();
  if (!cfg) return { valid: false, max: null };
  try {
    const found = (await new Stripe(cfg.secretKey).promotionCodes.list({ code, active: true, limit: 1 })).data[0];
    // Selon la version de l'API Stripe, le coupon est sur le code ou sous `promotion`.
    const coupon = (found as any)?.coupon ?? (found as any)?.promotion?.coupon;
    if (!isFullDiscount(typeof coupon === "object" ? coupon : null)) return { valid: false, max: null };
    const max = (found as any)?.max_redemptions ?? (typeof coupon === "object" ? coupon?.max_redemptions : null);
    const used = Number((found as any)?.times_redeemed ?? 0);
    return { valid: true, max: typeof max === "number" ? Math.max(0, max - used) : null };
  } catch { return { valid: false, max: null }; }
}

export async function redeemGiftCode(uid: string, raw: unknown) {
  const code = normalizeGiftCode(raw);
  if (!code) throw new HttpError(400, "invalid_code", "Ce code n'a pas la bonne forme.");
  const ref = db.doc(`users/${uid}`);
  const before = (await ref.get()).data();
  // Déjà offert : rien à refaire, on répond comme un succès (un agent peut rappeler l'outil sans risque).
  if (proSources(before).granted) return { ...(await billingStatus(uid)), redeemed: false, alreadyActive: true };
  const day = new Date().toISOString().slice(0, 10);
  if (giftAttempts(before, day) >= GIFT_ATTEMPTS_PER_DAY) throw new HttpError(429, "too_many_attempts", "Trop d'essais aujourd'hui. Réessaie demain.");
  const { valid, max } = await giftCodeLimit(code);
  if (!valid) {
    await ref.set({ giftAttempts: { day, n: giftAttempts(before, day) + 1 } }, { merge: true });
    throw new HttpError(404, "unknown_code", "Code inconnu ou expiré.");
  }
  const uses = db.doc(`giftCodeUses/${code}`);
  await db.runTransaction(async tx => {
    const n = Number((await tx.get(uses)).get("count") ?? 0);
    if (max !== null && n >= max) throw new HttpError(410, "code_exhausted", "Ce code a déjà été utilisé le nombre de fois prévu.");
    await setProSource(uid, "granted", { since: Date.now(), ref: `code:${code}` }, tx);
    tx.set(uses, { count: n + 1, lastAt: Date.now() }, { merge: true });
    tx.set(db.doc(`giftRedemptions/${uid}`), { uid, code, at: Date.now() });
  });
  return { ...(await billingStatus(uid)), redeemed: true, alreadyActive: false };
}

const RETURN_HOSTS = new Set(["usemoneymaker.com", "www.usemoneymaker.com", "moneymaker-io.web.app", "localhost"]);

/** URL de retour sûre : seulement nos domaines (ou le schéma de l'app), sinon le dashboard. */
export function safeReturnUrl(raw: unknown, base: string): string {
  if (typeof raw === "string") {
    if (/^moneymaker:\/\//.test(raw)) return raw.slice(0, 300);
    try { const u = new URL(raw); if (RETURN_HOSTS.has(u.hostname)) return u.toString(); } catch { /* repli */ }
  }
  return `${base}/#settings`;
}

export async function createCheckout(uid: string, email: string | undefined, returnUrl: string) {
  if (await isPro(uid)) throw new HttpError(409, "already_pro");
  if (!(await configFor(uid))) throw new HttpError(503, "billing_unavailable", "Le paiement n'est pas encore ouvert.");
  const { cfg, stripe: s } = await stripe();
  const sep = returnUrl.includes("?") ? "&" : "?";
  const session = await s.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: cfg.priceId, quantity: 1 }],
    client_reference_id: uid,
    customer_email: email,
    customer_creation: "always",
    invoice_creation: { enabled: true },
    allow_promotion_codes: true,
    metadata: { uid, app_user_id: uid, product_id: PRO_PRODUCT_ID },
    payment_intent_data: { metadata: { uid, app_user_id: uid, product_id: PRO_PRODUCT_ID } },
    success_url: `${returnUrl}${sep}pro=success`,
    cancel_url: `${returnUrl}${sep}pro=cancel`,
  });
  return { url: session.url, id: session.id };
}

export async function handleBillingWebhook(raw: Buffer | string | undefined, signature: string | undefined) {
  const { cfg, stripe: s } = await stripe();
  if (!raw || !signature || !cfg.webhookSecret) throw new HttpError(400, "invalid_signature");
  let event: Stripe.Event;
  try { event = s.webhooks.constructEvent(raw, signature, cfg.webhookSecret); }
  catch { throw new HttpError(400, "invalid_signature"); }

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const cs = event.data.object as Stripe.Checkout.Session;
    const uid = cs.client_reference_id ?? cs.metadata?.uid;
    // Un code à -100 % termine le paiement en no_payment_required : le droit est acquis aussi.
    // Seules nos sessions de paiement Pro comptent (pas un lien de paiement ou un autre produit du compte Stripe).
    const isPro = cs.metadata?.product_id === PRO_PRODUCT_ID;
    if (uid && isPro && (cs.payment_status === "paid" || cs.payment_status === "no_payment_required")) {
      await setProSource(uid, "stripe", { since: Date.now(), ref: String(cs.payment_intent ?? cs.id) });
      await db.doc(`users/${uid}`).set({ proCustomer: String(cs.customer ?? "") }, { merge: true });
      await trackPurchase(uid, "stripe");
    }
  } else if (event.type === "charge.refunded") {
    const ch = event.data.object as Stripe.Charge;
    // La charge ne reprend pas les métadonnées du paiement : on retrouve l'acheteur par son paiement.
    const pi = String(ch.payment_intent ?? "");
    const byRef = async (field: string) => pi ? (await db.collection("users").where(field, "==", pi).limit(1).get()).docs[0]?.id : undefined;
    const uid = ch.metadata?.uid ?? await byRef("proSources.stripe.ref") ?? await byRef("proPaymentIntent");
    if (uid && ch.refunded) {
      await setProSource(uid, "stripe", null);
      await db.doc(`users/${uid}`).set({ proRefundedAt: Date.now() }, { merge: true });
    }
  }
  return { received: true };
}

// ── Achat intégré d'Apple (app iPhone) ───────────────────────────────────

const APP_BUNDLE_ID = "io.moneymaker.app";
const APP_APPLE_ID = 6821596839;
// Production d'abord ; le bac à sable sert à App Review et à TestFlight.
const APP_VERIFIERS = [
  new SignedDataVerifier(APPLE_ROOT_CERTIFICATES, true, Environment.PRODUCTION, APP_BUNDLE_ID, APP_APPLE_ID),
  new SignedDataVerifier(APPLE_ROOT_CERTIFICATES, true, Environment.SANDBOX, APP_BUNDLE_ID),
];

async function verifyAppTransaction(signed: unknown) {
  if (typeof signed !== "string" || !signed || signed.length > 20_000) throw new HttpError(400, "invalid_transaction");
  for (const v of APP_VERIFIERS) {
    try { return await v.verifyAndDecodeTransaction(signed); } catch { /* environnement suivant */ }
  }
  throw new HttpError(400, "invalid_transaction", "Transaction App Store invalide.");
}

/** Remboursement ou retrait (Partage familial, fraude) : Pro retiré au compte qui l'avait reçu. */
export async function revokeAppStorePro(originalTransactionId: string) {
  const link = await db.doc(`appStorePurchases/${originalTransactionId}`).get();
  const uid = link.get("uid");
  if (typeof uid !== "string") return;
  await link.ref.set({ revokedAt: Date.now() }, { merge: true });
  const user = await db.doc(`users/${uid}`).get();
  const current = user.get("proSources.app_store.ref") ?? user.get("proOriginalTransactionId");
  if (current === originalTransactionId) {
    await setProSource(uid, "app_store", null);
    await user.ref.set({ proRefundedAt: Date.now() }, { merge: true });
  }
}

/**
 * Transaction StoreKit 2 envoyée par l'app (achat, restauration ou mise à jour) : signature Apple
 * vérifiée, produit Pro, puis Pro activé sur ce compte. Une même transaction ne peut pas débloquer
 * deux comptes MoneyMaker.
 */
export async function redeemAppStorePurchase(uid: string, signedTransaction: unknown) {
  const t: JWSTransactionDecodedPayload = await verifyAppTransaction(signedTransaction);
  if (t.productId !== PRO_PRODUCT_ID) throw new HttpError(400, "unknown_product");
  // Démo en lecture seule (App Review) : achat vérifié, Pro affiché, rien n'est enregistré.
  if (uid === DEMO_UID) return { ...(await billingStatus(uid)), pro: !t.revocationDate };
  const original = String(t.originalTransactionId ?? t.transactionId ?? "");
  if (!original) throw new HttpError(400, "invalid_transaction");
  if (t.revocationDate) {
    await revokeAppStorePro(original);
    return billingStatus(uid);
  }
  // Bac à sable (TestFlight, Xcode) : un achat gratuit ne doit pas donner Pro à vie en production.
  // Seuls les comptes de l'équipe le gardent ; les autres le voient sans qu'il soit enregistré.
  if (String(t.environment) === "Sandbox" && !(await config())?.testers.includes(uid)) {
    return { ...(await billingStatus(uid)), pro: true, sandbox: true };
  }
  const token = await appAccountToken(uid);
  if (t.appAccountToken && t.appAccountToken.toLowerCase() !== token.toLowerCase()) {
    throw new HttpError(409, "purchase_other_account", "Cet achat est rattaché à un autre compte MoneyMaker.");
  }
  const link = db.doc(`appStorePurchases/${original}`);
  let isNew = false;
  await db.runTransaction(async tx => {
    const owner = (await tx.get(link)).get("uid");
    isNew = !owner;
    if (owner && owner !== uid) throw new HttpError(409, "purchase_other_account", "Cet achat est rattaché à un autre compte MoneyMaker.");
    // Firestore : toutes les lectures avant les écritures (setProSource lit le compte).
    await setProSource(uid, "app_store", { since: t.purchaseDate ?? Date.now(), ref: original, environment: String(t.environment ?? "") }, tx);
    if (!owner) {
      tx.set(link, { uid, productId: t.productId, environment: String(t.environment ?? ""), purchaseDate: t.purchaseDate ?? Date.now(), createdAt: Date.now() });
    }
  });
  if (isNew) await trackPurchase(uid, "app_store");
  return billingStatus(uid);
}

/** Comptes de l'équipe (system/billing.testers) : ils reçoivent les avis envoyés depuis l'app. */
export async function teamUids(): Promise<string[]> {
  return (await config())?.testers ?? [];
}
