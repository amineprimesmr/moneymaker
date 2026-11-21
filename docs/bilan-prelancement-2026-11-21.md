# Bilan pré-lancement MoneyMaker — 21 nov. 2026

**Verdict : pas prêt pour le marketing.** Le cœur tient (tests verts, prod stable, aucun crash évident dans l'app, toutes les routes appelées existent). Mais il reste des données fausses en public, des failles exploitables avec la clé publique, et du travail en cours non déployé qui casse ce que la fiche App Store promet.

## Ce qui a été testé

| Check | Résultat |
|---|---|
| Tests backend (`npm test`) | 147/147 ✅ |
| Typecheck backend (`tsc`) | 0 erreur ✅ |
| SDK iOS `swift build` + `swift test` | ✅ (2 tests seulement) |
| `node --check` CLI / MCP | ✅ |
| Prod : 21 fonctions déployées = 21 exportées | ✅ |
| Prod : erreurs serveur sur 4 jours | 1 seul 502 isolé ✅ |
| Prod : temps de réponse | 50–270 ms ✅ |
| Appels app iOS → API | tous existent, sauf `/v1/feedback` |
| Appels dashboard → API | tous existent, champs OK sauf fiche client |
| Outils MCP (72) → API | tous existent ✅ |
| Fiche App Store (longueurs, Sign in with Apple, suppression de compte) | ✅ |
| Secrets commités | aucun ✅ (dépôt GitHub **public**) |
| `npm audit` backend | 1 faille haute (body-parser), corrigeable par `npm audit fix` |
| **Build de l'app iOS** | **non fait** : 14 Go libres (< 15) et load 16 |

## 🔴 BLOQUANTS

1. **Faux chiffres n°1 du classement public.** Le business « MoneyMaker » (`moneymaker-app`) contient ~443 abonnés fictifs (`mm_test_*`, marqués non-sandbox, ventes du 23–25 oct.). Résultat : `GET /v1/leaderboard` affiche MoneyMaker **1er avec 2 384 € de MRR**, et ton MRR global (2 585 €) est faux à 92 %. Aucun script dans le dépôt : injecté à la main. Les benchmarks ne l'excluent pas non plus (`benchmarks.ts:18`).
2. **Failles exploitables avec la clé `mm_pub_`** (publique, livrée dans les apps ; le code est public) :
   - **Démo pas en lecture seule** : `Authorization: mm_demo` sans `Bearer` passe toutes les écritures (`api.ts:62` vs `api.ts:1982`). On peut supprimer la démo, créer des business, un `mm_pat_`, publier au classement. ✔ vérifié.
   - **Vol d'abonnements** : `POST /v1/customers/<victime>/alias` déplace tous ses achats, sans exiger un id `$anon:` (`api.ts:444`, aussi `api.ts:949`). ✔ vérifié.
   - **Portail Stripe d'un autre client** : `/v1/customers/:id/stripe/portal` et `manage-link` avec la seule clé publique (`api.ts:483`, `api.ts:1825`).
   - **Produit choisi par le client lors d'un checkout Stripe** : on paie le prix le moins cher et on déclare `productId: premium_annual` (`stripe.ts:243`).
3. **Travail non commité et non déployé, qui casse des promesses** :
   - `POST /v1/feedback` → 404 en prod ; l'app affiche « route_not_found » (fonction mise en avant dans les nouveautés 1.1.1).
   - `freeLaunch = true` dans l'app, mais `FREE_LAUNCH` pas déployé : le serveur refuse encore le 2ᵉ business (402 `pro_required`) alors que l'app dit « illimité ».
   - Le dashboard en prod ne correspond à aucun commit (mélange).
4. **L'adresse de support ne reçoit rien.** `contact@moneymakerr.fr` : MX nul (vérifié). Seule adresse sur /support, /privacy, CGU, notes App Review. `usemoneymaker.com` n'a pas de MX.
5. **Notes App Review fausses** : `review-notes-en.md:7` demande de tester l'achat Pro, qui n'est plus proposé (`freeLaunch`). Les captures `7-paywall.png` montrent un écran inaccessible. Rejet 2.1 / 2.3.3 probable si l'achat est joint à la version.
6. **Suppression de compte** : en démo (le cas du reviewer) ou hors ligne, l'échec est silencieux (`LiveScreens.swift:1170`). Pas de révocation du jeton Sign in with Apple. Avis, signalements et codes cadeaux restent après suppression, alors que la confidentialité promet un effacement « immédiat et définitif ».
7. **Confidentialité** : `PrivacyInfo.xcprivacy` ne déclare rien alors que PostHog identifie l'utilisateur ; `privacy.html` oublie plusieurs sous-traitants (Translation, APNs, Stripe, CDN…) et les transferts hors UE ; **aucune mention légale** (éditeur, SIREN, hébergeur) exigée par la LCEN.
8. **SDK Android en Play Billing 7.1.1** : Google exige la v8 depuis le 31 août (prolongation jusqu'au 1er nov.). Tout client Android ne peut plus publier de mise à jour. Concerne aussi React Native et Flutter.

## 🟠 IMPORTANTS

**Chiffres faux (le cœur du produit)**
- Devises sans décimales (JPY, KRW…) divisées par 100 côté Stripe (`stripe.ts:38,85,185`, `connect.ts:68`, `resync.ts`).
- Toute devise hors d'une table de 30 taux fixes est convertie en **0** (`engine.ts:116`) ; taux jamais mis à jour.
- MRR Stripe : coupons ignorés, abonnements multi-articles et paliers à 0, renouvellement au prix catalogue.
- Churn : les essais expirés sont comptés comme des résiliations (`metrics.ts:104`).
- Google : abonnement annuel compté mensuel (MRR × 12) quand l'achat arrive par RTDN (`google.ts:61`), pas de renouvellements.
- Vente Checkout possiblement comptée deux fois (`stripe.ts:180` + `charge.succeeded`) — à confirmer.
- Dashboard : totaux du jour additionnant des devises différentes + sandbox (`screens.js:461`) ; fiche client qui lit des champs inexistants (`screens.js:537`).

**Sécurité / rôles**
- Un « developer » peut se créer une `mm_sk_` = admin ; membre retiré garde ses clés.
- RTDN Google protégé par un simple jeton d'URL, visible par un viewer.
- N'importe quelle clé déclenche des scans App Store lourds (facture).
- `mm_pat_` sans expiration ni révocation.
- Pas de CSP / `frame-ancestors` (page OAuth `/connect` piégeable en iframe).

**Pro (deviendra critique quand FREE_LAUNCH repassera à false)** : achat sandbox TestFlight = Pro à vie ; code cadeau réutilisable à l'infini ; webhook Pro ne vérifie pas le produit acheté.

**App iOS**
- Lien `moneymaker://auth?token=…` connecte à un autre compte sans confirmation.
- Après déconnexion, widgets et Live Activity gardent jusqu'à 3 h les données de l'ancien compte ; push pas réenregistrées pour le nouveau.
- Faux chiffres (1 284 €, « Mon app 59,99 € ») possibles dans la Live Activity / widgets hors ligne (`Today.placeholder`).
- Nouvel utilisateur sans business : écran de zéros, aucun bouton pour démarrer (c'est ce que verra une personne venue d'une pub).
- ~10 textes récents sans traduction anglaise (période mois calendaire, commission d'affiliation).

**Web**
- Pas de « mot de passe oublié » ; erreurs Firebase brutes en anglais ; validation du formulaire contournée à l'inscription ; pas de lien CGU à l'inscription.
- Bouton principal « Ajouter à Claude » vers une fiche d'annuaire peut-être pas encore acceptée, sans repli.
- Accueil qui ne parle que de Claude : rien sur l'alternative RevenueCat, le SDK, l'app iPhone.
- ~15 textes sans traduction EN ; pas de robots.txt, sitemap, og:image.

**Docs** : `llms.txt` décrit un MCP local à 11 outils (réel : hébergé, ~75) ; `mcp-docs.html` dit que l'assistant ne touche jamais aux clés (faux) ; « auto-hébergé » partout alors que c'est hébergé ; Flutter `ref: 1.1.1` antérieur à la migration Kotlin ; SDK publiés pointent encore sur `moneymaker-io.web.app`.

**Robustesse** : métriques qui relisent jusqu'à 730 jours de transactions à chaque affichage (timeout dès ~100 000 abonnés) ; `dailySnapshot` séquentiel sans timeout ; `storeResync` toutes les 15 min = milliers d'appels Stripe pour un gros marchand.

## 🟡 MINEURS (extrait)
`?limit=abc` → 500 ; injection de formules dans l'export CSV ; nom de projet avec emoji → 500 à l'export ; SSRF sans retour sur icônes/webhooks ; `exit(0)` après changement de langue ; requêtes de période non annulées (vieilles données qui écrasent les récentes) ; `app/AppStore.md` resté en 1.0 ; README public qui contient l'UDID de l'iPhone ; build 12 à passer en 13 si déjà envoyé ; `urssaf` en mot-clé FR.

## Ordre de correction proposé
1. Nettoyer `moneymaker-app` (ou le retirer du classement) — 10 min, avant toute com.
2. Fermer B1–B4 côté serveur (démo, alias anonyme, portail/manage-link en `mm_sk_`, prix → produit côté serveur).
3. Commiter + déployer le travail en cours (feedback, FREE_LAUNCH, dashboard), puis vérifier en prod.
4. Adresse de support qui marche + mentions légales + privacy/PrivacyInfo complets.
5. Notes App Review et captures alignées sur le lancement gratuit ; suppression de compte avec message d'erreur + révocation Apple.
6. Devises (sans décimales, taux manquants), churn des essais, période Google.
7. SDK Android → Play Billing 8, nouvelle 1.1.2 avec `usemoneymaker.com`.
8. Le reste (état vide, déconnexion propre, traductions, SEO, docs).

## État après corrections (21 nov. 2026, soir)
Fait et déployé (functions, firestore, hosting sur `moneymaker-io`), commit `2528160` :
- Bloquants 1, 2, 3, 6, 7 (sauf identité légale), 8 (SDK 1.2.0 prêt, pas publié) et tous les points 🟠 « chiffres », « sécurité », « app iOS », « web ».
- Fausses données de `moneymaker-app` supprimées (sauvegarde `~/Developer/backups/moneymaker-donnees-fictives-2026-11-21.json`).
- Tests backend 153/153, SDK iOS 10/10, SDK Android 20/20 (projet JVM de test), app iOS compilée et installée sur le 16 Pro Max.

Reste, à décider par Amine :
- Adresse de support réelle (provisoire : `contact@moneymakerr.fr`, domaine sans MX).
- Champs `[À COMPLÉTER]` de `legal.html` (éditeur, SIREN, adresse).
- Publication SDK 1.2.0 (tag git, JitPack, npm) ; SDK Android à réinstaller pour lancer Gradle.
- Section confidentialité de la fiche App Store Connect à aligner sur `PrivacyInfo.xcprivacy` (DeviceID inclus).
