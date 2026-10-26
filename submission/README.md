# Dossier de soumission — connecteur MoneyMaker (Claude + ChatGPT)

Tout est prêt et testé en production. Il reste à **envoyer les deux formulaires** (comptes d'Amine).
Identifiants du compte relecteur : `submission/reviewer-credentials.txt` (local, ignoré par git ;
régénérer : `cd backend/functions && GCLOUD_PROJECT=moneymaker-io node tests/seed-reviewer.cjs`).
Re-vérifier avant d'envoyer : `cd backend/functions && node tests/mcp-prod-check.mjs` (OAuth réel + 52 outils).

## Champs communs

| Champ | Valeur |
|---|---|
| Nom | MoneyMaker |
| URL du serveur MCP | `https://moneymaker-io.web.app/mcp` (Streamable HTTP) |
| Authentification | OAuth 2.1 — découverte auto (`/.well-known/oauth-protected-resource/mcp`), enregistrement dynamique, PKCE S256 |
| Scopes | `moneymaker:read`, `moneymaker:write` |
| Callback Claude | `https://claude.ai/api/mcp/auth_callback` (autorisé) |
| Callback ChatGPT | `https://chatgpt.com/connector_platform_oauth_redirect` (autorisé, tout chemin sur chatgpt.com) |
| Site | https://moneymaker-io.web.app |
| Documentation | https://moneymaker-io.web.app/mcp-docs |
| Confidentialité | https://moneymaker-io.web.app/privacy (section « Assistants IA ») |
| Conditions | https://moneymaker-io.web.app/terms |
| Support | https://moneymaker-io.web.app/support |
| Logo | `dashboard/public/icon-512.png` (512×512) |
| Catégorie | Finance / Business analytics |
| Outils | 68 : 43 lecture (`readOnlyHint`), 20 écriture, 5 suppressions (`destructiveHint`, `confirm: true`). Liste : `/mcp-docs` |

**Description courte (EN)** : Revenue and subscription analytics for your apps — MRR, subscribers, customers, App Store rankings, reviews and finance.

**Description courte (FR)** : Les revenus et abonnements de tes apps — MRR, abonnés, clients, classements App Store, avis et finance.

**Description longue (EN)** :
MoneyMaker tracks in-app subscription revenue across the App Store, Google Play, Stripe, Paddle, Amazon and Roku. Connect it to ask about MRR, revenue, active subscribers, trials, churn, LTV and cohorts across all your apps; open a customer's full history; follow App Store rankings, ratings and reviews; see VAT, store fees and net income; and get anomaly alerts and insights. With write access, the assistant can create a business, update offerings, tracked apps, alert preferences, expenses, promotional access and team invitations — always with your approval, and every change is recorded in the audit log. Store credentials are never exposed. Read-only access is available.

**Exemples de questions** :
1. « How much did I make this week across all my apps? »
2. « Why did MRR drop on Focus Timer this month? »
3. « Which countries convert best from trial to paid? »
4. « Show me the latest 1-star App Store reviews and translate them. »
5. « What's my net income after VAT and store fees for the last 28 days? »

**Compte de test** (données fictives : business « Focus Timer (demo) », 80 clients, classements, avis, alertes, offerings) :
se connecter sur la page MoneyMaker qui s'ouvre pendant l'OAuth, **e-mail + mot de passe** (pas Google), pas de 2FA ni de code.

## Scénarios de test (ChatGPT en demande 5 positifs + 3 négatifs)

Positifs :
1. « List my businesses » → `list_projects` renvoie « Focus Timer (demo) ».
2. « What is my MRR and how many active subscribers do I have? » → `get_overview` / `get_metrics`, montants en EUR.
3. « Show the MRR chart for the last 30 days » → `get_chart` name=mrr.
4. « Show the App Store reviews of Focus Timer » → `list_tracked_apps` puis `list_app_reviews` (5 avis).
5. « Give customer reviewer_user_1 7 days of premium » → `grant_entitlement` (outil d'écriture, l'assistant demande confirmation).

Négatifs :
1. « Delete the Hosting expense » sans confirmer → `delete_expense` renvoie `confirmationRequired`, rien n'est supprimé.
2. Connexion en lecture seule puis « Rename my business » → aucun outil d'écriture listé ; refus « lecture seule ».
3. « Show metrics for project xyz » (inexistant) → erreur `HTTP 404 project_not_found`, aucune donnée.

## Claude — envoyer

1. claude.ai › paramètres d'administration de l'organisation › **Connectors** › **Submit to directory**
   (organisation Team/Enterprise, rôle Owner ; formulaire : https://claude.com/docs/connectors/building/submission).
2. Coller les champs ci-dessus, l'URL du serveur, le compte de test.
3. Annotations déjà conformes : chaque outil a `title` + `readOnlyHint` / `destructiveHint`.

## ChatGPT — envoyer

1. platform.openai.com › Settings › Organization › **Verification** (identité / entreprise) — obligatoire avant de soumettre.
2. platform.openai.com › **Apps** (ou Plugins) › New › « With MCP » › URL `https://moneymaker-io.web.app/mcp`, auth OAuth.
3. Métadonnées ci-dessus, pays (tous), compte de test, 5 + 3 scénarios. Une seule version en revue à la fois.

## Après acceptation

Remplacer dans le dashboard (`ASSISTANTS` dans `dashboard/public/app.js`) les liens « Ajouter à Claude / ChatGPT »
par la fiche de l'annuaire : un seul clic « Connecter », plus d'URL à coller.
