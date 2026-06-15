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
import { getPropertyUnits, PROPERTY_UNIT_CONFIGS } from "@shared/property-units";
import { communityAddressRuleForName } from "@shared/community-addresses";
import { resolveComboUnitBedrooms, inferCombinedBedroomsFromDraft } from "@shared/draft-unit-bedrooms";

const loopbackBaseUrl = () => `http://127.0.0.1:${process.env.PORT || "5000"}`;

export interface AssistantTool {
  name: string;
  kind: "read" | "write";
  description: string;
  input_schema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
  // Write tools MUST provide these so the confirm-before-act card can show the
  // operator exactly what's about to happen before it runs. Read tools omit them.
  confirmLabel?: (input: Record<string, unknown>) => string;
  confirmSummary?: (input: Record<string, unknown>) => string;
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

async function loopbackPost(path: string, body: Record<string, unknown>): Promise<unknown> {
  const resp = await fetch(`${loopbackBaseUrl()}${path}`, {
    method: "POST",
    headers: loopbackRequestHeaders(),
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep text */
  }
  if (!resp.ok) return { _error: true, status: resp.status, body: parsed };
  return parsed;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const money = (v: unknown): string => {
  const n = Number(v);
  return Number.isFinite(n) ? `$${Math.round(n).toLocaleString()}` : "an unknown amount";
};

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
    name: "list_properties",
    kind: "read",
    description:
      "List the FULL property portfolio — both CONFIGURED/active properties AND saved community DRAFTS (listings still being built, which have NO Guesty bookings yet, e.g. 'Ko Olina Beach Villas'). " +
      "Call this FIRST whenever the operator names a property / community / resort to act on (find photos, price, buy-in) and you can't find it via list_bookings — drafts never appear in bookings, so this is the only way to see them. " +
      "Returns `properties`, each with: `id` (the internal property id to pass to find_buy_in / scan_city_vrbo / start_auto_fill — NEGATIVE for drafts), `kind` ('configured' | 'draft'), `community` (resort/complex name), `title`, `city`, `state`, `streetAddress`, `bedrooms` (per-unit list) and `totalBedrooms`. " +
      "Match the operator's wording to `community`/`title` LOOSELY (case-insensitive substring — 'Ko Olina Beach' matches 'Ko Olina Beach Villas'). For find_photos, pass the matched `community` plus \"<city>, <state>\" as the location. Pass `query` to filter.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional case-insensitive substring to filter by community / title / city." },
        includeDrafts: { type: "boolean", description: "Include community drafts (default true)." },
      },
      required: [],
    },
    execute: async (input) => {
      const q = str(input.query)?.toLowerCase();
      const includeDrafts = input.includeDrafts !== false;
      const matches = (...vals: Array<string | null | undefined>): boolean =>
        !q || vals.some((v) => typeof v === "string" && v.toLowerCase().includes(q));

      const configured = Object.entries(PROPERTY_UNIT_CONFIGS)
        .map(([id, cfg]) => {
          const bedrooms = cfg.units.map((u) => u.bedrooms);
          const rule = communityAddressRuleForName(cfg.community);
          return {
            id: Number(id),
            kind: "configured" as const,
            community: cfg.community,
            title: null as string | null,
            city: rule?.city ?? null,
            state: rule?.state ?? null,
            streetAddress: rule?.street ?? null,
            bedrooms,
            totalBedrooms: bedrooms.reduce((s, b) => s + b, 0),
            units: cfg.units.length,
          };
        })
        .filter((p) => matches(p.community));

      let drafts: Array<Record<string, unknown>> = [];
      if (includeDrafts) {
        const raw = await loopbackGet("/api/community/drafts");
        const list: any[] = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.drafts) ? (raw as any).drafts : [];
        drafts = list
          .map((d: any) => {
            const resolved = resolveComboUnitBedrooms(d);
            const isSingle = d?.singleListing === true;
            const bedrooms = (isSingle ? [resolved.unit1] : [resolved.unit1, resolved.unit2]).filter(
              (b) => Number.isFinite(b) && b > 0,
            );
            return {
              id: -Number(d.id), // real internal API id for drafts (the 900xxx dashboard number is cosmetic)
              displayId: 900000 + Number(d.id),
              kind: "draft" as const,
              status: d.status ?? null,
              community: d.name ?? null,
              title: d.listingTitle ?? d.bookingTitle ?? null,
              city: d.city ?? null,
              state: d.state ?? null,
              streetAddress: d.streetAddress ?? null,
              bedrooms,
              totalBedrooms: bedrooms.reduce((s: number, b: number) => s + b, 0) || inferCombinedBedroomsFromDraft(d) || null,
              sourceUrl: d.sourceUrl ?? null,
            };
          })
          .filter((p) => matches(p.community as string, p.title as string, p.city as string));
      }

      return {
        note:
          "Drafts use a NEGATIVE `id` for the buy-in/auto-fill tools (the 900xxx 'displayId' is just the dashboard label). Drafts have no Guesty bookings, so they never appear in list_bookings. Match the operator's wording to community/title loosely (substring, case-insensitive).",
        configuredCount: configured.length,
        draftCount: drafts.length,
        properties: [...configured, ...drafts],
      };
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
  {
    name: "start_auto_fill",
    kind: "write",
    description:
      "ACTION (requires operator confirmation): start the 'auto-fill cheapest' background job for a booking. It runs the full escalation ladder (resort find-buy-in → home-city VRBO → nearby-city expansion → per-slot fallback) and ATTACHES the cheapest PROFITABLE buy-in combination to the reservation's empty unit slots. This is a real, money-committing change to the booking — it is gated behind a confirm card and only runs after the operator clicks Confirm. " +
      "Provide reservationId, propertyId (configured multi-unit/combo property), checkIn, checkOut, and expectedRevenue (the booking's net revenue / host payout from list_bookings — REQUIRED so the $100 profit gate works; without it the gate is disabled). The unit slots are derived server-side from the property config. Returns a jobId; then use check_auto_fill to watch progress.",
    input_schema: {
      type: "object",
      properties: {
        reservationId: { type: "string", description: "Guesty reservation id." },
        propertyId: { type: "number", description: "Internal property id (must be a configured combo/multi-unit property)." },
        checkIn: { type: "string", description: "Check-in YYYY-MM-DD." },
        checkOut: { type: "string", description: "Check-out YYYY-MM-DD." },
        expectedRevenue: { type: "number", description: "Booking net revenue / host payout (drives the profit gate)." },
        listingId: { type: "string", description: "Optional Guesty listing id." },
        propertyName: { type: "string", description: "Optional display name." },
      },
      required: ["reservationId", "propertyId", "checkIn", "checkOut"],
    },
    confirmLabel: (input) => `Auto-fill booking ${str(input.reservationId) ?? ""}`.trim(),
    confirmSummary: (input) => {
      const propertyId = Number(input.propertyId);
      const cfg = PROPERTY_UNIT_CONFIGS[propertyId];
      const units = getPropertyUnits(propertyId);
      const where = cfg?.community ? ` in ${cfg.community}` : "";
      const unitDesc = units.length
        ? `${units.length} unit slot${units.length > 1 ? "s" : ""} (${units.map((u) => `${u.bedrooms}BR`).join(" + ")})`
        : "its unit slots";
      const rev = input.expectedRevenue != null ? ` Profit gate uses revenue ${money(input.expectedRevenue)} (won't attach a combo losing >$100).` : " No revenue provided, so the profit gate is OFF.";
      return `Search and attach the cheapest profitable buy-in combo${where} for booking ${str(input.reservationId) ?? ""} (${str(input.checkIn)}→${str(input.checkOut)}), filling ${unitDesc}.${rev} This commits real buy-ins to the reservation.`;
    },
    execute: async (input) => {
      const propertyId = Number(input.propertyId);
      const slots = getPropertyUnits(propertyId).map((u) => ({
        unitId: u.unitId,
        unitLabel: u.unitLabel,
        bedrooms: u.bedrooms,
      }));
      if (slots.length === 0) {
        return { _error: true, message: `Property ${propertyId} has no configured unit slots — not a combo property.` };
      }
      const cfg = PROPERTY_UNIT_CONFIGS[propertyId];
      return loopbackPost("/api/operations/auto-fill", {
        reservationId: str(input.reservationId),
        propertyId,
        listingId: str(input.listingId) ?? null,
        propertyName: str(input.propertyName) ?? `Property ${propertyId}`,
        community: cfg?.community ?? null,
        checkIn: str(input.checkIn),
        checkOut: str(input.checkOut),
        slots,
        expectedRevenue: input.expectedRevenue != null ? Number(input.expectedRevenue) : undefined,
      });
    },
  },
  {
    name: "check_auto_fill",
    kind: "read",
    description:
      "Check the progress/result of an auto-fill job started by start_auto_fill. Pass the jobId. Returns status, done (terminal flag), the escalation phase, the units `attached` so far, `skipped` slots, `totalCost`, `expectedProfit`, and `cityEconomics`. Poll this after confirming an auto-fill; if not done, tell the operator it's still running.",
    input_schema: {
      type: "object",
      properties: { jobId: { type: "string", description: "Job id returned by start_auto_fill." } },
      required: ["jobId"],
    },
    execute: async (input) => loopbackGet(`/api/operations/auto-fill/${encodeURIComponent(str(input.jobId) ?? "")}`),
  },
  {
    name: "find_photos",
    kind: "read",
    description:
      "Find candidate PHOTOS for a community/resort via image search — use for 'find photos for <community>' or 'I need photos of <resort>'. Provide communityName (the resort/complex, e.g. 'Poipu Kai Resort') and location (city + state, e.g. 'Koloa, Hawaii'); optionally bedrooms. Returns an `images` array of {url, thumbnail, label, source}. These are CANDIDATES for the operator to review — not auto-applied to any listing. For a booking's community/location, get_buy_in_estimate returns complexName + region; for a SAVED property or DRAFT being built (e.g. 'Ko Olina Beach Villas'), call list_properties first to get its community + city/state.",
    input_schema: {
      type: "object",
      properties: {
        communityName: { type: "string", description: "Resort/complex name." },
        location: { type: "string", description: "City, State (e.g. 'Koloa, Hawaii')." },
        bedrooms: { type: "number", description: "Optional bedroom count to bias results." },
      },
      required: ["communityName", "location"],
    },
    execute: async (input) =>
      loopbackGet("/api/photos/find-replacement", {
        communityName: str(input.communityName),
        location: str(input.location),
        bedrooms: input.bedrooms != null ? String(input.bedrooms) : undefined,
      }),
  },
  {
    name: "get_photo_alerts",
    kind: "read",
    description:
      "List photo-listing alerts — cases where a property's photos on an OTA (Airbnb/VRBO/Booking) changed or a competitor match was detected. Use for 'are any listings flagged for photo issues?'. Pass unacknowledgedOnly=true to see only open alerts. Returns `alerts` with folder, platform, prior/new status, matched URLs, and detected/acknowledged timestamps.",
    input_schema: {
      type: "object",
      properties: { unacknowledgedOnly: { type: "boolean", description: "Only return un-acknowledged alerts." } },
      required: [],
    },
    execute: async (input) =>
      loopbackGet("/api/photo-listing-alerts", { unacknowledged: input.unacknowledgedOnly ? "1" : undefined }),
  },
  {
    name: "get_photo_listing_status",
    kind: "read",
    description:
      "Read the per-folder photo↔OTA match status dashboard (the daily photo-listing check): for each community folder, whether its photos currently appear on Airbnb/VRBO/Booking and any matched URLs. Use for 'what's the photo listing status?' or to see which listings' photos are syncing/flagged. Returns `checks` (one row per folder) + `activeFolderAliases`.",
    input_schema: { type: "object", properties: {}, required: [] },
    execute: async () => loopbackGet("/api/photo-listing-check"),
  },
  {
    name: "list_guest_conversations",
    kind: "read",
    description:
      "List recent guest inbox conversations (from Guesty) — guest name, channel, last message, unread state. Use for 'who messaged me?', 'any new guest messages?', or to find a conversationId to read a thread or reply. Returns Guesty's conversation list; summarize it (don't dump). Each conversation has an `id` (the conversationId for get_guest_thread / send_guest_message).",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max conversations (default 50)." } },
      required: [],
    },
    execute: async (input) => {
      const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 100);
      // `fields=` (empty) is load-bearing — it makes Guesty return the full
      // state.lastMessage shape the inbox relies on (see CLAUDE.md 2026-05-04).
      return loopbackGet(`/api/guesty-proxy/communication/conversations?limit=${limit}&fields=`);
    },
  },
  {
    name: "get_guest_thread",
    kind: "read",
    description:
      "Read the messages in one guest conversation thread (newest activity included). Pass the conversationId from list_guest_conversations. Use to understand what a guest asked before drafting or sending a reply. Returns Guesty `posts`.",
    input_schema: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "Guesty conversation id." },
        limit: { type: "number", description: "Max posts (default 50)." },
      },
      required: ["conversationId"],
    },
    execute: async (input) => {
      const id = encodeURIComponent(str(input.conversationId) ?? "");
      const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 100);
      return loopbackGet(`/api/guesty-proxy/communication/conversations/${id}/posts?limit=${limit}`);
    },
  },
  {
    name: "draft_guest_reply",
    kind: "read",
    description:
      "Generate a suggested reply DRAFT to a guest message (does NOT send). Pass the guestMessage (and any context: propertyName, guestName, checkIn, checkOut, channel, conversationHistory). Returns { draft }. Show the draft to the operator and offer to send it with send_guest_message (which is confirm-gated). Use this before sending so the operator can review/edit.",
    input_schema: {
      type: "object",
      properties: {
        guestMessage: { type: "string", description: "The guest's latest message to reply to." },
        propertyName: { type: "string", description: "Optional property/listing name." },
        guestName: { type: "string", description: "Optional guest first name." },
        checkIn: { type: "string", description: "Optional check-in YYYY-MM-DD." },
        checkOut: { type: "string", description: "Optional check-out YYYY-MM-DD." },
        channel: { type: "string", description: "Optional channel (airbnb/vrbo/booking/email)." },
        conversationHistory: { type: "string", description: "Optional prior thread text, oldest→newest." },
      },
      required: ["guestMessage"],
    },
    execute: async (input) =>
      loopbackPost("/api/inbox/ai-draft", {
        guestMessage: str(input.guestMessage),
        propertyName: str(input.propertyName),
        guestName: str(input.guestName),
        checkIn: str(input.checkIn),
        checkOut: str(input.checkOut),
        channel: str(input.channel),
        conversationHistory: str(input.conversationHistory),
      }),
  },
  {
    name: "send_guest_message",
    kind: "write",
    description:
      "ACTION (requires operator confirmation): send a message to a guest in a Guesty conversation. It routes to the guest's booking channel (Airbnb/VRBO/Booking/email) automatically. Pass conversationId (from list_guest_conversations) and the exact message body. ALWAYS draft with draft_guest_reply and show it first; only call this once the operator wants it sent. Gated behind a confirm card — it does not send until the operator clicks Confirm.",
    input_schema: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "Guesty conversation id." },
        body: { type: "string", description: "Exact message text to send to the guest." },
      },
      required: ["conversationId", "body"],
    },
    confirmLabel: () => "Send message to guest",
    confirmSummary: (input) => {
      const body = str(input.body) ?? "";
      const preview = body.length > 240 ? `${body.slice(0, 240)}…` : body;
      return `Send this message to the guest (conversation ${str(input.conversationId) ?? ""}), via their booking channel:\n\n"${preview}"`;
    },
    execute: async (input) => {
      const id = encodeURIComponent(str(input.conversationId) ?? "");
      const body = str(input.body);
      if (!body) return { _error: true, message: "Empty message body." };
      // Mirror the inbox client: read the conversation's module so the message
      // routes to the guest's actual channel; Guesty 400s on extra module keys.
      let mod: Record<string, unknown> = { type: "email" };
      try {
        const conv: any = await loopbackGet(`/api/guesty-proxy/communication/conversations/${id}`);
        const rawMod = (conv?.data?.module ?? conv?.module ?? {}) as Record<string, unknown>;
        const picked: Record<string, unknown> = {};
        for (const k of ["type", "channelId", "platform", "integrationId"]) {
          if (rawMod[k] !== undefined) picked[k] = rawMod[k];
        }
        if (!picked.type) picked.type = "email";
        mod = picked;
      } catch {
        /* fall back to email module */
      }
      return loopbackPost(`/api/guesty-proxy/communication/conversations/${id}/send-message`, { body, module: mod });
    },
  },
  {
    name: "send_payment_receipt",
    kind: "write",
    description:
      "ACTION (requires operator confirmation): send a payment or refund RECEIPT message to a guest for a reservation (also mints a durable /receipt page). Use after a payment was taken or a refund issued. Provide reservationId (or confirmationCode) and kind ('payment' or 'refund'); optionally amount + dateIso to force a specific transaction. Gated behind a confirm card.",
    input_schema: {
      type: "object",
      properties: {
        reservationId: { type: "string", description: "Guesty reservation id (or use confirmationCode)." },
        confirmationCode: { type: "string", description: "Guesty confirmation code (if no reservationId)." },
        kind: { type: "string", enum: ["payment", "refund"], description: "Receipt type." },
        amount: { type: "number", description: "Optional amount in $ to force a specific transaction." },
        dateIso: { type: "string", description: "Optional transaction date YYYY-MM-DD." },
      },
      required: [],
    },
    confirmLabel: (input) => `Send ${str(input.kind) ?? "payment"} receipt`,
    confirmSummary: (input) => {
      const who = str(input.reservationId) ?? str(input.confirmationCode) ?? "the reservation";
      const amt = input.amount != null ? ` for ${money(input.amount)}` : "";
      return `Send the guest a ${str(input.kind) ?? "payment"} receipt${amt} for reservation ${who}, via their booking channel, and create a durable receipt page.`;
    },
    execute: async (input) => {
      if (!str(input.reservationId) && !str(input.confirmationCode)) {
        return { _error: true, message: "Provide a reservationId or confirmationCode." };
      }
      return loopbackPost("/api/inbox/guest-receipts/send-for-reservation", {
        reservationId: str(input.reservationId),
        confirmationCode: str(input.confirmationCode),
        kind: str(input.kind),
        amount: input.amount != null ? Number(input.amount) : undefined,
        dateIso: str(input.dateIso),
      });
    },
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
