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
import {
  enqueueAgentRun,
  getAgentRunResult,
  cancelAgentRun,
  type BuyinAgentOutcome,
  type BuyinAgentRunResult,
} from "./buyin-agent-queue";
import { registerCommitContext, unregisterCommitContext } from "./buyin-agent-commit";

// Server-side poll ceiling: slightly longer than the runner's own wall-clock budget
// (BUYIN_AGENT_RUN_BUDGET_MS, default 25 min) so the runner reports a terminal
// outcome first; if it dies, this timeout fails the job cleanly (plan §7).
const AGENT_POLL_TIMEOUT_MS = Math.max(60_000, Number(process.env.BUYIN_AGENT_POLL_TIMEOUT_MS) || 30 * 60_000);
const AGENT_POLL_INTERVAL_MS = 3000;
const ERROR_OUTCOMES: BuyinAgentOutcome[] = ["session-invalid", "bot-walled", "budget-exhausted", "agent-error"];

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

// Human-readable terminal summary for a structured agent outcome (plan §5: every
// run must say WHY, especially why empty). Pure → unit-tested.
export function buildOutcomeSummary(
  outcome: BuyinAgentOutcome,
  candidates: unknown[] | undefined,
  filled: number,
  total: number,
  agentMessage?: string | null,
): string {
  const n = Array.isArray(candidates) ? candidates.length : 0;
  const base = (agentMessage ?? "").trim();
  switch (outcome) {
    case "attached":
      return base || `Agent attached ${filled}/${total} unit(s) from ${n} candidate(s) considered.`;
    case "no-combo-found":
      return base || `Agent found no profitable, walkable combo (${n} candidate(s) considered).`;
    case "session-invalid":
      return `⚠️ Buy-in agent session invalid (logged out?) — ${base || "could not verify VRBO/Airbnb sign-in"}. No reliable search performed; handle this reservation manually.`;
    case "bot-walled":
      return `⚠️ Buy-in agent hit a bot wall — ${base || "blocked before completing the search"}. Handle manually.`;
    case "budget-exhausted":
      return `⚠️ Buy-in agent ran out of time — ${base || "no combo within the wall-clock budget"} (${n} candidate(s) considered).`;
    case "agent-error":
      return `⚠️ Buy-in agent error — ${base || "the run failed"}. Handle manually.`;
    default:
      return base || `Buy-in agent outcome: ${outcome}.`;
  }
}

function slotSkipReason(outcome: BuyinAgentOutcome): string {
  switch (outcome) {
    case "no-combo-found": return "agent found no profitable, walkable unit for this slot";
    case "session-invalid": return "agent session invalid (logged out?) — not searched; handle manually";
    case "bot-walled": return "agent blocked by a bot wall — handle manually";
    case "budget-exhausted": return "agent ran out of time before filling this slot";
    case "agent-error": return "agent error before filling this slot — handle manually";
    default: return `agent did not fill this slot (${outcome})`;
  }
}

// Run the cowork (agent-driven) engine for this job.
//
// Returns TRUE when the agent owned the run (job already finalized) and the caller
// must NOT continue to the legacy ladder. (The cowork engine is a CLEAN cutover —
// it never falls back to the legacy ladder; an empty/failed run leaves the slot for
// manual handling, surfaced loudly via the structured outcome.)
//
// Flow (plan §2/§3): register the commit context so the runner's propose_attach can
// commit onto THIS job → enqueue one agent run → poll the in-process agent queue
// until terminal (or the server-side timeout) → reconcile all-or-nothing → apply the
// structured outcome to the job → finalize.
export async function runCoworkAutoFillJob(job: AutoFillJob, deps: CoworkDeps): Promise<boolean> {
  deps.touch(job, { status: "running", phase: "agent", message: "Dispatching the buy-in agent…", progress: 8, startedAt: job.startedAt ?? Date.now() });

  // Nothing to do — every slot already filled (sibling slots / a resumed run).
  if (deps.remainingSlots().length === 0) {
    deps.touch(job, { status: "completed", phase: "done", message: "All slots were already filled.", progress: 100, finishedAt: Date.now() });
    deps.finalize(job);
    return true;
  }

  registerCommitContext(job.id, { job, deps });
  let runId: string | null = null;
  try {
    const model = job.owner === "bulk"
      ? (process.env.BUYIN_AGENT_BULK_MODEL || null)
      : (process.env.BUYIN_AGENT_MODEL || null);
    const enq = enqueueAgentRun(
      {
        jobId: job.id,
        reservationId: job.reservationId,
        propertyId: job.propertyId,
        propertyName: job.propertyName,
        community: job.community,
        listingId: job.listingId,
        checkIn: job.checkIn,
        checkOut: job.checkOut,
        nights: job.nights,
        slots: job.slots.map((s) => ({ unitId: s.unitId, unitLabel: s.unitLabel, bedrooms: s.bedrooms })),
        groundFloorBedrooms: Array.from(job.groundFloorBedrooms),
        expectedRevenue: job.expectedRevenue,
        dryRun: job.dryRun,
      },
      { origin: job.owner, model },
    );
    runId = enq.id;
    deps.touch(job, { phase: "agent", message: "Buy-in agent searching (VRBO/Airbnb via the sidecar, plus Google + PM sites)…", progress: 18 });

    // Poll the in-process agent queue. propose_attach mutates job.attached as the
    // agent commits, so progress reflects real fills.
    const deadline = Date.now() + AGENT_POLL_TIMEOUT_MS;
    let result: BuyinAgentRunResult | null = null;
    let terminalError: string | null = null;
    while (Date.now() < deadline) {
      if (job.canceled) break;
      const poll = getAgentRunResult(runId);
      if (poll?.done) {
        result = poll.result ?? null;
        terminalError = poll.error ?? null;
        break;
      }
      // Reflect committed progress while the agent works.
      if (job.attached.length > 0) {
        const pct = Math.min(92, 18 + Math.round((job.attached.length / Math.max(1, job.slots.length)) * 70));
        if (pct !== job.progress) deps.touch(job, { progress: pct, message: `Buy-in agent attached ${job.attached.length}/${job.slots.length}…` });
      }
      await new Promise((r) => setTimeout(r, AGENT_POLL_INTERVAL_MS));
    }

    if (job.canceled) {
      cancelAgentRun(runId);
      deps.finalize(job);
      return true;
    }

    // Derive the outcome. A missing terminal (timed out) is budget-exhausted.
    let outcome: BuyinAgentOutcome = result?.outcome
      ?? (terminalError ? "agent-error" : "budget-exhausted");
    const agentMessage = result?.message ?? terminalError ?? null;
    const candidates = result?.candidates;

    // ALL-OR-NOTHING for combo bookings: a partial combo rolls back to empty.
    await deps.reconcile(job);

    const filled = job.attached.length;
    const total = job.slots.length;
    // If the agent reported "attached" but reconciliation rolled a partial back to
    // empty, downgrade the outcome so the summary is honest.
    if (outcome === "attached" && filled === 0) outcome = "no-combo-found";

    // Stash the structured outcome + the considered candidate set durably (comboOptions
    // is persisted by finalize → upsertAutoFillLossOptions) for debuggability (plan §5).
    job.comboOptions.push({
      agentOutcome: outcome,
      agentMessage,
      candidates: Array.isArray(candidates) ? candidates : [],
      usage: result?.usage ?? null,
      at: Date.now(),
    });

    // Per-slot skip reasons for anything left unfilled.
    for (const slot of job.slots) {
      if (job.attached.some((a) => a.unitId === slot.unitId)) continue;
      if (job.skipped.some((s) => s.unitId === slot.unitId)) continue;
      job.skipped.push({ unitId: slot.unitId, unitLabel: slot.unitLabel, reason: `${slot.unitLabel}: ${slotSkipReason(outcome)}` });
    }

    deps.setEscalation(job, {
      homeCity: filled > 0 ? "found" : "no-pair",
      foundAt: filled > 0 ? "home-city" : null,
    });

    const isError = ERROR_OUTCOMES.includes(outcome) && filled < total;
    const summary = buildOutcomeSummary(outcome, candidates, filled, total, agentMessage);
    deps.touch(job, {
      status: isError ? "failed" : "completed",
      phase: "done",
      message: summary,
      progress: 100,
      error: isError ? (agentMessage || outcome) : null,
      finishedAt: Date.now(),
    });
    deps.finalize(job);
    return true;
  } catch (e: any) {
    if (runId) cancelAgentRun(runId);
    deps.touch(job, { status: "failed", phase: "done", message: `⚠️ Buy-in agent engine error — ${String(e?.message ?? e)}`, error: String(e?.message ?? e), progress: 100, finishedAt: Date.now() });
    deps.finalize(job);
    return true;
  } finally {
    unregisterCommitContext(job.id);
  }
}
