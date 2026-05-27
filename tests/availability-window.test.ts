import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";

const {
  AVAILABILITY_RELIABILITY_FACTOR,
  AVAILABILITY_WINDOW_NIGHTS,
  availabilityWindowCountForWeeks,
  computeAvailabilityThresholds,
  generateTwiceMonthlyAvailabilityWindows,
} = await import("../server/seasonal-availability");

console.log("availability window suite");

const windows = generateTwiceMonthlyAvailabilityWindows({
  weeks: 104,
  now: new Date("2026-05-27T12:00:00Z"),
});

assert.equal(windows.length, 48, "24 months should produce 48 windows");
assert.equal(windows[0].checkIn, "2026-06-01", "first future anchor should be the next 1st or 15th");
assert.equal(windows[0].checkOut, "2026-06-15", "windows should run 14 nights");
assert.equal(windows[0].nights, AVAILABILITY_WINDOW_NIGHTS);
assert.equal(availabilityWindowCountForWeeks(104), 48);
assert.equal(AVAILABILITY_RELIABILITY_FACTOR, 0.5, "false-positive haircut should be 50%");
console.log("  ✓ generates 48 future 14-night windows");

const thresholds = computeAvailabilityThresholds([
  { unitId: "A", unitLabel: "Unit A", bedrooms: 3 },
  { unitId: "B", unitLabel: "Unit B", bedrooms: 3 },
], 2);

assert.equal(thresholds.blockMinSets, 3, "block floor should not go below 3 effective sets");
assert.equal(thresholds.blockCandidatesByBR[3], 6, "3BR + 3BR needs 6 effective 3BR candidates for 3 sets");
assert.equal(thresholds.openCandidatesByBR[3], 10, "open threshold keeps two cushion sets");
console.log("  ✓ keeps a 3-set block floor for combo inventory");

console.log("availability window suite passed");
