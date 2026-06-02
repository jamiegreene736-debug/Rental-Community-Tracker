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
