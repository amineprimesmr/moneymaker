// Monnaie virtuelle (pièces, crédits, gemmes…).
//
// Config : `config.virtualCurrencies: [{ code, name, grants: { productId: amount } }]`.
// Soldes : projects/{pid}/customers/{id}/wallet/{code} { code, balance, updatedAt }.
// Journal (idempotence) : projects/{pid}/customers/{id}/walletLedger/{key}.
//
// Crédit automatique dans la transaction d'upsertPurchase (store.ts) sur INITIAL_PURCHASE / RENEWAL /
// NON_RENEWING_PURCHASE (et TRIAL_CONVERTED, premier paiement réel) d'un produit mappé ; débit sur REFUND.
// Clé d'idempotence = magasin + id d'achat + date du paiement : une notification rejouée ne crédite jamais deux fois.

import { createHash } from "crypto";
import type { Transaction } from "firebase-admin/firestore";
import type { Purchase } from "./engine";

export interface VirtualCurrency { code: string; name: string; grants: Record<string, number> }
export interface WalletOp { key: string; code: string; amount: number; reason: "purchase" | "refund"; productId: string; purchaseId: string }

const bad = (code: string) => { throw new Error(code); };

export function sanitizeVirtualCurrencies(input: any): VirtualCurrency[] {
  if (!Array.isArray(input) || input.length > 20) bad("invalid_virtual_currencies");
  const seen = new Set<string>();
  return input.map((c: any) => {
    const code = String(c?.code ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9_]{1,16}$/.test(code)) bad("invalid_currency_code");
    if (seen.has(code)) bad("duplicate_currency_code");
    seen.add(code);
    const name = String(c?.name ?? "").trim();
    if (!name || name.length > 60) bad("invalid_currency_name");
    const grants = c?.grants ?? {};
    if (typeof grants !== "object" || Array.isArray(grants) || Object.keys(grants).length > 100) bad("invalid_currency_grants");
    const clean: Record<string, number> = {};
    for (const [pid, v] of Object.entries(grants)) {
      const n = Number(v);
      if (!pid || pid.length > 200 || !Number.isInteger(n) || n <= 0 || n > 1e9) bad("invalid_currency_grants");
      clean[pid] = n;
    }
    return { code, name, grants: clean };
  });
}

const CREDIT_EVENTS = ["INITIAL_PURCHASE", "RENEWAL", "NON_RENEWING_PURCHASE", "TRIAL_CONVERTED"];

/** Pure : opérations de portefeuille déclenchées par les événements d'un achat. */
export function walletOpsFor(currencies: VirtualCurrency[] | undefined, purchase: Purchase, events: string[]): WalletOp[] {
  if (!currencies?.length || purchase.store === "promotional") return [];
  const credit = events.some(e => CREDIT_EVENTS.includes(e)) && !purchase.isTrial;
  const refund = events.includes("REFUND");
  const ops: WalletOp[] = [];
  for (const c of currencies) {
    const amount = c.grants[purchase.productId];
    if (!amount) continue;
    const base = `${purchase.store}:${purchase.id}:${purchase.latestPurchaseAt}:${c.code}`;
    if (credit) ops.push({ key: ledgerKey(`${base}:grant`), code: c.code, amount, reason: "purchase", productId: purchase.productId, purchaseId: purchase.id });
    if (refund) ops.push({ key: ledgerKey(`${base}:refund`), code: c.code, amount: -amount, reason: "refund", productId: purchase.productId, purchaseId: purchase.id });
  }
  return ops;
}

export const ledgerKey = (raw: string) => createHash("sha256").update(raw).digest("hex").slice(0, 40);

export function parseAmount(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 1e9) bad("invalid_amount");
  return n;
}

export function parseIdempotencyKey(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9_.:-]{8,128}$/.test(v)) bad("invalid_idempotency_key");
  return v as string;
}

/** Pure : vérifie qu'une dépense est possible. */
export function canSpend(balance: number, amount: number) { return Number.isFinite(balance) && balance >= amount; }

// ── Firestore ────────────────────────────────────────────────────────────────

/** À appeler dans la transaction d'upsertPurchase, après toutes les autres lectures et avant les écritures. */
export async function readWalletOps(tx: Transaction, customerRef: FirebaseFirestore.DocumentReference, ops: WalletOp[]) {
  if (!ops.length) return [] as WalletOp[];
  const snaps = await Promise.all(ops.map(o => tx.get(customerRef.collection("walletLedger").doc(o.key))));
  return ops.filter((_, i) => !snaps[i].exists);
}

export function writeWalletOps(tx: Transaction, customerRef: FirebaseFirestore.DocumentReference, ops: WalletOp[], now: number) {
  const { FieldValue } = require("firebase-admin/firestore") as typeof import("firebase-admin/firestore");
  for (const o of ops) {
    tx.set(customerRef.collection("walletLedger").doc(o.key), { ...o, at: now });
    tx.set(customerRef.collection("wallet").doc(o.code), { code: o.code, balance: FieldValue.increment(o.amount), updatedAt: now }, { merge: true });
  }
}

export async function readWallet(projectId: string, appUserId: string, currencies: VirtualCurrency[] = []) {
  const { db } = await import("./store");
  const snap = await db.collection(`projects/${projectId}/customers/${appUserId}/wallet`).get();
  const balances = new Map(snap.docs.map(d => [d.id, Number(d.get("balance") ?? 0)]));
  const codes = [...new Set([...currencies.map(c => c.code), ...balances.keys()])];
  return {
    appUserId,
    virtualCurrencies: Object.fromEntries(codes.map(code => [code, { code, name: currencies.find(c => c.code === code)?.name ?? code, balance: balances.get(code) ?? 0 }])),
  };
}

/** Débit (spend) ou crédit (grant) manuel, idempotent sur `idempotencyKey`. */
export async function moveWallet(projectId: string, appUserId: string, code: string, amount: number, kind: "spend" | "grant", idempotencyKey: string | undefined, reason?: string) {
  const { db } = await import("./store");
  const { FieldValue } = await import("firebase-admin/firestore");
  const customerRef = db.doc(`projects/${projectId}/customers/${appUserId}`);
  const walletRef = customerRef.collection("wallet").doc(code);
  const key = idempotencyKey ? ledgerKey(`${kind}:${idempotencyKey}`) : customerRef.collection("walletLedger").doc().id;
  const ledgerRef = customerRef.collection("walletLedger").doc(key);
  return db.runTransaction(async tx => {
    const [led, w] = await Promise.all([tx.get(ledgerRef), tx.get(walletRef)]);
    const balance = Number(w.get("balance") ?? 0);
    if (led.exists) {
      const l = led.data()!;
      if (l.code !== code || Math.abs(l.amount) !== amount) bad("idempotency_key_reused");
      return { code, balance, replayed: true, transactionId: key };
    }
    if (kind === "spend" && !canSpend(balance, amount)) bad("insufficient_balance");
    const delta = kind === "spend" ? -amount : amount;
    tx.set(ledgerRef, { code, amount: delta, reason: reason ?? kind, at: Date.now(), ...(idempotencyKey ? { idempotencyKey } : {}) });
    tx.set(walletRef, { code, balance: FieldValue.increment(delta), updatedAt: Date.now() }, { merge: true });
    tx.set(customerRef, { appUserId }, { merge: true });
    return { code, balance: balance + delta, replayed: false, transactionId: key };
  });
}
