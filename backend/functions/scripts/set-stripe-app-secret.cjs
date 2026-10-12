// Saves the Stripe App signing secret (absec_…) to Firestore `system/stripeApp` (server-only).
// Usage: cd backend/functions && npm run build && node scripts/set-stripe-app-secret.cjs
process.env.GCLOUD_PROJECT = "moneymaker-io";
const readline = require("readline");
const { db } = require("../lib/store");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
rl._writeToOutput = s => { if (!rl.muted) rl.output.write(s); };
rl.question("Colle le secret de signature (absec_…) puis Entrée : ", async secret => {
  rl.close(); process.stdout.write("\n");
  secret = secret.trim();
  if (!/^absec_[A-Za-z0-9]+$/.test(secret)) { console.log("Ce n'est pas un secret absec_… valide."); process.exit(1); }
  await db.doc("system/stripeApp").set({ signingSecret: secret, updatedAt: Date.now() }, { merge: true });
  console.log("✔ Secret enregistré sur le serveur.");
  process.exit(0);
});
rl.muted = true;
