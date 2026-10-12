# moneymaker-react-native

React Native + Expo SDK for **MoneyMaker** (self-hosted RevenueCat alternative). It wraps the native
SDKs: StoreKit 2 on iOS (`sdk/ios`) and Google Play Billing on Android (`sdk/android`).

Requirements: Expo SDK 52+ (or bare React Native with `expo-modules-core`), iOS 16+, Android minSdk 23.
Not supported in Expo Go: use a development build.

## Install / Installation

**Expo (managed / prebuild)**

```sh
npx expo install moneymaker-react-native
npx expo prebuild   # or: eas build
```

No config plugin required: Play Billing adds its permission itself, and In-App Purchase needs no entitlement.
Set `ios.deploymentTarget` to `16.0` with `expo-build-properties` if your project targets lower.

**Bare React Native**

```sh
npx install-expo-modules@latest   # once, if expo-modules-core is not set up yet
npm install moneymaker-react-native
cd ios && pod install
```

## Usage / Utilisation

```tsx
import MoneyMaker, { useEntitlement } from 'moneymaker-react-native';

MoneyMaker.configure({ apiKey: 'mm_pub_…', appUserId: user?.id }); // once, at startup

const offerings = await MoneyMaker.getOfferings();
const pkg = offerings.current?.packages[0];
if (pkg) {
  const result = await MoneyMaker.purchasePackage(pkg);
  if (result.status === 'success' && MoneyMaker.isEntitled('premium')) unlock();
}

const sub = MoneyMaker.addCustomerInfoListener((info) => console.log(info.activeEntitlements));
sub.remove();

function Gate() {
  const premium = useEntitlement('premium'); // live, cached offline
  return premium ? <Pro /> : <Paywall />;
}
```

## API

| Method | Returns | Notes |
| --- | --- | --- |
| `configure({ apiKey, appUserId?, baseUrl? })` | `void` | Once. Anonymous `$anon:…` id if no `appUserId`. |
| `logIn(appUserId)` / `logOut()` | `Promise<CustomerInfo>` / `Promise<void>` | Anonymous purchases are aliased to the new id. |
| `getCustomerInfo()` | `Promise<CustomerInfo>` | Cache if < 5 min, else network. |
| `refreshCustomerInfo()` | `Promise<CustomerInfo>` | Always network. |
| `getCachedCustomerInfo()` | `CustomerInfo \| null` | Sync. |
| `isEntitled(id)` | `boolean` | Sync, cached, offline. |
| `addCustomerInfoListener(fn)` | `{ remove() }` | Purchases, renewals, refunds, login. |
| `setAttributes(record)` | `Promise<void>` | `null` deletes a key. |
| `getOfferings()` | `Promise<Offerings>` | Dashboard paywall with store prices. |
| `purchasePackage(pkg, { offerToken? })` | `Promise<PurchaseResult>` | `{ status: 'success' \| 'userCancelled' \| 'pending' }` |
| `purchaseProduct(productId, { offerToken? })` | `Promise<PurchaseResult>` | Android: product must be in an offering. |
| `restorePurchases()` | `Promise<CustomerInfo>` | "Restore" button. |
| `syncPurchases()` | `Promise<void>` | iOS: silent StoreKit sync. Android: silent re-post. |
| `showManageSubscriptions()` | `Promise<void>` | iOS sheet / Play Store subscriptions page. |

Hooks: `useCustomerInfo()`, `useEntitlement(id)`. Helper: `isEntitled(info, id)`.
Dates are epoch milliseconds. Errors carry `error.code` (`not_configured`, `product_not_found`,
`unverified_transaction`, `network`, `no_activity`, `billing_<n>`, or the server error code).

## FR — en bref

SDK React Native / Expo de MoneyMaker, basé sur les SDK natifs (StoreKit 2 et Google Play Billing).
Installation Expo : `npx expo install moneymaker-react-native` puis `npx expo prebuild` (pas d'Expo Go,
pas de plugin de config nécessaire). React Native nu : `npx install-expo-modules@latest`, `npm install`,
puis `pod install`. Appelez `MoneyMaker.configure({ apiKey })` au démarrage, `getOfferings()` pour le
paywall, `purchasePackage(pkg)` pour acheter, `isEntitled('premium')` ou `useEntitlement('premium')`
pour débloquer, et `restorePurchases()` derrière le bouton « Restaurer ».

## Development

Native sources are copied from `../ios` and `../android` by `npm run sync-native` (run on `prepare`),
so the native SDKs stay the single source of truth.
