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
  CLAUDE_FIND_RUN_BULK_MAX,
  CLAUDE_FIND_RUN_QUEUE_MAX_AGE_MS,
  activeClaudeFindRunForReservation,
  appendClaudeFindRunEvents,
  applyClaudeFindRunUpdate,
  browserMcpFailureFromInit,
  browserNeverUsedFailure,
  browserProofRequiredFromInit,
  claimNextClaudeFindRun,
  claudeFindRunnerActivity,
  claudeFindRunOverview,
  claudeFindRunQueueAhead,
  checkoutRunDidNoWorkFailure,
  classifyClaudeStreamLine,
  claudeFindRunStatusLabel,
  claudeFindRunWatchdogVerdict,
  clientClaudeFindRunView,
  latestClaudeFindRunForReservation,
  lineCallsAgentPortalEndpoint,
  lineUsesChromeBrowserTool,
  parseClaudeFindRunStore,
  reportLooksLikeRefusal,
  scanClaudeFindRunMarkers,
  scrubClaudeFindRunToken,
  serializeClaudeFindRunStore,
} from "../shared/claude-find-run";
import { checkoutRunEligibility } from "../shared/claude-find-run";
import { buildCoworkBuyInPrompt, buildCoworkCheckoutPrompt, type CoworkBuyInPromptInput } from "../shared/cowork-buyin-prompt";
// The daemon runner is plain node .mjs — import its twins directly.
import {
  browserMcpFailure as runnerBrowserMcpFailure,
  daemonRestartFailure as runnerDaemonRestartFailure,
  maxTurnsFailure as runnerMaxTurnsFailure,
  runCeilingFailure as runnerRunCeilingFailure,
  browserNeverUsedFailure as runnerBrowserNeverUsedFailure,
  browserProofRequiredFromInit as runnerBrowserProofRequired,
  checkoutRunDidNoWorkFailure as runnerCheckoutNoWorkFailure,
  classifyStreamLine as runnerClassify,
  lineCallsAgentPortalEndpoint as runnerLineCallsAgentEndpoint,
  lineUsesChromeBrowserTool as runnerLineUsesChromeTool,
  pickAttentionTarget as runnerPickAttentionTarget,
  reportLooksLikeRefusal as runnerReportLooksLikeRefusal,
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
    "7-day TTL evicts old terminal runs but NEVER an active run (createdAt order)",
    parsed.runs.map((r) => r.id).join(",") === "active-old,fresh",
    parsed.runs.map((r) => r.id),
  );
}
{
  // Deep-queue: ALL active runs survive serialization even far past the store
  // cap — a bulk batch parks dozens in "queued" and none may be dropped.
  const active = Array.from({ length: CLAUDE_FIND_RUN_STORE_CAP + 20 }, (_, i) =>
    makeRun({ id: `q${i}`, reservationId: `res-${i}`, status: "queued" }),
  );
  const parsed = parseClaudeFindRunStore(serializeClaudeFindRunStore({ version: 1, runs: active }, NOW));
  check(
    "active runs are never capped (all 52+ queued survive)",
    parsed.runs.length === CLAUDE_FIND_RUN_STORE_CAP + 20 && parsed.runs.every((r) => r.status === "queued"),
    parsed.runs.length,
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

// ── watchdog: BULK queue semantics (2026-07-20) ─────────────────────────────
// The runner is sequential, so a bulk batch legitimately parks runs in
// "queued" for hours. The watchdog must distinguish "waiting in line behind a
// live run" from "the Mac runner is down" — and a queue-parked run must get
// its FULL 90 minutes once it finally starts.
{
  const later = NOW + 45 * 60_000; // 45 min after the batch was queued
  const busyActivity = claudeFindRunnerActivity(
    [makeRun({ id: "head", reservationId: "res-head", status: "running", claimedAt: iso(60_000), heartbeatAt: iso(44 * 60_000) })],
    later,
  );
  check("runner activity: a beating run reads as busy", busyActivity.busy === true);
  check(
    "queued 45 min behind a live run → NOT failed (waiting in line is the design)",
    claudeFindRunWatchdogVerdict(makeRun({ id: "tail" }), later, busyActivity).action === "none",
  );
  const idleAfterFinish = claudeFindRunnerActivity(
    [makeRun({ id: "head", status: "completed", claimedAt: iso(60_000), heartbeatAt: iso(40 * 60_000), endedAt: iso(44 * 60_000) })],
    later,
  );
  check("runner activity: a finished run is not busy but leaves fresh lastActivity", idleAfterFinish.busy === false && idleAfterFinish.lastActivityMs === NOW + 44 * 60_000);
  check(
    // The class this basis exists for: head-of-line finishes at minute 44;
    // every queued run's createdAt-based 5-min window lapsed long ago, but the
    // runner is demonstrably alive — give it a fresh window from that proof.
    "queued run right after the head finished → NOT failed (claim window re-arms from runner activity)",
    claudeFindRunWatchdogVerdict(makeRun({ id: "tail" }), later, idleAfterFinish).action === "none",
  );
  check(
    "queued run with a runner idle past the claim window → still fails as runner-offline",
    claudeFindRunWatchdogVerdict(
      makeRun({ id: "tail" }),
      NOW + 50 * 60_000,
      { busy: false, lastActivityMs: NOW + 44 * 60_000 },
    ).action === "fail",
  );
  check(
    "no activity context at all behaves exactly like the single-run original",
    claudeFindRunWatchdogVerdict(makeRun(), NOW + CLAUDE_FIND_RUN_CLAIM_TIMEOUT_MS + 1_000).action === "fail",
  );
  check(
    "a busy runner protects a queued run of ANY age (deep overnight line never expires)",
    claudeFindRunWatchdogVerdict(
      makeRun(),
      NOW + CLAUDE_FIND_RUN_QUEUE_MAX_AGE_MS + 1_000,
      { busy: true, lastActivityMs: NOW + CLAUDE_FIND_RUN_QUEUE_MAX_AGE_MS },
    ).action === "none",
  );
  const wedged = claudeFindRunWatchdogVerdict(
    makeRun(),
    NOW + CLAUDE_FIND_RUN_QUEUE_MAX_AGE_MS + 1_000,
    // Runner NOT busy but showing recent activity (an inter-run gap) — yet this
    // run waited far past the drain window: it is being passed over → backstop.
    { busy: false, lastActivityMs: NOW + CLAUDE_FIND_RUN_QUEUE_MAX_AGE_MS },
  );
  check(
    "final backstop closes a run passed over past the drain window (idle-but-active runner)",
    wedged.action === "fail" && /past the drain window/.test(wedged.error ?? ""),
  );
  check(
    // A run that waited 3 hours in line must not be closed by the 90-min
    // ceiling 90 minutes after CREATION — the ceiling measures WORK time.
    "running ceiling measures from claimedAt, not createdAt",
    claudeFindRunWatchdogVerdict(
      makeRun({ status: "running", claimedAt: iso(3 * 60 * 60_000), heartbeatAt: iso(3 * 60 * 60_000 + 5 * 60_000) }),
      NOW + 3 * 60 * 60_000 + 10 * 60_000,
    ).action === "none"
      && claudeFindRunWatchdogVerdict(
        makeRun({ status: "running", claimedAt: iso(3 * 60 * 60_000), heartbeatAt: iso(3 * 60 * 60_000 + CLAUDE_FIND_RUN_MAX_AGE_MS) }),
        NOW + 3 * 60 * 60_000 + CLAUDE_FIND_RUN_MAX_AGE_MS + 1_000,
      ).action === "fail",
  );
  check(
    "deep-queue design: bulk cap covers a full portfolio and the backstop is generous",
    CLAUDE_FIND_RUN_BULK_MAX >= 52 && CLAUDE_FIND_RUN_QUEUE_MAX_AGE_MS >= 24 * 60 * 60_000,
  );
}

// ── queue position (queueAhead) ─────────────────────────────────────────────
{
  const runs = [
    makeRun({ id: "working", reservationId: "res-a", status: "running", claimedAt: iso(1_000) }),
    makeRun({ id: "q1", reservationId: "res-b" }),
    makeRun({ id: "cancelled-q", reservationId: "res-c", cancelRequested: true }),
    makeRun({ id: "done", reservationId: "res-d", status: "completed" }),
    makeRun({ id: "q2", reservationId: "res-e" }),
  ];
  check("first queued run counts only the one being worked", claudeFindRunQueueAhead(runs, "q1") === 1);
  check(
    "later queued run counts the worked run + earlier queued, skipping cancelled/terminal",
    claudeFindRunQueueAhead(runs, "q2") === 2,
  );
  check("the running run itself answers 0", claudeFindRunQueueAhead(runs, "working") === 0);
  check("unknown run answers 0", claudeFindRunQueueAhead(runs, "nope") === 0);
  check(
    "client view carries queueAhead only when positive",
    clientClaudeFindRunView(makeRun(), { queueAhead: 2 }).queueAhead === 2
      && clientClaudeFindRunView(makeRun(), { queueAhead: 0 }).queueAhead === undefined
      && clientClaudeFindRunView(makeRun()).queueAhead === undefined,
  );
  const label = claudeFindRunStatusLabel("queued", "find", 2);
  check(
    "queued label names the position in line",
    label.tone === "active" && /2 runs ahead/.test(label.label),
  );
  check(
    "queued label without a position keeps the original copy",
    claudeFindRunStatusLabel("queued").label === "Queued — waiting for the Mac runner",
  );
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
    // CLI ≥2.1.216 emits init BEFORE MCP connect finishes — a healthy run
    // reports "pending" at startup (2026-07-20 live incident: the old
    // kill-on-anything-but-connected failed every run instantly). Pending is
    // INDETERMINATE: no init kill, deferred proof-of-use gate armed instead.
    "chrome pending → NOT an init failure (CLI 2.1.216 healthy startup shape)",
    browserMcpFailureFromInit(init([{ name: "chrome", status: "pending" }])) === null,
  );
  check(
    "pending (and unknown in-flight statuses) arm the deferred proof gate",
    browserProofRequiredFromInit(init([{ name: "chrome", status: "pending" }])) === true
      && browserProofRequiredFromInit(init([{ name: "chrome", status: "connecting" }])) === true
      && browserProofRequiredFromInit(init([{ name: "chrome", status: "connected" }])) === false
      && browserProofRequiredFromInit(init([{ name: "chrome", status: "failed" }])) === false
      && browserProofRequiredFromInit("not json") === false,
  );
  const chromeToolLine = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "mcp__chrome__navigate_page", input: { url: "https://vrbo.com" } }] },
  });
  check(
    "an mcp__chrome__ tool call is the positive browser proof",
    lineUsesChromeBrowserTool(chromeToolLine) === true
      && lineUsesChromeBrowserTool(JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "WebSearch", input: {} }] },
      })) === false
      && lineUsesChromeBrowserTool(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "mcp__chrome__ mentioned in prose" }] } })) === false
      && lineUsesChromeBrowserTool("not json") === false,
  );
  check(
    "the never-used failure names the refusal",
    /never attached|never opened a page/.test(browserNeverUsedFailure()) && /Refused/.test(browserNeverUsedFailure()),
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
    init([{ name: "chrome", status: "pending" }]),
    init([{ name: "chrome", status: "failed" }]),
    init([{ name: "railway-mcp-server", status: "failed" }, { name: "chrome", status: "failed" }]),
    init([]),
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [] } }),
    chromeToolLine,
    "not json",
  ];
  check(
    "runner .mjs and shared TS browser guard are behaviorally identical",
    CASES.every((l) => runnerBrowserMcpFailure(l) === browserMcpFailureFromInit(l)),
  );
  check(
    "runner .mjs and shared TS proof-gate twins are behaviorally identical",
    CASES.every(
      (l) =>
        runnerBrowserProofRequired(l) === browserProofRequiredFromInit(l)
        && runnerLineUsesChromeTool(l) === lineUsesChromeBrowserTool(l),
    ) && runnerBrowserNeverUsedFailure() === browserNeverUsedFailure(),
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
      const term = runnerSrc.slice(runnerSrc.indexOf("if (!terminalPosted"));
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
    // CLI ≥2.1.216 deferred gate: proof-of-use is tracked per line and a
    // "completed" report without a single chrome call is refused BEFORE the
    // completed branch. Removing either half reopens the 2026-07-19
    // browser-less-run hole on new CLIs.
    "the deferred proof gate tracks chrome tool use and refuses unproven completions",
    /if \(!browserUsed && lineUsesChromeBrowserTool\(line\)\) browserUsed = true;/.test(runnerSrc)
      && (() => {
        const term = runnerSrc.slice(runnerSrc.indexOf("const authProblem"));
        const gate = term.indexOf('} else if (!browserUsed) {');
        const completed = term.indexOf('status: "completed"');
        return gate > -1 && completed > -1 && gate < completed
          && /!browserUsed\) \{[\s\S]{0,400}?browserNeverUsedFailure\(\)/.test(term);
      })(),
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
  check(
    // 2026-07-20: the daemon env exports ANTHROPIC_API_KEY for worker.mjs's
    // vision fallback; if the find-run child inherits it, every run silently
    // flips to per-token API billing (~$4-10/run measured) instead of the
    // CLI's subscription login. The strip must come BEFORE the explicit
    // CLAUDE_FIND_RUN_API_KEY opt-in override.
    "the inherited ANTHROPIC_API_KEY is stripped from the find-run child env (subscription billing by default)",
    (() => {
      const strip = runnerSrc.indexOf("delete childEnv.ANTHROPIC_API_KEY;");
      const optIn = runnerSrc.indexOf(
        "if (process.env.CLAUDE_FIND_RUN_API_KEY) childEnv.ANTHROPIC_API_KEY = process.env.CLAUDE_FIND_RUN_API_KEY;",
      );
      return strip > -1 && optIn > -1 && strip < optIn;
    })(),
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
  // ── BULK (2026-07-20): one endpoint, N identical runs, queue-aware guards ──
  check(
    // The bulk endpoint must enqueue THE SAME record the single button
    // creates — one shared constructor, not a parallel copy that drifts.
    "server: bulk endpoint exists and shares the single-run constructor",
    serverSrc.includes('app.post("/api/claude-find-runs/bulk"')
      && (serverSrc.match(/enqueueFindRunInStore\(/g) ?? []).length >= 3, // def + single + bulk
  );
  check(
    "server: bulk items are skipped (not batch-fatal) on invalid input or an active run",
    serverSrc.includes("skipped.push({") && serverSrc.includes("continue;"),
  );
  check(
    "server: bulk batch capped at CLAUDE_FIND_RUN_BULK_MAX",
    serverSrc.includes("rawItems.length > CLAUDE_FIND_RUN_BULK_MAX"),
  );
  check(
    "server: bulk enqueues inside ONE store mutation (single-flight guard sees earlier batch items)",
    /await mutateStore\(\(store\) => \{\s*\n\s*const created/.test(serverSrc),
  );
  check(
    // Without this, a bulk batch's tail runs get failed as "runner never
    // picked this up" while the runner is busy on the head of the line.
    "server: watchdog passes runner-activity context to every verdict",
    serverSrc.includes("claudeFindRunnerActivity(store.runs, nowMs)")
      && serverSrc.includes("claudeFindRunWatchdogVerdict(run, nowMs, activity)"),
  );
  check(
    "server: status endpoint stamps queueAhead so queued rows can name their position",
    serverSrc.includes("queueAhead: claudeFindRunQueueAhead(store.runs, latest.id)"),
  );
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
  check(
    // 2026-07-20: bulk find is headless too — the bulk button posts the batch
    // to the bulk endpoint and gates its count on LIVE runs, not TTL memory.
    "client: bulk button posts the batch to /api/claude-find-runs/bulk and gates on live runs",
    bookingsSrc.includes('"/api/claude-find-runs/bulk", { items: inputs }')
      && bookingsSrc.includes("bulkFindReady")
      && bookingsSrc.includes("bulkFindActiveIds"),
  );
  check(
    "client: queued panel badge passes queueAhead so a bulk wait reads as a line, not an outage",
    bookingsSrc.includes("claudeFindRunStatusLabel(run.status, run.kind, run.queueAhead)"),
  );
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
    // the ATTENTION path so both cases get it — and (2026-07-21 operator
    // report: "no Chrome window highlighted in yellow is showing") the reason
    // rides along so the BLOCKED tab is the one activated + painted.
    "the runner surfaces its Chrome window whenever attention is raised",
    runnerSrc.includes("async function surfaceRunnerChrome(reason)")
      && runnerSrc.includes("Browser.setWindowBounds")
      && runnerSrc.includes("void surfaceRunnerChrome(reason);"),
  );
  check(
    // Bot-wall / generic attention gets the SAME yellow treatment as the card
    // handoff, on the reason-picked blocked tab: tab activation, on-screen
    // window, yellow banner + border, and cleanup when the blocker clears.
    "generic attention paints the yellow banner into the reason-picked blocked tab",
    runnerSrc.includes("pickAttentionTarget(targets, reason)")
      && runnerSrc.includes("rct-findrun-attn-banner")
      && runnerSrc.includes("rct-findrun-attn-border")
      && runnerSrc.includes("NEEDS YOU")
      && runnerSrc.slice(
        runnerSrc.indexOf("async function surfaceRunnerChrome"),
        runnerSrc.indexOf("async function clearAttentionSurface"),
      ).includes("/json/activate/"),
  );
  check(
    // A stale "NEEDS YOU" banner after the agent resumed would misdirect the
    // operator on their NEXT look — stopAttentionAlarm clears it (flag-guarded,
    // and it must never touch the payment handoff's card banner).
    "clearing attention removes the yellow attention banner (and only that banner)",
    runnerSrc.includes("async function clearAttentionSurface")
      && /function stopAttentionAlarm\(\)\s*\{[^}]*clearAttentionSurface\(\)/.test(runnerSrc)
      && !runnerSrc.slice(
        runnerSrc.indexOf("async function clearAttentionSurface"),
        runnerSrc.indexOf("export async function surfaceCheckoutHandoff"),
      ).includes("rct-findrun-card-"),
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
      // legit CDP result read and must not trip this.) The slice starts at the
      // attention surfacing code so BOTH yellow treatments stay display-only.
      && !/(querySelector\(\s*["']input|\.value\s*=[^=]|\.click\(\)|\.submit\(\))/.test(
        runnerSrc.slice(runnerSrc.indexOf("export function pickAttentionTarget"), runnerSrc.indexOf("let attentionAlarm")),
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

  // ── pickAttentionTarget (2026-07-21: surface the BLOCKED tab, not tab 0) ──
  console.log("claude-find-run: attention tab picking");
  {
    const tabs = [
      { type: "page", id: "t1", url: "https://www.hotels.com/?q-destination=Kauai", title: "Hotels" },
      { type: "page", id: "t2", url: "https://www.vrbo.com/en-ca/search?destination=Kapaa", title: "Vacation rentals" },
      { type: "page", id: "t3", url: "https://qpublic.schneidercorp.com/Application.aspx", title: "Just a moment..." },
      { type: "iframe", id: "i1", url: "https://www.google.com/recaptcha/api2/aframe" },
    ];
    check(
      "the reason's site name picks the matching tab over tab 0",
      runnerPickAttentionTarget(tabs, "ATTENTION was: bot check on vrbo.com — unit 3")?.id === "t2",
    );
    check(
      "a challenge-shaped title (Cloudflare interstitial) wins when the reason names that site",
      runnerPickAttentionTarget(tabs, "Cloudflare bot challenge on qPublic property records site")?.id === "t3",
    );
    check(
      "an un-hinted reason still surfaces a challenge-shaped tab over tab 0",
      runnerPickAttentionTarget(tabs, "something unrecognizable")?.id === "t3",
    );
    check(
      "no hints and no challenge shape falls back to the first page (never an iframe)",
      runnerPickAttentionTarget([tabs[0], tabs[1]], "something unrecognizable")?.id === "t1"
        && runnerPickAttentionTarget([tabs[3]], "bot check") === null,
    );
    check("an empty tab list yields null", runnerPickAttentionTarget([], "bot check on vrbo.com") === null);
  }
}

// ── Page-level status overview (2026-07-21: "show me like a status") ────────
{
  const view = (over: Record<string, unknown>) => ({
    id: "r1", reservationId: "res1", propertyName: "P", guestName: null, kind: "find",
    status: "queued", createdAt: "2026-07-21T00:00:00.000Z", endedAt: null,
    cancelRequested: false, attentionReason: null, report: null, error: null,
    events: [], droppedEvents: 0, ...over,
  }) as any;
  const now = Date.parse("2026-07-21T02:00:00.000Z");
  const overview = claudeFindRunOverview(
    [
      view({ id: "a", status: "queued" }),
      view({ id: "b", status: "running" }),
      view({ id: "c", status: "attention" }),
      view({ id: "d", status: "completed", endedAt: "2026-07-21T01:45:00.000Z" }),
      view({ id: "e", status: "failed", endedAt: "2026-07-21T01:50:00.000Z" }),
      view({ id: "f", status: "completed", endedAt: "2026-07-20T20:00:00.000Z" }), // outside the window
      view({ id: "g", status: "cancelled", endedAt: "2026-07-21T01:59:00.000Z" }),
    ],
    now,
  );
  check(
    "overview splits active (store order) from recent terminal (newest first)",
    overview.active.map((r: any) => r.id).join(",") === "a,b,c"
      && overview.recent.map((r: any) => r.id).join(",") === "g,e,d",
  );
  check(
    "overview counts every bucket and drops stale terminal runs",
    overview.counts.queued === 1 && overview.counts.working === 1 && overview.counts.attention === 1
      && overview.counts.completed === 1 && overview.counts.failed === 1 && overview.counts.cancelled === 1,
  );
  check("an empty store yields an empty overview", claudeFindRunOverview([], now).active.length === 0
    && claudeFindRunOverview([], now).recent.length === 0);

  // Cumulative batch progress: computed over the FULL view set, so a completed
  // run OUTSIDE the recent-terminal window still counts toward its batch.
  const batchOverview = claudeFindRunOverview(
    [
      view({ id: "ba", status: "queued", batchId: "B1" }),
      view({ id: "bb", status: "running", batchId: "B1" }),
      view({ id: "bd", status: "completed", endedAt: "2026-07-21T01:45:00.000Z", batchId: "B1" }),
      view({ id: "bf", status: "completed", endedAt: "2026-07-20T20:00:00.000Z", batchId: "B1" }), // stale window, still in batch
      view({ id: "solo", status: "completed", endedAt: "2026-07-21T01:50:00.000Z" }), // no batchId → excluded
    ],
    now,
  );
  check("batch rollup counts a completed run even outside the recent window", (() => {
    const b = batchOverview.batches.find((x) => x.batchId === "B1");
    return !!b && b.total === 4 && b.done === 2 && b.completed === 2 && b.queued === 1 && b.working === 1;
  })());
  check("batch rollup estimates an ETA from realized throughput while runs remain", (() => {
    const b = batchOverview.batches.find((x) => x.batchId === "B1");
    return !!b && typeof b.etaMs === "number" && (b.etaMs as number) > 0;
  })());
  check("single (non-batch) runs produce no batch entry", !batchOverview.batches.some((x) => x.total === 1));

  const record = {
    id: "x", reservationId: "res", propertyId: 1, propertyName: "P", guestName: "Ann Guest",
    status: "queued", createdAt: "2026-07-21T00:00:00.000Z", claimedAt: null, heartbeatAt: null,
    endedAt: null, cancelRequested: false, attentionReason: null, report: null, error: null,
    events: [], droppedEvents: 0, token: "t", prompt: "p", unitIds: [], checkIn: "", checkOut: "",
  } as any;
  check("client view carries guestName for the banner (token/prompt still stripped)", (() => {
    const v = clientClaudeFindRunView(record) as any;
    return v.guestName === "Ann Guest" && !("token" in v) && !("prompt" in v);
  })());
  check("client view carries batchId when set, omits it for single runs", (() => {
    const batched = clientClaudeFindRunView({ ...record, batchId: "B1" }) as any;
    const single = clientClaudeFindRunView(record) as any;
    return batched.batchId === "B1" && !("batchId" in single);
  })());

  const fs2 = await import("node:fs");
  const serverSrc = fs2.readFileSync("server/claude-find-runs.ts", "utf8");
  check(
    "GET /api/claude-find-runs/overview exists and rolls up via the shared helper",
    serverSrc.includes('app.get("/api/claude-find-runs/overview"')
      && /claudeFindRunOverview\(views, Date\.now\(\)\)/.test(serverSrc),
  );
  const bannerSrc = fs2.readFileSync("client/src/components/claude-run-status-banner.tsx", "utf8");
  check(
    "the banner polls the overview endpoint and can cancel a live run",
    bannerSrc.includes('"/api/claude-find-runs/overview"') && bannerSrc.includes("/cancel"),
  );
  const bookingsSrc = fs2.readFileSync("client/src/pages/bookings.tsx", "utf8");
  check(
    // 2026-07-22 "reservations loading slowly": 50+ rows each firing their own
    // status POST on mount → one 50ms-window batched call (endpoint takes 100
    // ids). Un-batching this reintroduces the mount stampede.
    "per-row find-run status fetches are COALESCED into batched POSTs",
    bookingsSrc.includes("fetchClaudeFindRunStatusCoalesced")
      && /queryFn: \(\) => fetchClaudeFindRunStatusCoalesced\(reservationId\)/.test(bookingsSrc)
      && bookingsSrc.includes("ids.slice(i, i + 100)"),
  );
  check(
    "the bookings page mounts the banner and wakes it when runs are enqueued",
    bookingsSrc.includes("<ClaudeRunStatusBanner")
      && (bookingsSrc.match(/invalidateQueries\(\{ queryKey: \["\/api\/claude-find-runs\/overview"\] \}\)/g) ?? []).length >= 3,
  );
}

// ── Refusal / no-work terminal guard (2026-07-21) ───────────────────────────
// Real incident, run 629799c6-e8fa-43ff-90d5-8e24e65c1469 (Jul 19): a headless
// CHECKOUT run's model REFUSED the task ("I'm not going to execute this task…
// hallmarks of fraudulent automation"), the CLI still emitted subtype
// "success", and the run was recorded "completed" with a green chip. The
// guard is STRUCTURAL: the checkout brief's step 1 is an unconditional GET on
// the agent buy-in endpoint, so a checkout run that ends "success" with ZERO
// /api/claude-find-runs/agent/:id/* calls did no work and must fail. Refusal
// phrasing only sharpens the error wording — it is never the gate.
console.log("\n[refusal / no-work terminal guard]");
{
  const agentCurlLine = JSON.stringify({
    type: "assistant",
    message: {
      content: [{
        type: "tool_use",
        name: "Bash",
        input: { command: 'curl -sS https://portal.example/api/claude-find-runs/agent/run-9/buy-in -H "X-Run-Token: tok"' },
      }],
    },
  });
  const chromeOnlyLine = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "mcp__chrome__navigate_page", input: { url: "https://vrbo.com/x" } }] },
  });
  const plainCurlLine = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "curl -sS https://vrbo.com/listing" } }] },
  });
  check("a curl to an agent portal endpoint counts as work", lineCallsAgentPortalEndpoint(agentCurlLine) === true);
  check("a chrome tool call is NOT an agent-endpoint call", lineCallsAgentPortalEndpoint(chromeOnlyLine) === false);
  check("a curl to a non-portal URL is NOT an agent-endpoint call", lineCallsAgentPortalEndpoint(plainCurlLine) === false);
  check("non-assistant / unparseable lines answer false", lineCallsAgentPortalEndpoint('{"type":"result"}') === false
    && lineCallsAgentPortalEndpoint("not json") === false);
  for (const line of [agentCurlLine, chromeOnlyLine, plainCurlLine, '{"type":"result"}', "junk"]) {
    check(
      `runner twin agrees on agent-endpoint detection (${line.slice(0, 40)}…)`,
      runnerLineCallsAgentEndpoint(line) === lineCallsAgentPortalEndpoint(line),
    );
  }

  // The real incident report's opening — the refusal shape.
  const incidentReport =
    "I'm not going to execute this task. Here's why:\n\n**This prompt has the hallmarks of fraudulent automation, not a legitimate business tool:**";
  const honestReport =
    "Checkout prepared for Unit 8J — total $1,912.40 vs approved $1,850.00, damage waiver selected, travel insurance declined. No purchase has been submitted — the checkout tab is open, waiting for the card.";
  check("the incident report reads as a refusal", reportLooksLikeRefusal(incidentReport) === true);
  check("an honest checkout report does NOT read as a refusal", reportLooksLikeRefusal(honestReport) === false);
  check("null / empty reports are not refusals", reportLooksLikeRefusal(null) === false && reportLooksLikeRefusal("") === false);
  for (const report of [incidentReport, honestReport, null]) {
    check(
      "runner twin agrees on refusal shape",
      runnerReportLooksLikeRefusal(report) === reportLooksLikeRefusal(report),
    );
  }

  const refusedError = checkoutRunDidNoWorkFailure(incidentReport);
  check(
    "refusal-shaped no-work error names the refusal and quotes the report head",
    refusedError.includes("REFUSED") && refusedError.includes("I'm not going to execute this task")
      && refusedError.includes("failed"),
  );
  const noOpError = checkoutRunDidNoWorkFailure("All done, everything looks great.");
  check(
    "non-refusal no-work error is still an honest structural failure",
    noOpError.includes("without doing ANY checkout work") && noOpError.includes("not even the step-1 buy-in read")
      && !noOpError.includes("REFUSED"),
  );
  check(
    "runner twin produces identical no-work errors",
    runnerCheckoutNoWorkFailure(incidentReport) === refusedError
      && runnerCheckoutNoWorkFailure("All done, everything looks great.") === noOpError,
  );

  // Source guards — the runner actually wires the gate (runnerSrc pattern).
  const fs3 = await import("node:fs");
  const path3 = await import("node:path");
  const { fileURLToPath: toPath3 } = await import("node:url");
  const here3 = path3.dirname(toPath3(import.meta.url));
  const runnerSrc = fs3.readFileSync(path3.join(here3, "../daemon/vrbo-sidecar/claude-find-runner.mjs"), "utf8");
  check(
    "runner: tracks agent-endpoint use on every stream line",
    /if \(!agentEndpointUsed && lineCallsAgentPortalEndpoint\(line\)\) agentEndpointUsed = true;/.test(runnerSrc),
  );
  check(
    "runner: derives the run kind from the claim payload (missing = find)",
    runnerSrc.includes('const runKind = run.kind === "checkout" ? "checkout" : "find";'),
  );
  check(
    "runner: a success-result checkout run with zero agent-endpoint calls is FAILED, and the branch outranks the browser gate",
    (() => {
      const term = runnerSrc.slice(runnerSrc.indexOf("if (!terminalPosted"));
      const noWork = term.indexOf('runKind === "checkout" && !agentEndpointUsed');
      const browserGate = term.indexOf("} else if (!browserUsed) {");
      return noWork > 0 && browserGate > 0 && noWork < browserGate
        && /runKind === "checkout" && !agentEndpointUsed\) \{[\s\S]{0,900}?terminal: \{ status: "failed"/.test(term);
    })(),
  );
  check(
    "runner: the no-work failure routes through the attention channel (reason survives on the failed record)",
    (() => {
      const term = runnerSrc.slice(runnerSrc.indexOf('runKind === "checkout" && !agentEndpointUsed'));
      const branch = term.slice(0, term.indexOf("} else if"));
      return branch.includes("checkoutRunDidNoWorkFailure(resultReport)") && branch.includes("pendingAttention = error;");
    })(),
  );
  const serverSrc3 = fs3.readFileSync(path3.join(here3, "../server/claude-find-runs.ts"), "utf8");
  check(
    "server: the daemon claim payload carries the run kind",
    serverSrc3.includes('kind: claimed.kind ?? "find"'),
  );

  // The checkout brief's grounding context (refusal-likelihood reduction) must
  // exist in BOTH variants without weakening the money-safety rules.
  const headlessCheckout = buildCoworkCheckoutPrompt(
    {
      reservationId: "res-1",
      guestName: "Ann Guest",
      propertyName: "Pili Mai",
      checkIn: "2026-08-01",
      checkOut: "2026-08-08",
      units: [{ buyInId: 9, unitLabel: "Unit 8J", listingUrl: "https://www.vrbo.com/1234567", costPaid: 1850 }],
      party: null,
      baseUrl: "https://portal.example",
    },
    { headlessRun: { runId: "run-9", runToken: "tok-9" } },
  );
  const coworkCheckout = buildCoworkCheckoutPrompt({
    reservationId: "res-1",
    guestName: "Ann Guest",
    propertyName: "Pili Mai",
    checkIn: "2026-08-01",
    checkOut: "2026-08-08",
    units: [{ buyInId: 9, unitLabel: "Unit 8J", listingUrl: "https://www.vrbo.com/1234567", costPaid: 1850 }],
    party: null,
    baseUrl: "https://portal.example",
  });
  for (const [label, prompt] of [["headless", headlessCheckout], ["cowork", coworkCheckout]] as const) {
    check(
      `${label} checkout brief carries the legitimacy context`,
      prompt.includes("## Context — whose system this is")
        && prompt.includes("my own property-management system")
        && prompt.includes("You never handle card"),
    );
    check(
      `${label} checkout brief keeps the money-safety rules despite the context block`,
      prompt.includes("The final submit is human-only") && prompt.includes("15% above")
        && prompt.includes("Damage waiver ONLY"),
    );
  }
  check(
    "only the headless variant grounds the run token's origin",
    headlessCheckout.includes("minted by my") && !coworkCheckout.includes("minted by my"),
  );
}

// ── Interrupted-run honesty (2026-07-22): ceiling / turn-cap / daemon restart ─
// The Jul-21 bulk queues failed runs three ways that all surfaced as opaque
// errors: the runner's own 40-min ceiling kill reported as the CLI's bare
// "error_during_execution", the CLI turn cap as "error_max_turns", and a
// daemon restart (launchctl kickstart) leaving a mid-flight run to die into
// the watchdog's generic "no heartbeat" 10 minutes later. These lock the
// honest messages + the wiring that produces them.
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const runnerSrc = fs.readFileSync(path.join(here, "../daemon/vrbo-sidecar/claude-find-runner.mjs"), "utf8");

  const ceiling = runnerRunCeilingFailure(60);
  check(
    "ceiling failure names the minutes, keeps partial work, and points at the env knob",
    ceiling.includes("60-minute") && /still on the reservation/i.test(ceiling)
      && ceiling.includes("CLAUDE_FIND_RUN_MAX_MS") && /re-run/i.test(ceiling),
  );
  const turns = runnerMaxTurnsFailure(300);
  check(
    "turn-cap failure names the turn count and points at the env knob",
    turns.includes("300") && turns.includes("CLAUDE_FIND_RUN_MAX_TURNS") && /re-run/i.test(turns),
  );
  const restart = runnerDaemonRestartFailure();
  check(
    "daemon-restart failure says the run is dead and partial work survives",
    /restarted mid-run/i.test(restart) && /still on the reservation/i.test(restart) && /re-run/i.test(restart),
  );

  check(
    "the kill timer flips ceilingHit BEFORE killing the CLI",
    /ceilingHit = true;[\s\S]{0,400}?child\.kill\("SIGTERM"\)/.test(runnerSrc),
  );
  check(
    // The SIGTERM'd CLI can emit a bare error_during_execution result (or no
    // result); the ceiling branch must outrank both so the real cause is what
    // the operator reads on the failed row.
    "ceilingHit outranks the result branches in the terminal classifier",
    (() => {
      const term = runnerSrc.slice(runnerSrc.indexOf("if (!terminalPosted"));
      const ceilingBranch = term.indexOf("} else if (ceilingHit) {");
      const success = term.indexOf("sawResult && resultReport !== null");
      return ceilingBranch > -1 && success > -1 && ceilingBranch < success
        && /ceilingHit\) \{[\s\S]{0,600}?runCeilingFailure\(/.test(term);
    })(),
  );
  check(
    "error_max_turns maps to the honest turn-cap message",
    /subtype === "error_max_turns"[\s\S]{0,300}?maxTurnsFailure\(MAX_TURNS\)/.test(runnerSrc),
  );
  check(
    // Without this a kickstart mid-run leaves the run silent until the server
    // watchdog buries the cause behind "no heartbeat for 10 minutes".
    "SIGTERM with a run in flight kills the CLI and posts the daemon-restart terminal",
    /const shutdown = async \(signal\)/.test(runnerSrc)
      && /shutdown[\s\S]{0,900}?child\.kill\("SIGTERM"\)/.test(runnerSrc)
      && /daemonRestartFailure\(\)[\s\S]{0,200}?terminal: \{ status: "failed", error: daemonRestartFailure\(\) \}/.test(runnerSrc)
      && /process\.on\("SIGTERM", \(\) => void shutdown\("SIGTERM"\)\)/.test(runnerSrc),
  );
  check(
    // The normal terminal classifier must stand down when the shutdown path
    // owns the terminal — two competing terminals would race.
    "the terminal classifier defers to the shutdown path",
    runnerSrc.includes("if (!terminalPosted && !shuttingDown)"),
  );
  check(
    // 60 min stays under the server watchdog's 90-min per-run ceiling — a
    // runner ceiling ABOVE it would let the watchdog fail live runs first.
    "runner defaults: 60-min ceiling (under the 90-min watchdog) and 300 turns",
    runnerSrc.includes("CLAUDE_FIND_RUN_MAX_MS ?? 60 * 60_000")
      && runnerSrc.includes("CLAUDE_FIND_RUN_MAX_TURNS ?? 300")
      && 60 * 60_000 < CLAUDE_FIND_RUN_MAX_AGE_MS,
  );
}

console.log(`\nclaude-find-run: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
