# MoneyMaker SDK changelog

All SDKs (iOS, Android, React Native, Flutter) share one version number.

## 1.2.0

### Install

| SDK | Install |
| --- | --- |
| iOS (SwiftPM) | `.package(url: "https://github.com/amineprimesmr/moneymaker", from: "1.2.0")`, product `MoneyMaker` |
| Android (JitPack) | `maven("https://jitpack.io")` + `implementation("com.github.amineprimesmr:moneymaker:1.2.0")` |
| React Native / Expo | `npx expo install moneymaker-react-native@1.2.0` (or `npm install moneymaker-react-native@1.2.0`) |
| Flutter | `moneymaker_flutter: { git: { url: https://github.com/amineprimesmr/moneymaker, path: sdk/flutter, ref: 1.2.0 } }` |

### Android
- **Google Play Billing Library 8.3.0** (was 7.1.1): `queryProductDetailsAsync` → `QueryProductDetailsResult`
  (unfetched products are logged), `enablePendingPurchases(PendingPurchasesParams)`, automatic service reconnection
  (`enableAutoServiceReconnection()`); no use of the removed `queryPurchaseHistory` / SKU APIs. minSdk 23.
- **Consumables**: `MoneyMaker.configure(…, consumableProductIds = setOf("coins_100"))` (or
  `MoneyMaker.shared.consumableProductIds`). Consumables are sent as `"type": "consumable"` (the server does not
  acknowledge them) and consumed with `consumeAsync` once the server accepted them, so they can be bought again.
  Queued (offline) consumables are consumed when the queue is flushed; owned unconsumed ones at the next sync.
- **Explicit subscription offer**: by default the base plan **without offer** is bought (no longer
  `subscriptionOfferDetails.firstOrNull()`). `purchase(activity, pkg, offerToken = …, offerId = …)` buys a specific
  offer; a `play_store` id written `productId:basePlanId` selects that base plan. `Package.formattedPrice`,
  `priceAmountMicros`, `priceCurrencyCode`, `subscriptionPeriod` and `hasFreeTrial` follow the same base plan.
- The purchase body sends the period of the plan actually bought (`period`, ISO 8601) plus `basePlanId` / `offerId`.
- **Errors**: API failures always throw `MoneyMakerException` (`code`, `status`, `billingResponseCode`, `isRetryable`)
  instead of returning an empty JSON object; `loadOfferings()` throws when the API is unreachable instead of returning
  empty offerings (on a device without Google Play, offerings are returned with `product == null`).
  A 2xx with an invalid body throws `invalid_response`.
- **Retries**: every 5xx is retried (not only `internal_error`) and every 5xx / 429 / network failure queues the
  purchase token for later instead of dropping it.
- **Play connection**: `BILLING_UNAVAILABLE` (and any setup failure) is an error (`billing_3`); a service
  disconnection before setup finished or a 30 s timeout no longer blocks the coroutine forever.
- **logIn** re-syncs the Google Play purchases after login (same as iOS) and only switches `appUserId` once the
  server answered.

### iOS
- `logIn` only changes `appUserID` after the server answered: a failed login leaves the SDK on the previous id.
- `restorePurchases()` throws the `AppStore.sync()` error (e.g. `StoreKitError.userCancelled`) instead of ignoring
  it; the built-in paywall and Customer Center ignore the user cancellation.
- `signPromotionalOffer` throws `MoneyMakerError.server(code: "invalid_offer_signature")` on a malformed signature
  (it threw `productNotFound`).
- `MoneyMaker.sdkVersion` (sent in the User-Agent).

### All SDKs
- Default API `https://usemoneymaker.com/v1`. The hosted signing key is pinned for `usemoneymaker.com` and the former
  `moneymaker-io.web.app` (same key, both serve `/v1/signing-key`), so apps that still pass the old base URL keep
  verified entitlements.
- React Native: `configure({ consumableProductIds })`, `purchasePackage(pkg, { offerId })`. Flutter:
  `configure(apiKey, consumableProductIds: {...})`, `purchasePackage(pkg, offerId: ...)`.
