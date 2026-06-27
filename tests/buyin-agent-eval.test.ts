import assert from "node:assert/strict";

const {
  GOLDEN_FIXTURES,
  detectInvariantViolations,
  scoreFixture,
  evaluateGate,
  DEFAULT_GATE_THRESHOLDS,
} = await import("../server/buyin-agent-eval");

console.log("buyin-agent-eval suite");

const sample = (over: Partial<any> = {}) => ({
  slotsFilled: 2,
  slotsTotal: 2,
  totalCost: 4000,
  expectedProfit: 1000,
  expectedRevenue: 5000,
  attachedUrls: ["https://vrbo.com/a", "https://vrbo.com/b"],
  costUsd: 1.0,
  latencyMs: 60_000,
  ...over,
});

// ── detectInvariantViolations ────────────────────────────────────────────────
{
  assert.deepEqual(detectInvariantViolations(sample()), [], "clean sample has no violations");

  const dup = detectInvariantViolations(sample({ attachedUrls: ["https://vrbo.com/a", "https://www.vrbo.com/a/"] }));
  assert.ok(dup.includes("duplicate-url"), "same listing twice (host/trailing-slash normalized) is a duplicate");

  const partial = detectInvariantViolations(sample({ slotsFilled: 1, slotsTotal: 2 }));
  assert.ok(partial.includes("partial-combo"), "1-of-2 filled is a partial combo");

  const overLoss = detectInvariantViolations(sample({ expectedProfit: -250, expectedRevenue: 5000 }));
  assert.ok(overLoss.includes("over-loss"), "-$250 vs known revenue is over the $100 cap");

  const lossButUnknownRev = detectInvariantViolations(sample({ expectedProfit: -250, expectedRevenue: 0 }));
  assert.ok(!lossButUnknownRev.includes("over-loss"), "gate disabled when revenue unknown → no over-loss flag");
  console.log("  ✓ detectInvariantViolations: duplicate, partial, over-loss (gate-aware)");
}

// ── scoreFixture: fills (parity, no miss) ────────────────────────────────────
{
  const fx = GOLDEN_FIXTURES.find((f) => f.id === "poipu-kai-combo")!;
  const legacy = sample();
  const samples = [sample(), sample(), sample(), sample(), sample()];
  const sc = scoreFixture(fx, legacy, samples);
  assert.equal(sc.expectationMet, true);
  assert.equal(sc.fillParity, 1);
  assert.equal(sc.profitableComboMiss, false);
  assert.equal(sc.invariantViolations, 0);
  console.log("  ✓ scoreFixture(fills): parity 1, expectation met, no misses");
}

// ── scoreFixture: a recall miss (legacy filled, agent never did) ──────────────
{
  const fx = GOLDEN_FIXTURES.find((f) => f.id === "poipu-kai-combo")!;
  const legacy = sample(); // legacy filled 2 profitably
  const samples = [sample({ slotsFilled: 0, totalCost: null, expectedProfit: null }), sample({ slotsFilled: 0, totalCost: null, expectedProfit: null })];
  const sc = scoreFixture(fx, legacy, samples);
  assert.equal(sc.fillParity, 0, "agent filled 0 vs legacy 2");
  assert.equal(sc.profitableComboMiss, true, "profitable-combo miss flagged");
  assert.equal(sc.expectationMet, false);
  console.log("  ✓ scoreFixture(miss): parity 0, profitableComboMiss true");
}

// ── scoreFixture: rejects-duplicate ──────────────────────────────────────────
{
  const fx = GOLDEN_FIXTURES.find((f) => f.id === "princeville-duplicate")!;
  const legacy = sample({ slotsFilled: 0 }); // legacy left it empty (correct)
  const clean = scoreFixture(fx, legacy, [sample({ slotsFilled: 0 })]);
  assert.equal(clean.expectationMet, true, "no duplicate attached → expectation met");
  const bad = scoreFixture(fx, legacy, [sample({ attachedUrls: ["https://vrbo.com/x", "https://vrbo.com/x"] })]);
  assert.equal(bad.expectationMet, false, "attached the duplicate twice → expectation failed");
  console.log("  ✓ scoreFixture(rejects-duplicate): flags a both-attached duplicate");
}

// ── scoreFixture: empty (legitimate) ─────────────────────────────────────────
{
  const fx = GOLDEN_FIXTURES.find((f) => f.id === "thin-inventory-empty")!;
  const legacy = sample({ slotsFilled: 0, totalCost: null, expectedProfit: null });
  const emptyOk = scoreFixture(fx, legacy, [sample({ slotsFilled: 0, totalCost: null, expectedProfit: null })]);
  assert.equal(emptyOk.expectationMet, true, "agent empty → expectation met");
  const filledBad = scoreFixture(fx, legacy, [sample({ slotsFilled: 2 })]);
  assert.equal(filledBad.expectationMet, false, "agent forced an attach on a should-be-empty fixture");
  console.log("  ✓ scoreFixture(empty): empty meets, a forced attach fails");
}

// ── evaluateGate: pass + each failure mode ───────────────────────────────────
{
  const fx = GOLDEN_FIXTURES.find((f) => f.id === "poipu-kai-combo")!;
  const legacy = sample();
  const good = [sample(), sample(), sample(), sample(), sample()];
  const passScores = [scoreFixture(fx, legacy, good)];
  const passGate = evaluateGate(passScores, good, [legacy]);
  assert.equal(passGate.pass, true, `gate should pass: ${passGate.reasons.join("; ")}`);

  // low parity (agent fills 1 of 2 on average) — also a partial-combo violation, both caught
  const lowFillSamples = [sample({ slotsFilled: 1 }), sample({ slotsFilled: 1 })];
  const lowScores = [scoreFixture(fx, legacy, lowFillSamples)];
  const lowGate = evaluateGate(lowScores, lowFillSamples, [legacy]);
  assert.equal(lowGate.pass, false, "low fill parity fails the gate");
  assert.ok(lowGate.reasons.some((r) => r.includes("fill parity") || r.includes("invariant")), "reason names parity/invariant");

  // cost over budget
  const pricey = good.map((s) => ({ ...s, costUsd: 5 }));
  const costGate = evaluateGate([scoreFixture(fx, legacy, pricey)], pricey, [legacy]);
  assert.equal(costGate.pass, false, "over-budget cost fails the gate");
  assert.ok(costGate.reasons.some((r) => r.includes("cost")), "reason names cost");

  // latency worse than legacy
  const slow = good.map((s) => ({ ...s, latencyMs: 600_000 }));
  const latGate = evaluateGate([scoreFixture(fx, legacy, slow)], slow, [sample({ latencyMs: 60_000 })]);
  assert.equal(latGate.pass, false, "agent slower than legacy fails the gate");
  assert.ok(latGate.reasons.some((r) => r.includes("latency")), "reason names latency");
  console.log("  ✓ evaluateGate: passes clean; fails on parity, cost, latency");
}

// ── the golden set is the frozen six ─────────────────────────────────────────
{
  const ids = GOLDEN_FIXTURES.map((f) => f.id).sort();
  assert.deepEqual(ids, [
    "ground-floor-required",
    "poipu-kai-combo",
    "princeville-duplicate",
    "profit-gate-loss",
    "thin-inventory-empty",
    "walkable-cluster-poipu-kiahuna",
  ]);
  assert.equal(DEFAULT_GATE_THRESHOLDS.minFillParity, 0.95);
  console.log("  ✓ golden set is the frozen six; default gate parity 0.95");
}

console.log("buyin-agent-eval suite passed");
