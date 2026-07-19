// Presentation helpers for the headless find-run panel — pure, browser-safe,
// unit-tested. The panel used to render the event stream as one undifferentiated
// monospace wall (browser noise, agent narration, and the API milestones all
// looked identical) with the final report ALSO leaking in as a 400-char log
// line, then repeated verbatim below. This module gives the panel the three
// things it needs to read like a report instead of a log tail:
//   1. classifyFindRunEvent — a display GROUP per event so the feed can style
//      milestones (buy-in created / attached / verdict recorded) as section
//      markers, dim the noisy browse steps, and quote the agent's own notes.
//   2. isFinalReportEcho — drop the note that merely duplicates the report.
//   3. parseFindRunReport — the agent's markdown report → safe block
//      descriptors (heading/paragraph/list/table/hr + inline bold) the client
//      renders as real elements. No HTML string is ever produced, so there is
//      no injection surface even though the text is agent-authored.

import type { ClaudeFindRunEvent } from "./claude-find-run";

export type FindRunEventGroup =
  | "milestone" // a portal write the operator cares about (created/attached/verdict)
  | "search" // a web search
  | "browse" // opening/fetching a page — high-volume noise, dimmed
  | "note" // the agent's own narration
  | "error" // a failure line
  | "lifecycle"; // runner started/finished/stopped

export interface FindRunEventDisplay {
  group: FindRunEventGroup;
  /** Milestones read as section markers; the panel gives them a rule + weight. */
  isMilestone: boolean;
  /** Browse chatter is dimmed so the meaningful lines stand out. */
  dim: boolean;
}

// The exact action strings describeToolUse() emits for the portal writes. Kept
// in sync with daemon/vrbo-sidecar/claude-find-runner.mjs (source-guarded in
// tests) — these are the run's real checkpoints, so they anchor the feed.
const MILESTONE_TEXTS = [
  "Creating a buy-in record via the portal",
  "Attaching a buy-in to the reservation",
  "Recording the guest-expectation verdict",
];

export function classifyFindRunEvent(event: ClaudeFindRunEvent): FindRunEventDisplay {
  const text = String(event?.text ?? "");
  if (event?.kind === "error") return { group: "error", isMilestone: false, dim: false };
  if (event?.kind === "note") return { group: "note", isMilestone: false, dim: false };
  if (event?.kind === "status") {
    return { group: "lifecycle", isMilestone: false, dim: false };
  }
  // action
  if (MILESTONE_TEXTS.some((m) => text.startsWith(m))) {
    return { group: "milestone", isMilestone: true, dim: false };
  }
  if (text.startsWith("Searching the web")) {
    return { group: "search", isMilestone: false, dim: false };
  }
  // Opening / Fetching / Browser: … — the high-volume page churn.
  return { group: "browse", isMilestone: false, dim: true };
}

function collapseWhitespace(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The agent's final message is captured BOTH as the last "note" event (the
 * runner truncates it to 400 chars) and as the run's report. Rendering both is
 * the duplicated "## Final Report …" line the operator saw. This flags the
 * echo so the feed can drop it — the full report renders on its own below.
 */
export function isFinalReportEcho(event: ClaudeFindRunEvent, report: string | null | undefined): boolean {
  if (!report || event?.kind !== "note") return false;
  const note = collapseWhitespace(event.text);
  if (note.length < 24) return false; // too short to be a report echo
  const normalizedReport = collapseWhitespace(report);
  // The note is a leading slice of the report — compare on a generous prefix
  // (the note is capped at 400, so match the shorter of the two, minus slack).
  const probe = note.slice(0, Math.min(note.length, 180));
  return normalizedReport.startsWith(probe);
}

// ── report markdown → safe block descriptors ────────────────────────────────

export interface ReportInlineSpan {
  text: string;
  bold: boolean;
}
export type ReportBlock =
  | { type: "heading"; level: number; spans: ReportInlineSpan[] }
  | { type: "paragraph"; spans: ReportInlineSpan[] }
  | { type: "list"; items: ReportInlineSpan[][] }
  | { type: "table"; header: ReportInlineSpan[][]; rows: ReportInlineSpan[][][] }
  | { type: "hr" };

/** Split a line into bold / plain inline spans (**bold** only — no nesting). */
export function parseReportInline(text: string): ReportInlineSpan[] {
  const raw = String(text ?? "");
  if (!raw) return [];
  const spans: ReportInlineSpan[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) spans.push({ text: raw.slice(last, m.index), bold: false });
    spans.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < raw.length) spans.push({ text: raw.slice(last), bold: false });
  return spans.length ? spans : [{ text: raw, bold: false }];
}

const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_SEP = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/; // |---|:--:|
const HEADING = /^(#{1,4})\s+(.*)$/;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^\s*[-*]\s+(.*)$/;

function splitTableCells(line: string): string[] {
  const inner = TABLE_ROW.exec(line)?.[1] ?? "";
  return inner.split("|").map((c) => c.trim());
}

/**
 * Parse the agent's markdown report into a small, safe block grammar the panel
 * renders as React elements. Deliberately minimal — it covers exactly what
 * these reports use (headings, bold, pipe tables, bullet lists, rules,
 * paragraphs). Anything unrecognised falls through as paragraph text, never
 * dropped and never interpreted as HTML.
 */
export function parseFindRunReport(markdown: string | null | undefined): ReportBlock[] {
  const src = String(markdown ?? "").replace(/\r\n/g, "\n");
  if (!src.trim()) return [];
  const lines = src.split("\n");
  const blocks: ReportBlock[] = [];
  let para: string[] = [];
  let list: string[] = [];
  let table: string[] = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: "paragraph", spans: parseReportInline(para.join(" ")) });
      para = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      blocks.push({ type: "list", items: list.map((i) => parseReportInline(i)) });
      list = [];
    }
  };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.map(splitTableCells);
    const dataRows = rows.filter((_, i) => !TABLE_SEP.test(table[i]));
    const header = dataRows.length ? dataRows[0] : [];
    const body = dataRows.slice(1);
    blocks.push({
      type: "table",
      header: header.map((c) => parseReportInline(c)),
      rows: body.map((r) => r.map((c) => parseReportInline(c))),
    });
    table = [];
  };
  const flushAll = () => { flushPara(); flushList(); flushTable(); };

  for (const line of lines) {
    if (TABLE_ROW.test(line)) {
      flushPara(); flushList();
      table.push(line);
      continue;
    }
    // not a table row → close any open table
    if (table.length) flushTable();

    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (HR.test(line)) { flushAll(); blocks.push({ type: "hr" }); continue; }
    const h = HEADING.exec(line);
    if (h) { flushAll(); blocks.push({ type: "heading", level: h[1].length, spans: parseReportInline(h[2]) }); continue; }
    const b = BULLET.exec(line);
    if (b) { flushPara(); list.push(b[1]); continue; }
    // plain paragraph line
    flushList();
    para.push(line.trim());
  }
  flushAll();
  return blocks;
}

// ── outcome + timing summaries ──────────────────────────────────────────────

/** "16 min", "45s", or "" when the timing isn't known. */
export function formatFindRunDuration(startIso: string | null | undefined, endIso: string | null | undefined): string {
  const start = startIso ? Date.parse(startIso) : NaN;
  const end = endIso ? Date.parse(endIso) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "";
  const secs = Math.round((end - start) / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.round(secs / 60)} min`;
}

export interface FindRunGuestVerdictBadge {
  label: string;
  icon: "happy" | "concerns" | "unhappy";
  tone: "good" | "attention" | "bad";
}

/** Map the recorded guest-expectation verdict to a badge, or null if none. */
export function findRunGuestVerdictBadge(verdict: string | null | undefined): FindRunGuestVerdictBadge | null {
  switch (String(verdict ?? "").trim().toLowerCase()) {
    case "happy":
      return { label: "Guest happy", icon: "happy", tone: "good" };
    case "concerns":
      return { label: "Guest concerns", icon: "concerns", tone: "attention" };
    case "unhappy":
      return { label: "Guest not happy", icon: "unhappy", tone: "bad" };
    default:
      return null;
  }
}
