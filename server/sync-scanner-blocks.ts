// Calendar-block sync helper.
//
// Two callers:
//   1. POST /api/availability/sync-blocks/:propertyId — operator
//      manually clicks the "Sync blocks" button in the Availability
//      tab. Sends an explicit windows[] payload.
//   2. server/availability-scanner.ts — after a full scan completes,
//      auto-publishes blocks for any property the scanner flagged as
//      below-threshold. Reads the run's scan rows directly from
//      storage and constructs the windows[] internally.
//
// Both paths converge here so the Guesty PUT logic + DB block-tracking
// stay in one place. Only blocks with `source: "nexstay-scanner"` are
// created/removed; human-placed blocks from other sources are never
// touched.

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

function dateMs(value: string): number {
  return new Date(`${value}T12:00:00Z`).getTime();
}

function rangesOverlap(
  a: { startDate: string; endDate: string },
  b: { startDate: string; endDate: string },
): boolean {
  return dateMs(a.startDate) < dateMs(b.endDate) && dateMs(b.startDate) < dateMs(a.endDate);
}

function rangeCovers(
  outer: { startDate: string; endDate: string },
  inner: { startDate: string; endDate: string },
): boolean {
  return dateMs(outer.startDate) <= dateMs(inner.startDate) && dateMs(outer.endDate) >= dateMs(inner.endDate);
}

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
  windows: SyncWindow[],
): Promise<SyncResult> {
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
  const desiredBlocks = new Set(
    windows.filter((w) => w.verdict === "blocked").map((w) => `${w.startDate}:${w.endDate}`),
  );
  const desiredBlockWindows = windows.filter((w) => w.verdict === "blocked");
  const clearableWindowList = windows.filter((w) => w.verdict === "available" || w.verdict === "tight");
  const clearableWindows = new Set(
    clearableWindowList.map((w) => `${w.startDate}:${w.endDate}`),
  );

  let created = 0;
  let removed = 0;
  const failures: SyncResult["failures"] = [];
  const calPath = `/availability-pricing/api/calendar/listings/${guestyListingId}`;

  // Clear stale scanner-created blocks first. If an old block overlaps a
  // desired policy block but does not exactly match it, remove it and let the
  // create phase write the exact replacement range. This keeps the calendar
  // from accumulating legacy scanner blackout bands after policy changes.
  for (const b of active) {
    const key = `${b.startDate}:${b.endDate}`;
    if (desiredBlocks.has(key)) continue;
    const overlapsKnownWindow =
      desiredBlockWindows.some((w) => rangesOverlap(b, w)) ||
      clearableWindowList.some((w) => rangesOverlap(b, w));
    if (!clearableWindows.has(key) && !overlapsKnownWindow) continue;
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

  const remainingActive = await storage.getActiveScannerBlocks(propertyId);
  const activeKeyed = new Map(remainingActive.map((b) => [`${b.startDate}:${b.endDate}`, b]));

  // Block new windows via calendar PUT.
  for (const w of windows.filter((ww) => ww.verdict === "blocked")) {
    const key = `${w.startDate}:${w.endDate}`;
    if (activeKeyed.has(key)) continue;
    try {
      const reason = w.reason
        ?? (w.maxSets != null && w.minSets != null
          ? `low-inventory: ${w.maxSets} / ${w.minSets} sets`
          : "below threshold");
      const resp = await guestyCalendarPutWithRetry(calPath, {
        startDate: w.startDate,
        endDate: w.endDate,
        status: "unavailable",
        note: `nexstay-scanner: ${reason}`,
      }) as any;
      const createdBlocksArr = resp?.data?.blocks?.createdBlocks
        ?? resp?.blocks?.createdBlocks
        ?? [];
      const guestyBlockId = createdBlocksArr[0]?._id ?? createdBlocksArr[0]?.id ?? null;
      await storage.createScannerBlock({
        propertyId,
        guestyListingId,
        startDate: w.startDate,
        endDate: w.endDate,
        guestyBlockId,
        reason,
      });
      created++;
      await sleep(750);
    } catch (e: any) {
      failures.push({ action: "create", startDate: w.startDate, error: e?.message ?? String(e) });
    }
  }

  return {
    success: failures.length === 0,
    propertyId,
    guestyListingId,
    created,
    removed,
    unchanged: Math.max(0, remainingActive.length - created),
    failures,
  };
}
