import { and, eq, isNull } from "drizzle-orm";
import { db, dbPool } from "../server/db";
import { getGuestyToken } from "../server/guesty-token";
import { scannerBlocks } from "../shared/schema";

type CleanupFailure = {
  blockId: number;
  propertyId: number;
  guestyListingId: string;
  startDate: string;
  endDate: string;
  error: string;
};

const dryRun = process.argv.includes("--dry-run");
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

async function main() {
  const activeBlocks = await db
    .select()
    .from(scannerBlocks)
    .where(isNull(scannerBlocks.removedAt))
    .orderBy(scannerBlocks.propertyId, scannerBlocks.startDate);

  const propertyIds = new Set(activeBlocks.map((block) => block.propertyId));
  const failures: CleanupFailure[] = [];
  let cleared = 0;

  console.log(
    `[clear-scanner-blocks] ${dryRun ? "dry run: " : ""}found ${activeBlocks.length} active tracked scanner block(s) across ${propertyIds.size} propert${propertyIds.size === 1 ? "y" : "ies"}`,
  );

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
      console.log(
        `[clear-scanner-blocks] ${dryRun ? "would clear" : "cleared"} property=${block.propertyId} listing=${block.guestyListingId} ${block.startDate}..${block.endDate}`,
      );
    } catch (error: any) {
      failures.push({
        blockId: block.id,
        propertyId: block.propertyId,
        guestyListingId: block.guestyListingId,
        startDate: block.startDate,
        endDate: block.endDate,
        error: error?.message ?? String(error),
      });
      console.error(
        `[clear-scanner-blocks] failed property=${block.propertyId} listing=${block.guestyListingId} ${block.startDate}..${block.endDate}: ${error?.message ?? String(error)}`,
      );
    }
  }

  const summary = {
    dryRun,
    total: activeBlocks.length,
    properties: propertyIds.size,
    cleared,
    failed: failures.length,
    failures,
  };
  console.log(JSON.stringify(summary, null, 2));

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(`[clear-scanner-blocks] ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await dbPool.end().catch(() => undefined);
  });
