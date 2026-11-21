# MoneyMaker iOS SDK

Swift SDK for MoneyMaker (StoreKit 2): subscriptions, one-time purchases, entitlements, paywall and Customer Center.
iOS 16+, macOS 13+, watchOS 9+, tvOS 16+, visionOS 1+. Version **1.2.0** ([changelog](../CHANGELOG.md)).

## Install

Swift Package Manager, from the repository root manifest:

```swift
.package(url: "https://github.com/amineprimesmr/moneymaker", from: "1.2.0")
// target dependency: .product(name: "MoneyMaker", package: "moneymaker")
```

Xcode: File > Add Package Dependencies… > `https://github.com/amineprimesmr/moneymaker`, rule "Up to Next Major" from `1.2.0`.

## Use

```swift
import MoneyMaker

MoneyMaker.configure(apiKey: "mm_pub_…", appUserID: user?.id)   // default API: https://usemoneymaker.com/v1
let offerings = try await MoneyMaker.shared.loadOfferings()
let result = try await MoneyMaker.shared.purchase(offerings.current!.packages[0])
if MoneyMaker.shared.isEntitled("premium") { … }
try await MoneyMaker.shared.logIn(user.id)          // appUserID changes only if the server accepted it
try await MoneyMaker.shared.restorePurchases()      // throws StoreKitError.userCancelled if the sign-in is dismissed
```

Consumables need no configuration on iOS: StoreKit reports the product type to the server.

## Tests

```sh
swift test --build-path ~/Library/Developer/Xcode/DerivedData/moneymaker-sdk   # from the repository root
```
