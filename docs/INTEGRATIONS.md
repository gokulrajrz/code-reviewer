# Integrations: Zoho Cliq Notifications

The AI Code Reviewer possesses a native **Zoho Cliq Chatbot Integration** heavily built into the `Reducer` endpoint of the Map-Reduce pipeline.

When a Pull Request review finalizes via the Sandbox, the Worker dispatches the review JSON to a Zoho Cliq bot, automatically piping heavily structured Rich-Card outputs mapping the Check Run badge (`Success` / `Failure`) alongside key metrics directly to your organization.

## Registering The Application

1. Open your Zoho Cliq Application and navigate to the **API & Bots** interface.
2. Register a new Bot application (e.g., `PR Code Reviewer Bot`).
3. Under the **OAuth 2.0 Credentials**, generate a long-lived Webhook / OAuth Refresh Token instance.

## Connecting OAuth Secrets to Cloudflare

The integration requires configuring 4 distinct Secret Variables via `wrangler secret`:

```bash
# Your generated Zoho Cliq Client ID
npx wrangler secret put CLIQ_CLIENT_ID

# Your generated Zoho Cliq Client Secret Key
npx wrangler secret put CLIQ_CLIENT_SECRET

# The 60-day or Permanent OAuth Refresh Token
npx wrangler secret put CLIQ_REFRESH_TOKEN

# The target Channel ID or UID mapping for the Bot's Rich-Card push
npx wrangler secret put CLIQ_CHANNEL_ID
```

## Configuring Worker Variables

The `wrangler.jsonc` file heavily restricts the integration via configuration variables. Ensure these variables match your precise Bot names:

```jsonc
	"vars": {
        // The programmatic Bot handle that executes the messages.
		"CLIQ_BOT_NAME": "codereviewbot",
        // Fallback target if mapping fails
		"CLIQ_CHANNEL_ID": "prweb",
        // Optional UID mapping table config
		"CLIQ_DB_NAME": "githubusermap"
	}
```

## How It Executes

Upon reaching a terminal evaluation status for a PR review chunk collection, the Worker builds deeply structured JSON:

* **Header:** Rendered Yellow (`In Progress`), Green (`Success`), or Red (`Changes Requested`) based on the Verified LLM critique.
* **Metadata Table:** Lists PR Author, Total Review Duration, Cloudflare Tokens Expended, and Link telemetry.
* **Findings:** Generates condensed Markdown blocks displaying the top critiques generated sequentially by the Sandbox.

If the Bot is successfully mapped to an internal database or explicitly defined in the `CLIQ_CHANNEL_ID`, the payload is streamed silently out-of-band via fire-and-forget logic so it does not bottleneck GitHub Check Run completion APIs.
