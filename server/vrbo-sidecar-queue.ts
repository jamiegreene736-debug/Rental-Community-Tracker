// Local-Chrome VRBO sidecar queue.
//
// Background: Vrbo's anti-bot fingerprints every Browserbase residential
// session and blocks them at the bot wall, even with a persistent context
// seeded with the operator's real-Chrome cookies (the cookies survive
// the homepage hop but Vrbo escalates to a slider CAPTCHA on the search
// endpoint — IP fingerprint, not session-trust). See diagnostic from
// PR #265 + screenshot at /photos/debug/vrbo-stagehand-1777422718433.jpg.
//
// The operator's REAL Chrome session (their home IP) reaches Vrbo
// cleanly — verified end-to-end via Chrome MCP in PR #268 follow-up.
// This module bridges find-buy-in (running on Railway) to that real
// Chrome session via a tiny in-memory queue:
//
//   1. find-buy-in calls `enqueue(destination, dates, bedrooms)` and
//      polls `getResult(id)` for up to ~60s.
//   2. A "/loop" worker running inside the operator's Claude Code
//      session polls `next()` every ~30s, drives Chrome MCP to do the
//      Vrbo search on their real browser, extracts priced cards, and
//      calls `complete(id, results)`.
//
// When the worker is offline, find-buy-in's poll times out and falls
// back to the existing Vrbo paths (Google site:search etc.) gracefully.
//
// Why in-memory and not a DB table:
//   - Single-instance Railway deploy; no need to share queue across
//     processes.
//   - Pending requests > 5 min are stale anyway (operator already
//     scrolled past that buy-in dialog).
//   - Restart / deploy wipes the queue, but find-buy-in's existing
//     fallback paths cover the gap automatically.
//
// Auth note: all four endpoints accept a worker / find-buy-in caller
// without auth except the worker-poll one, which honours ADMIN_SECRET
// when set (matches the pattern in /api/admin/guesty/save-session).
// find-buy-in's enqueue/poll happen server-side so they don't need
// auth either.

export type SidecarRequest = {
  id: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  destination: string;
  checkIn: string;
  checkOut: string;
  bedrooms: number;
  // Dedup key: same (destination, dates, bedrooms) within the TTL
  // returns the EXISTING request id rather than creating a duplicate.
  // Reduces redundant Chrome scrapes when the operator opens multiple
  // buy-in dialogs in a row for the same reservation.
  requestKey: string;
  results?: SidecarVrboCandidate[];
  error?: string;
  createdAt: number;
  claimedAt?: number;
  completedAt?: number;
};

export type SidecarVrboCandidate = {
  url: string;
  title: string;
  totalPrice: number;
  nightlyPrice: number;
  bedrooms?: number;
  image?: string;
  snippet?: string;
};

const queue = new Map<string, SidecarRequest>();
const requestKeyIndex = new Map<string, string>(); // requestKey → id

// TTLs (per-status) — also bound the size of the queue so a wedged
// worker can't accumulate state forever.
const PENDING_TTL_MS = 5 * 60 * 1000;       // pending requests > 5 min are dropped
const IN_PROGRESS_RECLAIM_MS = 90 * 1000;   // in_progress > 90s is re-queued (worker probably crashed)
const TERMINAL_TTL_MS = 5 * 60 * 1000;      // completed/failed > 5 min are dropped (find-buy-in already moved on)

function nowMs(): number { return Date.now(); }

// Inline cleanup pass — keeps the Map bounded without a separate timer.
function cleanup(): void {
  const now = nowMs();
  for (const [id, r] of queue) {
    if (r.status === "pending" && now - r.createdAt > PENDING_TTL_MS) {
      r.status = "failed";
      r.error = "expired waiting for worker";
      r.completedAt = now;
    }
    if (r.status === "in_progress" && r.claimedAt && now - r.claimedAt > IN_PROGRESS_RECLAIM_MS) {
      // Worker probably crashed mid-request. Put it back in pending so
      // the next worker poll picks it up.
      r.status = "pending";
      r.claimedAt = undefined;
    }
    if ((r.status === "completed" || r.status === "failed") && r.completedAt && now - r.completedAt > TERMINAL_TTL_MS) {
      queue.delete(id);
      requestKeyIndex.delete(r.requestKey);
    }
  }
}

function makeRequestKey(destination: string, checkIn: string, checkOut: string, bedrooms: number): string {
  return `${destination.toLowerCase().trim()}|${checkIn}|${checkOut}|${bedrooms}`;
}

function makeId(): string {
  // 12 random hex chars — enough entropy for a single-process queue.
  return Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

/**
 * Enqueue a Vrbo search. If an identical request is already in flight
 * (pending or in_progress), returns the EXISTING id so callers
 * deduplicate cleanly. If a recent completed/failed result exists for
 * the same key (within 1 minute), also returns that id so callers
 * can pick up the cached answer.
 */
export function enqueue(opts: {
  destination: string;
  checkIn: string;
  checkOut: string;
  bedrooms: number;
}): { id: string; deduped: boolean } {
  cleanup();
  const requestKey = makeRequestKey(opts.destination, opts.checkIn, opts.checkOut, opts.bedrooms);
  const existingId = requestKeyIndex.get(requestKey);
  if (existingId) {
    const existing = queue.get(existingId);
    if (existing) {
      const isFresh =
        existing.status === "pending"
        || existing.status === "in_progress"
        || (existing.completedAt && nowMs() - existing.completedAt < 60 * 1000);
      if (isFresh) return { id: existingId, deduped: true };
    }
  }
  const id = makeId();
  const req: SidecarRequest = {
    id,
    status: "pending",
    destination: opts.destination,
    checkIn: opts.checkIn,
    checkOut: opts.checkOut,
    bedrooms: opts.bedrooms,
    requestKey,
    createdAt: nowMs(),
  };
  queue.set(id, req);
  requestKeyIndex.set(requestKey, id);
  return { id, deduped: false };
}

/**
 * Worker pulls the oldest pending request and marks it in_progress.
 * Returns null when the queue has nothing for the worker to do.
 */
export function next(): SidecarRequest | null {
  cleanup();
  // Oldest pending first.
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
 * Worker reports the result. Either `results` (success) or `error`
 * (failure) must be provided; callers shouldn't pass both.
 */
export function complete(opts: {
  id: string;
  results?: SidecarVrboCandidate[];
  error?: string;
}): { ok: boolean; reason?: string } {
  const r = queue.get(opts.id);
  if (!r) return { ok: false, reason: "request not found (already expired?)" };
  if (r.status === "completed" || r.status === "failed") {
    return { ok: false, reason: `request already in terminal state ${r.status}` };
  }
  if (opts.results) {
    r.status = "completed";
    r.results = opts.results;
  } else {
    r.status = "failed";
    r.error = opts.error || "worker reported failure with no message";
  }
  r.completedAt = nowMs();
  return { ok: true };
}

/**
 * Caller (find-buy-in) reads result. Returns the request shape so the
 * caller can branch on status + pick up `results` or `error`.
 */
export function getResult(id: string): SidecarRequest | null {
  cleanup();
  return queue.get(id) ?? null;
}

/**
 * Diagnostic snapshot for /api/admin/vrbo-sidecar/status.
 */
export function getStatus(): {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  oldestPendingAgeSec: number | null;
  newestRequestAt: string | null;
} {
  cleanup();
  let pending = 0, inProgress = 0, completed = 0, failed = 0;
  let oldestPendingAge: number | null = null;
  let newestAt = 0;
  const now = nowMs();
  for (const r of queue.values()) {
    if (r.status === "pending") {
      pending++;
      const age = (now - r.createdAt) / 1000;
      if (oldestPendingAge === null || age > oldestPendingAge) oldestPendingAge = age;
    }
    if (r.status === "in_progress") inProgress++;
    if (r.status === "completed") completed++;
    if (r.status === "failed") failed++;
    if (r.createdAt > newestAt) newestAt = r.createdAt;
  }
  return {
    total: queue.size,
    pending,
    inProgress,
    completed,
    failed,
    oldestPendingAgeSec: oldestPendingAge,
    newestRequestAt: newestAt > 0 ? new Date(newestAt).toISOString() : null,
  };
}

/**
 * Convenience helper for find-buy-in: enqueue + poll up to a wall
 * budget. Returns the candidate list on success, null on
 * timeout/failure (caller falls back to other VRBO paths).
 */
export async function searchVrboViaSidecar(opts: {
  destination: string;
  checkIn: string;
  checkOut: string;
  bedrooms: number;
  pollIntervalMs?: number;
  walletBudgetMs?: number;
}): Promise<{
  candidates: SidecarVrboCandidate[];
  workerOnline: boolean;
  durationMs: number;
  reason: string;
} | null> {
  const startedAt = nowMs();
  const pollMs = opts.pollIntervalMs ?? 2000;
  const walletMs = opts.walletBudgetMs ?? 75_000;
  const { id } = enqueue({
    destination: opts.destination,
    checkIn: opts.checkIn,
    checkOut: opts.checkOut,
    bedrooms: opts.bedrooms,
  });

  while (nowMs() - startedAt < walletMs) {
    const r = getResult(id);
    if (!r) {
      // Request expired (probably no worker online). Fall back.
      return {
        candidates: [],
        workerOnline: false,
        durationMs: nowMs() - startedAt,
        reason: "request expired before completion (worker likely offline)",
      };
    }
    if (r.status === "completed") {
      return {
        candidates: r.results ?? [],
        workerOnline: true,
        durationMs: nowMs() - startedAt,
        reason: `worker returned ${r.results?.length ?? 0} candidates`,
      };
    }
    if (r.status === "failed") {
      return {
        candidates: [],
        workerOnline: true,
        durationMs: nowMs() - startedAt,
        reason: r.error || "worker reported failure",
      };
    }
    await new Promise((res) => setTimeout(res, pollMs));
  }
  // Wall budget exceeded — caller falls back. Don't mark the request
  // failed; the worker may still complete it (and a future identical
  // enqueue will dedupe to the cached result).
  return {
    candidates: [],
    workerOnline: false,
    durationMs: nowMs() - startedAt,
    reason: `wall budget ${walletMs}ms exceeded waiting for worker`,
  };
}
