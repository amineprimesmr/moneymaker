---
name: moneymaker
description: Integrate MoneyMaker (self-hosted RevenueCat alternative) into an iOS, Android or web app — in-app subscriptions, paywall, entitlements, restore, Stripe checkout, server webhooks. Use when the user asks to add subscriptions/paywall/in-app purchases, to replace RevenueCat, or mentions MoneyMaker or mm_pub_/mm_sk_/mm_pat_ keys.
---

# MoneyMaker integration

1. Fetch the always-current reference: `curl -s https://moneymaker-io.web.app/llms.txt` and follow it exactly.
2. Ask the user only for what you cannot find: the public key `mm_pub_…` (dashboard → business → Réglages) and the entitlement id (default `premium`). If they give a personal token `mm_pat_…`, you may create/configure the project yourself through the API (`POST /v1/projects`, `PATCH /v1/projects/{id}`) — print the returned secret key once to the user and never commit it.
3. Integrate: configure at launch → logIn/logOut with the app's auth → gate with `isEntitled` → paywall with `loadOfferings` + `purchase` (or the drop-in `MoneyMakerPaywall`) → restore button.
4. Remove RevenueCat / hand-written StoreKit or Play Billing listeners the SDK replaces. Keep product ids identical.
5. Verify: build the app, then `GET /v1/customers/{appUserId}` with the public key returns the expected `activeEntitlements` after a sandbox purchase.
6. Store setup the user must do in consoles (you cannot): App Store Server Notifications V2 URL, In-App Purchase key (.p8), Play service account + Pub/Sub push URL, Stripe webhook. Give them the exact URLs from `GET /v1/projects/{id}` → `endpoints`.
