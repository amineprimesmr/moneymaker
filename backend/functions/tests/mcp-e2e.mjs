// Parcours OAuth + MCP complet contre les émulateurs (aucune donnée de production) :
// JAVA_HOME=… firebase emulators:exec --project demo-moneymaker --only functions,firestore,auth,hosting "node backend/functions/tests/mcp-e2e.mjs"
import assert from "node:assert";
import { createHash, randomBytes } from "node:crypto";
const HOST = "http://127.0.0.1:5100", AUTH = "http://127.0.0.1:9199";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const j = async (path, { key, method = "GET", body, form, headers = {} } = {}) => {
  const r = await fetch(HOST + path, { method, redirect: "manual", headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}),
    "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json", ...headers },
    body: form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined });
  const t = await r.json().catch(() => ({}));
  return { status: r.status, body: t, headers: r.headers };
};
const ok = async (...a) => { const r = await j(...a); assert.ok(r.status < 300, `${a[0]} → ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
let rid = 0;
const mcp = async (key, method, params) => (await ok("/mcp", { key, method: "POST", body: { jsonrpc: "2.0", id: ++rid, method, params } }));
const call = async (key, name, args = {}) => { const r = (await mcp(key, "tools/call", { name, arguments: args })).result; return { ...r, data: (() => { try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; } })() }; };

const signUp = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: `mcp${Date.now()}@x.io`, password: "password123", returnSecureToken: true }) }).then(r => r.json());
const idToken = signUp.idToken; assert(idToken, "auth emulator sign-up");
const { projectId: pid } = await ok("/v1/projects", { key: idToken, method: "POST", body: { name: "MCP Test", config: { currency: "EUR", entitlements: { pro: ["monthly"] } } } });
const { token: pat } = await ok("/v1/tokens", { key: idToken, method: "POST", body: { label: "mcp-e2e" } });

// 1. Découverte : 401 + WWW-Authenticate, métadonnées OAuth.
const unauth = await j("/mcp", { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "initialize" } });
assert.equal(unauth.status, 401);
assert.match(unauth.headers.get("www-authenticate"), /resource_metadata=".*\/\.well-known\/oauth-protected-resource\/mcp"/);
const prm = await ok("/.well-known/oauth-protected-resource/mcp");
assert.match(prm.resource, /\/mcp$/); assert.deepEqual(prm.scopes_supported, ["moneymaker:read", "moneymaker:write"]);
const asm = await ok("/.well-known/oauth-authorization-server");
assert.match(asm.registration_endpoint, /\/oauth\/register$/); assert.deepEqual(asm.code_challenge_methods_supported, ["S256"]);

// 2. Enregistrement dynamique : redirections non autorisées refusées.
assert.equal((await j("/oauth/register", { method: "POST", body: { redirect_uris: ["https://evil.example/cb"] } })).status, 400);
const client = await ok("/oauth/register", { method: "POST", body: { client_name: "Claude", redirect_uris: [REDIRECT] } });
assert.equal(client.client_name, "Claude");

async function authorize(scope) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const qs = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge,
    code_challenge_method: "S256", state: "st4te", scope, resource: prm.resource });
  const r = await j(`/oauth/authorize?${qs}`);
  assert.equal(r.status, 302);
  const request = new URL(r.headers.get("location")).searchParams.get("request");
  assert.ok(request, "redirection vers /connect?request=");
  const preview = await ok(`/oauth/request?request=${encodeURIComponent(request)}`);
  assert.equal(preview.name, "Claude"); assert.equal(preview.redirectHost, "claude.ai");
  assert.equal((await j("/oauth/approve", { method: "POST", body: { request, consent: true, scopes: preview.scopes } })).status, 401, "approbation sans session refusée");
  const { redirect } = await ok("/oauth/approve", { key: idToken, method: "POST", body: { request, consent: true, scopes: preview.scopes } });
  const u = new URL(redirect); assert.equal(u.searchParams.get("state"), "st4te");
  const code = u.searchParams.get("code");
  assert.equal((await j("/oauth/token", { method: "POST", form: { grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: "x".repeat(43) } })).status, 400, "PKCE faux refusé");
  return ok("/oauth/token", { method: "POST", form: { grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier, resource: prm.resource } });
}

// 3. Connexion en lecture seule.
const ro = await authorize("moneymaker:read offline_access");
assert.match(ro.access_token, /^mm_oat_/); assert.equal(ro.scope, "moneymaker:read");
const init = (await mcp(ro.access_token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } })).result;
assert.equal(init.serverInfo.name, "moneymaker");
assert.equal((await j("/mcp", { key: ro.access_token, method: "POST", body: { jsonrpc: "2.0", method: "notifications/initialized" } })).status, 202);
const roTools = (await mcp(ro.access_token, "tools/list")).result.tools;
assert.ok(roTools.every(t => t.annotations.readOnlyHint), "lecture seule : aucun outil d'écriture listé");
const projects = (await call(ro.access_token, "list_projects")).data;
assert.equal(projects[0].id, pid);
const metrics = await call(ro.access_token, "get_metrics", { projectId: pid, days: 7 });
assert.ok(!metrics.isError, metrics.content[0].text); assert.equal(metrics.data.projectId, pid);
const project = (await call(ro.access_token, "get_project", { projectId: pid })).data;
assert.ok(!JSON.stringify(project).includes("whsec_") && !/token=[^…]/.test(JSON.stringify(project.endpoints)), "secrets masqués");
assert.equal((await call(ro.access_token, "update_project", { projectId: pid, name: "x" })).isError, true);
assert.equal((await j(`/v1/projects/${pid}`, { key: ro.access_token, method: "PATCH", body: { name: "x" } })).body.error, "insufficient_scope");
assert.equal((await j(`/v1/projects/${pid}/metrics`, { key: ro.access_token })).status, 200, "le jeton OAuth fonctionne aussi sur l'API REST");

// 4. Refresh : rotation, usage unique.
const refreshed = await ok("/oauth/token", { method: "POST", form: { grant_type: "refresh_token", refresh_token: ro.refresh_token, client_id: client.client_id } });
assert.match(refreshed.access_token, /^mm_oat_/);
assert.equal((await j("/oauth/token", { method: "POST", form: { grant_type: "refresh_token", refresh_token: ro.refresh_token, client_id: client.client_id } })).status, 400);

// 5. Connexion lecture + écriture : écritures sûres, suppressions avec confirmation, audit.
const rw = await authorize("moneymaker:read moneymaker:write");
assert.ok((await mcp(rw.access_token, "tools/list")).result.tools.some(t => t.name === "remove_member" && t.annotations.destructiveHint));
const alerts = await call(rw.access_token, "set_alert_preferences", { projectId: pid, threshold: 4, weeklySummary: false });
assert.deepEqual(alerts.data.anomalies, { enabled: true, threshold: 4, weeklySummary: false });
const offerings = await call(rw.access_token, "update_offerings", { projectId: pid, offerings: { default: { packages: [{ id: "$rc_monthly", productIds: { app_store: "monthly" } }] } }, currentOffering: "default" });
assert.ok(!offerings.isError, offerings.content[0].text); assert.equal(offerings.data.currentOffering, "default");
assert.equal((await call(rw.access_token, "update_project", { projectId: pid, name: "MCP Renamed", config: { website: "https://example.com" } })).data.name, "MCP Renamed");
assert.equal((await call(rw.access_token, "upsert_expense", { id: "figma", name: "Figma", amount: 15, every: "month" })).data.expense.amountMicros, 15e6);
assert.equal((await call(rw.access_token, "delete_expense", { id: "figma" })).data.confirmationRequired, true);
assert.equal((await call(rw.access_token, "list_expenses")).data.expenses.length, 1, "rien supprimé sans confirm");
assert.equal((await call(rw.access_token, "delete_expense", { id: "figma", confirm: true })).data.ok, true);
assert.equal((await call(rw.access_token, "list_expenses")).data.expenses.length, 0);
const inv = await call(rw.access_token, "invite_member", { projectId: pid, email: "friend@x.io", role: "viewer" });
assert.match(inv.data.link, /invite/);
assert.equal((await call(rw.access_token, "revoke_invite", { projectId: pid, inviteId: inv.data.id, confirm: true })).data.ok, true);
const grant = await call(rw.access_token, "grant_entitlement", { projectId: pid, customerId: "user_1", entitlement: "pro", days: 3 });
assert.ok(!grant.isError, grant.content[0].text);
assert.ok((await call(rw.access_token, "get_customer", { projectId: pid, customerId: "user_1" })).data.activeEntitlements.includes("pro"));
const created = await call(rw.access_token, "create_project", { name: "Second", currency: "USD" });
assert.match(created.data.publicKey, /^mm_pub_/); assert.ok(!String(created.data.secretKey).startsWith("mm_sk_"), "clé secrète jamais renvoyée");
const audit = (await call(rw.access_token, "get_audit_log", { projectId: pid })).data;
assert.ok(audit.entries.length >= 4, "écritures MCP journalisées");

// 6. Jeton personnel en secours.
assert.equal((await call(pat, "list_projects")).data.length, 2);

// 7. Révocation depuis /connect : le jeton cesse de fonctionner.
const { grants } = await ok("/oauth/grants", { key: idToken });
assert.equal(grants.filter(g => !g.revoked).length, 2);
for (const g of grants) await ok("/oauth/disconnect", { key: idToken, method: "POST", body: { id: g.id } });
assert.equal((await j("/mcp", { key: rw.access_token, method: "POST", body: { jsonrpc: "2.0", id: 9, method: "tools/list" } })).status, 401);
assert.equal((await j("/oauth/token", { method: "POST", form: { grant_type: "refresh_token", refresh_token: rw.refresh_token, client_id: client.client_id } })).status, 400);

console.log(`MCP e2e OK — ${roTools.length} outils en lecture, parcours OAuth, écritures, confirmations, révocation`);
