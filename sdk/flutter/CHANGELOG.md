## 1.0.0
- Initial release: wraps MoneyMaker iOS (StoreKit 2) and Android (Play Billing) SDKs.

## 1.1.1
- Migration vers le Kotlin intégré (Flutter 3.44+ / Dart 3.12 minimum).
- SDK Android MoneyMaker 1.1.1.

## 1.2.0
- SDK Android MoneyMaker 1.2.0 (Google Play Billing Library 8.3.0), SDK iOS 1.2.0 (vendored).
- `configure(..., consumableProductIds: {...})` (Android): consumables are consumed after server validation.
- `purchasePackage` / `purchaseProduct` accept `offerId`; Android buys the base plan without offer by default.
- Android Gradle: AGP 8.13.2 / Kotlin 2.3.0 in the buildscript, built-in Kotlin kept (no `kotlinOptions`).
