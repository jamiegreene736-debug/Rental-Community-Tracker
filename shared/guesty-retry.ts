// Guesty 429 retry policy (operator incident 2026-07-20: the Operations tab
// failed to load with "500: Failed to fetch bookings — Guesty 429 on GET
// /reservations…"). guestyRequest serializes every Guesty call through a
// global gate and PAUSES future requests when a 429 lands — but the request
// that RECEIVED the 429 was thrown immediately, so any interactive endpoint
// unlucky enough to hit the rate-limit window surfaced a hard 500. A 429
// means Guesty did NOT process the request, so re-issuing after the pause is
// safe for every method (including PUT/POST).
//
// Pure so tests can exercise the policy without the server's DB imports.

/** Default number of in-place retries after a 429 (attempts = retries + 1). */
export const DEFAULT_GUESTY_429_RETRIES = 2;

/** Total attempts for one guestyRequest call, from the env override. */
export function guesty429MaxAttempts(envValue?: string | null): number {
  const n = Number(String(envValue ?? "").trim() || NaN);
  const retries = Number.isFinite(n) && n >= 0 ? Math.min(n, 5) : DEFAULT_GUESTY_429_RETRIES;
  return 1 + retries;
}

/**
 * Retry-After header → milliseconds to pause, capped at 120s (the same cap
 * the request gate has always used). Accepts both delta-seconds and HTTP-date
 * forms; null when absent/unparseable (caller falls back to 15s).
 */
export function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 120000);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, Math.min(dateMs - Date.now(), 120000));
  return null;
}

/** Pause applied after a 429 before the next attempt may fire. */
export function guesty429PauseMs(retryAfterMs: number | null): number {
  return retryAfterMs ?? 15000;
}

/** True when this 429 should be retried in place rather than thrown. */
export function shouldRetryGuesty429(status: number, attempt: number, maxAttempts: number): boolean {
  return status === 429 && attempt < maxAttempts;
}
