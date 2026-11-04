# Configurer MoneyMaker

MoneyMaker affiche en direct les revenus d'apps et de business (App Store, Google Play, Stripe). L'utilisateur t'a demandé de configurer son compte. Tu fais le travail ; il n'intervient que pour se connecter et te donner ses clés. Parle-lui dans sa langue, simplement, une étape à la fois.

## 1. Ajouter le serveur MCP

Adresse : `https://usemoneymaker.com/mcp` (HTTP, connexion OAuth). Selon ton outil :

- Claude Code : `claude mcp add --transport http moneymaker https://usemoneymaker.com/mcp`
- Codex : `codex mcp add moneymaker --url https://usemoneymaker.com/mcp`, puis `codex mcp login moneymaker`
- Cursor : ajoute à `~/.cursor/mcp.json` : `{"mcpServers":{"moneymaker":{"url":"https://usemoneymaker.com/mcp"}}}`
- Application sans ligne de commande (Claude, ChatGPT…) : demande à l'utilisateur d'ajouter un connecteur personnalisé avec cette adresse.

Les outils n'apparaissent souvent qu'après un redémarrage de la session, parfois avec un préfixe (`mcp__moneymaker__list_projects`). Dis à l'utilisateur quoi faire : redémarrer l'outil, puis lancer `/mcp` dans Claude Code pour s'authentifier. Il peut ensuite te redire « continue » : reprends à l'étape 2.

## 2. Créer le compte

À la première connexion, une page MoneyMaker s'ouvre dans le navigateur. L'utilisateur y choisit Google ou « Créer un compte », puis clique sur **Autoriser** en gardant la lecture et la modification. Toi, tu ne saisis jamais son mot de passe. Attends sa confirmation, puis appelle `list_projects` pour vérifier la connexion.

## 3. Créer le business

Si `list_projects` renvoie déjà le bon business, garde-le. Sinon demande son nom et ce qu'il vend. Pour une app iOS, trouve-la avec `search_app_store` et passe son ID en `appStoreAppId`. Pour une app Android, passe `googlePackageName`. Pour un business Stripe seul, le nom suffit. Fais confirmer, puis appelle `create_project` et garde le `projectId`, demandé par les outils suivants.

Le plan gratuit a un nombre limité de business. Si la création est refusée pour cette raison, explique que MoneyMaker Pro débloque les business illimités, sans rien acheter toi-même.

## 4. Brancher les revenus

Demande quelles sources il utilise, puis traite seulement celles-là.

| Source | Ce qu'il te faut | Outil |
|---|---|---|
| Stripe | Clé restreinte `rk_` de préférence (`sk_` accepté) : lecture Abonnements, Factures, Clients, Paiements, écriture Webhook Endpoints. Dashboard Stripe › Développeurs › Clés API | `connect_stripe` |
| App Store | Clé API App Store Connect, rôle App Manager ou Admin : issuer ID, key ID, contenu du `.p8`. Utilisateurs et accès › Intégrations | `connect_app_store` |
| Google Play | JSON d'un compte de service invité dans la Play Console, droits « Voir les données financières » et « Gérer les commandes », et le nom du package. L'outil renvoie un endpoint Pub/Sub à configurer dans la Play Console : transmets-le | `connect_google_play` |
| RevenueCat | Clé secrète `sk_`, pour importer l'historique | `import_revenuecat` |

Sécurité des clés : l'utilisateur peut te coller une clé ou t'indiquer le chemin d'un fichier (`.p8`, JSON) que tu lis pour le passer à l'outil. Ne les réaffiche jamais, ne les copie dans aucun fichier et ne les inscris pas dans le dépôt. S'il préfère ne pas te les confier, il peut brancher la source lui-même sur https://usemoneymaker.com, puis tu reprends à l'étape 5.

Si `connect_app_store` signale une URL de notifications serveur déjà configurée, demande avant de la remplacer avec `setNotificationUrl: true`.

## 5. Vérifier

N'annonce pas la réussite avant d'avoir vérifié :

1. `get_import_status` avec le `jobId` renvoyé par `import_revenuecat`, si tu as lancé cet import.
2. `get_setup_checklist` : traite ce qui manque, en signalant les étapes facultatives.
3. `get_overview` : montre à l'utilisateur ses vrais chiffres. Un compte à zéro après un branchement réussi peut simplement vouloir dire que l'import n'est pas terminé : dis-le.

## 6. Terminer sur l'iPhone

Dis à l'utilisateur d'ouvrir l'app MoneyMaker, de toucher **J'ai déjà un compte** et de se connecter **avec le même compte**, puis d'accepter les notifications. Appelle ensuite `send_test_push` : il doit entendre le son de vente. Termine par un résumé court : ce qui est branché, ce qui reste à faire.

## Règles

- Avant chaque écriture, dis ce que tu vas faire et obtiens son accord.
- Les montants `…Micros` se divisent par 1 000 000.
- En cas d'erreur, explique-la simplement et propose la suite. N'invente aucun chiffre.

Aide : https://usemoneymaker.com/support
