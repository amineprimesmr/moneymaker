# moneymaker_flutter

Flutter plugin for [MoneyMaker](https://github.com/amineprimesmr/moneymaker) — subscriptions for the App Store, Google Play and Stripe on your own backend. It wraps the native SDKs (iOS: StoreKit 2, Android: Play Billing 7).

## English

**Install**

```yaml
dependencies:
  moneymaker_flutter:
    git: { url: https://github.com/amineprimesmr/moneymaker, path: sdk/flutter }
```

- iOS 16+. The Swift SDK is vendored in the pod (`tool/sync_native_sources.sh`).
- Android minSdk 23. The plugin pulls `com.github.amineprimesmr:moneymaker:1.1.0` from JitPack. If your app's `settings.gradle` uses `RepositoriesMode.FAIL_ON_PROJECT_REPOS`, add `maven { url 'https://jitpack.io' }` there.

**Use**

```dart
await MoneyMaker.configure('mm_pub_…', appUserId: user?.id);
final offerings = await MoneyMaker.getOfferings();
final result = await MoneyMaker.purchasePackage(offerings.current!.packages.first);
if (result case PurchaseSuccess(:final customerInfo)) { /* customerInfo.isEntitled('premium') */ }
MoneyMaker.customerInfoStream.listen((info) => print(info.activeEntitlements));
```

API: `configure`, `logIn`, `logOut`, `getCustomerInfo`, `refreshCustomerInfo`, `isEntitled`, `customerInfoStream`, `setAttributes`, `getOfferings`, `purchasePackage`, `purchaseProduct`, `restorePurchases`, `syncPurchases` (iOS), `showManageSubscriptions`. Errors are thrown as `MoneyMakerException(code, message)`.

Platform differences: on Android, `CustomerInfo.purchases`, `accountToken`, `requestedAt` and `Entitlement.purchasedAt` are not exposed by the native SDK (empty/null); `purchaseProduct` only works for products that belong to an offering.

Full example: [`example/main.dart`](example/main.dart).

## Français

**Installation** : ajoutez la dépendance ci-dessus. iOS 16 minimum ; Android minSdk 23, le SDK natif vient de JitPack (ajoutez `maven { url 'https://jitpack.io' }` dans `settings.gradle` si votre projet interdit les dépôts au niveau des modules).

**Utilisation** : appelez `MoneyMaker.configure('mm_pub_…')` au démarrage, `logIn(id)` quand l'utilisateur se connecte, `getOfferings()` pour le paywall, `purchasePackage(p)` pour acheter, et écoutez `customerInfoStream` pour réagir aux changements de droits. `restorePurchases()` pour le bouton « Restaurer », `showManageSubscriptions()` pour gérer l'abonnement.

Différences Android : `purchases`, `accountToken`, `requestedAt` et `purchasedAt` ne sont pas fournis par le SDK natif (vides/null) ; `purchaseProduct` ne fonctionne que pour un produit présent dans une offre.

Après toute modification de `sdk/ios/Sources/MoneyMaker`, lancez `tool/sync_native_sources.sh`.
