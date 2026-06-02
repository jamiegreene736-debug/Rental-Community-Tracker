import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db";
import { getGuestyToken } from "./guesty-token";
import { scannerBlocks } from "../shared/schema";

export type ScannerBlockCleanupFailure = {
  blockId: number;
  propertyId: number;
  guestyListingId: string;
  startDate: string;
  endDate: string;
  error: string;
};

export type ScannerBlockCleanupResult = {
  dryRun: boolean;
  total: number;
  properties: number;
  cleared: number;
  failed: number;
  failures: ScannerBlockCleanupFailure[];
};

const GUESTY_CALENDAR_BASE = "https://open-api.guesty.com/v1/availability-pricing/api/calendar/listings";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function putCalendarAvailable(block: {
  guestyListingId: string;
  startDate: string;
  endDate: string;
}) {
  const token = await getGuestyToken();
  const url = `${GUESTY_CALENDAR_BASE}/${encodeURIComponent(block.guestyListingId)}`;
  const body = {
    startDate: block.startDate,
    endDate: block.endDate,
    status: "available",
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (res.ok) return;

    const text = await res.text().catch(() => "");
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(750 * (attempt + 1));
      continue;
    }
    throw new Error(`Guesty calendar PUT ${res.status}: ${text.slice(0, 300)}`);
  }
}

export async function clearTrackedScannerBlocks(options: { dryRun?: boolean } = {}): Promise<ScannerBlockCleanupResult> {
  const dryRun = options.dryRun === true;
  const activeBlocks = await db
    .select()
    .from(scannerBlocks)
    .where(isNull(scannerBlocks.removedAt))
    .orderBy(scannerBlocks.propertyId, scannerBlocks.startDate);

  const propertyIds = new Set(activeBlocks.map((block) => block.propertyId));
  const failures: ScannerBlockCleanupFailure[] = [];
  let cleared = 0;

  for (const block of activeBlocks) {
    if (!block.guestyListingId) {
      failures.push({
        blockId: block.id,
        propertyId: block.propertyId,
        guestyListingId: "",
        startDate: block.startDate,
        endDate: block.endDate,
        error: "Missing Guesty listing id on scanner block row",
      });
      continue;
    }

    try {
      if (!dryRun) {
        await putCalendarAvailable(block);
        await db
          .update(scannerBlocks)
          .set({ removedAt: new Date() })
          .where(and(eq(scannerBlocks.id, block.id), isNull(scannerBlocks.removedAt)));
        await sleep(250);
      }
      cleared++;
    } catch (error: any) {
      failures.push({
        blockId: block.id,
        propertyId: block.propertyId,
        guestyListingId: block.guestyListingId,
        startDate: block.startDate,
        endDate: block.endDate,
        error: error?.message ?? String(error),
      });
    }
  }

  return {
    dryRun,
    total: activeBlocks.length,
    properties: propertyIds.size,
    cleared,
    failed: failures.length,
    failures,
  };
}
