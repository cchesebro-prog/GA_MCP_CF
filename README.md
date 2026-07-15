# Google Analytics MCP server on Cloudflare Workers

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cchesebro-prog/GA_MCP_CF)

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives
MCP clients (Claude, Gemini CLI, etc.) read access to Google Analytics 4 data,
running as a Cloudflare Worker instead of the local `pipx run analytics-mcp`
process from the original
[googleanalytics/google-analytics-mcp](https://github.com/googleanalytics/google-analytics-mcp)
project.

Because a Worker can't run `gcloud`/Application Default Credentials the way a
local process can, this port authenticates with a **GCP service account key**
stored as a Cloudflare secret: the Worker signs its own JWT (via the Workers
Web Crypto API) and exchanges it for a Google OAuth2 access token on each
cold start.

> The button above clones this repo into your own GitHub account, provisions
> a new Worker on your Cloudflare account, and wires up auto-deploy on every
> push. It does **not** set the `GA_SERVICE_ACCOUNT_KEY` / `MCP_AUTH_TOKEN`
> secrets for you — you still need to complete the Google Cloud setup below
> and run the `wrangler secret put` commands in step 3 before the server can
> actually reach Google Analytics.

## Tools exposed

Same 9 tools as the original server, called via the GA4 Data API and Admin
API REST endpoints directly:

| Tool | What it does |
|---|---|
| `get_account_summaries` | List every GA account/property the service account can see |
| `get_property_details` | Config details for one GA4 property |
| `list_google_ads_links` | Google Ads accounts linked to a property |
| `list_property_annotations` | Annotations (e.g. release/campaign notes) on a property |
| `get_custom_dimensions_and_metrics` | Custom dimension/metric definitions on a property |
| `run_report` | Core historical report (`runReport`) |
| `run_realtime_report` | Last ~30 minutes of activity (`runRealtimeReport`) |
| `run_funnel_report` | Funnel analysis (`runFunnelReport`, v1alpha) |
| `run_conversions_report` | Report scoped to specific conversion actions (`runReport` + `conversionSpec`, v1alpha) |

`date_ranges`, `dimension_filter`, `metric_filter`, and `order_bys` use the
Data API's own camelCase REST JSON shapes directly (e.g.
`{"fieldName":"country","stringFilter":{"value":"United States"}}`) rather
than the snake_case Python proto kwargs the original server used — see the
[FilterExpression reference](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/FilterExpression).

## 1. Google Cloud setup

You'll need a GCP project with the Analytics Admin API and Analytics Data API
enabled, and a service account granted read access to your GA4 properties.
None of this can be done on your behalf from here — a Google Cloud project
and Google Analytics account access are tied to your Google identity.

1. **Create (or pick) a GCP project.**
   ```
   gcloud projects create wigwam-ga-mcp --name="Wigwam GA MCP"
   gcloud config set project wigwam-ga-mcp
   ```
2. **Enable the required APIs.**
   ```
   gcloud services enable analyticsadmin.googleapis.com analyticsdata.googleapis.com
   ```
3. **Create a service account and a JSON key for it.**
   ```
   gcloud iam service-accounts create ga-mcp-reader \
     --display-name="GA4 MCP read-only"

   gcloud iam service-accounts keys create ga-mcp-key.json \
     --iam-account=ga-mcp-reader@wigwam-ga-mcp.iam.gserviceaccount.com
   ```
   `ga-mcp-key.json` is a secret — don't commit it. You'll paste its contents
   into a Cloudflare secret in step 3 below, then delete the local file.
4. **Grant the service account access to your GA4 properties.** This step
   happens in the Google Analytics UI, not GCP, since GA4 property access
   isn't an IAM role:
   - Go to [analytics.google.com](https://analytics.google.com) → **Admin**
     → **Property Access Management** (or **Account Access Management** to
     grant it across every property in the account at once).
   - Click **+** → **Add users**.
   - Enter the service account's email
     (`ga-mcp-reader@wigwam-ga-mcp.iam.gserviceaccount.com`).
   - Assign the **Viewer** role. Uncheck "Notify new users by email" (service
     accounts can't read email).

## 2. Local development

```
npm install
cp .dev.vars.example .dev.vars
# edit .dev.vars: paste the service account JSON as GA_SERVICE_ACCOUNT_KEY,
# and set MCP_AUTH_TOKEN to a random string
npm run dev
```

`wrangler dev` will print a local URL; MCP clients can connect to
`http://localhost:8787/mcp`.

## 3. Deploy to Cloudflare

```
npx wrangler login          # first time only
npx wrangler secret put GA_SERVICE_ACCOUNT_KEY   # paste the full JSON key contents
npx wrangler secret put MCP_AUTH_TOKEN            # a long random string
npm run deploy
```

Wrangler will print the deployed URL, e.g.
`https://wigwam-google-analytics-mcp.<your-subdomain>.workers.dev`.

### Why `MCP_AUTH_TOKEN`?

The Worker is reachable at a public `*.workers.dev` URL by default. Setting
`MCP_AUTH_TOKEN` requires every request to include
`Authorization: Bearer <token>`, so a stranger with the URL can't query your
GA4 data. This is a shared-secret gate, not a full auth system — treat the
token like a password and rotate it (`wrangler secret put MCP_AUTH_TOKEN`) if
it ever leaks. If you need per-user login instead, that's a larger change
(3-legged OAuth with Durable Object token storage) not implemented here.

## 4. Connect an MCP client

For clients that support remote MCP servers over Streamable HTTP, add:

```json
{
  "mcpServers": {
    "google-analytics": {
      "url": "https://wigwam-google-analytics-mcp.<your-subdomain>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

An SSE-transport endpoint is also available at `/sse` for clients that don't
yet support Streamable HTTP.

## Project layout

```
src/
  index.ts      MCP server definition (tool schemas) + Worker fetch handler
  ga-client.ts  fetch() wrappers for the GA Admin API and Data API
  auth.ts       Service-account JWT signing + Google OAuth2 token exchange
wrangler.jsonc  Worker/Durable Object configuration
```
