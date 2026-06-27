// ─────────────────────────────────────────────────────────────────────────────
// Cowork buy-in engine — evaluation harness (plan §5).
//
// The whole cutover rests on RECALL, and the agent is non-deterministic, so a
// one-shot "agent vs legacy on a batch" diff proves nothing. This module is the
// STANDING harness: a frozen golden fixture set + pure scoring + a DECIDABLE
// go/no-go gate, run on every prompt/tool change from Phase 1 on.
//
// What lives here (pure, no DB / no network) so it's unit-testable today:
//   - GOLDEN_FIXTURES: the frozen edge cases with known-good answers.
//   - detectInvariantViolations / scoreFixture / evaluateGate: the scoring + gate.
//   - DEFAULT_GATE_THRESHOLDS: the plan's four go/no-go numbers.
//
// The LIVE drive (enqueue N dry-run cowork jobs against a running server, capture
// the legacy baseline as ground truth, feed samples in here) is script/run-buyin-eval.ts
// and is operator-run — it needs the server + sidecar + the agent runner.
// ─────────────────────────────────────────────────────────────────────────────

// What we expect the engine to do for a fixture.
export type GoldenExpectation =
  // Should find a combo filling at least `minSlotsFilled` slots (optionally under a cost ceiling).
  | { kind: "fills"; minSlotsFilled: number; maxComboCost?: number }
  // Should LEGITIMATELY come up empty (thin inventory / over-budget). Distinct from a miss.
  | { kind: "empty"; reason: string }
  // A planted duplicate half must be rejected (server dedup guard).
  | { kind: "rejects-duplicate" }
  // A forced partial combo must roll back to empty (all-or-nothing).
  | { kind: "rolls-back-partial" };

export type GoldenFixture = {
  id: string;
  label: string;
  description: string;
  // The dry-run job input the live harness submits (StartAutoFillInput-shaped).
  input: {
    reservationId: string;
    propertyId: number;
    propertyName: string;
    community: string | null;
    checkIn: string;
    checkOut: string;
    slots: Array<{ unitId: string; unitLabel: string; bedrooms: number }>;
    groundFloorBedrooms?: number[];
    expectedRevenue: number;
  };
  expected: GoldenExpectation;
};

// One run sample (a compact extract of a serialized AutoFillJobStatus + telemetry).
export type RunSample = {
  slotsFilled: number;
  slotsTotal: number;
  totalCost: number | null;
  expectedProfit: number | null;
  expectedRevenue: number;
  attachedUrls: string[];
  // Violations the engine/guards flagged at run time (the harness also derives the
  // structural ones below, so an unreported duplicate still counts).
  reportedViolations?: string[];
  costUsd?: number | null;
  latencyMs?: number | null;
  outcome?: string;
};

// Derive the hard structural invariant violations from a committed sample.
export function detectInvariantViolations(sample: RunSample): string[] {
  const v: string[] = [...(sample.reportedViolations ?? [])];
  // Duplicate physical listing attached twice.
  const urls = sample.attachedUrls.map((u) => normUrl(u)).filter(Boolean);
  if (new Set(urls).size < urls.length) v.push("duplicate-url");
  // Partial combo (some but not all slots filled) must never be committed.
  if (sample.slotsFilled > 0 && sample.slotsFilled < sample.slotsTotal) v.push("partial-combo");
  // Over the $100 max-loss cap (only when revenue is known → gate enabled).
  if (sample.expectedRevenue > 0 && sample.expectedProfit != null && sample.expectedProfit < -100) {
    v.push("over-loss");
  }
  return Array.from(new Set(v));
}

function normUrl(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return String(url).split("?")[0].replace(/\/+$/, "").toLowerCase();
  }
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, n) => s + n, 0) / xs.length : 0;
}
function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export type FixtureScore = {
  id: string;
  expectationKind: GoldenExpectation["kind"];
  // Ground truth from the legacy baseline run for this fixture.
  legacyFilled: number;
  legacyProfitable: boolean;
  // Agent N-run variance band.
  agentFillMean: number;
  agentFillMin: number;
  agentFillMax: number;
  samples: number;
  // Derived gate signals.
  fillParity: number; // agentFillMean / legacyFilled (1 when legacy filled 0, i.e. nothing to match)
  profitableComboMiss: boolean; // legacy found a profitable combo; agent never did across N runs
  invariantViolations: number; // total across all samples
  expectationMet: boolean; // did the agent satisfy the fixture's specific expectation?
  notes: string[];
};

// Score one fixture: its legacy baseline (ground truth) vs the agent's N samples.
export function scoreFixture(fx: GoldenFixture, legacy: RunSample, samples: RunSample[]): FixtureScore {
  const fills = samples.map((s) => s.slotsFilled);
  const agentFillMean = mean(fills);
  const legacyFilled = legacy.slotsFilled;
  const legacyProfitable = legacyFilled >= legacy.slotsTotal && legacyFilled > 0 &&
    (legacy.expectedRevenue <= 0 || (legacy.expectedProfit ?? 0) >= -100);
  const anyAgentProfitableFull = samples.some((s) =>
    s.slotsFilled >= s.slotsTotal && s.slotsFilled > 0 &&
    (s.expectedRevenue <= 0 || (s.expectedProfit ?? 0) >= -100));

  const invariantViolations = samples.reduce((sum, s) => sum + detectInvariantViolations(s).length, 0);

  const notes: string[] = [];
  let expectationMet = true;
  switch (fx.expected.kind) {
    case "fills": {
      const exp = fx.expected; // bind the narrowed variant so it survives closures
      const need = exp.minSlotsFilled;
      expectationMet = samples.every((s) => s.slotsFilled >= need);
      if (!expectationMet) notes.push(`some runs filled < ${need} slots (min ${Math.min(...fills, 0)})`);
      if (exp.maxComboCost != null) {
        const maxCost = exp.maxComboCost;
        const overCost = samples.some((s) => (s.totalCost ?? Infinity) > maxCost);
        if (overCost) { expectationMet = false; notes.push(`a run exceeded maxComboCost $${maxCost}`); }
      }
      break;
    }
    case "empty": {
      expectationMet = samples.every((s) => s.slotsFilled === 0);
      if (!expectationMet) notes.push(`expected legitimately empty (${fx.expected.reason}) but a run filled slots`);
      break;
    }
    case "rejects-duplicate": {
      // The planted duplicate must never both-attach: no duplicate-url violations and
      // never a same-url pair committed.
      expectationMet = samples.every((s) => !detectInvariantViolations(s).includes("duplicate-url"));
      if (!expectationMet) notes.push("a run attached the planted duplicate listing twice");
      break;
    }
    case "rolls-back-partial": {
      // Never leave a partial combo committed.
      expectationMet = samples.every((s) => !(s.slotsFilled > 0 && s.slotsFilled < s.slotsTotal));
      if (!expectationMet) notes.push("a run left a partial combo committed (no all-or-nothing rollback)");
      break;
    }
  }

  const fillParity = legacyFilled > 0 ? agentFillMean / legacyFilled : 1;
  const profitableComboMiss = legacyProfitable && !anyAgentProfitableFull;
  if (profitableComboMiss) notes.push("legacy found a profitable full combo; agent never did across N runs");

  return {
    id: fx.id,
    expectationKind: fx.expected.kind,
    legacyFilled,
    legacyProfitable,
    agentFillMean,
    agentFillMin: fills.length ? Math.min(...fills) : 0,
    agentFillMax: fills.length ? Math.max(...fills) : 0,
    samples: samples.length,
    fillParity,
    profitableComboMiss,
    invariantViolations,
    expectationMet,
    notes,
  };
}

export type GateThresholds = {
  minFillParity: number; // mean agent fills / legacy fills, across the golden set
  maxCostUsdPerRun: number; // mean cost per run ceiling
  // p95 agent latency must be <= legacy p95 * this factor (1 = no worse than legacy)
  maxLatencyFactorVsLegacy: number;
};

// The plan's go/no-go numbers.
export const DEFAULT_GATE_THRESHOLDS: GateThresholds = {
  minFillParity: 0.95,
  maxCostUsdPerRun: 3,
  maxLatencyFactorVsLegacy: 1,
};

export type GateResult = {
  pass: boolean;
  reasons: string[];
  overallFillParity: number;
  profitableComboMisses: number;
  invariantViolations: number;
  expectationFailures: number;
  meanCostUsd: number;
  agentP95LatencyMs: number;
  legacyP95LatencyMs: number;
};

// The DECIDABLE gate (plan §5): ≥95% fill parity, ZERO profitable-combo misses,
// ZERO invariant violations, every fixture expectation met, cost ≤ $Y, p95 ≤ legacy.
export function evaluateGate(
  scores: FixtureScore[],
  allSamples: RunSample[],
  legacySamples: RunSample[],
  thresholds: GateThresholds = DEFAULT_GATE_THRESHOLDS,
): GateResult {
  const reasons: string[] = [];

  // Fill parity over fixtures that legacy actually filled (an "empty" fixture has
  // legacyFilled 0 and parity 1, so it neither helps nor hurts).
  const parityScores = scores.filter((s) => s.legacyFilled > 0);
  const overallFillParity = parityScores.length ? mean(parityScores.map((s) => s.fillParity)) : 1;
  if (overallFillParity < thresholds.minFillParity) {
    reasons.push(`fill parity ${(overallFillParity * 100).toFixed(1)}% < ${(thresholds.minFillParity * 100).toFixed(0)}%`);
  }

  const profitableComboMisses = scores.filter((s) => s.profitableComboMiss).length;
  if (profitableComboMisses > 0) reasons.push(`${profitableComboMisses} profitable-combo miss(es) on the golden set`);

  const invariantViolations = scores.reduce((sum, s) => sum + s.invariantViolations, 0);
  if (invariantViolations > 0) reasons.push(`${invariantViolations} invariant violation(s) in committed results`);

  const expectationFailures = scores.filter((s) => !s.expectationMet).length;
  if (expectationFailures > 0) reasons.push(`${expectationFailures} fixture expectation(s) not met`);

  const costs = allSamples.map((s) => Number(s.costUsd) || 0).filter((n) => n > 0);
  const meanCostUsd = mean(costs);
  if (costs.length && meanCostUsd > thresholds.maxCostUsdPerRun) {
    reasons.push(`mean cost $${meanCostUsd.toFixed(2)}/run > $${thresholds.maxCostUsdPerRun}`);
  }

  const agentP95LatencyMs = percentile(allSamples.map((s) => Number(s.latencyMs) || 0).filter((n) => n > 0), 95);
  const legacyP95LatencyMs = percentile(legacySamples.map((s) => Number(s.latencyMs) || 0).filter((n) => n > 0), 95);
  if (legacyP95LatencyMs > 0 && agentP95LatencyMs > legacyP95LatencyMs * thresholds.maxLatencyFactorVsLegacy) {
    reasons.push(`agent p95 latency ${Math.round(agentP95LatencyMs)}ms > legacy p95 ${Math.round(legacyP95LatencyMs)}ms`);
  }

  return {
    pass: reasons.length === 0,
    reasons,
    overallFillParity,
    profitableComboMisses,
    invariantViolations,
    expectationFailures,
    meanCostUsd,
    agentP95LatencyMs,
    legacyP95LatencyMs,
  };
}

// ── the frozen golden fixture set (plan §5) ──────────────────────────────────
// Edit deliberately and rarely. The live harness submits each as a dry-run cowork
// job N times; the legacy engine run for the same input is the ground truth.
// Property ids/communities are representative of the real portfolio; the live
// harness validates them against the running server.
export const GOLDEN_FIXTURES: GoldenFixture[] = [
  {
    id: "princeville-duplicate",
    label: "Princeville same-unit relisted (dedup)",
    description:
      "A combo where the same physical unit is relisted under two VRBO ids (Cecilio Marquez incident). " +
      "The server dedup guard must never attach both halves.",
    input: {
      reservationId: "golden-princeville-dup",
      propertyId: 19,
      propertyName: "Princeville combo",
      community: "mauna kai princeville",
      checkIn: "2026-07-20",
      checkOut: "2026-07-27",
      slots: [
        { unitId: "A", unitLabel: "Unit A", bedrooms: 2 },
        { unitId: "B", unitLabel: "Unit B", bedrooms: 2 },
      ],
      expectedRevenue: 6000,
    },
    expected: { kind: "rejects-duplicate" },
  },
  {
    id: "poipu-kai-combo",
    label: "Poipu Kai 6BR = 3BR + 3BR (combo fills)",
    description: "A standard same-community combo that should fill both 3BR slots within budget.",
    input: {
      reservationId: "golden-poipu-kai-combo",
      propertyId: 4,
      propertyName: "Poipu Kai 6BR",
      community: "poipu kai",
      checkIn: "2026-09-12",
      checkOut: "2026-09-19",
      slots: [
        { unitId: "A", unitLabel: "Unit A", bedrooms: 3 },
        { unitId: "B", unitLabel: "Unit B", bedrooms: 3 },
      ],
      expectedRevenue: 9000,
    },
    expected: { kind: "fills", minSlotsFilled: 2 },
  },
  {
    id: "walkable-cluster-poipu-kiahuna",
    label: "Cross-complex walkable cluster (Poipu Kai + Kiahuna)",
    description:
      "A combo whose halves are in adjacent walkable complexes — must be allowed via the curated " +
      "WALKABLE_COMPLEX_CLUSTERS adjacency, not rejected as cross-resort.",
    input: {
      reservationId: "golden-walkable-cluster",
      propertyId: 4,
      propertyName: "Poipu walkable cluster",
      community: "poipu kai",
      checkIn: "2026-10-03",
      checkOut: "2026-10-10",
      slots: [
        { unitId: "A", unitLabel: "Unit A", bedrooms: 2 },
        { unitId: "B", unitLabel: "Unit B", bedrooms: 2 },
      ],
      expectedRevenue: 7000,
    },
    expected: { kind: "fills", minSlotsFilled: 2 },
  },
  {
    id: "ground-floor-required",
    label: "Ground-floor-required slot",
    description:
      "A single unit that requires a confirmed ground-floor listing. A pick without a " +
      "server-verifiable ground-floor snippet must be rejected for the slot.",
    input: {
      reservationId: "golden-ground-floor",
      propertyId: 4,
      propertyName: "Ground-floor required",
      community: "poipu kai",
      checkIn: "2026-08-15",
      checkOut: "2026-08-22",
      slots: [{ unitId: "A", unitLabel: "Unit A", bedrooms: 3 }],
      groundFloorBedrooms: [3],
      expectedRevenue: 5000,
    },
    expected: { kind: "fills", minSlotsFilled: 1 },
  },
  {
    id: "thin-inventory-empty",
    label: "Thin-inventory community (legitimately empty)",
    description:
      "A community with no usable inventory for the dates — the agent must come up EMPTY (no combo), " +
      "and the outcome must be no-combo-found, NOT a forced bad attach.",
    input: {
      reservationId: "golden-thin-empty",
      propertyId: 4,
      propertyName: "Thin inventory",
      community: "poipu kai",
      checkIn: "2026-12-24",
      checkOut: "2026-12-27",
      slots: [
        { unitId: "A", unitLabel: "Unit A", bedrooms: 4 },
        { unitId: "B", unitLabel: "Unit B", bedrooms: 4 },
      ],
      expectedRevenue: 4000,
    },
    expected: { kind: "empty", reason: "no walkable same-community 4BR+4BR inventory for a 3-night holiday stay" },
  },
  {
    id: "profit-gate-loss",
    label: "Profit-gate loss (over $100 max-loss → empty)",
    description:
      "The only available combo loses more than $100 vs the booking revenue. The profit gate must " +
      "REFUSE it (record a loss option) and leave the booking empty — never attach an over-loss combo.",
    input: {
      reservationId: "golden-profit-loss",
      propertyId: 4,
      propertyName: "Profit-gate loss",
      community: "poipu kai",
      checkIn: "2026-11-07",
      checkOut: "2026-11-10",
      slots: [
        { unitId: "A", unitLabel: "Unit A", bedrooms: 3 },
        { unitId: "B", unitLabel: "Unit B", bedrooms: 3 },
      ],
      expectedRevenue: 2000,
    },
    expected: { kind: "empty", reason: "cheapest walkable combo exceeds the $100 max-loss cap" },
  },
];
