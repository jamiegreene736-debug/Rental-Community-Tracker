// Push-outcome reconciliation against the durable per-tab Guesty push ledger
// (2026-07-14). THE INCIDENT: the operator's Descriptions push succeeded
// server-side in 111s (a Guesty 429 rate-limit pause held the global request
// gate for ~2 minutes before the PUT could run), the ledger recorded
// "7 description fields pushed · success", but the browser silently lost the
// long-lived HTTP response — so the button sat on "Pushing…" forever even
// though the push had landed on Guesty.
//
// The fix: the client no longer trusts the POST response as the ONLY signal.
// It snapshots the ledger's descriptions entry BEFORE pushing (the baseline),
// then races the POST against a slow poll of the ledger. Whichever confirms
// first wins; a lost/hung/killed response resolves from the ledger instead of
// stranding the UI. Baselines compare SERVER timestamps to SERVER timestamps,
// so client clock skew can never mis-read an old entry as fresh.
//
// Pure decision logic only — no fetch/DOM here so it stays unit-testable.

import type { GuestyPushEntry, GuestyPushStatus } from "./guesty-push-history";

// How often the client re-reads the ledger while the push request is still
// unresolved. Deliberately slow — the ledger GET is cheap but there's no
// reason to hammer it; a push that needs reconciling is already minutes-slow.
export const PUSH_RECONCILE_POLL_MS = 5_000;

// Total client-side patience for one push. The server's worst honest case is
// two gated Guesty calls behind back-to-back 429 pauses (120s cap each) plus
// queue depth — ~5 minutes. Past this we stop waiting and report honestly.
export const PUSH_RECONCILE_DEADLINE_MS = 6 * 60_000;

export type PushReconcileOutcome = {
  status: GuestyPushStatus;
  summary: string;
  pushedAt: string;
};

// Loose input shape: ledger GET responses come off the wire, so tolerate
// missing/odd fields instead of trusting the type.
export type PushLedgerEntryLike = Partial<GuestyPushEntry> | null | undefined;

export function pushEntryTimeMs(entry: PushLedgerEntryLike): number | null {
  if (!entry || typeof entry.pushedAt !== "string") return null;
  const ms = new Date(entry.pushedAt).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// A ledger entry counts as THIS push's outcome only when it is strictly newer
// than the pre-push baseline (or any entry at all when no baseline existed).
// Entries with unparseable timestamps or unknown statuses never match — a
// malformed ledger row must not flip the UI either way.
export function freshPushOutcome(
  baselineMs: number | null,
  entry: PushLedgerEntryLike,
): PushReconcileOutcome | null {
  const entryMs = pushEntryTimeMs(entry);
  if (entryMs == null) return null;
  if (baselineMs != null && entryMs <= baselineMs) return null;
  const status = entry?.status;
  if (status !== "success" && status !== "error") return null;
  return {
    status,
    summary: typeof entry?.summary === "string" ? entry.summary : "",
    pushedAt: new Date(entryMs).toISOString(),
  };
}

// Operator-facing copy for the honest give-up path. The push may STILL land
// after this (the server keeps working) — say so instead of implying failure.
export function pushReconcileTimeoutMessage(tabLabel: string): string {
  return (
    `The ${tabLabel} push is taking unusually long (Guesty may be rate-limiting requests). ` +
    `It may still complete in the background — check this tab's "Pushed" stamp in a minute before retrying.`
  );
}
