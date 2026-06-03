import { topMarketScanCache as topMarketScanCacheRows } from "@shared/schema";
import {
  hasSevenEightBedroomComboPotential,
  hasSixBedroomComboPotential,
} from "./community-research";
import { db } from "./db";

export function topMarketScanCacheKey(city: string, state: string): string {
  return `${state.trim().toLowerCase()}|${city.trim().toLowerCase()}`;
}

export type TopMarketScanCacheRow = typeof topMarketScanCacheRows.$inferSelect;

function isMissingTopMarketScanCacheTable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /42P01|does not exist|relation .*top_market_scan_cache.* does not exist/i.test(message);
}

export async function loadTopMarketScanCacheMap(): Promise<Map<string, TopMarketScanCacheRow>> {
  try {
    const rows = await db.select().from(topMarketScanCacheRows);
    const map = new Map<string, TopMarketScanCacheRow>();
    for (const row of rows) map.set(row.marketKey, row);
    return map;
  } catch (err) {
    if (isMissingTopMarketScanCacheTable(err)) {
      console.warn("[top-market-scan-cache] table missing — returning empty cache map until schema is ensured");
      return new Map();
    }
    throw err;
  }
}

export async function upsertTopMarketScanCache(params: {
  city: string;
  state: string;
  tag?: string;
  communities: unknown[];
  error?: string | null;
}): Promise<void> {
  const now = new Date();
  const marketKey = topMarketScanCacheKey(params.city, params.state);
  const communities = Array.isArray(params.communities) ? params.communities : [];
  const sixBedroomPossible = communities.some((c) => hasSixBedroomComboPotential(c as any));
  const sevenEightBedroomPossible = communities.some((c) => hasSevenEightBedroomComboPotential(c as any));
  try {
    await db.insert(topMarketScanCacheRows).values({
      marketKey,
      city: params.city.trim(),
      state: params.state.trim(),
      tag: params.tag ?? null,
      sixBedroomPossible,
      sevenEightBedroomPossible,
      qualifyingCount: communities.length,
      communities,
      error: params.error ?? null,
      scannedAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: topMarketScanCacheRows.marketKey,
      set: {
        city: params.city.trim(),
        state: params.state.trim(),
        tag: params.tag ?? null,
        sixBedroomPossible,
        sevenEightBedroomPossible,
        qualifyingCount: communities.length,
        communities,
        error: params.error ?? null,
        scannedAt: now,
        updatedAt: now,
      },
    });
  } catch (err) {
    if (isMissingTopMarketScanCacheTable(err)) {
      console.error(
        `[top-market-scan-cache] cannot save ${params.city}, ${params.state} — top_market_scan_cache table missing`,
      );
      return;
    }
    throw err;
  }
}

export function serializeTopMarketScanCacheRow(row: TopMarketScanCacheRow) {
  return {
    city: row.city,
    state: row.state,
    tag: row.tag,
    sixBedroomPossible: row.sixBedroomPossible,
    sevenEightBedroomPossible: row.sevenEightBedroomPossible,
    qualifyingCount: row.qualifyingCount,
    scannedAt: row.scannedAt?.toISOString?.() ?? row.scannedAt,
    error: row.error,
  };
}
