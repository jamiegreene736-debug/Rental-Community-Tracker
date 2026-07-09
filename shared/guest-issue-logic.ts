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

// A guest issue is filed under one of two KINDS, each its own inbox tab:
//   property    → Guest Issues        (maintenance, cleanliness, noise, access,
//                                       safety, amenities, directions, general)
//   back_office → Back-Office Issues   (refund requests, billing disputes,
//                                       cancellation requests)
export const GUEST_ISSUE_KINDS = ["property", "back_office"] as const;
export type GuestIssueKind = (typeof GUEST_ISSUE_KINDS)[number];

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

/** Server-side validation for a new issue's title (2–200 chars after trim). */
export function validateGuestIssueTitle(
  raw: unknown,
): { ok: true; title: string } | { ok: false; error: string } {
  const title = String(raw ?? "").trim();
  if (title.length < 2) return { ok: false, error: "Issue title is required" };
  if (title.length > 200) return { ok: false, error: "Issue title is too long (max 200 characters)" };
  return { ok: true, title };
}
