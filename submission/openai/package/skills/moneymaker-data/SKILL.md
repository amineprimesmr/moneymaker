---
name: moneymaker-data
description: Analyse and manage the user's MoneyMaker app business data through the moneymaker MCP tools — revenue, MRR, subscribers, trials, churn, LTV, customers, transactions, App Store rankings and reviews, finance (VAT, net, payouts), growth charts, cohorts, alerts, configuration and team. Use when the user asks about their app revenue, sales, subscribers, MoneyMaker, or wants to change a MoneyMaker setting.
---

# MoneyMaker data

1. Start with `get_overview` (all businesses at once) or `list_projects` to get `projectId`s.
2. Amounts are micro-units: divide every `…Micros` field by 1,000,000 and show the `currency`. Timestamps are Unix ms.
3. Pick the narrowest tool: today → `get_today`; trend → `get_chart` (`mrr`, `revenue`, `churn`, `trial_conversion_rate`…); one customer → `get_customer`; why did it move → `list_anomalies`, `list_events`, `list_alerts`; money in pocket → `get_finance`.
4. Before any write, state exactly what will change and wait for the user's yes. `update_project` / `update_offerings` replace whole fields: read `get_project` / `get_offerings` first and send the full list.
5. Destructive tools (`delete_project`, `remove_member`, `revoke_invite`, `delete_expense`, `remove_tracked_app`, `disconnect_posthog`, `grant_entitlement` with `days: 0`) first return `confirmationRequired`; call again with `confirm: true` only after explicit consent. `delete_project` permanently deletes a whole business (owner only): metrics, customers, settings, API keys and logo, with no undo — name the business and say it is irreversible before asking.
6. Store credentials: `connect_stripe`, `connect_app_store`, `connect_google_play`, `connect_posthog` and `set_store_credentials` (and `import_revenuecat`) write keys to the server. They are never read back or returned (`get_project` only shows whether a credential is present). Pass keys only as tool arguments and never repeat them in replies.
7. A read-only connection (scope `moneymaker:read`) has no write tools: to change something, the user reconnects MoneyMaker allowing changes.
