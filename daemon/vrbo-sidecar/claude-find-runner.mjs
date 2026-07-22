#!/usr/bin/env node
// claude-find-runner.mjs — the headless Claude find-run child.
//
// Spawned by worker.mjs (LOCAL role, slot 1 only — never on Railway server
// workers). Polls the portal for queued find-runs (X-Admin-Secret, the
// daemon's standing credential), and for each claimed run:
//
//   1. ensures the DEDICATED runner Chrome is up (own persistent profile at
//      ~/.vrbo-sidecar-daemon/claude-findrun-chrome, CDP port 9250, hidden/
//      minimized launch flags copied from chrome-sidecar-manager — cookies and
//      solved bot-check clearances survive between runs, and it NEVER touches
//      the operator's personal Chrome or the 8 sidecar scrape instances);
//   2. spawns `claude -p` with the run's brief on stdin, a locked-down tool
//      allowlist (browser MCP + curl-only Bash + web search/fetch — the agent
//      can NOT run arbitrary shell), and chrome-devtools-mcp attached to the
//      runner Chrome;
//   3. relays the stream as display events to the portal (token-scrubbed),
//      turns the brief's "ATTENTION:"/"RESUMED:" marker lines into portal
//      attention state + loud local chimes (Sosumi protocol), and posts the
//      terminal report (the agent's final message);
//   4. honors operator cancels (the events-flush response carries
//      {cancelled:true}) by killing the CLI.
//
// AUTH REALITY (2026-07-19, verified on the operator's Mac): the `claude` CLI
// login is SEPARATE from the Claude Desktop app login. If the CLI is not
// logged in and no API key is configured, runs fail fast with the setup
// instruction in the error — run `claude` once in Terminal and /login, or set
// CLAUDE_FIND_RUN_API_KEY in the sidecar env.
//
// Sequential by construction: one run at a time, claims only between runs.
import { spawn } from "child_process";
import { createInterface } from "readline";
import fs from "fs";
import os from "os";
import path from "path";

const SERVER = process.env.SIDECAR_SERVER ?? "https://rental-community-tracker-production.up.railway.app";
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "";
const POLL_MS = Number(process.env.CLAUDE_FIND_RUN_POLL_MS ?? 15_000);
const MODEL = process.env.CLAUDE_FIND_RUN_MODEL ?? "claude-sonnet-4-6";
// 60 min / 300 turns (2026-07-22, was 40/200): both caps were the top failure
// cause in the Jul-21 bulk queues — runs mid-legitimate-work (exhaustive
// city/PM sweeps) were SIGTERM'd at 40:00 and surfaced as an opaque
// "error_during_execution". The server's per-run watchdog ceiling is 90 min
// (CLAUDE_FIND_RUN_MAX_AGE_MS) — keep MAX_MS comfortably under it.
const MAX_MS = Number(process.env.CLAUDE_FIND_RUN_MAX_MS ?? 60 * 60_000);
const MAX_TURNS = Number(process.env.CLAUDE_FIND_RUN_MAX_TURNS ?? 300);
const CDP_PORT = Number(process.env.CLAUDE_FIND_RUN_CDP_PORT ?? 9250);
const SOUNDS = process.env.CLAUDE_FIND_RUN_SOUNDS !== "0" && process.platform === "darwin";
const CLAUDE_BIN = process.env.CLAUDE_FIND_RUN_CLAUDE_BIN
  ?? (fs.existsSync(path.join(os.homedir(), ".local/bin/claude")) ? path.join(os.homedir(), ".local/bin/claude") : "claude");
const HOME_DIR = path.join(os.homedir(), ".vrbo-sidecar-daemon");
const RUNS_DIR = path.join(HOME_DIR, "claude-find-runs");
const CHROME_PROFILE = path.join(HOME_DIR, "claude-findrun-chrome");
const CHROME_BIN = process.env.CLAUDE_FIND_RUN_CHROME_BIN
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Tool allowlist — the agent's ENTIRE capability surface. curl-only Bash is
// load-bearing: the brief's two attach calls are curl, and nothing else on
// the Mac is reachable. Do not add a bare "Bash".
const ALLOWED_TOOLS = ["mcp__chrome", "Bash(curl:*)", "WebSearch", "WebFetch"];

// PINNED chrome-devtools-mcp — see the mcp-config comment below for why this
// must not go back to "@latest".
const CHROME_MCP_PKG = process.env.CLAUDE_FIND_RUN_CHROME_MCP || "chrome-devtools-mcp@1.6.0";

// THE DAEMON HAS A BARE PATH — this is the actual root cause of every
// browser-less run (2026-07-19, proven by `ps eww` on the live runner:
// PATH=/usr/bin:/bin:/usr/sbin:/sbin). launchd does not load a login shell,
// so `spawn("npx")` dies with ENOENT in ~5ms — for the CLI's own MCP spawn
// AND for the preflight. Every shell-run test passed (full user PATH); every
// daemon run failed. Two-part fix, BOTH required:
//  - EXTENDED_PATH: npx is a `#!/usr/bin/env node` script, so even invoked by
//    absolute path it still needs `node` resolvable on PATH — as does anything
//    npx spawns. Prepend the runtime's own bin dir plus the usual macOS
//    install locations to whatever PATH we inherited.
//  - NPX_BIN: an absolute npx for the preflight spawn and the MCP config, so
//    neither depends on PATH lookup at all.
const EXTENDED_PATH = [
  path.dirname(process.execPath), // the node actually running this daemon
  path.join(os.homedir(), ".local/bin"), // claude CLI's bundled node/npx
  "/opt/homebrew/bin",
  "/usr/local/bin",
  process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
].join(":");
function resolveNpxBin() {
  if (process.env.CLAUDE_FIND_RUN_NPX_BIN) return process.env.CLAUDE_FIND_RUN_NPX_BIN;
  const candidates = [
    path.join(path.dirname(process.execPath), "npx"),
    path.join(os.homedir(), ".local/bin/npx"),
    "/opt/homebrew/bin/npx",
    "/usr/local/bin/npx",
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return "npx"; // last resort: PATH lookup (works in shell contexts)
}
const NPX_BIN = resolveNpxBin();

// The browser MCP genuinely takes ~2.6s to hand-shake (npx spawn + package load
// + CDP connect). On a cold or contended start that exceeds the CLI's own MCP
// startup budget and the run comes up browser-less. Preflight it — the same
// handshake, before the costly agent run — up to this many times; a success
// warms the npx cache and proves Chrome is reachable, so the CLI's connect
// moments later is fast.
const BROWSER_PREFLIGHT_ATTEMPTS = Number(process.env.CLAUDE_FIND_RUN_BROWSER_PREFLIGHT_ATTEMPTS ?? 3);
// Startup budget handed to the CLI for the MCP connect. The default can be
// marginal against a 2.6s connect under load; give it real headroom.
const CLI_MCP_TIMEOUT_MS = Number(process.env.CLAUDE_FIND_RUN_MCP_TIMEOUT_MS ?? 30_000);

// Must match shared/claude-find-run.ts marker constants — drift-locked by
// tests/claude-find-run.test.ts.
const ATTENTION_MARKER = "ATTENTION:";
const RESUMED_MARKER = "RESUMED:";

const log = (msg) => console.log(`[claude-find-runner] ${new Date().toISOString()} ${msg}`);

function authHeaders() {
  return ADMIN_SECRET ? { "X-Admin-Secret": ADMIN_SECRET } : {};
}

function scrubToken(text, token) {
  if (!token || !text) return text ?? "";
  return String(text).split(token).join("[run-token]");
}

// ── stream classification (mirrors the intent of the server's display feed) ──
export function classifyStreamLine(rawLine, nowIso) {
  let parsed;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.type === "system" && parsed.subtype === "init") {
    const model = typeof parsed.model === "string" ? parsed.model : "unknown model";
    const tools = Array.isArray(parsed.tools) ? parsed.tools.length : 0;
    return { at: nowIso, kind: "status", text: `Runner started (${model}, ${tools} tools).` };
  }
  if (parsed.type === "assistant") {
    const content = parsed.message?.content;
    if (!Array.isArray(content)) return null;
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        return { at: nowIso, kind: "note", text: block.text.trim().replace(/\s+/g, " ").slice(0, 400) };
      }
      if (block?.type === "tool_use") {
        return { at: nowIso, kind: "action", text: describeToolUse(block.name, block.input) };
      }
    }
    return null;
  }
  if (parsed.type === "result") {
    const outcome = parsed.subtype === "success" ? "finished" : `ended (${parsed.subtype ?? "unknown"})`;
    const mins = Number.isFinite(parsed.duration_ms) ? ` after ${Math.round(parsed.duration_ms / 60_000)} min` : "";
    return { at: nowIso, kind: "status", text: `Runner ${outcome}${mins}.` };
  }
  return null;
}

/**
 * Did the run come up WITHOUT its browser?
 *
 * The CLI's `system/init` line reports every MCP server it managed to start.
 * If chrome-devtools-mcp isn't `connected`, the agent has no way to open a
 * listing, read a calendar, or look at photos — it silently falls back to
 * WebSearch/WebFetch and keeps going. That happened on a real run
 * (2026-07-19): the agent itself said "ATTENTION: browser tools missing … I
 * will … attach the best-qualified listings I can verify" and was on its way
 * to attaching units it could not verify. Nothing stopped it, and the only
 * trace was a line of prose inside a JSONL file on the Mac.
 *
 * A find-run without a browser is not a degraded run, it is the WRONG run —
 * so this returns the operator-facing error that ends it. Returns null for
 * any non-init line and for a healthy init.
 *
 * SCOPE (verified against the real CLI, 2026-07-19): "connected" means the MCP
 * PROCESS started and handshook — not that Chrome is reachable. Pointing the
 * config at a dead port still reports "connected". That is fine: a reachable-
 * but-broken browser makes every mcp__chrome CALL fail loudly, which the agent
 * and the operator both see. This guard covers the silent case — the tools
 * never existing at all.
 *
 * Keep behaviourally identical to the shared TS twin (equivalence-locked in
 * tests/claude-find-run.test.ts).
 */
export function browserMcpFailure(rawLine) {
  let parsed;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.type !== "system" || parsed.subtype !== "init") return null;
  const servers = Array.isArray(parsed.mcp_servers) ? parsed.mcp_servers : [];
  const chrome = servers.find((s) => s && s.name === "chrome");
  // CLI ≥2.1.216 emits init BEFORE MCP connect finishes — "pending" is the
  // healthy startup shape there (2026-07-20 incident: the old
  // any-status-but-connected kill failed every run instantly). Only an
  // explicit "failed" or a missing chrome entry is fatal at init; "pending"
  // arms the deferred proof-of-use gate instead.
  if (chrome && chrome.status !== "failed") return null;
  const state = !chrome ? "was not started at all" : `reported status "${String(chrome.status)}"`;
  return (
    `The runner's browser did not attach — chrome-devtools-mcp ${state}. `
    + "Without it this run can only web-search, so it cannot open listings, "
    + "check live availability, or verify photos. Stopped rather than attach "
    + "units it could not verify. Re-run it; if this repeats, check that the "
    + "dedicated Chrome is up and that chrome-devtools-mcp is installed."
  );
}

// TWIN of browserProofRequiredFromInit in shared/claude-find-run.ts — true
// when init shows chrome in an in-flight (non-connected, non-failed) state.
export function browserProofRequiredFromInit(rawLine) {
  let parsed;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  if (parsed.type !== "system" || parsed.subtype !== "init") return false;
  const servers = Array.isArray(parsed.mcp_servers) ? parsed.mcp_servers : [];
  const chrome = servers.find((s) => s && s.name === "chrome");
  return Boolean(chrome) && chrome.status !== "connected" && chrome.status !== "failed";
}

// TWIN of lineUsesChromeBrowserTool in shared/claude-find-run.ts — positive
// proof the browser attached: the agent CALLED an mcp__chrome__ tool.
export function lineUsesChromeBrowserTool(rawLine) {
  let parsed;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || parsed.type !== "assistant") return false;
  const content = parsed.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) => b && b.type === "tool_use" && typeof b.name === "string" && b.name.startsWith("mcp__chrome__"),
  );
}

// TWIN of browserNeverUsedFailure in shared/claude-find-run.ts.
export function browserNeverUsedFailure() {
  return (
    "The run finished without ever using its browser — chrome-devtools-mcp "
    + "never attached (or the agent never opened a page), so nothing it "
    + "reported was verified against a live listing. Refused rather than "
    + "record unverified findings. Re-run it; if this repeats, check that the "
    + "dedicated Chrome is up and that chrome-devtools-mcp is installed."
  );
}

// TWIN of lineCallsAgentPortalEndpoint in shared/claude-find-run.ts — true
// when the agent's curl-only Bash hits ANY /api/claude-find-runs/agent/:id/*
// endpoint. These calls ARE the run's work; a checkout run whose step-1 GET
// (unconditional in the brief) never happened did nothing.
export function lineCallsAgentPortalEndpoint(rawLine) {
  let parsed;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || parsed.type !== "assistant") return false;
  const content = parsed.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) =>
      b && b.type === "tool_use" && b.name === "Bash"
      && typeof b.input?.command === "string"
      && b.input.command.includes("claude-find-runs/agent/"),
  );
}

// TWIN of reportLooksLikeRefusal in shared/claude-find-run.ts — supplementary
// wording signal only; the fail decision is structural (zero endpoint calls).
export function reportLooksLikeRefusal(report) {
  const head = String(report ?? "").slice(0, 800).toLowerCase();
  return /\b(i['’]?m not going to|i am not going to|i (?:will|can) ?not (?:execute|proceed|assist|perform|complete)|i won['’]?t (?:execute|proceed|do|perform)|i refuse|refusing to|declin(?:e|ing) to (?:execute|proceed|perform)|hallmarks of fraud|fraudulent automation)\b/.test(head);
}

// TWIN of checkoutRunDidNoWorkFailure in shared/claude-find-run.ts.
// The 2026-07-19 incident (run 629799c6…): a checkout run whose model REFUSED
// the task ("I'm not going to execute this task… hallmarks of fraudulent
// automation") still emitted subtype "success" and was recorded "completed"
// with a green chip. Zero agent-endpoint calls is the structural proof no
// work happened; refusal phrasing only sharpens the message.
export function checkoutRunDidNoWorkFailure(report) {
  const head = String(report ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
  if (reportLooksLikeRefusal(report)) {
    return (
      "The model REFUSED the checkout task — its final report declines to run it"
      + (head ? ` ("${head}…")` : "")
      + ". It made ZERO portal calls (not even the step-1 buy-in read), so no "
      + "checkout was prepared and nothing was claimed. Recorded as failed, not "
      + "completed. Review the report, then re-run it or prepare the checkout in "
      + "Cowork/manually."
    );
  }
  return (
    'The run ended "success" without doing ANY checkout work — it never called '
    + "a single portal endpoint (not even the step-1 buy-in read), so no checkout "
    + "was prepared and nothing was claimed. Whatever the report says, it is not "
    + "a completed checkout. Recorded as failed; review the report and re-run it."
  );
}

/** Honest terminal error for a run the runner itself killed at the time
 *  ceiling. The CLI reports SIGTERM as a bare "error_during_execution" (the
 *  Jul-21 queue's opaque failures) — this names the real cause and tells the
 *  operator the partial work survived. */
export function runCeilingFailure(minutes) {
  return (
    `The run hit the ${minutes}-minute time ceiling while still working and was stopped by the runner. `
    + "Anything it attached before the cutoff is still on the reservation — re-run it to finish the "
    + "remaining slots, or raise CLAUDE_FIND_RUN_MAX_MS in the sidecar env if this property genuinely "
    + "needs longer searches."
  );
}

/** Honest terminal error for the CLI's own turn cap (result subtype
 *  "error_max_turns") — same class as the time ceiling: interrupted mid-work,
 *  not a real search failure. */
export function maxTurnsFailure(turns) {
  return (
    `The run used all ${turns} agent turns before finishing and was stopped mid-work. `
    + "Anything it attached before the cutoff is still on the reservation — re-run it to finish the "
    + "remaining slots, or raise CLAUDE_FIND_RUN_MAX_TURNS in the sidecar env."
  );
}

/** Terminal error posted when the daemon itself is being restarted (launchctl
 *  kickstart / SIGTERM) with a run in flight. Without this the run just goes
 *  silent and the server watchdog buries the cause 10 minutes later as
 *  "no heartbeat — check the Mac's sidecar log" (runs 1f0959a1 + 7600ca55,
 *  Jul 20-21). */
export function daemonRestartFailure() {
  return (
    "The Mac sidecar daemon was restarted mid-run and this run was killed with it. "
    + "Nothing more will happen on this run — anything attached before the restart is still on the "
    + "reservation; re-run it from the portal to finish."
  );
}

export function describeToolUse(name, input) {
  const tool = typeof name === "string" ? name : "tool";
  const url = typeof input?.url === "string" ? input.url : null;
  if (/navigate/i.test(tool) && url) return `Opening ${url.slice(0, 160)}`;
  if (tool === "WebSearch" && typeof input?.query === "string") return `Searching the web: ${input.query.slice(0, 140)}`;
  if (tool === "WebFetch" && url) return `Fetching ${url.slice(0, 160)}`;
  if (tool === "Bash" && typeof input?.command === "string") {
    const cmd = input.command.replace(/\s+/g, " ").trim();
    // Show the endpoint, never the payload — costs/addresses belong in the
    // report, not the action feed.
    // Longest alternatives FIRST: "checkout-claim/complete" must not match the
    // bare "checkout-claim", and "buy-ins" must win over "buy-in".
    const endpoint = /claude-find-runs\/agent\/[^/\s"']+\/(buy-ins|attach|guest-happy|checkout-claim\/complete|checkout-claim\/release|checkout-claim|traveler-email|buy-in)/.exec(cmd)?.[1];
    if (endpoint === "buy-ins") return "Creating a buy-in record via the portal";
    if (endpoint === "attach") return "Attaching a buy-in to the reservation";
    if (endpoint === "guest-happy") return "Recording the guest-expectation verdict";
    if (endpoint === "buy-in") return "Reading the buy-in record";
    if (endpoint === "traveler-email") return "Minting the traveler alias email";
    if (endpoint === "checkout-claim") return "Claiming the reservation's checkout lane";
    if (endpoint === "checkout-claim/complete") return "Recording the payment handoff — awaiting your card";
    if (endpoint === "checkout-claim/release") return "Releasing the checkout lane";
    return `Running: ${cmd.slice(0, 120)}`;
  }
  const short = tool.replace(/^mcp__[^_]+(?:_[^_]+)*__/, "").replace(/_/g, " ");
  return `Browser: ${short.slice(0, 80)}`;
}

/** Last unresolved ATTENTION reason in an assistant text, if any. */
export function scanMarkers(text) {
  let attention = null;
  let resumed = false;
  for (const rawLine of String(text ?? "").split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith(ATTENTION_MARKER)) {
      attention = line.slice(ATTENTION_MARKER.length).trim() || "The agent is blocked and waiting.";
      resumed = false;
    } else if (line.startsWith(RESUMED_MARKER)) {
      resumed = true;
    }
  }
  return { attention: resumed ? null : attention, resumed };
}

// ── sounds (Cowork's Sosumi protocol, owned by the wrapper not the agent) ────
function playOnce(cmd, args) {
  if (!SOUNDS) return;
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* sounds are best-effort */
  }
}

/**
 * Which open tab is the one the operator must look at?
 *
 * The runner Chrome accumulates tabs across a run (listings, searches,
 * records sites), and CDP's /json/list order is NOT "blocked tab first" — on
 * the 2026-07-21 live incident the challenged qPublic tab sat behind six
 * others, so plain pages[0] surfacing showed the operator an unrelated page
 * and the portal's "needs you" looked like a false alarm. The ATTENTION
 * reason names the blocked site ("bot check on vrbo.com — unit …"), so host
 * words from the reason outrank everything; challenge-shaped URLs/titles
 * (captcha/challenge/verify…) break ties; the first listed page stays the
 * fallback. Pure — exported for tests/claude-find-run.test.ts.
 */
export function pickAttentionTarget(targets, reason) {
  const pages = Array.isArray(targets) ? targets.filter((t) => t?.type === "page") : [];
  if (!pages.length) return null;
  const text = String(reason ?? "").toLowerCase();
  const hints = new Set();
  for (const m of text.matchAll(/[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+/g)) {
    const host = m[0].replace(/^www\./, "");
    hints.add(host);
    const stem = host.split(".")[0];
    if (stem.length >= 4) hints.add(stem);
  }
  for (const word of ["vrbo", "booking", "zillow", "hotels", "airbnb", "expedia", "qpublic", "redfin", "realtor"]) {
    if (text.includes(word)) hints.add(word);
  }
  const challengeRe = /captcha|challenge|verif|denied|robot|human|px-|bot.?check|cloudflare|just a moment/i;
  const score = (t) => {
    const url = String(t?.url ?? "");
    const title = String(t?.title ?? "");
    let host = "";
    try { host = new URL(url).hostname.replace(/^www\./, ""); } catch {}
    let s = 0;
    for (const hint of hints) {
      if (hint && host && (host === hint || host.includes(hint))) { s += 4; break; }
    }
    if (challengeRe.test(url) || challengeRe.test(title)) s += 2;
    return s;
  };
  let best = pages[0];
  let bestScore = score(best);
  for (const t of pages.slice(1)) {
    const s = score(t);
    if (s > bestScore) { best = t; bestScore = s; }
  }
  return best;
}

/** Run one JS expression in a tab over its page-level CDP websocket. Best-effort. */
async function cdpEvaluateInTab(target, expression) {
  if (!target?.webSocketDebuggerUrl || typeof WebSocket !== "function") return null;
  return await new Promise((resolve) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const done = (value) => { try { ws.close(); } catch {} resolve(value); };
    const timer = setTimeout(() => done(null), 4_000);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } })));
    ws.addEventListener("message", (event) => {
      let data;
      try { data = JSON.parse(String(event.data)); } catch { return; }
      if (data.id !== 1) return;
      clearTimeout(timer);
      done(data.result?.result?.value ?? null);
    });
    ws.addEventListener("error", () => { clearTimeout(timer); done(null); });
  });
}

/**
 * Bring the hidden runner Chrome ON-SCREEN when the operator is needed —
 * with the yellow treatment ON THE BLOCKED TAB.
 *
 * The dedicated Chrome launches minimized and parked at -32000,-32000 — right
 * for unattended runs, useless the moment a human must interact with a page.
 * 2026-07-21 operator report: "Cowork keeps saying the buy-in needs my action
 * but no Chrome window highlighted in yellow is showing" — the old version
 * only un-minimized the window (no banner, no tab activation), so a bot-wall
 * attention looked like nothing at all next to the sidecar's yellow challenge
 * treatment the operator was trained on. Now every non-payment attention:
 *   1. picks the BLOCKED tab (pickAttentionTarget — reason host + challenge
 *      shape, not blind pages[0]),
 *   2. activates that tab (/json/activate) and un-minimizes + places the
 *      window on-screen,
 *   3. paints the sidecar-style YELLOW banner + click-transparent border into
 *      the tab with the attention reason and what to do about it.
 * DISPLAY-ONLY, same rule as the card handoff: the injected DOM never touches
 * forms or clicks — the operator solves the challenge; the banner dies on the
 * navigation solving it causes (and clearAttentionSurface removes it when the
 * agent prints RESUMED without a navigation).
 * Best-effort: surfacing failures must never break the run; the ATTENTION
 * chime + portal banner still tell the operator, who can dig the window out
 * of the Dock. Never yanked back off-screen — the operator may be mid-use.
 */
export async function surfaceRunnerChrome(reason) {
  try {
    const base = `http://127.0.0.1:${CDP_PORT}`;
    const targets = await (await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(2_000) })).json();
    const target = pickAttentionTarget(targets, reason);
    if (!target?.id) return false;

    // Front the blocked TAB inside its window (plain HTTP endpoint).
    await fetch(`${base}/json/activate/${target.id}`, { signal: AbortSignal.timeout(2_000) }).catch(() => {});

    const version = await (await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(2_000) })).json();
    const wsUrl = version?.webSocketDebuggerUrl;
    if (wsUrl && typeof WebSocket === "function") {
      const send = (ws, id, method, params) => ws.send(JSON.stringify({ id, method, params }));
      await new Promise((resolve) => {
        const ws = new WebSocket(wsUrl);
        const done = () => { try { ws.close(); } catch {} resolve(); };
        const timer = setTimeout(done, 4_000);
        let windowId = null;
        ws.addEventListener("open", () => send(ws, 1, "Browser.getWindowForTarget", { targetId: target.id }));
        ws.addEventListener("message", (event) => {
          let data;
          try { data = JSON.parse(String(event.data)); } catch { return; }
          if (data.id === 1) {
            windowId = data.result?.windowId;
            if (!windowId) { clearTimeout(timer); return done(); }
            // Un-minimize FIRST (bounds are ignored while minimized), then place.
            send(ws, 2, "Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
          } else if (data.id === 2) {
            send(ws, 3, "Browser.setWindowBounds", {
              windowId,
              bounds: { left: 80, top: 60, width: 1360, height: 900 },
            });
          } else if (data.id === 3) {
            clearTimeout(timer);
            done();
          }
        });
        ws.addEventListener("error", () => { clearTimeout(timer); done(); });
      });
    }

    // Paint the yellow attention treatment INTO the blocked tab so the
    // operator can tell at a glance WHICH page needs them and WHY.
    const message = `\u{1F916} NEEDS YOU — ${String(reason ?? "the runner is blocked").slice(0, 200)} · Solve what this page is asking (bot check / sign-in), then leave the tab open — the buy-in runner is watching and continues automatically. If nothing here looks blocked, check the run log in the portal.`;
    const inject = `(() => {
      const styleId = "rct-findrun-attn-style";
      const bannerId = "rct-findrun-attn-banner";
      const borderId = "rct-findrun-attn-border";
      if (!document.getElementById(styleId)) {
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = \`
          #\${bannerId} {
            position: fixed; z-index: 2147483647; top: 0; left: 0; right: 0;
            padding: 14px 18px; background: #fde047; color: #111827;
            border-bottom: 4px solid #f59e0b;
            font: 700 18px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22); text-align: center;
          }
          body { padding-top: 58px !important; }
          #\${borderId} {
            position: fixed; z-index: 2147483646; inset: 0;
            border: 12px solid #facc15; box-shadow: inset 0 0 0 4px #f59e0b;
            pointer-events: none;
          }
        \`;
        document.documentElement.appendChild(style);
      }
      let banner = document.getElementById(bannerId);
      if (!banner) {
        banner = document.createElement("div");
        banner.id = bannerId;
        document.documentElement.appendChild(banner);
      }
      banner.textContent = ${JSON.stringify(message)};
      if (!document.getElementById(borderId)) {
        const border = document.createElement("div");
        border.id = borderId;
        document.documentElement.appendChild(border);
      }
      return "painted";
    })()`;
    const painted = (await cdpEvaluateInTab(target, inject)) === "painted";
    attentionSurfaced = true;
    log(
      painted
        ? "surfaced the runner Chrome window with the yellow attention banner"
        : "surfaced the runner Chrome window for the operator",
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the yellow attention treatment from every tab once the blocker
 * clears (RESUMED marker / run end). A solved bot check usually navigates —
 * which kills the injected DOM naturally — but a sign-in solved in another
 * tab, or an agent that moved on, leaves a stale "NEEDS YOU" banner that
 * would misdirect the operator on the NEXT look. Flag-guarded so the many
 * stopAttentionAlarm() call sites cost nothing when nothing was surfaced.
 * Deliberately leaves the payment handoff's card banner alone — that one must
 * stay until the operator's own Checkout click navigates.
 */
export async function clearAttentionSurface() {
  if (!attentionSurfaced) return;
  attentionSurfaced = false;
  try {
    const base = `http://127.0.0.1:${CDP_PORT}`;
    const targets = await (await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(2_000) })).json();
    const pages = Array.isArray(targets) ? targets.filter((t) => t?.type === "page") : [];
    const remove = `(() => {
      for (const id of ["rct-findrun-attn-style", "rct-findrun-attn-banner", "rct-findrun-attn-border"]) {
        document.getElementById(id)?.remove();
      }
      return "cleared";
    })()`;
    for (const target of pages) {
      await cdpEvaluateInTab(target, remove).catch(() => {});
    }
  } catch {
    /* best-effort */
  }
}

/**
 * The CARD HANDOFF pop-up (operator directive 2026-07-20: "have it pop up
 * Chrome so I can see it in like a yellow pop up"). When a checkout run
 * reaches the payment stage — alias minted, guest name filled, card form
 * showing — this surfaces the PREPARED CHECKOUT TAB near-fullscreen and
 * paints the sidecar's yellow challenge treatment onto it (top banner +
 * yellow border), so the handoff is unmissable. Same visual language as
 * worker.mjs setVrboChallengeHighlight; injection is via raw CDP
 * Runtime.evaluate on the page target (no Playwright in this runner).
 *
 * DISPLAY-ONLY, and load-bearing that it stays that way: the injected DOM is
 * a banner + a pointer-events:none border. It must never touch the checkout
 * form, prefill anything, or intercept clicks — the card and the final
 * Checkout click are the operator's alone. The banner disappears naturally on
 * the navigation their Checkout click causes.
 */
export async function surfaceCheckoutHandoff(reason) {
  try {
    const base = `http://127.0.0.1:${CDP_PORT}`;
    const targets = await (await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(2_000) })).json();
    const pages = Array.isArray(targets) ? targets.filter((t) => t?.type === "page") : [];
    if (!pages.length) return false;
    // Find the prepared checkout tab: a vrbo.com page, checkout-shaped URL
    // first. Fall back to any vrbo tab, then the frontmost page.
    const score = (t) => {
      const url = String(t?.url ?? "");
      if (!/(^|\.)vrbo\.com/i.test(url.replace(/^https?:\/\//i, "").split("/")[0] ?? "")) return 0;
      return /checkout|payment|book/i.test(url) ? 2 : 1;
    };
    const target = [...pages].sort((a, b) => score(b) - score(a))[0];
    if (!target?.id) return false;

    // Front that TAB inside its window (plain HTTP endpoint — no ws needed).
    await fetch(`${base}/json/activate/${target.id}`, { signal: AbortSignal.timeout(2_000) }).catch(() => {});

    // Surface the WINDOW: un-minimize, then near-fullscreen-ish bounds.
    const version = await (await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(2_000) })).json();
    const browserWs = version?.webSocketDebuggerUrl;
    if (browserWs && typeof WebSocket === "function") {
      await new Promise((resolve) => {
        const ws = new WebSocket(browserWs);
        const done = () => { try { ws.close(); } catch {} resolve(); };
        const timer = setTimeout(done, 4_000);
        let windowId = null;
        ws.addEventListener("open", () => ws.send(JSON.stringify({ id: 1, method: "Browser.getWindowForTarget", params: { targetId: target.id } })));
        ws.addEventListener("message", (event) => {
          let data;
          try { data = JSON.parse(String(event.data)); } catch { return; }
          if (data.id === 1) {
            windowId = data.result?.windowId;
            if (!windowId) { clearTimeout(timer); return done(); }
            ws.send(JSON.stringify({ id: 2, method: "Browser.setWindowBounds", params: { windowId, bounds: { windowState: "normal" } } }));
          } else if (data.id === 2) {
            ws.send(JSON.stringify({ id: 3, method: "Browser.setWindowBounds", params: { windowId, bounds: { left: 40, top: 30, width: 1500, height: 980 } } }));
          } else if (data.id === 3) {
            clearTimeout(timer);
            done();
          }
        });
        ws.addEventListener("error", () => { clearTimeout(timer); done(); });
      });
    }

    // Paint the yellow handoff treatment INTO the checkout tab.
    if (!target.webSocketDebuggerUrl || typeof WebSocket !== "function") return false;
    const message = `\u{1F4B3} ADD THE CREDIT CARD — ${String(reason ?? "the checkout is prepared").slice(0, 200)} · Card fields are EMPTY; add the card and click Checkout yourself. No purchase has been submitted.`;
    // Injected verbatim as a function body via Runtime.evaluate. Idempotent:
    // re-injection just updates the banner text.
    const inject = `(() => {
      const styleId = "rct-findrun-card-style";
      const bannerId = "rct-findrun-card-banner";
      const borderId = "rct-findrun-card-border";
      if (!document.getElementById(styleId)) {
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = \`
          #\${bannerId} {
            position: fixed; z-index: 2147483647; top: 0; left: 0; right: 0;
            padding: 14px 18px; background: #fde047; color: #111827;
            border-bottom: 4px solid #f59e0b;
            font: 700 18px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22); text-align: center;
          }
          body { padding-top: 58px !important; }
          #\${borderId} {
            position: fixed; z-index: 2147483646; inset: 0;
            border: 12px solid #facc15; box-shadow: inset 0 0 0 4px #f59e0b;
            pointer-events: none;
          }
        \`;
        document.documentElement.appendChild(style);
      }
      let banner = document.getElementById(bannerId);
      if (!banner) {
        banner = document.createElement("div");
        banner.id = bannerId;
        document.documentElement.appendChild(banner);
      }
      banner.textContent = ${JSON.stringify(message)};
      if (!document.getElementById(borderId)) {
        const border = document.createElement("div");
        border.id = borderId;
        document.documentElement.appendChild(border);
      }
      return "painted";
    })()`;
    const painted = await new Promise((resolve) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      const done = (ok) => { try { ws.close(); } catch {} resolve(ok); };
      const timer = setTimeout(() => done(false), 4_000);
      ws.addEventListener("open", () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: inject, returnByValue: true } })));
      ws.addEventListener("message", (event) => {
        let data;
        try { data = JSON.parse(String(event.data)); } catch { return; }
        if (data.id !== 1) return;
        clearTimeout(timer);
        done(data.result?.result?.value === "painted");
      });
      ws.addEventListener("error", () => { clearTimeout(timer); done(false); });
    });
    if (painted) log("card handoff: surfaced the checkout tab with the yellow banner");
    return painted;
  } catch {
    return false;
  }
}

let attentionAlarm = null;
let attentionSurfaced = false;
function startAttentionAlarm(reason) {
  // The window surfaces on EVERY attention raise (not just the first) — a
  // second blocker may be on a different tab. The PAYMENT handoff gets the
  // card-specific yellow pop-up on the prepared checkout tab; every other
  // attention (bot walls etc.) gets the yellow attention treatment on the
  // BLOCKED tab (reason-targeted). Fire-and-forget either way.
  if (/^awaiting payment\b/i.test(String(reason ?? "").trim())) {
    void surfaceCheckoutHandoff(reason);
  } else {
    void surfaceRunnerChrome(reason);
  }
  if (attentionAlarm || !SOUNDS) return;
  let fires = 0;
  const fire = () => {
    fires += 1;
    playOnce("/bin/sh", ["-c", "for i in 1 2 3; do afplay /System/Library/Sounds/Sosumi.aiff; done"]);
    playOnce("say", ["-r", "170", "The buy-in runner needs you. Check the portal."]);
    playOnce("osascript", ["-e", `display notification ${JSON.stringify(String(reason).slice(0, 120))} with title "Find-run needs you" sound name "Sosumi"`]);
    if (fires >= 15) stopAttentionAlarm();
  };
  fire();
  attentionAlarm = setInterval(fire, 60_000);
}
function stopAttentionAlarm() {
  if (attentionAlarm) clearInterval(attentionAlarm);
  attentionAlarm = null;
  void clearAttentionSurface();
}

function terminalChime(status, summary) {
  if (!SOUNDS) return;
  const sound = status === "completed" ? "Glass" : "Basso";
  playOnce("/bin/sh", ["-c", `afplay /System/Library/Sounds/${sound}.aiff; afplay /System/Library/Sounds/${sound}.aiff`]);
  playOnce("say", ["-r", "180", status === "completed" ? "Buy-in run finished." : `Buy-in run ${status}. ${String(summary ?? "").slice(0, 80)}`]);
}

// ── runner Chrome (dedicated, hidden, persistent profile) ───────────────────
async function cdpAlive() {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureRunnerChrome() {
  if (await cdpAlive()) return true;
  if (!fs.existsSync(CHROME_BIN)) {
    log(`Chrome binary missing at ${CHROME_BIN}`);
    return false;
  }
  fs.mkdirSync(CHROME_PROFILE, { recursive: true });
  // Hidden-launch flags per chrome-sidecar-manager: minimized, no startup
  // window surface, parked off-screen, renderer never throttled in background.
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${CHROME_PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--start-minimized",
    "--window-position=-32000,-32000",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "about:blank",
  ];
  try {
    spawn(CHROME_BIN, args, { stdio: "ignore", detached: true }).unref();
  } catch (e) {
    log(`Chrome launch failed: ${e?.message ?? e}`);
    return false;
  }
  for (let i = 0; i < 25; i += 1) {
    await new Promise((r) => setTimeout(r, 1_000));
    if (await cdpAlive()) return true;
  }
  return false;
}

/**
 * Warm + verify the browser MCP before the real run.
 *
 * Runs the EXACT same `npx chrome-devtools-mcp … --browserUrl` the CLI is about
 * to run and waits for its `serverInfo` handshake. A clean handshake here means
 * the npx package is cached and Chrome's CDP is answering, so the CLI's own
 * connect a moment later is fast and reliable. This is what makes a transient
 * cold-start self-heal instead of producing a browser-less run.
 *
 * Resolves true on handshake, false on timeout/spawn error. Never throws.
 */
async function preflightBrowserMcp(timeoutMs = 25_000) {
  return await new Promise((resolve) => {
    let child;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill("SIGKILL"); } catch {}
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      child = spawn(NPX_BIN, ["-y", CHROME_MCP_PKG, "--browserUrl", `http://127.0.0.1:${CDP_PORT}`], {
        stdio: ["pipe", "pipe", "ignore"],
        // npx's shebang needs `node` resolvable, and the daemon's inherited
        // PATH is launchd-bare — same reason the MCP config uses NPX_BIN.
        env: { ...process.env, PATH: EXTENDED_PATH },
      });
    } catch {
      finish(false);
      return;
    }
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += String(d);
      if (buf.includes('"serverInfo"')) finish(true);
    });
    child.on("error", () => finish(false));
    child.on("close", () => finish(false));
    try {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "runner-preflight", version: "1" } },
        }) + "\n",
      );
    } catch {
      finish(false);
    }
  });
}

// ── portal I/O ──────────────────────────────────────────────────────────────
async function claimRun() {
  const res = await fetch(`${SERVER}/api/claude-find-runs/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`claim HTTP ${res.status}`);
  const data = await res.json().catch(() => ({}));
  return data?.run ?? null;
}

async function postEvents(run, payload) {
  const res = await fetch(`${SERVER}/api/claude-find-runs/agent/${encodeURIComponent(run.id)}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Run-Token": run.token },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { ok: false, cancelled: false };
  const data = await res.json().catch(() => ({}));
  return { ok: true, cancelled: data?.cancelled === true };
}

// ── one run ─────────────────────────────────────────────────────────────────
// The in-flight run + its CLI child, for the graceful-shutdown handler below —
// a daemon restart (launchctl kickstart sends SIGTERM) must post an honest
// terminal instead of leaving the run to die silently.
let activeRun = null;
let activeChild = null;
let shuttingDown = false;

async function handleRun(run) {
  log(`claimed run ${run.id} (${run.propertyName ?? "?"} / ${run.reservationId ?? "?"})`);
  activeRun = run;
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const transcriptPath = path.join(RUNS_DIR, `${run.id}.jsonl`);
  const transcript = fs.createWriteStream(transcriptPath, { flags: "a" });

  const fail = async (error) => {
    stopAttentionAlarm();
    await postEvents(run, { terminal: { status: "failed", error } }).catch(() => {});
    terminalChime("failed", error);
  };

  if (!(await ensureRunnerChrome())) {
    await fail(
      "The runner's dedicated Chrome would not start — check the Mac (CLAUDE_FIND_RUN_CHROME_BIN / port " + CDP_PORT + ").",
    );
    transcript.end();
    return;
  }

  // Warm + verify the browser MCP before spending an agent run. Retried,
  // because a cold/contended first start is exactly the transient that left a
  // real run browser-less (2026-07-19). Re-check Chrome between attempts.
  let browserReady = false;
  for (let attempt = 1; attempt <= BROWSER_PREFLIGHT_ATTEMPTS; attempt += 1) {
    if (await preflightBrowserMcp()) {
      browserReady = true;
      if (attempt > 1) log(`run ${run.id} browser MCP ready on preflight attempt ${attempt}`);
      break;
    }
    log(`run ${run.id} browser MCP preflight ${attempt}/${BROWSER_PREFLIGHT_ATTEMPTS} did not hand-shake`);
    await ensureRunnerChrome();
  }
  if (!browserReady) {
    await fail(
      "The runner's browser (chrome-devtools-mcp) would not start after "
      + `${BROWSER_PREFLIGHT_ATTEMPTS} attempts. Stopped rather than run without it — a browser-less `
      + "find can only web-search and cannot verify a listing. Re-run it; if this repeats, "
      + "check that chrome-devtools-mcp installs (npx) and that the dedicated Chrome is up on port " + CDP_PORT + ".",
    );
    transcript.end();
    return;
  }

  // Ad-hoc MCP config: chrome-devtools-mcp attached to the runner Chrome.
  //
  // PINNED, not @latest. "@latest" forces npx to resolve against the registry
  // on every single run, and that round-trip is what blew the CLI's MCP
  // startup window on 2026-07-19 — the run came up with no browser at all. A
  // pinned version resolves from the local npx cache once it is warm.
  // Override with CLAUDE_FIND_RUN_CHROME_MCP (e.g. to test a newer release).
  const mcpConfigPath = path.join(RUNS_DIR, `${run.id}.mcp.json`);
  fs.writeFileSync(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        // NPX_BIN, never bare "npx": the CLI inherits the daemon's launchd
        // PATH, where bare npx is ENOENT — the true cause of every
        // browser-less run.
        chrome: { command: NPX_BIN, args: ["-y", CHROME_MCP_PKG, "--browserUrl", `http://127.0.0.1:${CDP_PORT}`] },
      },
    }),
  );

  // Clean env: never leak the daemon's ADMIN_SECRET into the agent process,
  // and strip nested-session guards. CLAUDE_FIND_RUN_API_KEY (optional) rides
  // in as ANTHROPIC_API_KEY for API-billed auth; otherwise the CLI's
  // SUBSCRIPTION login is used — the daemon's own ANTHROPIC_API_KEY (exported
  // by run-vrbo-sidecar.sh for worker.mjs's vision fallback) is deliberately
  // STRIPPED here, because an inherited key silently flips every find-run to
  // per-token API billing (~$4-10/run measured 2026-07-20). Opting back into
  // API billing must be explicit via CLAUDE_FIND_RUN_API_KEY.
  const childEnv = { ...process.env };
  delete childEnv.ADMIN_SECRET;
  delete childEnv.CLAUDECODE;
  delete childEnv.ANTHROPIC_API_KEY;
  // Give the CLI a real budget for the ~2.6s MCP connect. Without headroom the
  // default can lapse under load and the browser is marked "failed" at init.
  if (!childEnv.MCP_TIMEOUT) childEnv.MCP_TIMEOUT = String(CLI_MCP_TIMEOUT_MS);
  // A usable PATH for everything the CLI spawns (the MCP's npx shebang needs
  // node; WebFetch helpers etc.). The daemon's own PATH is launchd-bare.
  childEnv.PATH = EXTENDED_PATH;
  delete childEnv.CLAUDE_CODE_ENTRYPOINT;
  if (process.env.CLAUDE_FIND_RUN_API_KEY) childEnv.ANTHROPIC_API_KEY = process.env.CLAUDE_FIND_RUN_API_KEY;

  const child = spawn(
    CLAUDE_BIN,
    [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--model", MODEL,
      "--max-turns", String(MAX_TURNS),
      "--mcp-config", mcpConfigPath,
      // Only THIS config. Without it the run also loads the operator's
      // user-scope MCP servers (a real run pulled in "railway-mcp-server"),
      // which is both unnecessary attack surface for an unattended agent and
      // extra startup work competing for the same MCP init window.
      "--strict-mcp-config",
      "--allowedTools", ...ALLOWED_TOOLS,
    ],
    { env: childEnv, cwd: RUNS_DIR, stdio: ["pipe", "pipe", "pipe"] },
  );
  activeChild = child;
  child.stdin.write(run.prompt);
  child.stdin.end();

  let buffer = [];
  let pendingAttention; // undefined = no change; string = raise; null = clear
  let terminalPosted = false;
  let cancelled = false;
  let sawResult = false;
  let resultReport = null;
  let resultError = null;
  // Set when the init line shows the browser never attached. The run is killed
  // immediately and this becomes its terminal error — it must win over the
  // "exited without a result" fallback below, which would otherwise bury the
  // real cause behind a generic message.
  let browserFailure = null;
  // Deferred browser proof (CLI ≥2.1.216): flips true on the first
  // mcp__chrome__ tool call. A "completed" report without it is refused —
  // the 2026-07-19 wrong-run class, regardless of what the init line said.
  let browserUsed = false;
  // The run's kind rides in on the claim payload (server stamps it; absent on
  // pre-2026-07-21 daemons/payloads = "find"). Checkout runs carry the extra
  // no-work terminal gate below.
  const runKind = run.kind === "checkout" ? "checkout" : "find";
  // Flips true on the first curl to any /api/claude-find-runs/agent/:id/*
  // endpoint — the structural proof the run did its portal work. A checkout
  // run's brief makes the step-1 buy-in GET unconditional, so a checkout run
  // that ends "success" with this still false did NOTHING (the 2026-07-19
  // refusal incident, run 629799c6…, recorded completed off subtype
  // "success").
  let agentEndpointUsed = false;

  const flush = async (extra = {}) => {
    const events = buffer.splice(0, buffer.length).map((e) => ({ ...e, text: scrubToken(e.text, run.token) }));
    const payload = { events, heartbeat: true, ...extra };
    if (pendingAttention !== undefined) {
      payload.attention = pendingAttention === null ? null : scrubToken(pendingAttention, run.token);
      pendingAttention = undefined;
    }
    const res = await postEvents(run, payload).catch(() => ({ ok: false, cancelled: false }));
    if (res.cancelled && !cancelled) {
      cancelled = true;
      log(`run ${run.id} cancelled by the operator — killing the CLI`);
      stopAttentionAlarm();
      try {
        child.kill("SIGTERM");
      } catch {}
    }
  };
  const flushTimer = setInterval(() => void flush(), 3_000);
  // Set when the runner's own time ceiling kills the CLI. The kill surfaces
  // from the CLI as a bare "error_during_execution" (or no result at all), so
  // the terminal classifier must consult this flag to report the real cause.
  let ceilingHit = false;
  const killTimer = setTimeout(() => {
    ceilingHit = true;
    log(`run ${run.id} hit the ${Math.round(MAX_MS / 60_000)}-minute ceiling — killing the CLI`);
    buffer.push({ at: new Date().toISOString(), kind: "status", text: `Run hit the ${Math.round(MAX_MS / 60_000)}-minute ceiling — stopping.` });
    try {
      child.kill("SIGTERM");
    } catch {}
  }, MAX_MS);

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    transcript.write(line + "\n");
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {}
    // FAIL LOUDLY, never degrade: if the browser did not attach, stop now.
    // The agent will happily continue on WebSearch alone and attach units it
    // never looked at — a wrong answer that looks exactly like a normal run.
    if (!browserFailure) {
      const failure = browserMcpFailure(line);
      if (failure) {
        browserFailure = failure;
        log(`run ${run.id} has NO browser (chrome MCP not connected) — killing the CLI`);
        buffer.push({ at: new Date().toISOString(), kind: "status", text: "Browser did not attach — stopping the run." });
        try {
          child.kill("SIGTERM");
        } catch {}
      }
    }
    // CLI ≥2.1.216: init fires while chrome is still "pending" — note it, and
    // prove attachment by USE instead (any mcp__chrome__ tool call). A
    // completed report with zero chrome calls is refused at the terminal.
    if (browserProofRequiredFromInit(line)) {
      buffer.push({
        at: new Date().toISOString(),
        kind: "status",
        text: "Browser MCP still connecting at startup — the run will be accepted only if it actually uses the browser.",
      });
    }
    if (!browserUsed && lineUsesChromeBrowserTool(line)) browserUsed = true;
    if (!agentEndpointUsed && lineCallsAgentPortalEndpoint(line)) agentEndpointUsed = true;
    // Marker scan on the agent's own words → portal attention + local alarm.
    if (parsed?.type === "assistant") {
      for (const block of parsed.message?.content ?? []) {
        if (block?.type === "text" && typeof block.text === "string") {
          const markers = scanMarkers(block.text);
          if (markers.attention) {
            pendingAttention = markers.attention;
            startAttentionAlarm(markers.attention);
          } else if (markers.resumed) {
            pendingAttention = null;
            stopAttentionAlarm();
          }
        }
      }
    }
    if (parsed?.type === "result") {
      sawResult = true;
      if (parsed.subtype === "success") {
        resultReport = typeof parsed.result === "string" ? parsed.result : null;
      } else if (parsed.subtype === "error_max_turns") {
        // Interrupted mid-work by the CLI's turn cap — name it honestly
        // instead of the opaque "Runner ended: error_max_turns".
        resultError = maxTurnsFailure(MAX_TURNS);
      } else {
        resultError = `Runner ended: ${parsed.subtype ?? "unknown"}${typeof parsed.result === "string" ? ` — ${parsed.result.slice(0, 400)}` : ""}`;
      }
    }
    const event = classifyStreamLine(line, new Date().toISOString());
    if (event) buffer.push(event);
  });
  child.stderr.on("data", (chunk) => transcript.write(String(chunk)));

  await new Promise((resolve) => child.on("close", resolve));
  clearInterval(flushTimer);
  clearTimeout(killTimer);
  rl.close();
  stopAttentionAlarm();

  // Terminal classification — honest about which way it ended.
  if (!terminalPosted && !shuttingDown) {
    terminalPosted = true;
    if (cancelled) {
      await flush(); // final events only; status is already cancelled server-side
    } else if (ceilingHit) {
      // Ahead of the result branches: the SIGTERM'd CLI reports a bare
      // "error_during_execution" (or nothing), which buries the real cause —
      // the runner's own time ceiling (the Jul-21 queue failures).
      await flush({ terminal: { status: "failed", error: runCeilingFailure(Math.round(MAX_MS / 60_000)) } });
      terminalChime("failed", "Run hit the time ceiling");
    } else if (browserFailure) {
      // Ahead of every other branch: a browser-less run may still emit a
      // "success" result full of web-searched guesses, and that must never be
      // recorded as a completed find.
      await flush({ terminal: { status: "failed", error: scrubToken(browserFailure, run.token) } });
      terminalChime("failed", "Browser did not attach");
    } else if (sawResult && resultReport !== null && !resultError) {
      const authProblem = /not logged in|please run \/?login|authentication_error|invalid api key/i.test(resultReport);
      if (authProblem) {
        await flush({
          terminal: {
            status: "failed",
            error:
              "The Claude CLI is not logged in on the Mac. One-time setup: open Terminal, run `claude`, then `/login` — or set CLAUDE_FIND_RUN_API_KEY in the sidecar env.",
          },
        });
        terminalChime("failed", "Claude login needed");
      } else if (runKind === "checkout" && !agentEndpointUsed) {
        // Refusal / no-op guard, BEFORE the browser gate on purpose: a model
        // that refused the task used neither the browser nor an endpoint, and
        // "the browser never attached" would bury the real cause. Structural,
        // not phrase-matched — the checkout brief's step 1 is an unconditional
        // agent-endpoint GET, so zero endpoint calls means zero work whatever
        // the report claims. The error rides the attention channel too so the
        // failed record keeps the reason for the row's attention surfacing.
        const error = checkoutRunDidNoWorkFailure(resultReport);
        pendingAttention = error;
        await flush({ terminal: { status: "failed", error: scrubToken(error, run.token) } });
        terminalChime("failed", "Checkout run did no work");
      } else if (!browserUsed) {
        // The deferred half of the browser guard: the CLI reported a
        // "successful" run that never called a single mcp__chrome tool.
        // Whatever it reported was web-searched, not verified — refuse it.
        await flush({ terminal: { status: "failed", error: browserNeverUsedFailure() } });
        terminalChime("failed", "Browser was never used");
      } else {
        await flush({ terminal: { status: "completed", report: scrubToken(resultReport, run.token) } });
        terminalChime("completed");
      }
    } else {
      const error = resultError ?? "The runner exited without a result — see the transcript on the Mac.";
      await flush({ terminal: { status: "failed", error: scrubToken(error, run.token) } });
      terminalChime("failed", error);
    }
  }
  transcript.end();
  try {
    fs.unlinkSync(mcpConfigPath);
  } catch {}
  log(`run ${run.id} finished (cancelled=${cancelled}, sawResult=${sawResult})`);
}

// ── main loop ───────────────────────────────────────────────────────────────
async function main() {
  log(`runner up — server ${SERVER}, model ${MODEL}, CDP ${CDP_PORT}, claude ${CLAUDE_BIN}, npx ${NPX_BIN}`);
  // Graceful shutdown: a daemon restart (launchctl kickstart → SIGTERM) with a
  // run in flight must kill the CLI AND post an honest terminal — otherwise
  // the run goes silent and the server watchdog fails it 10 minutes later
  // with a cause-burying "no heartbeat" message (Jul 20-21 incidents).
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const run = activeRun;
    const child = activeChild;
    activeRun = null;
    activeChild = null;
    try {
      if (child) child.kill("SIGTERM");
    } catch {}
    if (run) {
      log(`${signal} with run ${run.id} in flight — posting an honest terminal before exit`);
      await Promise.race([
        postEvents(run, {
          events: [{ at: new Date().toISOString(), kind: "error", text: daemonRestartFailure() }],
          terminal: { status: "failed", error: daemonRestartFailure() },
        }).catch(() => {}),
        new Promise((r) => setTimeout(r, 3_000)),
      ]);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  while (true) {
    try {
      const run = await claimRun();
      if (run?.id && run?.token && run?.prompt) {
        await handleRun(run);
        activeRun = null;
        activeChild = null;
        continue; // check for the next queued run immediately
      }
    } catch (e) {
      log(`poll error: ${e?.message ?? e}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// Import-safe: tests import classifyStreamLine/scanMarkers without starting
// the loop.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    log(`fatal: ${e?.message ?? e}`);
    process.exit(1);
  });
}
