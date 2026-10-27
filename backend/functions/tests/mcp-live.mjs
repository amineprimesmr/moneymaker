// Teste le serveur MCP (JSON-RPC + outils) contre l'API réelle, sans déployer : dispatch() devient un fetch HTTP.
// MM_TOKEN=mm_demo (lecture seule, données de démo) ou mm_pat_… ; MM_API_URL pour une autre base.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
process.env.GCLOUD_PROJECT ??= "moneymaker-io";
const { rpc } = require("../lib/mcp/server.js");
const BASE = (process.env.MM_API_URL ?? "https://usemoneymaker.com").replace(/\/$/, "");
const TOKEN = process.env.MM_TOKEN ?? "mm_demo";
const dispatch = async (method, path, { query, body, authorization }) => {
  const qs = new URLSearchParams(query ?? {}).toString();
  const res = await fetch(`${BASE}${path}${qs ? `?${qs}` : ""}`, { method, headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text(); let b = text; try { b = JSON.parse(text); } catch {}
  return { status: res.status, body: b };
};
const id = { authorization: `Bearer ${TOKEN}`, write: process.env.MM_WRITE !== "0" };
let n = 0;
export const send = (method, params) => rpc({ jsonrpc: "2.0", id: ++n, method, params }, id, dispatch);
export const tool = async (name, args = {}) => (await send("tools/call", { name, arguments: args })).result;

if (import.meta.url === `file://${process.argv[1]}`) {
  const init = await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  console.log("initialize:", init.result.protocolVersion, init.result.serverInfo.name);
  const { tools } = (await send("tools/list")).result;
  console.log("tools:", tools.length);
  const pid = JSON.parse((await tool("list_projects")).content[0].text)[0]?.id;
  console.log("projectId:", pid);
  const args = JSON.parse(process.env.MM_ARGS ?? "{}");
  const only = process.argv.slice(2);
  const sample = { projectId: pid, name: "mrr", kind: "transactions", term: "focus timer", maxRows: 3, limit: 3, filters: {}, ...args };
  for (const t of tools) {
    if (only.length && !only.includes(t.name)) continue;
    if (t.annotations.readOnlyHint === false && !only.includes(t.name)) continue; // écritures : seulement sur demande explicite
    const a = Object.fromEntries(Object.keys(t.inputSchema.properties).filter(k => k in sample).map(k => [k, sample[k]]));
    const missing = t.inputSchema.required.filter(r => !(r in a));
    if (missing.length) { console.log(`SKIP  ${t.name} (manque ${missing})`); continue; }
    const t0 = Date.now(); const r = await tool(t.name, a);
    console.log(`${r.isError ? "ERR " : "OK  "} ${t.name.padEnd(24)} ${String(Date.now() - t0).padStart(5)}ms ${r.content[0].text.replace(/\s+/g, " ").slice(0, 110)}`);
  }
}
