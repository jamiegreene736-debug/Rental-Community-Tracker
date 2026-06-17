import { topMarketScanCache as topMarketScanCacheRows } from "@shared/schema";
import {
  hasFourBedroomComboPotential,
  hasFiveBedroomComboPotential,
  hasSevenEightBedroomComboPotential,
  hasSixBedroomComboPotential,
  filterTopScanComboCandidates,
} from "./community-research";
import { db } from "./db";
import { eq } from "drizzle-orm";

/** Bump when combo-badge logic changes so cached market flags are recomputed. */
// v5: candidate filter widened from 6BR-only to any 4BR/5BR/6BR/7-8BR combo, and
// four/five-bedroom flags added — recompute flags + qualifyingCount on deploy.
export const TOP_MARKET_SCAN_CACHE_LOGIC_VERSION = 5;

const TOP_MARKET_SCAN_CACHE_VERSION_KEY = "__top_market_scan_cache_logic_version__";

export function topMarketScanCacheKey(city: string, state: string): string {
  return `${state.trim().toLowerCase()}|${city.trim().toLowerCase()}`;
}

function isTopMarketScanCacheMetaRow(marketKey: string): boolean {
  return marketKey === TOP_MARKET_SCAN_CACHE_VERSION_KEY;
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
    for (const row of rows) {
      if (isTopMarketScanCacheMetaRow(row.marketKey)) continue;
      map.set(row.marketKey, row);
    }
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
  const communities = filterTopScanComboCandidates(
    (Array.isArray(params.communities) ? params.communities : []) as any[],
  );
  const fourBedroomPossible = communities.some((c) => hasFourBedroomComboPotential(c as any));
  const fiveBedroomPossible = communities.some((c) => hasFiveBedroomComboPotential(c as any));
  const sixBedroomPossible = communities.some((c) => hasSixBedroomComboPotential(c as any));
  const sevenEightBedroomPossible = communities.some((c) => hasSevenEightBedroomComboPotential(c as any));
  try {
    await db.insert(topMarketScanCacheRows).values({
      marketKey,
      city: params.city.trim(),
      state: params.state.trim(),
      tag: params.tag ?? null,
      fourBedroomPossible,
      fiveBedroomPossible,
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
        fourBedroomPossible,
        fiveBedroomPossible,
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

export async function clearTopMarketScanCache(): Promise<void> {
  try {
    await db.delete(topMarketScanCacheRows);
    console.log("[top-market-scan-cache] cleared all cached market scans");
  } catch (err) {
    if (isMissingTopMarketScanCacheTable(err)) return;
    throw err;
  }
}

/** Recompute 4BR/5BR/6BR/7-8BR combo flags from stored community JSON (no SearchAPI). */
export async function refreshTopMarketScanCacheComboFlags(): Promise<number> {
  try {
    const rows = await db.select().from(topMarketScanCacheRows);
    let updated = 0;
    for (const row of rows) {
      const communities = filterTopScanComboCandidates(
        (Array.isArray(row.communities) ? row.communities : []) as any[],
      );
      const fourBedroomPossible = communities.some((c) => hasFourBedroomComboPotential(c as any));
      const fiveBedroomPossible = communities.some((c) => hasFiveBedroomComboPotential(c as any));
      const sixBedroomPossible = communities.some((c) => hasSixBedroomComboPotential(c as any));
      const sevenEightBedroomPossible = communities.some((c) => hasSevenEightBedroomComboPotential(c as any));
      if (
        row.fourBedroomPossible === fourBedroomPossible &&
        row.fiveBedroomPossible === fiveBedroomPossible &&
        row.sixBedroomPossible === sixBedroomPossible &&
        row.sevenEightBedroomPossible === sevenEightBedroomPossible &&
        row.qualifyingCount === communities.length
      ) {
        continue;
      }
      await db.update(topMarketScanCacheRows).set({
        fourBedroomPossible,
        fiveBedroomPossible,
        sixBedroomPossible,
        sevenEightBedroomPossible,
        qualifyingCount: communities.length,
        communities,
        updatedAt: new Date(),
      }).where(eq(topMarketScanCacheRows.marketKey, row.marketKey));
      updated += 1;
    }
    if (updated > 0) {
      console.log(`[top-market-scan-cache] refreshed combo flags on ${updated} cached markets`);
    }
    return updated;
  } catch (err) {
    if (isMissingTopMarketScanCacheTable(err)) return 0;
    throw err;
  }
}

export async function ensureTopMarketScanCacheLogicVersion(): Promise<void> {
  try {
    const rows = await db.select().from(topMarketScanCacheRows).where(
      eq(topMarketScanCacheRows.marketKey, TOP_MARKET_SCAN_CACHE_VERSION_KEY),
    ).limit(1);
    const stored = rows[0]?.tag ? Number(rows[0].tag) : 0;
    if (stored >= TOP_MARKET_SCAN_CACHE_LOGIC_VERSION) return;

    await clearTopMarketScanCache();
    const now = new Date();
    await db.insert(topMarketScanCacheRows).values({
      marketKey: TOP_MARKET_SCAN_CACHE_VERSION_KEY,
      city: "",
      state: "",
      tag: String(TOP_MARKET_SCAN_CACHE_LOGIC_VERSION),
      sixBedroomPossible: false,
      sevenEightBedroomPossible: false,
      qualifyingCount: 0,
      communities: [],
      error: null,
      scannedAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: topMarketScanCacheRows.marketKey,
      set: { tag: String(TOP_MARKET_SCAN_CACHE_LOGIC_VERSION), updatedAt: now },
    });
    console.log(
      `[top-market-scan-cache] logic version ${TOP_MARKET_SCAN_CACHE_LOGIC_VERSION} — cleared market cache for fresh scans`,
    );
  } catch (err) {
    if (isMissingTopMarketScanCacheTable(err)) return;
    throw err;
  }
}

export function serializeTopMarketScanCacheRow(row: TopMarketScanCacheRow) {
  return {
    city: row.city,
    state: row.state,
    tag: row.tag,
    fourBedroomPossible: row.fourBedroomPossible,
    fiveBedroomPossible: row.fiveBedroomPossible,
    sixBedroomPossible: row.sixBedroomPossible,
    sevenEightBedroomPossible: row.sevenEightBedroomPossible,
    qualifyingCount: row.qualifyingCount,
    scannedAt: row.scannedAt?.toISOString?.() ?? row.scannedAt,
    error: row.error,
  };
}
