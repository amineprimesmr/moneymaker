import Stripe from "stripe";
import { Purchase, PurchaseStatus, HttpError, readableProductId, minorToMicros } from "./engine";
import { Project, getCredentials, lookupIndex, upsertPurchase, recordEvent, db } from "./store";
import { toAlpha2 } from "./countries";

const SUB_STATUS: Record<string, PurchaseStatus> = {
  active: "active", trialing: "active", past_due: "billing_retry", unpaid: "billing_retry",
  canceled: "expired", incomplete: "expired", incomplete_expired: "expired", paused: "paused",
};

const INTERVAL_MONTHS: Record<string, number> = { day: 1 / 30.4375, week: 7 / 30.4375, month: 1, year: 12 };

async function stripeFor(project: Project) {
  const creds = await getCredentials(project.id);
  if (!creds.stripe?.secretKey) throw new HttpError(400, "stripe_not_configured", "Upload a Stripe restricted/secret key");
  return { stripe: new Stripe(creds.stripe.secretKey), webhookSecret: creds.stripe.webhookSecret };
}

/** Montant mensuel facturé réellement : tous les articles, remises (pourcentage ou montant) déduites. Pure — unit-tested. */
export function subscriptionAmountMinor(s: Stripe.Subscription): number {
  let total = 0;
  for (const it of s.items?.data ?? []) {
    const unit = it.price?.unit_amount ?? (it.price?.unit_amount_decimal ? Number(it.price.unit_amount_decimal) : null);
    if (unit !== null && unit !== undefined) total += unit * (it.quantity ?? 1);
  }
  const discounts = [...((s as any).discounts ?? []), ...((s as any).discount ? [(s as any).discount] : [])]
    .filter(d => d && typeof d === "object");
  for (const d of discounts) {
    const c = d.coupon ?? d.source?.coupon;
    if (!c || typeof c !== "object") continue;
    if (c.duration === "once") continue; // une remise ponctuelle ne change pas le revenu récurrent
    if (typeof c.percent_off === "number") total = total * (1 - c.percent_off / 100);
    else if (typeof c.amount_off === "number") total = Math.max(0, total - c.amount_off);
  }
  return Math.round(total);
}

export function stripeSubscriptionPurchase(s: Stripe.Subscription, now = Date.now()): Purchase {
  const item = s.items.data[0];
  const price = item?.price;
  const periodEnd = (item as any)?.current_period_end ?? (s as any).current_period_end;
  const periodStart = (item as any)?.current_period_start ?? (s as any).current_period_start;
  const status = SUB_STATUS[s.status] ?? "expired";
  const months = price?.recurring ? (INTERVAL_MONTHS[price.recurring.interval] ?? 1) * (price.recurring.interval_count ?? 1) : 1;
  return {
    id: s.id,
    store: "stripe",
    productId: String(s.metadata?.product_id || price?.lookup_key || price?.id || "unknown"),
    type: "subscription",
    status,
    purchasedAt: s.start_date * 1000,
    latestPurchaseAt: (periodStart ?? s.start_date) * 1000,
    expiresAt: status === "expired" ? (s.ended_at ?? periodEnd ?? now / 1000) * 1000 : (periodEnd ? periodEnd * 1000 : null),
    willRenew: !s.cancel_at_period_end && !s.cancel_at && status !== "expired",
    isTrial: s.status === "trialing",
    isSandbox: !s.livemode,
    priceMicros: minorToMicros(subscriptionAmountMinor(s), price?.currency ?? "eur"),
    currency: (price?.currency ?? "eur").toUpperCase(),
    periodMonths: months,
    billingIssue: status === "billing_retry",
    updatedAt: now,
    country: toAlpha2((s.customer as any)?.address?.country ?? s.metadata?.country),
    affiliate: isAffiliateSale(s.metadata),
    productName: typeof price?.product === "object" && price.product && !("deleted" in price.product && price.product.deleted) ? (price.product as Stripe.Product).name : (price?.nickname ?? null),
  };
}

/** Développements utiles à la lecture d'un abonnement : remises (MRR exact) et produit (nom lisible). */
export const SUB_EXPAND = ["discounts", "items.data.price.product"];

/** Metadata keys apps commonly use to store their own user id on Stripe objects. */
/** Métadonnées qui signalent une vente apportée par un affilié (Process : sk_ref ; Rewardful, Tolt, FirstPromoter…). */
export const AFFILIATE_METADATA_KEYS = ["sk_ref", "ref", "referral", "referral_code", "affiliate", "affiliate_id", "affiliate_code", "rewardful_referral", "tolt_referral", "fp_ref", "promotekit_referral"];
export const isAffiliateSale = (...sources: (Stripe.Metadata | null | undefined)[]) =>
  sources.some(m => AFFILIATE_METADATA_KEYS.some(k => !!m?.[k]));

/** Une charge ne reprend pas les métadonnées de son PaymentIntent (là où Checkout les range) : on les relit. */
export async function chargeIsAffiliate(stripe: Stripe | undefined, ch: Stripe.Charge) {
  if (isAffiliateSale(ch.metadata)) return true;
  const pi = typeof ch.payment_intent === "string" ? ch.payment_intent : ch.payment_intent?.id;
  if (!stripe || !pi) return false;
  const intent = await stripe.paymentIntents.retrieve(pi).catch(() => null);
  return isAffiliateSale(intent?.metadata);
}

export const USER_ID_METADATA_KEYS = ["app_user_id", "appUserId", "firebaseUID", "firebase_uid", "firebaseUid", "user_id", "userId", "uid", "supabase_user_id", "clerk_user_id"];

export function appUserIdFrom(...sources: (Stripe.Metadata | null | undefined)[]) {
  for (const m of sources) for (const k of USER_ID_METADATA_KEYS) if (m?.[k]) return String(m[k]);
  return null;
}

/** Name of what was bought in a Checkout / Payment Link payment (first line item), when Stripe knows it. */
export async function checkoutProductName(stripe: Stripe | undefined, paymentIntent: unknown): Promise<string | null> {
  const pi = typeof paymentIntent === "string" ? paymentIntent : (paymentIntent as any)?.id;
  if (!stripe || !pi) return null;
  const s = (await stripe.checkout.sessions.list({ payment_intent: pi, limit: 1, expand: ["data.line_items"] }).catch(() => null))?.data[0];
  return readableProductId(s?.line_items?.data[0]?.description);
}

/** One-time Stripe payment (Checkout "payment" mode, Payment Links, plain charges). Pure — unit-tested. */
export function stripeOneTimePurchase(ch: Stripe.Charge, now = Date.now(), productName?: string | null): Purchase {
  const net = ch.amount_captured - (ch.amount_refunded ?? 0);
  return {
    id: String(ch.payment_intent ?? ch.id), store: "stripe",
    productId: String(ch.metadata?.product_id ?? productName ?? ch.description ?? "stripe_payment").slice(0, 200), type: "non_consumable",
    status: ch.refunded ? "refunded" : "active", purchasedAt: ch.created * 1000, latestPurchaseAt: ch.created * 1000,
    expiresAt: null, willRenew: false, isTrial: false, isSandbox: !ch.livemode, priceMicros: minorToMicros(Math.max(0, net), ch.currency),
    currency: ch.currency.toUpperCase(), periodMonths: 0, billingIssue: false, updatedAt: now,
    country: toAlpha2(ch.billing_details?.address?.country ?? (ch.payment_method_details as any)?.card?.country),
    affiliate: isAffiliateSale(ch.metadata, typeof ch.payment_intent === "object" ? (ch.payment_intent as any)?.metadata : null),
  };
}

/** Abonnement d'une facture Stripe (l'emplacement du champ change selon la version d'API). */
export const invoiceSubscription = (inv: any): string | null => {
  const s = inv?.subscription ?? inv?.parent?.subscription_details?.subscription ?? null;
  return s ? String(typeof s === "string" ? s : s.id) : null;
};

/** True when a charge pays a subscription invoice: those are recorded through the subscription.
 *  A one-time Checkout with « invoice_creation » also has an invoice, but no subscription: it stays a sale.
 *  (Newer API versions dropped `charge.invoice`, hence the invoice-payments lookup.) */
export async function isSubscriptionCharge(stripe: Stripe | undefined, ch: Stripe.Charge) {
  const bySubscriptionText = /^Subscription (creation|update|cycle)/i.test(ch.description ?? "");
  let invoice: unknown = (ch as any).invoice ?? null;
  if (!invoice && stripe && ch.payment_intent) {
    const pi = typeof ch.payment_intent === "string" ? ch.payment_intent : ch.payment_intent.id;
    const list = await stripe.invoicePayments.list({ payment: { type: "payment_intent", payment_intent: pi }, limit: 1 }).catch(() => null);
    if (!list) return bySubscriptionText;
    invoice = list.data[0]?.invoice ?? null;
  }
  if (!invoice) return bySubscriptionText;
  if (typeof invoice === "object") return Boolean(invoiceSubscription(invoice));
  if (!stripe) return bySubscriptionText;
  const inv = await stripe.invoices.retrieve(String(invoice)).catch(() => null);
  return inv ? Boolean(invoiceSubscription(inv)) : bySubscriptionText;
}

/** Customer id for a one-time payment: app id in metadata, else known Stripe customer, else the buyer's email. */
export async function oneTimeOwner(project: Project, ch: Stripe.Charge) {
  const pi = typeof ch.payment_intent === "object" ? (ch.payment_intent as any) : null;
  return appUserIdFrom(ch.metadata, pi?.metadata)
    ?? (ch.customer ? await lookupIndex(project.id, `stripe_cus:${ch.customer}`) : null)
    ?? (ch.customer ? `$stripe:${ch.customer}` : ch.billing_details?.email ? `$email:${ch.billing_details.email.toLowerCase()}` : `$stripe:${ch.id}`);
}

export async function storeSubscription(project: Project, sub: Stripe.Subscription, stripe?: Stripe, opts: { silent?: boolean; appUserId?: string } = {}) {
  let appUserId = opts.appUserId ?? appUserIdFrom(sub.metadata) ?? await lookupIndex(project.id, `stripe:${sub.id}`, `stripe_cus:${sub.customer}`);
  let country: string | null = null;
  if (stripe && typeof sub.customer === "string") {
    const c = await stripe.customers.retrieve(sub.customer).catch(() => null);
    if (c && !("deleted" in c && c.deleted)) {
      const customer = c as Stripe.Customer;
      appUserId ??= appUserIdFrom(customer.metadata);
      country = toAlpha2(customer.address?.country ?? customer.shipping?.address?.country);
    }
  }
  appUserId ??= `$stripe:${sub.customer}`;
  const purchase = stripeSubscriptionPurchase(sub);
  if (country) purchase.country = country;
  return upsertPurchase(project, appUserId, purchase, [`stripe:${sub.id}`, `stripe_cus:${sub.customer}`], opts);
}

export async function ingestStripeWebhook(project: Project, rawBody: Buffer, signature: string | undefined) {
  const creds = await getCredentials(project.id);
  if (!creds.stripe?.webhookSecret) throw new HttpError(400, "stripe_webhook_secret_missing");
  let event: Stripe.Event;
  try {
    event = Stripe.webhooks.constructEvent(rawBody, signature ?? "", creds.stripe.webhookSecret);
  } catch (e) {
    throw new HttpError(400, "invalid_stripe_signature", (e as Error).message);
  }
  const seen = db.doc(`projects/${project.id}/stripeEvents/${event.id}`);
  if ((await seen.get()).exists) return { duplicate: true };
  const stripe = creds.stripe.secretKey ? new Stripe(creds.stripe.secretKey) : undefined;
  let result: unknown = { ignored: event.type };

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed": {
      // Always re-read the live object so out-of-order events can't regress state.
      const sub = stripe ? await stripe.subscriptions.retrieve((event.data.object as Stripe.Subscription).id, { expand: SUB_EXPAND }) : event.data.object as Stripe.Subscription;
      result = await storeSubscription(project, sub, stripe);
      break;
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      const inv = event.data.object as any;
      const subId = invoiceSubscription(inv);
      if (stripe && subId) result = await storeSubscription(project, await stripe.subscriptions.retrieve(String(subId), { expand: SUB_EXPAND }), stripe);
      break;
    }
    case "checkout.session.completed": {
      const s = event.data.object as Stripe.Checkout.Session;
      const appUserId = s.client_reference_id ?? appUserIdFrom(s.metadata);
      if (s.mode === "payment" && !appUserId && s.payment_status === "paid") {
        // Web checkout without an app account: charge.succeeded records it (keyed by email / Stripe customer).
        result = { recordedBy: "charge.succeeded" };
      } else if (s.mode === "payment" && appUserId && s.payment_status === "paid") {
        const productId = String(s.metadata?.product_id ?? (await checkoutProductName(stripe, s.payment_intent)) ?? "stripe_one_time");
        result = await upsertPurchase(project, appUserId, {
          id: String(s.payment_intent ?? s.id), store: "stripe", productId, type: "non_consumable", status: "active",
          purchasedAt: s.created * 1000, latestPurchaseAt: s.created * 1000, expiresAt: null, willRenew: false,
          isTrial: false, isSandbox: !s.livemode, priceMicros: minorToMicros(s.amount_total ?? 0, s.currency ?? "eur"),
          currency: (s.currency ?? "eur").toUpperCase(), periodMonths: 0, billingIssue: false, updatedAt: Date.now(),
          country: toAlpha2(s.customer_details?.address?.country), affiliate: isAffiliateSale(s.metadata),
        }, [`stripe:${s.payment_intent ?? s.id}`, ...(s.customer ? [`stripe_cus:${s.customer}`] : [])]);
      } else if (s.subscription && stripe) {
        const sub = await stripe.subscriptions.retrieve(String(s.subscription), { expand: SUB_EXPAND });
        if (appUserId && !sub.metadata?.app_user_id) await stripe.subscriptions.update(sub.id, { metadata: { ...sub.metadata, app_user_id: appUserId } });
        result = await storeSubscription(project, { ...sub, metadata: { ...sub.metadata, ...(appUserId ? { app_user_id: appUserId } : {}) } }, stripe);
      }
      break;
    }
    case "charge.succeeded": {
      const ch = event.data.object as Stripe.Charge;
      if (!ch.paid || await isSubscriptionCharge(stripe, ch)) break; // subscription invoices are handled through the subscription
      const owner = await oneTimeOwner(project, ch);
      const name = ch.metadata?.product_id ? null : await checkoutProductName(stripe, ch.payment_intent);
      result = await upsertPurchase(project, owner, { ...stripeOneTimePurchase(ch, Date.now(), name), affiliate: await chargeIsAffiliate(stripe, ch) }, [`stripe:${ch.payment_intent ?? ch.id}`, ...(ch.customer ? [`stripe_cus:${ch.customer}`] : [])]);
      break;
    }
    case "charge.refunded": {
      const ch = event.data.object as Stripe.Charge;
      const key = String(ch.payment_intent ?? "");
      const owner = key ? await lookupIndex(project.id, `stripe:${key}`) : null;
      const ref = owner ? db.doc(`projects/${project.id}/customers/${owner}/purchases/${key}`) : null;
      const prev = ref ? (await ref.get()).data() as Purchase | undefined : undefined;
      if (prev && ch.refunded && prev.type !== "subscription") {
        // Achat unique remboursé en entier : l'achat passe en « remboursé » (événement REFUND + transaction négative).
        result = await upsertPurchase(project, owner!, { ...prev, status: "refunded", updatedAt: Date.now() });
        break;
      }
      // Remboursement partiel, ou facture d'abonnement remboursée : l'abonnement garde son état,
      // mais le remboursement est notifié et retiré du revenu.
      const before = Number((event.data as any).previous_attributes?.amount_refunded ?? 0);
      const delta = Math.max(0, (ch.amount_refunded ?? 0) - before);
      if (!delta) break;
      const subId = invoiceSubscription((ch as any).invoice && typeof (ch as any).invoice === "object" ? (ch as any).invoice : null)
        ?? (typeof (ch as any).invoice === "string" && stripe ? invoiceSubscription(await stripe.invoices.retrieve((ch as any).invoice).catch(() => null)) : null);
      const who = owner ?? (subId ? await lookupIndex(project.id, `stripe:${subId}`) : null)
        ?? (ch.customer ? await lookupIndex(project.id, `stripe_cus:${ch.customer}`) : null) ?? `$stripe:${ch.customer ?? ch.id}`;
      const sub = subId ? (await db.doc(`projects/${project.id}/customers/${who}/purchases/${subId}`).get()).data() as Purchase | undefined : undefined;
      const base = sub ?? prev ?? { id: subId ?? key ?? ch.id, productId: String(ch.metadata?.product_id ?? ch.description ?? "stripe_payment"), store: "stripe" as const };
      result = await recordEvent(project, who, { ...base, currency: ch.currency.toUpperCase(), isSandbox: !ch.livemode }, "REFUND", {
        refundMicros: minorToMicros(delta, ch.currency), key: `stripe:${ch.id}:${ch.amount_refunded}`,
      }) as any;
      break;
    }
    case "charge.dispute.created": {
      // Litige (rétrofacturation) : l'équivalent d'une demande de remboursement.
      const dp = event.data.object as Stripe.Dispute;
      const chId = typeof dp.charge === "string" ? dp.charge : dp.charge?.id;
      const ch = stripe && chId ? await stripe.charges.retrieve(chId).catch(() => null) : null;
      const key = String(ch?.payment_intent ?? "");
      const who = (key ? await lookupIndex(project.id, `stripe:${key}`) : null)
        ?? (ch?.customer ? await lookupIndex(project.id, `stripe_cus:${ch.customer}`) : null) ?? `$stripe:${ch?.customer ?? chId}`;
      result = await recordEvent(project, who, {
        id: key || chId || dp.id, productId: String(ch?.metadata?.product_id ?? ch?.description ?? "stripe_payment"), store: "stripe",
        currency: dp.currency.toUpperCase(), priceMicros: minorToMicros(dp.amount, dp.currency), isSandbox: !dp.livemode,
      }, "REFUND_REQUESTED", { reason: `dispute:${dp.reason}`, key: `stripe:dispute:${dp.id}` }) as any;
      break;
    }
  }
  await seen.set({ type: event.type, at: Date.now() });
  return result;
}

/** Hosted Checkout for web / external purchase links. */
/** RevenueCat-style `POST /receipts` for Stripe: fetch_token = subscription id (sub_…) or Checkout Session id (cs_…). */
export async function ingestStripeFetchToken(project: Project, appUserId: string, token: string) {
  const { stripe } = await stripeFor(project);
  let subId = token;
  if (token.startsWith("cs_")) {
    const cs = await stripe.checkout.sessions.retrieve(token);
    subId = typeof cs.subscription === "string" ? cs.subscription : cs.subscription?.id ?? "";
  }
  if (!subId.startsWith("sub_")) throw new HttpError(400, "invalid_fetch_token", "Stripe fetch_token must be sub_… or cs_…");
  const sub = await stripe.subscriptions.retrieve(subId, { expand: SUB_EXPAND });
  await storeSubscription(project, sub, stripe, { appUserId });
}

export async function createCheckout(project: Project, appUserId: string, body: any) {
  const { stripe } = await stripeFor(project);
  const priceId = String(body?.priceId ?? "");
  if (!priceId) throw new HttpError(400, "price_required");
  const price = await stripe.prices.retrieve(priceId);
  const url = (u: unknown) => {
    if (typeof u !== "string" || !/^https:\/\/|^[a-z][a-z0-9+.-]*:\/\//i.test(u)) throw new HttpError(400, "invalid_redirect_url");
    return u;
  };
  if (!price.active) throw new HttpError(400, "price_inactive");
  // Le produit débloqué est déduit du prix côté serveur : un client (clé publique) ne doit pas pouvoir
  // payer le prix le moins cher en déclarant un produit plus cher.
  const allowed = [price.lookup_key, price.id].filter(Boolean) as string[];
  const productId = typeof body?.productId === "string" && allowed.includes(body.productId) ? body.productId : (price.lookup_key ?? price.id);
  const meta = { app_user_id: appUserId, product_id: productId };
  const session = await stripe.checkout.sessions.create({
    mode: price.recurring ? "subscription" : "payment",
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: appUserId,
    success_url: url(body?.successUrl), cancel_url: url(body?.cancelUrl),
    metadata: meta,
    ...(price.recurring ? { subscription_data: { metadata: meta } } : { payment_intent_data: { metadata: meta } }),
    ...(typeof body?.email === "string" && body.email ? { customer_email: body.email } : {}),
    ...(await promoDiscount(stripe, body?.promoCode)),
  });
  return { url: session.url, id: session.id };
}

/** Explicit promotion code → `discounts`; otherwise let the buyer type one (`allow_promotion_codes`). */
async function promoDiscount(stripe: Stripe, code: unknown): Promise<Partial<Stripe.Checkout.SessionCreateParams>> {
  if (typeof code !== "string" || !code.trim()) return { allow_promotion_codes: true };
  const found = (await stripe.promotionCodes.list({ code: code.trim(), active: true, limit: 1 })).data[0];
  if (!found) throw new HttpError(400, "invalid_promotion_code", "Code promo inconnu ou expiré");
  return { discounts: [{ promotion_code: found.id }] };
}

/** Identifiants devinables (e-mail, client Stripe…) : jamais de portail ouvert avec une simple clé publique. */
export const guessableCustomerId = (id: string) => id.startsWith("$") && !/^\$(anon:|RCAnonymousID:)/.test(id) || /@/.test(id);

export async function createPortal(project: Project, appUserId: string, returnUrl: string) {
  if (returnUrl && !/^https:\/\/|^[a-z][a-z0-9+.-]*:\/\//i.test(returnUrl)) throw new HttpError(400, "invalid_return_url");
  const { stripe } = await stripeFor(project);
  const customerId = (await db.collection(`projects/${project.id}/customers/${appUserId}/purchases`).where("store", "==", "stripe").limit(1).get())
    .docs[0]?.id;
  if (!customerId) throw new HttpError(404, "no_stripe_customer");
  const sub = customerId.startsWith("sub_") ? await stripe.subscriptions.retrieve(customerId, { expand: SUB_EXPAND }) : null;
  if (!sub) throw new HttpError(404, "no_stripe_subscription");
  const portal = await stripe.billingPortal.sessions.create({ customer: String(sub.customer), return_url: returnUrl });
  return { url: portal.url };
}
