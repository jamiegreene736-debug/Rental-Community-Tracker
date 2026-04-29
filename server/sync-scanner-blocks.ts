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
  const activeKeyed = new Map(active.map((b) => [`${b.startDate}:${b.endDate}`, b]));
  const desiredBlocks = new Set(
    windows.filter((w) => w.verdict === "blocked").map((w) => `${w.startDate}:${w.endDate}`),
  );

  let created = 0;
  let removed = 0;
  const failures: SyncResult["failures"] = [];
  const calPath = `/availability-pricing/api/calendar/listings/${guestyListingId}`;

  // Block new windows via calendar PUT.
  for (const w of windows.filter((ww) => ww.verdict === "blocked")) {
    const key = `${w.startDate}:${w.endDate}`;
    if (activeKeyed.has(key)) continue;
    try {
      const reason = w.reason
        ?? (w.maxSets != null && w.minSets != null
          ? `low-inventory: ${w.maxSets} / ${w.minSets} sets`
          : "below threshold");
      const resp = await guestyRequest("PUT", calPath, {
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
      await new Promise((r) => setTimeout(r, 120));
    } catch (e: any) {
      failures.push({ action: "create", startDate: w.startDate, error: e?.message ?? String(e) });
    }
  }

  // Unblock windows by setting status: "available" on the same range.
  for (const b of active) {
    const key = `${b.startDate}:${b.endDate}`;
    if (desiredBlocks.has(key)) continue;
    try {
      await guestyRequest("PUT", calPath, {
        startDate: b.startDate,
        endDate: b.endDate,
        status: "available",
      });
      await storage.markScannerBlockRemoved(b.id);
      removed++;
      await new Promise((r) => setTimeout(r, 120));
    } catch (e: any) {
      failures.push({ action: "remove", startDate: b.startDate, error: e?.message ?? String(e) });
    }
  }

  return {
    success: failures.length === 0,
    propertyId,
    guestyListingId,
    created,
    removed,
    unchanged: active.length - removed,
    failures,
  };
}
