// ─────────────────────────────────────────────────────────────────────────────
// Cowork buy-in engine — the agent-driven replacement for the legacy 4-stage
// auto-fill ladder (see the plan: "Replace the buy-in tool with an autonomous
// cowork agent engine").
//
// SEAM: server/auto-fill-job.ts runAutoFillJob() forks here when the engine for
// the run resolves to "cowork" (BUYIN_ENGINE for row runs, BUYIN_ENGINE_BULK for
// the bulk queue — gated separately so a single-reservation cutover never drags
// the whole bulk fleet onto Opus). runCoworkAutoFillJob mutates the SAME AutoFillJob
// object and reuses the legacy helpers (attachPick, reconcile, finalize, touch,
// the profit gate) passed in via `deps` — so serializeAutoFillJob is unchanged and
// the client poller + UI work untouched, and every load-bearing invariant stays a
// server-side guard the agent cannot bypass (plan §4).
//
// GOVERNING PRINCIPLE: the agent PROPOSES (which listing + price + bedrooms), the
// server COMMITS (profit gate, walkability, dedup, proximity, all-or-nothing).
//
// IMPORT DISCIPLINE: this module imports ONLY TYPES from ./auto-fill-job (erased
// at runtime) and receives every runtime helper through `deps`. auto-fill-job.ts
// imports the VALUES here (buyInEngine*, runCoworkAutoFillJob). That keeps the
// runtime dependency one-directional (auto-fill-job → cowork) with no circular
// require — do not add a value import from ./auto-fill-job here.
// ─────────────────────────────────────────────────────────────────────────────

import type { ProfitVerdict } from "@shared/buy-in-profit";
import type {
  AutoFillJob,
  AutoFillSlotInput,
  AttachStage,
  AttachPickArgs,
  CityEconomics,
  LossComboScope,
} from "./auto-fill-job";

export type BuyInEngine = "legacy" | "cowork";

// Row "Auto-fill cheapest" engine. Default legacy.
export function buyInEngine(): BuyInEngine {
  return process.env.BUYIN_ENGINE === "cowork" ? "cowork" : "legacy";
}
// Bulk-queue engine — SEPARATE knob (plan §1). Default legacy so a single-
// reservation cutover (BUYIN_ENGINE=cowork) does NOT turn the next bulk run into a
// fleet of concurrent Opus agent runs through one Chrome. Flip only after the §5
// gate is re-run under bulk concurrency.
export function buyInEngineBulk(): BuyInEngine {
  return process.env.BUYIN_ENGINE_BULK === "cowork" ? "cowork" : "legacy";
}
// Resolve the engine for a given job owner.
export function resolveBuyInEngine(owner: "row" | "bulk"): BuyInEngine {
  return owner === "bulk" ? buyInEngineBulk() : buyInEngine();
}

// The legacy run-scoped helpers the cowork engine reuses. Passed from the fork
// point in runAutoFillJob (all in scope there) so this module needs no value
// import from auto-fill-job.
export type CoworkDeps = {
  base: string;
  // Profit gate on a proposed combo cost, evaluated on the RUNNING committed total.
  gate: (comboCost: number) => ProfitVerdict;
  committedCost: () => number;
  remainingSlots: () => AutoFillSlotInput[];
  // The cross-slot used-identity set (no same listing twice).
  used: Set<string>;
  recordEconomics: (
    source: AttachStage,
    label: string,
    comboCost: number,
    profit: number,
    accepted: boolean,
    reason?: string,
    units?: CityEconomics["units"],
  ) => void;
  recordLossComboOption: (label: string, pair: any, comboCost: number, profit: number, scope: LossComboScope) => void;
  // Legacy commit + lifecycle helpers (the unbypassable server-side chokepoints).
  attachPick: (args: AttachPickArgs) => Promise<boolean>;
  reconcile: (job: AutoFillJob) => Promise<void>;
  finalize: (job: AutoFillJob) => void;
  touch: (job: AutoFillJob, patch?: Partial<AutoFillJob>) => void;
  setEscalation: (job: AutoFillJob, patch: Partial<AutoFillJob["escalation"]>) => void;
};

// Run the cowork (agent-driven) engine for this job.
//
// Returns TRUE when the agent owned the run (job already finalized) and the caller
// must NOT continue to the legacy ladder. Returns FALSE to fall through to legacy.
//
// PHASE 0 (scaffold): always returns false so BUYIN_ENGINE=cowork is byte-identical
// to legacy. The queue/runner/admin-route transport is stood up in parallel; the
// orchestration (enqueue → poll → propose_attach → finalize) lands in Phase 2.
export async function runCoworkAutoFillJob(job: AutoFillJob, _deps: CoworkDeps): Promise<boolean> {
  console.log(
    `[buyin-cowork] engine=cowork selected for reservation ${job.reservationId} (job ${job.id}); ` +
      `Phase-0 scaffold — not yet implemented, falling through to the legacy ladder.`,
  );
  return false;
}
