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

export async function loadTopMarketScanCacheMap(): Promise<Map<string, TopMarketScanCacheRow>> {
  const rows = await db.select().from(topMarketScanCacheRows);
  const map = new Map<string, TopMarketScanCacheRow>();
  for (const row of rows) map.set(row.marketKey, row);
  return map;
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
