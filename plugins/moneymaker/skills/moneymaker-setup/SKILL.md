---
name: moneymaker-setup
description: Onboard a user on MoneyMaker end to end from Claude — create the business, connect App Store Connect, Google Play, Stripe, RevenueCat and PostHog (reusing the connectors already in this session to fetch keys and app ids), check the setup checklist and send a test push. Use when the user says /moneymaker-setup, "set up MoneyMaker", "connect my apps/Stripe/RevenueCat to MoneyMaker", or has just installed the MoneyMaker connector.
---

# MoneyMaker setup — from zero to first sale, inside Claude

Goal: the user types one command and ends with a connected business, a green `/setup` checklist and a
test push on their iPhone. Do the work yourself; ask only for what you cannot fetch.

## 0. Permissions (once)

- If the MoneyMaker tools are missing, the connector is not connected: Claude Code → `/mcp` › moneymaker ›
  Authenticate; claude.ai → Settings › Connectors › MoneyMaker › Connect. Ask for **read + write**.
- Claude Code: to stop per-call prompts, offer to add `"mcp__plugin_moneymaker_moneymaker"` to
  `permissions.allow` in `~/.claude/settings.json` (or `"mcp__moneymaker"` if added with `claude mcp add`).
  Edit it only after the user says yes.
- Before the first write, show **one summary** of everything you will connect and get one "go".
  Destructive tools still need `confirm: true` after an explicit yes, each time.

## 1. Discover what is already available

List the tools of this session and note which of these exist (names vary — match by vendor):
Stripe MCP, RevenueCat MCP, PostHog MCP, App Store Connect (`asc` CLI or an ASC MCP), Google Play/GCP.
Then call `list_projects` and `get_setup_checklist` for any existing business — never create a duplicate.

## 2. Business

`search_app_store` with the app name → `create_project` with `appStoreAppId` (and `googlePackageName`
if Android). Keep the returned `projectId`; the public SDK key may be shown, the secret key is never shown.

## 3. Connect each source (skip the ones the user doesn't use)

| Source | Get it yourself if you can | Otherwise, minimal steps for the user | Tool |
|---|---|---|---|
| App Store Connect | `asc` CLI / ASC MCP: issuer id, key id, app Apple ID (`asc apps list`) | https://appstoreconnect.apple.com/access/integrations/api → Team Keys → **+** → role **App Manager** → download the .p8 once, copy Issuer ID and Key ID | `connect_app_store` |
| Google Play | GCP connector: create a service account JSON | Play Console → Users and permissions → invite the service account email with **View financial data** + **Manage orders** | `connect_google_play` |
| Stripe | Stripe MCP: create a restricted key (read Subscriptions, Invoices, Customers, Charges; write Webhook Endpoints) | https://dashboard.stripe.com/apikeys → **Create restricted key** with those rights | `connect_stripe` |
| RevenueCat | RevenueCat MCP: project id and a v1 secret key | https://app.revenuecat.com → Project settings › API keys → **+ New secret API key** (v1) | `import_revenuecat` then `get_import_status` until done |
| PostHog | PostHog MCP: project id and host | https://eu.posthog.com/settings/user-api-keys → personal key with **query:read, project:read** | `connect_posthog` |
| Paddle / Amazon / Roku / AppsFlyer | — | key from their console | `set_store_credentials` |

For a .p8 or JSON file on disk, read it and pass the content straight to the tool.

Rules for secrets:
- Pass keys only as tool arguments. Never repeat a key, private key, JSON or password in your replies,
  summaries or code blocks — say "the key ending in …4F2" at most.
- Don't write secrets to files in the repo. Don't ask the user to paste a key you could fetch yourself.
- If App Store notifications already point at another backend, `connect_app_store` leaves them alone:
  tell the user and set `setNotificationUrl: true` only if they agree.

## 4. Products and offerings

After the connections, `get_offerings` / `get_project`: products imported from the stores land in the
first entitlement (`premium`). If there is no offering yet, propose one (`update_offerings`) with the
monthly/annual products, summarised in one line, and apply on yes.

## 5. Verify and finish

1. `get_setup_checklist` → fix or explain every step still open.
2. `send_test_webhook` if webhooks are configured.
3. `send_test_push` → if `no_device`, tell the user to install the MoneyMaker iPhone app, sign in and allow
   notifications, then retry.
4. End with a short recap: what is connected, what is pending (e.g. waiting for the first real purchase),
   and three questions they can ask now ("How much did I make this week?").
