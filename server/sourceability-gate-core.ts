// Sourceability gate — PURE decision core (no IO, no heavy imports).
//
// Split out from sourceability-gate.ts so the risk-bearing logic
// (block / open / skip) can be unit-tested without dragging in the server
// graph (storage, sidecar scan, bulk-queue) that the full module imports.
//
// LOAD-BEARING: fail-safe is OPEN. A scan that is offline / errored / empty
// yields "skip" — we never block or unblock on doubt. We only BLOCK on a
// CONFIRMED real pool whose cheapest sourceable combo is a confirmed loss.
// A false block silently kills real revenue, so the asymmetry is deliberate.

export type SourceabilityScan = {
  /** True only when the scan is trustworthy: sidecar online AND a real pool was
   *  harvested. False ⇒ caller must treat the window as "skip" (fail-safe). */
  ok: boolean;
  /** Cheapest sourceable same-community combo cost for the full stay, or null
   *  when a real pool was scanned but no same-community combo could be formed. */
  cheapestCost: number | null;
};

export type SourceabilityDecision = "block" | "open" | "skip";

export function decideSourceability(args: {
  scan: SourceabilityScan;
  /** What we'd sell the window for (stay total) = nightly basis × (1+margin) × nights. */
  sellableRevenue: number;
  /** Required margin as a fraction of cost. Default 0 ⇒ block on actual loss. */
  minMargin?: number;
}): { decision: SourceabilityDecision; reason: string; projectedProfit: number | null } {
  if (!args.scan.ok) {
    return { decision: "skip", reason: "scan unavailable/empty — fail-safe, no calendar change", projectedProfit: null };
  }
  const minMargin = Math.max(0, args.minMargin ?? 0);
  if (args.scan.cheapestCost == null) {
    return { decision: "block", reason: "no sourceable same-community combo in a real pool", projectedProfit: null };
  }
  const profit = args.sellableRevenue - args.scan.cheapestCost;
  const required = args.scan.cheapestCost * minMargin;
  if (profit < required) {
    return {
      decision: "block",
      reason: `unsourceable at a profit: cheapest combo $${Math.round(args.scan.cheapestCost)} vs sellable $${Math.round(args.sellableRevenue)} → profit $${Math.round(profit)}${minMargin > 0 ? ` (need ≥ $${Math.round(required)})` : ""}`,
      projectedProfit: profit,
    };
  }
  return { decision: "open", reason: `sourceable: profit $${Math.round(profit)}`, projectedProfit: profit };
}

/** Weekly 7-night windows from now+minLead out to now+horizon (UTC, YYYY-MM-DD). */
export function generateWeeklyWindows(
  now: Date,
  minLeadDays: number,
  horizonDays: number,
): Array<{ startDate: string; endDate: string; nights: number }> {
  const windows: Array<{ startDate: string; endDate: string; nights: number }> = [];
  const base = new Date(now);
  base.setUTCHours(12, 0, 0, 0);
  for (let offset = Math.max(0, minLeadDays); offset + 7 <= horizonDays; offset += 7) {
    const s = new Date(base);
    s.setUTCDate(s.getUTCDate() + offset);
    const e = new Date(s);
    e.setUTCDate(e.getUTCDate() + 7);
    windows.push({ startDate: s.toISOString().slice(0, 10), endDate: e.toISOString().slice(0, 10), nights: 7 });
  }
  return windows;
}

// ── Confirmation guard (immunity to single-scrape noise) ─────────────────────
// We observed the SAME window read −$8,664 (block) then +$5,045 (open) minutes
// apart — VRBO scrapes are noisy/partial. So the gate never acts on one scan:
// a window must produce the SAME decision in N CONSECUTIVE sweeps before we
// block/unblock it on Guesty. Random noise never reaches N-in-a-row; a genuine,
// persistent loss does. The streaks are persisted per window (survive deploys).
export const DEFAULT_CONFIRM_SWEEPS = 2;

export type ConfirmationState = { consecutiveBlocks: number; consecutiveOpens: number };

/** Fold this sweep's decision into the running streaks. "skip" carries NO
 *  evidence (failed/empty scan) and leaves both streaks unchanged — a failed
 *  scan must never reset a confirmation nor count toward one. */
export function applyConfirmation(prev: ConfirmationState, decision: SourceabilityDecision): ConfirmationState {
  if (decision === "block") return { consecutiveBlocks: prev.consecutiveBlocks + 1, consecutiveOpens: 0 };
  if (decision === "open") return { consecutiveBlocks: 0, consecutiveOpens: prev.consecutiveOpens + 1 };
  return { consecutiveBlocks: prev.consecutiveBlocks, consecutiveOpens: prev.consecutiveOpens };
}

/** The CONFIRMED action — only fires once a decision has repeated `threshold`
 *  times in a row. Until then the window is "pending" and the calendar is left
 *  exactly as it is. */
export function confirmedAction(state: ConfirmationState, threshold: number): "block" | "open" | "pending" {
  const t = Math.max(1, threshold);
  if (state.consecutiveBlocks >= t) return "block";
  if (state.consecutiveOpens >= t) return "open";
  return "pending";
}
