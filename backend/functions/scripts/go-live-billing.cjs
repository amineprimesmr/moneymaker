// Passe MoneyMaker Pro en paiement réel.
// Usage : copier la clé secrète live (sk_live_… ou rk_live_…) depuis le dashboard Stripe, puis
//   GOOGLE_CLOUD_PROJECT=moneymaker-io node scripts/go-live-billing.cjs
// La clé est lue dans le presse-papiers, jamais affichée, puis le presse-papiers est vidé.

const { execSync } = require("child_process");
const Stripe = require("stripe");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const WEBHOOK_URL = "https://usemoneymaker.com/v1/webhooks/billing";
const EVENTS = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "charge.refunded"];

(async () => {
  const key = execSync("pbpaste").toString().trim();
  if (!/^(sk|rk)_live_/.test(key)) throw new Error("Le presse-papiers ne contient pas de clé live Stripe.");
  execSync("printf '' | pbcopy");
  const stripe = new Stripe(key);

  const products = await stripe.products.search({ query: "metadata['product_id']:'io.moneymaker.pro.lifetime'" });
  const product = products.data[0] ?? await stripe.products.create({
    name: "MoneyMaker Pro", description: "Licence à vie : business illimités.",
    tax_code: "txcd_10202000", metadata: { product_id: "io.moneymaker.pro.lifetime" },
  });
  const prices = await stripe.prices.list({ product: product.id, active: true });
  const price = prices.data.find(p => p.unit_amount === 2900 && p.currency === "eur" && !p.recurring)
    ?? await stripe.prices.create({ product: product.id, unit_amount: 2900, currency: "eur", tax_behavior: "inclusive" });

  for (const w of (await stripe.webhookEndpoints.list({ limit: 100 })).data) {
    if (w.url === WEBHOOK_URL) await stripe.webhookEndpoints.del(w.id);
  }
  const hook = await stripe.webhookEndpoints.create({ url: WEBHOOK_URL, enabled_events: EVENTS });

  initializeApp({ projectId: "moneymaker-io" });
  await getFirestore().doc("system/billing").set({
    secretKey: key, webhookSecret: hook.secret, priceId: price.id, mode: "live", updatedAt: Date.now(),
  }, { merge: true });
  console.log(`OK live : produit ${product.id}, prix ${price.id}, webhook ${hook.id}`);
})().catch(e => { console.error("Échec :", e.message); process.exit(1); });
