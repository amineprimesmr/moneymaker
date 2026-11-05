# MoneyMaker — fiche App Store et dossier de review

## Fiche

| Champ | Valeur |
|---|---|
| Nom (30) | MoneyMaker : revenus des apps |
| Sous-titre (30) | MRR, ventes et net en direct |
| Catégorie | Finance (secondaire : Productivité) |
| Classification | 4+ (aucun contenu sensible) |
| Prix | Gratuit, sans achat intégré |
| Appareils | iPhone uniquement (iOS 17+) |
| URL de confidentialité | https://usemoneymaker.com/privacy |
| URL d'assistance | https://usemoneymaker.com/support |
| URL marketing | https://usemoneymaker.com/support |
| Copyright | © 2026 MoneyMaker |

**Mots-clés (100)** : `abonnements,indie,développeur,dashboard,widget,churn,saas,compta,urssaf,chiffre,affaires,finance,startup`

**Texte promotionnel (170)**
> Chaque vente de tes apps en direct, sur ton écran verrouillé. MRR, revenus, net après commissions et impôts, classements App Store dans 177 pays.

**Description**
> MoneyMaker réunit les revenus de toutes tes apps et produits numériques (App Store et Stripe) dans un seul tableau de bord, en temps réel.
>
> EN DIRECT
> • Notification « cha-ching » à chaque vente, essai ou remboursement
> • Revenus du jour sur l'écran verrouillé et dans la Dynamic Island (Live Activity)
> • Widgets : revenus du jour, ventes en direct, MRR avec objectif, tableau de bord, classements
>
> TES CHIFFRES
> • MRR, revenu par période, utilisateurs payants, téléchargements, essais, churn, conversion
> • Tous tes business ensemble, ou seulement ceux que tu choisis
> • La planète des ventes : d'où vient ton argent, pays par pays
>
> CE QU'IL TE RESTE VRAIMENT (optionnel)
> • Du brut au net en poche : TVA, commission App Store, frais Stripe, cotisations et impôts selon ton statut (micro-entreprise, SASU, EURL…)
> • Prochains virements, échéances URSSAF / impôts / TVA, dépenses, export comptable
>
> APP STORE
> • Classements dans 177 pays, alertes quand ton app grimpe ou entre dans un nouveau pays
>
> Crée ton compte directement dans l'app, puis connecte tes sources de revenus en quelques minutes. Les estimations fiscales sont indicatives et ne remplacent pas un expert-comptable.

**Nouveautés 1.0** : Première version.

## Confidentialité (questionnaire « App Privacy »)

Suivi publicitaire (tracking) : **Non**.

| Type de donnée | Collectée | Liée à l'utilisateur | Utilisée pour | Suivi |
|---|---|---|---|---|
| Coordonnées → Adresse e-mail | Oui | Oui | Fonctionnalités de l'app | Non |
| Identifiants → ID utilisateur | Oui | Oui | Fonctionnalités de l'app | Non |
| Achats → Historique d'achats (ventes des apps du développeur) | Oui | Oui | Fonctionnalités de l'app | Non |
| Données financières → Autres (statut, taux, dépenses — optionnel) | Oui | Oui | Fonctionnalités de l'app | Non |
| Identifiants → ID d'appareil (jeton de notification) | Oui | Oui | Fonctionnalités de l'app | Non |
| Diagnostics, localisation, contacts, contenu utilisateur, navigation | Non | — | — | — |

## Notes pour la review (à coller dans « App Review Information »)

> MoneyMaker is a free companion app for app developers: it shows the revenue of their own apps (App Store, Stripe) collected by the MoneyMaker service. There are no in-app purchases and nothing to buy.
>
> NO LOGIN NEEDED FOR REVIEW: on the first screen, tap "Découvrir avec un exemple". This opens a read-only demo business ("Focus Timer") with realistic sample data, updated every hour: revenue, MRR, live sales feed, world map, widgets and settings.
>
> Account creation is also available in the app: "Se connecter ou créer un compte" with email. Account deletion: Réglages (Settings) → "Supprimer mon compte" (for a real account; the demo is read-only).
>
> Notifications are optional and only report the developer's own sales. The Live Activity shows today's revenue. Tax/net figures are clearly labeled as estimates, not financial advice.
>
> Build 1.0 (5): per Guideline 2.3.10, all references to other platforms were removed from the description, keywords and the app itself. Sign-in is email only (no third-party login).

## État de préparation

| Point | État |
|---|---|
| Build Release signé (distribution, push production, sans chiffrement propriétaire) | ✅ |
| iPhone uniquement | ✅ |
| Connexion et création de compte dans l'app (e-mail uniquement, pas de connexion tierce → 4.8 sans objet) | ✅ |
| Suppression du compte dans l'app (5.1.1(v)) | ✅ |
| Pages confidentialité / conditions / aide | ✅ en ligne (contact@moneymakerr.com) |
| Fiche App Store (texte, mots-clés, catégorie, classification) | ✅ ci-dessus |
| Questionnaire App Privacy | ✅ ci-dessus |
| Accès pour la review | ✅ mode démo sans compte (« Découvrir avec un exemple »), connexion non requise |
| Captures d'écran 6,7" (1290×2796) | ✅ 4 captures envoyées |
| Fiche App Store Connect | ✅ app 6821596839 |
| Clé APNs (notifications) | ✅ HY8R5SV868 dans Firestore `system/apns`, testée (200) |

## Historique de review

- **20 oct. 2026, 1.0 (3) refusée, 2.3.10** : mentions de Google Play dans la description. Corrigé dans le build 1.0 (5) : plus aucune mention d'une autre plateforme (fiche, mots-clés, app, démo, page d'aide). Connexion Google retirée de l'app (4.8). Captures refaites sans l'écran Pilotage supprimé (2.3.3). Mention « estimation, pas un conseil fiscal » sous le détail du net. Démo : suppression de compte et réglages fiscaux masqués (lecture seule).
- **27 oct. 2026, 1.1 (6) refusée, 2.1(a)** (iPad Air M4) : « Business illimités » (Réglages) sans effet, car le paywall était présenté depuis la racine alors que les Réglages sont déjà en plein écran. Corrigé dans 1.1 (7) : paywall présenté par les Réglages, vérifié par test UI sur simulateur iPad (`UITests/PaywallButtonTests.swift`, `MM_PAYWALL_TEST=1`), qui échoue sur l'ancien code. « Play » retiré du paywall (2.3.10). Notes de revue mises à jour : Pro y est décrit, au lieu de « nothing to buy ».
- **5 nov. 2026, 1.1 (10) refusée, 2.1(a)** (iPad Air 11 M3, iPadOS 27.2) : « the app did not respond when we attempted to login ». Journaux serveur : aucune requête de l'iPad sur `/v1` pendant la review, donc ni lien démo abouti, ni jeton créé. Aucun compte Apple ni e-mail n'existait dans Firebase : ces deux parcours n'avaient jamais servi en production. Bug trouvé à la lecture : connexion par lien pendant l'intro → écran du lancement figé (`holdsSplash` jamais remis à faux). Corrigé dans 1.1 (11) : bouton « Essayer la démo » visible sans lien, bouton Apple natif sans surcouche, un message à chaque échec, délai de 20 s, Google Play retiré de l'onboarding. Cause exacte du bouton touché non prouvée.
- **Règle pour la suite** : la démo se lance d'un bouton dans l'app, jamais d'un lien à ouvrir dans Safari. Tester Apple et e-mail sur un vrai compte avant chaque soumission qui touche à la connexion.
- **Règle pour la suite** : les captures ne doivent pas avoir de canal alpha (`sips -g hasAlpha`), refus d'Apple sinon. iPad pris en charge = captures iPad 13 pouces obligatoires dans la langue principale (fr-FR).
- **Règle pour la suite** : ne jamais citer Google Play, Android ni une autre plateforme dans la fiche ou dans l'app iOS. Ne jamais remettre de connexion tierce (Google…) sans « Se connecter avec Apple ».

## Langues de l'app (5 nov. 2026)

- Les clés des catalogues de textes sont en français, mais `sourceLanguage` vaut `en` et `CFBundleDevelopmentRegion` aussi : l'anglais sert de langue par défaut dans le monde.
- Chaque chaîne doit donc avoir une valeur `en` **et** une valeur `fr`. Sans `fr` explicite, un iPhone français retombe sur l'anglais pour tout le catalogue, si `fr.lproj/Localizable.strings` n'existe pas.
- Les images d'onboarding ont une variante par langue dans `Assets.xcassets` (`locale: en` et `locale: fr`).
- Les messages d'erreur du serveur sont traduits dans l'app d'après leur code (`APIError.server`).
