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

// ── Background ops (e.g. "Verify community") yield to the bulk search ─────────
// A background vrbo_photo_scrape shares the "vrbo_search" concurrency group with
// the bulk's vrbo_search. It must NOT preempt a ready foreground search, but must
// still run when nothing foreground is waiting (no starvation).
{
  resetQueue();
  // Background scrape enqueued FIRST (older)...
  enqueueOp({
    opType: "vrbo_photo_scrape",
    params: { url: "https://www.vrbo.com/111", maxPhotos: 8, queueContext: { background: true, scanLabel: "verify-combo-community" } },
  });
  // ...then a foreground bulk search (newer). Despite being newer, it wins.
  enqueueOp({
    opType: "vrbo_search",
    params: {
      destination: "Poipu Kai", searchTerm: "Poipu Kai", checkIn: "2026-07-10", checkOut: "2026-07-17",
      bedrooms: 3, queueContext: { ...buyInQueueContext, providerLabel: "VRBO" },
    },
  });
  const claim = next({ slot: "1", workerRole: "local", browserMode: "cdp", chromePrimary: "local" });
  assert.equal(claim?.opType, "vrbo_search", "foreground bulk search must preempt the older background verify scrape");
  // Group is now at its limit of 1 → the background scrape can't double up vs VRBO.
  const blocked = next({ slot: "2", workerRole: "local", browserMode: "cdp", chromePrimary: "local" });
  assert.equal(blocked, null, "background scrape must not run concurrently with the bulk VRBO search (single-file)");
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
