const test = require("node:test");
const assert = require("node:assert");
const { createHash } = require("node:crypto");
const { scopes, redirectAllowed, redirectMatches, clientName, pkce, safeID } = require("../lib/mcp/policy.js");
const { TOOLS, toolList } = require("../lib/mcp/tools.js");

test("redirections : Claude, ChatGPT et loopback seulement", () => {
  for (const ok of ["https://claude.ai/api/mcp/auth_callback", "https://chatgpt.com/connector_platform_oauth_redirect", "http://localhost:53121/callback", "http://127.0.0.1:9/cb"])
    assert.ok(redirectAllowed(ok), ok);
  for (const ko of ["https://evil.com/cb", "http://claude.ai/cb", "https://claude.ai:444/cb", "https://u:p@claude.ai/cb", "https://claude.ai/cb#x", "javascript:alert(1)"])
    assert.ok(!redirectAllowed(ko), ko);
  assert.ok(redirectMatches("http://localhost:1234/callback", "http://localhost:5555/callback"));
  assert.ok(!redirectMatches("http://localhost:1234/callback", "http://localhost:5555/other"));
  assert.ok(!redirectMatches("https://claude.ai/a", "https://claude.ai/b"));
});

test("nom affiché déduit de la redirection", () => {
  assert.equal(clientName("https://claude.ai/x", "ChatGPT"), "Claude");
  assert.equal(clientName("https://chatgpt.com/x", "Claude"), "ChatGPT");
  assert.equal(clientName("http://localhost:1/x", "Claude Code"), "Claude Code");
});

test("scopes et PKCE", () => {
  assert.deepEqual(scopes("moneymaker:read offline_access"), ["moneymaker:read"]);
  assert.throws(() => scopes("admin"));
  const v = "a".repeat(43);
  assert.ok(pkce(v, createHash("sha256").update(v).digest("base64url")));
  assert.ok(!pkce("short", createHash("sha256").update("short").digest("base64url")));
  assert.ok(safeID("mm_oat_" + "x".repeat(43)) && !safeID("a/b"));
});

test("catalogue : noms uniques, suppressions confirmées, lecture seule filtrée", () => {
  assert.equal(new Set(TOOLS.map(t => t.name)).size, TOOLS.length);
  for (const t of TOOLS.filter(t => t.destructive)) assert.ok(t.write && t.props.confirm, t.name);
  assert.ok(toolList(false).every(t => t.annotations.readOnlyHint));
  for (const t of toolList(true)) assert.ok(/^[a-z_]{3,40}$/.test(t.name) && t.description.length > 10);
});
