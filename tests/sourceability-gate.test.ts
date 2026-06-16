import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";

const { decideAvailabilitySourceability, generateWeeklyWindows, applyConfirmation, confirmedAction, classifyObservation } = await import("../server/sourceability-gate-core");
const { computeSetsFromCounts } = await import("../server/availability-search");

console.log("sourceability gate suite (Airbnb-availability)");

// FAIL-SAFE: a failed/keyless Airbnb search must NEVER block or unblock — a
// false block silently kills real revenue, so we only act on a SUCCESSFUL search.
{
  const d = decideAvailabilitySourceability({ ok: false, setsAvailable: 0, detail: "no key" });
  assert.equal(d.decision, "skip", "search not ok → skip (fail-safe, no calendar change)");
  const d2 = decideAvailabilitySourceability({ ok: false, setsAvailable: 5 });
  assert.equal(d2.decision, "skip", "search not ok always skips, even if a stale count is present");
}

// A SUCCESSFUL search that can supply ≥1 complete unit-set → open (keep selling).
{
  const d = decideAvailabilitySourceability({ ok: true, setsAvailable: 1, detail: "3BR×4, 2BR×9 → 1 set" });
  assert.equal(d.decision, "open", "≥1 set available on Airbnb → open");
  const d2 = decideAvailabilitySourceability({ ok: true, setsAvailable: 7 });
  assert.equal(d2.decision, "open", "plenty of sets → open");
}

// A SUCCESSFUL search that can't supply the unit set (a required size missing) → block.
{
  const d = decideAvailabilitySourceability({ ok: true, setsAvailable: 0, detail: "3BR×0, 2BR×9 → 0 sets" });
  assert.equal(d.decision, "block", "a required size unavailable on Airbnb → block");
}
console.log("  ✓ decideAvailabilitySourceability: fail-safe skip / open when set available / block when a size is missing");

// computeSetsFromCounts: the bedroom-plan set math that drives availability.
{
  // 5BR = 3BR + 2BR: needs one of each per set → min(have3, have2).
  assert.equal(computeSetsFromCounts([{ bedrooms: 3 }, { bedrooms: 2 }], { 3: 4, 2: 9 }), 4, "5BR=3+2: min(4,9)=4 sets");
  assert.equal(computeSetsFromCounts([{ bedrooms: 3 }, { bedrooms: 2 }], { 3: 0, 2: 9 }), 0, "no 3BR → 0 sets (would block)");
  assert.equal(computeSetsFromCounts([{ bedrooms: 3 }, { bedrooms: 2 }], { 3: 1, 2: 1 }), 1, "one of each → exactly 1 set (open)");
  // 6BR = 3BR + 3BR: needs TWO distinct 3BRs per set → floor(have3 / 2).
  assert.equal(computeSetsFromCounts([{ bedrooms: 3 }, { bedrooms: 3 }], { 3: 7 }), 3, "6BR=3+3: floor(7/2)=3 sets");
  assert.equal(computeSetsFromCounts([{ bedrooms: 3 }, { bedrooms: 3 }], { 3: 1 }), 0, "6BR=3+3 with only one 3BR → 0 sets (would block)");
}
console.log("  ✓ computeSetsFromCounts: per-size set math (3+2 needs one each; 3+3 needs two distinct 3BRs)");

// Windows: weekly 7-night, within [minLead, horizon], each start+7 = end.
{
  const now = new Date("2026-06-15T00:00:00Z");
  const ws = generateWeeklyWindows(now, 3, 90);
  assert.ok(ws.length > 0, "generates near-term windows");
  assert.ok(ws.every((w) => w.nights === 7), "all windows are 7 nights");

  const firstLead = Math.round((new Date(ws[0].startDate + "T12:00:00Z").getTime() - now.getTime()) / 86_400_000);
  assert.ok(firstLead >= 3, `first window respects minLead (got ${firstLead})`);

  const lastHorizon = Math.round((new Date(ws[ws.length - 1].endDate + "T12:00:00Z").getTime() - now.getTime()) / 86_400_000);
  assert.ok(lastHorizon <= 90, `last window within horizon (got ${lastHorizon})`);

  for (const w of ws) {
    const span = Math.round((new Date(w.endDate + "T12:00:00Z").getTime() - new Date(w.startDate + "T12:00:00Z").getTime()) / 86_400_000);
    assert.equal(span, 7, "each window spans exactly 7 nights");
  }
}
console.log("  ✓ generateWeeklyWindows: 7-night windows within [minLead, horizon]");

// ── Confirmation guard: immunity to single-search noise ──
{
  const zero = { consecutiveBlocks: 0, consecutiveOpens: 0 };
  // streak accumulation + reset
  assert.deepEqual(applyConfirmation(zero, "block"), { consecutiveBlocks: 1, consecutiveOpens: 0 });
  assert.deepEqual(applyConfirmation({ consecutiveBlocks: 1, consecutiveOpens: 0 }, "block"), { consecutiveBlocks: 2, consecutiveOpens: 0 });
  assert.deepEqual(applyConfirmation({ consecutiveBlocks: 2, consecutiveOpens: 0 }, "open"), { consecutiveBlocks: 0, consecutiveOpens: 1 }, "open resets the block streak");
  // skip carries NO evidence — streaks unchanged (must not reset a confirmation)
  assert.deepEqual(applyConfirmation({ consecutiveBlocks: 1, consecutiveOpens: 0 }, "skip"), { consecutiveBlocks: 1, consecutiveOpens: 0 }, "skip leaves streaks unchanged");

  // confirmedAction only fires at the threshold
  assert.equal(confirmedAction({ consecutiveBlocks: 1, consecutiveOpens: 0 }, 2), "pending", "1/2 blocks → pending (no calendar change)");
  assert.equal(confirmedAction({ consecutiveBlocks: 2, consecutiveOpens: 0 }, 2), "block", "2/2 blocks → block");
  assert.equal(confirmedAction({ consecutiveBlocks: 0, consecutiveOpens: 2 }, 2), "open", "2/2 opens → open");
  assert.equal(confirmedAction({ consecutiveBlocks: 5, consecutiveOpens: 0 }, 1), "block", "threshold floors at 1");

  // THE NOISE CASE: block, open, block, block (threshold 2)
  let s = { consecutiveBlocks: 0, consecutiveOpens: 0 };
  for (const dec of ["block", "open", "block"] as const) { s = applyConfirmation(s, dec); assert.equal(confirmedAction(s, 2), "pending", `noisy ${dec} must NOT act`); }
  s = applyConfirmation(s, "block");
  assert.equal(confirmedAction(s, 2), "block", "only a 2nd CONSECUTIVE block confirms → block");

  // a skip between two blocks does NOT break the confirmation (no evidence, not contradiction)
  let t = applyConfirmation({ consecutiveBlocks: 0, consecutiveOpens: 0 }, "block");
  t = applyConfirmation(t, "skip");
  t = applyConfirmation(t, "block");
  assert.equal(confirmedAction(t, 2), "block", "block, skip, block → confirmed (skip is neutral)");
}
console.log("  ✓ confirmation guard: N-consecutive required; noise never acts; skip is neutral");

// ── UI status classifier (the "1/2 — one more sweep to block" labels) ──
{
  // flagged once, needs a second sweep
  const onceFlagged = classifyObservation({ consecutiveBlocks: 1, consecutiveOpens: 0, threshold: 2, blockedOnGuesty: false });
  assert.equal(onceFlagged.status, "block-pending");
  assert.equal(onceFlagged.label, "No Airbnb units 1/2 — 1 more sweep to block");
  assert.deepEqual(onceFlagged.progress, { count: 1, of: 2 });

  // confirmed (2/2) but not yet pushed to Guesty
  const confirmed = classifyObservation({ consecutiveBlocks: 2, consecutiveOpens: 0, threshold: 2, blockedOnGuesty: false });
  assert.equal(confirmed.status, "blocked");

  // live on the calendar
  const live = classifyObservation({ consecutiveBlocks: 2, consecutiveOpens: 0, threshold: 2, blockedOnGuesty: true });
  assert.equal(live.status, "blocked");
  assert.equal(live.label, "Blocked on Guesty");

  // available confirmed + forming
  assert.equal(classifyObservation({ consecutiveBlocks: 0, consecutiveOpens: 2, threshold: 2, blockedOnGuesty: false }).status, "sourceable");
  assert.equal(classifyObservation({ consecutiveBlocks: 0, consecutiveOpens: 2, threshold: 2, blockedOnGuesty: false }).label, "Available on Airbnb");
  assert.equal(classifyObservation({ consecutiveBlocks: 0, consecutiveOpens: 1, threshold: 2, blockedOnGuesty: false }).status, "sourceable-pending");

  // nothing yet
  assert.equal(classifyObservation({ consecutiveBlocks: 0, consecutiveOpens: 0, threshold: 2, blockedOnGuesty: false }).status, "unknown");

  // higher threshold pluralizes correctly
  assert.equal(classifyObservation({ consecutiveBlocks: 1, consecutiveOpens: 0, threshold: 3, blockedOnGuesty: false }).label, "No Airbnb units 1/3 — 2 more sweeps to block");
}
console.log("  ✓ classifyObservation: 1/2 pending, 2/2 confirmed, live-blocked, available, plural labels");

console.log("sourceability gate suite passed");
