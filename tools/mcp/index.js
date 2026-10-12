#!/usr/bin/env node
// Serveur MCP MoneyMaker (stdio, JSON-RPC 2.0 délimité par des retours à la ligne). Aucune dépendance.
// claude mcp add moneymaker -e MM_TOKEN=mm_pat_… -- node /chemin/vers/tools/mcp/index.js
import { createInterface } from "node:readline";
import { COMMANDS } from "../shared/client.mjs";

const SERVER = { name: "moneymaker", version: "1.0.0" };
const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];

const send = msg => process.stdout.write(JSON.stringify(msg) + "\n");
const tools = () => Object.entries(COMMANDS).map(([name, c]) => ({
  name, description: c.description,
  inputSchema: { type: "object", properties: c.params, required: c.required, additionalProperties: false },
}));

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return { protocolVersion: SUPPORTED.includes(params?.protocolVersion) ? params.protocolVersion : SUPPORTED[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER,
        instructions: "Données d'abonnements MoneyMaker. Commence par list_projects pour obtenir les projectId. Montants en micro-unités (÷ 1 000 000)." };
    case "ping": return {};
    case "tools/list": return { tools: tools() };
    case "tools/call": {
      const c = COMMANDS[params?.name];
      if (!c) throw Object.assign(new Error(`Outil inconnu : ${params?.name}`), { code: -32602 });
      try {
        const out = await c.run(params.arguments ?? {});
        return { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }] };
      } catch (e) { return { content: [{ type: "text", text: e.message }], isError: true }; }
    }
    default:
      if (id === undefined) return undefined; // notification (ex. notifications/initialized)
      throw Object.assign(new Error(`Méthode inconnue : ${method}`), { code: -32601 });
  }
}

createInterface({ input: process.stdin }).on("line", async line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  try {
    const result = await handle(msg);
    if (msg.id !== undefined && result !== undefined) send({ jsonrpc: "2.0", id: msg.id, result });
  } catch (e) {
    if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: e.code ?? -32603, message: e.message } });
  }
});
