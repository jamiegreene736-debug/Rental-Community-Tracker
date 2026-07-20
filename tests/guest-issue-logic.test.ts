import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  orderGuestIssuesResolvedLast,
  validateGuestIssueTitle,
  BACK_OFFICE_TASK_CONVERSATION_ID,
  isBackOfficeTaskConversationId,
} from "../shared/guest-issue-logic";

console.log("guest-issue-logic suite");

// ── status / severity constants ──
assert.deepEqual([...GUEST_ISSUE_STATUSES], ["open", "ongoing", "resolved"]);
assert.deepEqual([...GUEST_ISSUE_SEVERITIES], ["low", "normal", "high", "urgent"]);
assert.deepEqual([...GUEST_ISSUE_KINDS], ["property", "back_office", "back_office_task"]);
console.log("  ✓ status + severity + kind vocabularies are stable");

// ── kind guards / normalize / label ──
assert.equal(isGuestIssueKind("back_office"), true);
assert.equal(isGuestIssueKind("back_office_task"), true);
assert.equal(isGuestIssueKind("nope"), false);
assert.equal(normalizeGuestIssueKind(" Back_Office "), "back_office");
assert.equal(normalizeGuestIssueKind("Back_Office_Task"), "back_office_task");
assert.equal(normalizeGuestIssueKind("property"), "property");
assert.equal(normalizeGuestIssueKind("garbage"), "property"); // default
assert.equal(normalizeGuestIssueKind(undefined), "property");
assert.equal(guestIssueKindLabel("back_office"), "Back-office");
assert.equal(guestIssueKindLabel("back_office_task"), "Task");
assert.equal(guestIssueKindLabel("property"), "Property");
assert.equal(guestIssueKindLabel(""), "Property");
console.log("  ✓ kind guard/normalize/label");

// ── back-office task conversation sentinel ──
// The sentinel lets an operator-created task exist WITHOUT a guest thread while
// guest_issues.conversationId stays NOT NULL. It must never look like a real
// Guesty conversation id (those are hex ObjectIds).
assert.equal(BACK_OFFICE_TASK_CONVERSATION_ID, "back-office-tasks");
assert.equal(/^[0-9a-f]{24}$/.test(BACK_OFFICE_TASK_CONVERSATION_ID), false);
assert.equal(isBackOfficeTaskConversationId(BACK_OFFICE_TASK_CONVERSATION_ID), true);
assert.equal(isBackOfficeTaskConversationId("69ea7b4608e5bc000f8e89ef"), false);
assert.equal(isBackOfficeTaskConversationId(""), false);
assert.equal(isBackOfficeTaskConversationId(null), false);
console.log("  ✓ back-office task conversation sentinel");

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

// ── orderGuestIssuesResolvedLast: resolved sink, order stable, no mutation ──
const src = [
  { id: 1, status: "resolved" },
  { id: 2, status: "open" },
  { id: 3, status: "resolved" },
  { id: 4, status: "ongoing" },
];
const ordered = orderGuestIssuesResolvedLast(src);
assert.deepEqual(ordered.map((i) => i.id), [2, 4, 1, 3]); // unresolved keep order, resolved keep order, resolved last
assert.deepEqual(src.map((i) => i.id), [1, 2, 3, 4]); // input array untouched (not mutated)
assert.deepEqual(orderGuestIssuesResolvedLast([]).length, 0);
assert.deepEqual(orderGuestIssuesResolvedLast([{ id: 9, status: "open" }]).map((i) => i.id), [9]);
console.log("  ✓ orderGuestIssuesResolvedLast sinks resolved, stable, non-mutating");

// ── title validation ──
assert.equal(validateGuestIssueTitle("  AC broken  ").ok, true);
assert.deepEqual(validateGuestIssueTitle("  AC broken  "), { ok: true, title: "AC broken" });
assert.equal(validateGuestIssueTitle("").ok, false);
assert.equal(validateGuestIssueTitle(" a ").ok, false); // < 2 chars after trim
assert.equal(validateGuestIssueTitle("x".repeat(201)).ok, false);
assert.equal(validateGuestIssueTitle(undefined).ok, false);
console.log("  ✓ title validation enforces 2–200 chars");

// ── SOURCE GUARDS: Back-Office Tasks wiring (2026-07-20) ─────────────────────
// Tasks (kind "back_office_task") are operator-CREATED work assignments the
// agent team must SEE and resolve, while back-office ISSUES stay operator-only.
// These greps lock the visibility rules against a well-meaning "simplification".
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routesSrc = readFileSync(path.join(repoRoot, "server", "routes.ts"), "utf8");
const storageSrc = readFileSync(path.join(repoRoot, "server", "storage.ts"), "utf8");
const panelSrc = readFileSync(
  path.join(repoRoot, "client", "src", "components", "GuestIssuesPanel.tsx"),
  "utf8",
);
const inboxSrc = readFileSync(path.join(repoRoot, "client", "src", "pages", "inbox.tsx"), "utf8");

// 1) List route: agents are stripped of back_office rows but KEEP tasks — the
//    old blanket `if (isAgentRole) kind = "property"` must not come back.
assert.ok(
  routesSrc.includes('if (isAgentRole && kind === "back_office") kind = "property";'),
  "routes.ts must coerce ONLY an agent's back_office kind (tasks stay agent-visible)",
);
assert.ok(
  routesSrc.includes('isAgentRole ? fetched.filter((i) => i.kind !== "back_office") : fetched'),
  "routes.ts list route must strip back_office rows (and only those) for the agent role",
);

// 2) Create route: an omitted conversationId on a TASK falls back to the shared
//    sentinel; agents can never create tasks (kind coerced to property first).
assert.ok(
  routesSrc.includes('if (!conversationId && kind === "back_office_task") conversationId = BACK_OFFICE_TASK_CONVERSATION_ID;'),
  "routes.ts create route must default a task's missing conversationId to the sentinel",
);
assert.ok(
  routesSrc.includes('const kind = isAgentRole ? "property" : normalizeGuestIssueKind(req.body?.kind);'),
  "routes.ts create route must coerce the agent role to kind property (no agent-created tasks)",
);

// 3) Storage kind filter accepts the task kind (else the tab shows everything).
assert.ok(
  storageSrc.includes('opts.kind === "back_office_task"'),
  "storage.listGuestIssues must filter by the back_office_task kind",
);

// 4) Client: the tasks tab exists for BOTH roles (no isAgent gate on its
//    trigger), creation is admin-gated via canCreate, and the sentinel hides
//    the open-conversation link.
assert.ok(
  inboxSrc.includes('data-testid="tab-back-office-tasks"'),
  "inbox.tsx must render the Back-Office Tasks tab trigger",
);
assert.ok(
  inboxSrc.includes('kind="back_office_task"') && inboxSrc.includes("canCreate={isAdmin}"),
  "inbox.tsx must mount GuestIssuesTab kind=back_office_task with admin-only creation",
);
assert.ok(
  panelSrc.includes("!isBackOfficeTaskConversationId(issue.conversationId)"),
  "GuestIssuesPanel must hide the open-conversation link on sentinel-conversation tasks",
);
assert.ok(
  panelSrc.includes('kind: "back_office_task"'),
  "GuestIssuesTab's New-task form must POST kind back_office_task",
);
console.log("  ✓ source guards: Back-Office Tasks visibility + creation wiring");

console.log("guest-issue-logic suite passed");
