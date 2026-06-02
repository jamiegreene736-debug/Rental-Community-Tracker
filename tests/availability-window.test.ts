import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";

const {
  demandFactorForPolicyBand,
  isDueForPolicyPass,
} = await import("../server/availability-policy");

const {
  AVAILABILITY_RELIABILITY_FACTOR,
  AVAILABILITY_AUTO_BLOCK_HOLIDAY_DAYS,
  AVAILABILITY_AUTO_BLOCK_ULTRA_PEAK_DAYS,
  AVAILABILITY_AUTO_BLOCK_NEAR_TERM_DAYS,
  AVAILABILITY_WINDOW_NIGHTS,
  AVAILABILITY_POLICY_HIGH_SEASON_LEAD_DAYS,
  availabilityAutoBlockAllowed,
  availabilityBlockingQualityIssue,
  availabilityLeadDaysForPolicyBand,
  availabilityVerdictForScan,
  availabilityWindowCountForWeeks,
  computeAvailabilityThresholds,
  effectiveAvailabilityCount,
  generateWeeklyAvailabilityPolicyWindows,
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
assert.equal(AVAILABILITY_RELIABILITY_FACTOR, 1, "availability scan should use proven raw inventory without a haircut");
assert.equal(AVAILABILITY_AUTO_BLOCK_NEAR_TERM_DAYS, 45, "standard policy horizon should be 45 days");
assert.equal(AVAILABILITY_POLICY_HIGH_SEASON_LEAD_DAYS, 75, "high-season policy horizon should be 75 days");
assert.equal(AVAILABILITY_AUTO_BLOCK_HOLIDAY_DAYS, 90, "major-holiday policy horizon should be 90 days");
assert.equal(AVAILABILITY_AUTO_BLOCK_ULTRA_PEAK_DAYS, 120, "ultra-peak policy horizon should be 120 days");
console.log("  ✓ generates 48 future 14-night windows");

const policyWindows = generateWeeklyAvailabilityPolicyWindows({
  weeks: 4,
  now: new Date("2026-05-27T12:00:00Z"),
});
assert.equal(policyWindows.length, 4, "policy should generate weekly arrival bands");
assert.equal(policyWindows[0].checkIn, "2026-05-27");
assert.equal(policyWindows[0].checkOut, "2026-06-03");
assert.equal(availabilityLeadDaysForPolicyBand("standard"), 45);
assert.equal(availabilityLeadDaysForPolicyBand("high"), 75);
assert.equal(availabilityLeadDaysForPolicyBand("majorHoliday"), 90);
assert.equal(availabilityLeadDaysForPolicyBand("ultraPeak"), 120);
console.log("  ✓ exposes deterministic policy lead times");

const thresholds = computeAvailabilityThresholds([
  { unitId: "A", unitLabel: "Unit A", bedrooms: 3 },
  { unitId: "B", unitLabel: "Unit B", bedrooms: 3 },
], 2);

assert.equal(thresholds.blockMinSets, 1, "default target should only block below 1 effective set");
assert.equal(thresholds.openMinSets, 2, "2-set target should open at 2 effective sets");
assert.equal(thresholds.blockCandidatesByBR[3], 2, "3BR + 3BR blocks only below one complete set");
assert.equal(thresholds.openCandidatesByBR[3], 4, "3BR + 3BR opens at two complete sets");
console.log("  ✓ keeps a loose block floor for combo inventory");

const conservativeThresholds = computeAvailabilityThresholds([
  { unitId: "A", unitLabel: "Unit A", bedrooms: 3 },
  { unitId: "B", unitLabel: "Unit B", bedrooms: 3 },
], 5);

assert.equal(conservativeThresholds.blockMinSets, 1, "higher open targets should not raise the hard blackout floor");
assert.equal(
  availabilityVerdictForScan(1, conservativeThresholds, { daemonOnline: true, warnings: [] }),
  "open",
  "inventory counts no longer drive blackout decisions",
);
console.log("  ✓ availability counts no longer create blackout bands");

assert.equal(
  effectiveAvailabilityCount({ airbnb: 1, vrbo: 0, booking: 0, pm: 0, total: 1 }),
  1,
  "one proved replacement should not be rounded down to zero by the reliability haircut",
);
assert.equal(
  effectiveAvailabilityCount({ airbnb: 0, vrbo: 0, booking: 0, pm: 0, total: 0 }),
  0,
  "zero found replacements should remain zero",
);
console.log("  ✓ preserves a single proven replacement candidate");

assert.equal(
  availabilityVerdictForScan(0, thresholds, { daemonOnline: true, warnings: [] }, {
    season: "HIGH",
    checkIn: "2026-06-15",
    now: new Date("2026-05-27T12:00:00Z"),
  }),
  "blocked",
  "clean near-term zero inventory should remain blockable",
);
assert.equal(
  availabilityVerdictForScan(0, thresholds, { daemonOnline: true, warnings: [] }, {
    season: "LOW",
    checkIn: "2026-11-15",
    now: new Date("2026-05-27T12:00:00Z"),
  }),
  "open",
  "far-future standard-season arrivals should stay open by policy",
);
assert.equal(
  availabilityVerdictForScan(0, thresholds, { daemonOnline: true, warnings: [] }, {
    season: "HOLIDAY",
    checkIn: "2026-11-22",
    now: new Date("2026-05-27T12:00:00Z"),
  }),
  "open",
  "major holiday arrivals outside the 90-day policy horizon should stay open",
);
assert.equal(
  availabilityAutoBlockAllowed({
    season: "HOLIDAY",
    checkIn: "2026-07-01",
    now: new Date("2026-05-27T12:00:00Z"),
  }),
  true,
  "near holiday scarcity should still be eligible for auto-blocking",
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
  }, {
    season: "HIGH",
    checkIn: "2026-06-15",
    now: new Date("2026-05-27T12:00:00Z"),
  }),
  "blocked",
  "provider failures no longer affect fixed policy blocks",
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
  "provider warnings are diagnostic only under fixed policy",
);
console.log("  ✓ provider availability evidence no longer controls blackouts");

assert.equal(
  isDueForPolicyPass(new Date("2026-05-28T04:30:00Z"), new Date("2026-05-28T05:30:00Z"), 24),
  false,
  "same Eastern day before 1 AM should not re-run",
);
assert.equal(
  isDueForPolicyPass(new Date("2026-05-27T10:00:00Z"), new Date("2026-05-28T06:00:00Z"), 24),
  true,
  "after 1 AM Eastern on a new day should run",
);
console.log("  ✓ daily policy pass is due after 1 AM Eastern");

assert.equal(demandFactorForPolicyBand("standard"), 1.15);
assert.equal(demandFactorForPolicyBand("high"), 1.25);
assert.equal(demandFactorForPolicyBand("majorHoliday"), 1.4);
assert.equal(demandFactorForPolicyBand("ultraPeak"), 1.5);
console.log("  ✓ lead-time policy bands use fixed seasonal markups");

console.log("availability window suite passed");
