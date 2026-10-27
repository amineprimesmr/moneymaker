// MoneyMaker Pro : licence à vie à 29 €, payée une fois avec Stripe Checkout.
//
//   • Gratuit : un business. Pro : business illimités.
//   • Le compte Stripe de MoneyMaker est lu dans Firestore system/billing
//     { secretKey, webhookSecret, priceId } (jamais renvoyé par l'API).
//   • Le webhook POST /v1/webhooks/billing active Pro sur users/{uid} et le retire en cas de
//     remboursement complet. Le même compte Stripe est connecté au business « MoneyMaker » : les
//     ventes apparaissent donc aussi dans l'app, attribuées à l'utilisateur (metadata app_user_id).

import Stripe from "stripe";
import { HttpError } from "./engine";
import { db } from "./store";

export const FREE_PROJECTS = 1;
export const PRO_PRICE = { amount: 29, currency: "EUR" };

interface BillingConfig { secretKey: string; webhookSecret: string; priceId: string }
let cache: { at: number; cfg: BillingConfig | null } | null = null;

async function config(): Promise<BillingConfig | null> {
  if (cache && Date.now() - cache.at < 60_000) return cache.cfg;
  const d = (await db.doc("system/billing").get()).data();
  const cfg = d?.secretKey && d?.priceId ? { secretKey: d.secretKey, webhookSecret: d.webhookSecret ?? "", priceId: d.priceId } : null;
  cache = { at: Date.now(), cfg };
  return cfg;
}

async function stripe() {
  const cfg = await config();
  if (!cfg) throw new HttpError(503, "billing_unavailable", "Le paiement n'est pas encore configuré.");
  return { cfg, stripe: new Stripe(cfg.secretKey) };
}

export async function isPro(uid: string) {
  return (await db.doc(`users/${uid}`).get()).get("pro") === true;
}

async function ownedProjects(uid: string) {
  return (await db.collection("projects").where("ownerUid", "==", uid).count().get()).data().count;
}

export async function billingStatus(uid: string) {
  const [pro, owned] = await Promise.all([isPro(uid), ownedProjects(uid)]);
  return { pro, ownedProjects: owned, freeProjects: FREE_PROJECTS, price: PRO_PRICE, available: !!(await config()) };
}

/** Bloque la création au-delà du quota gratuit (402 : l'appelant propose l'achat). */
export async function assertCanCreateProject(uid: string) {
  // Tant que le paiement n'est pas configuré, personne n'est bloqué sans pouvoir payer.
  if (!(await config()) || await isPro(uid)) return;
  if (await ownedProjects(uid) >= FREE_PROJECTS) {
    throw new HttpError(402, "pro_required", `Le plan gratuit inclut ${FREE_PROJECTS} business. MoneyMaker Pro (29 €, une fois) les débloque tous.`);
  }
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

export async function createCheckout(uid: string, email: string | undefined, returnUrl: string, externalPurchaseToken?: string) {
  if (await isPro(uid)) throw new HttpError(409, "already_pro");
  const { cfg, stripe: s } = await stripe();
  const sep = returnUrl.includes("?") ? "&" : "?";
  // Jeton StoreKit External Purchase (achat depuis l'app dans l'UE) : gardé pour la déclaration
  // mensuelle à Apple (commission sur les ventes faites hors de l'In-App Purchase).
  const ept = typeof externalPurchaseToken === "string" && externalPurchaseToken.length < 4096 ? externalPurchaseToken : undefined;
  const session = await s.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: cfg.priceId, quantity: 1 }],
    client_reference_id: uid,
    customer_email: email,
    customer_creation: "always",
    invoice_creation: { enabled: true },
    allow_promotion_codes: true,
    metadata: { uid, app_user_id: uid, product_id: "io.moneymaker.pro.lifetime", ...(ept ? { apple_ept: "1" } : {}) },
    payment_intent_data: { metadata: { uid, app_user_id: uid, product_id: "io.moneymaker.pro.lifetime" } },
    success_url: `${returnUrl}${sep}pro=success`,
    cancel_url: `${returnUrl}${sep}pro=cancel`,
  });
  if (ept) await db.doc(`externalPurchases/${session.id}`).set({ uid, token: ept, createdAt: Date.now(), status: "pending" });
  return { url: session.url };
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
    if (uid && cs.payment_status === "paid") {
      await db.doc(`users/${uid}`).set({
        pro: true, proSince: Date.now(), proPaymentIntent: String(cs.payment_intent ?? ""), proCustomer: String(cs.customer ?? ""),
      }, { merge: true });
      if (cs.metadata?.apple_ept) {
        await db.doc(`externalPurchases/${cs.id}`).set({ status: "paid", paidAt: Date.now(), amountTotal: cs.amount_total, currency: cs.currency,
          paymentIntent: String(cs.payment_intent ?? "") }, { merge: true });
      }
    }
  } else if (event.type === "charge.refunded") {
    const ch = event.data.object as Stripe.Charge;
    const uid = ch.metadata?.uid;
    if (uid && ch.refunded) {
      await db.doc(`users/${uid}`).set({ pro: false, proRefundedAt: Date.now() }, { merge: true });
      const ep = await db.collection("externalPurchases").where("paymentIntent", "==", String(ch.payment_intent ?? "")).limit(1).get();
      ep.docs.forEach(d => d.ref.set({ status: "refunded", refundedAt: Date.now() }, { merge: true }));
    }
  }
  return { received: true };
}
