// server/guesty-reservations-cache.ts
//
// Stale-while-revalidate (SWR) cache for paginated Guesty /reservations pulls.
//
// Why this exists (2026-07-21 dashboard/operations speed incident): live edge
// logs showed GET /api/bookings/guesty-all at ~87s and the dashboard coverage
// endpoints (payment-failures, buyin-coverage, arrival-details-coverage,
// minimum-stays, channel-status) at 120-136s PER REQUEST. Every one of those
// re-paginated the account's reservations live through the global Guesty
// request gate (server/guesty-sync.ts — min ~500ms gap between calls, plus an
// up-to-120s shared pause after any 429), and because they fire concurrently
// on a dashboard/operations load their pagination loops serialize behind each
// other. The listing set was already SWR-cached (guesty-listings-cache.ts);
// the reservation pull was the missing half.
//
// Semantics mirror guesty-listings-cache.ts deliberately (same operator-facing
// guarantees, same test shape):
//   - cold miss: await the live pagination, cache only a TRUSTWORTHY
//     (non-empty, complete) result, always return whatever was fetched.
//   - warm hit (within TTL, default 60s): return instantly.
//   - stale hit: return last-good IMMEDIATELY and kick one deduped,
//     backoff-bounded background refresh. A failed/partial refresh keeps
//     serving last-good — a transient Guesty 429 can never blank the
//     Operations table or a dashboard popup.
//
// LOAD-BEARING invariants (do not "simplify" away):
//   - The cache stores RAW reservation rows, BEFORE the route-level
//     isRenderable/isCommitted filtering. That's what lets the
//     includeCanceled=false and =true variants of the SAME pull share one
//     cache entry (the route filters after), and it keeps the account-wide
//     coverage rule (AGENTS.md 2026-06-06 "missing Makahuena") intact: what
//     Guesty returned is what the route sees, just up to TTL_MS old.
//   - Only a COMPLETE (natural pagination end) non-empty pull is cached.
//     A maxRows-truncated or empty result is returned to the caller but never
//     stored — partial data must not become "last-good".
//   - Buy-in slot enrichment is NOT cached here. Attach/detach must reflect
//     immediately (the client invalidates guesty-all right after attaching),
//     so the route re-runs its DB-only enrichment on every request against
//     the cached rows.

export interface GuestyReservationsFetchParams {
  /** Pre-encoded `filters=...&` query prefix, or "" for an unfiltered pull. */
  filterQuery: string;
  /** Raw space-separated fields list (encoded at fetch time). */
  fields: string;
  sort: string;
  limit: number;
  maxRows: number;
}

export interface GuestyReservationsResult {
  rows: any[];
  fetchedPages: number;
  /**
   * True when pagination reached its NATURAL end — a short last page or rows
   * caught up to Guesty's reported total. False only when the maxRows cap cut
   * the pull off mid-set; `trustworthy()` refuses to cache that.
   */
  complete: boolean;
}

function unwrapRows(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.data?.results)) return data.data.results;
  return [];
}

function listTotal(data: any): number | null {
  const raw = data?.total ?? data?.count ?? data?.data?.total ?? data?.data?.count;
  const num = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(num) && num > 0 ? num : null;
}

// The exact reservation fields GET /api/bookings/guesty-all requests (see the
// guestsCount/numberOfGuests note there). Exported so routes.ts and the boot
// warm reference ONE string — if they drifted, the warm would prime a key the
// page never reads.
export const OPERATIONS_RESERVATION_FIELDS =
  "_id status createdAt checkIn checkOut checkInDateLocalized checkOutDateLocalized nightsCount guest guestsCount numberOfGuests money payments source integration confirmationCode preApproveState listing listingId terms cancellationPolicy cancellationPolicies cancellationPolicyText cancellationPolicyDescription cancellationPolicyName cancelationPolicy";

/**
 * Page through /reservations and return the de-duplicated raw row set. This is
 * the loop that previously lived inline in /api/bookings/guesty-all (both
 * passes) and /api/bookings/listing/:listingId; pagination behaviour is
 * preserved verbatim. Success-only: a failed page rejects the whole call.
 */
export async function fetchGuestyReservationPages(
  params: GuestyReservationsFetchParams,
): Promise<GuestyReservationsResult> {
  const { guestyRequest } = await import("./guesty-sync");
  const limit = Math.min(Math.max(Math.floor(params.limit) || 100, 1), 100);
  const maxRows = Math.max(Math.floor(params.maxRows) || limit, limit);
  const fields = encodeURIComponent(params.fields.trim());

  const rows: any[] = [];
  const seen = new Set<string>();
  let fetchedPages = 0;
  let complete = false;

  for (let skip = 0; skip < maxRows; skip += limit) {
    const data = (await guestyRequest(
      "GET",
      `/reservations?${params.filterQuery}limit=${limit}&skip=${skip}&sort=${params.sort}&fields=${fields}`,
    )) as any;
    const pageRows = unwrapRows(data);
    fetchedPages += 1;
    for (const row of pageRows) {
      const id = String(row?._id ?? row?.id ?? "").trim();
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      rows.push(row);
    }
    const total = listTotal(data);
    if (pageRows.length < limit || (total && skip + pageRows.length >= total)) {
      complete = true;
      break;
    }
  }

  return { rows, fetchedPages, complete };
}

const DEFAULT_TTL_MS = (() => {
  const raw = Number(process.env.GUESTY_RESERVATIONS_CACHE_TTL_MS ?? 60_000);
  return Number.isFinite(raw) ? Math.max(0, raw) : 60_000;
})();

// Same backoff rule as the listings cache: never spawn background refreshes
// for one key more often than this, no matter how fast requests arrive.
const REFRESH_MIN_INTERVAL_MS = 15_000;

// Filter queries embed dates (today / rolling windows), so keys roll over
// daily. Cap the map so a long-lived process can't accumulate stale keys.
const MAX_CACHE_KEYS = 24;

interface CacheEntry {
  data: GuestyReservationsResult;
  storedAt: number;
  lastRefreshAt: number;
}

export type GuestyReservationsFetcher = (
  params: GuestyReservationsFetchParams,
) => Promise<GuestyReservationsResult>;

export interface GuestyReservationsCacheOptions {
  fetcher: GuestyReservationsFetcher;
  ttlMs?: number;
  refreshMinIntervalMs?: number;
  maxKeys?: number;
  /** Injectable clock — tests advance it to exercise stale transitions. */
  clock?: () => number;
}

export interface GuestyReservationsCache {
  get(params: GuestyReservationsFetchParams, ttlOverrideMs?: number): Promise<GuestyReservationsResult>;
  /** Await any in-flight background refreshes — test seam. */
  settleRefreshes(): Promise<void>;
  /** Number of distinct cached keys — test/inspection seam. */
  size(): number;
}

function normalizeKey(params: GuestyReservationsFetchParams): string {
  const fields = params.fields.trim().split(/\s+/).filter(Boolean).sort().join(" ");
  return `${params.sort}|${params.limit}|${params.maxRows}|${fields}|${params.filterQuery}`;
}

// Trustworthy = safe to store / safe to overwrite last-good with: non-empty
// AND the pagination reached its natural end. Matches the listings cache.
function trustworthy(data: GuestyReservationsResult): boolean {
  return !!data && data.rows.length > 0 && data.complete;
}

export function createGuestyReservationsCache(
  opts: GuestyReservationsCacheOptions,
): GuestyReservationsCache {
  const fetcher = opts.fetcher;
  const ttlDefault = opts.ttlMs ?? DEFAULT_TTL_MS;
  const refreshMinInterval = opts.refreshMinIntervalMs ?? REFRESH_MIN_INTERVAL_MS;
  const maxKeys = opts.maxKeys ?? MAX_CACHE_KEYS;
  const now = opts.clock ?? Date.now;

  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<GuestyReservationsResult>>();
  const refreshChains = new Set<Promise<void>>();

  function store(key: string, data: GuestyReservationsResult) {
    cache.set(key, { data, storedAt: now(), lastRefreshAt: now() });
    // Evict oldest entries past the cap (date-rolled keys from prior days).
    while (cache.size > maxKeys) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      cache.forEach((entry, k) => {
        if (entry.storedAt < oldestAt) { oldestAt = entry.storedAt; oldestKey = k; }
      });
      if (oldestKey == null) break;
      cache.delete(oldestKey);
    }
  }

  // One in-flight fetch per key, shared by cold-miss awaits AND background
  // refreshes — concurrent dashboard endpoints hitting the same pull never
  // start more than one Guesty pagination.
  function runFetch(key: string, params: GuestyReservationsFetchParams): Promise<GuestyReservationsResult> {
    const existing = inflight.get(key);
    if (existing) return existing;
    const p = fetcher(params).finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, p);
    return p;
  }

  async function get(
    params: GuestyReservationsFetchParams,
    ttlOverrideMs?: number,
  ): Promise<GuestyReservationsResult> {
    const ttlMs = ttlOverrideMs ?? ttlDefault;
    const key = normalizeKey(params);

    if (ttlMs <= 0) {
      // Explicit always-fresh escape hatch; still deduped against itself.
      return runFetch(key, params);
    }

    const entry = cache.get(key);
    if (entry) {
      const t = now();
      const stale = t - entry.storedAt >= ttlMs;
      if (stale && !inflight.has(key) && t - entry.lastRefreshAt >= refreshMinInterval) {
        entry.lastRefreshAt = t;
        const chain = runFetch(key, params)
          .then((fresh) => {
            if (trustworthy(fresh)) store(key, fresh);
            // Untrustworthy refresh: keep last-good; lastRefreshAt already
            // bumped so the backoff applies before the next attempt.
          })
          .catch(() => {
            /* keep serving last-good */
          })
          .finally(() => {
            refreshChains.delete(chain);
          });
        refreshChains.add(chain);
      }
      return entry.data;
    }

    // Cold miss: block on the live pull; cache only a trustworthy result but
    // always return what we fetched so callers behave exactly as before.
    const data = await runFetch(key, params);
    if (trustworthy(data)) store(key, data);
    return data;
  }

  async function settleRefreshes(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    inflight.forEach((p) => pending.push(p));
    refreshChains.forEach((p) => pending.push(p));
    await Promise.allSettled(pending);
  }

  return { get, settleRefreshes, size: () => cache.size };
}

// Default process-wide instance bound to the real Guesty pagination.
const defaultCache = createGuestyReservationsCache({ fetcher: fetchGuestyReservationPages });

export function getCachedGuestyReservations(
  params: GuestyReservationsFetchParams,
  ttlMs?: number,
): Promise<GuestyReservationsResult> {
  return defaultCache.get(params, ttlMs);
}

/**
 * The exact main-pass pull GET /api/bookings/guesty-all runs for its default
 * query (includePast=false → checkOut >= today). Shared by the route and the
 * boot warm so the warm primes the key the Operations page actually reads.
 */
export function defaultOperationsReservationParams(todayIso: string): GuestyReservationsFetchParams {
  const filterArr = [{ field: "checkOut", operator: "$gte", value: todayIso }];
  return {
    filterQuery: `filters=${encodeURIComponent(JSON.stringify(filterArr))}&`,
    fields: OPERATIONS_RESERVATION_FIELDS,
    sort: "checkIn",
    limit: 100,
    maxRows: 5000,
  };
}

/**
 * Boot-time warm of the default Operations reservation pull, so the
 * operator's first bookings-page load after a deploy reads from memory
 * instead of paying the full serialized Guesty pagination. Fire-and-forget;
 * failures are swallowed (a Guesty outage at boot must never crash startup).
 */
export async function warmOperationsReservationsCache(): Promise<void> {
  try {
    const todayIso = new Date().toISOString().slice(0, 10);
    await getCachedGuestyReservations(defaultOperationsReservationParams(todayIso));
  } catch (err: any) {
    console.warn(`[guesty-reservations-cache] boot warm failed: ${err?.message ?? err}`);
  }
}
