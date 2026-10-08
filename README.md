# MoneyMaker

Alternative auto-hébergée à RevenueCat : un seul backend pour les abonnements **App Store (StoreKit 2)**, **Google Play Billing** et **Stripe**, avec dashboard multi-business, app iPhone + widgets, SDK iOS/Android et webhooks signés vers tes propres serveurs. 0 % de commission.

- Dashboard : https://moneymaker-io.web.app
- API : `https://moneymaker-io.web.app/v1`
- Doc pour agents : https://moneymaker-io.web.app/llms.txt (même contenu lisible sur `/docs`)

## Structure

| Dossier | Contenu |
|---|---|
| `backend/functions` | Cloud Functions (europe-west1) : `api` (routeur HTTP), `deliverEvent` (webhooks sortants signés, réessais), `dailySnapshot` (historique MRR) |
| `backend/functions/src/engine.ts` | Cœur pur : statuts, accès (entitlements), événements, MRR/churn — testé unitairement |
| `backend/functions/src/{apple,google,stripe}.ts` | Vérification JWS Apple + App Store Server API, Play Developer API + RTDN, webhooks Stripe |
| `dashboard/public` | Dashboard web (Firebase Hosting, sans build), `llms.txt`, `/docs` |
| `sdk/ios` | Swift Package `MoneyMaker` (StoreKit 2, paywall SwiftUI, `.requiresEntitlement`) |
| `sdk/android` | Bibliothèque Kotlin `io.moneymaker:moneymaker` (Play Billing 7) |
| `app` | App iPhone MoneyMaker + widgets (écran d'accueil et écran verrouillé) |
| `skills/moneymaker` | Skill Claude Code pour intégrer MoneyMaker dans n'importe quelle app |

## Modèle de données (Firestore, accès serveur uniquement)

`projects/{id}` (config publique) · `projects/{id}/private/credentials` (clés stores, jamais renvoyées) · `projects/{id}/customers/{appUserId}/purchases/{id}` · `events` · `transactions` · `daily` · `index` (lien store → client) · `apiKeys/{sha256}` (clés stockées hachées).

Clés : `mm_pub_` (apps, lecture client + achats), `mm_sk_` (serveurs, gestion d'un projet), `mm_pat_` (jeton personnel : tous tes business, app iPhone, agents).

## Développement

```bash
cd backend/functions && npm install && npm test        # tests unitaires
firebase emulators:exec --project demo-moneymaker --only functions,firestore,auth,hosting "node backend/functions/tests/e2e.mjs"
cd sdk/ios && swift test
cd sdk/android && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew :moneymaker:testReleaseUnitTest
```

Déploiement : `firebase deploy --project moneymaker-io --only functions,hosting,firestore` (les tests tournent en predeploy).

App iPhone (iPhone 14 Pro Max uniquement) :

```bash
cd app && xcodegen generate && nice -n 15 xcodebuild -project MoneyMakerApp.xcodeproj -scheme MoneyMaker -destination 'id=00008120-0000158022D0C01E' -derivedDataPath ~/Library/Developer/Xcode/DerivedData/moneymaker-app -jobs 4 build
```

## Brancher une app

Le plus rapide : dashboard → business → **Branchement** → « Copier le prompt », à coller dans ton agent. Détails complets dans `llms.txt`.
