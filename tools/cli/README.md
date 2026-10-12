# mm — CLI MoneyMaker

CLI sans dépendance (Node ≥ 18), mêmes commandes que le serveur MCP (`tools/shared/client.mjs`).

```sh
export MM_TOKEN=mm_pat_xxx            # Dashboard › Compte › jeton d'accès personnel
alias mm="node /chemin/vers/moneymaker/tools/cli/mm.js"   # ou : cd tools/cli && npm link

mm help
mm list-projects
mm get-overview --days 7
mm get-metrics --project <pid> --days 30
mm get-chart --project <pid> --name mrr --days 90 --resolution week
mm get-ltv-prediction --project <pid> --group-by country
mm list-customers --project <pid> --paying
mm get-customer --project <pid> --customer <appUserId>
mm grant-entitlement --project <pid> --customer <appUserId> --entitlement premium --days 7
mm list-events --project <pid> --limit 20
mm get-offerings --project <pid> --json > offerings.json
mm update-offerings --project <pid> --offerings @offerings.json --current-offering default
```

`--json` affiche la réponse brute. Une valeur `@fichier` est lue depuis le disque. `MM_API_URL` change la base (défaut `https://moneymaker-io.web.app`).
