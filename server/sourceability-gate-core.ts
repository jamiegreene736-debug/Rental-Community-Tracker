// Sourceability gate — PURE decision core (no IO, no heavy imports).
//
// Split out from sourceability-gate.ts so the risk-bearing logic
// (block / open / skip) can be unit-tested without dragging in the server
// graph (storage, Airbnb search) that the full module imports.
//
// 2026-06-15 (operator directive): the calendar black-out is decided PURELY by
// live Airbnb availability — NO VRBO, no profit/combo math. A window is blocked
// only when a SearchAPI Airbnb search for those exact dates can't surface the
// unit sizes the listing is built from (e.g. a 5BR = 3BR + 2BR needs ≥1
// available 3BR AND ≥1 available 2BR). If Airbnb has them, the window stays
// OPEN.
//
// LOAD-BEARING: fail-safe is OPEN. A search that is keyless / errored / rate-
// limited yields "skip" — we never block or unblock on doubt. We only BLOCK
// when a SUCCESSFUL Airbnb search confirms a required unit size is unavailable.
// A false block silently kills real revenue, so the asymmetry is deliberate.

export type AvailabilityScan = {
  /** True only when the Airbnb search succeeded (API key present, no provider
   *  error). False ⇒ caller must treat the window as "skip" (fail-safe). */
  ok: boolean;
  /** How many COMPLETE unit-sets Airbnb can supply for the dates. A 3BR+2BR
   *  plan needs ≥1 available 3BR and ≥1 available 2BR ⇒ ≥1 set. 0 ⇒ at least
   *  one required size is unavailable on Airbnb for the window. */
  setsAvailable: number;
  /** Human detail for the observation row, e.g. "3BR×4, 2BR×9 → 4 set(s)". */
  detail?: string;
};

export type SourceabilityDecision = "block" | "open" | "skip";

/** The whole black-out decision: open when Airbnb can supply the unit set,
 *  block when a successful search shows it can't, skip on a failed search. */
export function decideAvailabilitySourceability(
  scan: AvailabilityScan,
): { decision: SourceabilityDecision; reason: string } {
  if (!scan.ok) {
    return { decision: "skip", reason: "Airbnb search unavailable — fail-safe, no calendar change" };
  }
  if (scan.setsAvailable >= 1) {
    return { decision: "open", reason: `Airbnb has the units (${scan.detail ?? "available"})` };
  }
  return { decision: "block", reason: `Airbnb has no available unit set for these dates (${scan.detail ?? "0 sets"})` };
}

// ── Profit-aware decision (operator direction 2026-06-17) ────────────────────
// Availability rarely binds in a liquid market; the real pain is PROFIT — a week
// sold far out that now costs more to source than we sold it for. This extends
// the availability decision with a loss branch driven by an assumed buy-in cost
// (the HIGH END of same-community Airbnb rates) vs our actual Guesty sell price.
//
// LOAD-BEARING fail-safes (revenue-preserving, same asymmetry as above):
//  - failed search ⇒ skip; no available set ⇒ block (unchanged availability rule).
//  - sourceable but cost/sell NOT assessable (no priced comps / no calendar
//    price) ⇒ OPEN, never block — we never close a window on missing profit data.
export type ProfitInputs = {
  assumedCost: number | null;   // high-end assumed buy-in cost for the combo, or null if unpriceable
  sellPrice: number | null;     // our real Guesty sell price for the window, or null if unavailable
  minMargin: number;            // require sell to beat cost by this fraction (0 = block only on an outright loss)
};

export function decideSourceabilityWithProfit(
  scan: AvailabilityScan,
  profit: ProfitInputs,
): { decision: SourceabilityDecision; reason: string } {
  if (!scan.ok) {
    return { decision: "skip", reason: "Airbnb search unavailable — fail-safe, no calendar change" };
  }
  if (scan.setsAvailable < 1) {
    return { decision: "block", reason: `Unsourceable: Airbnb has no available unit set (${scan.detail ?? "0 sets"})` };
  }
  const { assumedCost, sellPrice, minMargin } = profit;
  if (assumedCost == null || sellPrice == null || !(sellPrice > 0)) {
    return {
      decision: "open",
      reason: `Sourceable (${scan.detail ?? "available"}); profit not assessable (cost=${assumedCost ?? "?"}, sell=${sellPrice ?? "?"}) — open`,
    };
  }
  const ceiling = sellPrice * (1 - Math.max(0, minMargin));
  if (assumedCost > ceiling) {
    const marginNote = minMargin > 0 ? ` (−${Math.round(minMargin * 100)}% margin → $${Math.round(ceiling)})` : "";
    return { decision: "block", reason: `Loss: assumed buy-in $${Math.round(assumedCost)} > sell $${Math.round(sellPrice)}${marginNote}` };
  }
  return { decision: "open", reason: `Profitable: assumed buy-in $${Math.round(assumedCost)} ≤ sell $${Math.round(sellPrice)} (${scan.detail ?? "available"})` };
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

// ── UI status (what the operator sees per window) ────────────────────────────
export type ObservationStatus = "blocked" | "block-pending" | "sourceable" | "sourceable-pending" | "unknown";

/** Turn a window's persisted streaks into a human status + progress for the UI,
 *  e.g. "No Airbnb units 1/2 — 1 more sweep to block". `blockedOnGuesty`
 *  reflects whether a live block actually exists on the calendar for the window. */
export function classifyObservation(args: {
  consecutiveBlocks: number;
  consecutiveOpens: number;
  threshold: number;
  blockedOnGuesty: boolean;
}): { status: ObservationStatus; label: string; progress: { count: number; of: number } | null } {
  const t = Math.max(1, args.threshold);
  if (args.blockedOnGuesty) {
    return { status: "blocked", label: "Blocked on Guesty", progress: { count: t, of: t } };
  }
  if (args.consecutiveBlocks >= t) {
    return { status: "blocked", label: "No Airbnb units — blocking next enforced sweep", progress: { count: t, of: t } };
  }
  if (args.consecutiveBlocks >= 1) {
    const remaining = t - args.consecutiveBlocks;
    return {
      status: "block-pending",
      label: `No Airbnb units ${args.consecutiveBlocks}/${t} — ${remaining} more sweep${remaining === 1 ? "" : "s"} to block`,
      progress: { count: args.consecutiveBlocks, of: t },
    };
  }
  if (args.consecutiveOpens >= t) {
    return { status: "sourceable", label: "Available on Airbnb", progress: { count: t, of: t } };
  }
  if (args.consecutiveOpens >= 1) {
    return { status: "sourceable-pending", label: `Available on Airbnb ${args.consecutiveOpens}/${t}`, progress: { count: args.consecutiveOpens, of: t } };
  }
  return { status: "unknown", label: "Checking…", progress: null };
}
