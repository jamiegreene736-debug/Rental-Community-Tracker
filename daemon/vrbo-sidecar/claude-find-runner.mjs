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
const MAX_MS = Number(process.env.CLAUDE_FIND_RUN_MAX_MS ?? 40 * 60_000);
const MAX_TURNS = Number(process.env.CLAUDE_FIND_RUN_MAX_TURNS ?? 200);
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
  if (chrome && chrome.status === "connected") return null;
  const state = !chrome ? "was not started at all" : `reported status "${String(chrome.status)}"`;
  return (
    `The runner's browser did not attach — chrome-devtools-mcp ${state}. `
    + "Without it this run can only web-search, so it cannot open listings, "
    + "check live availability, or verify photos. Stopped rather than attach "
    + "units it could not verify. Re-run it; if this repeats, check that the "
    + "dedicated Chrome is up and that chrome-devtools-mcp is installed."
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
    const endpoint = /claude-find-runs\/agent\/[^/\s"']+\/(buy-ins|attach)/.exec(cmd)?.[1];
    if (endpoint === "buy-ins") return "Creating a buy-in record via the portal";
    if (endpoint === "attach") return "Attaching a buy-in to the reservation";
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

let attentionAlarm = null;
function startAttentionAlarm(reason) {
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
async function handleRun(run) {
  log(`claimed run ${run.id} (${run.propertyName ?? "?"} / ${run.reservationId ?? "?"})`);
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
        chrome: { command: "npx", args: ["-y", CHROME_MCP_PKG, "--browserUrl", `http://127.0.0.1:${CDP_PORT}`] },
      },
    }),
  );

  // Clean env: never leak the daemon's ADMIN_SECRET into the agent process,
  // and strip nested-session guards. CLAUDE_FIND_RUN_API_KEY (optional) rides
  // in as ANTHROPIC_API_KEY for API-billed auth; otherwise the CLI login is
  // used.
  const childEnv = { ...process.env };
  delete childEnv.ADMIN_SECRET;
  delete childEnv.CLAUDECODE;
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
  const killTimer = setTimeout(() => {
    log(`run ${run.id} hit the ${Math.round(MAX_MS / 60_000)}-minute ceiling — killing the CLI`);
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
  if (!terminalPosted) {
    terminalPosted = true;
    if (cancelled) {
      await flush(); // final events only; status is already cancelled server-side
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
  log(`runner up — server ${SERVER}, model ${MODEL}, CDP ${CDP_PORT}, claude ${CLAUDE_BIN}`);
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  while (true) {
    try {
      const run = await claimRun();
      if (run?.id && run?.token && run?.prompt) {
        await handleRun(run);
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
