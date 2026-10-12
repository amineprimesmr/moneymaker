// Server-side attribution / engagement connectors (RevenueCat parity).
// Every `build*` function is pure (unit-tested in tests/connectors.test.cjs) and returns an HTTP request
// description, or null when the event must not be sent (unmapped type, missing identifier, sandbox...).
import { createHash } from "crypto";

export type Attrs = Record<string, string | undefined>;
export interface Req { url: string; method?: "POST" | "GET" | "PUT" | "PATCH"; headers?: Record<string, string>; body?: unknown; form?: Record<string, string | undefined> }
export interface AppIds { bundleId?: string; packageName?: string }

/** Reserved customer attributes read by connectors (set by the SDKs, `$`-prefixed like RevenueCat). */
export const RESERVED_ATTRIBUTES = [
  "$email", "$displayName", "$phoneNumber", "$ip", "$idfa", "$idfv", "$gpsAdId", "$androidId", "$attConsentStatus",
  "$appsflyerId", "$adjustId", "$branchId", "$fbAnonId", "$kochavaDeviceId", "$tenjinId", "$singularId",
  "$onesignalId", "$onesignalUserId", "$brazeAliasName", "$brazeAliasLabel", "$iterableUserId", "$customerioId",
  "$clevertapId", "$airshipChannelId", "$intercomId", "$mparticleId", "$firebaseAppInstanceId",
  "$appleAdsToken", "$airbridgeDeviceId", "$timezone", "$osVersion", "$appVersion", "$deviceModel", "$locale",
] as const;

const REVENUE = new Set(["INITIAL_PURCHASE", "RENEWAL", "TRIAL_CONVERTED", "NON_RENEWING_PURCHASE"]);
export const isRevenue = (e: any) => REVENUE.has(e.type) && !e.isTrial && Number(e.priceMicros) > 0;
export const amount = (e: any) => (isRevenue(e) ? Math.round(Number(e.priceMicros) / 1e4) / 100 : 0);
/** Refunds are negative revenue for tools that support it. */
export const signedAmount = (e: any) => (e.type === "REFUND" && Number(e.priceMicros) > 0 ? -Math.round(Number(e.priceMicros) / 1e4) / 100 : amount(e));
export const platformOf = (e: any): "ios" | "android" | "web" => (e.store === "play_store" ? "android" : e.store === "app_store" ? "ios" : "web");
export const eventName = (e: any) => `mm_${String(e.type).toLowerCase()}`;
const sha = (s: string) => createHash("sha256").update(s.trim().toLowerCase()).digest("hex");
const secs = (e: any) => Math.floor(Number(e.at ?? Date.now()) / 1000);
const iso = (e: any) => new Date(Number(e.at ?? Date.now())).toISOString();
const clean = <T extends Record<string, any>>(o: T): T => JSON.parse(JSON.stringify(o));
const props = (e: any) => clean({
  product_id: e.productId, store: e.store, price: amount(e), currency: e.currency, country: e.country ?? undefined,
  is_trial: Boolean(e.isTrial), event_type: e.type, transaction_id: e.transactionId ?? e.id,
});
const isIPv4 = (ip?: string) => Boolean(ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip));
/** ATT status as the 0..3 integer used by Singular / Airbridge (0 not determined, 1 restricted, 2 denied, 3 authorized). */
const attCode = (s?: string) => ({ notDetermined: 0, not_determined: 0, restricted: 1, denied: 2, authorized: 3 } as Record<string, number>)[s ?? ""] ?? 0;
const basic = (u: string, p = "") => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

// ───────────────────────────── Attribution / ads ─────────────────────────────

/** Meta Conversions API, app events. POST graph.facebook.com/{v}/{dataset_id}/events
 * (https://developers.facebook.com/docs/marketing-api/conversions-api/app-events — latest Graph API v26.0, 29 Jul 2026). */
export interface MetaCfg { datasetId: string; accessToken: string; apiVersion?: string; testEventCode?: string }
const META_NAMES: Record<string, string> = { TRIAL_STARTED: "StartTrial", TRIAL_CONVERTED: "Subscribe", INITIAL_PURCHASE: "Subscribe", RENEWAL: "Purchase", NON_RENEWING_PURCHASE: "Purchase" };
export function buildMeta(cfg: MetaCfg, e: any, a: Attrs, app: AppIds): Req | null {
  let name = META_NAMES[e.type];
  if (!name || (e.type === "INITIAL_PURCHASE" && e.isTrial)) return null; // trial start is sent as TRIAL_STARTED
  const p = platformOf(e);
  if (p === "web") return null;
  const madid = p === "ios" ? a.$idfa : a.$gpsAdId;
  if (!a.$fbAnonId && !madid) return null;
  const ate = p === "android" ? 1 : a.$attConsentStatus === "authorized" ? 1 : 0;
  const pkg = (p === "ios" ? app.bundleId : app.packageName) ?? "";
  // extinfo: 16 positional fields, all present (empty string placeholders): 0 version i2/a2, 1 package, 2 short version, 3 long version,
  // 4 OS version (required), 5 device model, 6 locale, 7 tz abbr, 8 carrier, 9-11 screen w/h/density, 12 cores, 13-14 storage, 15 device timezone.
  const extinfo = [p === "ios" ? "i2" : "a2", pkg, a.$appVersion ?? "", a.$appVersion ?? "", a.$osVersion ?? "", a.$deviceModel ?? "", a.$locale ?? "", "", "", "", "", "", "", "", "", a.$timezone ?? ""];
  return {
    url: `https://graph.facebook.com/${cfg.apiVersion ?? "v26.0"}/${encodeURIComponent(cfg.datasetId)}/events`,
    body: clean({
      access_token: cfg.accessToken, test_event_code: cfg.testEventCode,
      data: [{
        event_name: name, event_time: secs(e), event_id: e.id, action_source: "app",
        user_data: { anon_id: a.$fbAnonId, madid: ate ? madid : undefined, external_id: [sha(String(e.appUserId))], em: a.$email ? [sha(a.$email)] : undefined, client_ip_address: a.$ip },
        app_data: clean({ advertiser_tracking_enabled: ate, application_tracking_enabled: ate, extinfo, vendor_id: p === "ios" ? a.$idfv : undefined }),
        custom_data: { currency: e.currency, value: amount(e), content_ids: [e.productId], content_type: "product" },
      }],
    }),
  };
}

/** Adjust S2S events. POST https://s2s.adjust.com/event (form), Authorization: Bearer <S2S token> (https://dev.adjust.com/en/api/s2s-api/events). */
export interface AdjustCfg { appToken: string; s2sToken: string; eventTokens: Record<string, string> }
export function buildAdjust(cfg: AdjustCfg, e: any, a: Attrs): Req | null {
  const token = cfg.eventTokens?.[e.type];
  if (!token) return null;
  const p = platformOf(e);
  const ids: Record<string, string | undefined> = { adid: a.$adjustId, ...(p === "ios" ? { idfa: a.$idfa, idfv: a.$idfv } : { gps_adid: a.$gpsAdId, android_id: a.$androidId }) };
  if (!Object.values(ids).some(Boolean)) return null;
  const rev = signedAmount(e);
  return {
    url: "https://s2s.adjust.com/event", headers: { Authorization: `Bearer ${cfg.s2sToken}` },
    form: clean({
      s2s: "1", app_token: cfg.appToken, event_token: token, created_at_unix: String(secs(e)), environment: e.isSandbox ? "sandbox" : "production",
      ...ids, ip_address: isIPv4(a.$ip) ? a.$ip : undefined /* IPv4 only */, ...(rev ? { revenue: String(rev), currency: e.currency } : {}),
      callback_params: JSON.stringify({ app_user_id: e.appUserId, product_id: e.productId }),
    }),
  };
}

/** Branch v2 events. POST https://api2.branch.io/v2/event/standard (or /custom). */
export interface BranchCfg { branchKey: string }
const BRANCH_STD: Record<string, string> = { TRIAL_STARTED: "START_TRIAL", TRIAL_CONVERTED: "SUBSCRIBE", INITIAL_PURCHASE: "SUBSCRIBE", RENEWAL: "PURCHASE", NON_RENEWING_PURCHASE: "PURCHASE" };
export function buildBranch(cfg: BranchCfg, e: any, a: Attrs): Req | null {
  const p = platformOf(e);
  const std = e.type === "INITIAL_PURCHASE" && e.isTrial ? null : BRANCH_STD[e.type];
  const user_data = clean({
    os: p === "ios" ? "iOS" : p === "android" ? "Android" : undefined, developer_identity: e.appUserId,
    idfa: p === "ios" ? a.$idfa : undefined, idfv: p === "ios" ? a.$idfv : undefined, aaid: p === "android" ? a.$gpsAdId : undefined,
    android_id: p === "android" ? a.$androidId : undefined, browser_fingerprint_id: undefined, ip: a.$ip,
    limit_ad_tracking: p === "ios" ? a.$attConsentStatus !== "authorized" : undefined,
  });
  if (!user_data.os || !(user_data.idfa || user_data.idfv || user_data.aaid || user_data.android_id)) return null;
  const rev = amount(e);
  return {
    url: `https://api2.branch.io/v2/event/${std ? "standard" : "custom"}`,
    body: clean({
      name: std ?? eventName(e), branch_key: cfg.branchKey, user_data,
      event_data: std ? clean({ transaction_id: e.transactionId ?? e.id, currency: rev ? e.currency : undefined, revenue: rev || undefined, description: e.type }) : undefined,
      custom_data: { app_user_id: e.appUserId, product_id: e.productId, store: e.store },
      content_items: [{ $sku: e.productId, $product_name: e.productId, ...(rev ? { $price: rev, $currency: e.currency, $quantity: 1 } : {}) }],
    }),
  };
}

/** Singular S2S events, legacy V1 endpoint (pure server-side). GET https://s2s.singular.net/api/v1/evt.
 * iOS: idfv always, idfa only when available, att_authorization_status required. */
export interface SingularCfg { sdkKey: string }
export function buildSingular(cfg: SingularCfg, e: any, a: Attrs, app: AppIds): Req | null {
  const p = platformOf(e);
  const bundle = p === "ios" ? app.bundleId : app.packageName;
  if (p === "web" || !bundle || !a.$ip) return null;
  const ids = p === "ios" ? { idfa: a.$idfa, idfv: a.$idfv } : { aifa: a.$gpsAdId, andi: a.$androidId };
  if (!Object.values(ids).some(Boolean) || (p === "ios" && !a.$idfv)) return null; // IDFV is mandatory on iOS
  const att = p === "ios" ? { att_authorization_status: String(attCode(a.$attConsentStatus)) } : {};
  const rev = signedAmount(e);
  const q = clean({
    a: cfg.sdkKey, p: p === "ios" ? "iOS" : "Android", i: bundle, ip: a.$ip, ve: a.$osVersion ?? "0", n: eventName(e),
    ...ids, ...att, utime: String(secs(e)), custom_user_id: e.appUserId,
    ...(rev ? { is_revenue_event: "true", amt: String(rev), cur: e.currency, purchase_product_id: e.productId, purchase_transaction_id: e.transactionId ?? e.id } : {}),
  });
  return { url: `https://s2s.singular.net/api/v1/evt?${new URLSearchParams(q as any)}`, method: "GET" };
}

/** Kochava post-install event. POST https://control.kochava.com/track/json
 * (https://support.kochava.com/server-to-server-integration/post-install-event-setup): device_ver/device_ua required (may be ""), att required on iOS. */
export interface KochavaCfg { appGuid: string }
export function buildKochava(cfg: KochavaCfg, e: any, a: Attrs): Req | null {
  const deviceId = a.$kochavaDeviceId;
  if (!deviceId || !a.$ip) return null; // origination_ip is required
  const p = platformOf(e), rev = signedAmount(e);
  const device_ids = clean(p === "ios" ? { idfa: a.$idfa, idfv: a.$idfv } : { adid: a.$gpsAdId, android_id: a.$androidId });
  if (!Object.keys(device_ids).length) return null;
  return {
    url: "https://control.kochava.com/track/json",
    body: {
      action: "event", kochava_app_id: cfg.appGuid, kochava_device_id: deviceId,
      data: clean({
        usertime: secs(e), origination_ip: a.$ip, app_version: a.$appVersion, device_ver: "", device_ua: "", device_ids,
        ...(p === "ios" ? { att: a.$attConsentStatus === "authorized" } : {}), currency: rev ? e.currency : undefined,
        event_name: eventName(e), event_data: clean({ ...props(e), sum: rev || undefined, user_id: e.appUserId }),
      }),
    },
  };
}

/** Tenjin S2S purchase. POST https://track.tenjin.com/v0/purchase, Basic <SDK key>: (https://tenjin.com/docs/server-to-server-s2s-setup/#purchase-api).
 * Required: analytics_installation_id, advertising_id, bundle_id, platform, os_version, sdk_version, product_id, price, quantity, currency; developer_device_id on iOS. */
export interface TenjinCfg { apiKey: string }
export function buildTenjin(cfg: TenjinCfg, e: any, a: Attrs, app: AppIds): Req | null {
  if (!isRevenue(e)) return null;
  const p = platformOf(e), bundle = p === "ios" ? app.bundleId : app.packageName;
  const adId = p === "ios" ? a.$idfa : a.$gpsAdId;
  if (p === "web" || !bundle || !a.$tenjinId || (p === "ios" && !a.$idfv)) return null;
  return {
    url: "https://track.tenjin.com/v0/purchase", headers: { Authorization: basic(cfg.apiKey) },
    form: clean({
      bundle_id: bundle, platform: p, advertising_id: adId || "00000000-0000-0000-0000-000000000000", analytics_installation_id: a.$tenjinId,
      developer_device_id: p === "ios" ? a.$idfv : a.$androidId, limit_ad_tracking: adId ? "0" : "1",
      os_version: a.$osVersion ?? "", sdk_version: "moneymaker-s2s-1.0", app_version: a.$appVersion, product_id: e.productId, currency: e.currency, quantity: "1", price: String(amount(e)),
      ip_address: a.$ip, customer_user_id: e.appUserId,
    }),
  };
}

/** Airbridge S2S in-app event. POST https://api.airbridge.io/events/v2/apps/{app_name}/mobile-app/9360, Bearer API token,
 * X-Forwarded-For = device IP; eventTimestamp in ms, must be < 24 h old; 1000 req/min
 * (https://help.airbridge.io/en/references/s2s-event/send-in-app-events). */
export interface AirbridgeCfg { appName: string; apiToken: string }
const AIRBRIDGE: Record<string, string> = {
  TRIAL_STARTED: "airbridge.startTrial", INITIAL_PURCHASE: "airbridge.subscribe", TRIAL_CONVERTED: "airbridge.subscribe",
  RENEWAL: "airbridge.ecommerce.order.completed", NON_RENEWING_PURCHASE: "airbridge.ecommerce.order.completed", EXPIRATION: "airbridge.unsubscribe",
};
/** Deterministic UUID-v4-shaped id from the event id (Airbridge dedupes on eventUUID). */
const uuidOf = (s: string) => { const h = createHash("sha256").update(s).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${"89ab"[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`; };
export function buildAirbridge(cfg: AirbridgeCfg, e: any, a: Attrs, app: AppIds, now = Date.now()): Req | null {
  const p = platformOf(e);
  const pkg = p === "ios" ? app.bundleId : app.packageName;
  const at = Number(e.at ?? now);
  if (p === "web" || !pkg || now - at > 24 * 3600 * 1000) return null;
  const category = e.type === "INITIAL_PURCHASE" && e.isTrial ? "airbridge.startTrial" : AIRBRIDGE[e.type] ?? eventName(e);
  const rev = amount(e);
  const device = a.$airbridgeDeviceId ? clean({
    deviceUUID: a.$airbridgeDeviceId, osName: p === "ios" ? "iOS" : "Android", osVersion: a.$osVersion ?? "", deviceModel: a.$deviceModel, locale: a.$locale,
    ...(p === "ios" ? { ifa: a.$idfa, ifv: a.$idfv, appTrackingTransparency: attCode(a.$attConsentStatus) } : { gaid: a.$gpsAdId }),
  }) : undefined;
  return {
    url: `https://api.airbridge.io/events/v2/apps/${encodeURIComponent(cfg.appName)}/mobile-app/9360`,
    headers: { Authorization: `Bearer ${cfg.apiToken}`, ...(a.$ip ? { "X-Forwarded-For": a.$ip } : {}) },
    body: clean({
      eventUUID: uuidOf(String(e.id)), eventTimestamp: at,
      user: { externalUserID: String(e.appUserId), externalUserEmail: a.$email }, device,
      app: { packageName: pkg, version: a.$appVersion },
      eventData: { goal: clean({
        category, value: rev || undefined,
        semanticAttributes: clean({ transactionID: e.transactionId ?? e.id, inAppPurchased: true, currency: rev ? e.currency : undefined,
          products: [clean({ productID: e.productId, name: e.productId, quantity: 1, price: rev || undefined, currency: rev ? e.currency : undefined })] }),
        customAttributes: clean({ store: e.store, event_type: e.type, is_trial: Boolean(e.isTrial) }),
      }) },
    }),
  };
}

// ───────────────────────────── Engagement / CRM ─────────────────────────────

/** Braze /users/track: purchases + custom events + subscription attributes. */
export interface BrazeCfg { restEndpoint: string; apiKey: string }
export function buildBraze(cfg: BrazeCfg, e: any, a: Attrs): Req {
  const user = a.$brazeAliasName && a.$brazeAliasLabel
    ? { user_alias: { alias_name: a.$brazeAliasName, alias_label: a.$brazeAliasLabel } } : { external_id: e.appUserId };
  const t = iso(e);
  return {
    url: `${cfg.restEndpoint.replace(/\/$/, "")}/users/track`, headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: clean({
      attributes: [{ ...user, mm_last_event: e.type, mm_product_id: e.productId, mm_store: e.store,
        mm_is_subscriber: !["EXPIRATION", "REFUND", "REVOKED"].includes(e.type), ...(a.$email ? { email: a.$email } : {}) }],
      events: [{ ...user, name: eventName(e), time: t, properties: props(e) }],
      purchases: isRevenue(e) ? [{ ...user, product_id: e.productId, currency: e.currency, price: amount(e), time: t, quantity: 1, properties: { store: e.store, type: e.type } }] : undefined,
    }),
  };
}

/** OneSignal user tags. PATCH https://api.onesignal.com/apps/{app_id}/users/by/{alias}/{id} */
export interface OneSignalCfg { appId: string; restApiKey: string }
export function buildOneSignal(cfg: OneSignalCfg, e: any, a: Attrs): Req {
  const [label, id] = a.$onesignalId ? ["onesignal_id", a.$onesignalId] : ["external_id", a.$onesignalUserId ?? e.appUserId];
  const active = !["EXPIRATION", "REFUND", "REVOKED"].includes(e.type);
  return {
    url: `https://api.onesignal.com/apps/${encodeURIComponent(cfg.appId)}/users/by/${label}/${encodeURIComponent(String(id))}`, method: "PATCH",
    headers: { Authorization: `Key ${cfg.restApiKey}` },
    body: { properties: { tags: clean({
      mm_last_event: e.type, mm_product_id: e.productId, mm_store: e.store, mm_is_subscriber: active ? "true" : "false",
      mm_is_trial: e.isTrial ? "true" : "false", mm_last_event_at: String(secs(e)), ...(e.type === "BILLING_ISSUE" ? { mm_billing_issue: "true" } : e.type === "BILLING_RECOVERED" ? { mm_billing_issue: "false" } : {}),
    }) } },
  };
}

/** Iterable: trackPurchase for revenue, events/track otherwise. Header Api-Key; createdAt is a Unix timestamp in seconds (https://api.iterable.com/api/docs). */
export interface IterableCfg { apiKey: string; region?: "us" | "eu" }
export function buildIterable(cfg: IterableCfg, e: any, a: Attrs): Req {
  const host = cfg.region === "eu" ? "https://api.eu.iterable.com" : "https://api.iterable.com";
  const headers = { "Api-Key": cfg.apiKey };
  const userId = a.$iterableUserId ?? e.appUserId;
  if (isRevenue(e)) return {
    url: `${host}/api/commerce/trackPurchase`, headers,
    body: clean({ id: e.id, user: { userId, email: a.$email, preferUserId: true }, total: amount(e), createdAt: secs(e),
      items: [{ id: e.productId, sku: e.productId, name: e.productId, price: amount(e), quantity: 1 }], dataFields: props(e) }),
  };
  return { url: `${host}/api/events/track`, headers, body: clean({ id: e.id, userId, email: a.$email, eventName: eventName(e), createdAt: secs(e), dataFields: props(e) }) };
}

/** Customer.io Track API v1: POST /api/v1/customers/{id}/events, Basic site_id:api_key. */
export interface CustomerIoCfg { siteId: string; apiKey: string; region?: "us" | "eu" }
export function buildCustomerIo(cfg: CustomerIoCfg, e: any, a: Attrs): Req {
  const host = cfg.region === "eu" ? "https://track-eu.customer.io" : "https://track.customer.io";
  return {
    url: `${host}/api/v1/customers/${encodeURIComponent(a.$customerioId ?? e.appUserId)}/events`, headers: { Authorization: basic(cfg.siteId, cfg.apiKey) },
    body: { name: eventName(e), id: undefined, timestamp: secs(e), data: { ...props(e), revenue: amount(e) || undefined } },
  };
}

/** CleverTap upload API. POST https://{region}.api.clevertap.com/1/upload */
export interface CleverTapCfg { accountId: string; passcode: string; region?: string }
export function buildCleverTap(cfg: CleverTapCfg, e: any, a: Attrs): Req {
  const host = cfg.region && cfg.region !== "eu1" ? `${cfg.region}.api.clevertap.com` : "eu1.api.clevertap.com";
  const charged = isRevenue(e);
  return {
    url: `https://${host}/1/upload`, headers: { "X-CleverTap-Account-Id": cfg.accountId, "X-CleverTap-Passcode": cfg.passcode },
    body: { d: [{ ...(a.$clevertapId ? { objectId: a.$clevertapId } : { identity: e.appUserId }), ts: secs(e), type: "event", evtName: charged ? "Charged" : eventName(e),
      evtData: charged ? { Amount: amount(e), Currency: e.currency, "Charged ID": e.transactionId ?? e.id, Items: [{ ProductId: e.productId, Store: e.store }] } : props(e) }] },
  };
}

/** Airship custom events. POST https://go.urbanairship.com/api/custom-events (EU: go.airship.eu), Bearer token + X-UA-Appkey (required),
 * 1..100 events per request, lowercase event names (https://www.airship.com/docs/developer/rest-api/ua/operations/custom-events/). */
export interface AirshipCfg { appKey: string; token: string; region?: "us" | "eu" }
export function buildAirship(cfg: AirshipCfg, e: any, a: Attrs): Req {
  const host = cfg.region === "eu" ? "https://go.airship.eu" : "https://go.urbanairship.com";
  const user = a.$airshipChannelId ? { channel: a.$airshipChannelId } : { named_user_id: e.appUserId };
  return {
    url: `${host}/api/custom-events`, headers: { Authorization: `Bearer ${cfg.token}`, "X-UA-Appkey": cfg.appKey, Accept: "application/vnd.urbanairship+json; version=3" },
    body: [{ occurred: iso(e).slice(0, 19), user, body: clean({ name: eventName(e), value: amount(e) || undefined, transaction: e.transactionId ?? e.id, properties: props(e) }) }],
  };
}

/** Intercom data events (POST /events). Contact attributes are updated separately (see sendIntercom). */
/** Latest stable REST version (https://developers.intercom.com/docs/references/rest-api/api.intercom.io/data-events/createdataevent). Max 10 metadata keys. */
export const INTERCOM_VERSION = "2.16";
export interface IntercomCfg { accessToken: string; region?: "us" | "eu" | "au" }
export const intercomHost = (cfg: IntercomCfg) => (cfg.region === "eu" ? "https://api.eu.intercom.io" : cfg.region === "au" ? "https://api.au.intercom.io" : "https://api.intercom.io");
export function buildIntercomEvent(cfg: IntercomCfg, e: any, a: Attrs): Req {
  return {
    url: `${intercomHost(cfg)}/events`, headers: { Authorization: `Bearer ${cfg.accessToken}`, "Intercom-Version": INTERCOM_VERSION, Accept: "application/json" },
    body: clean({ event_name: eventName(e), created_at: secs(e), user_id: a.$intercomId ?? e.appUserId, metadata: { product_id: e.productId, store: e.store, price: amount(e), currency: e.currency } }),
  };
}
export const intercomAttributes = (e: any) => ({ mm_last_event: e.type, mm_product_id: e.productId, mm_is_subscriber: !["EXPIRATION", "REFUND", "REVOKED"].includes(e.type) });

/** Firebase / GA4 Measurement Protocol for apps. POST /mp/collect?firebase_app_id=&api_secret= */
export interface Ga4Cfg { firebaseAppId: string; apiSecret: string; androidFirebaseAppId?: string }
export function buildGa4(cfg: Ga4Cfg, e: any, a: Attrs): Req | null {
  if (!a.$firebaseAppInstanceId) return null;
  const appId = platformOf(e) === "android" && cfg.androidFirebaseAppId ? cfg.androidFirebaseAppId : cfg.firebaseAppId;
  const rev = amount(e);
  const ev = rev
    ? { name: "purchase", params: { currency: e.currency, value: rev, transaction_id: e.transactionId ?? e.id, items: [{ item_id: e.productId, item_name: e.productId, price: rev, quantity: 1 }], mm_event: e.type } }
    : e.type === "REFUND" ? { name: "refund", params: clean({ currency: e.currency, value: Number(e.priceMicros ?? 0) / 1e6, transaction_id: e.transactionId ?? e.id }) }
    : { name: eventName(e), params: clean({ product_id: e.productId, store: e.store, is_trial: e.isTrial ? 1 : 0 }) };
  return {
    url: `https://www.google-analytics.com/mp/collect?firebase_app_id=${encodeURIComponent(appId)}&api_secret=${encodeURIComponent(cfg.apiSecret)}`,
    body: { app_instance_id: a.$firebaseAppInstanceId, user_id: e.appUserId, timestamp_micros: Number(e.at ?? Date.now()) * 1000, events: [ev] },
  };
}

/** mParticle server-to-server events API. POST https://s2s.{pod}.mparticle.com/v2/events, Basic key:secret. */
export interface MParticleCfg { apiKey: string; apiSecret: string; pod?: "us1" | "us2" | "eu1" | "au1" }
export function buildMParticle(cfg: MParticleCfg, e: any, a: Attrs): Req {
  const host = cfg.pod ? `https://s2s.${cfg.pod}.mparticle.com` : "https://s2s.mparticle.com";
  return {
    url: `${host}/v2/events`, headers: { Authorization: basic(cfg.apiKey, cfg.apiSecret) },
    body: clean({
      schema_version: 2, environment: e.isSandbox ? "development" : "production", ip: a.$ip,
      user_identities: { customer_id: e.appUserId, email: a.$email },
      ...(a.$mparticleId ? { mpid: a.$mparticleId } : {}),
      device_info: clean({ ios_advertising_id: a.$idfa, ios_idfv: a.$idfv, android_advertising_id: a.$gpsAdId }),
      events: [{ event_type: "custom_event", data: { event_name: eventName(e), custom_event_type: "transaction", timestamp_unixtime_ms: Number(e.at ?? Date.now()), custom_attributes: Object.fromEntries(Object.entries(props(e)).map(([k, v]) => [k, String(v)])) } }],
    }),
  };
}

/** Statsig log_event. POST https://events.statsigapi.net/v1/log_event, header statsig-api-key (server secret) + STATSIG-CLIENT-TIME;
 * `value` is a string (https://docs.statsig.com/api-reference/events/log-custom-events). */
export interface StatsigCfg { serverSecret: string }
export function buildStatsig(cfg: StatsigCfg, e: any): Req {
  return {
    url: "https://events.statsigapi.net/v1/log_event", headers: { "statsig-api-key": cfg.serverSecret, "STATSIG-CLIENT-TIME": String(Date.now()) },
    body: { events: [{ eventName: eventName(e), user: { userID: e.appUserId, country: e.country ?? undefined }, value: String(amount(e) || e.productId), time: Number(e.at ?? Date.now()),
      metadata: Object.fromEntries(Object.entries(props(e)).map(([k, v]) => [k, String(v)])) }] },
  };
}

/** TelemetryDeck ingestion v2. POST https://nom.telemetrydeck.com/v2/namespace/{namespace}/ (or /v2/ without namespace);
 * clientUser hashed, isTestMode boolean, floatValue top-level number, flat payload (https://telemetrydeck.com/docs/ingest/v2/). */
export interface TelemetryDeckCfg { appId: string; namespace?: string }
export function buildTelemetryDeck(cfg: TelemetryDeckCfg, e: any): Req {
  return {
    url: cfg.namespace ? `https://nom.telemetrydeck.com/v2/namespace/${encodeURIComponent(cfg.namespace)}/` : "https://nom.telemetrydeck.com/v2/",
    body: [{ appID: cfg.appId, clientUser: createHash("sha256").update(String(e.appUserId)).digest("hex"), type: `MoneyMaker.${e.type}`, isTestMode: Boolean(e.isSandbox), ...(amount(e) ? { floatValue: amount(e) } : {}),
      payload: clean({ productId: e.productId, store: e.store, price: amount(e), currency: e.currency, country: e.country ?? undefined }) }],
  };
}

// ───────────────────────────── Apple Search Ads (AdServices) ─────────────────────────────

/** Apple AdServices attribution: POST the token (text/plain) to api-adservices.apple.com/api/v1/. */
export const APPLE_ADS_URL = "https://api-adservices.apple.com/api/v1/";
export function parseAppleAds(json: any) {
  if (!json || json.attribution !== true) return { attribution: false };
  const pick = ["orgId", "campaignId", "adGroupId", "keywordId", "adId", "conversionType", "countryOrRegion", "clickDate", "claimType"];
  return clean({ attribution: true, ...Object.fromEntries(pick.map(k => [k, json[k]])) });
}
