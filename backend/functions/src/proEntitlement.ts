// Droit MoneyMaker Pro d'un compte, quel que soit l'endroit où il a été acheté.
//
// users/{uid}.proSources liste les achats actifs : "stripe" (dashboard web), "app_store" (app iPhone)
// ou "granted" (offert à la main). Pro est actif dès qu'une source l'est : un achat sur le web débloque
// l'iPhone et inversement, et le remboursement d'une source ne retire pas Pro si une autre reste.
// Les testeurs peuvent forcer l'affichage (proTesterOverride) sans toucher aux achats.
// users/{uid}.pro en est la copie calculée, lue partout ailleurs.

export type ProSource = "stripe" | "app_store" | "granted";
export interface ProGrant { since: number; ref?: string; environment?: string }
export type ProSources = Partial<Record<ProSource, ProGrant>>;
type UserDoc = Record<string, any> | undefined;

/** Sources actives. Les comptes d'avant les sources (pro + proChannel) sont relus pour ne perdre personne. */
export function proSources(u: UserDoc): ProSources {
  if (u?.proSources && typeof u.proSources === "object") return { ...u.proSources };
  if (u?.pro !== true || u.proTestToggledAt) return {};
  const since = typeof u.proSince === "number" ? u.proSince : 0;
  if (u.proOriginalTransactionId) return { app_store: { since, ref: String(u.proOriginalTransactionId) } };
  if (u.proPaymentIntent) return { stripe: { since, ref: String(u.proPaymentIntent) } };
  return { granted: { since } };
}

/** Forçage testeur (Réglages → Mode test). Avant les sources, la bascule écrivait directement pro. */
export function testerOverride(u: UserDoc): boolean | undefined {
  if (typeof u?.proTesterOverride === "boolean") return u.proTesterOverride;
  if (!u?.proSources && u?.proTestToggledAt) return u.pro === true;
  return undefined;
}

export function proState(u: UserDoc) {
  const sources = Object.keys(proSources(u)) as ProSource[];
  return { pro: testerOverride(u) ?? sources.length > 0, sources };
}

/** Sources après l'ajout (grant) ou le retrait (null) d'un achat. */
export function withSource(u: UserDoc, source: ProSource, grant: ProGrant | null): ProSources {
  const next = proSources(u);
  if (grant) next[source] = grant; else delete next[source];
  return next;
}

/** Champs à écrire sur users/{uid} : sources, forçage testeur et copie calculée de pro. */
export function proFields(sources: ProSources, override: boolean | undefined, now = Date.now()) {
  const fields: Record<string, unknown> = { proSources: sources, pro: proState({ proSources: sources, proTesterOverride: override }).pro, proUpdatedAt: now };
  if (override !== undefined) fields.proTesterOverride = override;
  return fields;
}

// ── Code cadeau (accès Pro offert) ─────────────────────────────────────────

/** Code tel qu'on le compare : sans espaces, en majuscules. null si la forme est impossible. */
export function normalizeGiftCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.replace(/\s+/g, "").toUpperCase();
  return /^[A-Z0-9][A-Z0-9_-]{5,39}$/.test(code) ? code : null;
}

/** Un coupon n'offre Pro que s'il retire 100 % du prix. */
export function isFullDiscount(coupon: { percent_off?: number | null; valid?: boolean } | null | undefined): boolean {
  return !!coupon && coupon.valid !== false && coupon.percent_off === 100;
}

export const GIFT_ATTEMPTS_PER_DAY = 10;
/** Compteur d'essais ratés du jour (users/{uid}.giftAttempts), pour empêcher de deviner un code. */
export function giftAttempts(u: UserDoc, day: string): number {
  return u?.giftAttempts?.day === day && typeof u.giftAttempts.n === "number" ? u.giftAttempts.n : 0;
}
