#!/usr/bin/env node
// mm — CLI MoneyMaker. Mêmes commandes que le serveur MCP (tools/shared/client.mjs).
//   mm list-projects
//   mm get-metrics --project <id> --days 30
//   mm grant-entitlement --project <id> --customer <appUserId> --entitlement premium --days 7
//   mm update-offerings --project <id> --offerings @offerings.json --current-offering default
// Options : --json (sortie JSON brute). Auth : MM_TOKEN=mm_pat_…  Base : MM_API_URL.
import { readFileSync } from "node:fs";
import { COMMANDS } from "../shared/client.mjs";

const ALIAS = { project: "projectId", customer: "customerId", "current-offering": "currentOffering", "group-by": "groupBy" };
const camel = s => ALIAS[s] ?? s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function parse(argv) {
  const args = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { rest.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    const v = inline !== undefined ? inline : argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    args[camel(k)] = v;
  }
  return { args, rest };
}

function coerce(cmd, args) {
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === "json") continue;
    const t = cmd.params[k]?.type;
    if (!t) throw new Error(`Option inconnue --${k}. Options : ${Object.keys(cmd.params).map(p => `--${p}`).join(" ") || "aucune"}`);
    let val = v;
    if (typeof val === "string" && val.startsWith("@")) val = readFileSync(val.slice(1), "utf8");
    if (t === "number") val = Number(val);
    else if (t === "boolean") val = val === true || val === "true";
    else if (t === "object" && typeof val === "string") val = JSON.parse(val);
    out[k] = val;
  }
  for (const r of cmd.required) if (out[r] === undefined) throw new Error(`--${r === "projectId" ? "project" : r === "customerId" ? "customer" : r} requis`);
  return out;
}

const money = v => typeof v === "number" ? (v / 1e6).toFixed(2) : v;
function pretty(name, out) {
  if (name === "list_projects") return out.map(p => `${p.id}\t${p.name}\t${p.role ?? ""}\t${p.currency ?? ""}`).join("\n");
  if (name === "get_overview" || name === "get_metrics") {
    const keys = ["mrrMicros", "arrMicros", "revenueMicros", "netRevenueMicros", "activeSubscriptions", "activeTrials", "newCustomers", "payingCustomers", "trialConversionRate", "monthlyChurnRate"];
    return [`devise ${out.currency}`, ...keys.filter(k => out[k] !== undefined).map(k => `${k.replace(/Micros$/, "")}\t${k.endsWith("Micros") ? money(out[k]) : out[k]}`)].join("\n");
  }
  if (name === "list_events") return out.events.map(e => `${new Date(e.at).toISOString()}\t${e.type}\t${e.appUserId}\t${e.productId ?? ""}\t${e.priceMicros ? money(e.priceMicros) + " " + e.currency : ""}`).join("\n");
  if (name === "list_customers") return out.customers.map(c => `${c.id}\t${(c.activeEntitlements ?? []).join(",") || "-"}\t${c.isPaying ? "payant" : ""}\t${money(c.totalSpentMicros ?? 0)}`).join("\n");
  return JSON.stringify(out, null, 2);
}

function help() {
  console.log(`mm — CLI MoneyMaker\n\nUsage : mm <commande> [--option valeur] [--json]\n\nCommandes :\n${Object.entries(COMMANDS).map(([n, c]) =>
    `  ${n.replace(/_/g, "-").padEnd(20)} ${c.description}\n${" ".repeat(23)}${Object.keys(c.params).map(p => `--${p === "projectId" ? "project" : p === "customerId" ? "customer" : p.replace(/[A-Z]/g, m => "-" + m.toLowerCase())}${c.required.includes(p) ? "" : "?"}`).join(" ")}`).join("\n")}\n\nAuth : MM_TOKEN=mm_pat_…   API : MM_API_URL (défaut https://usemoneymaker.com)\nValeurs @fichier.json lues depuis le disque.`);
}

const { args, rest } = parse(process.argv.slice(2));
const name = (rest[0] ?? "").replace(/-/g, "_");
if (!name || name === "help" || args.help) { help(); process.exit(name || args.help ? 0 : 1); }
const cmd = COMMANDS[name];
if (!cmd) { console.error(`Commande inconnue : ${rest[0]}\n`); help(); process.exit(1); }
try {
  const out = await cmd.run(coerce(cmd, args));
  console.log(args.json ? JSON.stringify(out, null, 2) : pretty(name, out));
} catch (e) { console.error(`mm: ${e.message}`); process.exit(1); }
