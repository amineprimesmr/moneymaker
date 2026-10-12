const test = require("node:test");
const assert = require("node:assert");
const { roleOf, atLeast, defaultRequired, canManage, owners } = require("../lib/roles");

const p = { members: ["o", "a", "d", "v", "x"], roles: { a: "admin", d: "developer", v: "viewer", x: "bogus" } };

test("roleOf: legacy members are owners, non-members null", () => {
  assert.equal(roleOf(p, "o"), "owner");
  assert.equal(roleOf(p, "a"), "admin");
  assert.equal(roleOf(p, "v"), "viewer");
  assert.equal(roleOf(p, "x"), "owner");
  assert.equal(roleOf(p, "zzz"), null);
  assert.equal(roleOf({ members: ["o"] }, "o"), "owner");
  assert.deepEqual(owners(p), ["o", "x"]);
});

test("levels and default requirement", () => {
  assert.ok(atLeast("owner", "admin"));
  assert.ok(!atLeast("viewer", "developer"));
  assert.ok(atLeast("developer", "developer"));
  assert.equal(defaultRequired("GET"), "viewer");
  assert.equal(defaultRequired("POST"), "developer");
  assert.equal(defaultRequired("DELETE"), "developer");
});

test("canManage", () => {
  assert.ok(canManage("admin", "developer", "viewer", false));
  assert.ok(!canManage("admin", "owner", "viewer", false));
  assert.ok(canManage("owner", "owner", "admin", false));
  assert.ok(!canManage("owner", "admin", "owner", false)); // no ownership transfer
  assert.ok(!canManage("developer", "viewer", "developer", false));
  assert.ok(canManage("viewer", "viewer", null, true)); // leaving
  assert.ok(!canManage("viewer", "viewer", "admin", true));
});
