import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";

const { decideSourceability, generateWeeklyWindows } = await import("../server/sourceability-gate-core");

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

console.log("sourceability gate suite passed");
