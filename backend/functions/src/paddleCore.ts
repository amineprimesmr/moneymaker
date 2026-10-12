// Paddle Billing — pure helpers (no Firestore) so they stay unit-testable.
// Signature: header `Paddle-Signature: ts=<unix>;h1=<hex>` ; h1 = HMAC-SHA256(secret, `${ts}:${rawBody}`)
// (https://developer.paddle.com/webhooks/signature-verification). Several h1 may be present during rotation.
import { createHmac, timingSafeEqual } from "crypto";
import type { Purchase, PurchaseStatus } from "./engine";

export function verifyPaddleSignature(rawBody: Buffer | string, header: string | undefined, secret: string, now = Date.now(), toleranceSec = 300): boolean {
  if (!header || !secret) return false;
  let ts = "";
  const h1: string[] = [];
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "ts") ts = v; else if (k === "h1") h1.push(v);
  }
  if (!/^\d+$/.test(ts) || !h1.length) return false;
  if (toleranceSec > 0 && Math.abs(now / 1000 - Number(ts)) > toleranceSec) return false;
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected = createHmac("sha256", secret).update(`${ts}:${body}`).digest();
  return h1.some(sig => {
    if (!/^[0-9a-f]+$/i.test(sig)) return false;
    const got = Buffer.from(sig, "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

const ms = (iso: unknown) => (typeof iso === "string" && iso ? Date.parse(iso) : NaN);
const INTERVAL_MONTHS: Record<string, number> = { day: 1 / 30, week: 0.25, month: 1, year: 12 };
export const periodMonthsOf = (cycle: any) => cycle?.interval ? (INTERVAL_MONTHS[cycle.interval] ?? 0) * Number(cycle.frequency ?? 1) : 0;

export const PADDLE_USER_KEYS = ["app_user_id", "appUserId", "user_id", "userId", "uid"];
export function paddleAppUserId(customData: any): string | null {
  if (!customData || typeof customData !== "object") return null;
  for (const k of PADDLE_USER_KEYS) if (typeof customData[k] === "string" && customData[k].trim()) return customData[k].trim();
  return null;
}

const STATUS: Record<string, PurchaseStatus> = { active: "active", trialing: "active", past_due: "billing_retry", paused: "paused", canceled: "expired" };

/** Paddle Billing subscription entity → Purchase. */
export function paddleSubscriptionPurchase(s: any, now = Date.now()): Purchase {
  const item = s.items?.[0] ?? {};
  const price = item.price ?? {};
  const periodEnd = ms(s.current_billing_period?.ends_at);
  const canceledAt = ms(s.canceled_at);
  const status = STATUS[s.status] ?? "expired";
  const expiresAt = Number.isFinite(periodEnd) ? periodEnd : Number.isFinite(canceledAt) ? canceledAt : now;
  const unit = Number(price.unit_price?.amount ?? item.unit_price?.amount ?? 0); // minor units (string in Paddle)
  const started = ms(s.started_at) || ms(s.created_at) || now;
  const latest = ms(s.current_billing_period?.starts_at) || started;
  return {
    id: String(s.id), store: "paddle", productId: String(price.id ?? item.price_id ?? "paddle"), type: "subscription",
    status: status === "expired" && expiresAt > now && s.status !== "canceled" ? "active" : status,
    purchasedAt: started, latestPurchaseAt: latest, expiresAt: s.status === "canceled" ? Math.min(expiresAt, Number.isFinite(canceledAt) ? canceledAt : expiresAt) : expiresAt,
    willRenew: s.status !== "canceled" && s.scheduled_change?.action !== "cancel" && s.status !== "paused",
    isTrial: s.status === "trialing", isSandbox: false,
    priceMicros: Math.round(unit * Number(item.quantity ?? 1) * 10000), currency: String(s.currency_code ?? price.unit_price?.currency_code ?? "EUR").toUpperCase(),
    periodMonths: periodMonthsOf(s.billing_cycle ?? price.billing_cycle), billingIssue: s.status === "past_due",
    updatedAt: ms(s.updated_at) || now,
  };
}

/** Completed one-time transaction (no subscription_id) → non-consumable Purchase. */
export function paddleTransactionPurchase(t: any, now = Date.now()): Purchase {
  const price = t.items?.[0]?.price ?? {};
  const total = Number(t.details?.totals?.grand_total ?? t.details?.totals?.total ?? 0);
  const at = ms(t.billed_at) || ms(t.created_at) || now;
  return {
    id: String(t.id), store: "paddle", productId: String(price.id ?? "paddle_one_time"), type: "non_consumable", status: "active",
    purchasedAt: at, latestPurchaseAt: at, expiresAt: null, willRenew: false, isTrial: false, isSandbox: false,
    priceMicros: Math.round(total * 10000), currency: String(t.currency_code ?? "EUR").toUpperCase(), periodMonths: 0, billingIssue: false,
    updatedAt: ms(t.updated_at) || now, country: t.address?.country_code ?? null,
  };
}
