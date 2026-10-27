# MoneyMaker MCP

Le serveur MCP est **hébergé** dans la fonction `api` (Firebase `moneymaker-io`, europe-west1) :
`https://usemoneymaker.com/mcp` — Streamable HTTP sans état, OAuth 2.1 (DCR + PKCE) ou jeton `mm_pat_…`.
Guide utilisateur : https://usemoneymaker.com/mcp-docs · autorisations : https://usemoneymaker.com/connect

Code : `backend/functions/src/mcp/` — `tools.ts` (catalogue, chaque outil appelle une route `/v1` via
`dispatch()` en mémoire : mêmes rôles, validations et audit), `server.ts` (JSON-RPC, découverte OAuth),
`oauth.ts` + `policy.ts` (serveur d'autorisation, calqué sur le connecteur V2). Consentement : `dashboard/public/connect.html`.

Ce dossier ne contient plus qu'un **pont stdio** vers le serveur hébergé, pour les clients sans HTTP :

```sh
claude mcp add moneymaker -e MM_TOKEN=mm_pat_xxx -- node /chemin/vers/moneymaker/tools/mcp/index.js
```

Préférer la connexion directe : `claude mcp add --transport http moneymaker https://usemoneymaker.com/mcp`.

## Tests

```sh
cd backend/functions && npm run build
MM_TOKEN=mm_demo node tests/mcp-live.mjs                 # outils de lecture contre l'API de prod (données de démo)
MM_TOKEN=mm_pat_xxx node tests/mcp-live.mjs get_metrics  # un outil précis, avec ton jeton
# Parcours OAuth complet + écritures, sur émulateurs :
JAVA_HOME=/opt/homebrew/opt/openjdk@21 firebase emulators:exec --project demo-moneymaker --only functions,firestore,auth,hosting "node backend/functions/tests/mcp-e2e.mjs"
```
