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
// Long-running photo pushes also supply an operation ID so an overlapping
// background push can never resolve the wrong browser request. Entries with
// unparseable timestamps or unknown statuses never match.
export function freshPushOutcome(
  baselineMs: number | null,
  entry: PushLedgerEntryLike,
  expectedOperationId?: string,
): PushReconcileOutcome | null {
  const entryMs = pushEntryTimeMs(entry);
  if (entryMs == null) return null;
  if (baselineMs != null && entryMs <= baselineMs) return null;
  if (expectedOperationId && entry?.operationId !== expectedOperationId) return null;
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

// ── Photos push: reconcile after a mid-stream connection cut ────────────────
// (2026-07-14 second incident, same class as the descriptions one above.)
// THE INCIDENT: a 51-photo manual push with AI upscale ran ~16 minutes
// server-side (every photo was sub-1920px, so each cost a ~30s Real-ESRGAN
// call before ImgBB + the Guesty PUTs). Railway's edge hard-cuts EVERY
// response at exactly 900,000 ms (15 minutes) of total duration — even while
// NDJSON progress lines are actively streaming — so the browser lost the
// stream at ~45/51, showed "✗ failed", and the server then finished, verified
// 51/51 on Guesty, and ledger-stamped SUCCESS a minute later. The old NDJSON
// comment ("no timeout possible") was simply wrong at the edge layer.
//
// The client reconciles a lost stream against the photos ledger entry, with a
// deadline scaled to how many photos the server still had left when the
// stream died: each remaining photo can honestly cost up to ~ESRGAN 30-40s +
// validation + ImgBB retries (~60s worst case), plus a base allowance for the
// final PUT + the 3-attempt verify ladder. Floor = the descriptions deadline
// (never LESS patient than the simple case); cap keeps a wedged server from
// pinning the UI for an hour.
export const PHOTO_PUSH_RECONCILE_BASE_MS = 2 * 60_000;
export const PHOTO_PUSH_RECONCILE_PER_PHOTO_MS = 60_000;
export const PHOTO_PUSH_RECONCILE_MAX_MS = 45 * 60_000;

export function photoPushReconcileDeadlineMs(remainingPhotos: number): number {
  const remaining = Number.isFinite(remainingPhotos)
    ? Math.max(0, Math.ceil(remainingPhotos))
    : 0;
  const scaled = PHOTO_PUSH_RECONCILE_BASE_MS + remaining * PHOTO_PUSH_RECONCILE_PER_PHOTO_MS;
  return Math.min(PHOTO_PUSH_RECONCILE_MAX_MS, Math.max(PUSH_RECONCILE_DEADLINE_MS, scaled));
}

// Shown in the push progress UI while the ledger poll runs. Honest about what
// happened (the connection dropped, not the push) and what the client is
// doing about it.
// Only blame the 15-minute edge cap when ~15 minutes actually elapsed
// (operator confusion 2026-07-22: a drop after ONE photo carried the edge-cap
// explanation, which reads like a systemic failure — an early drop is almost
// always a network blip or the browser pausing the tab, and the push itself
// is unaffected either way).
export const PUSH_EDGE_CAP_BLAME_MS = 14 * 60_000;

export function photoPushStreamLostMessage(seen: number, total: number, elapsedMs?: number): string {
  const progress = total > 0 ? ` after ${Math.min(seen, total)} of ${total} photos` : "";
  const cause =
    typeof elapsedMs === "number" && elapsedMs >= 0 && elapsedMs < PUSH_EDGE_CAP_BLAME_MS
      ? "(usually a brief network blip or the browser pausing the tab)"
      : "(long pushes exceed the hosting edge's 15-minute response limit)";
  return (
    `The connection to the server dropped${progress} ${cause}. ` +
    `The server is still pushing in the background — watching the push ledger for the result…`
  );
}
