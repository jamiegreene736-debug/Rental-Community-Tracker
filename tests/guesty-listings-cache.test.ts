// Locks the stale-while-revalidate semantics of the Guesty listing cache
// (server/guesty-listings-cache.ts). The Operations Property dropdown was slow
// because /api/guesty-listings-all and /api/bookings/guesty-all each paginated
// Guesty live on every cold load, serialized behind a 500ms request gate. This
// cache serves the listing set from memory; these tests guarantee it:
//   - dedups concurrent cold-miss fetches into ONE underlying call,
//   - serves last-good instantly while a stale entry refreshes in the background,
//   - never poisons the cache with an empty/partial/errored result,
//   - keys distinct field sets separately,
//   - bounds background-refresh frequency (backoff).
import assert from "node:assert";
// The cache module's SWR core is dependency-free at import time (it lazy-imports
// guestyRequest only inside fetchAllGuestyListings), so a plain static import is
// safe here — no DATABASE_URL / server boot is pulled in.
import {
  createGuestyListingsCache,
  type GuestyListingsResult,
  type GuestyListingsFetchParams,
} from "../server/guesty-listings-cache";

console.log("guesty-listings-cache");

const DROPDOWN_FIELDS = "_id nickname title status";
const OPS_FIELDS = "title nickname name status terms cancellationPolicy";

// `complete` defaults true (a natural-end fetch). Pass false to simulate a
// maxPages-capped / truncated fetch that must NOT be cached.
function result(n: number, complete = true): GuestyListingsResult {
  const results = Array.from({ length: n }, (_, i) => ({ _id: `listing-${i}` }));
  return { results, total: n, reportedTotal: n, returned: n, fetchedPages: 1, complete };
}

// Controllable clock so we can step across the TTL deterministically.
function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function testColdMissCachesAndDedups() {
  let calls = 0;
  const cache = createGuestyListingsCache({
    fetcher: async () => { calls += 1; await tick(); return result(20); },
    ttlMs: 1000,
  });

  // Two concurrent cold-miss reads should share ONE underlying fetch.
  const [a, b] = await Promise.all([
    cache.get({ fields: DROPDOWN_FIELDS }),
    cache.get({ fields: DROPDOWN_FIELDS }),
  ]);
  assert.equal(a.results.length, 20);
  assert.equal(b.results.length, 20);
  assert.equal(calls, 1, "concurrent cold misses must dedup to a single fetch");
  assert.equal(cache.size(), 1, "trustworthy cold-miss result should be cached");

  // A warm hit within TTL must not refetch.
  const c = await cache.get({ fields: DROPDOWN_FIELDS });
  assert.equal(c.results.length, 20);
  assert.equal(calls, 1, "warm hit within TTL must not refetch");
  console.log("  ✓ cold miss caches + concurrent reads dedup to one fetch; warm hit serves memory");
}

async function testStaleWhileRevalidate() {
  const clock = makeClock();
  let calls = 0;
  let nextCount = 20;
  const cache = createGuestyListingsCache({
    fetcher: async () => { calls += 1; await tick(); return result(nextCount); },
    ttlMs: 1000,
    refreshMinIntervalMs: 100,
    clock: clock.now,
  });

  const first = await cache.get({ fields: DROPDOWN_FIELDS });
  assert.equal(first.results.length, 20);
  assert.equal(calls, 1);

  // Past TTL: the next read returns the STALE set immediately and kicks a
  // background refresh that updates the cache to the new value.
  clock.advance(1500);
  nextCount = 31;
  const stale = await cache.get({ fields: DROPDOWN_FIELDS });
  assert.equal(stale.results.length, 20, "stale read must return last-good immediately, not block");
  assert.equal(calls, 2, "stale read must trigger exactly one background refresh");

  await cache.settleRefreshes();
  const refreshed = await cache.get({ fields: DROPDOWN_FIELDS });
  assert.equal(refreshed.results.length, 31, "after background refresh, cache serves the new set");
  assert.equal(calls, 2, "post-refresh read within TTL must not refetch again");
  console.log("  ✓ stale read serves last-good instantly + background refresh updates the entry");
}

async function testFailedRefreshKeepsLastGood() {
  const clock = makeClock();
  let calls = 0;
  let mode: "ok" | "throw" | "empty" | "truncated" = "ok";
  const cache = createGuestyListingsCache({
    fetcher: async () => {
      calls += 1;
      await tick();
      if (mode === "throw") throw new Error("guesty 429");
      if (mode === "empty") return result(0); // transient empty
      if (mode === "truncated") return result(99, /*complete*/ false); // maxPages-capped
      return result(20);
    },
    ttlMs: 1000,
    refreshMinIntervalMs: 100,
    clock: clock.now,
  });

  await cache.get({ fields: DROPDOWN_FIELDS }); // warm: 20

  // A background refresh that THROWS must keep serving last-good.
  clock.advance(1500);
  mode = "throw";
  const afterThrow = await cache.get({ fields: DROPDOWN_FIELDS });
  assert.equal(afterThrow.results.length, 20, "errored refresh must not blank the cache");
  await cache.settleRefreshes();
  assert.equal((await cache.get({ fields: DROPDOWN_FIELDS })).results.length, 20);

  // A background refresh that returns an EMPTY set must not overwrite the good entry.
  clock.advance(1500);
  mode = "empty";
  const beforeEmpty = await cache.get({ fields: DROPDOWN_FIELDS });
  assert.equal(beforeEmpty.results.length, 20);
  await cache.settleRefreshes();
  assert.equal(
    (await cache.get({ fields: DROPDOWN_FIELDS })).results.length,
    20,
    "empty refresh must not overwrite a good non-empty entry",
  );

  // A background refresh that returns a TRUNCATED (incomplete) set — even though
  // non-empty — must not overwrite the good entry either.
  clock.advance(1500);
  mode = "truncated";
  await cache.get({ fields: DROPDOWN_FIELDS });
  await cache.settleRefreshes();
  assert.equal(
    (await cache.get({ fields: DROPDOWN_FIELDS })).results.length,
    20,
    "truncated (incomplete) refresh must not overwrite a good entry with a partial set",
  );
  console.log("  ✓ errored + empty + truncated background refreshes keep last-good (no cache poisoning)");
}

async function testColdMissEmptyNotCached() {
  let calls = 0;
  const cache = createGuestyListingsCache({
    fetcher: async () => { calls += 1; await tick(); return result(0); },
    ttlMs: 1000,
  });
  const r = await cache.get({ fields: DROPDOWN_FIELDS });
  assert.equal(r.results.length, 0, "cold-miss empty is still returned to the caller");
  assert.equal(cache.size(), 0, "a transient empty cold-miss must NOT be cached");
  // Next read retries (still not cached) rather than serving a poisoned empty.
  await cache.get({ fields: DROPDOWN_FIELDS });
  assert.equal(calls, 2, "empty cold-miss is retried on the next read, not served from cache");
  console.log("  ✓ empty cold-miss result is returned but not cached (retries next time)");
}

async function testColdMissTruncatedNotCached() {
  let calls = 0;
  const cache = createGuestyListingsCache({
    // Non-empty but incomplete (maxPages-capped) — a partial set we must not
    // pin as last-good, since it would hide listings for a whole TTL.
    fetcher: async () => { calls += 1; await tick(); return result(50, /*complete*/ false); },
    ttlMs: 1000,
  });
  const r = await cache.get({ fields: DROPDOWN_FIELDS });
  assert.equal(r.results.length, 50, "truncated cold-miss is still returned to the caller");
  assert.equal(cache.size(), 0, "a truncated (incomplete) cold-miss must NOT be cached");
  await cache.get({ fields: DROPDOWN_FIELDS });
  assert.equal(calls, 2, "truncated cold-miss is retried on the next read, not served from cache");
  console.log("  ✓ truncated (incomplete) cold-miss is returned but not cached");
}

async function testDistinctFieldSetsKeyedSeparately() {
  const seen: string[] = [];
  const cache = createGuestyListingsCache({
    fetcher: async (p: GuestyListingsFetchParams) => { seen.push(p.fields ?? ""); await tick(); return result(10); },
    ttlMs: 10_000,
  });
  await cache.get({ fields: DROPDOWN_FIELDS });
  await cache.get({ fields: OPS_FIELDS });
  assert.equal(cache.size(), 2, "different field sets must be cached under different keys");
  assert.equal(seen.length, 2);

  // Same field SET in a different token ORDER must hit the same key (no refetch).
  const reordered = DROPDOWN_FIELDS.split(" ").reverse().join(" ");
  await cache.get({ fields: reordered });
  assert.equal(cache.size(), 2, "reordered-but-identical field set must reuse the existing key");
  assert.equal(seen.length, 2, "reordered field set must not trigger a new fetch");
  console.log("  ✓ distinct field sets keyed separately; token order normalized");
}

async function testRefreshBackoff() {
  // Real config keeps TTL (2min) >> refreshMinInterval (15s), so the first
  // stale read always refreshes immediately and the backoff only throttles
  // REPEATED refreshes. Mirror that here: ttl 1000 < backoff 2000 would delay
  // the first refresh, so use ttl 1000 with backoff 2000 and a FAILING refresh
  // that leaves the entry stale to exercise the throttle.
  const clock = makeClock();
  let calls = 0;
  let failNext = false;
  const cache = createGuestyListingsCache({
    fetcher: async () => {
      calls += 1;
      await tick();
      if (failNext) throw new Error("flaky guesty");
      return result(5);
    },
    ttlMs: 1000,
    refreshMinIntervalMs: 2000,
    clock: clock.now,
  });

  await cache.get({ fields: DROPDOWN_FIELDS }); // cold miss: calls=1, cached
  assert.equal(calls, 1);

  // First stale read past both ttl AND backoff -> refresh #1 (which fails, so
  // the entry stays stale with lastRefreshAt bumped).
  clock.advance(2500);
  failNext = true;
  await cache.get({ fields: DROPDOWN_FIELDS });
  await cache.settleRefreshes();
  assert.equal(calls, 2, "first stale read past the backoff window must refresh once");

  // Still stale, but inside the 2000ms backoff window -> NO new refresh.
  clock.advance(1000);
  await cache.get({ fields: DROPDOWN_FIELDS });
  assert.equal(calls, 2, "a stale read inside the backoff window must not start another refresh");

  // Past the backoff window again -> a refresh is allowed (this one succeeds).
  clock.advance(2000);
  failNext = false;
  await cache.get({ fields: DROPDOWN_FIELDS });
  await cache.settleRefreshes();
  assert.equal(calls, 3, "after the backoff window a stale read may refresh again");
  assert.equal(
    (await cache.get({ fields: DROPDOWN_FIELDS })).results.length,
    5,
    "the successful refresh repopulates the entry and it serves fresh",
  );
  console.log("  ✓ background-refresh backoff bounds refresh frequency on a flaky source");
}

async function testTtlZeroBypass() {
  let calls = 0;
  const cache = createGuestyListingsCache({
    fetcher: async () => { calls += 1; await tick(); return result(9); },
    ttlMs: 1000,
  });
  await cache.get({ fields: DROPDOWN_FIELDS }, 0);
  await cache.get({ fields: DROPDOWN_FIELDS }, 0);
  assert.equal(calls, 2, "ttl<=0 override must bypass the cache and fetch live every time");
  assert.equal(cache.size(), 0, "ttl<=0 reads must not populate the cache");
  console.log("  ✓ ttl<=0 override bypasses the cache (explicit always-fresh escape hatch)");
}

async function testStartSkipBypass() {
  let calls = 0;
  const cache = createGuestyListingsCache({
    fetcher: async () => { calls += 1; await tick(); return result(40); },
    ttlMs: 10_000,
  });
  await cache.get({ fields: DROPDOWN_FIELDS, startSkip: 100 });
  assert.equal(cache.size(), 0, "windowed (startSkip>0) reads must not populate the full-set cache");
  assert.equal(calls, 1);
  console.log("  ✓ startSkip>0 windowed reads bypass the full-set cache");
}

(async () => {
  await testColdMissCachesAndDedups();
  await testStaleWhileRevalidate();
  await testFailedRefreshKeepsLastGood();
  await testColdMissEmptyNotCached();
  await testColdMissTruncatedNotCached();
  await testDistinctFieldSetsKeyedSeparately();
  await testRefreshBackoff();
  await testTtlZeroBypass();
  await testStartSkipBypass();
  console.log("guesty-listings-cache: all passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
