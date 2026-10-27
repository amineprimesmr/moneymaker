const test = require("node:test");
const assert = require("node:assert");
const P = require("../lib/posthog");

test("propose les étapes de l'entonnoir d'après les noms d'événements", () => {
  const events = ["$pageview", "Application Opened", "onboarding_completed", "paywall_viewed", "trial_started", "purchase_completed", "button_tap"]
    .map(event => ({ event, count: 1 }));
  assert.deepStrictEqual(P.suggestMapping(events), {
    open: "Application Opened", onboarding: "onboarding_completed", paywall: "paywall_viewed", trial: "trial_started", purchase: "purchase_completed",
  });
});

test("valide la configuration PostHog", () => {
  const { config, apiKey } = P.sanitizePosthog({ host: "eu", projectId: "12345", apiKey: "phx_abcdefghijklmnopqrstuvwxyz", events: { paywall: "pw" } });
  assert.strictEqual(config.host, "https://eu.posthog.com");
  assert.strictEqual(apiKey, "phx_abcdefghijklmnopqrstuvwxyz");
  assert.deepStrictEqual(config.events, { paywall: "pw" });
  assert.throws(() => P.sanitizePosthog({ projectId: "abc" }));
  assert.throws(() => P.sanitizePosthog({ projectId: "1", apiKey: "phc_public" }));
  // Une étape vidée est retirée, les autres sont gardées.
  assert.deepStrictEqual(P.sanitizePosthog({ events: { paywall: "" } }, config).config.events, {});
});
