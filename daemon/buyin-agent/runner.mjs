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
// legitimately-empty search. Before running the agent, confirm the "muscle" (the
// local sidecar that drives the operator's authenticated Chrome) is actually online
// so we can fail loudly up front instead of producing a false empty.
//
// NOTE: a deeper login-wall check (open a known authed VRBO page, confirm not a
// login form) needs a dedicated sidecar op — a follow-up. For now an offline
// sidecar is the detectable failure and is reported as session-invalid (we cannot
// verify the sessions, so we must NOT treat the run as a legitimate empty).
async function precheckSessions() {
  try {
    const r = await httpJson("GET", "/api/admin/vrbo-sidecar/status", undefined, 8000);
    if (!r.ok) return { ok: false, reason: `sidecar status unreachable (HTTP ${r.status})` };
    // The sidecar drives the operator's authenticated Chrome; if no worker is online
    // we can't verify sessions or scrape anything reliably.
    const online = r.data?.online ?? r.data?.heartbeat?.online ?? r.data?.sidecarLane?.online;
    if (online === false) return { ok: false, reason: "local Chrome sidecar is offline — cannot verify VRBO/Airbnb sessions" };
    return { ok: true, reason: "sidecar reachable" };
  } catch (e) {
    return { ok: false, reason: `precheck failed: ${e?.message ?? e}` };
  }
}

// ── the agent loop (plan §3) ─────────────────────────────────────────────────
// A tool-use loop against the Anthropic Messages API (raw fetch — matches the
// server's existing api.anthropic.com pattern; no SDK dependency). The agent is the
// BRAIN; the sidecar stays the MUSCLE (exposed via find_buy_in / scan_city_vrbo).
// propose_attach is the single COMMIT path — every server-side guard runs there.
//
// LIVE VERIFICATION REQUIRED: this path needs ANTHROPIC_API_KEY + the live server +
// an online sidecar; it cannot be exercised by the repo unit tests.
const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const MAX_STEPS = Math.max(4, Number(process.env.BUYIN_AGENT_MAX_STEPS) || 40);

const SYSTEM_PROMPT = `You are the autonomous buy-in finder for a vacation-rental operations team. A guest's
reserved unit fell through and you must find the CHEAPEST replacement rental(s) ("buy-ins") that:
- match the required bedroom size(s) for every empty slot,
- are in the SAME community as the booking, or a curated walkable adjacent complex (units in a
  multi-unit booking must be walkable to each other),
- keep the booking within the $100 max-loss profit gate, and
- for any ground-floor-required slot, are genuinely ground-floor (you must supply a quoted
  listing-text snippet as evidence).

How to work:
1. Call get_job_context to see the slots, dates, community, expected revenue, and what is already filled.
2. Use find_buy_in (resort-scoped) and scan_city_vrbo (city-wide) — these drive the operator's real
   Chrome via the sidecar, so they handle VRBO/Airbnb bot-walls. Also use web_search for open-ended
   Google + property-manager-site research the scrapers miss.
3. Use check_walkability and evaluate_profit to vet candidates BEFORE committing. Prefer the cheapest
   combo that passes the profit gate.
4. Commit with propose_attach (one call can include all slots' picks for a combo). The SERVER re-checks
   every guard (profit, walkability/proximity on server-derived coords, dedup, ground-floor snippet) and
   may refuse a pick — read the result and adjust.
5. When done, call finish exactly once with a structured outcome and the candidate set you considered.

Be decisive and stop early once you have a profitable, walkable, correctly-sized combo. If after a
genuine search no acceptable combo exists, finish with outcome "no-combo-found" — do NOT attach an
over-budget or wrong-community unit just to fill the slot. Always finish with the candidate set you
evaluated (with a per-candidate reason) so a miss is debuggable.`;

function toolDefs() {
  const defs = [
    { name: "get_job_context", description: "Live job context: slots (with filled flag), dates, community, expected revenue, running committed cost, revenue available, ground-floor-required bedrooms.", input_schema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] } },
    { name: "get_property_unit_config", description: "The configured unit composition for a property id.", input_schema: { type: "object", properties: { propertyId: { type: "number" } }, required: ["propertyId"] } },
    { name: "get_nearby_towns", description: "Nearby towns for a community, nearest-first, within a drive-time cap.", input_schema: { type: "object", properties: { community: { type: "string" }, maxDriveMinutes: { type: "number" }, limit: { type: "number" } }, required: ["community"] } },
    { name: "find_buy_in", description: "Resort-scoped buy-in search via the sidecar (VRBO/Airbnb in the booked community). Returns priced candidates.", input_schema: { type: "object", properties: { propertyId: { type: "number" }, bedrooms: { type: "number" }, checkIn: { type: "string" }, checkOut: { type: "string" }, community: { type: "string" } }, required: ["propertyId", "bedrooms", "checkIn", "checkOut"] } },
    { name: "scan_city_vrbo", description: "City-wide VRBO inventory scan via the sidecar for combo pairs in the booking's city.", input_schema: { type: "object", properties: { propertyId: { type: "number" }, checkIn: { type: "string" }, checkOut: { type: "string" } }, required: ["propertyId", "checkIn", "checkOut"] } },
    { name: "check_walkability", description: "Pre-filter: are these picks walkable to each other? (pre-filter only; server re-checks at commit).", input_schema: { type: "object", properties: { picks: { type: "array", items: { type: "object" } } }, required: ["picks"] } },
    { name: "evaluate_profit", description: "Profit verdict for a proposed combo cost vs the booking (the $100 max-loss gate).", input_schema: { type: "object", properties: { expectedRevenue: { type: "number" }, existingCost: { type: "number" }, comboCost: { type: "number" } }, required: ["expectedRevenue", "existingCost", "comboCost"] } },
    { name: "propose_attach", description: "COMMIT a pick or full combo. Each pick: {unitId,url,title,totalPrice,bedrooms,source,groundFloorEvidence?,photos?}. Server enforces every guard and may refuse.", input_schema: { type: "object", properties: { jobId: { type: "string" }, picks: { type: "array", items: { type: "object" } } }, required: ["jobId", "picks"] } },
    { name: "finish", description: "End the run. Provide the final outcome + the candidate set considered.", input_schema: { type: "object", properties: { outcome: { type: "string", enum: ["attached", "no-combo-found", "budget-exhausted", "bot-walled", "session-invalid", "agent-error"] }, message: { type: "string" }, candidates: { type: "array", items: { type: "object" } } }, required: ["outcome"] } },
  ];
  if ((process.env.BUYIN_AGENT_WEB_SEARCH ?? "1") !== "0") {
    // Anthropic server-side web search (executed by the API) for Google + PM-site research.
    defs.push({ type: "web_search_20250305", name: "web_search", max_uses: Number(process.env.BUYIN_AGENT_WEB_SEARCH_MAX) || 8 });
  }
  return defs;
}

async function execTool(name, input, run) {
  const jobId = run.params.jobId;
  switch (name) {
    case "get_job_context": {
      const r = await httpJson("GET", `/api/admin/buyin-agent/tools/job-context?jobId=${encodeURIComponent(input.jobId || jobId)}`);
      return r.data;
    }
    case "get_property_unit_config": {
      const r = await httpJson("GET", `/api/admin/buyin-agent/tools/property-unit-config?propertyId=${Number(input.propertyId)}`);
      return r.data;
    }
    case "get_nearby_towns": {
      const q = new URLSearchParams({ community: String(input.community ?? "") });
      if (input.maxDriveMinutes != null) q.set("maxDriveMinutes", String(input.maxDriveMinutes));
      if (input.limit != null) q.set("limit", String(input.limit));
      const r = await httpJson("GET", `/api/admin/buyin-agent/tools/nearby-towns?${q}`, undefined, 60_000);
      return r.data;
    }
    case "find_buy_in": {
      const q = new URLSearchParams({ propertyId: String(input.propertyId), bedrooms: String(input.bedrooms), checkIn: String(input.checkIn), checkOut: String(input.checkOut) });
      if (input.community) q.set("community", String(input.community));
      const r = await httpJson("GET", `/api/operations/find-buy-in?${q}`, undefined, 300_000);
      return r.data;
    }
    case "scan_city_vrbo": {
      const q = new URLSearchParams({ propertyId: String(input.propertyId), checkIn: String(input.checkIn), checkOut: String(input.checkOut), skipEnrich: "1" });
      const r = await httpJson("GET", `/api/operations/city-vrbo-inventory?${q}`, undefined, 300_000);
      return r.data;
    }
    case "check_walkability": {
      const r = await httpJson("POST", "/api/admin/buyin-agent/tools/check-walkability", { picks: input.picks ?? [] });
      return r.data;
    }
    case "evaluate_profit": {
      const r = await httpJson("POST", "/api/admin/buyin-agent/tools/evaluate-profit", input);
      return r.data;
    }
    case "propose_attach": {
      const r = await httpJson("POST", "/api/admin/buyin-agent/propose-attach", { jobId: input.jobId || jobId, picks: input.picks ?? [] }, 120_000);
      return r.data;
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

async function callMessages(body) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY || "",
      "anthropic-version": API_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`messages API HTTP ${res.status}: ${JSON.stringify(data).slice(0, 400)}`);
  return data;
}

async function runAgent(run, onStage) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { outcome: "agent-error", message: "ANTHROPIC_API_KEY not set on the runner", candidates: [] };
  }
  const model = run.model || MODEL;
  const tools = toolDefs();
  const messages = [{
    role: "user",
    content:
      `Find buy-in replacement(s) for this reservation. jobId=${run.params.jobId}. ` +
      `Start by calling get_job_context with that jobId.\n\nRun parameters:\n` +
      JSON.stringify(run.params, null, 2),
  }];

  let usage = { inputTokens: 0, outputTokens: 0, toolCalls: 0 };
  for (let step = 0; step < MAX_STEPS; step++) {
    onStage?.(`step ${step + 1}/${MAX_STEPS}`);
    const resp = await callMessages({ model, max_tokens: 4096, system: SYSTEM_PROMPT, tools, messages });
    usage.inputTokens += resp.usage?.input_tokens || 0;
    usage.outputTokens += resp.usage?.output_tokens || 0;
    messages.push({ role: "assistant", content: resp.content });

    const toolUses = (resp.content || []).filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      // Model ended its turn without calling finish — treat as a soft no-result.
      const text = (resp.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
      return { outcome: "no-combo-found", message: text || "Agent ended without a committed combo.", candidates: [], usage };
    }

    const toolResults = [];
    for (const tu of toolUses) {
      if (tu.name === "finish") {
        return {
          outcome: tu.input?.outcome || "no-combo-found",
          message: tu.input?.message || "",
          candidates: Array.isArray(tu.input?.candidates) ? tu.input.candidates : [],
          usage,
        };
      }
      usage.toolCalls++;
      let result;
      try {
        result = await execTool(tu.name, tu.input || {}, run);
      } catch (e) {
        result = { error: String(e?.message ?? e) };
      }
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result).slice(0, 60_000) });
    }
    // web_search is a server tool executed by the API — it never appears in toolUses,
    // so we only feed back our custom tool_results.
    if (toolResults.length > 0) messages.push({ role: "user", content: toolResults });
  }
  return { outcome: "budget-exhausted", message: `Agent hit the ${MAX_STEPS}-step cap.`, candidates: [], usage };
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
