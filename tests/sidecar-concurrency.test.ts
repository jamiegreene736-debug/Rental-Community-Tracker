import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";

const {
  clearSidecarQueue,
  enqueueOp,
  getStatus,
  next,
  resumeQueue,
} = await import("../server/vrbo-sidecar-queue");

const buyInQueueContext = {
  scanLabel: "3BR Poipu Kai buy-in scan",
  providerLabel: "Booking.com",
  unitLabel: "3BR unit",
  dateLabel: "2026-07-10 to 2026-07-17",
  detail: "test buy-in provider concurrency",
};

function resetQueue() {
  resumeQueue();
  clearSidecarQueue("sidecar concurrency test reset");
}

resetQueue();

enqueueOp({
  opType: "booking_search",
  params: {
    destination: "Poipu Kai",
    searchTerm: "Poipu Kai",
    checkIn: "2026-07-10",
    checkOut: "2026-07-17",
    bedrooms: 3,
    queueContext: { ...buyInQueueContext, providerLabel: "Booking.com" },
  },
});

enqueueOp({
  opType: "vrbo_search",
  params: {
    destination: "Poipu Kai",
    searchTerm: "Poipu Kai",
    checkIn: "2026-07-10",
    checkOut: "2026-07-17",
    bedrooms: 3,
    queueContext: { ...buyInQueueContext, providerLabel: "VRBO" },
  },
});

const firstClaim = next({ slot: "1", workerRole: "local", browserMode: "cdp", chromePrimary: "local" });
const secondClaim = next({ slot: "2", workerRole: "local", browserMode: "cdp", chromePrimary: "local" });

assert.ok(firstClaim, "first worker should claim the first provider search");
assert.ok(secondClaim, "second worker should claim the other provider search");
assert.notEqual(firstClaim.id, secondClaim.id, "workers must claim separate requests");
assert.deepEqual(
  [firstClaim.opType, secondClaim.opType].sort(),
  ["booking_search", "vrbo_search"],
  "Booking.com and VRBO buy-in searches should be claimable concurrently",
);
assert.equal(getStatus().inProgress, 2, "both provider searches should be in progress at once");

resetQueue();

enqueueOp({
  opType: "booking_search",
  params: {
    destination: "Poipu Kai",
    searchTerm: "Poipu Kai",
    checkIn: "2026-07-10",
    checkOut: "2026-07-17",
    bedrooms: 3,
    queueContext: { ...buyInQueueContext, providerLabel: "Booking.com" },
  },
});

enqueueOp({
  opType: "booking_search",
  params: {
    destination: "Poipu Kai",
    searchTerm: "Poipu Kai Villas",
    checkIn: "2026-07-10",
    checkOut: "2026-07-17",
    bedrooms: 3,
    queueContext: { ...buyInQueueContext, providerLabel: "Booking.com" },
  },
});

const bookingClaim = next({ slot: "1", workerRole: "local", browserMode: "cdp", chromePrimary: "local" });
const blockedSameProviderClaim = next({ slot: "2", workerRole: "local", browserMode: "cdp", chromePrimary: "local" });

assert.equal(bookingClaim?.opType, "booking_search");
assert.equal(blockedSameProviderClaim, null, "same-provider buy-in searches should stay single-file by default");

resetQueue();

next({ slot: "1", workerRole: "local", browserMode: "cdp", chromePrimary: "local" });

enqueueOp({
  opType: "vrbo_search",
  params: {
    destination: "Poipu Kai",
    searchTerm: "Poipu Kai",
    checkIn: "2026-07-10",
    checkOut: "2026-07-17",
    bedrooms: 3,
    queueContext: { ...buyInQueueContext, providerLabel: "VRBO" },
  },
});

const serverClaimAfterIdleLocalPoll = next({ slot: "2", workerRole: "server", browserMode: "cdp", chromePrimary: "server" });
assert.equal(
  serverClaimAfterIdleLocalPoll?.opType,
  "vrbo_search",
  "idle local heartbeat polls must not block Railway workers from claiming OTA work",
);

resetQueue();

// ── Cautious same-IP VRBO concurrency (2026-06-14) ───────────────────────────
// The "vrbo_search" group default limit is SIDECAR_VRBO_CONCURRENCY (default 2):
// when VRBO looks healthy, two VRBO ops run concurrently from the one IP (the
// nearby-expansion / multi-unit speedup). The instant VRBO pushes back (a block
// cooldown OR any recent consecutive failure) opConcurrencyLimit drops back to 1
// — the same single value SIDECAR_VRBO_CONCURRENCY=1 forces — so we never sustain
// a high request rate against a rate-limiting IP. The adaptive `backingOff` branch
// is logic-identical to the env=1 branch below (both → limit 1) and is monitored
// live via the recordProviderFailure cooldown log.
{
  // Two DISTINCT foreground VRBO searches (distinct params → not deduped).
  const enqueueTwoVrbo = () => {
    enqueueOp({
      opType: "vrbo_search",
      params: {
        destination: "Poipu Kai", searchTerm: "Poipu Kai", checkIn: "2026-07-10", checkOut: "2026-07-17",
        bedrooms: 3, queueContext: { ...buyInQueueContext, providerLabel: "VRBO" },
      },
    });
    enqueueOp({
      opType: "vrbo_search",
      params: {
        destination: "Koloa", searchTerm: "Koloa", checkIn: "2026-07-10", checkOut: "2026-07-17",
        bedrooms: 3, queueContext: { ...buyInQueueContext, providerLabel: "VRBO" },
      },
    });
  };

  // Healthy default (concurrency 2): both VRBO searches are claimable at once.
  resetQueue();
  delete process.env.SIDECAR_VRBO_CONCURRENCY;
  enqueueTwoVrbo();
  const v1 = next({ slot: "1", workerRole: "local", browserMode: "cdp", chromePrimary: "local" });
  const v2 = next({ slot: "2", workerRole: "local", browserMode: "cdp", chromePrimary: "local" });
  assert.equal(v1?.opType, "vrbo_search", "first VRBO search claims (healthy)");
  assert.equal(v2?.opType, "vrbo_search", "second VRBO search claims concurrently on the same IP (default concurrency 2)");
  assert.equal(getStatus().inProgress, 2, "two VRBO searches run concurrently when VRBO is healthy");

  // Env revert (SIDECAR_VRBO_CONCURRENCY=1): single-file, the old behaviour — and
  // the exact limit the adaptive back-off applies when VRBO is unhealthy.
  resetQueue();
  process.env.SIDECAR_VRBO_CONCURRENCY = "1";
  enqueueTwoVrbo();
  const s1 = next({ slot: "1", workerRole: "local", browserMode: "cdp", chromePrimary: "local" });
  const s2 = next({ slot: "2", workerRole: "local", browserMode: "cdp", chromePrimary: "local" });
  assert.equal(s1?.opType, "vrbo_search", "first VRBO search claims (single-file)");
  assert.equal(s2, null, "SIDECAR_VRBO_CONCURRENCY=1 keeps VRBO single-file (revert / adaptive-backoff limit)");
  delete process.env.SIDECAR_VRBO_CONCURRENCY;
}

// ── Background ops (e.g. "Verify community") still YIELD priority to the bulk ──
// A background vrbo_photo_scrape shares the "vrbo_search" concurrency group. It
// must NEVER preempt a ready foreground search for the first slot. Under the
// healthy default (concurrency 2) the SECOND slot may run it alongside; under
// SIDECAR_VRBO_CONCURRENCY=1 the second slot stays blocked (single-file).
{
  const enqueueScrapeThenSearch = () => {
    // Background scrape enqueued FIRST (older)...
    enqueueOp({
      opType: "vrbo_photo_scrape",
      params: { url: "https://www.vrbo.com/111", maxPhotos: 8, queueContext: { background: true, scanLabel: "verify-combo-community" } },
    });
    // ...then a foreground bulk search (newer). Despite being newer, it wins slot 1.
    enqueueOp({
      opType: "vrbo_search",
      params: {
        destination: "Poipu Kai", searchTerm: "Poipu Kai", checkIn: "2026-07-10", checkOut: "2026-07-17",
        bedrooms: 3, queueContext: { ...buyInQueueContext, providerLabel: "VRBO" },
      },
    });
  };

  // Healthy default: foreground preempts slot 1; the background scrape rides slot 2.
  resetQueue();
  delete process.env.SIDECAR_VRBO_CONCURRENCY;
  enqueueScrapeThenSearch();
  const claim = next({ slot: "1", workerRole: "local", browserMode: "cdp", chromePrimary: "local" });
  assert.equal(claim?.opType, "vrbo_search", "foreground bulk search must preempt the older background verify scrape for slot 1");
  const second = next({ slot: "2", workerRole: "local", browserMode: "cdp", chromePrimary: "local" });
  assert.equal(second?.opType, "vrbo_photo_scrape", "background scrape rides the second VRBO slot when VRBO is healthy (concurrency 2)");

  // Single-file revert: foreground still wins slot 1, scrape is blocked from slot 2.
  resetQueue();
  process.env.SIDECAR_VRBO_CONCURRENCY = "1";
  enqueueScrapeThenSearch();
  const claim1 = next({ slot: "1", workerRole: "local", browserMode: "cdp", chromePrimary: "local" });
  assert.equal(claim1?.opType, "vrbo_search", "foreground bulk search still preempts the background scrape (single-file)");
  const blocked = next({ slot: "2", workerRole: "local", browserMode: "cdp", chromePrimary: "local" });
  assert.equal(blocked, null, "under SIDECAR_VRBO_CONCURRENCY=1 the background scrape must not double up with the bulk VRBO search");
  delete process.env.SIDECAR_VRBO_CONCURRENCY;
}

// Background op is NOT starved: when it's the only thing pending, it gets claimed.
{
  resetQueue();
  enqueueOp({
    opType: "vrbo_photo_scrape",
    params: { url: "https://www.vrbo.com/222", maxPhotos: 8, queueContext: { background: true } },
  });
  const claim = next({ slot: "1", workerRole: "local", browserMode: "cdp", chromePrimary: "local" });
  assert.equal(claim?.opType, "vrbo_photo_scrape", "a lone background op must still be claimed (no starvation)");
}

resetQueue();

console.log("sidecar concurrency suite passed");
