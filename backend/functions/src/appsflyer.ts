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
  const appId = event.store === "play_store" ? cfg.androidAppId : cfg.appId;
  if (!appId) return "no_app_id";
  const value: Record<string, unknown> = { af_content_id: event.productId, store: event.store };
  if (REVENUE.has(event.type) && !event.isTrial && event.priceMicros > 0) {
    value.af_revenue = (event.priceMicros / 1e6).toFixed(2);
    value.af_currency = event.currency;
  }
  const res = await fetch(`https://api2.appsflyer.com/inappevent/${encodeURIComponent(appId)}`, {
    method: "POST", signal: AbortSignal.timeout(10000),
    headers: { "Content-Type": "application/json", authentication: creds.appsflyer.devKey },
    body: JSON.stringify({
      appsflyer_id: afId, customer_user_id: event.appUserId, eventName: name, eventValue: JSON.stringify(value),
      eventTime: new Date(event.at).toISOString().replace("T", " ").slice(0, 23),
      ...(customer.attributes?.$idfa ? { idfa: customer.attributes.$idfa } : {}),
      ...(customer.attributes?.$idfv ? { idfv: customer.attributes.$idfv } : {}),
    }),
  });
  if (!res.ok) throw new Error(`AppsFlyer ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return "sent";
}
