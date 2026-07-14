// Bounded retry for fetch calls that can hit a TRANSIENT edge failure —
// Railway returns 502/503/504 with "connection refused" upstream errors while
// a deploy swaps containers (the 2026-07-14 photo-dedupe-apply incident: the
// operator clicked "Remove 6 selected photos" 66s after a deploy was created
// and the request died at the edge without ever reaching the app), and Safari
// occasionally drops a connection outright (TypeError: Load failed).
//
// ONLY use this for requests that are SAFE to repeat:
//   - reads, and
//   - idempotent writes (the photo-dedupe apply/restore soft-delete flips
//     photo_labels.hidden to a fixed value — applying twice is a no-op, and
//     the apply is additionally validated server-side against the stored scan).
// NEVER wrap a non-idempotent push with this — those reconcile against the
// durable push ledger instead (shared/push-reconcile.ts, PR #1039/#1040).
//
// Retrying does NOT try to outlast a full deploy blackout (that's fixed at the
// source by railway.json healthcheckPath — see AGENTS.md "Deploy healthcheck");
// it absorbs single-request blips. After a real container swap the dedupe
// retry lands on the NEW process, whose in-memory scan store is empty, and the
// server answers the designed 410 "scan expired — rescan" — an honest outcome,
// never a blind apply.

/** Statuses the Railway edge emits when the app container isn't reachable. */
export const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

export function isTransientHttpStatus(status: number): boolean {
  return TRANSIENT_HTTP_STATUSES.has(status);
}

/** 2s, 4s, 8s… capped at 8s so the worst case stays glanceable, not minutes. */
export function transientRetryDelayMs(attempt: number): number {
  const base = 2_000 * Math.pow(2, Math.max(0, attempt));
  return Math.min(base, 8_000);
}

export type TransientRetryOpts = {
  /** Total attempts including the first one. Default 3. */
  attempts?: number;
  /** Injectable for tests. Defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
};

type MinimalResponse = { status: number };

/**
 * Runs `doFetch` up to `attempts` times, retrying when it throws (network
 * error / dropped connection) or resolves with a transient 5xx status.
 * Non-transient statuses (200, 410, 422, …) return immediately — the caller
 * owns their meaning. Exhausted retries return the last transient response,
 * or rethrow the last error, so the caller's error handling is unchanged.
 */
export async function fetchWithTransientRetry<T extends MinimalResponse>(
  doFetch: () => Promise<T>,
  opts: TransientRetryOpts = {},
): Promise<T> {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? 3));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: unknown = null;
  let lastResponse: T | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(transientRetryDelayMs(attempt - 1));
    try {
      const res = await doFetch();
      if (!isTransientHttpStatus(res.status)) return res;
      lastResponse = res;
      lastError = null;
    } catch (err) {
      lastError = err;
      lastResponse = null;
    }
  }
  if (lastResponse) return lastResponse;
  throw lastError;
}
