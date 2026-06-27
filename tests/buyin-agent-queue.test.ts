import assert from "node:assert/strict";
import type { Request } from "express";

process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";

const {
  enqueueAgentRun,
  nextAgentRun,
  completeAgentRun,
  getAgentRunResult,
  stampAgentHeartbeat,
  getAgentHeartbeat,
  getAgentQueueStatus,
  cancelAgentRun,
  __resetBuyinAgentQueueForTests,
} = await import("../server/buyin-agent-queue");
const { isAgentAllowedPath } = await import("../server/auth");

function reqOf(method: string, path: string): Request {
  return { method, path } as Request;
}

const params = (jobId: string, reservationId: string) => ({
  jobId,
  reservationId,
  propertyId: 12,
  propertyName: "Test Property",
  community: "poipu kai",
  listingId: null,
  checkIn: "2026-08-01",
  checkOut: "2026-08-08",
  nights: 7,
  slots: [{ unitId: "A", unitLabel: "Unit A", bedrooms: 3 }],
  groundFloorBedrooms: [] as number[],
  expectedRevenue: 5000,
  dryRun: false,
});

console.log("buyin-agent-queue suite");

// ── enqueue → claim → complete (happy path) ──────────────────────────────────
{
  __resetBuyinAgentQueueForTests();
  const { id } = enqueueAgentRun(params("afj_1", "res_1"), { origin: "row", model: "claude-opus-4-8" });
  assert.ok(id.startsWith("bar_"), "run id has bar_ prefix");

  let st = getAgentQueueStatus();
  assert.equal(st.pending, 1);
  assert.equal(st.inProgress, 0);

  const claim = nextAgentRun();
  assert.ok(claim, "claim returns a run");
  assert.equal(claim!.id, id);
  assert.equal(claim!.origin, "row");
  assert.equal(claim!.model, "claude-opus-4-8");
  assert.equal(claim!.params.reservationId, "res_1");
  assert.equal(claim!.params.jobId, "afj_1");

  // Only one pending → second claim is null.
  assert.equal(nextAgentRun(), null, "no second pending run");

  st = getAgentQueueStatus();
  assert.equal(st.pending, 0);
  assert.equal(st.inProgress, 1);

  // Heartbeat shows online + busy after a claim.
  const hb = getAgentHeartbeat();
  assert.equal(hb.online, true, "online after claim");
  assert.equal(hb.busy, true, "busy with an in-progress run");

  // In-progress poll is not done.
  let poll = getAgentRunResult(id);
  assert.ok(poll);
  assert.equal(poll!.status, "in_progress");
  assert.equal(poll!.done, false);

  // Complete with an attached outcome.
  const done = completeAgentRun({ id, result: { outcome: "attached", message: "ok", candidates: [] } });
  assert.equal(done.ok, true);

  poll = getAgentRunResult(id);
  assert.equal(poll!.status, "completed");
  assert.equal(poll!.done, true);
  assert.equal(poll!.result?.outcome, "attached");

  // Idempotent re-complete.
  assert.equal(completeAgentRun({ id }).ok, true, "re-complete is idempotent");

  console.log("  ✓ enqueue → claim → complete, FIFO single-claim, heartbeat/online/busy, idempotent complete");
}

// ── FIFO ordering across two runs ─────────────────────────────────────────────
{
  __resetBuyinAgentQueueForTests();
  const a = enqueueAgentRun(params("afj_a", "res_a"));
  const b = enqueueAgentRun(params("afj_b", "res_b"));
  const first = nextAgentRun();
  assert.equal(first!.id, a.id, "oldest claimed first");
  const second = nextAgentRun();
  assert.equal(second!.id, b.id, "next-oldest claimed second");
  console.log("  ✓ claims pending runs oldest-first");
}

// ── error outcome reports as failed ───────────────────────────────────────────
{
  __resetBuyinAgentQueueForTests();
  const { id } = enqueueAgentRun(params("afj_e", "res_e"));
  nextAgentRun();
  completeAgentRun({ id, error: "Session precheck failed", result: { outcome: "session-invalid", candidates: [] } });
  const poll = getAgentRunResult(id);
  assert.equal(poll!.status, "failed");
  assert.equal(poll!.error, "Session precheck failed");
  assert.equal(poll!.result?.outcome, "session-invalid");
  console.log("  ✓ error/result reported as failed with the structured outcome");
}

// ── heartbeat liveness + reclaim/cancel semantics ────────────────────────────
{
  __resetBuyinAgentQueueForTests();
  // Unknown id heartbeat → not alive (runner should abandon).
  assert.equal(stampAgentHeartbeat("nope").alive, false, "unknown run id is not alive");

  const { id } = enqueueAgentRun(params("afj_h", "res_h"));
  nextAgentRun();
  assert.equal(stampAgentHeartbeat(id, "researching").alive, true, "in-progress run is alive");

  // Cancel (parent superseded) → failed; subsequent heartbeat not alive.
  assert.equal(cancelAgentRun(id), true);
  assert.equal(stampAgentHeartbeat(id).alive, false, "canceled run is not alive");
  assert.equal(getAgentRunResult(id)!.status, "failed");

  // Cancel of an unknown / already-terminal run → false.
  assert.equal(cancelAgentRun("nope"), false);
  assert.equal(cancelAgentRun(id), false, "re-cancel of a terminal run is false");
  console.log("  ✓ heartbeat aliveness, cancel marks failed, re-cancel is a no-op");
}

// ── unknown ids ───────────────────────────────────────────────────────────────
{
  __resetBuyinAgentQueueForTests();
  assert.equal(getAgentRunResult("missing"), null, "missing run → null");
  assert.equal(completeAgentRun({ id: "missing" }).ok, false, "complete missing → ok:false");
  console.log("  ✓ unknown run ids resolve null / ok:false");
}

// ── auth allowlist: runner endpoints are public (like the sidecar) ───────────
{
  assert.equal(isAgentAllowedPath(reqOf("GET", "/api/admin/buyin-agent/next")), true);
  assert.equal(isAgentAllowedPath(reqOf("POST", "/api/admin/buyin-agent/result")), true);
  assert.equal(isAgentAllowedPath(reqOf("POST", "/api/admin/buyin-agent/heartbeat")), true);
  // Sanity: a non-allowlisted admin route stays blocked.
  assert.equal(isAgentAllowedPath(reqOf("POST", "/api/pricing/bulk-refresh")), false);
  console.log("  ✓ /api/admin/buyin-agent/* is allowlisted; other admin routes stay blocked");
}

console.log("buyin-agent-queue suite passed");
