import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";

const {
  AVAILABILITY_RELIABILITY_FACTOR,
  AVAILABILITY_WINDOW_NIGHTS,
  availabilityBlockingQualityIssue,
  availabilityVerdictForScan,
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
assert.equal(AVAILABILITY_RELIABILITY_FACTOR, 0.75, "false-positive haircut should be a 25% reserve");
console.log("  ✓ generates 48 future 14-night windows");

const thresholds = computeAvailabilityThresholds([
  { unitId: "A", unitLabel: "Unit A", bedrooms: 3 },
  { unitId: "B", unitLabel: "Unit B", bedrooms: 3 },
], 2);

assert.equal(thresholds.blockMinSets, 1, "default target should only block below 1 effective set");
assert.equal(thresholds.openMinSets, 2, "2-set target should open at 2 effective sets");
assert.equal(thresholds.blockCandidatesByBR[3], 2, "3BR + 3BR blocks only below one complete set");
assert.equal(thresholds.openCandidatesByBR[3], 4, "3BR + 3BR opens at two complete sets");
console.log("  ✓ keeps a loose block floor for combo inventory");

assert.equal(
  availabilityVerdictForScan(0, thresholds, { daemonOnline: true, warnings: [] }),
  "blocked",
  "clean zero inventory should remain blockable",
);
assert.equal(
  availabilityVerdictForScan(0, thresholds, {
    daemonOnline: true,
    warnings: [{
      season: "HIGH",
      channel: "vrbo",
      kind: "timeout",
      message: "VRBO timed out during the HIGH scan",
      reason: "provider search timed out",
    }],
  }),
  "tight",
  "provider failures should not create automatic blocks",
);
assert.match(
  availabilityBlockingQualityIssue({
    daemonOnline: true,
    warnings: [{
      season: "HIGH",
      channel: "booking",
      kind: "captcha",
      message: "Booking.com hit CAPTCHA",
      reason: "captcha challenge visible",
    }],
  }),
  /BOOKING captcha/,
);
assert.equal(
  availabilityVerdictForScan(2, thresholds, {
    daemonOnline: true,
    warnings: [{
      season: "HIGH",
      channel: "vrbo",
      kind: "timeout",
      message: "VRBO timed out during the HIGH scan",
      reason: "provider search timed out",
    }],
  }),
  "open",
  "provider warnings should only downgrade automatic blocks, not hide sufficient inventory",
);
console.log("  ✓ refuses to auto-block from incomplete provider evidence");

console.log("availability window suite passed");
