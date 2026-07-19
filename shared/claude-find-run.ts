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
// - FIND-ONLY. The brief ends at ATTACH (buildCoworkBuyInPrompt semantics);
//   checkout stays the human-gated Cowork prompt. Never wire this runner to
//   the checkout brief — the send press there is the money approval.
// - The agent NEVER holds the portal admin secret. It authenticates its two
//   attach calls with a RUN-SCOPED token minted per run, accepted only by the
//   /api/claude-find-runs/agent/:id/* endpoints, only while the run is live.
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

export interface ClaudeFindRunRecord {
  id: string;
  reservationId: string;
  propertyId: number;
  propertyName: string;
  guestName: string | null;
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
/** Absolute ceiling on any non-terminal run. */
export const CLAUDE_FIND_RUN_MAX_AGE_MS = 90 * 60 * 1_000;

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
 * Server-side watchdog for orphaned runs. Honest failure messages — each names
 * what actually went wrong so the operator knows whether to check the Mac.
 */
export function claudeFindRunWatchdogVerdict(run: ClaudeFindRunRecord, nowMs: number): ClaudeFindRunWatchdogVerdict {
  if (!ACTIVE_CLAUDE_FIND_RUN_STATUSES.has(run.status)) return { action: "none" };
  const created = Date.parse(run.createdAt);
  if (Number.isFinite(created) && nowMs - created > CLAUDE_FIND_RUN_MAX_AGE_MS) {
    return { action: "fail", error: "Run exceeded the 90-minute ceiling and was closed by the watchdog." };
  }
  if (run.status === "queued") {
    if (Number.isFinite(created) && nowMs - created > CLAUDE_FIND_RUN_CLAIM_TIMEOUT_MS) {
      return {
        action: "fail",
        error:
          "The Mac runner never picked this up — is the Mac awake and the sidecar daemon running? (launchctl kickstart -k gui/$(id -u)/com.vrbosidecar.worker)",
      };
    }
    return { action: "none" };
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

/** What the bookings client sees — token + prompt STRIPPED, events truncated. */
export interface ClaudeFindRunClientView {
  id: string;
  reservationId: string;
  propertyName: string;
  status: ClaudeFindRunStatus;
  createdAt: string;
  endedAt: string | null;
  cancelRequested: boolean;
  attentionReason: string | null;
  report: string | null;
  error: string | null;
  events: ClaudeFindRunEvent[];
  droppedEvents: number;
}

export function clientClaudeFindRunView(run: ClaudeFindRunRecord): ClaudeFindRunClientView {
  return {
    id: run.id,
    reservationId: run.reservationId,
    propertyName: run.propertyName,
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
    const endpoint = /claude-find-runs\/agent\/[^/\s"']+\/(buy-ins|attach)/.exec(cmd)?.[1];
    if (endpoint === "buy-ins") return "Creating a buy-in record via the portal";
    if (endpoint === "attach") return "Attaching a buy-in to the reservation";
    return `Running: ${cmd.slice(0, 120)}`;
  }
  const short = tool.replace(/^mcp__[^_]+(?:_[^_]+)*__/, "").replace(/_/g, " ");
  return `Browser: ${short.slice(0, 80)}`;
}

/** Row badge copy for the panel's status chip. */
export function claudeFindRunStatusLabel(status: ClaudeFindRunStatus): { label: string; tone: "active" | "attention" | "good" | "bad" } {
  switch (status) {
    case "queued":
      return { label: "Queued — waiting for the Mac runner", tone: "active" };
    case "claimed":
      return { label: "Starting on the Mac…", tone: "active" };
    case "running":
      return { label: "Running — searching for buy-ins", tone: "active" };
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
