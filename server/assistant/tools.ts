// Tool registry for the platform AI assistant.
//
// Each tool is a THIN wrapper over an existing HTTP endpoint, invoked via an
// in-process loopback self-call (http://127.0.0.1:${PORT}). Loopback bypasses
// the ADMIN_SECRET gate (see server/auth.ts `loopbackRequestHeaders` +
// `isLoopback`), exactly like server/auto-fill-job.ts. This means the assistant
// inherits every load-bearing rule baked into the endpoints (VRBO sight+click,
// profit gate, geo guards, no-double-attach) FOR FREE — it can't route around
// them because it never touches the DB / Guesty / VRBO directly.
//
// Phase 0 ships READ-ONLY tools. Write/outward tools (attach buy-in, send guest
// message, reprice) will be added with `kind: "write"` + a confirm-before-act
// gate in a later phase. The `kind` tag exists now so that gate is a one-line
// check when those land.

import { loopbackRequestHeaders } from "../auth";

const loopbackBaseUrl = () => `http://127.0.0.1:${process.env.PORT || "5000"}`;

export interface AssistantTool {
  name: string;
  kind: "read" | "write";
  description: string;
  input_schema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}

async function loopbackGet(path: string, query?: Record<string, string | undefined>): Promise<unknown> {
  const url = new URL(`${loopbackBaseUrl()}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null && v !== "") url.searchParams.set(k, v);
    }
  }
  const resp = await fetch(url.toString(), { headers: loopbackRequestHeaders() });
  const text = await resp.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON; keep as text */
  }
  if (!resp.ok) {
    return { _error: true, status: resp.status, body };
  }
  return body;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export const ASSISTANT_TOOLS: AssistantTool[] = [
  {
    name: "get_dashboard",
    kind: "read",
    description:
      "Read top-level operations dashboard metrics. Use for questions about revenue, cancellations, channel/listing connection status, or minimum-stay settings. " +
      "`metric` selects which: 'revenue_30_days' (last 30 days revenue + per-listing breakdown), 'revenue_week' (this week), 'cancellations' (recent canceled reservations), 'channel_status' (which listings are connected/disconnected per OTA), 'minimum_stays' (per-property minimum-night settings).",
    input_schema: {
      type: "object",
      properties: {
        metric: {
          type: "string",
          enum: ["revenue_30_days", "revenue_week", "cancellations", "channel_status", "minimum_stays"],
          description: "Which dashboard metric to fetch.",
        },
      },
      required: ["metric"],
    },
    execute: async (input) => {
      const metric = str(input.metric);
      switch (metric) {
        case "revenue_30_days":
          return loopbackGet("/api/dashboard/revenue-30-days");
        case "revenue_week":
          return loopbackGet("/api/dashboard/revenue-week");
        case "cancellations":
          return loopbackGet("/api/dashboard/cancellations");
        case "channel_status":
          return loopbackGet("/api/dashboard/channel-status");
        case "minimum_stays":
          return loopbackGet("/api/dashboard/minimum-stays");
        default:
          return { _error: true, message: `Unknown metric '${metric ?? ""}'.` };
      }
    },
  },
  {
    name: "list_bookings",
    kind: "read",
    description:
      "List reservations across ALL properties (account-wide, from Guesty) with guest, dates, channel, status, and money. Use to answer questions about upcoming stays, who is checking in, a specific guest's booking, or to find a reservationId/listingId to feed into another tool. " +
      "By default returns committed upcoming stays only. Set includePast=true to include past stays, includeCanceled=true to include canceled/declined/inquiry rows. Returns a possibly-large array — summarize, don't dump.",
    input_schema: {
      type: "object",
      properties: {
        includePast: { type: "boolean", description: "Include stays whose check-out is in the past." },
        includeCanceled: { type: "boolean", description: "Include canceled/declined/inquiry/expired reservations." },
        maxRows: { type: "number", description: "Cap on rows fetched (default 200, max 1000)." },
      },
      required: [],
    },
    execute: async (input) => {
      const maxRows = Math.min(Math.max(Number(input.maxRows) || 200, 1), 1000);
      return loopbackGet("/api/bookings/guesty-all", {
        includePast: input.includePast ? "true" : undefined,
        includeCanceled: input.includeCanceled ? "true" : undefined,
        maxRows: String(maxRows),
      });
    },
  },
  {
    name: "get_reports",
    kind: "read",
    description:
      "Read operations reports. kind='summary' for the overall portfolio summary report; kind='monthly' for a month-by-month revenue/occupancy report (pass `month` as YYYY-MM to focus a specific month, otherwise the default range is returned).",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["summary", "monthly"], description: "Which report to fetch." },
        month: { type: "string", description: "Optional YYYY-MM for the monthly report." },
      },
      required: ["kind"],
    },
    execute: async (input) => {
      const kind = str(input.kind);
      if (kind === "monthly") return loopbackGet("/api/reports/monthly", { month: str(input.month) });
      if (kind === "summary") return loopbackGet("/api/reports/summary");
      return { _error: true, message: `Unknown report kind '${kind ?? ""}'.` };
    },
  },
  {
    name: "get_buy_in_estimate",
    kind: "read",
    description:
      "Fast, static buy-in profitability estimate for a stay (NOT a live VRBO search). Given a Guesty listingId and dates, returns estimated per-unit nightly cost, total buy-in cost, and the per-night margin so you can answer 'is this booking worth it / should I send a higher special offer?'. " +
      "Use list_bookings first to find the listingId, check-in and check-out. cleaningFeePerUnit defaults to the operator's saved value if omitted.",
    input_schema: {
      type: "object",
      properties: {
        listingId: { type: "string", description: "Guesty listing id." },
        checkIn: { type: "string", description: "Check-in date YYYY-MM-DD." },
        checkOut: { type: "string", description: "Check-out date YYYY-MM-DD." },
        cleaningFeePerUnit: { type: "number", description: "Optional per-unit cleaning fee override." },
      },
      required: ["listingId", "checkIn", "checkOut"],
    },
    execute: async (input) =>
      loopbackGet("/api/inbox/buy-in-estimate", {
        listingId: str(input.listingId),
        checkIn: str(input.checkIn),
        checkOut: str(input.checkOut),
        cleaningFeePerUnit: input.cleaningFeePerUnit != null ? String(input.cleaningFeePerUnit) : undefined,
      }),
  },
  {
    name: "find_buy_in",
    kind: "read",
    description:
      "Run a LIVE multi-source buy-in search (Airbnb / VRBO / Booking.com / property managers) for ONE unit of a given bedroom count at a property's resort, for specific dates. Use to answer 'find a buy-in / a unit to cover this booking' for a single-unit need, or to price what covering a stay would cost. Returns `cheapest` (top options by nightly price), per-source results, and `diagnostics`. " +
      "This is SLOW (it drives the live browser sidecar — can take 30–90s+) and needs the operator's sidecar online; if it returns few/no results, say so and surface the diagnostics. To get propertyId + bedrooms for a booking, call get_buy_in_estimate first (it returns propertyId and per-unit bedrooms from the listingId).",
    input_schema: {
      type: "object",
      properties: {
        propertyId: { type: "number", description: "Internal property id (from get_buy_in_estimate)." },
        bedrooms: { type: "number", description: "Bedroom count to search for." },
        checkIn: { type: "string", description: "Check-in YYYY-MM-DD." },
        checkOut: { type: "string", description: "Check-out YYYY-MM-DD." },
        listingId: { type: "string", description: "Optional Guesty listing id for better resort inference." },
        community: { type: "string", description: "Optional community/resort override." },
        nocache: { type: "boolean", description: "Set true to force a fresh scan (skips the result cache)." },
      },
      required: ["propertyId", "bedrooms", "checkIn", "checkOut"],
    },
    execute: async (input) =>
      loopbackGet("/api/operations/find-buy-in", {
        propertyId: input.propertyId != null ? String(input.propertyId) : undefined,
        bedrooms: input.bedrooms != null ? String(input.bedrooms) : undefined,
        checkIn: str(input.checkIn),
        checkOut: str(input.checkOut),
        listingId: str(input.listingId),
        community: str(input.community),
        nocache: input.nocache ? "1" : undefined,
      }),
  },
  {
    name: "scan_city_vrbo",
    kind: "read",
    description:
      "Run a LIVE city-wide VRBO scan for a multi-unit (combo) property and find the best same-community COMBINATION that covers the booking. This is the tool for 'find a better combination' and 'find a new location' — it returns `suggestedPair` (cheapest walkable same-community combo), `suggestedPairs` (ranked alternatives), the full `listings`, the `bedroomPlan`/`unitLabels`, and `coverage` (how complete the scan was). " +
      "SLOW (drives the live sidecar; tens of seconds) and needs the sidecar online. Use scan_city_vrbo for combo properties; use find_buy_in for a single unit. Get propertyId from get_buy_in_estimate.",
    input_schema: {
      type: "object",
      properties: {
        propertyId: { type: "number", description: "Internal property id (from get_buy_in_estimate)." },
        checkIn: { type: "string", description: "Check-in YYYY-MM-DD." },
        checkOut: { type: "string", description: "Check-out YYYY-MM-DD." },
        phrase: { type: "string", description: "Optional resort/community phrase filter." },
        nocache: { type: "boolean", description: "Set true to force a fresh scan." },
      },
      required: ["propertyId", "checkIn", "checkOut"],
    },
    execute: async (input) =>
      loopbackGet("/api/operations/city-vrbo-inventory", {
        propertyId: input.propertyId != null ? String(input.propertyId) : undefined,
        checkIn: str(input.checkIn),
        checkOut: str(input.checkOut),
        phrase: str(input.phrase),
        nocache: input.nocache ? "1" : undefined,
      }),
  },
  {
    name: "get_market_rates",
    kind: "read",
    description:
      "Read the portfolio's stored market nightly rates by property and bedroom count, including per-month seasonal rates (LOW/HIGH/HOLIDAY). Use to answer pricing questions like 'what should I charge for <property> in <month>?' or 'what's the going nightly rate for a 3BR?'. Returns an array of rate rows; each has propertyId, bedrooms, medianNightly, and a monthlyRates map keyed by YYYY-MM.",
    input_schema: { type: "object", properties: {}, required: [] },
    execute: async () => loopbackGet("/api/property/market-rates"),
  },
];

export const ASSISTANT_TOOLS_BY_NAME = new Map(ASSISTANT_TOOLS.map((t) => [t.name, t]));

/** Anthropic tool definitions (name/description/input_schema only). */
export function anthropicToolDefs(): { name: string; description: string; input_schema: Record<string, unknown> }[] {
  return ASSISTANT_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

export async function runAssistantTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  const tool = ASSISTANT_TOOLS_BY_NAME.get(name);
  if (!tool) return { _error: true, message: `Unknown tool '${name}'.` };
  try {
    return await tool.execute(input ?? {});
  } catch (err) {
    return { _error: true, message: (err as Error)?.message ?? String(err) };
  }
}
