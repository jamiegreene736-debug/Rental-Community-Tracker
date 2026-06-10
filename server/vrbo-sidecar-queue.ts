import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "./db";
import { sidecarSearchVariations } from "@shared/schema";
import {
  generateSearchVariations,
  matchesSearchVariationTokens,
  normalizeResortSearchTerm,
  searchVariationKey,
  searchVariationTokens,
  type OtaProvider,
} from "./search-variations";

// Chrome sidecar queue.
//
// Bridges find-buy-in (running on Railway) to a polling sidecar worker.
// The worker can run locally for development, but production now runs it
// on Railway against a server Chrome/noVNC service and Bright Data proxy.
//
// Originally just for VRBO search. Generalized 2026-04-29 to handle
// multiple op types with the same queue machinery:
//   - airbnb_search    (drive airbnb.com search, return priced cards)
//   - vrbo_search      (drive vrbo.com search, return priced cards)
//   - booking_search   (drive booking.com search, return priced cards)
//   - google_serp      (run a Google query, return organic results)
//   - pm_site_search   (legacy only; market buy-in no longer scrapes
//                       property-management websites)
//   - pm_url_check     (legacy/detail tools only)
//
// Why one queue with op-type dispatch instead of four queues:
//   - Single endpoint surface, single set of TTLs, single dedup logic.
//   - The daemon can process them all on the same Chrome instance,
//     reusing the existing tab when possible.
//   - Heartbeat tracking is per-daemon, not per-op.
//
// Why in-memory and not a DB table:
//   - Single-instance Railway deploy; no need to share queue across
//     processes.
//   - Pending requests > 5 min are stale anyway (operator already
//     scrolled past that buy-in dialog).
//   - Restart / deploy wipes the queue, but find-buy-in's existing
//     fallback paths cover the gap automatically.
//
// Auth: worker endpoints (/next, /result) honor ADMIN_SECRET when
// set, matching the rest of /api/admin/*. Public endpoints (/enqueue,
// /result/:id, /heartbeat) don't — find-buy-in calls them
// server-to-server on the same instance and the heartbeat exposes
// only booleans + ms-age.

// Op types the daemon knows how to handle. Each has its own params
// shape and result shape; the daemon dispatches in worker.mjs based
// on `opType`.
export type SidecarOpType =
  | "airbnb_search"
  | "vrbo_search"
  | "vrbo_photo_scrape"
  | "zillow_photo_scrape"
  | "booking_search"
  | "google_serp"
  | "pm_site_search"
  | "pm_url_check"
  | "pm_url_check_batch"
  | "vrbo_upload_photos"
  | "booking_upload_photos"
  | "guesty_disconnect_channel"
  | "vrbo_book";

export type SidecarAirbnbParams = {
  destination: string;
  searchTerm?: string;
  checkIn: string;
  checkOut: string;
  bedrooms: number;
  searchVariations?: string[];
  variationMode?: SidecarSearchVariationMode;
  queueContext?: SidecarQueueContext;
};

export type SidecarVrboParams = {
  destination: string;
  searchTerm?: string;
  checkIn: string;
  checkOut: string;
  bedrooms: number;
  searchMode?: "destination_dropdown" | "map_bounds";
  mapSearch?: {
    enabled: boolean;
    targetName?: string;
    bounds?: { sw_lat: number; sw_lng: number; ne_lat: number; ne_lng: number };
    center?: { lat: number; lng: number };
    radiusKm?: number;
    /** Scroll/harvest the full city map inventory (~100+ cards) instead of a quick resort pass. */
    deepHarvest?: boolean;
  };
  searchVariations?: string[];
  variationMode?: SidecarSearchVariationMode;
  queueContext?: SidecarQueueContext;
  /** City-wide VRBO inventory export (single term, exhaustive list scroll + GraphQL pagination). */
  cityWideInventory?: boolean;
  /**
   * The property's EXPECTED US state, normalized to a full lowercase name
   * ("florida", "hawaii", …). The daemon's mainland-namesake destination guard
   * (vrboResolvedToNonHawaiiState) uses it to ACCEPT a resolution that matches the
   * expected state (a Florida property legitimately resolves to Florida) while
   * still rejecting a mismatch (a Hawaii property drifting to "Port Allen,
   * Louisiana"). Omitted/"hawaii" → byte-identical legacy behavior (reject all
   * non-Hawaii). See AGENTS.md geo-guard note + listing-geo.ts.
   */
  expectedState?: string;
};

// USPS abbreviation → full lowercase state name. The destination's state field is
// often the abbreviation ("FL"); the daemon guard matches on full names, so
// normalize here (server-side, type-checked) before threading expectedState.
const US_STATE_ABBR_TO_FULL: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california",
  co: "colorado", ct: "connecticut", de: "delaware", fl: "florida", ga: "georgia",
  hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa", ks: "kansas",
  ky: "kentucky", la: "louisiana", me: "maine", md: "maryland", ma: "massachusetts",
  mi: "michigan", mn: "minnesota", ms: "mississippi", mo: "missouri", mt: "montana",
  ne: "nebraska", nv: "nevada", nh: "new hampshire", nj: "new jersey", nm: "new mexico",
  ny: "new york", nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma",
  or: "oregon", pa: "pennsylvania", ri: "rhode island", sc: "south carolina",
  sd: "south dakota", tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont",
  va: "virginia", wa: "washington", wv: "west virginia", wi: "wisconsin", wy: "wyoming",
};
function fullStateNameLower(state?: string | null): string | undefined {
  const s = String(state ?? "").trim().toLowerCase();
  if (!s) return undefined;
  return US_STATE_ABBR_TO_FULL[s] ?? s; // already a full name, or unknown → pass through
}

export type SidecarVrboPhotoScrapeParams = {
  url: string;
  maxPhotos?: number;
};

// CODEX NOTE (2026-05-04, claude/sidecar-zillow-scrape): Zillow
// photo + facts scrape via the operator's local Chrome. Wired as
// the tertiary fallback in scrapeListingPhotos when both Apify
// and ScrapingBee return 0 photos — the residential IP bypasses
// Zillow's datacenter anti-bot wall that hits Apify and
// ScrapingBee on bad days. Result returns photos[] AND extracted
// facts (bedrooms/bathrooms/homeType/...), so the find-clean-unit
// HTML-fallback step is unnecessary when the sidecar succeeds.
export type SidecarZillowPhotoScrapeParams = {
  url: string;
  maxPhotos?: number;
};

export type SidecarZillowPhotoScrapeResult = {
  photos: string[];
  facts?: {
    bedrooms?: number;
    bathrooms?: number;
    homeType?: string;
    homeStatus?: string;
    propertySubType?: string;
    photoCount?: number;
  };
};

export type SidecarBookingParams = {
  destination: string;
  searchTerm?: string;
  checkIn: string;
  checkOut: string;
  bedrooms: number;
  searchMode?: "destination_dropdown" | "map_bounds";
  mapSearch?: {
    enabled: boolean;
    targetName?: string;
    bounds?: {
      sw_lat: number;
      sw_lng: number;
      ne_lat: number;
      ne_lng: number;
    };
    center?: { lat: number; lng: number };
    radiusKm?: number;
  };
  searchVariations?: string[];
  variationMode?: SidecarSearchVariationMode;
  queueContext?: SidecarQueueContext;
};

export type SidecarGoogleSerpParams = {
  query: string;
  maxResults?: number;
};

export type SidecarPmSearchSite = {
  label: string;
  baseUrl: string;
  searchUrl?: string;
};

export type SidecarPmSiteSearchParams = {
  sites: SidecarPmSearchSite[];
  searchTerm: string;
  checkIn: string;
  checkOut: string;
  bedrooms: number;
  perSiteLimit?: number;
  maxSites?: number;
  budgetMs?: number;
};

export type SidecarPmUrlCheckParams = {
  url: string;
  checkIn: string;
  checkOut: string;
  bedrooms?: number;
};

// Batch variant: daemon opens N parallel Chrome tabs and verifies
// each URL concurrently. Way faster than firing N pm_url_check
// requests sequentially. The upgraded local worker is sized for up to
// 8 tabs/windows; callers should still keep URL batches scoped to the
// exact shortlist they need.
export type SidecarPmUrlCheckBatchParams = {
  urls: string[];
  checkIn: string;
  checkOut: string;
  bedrooms?: number;
};

export type SidecarPmUrlCheckBatchResult = Array<{
  url: string;
  available: "yes" | "no" | "unclear";
  nightlyPrice: number | null;
  totalPrice: number | null;
  bedrooms?: number | null;
  reason: string;
}>;

// Photo upload ops for the channel-photo-independence flow. The
// sidecar uses the operator's authenticated VRBO partner portal /
// Booking extranet session (cookies already auto-synced) to upload
// photos directly to the channel's listing — bypassing Guesty so
// the channel can hold a different photo set than what Guesty's
// pictures[] would push.
//
// `partnerListingRef` is whatever the sidecar needs to navigate to
// the right listing's edit page. For VRBO this is the property ID
// in the partner portal URL (e.g. "1234567" from
// vrbo.com/partner/listings/1234567/photos). For Booking, the
// hotel id from the extranet URL. The operator sets this once per
// listing in the Photo Sync Status panel.
//
// `photos[].url` is a public URL the sidecar can download (typically
// an ImgBB URL produced earlier in the photo pipeline, or a scraped
// Zillow URL). Captions are optional; partner portals usually accept
// photo descriptions during bulk upload.
export type SidecarPhotoUploadParams = {
  partnerListingRef: string;
  photos: Array<{ url: string; caption?: string }>;
};

export type SidecarPhotoUploadResult = {
  uploaded: number;
  failed: number;
  details?: Array<{ url: string; ok: boolean; error?: string }>;
};

// Guesty admin channel disconnect. Sidecar Playwright navigates the
// operator's authenticated Guesty admin session to the listing's
// Settings → Integrations → [Channel] panel and clicks Disconnect,
// permanently severing Guesty's master sync to that channel for that
// listing (calendar, rates, photos, descriptions). The operator
// manages everything for that channel directly from there onward.
//
// Used as the final step of the per-channel isolate-replace-disconnect
// flow — runs only after the channel-specific photo upload has
// confirmed-succeeded, so Guesty's last sync state is the operator's
// hand-curated photo set.
export type SidecarGuestyDisconnectParams = {
  guestyListingId: string;
  channel: "vrbo" | "booking";
};

export type SidecarGuestyDisconnectResult = {
  ok: boolean;
  message: string;
};

// VRBO buy-in checkout. The sidecar drives ONE VRBO listing through guest
// checkout UP TO the payment step, fills only the traveler block (the actual
// guest's name + a unique per-unit email alias + the fixed booking phone), then
// surfaces the (yellow) Chrome window and BLOCKS while the operator enters card
// details + clicks "Book now" themselves. Card/billing fields are never touched
// by automation. See server/buy-in-checkout-job.ts + daemon processVrboBook.
export type SidecarVrboBookParams = {
  buyInId: number;
  listingUrl: string;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  firstName: string;
  lastName: string;
  email: string; // unique per-unit traveler alias
  phone: string; // fixed operator booking phone (407 449 7941)
  bedrooms?: number;
  queueContext?: SidecarQueueContext;
};

export type SidecarVrboBookResult = {
  stage: "booked" | "awaiting_payment_timeout";
  confirmed: boolean;
  confirmationNumber: string | null;
  travelerFilled?: Record<string, boolean>;
  listingUrl?: string;
  navUrl?: string;
};

export type SidecarParamsByOp = {
  airbnb_search: SidecarAirbnbParams;
  vrbo_search: SidecarVrboParams;
  vrbo_photo_scrape: SidecarVrboPhotoScrapeParams;
  zillow_photo_scrape: SidecarZillowPhotoScrapeParams;
  booking_search: SidecarBookingParams;
  google_serp: SidecarGoogleSerpParams;
  pm_site_search: SidecarPmSiteSearchParams;
  pm_url_check: SidecarPmUrlCheckParams;
  pm_url_check_batch: SidecarPmUrlCheckBatchParams;
  vrbo_upload_photos: SidecarPhotoUploadParams;
  booking_upload_photos: SidecarPhotoUploadParams;
  guesty_disconnect_channel: SidecarGuestyDisconnectParams;
  vrbo_book: SidecarVrboBookParams;
};

// Result shapes per op type.
export type SidecarPropertyCandidate = {
  url: string;
  title: string;
  totalPrice: number;
  nightlyPrice: number;
  bedrooms?: number;
  bathrooms?: number;
  sleeps?: number;
  rating?: number;
  reviewCount?: number;
  bedroomSource?: "search-card" | "search-filter" | "detail-page" | "unknown";
  sourceLabel?: string;
  image?: string;
  images?: string[];
  snippet?: string;
  locationText?: string;
  basicDetails?: string[];
  lat?: number;
  lng?: number;
  // PR #299: when daemon extracted from Vrbo's new "$X total includes
  // taxes & fees" format, the price is already all-in and downstream
  // should skip the per-region tax-normalization multiplier. Old
  // "$X for Y nights" format is pre-tax and still needs normalization.
  // Optional + defaults to false so older daemon binaries (pre-#299)
  // get the legacy normalization behavior automatically.
  priceIncludesTaxes?: boolean;
  // True when the scraped quote already includes mandatory platform /
  // property fees such as cleaning and service fees. Nightly/base-only
  // snippets set this false so the server can estimate all-in cost.
  priceIncludesFees?: boolean;
  priceBasis?: "all_in" | "pre_tax_total" | "stay_total" | "nightly_base" | "unknown";
  // A dated provider result card was visible, but the OTA did not expose a
  // parseable price in the card text. Count this for inventory/availability
  // only; never use it as a priced buy-in candidate.
  availabilityOnly?: boolean;
  directBookingUrl?: string;
  directBookingHost?: string;
  directBookingConfidence?: "high" | "medium" | "low";
  directBookingSource?: "airbnb_image_reverse_search";
  directBookingReason?: string;
  searchVariant?: string;
  vrboId?: string;
  bookingId?: string;
  captureSource?: "vrbo_graphql_propertySearchListings" | "vrbo_dom_search_card" | "booking_map_search_results";
};

export type SidecarSearchVariationMode =
  | boolean
  | {
      filterTokens?: string[];
      maxVariations?: number;
      allowDiscovery?: boolean;
      rerunOnlyUntried?: boolean;
    };

export type SidecarQueueContext = {
  scanLabel?: string;
  detail?: string;
  providerLabel?: string;
  unitLabel?: string;
  dateLabel?: string;
  listingTitle?: string;
  propertyId?: number;
  concurrencyMode?: "availability_bulk";
  /** When true, never reuse a prior successful sidecar search result for this op. */
  skipResultCache?: boolean;
  /** When true, bypass request-key dedupe and enqueue a new browser run. */
  forceFresh?: boolean;
};

export type SidecarSearchVariationAttempt = {
  term: string;
  typedQuery?: string;
  suggestionText?: string;
  source?: string;
  success: boolean;
  candidateCount: number;
  error?: string;
};

export type SidecarSearchVariationSummary = {
  provider: OtaProvider;
  communityKey: string;
  communityName: string;
  city: string | null;
  state: string | null;
  checkIn?: string;
  checkOut?: string;
  bedrooms?: number;
  tried: SidecarSearchVariationAttempt[];
  bestTerm: string | null;
  bestYieldCount: number;
  generatedTerms: string[];
};

export type SidecarScreenSnapshot = {
  slot: string;
  requestId?: string;
  opType?: SidecarOpType | string;
  label?: string;
  phase?: string;
  url?: string;
  title?: string;
  liveViewUrl?: string;
  screenshotDataUrl?: string;
  width?: number;
  height?: number;
  captcha?: boolean;
  active?: boolean;
  error?: string;
  at: string;
  ageMs: number;
};

export type SidecarScreenControlCommand = {
  id: string;
  slot: string;
  requestId?: string;
  action: "move" | "down" | "up" | "click" | "hold" | "surface";
  x: number;
  y: number;
  durationMs?: number;
  at: string;
};

export type SidecarSerpHit = {
  url: string;
  title: string;
  snippet?: string;
};

export type SidecarVrboPhotoScrapeResult = {
  photos: string[];
  // Listing sleeping-arrangements / "Rooms & beds" text harvested by the
  // sidecar (real browser, no bot wall) so the guest page can surface real
  // bed types. Optional — older workers don't return it.
  bedText?: string;
  // Guest capacity ("Sleeps N") harvested from the listing summary — reliable,
  // used for the combined-sleeps figure on the guest page. Optional.
  sleeps?: number | null;
  // Phase 4 detail enrichment: per-listing coordinates + complex/address from the
  // listing DETAIL page (the SRP/map don't expose them — AGENTS city-inventory #8).
  lat?: number | null;
  lng?: number | null;
  complexName?: string | null;
  streetAddress?: string | null;
};

export type SidecarPmUrlCheckResult = {
  available: "yes" | "no" | "unclear";
  nightlyPrice: number | null;
  totalPrice: number | null;
  bedrooms?: number | null;
  reason: string;
};

export type SidecarRequest = {
  id: string;
  status: "pending" | "paused" | "in_progress" | "completed" | "failed";
  opType: SidecarOpType;
  params:
    | SidecarAirbnbParams
    | SidecarVrboParams
    | SidecarVrboPhotoScrapeParams
    | SidecarZillowPhotoScrapeParams
    | SidecarBookingParams
    | SidecarGoogleSerpParams
    | SidecarPmSiteSearchParams
    | SidecarPmUrlCheckParams
    | SidecarPmUrlCheckBatchParams
    | SidecarPhotoUploadParams
    | SidecarGuestyDisconnectParams
    | SidecarVrboBookParams;
  requestKey: string;
  results?:
    | SidecarPropertyCandidate[]
    | SidecarVrboPhotoScrapeResult
    | SidecarZillowPhotoScrapeResult
    | SidecarSerpHit[]
    | SidecarPmUrlCheckResult
    | SidecarPmUrlCheckBatchResult
    | SidecarPhotoUploadResult
    | SidecarGuestyDisconnectResult
    | SidecarVrboBookResult
    | null;
  searchVariationSummary?: SidecarSearchVariationSummary;
  mapHarvest?: SidecarMapHarvestStats | null;
  error?: string;
  createdAt: number;
  claimedAt?: number;
  claimedBy?: SidecarWorkerRuntime["source"];
  completedAt?: number;
  cancelled?: boolean;
  pausedReason?: string;
  pausedAt?: number;
  stage?: string;
  stageUpdatedAt?: number;
};

export type SidecarStatusRequest = {
  id: string;
  status: SidecarRequest["status"];
  opType: SidecarOpType;
  label: string;
  summary: string;
  detail: string;
  providerLabel?: string;
  unitLabel?: string;
  dateLabel?: string;
  listingTitle?: string;
  stage?: string;
  pausedReason?: string;
  pausedAgeSec?: number;
  bedrooms?: number;
  destination?: string;
  siteCount?: number;
  ageSec: number;
  activeSec?: number;
};

export type SidecarWorkerRuntime = {
  slot?: string;
  workerRole?: string;
  browserMode?: string;
  chromePrimary?: string;
  source?: "server" | "local" | "unknown";
};

export type SidecarProviderKey = "airbnb" | "vrbo" | "booking";

export type SidecarProviderHealth = {
  provider: SidecarProviderKey;
  status: "healthy" | "degraded" | "blocked" | "cooldown" | "unknown";
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failureReason: string | null;
  cooldownUntil: string | null;
  retryAfterMs: number | null;
  updatedAt: string | null;
};

// Backward-compat alias — old code imported this name when the queue
// was VRBO-only.
export type SidecarVrboCandidate = SidecarPropertyCandidate;

export type SidecarMapHarvestStats = {
  harvestPasses?: number;
  finalHarvestTotal?: number;
  lastVisibleCards?: number;
  lastPropertyLinks?: number;
  domSeen?: number;
  harvestSeenInExtract?: number;
  extractTotalSeen?: number;
  extractDrops?: { noUrl?: number; noPrice?: number; noBedrooms?: number } | null;
  networkCount?: number;
  pricedNetworkCount?: number;
  mergedCount?: number;
  graphqlResponsesMatched?: number;
  graphqlResponsesSeen?: number;
  graphqlReplayPages?: number;
  graphqlUiPages?: number;
  graphqlPaginationStop?: string | null;
  graphqlTotalCount?: number;
};

const queue = new Map<string, SidecarRequest>();
const requestKeyIndex = new Map<string, string>(); // requestKey → id
type CachedSidecarResult = {
  results: SidecarRequest["results"];
  searchVariationSummary?: SidecarSearchVariationSummary;
  mapHarvest?: SidecarMapHarvestStats | null;
  cachedAt: number;
};
const successfulResultCache = new Map<string, CachedSidecarResult>();
const providerHealth = new Map<SidecarProviderKey, {
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  failureReason: string | null;
  cooldownUntil: number | null;
  updatedAt: number | null;
}>();
const searchVariationRuns = new Map<string, SidecarSearchVariationSummary>();

// Worker liveness: every time the worker calls `next()`, we stamp this.
// The UI polls `getHeartbeat()` to decide whether to show "Local sidecar
// online / offline" — purely a UX signal, not load-bearing for queue
// correctness. Online window is 90s (1.5× the daemon's POLL_IDLE_MS so
// a single missed poll doesn't flicker the indicator).
let lastWorkerPollAt: number | null = null;
let lastWorkerRuntime: SidecarWorkerRuntime | null = null;
let lastLocalWorkerPollAt: number | null = null;
let lastLocalWorkerRuntime: SidecarWorkerRuntime | null = null;
let lastServerWorkerPollAt: number | null = null;
let lastServerWorkerRuntime: SidecarWorkerRuntime | null = null;
const HEARTBEAT_ONLINE_WINDOW_MS = 90 * 1000;
const LOCAL_WORKER_PREFERRED_WINDOW_MS = Math.max(
  5_000,
  numberFromEnv("SIDECAR_LOCAL_WORKER_PREFERRED_WINDOW_MS", HEARTBEAT_ONLINE_WINDOW_MS),
);

// CODEX NOTE (2026-05-04, claude/sidecar-stop-start): operator-
// controlled paused flag. When true, next() returns null even when
// pending requests exist — the worker keeps polling (so the
// heartbeat / "online" indicator stays green) but it doesn't pick
// up any work. Combined with cancelActiveAndPendingRequests, this
// gives the operator a hard "Stop" — currently-running ops are
// cancelled AND new ones won't start. "Start" just clears the
// flag. State is in-memory only — a server restart resets to
// unpaused, which is the safer default.
let queuePaused = false;
let queuePausedAt: number | null = null;
let queuePausedReason: string | null = null;
let queueStopGeneration = 0;
const sidecarScreens = new Map<string, Omit<SidecarScreenSnapshot, "ageMs">>();
const sidecarScreenCommands = new Map<string, SidecarScreenControlCommand[]>();

// TTLs (per-status) — also bound the size of the queue so a wedged
// worker can't accumulate state forever.
const PENDING_TTL_MS = 5 * 60 * 1000;
const IN_PROGRESS_RECLAIM_MS = 90 * 1000;
const TERMINAL_TTL_MS = 5 * 60 * 1000;
const SUCCESS_RESULT_CACHE_TTL_MS = Math.max(
  0,
  numberFromEnv("SIDECAR_SUCCESS_RESULT_CACHE_TTL_MS", 48 * 60 * 60 * 1000),
);
const SIDECAR_SCREEN_TTL_MS = 10 * 60 * 1000;
const SIDECAR_INACTIVE_SCREEN_TTL_MS = Math.max(
  1_000,
  numberFromEnv("SIDECAR_INACTIVE_SCREEN_TTL_MS", 15_000),
);
const SIDECAR_SCREENSHOT_MAX_CHARS = 350_000;
const SIDECAR_SCREEN_COMMAND_TTL_MS = 60 * 1000;
const DEFAULT_OP_CONCURRENCY: Partial<Record<SidecarOpType, number>> = {
  // Keep same-provider public OTA searches single-file by default, but do
  // allow one VRBO and one Booking.com search to run at the same time. This
  // uses the visible Chrome slot pool without doubling up on the same provider
  // from the same Mac/IP.
  airbnb_search: 1,
  booking_search: 1,
  vrbo_search: 1,
  vrbo_photo_scrape: 1,
  // One human-paced checkout at a time — it pins a Chrome slot for the whole
  // payment handoff, so never run two concurrently.
  vrbo_book: 1,
};

function isAvailabilityBulkSearch(
  opType: SidecarOpType,
  params?: SidecarRequest["params"] | null,
): boolean {
  if (opType !== "booking_search" && opType !== "vrbo_search") return false;
  const queueContext = (params as Partial<SidecarBookingParams & SidecarVrboParams> | undefined)?.queueContext;
  return queueContext?.concurrencyMode === "availability_bulk";
}

function opConcurrencyGroup(opType: SidecarOpType, params?: SidecarRequest["params"] | null): string {
  if (isAvailabilityBulkSearch(opType, params)) {
    return opType === "booking_search"
      ? "availability_bulk_booking_search"
      : "availability_bulk_vrbo_search";
  }
  if (opType === "booking_search") return "booking_search";
  if (opType === "vrbo_search" || opType === "vrbo_photo_scrape") return "vrbo_search";
  if (opType === "airbnb_search") return "airbnb_search";
  return opType;
}

function nowMs(): number {
  return Date.now();
}

function cleanText(value: unknown, max = 160): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function providerForOp(opType: SidecarOpType): OtaProvider | null {
  if (opType === "airbnb_search") return "airbnb";
  if (opType === "vrbo_search") return "vrbo";
  if (opType === "booking_search") return "booking";
  return null;
}

function parseSearchLocation(params: Partial<SidecarAirbnbParams & SidecarVrboParams & SidecarBookingParams>): {
  communityName: string;
  city: string | null;
  state: string | null;
  communityKey: string;
} {
  const searchTerm = cleanText(params.searchTerm || params.destination);
  const destination = cleanText(params.destination);
  const parts = destination.split(",").map((part) => part.trim()).filter(Boolean);
  const communityName = normalizeResortSearchTerm(searchTerm || parts[0] || destination);
  const city = parts.length >= 3 ? parts[1] : null;
  const state = parts.length >= 3 ? parts[2] : parts.length === 2 ? parts[1] : null;
  return {
    communityName,
    city,
    state,
    communityKey: searchVariationKey({ community: communityName, city, state }),
  };
}

function variationRunKey(input: {
  provider: OtaProvider;
  communityKey: string;
  checkIn?: string;
  checkOut?: string;
  bedrooms?: number;
}): string {
  return [
    input.provider,
    input.communityKey,
    input.checkIn ?? "",
    input.checkOut ?? "",
    input.bedrooms ?? "",
  ].join("|");
}

function normalizeVariationAttempt(raw: unknown): SidecarSearchVariationAttempt | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const term = cleanText(item.term || item.searchTerm || item.suggestionText);
  if (!term) return null;
  const candidateCount = Number(item.candidateCount);
  return {
    term,
    typedQuery: cleanText(item.typedQuery) || undefined,
    suggestionText: cleanText(item.suggestionText) || undefined,
    source: cleanText(item.source, 80) || undefined,
    success: item.success === true,
    candidateCount: Number.isFinite(candidateCount) && candidateCount > 0 ? Math.round(candidateCount) : 0,
    error: cleanText(item.error, 240) || undefined,
  };
}

function normalizeMapHarvestStats(raw: unknown): SidecarMapHarvestStats | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const num = (value: unknown) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  };
  const extractDrops = item.extractDrops && typeof item.extractDrops === "object" && !Array.isArray(item.extractDrops)
    ? {
        noUrl: num((item.extractDrops as Record<string, unknown>).noUrl),
        noPrice: num((item.extractDrops as Record<string, unknown>).noPrice),
        noBedrooms: num((item.extractDrops as Record<string, unknown>).noBedrooms),
      }
    : null;
  return {
    harvestPasses: num(item.harvestPasses),
    finalHarvestTotal: num(item.finalHarvestTotal),
    lastVisibleCards: num(item.lastVisibleCards),
    lastPropertyLinks: num(item.lastPropertyLinks),
    domSeen: num(item.domSeen),
    harvestSeenInExtract: num(item.harvestSeenInExtract),
    extractTotalSeen: num(item.extractTotalSeen),
    extractDrops,
    networkCount: num(item.networkCount),
    pricedNetworkCount: num(item.pricedNetworkCount),
    mergedCount: num(item.mergedCount),
    graphqlResponsesMatched: num(item.graphqlResponsesMatched),
    graphqlResponsesSeen: num(item.graphqlResponsesSeen),
    graphqlReplayPages: num(item.graphqlReplayPages),
    graphqlUiPages: num(item.graphqlUiPages),
    graphqlPaginationStop: typeof item.graphqlPaginationStop === "string" ? item.graphqlPaginationStop : null,
    graphqlTotalCount: num(item.graphqlTotalCount),
  };
}

function normalizeWorkerResultsPayload(
  raw: unknown,
): { results: SidecarRequest["results"]; variationsTried: SidecarSearchVariationAttempt[]; mapHarvest: SidecarMapHarvestStats | null } {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const candidates = Array.isArray(obj.candidates) ? obj.candidates : undefined;
    const variationsTried = Array.isArray(obj.variationsTried)
      ? obj.variationsTried.map(normalizeVariationAttempt).filter((x): x is SidecarSearchVariationAttempt => Boolean(x))
      : [];
    const mapHarvest = normalizeMapHarvestStats(obj.mapHarvest);
    if (candidates) {
      return { results: candidates as SidecarPropertyCandidate[], variationsTried, mapHarvest };
    }
  }
  return { results: raw as SidecarRequest["results"], variationsTried: [], mapHarvest: null };
}

async function preferredVariationRows(input: {
  communityKey: string;
  channel: OtaProvider;
  preferredOnly?: boolean;
  limit?: number;
}) {
  const rows = await db
    .select()
    .from(sidecarSearchVariations)
    .where(and(
      eq(sidecarSearchVariations.communityKey, input.communityKey),
      eq(sidecarSearchVariations.channel, input.channel),
      ...(input.preferredOnly ? [eq(sidecarSearchVariations.preferred, true)] : []),
    ))
    .orderBy(
      desc(sidecarSearchVariations.preferred),
      desc(sidecarSearchVariations.lastYieldCount),
      desc(sidecarSearchVariations.lastSuccessAt),
      desc(sidecarSearchVariations.updatedAt),
    )
    .limit(input.limit ?? 20);
  return rows;
}

export async function buildSearchVariationPolicy(input: {
  provider: OtaProvider;
  community: string;
  city?: string | null;
  state?: string | null;
  checkIn?: string;
  checkOut?: string;
  bedrooms?: number;
  rerunOnlyUntried?: boolean;
  explicitTerms?: string[];
}): Promise<{
  communityKey: string;
  generatedTerms: string[];
  preferredTerms: string[];
  terms: string[];
  filterTokens: string[];
  maxVariations: number;
  allowDiscovery: boolean;
}> {
  const communityName = normalizeResortSearchTerm(input.community);
  const communityKey = searchVariationKey({ community: communityName, city: input.city, state: input.state });
  const filterTokens = searchVariationTokens(communityName);
  const generatedTerms = generateSearchVariations(communityName, filterTokens);
  let preferredTerms: string[] = [];
  try {
    preferredTerms = (await preferredVariationRows({ communityKey, channel: input.provider, limit: 8 }))
      .map((row) => cleanText(row.term))
      .filter(Boolean);
  } catch (e: any) {
    console.warn(`[sidecar-variations] preferred lookup failed: ${e?.message ?? e}`);
  }
  const terms = Array.from(new Set([
    ...(input.explicitTerms ?? []).map((term) => cleanText(term)).filter(Boolean),
    ...preferredTerms,
    ...generatedTerms,
  ])).filter((term) => matchesSearchVariationTokens(term, filterTokens));
  const runKey = variationRunKey({
    provider: input.provider,
    communityKey,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    bedrooms: input.bedrooms,
  });
  const triedTerms = new Set((searchVariationRuns.get(runKey)?.tried ?? []).map((attempt) => attempt.term.toLowerCase()));
  const maybeUntried = input.rerunOnlyUntried
    ? terms.filter((term) => !triedTerms.has(term.toLowerCase()))
    : terms;
  return {
    communityKey,
    generatedTerms,
    preferredTerms,
    terms: maybeUntried.length ? maybeUntried.slice(0, 12) : terms.slice(0, 12),
    filterTokens,
    maxVariations: 12,
    allowDiscovery: !input.rerunOnlyUntried,
  };
}

async function upsertVariationAttempt(input: {
  provider: OtaProvider;
  communityKey: string;
  communityName: string;
  city: string | null;
  state: string | null;
  attempt: SidecarSearchVariationAttempt;
}) {
  const existing = await db
    .select()
    .from(sidecarSearchVariations)
    .where(and(
      eq(sidecarSearchVariations.communityKey, input.communityKey),
      eq(sidecarSearchVariations.channel, input.provider),
      eq(sidecarSearchVariations.term, input.attempt.term),
    ))
    .limit(1);
  const patch = {
    communityName: input.communityName,
    city: input.city,
    state: input.state,
    source: input.attempt.source ?? "sidecar",
    timesTried: sql`${sidecarSearchVariations.timesTried} + 1`,
    lastYieldCount: input.attempt.candidateCount,
    totalYieldCount: sql`${sidecarSearchVariations.totalYieldCount} + ${input.attempt.candidateCount}`,
    lastError: input.attempt.success ? null : (input.attempt.error ?? "variation failed"),
    lastSearchedAt: new Date(),
    lastSuccessAt: input.attempt.success ? new Date() : existing[0]?.lastSuccessAt ?? null,
    updatedAt: new Date(),
  };
  if (existing[0]) {
    await db
      .update(sidecarSearchVariations)
      .set(patch)
      .where(eq(sidecarSearchVariations.id, existing[0].id));
    return;
  }
  await db.insert(sidecarSearchVariations).values({
    communityKey: input.communityKey,
    communityName: input.communityName,
    city: input.city,
    state: input.state,
    channel: input.provider,
    term: input.attempt.term,
    source: input.attempt.source ?? "sidecar",
    preferred: false,
    timesTried: 1,
    lastYieldCount: input.attempt.candidateCount,
    totalYieldCount: input.attempt.candidateCount,
    lastError: input.attempt.success ? null : (input.attempt.error ?? "variation failed"),
    lastSearchedAt: new Date(),
    lastSuccessAt: input.attempt.success ? new Date() : null,
    updatedAt: new Date(),
  });
}

async function persistVariationSummary(summary: SidecarSearchVariationSummary) {
  for (const attempt of summary.tried) {
    await upsertVariationAttempt({
      provider: summary.provider,
      communityKey: summary.communityKey,
      communityName: summary.communityName,
      city: summary.city,
      state: summary.state,
      attempt,
    });
  }
}

function recordSearchVariationSummary(
  r: SidecarRequest,
  variationsTried: SidecarSearchVariationAttempt[],
): SidecarSearchVariationSummary | undefined {
  const provider = providerForOp(r.opType);
  if (!provider || variationsTried.length === 0) return undefined;
  const params = r.params as Partial<SidecarAirbnbParams & SidecarVrboParams & SidecarBookingParams>;
  const location = parseSearchLocation(params);
  const generatedTerms = generateSearchVariations(location.communityName, searchVariationTokens(location.communityName));
  const best = [...variationsTried].sort((a, b) => b.candidateCount - a.candidateCount)[0] ?? null;
  const summary: SidecarSearchVariationSummary = {
    provider,
    communityKey: location.communityKey,
    communityName: location.communityName,
    city: location.city,
    state: location.state,
    checkIn: params.checkIn,
    checkOut: params.checkOut,
    bedrooms: params.bedrooms,
    tried: variationsTried,
    bestTerm: best && best.candidateCount > 0 ? best.term : null,
    bestYieldCount: best?.candidateCount ?? 0,
    generatedTerms,
  };
  searchVariationRuns.set(variationRunKey({
    provider,
    communityKey: location.communityKey,
    checkIn: params.checkIn,
    checkOut: params.checkOut,
    bedrooms: params.bedrooms,
  }), summary);
  void persistVariationSummary(summary).catch((e: any) => {
    console.warn(`[sidecar-variations] persistence failed: ${e?.message ?? e}`);
  });
  return summary;
}

export async function getSearchVariationStatus(input: {
  community: string;
  city?: string | null;
  state?: string | null;
  checkIn?: string;
  checkOut?: string;
  bedrooms?: number;
}): Promise<{
  communityKey: string;
  communityName: string;
  generatedTerms: string[];
  channels: Record<OtaProvider, {
    preferredTerms: string[];
    untriedTerms: string[];
    bestTerm: string | null;
    history: Array<{
      term: string;
      preferred: boolean;
      timesTried: number;
      lastYieldCount: number;
      totalYieldCount: number;
      lastError: string | null;
      lastSearchedAt: string | null;
      lastSuccessAt: string | null;
    }>;
    lastRun: SidecarSearchVariationSummary | null;
  }>;
}> {
  const communityName = normalizeResortSearchTerm(input.community);
  const communityKey = searchVariationKey({ community: communityName, city: input.city, state: input.state });
  const generatedTerms = generateSearchVariations(communityName);
  const channels = {} as Record<OtaProvider, {
    preferredTerms: string[];
    untriedTerms: string[];
    bestTerm: string | null;
    history: Array<{
      term: string;
      preferred: boolean;
      timesTried: number;
      lastYieldCount: number;
      totalYieldCount: number;
      lastError: string | null;
      lastSearchedAt: string | null;
      lastSuccessAt: string | null;
    }>;
    lastRun: SidecarSearchVariationSummary | null;
  }>;
  for (const provider of ["airbnb", "vrbo", "booking"] as OtaProvider[]) {
    const rows = await preferredVariationRows({ communityKey, channel: provider, limit: 30 }).catch(() => []);
    const lastRun = searchVariationRuns.get(variationRunKey({
      provider,
      communityKey,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      bedrooms: input.bedrooms,
    })) ?? null;
    const preferredTerms = rows.filter((row) => row.preferred).map((row) => row.term);
    const candidateTerms = Array.from(new Set([...preferredTerms, ...generatedTerms]))
      .filter((term) => matchesSearchVariationTokens(term, searchVariationTokens(communityName)));
    const triedTerms = new Set((lastRun?.tried ?? []).map((attempt) => attempt.term.toLowerCase()));
    const untriedTerms = candidateTerms.filter((term) => !triedTerms.has(term.toLowerCase())).slice(0, 12);
    const bestRow = rows.find((row) => row.lastYieldCount > 0);
    channels[provider] = {
      preferredTerms,
      untriedTerms,
      bestTerm: bestRow?.term ?? lastRun?.bestTerm ?? null,
      history: rows.map((row) => ({
        term: row.term,
        preferred: row.preferred,
        timesTried: row.timesTried,
        lastYieldCount: row.lastYieldCount,
        totalYieldCount: row.totalYieldCount,
        lastError: row.lastError,
        lastSearchedAt: row.lastSearchedAt ? row.lastSearchedAt.toISOString() : null,
        lastSuccessAt: row.lastSuccessAt ? row.lastSuccessAt.toISOString() : null,
      })),
      lastRun,
    };
  }
  return { communityKey, communityName, generatedTerms, channels };
}

export async function savePreferredSearchVariations(input: {
  community: string;
  city?: string | null;
  state?: string | null;
  channel: OtaProvider;
  terms: string[];
}) {
  const communityName = normalizeResortSearchTerm(input.community);
  const communityKey = searchVariationKey({ community: communityName, city: input.city, state: input.state });
  const terms = Array.from(new Set(input.terms.map((term) => cleanText(term)).filter(Boolean))).slice(0, 12);
  await db
    .update(sidecarSearchVariations)
    .set({ preferred: false, updatedAt: new Date() })
    .where(and(
      eq(sidecarSearchVariations.communityKey, communityKey),
      eq(sidecarSearchVariations.channel, input.channel),
    ));
  for (const term of terms) {
    const existing = await db
      .select()
      .from(sidecarSearchVariations)
      .where(and(
        eq(sidecarSearchVariations.communityKey, communityKey),
        eq(sidecarSearchVariations.channel, input.channel),
        eq(sidecarSearchVariations.term, term),
      ))
      .limit(1);
    if (existing[0]) {
      await db
        .update(sidecarSearchVariations)
        .set({ preferred: true, source: "operator", updatedAt: new Date() })
        .where(eq(sidecarSearchVariations.id, existing[0].id));
    } else {
      await db.insert(sidecarSearchVariations).values({
        communityKey,
        communityName,
        city: input.city ?? null,
        state: input.state ?? null,
        channel: input.channel,
        term,
        source: "operator",
        preferred: true,
        updatedAt: new Date(),
      });
    }
  }
  return getSearchVariationStatus({ community: communityName, city: input.city, state: input.state });
}

function numberFromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

const PROVIDER_BLOCK_COOLDOWN_BASE_MS = Math.max(
  60_000,
  numberFromEnv("SIDECAR_PROVIDER_BLOCK_COOLDOWN_MS", 15 * 60_000),
);
const PROVIDER_BLOCK_COOLDOWN_MAX_MS = Math.max(
  PROVIDER_BLOCK_COOLDOWN_BASE_MS,
  numberFromEnv("SIDECAR_PROVIDER_BLOCK_COOLDOWN_MAX_MS", 60 * 60_000),
);

function providerDisplayName(provider: SidecarProviderKey): string {
  switch (provider) {
    case "airbnb": return "Airbnb";
    case "vrbo": return "VRBO";
    case "booking": return "Booking.com";
  }
}

function providerFailureIsBlockLike(reason: string | undefined | null): boolean {
  return /\b(?:captcha|blocked|block page|bot|human verification|kyc|proxy|407|tunnel|access denied|rate.?limit|datadome|cloudflare|turnstile|unusual traffic|provider\/browser failure|blank search page|bad_endpoint)\b/i.test(
    String(reason ?? ""),
  );
}

function sidecarReasonIsInfrastructureFailure(reason: string | undefined | null): boolean {
  return /\b(?:no server chrome\/novnc sidecar|local macos chrome fallback is disabled|server chrome.*unavailable)\b/i.test(
    String(reason ?? ""),
  );
}

function providerHealthState(provider: SidecarProviderKey) {
  const existing = providerHealth.get(provider);
  if (existing) return existing;
  const fresh = {
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    failureReason: null,
    cooldownUntil: null,
    updatedAt: null,
  };
  providerHealth.set(provider, fresh);
  return fresh;
}

function providerHealthSnapshot(provider: SidecarProviderKey): SidecarProviderHealth {
  const state = providerHealthState(provider);
  const now = nowMs();
  const retryAfterMs = state.cooldownUntil && state.cooldownUntil > now
    ? Math.max(0, state.cooldownUntil - now)
    : null;
  const status: SidecarProviderHealth["status"] = retryAfterMs !== null
    ? "cooldown"
    : state.lastFailureAt && (!state.lastSuccessAt || state.lastFailureAt > state.lastSuccessAt)
      ? providerFailureIsBlockLike(state.failureReason) ? "blocked" : "degraded"
      : state.lastSuccessAt
        ? "healthy"
        : "unknown";
  return {
    provider,
    status,
    consecutiveFailures: state.consecutiveFailures,
    lastSuccessAt: state.lastSuccessAt ? new Date(state.lastSuccessAt).toISOString() : null,
    lastFailureAt: state.lastFailureAt ? new Date(state.lastFailureAt).toISOString() : null,
    failureReason: state.failureReason,
    cooldownUntil: state.cooldownUntil ? new Date(state.cooldownUntil).toISOString() : null,
    retryAfterMs,
    updatedAt: state.updatedAt ? new Date(state.updatedAt).toISOString() : null,
  };
}

export function getProviderHealth(provider?: SidecarProviderKey): SidecarProviderHealth[] {
  const providers: SidecarProviderKey[] = provider ? [provider] : ["airbnb", "vrbo", "booking"];
  return providers.map(providerHealthSnapshot);
}

function activeProviderCooldown(provider: SidecarProviderKey): SidecarProviderHealth | null {
  const snapshot = providerHealthSnapshot(provider);
  return snapshot.status === "cooldown" && snapshot.retryAfterMs !== null ? snapshot : null;
}

function recordProviderSuccess(provider: SidecarProviderKey): SidecarProviderHealth {
  const state = providerHealthState(provider);
  const now = nowMs();
  state.consecutiveFailures = 0;
  state.lastSuccessAt = now;
  state.failureReason = null;
  state.cooldownUntil = null;
  state.updatedAt = now;
  return providerHealthSnapshot(provider);
}

function recordProviderFailure(provider: SidecarProviderKey, reason: string): SidecarProviderHealth {
  const state = providerHealthState(provider);
  const now = nowMs();
  state.consecutiveFailures += 1;
  state.lastFailureAt = now;
  state.failureReason = reason.replace(/\s+/g, " ").trim().slice(0, 600);
  state.updatedAt = now;
  if (providerFailureIsBlockLike(reason)) {
    const multiplier = Math.min(4, Math.max(1, state.consecutiveFailures));
    state.cooldownUntil = now + Math.min(PROVIDER_BLOCK_COOLDOWN_MAX_MS, PROVIDER_BLOCK_COOLDOWN_BASE_MS * multiplier);
  }
  return providerHealthSnapshot(provider);
}

function recordProviderOutcome(
  provider: SidecarProviderKey,
  result: { workerOnline: boolean; reason: string; candidates: SidecarPropertyCandidate[] },
): SidecarProviderHealth {
  if (providerFailureIsBlockLike(result.reason) || sidecarReasonIsInfrastructureFailure(result.reason)) {
    return recordProviderFailure(provider, result.reason);
  }
  if (result.workerOnline) return recordProviderSuccess(provider);
  return recordProviderFailure(provider, result.reason);
}

function providerCooldownSearchResult(provider: SidecarProviderKey): {
  candidates: SidecarPropertyCandidate[];
  workerOnline: boolean;
  durationMs: number;
  reason: string;
  providerHealth: SidecarProviderHealth;
} {
  const health = providerHealthSnapshot(provider);
  const retryAt = health.cooldownUntil ? ` Retry after ${health.cooldownUntil}.` : "";
  return {
    candidates: [],
    workerOnline: getHeartbeat().isOnline,
    durationMs: 0,
    reason: `${providerDisplayName(provider)} provider is cooling down after a block/proxy failure: ${health.failureReason ?? "blocked"}.${retryAt}`,
    providerHealth: health,
  };
}

function opConcurrencyLimit(opType: SidecarOpType, params?: SidecarRequest["params"] | null): number {
  const group = opConcurrencyGroup(opType, params);
  if (isAvailabilityBulkSearch(opType, params)) {
    const envName = opType === "booking_search"
      ? "SIDECAR_AVAILABILITY_BOOKING_CONCURRENCY"
      : "SIDECAR_AVAILABILITY_VRBO_CONCURRENCY";
    const configured = numberFromEnv(envName, 4);
    return Math.max(1, Math.floor(configured));
  }
  const groupEnvName = group === "ota_provider" ? "SIDECAR_OTA_CONCURRENCY" : "";
  const envName = `SIDECAR_${opType.toUpperCase()}_CONCURRENCY`;
  const fallback = DEFAULT_OP_CONCURRENCY[opType] ?? Number.POSITIVE_INFINITY;
  const configured = groupEnvName && process.env[groupEnvName] !== undefined
    ? numberFromEnv(groupEnvName, fallback)
    : numberFromEnv(envName, fallback);
  if (!Number.isFinite(configured)) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor(configured));
}

function activeCountForOp(opType: SidecarOpType, params?: SidecarRequest["params"] | null): number {
  const group = opConcurrencyGroup(opType, params);
  let count = 0;
  for (const r of queue.values()) {
    if (r.status === "in_progress" && opConcurrencyGroup(r.opType, r.params) === group) count++;
  }
  return count;
}

function isOtaBrowserOp(opType: SidecarOpType): boolean {
  return (
    opType === "airbnb_search" ||
    opType === "booking_search" ||
    opType === "vrbo_search" ||
    opType === "vrbo_photo_scrape"
  );
}

function localWorkerHasActiveOtaClaim(): boolean {
  for (const r of queue.values()) {
    if (r.status !== "in_progress" || !isOtaBrowserOp(r.opType)) continue;
    if (r.claimedBy === "local") return true;
  }
  return false;
}

function localWorkerIsPreferred(now = nowMs()): boolean {
  // NOTE FOR CODEX: heartbeat-only polls must not block Railway workers.
  // A LaunchAgent that is alive but not claiming (or a stale local tab)
  // used to defer server OTA claims for 90s while buy-in looked hung.
  return Boolean(
    lastLocalWorkerPollAt !== null &&
    now - lastLocalWorkerPollAt < LOCAL_WORKER_PREFERRED_WINDOW_MS &&
    localWorkerHasActiveOtaClaim(),
  );
}

function canClaimOp(request: SidecarRequest, runtime?: SidecarWorkerRuntime | null): boolean {
  // vrbo_book (buy-in checkout) runs ONLY on the local Mac sidecar: the handler
  // ships there via `cp` (not in the Railway image), the operator's residential
  // IP is the one that clears VRBO's wall, and the human payment handoff happens
  // on the operator's own screen. Never let a server/Railway worker claim it
  // (it would throw "unknown opType: vrbo_book").
  if (request.opType === "vrbo_book" && runtime?.source !== "local") return false;
  if (runtime?.source === "server" && isOtaBrowserOp(request.opType) && localWorkerIsPreferred()) {
    return false;
  }
  return activeCountForOp(request.opType, request.params) < opConcurrencyLimit(request.opType, request.params);
}

function sidecarRunCancelledError(reason = "sidecar run cancelled by operator stop"): Error {
  const err = new Error(reason);
  err.name = "SidecarRunCancelledError";
  return err;
}

export function getSidecarStopGeneration(): number {
  return queueStopGeneration;
}

export function hasSidecarStopGenerationChanged(generation: number | null | undefined): boolean {
  return generation != null && generation !== queueStopGeneration;
}

export function assertSidecarStopGenerationCurrent(generation: number | null | undefined): void {
  if (hasSidecarStopGenerationChanged(generation)) {
    throw sidecarRunCancelledError();
  }
}

function normalizeWorkerRuntime(runtime?: Partial<SidecarWorkerRuntime> | null): SidecarWorkerRuntime | null {
  if (!runtime) return null;
  const clean = (value: unknown, max = 40): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.replace(/\s+/g, " ").trim().slice(0, max);
    return trimmed || undefined;
  };
  const workerRole = clean(runtime.workerRole);
  const browserMode = clean(runtime.browserMode);
  const chromePrimary = clean(runtime.chromePrimary);
  const slot = clean(runtime.slot, 16);
  const source = workerRole === "server" || chromePrimary === "server" || browserMode === "server"
    ? "server"
    : workerRole || browserMode || chromePrimary
      ? "local"
      : undefined;
  if (!workerRole && !browserMode && !chromePrimary && !slot && !source) return null;
  return {
    ...(slot ? { slot } : {}),
    ...(workerRole ? { workerRole } : {}),
    ...(browserMode ? { browserMode } : {}),
    ...(chromePrimary ? { chromePrimary } : {}),
    source: source ?? "unknown",
  };
}

export function stampHeartbeat(id?: string, stage?: string, runtime?: Partial<SidecarWorkerRuntime> | null): void {
  const stampedAt = nowMs();
  lastWorkerPollAt = stampedAt;
  const normalizedRuntime = normalizeWorkerRuntime(runtime);
  if (normalizedRuntime) {
    lastWorkerRuntime = normalizedRuntime;
    if (normalizedRuntime.source === "local") {
      lastLocalWorkerPollAt = stampedAt;
      lastLocalWorkerRuntime = normalizedRuntime;
    } else if (normalizedRuntime.source === "server") {
      lastServerWorkerPollAt = stampedAt;
      lastServerWorkerRuntime = normalizedRuntime;
    }
  }
  if (!id) return;
  const r = queue.get(id);
  if (r?.status === "in_progress") {
    r.claimedAt = stampedAt;
    if (stage && typeof stage === "string") {
      r.stage = stage.replace(/\s+/g, " ").trim().slice(0, 140);
      r.stageUpdatedAt = stampedAt;
    }
  }
}

function requestIsInProgress(id?: string): boolean {
  return Boolean(id && queue.get(id)?.status === "in_progress");
}

export function updateSidecarScreenSnapshot(snapshot: {
  slot?: unknown;
  requestId?: unknown;
  opType?: unknown;
  label?: unknown;
  phase?: unknown;
  url?: unknown;
  title?: unknown;
  liveViewUrl?: unknown;
  screenshotDataUrl?: unknown;
  width?: unknown;
  height?: unknown;
  captcha?: unknown;
  error?: unknown;
  clear?: unknown;
}): { ok: boolean } {
  const slot = String(snapshot.slot || "1").replace(/[^\w.-]/g, "").slice(0, 32) || "1";
  if (snapshot.clear === true) {
    sidecarScreens.delete(slot);
    sidecarScreenCommands.delete(slot);
    return { ok: true };
  }
  const requestId = typeof snapshot.requestId === "string" ? snapshot.requestId.slice(0, 80) : undefined;
  if (requestId && !requestIsInProgress(requestId)) {
    sidecarScreens.delete(slot);
    sidecarScreenCommands.delete(slot);
    return { ok: true };
  }
  const screenshotDataUrl = typeof snapshot.screenshotDataUrl === "string" &&
    snapshot.screenshotDataUrl.length <= SIDECAR_SCREENSHOT_MAX_CHARS
    ? snapshot.screenshotDataUrl
    : undefined;
  const previous = sidecarScreens.get(slot);
  const reusablePreviousImage =
    previous?.requestId === requestId && previous.screenshotDataUrl
      ? previous.screenshotDataUrl
      : undefined;
  sidecarScreens.set(slot, {
    slot,
    requestId,
    opType: typeof snapshot.opType === "string" ? snapshot.opType.slice(0, 80) : undefined,
    label: typeof snapshot.label === "string" ? snapshot.label.replace(/\s+/g, " ").trim().slice(0, 120) : undefined,
    phase: typeof snapshot.phase === "string" ? snapshot.phase.replace(/\s+/g, " ").trim().slice(0, 140) : undefined,
    url: typeof snapshot.url === "string" ? snapshot.url.slice(0, 500) : undefined,
    title: typeof snapshot.title === "string" ? snapshot.title.replace(/\s+/g, " ").trim().slice(0, 180) : undefined,
    liveViewUrl: typeof snapshot.liveViewUrl === "string" && /^https?:\/\//i.test(snapshot.liveViewUrl)
      ? snapshot.liveViewUrl.slice(0, 500)
      : undefined,
    screenshotDataUrl: screenshotDataUrl ?? reusablePreviousImage,
    width: typeof snapshot.width === "number" && Number.isFinite(snapshot.width) ? Math.round(snapshot.width) : previous?.width,
    height: typeof snapshot.height === "number" && Number.isFinite(snapshot.height) ? Math.round(snapshot.height) : previous?.height,
    captcha: snapshot.captcha === true,
    error: typeof snapshot.error === "string" ? snapshot.error.replace(/\s+/g, " ").trim().slice(0, 240) : undefined,
    at: new Date().toISOString(),
  });
  return { ok: true };
}

export function getSidecarScreenSnapshots(): SidecarScreenSnapshot[] {
  const now = nowMs();
  for (const [slot, snapshot] of sidecarScreens) {
    const at = Date.parse(snapshot.at);
    const ageMs = Number.isFinite(at) ? now - at : Number.POSITIVE_INFINITY;
    const active = requestIsInProgress(snapshot.requestId);
    if (
      !Number.isFinite(at) ||
      ageMs > SIDECAR_SCREEN_TTL_MS ||
      (!active && ageMs > SIDECAR_INACTIVE_SCREEN_TTL_MS)
    ) {
      sidecarScreens.delete(slot);
      sidecarScreenCommands.delete(slot);
    }
  }
  return Array.from(sidecarScreens.values())
    .map((snapshot) => {
      const at = Date.parse(snapshot.at);
      const active = requestIsInProgress(snapshot.requestId);
      return {
        ...snapshot,
        active,
        captcha: snapshot.captcha === true && active,
        ageMs: Number.isFinite(at) ? Math.max(0, now - at) : 0,
      };
    })
    .sort((a, b) => a.slot.localeCompare(b.slot, undefined, { numeric: true }));
}

function screenCommandKey(slot: string): string {
  return String(slot || "1").replace(/[^\w.-]/g, "").slice(0, 32) || "1";
}

function cleanupSidecarScreenCommands(): void {
  const now = nowMs();
  for (const [slot, commands] of sidecarScreenCommands) {
    const fresh = commands.filter((cmd) => {
      const at = Date.parse(cmd.at);
      return Number.isFinite(at) && now - at <= SIDECAR_SCREEN_COMMAND_TTL_MS;
    });
    if (fresh.length) sidecarScreenCommands.set(slot, fresh);
    else sidecarScreenCommands.delete(slot);
  }
}

export function enqueueSidecarScreenControlCommand(command: {
  slot?: unknown;
  requestId?: unknown;
  action?: unknown;
  x?: unknown;
  y?: unknown;
}): { ok: boolean; error?: string; command?: SidecarScreenControlCommand } {
  cleanupSidecarScreenCommands();
  const slot = screenCommandKey(String(command.slot || "1"));
  const action = String(command.action || "");
  if (action !== "move" && action !== "down" && action !== "up" && action !== "click" && action !== "hold" && action !== "surface" && action !== "restore") {
    return { ok: false, error: "action must be move, down, up, click, hold, surface, or restore" };
  }
  const x = Number(command.x);
  const y = Number(command.y);
  if (action !== "surface" && action !== "restore" && (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0)) {
    return { ok: false, error: "x and y must be non-negative numbers" };
  }
  const requestId = typeof command.requestId === "string" && command.requestId.trim()
    ? command.requestId.trim().slice(0, 80)
    : undefined;
  if (requestId) {
    if (!requestIsInProgress(requestId)) {
      return { ok: false, error: "sidecar screen is no longer active; start a fresh search or click the current flashing screen" };
    }
  }
  const queued: SidecarScreenControlCommand = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    slot,
    requestId,
    action,
    x: Number.isFinite(x) ? Math.round(x) : 0,
    y: Number.isFinite(y) ? Math.round(y) : 0,
    durationMs: action === "hold"
      ? Math.max(1_000, Math.min(15_000, Math.round(Number((command as { durationMs?: unknown }).durationMs) || 8_000)))
      : undefined,
    at: new Date().toISOString(),
  };
  const existing = sidecarScreenCommands.get(slot) ?? [];
  existing.push(queued);
  sidecarScreenCommands.set(slot, existing.slice(-80));
  return { ok: true, command: queued };
}

export function takeSidecarScreenControlCommands(slotRaw: unknown, requestIdRaw?: unknown): SidecarScreenControlCommand[] {
  cleanupSidecarScreenCommands();
  const slot = screenCommandKey(String(slotRaw || "1"));
  const requestId = typeof requestIdRaw === "string" && requestIdRaw.trim()
    ? requestIdRaw.trim().slice(0, 80)
    : undefined;
  const commands = sidecarScreenCommands.get(slot) ?? [];
  if (!commands.length) return [];
  const take: SidecarScreenControlCommand[] = [];
  const keep: SidecarScreenControlCommand[] = [];
  for (const command of commands) {
    if (!requestId || !command.requestId || command.requestId === requestId) take.push(command);
    else keep.push(command);
  }
  if (keep.length) sidecarScreenCommands.set(slot, keep);
  else sidecarScreenCommands.delete(slot);
  return take;
}

function cleanup(): void {
  const now = nowMs();
  for (const [key, cached] of Array.from(successfulResultCache.entries())) {
    if (SUCCESS_RESULT_CACHE_TTL_MS <= 0 || now - cached.cachedAt > SUCCESS_RESULT_CACHE_TTL_MS) {
      successfulResultCache.delete(key);
    }
  }
  for (const [id, r] of queue) {
    if (r.status === "pending" && now - r.createdAt > PENDING_TTL_MS) {
      r.status = "failed";
      r.error = "expired waiting for worker";
      r.completedAt = now;
    }
    if (
      r.status === "in_progress" &&
      r.claimedAt &&
      now - r.claimedAt > IN_PROGRESS_RECLAIM_MS
    ) {
      r.status = "pending";
      r.claimedAt = undefined;
      r.claimedBy = undefined;
    }
    if (
      (r.status === "completed" || r.status === "failed") &&
      r.completedAt &&
      now - r.completedAt > TERMINAL_TTL_MS
    ) {
      queue.delete(id);
      requestKeyIndex.delete(r.requestKey);
    }
  }
  for (const [slot, snapshot] of sidecarScreens) {
    const at = Date.parse(snapshot.at);
    if (!Number.isFinite(at) || now - at > SIDECAR_SCREEN_TTL_MS) {
      sidecarScreens.delete(slot);
    }
  }
}

function cloneSidecarResult<T>(value: T): T {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function canCacheSuccessfulResult(r: SidecarRequest): boolean {
  if (SUCCESS_RESULT_CACHE_TTL_MS <= 0) return false;
  if (!isOtaBrowserOp(r.opType)) return false;
  if (!Array.isArray(r.results)) return false;
  // Empty result sets are sometimes legitimate, but they can also come from a
  // transient provider UI miss. Cache only priced, useful result sets.
  return r.results.some((candidate) => {
    const c = candidate as Partial<SidecarPropertyCandidate>;
    return Number(c.totalPrice ?? 0) > 0 || Number(c.nightlyPrice ?? 0) > 0;
  });
}

function cacheSuccessfulResult(r: SidecarRequest): void {
  if (!canCacheSuccessfulResult(r)) return;
  successfulResultCache.set(r.requestKey, {
    results: cloneSidecarResult(r.results),
    searchVariationSummary: cloneSidecarResult(r.searchVariationSummary),
    mapHarvest: cloneSidecarResult(r.mapHarvest ?? null),
    cachedAt: nowMs(),
  });
}

function cachedSuccessfulResult(requestKey: string): CachedSidecarResult | null {
  cleanup();
  const cached = successfulResultCache.get(requestKey);
  if (!cached) return null;
  if (SUCCESS_RESULT_CACHE_TTL_MS <= 0 || nowMs() - cached.cachedAt > SUCCESS_RESULT_CACHE_TTL_MS) {
    successfulResultCache.delete(requestKey);
    return null;
  }
  return {
    results: cloneSidecarResult(cached.results),
    searchVariationSummary: cloneSidecarResult(cached.searchVariationSummary),
    mapHarvest: cloneSidecarResult(cached.mapHarvest ?? null),
    cachedAt: cached.cachedAt,
  };
}

// Build a stable, opType-aware dedup key. Two enqueues with the same
// op type AND same canonical params get folded into one request.
function makeRequestKey(
  opType: SidecarOpType,
  params: SidecarRequest["params"],
): string {
  switch (opType) {
    case "airbnb_search": {
      const p = params as SidecarAirbnbParams;
      return `${opType}|${(p.searchTerm || p.destination).toLowerCase().trim()}|${p.destination.toLowerCase().trim()}|${p.checkIn}|${p.checkOut}|${p.bedrooms}`;
    }
    case "booking_search": {
      const p = params as SidecarBookingParams;
      const mode = p.searchMode === "map_bounds" ? "map_bounds" : "destination_dropdown";
      const boundsKey = p.mapSearch?.bounds
        ? [
            p.mapSearch.bounds.sw_lat,
            p.mapSearch.bounds.sw_lng,
            p.mapSearch.bounds.ne_lat,
            p.mapSearch.bounds.ne_lng,
          ].map((n) => Number(n).toFixed(5)).join(",")
        : "no-bounds";
      return `${opType}|${mode}|${boundsKey}|${(p.searchTerm || p.destination).toLowerCase().trim()}|${p.destination.toLowerCase().trim()}|${p.checkIn}|${p.checkOut}|${p.bedrooms}`;
    }
    case "vrbo_search": {
      const p = params as SidecarVrboParams;
      // VRBO searches intentionally fetch the full resort/date result
      // set and let the server-side curation apply bedroom rules. One
      // browser run can therefore satisfy the 3BR, 4BR, etc. passes for
      // the same booking. Keeping bedroom count out of the dedupe key
      // reduces repeat VRBO page loads and lowers block/CAPTCHA pressure
      // without bypassing provider controls.
      const mode = p.searchMode === "map_bounds" ? "map_bounds" : "destination_dropdown";
      const boundsKey = p.mapSearch?.bounds
        ? [
            p.mapSearch.bounds.sw_lat,
            p.mapSearch.bounds.sw_lng,
            p.mapSearch.bounds.ne_lat,
            p.mapSearch.bounds.ne_lng,
          ].map((n) => Number(n).toFixed(5)).join(",")
        : "no-bounds";
      return `${opType}|${mode}|${boundsKey}|${(p.searchTerm || p.destination).toLowerCase().trim()}|${p.destination.toLowerCase().trim()}|${p.checkIn}|${p.checkOut}|all-bedrooms`;
    }
    case "vrbo_photo_scrape": {
      const p = params as SidecarVrboPhotoScrapeParams;
      return `vrbo_photo_scrape|${p.url}|${p.maxPhotos ?? 40}`;
    }
    case "zillow_photo_scrape": {
      const p = params as SidecarZillowPhotoScrapeParams;
      return `zillow_photo_scrape|${p.url}|${p.maxPhotos ?? 40}`;
    }
    case "google_serp": {
      const p = params as SidecarGoogleSerpParams;
      return `google_serp|${p.query.toLowerCase().trim()}|${p.maxResults ?? 20}`;
    }
    case "pm_site_search": {
      const p = params as SidecarPmSiteSearchParams;
      const sites = p.sites
        .map((s) => `${s.label}:${s.searchUrl || s.baseUrl}`)
        .sort()
        .join(",");
      return `pm_site_search|${sites}|${p.searchTerm.toLowerCase().trim()}|${p.checkIn}|${p.checkOut}|${p.bedrooms}|${p.perSiteLimit ?? 6}|${p.maxSites ?? "all"}`;
    }
    case "pm_url_check": {
      const p = params as SidecarPmUrlCheckParams;
      return `pm_url_check|${p.url}|${p.checkIn}|${p.checkOut}|${p.bedrooms ?? "any"}`;
    }
    case "pm_url_check_batch": {
      const p = params as SidecarPmUrlCheckBatchParams;
      const sortedUrls = [...p.urls].sort().join(",");
      return `pm_url_check_batch|${sortedUrls}|${p.checkIn}|${p.checkOut}|${p.bedrooms ?? "any"}`;
    }
    case "vrbo_upload_photos":
    case "booking_upload_photos": {
      const p = params as SidecarPhotoUploadParams;
      // Dedup on the listing ref + the SET of photo URLs (sorted),
      // not their order — re-enqueueing the same upload within the
      // dedup TTL collapses to one request. Caption changes alone
      // still dedup; the operator can re-trigger with different
      // photos to invalidate.
      const sortedUrls = [...p.photos.map((ph) => ph.url)].sort().join(",");
      return `${opType}|${p.partnerListingRef}|${sortedUrls}`;
    }
    case "guesty_disconnect_channel": {
      const p = params as SidecarGuestyDisconnectParams;
      return `guesty_disconnect_channel|${p.guestyListingId}|${p.channel}`;
    }
  }
}

function makeId(): string {
  return Array.from({ length: 12 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("");
}

/**
 * Generic enqueue. The discriminated `req` parameter ensures op-type
 * and params shape match.
 *
 * Dedup: same op + canonical params within TTL returns the existing
 * id (whether the prior is pending, in-progress, or recently
 * completed).
 */
export function enqueueOp(
  req:
    | { opType: "airbnb_search"; params: SidecarAirbnbParams }
    | { opType: "vrbo_search"; params: SidecarVrboParams }
    | { opType: "vrbo_photo_scrape"; params: SidecarVrboPhotoScrapeParams }
    | { opType: "zillow_photo_scrape"; params: SidecarZillowPhotoScrapeParams }
    | { opType: "booking_search"; params: SidecarBookingParams }
    | { opType: "google_serp"; params: SidecarGoogleSerpParams }
    | { opType: "pm_site_search"; params: SidecarPmSiteSearchParams }
    | { opType: "pm_url_check"; params: SidecarPmUrlCheckParams }
    | { opType: "pm_url_check_batch"; params: SidecarPmUrlCheckBatchParams }
    | { opType: "vrbo_upload_photos"; params: SidecarPhotoUploadParams }
    | { opType: "booking_upload_photos"; params: SidecarPhotoUploadParams }
    | { opType: "guesty_disconnect_channel"; params: SidecarGuestyDisconnectParams }
    | { opType: "vrbo_book"; params: SidecarVrboBookParams },
): { id: string; deduped: boolean } {
  cleanup();
  if (queuePaused) {
    const reason = queuePausedReason ? `: ${queuePausedReason}` : "";
    throw new Error(`Sidecar queue is stopped${reason}`);
  }
  const requestKey = makeRequestKey(req.opType, req.params);
  const queueContext = (req.params as { queueContext?: SidecarQueueContext } | undefined)?.queueContext;
  if (!queueContext?.forceFresh) {
    const existingId = requestKeyIndex.get(requestKey);
    if (existingId) {
      const existing = queue.get(existingId);
      if (existing) {
        const isFresh =
          existing.status === "pending" ||
          existing.status === "paused" ||
          existing.status === "in_progress" ||
          (existing.status === "completed" && existing.completedAt && nowMs() - existing.completedAt < 60 * 1000);
        if (isFresh) {
          console.log(
            `[vrbo-sidecar-queue] deduped ${req.opType} request onto ${existingId} (${existing.status}, age=${Math.round((nowMs() - existing.createdAt) / 1000)}s)`,
          );
          return { id: existingId, deduped: true };
        }
      } else {
        requestKeyIndex.delete(requestKey);
      }
    }
  }
  const id = makeId();
  const queueReq: SidecarRequest = {
    id,
    status: "pending",
    opType: req.opType,
    params: req.params,
    requestKey,
    createdAt: nowMs(),
  };
  queue.set(id, queueReq);
  requestKeyIndex.set(requestKey, id);
  return { id, deduped: false };
}

// Backward-compat: VRBO-only enqueue kept for callers that haven't
// been updated. Internally just delegates to enqueueOp.
export function enqueue(opts: SidecarVrboParams): {
  id: string;
  deduped: boolean;
} {
  return enqueueOp({ opType: "vrbo_search", params: opts });
}

/**
 * Worker pulls the oldest pending request and marks it in_progress.
 * Returns null when the queue has nothing for the worker to do.
 *
 * Side effect: stamps `lastWorkerPollAt` for the heartbeat surface.
 * Even an empty-queue poll counts as a heartbeat — the worker is
 * alive, just no work right now.
 */
export function next(runtime?: Partial<SidecarWorkerRuntime> | null): SidecarRequest | null {
  cleanup();
  const normalizedRuntime = normalizeWorkerRuntime(runtime);
  stampHeartbeat(undefined, undefined, normalizedRuntime);
  // CODEX NOTE (2026-05-04, claude/sidecar-stop-start): paused
  // queue returns null even when pending work exists. The worker
  // keeps polling (heartbeat stays green so the operator sees
  // it's still alive) but no work gets dispatched until resume.
  if (queuePaused) return null;
  let oldest: SidecarRequest | null = null;
  for (const r of queue.values()) {
    if (r.status !== "pending") continue;
    if (!canClaimOp(r, normalizedRuntime)) continue;
    if (!oldest || r.createdAt < oldest.createdAt) oldest = r;
  }
  if (!oldest) return null;
  oldest.status = "in_progress";
  oldest.claimedAt = nowMs();
  oldest.claimedBy = normalizedRuntime?.source;
  return oldest;
}

// CODEX NOTE (2026-05-04, claude/sidecar-stop-start): operator
// pause/resume controls. Pause does NOT cancel active or pending
// work — the operator usually wants to also call
// cancelActiveAndPendingRequests() to stop existing jobs in
// flight. The two are kept separate so `pauseQueue()` is safe
// to call without losing in-progress work, and the API endpoint
// can compose both behaviors for the "Stop" button.
export function pauseQueue(reason: string = "paused by operator"): {
  alreadyPaused: boolean;
} {
  // Stop is also a producer-level cancellation boundary. A long
  // background market/availability scan that began before this stop
  // must not resume enqueueing browser work after the operator clicks
  // Start Queue again.
  queueStopGeneration++;
  if (queuePaused) {
    queuePausedReason = reason.slice(0, 200);
    if (!queuePausedAt) queuePausedAt = nowMs();
    return { alreadyPaused: true };
  }
  queuePaused = true;
  queuePausedAt = nowMs();
  queuePausedReason = reason.slice(0, 200);
  return { alreadyPaused: false };
}

export function resumeQueue(): { wasResumed: boolean } {
  if (!queuePaused) return { wasResumed: false };
  queuePaused = false;
  queuePausedAt = null;
  queuePausedReason = null;
  return { wasResumed: true };
}

export function isQueuePaused(): {
  paused: boolean;
  pausedAt: string | null;
  pausedAgeMs: number | null;
  reason: string | null;
} {
  if (!queuePaused) {
    return { paused: false, pausedAt: null, pausedAgeMs: null, reason: null };
  }
  const at = queuePausedAt ?? nowMs();
  return {
    paused: true,
    pausedAt: new Date(at).toISOString(),
    pausedAgeMs: nowMs() - at,
    reason: queuePausedReason,
  };
}

/**
 * Worker reports completion. Either `results` (success) or `error`
 * (failure) must be provided.
 */
export function complete(opts: {
  id: string;
  results?: unknown;
  error?: string;
}): { ok: boolean; reason?: string } {
  const r = queue.get(opts.id);
  if (!r) return { ok: false, reason: "request not found (already expired?)" };
  if (r.status === "completed" || r.status === "failed") {
    return { ok: false, reason: `request already in terminal state ${r.status}` };
  }
  if (opts.results !== undefined) {
    const normalized = normalizeWorkerResultsPayload(opts.results);
    r.status = "completed";
    r.results = normalized.results;
    r.searchVariationSummary = recordSearchVariationSummary(r, normalized.variationsTried);
    r.mapHarvest = normalized.mapHarvest;
    cacheSuccessfulResult(r);
  } else {
    r.status = "failed";
    r.error = opts.error || "worker reported failure with no message";
  }
  r.completedAt = nowMs();
  return { ok: true };
}

function cancelRequest(id: string, reason: string): void {
  const r = queue.get(id);
  if (!r || r.status === "completed" || r.status === "failed") return;
  r.status = "failed";
  r.error = reason;
  r.cancelled = true;
  r.completedAt = nowMs();
}

export function cancelSidecarRequest(id: string, reason = "cancelled by operator"): {
  ok: boolean;
  request?: SidecarStatusRequest;
  error?: string;
} {
  cleanup();
  const r = queue.get(id);
  if (!r) return { ok: false, error: "request not found" };
  if (r.status === "completed" || r.status === "failed") {
    return { ok: false, error: `request is already ${r.status}` };
  }
  cancelRequest(id, reason);
  const updated = queue.get(id);
  return { ok: true, request: updated ? describeSidecarRequest(updated) : undefined };
}

export function pauseSidecarRequest(id: string, reason = "paused by operator"): {
  ok: boolean;
  request?: SidecarStatusRequest;
  error?: string;
} {
  cleanup();
  const r = queue.get(id);
  if (!r) return { ok: false, error: "request not found" };
  if (r.status === "paused") return { ok: true, request: describeSidecarRequest(r) };
  if (r.status !== "pending") {
    return { ok: false, error: r.status === "in_progress" ? "active scans can be cancelled, not paused" : `request is already ${r.status}` };
  }
  r.status = "paused";
  r.pausedReason = reason.slice(0, 200);
  r.pausedAt = nowMs();
  return { ok: true, request: describeSidecarRequest(r) };
}

export function resumeSidecarRequest(id: string): {
  ok: boolean;
  request?: SidecarStatusRequest;
  error?: string;
} {
  cleanup();
  const r = queue.get(id);
  if (!r) return { ok: false, error: "request not found" };
  if (r.status !== "paused") return { ok: false, error: `request is ${r.status}, not paused` };
  r.status = "pending";
  r.pausedReason = undefined;
  r.pausedAt = undefined;
  return { ok: true, request: describeSidecarRequest(r) };
}

export function cancelActiveAndPendingRequests(reason = "cancelled by operator"): {
  cancelled: number;
  pending: number;
  paused: number;
  inProgress: number;
} {
  cleanup();
  let cancelled = 0;
  let pending = 0;
  let paused = 0;
  let inProgress = 0;
  for (const r of queue.values()) {
    if (r.status !== "pending" && r.status !== "paused" && r.status !== "in_progress") continue;
    if (r.status === "pending") pending++;
    if (r.status === "paused") paused++;
    if (r.status === "in_progress") inProgress++;
    cancelRequest(r.id, reason);
    cancelled++;
  }
  return { cancelled, pending, paused, inProgress };
}

export function cancelSidecarRunAndRequests(reason = "cancelled by operator"): {
  cancelled: number;
  pending: number;
  paused: number;
  inProgress: number;
  stopGeneration: number;
} {
  // Request-level cancellation stops what is already queued. The stop
  // generation also tells long-running producers that captured the old
  // generation to stop enqueueing follow-up browser work.
  queueStopGeneration++;
  return {
    ...cancelActiveAndPendingRequests(reason),
    stopGeneration: queueStopGeneration,
  };
}

export function clearSidecarQueue(reason = "sidecar queue cleared by operator"): {
  cleared: number;
  cancelled: number;
  pending: number;
  paused: number;
  inProgress: number;
  completed: number;
  failed: number;
  stopGeneration: number;
} {
  cleanup();
  queueStopGeneration++;
  let pending = 0;
  let paused = 0;
  let inProgress = 0;
  let completed = 0;
  let failed = 0;
  for (const r of queue.values()) {
    if (r.status === "pending") pending++;
    else if (r.status === "paused") paused++;
    else if (r.status === "in_progress") inProgress++;
    else if (r.status === "completed") completed++;
    else if (r.status === "failed") failed++;
  }
  const cancelled = pending + paused + inProgress;
  const cleared = queue.size;
  queue.clear();
  requestKeyIndex.clear();
  successfulResultCache.clear();
  sidecarScreens.clear();
  sidecarScreenCommands.clear();
  return {
    cleared,
    cancelled,
    pending,
    paused,
    inProgress,
    completed,
    failed,
    stopGeneration: queueStopGeneration,
  };
}

export function isCancellationRequested(id: string): boolean {
  const r = queue.get(id);
  if (!r) return true;
  if (r.status === "completed") return false;
  return r.status !== "in_progress" || Boolean(r.cancelled);
}

export function getResult(id: string): SidecarRequest | null {
  cleanup();
  return queue.get(id) ?? null;
}

function describeSidecarRequest(r: SidecarRequest): SidecarStatusRequest {
  const now = nowMs();
  const ageSec = Math.max(0, Math.round((now - r.createdAt) / 1000));
  const activeSec = r.claimedAt ? Math.max(0, Math.round((now - r.claimedAt) / 1000)) : undefined;
  const pausedAgeSec = r.pausedAt ? Math.max(0, Math.round((now - r.pausedAt) / 1000)) : undefined;
  const p = r.params as Partial<
    SidecarAirbnbParams
    & SidecarVrboParams
    & SidecarBookingParams
    & SidecarPmSiteSearchParams
    & SidecarPmUrlCheckParams
    & SidecarPmUrlCheckBatchParams
    & SidecarVrboPhotoScrapeParams
    & SidecarPhotoUploadParams
    & SidecarGuestyDisconnectParams
  >;
  const bedrooms = typeof p.bedrooms === "number" && Number.isFinite(p.bedrooms) ? p.bedrooms : undefined;
  const destination = typeof p.searchTerm === "string" && p.searchTerm.trim()
    ? p.searchTerm.trim().slice(0, 80)
    : typeof p.destination === "string"
      ? p.destination.trim().slice(0, 80)
      : undefined;
  const siteCount = Array.isArray((p as SidecarPmSiteSearchParams).sites)
    ? (p as SidecarPmSiteSearchParams).sites.length
    : Array.isArray((p as SidecarPmUrlCheckBatchParams).urls)
      ? (p as SidecarPmUrlCheckBatchParams).urls.length
      : undefined;
  const br = bedrooms ? ` ${bedrooms}BR` : "";
  const providerLabel = (() => {
    switch (r.opType) {
      case "airbnb_search": return "Airbnb";
      case "vrbo_search": return "VRBO";
      case "booking_search": return "Booking.com";
      case "pm_site_search": return "PM websites";
      case "pm_url_check_batch":
      case "pm_url_check": return "PM";
      case "google_serp": return "Google";
      case "vrbo_photo_scrape":
      case "vrbo_upload_photos":
      case "vrbo_book": return "VRBO";
      case "booking_upload_photos": return "Booking.com";
      case "zillow_photo_scrape": return "Zillow";
      case "guesty_disconnect_channel": return "Guesty";
      default: return r.opType;
    }
  })();
  const label = (() => {
    switch (r.opType) {
      case "airbnb_search": return `Airbnb${br} search`;
      case "vrbo_search": return `VRBO${br} search`;
      case "booking_search": return `Booking.com${br} search`;
      case "pm_site_search": return `PM websites${br}${siteCount ? ` (${siteCount} sites)` : ""}`;
      case "pm_url_check_batch": return `PM rate checks${siteCount ? ` (${siteCount} pages)` : ""}`;
      case "pm_url_check": return "PM rate check";
      case "google_serp": return "Google discovery";
      case "vrbo_book": return "VRBO booking";
      case "vrbo_photo_scrape": return "VRBO photo scrape";
      case "zillow_photo_scrape": return "Zillow photo scrape";
      case "vrbo_upload_photos": return "VRBO photo upload";
      case "booking_upload_photos": return "Booking.com photo upload";
      case "guesty_disconnect_channel": return `Guesty ${p.channel ?? ""} disconnect`.trim();
      default: return r.opType;
    }
  })();
  const queueContext = (p as Partial<SidecarAirbnbParams & SidecarVrboParams & SidecarBookingParams>).queueContext;
  const listingTitle = String(queueContext?.listingTitle ?? "").trim() || undefined;
  const formatYmd = (ymd: unknown): string | null => {
    if (typeof ymd !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
    const [yearRaw, monthRaw, dayRaw] = ymd.split("-");
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    const day = Number(dayRaw);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
    const monthName = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month - 1];
    return monthName ? `${monthName} ${day}, ${year}` : ymd;
  };
  const dateLabel = queueContext?.dateLabel || (() => {
    const start = formatYmd(p.checkIn);
    const end = formatYmd(p.checkOut);
    if (!start || !end) return undefined;
    const [startMonth, startDay, startYear] = start.replace(",", "").split(" ");
    const [endMonth, endDay, endYear] = end.replace(",", "").split(" ");
    if (startYear === endYear && startMonth === endMonth) return `${startMonth} ${startDay}-${endDay}, ${startYear}`;
    if (startYear === endYear) return `${startMonth} ${startDay}-${endMonth} ${endDay}, ${startYear}`;
    return `${start}-${end}`;
  })();
  const unitLabel = queueContext?.unitLabel || (bedrooms ? `${bedrooms}BR unit` : undefined);
  const summary = queueContext?.scanLabel || [
    destination,
    unitLabel ? `${unitLabel} scan` : label,
  ].filter(Boolean).join(" · ") || label;
  const detail = queueContext?.detail || [
    providerLabel ? `${providerLabel}${unitLabel ? `: scanning ${unitLabel}` : ""}` : label,
    dateLabel,
    destination ? `location ${destination}` : "",
  ].filter(Boolean).join(" · ");
  return {
    id: r.id,
    status: r.status,
    opType: r.opType,
    label,
    summary,
    detail,
    providerLabel: queueContext?.providerLabel || providerLabel,
    unitLabel,
    dateLabel,
    listingTitle,
    stage: r.stage,
    pausedReason: r.pausedReason,
    pausedAgeSec,
    bedrooms,
    destination,
    siteCount,
    ageSec,
    activeSec,
  };
}

export function getStatus(): {
  total: number;
  pending: number;
  paused: number;
  inProgress: number;
  completed: number;
  failed: number;
  oldestPendingAgeSec: number | null;
  newestRequestAt: string | null;
  byOpType: Record<SidecarOpType, number>;
  activeRequests: SidecarStatusRequest[];
  pendingRequests: SidecarStatusRequest[];
  pausedRequests: SidecarStatusRequest[];
  providerHealth: SidecarProviderHealth[];
  searchVariations: SidecarSearchVariationSummary[];
} {
  cleanup();
  let pending = 0,
    paused = 0,
    inProgress = 0,
    completed = 0,
    failed = 0;
  let oldestPendingAge: number | null = null;
  let newestAt = 0;
  const byOpType: Record<SidecarOpType, number> = {
    airbnb_search: 0,
    vrbo_search: 0,
    vrbo_photo_scrape: 0,
    zillow_photo_scrape: 0,
    booking_search: 0,
    google_serp: 0,
    pm_site_search: 0,
    pm_url_check: 0,
    pm_url_check_batch: 0,
    vrbo_upload_photos: 0,
    booking_upload_photos: 0,
    guesty_disconnect_channel: 0,
    vrbo_book: 0,
  };
  const activeRequests: SidecarStatusRequest[] = [];
  const pendingRequests: SidecarStatusRequest[] = [];
  const pausedRequests: SidecarStatusRequest[] = [];
  const now = nowMs();
  for (const r of queue.values()) {
    if (r.status === "pending") {
      pending++;
      const age = (now - r.createdAt) / 1000;
      if (oldestPendingAge === null || age > oldestPendingAge)
        oldestPendingAge = age;
    }
    if (r.status === "in_progress") {
      inProgress++;
      activeRequests.push(describeSidecarRequest(r));
    }
    if (r.status === "pending") {
      pendingRequests.push(describeSidecarRequest(r));
    }
    if (r.status === "paused") {
      paused++;
      pausedRequests.push(describeSidecarRequest(r));
    }
    if (r.status === "completed") completed++;
    if (r.status === "failed") failed++;
    if (r.createdAt > newestAt) newestAt = r.createdAt;
    byOpType[r.opType as SidecarOpType]++;
  }
  return {
    total: queue.size,
    pending,
    paused,
    inProgress,
    completed,
    failed,
    oldestPendingAgeSec: oldestPendingAge,
    newestRequestAt: newestAt > 0 ? new Date(newestAt).toISOString() : null,
    byOpType,
    activeRequests: activeRequests.sort((a, b) => (b.activeSec ?? 0) - (a.activeSec ?? 0)).slice(0, 5),
    pendingRequests: pendingRequests.sort((a, b) => b.ageSec - a.ageSec).slice(0, 8),
    pausedRequests: pausedRequests.sort((a, b) => b.ageSec - a.ageSec).slice(0, 8),
    providerHealth: getProviderHealth(),
    searchVariations: Array.from(searchVariationRuns.values()).slice(-12),
  };
}

export function getHeartbeat(): {
  isOnline: boolean;
  everSeen: boolean;
  lastWorkerPollAt: string | null;
  ageMs: number | null;
  onlineWindowMs: number;
  maxConcurrency: number;
  // CODEX NOTE (2026-05-04, claude/sidecar-stop-start): added paused
  // + activeJob to the heartbeat so the status badge can render
  // three states (online/offline/paused) and surface what op is
  // currently running with how long it's been running.
  paused: boolean;
  pausedAt: string | null;
  pausedAgeMs: number | null;
  pausedReason: string | null;
  activeJob: {
    id: string;
    label: string;
    opType: SidecarOpType;
    stage?: string;
    activeSec: number;
  } | null;
  workerRuntime: SidecarWorkerRuntime | null;
  localWorkerRuntime: SidecarWorkerRuntime | null;
  serverWorkerRuntime: SidecarWorkerRuntime | null;
  localWorkerAgeMs: number | null;
  serverWorkerAgeMs: number | null;
} {
  const pausedState = isQueuePaused();
  // Inline-find the in-progress request without paying for a full
  // getStatus() walk — heartbeat is polled every 5-30s by the UI.
  let activeJob: ReturnType<typeof getHeartbeat>["activeJob"] = null;
  const now = nowMs();
  for (const r of queue.values()) {
    if (r.status !== "in_progress") continue;
    const activeSec = r.claimedAt ? Math.max(0, Math.round((now - r.claimedAt) / 1000)) : 0;
    if (!activeJob || activeSec > activeJob.activeSec) {
      activeJob = {
        id: r.id,
        label: labelForOpType(r.opType),
        opType: r.opType as SidecarOpType,
        stage: r.stage,
        activeSec,
      };
    }
  }
  if (lastWorkerPollAt === null) {
    return {
      isOnline: false,
      everSeen: false,
      lastWorkerPollAt: null,
      ageMs: null,
      onlineWindowMs: HEARTBEAT_ONLINE_WINDOW_MS,
      maxConcurrency: 8,
      paused: pausedState.paused,
      pausedAt: pausedState.pausedAt,
      pausedAgeMs: pausedState.pausedAgeMs,
      pausedReason: pausedState.reason,
      activeJob,
      workerRuntime: lastWorkerRuntime,
      localWorkerRuntime: lastLocalWorkerRuntime,
      serverWorkerRuntime: lastServerWorkerRuntime,
      localWorkerAgeMs: null,
      serverWorkerAgeMs: null,
    };
  }
  const ageMs = nowMs() - lastWorkerPollAt;
  const localWorkerAgeMs = lastLocalWorkerPollAt === null ? null : nowMs() - lastLocalWorkerPollAt;
  const serverWorkerAgeMs = lastServerWorkerPollAt === null ? null : nowMs() - lastServerWorkerPollAt;
  const preferredRuntime =
    localWorkerAgeMs !== null && localWorkerAgeMs < HEARTBEAT_ONLINE_WINDOW_MS
      ? lastLocalWorkerRuntime
      : lastWorkerRuntime;
  return {
    isOnline: ageMs < HEARTBEAT_ONLINE_WINDOW_MS,
    everSeen: true,
    lastWorkerPollAt: new Date(lastWorkerPollAt).toISOString(),
    ageMs,
    onlineWindowMs: HEARTBEAT_ONLINE_WINDOW_MS,
    maxConcurrency: 8,
    paused: pausedState.paused,
    pausedAt: pausedState.pausedAt,
    pausedAgeMs: pausedState.pausedAgeMs,
    pausedReason: pausedState.reason,
    activeJob,
    workerRuntime: preferredRuntime,
    localWorkerRuntime: lastLocalWorkerRuntime,
    serverWorkerRuntime: lastServerWorkerRuntime,
    localWorkerAgeMs,
    serverWorkerAgeMs,
  };
}

// Compact label for an op-type — mirrors the longer form in
// getStatus().describeRequest but without per-request params.
function labelForOpType(opType: string): string {
  switch (opType) {
    case "airbnb_search": return "Airbnb search";
    case "vrbo_search": return "VRBO search";
    case "booking_search": return "Booking.com search";
    case "pm_site_search": return "PM website search";
    case "pm_url_check_batch": return "PM rate checks";
    case "pm_url_check": return "PM rate check";
    case "google_serp": return "Google discovery";
    case "vrbo_book": return "VRBO booking";
    case "vrbo_photo_scrape": return "VRBO photo scrape";
    case "zillow_photo_scrape": return "Zillow photo scrape";
    case "vrbo_upload_photos": return "VRBO photo upload";
    case "booking_upload_photos": return "Booking.com photo upload";
    case "guesty_disconnect_channel": return "Guesty disconnect";
    default: return opType;
  }
}

/**
 * Convenience: enqueue a VRBO search, poll for result, return cards
 * (or null on timeout/failure). Used by find-buy-in's path 9.
 *
 * Generic equivalents for the other op types live below.
 */
export async function searchVrboViaSidecar(opts: {
  destination: string;
  searchTerm?: string;
  checkIn: string;
  checkOut: string;
  bedrooms: number;
  searchMode?: SidecarVrboParams["searchMode"];
  mapSearch?: SidecarVrboParams["mapSearch"];
  queueContext?: SidecarQueueContext;
  rerunOnlyUntried?: boolean;
  searchVariations?: string[];
  /** One VRBO map run using only the city/market search term (no resort sub-name variations). */
  cityWideInventory?: boolean;
  pollIntervalMs?: number;
  walletBudgetMs?: number;
  queueBudgetMs?: number;
  signal?: AbortSignal;
  stopGeneration?: number;
}): Promise<{
  candidates: SidecarPropertyCandidate[];
  workerOnline: boolean;
  durationMs: number;
  reason: string;
  providerHealth?: SidecarProviderHealth;
  searchVariationSummary?: SidecarSearchVariationSummary;
  mapHarvest?: SidecarMapHarvestStats | null;
} | null> {
  const cooldown = activeProviderCooldown("vrbo");
  if (cooldown) return providerCooldownSearchResult("vrbo");
  const vrboWalletMs = Math.max(
    opts.walletBudgetMs ?? 0,
    numberFromEnv("SIDECAR_VRBO_SEARCH_WALLET_BUDGET_MS", 6 * 60 * 1000),
  );
  const vrboQueueBudgetMs = Math.max(
    opts.queueBudgetMs ?? 0,
    numberFromEnv("SIDECAR_VRBO_SEARCH_QUEUE_BUDGET_MS", vrboWalletMs + 60_000),
  );
  const location = parseSearchLocation(opts);
  const singleCityTerm = cleanText(opts.searchTerm || opts.destination);
  const policy = opts.cityWideInventory
    ? {
        communityKey: `city-wide|${singleCityTerm.toLowerCase()}`,
        generatedTerms: [singleCityTerm],
        preferredTerms: [] as string[],
        terms: singleCityTerm ? [singleCityTerm] : [],
        filterTokens: [] as string[],
        maxVariations: 1,
        allowDiscovery: false,
      }
    : await buildSearchVariationPolicy({
        provider: "vrbo",
        community: location.communityName,
        city: location.city,
        state: location.state,
        checkIn: opts.checkIn,
        checkOut: opts.checkOut,
        bedrooms: opts.bedrooms,
        rerunOnlyUntried: opts.rerunOnlyUntried,
        explicitTerms: opts.searchVariations,
      });
  const r = await awaitOpResult({
    enqueueArgs: {
      opType: "vrbo_search",
      params: {
        destination: opts.destination,
        searchTerm: opts.searchTerm,
        checkIn: opts.checkIn,
        checkOut: opts.checkOut,
        bedrooms: opts.bedrooms,
        searchMode: opts.searchMode,
        mapSearch: opts.mapSearch,
        searchVariations: policy.terms,
        queueContext: opts.queueContext,
        cityWideInventory: Boolean(opts.cityWideInventory),
        // Thread the property's expected state (full lowercase name) so the daemon
        // guard accepts a same-state resolution (e.g. a Florida property → Florida)
        // instead of dropping it as a mainland namesake. Derived from the parsed
        // search location; "hawaii"/undefined keeps the legacy reject-all behavior.
        expectedState: fullStateNameLower(location.state),
        variationMode: {
          filterTokens: policy.filterTokens,
          maxVariations: policy.maxVariations,
          allowDiscovery: policy.allowDiscovery,
          rerunOnlyUntried: Boolean(opts.rerunOnlyUntried),
        },
      },
    },
    pollIntervalMs: opts.pollIntervalMs,
    walletBudgetMs: vrboWalletMs,
    queueBudgetMs: vrboQueueBudgetMs,
    signal: opts.signal,
    stopGeneration: opts.stopGeneration,
  });
  const result = {
    candidates: (r.results ?? []) as SidecarPropertyCandidate[],
    workerOnline: r.workerOnline,
    durationMs: r.durationMs,
    reason: r.reason,
  };
  return {
    ...result,
    providerHealth: recordProviderOutcome("vrbo", result),
    searchVariationSummary: r.searchVariationSummary,
    mapHarvest: r.mapHarvest ?? null,
  };
}

export async function scrapeVrboPhotosViaSidecar(opts: {
  url: string;
  maxPhotos?: number;
  pollIntervalMs?: number;
  walletBudgetMs?: number;
  signal?: AbortSignal;
  stopGeneration?: number;
}): Promise<{
  photos: string[];
  bedText: string;
  sleeps: number | null;
  lat: number | null;
  lng: number | null;
  complexName: string | null;
  streetAddress: string | null;
  workerOnline: boolean;
  durationMs: number;
  reason: string;
}> {
  if (!opts.url || !/^https?:\/\//.test(opts.url)) {
    return {
      photos: [],
      bedText: "",
      sleeps: null,
      lat: null,
      lng: null,
      complexName: null,
      streetAddress: null,
      workerOnline: false,
      durationMs: 0,
      reason: "valid url required",
    };
  }
  const r = await awaitOpResult({
    enqueueArgs: {
      opType: "vrbo_photo_scrape",
      params: { url: opts.url, maxPhotos: opts.maxPhotos ?? 40 },
    },
    pollIntervalMs: opts.pollIntervalMs,
    walletBudgetMs: opts.walletBudgetMs ?? 90_000,
    signal: opts.signal,
    stopGeneration: opts.stopGeneration,
  });
  const scraped = r.results as SidecarVrboPhotoScrapeResult | undefined;
  const sleeps = Number(scraped?.sleeps);
  const lat = Number(scraped?.lat);
  const lng = Number(scraped?.lng);
  return {
    photos: (scraped?.photos ?? []),
    bedText: (scraped?.bedText ?? ""),
    sleeps: Number.isFinite(sleeps) && sleeps > 0 ? sleeps : null,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    complexName: scraped?.complexName ?? null,
    streetAddress: scraped?.streetAddress ?? null,
    workerOnline: r.workerOnline,
    durationMs: r.durationMs,
    reason: r.reason,
  };
}

// CODEX NOTE (2026-05-04, claude/sidecar-zillow-scrape): Zillow
// photo + facts scrape via the operator's home-IP Chrome. Wired
// in as the tertiary fallback inside scrapeListingPhotos when
// Apify+ScrapingBee both return 0 photos. The residential IP
// bypasses Zillow's datacenter anti-bot wall that hits both
// scrapers on bad days. Returns both photos AND extracted facts
// (bedrooms/bathrooms/homeType/etc) so the find-clean-unit's
// HTML-fallback step is short-circuited when the sidecar
// succeeds.
//
// Default wallet 90s — Zillow detail pages are heavier than VRBO
// search-result cards (more JS, more lazy-loaded photos), so the
// daemon needs a bit more headroom. Caller can override.
export async function scrapeZillowPhotosViaSidecar(opts: {
  url: string;
  maxPhotos?: number;
  pollIntervalMs?: number;
  walletBudgetMs?: number;
  signal?: AbortSignal;
  stopGeneration?: number;
}): Promise<{
  photos: string[];
  facts: SidecarZillowPhotoScrapeResult["facts"];
  workerOnline: boolean;
  durationMs: number;
  reason: string;
}> {
  if (!opts.url || !/^https?:\/\/(www\.)?zillow\.com\//i.test(opts.url)) {
    return {
      photos: [],
      facts: undefined,
      workerOnline: false,
      durationMs: 0,
      reason: "valid zillow.com url required",
    };
  }
  const r = await awaitOpResult({
    enqueueArgs: {
      opType: "zillow_photo_scrape",
      params: { url: opts.url, maxPhotos: opts.maxPhotos ?? 40 },
    },
    pollIntervalMs: opts.pollIntervalMs,
    walletBudgetMs: opts.walletBudgetMs ?? 90_000,
    signal: opts.signal,
  });
  const result = r.results as SidecarZillowPhotoScrapeResult | undefined;
  return {
    photos: result?.photos ?? [],
    facts: result?.facts,
    workerOnline: r.workerOnline,
    durationMs: r.durationMs,
    reason: r.reason,
  };
}

export async function searchBookingViaSidecar(opts: {
  destination: string;
  searchTerm?: string;
  checkIn: string;
  checkOut: string;
  bedrooms: number;
  searchMode?: "destination_dropdown" | "map_bounds";
  mapSearch?: SidecarBookingParams["mapSearch"];
  queueContext?: SidecarQueueContext;
  rerunOnlyUntried?: boolean;
  searchVariations?: string[];
  pollIntervalMs?: number;
  walletBudgetMs?: number;
  queueBudgetMs?: number;
  signal?: AbortSignal;
  stopGeneration?: number;
}): Promise<{
  candidates: SidecarPropertyCandidate[];
  workerOnline: boolean;
  durationMs: number;
  reason: string;
  providerHealth?: SidecarProviderHealth;
  searchVariationSummary?: SidecarSearchVariationSummary;
}> {
  const cooldown = activeProviderCooldown("booking");
  if (cooldown) return providerCooldownSearchResult("booking");
  const location = parseSearchLocation(opts);
  const policy = await buildSearchVariationPolicy({
    provider: "booking",
    community: location.communityName,
    city: location.city,
    state: location.state,
    checkIn: opts.checkIn,
    checkOut: opts.checkOut,
    bedrooms: opts.bedrooms,
    rerunOnlyUntried: opts.rerunOnlyUntried,
    explicitTerms: opts.searchVariations,
  });
  const r = await awaitOpResult({
    enqueueArgs: {
      opType: "booking_search",
      params: {
        destination: opts.destination,
        searchTerm: opts.searchTerm,
        checkIn: opts.checkIn,
        checkOut: opts.checkOut,
        bedrooms: opts.bedrooms,
        searchMode: opts.searchMode,
        mapSearch: opts.mapSearch,
        searchVariations: policy.terms,
        queueContext: opts.queueContext,
        variationMode: {
          filterTokens: policy.filterTokens,
          maxVariations: policy.maxVariations,
          allowDiscovery: policy.allowDiscovery,
          rerunOnlyUntried: Boolean(opts.rerunOnlyUntried),
        },
      },
    },
    pollIntervalMs: opts.pollIntervalMs,
    walletBudgetMs: opts.walletBudgetMs,
    queueBudgetMs: opts.queueBudgetMs,
    signal: opts.signal,
    stopGeneration: opts.stopGeneration,
  });
  const result = {
    candidates: (r.results ?? []) as SidecarPropertyCandidate[],
    workerOnline: r.workerOnline,
    durationMs: r.durationMs,
    reason: r.reason,
  };
  return {
    ...result,
    providerHealth: recordProviderOutcome("booking", result),
    searchVariationSummary: r.searchVariationSummary,
  };
}

export async function searchAirbnbViaSidecar(opts: {
  destination: string;
  searchTerm?: string;
  checkIn: string;
  checkOut: string;
  bedrooms: number;
  queueContext?: SidecarQueueContext;
  rerunOnlyUntried?: boolean;
  searchVariations?: string[];
  pollIntervalMs?: number;
  walletBudgetMs?: number;
  queueBudgetMs?: number;
  signal?: AbortSignal;
  stopGeneration?: number;
}): Promise<{
  candidates: SidecarPropertyCandidate[];
  workerOnline: boolean;
  durationMs: number;
  reason: string;
  providerHealth?: SidecarProviderHealth;
  searchVariationSummary?: SidecarSearchVariationSummary;
}> {
  const cooldown = activeProviderCooldown("airbnb");
  if (cooldown) return providerCooldownSearchResult("airbnb");
  const location = parseSearchLocation(opts);
  const policy = await buildSearchVariationPolicy({
    provider: "airbnb",
    community: location.communityName,
    city: location.city,
    state: location.state,
    checkIn: opts.checkIn,
    checkOut: opts.checkOut,
    bedrooms: opts.bedrooms,
    rerunOnlyUntried: opts.rerunOnlyUntried,
    explicitTerms: opts.searchVariations,
  });
  const r = await awaitOpResult({
    enqueueArgs: {
      opType: "airbnb_search",
      params: {
        destination: opts.destination,
        searchTerm: opts.searchTerm,
        checkIn: opts.checkIn,
        checkOut: opts.checkOut,
        bedrooms: opts.bedrooms,
        searchVariations: policy.terms,
        queueContext: opts.queueContext,
        variationMode: {
          filterTokens: policy.filterTokens,
          maxVariations: policy.maxVariations,
          allowDiscovery: policy.allowDiscovery,
          rerunOnlyUntried: Boolean(opts.rerunOnlyUntried),
        },
      },
    },
    pollIntervalMs: opts.pollIntervalMs,
    walletBudgetMs: opts.walletBudgetMs,
    queueBudgetMs: opts.queueBudgetMs,
    signal: opts.signal,
    stopGeneration: opts.stopGeneration,
  });
  const result = {
    candidates: (r.results ?? []) as SidecarPropertyCandidate[],
    workerOnline: r.workerOnline,
    durationMs: r.durationMs,
    reason: r.reason,
  };
  return {
    ...result,
    providerHealth: recordProviderOutcome("airbnb", result),
    searchVariationSummary: r.searchVariationSummary,
  };
}

export async function googleSerpViaSidecar(opts: {
  query: string;
  maxResults?: number;
  pollIntervalMs?: number;
  walletBudgetMs?: number;
  signal?: AbortSignal;
  stopGeneration?: number;
}): Promise<{
  hits: SidecarSerpHit[];
  workerOnline: boolean;
  durationMs: number;
  reason: string;
}> {
  const r = await awaitOpResult({
    enqueueArgs: {
      opType: "google_serp",
      params: { query: opts.query, maxResults: opts.maxResults ?? 20 },
    },
    pollIntervalMs: opts.pollIntervalMs,
    walletBudgetMs: opts.walletBudgetMs,
    signal: opts.signal,
    stopGeneration: opts.stopGeneration,
  });
  return {
    hits: (r.results ?? []) as SidecarSerpHit[],
    workerOnline: r.workerOnline,
    durationMs: r.durationMs,
    reason: r.reason,
  };
}

export async function searchPmSitesViaSidecar(opts: {
  sites: SidecarPmSearchSite[];
  searchTerm: string;
  checkIn: string;
  checkOut: string;
  bedrooms: number;
  perSiteLimit?: number;
  maxSites?: number;
  pollIntervalMs?: number;
  walletBudgetMs?: number;
  queueBudgetMs?: number;
  signal?: AbortSignal;
  stopGeneration?: number;
}): Promise<{
  candidates: SidecarPropertyCandidate[];
  workerOnline: boolean;
  durationMs: number;
  reason: string;
}> {
  if (opts.sites.length === 0) {
    return {
      candidates: [],
      workerOnline: false,
      durationMs: 0,
      reason: "no PM sites supplied",
    };
  }
  const r = await awaitOpResult({
    enqueueArgs: {
      opType: "pm_site_search",
      params: {
        sites: opts.sites,
        searchTerm: opts.searchTerm,
        checkIn: opts.checkIn,
        checkOut: opts.checkOut,
        bedrooms: opts.bedrooms,
        perSiteLimit: opts.perSiteLimit,
        maxSites: opts.maxSites,
        budgetMs: opts.walletBudgetMs
          ? Math.max(15_000, Math.min(210_000, opts.walletBudgetMs - 30_000))
          : undefined,
      },
    },
    pollIntervalMs: opts.pollIntervalMs,
    walletBudgetMs: opts.walletBudgetMs ?? 120_000,
    queueBudgetMs: opts.queueBudgetMs,
    signal: opts.signal,
    stopGeneration: opts.stopGeneration,
  });
  return {
    candidates: (r.results ?? []) as SidecarPropertyCandidate[],
    workerOnline: r.workerOnline,
    durationMs: r.durationMs,
    reason: r.reason,
  };
}

export async function checkPmUrlViaSidecar(opts: {
  url: string;
  checkIn: string;
  checkOut: string;
  bedrooms?: number;
  pollIntervalMs?: number;
  walletBudgetMs?: number;
  signal?: AbortSignal;
  stopGeneration?: number;
}): Promise<{
  result: SidecarPmUrlCheckResult | null;
  workerOnline: boolean;
  durationMs: number;
  reason: string;
}> {
  const r = await awaitOpResult({
    enqueueArgs: {
      opType: "pm_url_check",
      params: {
        url: opts.url,
        checkIn: opts.checkIn,
        checkOut: opts.checkOut,
        bedrooms: opts.bedrooms,
      },
    },
    pollIntervalMs: opts.pollIntervalMs,
    walletBudgetMs: opts.walletBudgetMs,
    signal: opts.signal,
  });
  return {
    result: (r.results as SidecarPmUrlCheckResult | undefined) ?? null,
    workerOnline: r.workerOnline,
    durationMs: r.durationMs,
    reason: r.reason,
  };
}

// Verify N PM URLs in parallel against the operator's home-IP Chrome.
// The daemon opens up to 5 concurrent tabs; total wall time is roughly
// the slowest single-URL check, not the sum. Used by find-buy-in to
// upgrade unpriced sidecar-Google PM URLs into priced+verified rows
// without spending a Browserbase verify on each.
export async function checkPmUrlsBatchViaSidecar(opts: {
  urls: string[];
  checkIn: string;
  checkOut: string;
  bedrooms?: number;
  pollIntervalMs?: number;
  walletBudgetMs?: number;
  signal?: AbortSignal;
  stopGeneration?: number;
}): Promise<{
  results: SidecarPmUrlCheckBatchResult;
  workerOnline: boolean;
  durationMs: number;
  reason: string;
}> {
  if (opts.urls.length === 0) {
    return {
      results: [],
      workerOnline: false,
      durationMs: 0,
      reason: "no urls supplied",
    };
  }
  const r = await awaitOpResult({
    enqueueArgs: {
      opType: "pm_url_check_batch",
      params: {
        urls: opts.urls,
        checkIn: opts.checkIn,
        checkOut: opts.checkOut,
        bedrooms: opts.bedrooms,
      },
    },
    pollIntervalMs: opts.pollIntervalMs,
    // Default 60s — daemon does up to 5 in parallel ≈ 20-30s typical.
    walletBudgetMs: opts.walletBudgetMs ?? 60_000,
    signal: opts.signal,
    stopGeneration: opts.stopGeneration,
  });
  return {
    results: (r.results as SidecarPmUrlCheckBatchResult | undefined) ?? [],
    workerOnline: r.workerOnline,
    durationMs: r.durationMs,
    reason: r.reason,
  };
}

// Channel-photo-independence: upload a fresh photo set to one OTA
// channel via the operator's authenticated partner-portal session.
// `channel` picks the op type (vrbo_upload_photos vs
// booking_upload_photos). The sidecar's worker.mjs is responsible
// for the Playwright handler — until that lands the request will
// time out and the caller will see workerOnline=false.
//
// Default wall budget is 5 minutes — partner portals are slower than
// search loads and bulk upload of 25-40 photos can legitimately take
// minutes. Caller can override.
export async function uploadPhotosToChannelViaSidecar(opts: {
  channel: "vrbo" | "booking";
  partnerListingRef: string;
  photos: Array<{ url: string; caption?: string }>;
  pollIntervalMs?: number;
  walletBudgetMs?: number;
  signal?: AbortSignal;
}): Promise<{
  result: SidecarPhotoUploadResult | null;
  workerOnline: boolean;
  durationMs: number;
  reason: string;
}> {
  if (!opts.partnerListingRef || opts.photos.length === 0) {
    return {
      result: null,
      workerOnline: false,
      durationMs: 0,
      reason: "partnerListingRef and at least one photo required",
    };
  }
  const opType = opts.channel === "vrbo" ? "vrbo_upload_photos" : "booking_upload_photos";
  const r = await awaitOpResult({
    enqueueArgs: {
      opType,
      params: { partnerListingRef: opts.partnerListingRef, photos: opts.photos },
    },
    pollIntervalMs: opts.pollIntervalMs,
    walletBudgetMs: opts.walletBudgetMs ?? 5 * 60_000,
    signal: opts.signal,
  });
  return {
    result: (r.results as SidecarPhotoUploadResult | undefined) ?? null,
    workerOnline: r.workerOnline,
    durationMs: r.durationMs,
    reason: r.reason,
  };
}

// Channel-photo-independence: instruct the sidecar to disconnect a
// channel integration on the Guesty admin side. Sidecar Playwright
// navigates the operator's authenticated Guesty admin session and
// clicks Disconnect for the named channel on the named listing.
//
// Default wallet 4 minutes — Guesty admin can be slow on the listing
// detail page; enough buffer for navigation + confirm dialogs.
export async function disconnectGuestyChannelViaSidecar(opts: {
  guestyListingId: string;
  channel: "vrbo" | "booking";
  pollIntervalMs?: number;
  walletBudgetMs?: number;
  signal?: AbortSignal;
}): Promise<{
  result: SidecarGuestyDisconnectResult | null;
  workerOnline: boolean;
  durationMs: number;
  reason: string;
}> {
  if (!opts.guestyListingId) {
    return {
      result: null,
      workerOnline: false,
      durationMs: 0,
      reason: "guestyListingId required",
    };
  }
  const r = await awaitOpResult({
    enqueueArgs: {
      opType: "guesty_disconnect_channel",
      params: { guestyListingId: opts.guestyListingId, channel: opts.channel },
    },
    pollIntervalMs: opts.pollIntervalMs,
    walletBudgetMs: opts.walletBudgetMs ?? 4 * 60_000,
    signal: opts.signal,
  });
  return {
    result: (r.results as SidecarGuestyDisconnectResult | undefined) ?? null,
    workerOnline: r.workerOnline,
    durationMs: r.durationMs,
    reason: r.reason,
  };
}

// VRBO buy-in checkout. Enqueues a `vrbo_book` op and waits for the worker to
// drive the listing to payment, surface the (yellow) window, BLOCK for the
// operator to enter card details, and detect the booking confirmation. The
// wallet is long (default 50m) to cover a human-paced payment; the daemon's own
// hard timeout (SIDECAR_VRBO_BOOK_TIMEOUT_MS, default 45m) fires first so we
// still get a result. `onStage` is called each poll with the op's live stage
// (the worker emits "awaiting payment — operator entering card" once the window
// is up) so the checkout job can flip to an awaiting_payment status.
export async function bookVrboUnitViaSidecar(opts: {
  params: SidecarVrboBookParams;
  pollIntervalMs?: number;
  walletBudgetMs?: number;
  queueBudgetMs?: number;
  signal?: AbortSignal;
  onStage?: (stage: string | undefined, request: SidecarRequest) => void;
}): Promise<{
  result: SidecarVrboBookResult | null;
  workerOnline: boolean;
  durationMs: number;
  reason: string;
}> {
  if (!opts.params?.listingUrl || !opts.params?.email) {
    return { result: null, workerOnline: false, durationMs: 0, reason: "listingUrl and email required" };
  }
  const r = await awaitOpResult({
    enqueueArgs: {
      opType: "vrbo_book",
      // Every booking is a one-off interactive run: never dedup onto another
      // request and never serve a cached result.
      params: { ...opts.params, queueContext: { ...opts.params.queueContext, forceFresh: true, skipResultCache: true } },
    },
    pollIntervalMs: opts.pollIntervalMs ?? 2000,
    walletBudgetMs: opts.walletBudgetMs ?? (Number(process.env.SIDECAR_VRBO_BOOK_WALLET_MS) || 50 * 60_000),
    queueBudgetMs: opts.queueBudgetMs ?? (Number(process.env.SIDECAR_VRBO_BOOK_QUEUE_MS) || 10 * 60_000),
    signal: opts.signal,
    onPoll: opts.onStage ? (req) => opts.onStage!(req.stage, req) : undefined,
  });
  return {
    result: (r.results as SidecarVrboBookResult | undefined) ?? null,
    workerOnline: r.workerOnline,
    durationMs: r.durationMs,
    reason: r.reason,
  };
}

// Shared enqueue + poll loop. Each `searchXViaSidecar` is a thin
// op-typed wrapper around this.
async function awaitOpResult(opts: {
  enqueueArgs: Parameters<typeof enqueueOp>[0];
  pollIntervalMs?: number;
  walletBudgetMs?: number;
  queueBudgetMs?: number;
  signal?: AbortSignal;
  stopGeneration?: number;
  // Called once per poll tick with the live request (incl. its `stage`, set
  // from the worker's heartbeat label). Lets a caller surface intermediate
  // states — e.g. the checkout job flipping to "awaiting payment" while the op
  // is still in_progress. Must not throw.
  onPoll?: (request: SidecarRequest) => void;
}): Promise<{
  results: SidecarRequest["results"];
  searchVariationSummary?: SidecarSearchVariationSummary;
  mapHarvest?: SidecarMapHarvestStats | null;
  workerOnline: boolean;
  durationMs: number;
  reason: string;
}> {
  const startedAt = nowMs();
  const pollMs = opts.pollIntervalMs ?? 2000;
  const walletMs = opts.walletBudgetMs ?? 75_000;
  const queueBudgetMs = opts.queueBudgetMs ?? walletMs;
  const abortReason = (): string => {
    const raw = opts.signal?.reason;
    if (raw instanceof Error) return raw.message;
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    return "caller aborted sidecar request";
  };
  if (opts.signal?.aborted) {
    return {
      results: null,
      workerOnline: false,
      durationMs: nowMs() - startedAt,
      reason: abortReason(),
    };
  }
  assertSidecarStopGenerationCurrent(opts.stopGeneration);
  const pausedState = isQueuePaused();
  if (pausedState.paused) {
    return {
      results: null,
      workerOnline: false,
      durationMs: nowMs() - startedAt,
      reason: pausedState.reason ? `sidecar queue stopped: ${pausedState.reason}` : "sidecar queue stopped by operator",
    };
  }
  const requestKey = makeRequestKey(opts.enqueueArgs.opType, opts.enqueueArgs.params);
  const skipResultCache = (opts.enqueueArgs.params as { queueContext?: SidecarQueueContext } | undefined)
    ?.queueContext?.skipResultCache === true;
  if (!skipResultCache) {
    const cached = cachedSuccessfulResult(requestKey);
    if (cached) {
      const ageMs = nowMs() - cached.cachedAt;
      return {
        results: cached.results,
        searchVariationSummary: cached.searchVariationSummary,
        mapHarvest: cached.mapHarvest ?? null,
        workerOnline: true,
        durationMs: nowMs() - startedAt,
        reason: `served from successful sidecar result cache (${Math.round(ageMs / 60000)}m old)`,
      };
    }
  }
  const { id, deduped } = enqueueOp(opts.enqueueArgs);
  let activeStartedAt: number | null = null;
  let aborted = false;
  const cancelIfOwned = (reason: string) => {
    // A deduped waiter is sharing an already-running browser job with
    // another caller. Its local timeout/abort should stop waiting, but
    // must not kill the Chrome task out from under the original owner.
    if (!deduped) cancelRequest(id, reason);
  };
  const onAbort = () => {
    aborted = true;
    cancelIfOwned(abortReason());
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (opts.signal?.aborted) onAbort();
    while (true) {
      if (aborted || opts.signal?.aborted) {
        if (!aborted) onAbort();
        return {
          results: null,
          workerOnline: false,
          durationMs: nowMs() - startedAt,
          reason: abortReason(),
        };
      }
      if (hasSidecarStopGenerationChanged(opts.stopGeneration)) {
        const reason = "sidecar run cancelled by operator stop";
        cancelRequest(id, reason);
        throw sidecarRunCancelledError(reason);
      }
      const r = getResult(id);
      if (!r) {
        return {
          results: null,
          workerOnline: false,
          durationMs: nowMs() - startedAt,
          reason: "request expired before completion (worker likely offline)",
        };
      }
      try {
        opts.onPoll?.(r);
      } catch {
        /* onPoll must never break the poll loop */
      }
      const now = nowMs();
      if (r.status === "completed") {
        return {
          results: r.results ?? null,
          searchVariationSummary: r.searchVariationSummary,
          mapHarvest: r.mapHarvest ?? null,
          workerOnline: true,
          durationMs: nowMs() - startedAt,
          reason: `worker returned ${
            Array.isArray(r.results) ? r.results.length : r.results ? "1" : "0"
          } result(s)${r.searchVariationSummary?.tried?.length ? ` across ${r.searchVariationSummary.tried.length} location variation(s)` : ""}`,
        };
      }
      if (r.status === "failed") {
        return {
          results: null,
          workerOnline: true,
          durationMs: nowMs() - startedAt,
          reason: r.error || "worker reported failure",
        };
      }
      if (r.status === "paused" && now - startedAt >= queueBudgetMs) {
        return {
          results: null,
          workerOnline: true,
          durationMs: now - startedAt,
          reason: r.pausedReason ? `request paused by operator: ${r.pausedReason}` : "request paused by operator",
        };
      }
      if (r.status === "in_progress") {
        if (activeStartedAt === null) {
          activeStartedAt = deduped ? now : (r.claimedAt ?? now);
        }
      } else if (activeStartedAt !== null) {
        // Reclaimed jobs return to pending; extend the wallet for the next claim.
        activeStartedAt = null;
      }
      if (r.status === "pending" && now - startedAt >= queueBudgetMs) {
        const reason = `queue wait budget ${queueBudgetMs}ms exceeded waiting for worker`;
        cancelIfOwned(reason);
        return {
          results: null,
          workerOnline: false,
          durationMs: now - startedAt,
          reason,
        };
      }
      if (activeStartedAt !== null && now - activeStartedAt >= walletMs) {
        const reason = `wallet budget ${walletMs}ms exceeded while worker active`;
        cancelIfOwned(reason);
        return {
          results: null,
          workerOnline: false,
          durationMs: now - startedAt,
          reason,
        };
      }
      await new Promise((res) => setTimeout(res, pollMs));
    }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
