import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as ga from "./ga-client";

export interface Env {
  GA_SERVICE_ACCOUNT_KEY: string;
  MCP_AUTH_TOKEN?: string;
  MCP_OBJECT: DurableObjectNamespace;
}

const propertyIdSchema = z
  .union([z.string(), z.number()])
  .describe(
    'The GA4 property ID, either a bare numeric ID (e.g. 123456789) or a resource name (e.g. "properties/123456789").'
  );

// Filter expressions and order-by objects mirror the Google Analytics Data
// API's own REST JSON schema verbatim (fieldName, stringFilter, andGroup,
// orGroup, notExpression, inListFilter, numericFilter, betweenFilter, ...):
// https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/FilterExpression
const filterExpressionSchema = z
  .record(z.any())
  .describe(
    "A Data API FilterExpression object, e.g. " +
      '{"filter":{"fieldName":"country","stringFilter":{"value":"United States"}}}, ' +
      'or combined with {"andGroup":{"expressions":[...]}} / {"orGroup":{...}} / {"notExpression":{...}}.'
  );

const orderBySchema = z
  .record(z.any())
  .describe(
    "A Data API OrderBy object, e.g. " +
      '{"metric":{"metricName":"sessions"},"desc":true} or {"dimension":{"dimensionName":"date"}}.'
  );

const dateRangeSchema = z
  .record(z.any())
  .describe(
    'A Data API DateRange object with camelCase REST fields, e.g. {"startDate":"2024-01-01","endDate":"2024-01-31","name":"this_month"}. ' +
      'Relative dates like "today", "yesterday", and "NdaysAgo" are supported by the API.'
  );

export class GoogleAnalyticsMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "Google Analytics MCP",
    version: "0.1.0",
  });

  private key(): string {
    if (!this.env.GA_SERVICE_ACCOUNT_KEY) {
      throw new Error(
        "GA_SERVICE_ACCOUNT_KEY secret is not configured on this Worker."
      );
    }
    return this.env.GA_SERVICE_ACCOUNT_KEY;
  }

  private jsonResult(data: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }

  private errorResult(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }

  async init() {
    this.server.tool(
      "get_account_summaries",
      "Retrieves summary information (accounts and their properties) for every Google Analytics account the configured service account can see. No parameters.",
      {},
      async () => {
        try {
          return this.jsonResult(await ga.getAccountSummaries(this.key()));
        } catch (error) {
          return this.errorResult(error);
        }
      }
    );

    this.server.tool(
      "get_property_details",
      "Retrieves configuration details (display name, time zone, currency, industry category, etc.) for a single GA4 property.",
      { property_id: propertyIdSchema },
      async ({ property_id }) => {
        try {
          return this.jsonResult(await ga.getPropertyDetails(this.key(), property_id));
        } catch (error) {
          return this.errorResult(error);
        }
      }
    );

    this.server.tool(
      "list_google_ads_links",
      "Lists the Google Ads accounts linked to a GA4 property.",
      { property_id: propertyIdSchema },
      async ({ property_id }) => {
        try {
          return this.jsonResult(await ga.listGoogleAdsLinks(this.key(), property_id));
        } catch (error) {
          return this.errorResult(error);
        }
      }
    );

    this.server.tool(
      "list_property_annotations",
      "Lists reporting data annotations (notes on specific dates or date ranges, e.g. site releases or campaign launches) for a GA4 property.",
      { property_id: propertyIdSchema },
      async ({ property_id }) => {
        try {
          return this.jsonResult(await ga.listPropertyAnnotations(this.key(), property_id));
        } catch (error) {
          return this.errorResult(error);
        }
      }
    );

    this.server.tool(
      "get_custom_dimensions_and_metrics",
      "Retrieves the custom dimension and custom metric definitions configured on a GA4 property.",
      { property_id: propertyIdSchema },
      async ({ property_id }) => {
        try {
          return this.jsonResult(
            await ga.getCustomDimensionsAndMetrics(this.key(), property_id)
          );
        } catch (error) {
          return this.errorResult(error);
        }
      }
    );

    this.server.tool(
      "run_report",
      "Runs a core GA4 report (historical, non-realtime) via the Data API's runReport endpoint. dimensions/metrics are plain API names (e.g. \"city\", \"activeUsers\"); date_ranges, dimension_filter, metric_filter, and order_bys use the Data API's own camelCase REST JSON shape.",
      {
        property_id: propertyIdSchema,
        date_ranges: z.array(dateRangeSchema),
        dimensions: z.array(z.string()),
        metrics: z.array(z.string()),
        dimension_filter: filterExpressionSchema.optional(),
        metric_filter: filterExpressionSchema.optional(),
        order_bys: z.array(orderBySchema).optional(),
        limit: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
        currency_code: z.string().optional(),
        return_property_quota: z.boolean().optional(),
      },
      async (params) => {
        try {
          return this.jsonResult(await ga.runReport(this.key(), params));
        } catch (error) {
          return this.errorResult(error);
        }
      }
    );

    this.server.tool(
      "run_realtime_report",
      'Runs a GA4 realtime report (last ~30 minutes of activity) via the Data API\'s runRealtimeReport endpoint. Only realtime-specific dimensions/metrics are supported (e.g. "unifiedScreenName", "activeUsers"); custom metrics are not supported for realtime reports.',
      {
        property_id: propertyIdSchema,
        dimensions: z.array(z.string()),
        metrics: z.array(z.string()),
        dimension_filter: filterExpressionSchema.optional(),
        metric_filter: filterExpressionSchema.optional(),
        order_bys: z.array(orderBySchema).optional(),
        limit: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
        return_property_quota: z.boolean().optional(),
      },
      async (params) => {
        try {
          return this.jsonResult(await ga.runRealtimeReport(this.key(), params));
        } catch (error) {
          return this.errorResult(error);
        }
      }
    );

    this.server.tool(
      "run_funnel_report",
      "Runs a GA4 funnel report via the Data API's (v1alpha) runFunnelReport endpoint. Each entry in funnel_steps needs a \"name\" plus either an \"event\" (event name string) or a \"filter_expression\" (Data API FilterExpression). funnel_breakdown, funnel_next_action, and segments mirror the Data API's own camelCase REST JSON shape and are passed through as-is.",
      {
        property_id: propertyIdSchema,
        funnel_steps: z.array(
          z.object({
            name: z.string(),
            event: z.string().optional(),
            filter_expression: filterExpressionSchema.optional(),
          })
        ),
        date_ranges: z.array(dateRangeSchema).optional(),
        funnel_breakdown: z.record(z.any()).optional(),
        funnel_next_action: z.record(z.any()).optional(),
        segments: z.array(z.record(z.any())).optional(),
        return_property_quota: z.boolean().optional(),
      },
      async (params) => {
        try {
          return this.jsonResult(await ga.runFunnelReport(this.key(), params));
        } catch (error) {
          return this.errorResult(error);
        }
      }
    );

    this.server.tool(
      "run_conversions_report",
      'Runs a GA4 conversion-scoped report via the Data API\'s (v1alpha) runReport endpoint with a conversionSpec. conversion_spec.conversion_actions is a list of conversionActions resource names (empty = all conversion events); conversion_spec.attribution_model is "DATA_DRIVEN" or "LAST_CLICK".',
      {
        property_id: propertyIdSchema,
        date_ranges: z.array(dateRangeSchema),
        dimensions: z.array(z.string()),
        metrics: z.array(z.string()),
        conversion_spec: z.object({
          conversion_actions: z.array(z.string()).optional(),
          attribution_model: z.enum(["DATA_DRIVEN", "LAST_CLICK"]).optional(),
        }),
        dimension_filter: filterExpressionSchema.optional(),
        metric_filter: filterExpressionSchema.optional(),
        order_bys: z.array(orderBySchema).optional(),
        limit: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
        currency_code: z.string().optional(),
        return_property_quota: z.boolean().optional(),
      },
      async (params) => {
        try {
          return this.jsonResult(await ga.runConversionsReport(this.key(), params));
        } catch (error) {
          return this.errorResult(error);
        }
      }
    );
  }
}

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.MCP_AUTH_TOKEN) return true; // no shared secret configured
  const header = request.headers.get("Authorization") ?? "";
  return header === `Bearer ${env.MCP_AUTH_TOKEN}`;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (!isAuthorized(request, env)) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (url.pathname === "/mcp") {
      return GoogleAnalyticsMCP.serve("/mcp").fetch(request, env, ctx);
    }
    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return GoogleAnalyticsMCP.serveSSE("/sse").fetch(request, env, ctx);
    }
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("Google Analytics MCP server is running. Connect at /mcp (Streamable HTTP) or /sse (SSE).", {
        status: 200,
      });
    }
    return new Response("Not found", { status: 404 });
  },
};
