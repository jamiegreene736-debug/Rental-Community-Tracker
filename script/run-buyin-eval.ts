// ─────────────────────────────────────────────────────────────────────────────
// Cowork buy-in engine — LIVE golden eval harness (plan §5). OPERATOR-RUN.
//
// Drives the golden fixture set against a RUNNING server: for each fixture it runs
// the legacy engine once (ground truth) and the cowork engine N times (variance
// band), all in read-only dry-run via the per-run engineOverride, then scores them
// against the DECIDABLE gate and exits 0 (pass) / 1 (fail).
//
// Needs the live stack (server + sidecar + the buy-in agent runner online for the
// cowork pass). NOT part of `npm test` — the pure scoring/gate logic it uses is
// unit-tested in tests/buyin-agent-eval.test.ts.
//
// Usage:
//   BUYIN_EVAL_SERVER=https://your-app ADMIN_SECRET=… [BUYIN_EVAL_RUNS=5] \
//     npx tsx script/run-buyin-eval.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  GOLDEN_FIXTURES,
  scoreFixture,
  evaluateGate,
  type RunSample,
  type GoldenFixture,
} from "../server/buyin-agent-eval";

const SERVER = String(process.env.BUYIN_EVAL_SERVER || process.env.BUYIN_AGENT_SERVER || "").replace(/\/+$/, "");
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const RUNS = Math.max(1, Number(process.env.BUYIN_EVAL_RUNS) || 5);
const POLL_TIMEOUT_MS = Math.max(60_000, Number(process.env.BUYIN_EVAL_POLL_TIMEOUT_MS) || 30 * 60_000);
const POLL_INTERVAL_MS = 4000;

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (ADMIN_SECRET) h["X-Admin-Secret"] = ADMIN_SECRET;
  return h;
}

async function runOnce(fx: GoldenFixture, engine: "legacy" | "cowork"): Promise<RunSample> {
  const startedReq = Date.now();
  const startRes = await fetch(`${SERVER}/api/operations/auto-fill`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ ...fx.input, dryRun: true, engineOverride: engine, silent: true }),
  });
  const startData: any = await startRes.json().catch(() => ({}));
  if (!startRes.ok || !startData?.jobId) {
    throw new Error(`start failed (${engine}) for ${fx.id}: HTTP ${startRes.status} ${JSON.stringify(startData)}`);
  }
  const jobId = startData.jobId as string;

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let status: any = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const res = await fetch(`${SERVER}/api/operations/auto-fill/${encodeURIComponent(jobId)}`, { headers: headers() });
    status = await res.json().catch(() => ({}));
    if (status?.done) break;
  }
  if (!status?.done) throw new Error(`timed out polling ${engine} run for ${fx.id}`);

  const attached: any[] = Array.isArray(status.attached) ? status.attached : [];
  return {
    slotsFilled: Number(status.slotsFilled) || attached.length,
    slotsTotal: Number(status.slotsTotal) || fx.input.slots.length,
    totalCost: status.totalCost ?? null,
    expectedProfit: status.expectedProfit ?? null,
    expectedRevenue: Number(status.expectedRevenue) || fx.input.expectedRevenue,
    attachedUrls: attached.map((a) => String(a?.url ?? "")).filter(Boolean),
    latencyMs: status.timestamps?.finishedAt && status.timestamps?.startedAt
      ? status.timestamps.finishedAt - status.timestamps.startedAt
      : Date.now() - startedReq,
    outcome: status.message,
  };
}

async function main(): Promise<void> {
  if (!SERVER) {
    console.error("FATAL: set BUYIN_EVAL_SERVER (the running app base URL).");
    process.exit(2);
  }
  console.log(`Buy-in cowork eval — server=${SERVER} runs/fixture=${RUNS} fixtures=${GOLDEN_FIXTURES.length}\n`);

  const scores = [];
  const allCowork: RunSample[] = [];
  const allLegacy: RunSample[] = [];

  for (const fx of GOLDEN_FIXTURES) {
    process.stdout.write(`• ${fx.id} … `);
    let legacy: RunSample;
    try {
      legacy = await runOnce(fx, "legacy");
    } catch (e: any) {
      console.log(`legacy baseline FAILED: ${e?.message ?? e}`);
      continue;
    }
    allLegacy.push(legacy);

    const samples: RunSample[] = [];
    for (let i = 0; i < RUNS; i++) {
      try {
        samples.push(await runOnce(fx, "cowork"));
      } catch (e: any) {
        console.log(`\n   cowork run ${i + 1}/${RUNS} FAILED: ${e?.message ?? e}`);
      }
    }
    allCowork.push(...samples);
    const sc = scoreFixture(fx, legacy, samples);
    scores.push(sc);
    console.log(
      `legacy=${legacy.slotsFilled}/${legacy.slotsTotal} agentFill=${sc.agentFillMean.toFixed(2)} ` +
        `parity=${(sc.fillParity * 100).toFixed(0)}% miss=${sc.profitableComboMiss} ` +
        `viol=${sc.invariantViolations} met=${sc.expectationMet}` +
        (sc.notes.length ? `\n   notes: ${sc.notes.join("; ")}` : ""),
    );
  }

  const gate = evaluateGate(scores, allCowork, allLegacy);
  console.log("\n──────── GATE ────────");
  console.log(`fill parity:           ${(gate.overallFillParity * 100).toFixed(1)}%`);
  console.log(`profitable-combo miss: ${gate.profitableComboMisses}`);
  console.log(`invariant violations:  ${gate.invariantViolations}`);
  console.log(`expectation failures:  ${gate.expectationFailures}`);
  console.log(`mean cost/run:         $${gate.meanCostUsd.toFixed(2)}`);
  console.log(`p95 latency agent/legacy: ${Math.round(gate.agentP95LatencyMs)}ms / ${Math.round(gate.legacyP95LatencyMs)}ms`);
  console.log(`\nRESULT: ${gate.pass ? "PASS ✅" : "FAIL ❌"}`);
  if (!gate.pass) for (const r of gate.reasons) console.log(`  - ${r}`);
  process.exit(gate.pass ? 0 : 1);
}

void main();
