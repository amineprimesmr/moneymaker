# Set up MoneyMaker

MoneyMaker shows live revenue for apps and businesses (App Store, Google Play, Stripe). The user asked you to set up their account. You do the work; they only step in to sign in and give you their keys. Speak to them in their language, simply, one step at a time.

## 1. Add the MCP server

Address: `https://usemoneymaker.com/mcp` (HTTP, OAuth sign-in). Depending on your tool:

- Claude Code: `claude mcp add --transport http moneymaker https://usemoneymaker.com/mcp`
- Codex: `codex mcp add moneymaker --url https://usemoneymaker.com/mcp`, then `codex mcp login moneymaker`
- Cursor: add to `~/.cursor/mcp.json`: `{"mcpServers":{"moneymaker":{"url":"https://usemoneymaker.com/mcp"}}}`
- App without a command line (Claude, ChatGPT…): ask the user to add a custom connector with this address.

Tools often appear only after the session restarts, sometimes with a prefix (`mcp__moneymaker__list_projects`). Tell the user what to do: restart the tool, then run `/mcp` in Claude Code to authenticate. They can then tell you "continue": resume at step 2.

## 2. Create the account

On first sign-in, a MoneyMaker page opens in the browser. The user chooses Google or "Create account", then clicks **Authorize**, keeping read and write access. You never type their password. Wait for their confirmation, then call `list_projects` to check the connection.

## 3. Create the business

If `list_projects` already returns the right business, keep it. Otherwise ask its name and what it sells. For an iOS app, find it with `search_app_store` and pass its ID as `appStoreAppId`. For an Android app, pass `googlePackageName`. For a Stripe-only business, the name is enough. Get confirmation, then call `create_project` and keep the `projectId`, which the next tools need.

MoneyMaker is free during launch, with unlimited businesses: there is nothing to buy. If creation is refused anyway, explain the error and never buy anything yourself.

## 4. Connect revenue

Ask which sources they use, then handle only those.

| Source | What you need | Tool |
|---|---|---|
| Stripe | Restricted key `rk_` preferred (`sk_` accepted). Write: Webhook Endpoints, Subscriptions (adds `app_user_id` to metadata), Checkout Sessions and Customer portal (only for web checkout and subscription management). Read: Charges, Refunds, Customers, Invoices, Payment Intents, Prices, Products, Promotion codes. Optional: read Account (shows the account name). Stripe Dashboard › Developers › API keys | `connect_stripe` |
| App Store | App Store Connect API key, App Manager or Admin role: issuer ID, key ID, contents of the `.p8`. Users and Access › Integrations | `connect_app_store` |
| Google Play | JSON of a service account invited in Play Console, with "View financial data" and "Manage orders" permissions, and the package name. The tool returns a Pub/Sub endpoint to set in Play Console: pass it on | `connect_google_play` |
| RevenueCat | Secret key `sk_`, to import history | `import_revenuecat` |

Key safety: the user can paste a key or give you the path of a file (`.p8`, JSON) that you read to pass to the tool. Never display them again, never copy them into a file and never add them to the repository. If they'd rather not share them, they can connect the source themselves on https://usemoneymaker.com, then you resume at step 5.

If `connect_app_store` reports a server notification URL already set, ask before replacing it with `setNotificationUrl: true`.

## 5. Check

Don't announce success before checking:

1. `get_import_status` with the `jobId` returned by `import_revenuecat`, if you ran that import.
2. `get_setup_checklist`: handle what's missing, flagging optional steps.
3. `get_overview`: show the user their real numbers. A zero account after a successful connection may simply mean the import isn't finished: say so.

## 6. Finish in the app

Tell the user to open the MoneyMaker app, tap **I already have an account** and sign in **with the same account**, then allow notifications. Then call `send_test_push`: they should hear the sale sound. Finish with a short summary: what's connected, what's left to do.

## Rules

- Before each write, say what you're going to do and get their agreement.
- `…Micros` amounts are divided by 1,000,000.
- If an error occurs, explain it simply and suggest what's next. Never make up a number.

Help: https://usemoneymaker.com/support
