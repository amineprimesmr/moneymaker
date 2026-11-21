# MoneyMaker Android SDK

Kotlin SDK for MoneyMaker on **Google Play Billing Library 8.3.0**. minSdk 23, compileSdk 36, Java 17.
Version **1.2.0** ([changelog](../CHANGELOG.md)). Optional module `moneymaker-amazon` for the Amazon Appstore.

## Install (JitPack)

```kotlin
// settings.gradle.kts
dependencyResolutionManagement { repositories { google(); mavenCentral(); maven("https://jitpack.io") } }
// app/build.gradle.kts
dependencies { implementation("com.github.amineprimesmr:moneymaker:1.2.0") }
```

JitPack builds the git tag `1.2.0` with `jitpack.yml` (module `:moneymaker`, published as
`com.github.amineprimesmr:moneymaker`). It brings `com.android.billingclient:billing-ktx:8.3.0`.

## Use

```kotlin
MoneyMaker.configure(context, apiKey = "mm_pub_…", appUserId = user?.id,
    consumableProductIds = setOf("coins_100"))           // consumed after server validation, re-buyable
val offerings = MoneyMaker.shared.loadOfferings()          // throws MoneyMakerException if the API is unreachable
val pkg = offerings.current!!.packages.first()
MoneyMaker.shared.purchase(activity, pkg)                  // subscription: base plan without offer
MoneyMaker.shared.purchase(activity, pkg, offerId = "trial-7d")   // a specific offer
MoneyMaker.shared.logIn(user.id)                           // aliases, then re-syncs Play purchases
```

A `play_store` product id written `productId:basePlanId` in the dashboard selects that base plan.
Errors: `MoneyMakerException(code, status, billingResponseCode)`; `isRetryable` is true for network, 5xx and 429.

## Tests

```sh
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew :moneymaker:testReleaseUnitTest
```
