// Local-Chrome sidecar queue.
//
// Bridges find-buy-in (running on Railway) to a daemon running on the
// operator's Mac that drives their REAL Chrome via CDP. Vrbo's anti-bot
// fingerprints every Browserbase residential session (see PR #265's
// diagnostic + the Decision Log entry from 2026-04-29); driving the
// operator's actual home-IP Chrome is the only path that consistently
// gets past the bot wall.
//
// Originally just for VRBO search. Generalized 2026-04-29 to handle
// multiple op types with the same queue machinery:
//   - airbnb_search    (drive airbnb.com search, return priced cards)
//   - vrbo_search      (drive vrbo.com search, return priced cards)
//   - booking_search   (drive booking.com search, return priced cards)
//   - google_serp      (run a Google query, return organic results
//                       — used for PM company discovery)
//   - pm_site_search   (drive PM website search widgets/pages)
//   - pm_url_check     (visit a specific PM URL, scrape availability +
//                       price for the requested dates)
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
// requests sequentially (which would block on the daemon's single
// active page). Cap to 5 URLs per batch — Chrome handles 5 parallel
// loads comfortably; more risks DOM-extract races.
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
const HEARTBEAT_ONLINE_WINDOW_MS = 90 * 1000;

// TTLs (per-status) — also bound the size of the queue so a wedged
// worker can't accumulate state forever.
const PENDING_TTL_MS = 5 * 60 * 1000;
const IN_PROGRESS_RECLAIM_MS = 90 * 1000;
const TERMINAL_TTL_MS = 5 * 60 * 1000;

function nowMs(): number {
  return Date.now();
}

export function stampHeartbeat(id?: string, stage?: string): void {
  lastWorkerPollAt = nowMs();
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
      return `pm_site_search|${sites}|${p.searchTerm.toLowerCase().trim()}|${p.checkIn}|${p.checkOut}|${p.bedrooms}|${p.perSiteLimit ?? 6}`;
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
  const requestKey = makeRequestKey(req.opType, req.params);
  const existingId = requestKeyIndex.get(requestKey);
  if (existingId) {
    const existing = queue.get(existingId);
    if (existing) {
      const isFresh =
        existing.status === "pending" ||
        existing.status === "in_progress" ||
        (existing.completedAt && nowMs() - existing.completedAt < 60 * 1000);
      if (isFresh) return { id: existingId, deduped: true };
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
export function next(): SidecarRequest | null {
  cleanup();
  stampHeartbeat();
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
  lastWorkerPollAt: string | null;
  ageMs: number | null;
  onlineWindowMs: number;
} {
  if (lastWorkerPollAt === null) {
    return {
      isOnline: false,
      lastWorkerPollAt: null,
      ageMs: null,
      onlineWindowMs: HEARTBEAT_ONLINE_WINDOW_MS,
    };
  }
  const ageMs = nowMs() - lastWorkerPollAt;
  return {
    isOnline: ageMs < HEARTBEAT_ONLINE_WINDOW_MS,
    lastWorkerPollAt: new Date(lastWorkerPollAt).toISOString(),
    ageMs,
    onlineWindowMs: HEARTBEAT_ONLINE_WINDOW_MS,
  };
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
  });
  return {
    photos: ((r.results as SidecarVrboPhotoScrapeResult | undefined)?.photos ?? []),
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
  pollIntervalMs?: number;
  walletBudgetMs?: number;
  queueBudgetMs?: number;
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
        budgetMs: opts.walletBudgetMs
          ? Math.max(15_000, Math.min(135_000, opts.walletBudgetMs - 30_000))
          : undefined,
      },
    },
    pollIntervalMs: opts.pollIntervalMs,
    walletBudgetMs: opts.walletBudgetMs ?? 120_000,
    queueBudgetMs: opts.queueBudgetMs,
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
  const { id } = enqueueOp(opts.enqueueArgs);
  let activeStartedAt: number | null = null;

  while (true) {
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
      activeStartedAt = r.claimedAt ?? now;
    }
    if (r.status === "pending" && now - startedAt >= queueBudgetMs) {
      const reason = `queue wait budget ${queueBudgetMs}ms exceeded waiting for worker`;
      cancelRequest(id, reason);
      return {
        results: null,
        workerOnline: false,
        durationMs: now - startedAt,
        reason,
      };
    }
    if (activeStartedAt !== null && now - activeStartedAt >= walletMs) {
      const reason = `wallet budget ${walletMs}ms exceeded while worker active`;
      cancelRequest(id, reason);
      return {
        results: null,
        workerOnline: false,
        durationMs: now - startedAt,
        reason,
      };
    }
    await new Promise((res) => setTimeout(res, pollMs));
  }
}
