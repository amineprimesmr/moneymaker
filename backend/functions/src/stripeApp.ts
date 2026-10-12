// ══ Stripe App ══ — vérification des requêtes signées par l'app MoneyMaker du Dashboard Stripe.
//
// L'extension UI appelle `fetchStripeSignature()` (@stripe/ui-extension-sdk/utils) et envoie :
//   Stripe-Signature: t=<unix>,v1=<hex>        (HMAC-SHA256 de "<t>.<payload>" avec le secret de signature de l'app)
//   X-Stripe-User-Id / X-Stripe-Account-Id     (le payload signé est exactement JSON.stringify({ user_id, account_id }))
// Même schéma que les webhooks Stripe (stripe.webhooks.signature.verifyHeader) : réimplémenté ici sans dépendance
// pour être testé unitairement (tests/stripeApp.test.cjs).
//
// Secret de signature (absec_…, Dashboard Stripe › Apps › MoneyMaker › ⋯ › Clé secrète de signature) :
//   - variable d'environnement STRIPE_APP_SECRET (plusieurs secrets séparés par des virgules pendant une rotation), ou
//   - document Firestore system/stripeApp { signingSecret: "absec_…" } (ou signingSecrets: [...]).
import { createHmac, timingSafeEqual } from "crypto";

export const STRIPE_APP_TOLERANCE_SECONDS = 300;

/** Payload signé par défaut par fetchStripeSignature() : l'ordre des clés compte (user_id puis account_id). */
export function stripeAppPayload(userId: string, accountId: string): string {
  return JSON.stringify({ user_id: userId, account_id: accountId });
}

export function parseSignatureHeader(header: string | undefined | null): { timestamp: number; signatures: string[] } | null {
  if (!header || typeof header !== "string") return null;
  let timestamp = NaN;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t") timestamp = Number(v);
    else if (k === "v1" && v) signatures.push(v);
  }
  if (!Number.isFinite(timestamp) || !signatures.length) return null;
  return { timestamp, signatures };
}

/** Signature v1 d'un payload (utile aux tests et au debug). */
export function computeStripeSignature(payload: string, secret: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
}

export type StripeAppVerifyResult = { ok: true } | { ok: false; reason: "missing_header" | "malformed_header" | "no_secret" | "timestamp_out_of_tolerance" | "signature_mismatch" };

/** Vérifie un en-tête Stripe-Signature contre un ou plusieurs secrets (rotation), à temps constant. */
export function verifyStripeAppSignature(
  header: string | undefined | null, payload: string, secrets: string[],
  opts: { tolerance?: number; now?: number } = {},
): StripeAppVerifyResult {
  if (!header) return { ok: false, reason: "missing_header" };
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, reason: "malformed_header" };
  const valid = secrets.filter(s => typeof s === "string" && s.length > 0);
  if (!valid.length) return { ok: false, reason: "no_secret" };
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const tolerance = opts.tolerance ?? STRIPE_APP_TOLERANCE_SECONDS;
  if (tolerance > 0 && Math.abs(now - parsed.timestamp) > tolerance) return { ok: false, reason: "timestamp_out_of_tolerance" };
  for (const secret of valid) {
    const expected = Buffer.from(computeStripeSignature(payload, secret, parsed.timestamp), "hex");
    for (const sig of parsed.signatures) {
      const got = Buffer.from(sig, "hex");
      if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true };
    }
  }
  return { ok: false, reason: "signature_mismatch" };
}

/** Durées proposées par le bouton « Offrir un accès » (jours ; null = à vie). */
export const STRIPE_APP_GRANT_DAYS = [3, 7, 14, 30, 90, 180, 365, null] as const;

export function parseGrantDays(input: unknown): number | null | undefined {
  if (input === null || input === "lifetime") return null;
  const n = Number(input);
  return (STRIPE_APP_GRANT_DAYS as readonly (number | null)[]).includes(n) ? n : undefined;
}

export const isStripeCustomerId = (s: string) => /^cus_[A-Za-z0-9]{6,64}$/.test(s);
