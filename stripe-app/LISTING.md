# MoneyMaker — Stripe App Marketplace listing

App id: `io.moneymaker.stripe` · Category: Analytics / Subscriptions · Icon: `icon.png` (300×300 PNG, from `branding/app-icon-1024.png`).
Note: public listings must not contain the words "Stripe", "app", "free" or "paid" in the app **name** — "MoneyMaker" is fine.

---

## Français

**Nom :** MoneyMaker

**Accroche (≤ 80 car.) :** Vos abonnements App Store, Google Play et web, directement dans Stripe.

**Description courte :**
Voyez, sur chaque client Stripe, tout ce que MoneyMaker sait de lui : accès actifs, abonnements sur tous les stores, valeur vie client et historique. Offrez un accès promotionnel en un clic.

**Description longue :**
MoneyMaker unifie les achats intégrés et les abonnements de vos apps — App Store, Google Play, Stripe, Paddle, Amazon, Galaxy Store, Roku — dans une seule source de vérité. Cette app l'apporte dans le Dashboard Stripe :

- **Fiche client enrichie** : app user ID relié, statut payant, accès (entitlements) actifs avec leur échéance, abonnements et achats de *tous* les stores (pas seulement Stripe), total dépensé (LTV), attributs et événements récents.
- **Offrir un accès** : accordez un accès promotionnel (3 jours à vie) sans quitter Stripe ; il se cumule avec un accès promotionnel déjà en cours et apparaît instantanément dans vos apps.
- **Vue d'ensemble** partout dans le Dashboard : MRR, revenu sur 28 jours (avec évolution), abonnements actifs, essais en cours, nouveaux clients et répartition par store.
- **Lien direct** vers la fiche du client dans MoneyMaker.
- **Sécurisé** : la clé secrète MoneyMaker est chiffrée dans le Secret Store Stripe ; chaque requête est signée par Stripe et vérifiée par MoneyMaker.

**Pour commencer :** installez l'app, ouvrez ses réglages et collez la clé secrète de votre projet MoneyMaker (`mm_sk_…`, Réglages › Clés API). Le projet est détecté automatiquement.

**Autorisations :**
- `customer_read` — afficher le statut MoneyMaker sur la fiche client.
- `secret_write` — stocker la clé MoneyMaker de façon chiffrée.

**Support :** https://moneymaker-io.web.app/support · **Confidentialité :** https://moneymaker-io.web.app/privacy · **Conditions :** https://moneymaker-io.web.app/terms

---

## English

**Name:** MoneyMaker

**Tagline (≤ 80 chars):** Your App Store, Google Play and web subscriptions, right inside Stripe.

**Short description:**
See everything MoneyMaker knows about each Stripe customer: active entitlements, subscriptions across every store, lifetime value and history. Grant promotional access in one click.

**Long description:**
MoneyMaker unifies in-app purchases and subscriptions from your apps — App Store, Google Play, Stripe, Paddle, Amazon, Galaxy Store, Roku — into a single source of truth. This app brings it into the Stripe Dashboard:

- **Enriched customer page**: linked app user ID, paying status, active entitlements with expiry, subscriptions and purchases from *every* store (not just Stripe), total spent (LTV), attributes and recent events.
- **Grant access**: give promotional access (3 days to lifetime) without leaving Stripe; it stacks on top of a running promotional grant and reaches your apps instantly.
- **Overview** everywhere in the Dashboard: MRR, 28-day revenue (with trend), active subscriptions, active trials, new customers and per-store breakdown.
- **Deep link** to the customer in MoneyMaker.
- **Secure**: your MoneyMaker secret key is encrypted in the Stripe Secret Store; every request is signed by Stripe and verified by MoneyMaker.

**Getting started:** install the app, open its settings and paste your MoneyMaker project secret key (`mm_sk_…`, Settings › API keys). The project is detected automatically.

**Permissions:**
- `customer_read` — show MoneyMaker status on the customer page.
- `secret_write` — store the MoneyMaker key encrypted.

**Support:** https://moneymaker-io.web.app/support · **Privacy:** https://moneymaker-io.web.app/privacy · **Terms:** https://moneymaker-io.web.app/terms

---

## vs. RevenueCat's Stripe App

| | RevenueCat | MoneyMaker |
|---|---|---|
| Customer status, entitlements, cross-store history | yes | yes |
| Metrics overview | full-page, per project | drawer on every page (MRR, revenue 28d + trend, subs, trials, store split) |
| Write actions | read-only | **Grant promotional access** from Stripe |
| LTV on customer page | no | yes |
| Deep link to customer | yes | yes |

## Screenshots to capture (1280×800 recommended)
1. Customer page with linked user, entitlements and cross-store purchases.
2. "Grant access" form with the success toast.
3. Overview drawer (MRR, revenue, store breakdown).
4. Settings view with project connected.
