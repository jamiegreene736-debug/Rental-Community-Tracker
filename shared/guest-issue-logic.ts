// Pure, dependency-free helpers for the Guest Issues tracker in the guest inbox.
//
// A "guest issue" is a per-conversation problem log (maintenance, cleanliness,
// billing, access, noise, …) that the operator AND remote "agent" portal users
// can open, comment on, and move through a small lifecycle:
//
//   open  →  ongoing  →  resolved   (and back — a comment can reopen it)
//
// This module is shared between the server (status transitions, comment
// defaults, request validation) and the client (labels, open-count summary) so
// the two never drift. Keep it free of any Node / DB / React imports.

export const GUEST_ISSUE_STATUSES = ["open", "ongoing", "resolved"] as const;
export type GuestIssueStatus = (typeof GUEST_ISSUE_STATUSES)[number];

export const GUEST_ISSUE_SEVERITIES = ["low", "normal", "high", "urgent"] as const;
export type GuestIssueSeverity = (typeof GUEST_ISSUE_SEVERITIES)[number];

// A guest issue is filed under one of three KINDS, each its own inbox tab:
//   property         → Guest Issues       (maintenance, cleanliness, noise, access,
//                                          safety, amenities, directions, general)
//   back_office      → Back-Office Issues (refund requests, billing disputes,
//                                          cancellation requests) — OPERATOR-ONLY
//   back_office_task → Back-Office Tasks  (manual to-dos the OPERATOR creates for
//                                          the agent team to work and mark resolved,
//                                          e.g. "call the PM company for arrival
//                                          details") — agent-VISIBLE by design
export const GUEST_ISSUE_KINDS = ["property", "back_office", "back_office_task"] as const;
export type GuestIssueKind = (typeof GUEST_ISSUE_KINDS)[number];

// Back-office TASKS don't have to attach to a real Guesty conversation (the work
// is often "call/email a third party", not a guest thread). guest_issues.conversationId
// is NOT NULL, so unattached tasks carry this sentinel instead of a schema
// migration. Never a real Guesty conversation id (Guesty ids are hex ObjectIds),
// so it can't collide with the per-conversation panel's queries.
export const BACK_OFFICE_TASK_CONVERSATION_ID = "back-office-tasks";

/** True when an issue's conversationId is the unattached-task sentinel (no thread to open). */
export function isBackOfficeTaskConversationId(conversationId: unknown): boolean {
  return conversationId === BACK_OFFICE_TASK_CONVERSATION_ID;
}

export function isGuestIssueKind(value: unknown): value is GuestIssueKind {
  return typeof value === "string" && (GUEST_ISSUE_KINDS as readonly string[]).includes(value);
}

/** Coerce a client/DB value into a valid kind, defaulting to "property". */
export function normalizeGuestIssueKind(value: unknown): GuestIssueKind {
  if (typeof value !== "string") return "property";
  const v = value.trim().toLowerCase();
  return isGuestIssueKind(v) ? v : "property";
}

export function guestIssueKindLabel(kind: string): string {
  if (kind === "back_office_task") return "Task";
  return kind === "back_office" ? "Back-office" : "Property";
}

export function isGuestIssueStatus(value: unknown): value is GuestIssueStatus {
  return typeof value === "string" && (GUEST_ISSUE_STATUSES as readonly string[]).includes(value);
}

export function isGuestIssueSeverity(value: unknown): value is GuestIssueSeverity {
  return typeof value === "string" && (GUEST_ISSUE_SEVERITIES as readonly string[]).includes(value);
}

/**
 * Coerce a client-sent status change into a valid status, or null when it is
 * absent/blank/invalid (i.e. "this comment does not change the status").
 */
export function normalizeGuestIssueStatus(value: unknown): GuestIssueStatus | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return isGuestIssueStatus(v) ? v : null;
}

/** Coerce a client-sent severity into a valid value, defaulting to "normal". */
export function normalizeGuestIssueSeverity(value: unknown): GuestIssueSeverity {
  if (typeof value !== "string") return "normal";
  const v = value.trim().toLowerCase();
  return isGuestIssueSeverity(v) ? v : "normal";
}

/** A resolved issue carries a resolvedAt stamp; any other status clears it (reopen). */
export function resolvedAtForStatus(status: GuestIssueStatus, now: Date): Date | null {
  return status === "resolved" ? now : null;
}

/** Open OR ongoing = still needs attention; only "resolved" is done. */
export function isGuestIssueUnresolved(status: string): boolean {
  return status !== "resolved";
}

/** Default comment body when a remote agent flips status without typing anything. */
export function defaultCommentBodyForStatus(status: GuestIssueStatus): string {
  switch (status) {
    case "resolved":
      return "Marked as resolved.";
    case "ongoing":
      return "Marked as ongoing.";
    case "open":
      return "Reopened.";
  }
}

export function guestIssueStatusLabel(status: string): string {
  switch (status) {
    case "open":
      return "Open";
    case "ongoing":
      return "Ongoing";
    case "resolved":
      return "Resolved";
    default:
      return status || "Open";
  }
}

export function guestIssueSeverityLabel(severity: string): string {
  switch (severity) {
    case "low":
      return "Low";
    case "normal":
      return "Normal";
    case "high":
      return "High";
    case "urgent":
      return "Urgent";
    default:
      return severity || "Normal";
  }
}

export type GuestIssueStatusCounts = {
  open: number;
  ongoing: number;
  resolved: number;
  unresolved: number;
  total: number;
};

/** Roll up a list of issues into per-status counts (for the panel header badge). */
export function summarizeGuestIssueStatuses(issues: Array<{ status: string }>): GuestIssueStatusCounts {
  const counts: GuestIssueStatusCounts = { open: 0, ongoing: 0, resolved: 0, unresolved: 0, total: 0 };
  for (const issue of issues) {
    counts.total++;
    if (issue.status === "resolved") {
      counts.resolved++;
    } else if (issue.status === "ongoing") {
      counts.ongoing++;
      counts.unresolved++;
    } else {
      counts.open++;
      counts.unresolved++;
    }
  }
  return counts;
}

/**
 * Order issues so RESOLVED ones sink to the bottom, preserving the incoming
 * order within each group (storage returns newest-first). Used by the panel +
 * tab so a resolved issue — which the UI collapses to a compact row — never
 * pushes an active, still-needs-attention issue down the list. Pure + stable
 * (Array.prototype.sort is a stable sort in every supported runtime), and it
 * never mutates the caller's array.
 */
export function orderGuestIssuesResolvedLast<T extends { status: string }>(issues: T[]): T[] {
  return issues
    .slice()
    .sort((a, b) => Number(a.status === "resolved") - Number(b.status === "resolved"));
}

/** Server-side validation for a new issue's title (2–200 chars after trim). */
export function validateGuestIssueTitle(
  raw: unknown,
): { ok: true; title: string } | { ok: false; error: string } {
  const title = String(raw ?? "").trim();
  if (title.length < 2) return { ok: false, error: "Issue title is required" };
  if (title.length > 200) return { ok: false, error: "Issue title is too long (max 200 characters)" };
  return { ok: true, title };
}
