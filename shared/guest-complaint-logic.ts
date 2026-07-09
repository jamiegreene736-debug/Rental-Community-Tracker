// Pure, dependency-free helpers for the AUTOMATIC guest-complaint scanner.
//
// The scanner (server/guest-complaint-scanner.ts) reads the Guesty guest inbox,
// decides whether an incoming guest message is a COMPLAINT (something is wrong /
// the guest is unhappy — distinct from a benign policy question like "can I
// bring a pet?"), and then either opens a NEW guest issue or appends a
// timestamped note to an EXISTING unresolved one. A "guest issue" IS the
// complaint/task record; a comment IS the timestamped note. See
// shared/guest-issue-logic.ts for the shared status/severity lifecycle.
//
// This module holds every decision that must be identical between the server
// and its unit tests (detection, dedup/matching, idempotency marker, note/title
// formatting) so behavior can never drift. Keep it free of Node/DB/React.

import {
  normalizeGuestIssueSeverity,
  isGuestIssueUnresolved,
  type GuestIssueSeverity,
} from "./guest-issue-logic";

// Attribution for everything the scanner writes. createdByRole "system" (not
// admin/agent) is what the UI keys the "Auto-detected" badge off, and it keeps
// the honest "who opened this" trail — a human never claims an auto-open.
export const AUTO_COMPLAINT_AUTHOR = "auto-scan";
export const AUTO_COMPLAINT_ROLE = "system";
export const AUTO_COMPLAINT_SOURCE = "auto-scan";

// Coarse buckets the scanner uses to decide whether a NEW complaint is "the
// same problem" as an already-open issue (→ append a note) or a fresh one (→
// open a new issue). Kept small and stable — the Claude classifier is told to
// pick from exactly these.
export const COMPLAINT_CATEGORIES = [
  "maintenance",
  "cleanliness",
  "noise",
  "access",
  "billing",
  "safety",
  "amenities",
  "other",
] as const;
export type ComplaintCategory = (typeof COMPLAINT_CATEGORIES)[number];

export function normalizeComplaintCategory(value: unknown): ComplaintCategory {
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if ((COMPLAINT_CATEGORIES as readonly string[]).includes(v)) return v as ComplaintCategory;
  }
  return "other";
}

// ── Complaint keyword / heuristic pre-filter ────────────────────────────────
//
// This is the cheap gate that decides whether a message is worth a Claude
// classification call (and, when there is no ANTHROPIC key, IS the verdict).
// Deliberately COMPLAINT-shaped — it must NOT fire on ordinary logistics ("what
// time is check-in?", "can I get a late checkout?"). Recall is widened by the
// generic problem-phrase patterns below (`negatedFunctionSignal`) so a complaint
// that names no keyword ("the shower only runs cold") is still caught.
const COMPLAINT_KEYWORDS: Array<{ keyword: string; category: ComplaintCategory; severity: GuestIssueSeverity }> = [
  // Maintenance / broken things
  { keyword: "broken", category: "maintenance", severity: "high" },
  { keyword: "not working", category: "maintenance", severity: "high" },
  { keyword: "doesn't work", category: "maintenance", severity: "high" },
  { keyword: "does not work", category: "maintenance", severity: "high" },
  { keyword: "won't turn on", category: "maintenance", severity: "high" },
  { keyword: "stopped working", category: "maintenance", severity: "high" },
  { keyword: "leak", category: "maintenance", severity: "high" },
  { keyword: "leaking", category: "maintenance", severity: "high" },
  { keyword: "flood", category: "maintenance", severity: "urgent" },
  { keyword: "flooded", category: "maintenance", severity: "urgent" },
  { keyword: "mold", category: "maintenance", severity: "high" },
  { keyword: "no hot water", category: "maintenance", severity: "high" },
  { keyword: "no water", category: "maintenance", severity: "urgent" },
  { keyword: "no power", category: "maintenance", severity: "urgent" },
  { keyword: "no electricity", category: "maintenance", severity: "urgent" },
  { keyword: "power outage", category: "maintenance", severity: "urgent" },
  { keyword: "ac not working", category: "maintenance", severity: "high" },
  { keyword: "a/c not working", category: "maintenance", severity: "high" },
  { keyword: "air conditioning", category: "maintenance", severity: "normal" },
  { keyword: "not cooling", category: "maintenance", severity: "high" },
  { keyword: "no wifi", category: "amenities", severity: "normal" },
  { keyword: "no internet", category: "amenities", severity: "normal" },
  { keyword: "clogged", category: "maintenance", severity: "normal" },
  { keyword: "damaged", category: "maintenance", severity: "normal" },
  { keyword: "damage", category: "maintenance", severity: "normal" },
  // Cleanliness
  { keyword: "dirty", category: "cleanliness", severity: "normal" },
  { keyword: "filthy", category: "cleanliness", severity: "high" },
  { keyword: "not clean", category: "cleanliness", severity: "normal" },
  { keyword: "unclean", category: "cleanliness", severity: "normal" },
  { keyword: "disgusting", category: "cleanliness", severity: "high" },
  { keyword: "stain", category: "cleanliness", severity: "low" },
  { keyword: "stained", category: "cleanliness", severity: "low" },
  { keyword: "smell", category: "cleanliness", severity: "normal" },
  { keyword: "smells", category: "cleanliness", severity: "normal" },
  { keyword: "odor", category: "cleanliness", severity: "normal" },
  { keyword: "trash", category: "cleanliness", severity: "low" },
  // Pests → cleanliness/safety
  { keyword: "bugs", category: "cleanliness", severity: "high" },
  { keyword: "roach", category: "cleanliness", severity: "high" },
  { keyword: "cockroach", category: "cleanliness", severity: "high" },
  { keyword: "ants", category: "cleanliness", severity: "normal" },
  { keyword: "mice", category: "cleanliness", severity: "high" },
  { keyword: "rats", category: "cleanliness", severity: "high" },
  { keyword: "bed bug", category: "cleanliness", severity: "urgent" },
  { keyword: "bedbug", category: "cleanliness", severity: "urgent" },
  // Noise
  { keyword: "noise", category: "noise", severity: "normal" },
  { keyword: "noisy", category: "noise", severity: "normal" },
  { keyword: "too loud", category: "noise", severity: "normal" },
  { keyword: "loud music", category: "noise", severity: "normal" },
  // Access / lockout
  { keyword: "locked out", category: "access", severity: "urgent" },
  { keyword: "lockout", category: "access", severity: "urgent" },
  { keyword: "can't get in", category: "access", severity: "urgent" },
  { keyword: "cannot get in", category: "access", severity: "urgent" },
  { keyword: "code doesn't work", category: "access", severity: "urgent" },
  { keyword: "code not working", category: "access", severity: "urgent" },
  { keyword: "key doesn't work", category: "access", severity: "high" },
  // Safety
  { keyword: "unsafe", category: "safety", severity: "urgent" },
  { keyword: "unsanitary", category: "safety", severity: "high" },
  { keyword: "gas leak", category: "safety", severity: "urgent" },
  { keyword: "smoke detector", category: "safety", severity: "high" },
  // Billing / money complaints
  { keyword: "overcharged", category: "billing", severity: "high" },
  { keyword: "double charged", category: "billing", severity: "high" },
  { keyword: "wrong charge", category: "billing", severity: "normal" },
  { keyword: "refund", category: "billing", severity: "normal" },
  // General dissatisfaction
  { keyword: "complaint", category: "other", severity: "normal" },
  { keyword: "complain", category: "other", severity: "normal" },
  { keyword: "unacceptable", category: "other", severity: "high" },
  { keyword: "disappointed", category: "other", severity: "normal" },
  { keyword: "disappointing", category: "other", severity: "normal" },
  { keyword: "not as described", category: "other", severity: "high" },
  { keyword: "false advertising", category: "other", severity: "high" },
  { keyword: "terrible", category: "other", severity: "normal" },
  { keyword: "horrible", category: "other", severity: "normal" },
  { keyword: "worst", category: "other", severity: "normal" },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary match tolerant of internal whitespace ("bed bug" ↔ "bed  bug")
// and an optional plural suffix on the final token ("roach" ↔ "roaches",
// "stain" ↔ "stains") so a plural complaint still trips the gate.
function keywordPattern(keyword: string): RegExp {
  const source = keyword.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  return new RegExp(`(?<![a-z0-9])${source}(?:e?s)?(?![a-z0-9])`, "i");
}

const COMPLAINT_KEYWORD_PATTERNS = COMPLAINT_KEYWORDS.map((k) => ({ ...k, pattern: keywordPattern(k.keyword) }));

// Generic "X is not working / no working X" phrasing so a complaint that names
// no listed keyword still trips the gate. Intentionally narrow (a following
// verb/adjective of malfunction) to avoid firing on "no problem, working great".
const NEGATED_FUNCTION_RE =
  /\b(?:not|isn'?t|aren'?t|won'?t|wasn'?t|doesn'?t|didn'?t|can'?t|cannot|no)\b[^.!?]{0,24}\b(?:work(?:ing|s)?|cool(?:ing|s)?|heat(?:ing|s)?|turn(?:ing)?\s+on|flush(?:ing)?|drain(?:ing)?|clean|hot\s+water|functioning)\b/i;

export type ComplaintKeywordSignal = {
  matched: string[];
  category: ComplaintCategory | null;
  severity: GuestIssueSeverity;
};

// Cheap first-pass verdict. `matched` empty + no negated-function phrase ⇒ the
// scanner skips this message entirely (no Claude call). When something matches,
// severity = the strongest matched keyword's severity, category = the first
// matched keyword's category (Claude refines both when available).
export function complaintKeywordSignal(text: string): ComplaintKeywordSignal {
  const body = String(text ?? "");
  const hits = COMPLAINT_KEYWORD_PATTERNS.filter(({ pattern }) => pattern.test(body));
  const severityRank: Record<GuestIssueSeverity, number> = { low: 0, normal: 1, high: 2, urgent: 3 };
  // Severity = the strongest matched keyword (a low-only match reports "low").
  let severity: GuestIssueSeverity = hits.length ? hits[0].severity : "normal";
  let category: ComplaintCategory | null = null;
  for (const h of hits) {
    if (severityRank[h.severity] > severityRank[severity]) severity = h.severity;
    if (category === null) category = h.category;
  }
  if (hits.length === 0 && NEGATED_FUNCTION_RE.test(body)) {
    category = "maintenance";
    severity = "normal";
    return { matched: ["not working"], category, severity };
  }
  return { matched: hits.map((h) => h.keyword), category, severity };
}

// Does this message look enough like a complaint to be worth classifying?
export function looksLikeComplaint(text: string): boolean {
  return complaintKeywordSignal(text).matched.length > 0;
}

// ── The verdict the scanner acts on ─────────────────────────────────────────
export type ComplaintVerdict = {
  isComplaint: boolean;
  severity: GuestIssueSeverity;
  category: ComplaintCategory;
  title: string;
  summary: string;
  source: "claude" | "heuristic";
};

// No-key fallback verdict, derived purely from the keyword signal. Kept
// deliberately conservative: a bare negated-function phrase with no complaint
// keyword still counts (recall), but a message with zero signal is NOT a
// complaint.
export function heuristicComplaintVerdict(text: string): ComplaintVerdict {
  const signal = complaintKeywordSignal(text);
  const category = signal.category ?? "other";
  const isComplaint = signal.matched.length > 0;
  return {
    isComplaint,
    severity: normalizeGuestIssueSeverity(signal.severity),
    category,
    title: buildHeuristicTitle(category, signal.matched),
    summary: firstSentence(text),
    source: "heuristic",
  };
}

function buildHeuristicTitle(category: ComplaintCategory, matched: string[]): string {
  const label = CATEGORY_TITLE[category];
  const hint = matched.find((m) => m !== "not working");
  return hint ? `${label}: ${hint}` : label;
}

const CATEGORY_TITLE: Record<ComplaintCategory, string> = {
  maintenance: "Maintenance issue",
  cleanliness: "Cleanliness issue",
  noise: "Noise complaint",
  access: "Access problem",
  billing: "Billing complaint",
  safety: "Safety concern",
  amenities: "Amenity problem",
  other: "Guest complaint",
};

// ── Claude classification parsing ───────────────────────────────────────────
// Validate/normalize the model's JSON into a ComplaintVerdict. Missing/garbage
// fields degrade to safe defaults; `isComplaint` must be an explicit true.
export function parseClaudeComplaintClassification(raw: unknown): ComplaintVerdict | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const isComplaint = r.isComplaint === true || r.is_complaint === true;
  const category = normalizeComplaintCategory(r.category);
  const severity = normalizeGuestIssueSeverity(r.severity);
  const rawTitle = typeof r.title === "string" ? r.title.trim() : "";
  const title = clampTitle(rawTitle) || CATEGORY_TITLE[category];
  const summary =
    typeof r.summary === "string" && r.summary.trim()
      ? r.summary.trim().slice(0, 500)
      : "";
  return { isComplaint, severity, category, title, summary, source: "claude" };
}

function clampTitle(t: string): string {
  const s = t.replace(/\s+/g, " ").trim();
  if (s.length <= 120) return s;
  return s.slice(0, 117).replace(/\s+\S*$/, "") + "…";
}

function firstSentence(text: string): string {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const m = s.match(/^.{0,240}?[.!?](?:\s|$)/);
  return (m ? m[0] : s).trim().slice(0, 500);
}

// ── Idempotency: never action the same guest message twice ──────────────────
// The scanner stamps a compact marker (the message's ISO timestamp) onto the
// issue description and every auto-note it writes. Before acting on a message it
// checks the conversation's existing issues + comments for that marker, so a
// re-scan, a crash-replay, or a manual full rescan can NEVER duplicate an issue
// or a note — no per-message dedup table required.
export function messageMarker(postIso: string): string {
  return `[msg:${postIso}]`;
}

export function textReferencesMessage(text: string | null | undefined, postIso: string): boolean {
  if (!text || !postIso) return false;
  return text.includes(messageMarker(postIso));
}

/** True if this exact guest message has already been captured on the conversation. */
export function messageAlreadyCaptured(
  postIso: string,
  issues: Array<{ description?: string | null; comments?: Array<{ body?: string | null }> }>,
): boolean {
  for (const issue of issues) {
    if (textReferencesMessage(issue.description ?? null, postIso)) return true;
    for (const c of issue.comments ?? []) {
      if (textReferencesMessage(c.body ?? null, postIso)) return true;
    }
  }
  return false;
}

// Infer a category from free issue text (a human-typed issue has no category
// column; an auto-issue's title carries the category label). Used by the matcher
// so category-equality dedup works without a DB column.
export function inferComplaintCategoryFromText(text: string): ComplaintCategory {
  return complaintKeywordSignal(text).category ?? "other";
}

// ── Dedup: is this complaint already an OPEN issue on the conversation? ──────
// Returns the id of the unresolved issue to append a note to, or null to open a
// new one. Primary key is category equality (category is inferred from the
// issue's own title+description since guest_issues has no category column); a
// secondary keyword-overlap check catches an "other"-categorized recurrence of
// the same wording. Resolved issues never match — a complaint that recurs after
// being resolved is a fresh occurrence.
export type ExistingIssueLike = {
  id: number;
  status: string;
  category?: ComplaintCategory | null;
  title?: string | null;
  description?: string | null;
};

export function matchExistingComplaintIssue(
  verdict: ComplaintVerdict,
  issues: ExistingIssueLike[],
  matchedKeywords: string[] = [],
): number | null {
  const unresolved = issues.filter((i) => isGuestIssueUnresolved(i.status));
  if (unresolved.length === 0) return null;

  const categoryOf = (i: ExistingIssueLike): ComplaintCategory =>
    i.category ? normalizeComplaintCategory(i.category) : inferComplaintCategoryFromText(`${i.title ?? ""} ${i.description ?? ""}`);

  // 1) Same category (both known, both equal) — the most recently updated wins
  //    (issues arrive newest-first from storage; keep that order).
  if (verdict.category !== "other") {
    const sameCat = unresolved.find((i) => categoryOf(i) === verdict.category);
    if (sameCat) return sameCat.id;
  }

  // 2) Keyword overlap against the issue's title+description (handles the
  //    "other" bucket and category drift). Require a concrete shared token.
  const wanted = matchedKeywords.filter((k) => k && k !== "not working").map((k) => k.toLowerCase());
  if (wanted.length > 0) {
    const overlap = unresolved.find((i) => {
      const hay = `${i.title ?? ""} ${i.description ?? ""}`.toLowerCase();
      return wanted.some((k) => hay.includes(k));
    });
    if (overlap) return overlap.id;
  }

  return null;
}

// ── Note / issue text builders ──────────────────────────────────────────────
function channelSuffix(channel?: string | null): string {
  const c = String(channel ?? "").trim();
  return c ? ` · via ${c}` : "";
}

// The timestamped note appended to an existing issue when the same problem is
// mentioned again. The guest's verbatim words are quoted so the operator sees
// exactly what was said; the marker makes it idempotent.
export function buildComplaintCommentBody(opts: {
  guestMessage: string;
  postIso: string;
  channel?: string | null;
}): string {
  const quote = quoteGuestMessage(opts.guestMessage);
  return `Auto-detected follow-up from the guest${channelSuffix(opts.channel)}:\n${quote}\n${messageMarker(opts.postIso)}`;
}

// The description for a NEWLY-opened auto issue.
export function buildComplaintIssueDescription(opts: {
  verdict: ComplaintVerdict;
  guestMessage: string;
  postIso: string;
  channel?: string | null;
}): string {
  const summary = opts.verdict.summary ? `${opts.verdict.summary}\n\n` : "";
  const quote = quoteGuestMessage(opts.guestMessage);
  return `${summary}Auto-detected from the guest inbox${channelSuffix(opts.channel)}:\n${quote}\n${messageMarker(opts.postIso)}`;
}

function quoteGuestMessage(message: string): string {
  const trimmed = String(message ?? "").replace(/\s+$/g, "").trim();
  const capped = trimmed.length > 1000 ? trimmed.slice(0, 1000) + "…" : trimmed;
  return capped
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

// ── Parse an auto-detected note body back into its parts (for display) ───────
// The stored body is machine-formatted (see the two builders above): an optional
// summary paragraph, an "Auto-detected …" heading carrying the channel, the
// guest's verbatim message quoted line-by-line with "> ", and a trailing
// [msg:<iso>] idempotency marker. The UI must NOT show the raw "> " prefixes or
// the marker, so this reverses the format into structured pieces the panel can
// render nicely. Kept here (next to the builders) so the two can never drift.
//
// A human-typed note (no heading, no marker) is NOT auto-detected: everything is
// returned as `summary` with no quoted lines, and the panel renders it plainly.
export type ParsedComplaintNote = {
  /** True when the body carries the auto-scanner's structured shape. */
  isAutoDetected: boolean;
  /** Free-text lead before the "Auto-detected …" heading (issue descriptions carry the Claude summary here); null when absent. */
  summary: string | null;
  /** The channel the guest message arrived on (e.g. "homeaway2"), or null. */
  channel: string | null;
  /** The guest's verbatim message lines, with the "> " quote prefix removed. Blank lines are preserved as "". */
  quotedLines: string[];
  /** ISO timestamp the guest sent the message (from [msg:…]), or null. */
  messageIso: string | null;
};

const AUTO_COMPLAINT_HEADING_RE =
  /^Auto-detected (?:follow-up from the guest|from the guest inbox)(?: · via (.+?))?:\s*$/;
const MESSAGE_MARKER_RE = /\[msg:([^\]]+)\]/;

export function parseComplaintNote(body: string | null | undefined): ParsedComplaintNote {
  const raw = String(body ?? "");

  // Pull the guest-send timestamp out of the marker, then strip every marker
  // occurrence (and the whitespace it leaves behind) from the visible text.
  const markerMatch = raw.match(MESSAGE_MARKER_RE);
  const messageIso = markerMatch ? markerMatch[1].trim() : null;
  const withoutMarker = raw.replace(/[ \t]*\[msg:[^\]]+\][ \t]*/g, "").replace(/\n{3,}/g, "\n\n");

  const lines = withoutMarker.split("\n");
  const headingIdx = lines.findIndex((l) => AUTO_COMPLAINT_HEADING_RE.test(l.trim()));

  if (headingIdx < 0) {
    // Not the auto-scanner shape (human-typed note). Render as-is.
    const text = withoutMarker.trim();
    return {
      isAutoDetected: false,
      summary: text || null,
      channel: null,
      quotedLines: [],
      messageIso,
    };
  }

  const headingMatch = lines[headingIdx].trim().match(AUTO_COMPLAINT_HEADING_RE);
  const channel = headingMatch?.[1]?.trim() || null;

  const summary = lines.slice(0, headingIdx).join("\n").trim() || null;
  const quotedLines = lines
    .slice(headingIdx + 1)
    .filter((l) => /^>/.test(l))
    .map((l) => l.replace(/^>\s?/, ""));

  return { isAutoDetected: true, summary, channel, quotedLines, messageIso };
}

// ── Scanner persisted state (app_settings) ──────────────────────────────────
// One JSON blob tracks the one-time backfill progress + the incremental
// watermark so a redeploy resumes instead of re-scanning the whole inbox.
export type ComplaintScanState = {
  backfillComplete: boolean;
  // Count of oldest conversations already scanned during backfill — an index into
  // the createdAt-ascending inbox (stable across ticks: createdAt never changes and
  // new threads append at the end). Guesty's conversations endpoint rejects `skip`
  // and its cursor is unreliable, so the whole inbox is fetched in ONE large-`limit`
  // request and sliced by this count rather than server-paginated.
  backfillDoneCount: number;
  // Newest guest-post time (ms) the scanner has already considered. Incremental
  // runs only look at conversations/posts newer than this.
  watermarkMs: number;
  lastRunAt: string | null;
};

export const EMPTY_SCAN_STATE: ComplaintScanState = {
  backfillComplete: false,
  backfillDoneCount: 0,
  watermarkMs: 0,
  lastRunAt: null,
};

export function parseComplaintScanState(raw: string | null | undefined): ComplaintScanState {
  if (!raw) return { ...EMPTY_SCAN_STATE };
  try {
    const o = JSON.parse(raw) as Partial<ComplaintScanState>;
    return {
      backfillComplete: o.backfillComplete === true,
      backfillDoneCount: Number.isFinite(o.backfillDoneCount) ? Math.max(0, Number(o.backfillDoneCount)) : 0,
      watermarkMs: Number.isFinite(o.watermarkMs) ? Math.max(0, Number(o.watermarkMs)) : 0,
      lastRunAt: typeof o.lastRunAt === "string" ? o.lastRunAt : null,
    };
  } catch {
    return { ...EMPTY_SCAN_STATE };
  }
}

export function serializeComplaintScanState(state: ComplaintScanState): string {
  return JSON.stringify(state);
}
