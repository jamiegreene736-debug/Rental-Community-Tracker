import assert from "node:assert/strict";

import {
  GUEST_ISSUE_STATUSES,
  GUEST_ISSUE_SEVERITIES,
  GUEST_ISSUE_KINDS,
  isGuestIssueStatus,
  isGuestIssueSeverity,
  isGuestIssueKind,
  normalizeGuestIssueStatus,
  normalizeGuestIssueSeverity,
  normalizeGuestIssueKind,
  guestIssueKindLabel,
  resolvedAtForStatus,
  isGuestIssueUnresolved,
  defaultCommentBodyForStatus,
  guestIssueStatusLabel,
  guestIssueSeverityLabel,
  summarizeGuestIssueStatuses,
  validateGuestIssueTitle,
} from "../shared/guest-issue-logic";

console.log("guest-issue-logic suite");

// ── status / severity constants ──
assert.deepEqual([...GUEST_ISSUE_STATUSES], ["open", "ongoing", "resolved"]);
assert.deepEqual([...GUEST_ISSUE_SEVERITIES], ["low", "normal", "high", "urgent"]);
assert.deepEqual([...GUEST_ISSUE_KINDS], ["property", "back_office"]);
console.log("  ✓ status + severity + kind vocabularies are stable");

// ── kind guards / normalize / label ──
assert.equal(isGuestIssueKind("back_office"), true);
assert.equal(isGuestIssueKind("nope"), false);
assert.equal(normalizeGuestIssueKind(" Back_Office "), "back_office");
assert.equal(normalizeGuestIssueKind("property"), "property");
assert.equal(normalizeGuestIssueKind("garbage"), "property"); // default
assert.equal(normalizeGuestIssueKind(undefined), "property");
assert.equal(guestIssueKindLabel("back_office"), "Back-office");
assert.equal(guestIssueKindLabel("property"), "Property");
assert.equal(guestIssueKindLabel(""), "Property");
console.log("  ✓ kind guard/normalize/label");

// ── type guards ──
assert.equal(isGuestIssueStatus("ongoing"), true);
assert.equal(isGuestIssueStatus("closed"), false);
assert.equal(isGuestIssueStatus(3), false);
assert.equal(isGuestIssueSeverity("urgent"), true);
assert.equal(isGuestIssueSeverity("critical"), false);
console.log("  ✓ type guards accept only known values");

// ── normalizeGuestIssueStatus ──
assert.equal(normalizeGuestIssueStatus(" Resolved "), "resolved"); // trims + lowercases
assert.equal(normalizeGuestIssueStatus("OPEN"), "open");
assert.equal(normalizeGuestIssueStatus(""), null);
assert.equal(normalizeGuestIssueStatus("nope"), null);
assert.equal(normalizeGuestIssueStatus(undefined), null);
assert.equal(normalizeGuestIssueStatus(null), null);
console.log("  ✓ normalizeGuestIssueStatus coerces or rejects");

// ── normalizeGuestIssueSeverity ──
assert.equal(normalizeGuestIssueSeverity("HIGH"), "high");
assert.equal(normalizeGuestIssueSeverity(" low "), "low");
assert.equal(normalizeGuestIssueSeverity("bogus"), "normal"); // default
assert.equal(normalizeGuestIssueSeverity(undefined), "normal");
console.log("  ✓ normalizeGuestIssueSeverity defaults to normal");

// ── resolvedAt lifecycle ──
const now = new Date("2026-07-08T12:00:00Z");
assert.equal(resolvedAtForStatus("resolved", now)?.getTime(), now.getTime());
assert.equal(resolvedAtForStatus("ongoing", now), null); // reopen clears it
assert.equal(resolvedAtForStatus("open", now), null);
console.log("  ✓ resolvedAt is stamped only when resolved, cleared on reopen");

// ── isGuestIssueUnresolved ──
assert.equal(isGuestIssueUnresolved("open"), true);
assert.equal(isGuestIssueUnresolved("ongoing"), true);
assert.equal(isGuestIssueUnresolved("resolved"), false);
console.log("  ✓ open + ongoing count as unresolved");

// ── default comment bodies ──
assert.equal(defaultCommentBodyForStatus("resolved"), "Marked as resolved.");
assert.equal(defaultCommentBodyForStatus("ongoing"), "Marked as ongoing.");
assert.equal(defaultCommentBodyForStatus("open"), "Reopened.");
console.log("  ✓ status-only comments get a sensible default body");

// ── labels ──
assert.equal(guestIssueStatusLabel("ongoing"), "Ongoing");
assert.equal(guestIssueStatusLabel("resolved"), "Resolved");
assert.equal(guestIssueStatusLabel(""), "Open");
assert.equal(guestIssueSeverityLabel("urgent"), "Urgent");
assert.equal(guestIssueSeverityLabel(""), "Normal");
console.log("  ✓ labels render human-readable text");

// ── summarize ──
const counts = summarizeGuestIssueStatuses([
  { status: "open" },
  { status: "ongoing" },
  { status: "ongoing" },
  { status: "resolved" },
]);
assert.deepEqual(counts, { open: 1, ongoing: 2, resolved: 1, unresolved: 3, total: 4 });
assert.deepEqual(summarizeGuestIssueStatuses([]), {
  open: 0,
  ongoing: 0,
  resolved: 0,
  unresolved: 0,
  total: 0,
});
console.log("  ✓ summarizeGuestIssueStatuses rolls up counts");

// ── title validation ──
assert.equal(validateGuestIssueTitle("  AC broken  ").ok, true);
assert.deepEqual(validateGuestIssueTitle("  AC broken  "), { ok: true, title: "AC broken" });
assert.equal(validateGuestIssueTitle("").ok, false);
assert.equal(validateGuestIssueTitle(" a ").ok, false); // < 2 chars after trim
assert.equal(validateGuestIssueTitle("x".repeat(201)).ok, false);
assert.equal(validateGuestIssueTitle(undefined).ok, false);
console.log("  ✓ title validation enforces 2–200 chars");

console.log("guest-issue-logic suite passed");
