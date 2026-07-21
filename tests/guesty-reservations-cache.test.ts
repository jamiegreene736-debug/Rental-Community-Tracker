// Locks the SWR semantics of the Guesty RESERVATIONS cache
// (server/guesty-reservations-cache.ts) plus the wiring that made the
// 2026-07-21 dashboard/operations speed fix real. Live edge logs showed
// GET /api/bookings/guesty-all at ~87s and the dashboard coverage endpoints at
// 120-136s per request — every one re-paginated /reservations through the
// serialized Guesty gate on every load. These tests guarantee:
//   - SWR core: cold-miss dedup + cache, warm hit, stale-serve + background
//     refresh, no cache poisoning from empty/truncated/errored refreshes,
//     key-cap eviction.
//   - Source wiring: guesty-all (both passes) + the per-listing endpoint pull
//     through the cache; buy-in enrichment is ONE batched query (the N+1 is
//     gone); revenue-30-days + payment-failures serve SWR-cached payloads;
//     channel-status + minimum-stays read the cached listing set; the boot
//     warm primes the operations key; the bookings client keeps previous rows
//     while refetching.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
// Safe static import: the module lazy-imports guestyRequest only inside
// fetchGuestyReservationPages, so no server boot / DATABASE_URL is pulled in.
import {
  createGuestyReservationsCache,
  defaultOperationsReservationParams,
  OPERATIONS_RESERVATION_FIELDS,
  type GuestyReservationsFetchParams,
  type GuestyReservationsResult,
} from "../server/guesty-reservations-cache";

console.log("guesty-reservations-cache");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

function params(filterQuery: string, extra?: Partial<GuestyReservationsFetchParams>): GuestyReservationsFetchParams {
  return {
    filterQuery,
    fields: "_id status checkIn",
    sort: "checkIn",
    limit: 100,
    maxRows: 5000,
    ...extra,
  };
}

function result(n: number, complete = true): GuestyReservationsResult {
  return {
    rows: Array.from({ length: n }, (_, i) => ({ _id: `res-${i}` })),
    fetchedPages: 1,
    complete,
  };
}

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function testColdMissCachesAndDedups() {
  let calls = 0;
  const cache = createGuestyReservationsCache({
    fetcher: async () => { calls += 1; await tick(); return result(150); },
    ttlMs: 1000,
  });

  const [a, b] = await Promise.all([
    cache.get(params("filters=x&")),
    cache.get(params("filters=x&")),
  ]);
  assert.equal(a.rows.length, 150);
  assert.equal(b.rows.length, 150);
  assert.equal(calls, 1, "concurrent cold misses must dedup to a single pull");
  assert.equal(cache.size(), 1);

  const c = await cache.get(params("filters=x&"));
  assert.equal(c.rows.length, 150);
  assert.equal(calls, 1, "warm hit within TTL must not refetch");
  console.log("  ✓ cold miss caches + concurrent reads dedup; warm hit serves memory");
}

async function testStaleServesLastGoodAndRefreshes() {
  const clock = makeClock();
  let calls = 0;
  let nextCount = 150;
  const cache = createGuestyReservationsCache({
    fetcher: async () => { calls += 1; await tick(); return result(nextCount); },
    ttlMs: 1000,
    refreshMinIntervalMs: 100,
    clock: clock.now,
  });

  assert.equal((await cache.get(params("filters=x&"))).rows.length, 150);
  assert.equal(calls, 1);

  clock.advance(1500);
  nextCount = 175;
  const stale = await cache.get(params("filters=x&"));
  assert.equal(stale.rows.length, 150, "stale read must return last-good IMMEDIATELY");
  await cache.settleRefreshes();
  assert.equal(calls, 2, "stale read must kick exactly one background refresh");
  const fresh = await cache.get(params("filters=x&"));
  assert.equal(fresh.rows.length, 175, "next read serves the refreshed set");
  console.log("  ✓ stale hit serves last-good instantly + background-refreshes once");
}

async function testUntrustworthyRefreshKeepsLastGood() {
  const clock = makeClock();
  let calls = 0;
  const outputs: GuestyReservationsResult[] = [
    result(150),          // cold: good
    result(0),            // refresh 1: empty — must not overwrite
    result(80, false),    // refresh 2: truncated — must not overwrite
  ];
  const cache = createGuestyReservationsCache({
    fetcher: async () => { const out = outputs[Math.min(calls, outputs.length - 1)]; calls += 1; await tick(); return out; },
    ttlMs: 1000,
    refreshMinIntervalMs: 0,
    clock: clock.now,
  });

  await cache.get(params("filters=x&"));
  clock.advance(1500);
  await cache.get(params("filters=x&"));
  await cache.settleRefreshes();
  assert.equal((await cache.get(params("filters=x&"))).rows.length, 150, "empty refresh must keep last-good");
  clock.advance(1500);
  await cache.get(params("filters=x&"));
  await cache.settleRefreshes();
  assert.equal((await cache.get(params("filters=x&"))).rows.length, 150, "truncated refresh must keep last-good");
  console.log("  ✓ empty/truncated refreshes never poison last-good");
}

async function testErroredRefreshKeepsLastGood() {
  const clock = makeClock();
  let calls = 0;
  const cache = createGuestyReservationsCache({
    fetcher: async () => {
      calls += 1;
      await tick();
      if (calls > 1) throw new Error("guesty 429");
      return result(150);
    },
    ttlMs: 1000,
    refreshMinIntervalMs: 0,
    clock: clock.now,
  });
  await cache.get(params("filters=x&"));
  clock.advance(1500);
  const served = await cache.get(params("filters=x&"));
  assert.equal(served.rows.length, 150);
  await cache.settleRefreshes();
  assert.equal((await cache.get(params("filters=x&"))).rows.length, 150, "errored refresh must keep serving last-good");
  console.log("  ✓ errored refresh keeps serving last-good (429 can't blank the table)");
}

async function testColdEmptyNotCachedAndColdErrorPropagates() {
  let calls = 0;
  const cache = createGuestyReservationsCache({
    fetcher: async () => { calls += 1; await tick(); return result(0); },
    ttlMs: 1000,
  });
  assert.equal((await cache.get(params("filters=x&"))).rows.length, 0, "cold empty result still returned to caller");
  assert.equal(cache.size(), 0, "empty result must NOT be cached");
  await cache.get(params("filters=x&"));
  assert.equal(calls, 2, "uncached empty result refetches next time");

  const failing = createGuestyReservationsCache({
    fetcher: async () => { throw new Error("boom"); },
    ttlMs: 1000,
  });
  await assert.rejects(() => failing.get(params("filters=x&")), /boom/, "cold-path errors propagate (honest 500)");
  console.log("  ✓ cold empty isn't cached; cold errors propagate");
}

async function testDistinctKeysAndEviction() {
  const clock = makeClock();
  let calls = 0;
  const cache = createGuestyReservationsCache({
    fetcher: async () => { calls += 1; await tick(); return result(10); },
    ttlMs: 60_000,
    maxKeys: 3,
    clock: clock.now,
  });
  for (let i = 0; i < 5; i++) {
    clock.advance(10);
    await cache.get(params(`filters=day-${i}&`));
  }
  assert.equal(calls, 5, "distinct filter queries are distinct keys");
  assert.ok(cache.size() <= 3, `key cap must evict oldest entries (size=${cache.size()})`);
  // The newest key must survive eviction.
  await cache.get(params("filters=day-4&"));
  assert.equal(calls, 5, "newest key survived eviction");
  console.log("  ✓ distinct filters key separately; key cap evicts oldest");
}

// ── Source wiring guards ─────────────────────────────────────────────────────

function testRoutesWiring() {
  const routes = read("server/routes.ts");

  // guesty-all: both passes ride the cache; the old inline pagination loops
  // over /reservations are gone from the handler region.
  const guestyAllStart = routes.indexOf('app.get("/api/bookings/guesty-all"');
  assert.ok(guestyAllStart > 0, "guesty-all route present");
  const guestyAllBody = routes.slice(guestyAllStart, guestyAllStart + 9000);
  assert.ok(
    (guestyAllBody.match(/getCachedGuestyReservations\(/g) ?? []).length >= 2,
    "guesty-all must pull BOTH passes (main + canceled) through getCachedGuestyReservations",
  );
  assert.ok(
    !/guestyRequest\("GET", `\/reservations\?/.test(guestyAllBody),
    "guesty-all must not paginate /reservations directly any more",
  );
  assert.ok(
    guestyAllBody.includes("getBuyInsByReservationIds"),
    "guesty-all enrichment must use the ONE batched buy-ins query",
  );
  assert.ok(
    guestyAllBody.includes("OPERATIONS_RESERVATION_FIELDS"),
    "guesty-all must use the shared fields constant (boot warm keys off it)",
  );

  // per-listing endpoint rides the same cache + batch.
  const listingStart = routes.indexOf('app.get("/api/bookings/listing/:listingId"');
  assert.ok(listingStart > 0);
  const listingBody = routes.slice(listingStart, listingStart + 7000);
  assert.ok(listingBody.includes("getCachedGuestyReservations("), "per-listing endpoint must use the reservations cache");
  assert.ok(listingBody.includes("getBuyInsByReservationIds"), "per-listing enrichment must batch buy-ins");

  // The enrichment helper accepts the pre-batched map (N+1 fallback only for
  // single-reservation callers).
  assert.ok(
    routes.includes("attachedByReservation?: Record<string, any[]>"),
    "enrichGuestyReservationForOperations must accept the batched buy-ins map",
  );

  // revenue-30-days + payment-failures are SWR-cached: compute extracted,
  // handler serves last-good + background refresh, ?fresh=1 escape hatch.
  for (const marker of [
    "computeDashboardRevenue30Days",
    "revenue30dCache",
    "kickRevenue30dRefresh",
    "computePaymentFailures",
    "paymentFailuresCache",
    "kickPaymentFailuresRefresh",
  ]) {
    assert.ok(routes.includes(marker), `routes.ts must keep the SWR cache marker "${marker}"`);
  }

  // channel-status + minimum-stays read the SWR listing cache instead of a
  // live Guesty /listings call.
  const channelStart = routes.indexOf('app.get("/api/dashboard/channel-status"');
  const channelBody = routes.slice(channelStart, channelStart + 2500);
  assert.ok(channelBody.includes("getCachedGuestyListings("), "channel-status must read the cached listing set");
  const minStayStart = routes.indexOf('app.get("/api/dashboard/minimum-stays"');
  const minStayBody = routes.slice(minStayStart, minStayStart + 2500);
  assert.ok(minStayBody.includes("getCachedGuestyListings("), "minimum-stays must read the cached listing set");

  console.log("  ✓ routes.ts wiring: cached pulls, batched buy-ins, SWR dashboard payloads");
}

function testBootWarmAndClientWiring() {
  const index = read("server/index.ts");
  assert.ok(
    index.includes("warmOperationsReservationsCache"),
    "server boot must warm the default Operations reservation pull",
  );

  // The warm params must match the route's default pull exactly.
  const p = defaultOperationsReservationParams("2026-07-21");
  assert.equal(p.fields, OPERATIONS_RESERVATION_FIELDS);
  assert.equal(p.sort, "checkIn");
  assert.equal(p.limit, 100);
  assert.equal(p.maxRows, 5000);
  assert.ok(p.filterQuery.startsWith("filters="));
  assert.ok(decodeURIComponent(p.filterQuery).includes('"checkOut"'), "warm filter must be the checkOut>=today default");

  const storage = read("server/storage.ts");
  assert.ok(storage.includes("async getBuyInsByReservationIds"), "storage must expose the batched buy-ins query");

  const bookings = read("client/src/pages/bookings.tsx");
  assert.ok(
    (bookings.match(/placeholderData: \(prev: any\) => prev/g) ?? []).length >= 2,
    "both bookings-page reservation queries must keep previous rows while refetching",
  );
  console.log("  ✓ boot warm + storage batch + client placeholderData wiring intact");
}

async function main() {
  await testColdMissCachesAndDedups();
  await testStaleServesLastGoodAndRefreshes();
  await testUntrustworthyRefreshKeepsLastGood();
  await testErroredRefreshKeepsLastGood();
  await testColdEmptyNotCachedAndColdErrorPropagates();
  await testDistinctKeysAndEviction();
  testRoutesWiring();
  testBootWarmAndClientWiring();
  console.log("guesty-reservations-cache: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
