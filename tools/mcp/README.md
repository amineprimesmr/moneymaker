# MoneyMaker MCP server

Serveur [MCP](https://modelcontextprotocol.io) sur stdio, sans dépendance (Node ≥ 18). Il appelle l'API REST MoneyMaker avec un jeton d'accès personnel.

## Installation dans Claude Code

1. Dashboard › Compte › « Jeton d'accès personnel » (ou `POST /v1/tokens`) → `mm_pat_…`.
2. Ajoute le serveur :

```sh
claude mcp add moneymaker -e MM_TOKEN=mm_pat_xxx -- node /chemin/vers/moneymaker/tools/mcp/index.js
```

Variables : `MM_TOKEN` (obligatoire), `MM_API_URL` (défaut `https://moneymaker-io.web.app`, ex. `http://127.0.0.1:5002` avec l'émulateur).

Autres clients (Claude Desktop, Cursor…) : `{"command": "node", "args": ["/chemin/tools/mcp/index.js"], "env": {"MM_TOKEN": "mm_pat_xxx"}}`.

## Outils

| Outil | API |
|---|---|
| `list_projects` | `GET /v1/projects` |
| `get_overview` `{days?}` | `GET /v1/overview` |
| `get_metrics` `{projectId, days?}` | `GET /v1/projects/:pid/metrics` |
| `get_chart` `{projectId, name, days?, resolution?, store?, country?, product?}` | `GET /v1/projects/:pid/charts/:name` (`name: "list"` → liste) |
| `get_ltv_prediction` `{projectId, groupBy?}` | `GET /v1/projects/:pid/ltv-prediction` |
| `list_customers` `{projectId, limit?, paying?}` | `GET /v1/projects/:pid/customers` |
| `get_customer` `{projectId, customerId}` | `GET /v1/projects/:pid/customers/:id` |
| `grant_entitlement` `{projectId, customerId, entitlement, days?}` | `POST /v1/projects/:pid/customers/:id/grant` |
| `list_events` `{projectId, limit?, before?}` | `GET /v1/projects/:pid/events` |
| `get_offerings` `{projectId}` | `GET /v1/projects/:pid` (config) |
| `update_offerings` `{projectId, offerings?, currentOffering?}` | `PATCH /v1/projects/:pid` |

Montants en micro-unités (÷ 1 000 000). Les rôles du business s'appliquent (un lecteur ne peut pas `grant_entitlement` ni `update_offerings`).

Test rapide :

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | MM_TOKEN=mm_pat_xxx node tools/mcp/index.js
```
