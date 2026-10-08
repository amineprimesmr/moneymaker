// One-step store connections: validate credentials, wire the store to MoneyMaker, import catalog and history.
import Stripe from "stripe";
import { createSign } from "crypto";
import { JWT } from "google-auth-library";
import { FieldValue } from "firebase-admin/firestore";
import { HttpError } from "./engine";
import { Project, ProjectConfig, db, getCredentials, sha256 } from "./store";
import { storeSubscription } from "./stripe";
import { toAlpha2 } from "./countries";
import { convertMicros } from "./engine";
import { syncTrackers } from "./appstore";

const STRIPE_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
  "customer.subscription.paused", "customer.subscription.resumed", "invoice.paid", "invoice.payment_failed",
  "checkout.session.completed", "charge.refunded",
];

/** Stripe: validate key → create the webhook endpoint automatically → import subscriptions + 12 months of invoices. */
export async function connectStripe(project: Project, baseUrl: string, secretKey: string) {
  if (!/^(sk|rk)_(live|test)_/.test(secretKey ?? "")) throw new HttpError(400, "invalid_stripe_key");
  const stripe = new Stripe(secretKey);
  let account: Stripe.Account;
  try { account = await stripe.accounts.retrieveCurrent(); } catch (e) { throw new HttpError(400, "stripe_key_rejected", (e as Error).message); }
  const url = `${baseUrl}/v1/webhooks/stripe/${project.id}`;
  const existing = (await stripe.webhookEndpoints.list({ limit: 100 })).data.filter(w => w.url === url);
  for (const w of existing) await stripe.webhookEndpoints.del(w.id); // secrets are only returned on creation
  const endpoint = await stripe.webhookEndpoints.create({ url, enabled_events: STRIPE_EVENTS, description: `MoneyMaker · ${project.name}` });
  await db.doc(`projects/${project.id}/private/credentials`).set({ stripe: { secretKey, webhookSecret: endpoint.secret } }, { merge: true });
  await db.doc(`projects/${project.id}`).update({ "config.stripe.enabled": true, "config.stripe.accountName": account.settings?.dashboard?.display_name ?? account.business_profile?.name ?? account.id });
  const imported = await importStripeHistory(project, stripe);
  return { account: account.settings?.dashboard?.display_name ?? account.id, livemode: secretKey.includes("_live_"), webhookEndpoint: endpoint.id, ...imported };
}

export async function importStripeHistory(project: Project, stripe: Stripe) {
  let subscriptions = 0, invoices = 0;
  for await (const sub of stripe.subscriptions.list({ status: "all", limit: 100, expand: ["data.customer"] })) {
    const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
    await storeSubscription(project, { ...sub, customer: customerId } as Stripe.Subscription, stripe, { silent: true });
    subscriptions++;
  }
  // Revenue history: paid invoices of the last 12 months become transactions (idempotent ids).
  const since = Math.floor(Date.now() / 1000) - 365 * 86400;
  let batch = db.batch(), pending = 0;
  for await (const inv of stripe.invoices.list({ status: "paid", created: { gte: since }, limit: 100 })) {
    if (!inv.amount_paid) continue;
    const subId = (inv as any).subscription ?? (inv as any).parent?.subscription_details?.subscription ?? null;
    const appUserId = (await db.doc(`projects/${project.id}/index/${sha256(`stripe:${subId}`)}`).get()).get("appUserId")
      ?? (await db.doc(`projects/${project.id}/index/${sha256(`stripe_cus:${inv.customer}`)}`).get()).get("appUserId")
      ?? `$stripe:${inv.customer}`;
    const currency = inv.currency.toUpperCase();
    const amount = inv.amount_paid * 10000;
    batch.set(db.doc(`projects/${project.id}/transactions/stripe_inv_${inv.id}`), {
      appUserId, store: "stripe", productId: inv.lines.data[0]?.pricing?.price_details?.price ?? (inv.lines.data[0] as any)?.price?.id ?? "stripe",
      purchaseId: subId ?? inv.id, kind: inv.billing_reason === "subscription_cycle" ? "renewal" : "purchase",
      amountMicros: amount, currency, amountMicrosProject: convertMicros(amount, currency, project.config.currency),
      isSandbox: !inv.livemode, country: toAlpha2(inv.customer_address?.country), at: inv.created * 1000, imported: true,
    }, { merge: true });
    invoices++;
    if (++pending >= 400) { await batch.commit(); batch = db.batch(); pending = 0; }
  }
  if (pending) await batch.commit();
  return { importedSubscriptions: subscriptions, importedInvoices: invoices };
}

// ── App Store Connect API (ES256 JWT) ───────────────────────────────────────

function ascToken(c: { issuerId: string; keyId: string; privateKey: string }) {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = `${enc({ alg: "ES256", kid: c.keyId, typ: "JWT" })}.${enc({ iss: c.issuerId, iat: now, exp: now + 1100, aud: "appstoreconnect-v1" })}`;
  const sig = createSign("sha256").update(head).sign({ key: c.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${head}.${sig}`;
}

async function asc(c: { issuerId: string; keyId: string; privateKey: string }, path: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    ...init, signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${ascToken(c)}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status === 401 || res.status === 403 ? 400 : 502, "app_store_connect_error", text.slice(0, 400));
  return text ? JSON.parse(text) : {};
}

/** App Store Connect: read the app, optionally point Server Notifications V2 at MoneyMaker, import products, track rankings. */
export async function connectAppStore(project: Project, baseUrl: string, body: any) {
  const c = { issuerId: String(body?.issuerId ?? ""), keyId: String(body?.keyId ?? ""), privateKey: String(body?.privateKey ?? "") };
  if (!c.issuerId || !c.keyId || !/BEGIN PRIVATE KEY/.test(c.privateKey)) throw new HttpError(400, "invalid_app_store_connect_key");
  const appAppleId = String(body?.appAppleId ?? project.config.apple?.appAppleId ?? "");
  let app: any;
  if (appAppleId) app = (await asc(c, `/v1/apps/${encodeURIComponent(appAppleId)}`)).data;
  else if (project.config.apple?.bundleId) app = (await asc(c, `/v1/apps?filter[bundleId]=${encodeURIComponent(project.config.apple.bundleId)}`)).data?.[0];
  if (!app) throw new HttpError(404, "app_not_found", "Give appAppleId (App Store Connect → App Information → Apple ID)");

  const notificationUrl = `${baseUrl}/v1/webhooks/apple/${project.id}`;
  const previous = { production: app.attributes.subscriptionStatusUrl ?? null, sandbox: app.attributes.subscriptionStatusUrlForSandbox ?? null };
  let notificationsConfigured = false;
  // Never silently steal notifications from another backend: only overwrite when asked or when empty.
  if (body?.setNotificationUrl === true || (!previous.production && body?.setNotificationUrl !== false)) {
    await asc(c, `/v1/apps/${app.id}`, { method: "PATCH", body: JSON.stringify({ data: { type: "apps", id: app.id, attributes: {
      subscriptionStatusUrl: notificationUrl, subscriptionStatusUrlVersion: "V2",
      subscriptionStatusUrlForSandbox: notificationUrl, subscriptionStatusUrlVersionForSandbox: "V2",
    } } }) });
    notificationsConfigured = true;
  }

  // Catalog: auto-renewable subscriptions + in-app purchases.
  const productIds: string[] = [];
  const groups = await asc(c, `/v1/apps/${app.id}/subscriptionGroups?include=subscriptions&limit=50`).catch(() => ({ included: [] }));
  for (const s of groups.included ?? []) if (s.type === "subscriptions") productIds.push(s.attributes.productId);
  const iaps = await asc(c, `/v1/apps/${app.id}/inAppPurchasesV2?limit=200`).catch(() => ({ data: [] }));
  for (const p of iaps.data ?? []) if (p.attributes.inAppPurchaseType !== "CONSUMABLE") productIds.push(p.attributes.productId);

  const config: ProjectConfig = { ...project.config };
  config.apple = { bundleId: app.attributes.bundleId, appAppleId: Number(app.id) };
  if (productIds.length) {
    const ent = Object.keys(config.entitlements).length ? config.entitlements : { premium: [] };
    const first = Object.keys(ent)[0];
    ent[first] = [...new Set([...(ent[first] ?? []).filter(x => x !== "*"), ...productIds])];
    config.entitlements = ent;
  }
  const tracked = config.appStore?.apps ?? [];
  if (!tracked.some(a => a.appId === app.id)) config.appStore = { apps: [...tracked, { appId: app.id, own: true }] };
  await db.doc(`projects/${project.id}`).update({ config, name: project.name || app.attributes.name });
  await db.doc(`projects/${project.id}/private/credentials`).set({ appStoreConnect: c, ...(body?.inAppPurchaseKey ? { apple: body.inAppPurchaseKey } : {}) }, { merge: true });
  await syncTrackers(project.id, config.appStore!.apps, tracked);
  return {
    app: { id: app.id, name: app.attributes.name, bundleId: app.attributes.bundleId },
    notificationsConfigured, notificationUrl, previousNotificationUrls: previous, importedProducts: productIds,
  };
}

/** Google Play: validate the service account against the app and import subscription products. */
export async function connectGooglePlay(project: Project, body: any) {
  const sa = typeof body?.serviceAccount === "string" ? JSON.parse(body.serviceAccount) : body?.serviceAccount;
  const pkg = String(body?.packageName ?? project.config.google?.packageName ?? "");
  if (!sa?.client_email || !sa?.private_key || !pkg) throw new HttpError(400, "invalid_google_connection");
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: ["https://www.googleapis.com/auth/androidpublisher"] });
  const { token } = await jwt.getAccessToken().catch(e => { throw new HttpError(400, "google_auth_failed", e.message); });
  const res = await fetch(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(pkg)}/subscriptions`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new HttpError(400, "google_play_access_denied", (await res.text()).slice(0, 300));
  const productIds = ((await res.json()).subscriptions ?? []).map((s: any) => s.productId as string);
  const config = { ...project.config, google: { packageName: pkg } };
  if (productIds.length) {
    const ent = Object.keys(config.entitlements).length ? config.entitlements : { premium: [] };
    const first = Object.keys(ent)[0];
    ent[first] = [...new Set([...(ent[first] ?? []).filter(x => x !== "*"), ...productIds])];
    config.entitlements = ent;
  }
  await db.doc(`projects/${project.id}`).update({ config });
  await db.doc(`projects/${project.id}/private/credentials`).set({ google: { serviceAccount: { client_email: sa.client_email, private_key: sa.private_key } } }, { merge: true });
  const creds = await getCredentials(project.id);
  return {
    packageName: pkg, importedProducts: productIds, serviceAccount: sa.client_email,
    rtdn: { pushEndpoint: `/v1/webhooks/google/${project.id}?token=${creds.googleRtdnToken}` },
  };
}

export const markConnected = (pid: string, store: string) =>
  db.doc(`projects/${pid}`).set({ connections: { [store]: { connectedAt: FieldValue.serverTimestamp() } } }, { merge: true });
