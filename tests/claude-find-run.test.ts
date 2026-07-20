// Headless Claude find-run suite (2026-07-19). Network-free. Guards:
// - the pure run store (single-flight, claim, bounded events, sticky
//   terminals, honest watchdog messages, token/prompt stripping);
// - the headless brief variant (byte-identical default, run-scoped attach
//   proxies, marker protocol, no Cowork sounds);
// - the daemon runner's stream classification + marker scan (imported from
//   the .mjs directly) and its EQUIVALENCE with the shared TS twin — two
//   implementations exist because the daemon runs plain node, and this lock
//   is what keeps them from drifting;
// - source wiring: routes/index/auth registration, the runner's tool
//   allowlist (curl-only Bash — the agent's whole capability surface), the
//   worker's local-slot-1-only spawn gate, and the client button/panel.
import {
  ACTIVE_CLAUDE_FIND_RUN_STATUSES,
  CLAUDE_FIND_RUN_ATTENTION_MARKER,
  CLAUDE_FIND_RUN_CLAIM_TIMEOUT_MS,
  CLAUDE_FIND_RUN_EVENT_CAP,
  CLAUDE_FIND_RUN_HEARTBEAT_TIMEOUT_MS,
  CLAUDE_FIND_RUN_MAX_AGE_MS,
  CLAUDE_FIND_RUN_RESUMED_MARKER,
  CLAUDE_FIND_RUN_STORE_CAP,
  type ClaudeFindRunRecord,
  activeClaudeFindRunForReservation,
  appendClaudeFindRunEvents,
  applyClaudeFindRunUpdate,
  browserMcpFailureFromInit,
  claimNextClaudeFindRun,
  classifyClaudeStreamLine,
  claudeFindRunStatusLabel,
  claudeFindRunWatchdogVerdict,
  clientClaudeFindRunView,
  latestClaudeFindRunForReservation,
  parseClaudeFindRunStore,
  scanClaudeFindRunMarkers,
  scrubClaudeFindRunToken,
  serializeClaudeFindRunStore,
} from "../shared/claude-find-run";
import { checkoutRunEligibility } from "../shared/claude-find-run";
import { buildCoworkBuyInPrompt, buildCoworkCheckoutPrompt, type CoworkBuyInPromptInput } from "../shared/cowork-buyin-prompt";
// The daemon runner is plain node .mjs — import its twins directly.
import {
  browserMcpFailure as runnerBrowserMcpFailure,
  classifyStreamLine as runnerClassify,
  scanMarkers as runnerScanMarkers,
} from "../daemon/vrbo-sidecar/claude-find-runner.mjs";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

const NOW = Date.parse("2026-07-19T20:00:00Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function makeRun(overrides: Partial<ClaudeFindRunRecord> = {}): ClaudeFindRunRecord {
  return {
    id: "run-1",
    reservationId: "res-1",
    propertyId: 32,
    propertyName: "Pili Mai 6BR - Sleeps 12",
    guestName: "Steve Kuykendall",
    status: "queued",
    createdAt: iso(0),
    claimedAt: null,
    heartbeatAt: null,
    endedAt: null,
    cancelRequested: false,
    attentionReason: null,
    report: null,
    error: null,
    events: [],
    droppedEvents: 0,
    token: "secret-token-abc123",
    prompt: "the brief",
    unitIds: ["prop32-kia-3br", "prop32-kia-3br-b"],
    checkIn: "2026-08-13",
    checkOut: "2026-08-20",
    ...overrides,
  };
}

console.log("claude-find-run: store logic");

// ── parse/serialize ──────────────────────────────────────────────────────────
check("junk raw parses to an empty store", parseClaudeFindRunStore("not json").runs.length === 0);
check("null raw parses to an empty store", parseClaudeFindRunStore(null).runs.length === 0);
{
  const store = { version: 1 as const, runs: [makeRun()] };
  const roundTrip = parseClaudeFindRunStore(serializeClaudeFindRunStore(store, NOW));
  check("round-trip preserves the run", roundTrip.runs.length === 1 && roundTrip.runs[0].id === "run-1");
}
{
  const oldTerminal = makeRun({ id: "old", status: "completed", endedAt: iso(-8 * 24 * 60 * 60 * 1_000) });
  const freshTerminal = makeRun({ id: "fresh", status: "completed", endedAt: iso(-60_000) });
  const activeOld = makeRun({ id: "active-old", status: "running", createdAt: iso(-9 * 24 * 60 * 60 * 1_000) });
  const parsed = parseClaudeFindRunStore(
    serializeClaudeFindRunStore({ version: 1, runs: [oldTerminal, freshTerminal, activeOld] }, NOW),
  );
  check(
    "7-day TTL evicts old terminal runs but NEVER an active run",
    parsed.runs.map((r) => r.id).join(",") === "fresh,active-old",
    parsed.runs.map((r) => r.id),
  );
}
{
  const runs = Array.from({ length: CLAUDE_FIND_RUN_STORE_CAP + 10 }, (_, i) =>
    makeRun({ id: `r${i}`, status: "completed", endedAt: iso(-1_000) }),
  );
  const parsed = parseClaudeFindRunStore(serializeClaudeFindRunStore({ version: 1, runs }, NOW));
  check(
    `store cap keeps the newest ${CLAUDE_FIND_RUN_STORE_CAP}`,
    parsed.runs.length === CLAUDE_FIND_RUN_STORE_CAP && parsed.runs[0].id === "r10",
  );
}

// ── single-flight + latest ───────────────────────────────────────────────────
{
  const runs = [
    makeRun({ id: "a", status: "completed" }),
    makeRun({ id: "b", status: "running" }),
    makeRun({ id: "c", reservationId: "other", status: "queued" }),
  ];
  check("active run found for its reservation", activeClaudeFindRunForReservation(runs, "res-1")?.id === "b");
  check("terminal-only reservation has no active run", activeClaudeFindRunForReservation([runs[0]], "res-1") === null);
  check("attention counts as active (single-flight holds)", activeClaudeFindRunForReservation([makeRun({ status: "attention" })], "res-1") !== null);
  check("latest run returns newest regardless of status", latestClaudeFindRunForReservation(runs, "res-1")?.id === "b");
}

// ── claim ────────────────────────────────────────────────────────────────────
{
  const runs = [
    makeRun({ id: "cancelled-first", cancelRequested: true }),
    makeRun({ id: "oldest-live" }),
    makeRun({ id: "newer" }),
  ];
  const claimed = claimNextClaudeFindRun(runs, iso(1_000));
  check("claim takes the oldest queued, skipping cancel-requested", claimed?.id === "oldest-live");
  check("claim flips status + stamps claimedAt/heartbeat", claimed?.status === "claimed" && claimed?.claimedAt === iso(1_000) && claimed?.heartbeatAt === iso(1_000));
  check("nothing queued → null", claimNextClaudeFindRun([makeRun({ status: "running" })], iso(0)) === null);
}

// ── bounded events ───────────────────────────────────────────────────────────
{
  const run = makeRun();
  appendClaudeFindRunEvents(
    run,
    Array.from({ length: CLAUDE_FIND_RUN_EVENT_CAP + 25 }, (_, i) => ({ at: iso(i), kind: "note" as const, text: `e${i}` })),
  );
  check(
    "event ring caps and counts drops honestly",
    run.events.length === CLAUDE_FIND_RUN_EVENT_CAP && run.droppedEvents === 25 && run.events[0].text === "e25",
  );
}

// ── update transitions ───────────────────────────────────────────────────────
{
  const run = makeRun({ status: "claimed" });
  const alive = applyClaudeFindRunUpdate(run, { events: [{ at: iso(0), kind: "note", text: "hi" }] }, iso(5_000));
  check("first events flip claimed → running + heartbeat", alive && run.status === "running" && run.heartbeatAt === iso(5_000));
  applyClaudeFindRunUpdate(run, { attention: "bot check on vrbo.com" }, iso(6_000));
  check("attention string raises attention state", run.status === "attention" && run.attentionReason === "bot check on vrbo.com");
  applyClaudeFindRunUpdate(run, { attention: null, heartbeat: true }, iso(7_000));
  check("attention:null clears back to running", run.status === "running" && run.attentionReason === null);
  applyClaudeFindRunUpdate(run, { terminal: { status: "completed", report: "the report" } }, iso(8_000));
  check("terminal completes with report + endedAt", run.status === "completed" && run.report === "the report" && run.endedAt === iso(8_000));
  const late = applyClaudeFindRunUpdate(run, { events: [{ at: iso(9), kind: "note", text: "zombie" }] }, iso(9_000));
  check("terminal is STICKY — late flush refused (runner told to stop)", late === false && run.events.every((e) => e.text !== "zombie"));
}
{
  const run = makeRun({ status: "cancelled" });
  check("cancelled run refuses updates", applyClaudeFindRunUpdate(run, { heartbeat: true }, iso(0)) === false);
}

// ── watchdog ─────────────────────────────────────────────────────────────────
{
  check("fresh queued run → none", claudeFindRunWatchdogVerdict(makeRun(), NOW + 60_000).action === "none");
  const unclaimed = claudeFindRunWatchdogVerdict(makeRun(), NOW + CLAUDE_FIND_RUN_CLAIM_TIMEOUT_MS + 1_000);
  check(
    "unclaimed past 5 min fails naming the Mac runner",
    unclaimed.action === "fail" && /Mac runner never picked this up/.test(unclaimed.error ?? ""),
  );
  const silent = claudeFindRunWatchdogVerdict(
    makeRun({ status: "running", heartbeatAt: iso(0) }),
    NOW + CLAUDE_FIND_RUN_HEARTBEAT_TIMEOUT_MS + 1_000,
  );
  check("silent runner past 10 min fails naming the heartbeat", silent.action === "fail" && /went silent/.test(silent.error ?? ""));
  const fresh = claudeFindRunWatchdogVerdict(makeRun({ status: "running", heartbeatAt: iso(60_000) }), NOW + 120_000);
  check("beating runner → none", fresh.action === "none");
  const ceiling = claudeFindRunWatchdogVerdict(
    makeRun({ status: "attention", heartbeatAt: iso(CLAUDE_FIND_RUN_MAX_AGE_MS) }),
    NOW + CLAUDE_FIND_RUN_MAX_AGE_MS + 1_000,
  );
  check("90-min ceiling closes even a beating run", ceiling.action === "fail" && /90-minute ceiling/.test(ceiling.error ?? ""));
  check("terminal run → none", claudeFindRunWatchdogVerdict(makeRun({ status: "failed" }), NOW + 10 * CLAUDE_FIND_RUN_MAX_AGE_MS).action === "none");
}

// ── client view strips secrets ───────────────────────────────────────────────
{
  const run = makeRun({ events: Array.from({ length: 80 }, (_, i) => ({ at: iso(i), kind: "note" as const, text: `e${i}` })) });
  const view = clientClaudeFindRunView(run) as Record<string, unknown>;
  check("client view has NO token key", !("token" in view));
  check("client view has NO prompt key", !("prompt" in view));
  check("client view truncates events to 60 and counts the rest as dropped", (view.events as unknown[]).length === 60 && view.droppedEvents === 20);
}
check("token scrub replaces every occurrence", scrubClaudeFindRunToken("x secret-t x secret-t", "secret-t") === "x [run-token] x [run-token]");

// ── status labels ────────────────────────────────────────────────────────────
check("attention label tone is attention", claudeFindRunStatusLabel("attention").tone === "attention");
check("completed label tone is good", claudeFindRunStatusLabel("completed").tone === "good");

// ── headless brief variant ───────────────────────────────────────────────────
console.log("claude-find-run: headless brief");
const briefInput: CoworkBuyInPromptInput = {
  reservationId: "6a240f0640199c00133967ab",
  guestName: "Steve Kuykendall",
  propertyId: 32,
  propertyName: "Pili Mai 6BR - Sleeps 12",
  community: "Pili Mai",
  checkIn: "2026-08-13",
  checkOut: "2026-08-20",
  units: [
    { unitId: "prop32-kia-3br", unitLabel: "Unit A (3BR)", bedrooms: 3 },
    { unitId: "prop32-kia-3br-b", unitLabel: "Unit B (3BR)", bedrooms: 3 },
  ],
  netRevenue: 5250.55,
  baseUrl: "https://admin.example.com",
};
{
  const plain = buildCoworkBuyInPrompt(briefInput);
  const emptyOpts = buildCoworkBuyInPrompt(briefInput, {});
  check("headlessRun ABSENT keeps the prompt byte-identical (Cowork contract untouched)", plain === emptyOpts);
  const headless = buildCoworkBuyInPrompt(briefInput, { headlessRun: { runId: "run-77", runToken: "tok-abcdef" } });
  check("headless brief differs from the Cowork brief", headless !== plain);
  check(
    "create call points at the run-scoped agent proxy",
    headless.includes("https://admin.example.com/api/claude-find-runs/agent/run-77/buy-ins"),
  );
  check(
    "attach call points at the run-scoped agent proxy",
    headless.includes("https://admin.example.com/api/claude-find-runs/agent/run-77/attach"),
  );
  check("headless brief NEVER exposes the raw create endpoint", !headless.includes("/api/buy-ins\n") && !headless.includes("POST https://admin.example.com/api/buy-ins"));
  check("headless brief NEVER exposes the raw attach endpoint", !headless.includes("attach-buy-in"));
  check("run token rides as the X-Run-Token header", headless.includes(`X-Run-Token: tok-abcdef`));
  check("marker protocol present (ATTENTION/RESUMED)", headless.includes(CLAUDE_FIND_RUN_ATTENTION_MARKER) && headless.includes(CLAUDE_FIND_RUN_RESUMED_MARKER));
  check("headless brief owns no sounds (wrapper does)", !headless.includes("afplay") && !headless.includes("osascript") && !/\bsay -r\b/.test(headless));
  check("headless browser rule replaces the Cowork real-Chrome rule", headless.includes("dedicated Chrome") && !headless.includes("my REAL Chrome"));
  check("final-message-is-the-report instruction present", /FINAL MESSAGE becomes the run's saved report/.test(headless));
  check("find-only contract survives — headless still ends at ATTACH", headless.includes("This task ends at ATTACH"));
  check("profit guard survives in the headless brief", headless.includes("## Profit guard"));

  // ── Guest-expectation Phase 2 (2026-07-20): after attach, confirm the units
  // are what the guest booked. Read-only + a run-scoped verdict record; a
  // concerns/unhappy verdict alerts the operator. This is the config the SERVER
  // actually builds (see the server source guard below).
  const guest = buildCoworkBuyInPrompt(briefInput, {
    headlessRun: { runId: "run-77", runToken: "tok-abcdef" },
    afterAttach: "guest_expectation",
  });
  check("guest-expectation phase is appended", guest.includes("Phase 2 — will the GUEST be happy"));
  check(
    "guest-expectation replaces the ends-at-ATTACH stop with a continue",
    !guest.includes("This task ends at ATTACH") && /continue immediately with the guest-expectation check/i.test(guest),
  );
  check(
    "verdict recorded through the RUN-SCOPED proxy with the run token — never the raw endpoint",
    guest.includes("/api/claude-find-runs/agent/run-77/guest-happy")
      && guest.includes("X-Run-Token: tok-abcdef")
      && !guest.includes("/api/bookings/6a") // never the raw /api/bookings/:id/guest-happy
  );
  check(
    "the three verdicts are the only ones offered",
    /"verdict":"<happy \| concerns \| unhappy>"/.test(guest),
  );
  check(
    "a concerns/unhappy verdict ALERTS via the ATTENTION marker, but the agent does NOT wait",
    /ATTENTION: Guest expectation/.test(guest) && /DO NOT wait/.test(guest) && /finish the report/.test(guest),
  );
  check(
    "Phase 2 is READ-ONLY — never books, detaches, or re-finds",
    /never\s+books, detaches, or re-finds/.test(guest) && !/enter (a|the) card/i.test(guest.slice(guest.indexOf("Phase 2 — will the GUEST"))),
  );
  check(
    "guest_expectation is inert without the headless opt (only the runner drives it)",
    !buildCoworkBuyInPrompt(briefInput, { afterAttach: "guest_expectation" }).includes("Phase 2 — will the GUEST"),
  );
}

// ── runner classification + marker scan (.mjs) + TS-twin equivalence ─────────
console.log("claude-find-run: runner stream classification");
const FIXTURE_LINES = [
  JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-4-6", tools: ["a", "b", "c"] }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Searching VRBO for Pili Mai 3BR options now." }] } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__chrome__navigate_page", input: { url: "https://www.vrbo.com/search?q=pili+mai" } }] } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: `curl -sS -X POST https://x/api/claude-find-runs/agent/run-77/buy-ins -H "X-Run-Token: t" -d '{"costPaid":"1820"}'` } }] } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "curl -sS -X POST https://x/api/claude-find-runs/agent/run-77/attach -d '{}'" } }] } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: "pili mai 3br vrbo" } }] } }),
  JSON.stringify({ type: "result", subtype: "success", duration_ms: 900_000, result: "final report text" }),
  "not json at all",
  JSON.stringify({ type: "user", message: {} }),
];
{
  const events = FIXTURE_LINES.map((l) => runnerClassify(l, iso(0)));
  check("init line → runner-started status", events[0]?.kind === "status" && /claude-sonnet-4-6, 3 tools/.test(events[0].text));
  check("assistant text → note", events[1]?.kind === "note" && /Searching VRBO/.test(events[1].text));
  check("navigate tool → Opening <url>", events[2]?.kind === "action" && events[2].text.startsWith("Opening https://www.vrbo.com/"));
  check(
    "buy-in curl → terse action WITHOUT the payload (no cost in the feed)",
    events[3]?.text === "Creating a buy-in record via the portal" && !events[3].text.includes("1820"),
  );
  check("attach curl → terse attach action", events[4]?.text === "Attaching a buy-in to the reservation");
  check("WebSearch → searching line", events[5]?.text.startsWith("Searching the web: pili mai"));
  check("result → finished status with minutes", events[6]?.kind === "status" && /finished after 15 min/.test(events[6].text));
  check("junk + unknown types → null", events[7] === null && events[8] === null);

  // EQUIVALENCE LOCK: the shared TS twin must classify every fixture line
  // identically — this is what stops the two implementations drifting.
  const twinMatches = FIXTURE_LINES.every((l) => {
    const a = runnerClassify(l, iso(0));
    const b = classifyClaudeStreamLine(l, iso(0));
    return JSON.stringify(a) === JSON.stringify(b);
  });
  check("runner .mjs and shared TS classification are behaviorally identical", twinMatches);
}

// ── The browser guard (2026-07-19) ──────────────────────────────────────────
// A REAL run came up with chrome-devtools-mcp "failed", lost every browser
// tool, and kept going on WebSearch alone — announcing "ATTENTION: browser
// tools missing … I will … attach the best-qualified listings I can verify".
// It was on its way to attaching units it had never opened, and the only trace
// was prose inside a JSONL file on the Mac. A browser-less find-run is not a
// degraded run, it is the wrong run.
{
  const init = (servers: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({
    type: "system", subtype: "init", model: "claude-sonnet-4-6", tools: ["WebSearch"],
    mcp_servers: servers, ...extra,
  });

  check(
    "chrome connected → no failure (the happy path stays silent)",
    browserMcpFailureFromInit(init([{ name: "chrome", status: "connected" }])) === null,
  );
  check(
    // The exact shape observed on the live run.
    "chrome failed → run-ending error naming the cause",
    (() => {
      const err = browserMcpFailureFromInit(init([
        { name: "railway-mcp-server", status: "failed" },
        { name: "chrome", status: "failed" },
      ]));
      return typeof err === "string"
        && /browser did not attach/i.test(err)
        && /could not verify/i.test(err);
    })(),
  );
  check(
    "chrome missing entirely → also a failure (absence is not success)",
    typeof browserMcpFailureFromInit(init([{ name: "railway-mcp-server", status: "connected" }])) === "string",
  );
  check(
    "no mcp_servers field at all → failure, never assumed healthy",
    typeof browserMcpFailureFromInit(JSON.stringify({ type: "system", subtype: "init", model: "m", tools: [] })) === "string",
  );
  check(
    "a connected chrome alongside other FAILED servers is still fine",
    browserMcpFailureFromInit(init([
      { name: "railway-mcp-server", status: "failed" },
      { name: "chrome", status: "connected" },
    ])) === null,
  );

  // Only the init line decides this — never a later line.
  check(
    "non-init lines are ignored",
    browserMcpFailureFromInit(JSON.stringify({ type: "assistant", message: { content: [] } })) === null
      && browserMcpFailureFromInit(JSON.stringify({ type: "result", subtype: "success" })) === null
      && browserMcpFailureFromInit("not json") === null,
  );

  // EQUIVALENCE LOCK — the daemon runs the .mjs copy, so a fix applied to only
  // one implementation would leave the live Mac silently unguarded.
  const CASES = [
    init([{ name: "chrome", status: "connected" }]),
    init([{ name: "chrome", status: "failed" }]),
    init([{ name: "railway-mcp-server", status: "failed" }, { name: "chrome", status: "failed" }]),
    init([]),
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [] } }),
    "not json",
  ];
  check(
    "runner .mjs and shared TS browser guard are behaviorally identical",
    CASES.every((l) => runnerBrowserMcpFailure(l) === browserMcpFailureFromInit(l)),
  );
}

// ── Runner wiring: the guard must actually END the run ───────────────────────
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const runnerSrc = fs.readFileSync(path.join(here, "../daemon/vrbo-sidecar/claude-find-runner.mjs"), "utf8");

  check(
    "the guard kills the CLI as soon as the init line shows no browser",
    /const failure = browserMcpFailure\(line\);/.test(runnerSrc)
      && /browserFailure = failure;/.test(runnerSrc)
      && /child\.kill\("SIGTERM"\)/.test(runnerSrc),
  );
  check(
    // A browser-less run can still emit subtype:"success" full of
    // web-searched guesses; that must never be recorded as a completed find.
    "a browser failure outranks the success/result branches in the terminal classifier",
    (() => {
      const term = runnerSrc.slice(runnerSrc.indexOf("if (!terminalPosted)"));
      const guard = term.indexOf("} else if (browserFailure) {");
      const success = term.indexOf("sawResult && resultReport !== null");
      return guard > -1 && success > -1 && guard < success;
    })(),
  );
  check(
    "the browser failure is reported as FAILED, never completed",
    /browserFailure[\s\S]{0,400}?terminal: \{ status: "failed"/.test(runnerSrc),
  );
  check(
    // "@latest" forces a registry round-trip on EVERY run; that is what blew
    // the MCP startup window and produced the browser-less run.
    "chrome-devtools-mcp is version-PINNED, never @latest",
    runnerSrc.includes("chrome-devtools-mcp@1.6.0")
      && !runnerSrc.includes("chrome-devtools-mcp@latest"),
  );
  check(
    "the run loads ONLY its own MCP config (no user-scope servers)",
    runnerSrc.includes('"--strict-mcp-config"'),
  );
  // 2026-07-19: the browser MCP hand-shake takes ~2.6s; a cold/contended start
  // overran the CLI's default MCP budget and left a real run browser-less. Two
  // belts: preflight-warm-and-verify before the run, and give the CLI a real
  // startup budget.
  check(
    "the browser MCP is preflighted (warmed + verified) before the agent run, and retried",
    runnerSrc.includes("async function preflightBrowserMcp")
      && /for \(let attempt = 1; attempt <= BROWSER_PREFLIGHT_ATTEMPTS/.test(runnerSrc)
      && runnerSrc.includes("if (!browserReady) {"),
  );
  check(
    "a failed preflight ENDS the run (never runs browser-less), after Chrome re-checks",
    (() => {
      const loop = runnerSrc.slice(runnerSrc.indexOf("let browserReady"), runnerSrc.indexOf("Ad-hoc MCP config"));
      return loop.includes("await ensureRunnerChrome();") // re-check between attempts
        && /if \(!browserReady\) \{[\s\S]*?await fail\(/.test(loop);
    })(),
  );
  check(
    "the preflight verifies a real serverInfo handshake (not just that the process spawned)",
    (() => {
      const fn = runnerSrc.slice(runnerSrc.indexOf("async function preflightBrowserMcp"), runnerSrc.indexOf("// ── portal I/O"));
      return fn.includes('buf.includes(\'"serverInfo"\')') && fn.includes('method: "initialize"');
    })(),
  );
  check(
    "the CLI gets a real MCP startup budget via MCP_TIMEOUT",
    runnerSrc.includes("childEnv.MCP_TIMEOUT = String(CLI_MCP_TIMEOUT_MS)")
      && /CLI_MCP_TIMEOUT_MS = Number\(process\.env\.CLAUDE_FIND_RUN_MCP_TIMEOUT_MS \?\? 30_000\)/.test(runnerSrc),
  );
  // 2026-07-19 (the ACTUAL root cause of every browser-less daemon run, proven
  // by `ps eww` on the live runner): launchd hands the daemon
  // PATH=/usr/bin:/bin:/usr/sbin:/sbin, where bare `spawn("npx")` is ENOENT in
  // ~5ms — for the CLI's MCP spawn AND the preflight. Every shell test passed
  // (full user PATH); every daemon run failed. The prior "cold-start latency"
  // theory was a shell-side artifact.
  check(
    "npx is resolved to an ABSOLUTE path (env override + runtime bin dir + install locations)",
    runnerSrc.includes("function resolveNpxBin()")
      && runnerSrc.includes("CLAUDE_FIND_RUN_NPX_BIN")
      && runnerSrc.includes('path.join(path.dirname(process.execPath), "npx")'),
  );
  check(
    // Both spawn sites must use it — one bare "npx" left behind re-breaks the
    // daemon while every shell test keeps passing.
    "BOTH the MCP config and the preflight spawn use the absolute NPX_BIN, never bare npx",
    (() => {
      // CODE only — the runner's comments narrate the old bare-npx failure.
      const codeOnly = runnerSrc.replace(/^\s*\/\/[^\n]*/gm, "");
      return codeOnly.includes("chrome: { command: NPX_BIN")
        && /spawn\(NPX_BIN, \["-y", CHROME_MCP_PKG/.test(codeOnly)
        && !/command: "npx"/.test(codeOnly)
        && !/spawn\("npx"/.test(codeOnly);
    })(),
  );
  check(
    // npx is a #!/usr/bin/env node script: even invoked absolutely it needs
    // `node` resolvable on PATH, as does anything it spawns.
    "the CLI child AND the preflight get the EXTENDED_PATH (launchd's PATH is bare)",
    runnerSrc.includes("childEnv.PATH = EXTENDED_PATH")
      && /env: \{ \.\.\.process\.env, PATH: EXTENDED_PATH \}/.test(runnerSrc)
      && runnerSrc.includes("path.dirname(process.execPath), // the node actually running this daemon"),
  );
}
{
  const scan = runnerScanMarkers("working…\nATTENTION: bot check on vrbo.com — unit A\nstill waiting");
  check("ATTENTION marker scanned with reason", scan.attention === "bot check on vrbo.com — unit A");
  const cleared = runnerScanMarkers("ATTENTION: bot check\n…\nRESUMED: continuing unit A");
  check("RESUMED after ATTENTION clears it", cleared.attention === null && cleared.resumed === true);
  check("no markers → null", runnerScanMarkers("just narration").attention === null);
  const twinAgrees = ["ATTENTION: x", "ATTENTION: x\nRESUMED: y", "nothing", `${CLAUDE_FIND_RUN_ATTENTION_MARKER} only`].every(
    (t) => JSON.stringify(runnerScanMarkers(t)) === JSON.stringify(scanClaudeFindRunMarkers(t)),
  );
  check("runner .mjs and shared TS marker scans agree", twinAgrees);
}

// ── source wiring guards ─────────────────────────────────────────────────────
console.log("claude-find-run: source wiring");
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const read = (p: string) => fs.readFileSync(path.join(here, p), "utf8");

  const serverSrc = read("../server/claude-find-runs.ts");
  check("server: brief built with the headlessRun opt", serverSrc.includes("headlessRun: { runId: id, runToken: token }"));
  check(
    // 2026-07-20: the run auto-continues into the guest-expectation check.
    "server: headless brief carries afterAttach guest_expectation",
    serverSrc.includes('afterAttach: "guest_expectation"'),
  );
  check(
    // Mirrors the buy-ins/attach proxies: run-scoped token, reservation pinned
    // from the run, source forced to cowork, forwarded via loopback.
    "server: run-scoped guest-happy proxy exists, pins the run's reservation, forces source cowork",
    serverSrc.includes('app.post("/api/claude-find-runs/agent/:id/guest-happy"')
      && serverSrc.includes("encodeURIComponent(run.reservationId)}/guest-happy")
      && serverSrc.includes('source: "cowork"')
      && /verdict must be one of: happy, concerns, unhappy/.test(serverSrc),
  );
  check("server: token compared timing-safe", serverSrc.includes("timingSafeEqual"));
  check("server: single-flight 409 on an active reservation run", serverSrc.includes("activeClaudeFindRunForReservation") && serverSrc.includes("409"));
  check(
    "server: buy-in proxy pins run-owned fields (agent body can't retarget)",
    serverSrc.includes("propertyId: run.propertyId") && serverSrc.includes("checkIn: run.checkIn") && serverSrc.includes("checkOut: run.checkOut"),
  );
  check("server: attach proxy uses the RUN's reservation, never the body's", serverSrc.includes("encodeURIComponent(run.reservationId)"));
  check("server: Airbnb links rejected at the proxy too", /airbnb\\\./.test(serverSrc) && serverSrc.includes("Airbnb links can never be attached"));
  check(
    // 2026-07-20: a real run attached $0 buy-ins because the agent hill-climbed
    // against the 422s down to the minimal accepted body and dropped costPaid,
    // which the server then silently defaulted to "0". costPaid must be as hard
    // a requirement as unitId/URL so the agent's iteration includes it.
    "server: buy-in create REJECTS a missing/zero costPaid (no more silent $0 default)",
    serverSrc.includes("costPaid is required and must be the unit's total stay cost")
      && /!Number\.isFinite\(costPaid\) \|\| costPaid <= 0/.test(serverSrc)
      && !serverSrc.includes(': "0",')
      && serverSrc.includes("costPaid: costPaid.toFixed(2)"),
  );
  {
    const promptSrc = read("../shared/cowork-buyin-prompt.ts");
    check(
      // Belt-and-braces on top of the server 422: the headless auth note tells
      // the agent to send the complete body in one call and that costPaid is
      // required + > 0. Headless-only, so the default-prompt byte-identical
      // lock (test above) is untouched.
      "prompt: headless note demands a complete body with a real costPaid",
      promptSrc.includes("Send the COMPLETE create body in ONE call")
        && promptSrc.includes('"costPaid" is REQUIRED')
        && /recorded at 0 is a bug/.test(promptSrc),
    );
  }
  check("server: agent endpoints forward via 127.0.0.1 loopback", serverSrc.includes("loopbackBaseUrl") && serverSrc.includes("loopbackRequestHeaders"));
  check("server: kill switch honored at create", serverSrc.includes("CLAUDE_FIND_RUNS_DISABLED"));

  const routesSrc = read("../server/routes.ts");
  check("routes.ts registers the find-run routes", routesSrc.includes("registerClaudeFindRunRoutes(app)"));
  const indexSrc = read("../server/index.ts");
  check("index.ts starts the find-run watchdog", indexSrc.includes("startClaudeFindRunWatchdog()"));

  const authSrc = read("../server/auth.ts");
  check(
    "auth.ts opens ONLY the /agent/ prefix (operator routes stay gated)",
    authSrc.includes('"/api/claude-find-runs/agent/"') && !authSrc.includes('"/api/claude-find-runs/",'),
  );

  const runnerSrc = read("../daemon/vrbo-sidecar/claude-find-runner.mjs");
  check(
    "runner: tool allowlist is exactly browser MCP + curl-only Bash + web search/fetch",
    runnerSrc.includes(`const ALLOWED_TOOLS = ["mcp__chrome", "Bash(curl:*)", "WebSearch", "WebFetch"];`),
  );
  check("runner: no bare Bash allowance anywhere", !/ALLOWED_TOOLS = \[[^\]]*"Bash"[,\]]/.test(runnerSrc));
  check("runner: ADMIN_SECRET never reaches the agent child env", runnerSrc.includes("delete childEnv.ADMIN_SECRET"));
  check("runner: nested-session guard env stripped", runnerSrc.includes("delete childEnv.CLAUDECODE"));
  check("runner: prompt travels via stdin (no ARG_MAX risk)", runnerSrc.includes("child.stdin.write(run.prompt)"));
  check("runner: report + events token-scrubbed before posting", (runnerSrc.match(/scrubToken\(/g) ?? []).length >= 4);
  check("runner: markers match the shared constants", runnerSrc.includes(`const ATTENTION_MARKER = "${CLAUDE_FIND_RUN_ATTENTION_MARKER}"`) && runnerSrc.includes(`const RESUMED_MARKER = "${CLAUDE_FIND_RUN_RESUMED_MARKER}"`));
  check("runner: CLI login failure surfaces the one-time setup instruction", runnerSrc.includes("run `claude`, then `/login`") || /One-time setup/.test(runnerSrc));

  const workerSrc = read("../daemon/vrbo-sidecar/worker.mjs");
  check(
    "worker: runner spawns ONLY on the local Mac's slot 1 (never Railway server workers)",
    workerSrc.includes(`WORKER_ROLE === "server" || WORKER_SLOT !== "1"`) && workerSrc.includes("maybeStartClaudeFindRunner()"),
  );
  check("worker: runner kill switch honored", workerSrc.includes('CLAUDE_FIND_RUNS_DISABLED === "1"'));

  const bookingsSrc = read("../client/src/pages/bookings.tsx");
  check("client: start button POSTs /api/claude-find-runs", bookingsSrc.includes('apiRequest("POST", "/api/claude-find-runs", {'));
  check("client: button label present", bookingsSrc.includes("Auto-run · find cheapest (no window)"));
  check(
    "client: panel is ALWAYS mounted (report survives the empty-slots box disappearing)",
    /<HeadlessFindRunPanel\s+reservationId=\{r\._id\}/.test(bookingsSrc),
  );
  check("client: run start arms the fast slot-probe window", /armCoworkRunWindow\(\);\s*\n\s*void queryClient\.invalidateQueries\(\{ queryKey: claudeFindRunStatusKey/.test(bookingsSrc));
  check("client: cancel button wired", bookingsSrc.includes("button-headless-find-cancel-"));

  // ── Log-UI redesign (2026-07-20) ──────────────────────────────────────────
  check(
    // The final report used to render twice — once truncated in the feed, once
    // in full below. The feed now filters the echo.
    "client: the feed drops the note that duplicates the final report",
    bookingsSrc.includes("isFinalReportEcho(e, run.report)"),
  );
  check(
    "client: events are TYPED (milestones / search / browse / notes), not one flat wall",
    bookingsSrc.includes("classifyFindRunEvent(event)") && bookingsSrc.includes("FindRunEventRow"),
  );
  check(
    "client: the report is rendered as elements, not a raw markdown <pre>",
    bookingsSrc.includes("parseFindRunReport(markdown)")
      && bookingsSrc.includes('data-testid="findrun-report-rendered"')
      && !/<pre[^>]*>\s*\{run\.report\}/.test(bookingsSrc),
  );
  check(
    "client: the outcome strip surfaces attached units + prices + guest verdict",
    bookingsSrc.includes("findRunGuestVerdictBadge(verdictRaw)")
      && /units? attached/.test(bookingsSrc)
      && bookingsSrc.includes("guestHappyVerdict"),
  );
  check(
    // 'Separate each session better' — prior runs are shown as their own rows.
    "client: prior runs render as separated 'Earlier runs' sessions",
    bookingsSrc.includes("findrun-history-") && bookingsSrc.includes("Earlier runs ("),
  );
  check("client: the panel receives the reservation's attached buy-ins", bookingsSrc.includes("attachedUnits={r.slots"));

  // Server + shared history plumbing.
  check(
    "server: status payload carries per-reservation run history",
    serverSrc.includes("claudeFindRunHistoryForReservation(store.runs, reservationId)") && serverSrc.includes("history,"),
  );
  const sharedSrc = read("../shared/claude-find-run.ts");
  check(
    "shared: history excludes the latest run and is capped + newest-first",
    sharedSrc.includes("export function claudeFindRunHistoryForReservation")
      && sharedSrc.includes("mine.slice(1, 1 + limit)"),
  );
  check(
    // The verdict record shows as a first-class milestone in the feed.
    "shared + runner: the guest-happy curl is a labelled milestone (both twins)",
    sharedSrc.includes('if (endpoint === "guest-happy") return "Recording the guest-expectation verdict"')
      && runnerSrc.includes('if (endpoint === "guest-happy") return "Recording the guest-expectation verdict"')
      && runnerSrc.includes("(buy-ins|attach|guest-happy|checkout-claim\\/complete|checkout-claim\\/release|checkout-claim|traveler-email|buy-in)"),
  );
}

// ── HEADLESS CHECKOUT RUNS (2026-07-20) ─────────────────────────────────────
console.log("claude-find-run: checkout-run eligibility (server-authoritative money data)");
{
  const okRow = {
    id: 538,
    guestyReservationId: "res-1",
    bookingStatus: "not_started",
    airbnbListingUrl: "https://www.vrbo.com/4768896",
    costPaid: "1968.00",
    unitLabel: "Luana Kai C307",
    unitId: "unit-b",
  };
  const ok = checkoutRunEligibility(okRow, "res-1");
  check("a clean attached VRBO buy-in is eligible", ok.ok === true);
  check(
    "the approved unit carries id/label/URL/COST from the ROW (the brief's money anchor)",
    ok.ok === true && ok.unit.buyInId === 538 && ok.unit.costPaid === 1968
      && ok.unit.listingUrl === "https://www.vrbo.com/4768896" && ok.unit.unitLabel === "Luana Kai C307",
  );
  check("missing row → not found", checkoutRunEligibility(null, "res-1").ok === false);
  check(
    "attached to ANOTHER reservation → rejected (a run must never prepare another booking's unit)",
    checkoutRunEligibility({ ...okRow, guestyReservationId: "res-OTHER" }, "res-1").ok === false,
  );
  check(
    "booked / request_submitted → rejected (re-preparing risks a DUPLICATE purchase)",
    checkoutRunEligibility({ ...okRow, bookingStatus: "booked" }, "res-1").ok === false
      && checkoutRunEligibility({ ...okRow, bookingStatus: "request_submitted" }, "res-1").ok === false,
  );
  check(
    "queued / in_progress / awaiting_payment → rejected (a handoff is already active)",
    (["queued", "in_progress", "awaiting_payment"] as const).every(
      (s) => checkoutRunEligibility({ ...okRow, bookingStatus: s }, "res-1").ok === false,
    ),
  );
  check(
    "a non-VRBO listing → rejected with the re-channel pointer",
    (() => {
      const r = checkoutRunEligibility({ ...okRow, airbnbListingUrl: "https://www.booking.com/hotel/x" }, "res-1");
      return r.ok === false && /Find property on VRBO/.test(r.error);
    })(),
  );
  check(
    "http (not https) vrbo → rejected",
    checkoutRunEligibility({ ...okRow, airbnbListingUrl: "http://www.vrbo.com/1" }, "res-1").ok === false,
  );
  check(
    "a vrbo-lookalike host → rejected",
    checkoutRunEligibility({ ...okRow, airbnbListingUrl: "https://vrbo.com.evil.example/1" }, "res-1").ok === false,
  );
  check("no listing URL → rejected", checkoutRunEligibility({ ...okRow, airbnbListingUrl: null }, "res-1").ok === false);
  check(
    "zero / missing costPaid → rejected (it arms the 15% guard)",
    checkoutRunEligibility({ ...okRow, costPaid: "0" }, "res-1").ok === false
      && checkoutRunEligibility({ ...okRow, costPaid: null }, "res-1").ok === false,
  );
}

console.log("claude-find-run: headless checkout brief");
{
  const input = {
    reservationId: "res-1",
    guestName: "Jacelyn Tsu",
    propertyName: "Menehune Shores - 4BR Condos - Sleeps 12",
    checkIn: "2026-07-21",
    checkOut: "2026-07-26",
    units: [{ buyInId: 538, unitLabel: "Luana Kai C307", listingUrl: "https://www.vrbo.com/4768896", costPaid: "1968" }],
    party: { total: 12, adults: 10, children: 2 } as any,
    baseUrl: "https://portal.example",
  };
  const headless = buildCoworkCheckoutPrompt(input, { headlessRun: { runId: "run-9", runToken: "tok-9" } });
  const plain = buildCoworkCheckoutPrompt(input);
  check(
    "headless brief calls ONLY the run-scoped proxies (buy-in read, claim, complete, release, traveler-email)",
    headless.includes("/api/claude-find-runs/agent/run-9/buy-in")
      && headless.includes("/api/claude-find-runs/agent/run-9/checkout-claim")
      && headless.includes("/api/claude-find-runs/agent/run-9/checkout-claim/complete")
      && headless.includes("/api/claude-find-runs/agent/run-9/checkout-claim/release")
      && headless.includes("/api/claude-find-runs/agent/run-9/traveler-email")
      && !headless.includes("/api/cowork/checkout-claims")
      && !headless.includes("/api/buy-ins/"),
  );
  check("headless brief authenticates every call with the run token", headless.includes("X-Run-Token: tok-9"));
  check(
    "headless brief ENDS at the handoff — no wait-for-my-click phase, no chat-recorded result",
    !headless.includes("WAIT without touching the page")
      && /never write "booked" or "request_submitted"/.test(headless)
      && headless.includes("ATTENTION: awaiting payment"),
  );
  check(
    "headless brief keeps the prepared tab OPEN and closes only its own other tabs",
    headless.includes("KEEP THE PREPARED CHECKOUT TAB OPEN") && headless.includes("Close only the OTHER tabs"),
  );
  check(
    "headless brief keeps every money guard verbatim-in-spirit (waiver-only, human-only submit, 15%)",
    headless.includes("Damage waiver ONLY")
      && /final submit is human-only/.test(headless)
      && headless.includes("15% above")
      && headless.includes("Leave card number, expiration, and security-code fields")
      && headless.includes("empty. Never access card data and NEVER click the final purchase control."),
  );
  check(
    "headless brief swaps the Cowork sounds/bot protocol for the marker protocol",
    !/afplay|osascript|Sosumi/.test(headless) && headless.includes("ATTENTION: bot check on"),
  );
  check(
    "the PLAIN checkout brief is untouched by the new opt (deep-link/bulk path intact)",
    plain.includes("/api/cowork/checkout-claims")
      && plain.includes("WAIT without touching the page")
      && plain.includes("afplay /System/Library/Sounds/Glass.aiff")
      && !plain.includes("X-Run-Token"),
  );
}

console.log("claude-find-run: checkout milestones (both describeToolUse twins)");
{
  const bashLine = (cmd: string) =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: cmd } }] } });
  const cases: Array<[string, string]> = [
    ["curl -sS https://x/api/claude-find-runs/agent/run-9/buy-in -H h", "Reading the buy-in record"],
    ["curl -sS -X POST https://x/api/claude-find-runs/agent/run-9/traveler-email -d '{}'", "Minting the traveler alias email"],
    ["curl -sS -X POST https://x/api/claude-find-runs/agent/run-9/checkout-claim -d '{}'", "Claiming the reservation's checkout lane"],
    ["curl -sS -X POST https://x/api/claude-find-runs/agent/run-9/checkout-claim/complete -d '{}'", "Recording the payment handoff — awaiting your card"],
    ["curl -sS -X POST https://x/api/claude-find-runs/agent/run-9/checkout-claim/release -d '{}'", "Releasing the checkout lane"],
    ["curl -sS -X POST https://x/api/claude-find-runs/agent/run-9/buy-ins -d '{}'", "Creating a buy-in record via the portal"],
  ];
  for (const [cmd, expected] of cases) {
    const sharedEvent = classifyClaudeStreamLine(bashLine(cmd), iso(0));
    const runnerEvent = runnerClassify(bashLine(cmd), iso(0));
    check(
      `"${expected}" — shared and runner twins agree`,
      sharedEvent?.text === expected && runnerEvent?.text === expected,
      { shared: sharedEvent?.text, runner: runnerEvent?.text },
    );
  }
}

console.log("claude-find-run: checkout-run source wiring");
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverSrc = fs.readFileSync(path.join(here, "../server/claude-find-runs.ts"), "utf8");
  const runnerSrc = fs.readFileSync(path.join(here, "../daemon/vrbo-sidecar/claude-find-runner.mjs"), "utf8");
  check(
    "the create endpoint reads the buy-in via loopback and gates on checkoutRunEligibility",
    serverSrc.includes('app.post("/api/claude-find-runs/checkout"')
      && serverSrc.includes("`${loopbackBaseUrl()}/api/buy-ins/${buyInId}`")
      && serverSrc.includes("checkoutRunEligibility(row, reservationId)"),
  );
  check(
    "the create endpoint refuses to queue without the booking guest's full name",
    serverSrc.includes("full name is required"),
  );
  check(
    "ONE live run per reservation across BOTH kinds (find blocks checkout and vice versa)",
    (serverSrc.match(/activeClaudeFindRunForReservation\(store\.runs, /g) ?? []).length >= 2,
  );
  check(
    "every checkout proxy is gated on run kind + pinned buyInId",
    serverSrc.includes('run.kind !== "checkout"')
      && serverSrc.includes("const checkoutRunFor")
      && serverSrc.includes("reservationId: gate.run.reservationId")
      && serverSrc.includes("/api/buy-ins/${gate.buyInId}"),
  );
  check(
    // The agent must never be able to write a booking result: the operator
    // records the paid outcome. There is deliberately NO bookingStatus proxy.
    "no agent proxy can PATCH a bookingStatus",
    !/agent\/[^"]*"\s*,[^]*?bookingStatus/.test(serverSrc.slice(serverSrc.indexOf("CHECKOUT-run agent proxies"))),
  );
  check(
    "the checkout run record pins kind + buyInId and embeds the headless brief",
    serverSrc.includes('kind: "checkout"')
      && serverSrc.includes("buyInId,")
      && serverSrc.includes("buildCoworkCheckoutPrompt(")
      && serverSrc.includes("{ headlessRun: { runId: id, runToken: token } }"),
  );
  check(
    // The runner Chrome launches minimized/off-screen; a checkout handoff (or
    // a bot wall) needs the window IN FRONT of the operator. Surfacing rides
    // the ATTENTION path so both cases get it.
    "the runner surfaces its Chrome window whenever attention is raised",
    runnerSrc.includes("async function surfaceRunnerChrome")
      && runnerSrc.includes("Browser.setWindowBounds")
      && runnerSrc.includes("void surfaceRunnerChrome();"),
  );

  // ── The YELLOW card-handoff pop-up (operator directive 2026-07-20) ────────
  console.log("claude-find-run: yellow card-handoff pop-up");
  check(
    // The payment handoff gets the sidecar's yellow challenge treatment ON THE
    // PREPARED CHECKOUT TAB: near-fullscreen window + tab activation + an
    // injected top banner and border, in the sidecar's exact yellows.
    // Behaviorally proven against a real CDP Chrome pre-merge (banner painted
    // into the vrbo tab only, click-transparent, idempotent).
    "the payment handoff paints the yellow banner + border into the checkout tab",
    runnerSrc.includes("export async function surfaceCheckoutHandoff")
      && runnerSrc.includes("rct-findrun-card-banner")
      && runnerSrc.includes("rct-findrun-card-border")
      && runnerSrc.includes("#fde047")
      && runnerSrc.includes("#facc15")
      && runnerSrc.includes("ADD THE CREDIT CARD")
      && runnerSrc.includes("No purchase has been submitted")
      && runnerSrc.includes("/json/activate/")
      && runnerSrc.includes("Runtime.evaluate"),
  );
  check(
    // DISPLAY-ONLY is load-bearing: the border must be click-transparent and
    // nothing may touch the payment form. The card + final click are the
    // operator's alone.
    "the injected treatment is display-only (click-transparent border, no form access)",
    runnerSrc.includes("pointer-events: none")
      // (\.value\s*=[^=] — a bare assignment; `.value === "painted"` is the
      // legit CDP result read and must not trip this.)
      && !/(querySelector\(\s*["']input|\.value\s*=[^=]|\.click\(\)|\.submit\(\))/.test(
        runnerSrc.slice(runnerSrc.indexOf("surfaceCheckoutHandoff"), runnerSrc.indexOf("let attentionAlarm")),
      ),
  );
  check(
    "awaiting-payment attention routes to the yellow pop-up; other attention keeps plain surfacing",
    runnerSrc.includes("/^awaiting payment\\b/i.test(String(reason ?? \"\").trim())")
      && runnerSrc.includes("void surfaceCheckoutHandoff(reason);"),
  );
  // DRIFT-LOCK, behavioral: the headless checkout brief MANDATES the exact
  // ATTENTION line; after scanMarkers strips the marker, the remaining reason
  // must match the runner's routing regex — reword either side alone and this
  // trips before the operator loses the yellow pop-up.
  {
    const brief = buildCoworkCheckoutPrompt(
      {
        reservationId: "res-1",
        guestName: "Jacelyn Tsu",
        propertyName: "Menehune Shores",
        checkIn: "2026-07-21",
        checkOut: "2026-07-26",
        units: [{ buyInId: 538, unitLabel: "Luana Kai C307", listingUrl: "https://www.vrbo.com/1", costPaid: "1968" }],
        baseUrl: "https://x.example",
      },
      { headlessRun: { runId: "r", runToken: "t" } },
    );
    const mandated = brief.split("\n").find((l) => l.trim().startsWith("ATTENTION: awaiting payment"));
    const scanned = mandated ? runnerScanMarkers(mandated.trim()) : { attention: null };
    check(
      "the brief's mandated handoff line survives scanMarkers AND matches the routing regex",
      typeof scanned.attention === "string" && /^awaiting payment\b/i.test(scanned.attention),
      scanned.attention,
    );
  }
}

console.log(`\nclaude-find-run: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
