// Web purchases (RevenueCat "Web" parity): hosted paywall + purchase links (/pay/{pid}/{oid}),
// redemption links for anonymous web buyers, hosted customer portal (/manage/{pid}).
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import Stripe from "stripe";
import { HttpError, cleanId } from "./engine";
import { db, getCredentials, mergeCustomers, touchCustomer, Project } from "./store";
import { createCheckout, createPortal, storeSubscription } from "./stripe";

export interface WebConfig { enabled?: boolean; redemptionUrl?: string; successUrl?: string }

export function sanitizeWeb(w: any): WebConfig | undefined {
  if (w === null) return undefined;
  if (typeof w !== "object" || Array.isArray(w)) throw new HttpError(400, "invalid_web");
  const out: WebConfig = { enabled: w.enabled === undefined ? true : Boolean(w.enabled) };
  for (const k of ["redemptionUrl", "successUrl"] as const) if (w[k]) {
    const v = String(w[k]).trim();
    // Universal link (https://…) or custom scheme (myapp://redeem).
    if (v.length > 500 || !/^([a-z][a-z0-9+.-]*):\/\/\S+$/i.test(v) || /^(javascript|data|file):/i.test(v)) throw new HttpError(400, `invalid_web_${k}`, "URL https://… ou schéma d'app (monapp://…) attendu");
    out[k] = v;
  }
  return out;
}

/** Offering → public, secret-free shape for the hosted paywall (only packages with a Stripe price). */
export function publicOffering(project: Project, offeringId: string) {
  const web = (project.config as any).web as WebConfig | undefined;
  if (web && web.enabled === false) throw new HttpError(403, "web_purchases_disabled");
  const o = (project.config.offerings ?? {})[offeringId] as any;
  if (!o) throw new HttpError(404, "offering_not_found");
  const packages = (o.packages ?? []).filter((p: any) => typeof p.productIds?.stripe === "string" && /^price_/.test(p.productIds.stripe))
    .map((p: any) => ({ id: p.id, priceId: p.productIds.stripe, metadata: p.metadata ?? {} }));
  return { projectId: project.id, projectName: project.name, offeringId, description: o.description ?? null, paywall: o.paywall ?? null, packages, currency: project.config.currency };
}

/** Enriches packages with live Stripe prices (amount, interval). Publishable info only. */
export async function withPrices(project: Project, off: ReturnType<typeof publicOffering>) {
  const creds = await getCredentials(project.id);
  if (!creds.stripe?.secretKey) return { ...off, packages: off.packages.map((p: any) => ({ ...p, price: null })) };
  const stripe = new Stripe(creds.stripe.secretKey);
  const packages = await Promise.all(off.packages.map(async (p: any) => {
    const pr = await stripe.prices.retrieve(p.priceId, { expand: ["product"] }).catch(() => null);
    if (!pr || !pr.active) return null;
    const product = typeof pr.product === "object" && pr.product && !("deleted" in pr.product && pr.product.deleted) ? pr.product as Stripe.Product : null;
    return { ...p, price: { amount: pr.unit_amount, currency: pr.currency.toUpperCase(), interval: pr.recurring?.interval ?? null, intervalCount: pr.recurring?.interval_count ?? null, trialDays: pr.recurring?.trial_period_days ?? null }, productName: product?.name ?? null };
  }));
  return { ...off, packages: packages.filter(Boolean), livemode: creds.stripe.secretKey.includes("_live_") };
}

const ANON = /^\$web:[A-Za-z0-9_-]{16,}$/;

export async function webCheckout(project: Project, offeringId: string, body: any, base: string) {
  const off = publicOffering(project, cleanId(offeringId, 64));
  const pkg = off.packages.find((p: any) => p.id === body?.packageId);
  if (!pkg) throw new HttpError(400, "unknown_package");
  const raw = typeof body?.appUserId === "string" && body.appUserId.trim() ? cleanId(body.appUserId.trim()) : null;
  const appUserId = raw ?? `$web:${randomBytes(16).toString("base64url")}`;
  const email = typeof body?.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) && body.email.length < 200 ? body.email : undefined;
  const back = `${base}/pay/${encodeURIComponent(project.id)}/${encodeURIComponent(off.offeringId)}`;
  return createCheckout(project, appUserId, {
    priceId: pkg.priceId, productId: pkg.priceId, email, promoCode: typeof body?.promoCode === "string" ? body.promoCode.trim().slice(0, 100) : undefined,
    successUrl: `${base}/pay/success?pid=${encodeURIComponent(project.id)}&session_id={CHECKOUT_SESSION_ID}`, cancelUrl: back,
  });
}

// ── Manage-link tokens: `${b64(appUserId)}.${exp}.${hmac}` signed with the project's webhook signing secret.
export function signManageToken(appUserId: string, secret: string, ttlMs = 7 * 86400000, now = Date.now()) {
  const payload = `${Buffer.from(appUserId).toString("base64url")}.${now + ttlMs}`;
  return `${payload}.${createHmac("sha256", secret).update(`manage:${payload}`).digest("base64url")}`;
}
export function verifyManageToken(token: string, secret: string, now = Date.now()): string | null {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  const [u, exp, sig] = parts;
  const want = createHmac("sha256", secret).update(`manage:${u}.${exp}`).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want) || !(Number(exp) > now)) return null;
  return Buffer.from(u, "base64url").toString("utf8");
}

export async function manageLink(project: Project, appUserId: string, base: string) {
  const creds = await getCredentials(project.id);
  return { url: `${base}/manage/${encodeURIComponent(project.id)}?token=${signManageToken(appUserId, creds.webhookSigningSecret)}` };
}

export async function webPortal(project: Project, body: any, base: string) {
  const creds = await getCredentials(project.id);
  const appUserId = verifyManageToken(String(body?.token ?? ""), creds.webhookSigningSecret);
  if (!appUserId) throw new HttpError(401, "invalid_manage_token");
  const ret = typeof body?.returnUrl === "string" && /^https:\/\//.test(body.returnUrl) ? body.returnUrl : `${base}/manage/${encodeURIComponent(project.id)}`;
  return createPortal(project, appUserId, ret);
}

/** Called by /pay/success: syncs the Checkout Session now (no wait for the webhook) and, for an
 *  anonymous buyer, issues a single-use redemption token stored in projects/{pid}/redemptions. */
export async function webSuccess(project: Project, sessionId: string, base: string) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw new HttpError(400, "invalid_session_id");
  const creds = await getCredentials(project.id);
  if (!creds.stripe?.secretKey) throw new HttpError(400, "stripe_not_configured");
  const stripe = new Stripe(creds.stripe.secretKey);
  const cs = await stripe.checkout.sessions.retrieve(sessionId);
  if (cs.status !== "complete") throw new HttpError(409, "checkout_not_complete");
  const appUserId = cs.client_reference_id ?? "";
  if (!appUserId) throw new HttpError(409, "checkout_without_user");
  if (cs.subscription) {
    const sub = await stripe.subscriptions.retrieve(typeof cs.subscription === "string" ? cs.subscription : cs.subscription.id);
    await storeSubscription(project, sub, stripe, { appUserId }).catch(e => console.error("web success sync", e));
  }
  const web = (project.config as any).web as WebConfig | undefined;
  const manage = await manageLink(project, appUserId, base);
  const out: Record<string, unknown> = { appUserId: ANON.test(appUserId) ? null : appUserId, email: cs.customer_details?.email ?? null, manageUrl: manage.url, successUrl: web?.successUrl ?? null };
  if (ANON.test(appUserId)) {
    const bySession = db.doc(`projects/${project.id}/redemptions/session_${sessionId}`);
    let token = (await bySession.get()).get("token") as string | undefined;
    if (!token) {
      token = `mmr_${randomBytes(18).toString("base64url")}`;
      const batch = db.batch();
      batch.set(db.doc(`projects/${project.id}/redemptions/${token}`), { token, fromAppUserId: appUserId, sessionId, email: cs.customer_details?.email ?? null, createdAt: Date.now(), redeemedBy: null });
      batch.set(bySession, { token });
      await batch.commit();
    }
    const target = web?.redemptionUrl;
    out.redemptionToken = token;
    out.redemptionLink = target ? `${target}${target.includes("?") ? "&" : "?"}mm_redeem=${token}` : null;
  }
  return out;
}

/** POST /v1/customers/:id/redeem — moves the anonymous web purchase onto the app user (single use). */
export async function redeemWebPurchase(project: Project, appUserId: string, token: string) {
  if (!/^mmr_[A-Za-z0-9_-]{10,}$/.test(token)) throw new HttpError(400, "invalid_redemption_token");
  const ref = db.doc(`projects/${project.id}/redemptions/${token}`);
  const claimed = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError(404, "redemption_not_found");
    const r = snap.data()!;
    if (r.redeemedBy && r.redeemedBy !== appUserId) throw new HttpError(409, "already_redeemed");
    if (!r.redeemedBy) tx.update(ref, { redeemedBy: appUserId, redeemedAt: Date.now() });
    return r.fromAppUserId as string;
  });
  await mergeCustomers(project, claimed, appUserId);
  await touchCustomer(project.id, appUserId);
}
