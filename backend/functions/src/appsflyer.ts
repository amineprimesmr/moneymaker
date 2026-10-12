import { Project, Credentials, db } from "./store";

/** Same event names as RevenueCat's AppsFlyer integration, so existing dashboards keep working. */
const EVENT_NAMES: Record<string, string> = {
  INITIAL_PURCHASE: "rc_initial_purchase_event", RENEWAL: "rc_renewal_event", TRIAL_STARTED: "rc_trial_started_event",
  TRIAL_CONVERTED: "rc_trial_converted_event", CANCELLATION: "rc_cancellation_event", UNCANCELLATION: "rc_uncancellation_event",
  EXPIRATION: "rc_expiration_event", BILLING_ISSUE: "rc_billing_issue_event", PRODUCT_CHANGE: "rc_product_change_event",
  NON_RENEWING_PURCHASE: "rc_non_subscription_purchase_event", REFUND: "rc_refund_event",
};
const REVENUE = new Set(["INITIAL_PURCHASE", "RENEWAL", "TRIAL_CONVERTED", "NON_RENEWING_PURCHASE"]);

/** Server-to-server in-app event. Returns a short status string for the event log. */
export async function sendToAppsFlyer(project: Project, creds: Credentials, event: Record<string, any>): Promise<string> {
  const cfg = project.config.integrations?.appsflyer;
  const name = EVENT_NAMES[event.type];
  if (!cfg?.appId || !creds.appsflyer?.devKey || !name || event.isSandbox) return "skipped";
  const customer = (await db.doc(`projects/${project.id}/customers/${event.appUserId}`).get()).data() ?? {};
  const afId = customer.attributes?.$appsflyerId;
  if (!afId) return "no_appsflyer_id";
  const android = event.store === "play_store";
  const rawId = android ? cfg.androidAppId : cfg.appId;
  if (!rawId) return "no_app_id";
  // iOS app ids must carry the "id" prefix, otherwise AppsFlyer answers 200 but drops the event.
  const appId = !android && /^\d+$/.test(String(rawId)) ? `id${rawId}` : String(rawId);
  const a = customer.attributes ?? {};
  const value: Record<string, unknown> = { af_content_id: event.productId, store: event.store };
  if (REVENUE.has(event.type) && !event.isTrial && event.priceMicros > 0) {
    value.af_revenue = (event.priceMicros / 1e6).toFixed(2);
    value.af_currency = event.currency;
  }
  // https://dev.appsflyer.com/hc/reference/s2s-events-api3-post — header `authentication`, eventValue is a JSON *string*, 1 KB max.
  const res = await fetch(`https://api3.appsflyer.com/inappevent/${encodeURIComponent(appId)}`, {
    method: "POST", signal: AbortSignal.timeout(10000),
    headers: { "Content-Type": "application/json", authentication: creds.appsflyer.devKey },
    body: JSON.stringify({
      appsflyer_id: afId, customer_user_id: event.appUserId, eventName: name, eventValue: JSON.stringify(value),
      eventTime: new Date(event.at).toISOString().replace("T", " ").slice(0, 23),
      ...(value.af_currency ? { eventCurrency: event.currency } : {}),
      ...(project.config.apple?.bundleId || project.config.google?.packageName ? { bundleIdentifier: android ? project.config.google?.packageName : project.config.apple?.bundleId } : {}),
      ...(a.$idfa ? { idfa: String(a.$idfa).toUpperCase() } : {}),
      ...(a.$idfv ? { idfv: String(a.$idfv).toUpperCase() } : {}),
      ...(a.$ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(a.$ip) ? { ip: a.$ip } : {}),
    }),
  });
  if (!res.ok) throw new Error(`AppsFlyer ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return "sent";
}
