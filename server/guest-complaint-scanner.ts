// Automatic guest-complaint scanner.
//
// Reads the Guesty guest inbox, decides whether an incoming GUEST message is a
// complaint, and records it in the SAME guest-issue tracker the operator/agents
// already use (server/routes.ts /api/inbox/guest-issues, GuestIssuesPanel):
//   - a NEW problem opens a guest issue (status "open"),
//   - the SAME ongoing problem appends a timestamped note (a comment) to the
//     existing unresolved issue.
//
// Two phases, so it does exactly what the operator asked — "scan the whole guest
// inbox (every thread once), then for every new incoming message decide if it's
// a complaint":
//   1. BACKFILL (once): page every conversation and classify its guest posts
//      inside a bounded lookback window. Progress + a watermark persist in
//      app_settings so a redeploy resumes instead of re-scanning.
//   2. INCREMENTAL: every tick, only look at conversations with activity newer
//      than the watermark, and only at guest posts newer than it.
//
// Idempotency: every issue/note carries the source message's ISO timestamp as a
// marker (see shared/guest-complaint-logic.ts messageMarker). Before acting the
// scanner checks the conversation's issues + comments for that marker, so a
// re-scan / crash-replay / manual full rescan can never duplicate anything — no
// per-message dedup table needed.
//
// Detection is a cheap keyword/heuristic GATE → a Claude (Haiku) confirmation +
// classification. When there is no ANTHROPIC key (or Claude errors) it falls
// back to the pure heuristic verdict. Internal tracking only — it never messages
// the guest (opening a "task" is the whole ask; guest-facing replies stay the
// operator's / auto-reply's job).
//
// Rollout: auto-on (kill with GUEST_COMPLAINT_SCANNER_DISABLED=true or the
// /api/inbox/complaint-scan/toggle endpoint; the toggle persists in app_settings).
// Modeled on server/guest-receipts.ts (cadence + toggle shape).

import { guestyRequest } from "./guesty-sync";
import { storage } from "./storage";
import { callClaudeJson } from "./claude-json";
import { isIncomingPost, isSystemPost, postTimestampMs } from "@shared/guesty-post-classify";
import {
  complaintKeywordSignal,
  heuristicComplaintVerdict,
  parseClaudeComplaintClassification,
  matchExistingComplaintIssue,
  messageAlreadyCaptured,
  buildComplaintCommentBody,
  buildComplaintIssueDescription,
  parseComplaintScanState,
  serializeComplaintScanState,
  COMPLAINT_CATEGORIES,
  AUTO_COMPLAINT_AUTHOR,
  AUTO_COMPLAINT_ROLE,
  AUTO_COMPLAINT_SOURCE,
  type ComplaintVerdict,
  type ComplaintScanState,
  type ExistingIssueLike,
} from "@shared/guest-complaint-logic";
import type { GuestIssue, GuestIssueComment } from "@shared/schema";

const STATE_KEY = "guest_complaint_scan.state";
const ENABLED_KEY = "guest_complaint_scan.enabled";

const BACKFILL_DAYS = Number(process.env.GUEST_COMPLAINT_BACKFILL_DAYS) > 0 ? Number(process.env.GUEST_COMPLAINT_BACKFILL_DAYS) : 365;
// Conversations processed per tick (bounds backfill cost; it completes over a
// few ticks). Incremental ticks rarely touch this many.
const MAX_CONV_PER_RUN = Number(process.env.GUEST_COMPLAINT_MAX_CONV_PER_RUN) > 0 ? Number(process.env.GUEST_COMPLAINT_MAX_CONV_PER_RUN) : 60;
// Claude classification calls per tick (a hard cost cap; over budget falls back
// to the heuristic verdict so a candidate is never silently dropped).
const MAX_CLASSIFY_PER_RUN = Number(process.env.GUEST_COMPLAINT_MAX_CLASSIFY_PER_RUN) > 0 ? Number(process.env.GUEST_COMPLAINT_MAX_CLASSIFY_PER_RUN) : 40;
const CLASSIFY_MODEL = process.env.GUEST_COMPLAINT_MODEL || "claude-haiku-4-5-20251001";
// The whole inbox is fetched in ONE request: Guesty's /communication/conversations
// rejects `skip` (400 "skip is not allowed") and its cursor is unreliable, but it
// honors a large `limit`. This ceiling is generous headroom over the real inbox
// size; if it is ever exceeded the OLDEST conversations beyond it are not scanned
// (logged), and incremental still catches all new activity.
const CONV_FETCH_LIMIT = Math.max(100, Number(process.env.GUEST_COMPLAINT_CONV_FETCH_LIMIT) || 500);

let _enabled = process.env.GUEST_COMPLAINT_SCANNER_DISABLED !== "true";
let _isRunning = false;
let _lastRunAt: Date | null = null;
type RunResult = {
  phase: "backfill" | "incremental" | "disabled" | "busy";
  conversations: number;
  detected: number;
  created: number;
  appended: number;
  skipped: number;
  errors: number;
  classifyCalls: number;
  backfillComplete: boolean;
  message: string;
};
let _lastRunResult: RunResult | null = null;

export function getGuestComplaintScannerStatus() {
  return { enabled: _enabled, lastRunAt: _lastRunAt, lastRunResult: _lastRunResult, backfillDays: BACKFILL_DAYS };
}

export async function setGuestComplaintScannerEnabled(v: boolean): Promise<void> {
  _enabled = v;
  await storage.setSetting(ENABLED_KEY, v ? "1" : "0").catch(() => {});
  console.log(`[guest-complaints] ${v ? "Enabled" : "Disabled"}`);
}

// ── Guesty inbox reads (self-contained; mirrors auto-reply's shapes) ─────────
function unwrapConversations(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  for (const k of ["conversations", "results", "data"]) {
    if (Array.isArray(raw[k])) return raw[k];
  }
  for (const k of ["data", "results", "result"]) {
    if (raw[k] && typeof raw[k] === "object") {
      const inner = unwrapConversations(raw[k]);
      if (inner.length > 0) return inner;
    }
  }
  return [];
}

function unwrapPosts(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  for (const k of ["posts", "messages", "results", "data"]) {
    if (Array.isArray(raw[k])) return raw[k];
  }
  for (const k of ["data", "result"]) {
    if (raw[k] && typeof raw[k] === "object") {
      const inner = unwrapPosts(raw[k]);
      if (inner.length > 0) return inner;
    }
  }
  return [];
}

// Fetch the whole inbox in ONE request. Trailing `&fields=` IS LOAD-BEARING (same
// as auto-reply/inbox): without it Guesty returns a stripped conversation state
// and we lose state.lastMessage. NO `skip` (Guesty 400s on it) and NO cursor
// (unreliable on this endpoint) — a large `limit` returns everything. Sort is
// omitted; both phases order the result themselves (backfill by createdAt for a
// stable resume, incremental by activity).
async function fetchAllConversations(): Promise<any[]> {
  const data = await guestyRequest("GET", `/communication/conversations?limit=${CONV_FETCH_LIMIT}&fields=`);
  return unwrapConversations(data);
}

async function fetchConversationPosts(id: string): Promise<any[]> {
  try {
    const data = await guestyRequest("GET", `/communication/conversations/${id}/posts?limit=100`);
    return unwrapPosts(data);
  } catch (err) {
    console.error(`[guest-complaints] failed to fetch posts for ${id}: ${(err as Error).message}`);
    return [];
  }
}

function conversationId(conv: any): string {
  return String(conv?._id ?? conv?.id ?? "");
}

// Newest activity time (ms) for the incremental "is there anything new?" filter.
function convLastActivityMs(conv: any): number {
  const state = conv?.state;
  const candidates = [
    typeof state === "object" ? state?.lastMessage?.date : null,
    conv?.lastMessageAt,
    conv?.lastMessageReceivedAt,
    conv?.updatedAt,
    conv?.createdAt,
  ];
  for (const c of candidates) {
    const t = c ? new Date(String(c)).getTime() : NaN;
    if (Number.isFinite(t) && t > 0) return t;
  }
  return 0;
}

// Creation time (ms) — a STABLE key for backfill ordering (never changes, so a
// count-based resume can't skip or double a thread as new messages arrive).
function convCreatedAtMs(conv: any): number {
  const t = conv?.createdAt ? new Date(String(conv.createdAt)).getTime() : NaN;
  return Number.isFinite(t) && t > 0 ? t : 0;
}

// Guest / listing / reservation identity, same extraction as runAutoReply.
function conversationIdentity(conv: any): { guestName: string | null; listingId: string | null; reservationId: string | null } {
  const meta: any = conv?.meta ?? {};
  const guestObj = conv?.guest ?? meta.guest ?? {};
  const firstReservation =
    Array.isArray(meta.reservations) && meta.reservations.length > 0 ? meta.reservations[0] : conv?.reservation ?? null;
  return {
    guestName: guestObj.fullName ?? guestObj.firstName ?? null,
    listingId: conv?.listingId ?? firstReservation?.listingId ?? firstReservation?.listing?._id ?? null,
    reservationId: conv?.reservationId ?? firstReservation?._id ?? firstReservation?.id ?? null,
  };
}

function channelForConversation(conv: any, post: any): string | null {
  return post?.module?.type ?? conv?.module?.type ?? conv?.integration?.platform ?? null;
}

// ── Classification ──────────────────────────────────────────────────────────
type ClassifyBudget = { left: number };

const CLASSIFY_SYSTEM =
  "You triage short-term vacation-rental guest messages for a property manager. " +
  "A COMPLAINT is a message where the guest reports something WRONG with the property or their stay, or expresses clear dissatisfaction that needs the operator to DO something (fix, clean, replace, refund, respond). " +
  "It is NOT a complaint if the guest is only asking a logistics/policy question (check-in time, parking, wifi password, can I bring a pet), thanking, chatting, or leaving positive feedback. " +
  "Respond with STRICT JSON only.";

function classifyPrompt(message: string): string {
  return [
    "Classify this guest message.",
    "",
    "Guest message:",
    '"""',
    message.slice(0, 4000),
    '"""',
    "",
    "Return JSON exactly like:",
    '{"isComplaint": true|false, "severity": "low|normal|high|urgent", "category": "' + COMPLAINT_CATEGORIES.join("|") + '", "title": "<=8 word issue title", "summary": "one sentence describing the problem"}',
    "",
    "severity: urgent = safety / no water-power / locked out / medical; high = major function broken (AC out, big leak, pests); normal = ordinary problem; low = minor.",
    "If it is not a complaint, set isComplaint false (other fields can be defaults).",
  ].join("\n");
}

async function classifyComplaint(message: string, budget: ClassifyBudget): Promise<ComplaintVerdict> {
  const heuristic = heuristicComplaintVerdict(message);
  // Over budget or no key → pure heuristic (never drop a keyword-flagged msg).
  if (budget.left <= 0 || !process.env.ANTHROPIC_API_KEY) return heuristic;
  budget.left -= 1;
  try {
    const res = await callClaudeJson<Record<string, unknown>>({
      model: CLASSIFY_MODEL,
      maxTokens: 300,
      system: CLASSIFY_SYSTEM,
      prompt: classifyPrompt(message),
      temperature: 0,
      timeoutMs: 30_000,
    });
    if (!res.ok) {
      console.warn(`[guest-complaints] classify fell back to heuristic: ${res.error}`);
      return heuristic;
    }
    const parsed = parseClaudeComplaintClassification(res.data);
    return parsed ?? heuristic;
  } catch (e: any) {
    console.warn(`[guest-complaints] classify error, using heuristic: ${e?.message ?? e}`);
    return heuristic;
  }
}

// ── Per-conversation scan ────────────────────────────────────────────────────
type IssueWithComments = GuestIssue & { comments: GuestIssueComment[] };
type ConvScanResult = { maxPostMs: number; detected: number; created: number; appended: number; skipped: number; errors: number };

async function loadConversationIssues(convId: string): Promise<IssueWithComments[]> {
  const issues = await storage.getGuestIssuesByConversation(convId, 50);
  if (issues.length === 0) return [];
  const comments = await storage.getGuestIssueCommentsForIssues(issues.map((i) => i.id));
  const byIssue = new Map<number, GuestIssueComment[]>();
  for (const c of comments) {
    const arr = byIssue.get(c.issueId) ?? [];
    arr.push(c);
    byIssue.set(c.issueId, arr);
  }
  return issues.map((i) => ({ ...i, comments: byIssue.get(i.id) ?? [] }));
}

function toExistingLike(i: IssueWithComments): ExistingIssueLike {
  return { id: i.id, status: i.status, title: i.title, description: i.description };
}

async function scanConversation(conv: any, lowerBoundMs: number, budget: ClassifyBudget): Promise<ConvScanResult> {
  const result: ConvScanResult = { maxPostMs: 0, detected: 0, created: 0, appended: 0, skipped: 0, errors: 0 };
  const convId = conversationId(conv);
  if (!convId) return result;

  const posts = await fetchConversationPosts(convId);
  const guestPosts = posts
    .filter((p) => !isSystemPost(p) && isIncomingPost(p) && postTimestampMs(p) > lowerBoundMs)
    .sort((a, b) => postTimestampMs(a) - postTimestampMs(b)); // oldest first
  if (guestPosts.length === 0) return result;

  const identity = conversationIdentity(conv);
  let issuesLoaded: IssueWithComments[] | null = null;

  for (const post of guestPosts) {
    const ts = postTimestampMs(post);
    if (ts > result.maxPostMs) result.maxPostMs = ts;
    const text = String(post?.body ?? post?.text ?? post?.message ?? "").trim();
    if (!text) continue;

    // Cheap gate — most messages exit here with no Claude call.
    if (complaintKeywordSignal(text).matched.length === 0) continue;

    let verdict: ComplaintVerdict;
    try {
      verdict = await classifyComplaint(text, budget);
    } catch (e: any) {
      result.errors++;
      console.error(`[guest-complaints] classify threw for ${convId}: ${e?.message ?? e}`);
      continue;
    }
    if (!verdict.isComplaint) { result.skipped++; continue; }

    // Load the conversation's issues lazily (only once a candidate appears).
    if (issuesLoaded === null) {
      try {
        issuesLoaded = await loadConversationIssues(convId);
      } catch (e: any) {
        result.errors++;
        console.error(`[guest-complaints] failed to load issues for ${convId}: ${e?.message ?? e}`);
        return result;
      }
    }

    const postIso = new Date(ts).toISOString();
    // Idempotent: this exact message already captured → never act twice.
    if (messageAlreadyCaptured(postIso, issuesLoaded)) { result.skipped++; continue; }

    const channel = channelForConversation(conv, post);
    const signal = complaintKeywordSignal(text);
    const existingId = matchExistingComplaintIssue(verdict, issuesLoaded.map(toExistingLike), signal.matched);

    try {
      if (existingId != null) {
        const body = buildComplaintCommentBody({ guestMessage: text, postIso, channel });
        const res = await storage.commentOnGuestIssue(
          existingId,
          { body, statusChange: null, authorName: AUTO_COMPLAINT_AUTHOR, authorRole: AUTO_COMPLAINT_ROLE, source: AUTO_COMPLAINT_SOURCE },
          { lastCommentAt: new Date() },
        );
        if (res) {
          result.appended++;
          result.detected++;
          // Reflect in the local cache so a 2nd message in the same run dedups.
          const cached = issuesLoaded.find((i) => i.id === existingId);
          if (cached) cached.comments.push(res.comment);
        } else {
          // Issue vanished (concurrent delete) — open a fresh one instead.
          await openIssue(convId, identity, verdict, text, postIso, channel, issuesLoaded, result);
        }
      } else {
        await openIssue(convId, identity, verdict, text, postIso, channel, issuesLoaded, result);
      }
    } catch (e: any) {
      result.errors++;
      console.error(`[guest-complaints] write failed for ${convId}: ${e?.message ?? e}`);
    }
  }

  return result;
}

async function openIssue(
  convId: string,
  identity: { guestName: string | null; listingId: string | null; reservationId: string | null },
  verdict: ComplaintVerdict,
  text: string,
  postIso: string,
  channel: string | null,
  issuesLoaded: IssueWithComments[],
  result: ConvScanResult,
): Promise<void> {
  const description = buildComplaintIssueDescription({ verdict, guestMessage: text, postIso, channel });
  const issue = await storage.createGuestIssue({
    conversationId: convId,
    reservationId: identity.reservationId,
    guestName: identity.guestName,
    listingId: identity.listingId,
    title: verdict.title,
    description,
    severity: verdict.severity,
    status: "open",
    createdBy: AUTO_COMPLAINT_AUTHOR,
    createdByRole: AUTO_COMPLAINT_ROLE,
  });
  result.created++;
  result.detected++;
  issuesLoaded.unshift({ ...issue, comments: [] });
}

// ── Run ──────────────────────────────────────────────────────────────────────
export async function runGuestComplaintScan(opts?: { full?: boolean }): Promise<RunResult> {
  if (!_enabled && !opts?.full) {
    const r: RunResult = { phase: "disabled", conversations: 0, detected: 0, created: 0, appended: 0, skipped: 0, errors: 0, classifyCalls: 0, backfillComplete: false, message: "Guest complaint scanner disabled" };
    _lastRunAt = new Date();
    _lastRunResult = r;
    return r;
  }
  if (_isRunning) {
    return _lastRunResult ?? { phase: "busy", conversations: 0, detected: 0, created: 0, appended: 0, skipped: 0, errors: 0, classifyCalls: 0, backfillComplete: false, message: "Scan already running" };
  }
  _isRunning = true;
  const now = Date.now();
  const budget: ClassifyBudget = { left: MAX_CLASSIFY_PER_RUN };
  let conversations = 0, detected = 0, created = 0, appended = 0, skipped = 0, errors = 0;

  try {
    let state = parseComplaintScanState(await storage.getSetting(STATE_KEY).catch(() => undefined));
    // Manual "full rescan" resets progress; the idempotency markers make a full
    // re-read of the inbox safe (no duplicate issues/notes).
    if (opts?.full) state = { backfillComplete: false, backfillDoneCount: 0, watermarkMs: 0, lastRunAt: state.lastRunAt };

    const backfillCutoff = now - BACKFILL_DAYS * 24 * 60 * 60 * 1000;
    let watermarkMs = state.watermarkMs;
    let backfillComplete = state.backfillComplete;
    let backfillDoneCount = state.backfillDoneCount;

    // ONE fetch for the whole inbox. If it THROWS, the outer catch handles it and
    // the persisted state is left UNTOUCHED — a transient Guesty error can never
    // falsely "complete" the backfill (the old skip-paging bug scanned nothing).
    const allConvs = await fetchAllConversations();
    if (allConvs.length >= CONV_FETCH_LIMIT) {
      console.warn(`[guest-complaints] inbox returned ${allConvs.length} conversations at the fetch ceiling ${CONV_FETCH_LIMIT} — oldest beyond it are not scanned; raise GUEST_COMPLAINT_CONV_FETCH_LIMIT`);
    }

    const accumulate = (r: ConvScanResult) => {
      detected += r.detected; created += r.created; appended += r.appended; skipped += r.skipped; errors += r.errors;
    };

    if (!backfillComplete) {
      // ── BACKFILL: scan every thread once. Order by createdAt (STABLE — never
      // changes, new threads append at the end) and resume by COUNT, so a thread
      // arriving mid-backfill can't shift the cursor and skip an unscanned one. ──
      const ordered = [...allConvs].sort((a, b) => convCreatedAtMs(a) - convCreatedAtMs(b));
      const total = ordered.length;
      const slice = ordered.slice(backfillDoneCount, backfillDoneCount + MAX_CONV_PER_RUN);
      for (const conv of slice) {
        const lastMs = convLastActivityMs(conv);
        // Prune ancient threads — nothing worth actioning in a year-old chat. Still
        // counted as "done" (via slice.length) so the backfill advances past it.
        if (lastMs && lastMs < backfillCutoff) continue;
        conversations++;
        const r = await scanConversation(conv, backfillCutoff, budget);
        accumulate(r);
        if (r.maxPostMs > watermarkMs) watermarkMs = r.maxPostMs;
      }
      backfillDoneCount += slice.length;
      if (backfillDoneCount >= total) {
        // Every thread scanned once — incremental takes over from here.
        backfillComplete = true;
        watermarkMs = Math.max(watermarkMs, now);
      }
    } else {
      // ── INCREMENTAL: only threads with activity past the watermark, OLDEST-fresh
      // first so the watermark advances over a CONTIGUOUS prefix. If the per-run cap
      // truncates a big burst, the newest un-processed threads stay above the
      // watermark for the next tick — never skipped (the "middle gap" a
      // newest-first + jump-to-now would leave). ──
      const fresh = allConvs
        .filter((c) => convLastActivityMs(c) > state.watermarkMs)
        .sort((a, b) => convLastActivityMs(a) - convLastActivityMs(b));
      let capped = false;
      let lastProcessedActivity = state.watermarkMs;
      for (const conv of fresh) {
        if (conversations >= MAX_CONV_PER_RUN) { capped = true; break; }
        conversations++;
        accumulate(await scanConversation(conv, state.watermarkMs, budget));
        const activity = convLastActivityMs(conv);
        if (activity > lastProcessedActivity) lastProcessedActivity = activity;
      }
      // Capped → advance only to the last fully-processed thread's activity (a
      // gap-free prefix). Not capped → everything fresh was considered → caught up.
      watermarkMs = capped ? Math.max(watermarkMs, lastProcessedActivity) : Math.max(watermarkMs, now);
    }

    const newState: ComplaintScanState = { backfillComplete, backfillDoneCount, watermarkMs, lastRunAt: new Date().toISOString() };
    await storage.setSetting(STATE_KEY, serializeComplaintScanState(newState)).catch((e) =>
      console.error(`[guest-complaints] failed to persist scan state: ${e?.message ?? e}`),
    );

    const phase: RunResult["phase"] = state.backfillComplete ? "incremental" : "backfill";
    _lastRunResult = {
      phase, conversations, detected, created, appended, skipped, errors,
      classifyCalls: MAX_CLASSIFY_PER_RUN - budget.left,
      backfillComplete,
      message: `${phase}: scanned ${conversations} conversation(s) — ${created} opened, ${appended} note(s) appended, ${skipped} skipped, ${errors} error(s)${backfillComplete ? "" : " (backfill in progress)"}`,
    };
  } catch (e: any) {
    errors++;
    _lastRunResult = { phase: "incremental", conversations, detected, created, appended, skipped, errors, classifyCalls: MAX_CLASSIFY_PER_RUN - budget.left, backfillComplete: false, message: `Scan error: ${e?.message ?? e}` };
    console.error(`[guest-complaints] top-level error: ${e?.message ?? e}`);
  } finally {
    _isRunning = false;
    _lastRunAt = new Date();
  }
  console.log(`[guest-complaints] ${_lastRunResult?.message ?? "done"}`);
  return _lastRunResult!;
}

export function startGuestComplaintScanner() {
  // Load the persisted enable toggle before the first run (env is the default;
  // an operator OFF via the endpoint sticks across restarts).
  (async () => {
    const saved = await storage.getSetting(ENABLED_KEY).catch(() => undefined);
    if (saved === "0") _enabled = false;
    else if (saved === "1") _enabled = true;
  })().catch(() => {});

  // Stagger after the other schedulers boot; then every 5 minutes (a new guest
  // complaint becomes a tracked issue within ~5 min, same cadence as receipts).
  setTimeout(() => { runGuestComplaintScan().catch(() => {}); }, 90_000);
  const INTERVAL_MS = 5 * 60 * 1000;
  setInterval(() => { runGuestComplaintScan().catch(() => {}); }, INTERVAL_MS);

  console.log(`[guest-complaints] Scanner started (every 5 minutes, ${BACKFILL_DAYS}d backfill, model ${CLASSIFY_MODEL})`);
}
