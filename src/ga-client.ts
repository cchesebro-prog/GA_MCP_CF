/**
 * Thin fetch-based wrappers around the Google Analytics Admin API and Data
 * API (v1beta, plus v1alpha for the handful of endpoints that are still
 * alpha-only: Google Ads links, reporting data annotations, funnel reports,
 * and conversion-scoped reports).
 *
 * Filter expressions and order-by objects are passed straight through as the
 * REST API's own camelCase JSON shape (fieldName, stringFilter, andGroup,
 * orGroup, notExpression, inListFilter, numericFilter, betweenFilter, ...) —
 * see https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/FilterExpression
 * — rather than being re-validated here, so any shape the live API accepts
 * works without this server needing to model it.
 */

import { getAccessToken } from "./auth";

const ADMIN_BASE = "https://analyticsadmin.googleapis.com";
const DATA_BASE = "https://analyticsdata.googleapis.com";

export function constructPropertyRn(propertyId: string | number): string {
  const asString = String(propertyId).trim();
  if (asString.startsWith("properties/")) return asString;
  if (!/^\d+$/.test(asString)) {
    throw new Error(
      `Invalid property_id "${asString}". Expected a numeric GA4 property ID or a "properties/{id}" resource name.`
    );
  }
  return `properties/${asString}`;
}

async function googleFetch(
  serviceAccountKey: string,
  url: string,
  init: RequestInit = {}
): Promise<any> {
  const accessToken = await getAccessToken(serviceAccountKey);
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const message =
      json?.error?.message ?? `Google API request failed with status ${res.status}`;
    throw new Error(`${message} (url: ${url})`);
  }
  return json;
}

function toJsonBody(value: unknown): string {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

export async function getAccountSummaries(key: string): Promise<any> {
  const accountSummaries: any[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${ADMIN_BASE}/v1beta/accountSummaries`);
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await googleFetch(key, url.toString());
    accountSummaries.push(...(page.accountSummaries ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return { accountSummaries };
}

export async function getPropertyDetails(key: string, propertyId: string | number): Promise<any> {
  const rn = constructPropertyRn(propertyId);
  return googleFetch(key, `${ADMIN_BASE}/v1beta/${rn}`);
}

export async function listGoogleAdsLinks(key: string, propertyId: string | number): Promise<any> {
  const rn = constructPropertyRn(propertyId);
  return googleFetch(key, `${ADMIN_BASE}/v1beta/${rn}/googleAdsLinks`);
}

export async function listPropertyAnnotations(
  key: string,
  propertyId: string | number
): Promise<any> {
  const rn = constructPropertyRn(propertyId);
  // Reporting data annotations are v1alpha-only as of this writing.
  return googleFetch(key, `${ADMIN_BASE}/v1alpha/${rn}/reportingDataAnnotations`);
}

export async function getCustomDimensionsAndMetrics(
  key: string,
  propertyId: string | number
): Promise<any> {
  const rn = constructPropertyRn(propertyId);
  const [dimensions, metrics] = await Promise.all([
    googleFetch(key, `${ADMIN_BASE}/v1beta/${rn}/customDimensions`),
    googleFetch(key, `${ADMIN_BASE}/v1beta/${rn}/customMetrics`),
  ]);
  return {
    customDimensions: dimensions.customDimensions ?? [],
    customMetrics: metrics.customMetrics ?? [],
  };
}

// ---------------------------------------------------------------------------
// Data API
// ---------------------------------------------------------------------------

export interface RunReportParams {
  property_id: string | number;
  date_ranges: Array<Record<string, unknown>>;
  dimensions: string[];
  metrics: string[];
  dimension_filter?: Record<string, unknown>;
  metric_filter?: Record<string, unknown>;
  order_bys?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
  currency_code?: string;
  return_property_quota?: boolean;
}

export async function runReport(key: string, params: RunReportParams): Promise<any> {
  const rn = constructPropertyRn(params.property_id);
  const body: Record<string, unknown> = {
    dateRanges: params.date_ranges,
    dimensions: params.dimensions.map((name) => ({ name })),
    metrics: params.metrics.map((name) => ({ name })),
  };
  if (params.dimension_filter) body.dimensionFilter = params.dimension_filter;
  if (params.metric_filter) body.metricFilter = params.metric_filter;
  if (params.order_bys) body.orderBys = params.order_bys;
  if (params.limit !== undefined) body.limit = String(params.limit);
  if (params.offset !== undefined) body.offset = String(params.offset);
  if (params.currency_code) body.currencyCode = params.currency_code;
  if (params.return_property_quota) body.returnPropertyQuota = true;

  return googleFetch(key, `${DATA_BASE}/v1beta/${rn}:runReport`, {
    method: "POST",
    body: toJsonBody(body),
  });
}

export interface RunRealtimeReportParams {
  property_id: string | number;
  dimensions: string[];
  metrics: string[];
  dimension_filter?: Record<string, unknown>;
  metric_filter?: Record<string, unknown>;
  order_bys?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
  return_property_quota?: boolean;
}

export async function runRealtimeReport(
  key: string,
  params: RunRealtimeReportParams
): Promise<any> {
  const rn = constructPropertyRn(params.property_id);
  const body: Record<string, unknown> = {
    dimensions: params.dimensions.map((name) => ({ name })),
    metrics: params.metrics.map((name) => ({ name })),
  };
  if (params.dimension_filter) body.dimensionFilter = params.dimension_filter;
  if (params.metric_filter) body.metricFilter = params.metric_filter;
  if (params.order_bys) body.orderBys = params.order_bys;
  if (params.limit !== undefined) body.limit = String(params.limit);
  if (params.offset !== undefined) body.offset = String(params.offset);
  if (params.return_property_quota) body.returnPropertyQuota = true;

  return googleFetch(key, `${DATA_BASE}/v1beta/${rn}:runRealtimeReport`, {
    method: "POST",
    body: toJsonBody(body),
  });
}

export interface FunnelStepInput {
  name: string;
  event?: string;
  filter_expression?: Record<string, unknown>;
}

export interface RunFunnelReportParams {
  property_id: string | number;
  funnel_steps: FunnelStepInput[];
  date_ranges?: Array<Record<string, unknown>>;
  funnel_breakdown?: Record<string, unknown>;
  funnel_next_action?: Record<string, unknown>;
  segments?: Array<Record<string, unknown>>;
  return_property_quota?: boolean;
}

export async function runFunnelReport(key: string, params: RunFunnelReportParams): Promise<any> {
  const rn = constructPropertyRn(params.property_id);

  const steps = params.funnel_steps.map((step) => {
    if (step.filter_expression) {
      return { name: step.name, filterExpression: step.filter_expression };
    }
    if (step.event) {
      return {
        name: step.name,
        filterExpression: { funnelEventFilter: { eventName: step.event } },
      };
    }
    throw new Error(
      `Funnel step "${step.name}" needs either "event" or "filter_expression".`
    );
  });

  const body: Record<string, unknown> = {
    funnel: { steps },
  };
  if (params.date_ranges) body.dateRanges = params.date_ranges;
  if (params.funnel_breakdown) body.funnelBreakdown = params.funnel_breakdown;
  if (params.funnel_next_action) body.funnelNextAction = params.funnel_next_action;
  if (params.segments) body.segments = params.segments;
  if (params.return_property_quota) body.returnPropertyQuota = true;

  // Funnel reports are v1alpha-only.
  return googleFetch(key, `${DATA_BASE}/v1alpha/${rn}:runFunnelReport`, {
    method: "POST",
    body: toJsonBody(body),
  });
}

export interface ConversionSpecInput {
  conversion_actions?: string[];
  attribution_model?: "DATA_DRIVEN" | "LAST_CLICK";
}

export interface RunConversionsReportParams {
  property_id: string | number;
  date_ranges: Array<Record<string, unknown>>;
  dimensions: string[];
  metrics: string[];
  conversion_spec: ConversionSpecInput;
  dimension_filter?: Record<string, unknown>;
  metric_filter?: Record<string, unknown>;
  order_bys?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
  currency_code?: string;
  return_property_quota?: boolean;
}

export async function runConversionsReport(
  key: string,
  params: RunConversionsReportParams
): Promise<any> {
  const rn = constructPropertyRn(params.property_id);
  const body: Record<string, unknown> = {
    dateRanges: params.date_ranges,
    dimensions: params.dimensions.map((name) => ({ name })),
    metrics: params.metrics.map((name) => ({ name })),
    conversionSpec: {
      conversionActions: params.conversion_spec.conversion_actions ?? [],
      attributionModel: params.conversion_spec.attribution_model ?? "DATA_DRIVEN",
    },
  };
  if (params.dimension_filter) body.dimensionFilter = params.dimension_filter;
  if (params.metric_filter) body.metricFilter = params.metric_filter;
  if (params.order_bys) body.orderBys = params.order_bys;
  if (params.limit !== undefined) body.limit = String(params.limit);
  if (params.offset !== undefined) body.offset = String(params.offset);
  if (params.currency_code) body.currencyCode = params.currency_code;
  if (params.return_property_quota) body.returnPropertyQuota = true;

  // Conversion-scoped reporting is v1alpha-only.
  return googleFetch(key, `${DATA_BASE}/v1alpha/${rn}:runReport`, {
    method: "POST",
    body: toJsonBody(body),
  });
}
