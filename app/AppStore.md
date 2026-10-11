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
| URL de confidentialité | https://moneymaker-io.web.app/privacy |
| URL d'assistance | https://moneymaker-io.web.app/support |
| URL marketing | https://moneymaker-io.web.app |
| Copyright | © 2026 MoneyMaker |

**Mots-clés (100)** : `revenuecat,mrr,abonnements,revenus,app store,stripe,google play,ventes,indie,dashboard,widget,churn`

**Texte promotionnel (170)**
> Chaque vente de tes apps en direct, sur ton écran verrouillé. MRR, revenus, net après commissions et impôts, classements App Store dans 177 pays.

**Description**
> MoneyMaker réunit les revenus de toutes tes apps et produits numériques — App Store, Google Play et Stripe — dans un seul tableau de bord, en temps réel.
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
> • Du brut au net en poche : TVA, commissions Apple / Google, frais Stripe, cotisations et impôts selon ton statut (micro-entreprise, SASU, EURL…)
> • Prochains virements des stores, échéances URSSAF / impôts / TVA, dépenses, export comptable
>
> APP STORE
> • Classements dans 177 pays, alertes quand ton app grimpe ou entre dans un nouveau pays
>
> MoneyMaker se connecte en quelques minutes sur moneymaker-io.web.app (App Store Connect, Google Play, Stripe). Les estimations fiscales sont indicatives et ne remplacent pas un expert-comptable.

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

> MoneyMaker is a free companion app for app developers: it shows the revenue of their own apps (App Store, Google Play, Stripe) collected by the MoneyMaker web service. There are no in-app purchases and nothing to buy.
>
> NO LOGIN NEEDED FOR REVIEW: on the first screen, tap "Découvrir avec un exemple" (read-only demo business "Focus Timer", sample data refreshed hourly, token `mm_demo`).
>
> Account deletion: Réglages (Settings tab) → "Supprimer mon compte".
> Notifications are optional and only report the developer's own sales. The Live Activity shows today's revenue.
> Tax/net figures are clearly labeled as estimates, not financial advice.

## État de préparation

| Point | État |
|---|---|
| Build Release signé (distribution, push production, sans chiffrement propriétaire) | ✅ |
| iPhone uniquement | ✅ |
| Connexion et création de compte dans l'app (Google / e-mail) | ✅ |
| Suppression du compte dans l'app (5.1.1(v)) | ✅ |
| Pages confidentialité / conditions / aide | ✅ en ligne (contact@moneymakerr.com) |
| Fiche App Store (texte, mots-clés, catégorie, classification) | ✅ ci-dessus |
| Questionnaire App Privacy | ✅ ci-dessus |
| Accès pour la review | ✅ mode démo sans compte (« Découvrir avec un exemple »), connexion non requise |
| Captures d'écran 6,7" (1290×2796) | ✅ 4 captures envoyées |
| Fiche App Store Connect | ✅ app 6821596839 |
| Clé APNs (notifications) | ✅ HY8R5SV868 dans Firestore `system/apns`, testée (200) |
