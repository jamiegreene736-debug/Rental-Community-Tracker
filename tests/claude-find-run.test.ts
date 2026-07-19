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
import { buildCoworkBuyInPrompt, type CoworkBuyInPromptInput } from "../shared/cowork-buyin-prompt";
// The daemon runner is plain node .mjs — import its twins directly.
import {
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
  check("server: token compared timing-safe", serverSrc.includes("timingSafeEqual"));
  check("server: single-flight 409 on an active reservation run", serverSrc.includes("activeClaudeFindRunForReservation") && serverSrc.includes("409"));
  check(
    "server: buy-in proxy pins run-owned fields (agent body can't retarget)",
    serverSrc.includes("propertyId: run.propertyId") && serverSrc.includes("checkIn: run.checkIn") && serverSrc.includes("checkOut: run.checkOut"),
  );
  check("server: attach proxy uses the RUN's reservation, never the body's", serverSrc.includes("encodeURIComponent(run.reservationId)"));
  check("server: Airbnb links rejected at the proxy too", /airbnb\\\./.test(serverSrc) && serverSrc.includes("Airbnb links can never be attached"));
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
    bookingsSrc.includes("<HeadlessFindRunPanel reservationId={r._id} />"),
  );
  check("client: run start arms the fast slot-probe window", /armCoworkRunWindow\(\);\s*\n\s*void queryClient\.invalidateQueries\(\{ queryKey: claudeFindRunStatusKey/.test(bookingsSrc));
  check("client: cancel button wired", bookingsSrc.includes("button-headless-find-cancel-"));
}

console.log(`\nclaude-find-run: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
