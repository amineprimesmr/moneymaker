const test = require("node:test");
const assert = require("node:assert");
const { sanitizeFeedback } = require("../lib/feedback");

test("sanitizeFeedback garde le texte, borne le type et refuse le vide", () => {
  const f = sanitizeFeedback({ kind: "bug", message: "  Le graphique saute  ", appVersion: "1.1.1 (13)" });
  assert.equal(f.kind, "bug");
  assert.equal(f.message, "Le graphique saute");
  assert.equal(f.appVersion, "1.1.1 (13)");
  assert.equal(sanitizeFeedback({ kind: "hack", message: "ok ok" }).kind, "other");
  assert.throws(() => sanitizeFeedback({ message: " " }));
  assert.equal(sanitizeFeedback({ message: "x".repeat(5000) }).message.length, 4000);
});
