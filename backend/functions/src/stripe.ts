import Stripe from "stripe";
import { Purchase, PurchaseStatus, HttpError } from "./engine";
import { Project, getCredentials, lookupIndex, upsertPurchase, db } from "./store";
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
    priceMicros: (price?.unit_amount ?? 0) * 10000 * (item?.quantity ?? 1),
    currency: (price?.currency ?? "eur").toUpperCase(),
    periodMonths: months,
    billingIssue: status === "billing_retry",
    updatedAt: now,
    country: toAlpha2((s.customer as any)?.address?.country ?? s.metadata?.country),
  };
}

/** Metadata keys apps commonly use to store their own user id on Stripe objects. */
export const USER_ID_METADATA_KEYS = ["app_user_id", "appUserId", "firebaseUID", "firebase_uid", "firebaseUid", "user_id", "userId", "uid", "supabase_user_id", "clerk_user_id"];

export function appUserIdFrom(...sources: (Stripe.Metadata | null | undefined)[]) {
  for (const m of sources) for (const k of USER_ID_METADATA_KEYS) if (m?.[k]) return String(m[k]);
  return null;
}

export async function storeSubscription(project: Project, sub: Stripe.Subscription, stripe?: Stripe, opts: { silent?: boolean } = {}) {
  let appUserId = appUserIdFrom(sub.metadata) ?? await lookupIndex(project.id, `stripe:${sub.id}`, `stripe_cus:${sub.customer}`);
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
      const sub = stripe ? await stripe.subscriptions.retrieve((event.data.object as Stripe.Subscription).id) : event.data.object as Stripe.Subscription;
      result = await storeSubscription(project, sub, stripe);
      break;
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      const inv = event.data.object as any;
      const subId = inv.subscription ?? inv.parent?.subscription_details?.subscription;
      if (stripe && subId) result = await storeSubscription(project, await stripe.subscriptions.retrieve(String(subId)), stripe);
      break;
    }
    case "checkout.session.completed": {
      const s = event.data.object as Stripe.Checkout.Session;
      const appUserId = s.client_reference_id ?? appUserIdFrom(s.metadata);
      if (s.mode === "payment" && appUserId && s.payment_status === "paid") {
        const productId = String(s.metadata?.product_id ?? "stripe_one_time");
        result = await upsertPurchase(project, appUserId, {
          id: String(s.payment_intent ?? s.id), store: "stripe", productId, type: "non_consumable", status: "active",
          purchasedAt: s.created * 1000, latestPurchaseAt: s.created * 1000, expiresAt: null, willRenew: false,
          isTrial: false, isSandbox: !s.livemode, priceMicros: (s.amount_total ?? 0) * 10000,
          currency: (s.currency ?? "eur").toUpperCase(), periodMonths: 0, billingIssue: false, updatedAt: Date.now(),
          country: toAlpha2(s.customer_details?.address?.country),
        }, [`stripe:${s.payment_intent ?? s.id}`, ...(s.customer ? [`stripe_cus:${s.customer}`] : [])]);
      } else if (s.subscription && stripe) {
        const sub = await stripe.subscriptions.retrieve(String(s.subscription));
        if (appUserId && !sub.metadata?.app_user_id) await stripe.subscriptions.update(sub.id, { metadata: { ...sub.metadata, app_user_id: appUserId } });
        result = await storeSubscription(project, { ...sub, metadata: { ...sub.metadata, ...(appUserId ? { app_user_id: appUserId } : {}) } }, stripe);
      }
      break;
    }
    case "charge.refunded": {
      const ch = event.data.object as Stripe.Charge;
      const key = String(ch.payment_intent ?? "");
      const owner = key ? await lookupIndex(project.id, `stripe:${key}`) : null;
      if (owner && ch.refunded) {
        const ref = db.doc(`projects/${project.id}/customers/${owner}/purchases/${key}`);
        const prev = (await ref.get()).data() as Purchase | undefined;
        if (prev) result = await upsertPurchase(project, owner, { ...prev, status: "refunded", updatedAt: Date.now() });
      }
      break;
    }
  }
  await seen.set({ type: event.type, at: Date.now() });
  return result;
}

/** Hosted Checkout for web / external purchase links. */
export async function createCheckout(project: Project, appUserId: string, body: any) {
  const { stripe } = await stripeFor(project);
  const priceId = String(body?.priceId ?? "");
  if (!priceId) throw new HttpError(400, "price_required");
  const price = await stripe.prices.retrieve(priceId);
  const url = (u: unknown) => {
    if (typeof u !== "string" || !/^https:\/\/|^[a-z][a-z0-9+.-]*:\/\//i.test(u)) throw new HttpError(400, "invalid_redirect_url");
    return u;
  };
  const meta = { app_user_id: appUserId, product_id: String(body?.productId ?? price.lookup_key ?? price.id) };
  const session = await stripe.checkout.sessions.create({
    mode: price.recurring ? "subscription" : "payment",
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: appUserId,
    success_url: url(body?.successUrl), cancel_url: url(body?.cancelUrl),
    metadata: meta,
    ...(price.recurring ? { subscription_data: { metadata: meta } } : { payment_intent_data: { metadata: meta } }),
    allow_promotion_codes: true,
  });
  return { url: session.url, id: session.id };
}

export async function createPortal(project: Project, appUserId: string, returnUrl: string) {
  const { stripe } = await stripeFor(project);
  const customerId = (await db.collection(`projects/${project.id}/customers/${appUserId}/purchases`).where("store", "==", "stripe").limit(1).get())
    .docs[0]?.id;
  if (!customerId) throw new HttpError(404, "no_stripe_customer");
  const sub = customerId.startsWith("sub_") ? await stripe.subscriptions.retrieve(customerId) : null;
  if (!sub) throw new HttpError(404, "no_stripe_subscription");
  const portal = await stripe.billingPortal.sessions.create({ customer: String(sub.customer), return_url: returnUrl });
  return { url: portal.url };
}
