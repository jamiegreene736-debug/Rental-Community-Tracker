// ─────────────────────────────────────────────────────────────────────────────
// Buy-in AGENT runner — the LOCAL Mac process for the cowork buy-in engine.
//
// Polls the Railway server's agent queue (/api/admin/buyin-agent/next), runs an
// autonomous Claude agent that researches replacement rentals (VRBO/Airbnb via the
// sidecar tools, plus open-ended Google + property-manager-site research), and
// reports a structured outcome back (/api/admin/buyin-agent/result). Mirrors the
// sidecar daemon's launchd/keep-awake model; runs on the operator's Mac so the
// agent's tools drive THEIR logged-in sessions / home IP. See cowork plan §2/§3/§7.
//
// PHASE 0 (scaffold): the agent loop itself is NOT implemented yet — the cowork
// engine still falls through to the legacy ladder, so no run is ever enqueued. This
// runner stands up the poll + heartbeat + keep-awake + session-precheck transport so
// "runner polls + heartbeats green" is verifiable and Phase 2 only fills in
// runAgent(). If a run IS claimed (e.g. once Phase 2 enqueues), Phase 0 reports a
// clear agent-error rather than silently hanging.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from "child_process";

const SERVER = String(process.env.BUYIN_AGENT_SERVER || process.env.SIDECAR_SERVER || "").replace(/\/+$/, "");
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const POLL_IDLE_MS = Math.max(1000, Number(process.env.BUYIN_AGENT_POLL_IDLE_MS) || 5000);
const HEARTBEAT_MS = Math.max(2000, Number(process.env.BUYIN_AGENT_HEARTBEAT_MS) || 10_000);
const RUN_BUDGET_MS = Math.max(60_000, Number(process.env.BUYIN_AGENT_RUN_BUDGET_MS) || 25 * 60_000);
const MODEL = process.env.BUYIN_AGENT_MODEL || "claude-opus-4-8";
const KEEP_AWAKE =
  process.platform === "darwin" && (process.env.BUYIN_AGENT_KEEP_MAC_AWAKE ?? "1") !== "0";

let shuttingDown = false;
let caffeinateChild = null;

function log(message) {
  console.log(`[${new Date().toISOString()}] [buyin-agent-runner] ${message}`);
}

function authHeaders(contentType) {
  const h = {};
  if (contentType) h["Content-Type"] = contentType;
  if (ADMIN_SECRET) h["X-Admin-Secret"] = ADMIN_SECRET;
  return h;
}

async function httpJson(method, path, body, timeoutMs = 15_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${SERVER}${path}`, {
      method,
      headers: authHeaders(body !== undefined ? "application/json" : undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

// ── keep the Mac awake while a run is in flight ──────────────────────────────
function setCaffeinate(on) {
  if (!KEEP_AWAKE) return;
  if (on === !!caffeinateChild) return;
  if (on) {
    try {
      caffeinateChild = spawn("caffeinate", ["-i", "-m"], { stdio: "ignore" });
      caffeinateChild.on("exit", () => { caffeinateChild = null; });
      log("caffeinate held — Mac will not idle-sleep while an agent run is in flight");
    } catch (e) {
      caffeinateChild = null;
      log(`caffeinate spawn failed: ${e?.message ?? e}`);
    }
  } else {
    try { caffeinateChild?.kill(); } catch { /* ignore */ }
    caffeinateChild = null;
    log("caffeinate released — runner idle");
  }
}

// ── session-validity precheck (plan §7) ──────────────────────────────────────
// A logged-out VRBO/Airbnb session returns "no results" that looks IDENTICAL to a
// legitimately-empty search. Before running the agent, confirm the operator's
// sessions are authenticated so we can fail loudly (outcome "session-invalid")
// up front instead of after a fruitless walk.
//
// PHASE 0 stub: returns ok=true. Phase 2 wires this to a real check via the
// sidecar (open a known authed page, confirm not a login wall).
async function precheckSessions() {
  return { ok: true, reason: "phase-0 stub (session precheck not yet wired)" };
}

// ── the agent loop ───────────────────────────────────────────────────────────
// PHASE 0 stub: not implemented. Phase 2 implements the Claude Agent SDK loop with
// the buy-in tool surface (read context/towns/walkability/profit, sidecar scrape
// tools, web_search, and propose_attach as the single commit chokepoint).
async function runAgent(_run, _onStage) {
  return {
    outcome: "agent-error",
    message:
      "buy-in agent runner is the Phase-0 scaffold — the agent loop is not implemented yet. " +
      "The cowork engine should still be falling through to the legacy ladder; if you see this, " +
      "BUYIN_ENGINE/BUYIN_ENGINE_BULK was flipped to cowork before Phase 2 landed.",
    candidates: [],
  };
}

async function handleRun(run) {
  const id = run.id;
  log(`claimed run ${id} for reservation ${run.params?.reservationId} (origin=${run.origin}, model=${run.model || MODEL})`);
  setCaffeinate(true);
  let alive = true;
  const heartbeat = setInterval(async () => {
    try {
      const r = await httpJson("POST", "/api/admin/buyin-agent/heartbeat", { id });
      if (r.ok && r.data && r.data.alive === false) {
        alive = false;
        log(`run ${id} was reclaimed/canceled server-side — abandoning`);
      }
    } catch { /* transient; keep going */ }
  }, HEARTBEAT_MS);

  const budget = setTimeout(() => { alive = false; }, RUN_BUDGET_MS);

  let result;
  try {
    const pre = await precheckSessions();
    if (!pre.ok) {
      result = { outcome: "session-invalid", message: `Session precheck failed: ${pre.reason}`, candidates: [] };
    } else {
      result = await runAgent(run, (stage) => {
        if (!alive) return;
        httpJson("POST", "/api/admin/buyin-agent/heartbeat", { id, stage }).catch(() => {});
      });
    }
  } catch (e) {
    result = { outcome: "agent-error", message: String(e?.message ?? e), candidates: [] };
  } finally {
    clearInterval(heartbeat);
    clearTimeout(budget);
    setCaffeinate(false);
  }

  if (!alive && (!result || result.outcome !== "session-invalid")) {
    // Budget exhausted or server reclaimed — report honestly.
    result = result && result.outcome === "attached"
      ? result
      : { outcome: "budget-exhausted", message: "Agent run exceeded its wall-clock budget or was reclaimed.", candidates: result?.candidates ?? [] };
  }

  // An "agent-error"/"session-invalid"/"budget-exhausted" outcome is reported as an
  // error so the server-side poll surfaces it loudly; "attached"/"no-combo-found" are
  // normal terminal results.
  const isError = result.outcome === "agent-error" || result.outcome === "session-invalid" || result.outcome === "budget-exhausted" || result.outcome === "bot-walled";
  await httpJson("POST", "/api/admin/buyin-agent/result", {
    id,
    result,
    error: isError ? result.message || result.outcome : undefined,
  }).catch((e) => log(`failed to post result for ${id}: ${e?.message ?? e}`));
  log(`reported run ${id}: ${result.outcome}`);
}

async function pollOnce() {
  const r = await httpJson("GET", "/api/admin/buyin-agent/next");
  if (!r.ok) { log(`poll failed: HTTP ${r.status}`); return false; }
  const run = r.data?.run;
  if (!run) return false;
  await handleRun(run);
  return true;
}

async function mainLoop() {
  if (!SERVER) {
    log("FATAL: BUYIN_AGENT_SERVER (or SIDECAR_SERVER) env not set — nothing to poll.");
    process.exit(1);
  }
  log(`starting — server=${SERVER} model=${MODEL} poll=${POLL_IDLE_MS}ms keepAwake=${KEEP_AWAKE}`);
  while (!shuttingDown) {
    let didWork = false;
    try {
      didWork = await pollOnce();
    } catch (e) {
      log(`poll loop error: ${e?.message ?? e}`);
    }
    if (!didWork) await new Promise((res) => setTimeout(res, POLL_IDLE_MS));
  }
}

process.on("SIGINT", () => { shuttingDown = true; setCaffeinate(false); setTimeout(() => process.exit(0), 1000).unref?.(); });
process.on("SIGTERM", () => { shuttingDown = true; setCaffeinate(false); setTimeout(() => process.exit(0), 1000).unref?.(); });
process.on("exit", () => { try { caffeinateChild?.kill(); } catch { /* ignore */ } });

void mainLoop();
