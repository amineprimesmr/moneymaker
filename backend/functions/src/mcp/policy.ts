// Règles OAuth du connecteur MCP (pures, testées) : redirections autorisées, scopes, PKCE.
import { createHash, randomBytes, timingSafeEqual } from "crypto";

export const ORIGIN = (process.env.MONEYMAKER_PUBLIC_BASE ?? "https://moneymaker-io.web.app").replace(/\/$/, "");
export const RESOURCE = `${ORIGIN}/mcp`;
export const SCOPES = ["moneymaker:read", "moneymaker:write"] as const;
export type Scope = typeof SCOPES[number];
/** Préfixe des jetons d'accès OAuth : reconnus par authenticate() comme une session utilisateur. */
export const ACCESS_PREFIX = "mm_oat_";

export const opaque = () => randomBytes(32).toString("base64url");
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function scopes(value: unknown): Scope[] {
  if (typeof value !== "string") throw new Error("invalid_scope");
  // Les clients ajoutent parfois des scopes génériques (Claude : offline_access) ; le refresh est toujours émis.
  const values = [...new Set(value.split(" ").filter(s => s && !["offline_access", "openid", "profile", "email"].includes(s)))];
  if (!values.length || values.some(s => !(SCOPES as readonly string[]).includes(s))) throw new Error("invalid_scope");
  return values as Scope[];
}

export const HOSTED_CLIENTS = ["chatgpt.com", "chat.openai.com", "claude.ai", "claude.com"];
/** Redirection loopback RFC 8252 (Claude Code, Codex, Cursor…) : http sur localhost/127.0.0.1, port libre. */
export function loopback(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname) && !u.username && !u.password && !u.hash;
  } catch { return false; }
}
export function redirectAllowed(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  if (loopback(value)) return true;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !u.hash && !u.port && HOSTED_CLIENTS.includes(u.hostname);
  } catch { return false; }
}
/** Égalité stricte, sauf le port des redirections loopback qui change à chaque session (RFC 8252 §7.3). */
export function redirectMatches(registered: string, requested: unknown): boolean {
  if (typeof requested !== "string" || !redirectAllowed(requested)) return false;
  if (registered === requested) return true;
  if (!loopback(registered) || !loopback(requested)) return false;
  const a = new URL(registered), b = new URL(requested);
  return a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
}
/** Nom affiché sur l'écran de consentement : déduit de la redirection, jamais du nom déclaré par un site tiers. */
export function clientName(redirect: string, declared: unknown): string {
  const host = new URL(redirect).hostname;
  if (host === "claude.ai" || host === "claude.com") return "Claude";
  if (loopback(redirect)) {
    const d = typeof declared === "string" ? declared : "";
    return /claude/i.test(d) ? "Claude Code" : /codex|openai/i.test(d) ? "Codex" : /cursor/i.test(d) ? "Cursor" : "App locale";
  }
  return "ChatGPT";
}
export function pkce(verifier: unknown, challenge: string): boolean {
  return typeof verifier === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) &&
    equal(createHash("sha256").update(verifier).digest("base64url"), challenge);
}
export function safeID(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
}
