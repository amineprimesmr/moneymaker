// Trusted entitlements: Ed25519 signatures over customer-info responses.
// Message signed: `${nonce}.${requestTimeMs}.${sha256hex(body)}` → header `X-MoneyMaker-Signature: v1=<base64 sig>`.
// Pure crypto helpers (unit-tested) + a lazy key loader (env MM_SIGNING_KEY, else Firestore `system/signing`).
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, KeyObject } from "crypto";

export const SIGNATURE_HEADER = "X-MoneyMaker-Signature";
export const REQUEST_TIME_HEADER = "X-Request-Time";
export const NONCE_HEADER = "X-Nonce";

// DER prefixes to wrap raw 32-byte Ed25519 keys (RFC 8410).
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface SigningKey { privateKey: KeyObject; publicKeyRaw: string /* base64 raw 32 bytes */ }

export const bodyHash = (body: string | Buffer) => createHash("sha256").update(body).digest("hex");
export const signedMessage = (nonce: string, requestTimeMs: number | string, body: string | Buffer) =>
  `${nonce}.${requestTimeMs}.${bodyHash(body)}`;

/** Generates a new key pair. `privateKey` is base64 PKCS8 DER, `publicKey` base64 raw (32 bytes). */
export function generateSigningKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), publicKey: rawPublicKey(publicKey) };
}

export function rawPublicKey(key: KeyObject): string {
  const der = (key.type === "private" ? createPublicKey(key) : key).export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32).toString("base64");
}

/** Accepts PEM, base64 PKCS8 DER, or base64 raw 32-byte seed. */
export function parsePrivateKey(input: string): KeyObject {
  const s = input.trim();
  if (s.includes("BEGIN")) return createPrivateKey(s);
  const buf = Buffer.from(s, "base64");
  if (buf.length === 32) return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, buf]), format: "der", type: "pkcs8" });
  return createPrivateKey({ key: buf, format: "der", type: "pkcs8" });
}

export function publicKeyFromRaw(rawB64: string): KeyObject {
  const raw = Buffer.from(rawB64, "base64");
  if (raw.length !== 32) throw new Error("invalid_public_key");
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export function signResponse(privateKey: KeyObject, nonce: string, requestTimeMs: number, body: string | Buffer): string {
  return "v1=" + sign(null, Buffer.from(signedMessage(nonce, requestTimeMs, body)), privateKey).toString("base64");
}

/** Verifies a `v1=<sig>` header value against a raw base64 public key. Never throws. */
export function verifyResponse(publicKeyRaw: string, header: string | undefined | null, nonce: string, requestTimeMs: number | string, body: string | Buffer): boolean {
  try {
    const m = /^v1=([A-Za-z0-9+/=]+)$/.exec(String(header ?? "").trim());
    if (!m) return false;
    return verify(null, Buffer.from(signedMessage(nonce, requestTimeMs, body)), publicKeyFromRaw(publicKeyRaw), Buffer.from(m[1], "base64"));
  } catch { return false; }
}

let cached: Promise<SigningKey> | null = null;

/** Lazily loads the signing key: MM_SIGNING_KEY env, else Firestore `system/signing` (created on first use, server-only). */
export function getSigningKey(): Promise<SigningKey> {
  if (!cached) cached = loadSigningKey().catch(e => { cached = null; throw e; });
  return cached;
}

async function loadSigningKey(): Promise<SigningKey> {
  if (process.env.MM_SIGNING_KEY) {
    const privateKey = parsePrivateKey(process.env.MM_SIGNING_KEY);
    return { privateKey, publicKeyRaw: rawPublicKey(privateKey) };
  }
  const { db } = await import("./store");
  const ref = db.doc("system/signing");
  let snap = await ref.get();
  if (!snap.exists) {
    const kp = generateSigningKeyPair();
    // create() fails if another instance won the race → re-read theirs.
    await ref.create({ algorithm: "Ed25519", privateKey: kp.privateKey, publicKey: kp.publicKey, createdAt: Date.now() }).catch(() => null);
    snap = await ref.get();
  }
  const privateKey = parsePrivateKey(String(snap.get("privateKey")));
  return { privateKey, publicKeyRaw: rawPublicKey(privateKey) };
}
