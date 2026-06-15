// Legacy scanner block cleanup helper.
//
// Availability now protects near-term/critical windows by raising rates,
// not by creating unavailable Guesty blocks. This module remains as the
// single cleanup path for old scanner-created blocks. Only rows tracked in
// scanner_blocks are cleared; human-placed Guesty blocks are never touched.

import { storage } from "./storage";
import { guestyRequest } from "./guesty-sync";

export type SyncWindow = {
  startDate: string;
  endDate: string;
  verdict: "blocked" | "available" | "tight" | "error";
  reason?: string;
  // Legacy fields surfaced for the human-facing manual sync flow.
  // Auto-publish path leaves them undefined.
  maxSets?: number;
  minSets?: number;
};

export type SyncResult = {
  success: boolean;
  propertyId: number;
  guestyListingId: string | null;
  created: number;
  removed: number;
  unchanged: number;
  failures: Array<{ action: string; startDate: string; error: string }>;
  reason?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function guestyCalendarPutWithRetry(
  path: string,
  body: Record<string, unknown>,
): Promise<any> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await guestyRequest("PUT", path, body);
    } catch (e: any) {
      lastError = e;
      const message = e?.message ?? String(e);
      if (!/429|too many requests|rate.?limit/i.test(message) || attempt === 5) throw e;
      await sleep(2_000 * attempt + Math.floor(Math.random() * 750));
    }
  }
  throw lastError;
}

export async function syncScannerBlocksForProperty(
  propertyId: number,
  _windows: SyncWindow[],
): Promise<SyncResult> {
  return clearScannerBlocksForProperty(propertyId);
}

export async function clearScannerBlocksForProperty(propertyId: number): Promise<SyncResult> {
  const guestyListingId = await storage.getGuestyListingId(propertyId);
  if (!guestyListingId) {
    return {
      success: false,
      propertyId,
      guestyListingId: null,
      created: 0,
      removed: 0,
      unchanged: 0,
      failures: [],
      reason: `No Guesty listing mapped for property ${propertyId}`,
    };
  }

  const active = await storage.getActiveScannerBlocks(propertyId);
  let removed = 0;
  const failures: SyncResult["failures"] = [];
  const calPath = `/availability-pricing/api/calendar/listings/${guestyListingId}`;

  for (const b of active) {
    try {
      await guestyCalendarPutWithRetry(calPath, {
        startDate: b.startDate,
        endDate: b.endDate,
        status: "available",
      });
      await storage.markScannerBlockRemoved(b.id);
      removed++;
      await sleep(750);
    } catch (e: any) {
      failures.push({ action: "remove", startDate: b.startDate, error: e?.message ?? String(e) });
    }
  }

  return {
    success: failures.length === 0,
    propertyId,
    guestyListingId,
    created: 0,
    removed,
    unchanged: Math.max(0, active.length - removed),
    failures,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Sourceability gate reconcile (2026-06-15). The sourceability gate
// (server/sourceability-gate.ts) decides, per near-term window, whether we
// can source the buy-in at a profit. This pushes those decisions to Guesty:
// BLOCK (status unavailable) windows we can't source, and RESTORE (status
// available) windows that became sourceable again — touching ONLY the blocks
// WE created (source = SOURCEABILITY_GATE_SOURCE), never human/legacy blocks.
//
// FAIL-SAFE: a window is only un-blocked when this pass CONFIRMED it sourceable
// (in confirmedOpen). A window whose scan failed/was skipped is NOT in
// confirmedOpen, so its block is LEFT in place — we never lift a block on doubt.
// ─────────────────────────────────────────────────────────────────────────
export const SOURCEABILITY_GATE_SOURCE = "sourceability-gate";

export async function reconcileSourceabilityBlocks(args: {
  propertyId: number;
  desired: Array<{ startDate: string; endDate: string; reason: string }>;
  confirmedOpen: Array<{ startDate: string; endDate: string }>;
  /** When true, compute wouldCreate/wouldRemove but make NO Guesty calls. */
  dryRun?: boolean;
}): Promise<SyncResult & { wouldCreate: number; wouldRemove: number }> {
  const { propertyId, desired, confirmedOpen, dryRun = false } = args;
  const guestyListingId = await storage.getGuestyListingId(propertyId);
  if (!guestyListingId) {
    return {
      success: false, propertyId, guestyListingId: null,
      created: 0, removed: 0, unchanged: 0, failures: [],
      reason: `No Guesty listing mapped for property ${propertyId}`,
      wouldCreate: 0, wouldRemove: 0,
    };
  }

  const calPath = `/availability-pricing/api/calendar/listings/${guestyListingId}`;
  // Only OUR sourceability blocks — never touch human/legacy scanner blocks.
  const active = (await storage.getActiveScannerBlocks(propertyId))
    .filter((b) => b.source === SOURCEABILITY_GATE_SOURCE);
  const k = (s: string, e: string) => `${s}|${e}`;
  const activeKeys = new Set(active.map((b) => k(b.startDate, b.endDate)));
  const desiredKeys = new Set(desired.map((d) => k(d.startDate, d.endDate)));
  const openKeys = new Set(confirmedOpen.map((o) => k(o.startDate, o.endDate)));

  const failures: SyncResult["failures"] = [];
  let created = 0, removed = 0, wouldCreate = 0, wouldRemove = 0;

  // CREATE: desired windows not already blocked by us.
  for (const d of desired) {
    if (activeKeys.has(k(d.startDate, d.endDate))) continue;
    wouldCreate++;
    if (dryRun) continue;
    try {
      await guestyCalendarPutWithRetry(calPath, { startDate: d.startDate, endDate: d.endDate, status: "unavailable" });
      await storage.createScannerBlock({
        propertyId, guestyListingId, startDate: d.startDate, endDate: d.endDate,
        reason: d.reason.slice(0, 250), source: SOURCEABILITY_GATE_SOURCE,
      });
      created++;
      await sleep(750);
    } catch (e: any) {
      failures.push({ action: "create", startDate: d.startDate, error: e?.message ?? String(e) });
    }
  }

  // REMOVE: our blocks whose window is now CONFIRMED sourceable again. A block
  // whose window merely failed/skipped this pass is left untouched (fail-safe).
  for (const b of active) {
    const key = k(b.startDate, b.endDate);
    if (desiredKeys.has(key)) continue;   // still want it blocked
    if (!openKeys.has(key)) continue;     // not confirmed open ⇒ leave it
    wouldRemove++;
    if (dryRun) continue;
    try {
      await guestyCalendarPutWithRetry(calPath, { startDate: b.startDate, endDate: b.endDate, status: "available" });
      await storage.markScannerBlockRemoved(b.id);
      removed++;
      await sleep(750);
    } catch (e: any) {
      failures.push({ action: "remove", startDate: b.startDate, error: e?.message ?? String(e) });
    }
  }

  return {
    success: failures.length === 0,
    propertyId, guestyListingId,
    created, removed,
    unchanged: Math.max(0, active.length - removed),
    failures, wouldCreate, wouldRemove,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Pricing-blackout reconcile (2026-06-15). The market-pricing scan blacks out
// a month's window when it can't find a confident exact-bedroom comp basis
// (e.g. 3BR in a mostly-1/2BR resort). This pushes those decisions to Guesty:
// CLOSE (status unavailable) windows we couldn't price, and REOPEN (status
// available) windows that became priceable again — touching ONLY the blocks WE
// created (source = PRICING_BLACKOUT_SOURCE), never human/legacy/sourceability
// blocks.
//
// Matched by CALENDAR MONTH, not exact dates: the scan samples a different
// 7-night window per run, so a month re-blocked or re-priced with shifted dates
// must still reconcile against the prior block for that month.
//
// FAIL-SAFE: a previously-blacked month is only reopened when this run
// CONFIRMED it priceable (confirmedOpenMonths). A month whose scan errored/was
// skipped this run is in neither set, so its block is LEFT in place.
// ─────────────────────────────────────────────────────────────────────────
export const PRICING_BLACKOUT_SOURCE = "pricing-blackout";

const monthKeyOf = (date: string) => String(date).slice(0, 7);

export async function reconcilePricingBlackoutBlocks(args: {
  propertyId: number;
  desired: Array<{ startDate: string; endDate: string; reason: string }>;
  confirmedOpenMonths: string[];
  /** When true, compute wouldCreate/wouldRemove but make NO Guesty calls. */
  dryRun?: boolean;
}): Promise<SyncResult & { wouldCreate: number; wouldRemove: number }> {
  const { propertyId, desired, confirmedOpenMonths, dryRun = false } = args;
  const guestyListingId = await storage.getGuestyListingId(propertyId);
  if (!guestyListingId) {
    return {
      success: false, propertyId, guestyListingId: null,
      created: 0, removed: 0, unchanged: 0, failures: [],
      reason: `No Guesty listing mapped for property ${propertyId}`,
      wouldCreate: 0, wouldRemove: 0,
    };
  }

  const calPath = `/availability-pricing/api/calendar/listings/${guestyListingId}`;
  // Only OUR pricing-blackout blocks — never touch human/legacy/sourceability blocks.
  const active = (await storage.getActiveScannerBlocks(propertyId))
    .filter((b) => b.source === PRICING_BLACKOUT_SOURCE);
  const activeMonths = new Set(active.map((b) => monthKeyOf(b.startDate)));
  const desiredMonths = new Set(desired.map((d) => monthKeyOf(d.startDate)));
  const openMonths = new Set(confirmedOpenMonths.map((m) => monthKeyOf(m)));

  const failures: SyncResult["failures"] = [];
  let created = 0, removed = 0, wouldCreate = 0, wouldRemove = 0;

  // CREATE: desired blackout windows whose month isn't already blocked by us.
  for (const d of desired) {
    if (activeMonths.has(monthKeyOf(d.startDate))) continue;
    wouldCreate++;
    if (dryRun) continue;
    try {
      await guestyCalendarPutWithRetry(calPath, { startDate: d.startDate, endDate: d.endDate, status: "unavailable" });
      await storage.createScannerBlock({
        propertyId, guestyListingId, startDate: d.startDate, endDate: d.endDate,
        reason: d.reason.slice(0, 250), source: PRICING_BLACKOUT_SOURCE,
      });
      created++;
      await sleep(750);
    } catch (e: any) {
      failures.push({ action: "create", startDate: d.startDate, error: e?.message ?? String(e) });
    }
  }

  // REMOVE: our blocks whose MONTH is now CONFIRMED priceable again and is not
  // re-blacked this run. A block whose month merely failed/skipped this pass is
  // left untouched (fail-safe).
  for (const b of active) {
    const month = monthKeyOf(b.startDate);
    if (desiredMonths.has(month)) continue;   // still blacked out
    if (!openMonths.has(month)) continue;     // not confirmed priceable ⇒ leave it
    wouldRemove++;
    if (dryRun) continue;
    try {
      await guestyCalendarPutWithRetry(calPath, { startDate: b.startDate, endDate: b.endDate, status: "available" });
      await storage.markScannerBlockRemoved(b.id);
      removed++;
      await sleep(750);
    } catch (e: any) {
      failures.push({ action: "remove", startDate: b.startDate, error: e?.message ?? String(e) });
    }
  }

  return {
    success: failures.length === 0,
    propertyId, guestyListingId,
    created, removed,
    unchanged: Math.max(0, active.length - removed),
    failures, wouldCreate, wouldRemove,
  };
}
