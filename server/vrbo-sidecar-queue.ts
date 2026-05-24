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
  | "guesty_disconnect_channel";

export type SidecarAirbnbParams = {
  destination: string;
  searchTerm?: string;
  checkIn: string;
  checkOut: string;
  bedrooms: number;
};

export type SidecarVrboParams = {
  destination: string;
  searchTerm?: string;
  checkIn: string;
  checkOut: string;
  bedrooms: number;
};

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
};

// Result shapes per op type.
export type SidecarPropertyCandidate = {
  url: string;
  title: string;
  totalPrice: number;
  nightlyPrice: number;
  bedrooms?: number;
  bedroomSource?: "search-card" | "search-filter" | "detail-page" | "unknown";
  sourceLabel?: string;
  image?: string;
  snippet?: string;
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
  directBookingUrl?: string;
  directBookingHost?: string;
  directBookingConfidence?: "high" | "medium" | "low";
  directBookingSource?: "airbnb_image_reverse_search";
  directBookingReason?: string;
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
  error?: string;
  at: string;
  ageMs: number;
};

export type SidecarScreenControlCommand = {
  id: string;
  slot: string;
  requestId?: string;
  action: "move" | "down" | "up" | "click" | "surface";
  x: number;
  y: number;
  at: string;
};

export type SidecarSerpHit = {
  url: string;
  title: string;
  snippet?: string;
};

export type SidecarVrboPhotoScrapeResult = {
  photos: string[];
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
  status: "pending" | "in_progress" | "completed" | "failed";
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
    | SidecarGuestyDisconnectParams;
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
    | null;
  error?: string;
  createdAt: number;
  claimedAt?: number;
  completedAt?: number;
  cancelled?: boolean;
  stage?: string;
  stageUpdatedAt?: number;
};

export type SidecarStatusRequest = {
  id: string;
  status: SidecarRequest["status"];
  opType: SidecarOpType;
  label: string;
  stage?: string;
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

// Backward-compat alias — old code imported this name when the queue
// was VRBO-only.
export type SidecarVrboCandidate = SidecarPropertyCandidate;

const queue = new Map<string, SidecarRequest>();
const requestKeyIndex = new Map<string, string>(); // requestKey → id

// Worker liveness: every time the worker calls `next()`, we stamp this.
// The UI polls `getHeartbeat()` to decide whether to show "Local sidecar
// online / offline" — purely a UX signal, not load-bearing for queue
// correctness. Online window is 90s (1.5× the daemon's POLL_IDLE_MS so
// a single missed poll doesn't flicker the indicator).
let lastWorkerPollAt: number | null = null;
let lastWorkerRuntime: SidecarWorkerRuntime | null = null;
const HEARTBEAT_ONLINE_WINDOW_MS = 90 * 1000;

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
const SIDECAR_SCREEN_TTL_MS = 10 * 60 * 1000;
const SIDECAR_SCREENSHOT_MAX_CHARS = 350_000;
const SIDECAR_SCREEN_COMMAND_TTL_MS = 60 * 1000;

function nowMs(): number {
  return Date.now();
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
  lastWorkerPollAt = nowMs();
  const normalizedRuntime = normalizeWorkerRuntime(runtime);
  if (normalizedRuntime) lastWorkerRuntime = normalizedRuntime;
  if (!id) return;
  const r = queue.get(id);
  if (r?.status === "in_progress") {
    r.claimedAt = lastWorkerPollAt;
    if (stage && typeof stage === "string") {
      r.stage = stage.replace(/\s+/g, " ").trim().slice(0, 140);
      r.stageUpdatedAt = lastWorkerPollAt;
    }
  }
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
  const screenshotDataUrl = typeof snapshot.screenshotDataUrl === "string" &&
    snapshot.screenshotDataUrl.length <= SIDECAR_SCREENSHOT_MAX_CHARS
    ? snapshot.screenshotDataUrl
    : undefined;
  sidecarScreens.set(slot, {
    slot,
    requestId: typeof snapshot.requestId === "string" ? snapshot.requestId.slice(0, 80) : undefined,
    opType: typeof snapshot.opType === "string" ? snapshot.opType.slice(0, 80) : undefined,
    label: typeof snapshot.label === "string" ? snapshot.label.replace(/\s+/g, " ").trim().slice(0, 120) : undefined,
    phase: typeof snapshot.phase === "string" ? snapshot.phase.replace(/\s+/g, " ").trim().slice(0, 140) : undefined,
    url: typeof snapshot.url === "string" ? snapshot.url.slice(0, 500) : undefined,
    title: typeof snapshot.title === "string" ? snapshot.title.replace(/\s+/g, " ").trim().slice(0, 180) : undefined,
    liveViewUrl: typeof snapshot.liveViewUrl === "string" && /^https?:\/\//i.test(snapshot.liveViewUrl)
      ? snapshot.liveViewUrl.slice(0, 500)
      : undefined,
    screenshotDataUrl,
    width: typeof snapshot.width === "number" && Number.isFinite(snapshot.width) ? Math.round(snapshot.width) : undefined,
    height: typeof snapshot.height === "number" && Number.isFinite(snapshot.height) ? Math.round(snapshot.height) : undefined,
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
    if (!Number.isFinite(at) || now - at > SIDECAR_SCREEN_TTL_MS) {
      sidecarScreens.delete(slot);
    }
  }
  return Array.from(sidecarScreens.values())
    .map((snapshot) => {
      const at = Date.parse(snapshot.at);
      return {
        ...snapshot,
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
  if (action !== "move" && action !== "down" && action !== "up" && action !== "click" && action !== "surface") {
    return { ok: false, error: "action must be move, down, up, click, or surface" };
  }
  const x = Number(command.x);
  const y = Number(command.y);
  if (action !== "surface" && (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0)) {
    return { ok: false, error: "x and y must be non-negative numbers" };
  }
  const requestId = typeof command.requestId === "string" && command.requestId.trim()
    ? command.requestId.trim().slice(0, 80)
    : undefined;
  const queued: SidecarScreenControlCommand = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    slot,
    requestId,
    action,
    x: Number.isFinite(x) ? Math.round(x) : 0,
    y: Number.isFinite(y) ? Math.round(y) : 0,
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

// Build a stable, opType-aware dedup key. Two enqueues with the same
// op type AND same canonical params get folded into one request.
function makeRequestKey(
  opType: SidecarOpType,
  params: SidecarRequest["params"],
): string {
  switch (opType) {
    case "airbnb_search":
    case "vrbo_search":
    case "booking_search": {
      const p = params as SidecarAirbnbParams | SidecarVrboParams | SidecarBookingParams;
      return `${opType}|${(p.searchTerm || p.destination).toLowerCase().trim()}|${p.destination.toLowerCase().trim()}|${p.checkIn}|${p.checkOut}|${p.bedrooms}`;
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
    | { opType: "guesty_disconnect_channel"; params: SidecarGuestyDisconnectParams },
): { id: string; deduped: boolean } {
  cleanup();
  if (queuePaused) {
    const reason = queuePausedReason ? `: ${queuePausedReason}` : "";
    throw new Error(`Sidecar queue is stopped${reason}`);
  }
  const requestKey = makeRequestKey(req.opType, req.params);
  const existingId = requestKeyIndex.get(requestKey);
  if (existingId) {
    const existing = queue.get(existingId);
    if (existing) {
      const isFresh =
        existing.status === "pending" ||
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
  stampHeartbeat(undefined, undefined, runtime);
  // CODEX NOTE (2026-05-04, claude/sidecar-stop-start): paused
  // queue returns null even when pending work exists. The worker
  // keeps polling (heartbeat stays green so the operator sees
  // it's still alive) but no work gets dispatched until resume.
  if (queuePaused) return null;
  let oldest: SidecarRequest | null = null;
  for (const r of queue.values()) {
    if (r.status !== "pending") continue;
    if (!oldest || r.createdAt < oldest.createdAt) oldest = r;
  }
  if (!oldest) return null;
  oldest.status = "in_progress";
  oldest.claimedAt = nowMs();
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
  results?: SidecarRequest["results"];
  error?: string;
}): { ok: boolean; reason?: string } {
  const r = queue.get(opts.id);
  if (!r) return { ok: false, reason: "request not found (already expired?)" };
  if (r.status === "completed" || r.status === "failed") {
    return { ok: false, reason: `request already in terminal state ${r.status}` };
  }
  if (opts.results !== undefined) {
    r.status = "completed";
    r.results = opts.results;
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

export function cancelActiveAndPendingRequests(reason = "cancelled by operator"): {
  cancelled: number;
  pending: number;
  inProgress: number;
} {
  cleanup();
  let cancelled = 0;
  let pending = 0;
  let inProgress = 0;
  for (const r of queue.values()) {
    if (r.status !== "pending" && r.status !== "in_progress") continue;
    if (r.status === "pending") pending++;
    if (r.status === "in_progress") inProgress++;
    cancelRequest(r.id, reason);
    cancelled++;
  }
  return { cancelled, pending, inProgress };
}

export function cancelSidecarRunAndRequests(reason = "cancelled by operator"): {
  cancelled: number;
  pending: number;
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

export function isCancellationRequested(id: string): boolean {
  const r = queue.get(id);
  return Boolean(r?.cancelled);
}

export function getResult(id: string): SidecarRequest | null {
  cleanup();
  return queue.get(id) ?? null;
}

export function getStatus(): {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  oldestPendingAgeSec: number | null;
  newestRequestAt: string | null;
  byOpType: Record<SidecarOpType, number>;
  activeRequests: SidecarStatusRequest[];
  pendingRequests: SidecarStatusRequest[];
} {
  cleanup();
  let pending = 0,
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
  };
  const now = nowMs();
  const describeRequest = (r: SidecarRequest): SidecarStatusRequest => {
    const ageSec = Math.max(0, Math.round((now - r.createdAt) / 1000));
    const activeSec = r.claimedAt ? Math.max(0, Math.round((now - r.claimedAt) / 1000)) : undefined;
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
    const label = (() => {
      switch (r.opType) {
        case "airbnb_search": return `Airbnb${br} search`;
        case "vrbo_search": return `VRBO${br} search`;
        case "booking_search": return `Booking.com${br} search`;
        case "pm_site_search": return `PM websites${br}${siteCount ? ` (${siteCount} sites)` : ""}`;
        case "pm_url_check_batch": return `PM rate checks${siteCount ? ` (${siteCount} pages)` : ""}`;
        case "pm_url_check": return "PM rate check";
        case "google_serp": return "Google discovery";
        case "vrbo_photo_scrape": return "VRBO photo scrape";
        case "zillow_photo_scrape": return "Zillow photo scrape";
        case "vrbo_upload_photos": return "VRBO photo upload";
        case "booking_upload_photos": return "Booking.com photo upload";
        case "guesty_disconnect_channel": return `Guesty ${p.channel ?? ""} disconnect`.trim();
        default: return r.opType;
      }
    })();
    return {
      id: r.id,
      status: r.status,
      opType: r.opType,
      label,
      stage: r.stage,
      bedrooms,
      destination,
      siteCount,
      ageSec,
      activeSec,
    };
  };
  const activeRequests: SidecarStatusRequest[] = [];
  const pendingRequests: SidecarStatusRequest[] = [];
  for (const r of queue.values()) {
    if (r.status === "pending") {
      pending++;
      const age = (now - r.createdAt) / 1000;
      if (oldestPendingAge === null || age > oldestPendingAge)
        oldestPendingAge = age;
    }
    if (r.status === "in_progress") {
      inProgress++;
      activeRequests.push(describeRequest(r));
    }
    if (r.status === "pending") {
      pendingRequests.push(describeRequest(r));
    }
    if (r.status === "completed") completed++;
    if (r.status === "failed") failed++;
    if (r.createdAt > newestAt) newestAt = r.createdAt;
    byOpType[r.opType as SidecarOpType]++;
  }
  return {
    total: queue.size,
    pending,
    inProgress,
    completed,
    failed,
    oldestPendingAgeSec: oldestPendingAge,
    newestRequestAt: newestAt > 0 ? new Date(newestAt).toISOString() : null,
    byOpType,
    activeRequests: activeRequests.sort((a, b) => (b.activeSec ?? 0) - (a.activeSec ?? 0)).slice(0, 5),
    pendingRequests: pendingRequests.sort((a, b) => b.ageSec - a.ageSec).slice(0, 8),
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
    };
  }
  const ageMs = nowMs() - lastWorkerPollAt;
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
    workerRuntime: lastWorkerRuntime,
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
} | null> {
  const r = await awaitOpResult({
    enqueueArgs: {
      opType: "vrbo_search",
      params: {
        destination: opts.destination,
        searchTerm: opts.searchTerm,
        checkIn: opts.checkIn,
        checkOut: opts.checkOut,
        bedrooms: opts.bedrooms,
      },
    },
    pollIntervalMs: opts.pollIntervalMs,
    walletBudgetMs: opts.walletBudgetMs,
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

export async function scrapeVrboPhotosViaSidecar(opts: {
  url: string;
  maxPhotos?: number;
  pollIntervalMs?: number;
  walletBudgetMs?: number;
  signal?: AbortSignal;
  stopGeneration?: number;
}): Promise<{
  photos: string[];
  workerOnline: boolean;
  durationMs: number;
  reason: string;
}> {
  if (!opts.url || !/^https?:\/\//.test(opts.url)) {
    return {
      photos: [],
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
  return {
    photos: ((r.results as SidecarVrboPhotoScrapeResult | undefined)?.photos ?? []),
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
  const r = await awaitOpResult({
    enqueueArgs: {
      opType: "booking_search",
      params: {
        destination: opts.destination,
        searchTerm: opts.searchTerm,
        checkIn: opts.checkIn,
        checkOut: opts.checkOut,
        bedrooms: opts.bedrooms,
      },
    },
    pollIntervalMs: opts.pollIntervalMs,
    walletBudgetMs: opts.walletBudgetMs,
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

export async function searchAirbnbViaSidecar(opts: {
  destination: string;
  searchTerm?: string;
  checkIn: string;
  checkOut: string;
  bedrooms: number;
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
  const r = await awaitOpResult({
    enqueueArgs: {
      opType: "airbnb_search",
      params: {
        destination: opts.destination,
        searchTerm: opts.searchTerm,
        checkIn: opts.checkIn,
        checkOut: opts.checkOut,
        bedrooms: opts.bedrooms,
      },
    },
    pollIntervalMs: opts.pollIntervalMs,
    walletBudgetMs: opts.walletBudgetMs,
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

// Shared enqueue + poll loop. Each `searchXViaSidecar` is a thin
// op-typed wrapper around this.
async function awaitOpResult(opts: {
  enqueueArgs: Parameters<typeof enqueueOp>[0];
  pollIntervalMs?: number;
  walletBudgetMs?: number;
  queueBudgetMs?: number;
  signal?: AbortSignal;
  stopGeneration?: number;
}): Promise<{
  results: SidecarRequest["results"];
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
      const now = nowMs();
      if (r.status === "completed") {
        return {
          results: r.results ?? null,
          workerOnline: true,
          durationMs: nowMs() - startedAt,
          reason: `worker returned ${
            Array.isArray(r.results) ? r.results.length : r.results ? "1" : "0"
          } result(s)`,
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
      if (r.status === "in_progress" && activeStartedAt === null) {
        activeStartedAt = deduped ? now : (r.claimedAt ?? now);
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
