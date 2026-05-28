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

console.log("sidecar concurrency suite passed");
