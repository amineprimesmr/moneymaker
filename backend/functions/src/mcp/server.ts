// Connecteur MCP distant (Streamable HTTP, sans état, réponses JSON) + découverte OAuth.
// Routes : POST /mcp, GET /.well-known/oauth-{authorization-server,protected-resource}, /oauth/*.
// Les outils passent par dispatch() : la requête traverse le routeur /v1 comme un appel REST normal.
import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { HttpError } from "../engine";
import { resolveKey } from "../store";
import { ORIGIN, ACCESS_PREFIX } from "./policy";
import { authorizationMetadata, resourceMetadata, rateLimit, register, beginAuthorization, previewRequest, firebaseUser, approve, exchange,
  resolveAccessToken, revokeToken, listGrants, revokeGrant } from "./oauth";
import { TOOLS, toolList, needsConfirm, Call } from "./tools";

export type Dispatch = (method: string, path: string, opts: { query?: Record<string, unknown>; body?: unknown; authorization: string; ip?: string })
  => Promise<{ status: number; body: any }>;

const SERVER = { name: "moneymaker", title: "MoneyMaker", version: "2.0.0", websiteUrl: `${ORIGIN}/mcp-docs` };
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const ALLOWED_ORIGINS = [ORIGIN, "https://moneymaker-io.firebaseapp.com", "https://claude.ai", "https://claude.com", "https://chatgpt.com", "https://chat.openai.com"];
const MAX_TEXT = 300_000;
const INSTRUCTIONS = [
  "Données de revenus et d'abonnements MoneyMaker de l'utilisateur (apps iOS/Android/web).",
  "Commence par list_projects (ou get_overview pour tout voir d'un coup) ; la plupart des outils demandent un projectId.",
  "Montants en micro-unités : diviser les champs …Micros par 1 000 000. Dates en millisecondes Unix.",
  "Les champs …En sont la version anglaise d'un libellé ; réponds dans la langue de l'utilisateur.",
  "Écritures : décris le changement et obtiens l'accord de l'utilisateur avant d'appeler un outil d'écriture. Les suppressions exigent confirm=true après accord explicite.",
  "Pour update_project et update_offerings, lis la configuration actuelle d'abord : chaque champ envoyé remplace la valeur entière.",
].join("\n");

export const isMcpPath = (path: string) => path === "/mcp" || path.startsWith("/.well-known/oauth-") || path.startsWith("/oauth/");

export interface Identity { authorization: string; write: boolean }

/** Accepte un jeton OAuth (mm_oat_…) ou un jeton personnel (mm_pat_…, secours sans OAuth). */
async function identify(header?: string): Promise<Identity> {
  const raw = (header ?? "").replace(/^Bearer\s+/i, "").trim();
  if (raw.startsWith(ACCESS_PREFIX)) {
    const t = await resolveAccessToken(raw);
    if (t) return { authorization: `Bearer ${raw}`, write: t.scopes.includes("moneymaker:write") };
  } else if (raw.startsWith("mm_pat_")) {
    const rec = await resolveKey(raw);
    if (rec?.kind === "pat") return { authorization: `Bearer ${raw}`, write: true };
  }
  throw new HttpError(401, "invalid_token");
}

function text(out: unknown) {
  const s = typeof out === "string" ? out : JSON.stringify(out, null, 1);
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n… (réponse tronquée : réduis la période ou le limit)` : s;
}

async function callTool(id: Identity, params: any, dispatch: Dispatch, ip?: string) {
  const tool = TOOLS.find(t => t.name === params?.name);
  if (!tool) throw Object.assign(new Error(`Outil inconnu : ${params?.name}`), { code: -32602 });
  if (tool.write && !id.write) return { content: [{ type: "text", text: "Cette connexion est en lecture seule : reconnecte MoneyMaker en autorisant la modification." }], isError: true };
  const args = params.arguments ?? {};
  for (const r of tool.required ?? []) if (args[r] === undefined || args[r] === "") return { content: [{ type: "text", text: `Paramètre requis : ${r}` }], isError: true };
  if (tool.destructive && args.confirm !== true) return { content: [{ type: "text", text: text(needsConfirm(`${tool.title} (${JSON.stringify(args)})`)) }] };
  const call: Call = async (method, path, opts = {}) => {
    const query = Object.fromEntries(Object.entries(opts.query ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, String(v)]));
    const body = opts.body && typeof opts.body === "object" ? JSON.parse(JSON.stringify(opts.body)) : opts.body;
    const r = await dispatch(method, path, { query, body, authorization: id.authorization, ip });
    if (r.status >= 400) {
      const e = r.body ?? {};
      throw new Error(`HTTP ${r.status} ${e.error ?? "error"}${e.message && e.message !== e.error ? ` : ${e.message}` : ""}`);
    }
    return r.body;
  };
  try {
    const out = await tool.run(args, call);
    const structured = out && typeof out === "object" && !Array.isArray(out) ? out : undefined;
    return { content: [{ type: "text", text: text(out ?? { ok: true }) }], ...(structured && JSON.stringify(structured).length <= MAX_TEXT ? { structuredContent: structured } : {}) };
  } catch (e) {
    return { content: [{ type: "text", text: (e as Error).message }], isError: true };
  }
}

export async function rpc(msg: any, id: Identity, dispatch: Dispatch, ip?: string): Promise<unknown | undefined> {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
  if (msg.id === undefined) return undefined; // notification (notifications/initialized, cancelled…)
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  try {
    switch (msg.method) {
      case "initialize": {
        const asked = msg.params?.protocolVersion;
        return ok({ protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: INSTRUCTIONS });
      }
      case "ping": return ok({});
      case "tools/list": return ok({ tools: toolList(id.write) });
      case "tools/call": return ok(await callTool(id, msg.params, dispatch, ip));
      case "resources/list": return ok({ resources: [] });
      case "resources/templates/list": return ok({ resourceTemplates: [] });
      case "prompts/list": return ok({ prompts: [] });
      default: return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Méthode inconnue : ${msg.method}` } };
    }
  } catch (e) {
    return { jsonrpc: "2.0", id: msg.id, error: { code: (e as any).code ?? -32603, message: (e as Error).message } };
  }
}

/** Point d'entrée HTTP, appelé par handle() de l'API pour les chemins isMcpPath(). */
export async function handleMcp(req: Request, res: Response, path: string, dispatch: Dispatch) {
  res.set("Cache-Control", "no-store");
  const origin = req.get("origin");
  if (origin && !ALLOWED_ORIGINS.includes(origin)) { res.status(403).json({ error: "invalid_origin" }); return; }
  res.set("Access-Control-Allow-Origin", origin ?? "*"); res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID");
  res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.set("Access-Control-Expose-Headers", "WWW-Authenticate, MCP-Session-Id");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  const ip = req.ip ?? "unknown";
  try {
    if ((req.rawBody?.length ?? 0) > 256 * 1024) throw new HttpError(413, "request_too_large");
    if (path === "/.well-known/oauth-authorization-server" && req.method === "GET") { res.json(authorizationMetadata); return; }
    if (path.startsWith("/.well-known/oauth-protected-resource") && req.method === "GET") { res.json(resourceMetadata); return; }
    if (path === "/mcp") {
      if (req.method !== "POST") { res.set("Allow", "POST"); res.status(405).json({ error: "method_not_allowed" }); return; }
      const id = await identify(req.get("authorization"));
      await rateLimit(`mcp:${id.authorization.slice(-16)}`, 120);
      const body = req.body;
      if (Array.isArray(body)) {
        const out = (await Promise.all(body.map(m => rpc(m, id, dispatch, ip)))).filter(Boolean);
        if (!out.length) { res.status(202).send(""); return; }
        res.status(200).json(out); return;
      }
      const out = await rpc(body, id, dispatch, ip);
      if (out === undefined) { res.status(202).send(""); return; }
      res.status(200).json(out); return;
    }
    await rateLimit(`ip:${ip}`, 120);
    if (path === "/oauth/register" && req.method === "POST") { await rateLimit(`register:${ip}`, 10); res.status(201).json(await register(req.body)); return; }
    if (path === "/oauth/authorize" && req.method === "GET") { res.redirect(302, await beginAuthorization(req.query)); return; }
    if (path === "/oauth/request" && req.method === "GET") { res.json(await previewRequest(req.query.request)); return; }
    if (path === "/oauth/token" && req.method === "POST") { res.json(await exchange(req.body)); return; }
    if (path === "/oauth/revoke" && req.method === "POST") { await revokeToken(req.body); res.status(200).json({}); return; }
    if (path === "/oauth/approve" && req.method === "POST") { res.json(await approve(await firebaseUser(req.get("authorization")), req.body)); return; }
    if (path === "/oauth/grants" && req.method === "GET") { res.json({ grants: await listGrants(await firebaseUser(req.get("authorization"))) }); return; }
    if (path === "/oauth/disconnect" && req.method === "POST") { await revokeGrant(await firebaseUser(req.get("authorization")), req.body?.id); res.json({ disconnected: true }); return; }
    throw new HttpError(404, "not_found");
  } catch (e) {
    const err = e instanceof HttpError ? e : new HttpError(500, "temporarily_unavailable");
    if (!(e instanceof HttpError)) console.error("mcp", (e as Error).message);
    if (err.status === 401) res.set("WWW-Authenticate", `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`);
    // OAuth (RFC 6749 §5.2) : { error } ; jamais de corps de requête ni de jeton dans les journaux.
    if (!res.headersSent) res.status(err.status).json({ error: err.code });
  }
}
