// ─────────────────────────────────────────────────────────────────────────────
// Buy-in AGENT run queue — the transport between the Railway server and the
// operator's LOCAL Mac "buy-in agent" runner (daemon/buyin-agent/runner.mjs).
//
// WHY A SEPARATE QUEUE (not a new op type on vrbo-sidecar-queue.ts): the sidecar
// queue is tuned for SHORT single scrapes across ~14 op types (dedup by request
// key, 60s completed-result cache, per-op concurrency groups, hard timeouts in
// the low minutes). A buy-in AGENT run is the opposite: ONE long multi-site
// reasoning session (minutes to tens of minutes) that itself drives the sidecar
// queue as a sub-step. Bolting it onto the shared queue would inherit the wrong
// lifecycle and risk the whole pricing/photos/availability pipeline. So this is a
// deliberately lean, purpose-built mirror of the same three primitives
// (enqueue / next / complete) + a heartbeat, in-memory only (lost on redeploy —
// fine, because the buy-in job that drives it is itself boot-resumed and every
// pick persists to Postgres the moment it attaches; see server/auto-fill-job.ts).
//
// The runner authenticates with X-Admin-Secret and reaches these via the admin
// routes in server/routes.ts (/api/admin/buyin-agent/*), which are added to the
// portal auth allowlist exactly like the sidecar (see server/auth.ts).
// ─────────────────────────────────────────────────────────────────────────────

export type BuyinAgentRunOrigin = "row" | "bulk";

// The buy-in spec handed to the agent. jobId ties the run back to the in-memory
// AutoFillJob (server/auto-fill-job.ts) so the agent's propose_attach tool can
// look up + mutate the live job server-side (wired in Phase 2).
export type BuyinAgentRunParams = {
  jobId: string;
  reservationId: string;
  propertyId: number;
  propertyName: string;
  community: string | null;
  listingId: string | null;
  checkIn: string;
  checkOut: string;
  nights: number;
  slots: Array<{ unitId: string; unitLabel: string; bedrooms: number }>;
  groundFloorBedrooms: number[];
  expectedRevenue: number;
  dryRun: boolean;
  // BUYIN_ALLOW_LOSS mode: attach the cheapest VALID combo even at a loss (the server
  // still enforces it; this tells the agent to phrase its search accordingly).
  allowLoss?: boolean;
};

// Discriminated outcome the runner reports (see plan §5: every run must say WHY,
// especially why empty — a logged-out session must NOT look like a legit empty).
export type BuyinAgentOutcome =
  | "attached"
  | "no-combo-found"
  | "budget-exhausted"
  | "bot-walled"
  | "session-invalid"
  | "agent-error";

export type BuyinAgentRunResult = {
  outcome: BuyinAgentOutcome;
  // Free-form summary for the operator + the durable doneMessage.
  message?: string;
  // The candidate set the agent considered, each with a per-candidate reason, so a
  // recall miss is debuggable and distinguishable from an infra failure.
  candidates?: Array<{
    url?: string;
    title?: string;
    bedrooms?: number | null;
    totalPrice?: number | null;
    source?: string;
    decision?: "attached" | "rejected" | "considered";
    reason?: string;
  }>;
  // Telemetry for cost/latency attribution per origin.
  usage?: { inputTokens?: number; outputTokens?: number; toolCalls?: number; costUsd?: number };
};

type RunStatus = "pending" | "in_progress" | "completed" | "failed";

type AgentRun = {
  id: string;
  status: RunStatus;
  origin: BuyinAgentRunOrigin;
  model: string | null;
  params: BuyinAgentRunParams;
  result: BuyinAgentRunResult | null;
  error: string | null;
  createdAt: number;
  claimedAt: number | null;
  completedAt: number | null;
  heartbeatAt: number | null;
  stage: string | null;
};

// ── tuning ───────────────────────────────────────────────────────────────────
// The runner is considered ONLINE if it has polled/heartbeated within this window.
const ONLINE_WINDOW_MS = Math.max(30_000, Number(process.env.BUYIN_AGENT_ONLINE_WINDOW_MS) || 90_000);
// An in_progress run with no heartbeat for this long is reclaimed (the runner died
// mid-run). Generous because agent runs are long — but the runner heartbeats every
// few seconds, so a 5-min silence is a real death, not normal work.
const RECLAIM_MS = Math.max(60_000, Number(process.env.BUYIN_AGENT_RECLAIM_MS) || 5 * 60_000);
// A pending run not claimed within this window is stale (no runner online) — drop it
// so the server-side poll fails cleanly rather than hanging forever.
const PENDING_TTL_MS = Math.max(60_000, Number(process.env.BUYIN_AGENT_PENDING_TTL_MS) || 20 * 60_000);
// Keep a terminal run around this long so the server-side poll can read the result.
const TERMINAL_TTL_MS = Math.max(60_000, Number(process.env.BUYIN_AGENT_TERMINAL_TTL_MS) || 30 * 60_000);

// ── store ──────────────────────────────────────────────────────────────────
const runs = new Map<string, AgentRun>();
let lastWorkerSeenAt = 0;

function newRunId(): string {
  return `bar_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isTerminal(s: RunStatus): boolean {
  return s === "completed" || s === "failed";
}

function cleanup(): void {
  const now = Date.now();
  for (const [id, run] of Array.from(runs.entries())) {
    if (isTerminal(run.status)) {
      if (now - (run.completedAt ?? run.createdAt) > TERMINAL_TTL_MS) runs.delete(id);
      continue;
    }
    // A pending run nobody claimed in time → expire (fail) so the poll can resolve.
    if (run.status === "pending" && now - run.createdAt > PENDING_TTL_MS) {
      run.status = "failed";
      run.error = "No buy-in agent runner claimed this run (runner offline?)";
      run.completedAt = now;
      continue;
    }
    // An in_progress run whose runner went silent → reclaim back to pending.
    if (run.status === "in_progress" && now - (run.heartbeatAt ?? run.claimedAt ?? run.createdAt) > RECLAIM_MS) {
      run.status = "pending";
      run.claimedAt = null;
      run.heartbeatAt = null;
      run.stage = null;
    }
  }
}
setInterval(cleanup, 30_000).unref?.();

// ── primitives ─────────────────────────────────────────────────────────────
export function enqueueAgentRun(
  params: BuyinAgentRunParams,
  opts?: { origin?: BuyinAgentRunOrigin; model?: string | null },
): { id: string } {
  cleanup();
  const id = newRunId();
  const now = Date.now();
  runs.set(id, {
    id,
    status: "pending",
    origin: opts?.origin === "bulk" ? "bulk" : "row",
    model: opts?.model ?? null,
    params,
    result: null,
    error: null,
    createdAt: now,
    claimedAt: null,
    completedAt: null,
    heartbeatAt: null,
    stage: null,
  });
  return { id };
}

// Claim the oldest pending run for the runner. Marks it in_progress + stamps
// liveness. Returns the run params (the runner doesn't need the bookkeeping).
export function nextAgentRun(): { id: string; origin: BuyinAgentRunOrigin; model: string | null; params: BuyinAgentRunParams } | null {
  cleanup();
  lastWorkerSeenAt = Date.now();
  let oldest: AgentRun | null = null;
  for (const run of Array.from(runs.values())) {
    if (run.status !== "pending") continue;
    if (!oldest || run.createdAt < oldest.createdAt) oldest = run;
  }
  if (!oldest) return null;
  oldest.status = "in_progress";
  oldest.claimedAt = Date.now();
  oldest.heartbeatAt = Date.now();
  return { id: oldest.id, origin: oldest.origin, model: oldest.model, params: oldest.params };
}

export function completeAgentRun(args: { id: string; result?: BuyinAgentRunResult; error?: string }): { ok: boolean; reason?: string } {
  lastWorkerSeenAt = Date.now();
  const run = runs.get(args.id);
  if (!run) return { ok: false, reason: "unknown run id (expired?)" };
  if (isTerminal(run.status)) return { ok: true }; // idempotent
  run.completedAt = Date.now();
  run.heartbeatAt = Date.now();
  if (args.error) {
    run.status = "failed";
    run.error = String(args.error);
    run.result = args.result ?? null;
  } else {
    run.status = "completed";
    run.result = args.result ?? { outcome: "no-combo-found" };
  }
  return { ok: true };
}

// Worker liveness tick while it holds a long-running claim. Returns whether the
// run still exists (so the runner can abandon a run the server already reclaimed).
export function stampAgentHeartbeat(id?: string, stage?: string): { alive: boolean } {
  lastWorkerSeenAt = Date.now();
  if (!id) return { alive: true };
  const run = runs.get(id);
  if (!run || isTerminal(run.status)) return { alive: false };
  run.heartbeatAt = Date.now();
  if (typeof stage === "string") run.stage = stage;
  return { alive: true };
}

// Server-side poll target (the cowork engine reads this until terminal).
export function getAgentRunResult(id: string): {
  id: string;
  status: RunStatus;
  done: boolean;
  result: BuyinAgentRunResult | null;
  error: string | null;
  stage: string | null;
  createdAt: number;
  completedAt: number | null;
} | null {
  const run = runs.get(id);
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    done: isTerminal(run.status),
    result: run.result,
    error: run.error,
    stage: run.stage,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
  };
}

export function getAgentHeartbeat(): { online: boolean; lastSeenAt: number | null; busy: boolean } {
  cleanup();
  const now = Date.now();
  const busy = Array.from(runs.values()).some((r) => r.status === "in_progress");
  return {
    online: lastWorkerSeenAt > 0 && now - lastWorkerSeenAt < ONLINE_WINDOW_MS,
    lastSeenAt: lastWorkerSeenAt || null,
    busy,
  };
}

export function getAgentQueueStatus(): {
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  online: boolean;
  lastSeenAt: number | null;
} {
  cleanup();
  let pending = 0, inProgress = 0, completed = 0, failed = 0;
  for (const r of Array.from(runs.values())) {
    if (r.status === "pending") pending++;
    else if (r.status === "in_progress") inProgress++;
    else if (r.status === "completed") completed++;
    else if (r.status === "failed") failed++;
  }
  const hb = getAgentHeartbeat();
  return { pending, inProgress, completed, failed, online: hb.online, lastSeenAt: hb.lastSeenAt };
}

// Cancel a run (used when the parent AutoFillJob is superseded/canceled).
export function cancelAgentRun(id: string): boolean {
  const run = runs.get(id);
  if (!run || isTerminal(run.status)) return false;
  run.status = "failed";
  run.error = "Canceled by the server (parent job superseded)";
  run.completedAt = Date.now();
  return true;
}

// Test-only: reset all in-memory state.
export function __resetBuyinAgentQueueForTests(): void {
  runs.clear();
  lastWorkerSeenAt = 0;
}
