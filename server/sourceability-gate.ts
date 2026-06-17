// Sourceability gate — auto-block windows Airbnb can't supply the units for.
//
// THE PROBLEM (operator, 2026-06-15): the buy-in model sells inventory we
// don't own yet. If, by the time we try to source the real units, the unit
// sizes the listing is built from simply aren't available, we've sold a stay
// we can't fulfil. The honest fix is to STOP SELLING windows we can't source,
// i.e. BLOCK them on the Guesty calendar.
//
// THE RULE (operator directive, supersedes the original VRBO/profit gate): the
// black-out is decided PURELY by live Airbnb availability. Per near-term
// window we run ONE SearchAPI Airbnb search per required bedroom size for the
// exact dates (checkAirbnbAvailabilityForPlan). If Airbnb has at least one of
// EVERY required size (a 5BR = 3BR + 2BR needs an available 3BR AND an
// available 2BR), the window stays OPEN; only when a size is unavailable do we
// block. No VRBO, no profit/combo math, no pricing-comp confidence.
//
// THIS MODULE: a scheduled sweep that, per property, walks the near-term
// windows, runs the Airbnb availability check, decides block / open / skip per
// window, then reconciles those decisions to Guesty via sync-scanner-blocks
// (PUT unavailable / available), tracking only the blocks WE create.
//
// LOAD-BEARING SAFETY — fail-safe is OPEN. A search that is keyless, errored,
// or rate-limited yields "skip": we neither block nor unblock that window. We
// only BLOCK on a SUCCESSFUL Airbnb search that confirms a required size is
// unavailable. The asymmetry is deliberate: a false block silently kills real
// revenue, so we never block on doubt.

import { PROPERTY_UNIT_CONFIGS } from "@shared/property-units";
import {
  checkAirbnbAvailabilityForPlan,
  analyzeAirbnbPlanForProfit,
  assumedComboCost,
  clearAirbnbCellCache,
} from "./availability-search";
import { reconcileSourceabilityBlocks, type SyncResult } from "./sync-scanner-blocks";
import { storage } from "./storage";
import { guestyRequest } from "./guesty-sync";
import {
  decideAvailabilitySourceability,
  decideSourceabilityWithProfit,
  generateWeeklyWindows,
  applyConfirmation,
  confirmedAction,
  DEFAULT_CONFIRM_SWEEPS,
  type AvailabilityScan,
  type SourceabilityDecision,
} from "./sourceability-gate-core";

// Re-export the pure decision core so existing importers keep working.
export { decideAvailabilitySourceability, generateWeeklyWindows, applyConfirmation, confirmedAction } from "./sourceability-gate-core";
export type { AvailabilityScan, SourceabilityDecision } from "./sourceability-gate-core";

// ── Config (env-tunable; defaults are conservative) ──────────────────────────
const num = (v: string | undefined, d: number) => {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};
const flag = (v: string | undefined) => v === "1" || v === "true";

/** Master switch. Default OFF so the deploy is inert until explicitly enabled. */
export function isSourceabilityGateEnabled(): boolean {
  return flag(process.env.SOURCEABILITY_GATE_ENABLED);
}
/** When false (default) the sweep is a DRY RUN: it computes + records intent but
 *  does NOT push blocks/unblocks to Guesty. Flip on to actually enforce. */
export function isSourceabilityGateEnforced(): boolean {
  return flag(process.env.SOURCEABILITY_GATE_ENFORCE);
}
const HORIZON_DAYS = () => num(process.env.SOURCEABILITY_GATE_HORIZON_DAYS, 90);
const MIN_LEAD_DAYS = () => num(process.env.SOURCEABILITY_GATE_MIN_LEAD_DAYS, 3);
const SCAN_BUDGET = () => num(process.env.SOURCEABILITY_GATE_SCAN_BUDGET, 12);
/** How many CONSECUTIVE sweeps must agree before we block/unblock Guesty. ≥2
 *  makes the gate immune to a single noisy/partial Airbnb search. */
const CONFIRM_SWEEPS = () => Math.max(1, num(process.env.SOURCEABILITY_GATE_CONFIRM_SWEEPS, DEFAULT_CONFIRM_SWEEPS));

// ── Profit-aware gate (operator direction 2026-06-17; default OFF — inert) ────
// When enabled, the gate also blocks SOURCEABLE windows whose assumed buy-in
// cost (the HIGH END of same-community Airbnb rates, computed FREE from the same
// availability fetch) beats our real Guesty sell price. Default OFF so the
// deploy changes nothing until the operator reviews a dry-run and flips it on.
export function isSourceabilityProfitEnabled(): boolean {
  return flag(process.env.SOURCEABILITY_GATE_PROFIT_ENABLED);
}
/** "High end" percentile for the assumed buy-in cost (operator's pick: p90). */
const COST_PERCENTILE = () => {
  const n = num(process.env.SOURCEABILITY_GATE_COST_PERCENTILE, 0.9);
  return n > 0 && n <= 1 ? n : 0.9;
};
/** Require sell to beat cost by this fraction. 0 ⇒ block only on an outright loss. */
const MIN_MARGIN = () => Math.max(0, num(process.env.SOURCEABILITY_GATE_MIN_MARGIN, 0));

// Our own Guesty listing names (nicknames + titles), fetched once and cached, so
// the cost pool can EXCLUDE our own listings (they surface in the Airbnb results
// at our own asking price and would pin assumedCost ≈ sellPrice).
let _ownNamesCache: { at: number; names: string[] } | null = null;
async function getOwnListingNames(): Promise<string[]> {
  if (_ownNamesCache && Date.now() - _ownNamesCache.at < 60 * 60 * 1000) return _ownNamesCache.names;
  try {
    const data: any = await guestyRequest("GET", "/listings?limit=200&fields=_id%20title%20nickname");
    const rows: any[] = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
    const names = rows
      .flatMap((r) => [r?.nickname, r?.title])
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0);
    _ownNamesCache = { at: Date.now(), names };
    return names;
  } catch (e: any) {
    console.warn(`[sourceability-gate] own-listing names fetch failed: ${e?.message ?? e}`);
    return _ownNamesCache?.names ?? [];
  }
}

// Our real sell price for a window = sum of the per-night Guesty calendar
// `price` over the 7 nights. null on any error / missing day ⇒ caller treats
// profit as not-assessable and fail-safe-OPENs (never blocks on a missing price).
async function sellPriceForWindow(listingId: string, startDate: string, endDate: string): Promise<number | null> {
  try {
    const data: any = await guestyRequest(
      "GET",
      `/availability-pricing/api/calendar/listings/${listingId}?startDate=${startDate}&endDate=${endDate}`,
    );
    const days: any[] = Array.isArray(data?.days) ? data.days
      : Array.isArray(data?.data?.days) ? data.data.days
      : Array.isArray(data) ? data : [];
    let total = 0, counted = 0;
    for (const d of days) {
      const date = String(d?.date ?? "").slice(0, 10);
      if (date >= startDate && date < endDate) {
        const price = Number(d?.price);
        if (Number.isFinite(price) && price > 0) { total += price; counted++; }
      }
    }
    return counted > 0 ? total : null;
  } catch (e: any) {
    console.warn(`[sourceability-gate] sell price fetch failed (${listingId} ${startDate}): ${e?.message ?? e}`);
    return null;
  }
}

// ── The sweep (IO) ───────────────────────────────────────────────────────────
export type SourceabilitySweepReport = {
  propertyId: number;
  community: string | null;
  enabled: boolean;
  enforced: boolean;
  dryRun: boolean;
  scans: number;
  decisions: Array<{
    startDate: string;
    endDate: string;
    decision: SourceabilityDecision;        // this sweep's raw scan decision
    action?: "block" | "open" | "pending";  // confirmed action after N-sweep streak
    streak?: number;                        // consecutive count toward the confirm threshold
    reason: string;
  }>;
  confirmThreshold: number;
  blockedCount: number;   // CONFIRMED blocks acted on this sweep
  openCount: number;      // CONFIRMED opens acted on this sweep
  pendingCount: number;   // scanned, decided, but not yet confirmed (calendar untouched)
  skippedCount: number;
  sync: (SyncResult & { wouldCreate?: number; wouldRemove?: number }) | null;
  note?: string;
};

export async function runSourceabilitySweepForProperty(
  propertyId: number,
  opts: {
    /** Force the sweep even when the master flag is off (manual endpoint). */
    force?: boolean;
    /** Override enforcement (true ⇒ push to Guesty, false ⇒ dry-run). Defaults
     *  to the SOURCEABILITY_GATE_ENFORCE env. */
    enforce?: boolean;
    now?: Date;
    scanBudget?: number;
    /** Our own Guesty listing names to exclude from the profit cost pool.
     *  Prefetched once by the all-sweep; lazily fetched here if omitted. */
    ownNames?: string[];
  } = {},
): Promise<SourceabilitySweepReport> {
  const enabled = isSourceabilityGateEnabled();
  const enforce = opts.enforce ?? isSourceabilityGateEnforced();
  const confirmThreshold = CONFIRM_SWEEPS();
  const base: SourceabilitySweepReport = {
    propertyId, community: null, enabled, enforced: enforce, dryRun: !enforce,
    scans: 0, decisions: [], confirmThreshold,
    blockedCount: 0, openCount: 0, pendingCount: 0, skippedCount: 0, sync: null,
  };

  if (!enabled && !opts.force) return { ...base, note: "sourceability gate disabled (SOURCEABILITY_GATE_ENABLED unset)" };

  const config = PROPERTY_UNIT_CONFIGS[propertyId];
  if (!config) return { ...base, note: `no unit config for property ${propertyId}` };

  const community = config.community;
  const units = config.units.map((u) => ({ bedrooms: u.bedrooms }));
  const budget = opts.scanBudget ?? SCAN_BUDGET();
  const windows = generateWeeklyWindows(opts.now ?? new Date(), MIN_LEAD_DAYS(), HORIZON_DAYS());

  // Profit-aware mode (default OFF): resolve the cost pool exclusions, this
  // listing's id for the sell-price lookup, and the cost knobs once per property.
  const profitOn = isSourceabilityProfitEnabled();
  const ownNames = profitOn ? (opts.ownNames ?? (await getOwnListingNames())) : [];
  const guestyListingId = profitOn ? await storage.getGuestyListingId(propertyId).catch(() => null) : null;
  const costPct = COST_PERCENTILE();
  const minMargin = MIN_MARGIN();

  const toBlock: Array<{ startDate: string; endDate: string; reason: string }> = [];
  const confirmedOpen: Array<{ startDate: string; endDate: string }> = [];
  const decisions: SourceabilitySweepReport["decisions"] = [];
  let scans = 0;

  for (const w of windows) {
    if (scans >= budget) {
      decisions.push({ startDate: w.startDate, endDate: w.endDate, decision: "skip", reason: "scan budget exhausted" });
      continue;
    }

    let scan: AvailabilityScan;
    let d: { decision: SourceabilityDecision; reason: string };
    let obsCost: number | null = null;
    let obsSell: number | null = null;
    try {
      if (profitOn) {
        // Profit-aware: ONE analysis derives both availability AND the high-end
        // assumed buy-in cost from the same fetch; the sell price comes from our
        // Guesty calendar. Cost/sell missing ⇒ the decision fail-safe-OPENs.
        const analysis = await analyzeAirbnbPlanForProfit({
          community, unitSlots: units, checkIn: w.startDate, checkOut: w.endDate,
          ownNames, costPercentile: costPct,
        });
        scans++;
        scan = { ok: analysis.ok, setsAvailable: analysis.setsAvailable, detail: analysis.detail };
        if (analysis.ok) {
          obsCost = assumedComboCost(units, analysis.highEndNightlyBySize, w.nights);
          obsSell = guestyListingId ? await sellPriceForWindow(guestyListingId, w.startDate, w.endDate) : null;
        }
        d = decideSourceabilityWithProfit(scan, { assumedCost: obsCost, sellPrice: obsSell, minMargin });
      } else {
        const avail = await checkAirbnbAvailabilityForPlan({
          community,
          unitSlots: units,
          checkIn: w.startDate,
          checkOut: w.endDate,
        });
        scans++;
        scan = { ok: avail.ok, setsAvailable: avail.setsAvailable, detail: avail.detail };
        d = decideAvailabilitySourceability(scan);
      }
    } catch (e: any) {
      // Search threw → fail-safe skip (neither block nor unblock).
      decisions.push({ startDate: w.startDate, endDate: w.endDate, decision: "skip", reason: `airbnb search error: ${(e?.message ?? String(e)).slice(0, 120)}` });
      continue;
    }

    // CONFIRMATION GUARD: fold this search's decision into the persisted streak,
    // and only act on Guesty once the SAME decision has repeated `confirmThreshold`
    // times in a row — so a single noisy/partial search can't move the calendar.
    const prev = await storage.getSourceabilityObservation(propertyId, w.startDate, w.endDate).catch(() => null);
    const nextState = applyConfirmation(
      { consecutiveBlocks: prev?.consecutiveBlocks ?? 0, consecutiveOpens: prev?.consecutiveOpens ?? 0 },
      d.decision,
    );
    await storage.upsertSourceabilityObservation({
      propertyId, startDate: w.startDate, endDate: w.endDate,
      consecutiveBlocks: nextState.consecutiveBlocks, consecutiveOpens: nextState.consecutiveOpens,
      lastDecision: d.decision, lastCheapestCost: obsCost,
      lastSellableRevenue: obsSell, lastReason: d.reason,
    }).catch((e) => console.error(`[sourceability-gate] persist obs failed (${propertyId} ${w.startDate}):`, e?.message ?? e));

    const action = confirmedAction(nextState, confirmThreshold);
    const streak = d.decision === "block" ? nextState.consecutiveBlocks
      : d.decision === "open" ? nextState.consecutiveOpens : 0;
    decisions.push({
      startDate: w.startDate, endDate: w.endDate, decision: d.decision, action, streak,
      reason: `${d.reason} · ${d.decision}=${streak}/${confirmThreshold} → ${action}`,
    });
    if (action === "block") toBlock.push({ startDate: w.startDate, endDate: w.endDate, reason: d.reason });
    else if (action === "open") confirmedOpen.push({ startDate: w.startDate, endDate: w.endDate });
    // action === "pending" ⇒ scanned + decided, but not yet confirmed: leave the calendar untouched.
  }

  const sync = await reconcileSourceabilityBlocks({
    propertyId,
    desired: toBlock,
    confirmedOpen,
    dryRun: !enforce,
  });

  return {
    ...base,
    community,
    scans,
    decisions,
    confirmThreshold,
    blockedCount: toBlock.length,
    openCount: confirmedOpen.length,
    pendingCount: decisions.filter((d) => d.action === "pending").length,
    skippedCount: decisions.filter((d) => d.decision === "skip").length,
    sync,
  };
}

// ── All-property sweep (the scheduled entry point) ───────────────────────────
let _sweepInFlight = false;
let _lastSweepReport: { at: string; properties: number; blocked: number; removed: number } | null = null;

export function getLastSourceabilitySweepReport() {
  return _lastSweepReport;
}

/**
 * Sweep every real (positive-id) property that has a Guesty listing mapped.
 * The black-out check is pure SearchAPI Airbnb (no sidecar), so the sweep runs
 * independently of the operator's buy-in queue. Guarded by a single-flight
 * latch so a fast scheduler tick can't stack sweeps.
 */
export async function runSourceabilitySweepAllEnabled(
  opts: { enforce?: boolean; now?: Date } = {},
): Promise<{ ran: boolean; reason?: string; reports: SourceabilitySweepReport[] }> {
  if (!isSourceabilityGateEnabled()) return { ran: false, reason: "disabled", reports: [] };
  if (_sweepInFlight) return { ran: false, reason: "already running", reports: [] };

  _sweepInFlight = true;
  const reports: SourceabilitySweepReport[] = [];
  try {
    // Tidy: drop confirmation rows for windows that have already passed.
    const todayIso = (opts.now ?? new Date()).toISOString().slice(0, 10);
    await storage.deleteSourceabilityObservationsEndingBefore(todayIso).catch(() => {});
    // Fresh fetches per sweep (so each sweep is an independent observation for the
    // 2-sweep guard), but shared WITHIN the sweep so same-community properties
    // dedup to one SearchApi call per (town, size, week).
    clearAirbnbCellCache();
    const ownNames = isSourceabilityProfitEnabled() ? await getOwnListingNames().catch(() => []) : undefined;
    const propertyIds = Object.keys(PROPERTY_UNIT_CONFIGS).map(Number).filter((id) => id > 0);
    for (const propertyId of propertyIds) {
      const listingId = await storage.getGuestyListingId(propertyId).catch(() => null);
      if (!listingId) continue;
      try {
        reports.push(await runSourceabilitySweepForProperty(propertyId, { enforce: opts.enforce, now: opts.now, ownNames }));
      } catch (e: any) {
        console.error(`[sourceability-gate] property ${propertyId} sweep failed:`, e?.message ?? e);
      }
    }
    _lastSweepReport = {
      at: new Date().toISOString(),
      properties: reports.length,
      blocked: reports.reduce((s, r) => s + (r.sync?.created ?? 0), 0),
      removed: reports.reduce((s, r) => s + (r.sync?.removed ?? 0), 0),
    };
    return { ran: true, reports };
  } finally {
    _sweepInFlight = false;
  }
}
