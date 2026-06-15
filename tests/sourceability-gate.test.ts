import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";

const { decideSourceability, generateWeeklyWindows, applyConfirmation, confirmedAction, classifyObservation } = await import("../server/sourceability-gate-core");

console.log("sourceability gate suite");

// FAIL-SAFE: an offline/empty/failed scan must NEVER block or unblock,
// regardless of the numbers — a false block silently kills real revenue.
{
  const d = decideSourceability({ scan: { ok: false, cheapestCost: 5000 }, sellableRevenue: 1 });
  assert.equal(d.decision, "skip", "scan not ok → skip (fail-safe, no calendar change)");
  const d2 = decideSourceability({ scan: { ok: false, cheapestCost: null }, sellableRevenue: 99999 });
  assert.equal(d2.decision, "skip", "scan not ok always skips even with huge revenue");
}

// Real pool but no sourceable same-community combo → block.
{
  const d = decideSourceability({ scan: { ok: true, cheapestCost: null }, sellableRevenue: 9000 });
  assert.equal(d.decision, "block", "real pool, no combo → block");
}

// The actual Lea case: cheapest combo $18,617 vs sold $12,187 → clear loss → block.
{
  const d = decideSourceability({ scan: { ok: true, cheapestCost: 18617 }, sellableRevenue: 12187 });
  assert.equal(d.decision, "block", "cost >> revenue → block");
  assert.equal(d.projectedProfit, 12187 - 18617, "projected profit is revenue − cost");
}

// The Nancy case: cheapest combo $7,983 vs sellable $9,237 → profit → open.
{
  const d = decideSourceability({ scan: { ok: true, cheapestCost: 7983 }, sellableRevenue: 9237 });
  assert.equal(d.decision, "open", "profitable → open");
}

// minMargin threshold: thin-but-positive is blocked only when a margin is required.
{
  const thin20 = decideSourceability({ scan: { ok: true, cheapestCost: 10000 }, sellableRevenue: 11000, minMargin: 0.20 });
  assert.equal(thin20.decision, "block", "profit $1,000 < required $2,000 (20% of cost) → block");
  const ok20 = decideSourceability({ scan: { ok: true, cheapestCost: 10000 }, sellableRevenue: 12500, minMargin: 0.20 });
  assert.equal(ok20.decision, "open", "profit $2,500 ≥ $2,000 → open");
  const dflt = decideSourceability({ scan: { ok: true, cheapestCost: 10000 }, sellableRevenue: 11000 });
  assert.equal(dflt.decision, "open", "default minMargin 0 blocks only actual losses, not thin margins");
}

// Exact break-even is NOT a loss at the default threshold (profit 0 ≥ required 0).
{
  const even = decideSourceability({ scan: { ok: true, cheapestCost: 10000 }, sellableRevenue: 10000 });
  assert.equal(even.decision, "open", "break-even is not a loss at minMargin 0");
}
console.log("  ✓ decideSourceability: fail-safe skip / block-on-loss / open-on-profit / minMargin gate");

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

// ── Confirmation guard: immunity to single-scrape noise ──
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

  // THE NOISE CASE we observed: block, open, block, block (threshold 2)
  let s = { consecutiveBlocks: 0, consecutiveOpens: 0 };
  for (const dec of ["block", "open", "block"]) { s = applyConfirmation(s, dec); assert.equal(confirmedAction(s, 2), "pending", `noisy ${dec} must NOT act`); }
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
  // the operator's exact ask: flagged once, needs a second sweep
  const onceFlagged = classifyObservation({ consecutiveBlocks: 1, consecutiveOpens: 0, threshold: 2, blockedOnGuesty: false });
  assert.equal(onceFlagged.status, "block-pending");
  assert.equal(onceFlagged.label, "Loss flagged 1/2 — 1 more sweep to block");
  assert.deepEqual(onceFlagged.progress, { count: 1, of: 2 });

  // confirmed (2/2) but not yet pushed to Guesty
  const confirmed = classifyObservation({ consecutiveBlocks: 2, consecutiveOpens: 0, threshold: 2, blockedOnGuesty: false });
  assert.equal(confirmed.status, "blocked");

  // live on the calendar
  const live = classifyObservation({ consecutiveBlocks: 2, consecutiveOpens: 0, threshold: 2, blockedOnGuesty: true });
  assert.equal(live.status, "blocked");
  assert.equal(live.label, "Blocked on Guesty");

  // sourceable confirmed + forming
  assert.equal(classifyObservation({ consecutiveBlocks: 0, consecutiveOpens: 2, threshold: 2, blockedOnGuesty: false }).status, "sourceable");
  assert.equal(classifyObservation({ consecutiveBlocks: 0, consecutiveOpens: 1, threshold: 2, blockedOnGuesty: false }).status, "sourceable-pending");

  // nothing yet
  assert.equal(classifyObservation({ consecutiveBlocks: 0, consecutiveOpens: 0, threshold: 2, blockedOnGuesty: false }).status, "unknown");

  // higher threshold pluralizes correctly
  assert.equal(classifyObservation({ consecutiveBlocks: 1, consecutiveOpens: 0, threshold: 3, blockedOnGuesty: false }).label, "Loss flagged 1/3 — 2 more sweeps to block");
}
console.log("  ✓ classifyObservation: 1/2 pending, 2/2 confirmed, live-blocked, sourceable, plural labels");

console.log("sourceability gate suite passed");
