// server/guesty-listings-cache.ts
//
// Stale-while-revalidate (SWR) cache for the FULL Guesty listing set.
//
// Why this exists (see AGENTS.md + Decision Log 2026-06-23): the Operations
// page fires TWO live, uncached, full Guesty listing paginations on every cold
// mount — GET /api/guesty-listings-all (the Property dropdown) and
// GET /api/bookings/guesty-all (which calls fetchOperationsGuestyListings).
// Every Guesty call is serialized through a single global request gate
// (server/guesty-sync.ts, min ~500ms gap), so the two paginations contend with
// each other and with all other Guesty traffic (find-buy-in, inbox, auto-reply).
// The operator's symptom ("I have to leave the tab and come back before the
// dropdown loads") is just the slow in-flight fetch finishing in the background.
//
// This module fetches the listing set once and serves it from memory:
//   - cold miss: await the live fetch, cache only on a TRUSTWORTHY (non-empty,
//     complete) result, and always return whatever we fetched to the caller.
//   - warm hit (within TTL): return instantly.
//   - stale hit (past TTL): return the cached set IMMEDIATELY and kick a single
//     deduped, backoff-bounded background refresh. We never block a request on
//     Guesty once an entry exists, and a failed refresh keeps serving last-good.
//
// LOAD-BEARING invariants (do not "simplify" away):
//   - Only cache the LISTING ROW set. /api/bookings/guesty-all still does its own
//     reservation fetch, includeCanceled second-pass merge, and per-listing buy-in
//     enrichment live — that account-wide coverage is load-bearing (AGENTS.md
//     2026-06-06 "missing Makahuena"). We only swap out the listing pagination.
//   - Different field sets are DIFFERENT cache entries. The dropdown set and the
//     operations set are different supersets; keying them together would silently
//     drop fields that cancellationPolicy / target derivation depend on.
//   - Never overwrite a good non-empty entry with an empty/partial background
//     refresh (transient Guesty rate-limit / partial page would blank the
//     dropdown for a whole TTL otherwise).

// guestyRequest is imported LAZILY inside fetchAllGuestyListings (not at the top
// level): server/guesty-sync.ts pulls in server/index.ts (for `log`), which runs
// the server boot IIFE on import. A static import here would drag the whole boot
// (and a DB connect) into anything that merely imports this cache — including the
// unit test. Deferring it keeps this module's SWR core dependency-free.

export interface GuestyListingsFetchParams {
  fields?: string;
  limit?: number;
  maxPages?: number;
  /** Starting skip offset. >0 is an uncached windowed read (see endpoint). */
  startSkip?: number;
}

export interface GuestyListingsResult {
  results: any[];
  /** Guesty's reported total when known, else results.length. */
  total: number;
  /** Guesty's reported total, or null when Guesty didn't report one. */
  reportedTotal: number | null;
  returned: number;
  fetchedPages: number;
  /**
   * True when pagination reached its NATURAL end — a short last page
   * (rows < limit) or results caught up to Guesty's reported total. False only
   * when the maxPages cap cut us off mid-set (a genuinely truncated fetch). This
   * is the completeness signal `trustworthy()` gates on — NOT an exact
   * results.length === reportedTotal check, which dedup + mid-pagination listing
   * churn make unreliable (a healthy account can land one short and would then
   * never cache, silently reverting to live pagination on every load).
   */
  complete: boolean;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

// Local copies of the routes.ts unwrap/total helpers — kept here to avoid a
// circular import (routes.ts imports this module).
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

/**
 * Page through Guesty's /listings endpoint and return the de-duplicated set.
 * This is the loop that previously lived inline in /api/guesty-listings-all and
 * fetchOperationsGuestyListings; behaviour is preserved verbatim. Success-only:
 * a failed page rejects the whole call (we never return a partial set silently).
 */
export async function fetchAllGuestyListings(
  params: GuestyListingsFetchParams,
): Promise<GuestyListingsResult> {
  const limit = clampInt(params.limit ?? 100, 1, 100);
  const maxPages = clampInt(params.maxPages ?? 50, 1, 100);
  const fields = (params.fields ?? "").trim();
  let skip = Math.max(0, Math.floor(params.startSkip ?? 0));

  const { guestyRequest } = await import("./guesty-sync");

  const results: any[] = [];
  const seen = new Set<string>();
  let fetchedPages = 0;
  let reportedTotal: number | null = null;
  let complete = false;

  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ limit: String(limit), skip: String(skip) });
    if (fields) qs.set("fields", fields);

    const data = (await guestyRequest("GET", `/listings?${qs.toString()}`)) as any;
    const rows = unwrapRows(data);
    reportedTotal ??= listTotal(data);
    fetchedPages += 1;

    for (const row of rows) {
      // Skip rows with no id (matches the previous fetchOperationsGuestyListings
      // behaviour and keeps results.length a clean completeness signal). Guesty
      // listings always carry an _id; the dropdown client filters id-less rows
      // anyway, so this is safe for every caller.
      const id = String(row?._id ?? row?.id ?? "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      results.push(row);
    }

    // Natural end: Guesty gave us a short page, or we've collected the reported
    // total. Either way the set is complete and safe to cache.
    if (rows.length < limit) { complete = true; break; }
    if (reportedTotal && results.length >= reportedTotal) { complete = true; break; }
    skip += limit;
  }
  // If we fell out of the loop on the maxPages cap with full pages throughout,
  // `complete` stays false — a truncated fetch we must not cache as last-good.

  return {
    results,
    total: reportedTotal ?? results.length,
    reportedTotal,
    returned: results.length,
    fetchedPages,
    complete,
  };
}

// ── Field sets the warm + operations callers share ──────────────────────────
// BOOKINGS_DROPDOWN_FIELDS MUST stay token-for-token in sync with the client
// query key in client/src/pages/bookings.tsx (the guestyListings useQuery) so
// the boot warm primes the exact key that page requests. Token ORDER doesn't
// matter (the cache key normalizes by sorting tokens), but the SET must match.
export const BOOKINGS_DROPDOWN_FIELDS =
  "_id nickname title isListed active isActive status bedrooms bedroomsCount bedroomCount beds accommodates personCapacity address.full address.city address.state address.street";

// Used by fetchOperationsGuestyListings (GET /api/bookings/guesty-all). Superset
// of the dropdown set — adds name/bathrooms/terms/cancellationPolicy* that the
// cancellation-policy + listing-target derivation read. Keep verbatim.
export const OPERATIONS_LISTING_FIELDS =
  "title nickname name bedrooms bedroomsCount bedroomCount beds bathrooms accommodates personCapacity address.full address.city address.state address.street status active isActive terms cancellationPolicy cancellationPolicies";

const DEFAULT_TTL_MS = (() => {
  const raw = Number(process.env.GUESTY_LISTINGS_CACHE_TTL_MS ?? 120_000);
  return Number.isFinite(raw) ? Math.max(0, raw) : 120_000;
})();

// Don't spawn a fresh background refresh more often than this per key, even if
// requests keep arriving while an entry is stale — bounds how hard a flaky
// Guesty can be hammered through the shared request gate.
const REFRESH_MIN_INTERVAL_MS = 15_000;

interface CacheEntry {
  data: GuestyListingsResult;
  storedAt: number;
  lastRefreshAt: number;
}

export type GuestyListingsFetcher = (
  params: GuestyListingsFetchParams,
) => Promise<GuestyListingsResult>;

export interface GuestyListingsCacheOptions {
  fetcher: GuestyListingsFetcher;
  ttlMs?: number;
  refreshMinIntervalMs?: number;
  /** Injectable clock — tests advance it to exercise stale transitions. */
  clock?: () => number;
}

export interface GuestyListingsCache {
  get(params: GuestyListingsFetchParams, ttlOverrideMs?: number): Promise<GuestyListingsResult>;
  /** Await any in-flight background refreshes — test seam. */
  settleRefreshes(): Promise<void>;
  /** Number of distinct cached keys — test/inspection seam. */
  size(): number;
}

function normalizeKey(params: GuestyListingsFetchParams): string {
  const limit = clampInt(params.limit ?? 100, 1, 100);
  const maxPages = clampInt(params.maxPages ?? 50, 1, 100);
  const fields = (params.fields ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
  return `${limit}|${maxPages}|${fields}`;
}

// "Trustworthy" = safe to store / safe to overwrite a good entry with: a
// NON-EMPTY fetch that reached its natural end (data.complete). A truncated
// (maxPages-capped) or empty result is transient and must not poison the cache.
// We deliberately do NOT compare results.length to reportedTotal — dedup +
// mid-pagination listing churn make that off by a few on healthy accounts, which
// would stop the entry ever caching and silently revert to live pagination.
function trustworthy(data: GuestyListingsResult): boolean {
  return !!data && data.results.length > 0 && data.complete;
}

/**
 * Build an SWR cache around a listing fetcher. The module exports a default
 * instance bound to fetchAllGuestyListings (getCachedGuestyListings); tests
 * build their own instance with a fake fetcher + clock to lock the semantics.
 */
export function createGuestyListingsCache(opts: GuestyListingsCacheOptions): GuestyListingsCache {
  const fetcher = opts.fetcher;
  const ttlDefault = opts.ttlMs ?? DEFAULT_TTL_MS;
  const refreshMinInterval = opts.refreshMinIntervalMs ?? REFRESH_MIN_INTERVAL_MS;
  const now = opts.clock ?? Date.now;

  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<GuestyListingsResult>>();
  const refreshChains = new Set<Promise<void>>();

  // Single in-flight fetch per key shared by cold-miss awaits AND background
  // refreshes, so concurrent page loads never start more than one Guesty
  // pagination for the same key. Cleared in finally on success and failure.
  function runFetch(key: string, params: GuestyListingsFetchParams): Promise<GuestyListingsResult> {
    const existing = inflight.get(key);
    if (existing) return existing;
    const p = fetcher(params).finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, p);
    return p;
  }

  async function get(
    params: GuestyListingsFetchParams,
    ttlOverrideMs?: number,
  ): Promise<GuestyListingsResult> {
    const ttlMs = ttlOverrideMs ?? ttlDefault;

    if ((params.startSkip ?? 0) > 0 || ttlMs <= 0) {
      // Uncached path: windowed reads aren't representable as a full-set entry,
      // and ttl<=0 is an explicit "always fresh" escape hatch. Still deduped.
      return runFetch(`${normalizeKey(params)}|skip:${params.startSkip ?? 0}`, params);
    }

    const key = normalizeKey(params);
    const entry = cache.get(key);

    if (entry) {
      const t = now();
      const stale = t - entry.storedAt >= ttlMs;
      if (stale && !inflight.has(key) && t - entry.lastRefreshAt >= refreshMinInterval) {
        entry.lastRefreshAt = t;
        const chain = runFetch(key, params)
          .then((fresh) => {
            if (trustworthy(fresh)) {
              cache.set(key, { data: fresh, storedAt: now(), lastRefreshAt: now() });
            }
            // Untrustworthy refresh: keep last-good; lastRefreshAt already
            // bumped so the backoff applies before we try again.
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

    // Cold miss: block on the live fetch, but only cache a trustworthy result.
    // Always return what we fetched (even if empty) so the caller behaves
    // exactly as it did before this cache existed.
    const data = await runFetch(key, params);
    if (trustworthy(data)) {
      cache.set(key, { data, storedAt: now(), lastRefreshAt: now() });
    }
    return data;
  }

  async function settleRefreshes(): Promise<void> {
    // forEach (not spread of .values()) to avoid the repo's ES5-target
    // downlevel-iteration error on Map/Set iterators.
    const pending: Promise<unknown>[] = [];
    inflight.forEach((p) => pending.push(p));
    refreshChains.forEach((p) => pending.push(p));
    await Promise.allSettled(pending);
  }

  return { get, settleRefreshes, size: () => cache.size };
}

// Default process-wide instance, bound to the real Guesty fetcher.
const defaultCache = createGuestyListingsCache({ fetcher: fetchAllGuestyListings });

/**
 * SWR-cached read of the full Guesty listing set. See module header for the
 * cold-miss / warm / stale semantics.
 */
export function getCachedGuestyListings(
  params: GuestyListingsFetchParams,
  ttlMs?: number,
): Promise<GuestyListingsResult> {
  return defaultCache.get(params, ttlMs);
}

/**
 * Boot-time warm of the two keys the Operations page hits on mount, so the
 * operator's first load reads from memory instead of paying for two serialized
 * Guesty paginations. Fire-and-forget; every failure is swallowed so a Guesty
 * outage / rate-limit at boot can never crash startup.
 */
export async function warmGuestyListingsCache(): Promise<void> {
  const targets: GuestyListingsFetchParams[] = [
    { fields: BOOKINGS_DROPDOWN_FIELDS, limit: 100, maxPages: 50 },
    { fields: OPERATIONS_LISTING_FIELDS, limit: 100, maxPages: 100 },
  ];
  for (const target of targets) {
    try {
      await getCachedGuestyListings(target);
    } catch (err: any) {
      console.warn(
        `[guesty-listings-cache] boot warm failed for fields="${(target.fields ?? "").slice(0, 40)}…": ${err?.message ?? err}`,
      );
    }
  }
}
