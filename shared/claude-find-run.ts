// Headless Claude find-run — pure, browser-safe logic for the zero-click
// buy-in search runner (operator directive 2026-07-19: "Build this all out").
//
// WHAT THIS IS: the same find-and-attach brief the "Auto Cowork · find
// cheapest" button pushes into Claude Desktop, executed instead by a headless
// `claude -p` session spawned on the operator's Mac by the sidecar daemon —
// no Cowork window, no send press. The portal button enqueues a RUN; the
// daemon's runner child claims it, spawns the CLI with a locked-down tool
// allowlist, relays the session's progress as display events, and posts the
// terminal report. The operator watches it all on the bookings row.
//
// LOAD-BEARING BOUNDARIES (see AGENTS.md "Headless Claude find-runs"):
// - TWO KINDS since 2026-07-20 (operator: the per-unit checkout buttons must
//   "execute cowork automatically" like the find button): kind "find" ends at
//   ATTACH; kind "checkout" runs the checkout-PREPARATION brief for exactly ONE
//   pinned buy-in and ends at the awaiting_payment handoff. The MONEY approval
//   moved, it did not disappear: the run never touches card fields and never
//   clicks the final purchase control — the human still enters the card and
//   makes the Checkout click in the prepared tab, then records the result via
//   the row's "Paid — mark booked" control. (This REPLACES the original
//   "FIND-ONLY, never wire the runner to the checkout brief" rule, whose money
//   gate was the Cowork send press; the gate is now the card itself.)
// - The agent NEVER holds the portal admin secret. It authenticates its portal
//   calls with a RUN-SCOPED token minted per run, accepted only by the
//   /api/claude-find-runs/agent/:id/* endpoints, only while the run is live.
//   Checkout runs get their own proxies with reservationId AND buyInId pinned
//   from the run record — the agent's body can never retarget them.
// - `token` and `prompt` never leave the server except to the daemon (claim)
//   and the brief itself; clientClaudeFindRunView strips both, and event text
//   is scrubbed of the token before it is ever persisted or displayed.
//
// Everything in this file is pure (no I/O) so tests need no DATABASE_URL.

export type ClaudeFindRunStatus =
  | "queued" // created by the portal, waiting for the Mac runner to claim it
  | "claimed" // the daemon runner accepted it and is spawning the CLI
  | "running" // stream events are flowing
  | "attention" // the agent hit a bot wall / blocker and is waiting for the operator
  | "completed"
  | "failed"
  | "cancelled";

export const ACTIVE_CLAUDE_FIND_RUN_STATUSES: ReadonlySet<ClaudeFindRunStatus> = new Set<ClaudeFindRunStatus>([
  "queued",
  "claimed",
  "running",
  "attention",
]);

export type ClaudeFindRunEventKind =
  | "status" // lifecycle marker (runner started, model, terminal notes)
  | "note" // the agent's own narration text
  | "action" // a tool call, rendered tersely ("opening vrbo.com/…")
  | "attention" // needs the operator (bot wall etc.)
  | "error";

export interface ClaudeFindRunEvent {
  /** ISO timestamp (stamped by whoever minted the event). */
  at: string;
  kind: ClaudeFindRunEventKind;
  text: string;
}

export type ClaudeFindRunKind = "find" | "checkout";

export interface ClaudeFindRunRecord {
  id: string;
  reservationId: string;
  propertyId: number;
  propertyName: string;
  guestName: string | null;
  /** Absent on pre-2026-07-20 records — treat missing as "find". */
  kind?: ClaudeFindRunKind;
  /** Checkout runs only: the ONE buy-in this run may prepare (proxy-pinned). */
  buyInId?: number | null;
  status: ClaudeFindRunStatus;
  createdAt: string;
  claimedAt: string | null;
  heartbeatAt: string | null;
  endedAt: string | null;
  /** Operator asked to stop; the runner kills the CLI on its next flush. */
  cancelRequested: boolean;
  attentionReason: string | null;
  /** The agent's final report (its last message), token-scrubbed. */
  report: string | null;
  error: string | null;
  events: ClaudeFindRunEvent[];
  /** Events dropped by the bounded ring — honesty counter for the UI. */
  droppedEvents: number;
  /** Run-scoped secret — NEVER in client payloads (clientClaudeFindRunView). */
  token: string;
  /** The full headless brief — daemon-only, never in client payloads. */
  prompt: string;
  /** Slot unitIds the agent proxy may create buy-ins for. */
  unitIds: string[];
  checkIn: string;
  checkOut: string;
}

export interface ClaudeFindRunStore {
  version: 1;
  runs: ClaudeFindRunRecord[];
}

export const CLAUDE_FIND_RUN_STORE_KEY = "claude_find_runs.v1";
/** Newest runs kept in the store (terminal history for the row panels). */
export const CLAUDE_FIND_RUN_STORE_CAP = 40;
/** Terminal runs older than this are evicted at write time. */
export const CLAUDE_FIND_RUN_TERMINAL_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
/** Bounded per-run event ring. */
export const CLAUDE_FIND_RUN_EVENT_CAP = 250;
/** Events served to the client per run (newest). */
export const CLAUDE_FIND_RUN_CLIENT_EVENTS = 60;
/** queued with no daemon claim for this long → the Mac runner is offline. */
export const CLAUDE_FIND_RUN_CLAIM_TIMEOUT_MS = 5 * 60 * 1_000;
/** claimed/running with no heartbeat for this long → runner went silent. */
export const CLAUDE_FIND_RUN_HEARTBEAT_TIMEOUT_MS = 10 * 60 * 1_000;
/** Absolute ceiling on any non-terminal run, measured from when it STARTED
 *  (claimedAt) — queue-wait time is governed by the queue ceiling below. */
export const CLAUDE_FIND_RUN_MAX_AGE_MS = 90 * 60 * 1_000;
/**
 * Absolute ceiling on QUEUE WAIT (2026-07-20, bulk). The runner is sequential
 * — one run at a time by construction — so a bulk batch legitimately leaves
 * runs queued for hours while the line drains. 12h = the bulk cap (8) times
 * the per-run ceiling (90 min): the longest any honest queue can take. A run
 * still queued past that is stuck behind a wedged store, never a live line.
 */
export const CLAUDE_FIND_RUN_QUEUE_MAX_AGE_MS = 12 * 60 * 60 * 1_000;
/**
 * Most runs one bulk click may enqueue. Matches COWORK_BULK_FIND_MAX so the
 * batch size the operator approved for the Cowork bulk route carries over,
 * and so cap × per-run ceiling stays inside the queue ceiling above — raise
 * one and you must re-derive the other.
 */
export const CLAUDE_FIND_RUN_BULK_MAX = 8;

export function parseClaudeFindRunStore(raw: string | null | undefined): ClaudeFindRunStore {
  if (!raw) return { version: 1, runs: [] };
  try {
    const parsed = JSON.parse(raw) as ClaudeFindRunStore;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.runs)) return { version: 1, runs: [] };
    return { version: 1, runs: parsed.runs.filter((r) => r && typeof r.id === "string") };
  } catch {
    return { version: 1, runs: [] };
  }
}

export function serializeClaudeFindRunStore(store: ClaudeFindRunStore, nowMs: number): string {
  const isTerminal = (r: ClaudeFindRunRecord) => !ACTIVE_CLAUDE_FIND_RUN_STATUSES.has(r.status);
  const kept = store.runs
    .filter((r) => {
      if (!isTerminal(r)) return true;
      const ended = Date.parse(r.endedAt ?? r.createdAt);
      return !Number.isFinite(ended) || nowMs - ended < CLAUDE_FIND_RUN_TERMINAL_TTL_MS;
    })
    .slice(-CLAUDE_FIND_RUN_STORE_CAP);
  return JSON.stringify({ version: 1, runs: kept });
}

/** One live run per reservation — the single-flight guard. */
export function activeClaudeFindRunForReservation(
  runs: ClaudeFindRunRecord[],
  reservationId: string,
): ClaudeFindRunRecord | null {
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    if (run.reservationId === reservationId && ACTIVE_CLAUDE_FIND_RUN_STATUSES.has(run.status)) return run;
  }
  return null;
}

/** Latest run (any status) for a reservation — what the row panel renders. */
export function latestClaudeFindRunForReservation(
  runs: ClaudeFindRunRecord[],
  reservationId: string,
): ClaudeFindRunRecord | null {
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].reservationId === reservationId) return runs[i];
  }
  return null;
}

/** Oldest queued run — what the daemon claims. Mutates the run in place. */
export function claimNextClaudeFindRun(runs: ClaudeFindRunRecord[], nowIso: string): ClaudeFindRunRecord | null {
  const next = runs.find((r) => r.status === "queued" && !r.cancelRequested);
  if (!next) return null;
  next.status = "claimed";
  next.claimedAt = nowIso;
  next.heartbeatAt = nowIso;
  return next;
}

/** Append events into the bounded ring, counting drops honestly. */
export function appendClaudeFindRunEvents(run: ClaudeFindRunRecord, events: ClaudeFindRunEvent[]): void {
  if (!events.length) return;
  run.events.push(...events);
  const over = run.events.length - CLAUDE_FIND_RUN_EVENT_CAP;
  if (over > 0) {
    run.events.splice(0, over);
    run.droppedEvents += over;
  }
}

export interface ClaudeFindRunUpdate {
  events?: ClaudeFindRunEvent[];
  heartbeat?: boolean;
  /** Non-empty string raises attention; null clears it back to running. */
  attention?: string | null;
  terminal?: {
    status: "completed" | "failed";
    report?: string | null;
    error?: string | null;
  };
}

/**
 * Apply a runner flush to the record. Terminal states are sticky: a late
 * flush from a killed runner can never resurrect a cancelled/failed run.
 * Returns false when the run is already terminal (the runner should stop).
 */
export function applyClaudeFindRunUpdate(
  run: ClaudeFindRunRecord,
  update: ClaudeFindRunUpdate,
  nowIso: string,
): boolean {
  if (!ACTIVE_CLAUDE_FIND_RUN_STATUSES.has(run.status)) return false;
  if (update.events?.length) appendClaudeFindRunEvents(run, update.events);
  if (update.heartbeat || update.events?.length) run.heartbeatAt = nowIso;
  if (run.status === "claimed" && (update.events?.length || update.heartbeat)) run.status = "running";
  if (typeof update.attention === "string" && update.attention.trim()) {
    run.status = "attention";
    run.attentionReason = update.attention.trim().slice(0, 500);
  } else if (update.attention === null && run.status === "attention") {
    run.status = "running";
    run.attentionReason = null;
  }
  if (update.terminal) {
    run.status = update.terminal.status;
    run.report = update.terminal.report ?? run.report;
    run.error = update.terminal.error ?? null;
    run.endedAt = nowIso;
    run.attentionReason = update.terminal.status === "failed" ? run.attentionReason : null;
  }
  return true;
}

export interface ClaudeFindRunWatchdogVerdict {
  action: "none" | "fail";
  error?: string;
}

/**
 * Evidence that the Mac runner exists and is working, derived from the store
 * itself (the runner has no other registration). Used by the watchdog so a
 * bulk batch's queued runs aren't declared "runner offline" while the runner
 * is demonstrably busy on the run ahead of them.
 */
export interface ClaudeFindRunnerActivity {
  /** A run is claimed/running/attention RIGHT NOW with a live heartbeat. */
  busy: boolean;
  /** Newest proof of the runner doing anything (claim / heartbeat / finish). */
  lastActivityMs: number | null;
}

export function claudeFindRunnerActivity(runs: ClaudeFindRunRecord[], nowMs: number): ClaudeFindRunnerActivity {
  let busy = false;
  let last: number | null = null;
  for (const run of runs) {
    for (const stamp of [run.claimedAt, run.heartbeatAt, run.endedAt]) {
      const ms = stamp ? Date.parse(stamp) : NaN;
      if (Number.isFinite(ms) && (last === null || ms > last)) last = ms;
    }
    if (["claimed", "running", "attention"].includes(run.status)) {
      const beat = Date.parse(run.heartbeatAt ?? run.claimedAt ?? run.createdAt);
      if (Number.isFinite(beat) && nowMs - beat <= CLAUDE_FIND_RUN_HEARTBEAT_TIMEOUT_MS) busy = true;
    }
  }
  return { busy, lastActivityMs: last };
}

/**
 * Server-side watchdog for orphaned runs. Honest failure messages — each names
 * what actually went wrong so the operator knows whether to check the Mac.
 *
 * QUEUE SEMANTICS (2026-07-20, bulk): the runner works ONE run at a time, so a
 * bulk batch legitimately parks runs in "queued" for hours. A queued run is
 * only "the Mac runner never picked this up" when the runner is genuinely
 * absent: not busy on another run, and no runner activity (claim / heartbeat /
 * finish, anywhere in the store) within the claim window either — the activity
 * basis is what stops the head-of-line run finishing at minute 40 from
 * instantly expiring every run behind it (their createdAt-based windows all
 * lapsed while they waited in line, honestly). Called without the activity
 * context it behaves exactly as the single-run original.
 */
export function claudeFindRunWatchdogVerdict(
  run: ClaudeFindRunRecord,
  nowMs: number,
  activity?: ClaudeFindRunnerActivity,
): ClaudeFindRunWatchdogVerdict {
  if (!ACTIVE_CLAUDE_FIND_RUN_STATUSES.has(run.status)) return { action: "none" };
  const created = Date.parse(run.createdAt);
  if (run.status === "queued") {
    if (Number.isFinite(created) && nowMs - created > CLAUDE_FIND_RUN_QUEUE_MAX_AGE_MS) {
      return {
        action: "fail",
        error: "Waited in line for 12 hours without starting — closed by the watchdog. Re-run it if it is still wanted.",
      };
    }
    // Waiting in line behind a live run is the bulk queue working as designed.
    if (activity?.busy) return { action: "none" };
    const basis = Math.max(
      Number.isFinite(created) ? created : 0,
      activity?.lastActivityMs ?? 0,
    );
    if (basis > 0 && nowMs - basis > CLAUDE_FIND_RUN_CLAIM_TIMEOUT_MS) {
      return {
        action: "fail",
        error:
          "The Mac runner never picked this up — is the Mac awake and the sidecar daemon running? (launchctl kickstart -k gui/$(id -u)/com.vrbosidecar.worker)",
      };
    }
    return { action: "none" };
  }
  // Running ceiling measures from when the run STARTED — a bulk run that
  // waited 3 hours in line still gets its full 90 minutes of work.
  const started = Date.parse(run.claimedAt ?? run.createdAt);
  if (Number.isFinite(started) && nowMs - started > CLAUDE_FIND_RUN_MAX_AGE_MS) {
    return { action: "fail", error: "Run exceeded the 90-minute ceiling and was closed by the watchdog." };
  }
  const beat = Date.parse(run.heartbeatAt ?? run.claimedAt ?? run.createdAt);
  if (Number.isFinite(beat) && nowMs - beat > CLAUDE_FIND_RUN_HEARTBEAT_TIMEOUT_MS) {
    return {
      action: "fail",
      error: "The runner went silent mid-run (no heartbeat for 10 minutes) — check the Mac's sidecar log.",
    };
  }
  return { action: "none" };
}

/**
 * How many live runs stand between a QUEUED run and the runner. Store order is
 * append order = claim order (claimNextClaudeFindRun takes the first queued),
 * so position = every active run earlier in the array plus the one being
 * worked. Non-queued or unknown runs answer 0.
 */
export function claudeFindRunQueueAhead(runs: ClaudeFindRunRecord[], runId: string): number {
  const at = runs.findIndex((r) => r.id === runId);
  if (at < 0 || runs[at].status !== "queued" || runs[at].cancelRequested) return 0;
  let ahead = 0;
  for (let i = 0; i < runs.length; i++) {
    if (i === at) continue;
    const other = runs[i];
    if (!ACTIVE_CLAUDE_FIND_RUN_STATUSES.has(other.status)) continue;
    if (other.status === "queued" && other.cancelRequested) continue;
    // A claimed/running/attention run is being worked NOW — ahead regardless
    // of where the ring buffer holds it. Queued runs are ahead only if older.
    if (other.status !== "queued" || i < at) ahead++;
  }
  return ahead;
}

/** What the bookings client sees — token + prompt STRIPPED, events truncated. */
export interface ClaudeFindRunClientView {
  id: string;
  reservationId: string;
  propertyName: string;
  guestName: string | null;
  kind: ClaudeFindRunKind;
  status: ClaudeFindRunStatus;
  createdAt: string;
  endedAt: string | null;
  cancelRequested: boolean;
  attentionReason: string | null;
  report: string | null;
  error: string | null;
  events: ClaudeFindRunEvent[];
  droppedEvents: number;
  /** Queued runs only: live runs ahead of it in the one-at-a-time line. */
  queueAhead?: number;
}

/**
 * A prior run for the same reservation, shown as a collapsed "earlier run" row
 * so each session is visible and separate — WITHOUT the event/report payload
 * (the status endpoint fans out across every visible booking; a full history
 * per row would bloat it). id/status/timing are enough to distinguish sessions.
 */
export interface ClaudeFindRunHistoryEntry {
  id: string;
  kind: ClaudeFindRunKind;
  status: ClaudeFindRunStatus;
  createdAt: string;
  endedAt: string | null;
}

/** Newest-first prior runs for a reservation, excluding the latest (which the
 *  status view carries in full). Capped so the payload stays small. */
export function claudeFindRunHistoryForReservation(
  runs: ClaudeFindRunRecord[],
  reservationId: string,
  limit = 8,
): ClaudeFindRunHistoryEntry[] {
  const mine = runs
    .filter((r) => r.reservationId === reservationId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  // mine[0] is the latest — the status view already carries it in full.
  return mine.slice(1, 1 + limit).map((r) => ({
    id: r.id,
    kind: r.kind ?? "find",
    status: r.status,
    createdAt: r.createdAt,
    endedAt: r.endedAt,
  }));
}

export function clientClaudeFindRunView(
  run: ClaudeFindRunRecord,
  opts?: { queueAhead?: number },
): ClaudeFindRunClientView {
  return {
    ...(typeof opts?.queueAhead === "number" && opts.queueAhead > 0 ? { queueAhead: opts.queueAhead } : {}),
    id: run.id,
    reservationId: run.reservationId,
    propertyName: run.propertyName,
    guestName: run.guestName ?? null,
    kind: run.kind ?? "find",
    status: run.status,
    createdAt: run.createdAt,
    endedAt: run.endedAt,
    cancelRequested: run.cancelRequested,
    attentionReason: run.attentionReason,
    report: run.report,
    error: run.error,
    events: run.events.slice(-CLAUDE_FIND_RUN_CLIENT_EVENTS),
    droppedEvents: run.droppedEvents + Math.max(0, run.events.length - CLAUDE_FIND_RUN_CLIENT_EVENTS),
  };
}

/** Terminal runs stay on the page-level status banner this long after ending. */
export const CLAUDE_FIND_RUN_OVERVIEW_RECENT_MS = 60 * 60 * 1_000;

export interface ClaudeFindRunOverview {
  /** Live runs in queue order (the runner drains the store front-to-back). */
  active: ClaudeFindRunClientView[];
  /** Terminal runs that ended within the recent window, newest first. */
  recent: ClaudeFindRunClientView[];
  counts: {
    queued: number;
    /** claimed + running — "the runner is on it". */
    working: number;
    attention: number;
    completed: number;
    failed: number;
    cancelled: number;
  };
}

/**
 * Page-level roll-up for the All Reservations status banner (operator ask
 * 2026-07-21: "when I do a bulk run I need the UI on the all reservations
 * page to show me like a status"). Pure over already-stripped client views so
 * the server route and tests share it. Active runs keep STORE ORDER — that is
 * the sequential runner's actual drain order, so "position in line" reads
 * true; terminal runs outside the recent window drop off the banner (the
 * per-row panels remain their durable home).
 */
export function claudeFindRunOverview(views: ClaudeFindRunClientView[], nowMs: number): ClaudeFindRunOverview {
  const active: ClaudeFindRunClientView[] = [];
  const recent: ClaudeFindRunClientView[] = [];
  const counts = { queued: 0, working: 0, attention: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const view of views ?? []) {
    if (!view) continue;
    if (ACTIVE_CLAUDE_FIND_RUN_STATUSES.has(view.status)) {
      active.push(view);
      if (view.status === "queued") counts.queued += 1;
      else if (view.status === "attention") counts.attention += 1;
      else counts.working += 1;
      continue;
    }
    const ended = Date.parse(view.endedAt ?? view.createdAt);
    if (Number.isFinite(ended) && nowMs - ended <= CLAUDE_FIND_RUN_OVERVIEW_RECENT_MS) {
      recent.push(view);
      if (view.status === "completed") counts.completed += 1;
      else if (view.status === "failed") counts.failed += 1;
      else if (view.status === "cancelled") counts.cancelled += 1;
    }
  }
  recent.sort((a, b) => String(b.endedAt ?? b.createdAt).localeCompare(String(a.endedAt ?? a.createdAt)));
  return { active, recent, counts };
}

/**
 * The run token rides inside the brief, so the agent may echo it in its own
 * narration. Scrub it from every event/report string BEFORE persistence —
 * the client payload must never be one echo away from the attach capability.
 */
export function scrubClaudeFindRunToken(text: string, token: string): string {
  if (!token || !text) return text;
  return text.split(token).join("[run-token]");
}

/** Marker the brief tells the agent to print when it needs the operator. */
export const CLAUDE_FIND_RUN_ATTENTION_MARKER = "ATTENTION:";
/** Marker the brief tells the agent to print when a blocker is cleared. */
export const CLAUDE_FIND_RUN_RESUMED_MARKER = "RESUMED:";

export interface ClaudeFindRunMarkerScan {
  /** Last unresolved ATTENTION reason in the text, if any. */
  attention: string | null;
  /** True when a RESUMED marker follows the last ATTENTION. */
  resumed: boolean;
}

export function scanClaudeFindRunMarkers(text: string): ClaudeFindRunMarkerScan {
  let attention: string | null = null;
  let resumed = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith(CLAUDE_FIND_RUN_ATTENTION_MARKER)) {
      attention = line.slice(CLAUDE_FIND_RUN_ATTENTION_MARKER.length).trim() || "The agent is blocked and waiting.";
      resumed = false;
    } else if (line.startsWith(CLAUDE_FIND_RUN_RESUMED_MARKER)) {
      resumed = true;
    }
  }
  return { attention: resumed ? null : attention, resumed };
}

/**
 * Map one `claude -p --output-format stream-json` line to a display event.
 * Returns null for stream noise the operator doesn't need. The wrapper feeds
 * every stdout line through this; unparseable lines are dropped (the raw
 * transcript on the Mac keeps everything).
 */
/**
 * Did the run come up WITHOUT its browser?
 *
 * The CLI's `system/init` line reports every MCP server it started. If
 * chrome-devtools-mcp isn't `connected`, the agent cannot open a listing, read
 * a calendar, or look at photos — and it does NOT stop. On a real run
 * (2026-07-19) it announced "ATTENTION: browser tools missing … I will …
 * attach the best-qualified listings I can verify" and carried on toward
 * attaching units it had never looked at. A browser-less find-run is not a
 * degraded run, it is the wrong run, so this returns the operator-facing
 * error that ends it.
 *
 * Returns null for any non-init line and for a healthy init.
 *
 * SCOPE (verified against the real CLI, 2026-07-19): "connected" means the MCP
 * PROCESS started and handshook — not that Chrome is reachable. Pointing the
 * config at a dead port still reports "connected". That is fine: a reachable-
 * but-broken browser makes every mcp__chrome CALL fail loudly, which the agent
 * and the operator both see. This guard covers the silent case — the tools
 * never existing at all.
 *
 * CLI ≥2.1.216 (2026-07-20 incident): the init line is now emitted BEFORE MCP
 * servers finish connecting, so a healthy run reports chrome "pending" at
 * startup — the old any-status-but-connected kill produced an instant false
 * "Browser did not attach" on every run. "pending" (and any other unknown
 * in-flight status) is therefore INDETERMINATE, not fatal: the runner arms
 * the deferred proof-of-use gate instead (browserProofRequiredFromInit +
 * lineUsesChromeBrowserTool) and a completed report that never called a
 * single mcp__chrome tool is refused with browserNeverUsedFailure(). Only an
 * explicit "failed" status or a missing chrome entry still kills at init.
 *
 * TWIN of browserMcpFailure() in daemon/vrbo-sidecar/claude-find-runner.mjs —
 * the daemon is plain node and cannot import TS. Equivalence-locked in
 * tests/claude-find-run.test.ts; change both together.
 */
export function browserMcpFailureFromInit(rawLine: string): string | null {
  let parsed: any;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.type !== "system" || parsed.subtype !== "init") return null;
  const servers = Array.isArray(parsed.mcp_servers) ? parsed.mcp_servers : [];
  const chrome = servers.find((s: any) => s && s.name === "chrome");
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

/**
 * True when the init line reports chrome in an in-flight (non-"connected",
 * non-"failed") state — CLI ≥2.1.216 emits init before MCP connect finishes,
 * so "pending" is the NORMAL healthy startup shape there. The runner must not
 * kill on it; it arms the deferred proof-of-use gate instead. Non-init lines
 * return false.
 */
export function browserProofRequiredFromInit(rawLine: string): boolean {
  let parsed: any;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  if (parsed.type !== "system" || parsed.subtype !== "init") return false;
  const servers = Array.isArray(parsed.mcp_servers) ? parsed.mcp_servers : [];
  const chrome = servers.find((s: any) => s && s.name === "chrome");
  return Boolean(chrome) && chrome.status !== "connected" && chrome.status !== "failed";
}

/**
 * True when a stream line shows the agent actually CALLING a chrome browser
 * tool — the positive proof that the browser attached. Assistant messages
 * carry tool_use blocks whose names are prefixed "mcp__chrome__".
 */
export function lineUsesChromeBrowserTool(rawLine: string): boolean {
  let parsed: any;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || parsed.type !== "assistant") return false;
  const content = parsed.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (b: any) => b && b.type === "tool_use" && typeof b.name === "string" && b.name.startsWith("mcp__chrome__"),
  );
}

/**
 * Terminal error for a run whose report arrived with ZERO chrome tool calls —
 * the deferred twin of browserMcpFailureFromInit for the CLI-2.1.216 "pending"
 * init shape. A find that never opened the browser is the 2026-07-19
 * wrong-run class regardless of what the init line claimed.
 */
export function browserNeverUsedFailure(): string {
  return (
    "The run finished without ever using its browser — chrome-devtools-mcp "
    + "never attached (or the agent never opened a page), so nothing it "
    + "reported was verified against a live listing. Refused rather than "
    + "record unverified findings. Re-run it; if this repeats, check that the "
    + "dedicated Chrome is up and that chrome-devtools-mcp is installed."
  );
}

export function classifyClaudeStreamLine(rawLine: string, nowIso: string): ClaudeFindRunEvent | null {
  let parsed: any;
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
        const text = block.text.trim().replace(/\s+/g, " ").slice(0, 400);
        return { at: nowIso, kind: "note", text };
      }
      if (block?.type === "tool_use") {
        return { at: nowIso, kind: "action", text: describeClaudeToolUse(block.name, block.input) };
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

function describeClaudeToolUse(name: unknown, input: any): string {
  const tool = typeof name === "string" ? name : "tool";
  const url = typeof input?.url === "string" ? input.url : null;
  if (/navigate/i.test(tool) && url) return `Opening ${url.slice(0, 160)}`;
  if (tool === "WebSearch" && typeof input?.query === "string") return `Searching the web: ${input.query.slice(0, 140)}`;
  if (tool === "WebFetch" && url) return `Fetching ${url.slice(0, 160)}`;
  if (tool === "Bash" && typeof input?.command === "string") {
    const cmd = input.command.replace(/\s+/g, " ").trim();
    // The agent's Bash is curl-only (attach calls). Show the endpoint, never
    // the payload — costPaid etc. belong in the report, not the action feed.
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

/** Row badge copy for the panel's status chip. */
export function claudeFindRunStatusLabel(
  status: ClaudeFindRunStatus,
  kind: ClaudeFindRunKind = "find",
  queueAhead?: number,
): { label: string; tone: "active" | "attention" | "good" | "bad" } {
  switch (status) {
    case "queued":
      // Bulk parks runs in a one-at-a-time line; naming the position is what
      // separates "waiting its turn" from "the Mac runner is down".
      if (typeof queueAhead === "number" && queueAhead > 0) {
        return {
          label: `Queued — ${queueAhead} run${queueAhead === 1 ? "" : "s"} ahead in the Mac runner's line`,
          tone: "active",
        };
      }
      return { label: "Queued — waiting for the Mac runner", tone: "active" };
    case "claimed":
      return { label: "Starting on the Mac…", tone: "active" };
    case "running":
      return {
        label: kind === "checkout" ? "Running — preparing the checkout" : "Running — searching for buy-ins",
        tone: "active",
      };
    case "attention":
      return { label: "Needs you — the agent is blocked", tone: "attention" };
    case "completed":
      return { label: "Completed", tone: "good" };
    case "cancelled":
      return { label: "Cancelled", tone: "bad" };
    case "failed":
    default:
      return { label: "Failed", tone: "bad" };
  }
}

// ── headless CHECKOUT runs (2026-07-20) ─────────────────────────────────────

export interface CheckoutRunUnit {
  buyInId: number;
  unitLabel: string;
  listingUrl: string;
  costPaid: number;
}

/**
 * Server-side eligibility for a headless checkout run, evaluated against the
 * AUTHORITATIVE buy_ins row at run-create time (never against what a client
 * screen claimed — this is what replaced the old client-side costPaid
 * freshness pre-flight). Everything money-shaped the brief embeds comes from
 * the row this function approved.
 *
 * Rules, each with a reason:
 * - attached to THIS reservation — a run must never prepare another booking's unit;
 * - not booked / request_submitted — re-preparing one risks a duplicate purchase;
 * - not queued / in_progress / awaiting_payment — an operator handoff is
 *   already active (the checkout-claim lane), and the claim would 409 anyway;
 * - HTTPS vrbo.com listing URL — the brief only knows how to prepare a VRBO
 *   checkout; Booking.com/direct units go through "Find property on VRBO" first;
 * - costPaid > 0 — it anchors the 15% price guard; a $0 anchor waves any
 *   overpay through.
 */
export function checkoutRunEligibility(
  row: {
    id?: unknown;
    guestyReservationId?: unknown;
    bookingStatus?: unknown;
    airbnbListingUrl?: unknown;
    costPaid?: unknown;
    unitLabel?: unknown;
    unitId?: unknown;
  } | null | undefined,
  reservationId: string,
): { ok: true; unit: CheckoutRunUnit } | { ok: false; error: string } {
  const buyInId = Number(row?.id);
  if (!row || !Number.isFinite(buyInId)) return { ok: false, error: "Buy-in not found" };
  if (String(row.guestyReservationId ?? "") !== reservationId) {
    return { ok: false, error: "That buy-in is not attached to this reservation" };
  }
  const status = String(row.bookingStatus ?? "").trim().toLowerCase();
  if (status === "booked" || status === "request_submitted") {
    return { ok: false, error: "This unit already has a booking result — re-preparing it risks a duplicate purchase" };
  }
  if (status === "queued" || status === "in_progress" || status === "awaiting_payment") {
    return { ok: false, error: "A checkout is already active for this unit — finish or reset it first" };
  }
  const listingUrl = String(row.airbnbListingUrl ?? "").trim();
  let host = "";
  let protocol = "";
  try {
    const parsed = new URL(listingUrl);
    host = parsed.hostname.toLowerCase();
    protocol = parsed.protocol;
  } catch {
    return { ok: false, error: "The buy-in has no usable listing URL" };
  }
  if (protocol !== "https:" || (host !== "vrbo.com" && host !== "www.vrbo.com")) {
    return {
      ok: false,
      error: "The attached listing is not on vrbo.com — use \"Find property on VRBO\" to re-channel it before checkout",
    };
  }
  const costPaid = Number(row.costPaid);
  if (!Number.isFinite(costPaid) || costPaid <= 0) {
    return { ok: false, error: "The buy-in has no recorded price (costPaid) — the 15% guard cannot be armed" };
  }
  return {
    ok: true,
    unit: {
      buyInId,
      unitLabel: String(row.unitLabel ?? row.unitId ?? `buy-in ${buyInId}`).slice(0, 200),
      listingUrl,
      costPaid,
    },
  };
}
