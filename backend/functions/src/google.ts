import { JWT } from "google-auth-library";
import { Purchase, PurchaseStatus, HttpError, isoPeriodToMonths } from "./engine";
import { toAlpha2 } from "./countries";
import { Project, getCredentials, lookupIndex, upsertPurchase, sha256, db, mergeCustomers } from "./store";

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

async function client(project: Project) {
  const pkg = project.config.google?.packageName;
  if (!pkg) throw new HttpError(400, "google_not_configured", "Set config.google.packageName first");
  const creds = await getCredentials(project.id);
  const sa = creds.google?.serviceAccount;
  if (!sa) throw new HttpError(400, "google_credentials_missing", "Upload a Play service account JSON");
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: ["https://www.googleapis.com/auth/androidpublisher"] });
  const call = async (path: string, method = "GET", body?: unknown) => {
    const { token } = await jwt.getAccessToken();
    const res = await fetch(`${API}/${encodeURIComponent(pkg)}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status === 404 || res.status === 410 ? 400 : 502, "google_api_error", text.slice(0, 500));
    return text ? JSON.parse(text) : {};
  };
  return { pkg, call };
}

const STATE: Record<string, PurchaseStatus> = {
  SUBSCRIPTION_STATE_ACTIVE: "active",
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: "grace",
  SUBSCRIPTION_STATE_ON_HOLD: "billing_retry",
  SUBSCRIPTION_STATE_PAUSED: "paused",
  SUBSCRIPTION_STATE_CANCELED: "active",     // canceled = won't renew but still entitled until expiry
  SUBSCRIPTION_STATE_EXPIRED: "expired",
  SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: "expired",
};

export interface GoogleHints { priceMicros?: number; currency?: string; period?: string; }

export function googleSubscriptionPurchase(token: string, sub: any, hints: GoogleHints = {}, now = Date.now()): Purchase {
  const line = (sub.lineItems ?? []).slice().sort((a: any, b: any) => Date.parse(b.expiryTime ?? 0) - Date.parse(a.expiryTime ?? 0))[0] ?? {};
  const expiresAt = line.expiryTime ? Date.parse(line.expiryTime) : null;
  let status = STATE[sub.subscriptionState] ?? "expired";
  if (status === "active" && expiresAt !== null && expiresAt <= now) status = "expired";
  const isTrial = Boolean(line.offerDetails?.offerTags?.some((t: string) => /trial/i.test(t))) ||
    (line.offerPhase?.freeTrial !== undefined);
  return {
    id: `gp_${sha256(token).slice(0, 40)}`,
    store: "play_store",
    productId: String(line.productId ?? "unknown"),
    type: "subscription",
    status,
    purchasedAt: sub.startTime ? Date.parse(sub.startTime) : now,
    latestPurchaseAt: expiresAt && hints.period ? expiresAt - isoPeriodToMonths(hints.period) * 30.4375 * 86400000 : (sub.startTime ? Date.parse(sub.startTime) : now),
    expiresAt,
    willRenew: Boolean(line.autoRenewingPlan?.autoRenewEnabled) && sub.subscriptionState !== "SUBSCRIPTION_STATE_CANCELED",
    isTrial,
    isSandbox: Boolean(sub.testPurchase),
    priceMicros: Number(line.autoRenewingPlan?.recurringPrice?.units ?? 0) * 1e6 + Math.round(Number(line.autoRenewingPlan?.recurringPrice?.nanos ?? 0) / 1000) || (hints.priceMicros ?? 0),
    currency: line.autoRenewingPlan?.recurringPrice?.currencyCode ?? hints.currency ?? "USD",
    periodMonths: isoPeriodToMonths(hints.period) || 1,
    billingIssue: status === "grace" || status === "billing_retry",
    updatedAt: now,
    country: toAlpha2(sub.regionCode),
  };
}

export function googleProductPurchase(token: string, productId: string, p: any, hints: GoogleHints = {}, consumable = false): Purchase {
  const purchasedAt = Number(p.purchaseTimeMillis ?? Date.now());
  return {
    id: `gp_${sha256(token).slice(0, 40)}`,
    store: "play_store", productId, type: consumable ? "consumable" : "non_consumable",
    status: p.purchaseState === 1 ? "refunded" : "active",
    purchasedAt, latestPurchaseAt: purchasedAt, expiresAt: null, willRenew: false, isTrial: false,
    isSandbox: p.purchaseType === 0, priceMicros: hints.priceMicros ?? 0, currency: hints.currency ?? "USD",
    periodMonths: 0, billingIssue: false, updatedAt: Date.now(), country: toAlpha2(p.regionCode),
  };
}

async function remember(project: Project, token: string, data: Record<string, unknown>) {
  await db.doc(`projects/${project.id}/googleTokens/${sha256(token)}`).set({ token, ...data, updatedAt: Date.now() }, { merge: true });
}

async function fetchAndStore(project: Project, token: string, productId: string, kind: "subscription" | "inapp", consumable: boolean, appUserId: string | null, hints: GoogleHints) {
  const { call } = await client(project);
  const tokenPath = encodeURIComponent(token);
  let purchase: Purchase, accountHash: string | undefined;
  if (kind === "subscription") {
    const sub = await call(`/purchases/subscriptionsv2/tokens/${tokenPath}`);
    purchase = googleSubscriptionPurchase(token, sub, hints);
    accountHash = sub.externalAccountIdentifiers?.obfuscatedExternalAccountId;
    if (sub.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING" && purchase.status === "active") {
      await call(`/purchases/subscriptions/${encodeURIComponent(purchase.productId)}/tokens/${tokenPath}:acknowledge`, "POST", {}).catch(() => null);
    }
    if (sub.linkedPurchaseToken) {
      // Upgrade / resubscribe: the old token is superseded.
      const old = await lookupIndex(project.id, `google:${sha256(sub.linkedPurchaseToken)}`);
      if (old && !appUserId) appUserId = old;
    }
  } else {
    const p = await call(`/purchases/products/${encodeURIComponent(productId)}/tokens/${tokenPath}`);
    purchase = googleProductPurchase(token, productId, p, hints, consumable);
    accountHash = p.obfuscatedExternalAccountId;
    if (p.acknowledgementState === 0 && p.purchaseState === 0 && !consumable) {
      await call(`/purchases/products/${encodeURIComponent(productId)}/tokens/${tokenPath}:acknowledge`, "POST", {}).catch(() => null);
    }
  }
  let owner = await lookupIndex(project.id, `google:${sha256(token)}`, accountHash ? `acct:${accountHash}` : null);
  if (owner && appUserId && owner !== appUserId && owner.startsWith("$") && !appUserId.startsWith("$")) {
    await mergeCustomers(project, owner, appUserId);
    owner = appUserId;
  }
  const target = owner ?? appUserId ?? `$google:${purchase.id}`;
  await remember(project, token, { productId: purchase.productId, kind, consumable, hints, appUserId: target });
  const result = await upsertPurchase(project, target, purchase, [`google:${sha256(token)}`]);
  return { appUserId: target, purchase, ...result };
}

/** Client path: the Android SDK posts the purchase token right after Play Billing returns it. */
export async function ingestGooglePurchase(project: Project, appUserId: string, body: any) {
  const token = String(body?.purchaseToken ?? "");
  const productId = String(body?.productId ?? "");
  if (!token || token.length > 4096 || !productId) throw new HttpError(400, "invalid_purchase");
  const kind = body.type === "inapp" || body.type === "consumable" || body.type === "non_consumable" ? "inapp" : "subscription";
  return fetchAndStore(project, token, productId, kind, body.type === "consumable", appUserId, {
    priceMicros: Number(body.priceMicros) || undefined, currency: body.currency, period: body.period,
  });
}

/** Server path: Real-time developer notifications (Pub/Sub push subscription). */
export async function ingestGoogleNotification(project: Project, body: any) {
  const raw = body?.message?.data;
  if (!raw) throw new HttpError(400, "invalid_pubsub_message");
  const msg = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  if (msg.testNotification) return { test: true };
  const sub = msg.subscriptionNotification, one = msg.oneTimeProductNotification, voided = msg.voidedPurchaseNotification;
  const token: string | undefined = sub?.purchaseToken ?? one?.purchaseToken ?? voided?.purchaseToken;
  if (!token) return { ignored: true };
  const known = (await db.doc(`projects/${project.id}/googleTokens/${sha256(token)}`).get()).data() ?? {};
  if (voided) {
    const owner = await lookupIndex(project.id, `google:${sha256(token)}`);
    if (!owner) return { ignored: "unknown_token" };
    const ref = db.doc(`projects/${project.id}/customers/${owner}/purchases/gp_${sha256(token).slice(0, 40)}`);
    const prev = (await ref.get()).data() as Purchase | undefined;
    if (!prev) return { ignored: "unknown_purchase" };
    return upsertPurchase(project, owner, { ...prev, status: "refunded", updatedAt: Date.now() });
  }
  if (sub) return fetchAndStore(project, token, sub.subscriptionId ?? known.productId, "subscription", false, null, known.hints ?? {});
  return fetchAndStore(project, token, one.sku ?? known.productId, "inapp", Boolean(known.consumable), null, known.hints ?? {});
}
