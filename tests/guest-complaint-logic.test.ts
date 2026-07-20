import assert from "node:assert/strict";

import {
  COMPLAINT_CATEGORIES,
  normalizeComplaintCategory,
  complaintKindForCategory,
  complaintKeywordSignal,
  looksLikeComplaint,
  heuristicComplaintVerdict,
  parseClaudeComplaintClassification,
  inferComplaintCategoryFromText,
  matchExistingComplaintIssue,
  messageMarker,
  textReferencesMessage,
  messageAlreadyCaptured,
  buildComplaintCommentBody,
  buildComplaintIssueDescription,
  parseComplaintNote,
  parseComplaintScanState,
  serializeComplaintScanState,
  EMPTY_SCAN_STATE,
  AUTO_COMPLAINT_AUTHOR,
  AUTO_COMPLAINT_ROLE,
  AUTO_COMPLAINT_SOURCE,
  type ComplaintVerdict,
} from "../shared/guest-complaint-logic";

console.log("guest-complaint-logic suite");

// ── attribution constants ──
assert.equal(AUTO_COMPLAINT_AUTHOR, "auto-scan");
assert.equal(AUTO_COMPLAINT_ROLE, "system");
assert.equal(AUTO_COMPLAINT_SOURCE, "auto-scan");
console.log("  ✓ auto-scan attribution constants are stable");

// ── categories ──
assert.ok(COMPLAINT_CATEGORIES.includes("maintenance"));
assert.equal(normalizeComplaintCategory("NOISE"), "noise");
assert.equal(normalizeComplaintCategory("gibberish"), "other");
assert.equal(normalizeComplaintCategory(null), "other");
console.log("  ✓ category normalization");

// ── keyword signal: complaints trip, logistics do not ──
assert.ok(complaintKeywordSignal("The AC is broken and it's boiling in here").matched.length > 0);
assert.ok(looksLikeComplaint("there are cockroaches in the kitchen"));
assert.ok(looksLikeComplaint("the shower does not work at all")); // negated-function phrase
assert.ok(looksLikeComplaint("the wifi is not working"));
// Benign logistics / positive feedback must NOT look like complaints.
assert.equal(looksLikeComplaint("What time is check-in?"), false);
assert.equal(looksLikeComplaint("Can I bring my dog? Is early check-in possible?"), false);
assert.equal(looksLikeComplaint("Thank you so much, the place was perfect!"), false);
assert.equal(looksLikeComplaint("Where should we park the rental car?"), false);
console.log("  ✓ keyword/heuristic gate separates complaints from logistics");

// ── severity escalation ──
assert.equal(complaintKeywordSignal("we are locked out and can't get in").severity, "urgent");
assert.equal(complaintKeywordSignal("there is a bed bug in the bedroom").severity, "urgent");
assert.equal(complaintKeywordSignal("small stain on the couch").severity, "low");
console.log("  ✓ severity escalates for urgent classes");

// ── heuristic verdict ──
const hv = heuristicComplaintVerdict("The kitchen sink is leaking everywhere");
assert.equal(hv.isComplaint, true);
assert.equal(hv.category, "maintenance");
assert.equal(hv.source, "heuristic");
assert.ok(hv.title.length > 0);
const hvClean = heuristicComplaintVerdict("What's the wifi password?");
assert.equal(hvClean.isComplaint, false);
console.log("  ✓ heuristic verdict flags real problems, clears benign");

// ── Claude classification parsing ──
const parsed = parseClaudeComplaintClassification({
  isComplaint: true, severity: "high", category: "cleanliness", title: "Dirty towels on arrival", summary: "The towels were dirty when the guest arrived.",
});
assert.ok(parsed);
assert.equal(parsed!.isComplaint, true);
assert.equal(parsed!.category, "cleanliness");
assert.equal(parsed!.severity, "high");
assert.equal(parsed!.source, "claude");
// snake_case + bad enums degrade safely
const parsed2 = parseClaudeComplaintClassification({ is_complaint: true, severity: "nuclear", category: "weird", title: "", summary: "" });
assert.equal(parsed2!.isComplaint, true);
assert.equal(parsed2!.severity, "normal");
assert.equal(parsed2!.category, "other");
assert.ok(parsed2!.title.length > 0); // falls back to a category title
assert.equal(parseClaudeComplaintClassification("nope"), null);
assert.equal(parseClaudeComplaintClassification({ isComplaint: false }).isComplaint, false);
// overly long titles are clamped
const longTitle = parseClaudeComplaintClassification({ isComplaint: true, title: "x".repeat(400) });
assert.ok(longTitle!.title.length <= 121);
console.log("  ✓ Claude JSON parses, snake_case + bad enums degrade safely");

// ── category inference from free text (no DB column) ──
assert.equal(inferComplaintCategoryFromText("AC not cooling in the master bedroom"), "maintenance");
assert.equal(inferComplaintCategoryFromText("noisy neighbors kept us up"), "noise");
assert.equal(inferComplaintCategoryFromText("Nice weather question"), "other");
console.log("  ✓ category inferred from issue text");

// ── KIND: property vs back-office ──
assert.ok(COMPLAINT_CATEGORIES.includes("cancellation"));
assert.equal(complaintKindForCategory("billing"), "back_office");
assert.equal(complaintKindForCategory("cancellation"), "back_office");
for (const c of ["maintenance", "cleanliness", "noise", "access", "safety", "amenities", "other"] as const) {
  assert.equal(complaintKindForCategory(c), "property");
}
// Refund + cancellation requests trip the gate and land back-office.
assert.ok(looksLikeComplaint("Can I get a refund for last night?"));
assert.equal(complaintKeywordSignal("I'd like a refund please").category, "billing");
assert.ok(looksLikeComplaint("We need to cancel our reservation"));
assert.equal(complaintKeywordSignal("I want to cancel my booking").category, "cancellation");
assert.equal(heuristicComplaintVerdict("I want a refund").kind, "back_office");
assert.equal(heuristicComplaintVerdict("the AC is broken").kind, "property");
assert.equal(parseClaudeComplaintClassification({ isComplaint: true, category: "cancellation", title: "wants to cancel" })!.kind, "back_office");
console.log("  ✓ billing/cancellation → back_office; property categories → property");

// ── matchExistingComplaintIssue: dedup by category + KIND, ignore resolved ──
const verdictMaint: ComplaintVerdict = { isComplaint: true, severity: "high", category: "maintenance", kind: "property", title: "AC out again", summary: "", source: "claude" };
const issues = [
  { id: 10, status: "resolved", title: "AC not cooling", description: "" },       // resolved → ignored
  { id: 11, status: "open", title: "AC not cooling in bedroom", description: "" }, // unresolved maintenance → match
  { id: 12, status: "ongoing", title: "Noisy pool at night", description: "" },
];
assert.equal(matchExistingComplaintIssue(verdictMaint, issues, ["ac not working"]), 11);
// A back-office (billing) verdict must NOT fold into a property issue — different kind.
const verdictBilling: ComplaintVerdict = { isComplaint: true, severity: "normal", category: "billing", kind: "back_office", title: "Overcharged", summary: "", source: "claude" };
assert.equal(matchExistingComplaintIssue(verdictBilling, issues, ["overcharged"]), null);
// …but it DOES fold into an existing unresolved back-office issue (same kind).
assert.equal(
  matchExistingComplaintIssue(verdictBilling, [{ id: 20, status: "open", kind: "back_office", title: "Billing / refund request", description: "wants a refund" }], ["refund"]),
  20,
);
// A property verdict ignores a same-keyword back-office issue.
const verdictCancel: ComplaintVerdict = { isComplaint: true, severity: "normal", category: "cancellation", kind: "back_office", title: "Cancellation request", summary: "", source: "claude" };
assert.equal(matchExistingComplaintIssue(verdictCancel, [{ id: 21, status: "open", kind: "property", title: "Noise", description: "" }], []), null);
// Only a RESOLVED matching issue exists → new one (fresh occurrence).
assert.equal(matchExistingComplaintIssue(verdictMaint, [{ id: 5, status: "resolved", title: "AC not cooling", description: "" }], ["ac"]), null);
// "other" category still matches via keyword overlap against title/description.
const verdictOther: ComplaintVerdict = { isComplaint: true, severity: "normal", category: "other", kind: "property", title: "problem", summary: "", source: "heuristic" };
assert.equal(matchExistingComplaintIssue(verdictOther, [{ id: 7, status: "open", title: "Guest complaint", description: "the balcony railing is loose" }], ["railing"]), 7);
assert.equal(matchExistingComplaintIssue(verdictOther, [], []), null);
// A manual Back-Office TASK ("call the PM company for arrival details") must
// NEVER absorb scanner complaints — even when its text would match by category
// inference or keyword overlap. kindOf's legacy-row inference cannot claim it.
assert.equal(
  matchExistingComplaintIssue(
    verdictMaint,
    [{ id: 30, status: "open", kind: "back_office_task", title: "AC not cooling — call HVAC vendor", description: "ac not working per guest" }],
    ["ac not working"],
  ),
  null,
);
assert.equal(
  matchExistingComplaintIssue(
    verdictBilling,
    [{ id: 31, status: "open", kind: "back_office_task", title: "Refund follow-up with PM billing dept", description: "chase the refund" }],
    ["refund"],
  ),
  null,
);
console.log("  ✓ dedup matches unresolved same-category+kind, ignores resolved/other-kind/tasks, opens new otherwise");

// ── idempotency markers ──
const iso = "2026-07-09T10:00:00.000Z";
assert.equal(messageMarker(iso), `[msg:${iso}]`);
assert.equal(textReferencesMessage(`note ${messageMarker(iso)}`, iso), true);
assert.equal(textReferencesMessage("unrelated note", iso), false);
assert.equal(
  messageAlreadyCaptured(iso, [
    { description: "opened from inbox " + messageMarker(iso), comments: [] },
  ]),
  true,
);
assert.equal(
  messageAlreadyCaptured(iso, [
    { description: "some other issue", comments: [{ body: "follow-up " + messageMarker(iso) }] },
  ]),
  true,
);
assert.equal(messageAlreadyCaptured(iso, [{ description: "x", comments: [{ body: "y" }] }]), false);
console.log("  ✓ message marker makes create/append idempotent");

// ── note / description builders quote the guest + carry the marker ──
const note = buildComplaintCommentBody({ guestMessage: "AC still broken!!", postIso: iso, channel: "airbnb2" });
assert.ok(note.includes("> AC still broken!!"));
assert.ok(note.includes(messageMarker(iso)));
assert.ok(note.includes("airbnb2"));
const desc = buildComplaintIssueDescription({
  verdict: verdictMaint, guestMessage: "The AC has been broken since check-in", postIso: iso, channel: null,
});
assert.ok(desc.includes("> The AC has been broken since check-in"));
assert.ok(desc.includes(messageMarker(iso)));
console.log("  ✓ builders quote the guest verbatim + stamp the marker");

// ── parseComplaintNote: reverse the stored body into display parts ──
// Round-trip a NEW-issue description: summary lead + verbatim quote + marker.
const descBody = buildComplaintIssueDescription({
  verdict: { isComplaint: true, severity: "normal", category: "maintenance", title: "Bathtub clogged", summary: "The bathtub in the main bedroom is clogged.", source: "claude" },
  guestMessage: "Hi,\n\nThe bathtub to the main bedroom is clogged and drains very slowly.",
  postIso: iso,
  channel: "homeaway2",
});
const parsedDesc = parseComplaintNote(descBody);
assert.equal(parsedDesc.isAutoDetected, true);
assert.equal(parsedDesc.summary, "The bathtub in the main bedroom is clogged.");
assert.equal(parsedDesc.channel, "homeaway2");
assert.equal(parsedDesc.messageIso, iso);
// Verbatim lines have the "> " stripped; the blank paragraph break is preserved.
assert.deepEqual(parsedDesc.quotedLines, ["Hi,", "", "The bathtub to the main bedroom is clogged and drains very slowly."]);
// The raw marker + quote prefixes never survive into any display field.
assert.ok(!parsedDesc.quotedLines.some((l) => l.startsWith(">")));
assert.ok(!(parsedDesc.summary ?? "").includes("[msg:"));
assert.ok(!parsedDesc.quotedLines.join("\n").includes("[msg:"));

// Round-trip a follow-up COMMENT: no summary lead, quote + marker only.
const commentBody = buildComplaintCommentBody({ guestMessage: "It's still not draining!", postIso: iso, channel: "airbnb2" });
const parsedComment = parseComplaintNote(commentBody);
assert.equal(parsedComment.isAutoDetected, true);
assert.equal(parsedComment.summary, null);
assert.equal(parsedComment.channel, "airbnb2");
assert.equal(parsedComment.messageIso, iso);
assert.deepEqual(parsedComment.quotedLines, ["It's still not draining!"]);

// A no-channel description still parses (channel null).
const noChan = parseComplaintNote(buildComplaintIssueDescription({
  verdict: verdictMaint, guestMessage: "AC is broken", postIso: iso, channel: null,
}));
assert.equal(noChan.channel, null);
assert.equal(noChan.messageIso, iso);
assert.deepEqual(noChan.quotedLines, ["AC is broken"]);

// A human-typed note (no heading, no marker) is NOT auto-detected: whole text is
// the summary, nothing is treated as a quote.
const human = parseComplaintNote("Called the plumber, arriving tomorrow 9am.");
assert.equal(human.isAutoDetected, false);
assert.equal(human.summary, "Called the plumber, arriving tomorrow 9am.");
assert.deepEqual(human.quotedLines, []);
assert.equal(human.messageIso, null);
// Empty / null bodies degrade to an empty non-auto note.
assert.equal(parseComplaintNote("").summary, null);
assert.equal(parseComplaintNote(null).isAutoDetected, false);
console.log("  ✓ parseComplaintNote reverses stored bodies, strips markers/quotes, keeps human notes plain");

// ── scan state (de)serialization ──
assert.deepEqual(parseComplaintScanState(null), EMPTY_SCAN_STATE);
assert.deepEqual(parseComplaintScanState("not json"), EMPTY_SCAN_STATE);
const st = { backfillComplete: true, backfillDoneCount: 150, watermarkMs: 1720000000000, lastRunAt: iso };
assert.deepEqual(parseComplaintScanState(serializeComplaintScanState(st)), st);
// negative / garbage numbers clamp
const clamped = parseComplaintScanState(JSON.stringify({ backfillComplete: false, backfillDoneCount: -5, watermarkMs: "x", lastRunAt: 1 }));
assert.equal(clamped.backfillDoneCount, 0);
assert.equal(clamped.watermarkMs, 0);
assert.equal(clamped.lastRunAt, null);
console.log("  ✓ scan state round-trips + sanitizes");

console.log("guest-complaint-logic suite passed");
