#!/usr/bin/env node
// Pont stdio → serveur MCP hébergé MoneyMaker (https://usemoneymaker.com/mcp). Aucune dépendance.
// Pour les clients qui ne parlent que stdio ; les autres se connectent directement à l'URL (OAuth).
// claude mcp add moneymaker -e MM_TOKEN=mm_pat_… -- node /chemin/vers/tools/mcp/index.js
import { createInterface } from "node:readline";

const URL_ = `${(process.env.MM_API_URL ?? "https://usemoneymaker.com").replace(/\/$/, "")}/mcp`;
const TOKEN = process.env.MM_TOKEN;
const send = msg => process.stdout.write(JSON.stringify(msg) + "\n");
const fail = (id, message, code = -32603) => id !== undefined && send({ jsonrpc: "2.0", id, error: { code, message } });

createInterface({ input: process.stdin }).on("line", async line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  if (!TOKEN) return fail(msg.id, "MM_TOKEN manquant : crée un jeton (mm_pat_…) dans le dashboard › Compte.");
  try {
    const res = await fetch(URL_, { method: "POST", body: line, signal: AbortSignal.timeout(90000),
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "User-Agent": "moneymaker-mcp-stdio/2" } });
    if (res.status === 202) return;
    const text = await res.text();
    if (!res.ok) return fail(msg.id, res.status === 401 ? "Jeton MoneyMaker invalide ou révoqué (MM_TOKEN)." : `HTTP ${res.status} ${text.slice(0, 200)}`);
    const out = JSON.parse(text);
    for (const m of Array.isArray(out) ? out : [out]) send(m);
  } catch (e) { fail(msg.id, e.message); }
});
