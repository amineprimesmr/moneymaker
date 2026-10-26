// Vérification de soumission : OAuth réel + chaque outil via https://moneymaker-io.web.app/mcp, avec le compte relecteur.
// node tests/mcp-prod-check.mjs   (lit submission/reviewer-credentials.txt ; écrit uniquement dans le business du relecteur)
import fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
const B = "https://moneymaker-io.web.app";
const cred = fs.readFileSync(new URL("../../../submission/reviewer-credentials.txt", import.meta.url), "utf8");
const email = /E-mail : (.+)/.exec(cred)[1].trim(), password = /Mot de passe : (.+)/.exec(cred)[1].trim();
const { apiKey } = await (await fetch(`${B}/__/firebase/init.json`)).json();
const { idToken } = await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }) })).json();
if (!idToken) throw new Error("connexion relecteur impossible");
const J = async (path, init = {}) => { const r = await fetch(B + path, { redirect: "manual", ...init }); return { r, b: await r.json().catch(() => ({})) }; };
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const client = (await J("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }) })).b;
const verifier = randomBytes(32).toString("base64url"), challenge = createHash("sha256").update(verifier).digest("base64url");
const qs = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", scope: "moneymaker:read moneymaker:write", state: "s" });
const request = new URL((await J(`/oauth/authorize?${qs}`)).r.headers.get("location")).searchParams.get("request");
const { redirect } = (await J("/oauth/approve", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
  body: JSON.stringify({ request, consent: true, scopes: ["moneymaker:read", "moneymaker:write"] }) })).b;
const code = new URL(redirect).searchParams.get("code");
const tok = (await J("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier }) })).b;
console.log("OAuth prod :", tok.access_token?.slice(0, 7), tok.scope);
let id = 0;
const rpc = async (method, params) => (await J("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) })).b;
const tool = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result;
const data = r => { try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; } };
const { tools } = (await rpc("tools/list")).result;
const pid = data(await tool("list_projects")).find(p => p.name === "Focus Timer (demo)").id;
const cust = data(await tool("list_customers", { projectId: pid, limit: 1 })).customers[0].appUserId;
const appId = "1000000001";
const review = data(await tool("list_app_reviews", { projectId: pid, appId, limit: 1 })).reviews?.[0]?.id;
const args = {
  get_chart: { projectId: pid, name: "mrr", days: 30 }, get_customer: { projectId: pid, customerId: cust }, export_csv: { projectId: pid, kind: "customers", maxRows: 5 },
  preview_audience: { projectId: pid, filters: {} }, get_app_rankings: { projectId: pid, appId }, get_app_ratings: { projectId: pid, appId }, list_app_reviews: { projectId: pid, appId },
  translate_review: { projectId: pid, appId, reviewId: review }, search_app_store: { term: "pomodoro" }, get_experiment_results: null, list_audience_customers: null, list_posthog_events: null,
  update_project: { projectId: pid, config: { website: "https://moneymaker-io.web.app" } },
  update_offerings: { projectId: pid, currentOffering: "default" }, set_alert_preferences: { projectId: pid, threshold: 3 }, add_tracked_app: { projectId: pid, appId, own: true },
  refresh_app_store: { projectId: pid }, grant_entitlement: { projectId: pid, customerId: cust, entitlement: "premium", days: 7 }, send_test_webhook: { projectId: pid },
  update_public_listing: { projectId: pid, listed: false }, update_finance_settings: { settings: { structure: "sasu_is" } },
  upsert_expense: { id: "figma", name: "Figma", amount: 15, every: "month" }, delete_expense: { id: "figma", confirm: true }, invite_member: { projectId: pid, email: "teammate@example.com", role: "viewer" },
  create_project: null, update_member_role: null, remove_member: null, disconnect_posthog: null, remove_tracked_app: null, revoke_invite: "after",
};
let ok = 0, bad = [];
for (const t of tools) {
  if (args[t.name] === null || args[t.name] === "after") continue;
  const a = args[t.name] ?? Object.fromEntries(Object.keys(t.inputSchema.properties).filter(k => k === "projectId").map(k => [k, pid]));
  const r = await tool(t.name, a);
  const expected = r.isError && /posthog_not_connected/.test(r.content[0].text);
  if (r.isError && !expected) bad.push(`${t.name}: ${r.content[0].text.slice(0, 120)}`); else ok++;
}
const inv = data(await tool("list_members", { projectId: pid })).invites?.find(i => i.email === "teammate@example.com");
if (inv) { const r = await tool("revoke_invite", { projectId: pid, inviteId: inv.id }); if (!data(r).confirmationRequired) bad.push("revoke_invite sans confirmation"); await tool("revoke_invite", { projectId: pid, inviteId: inv.id, confirm: true }); ok++; }
await tool("update_public_listing", { projectId: pid, listed: false });
console.log(`${ok} outils OK sur ${tools.length} (non testés en prod : create_project, update_member_role, remove_member, remove_tracked_app, disconnect_posthog, get_experiment_results, list_audience_customers — couverts par l'e2e émulateur)`);
if (bad.length) { console.log("ÉCHECS :\n" + bad.join("\n")); process.exit(1); }
