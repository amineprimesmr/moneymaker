// Filet de sécurité de la synchro en direct.
//
// Les ventes arrivent en temps réel par les webhooks (Stripe, App Store Server Notifications). Si un envoi se perd
// (serveur indisponible, bug, secret changé), la vente manquerait pour toujours. Toutes les 15 minutes, ce job relit
// la source elle-même sur les 3 derniers jours et rejoue, par le même code que les webhooks, uniquement ce qui manque :
// - Stripe : chaque paiement réussi sans transaction en base (vente unique ou facture d'abonnement), chaque remboursement
//   pas encore marqué ;
// - Apple : les notifications que notre serveur n'a jamais acceptées (historique App Store Server API, onlyFailures).
// Une vente déjà enregistrée n'est jamais réécrite : pas de doublon, pas de notification en double.

import Stripe from "stripe";
import { AppStoreServerAPIClient, Environment } from "@apple/app-store-server-library";
import { Purchase, convertMicros, minorToMicros } from "./engine";
import { Project, db, getCredentials, lookupIndex, upsertPurchase } from "./store";
import { checkoutProductName, invoiceSubscription, oneTimeOwner, storeSubscription, stripeOneTimePurchase, stripeSubscriptionPurchase, SUB_EXPAND } from "./stripe";
import { ingestAppleNotification } from "./apple";

const DAY = 86400000;
export const RESYNC_WINDOW_MS = 3 * DAY;

async function hasTransaction(pid: string, purchaseId: string, near?: number) {
  const snap = await db.collection(`projects/${pid}/transactions`).where("purchaseId", "==", purchaseId).select("at", "kind").get();
  return snap.docs.some(d => d.get("kind") !== "refund" && (near === undefined || Math.abs(Number(d.get("at")) - near) < 2 * DAY));
}

/** Facture réglée par un paiement (champ `invoice` des anciennes versions d'API, sinon invoice payments). */
async function chargeInvoice(stripe: Stripe, ch: Stripe.Charge): Promise<Stripe.Invoice | null> {
  let id: unknown = (ch as any).invoice ?? null;
  if (!id && ch.payment_intent) {
    const pi = typeof ch.payment_intent === "string" ? ch.payment_intent : ch.payment_intent.id;
    id = (await stripe.invoicePayments.list({ payment: { type: "payment_intent", payment_intent: pi }, limit: 1 })).data[0]?.invoice ?? null;
  }
  if (!id) return null;
  return typeof id === "object" ? id as Stripe.Invoice : stripe.invoices.retrieve(String(id));
}

export async function resyncStripe(project: Project, stripe: Stripe, now = Date.now()) {
  const gte = Math.floor((now - RESYNC_WINDOW_MS) / 1000);
  const fixed: string[] = [];
  for await (const ch of stripe.charges.list({ created: { gte }, limit: 100 })) {
    if (!ch.paid || ch.status !== "succeeded") continue;
    const oneTimeId = String(ch.payment_intent ?? ch.id);
    if (await hasTransaction(project.id, oneTimeId)) continue;
    const inv = await chargeInvoice(stripe, ch);
    const subId = invoiceSubscription(inv);
    if (subId) {
      const periodStart = Number((inv as any)?.lines?.data?.[0]?.period?.start ?? ch.created) * 1000;
      if (await hasTransaction(project.id, subId, periodStart)) continue;
      const sub = await stripe.subscriptions.retrieve(subId, { expand: SUB_EXPAND });
      await storeSubscription(project, sub, stripe);
      if (await hasTransaction(project.id, subId, periodStart)) { fixed.push(`sub ${subId}`); continue; }
      // Période plus ancienne que l'état actuel de l'abonnement : la recette est inscrite telle quelle.
      const owner = await lookupIndex(project.id, `stripe:${subId}`, `stripe_cus:${ch.customer}`) ?? `$stripe:${ch.customer}`;
      const p = { ...stripeSubscriptionPurchase(sub), latestPurchaseAt: periodStart, priceMicros: minorToMicros(inv!.amount_paid ?? 0, inv!.currency),
        currency: (inv!.currency ?? sub.currency).toUpperCase() };
      await recordLateTransaction(project, owner, p, inv!.billing_reason === "subscription_cycle" ? "renewal" : "purchase", `stripe_inv_${inv!.id}`);
      fixed.push(`invoice ${inv!.id}`);
      continue;
    }
    // Vente unique (Checkout « payment », Payment Link, facture sans abonnement) : même chemin que charge.succeeded.
    const owner = await oneTimeOwner(project, ch);
    const name = ch.metadata?.product_id ? null : await checkoutProductName(stripe, ch.payment_intent);
    await upsertPurchase(project, owner, stripeOneTimePurchase(ch, Date.now(), name), [`stripe:${oneTimeId}`, ...(ch.customer ? [`stripe_cus:${ch.customer}`] : [])]);
    fixed.push(`charge ${ch.id}`);
  }
  // Remboursements complets pas encore reflétés (même règle que charge.refunded).
  for await (const r of stripe.refunds.list({ created: { gte }, limit: 100 })) {
    if (r.status !== "succeeded" || !r.payment_intent) continue;
    const key = String(typeof r.payment_intent === "string" ? r.payment_intent : r.payment_intent.id);
    const owner = await lookupIndex(project.id, `stripe:${key}`);
    if (!owner) continue;
    const ref = db.doc(`projects/${project.id}/customers/${owner}/purchases/${key}`);
    const prev = (await ref.get()).data() as Purchase | undefined;
    if (!prev || prev.status === "refunded") continue;
    const ch = await stripe.charges.retrieve(String(r.charge));
    if (!ch.refunded) continue;
    await upsertPurchase(project, owner, { ...prev, status: "refunded", updatedAt: Date.now() });
    fixed.push(`refund ${r.id}`);
  }
  return fixed;
}

/** Transaction d'une période d'abonnement passée, écrite à l'identique d'un import d'historique. */
async function recordLateTransaction(project: Project, owner: string, p: Purchase, kind: "purchase" | "renewal", id: string) {
  await db.doc(`projects/${project.id}/transactions/${id}`).set({
    appUserId: owner, store: "stripe", productId: p.productId, purchaseId: p.id, kind,
    amountMicros: p.priceMicros, currency: p.currency, amountMicrosProject: convertMicros(p.priceMicros, p.currency, project.config.currency),
    isSandbox: p.isSandbox, country: p.country ?? null, periodMonths: p.periodMonths, at: p.latestPurchaseAt, resynced: true,
  }, { merge: true });
}

export async function resyncApple(project: Project, creds: { issuerId: string; keyId: string; privateKey: string }, now = Date.now()) {
  const bundleId = project.config.apple?.bundleId;
  if (!bundleId) return [];
  const fixed: string[] = [];
  for (const env of [Environment.PRODUCTION, Environment.SANDBOX]) {
    const client = new AppStoreServerAPIClient(creds.privateKey, creds.keyId, creds.issuerId, bundleId, env);
    let token: string | null = null;
    do {
      const page = await client.getNotificationHistory(token, { startDate: now - RESYNC_WINDOW_MS, endDate: now, onlyFailures: true });
      for (const h of page.notificationHistory ?? []) {
        if (!h.signedPayload) continue;
        await ingestAppleNotification(project, h.signedPayload);
        fixed.push(`apple ${env}`);
      }
      token = page.hasMore ? page.paginationToken ?? null : null;
    } while (token);
  }
  return fixed;
}

/** Un projet : Stripe et Apple si leurs clés sont là. L'état est écrit dans health.resync (lu par le dashboard). */
export async function resyncProject(project: Project, now = Date.now()) {
  const creds = await getCredentials(project.id).catch(() => null);
  const fixed: string[] = [], errors: string[] = [];
  if (creds?.stripe?.secretKey) {
    try { fixed.push(...await resyncStripe(project, new Stripe(creds.stripe.secretKey), now)); }
    catch (e) { errors.push(`stripe: ${(e as Error).message.slice(0, 160)}`); }
  }
  if (creds?.apple?.privateKey && creds.apple.keyId && creds.apple.issuerId) {
    try { fixed.push(...await resyncApple(project, creds.apple, now)); }
    catch (e) { errors.push(`apple: ${(e as Error).message.slice(0, 160)}`); }
  }
  if (creds?.stripe?.secretKey || creds?.apple?.privateKey) {
    await db.doc(`projects/${project.id}`).set({ health: { resync: { lastAt: Date.now(), fixed: fixed.length, errors, ...(fixed.length ? { lastFixedAt: Date.now() } : {}) } } }, { merge: true });
  }
  return { fixed, errors };
}
