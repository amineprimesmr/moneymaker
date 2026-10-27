// Client du backend MoneyMaker (routes « ══ Stripe App ══ » de backend/functions/src/api.ts).
// Chaque requête porte : Stripe-Signature (fetchStripeSignature), X-Stripe-User-Id / X-Stripe-Account-Id
// (payload signé {user_id, account_id}) et Authorization: Bearer <clé mm_sk_ lue dans le Secret Store>.
import Stripe from "stripe";
import { createHttpClient, STRIPE_API_KEY } from "@stripe/ui-extension-sdk/http_client";
import fetchStripeSignature from "@stripe/ui-extension-sdk/signature";
import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";

export const SECRET_NAME = "moneymaker_secret_key";
const DEFAULT_API_BASE = "https://usemoneymaker.com/v1/stripe-app";

export const stripe = new Stripe(STRIPE_API_KEY, { httpClient: createHttpClient() as Stripe.HttpClient });

export const apiBase = (ctx: ExtensionContextValue): string => {
  const c = ctx.environment?.constants as { API_BASE?: string } | undefined;
  return c?.API_BASE ?? DEFAULT_API_BASE;
};

/** Portée « account » : la clé est partagée par tous les utilisateurs du compte Stripe. */
const scope = () => ({ type: "account" as const });

export async function readSecretKey(): Promise<string | null> {
  try {
    const s = await stripe.apps.secrets.find({ scope: scope(), name: SECRET_NAME, expand: ["payload"] });
    return s.payload ?? null;
  } catch {
    return null; // resource_missing : pas encore configurée
  }
}

export async function writeSecretKey(value: string): Promise<void> {
  await stripe.apps.secrets.create({ scope: scope(), name: SECRET_NAME, payload: value });
}

export async function deleteSecretKey(): Promise<void> {
  await stripe.apps.secrets.deleteWhere({ scope: scope(), name: SECRET_NAME });
}

export class MissingKeyError extends Error { constructor() { super("missing_key"); } }
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message || code); }
}

export async function mmFetch<T>(ctx: ExtensionContextValue, path: string, init: { method?: string; body?: unknown; key?: string } = {}): Promise<T> {
  const key = init.key ?? await readSecretKey();
  if (!key) throw new MissingKeyError();
  const userId = ctx.userContext?.id ?? "";
  const accountId = ctx.userContext?.account.id ?? "";
  const res = await fetch(`${apiBase(ctx)}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "Stripe-Signature": await fetchStripeSignature(),
      "X-Stripe-User-Id": userId,
      "X-Stripe-Account-Id": accountId,
      Authorization: `Bearer ${key}`,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify({ ...(init.body as object), user_id: userId, account_id: accountId }) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.error ?? "http_error", json.message ?? `HTTP ${res.status}`);
  return json as T;
}

// ── Types des réponses ────────────────────────────────────────────────────
export interface ProjectRef { id: string; name: string; currency: string }
export interface Entitlement { id: string; active: boolean; expiresAt: number | null; productId?: string; store?: string; willRenew?: boolean; isTrial?: boolean }
export interface PurchaseRow { id: string; store: string; productId: string; type: string; status: string; active: boolean; purchasedAt: number; expiresAt: number | null; willRenew: boolean; isTrial: boolean; isSandbox: boolean; billingIssue: boolean }
export interface EventRow { id: string; type: string; store: string; productId: string; priceMicros: number | null; currency: string | null; isSandbox: boolean; at: number }
interface CustomerBase { project: ProjectRef; stripeCustomerId: string; entitlementIds: string[]; grantDays: (number | null)[]; dashboardUrl: string }
export type CustomerResponse =
  | (CustomerBase & { linked: false })
  | (CustomerBase & {
    linked: true; appUserId: string; entitlements: Entitlement[]; activeEntitlements: string[]; purchases: PurchaseRow[]; stores: string[];
    totalSpentMicros: number; isPaying: boolean; firstSeenAt: number | null; lastSeenAt: number | null; country: string | null;
    attributes: Record<string, { value?: string } | string>; events: EventRow[];
  });
export interface OverviewResponse {
  project: ProjectRef; accountId: string; dashboardUrl: string;
  mrrMicros: number; revenue28dMicros: number; netRevenue28dMicros: number; previousRevenue28dMicros: number | null;
  activeSubscriptions: number; activeTrials: number; activeCustomers: number; newCustomers28d: number; trialConversionRate: number | null;
  byStore: Record<string, { mrrMicros: number; active: number }>; revenueByStore: Record<string, number>; generatedAt: number;
}
