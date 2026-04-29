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
// four op types with the same queue machinery:
//   - vrbo_search      (drive vrbo.com search, return priced cards)
//   - booking_search   (drive booking.com search, return priced cards)
//   - google_serp      (run a Google query, return organic results
//                       — used for PM company discovery)
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
  | "vrbo_search"
  | "booking_search"
  | "google_serp"
  | "pm_url_check"
  | "pm_url_check_batch";

export type SidecarVrboParams = {
  destination: string;
  checkIn: string;
  checkOut: string;
  bedrooms: number;
};

export type SidecarBookingParams = {
  destination: string;
  checkIn: string;
  checkOut: string;
  bedrooms: number;
};

export type SidecarGoogleSerpParams = {
  query: string;
  maxResults?: number;
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
  reason: string;
}>;

export type SidecarParamsByOp = {
  vrbo_search: SidecarVrboParams;
  booking_search: SidecarBookingParams;
  google_serp: SidecarGoogleSerpParams;
  pm_url_check: SidecarPmUrlCheckParams;
  pm_url_check_batch: SidecarPmUrlCheckBatchParams;
};

// Result shapes per op type.
export type SidecarPropertyCandidate = {
  url: string;
  title: string;
  totalPrice: number;
  nightlyPrice: number;
  bedrooms?: number;
  image?: string;
  snippet?: string;
};

export type SidecarSerpHit = {
  url: string;
  title: string;
  snippet?: string;
};

export type SidecarPmUrlCheckResult = {
  available: "yes" | "no" | "unclear";
  nightlyPrice: number | null;
  totalPrice: number | null;
  reason: string;
};

export type SidecarRequest = {
  id: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  opType: SidecarOpType;
  params:
    | SidecarVrboParams
    | SidecarBookingParams
    | SidecarGoogleSerpParams
    | SidecarPmUrlCheckParams
    | SidecarPmUrlCheckBatchParams;
  requestKey: string;
  results?:
    | SidecarPropertyCandidate[]
    | SidecarSerpHit[]
    | SidecarPmUrlCheckResult
    | SidecarPmUrlCheckBatchResult
    | null;
  error?: string;
  createdAt: number;
  claimedAt?: number;
  completedAt?: number;
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
    case "vrbo_search":
    case "booking_search": {
      const p = params as SidecarVrboParams | SidecarBookingParams;
      return `${opType}|${p.destination.toLowerCase().trim()}|${p.checkIn}|${p.checkOut}|${p.bedrooms}`;
    }
    case "google_serp": {
      const p = params as SidecarGoogleSerpParams;
      return `google_serp|${p.query.toLowerCase().trim()}|${p.maxResults ?? 20}`;
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
    | { opType: "vrbo_search"; params: SidecarVrboParams }
    | { opType: "booking_search"; params: SidecarBookingParams }
    | { opType: "google_serp"; params: SidecarGoogleSerpParams }
    | { opType: "pm_url_check"; params: SidecarPmUrlCheckParams }
    | { opType: "pm_url_check_batch"; params: SidecarPmUrlCheckBatchParams },
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
  lastWorkerPollAt = nowMs();
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
} {
  cleanup();
  let pending = 0,
    inProgress = 0,
    completed = 0,
    failed = 0;
  let oldestPendingAge: number | null = null;
  let newestAt = 0;
  const byOpType: Record<SidecarOpType, number> = {
    vrbo_search: 0,
    booking_search: 0,
    google_serp: 0,
    pm_url_check: 0,
    pm_url_check_batch: 0,
  };
  const now = nowMs();
  for (const r of queue.values()) {
    if (r.status === "pending") {
      pending++;
      const age = (now - r.createdAt) / 1000;
      if (oldestPendingAge === null || age > oldestPendingAge)
        oldestPendingAge = age;
    }
    if (r.status === "in_progress") inProgress++;
    if (r.status === "completed") completed++;
    if (r.status === "failed") failed++;
    if (r.createdAt > newestAt) newestAt = r.createdAt;
    byOpType[r.opType]++;
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
  checkIn: string;
  checkOut: string;
  bedrooms: number;
  pollIntervalMs?: number;
  walletBudgetMs?: number;
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
        checkIn: opts.checkIn,
        checkOut: opts.checkOut,
        bedrooms: opts.bedrooms,
      },
    },
    pollIntervalMs: opts.pollIntervalMs,
    walletBudgetMs: opts.walletBudgetMs,
  });
  return {
    candidates: (r.results ?? []) as SidecarPropertyCandidate[],
    workerOnline: r.workerOnline,
    durationMs: r.durationMs,
    reason: r.reason,
  };
}

export async function searchBookingViaSidecar(opts: {
  destination: string;
  checkIn: string;
  checkOut: string;
  bedrooms: number;
  pollIntervalMs?: number;
  walletBudgetMs?: number;
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
        checkIn: opts.checkIn,
        checkOut: opts.checkOut,
        bedrooms: opts.bedrooms,
      },
    },
    pollIntervalMs: opts.pollIntervalMs,
    walletBudgetMs: opts.walletBudgetMs,
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

// Shared enqueue + poll loop. Each `searchXViaSidecar` is a thin
// op-typed wrapper around this.
async function awaitOpResult(opts: {
  enqueueArgs: Parameters<typeof enqueueOp>[0];
  pollIntervalMs?: number;
  walletBudgetMs?: number;
}): Promise<{
  results: SidecarRequest["results"];
  workerOnline: boolean;
  durationMs: number;
  reason: string;
}> {
  const startedAt = nowMs();
  const pollMs = opts.pollIntervalMs ?? 2000;
  const walletMs = opts.walletBudgetMs ?? 75_000;
  const { id } = enqueueOp(opts.enqueueArgs);

  while (nowMs() - startedAt < walletMs) {
    const r = getResult(id);
    if (!r) {
      return {
        results: null,
        workerOnline: false,
        durationMs: nowMs() - startedAt,
        reason: "request expired before completion (worker likely offline)",
      };
    }
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
    await new Promise((res) => setTimeout(res, pollMs));
  }
  return {
    results: null,
    workerOnline: false,
    durationMs: nowMs() - startedAt,
    reason: `wallet budget ${walletMs}ms exceeded waiting for worker`,
  };
}
