// Pure presentation helpers for the headless find-run panel (2026-07-20 log-UI
// redesign): event grouping, the report-echo filter, and the safe markdown
// block parser.
import {
  classifyFindRunEvent,
  findRunGuestVerdictBadge,
  formatFindRunDuration,
  isFinalReportEcho,
  parseFindRunReport,
  parseReportInline,
} from "../shared/claude-find-run-display";
import type { ClaudeFindRunEvent } from "../shared/claude-find-run";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

const ev = (kind: ClaudeFindRunEvent["kind"], text: string): ClaudeFindRunEvent => ({ at: "2026-07-20T21:34:00Z", kind, text });

console.log("claude-find-run-display: event grouping");
check("buy-in create is a MILESTONE", classifyFindRunEvent(ev("action", "Creating a buy-in record via the portal")).isMilestone === true);
check("attach is a MILESTONE", classifyFindRunEvent(ev("action", "Attaching a buy-in to the reservation")).isMilestone === true);
check("verdict record is a MILESTONE", classifyFindRunEvent(ev("action", "Recording the guest-expectation verdict")).isMilestone === true);
check("a web search is its own group, not a milestone", (() => { const d = classifyFindRunEvent(ev("action", "Searching the web: menehune shores")); return d.group === "search" && !d.isMilestone; })());
check("browse chatter is DIMMED noise", (() => { const d = classifyFindRunEvent(ev("action", "Browser: close page")); return d.group === "browse" && d.dim === true; })());
check("opening a page is dimmed browse", classifyFindRunEvent(ev("action", "Opening https://www.vrbo.com/search")).dim === true);
check("the agent's note is a note", classifyFindRunEvent(ev("note", "Menehune Shores has no 2BR — going city-wide.")).group === "note");
check("a lifecycle status is lifecycle", classifyFindRunEvent(ev("status", "Runner finished after 16 min.")).group === "lifecycle");
check("an error is an error", classifyFindRunEvent(ev("error", "Browser did not attach")).group === "error");

console.log("claude-find-run-display: final-report echo filter");
{
  const report = "---\n## Final Report — Buy-In Find Run\n**Reservation:** 6a357 | Guest: Jacelyn Tsu\n\n### Search Summary\nMenehune Shores direct search: none; city-wide fallback.";
  // The runner captures the final message as a 400-char note too.
  const echoNote = ev("note", report.replace(/\s+/g, " ").trim().slice(0, 400));
  check("the note that duplicates the report is flagged as an echo", isFinalReportEcho(echoNote, report) === true);
  check("a normal narration note is NOT an echo", isFinalReportEcho(ev("note", "Comparing bedding layouts now."), report) === false);
  check("no report → never an echo", isFinalReportEcho(echoNote, null) === false);
  check("a non-note event is never an echo", isFinalReportEcho(ev("action", report.slice(0, 200)), report) === false);
  check("a short note is not treated as an echo", isFinalReportEcho(ev("note", "Done."), report) === false);
}

console.log("claude-find-run-display: inline bold");
check("plain text → one non-bold span", (() => { const s = parseReportInline("just text"); return s.length === 1 && !s[0].bold && s[0].text === "just text"; })());
check("**bold** is split out", (() => {
  const s = parseReportInline("price is **$1,400** total");
  return s.length === 3 && s[0].text === "price is " && s[1].bold && s[1].text === "$1,400" && s[2].text === " total";
})());
check("no markdown chars survive as literal asterisks", !parseReportInline("**Reservation:** 6a357").some((x) => x.text.includes("**")));

console.log("claude-find-run-display: report block parser");
{
  const md = [
    "---",
    "## Final Report — Buy-In Find Run",
    "**Reservation:** 6a357 | Guest: Jacelyn Tsu | 5 nights",
    "",
    "### Search Summary",
    "Menehune Shores direct search: **No 2BR units available**.",
    "City-wide fallback activated.",
    "",
    "| Listing | Price (5 nts) | Complex | Sleeps |",
    "|---|---|---|---|",
    "| Maui Banyan A-202 | **$1,400** | Maui Banyan | 8 |",
    "| Luana Kai C307 | $1,968 | Luana Kai | 7 |",
    "",
    "- Unit A: Maui Banyan A-202 — $1,400",
    "- Unit B: Luana Kai C307 — $1,968",
  ].join("\n");
  const blocks = parseFindRunReport(md);
  const types = blocks.map((b) => b.type);
  check("hr, heading, paragraph, table, list are all recognised", ["hr", "heading", "paragraph", "table", "list"].every((t) => types.includes(t)), types);
  const heading = blocks.find((b) => b.type === "heading");
  check("heading keeps its level + text", heading?.type === "heading" && heading.level === 2 && heading.spans.map((s) => s.text).join("") === "Final Report — Buy-In Find Run");
  const table = blocks.find((b) => b.type === "table");
  check("table header has 4 columns", table?.type === "table" && table.header.length === 4);
  check("table separator row is dropped", table?.type === "table" && table.rows.length === 2);
  check("table cell keeps inline bold", (() => {
    if (table?.type !== "table") return false;
    const priceCell = table.rows[0][1];
    return priceCell.length === 1 && priceCell[0].bold && priceCell[0].text === "$1,400";
  })());
  const list = blocks.find((b) => b.type === "list");
  check("list has 2 items", list?.type === "list" && list.items.length === 2);
  check("empty report → no blocks", parseFindRunReport("").length === 0 && parseFindRunReport(null).length === 0);
  check("a plain paragraph with no markdown still parses", (() => {
    const b = parseFindRunReport("just a plain sentence with no markup");
    return b.length === 1 && b[0].type === "paragraph";
  })());
}

console.log("claude-find-run-display: duration + verdict badge");
check("duration in minutes", formatFindRunDuration("2026-07-20T21:18:00Z", "2026-07-20T21:34:00Z") === "16 min");
check("duration in seconds under a minute", formatFindRunDuration("2026-07-20T21:18:00Z", "2026-07-20T21:18:45Z") === "45s");
check("no end → empty duration", formatFindRunDuration("2026-07-20T21:18:00Z", null) === "");
check("end before start → empty (clock skew safe)", formatFindRunDuration("2026-07-20T21:34:00Z", "2026-07-20T21:18:00Z") === "");
check("happy verdict badge", findRunGuestVerdictBadge("happy")?.tone === "good");
check("concerns verdict badge", findRunGuestVerdictBadge("concerns")?.tone === "attention");
check("unhappy verdict badge", findRunGuestVerdictBadge("unhappy")?.tone === "bad");
check("unknown verdict → no badge", findRunGuestVerdictBadge("maybe") === null && findRunGuestVerdictBadge(null) === null);

console.log(`\nclaude-find-run-display: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
