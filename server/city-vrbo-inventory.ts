import {
  countCityVrboPhraseBuckets,
  filterCityVrboListingsByPhrase,
  groupCityVrboByBedroom,
  suggestCityVrboComboPair,
  type CityVrboComboPair,
  type CityVrboListing,
} from "@shared/city-vrbo-combo";
import { BUY_IN_MARKET_LOCATIONS, searchLocationForBuyInMarket } from "@shared/buy-in-market";

export type CityVrboFilterPipeline = {
  rawSidecar: number;
  droppedNoPrice: number;
  droppedBelowMinBedrooms: number;
  afterNormalize: number;
  phraseFilter: string | null;
  afterPhraseFilter: number;
  byBedroom: Record<number, number>;
  phraseBuckets: number;
  suggestedPair: boolean;
};

type SidecarVrboCandidate = {
  url: string;
  title: string;
  nightlyPrice?: number;
  totalPrice?: number;
  bedrooms?: number;
  lat?: number;
  lng?: number;
  snippet?: string;
  captureSource?: string;
};

type CityVrboScrapeCacheEntry = {
  expiresAt: number;
  citySearchTerm: string;
  nights: number;
  listings: CityVrboListing[];
  sidecar: {
    workerOnline: boolean;
    durationMs: number;
    reason: string;
    rawCount: number;
    mapHarvest: Record<string, unknown> | null;
  };
  normalizePipeline: Omit<CityVrboFilterPipeline, "phraseFilter" | "afterPhraseFilter" | "phraseBuckets" | "suggestedPair">;
};

const CITY_VRBO_CACHE_TTL_MS = Math.max(
  60_000,
  Number(process.env.CITY_VRBO_INVENTORY_TTL_MS ?? 20 * 60_000),
);
const cityVrboScrapeCache = new Map<string, CityVrboScrapeCacheEntry>();

function cacheKeyForScrape(community: string, checkIn: string, checkOut: string): string {
  return `${community.toLowerCase()}|${checkIn}|${checkOut}|city-vrbo-v1`;
}

function rawCandidateBedroomSignal(candidate: SidecarVrboCandidate): number | null {
  if (typeof candidate.bedrooms === "number" && Number.isFinite(candidate.bedrooms) && candidate.bedrooms > 0) {
    return Math.round(candidate.bedrooms);
  }
  const text = `${candidate.title ?? ""} ${candidate.snippet ?? ""}`;
  const match = text.match(/\b(\d{1,2})\s*(?:br|bd|bdr|bedrooms?)\b/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function normalizeSidecarCandidates(
  candidates: SidecarVrboCandidate[],
  nights: number,
): { listings: CityVrboListing[]; pipeline: CityVrboScrapeCacheEntry["normalizePipeline"] } {
  const deduped = new Map<string, CityVrboListing>();
  let droppedNoPrice = 0;
  let droppedBelowMinBedrooms = 0;
  for (const candidate of candidates) {
    const total = Math.round(Number(candidate.totalPrice) || 0);
    const nightly = Number(candidate.nightlyPrice) > 0
      ? Math.round(Number(candidate.nightlyPrice))
      : total > 0
        ? Math.round(total / Math.max(1, nights))
        : 0;
    if (total <= 0 && nightly <= 0) {
      droppedNoPrice += 1;
      continue;
    }
    const bedrooms = rawCandidateBedroomSignal(candidate);
    if (bedrooms === null || bedrooms < 2) {
      droppedBelowMinBedrooms += 1;
      continue;
    }
    const mapped: CityVrboListing = {
      url: candidate.url,
      title: candidate.title,
      bedrooms,
      nightlyPrice: nightly > 0 ? nightly : undefined,
      totalPrice: total > 0 ? total : nightly * Math.max(1, nights),
      lat: typeof candidate.lat === "number" && Number.isFinite(candidate.lat) ? candidate.lat : null,
      lng: typeof candidate.lng === "number" && Number.isFinite(candidate.lng) ? candidate.lng : null,
      sourceLabel: "Vrbo",
    };
    const previous = deduped.get(mapped.url);
    const mappedTotal = mapped.totalPrice ?? 0;
    const previousTotal = previous?.totalPrice ?? Number.POSITIVE_INFINITY;
    if (!previous || mappedTotal < previousTotal) deduped.set(mapped.url, mapped);
  }
  const listings = Array.from(deduped.values()).sort((a, b) => (a.totalPrice ?? 0) - (b.totalPrice ?? 0));
  const byBedroomMap = groupCityVrboByBedroom(listings);
  const byBedroom: Record<number, number> = {};
  for (const [br, rows] of byBedroomMap) byBedroom[br] = rows.length;
  return {
    listings,
    pipeline: {
      rawSidecar: candidates.length,
      droppedNoPrice,
      droppedBelowMinBedrooms,
      afterNormalize: listings.length,
      byBedroom,
    },
  };
}

function buildFilterPipeline(
  base: CityVrboScrapeCacheEntry["normalizePipeline"],
  filteredListings: CityVrboListing[],
  phraseFilter: string | null,
  suggestedPair: CityVrboComboPair | null,
): CityVrboFilterPipeline {
  const byBedroomMap = groupCityVrboByBedroom(filteredListings);
  const byBedroom: Record<number, number> = {};
  for (const [br, rows] of byBedroomMap) byBedroom[br] = rows.length;
  return {
    ...base,
    phraseFilter,
    afterPhraseFilter: filteredListings.length,
    byBedroom,
    phraseBuckets: countCityVrboPhraseBuckets(filteredListings),
    suggestedPair: Boolean(suggestedPair),
  };
}

function logFilterPipeline(
  community: string,
  checkIn: string,
  checkOut: string,
  pipeline: CityVrboFilterPipeline,
  fromCache: boolean,
) {
  const bedroomSummary = Object.entries(pipeline.byBedroom)
    .sort(([a], [b]) => Number(b) - Number(a))
    .map(([br, count]) => `${br}BR=${count}`)
    .join(" ");
  console.log(
    `[city-vrbo-inventory] community="${community}" ${checkIn}→${checkOut} ` +
    `${fromCache ? "cache-hit" : "fresh-scrape"} pipeline: ` +
    `raw=${pipeline.rawSidecar} -noPrice=${pipeline.droppedNoPrice} -minBR=${pipeline.droppedBelowMinBedrooms} ` +
    `normalized=${pipeline.afterNormalize}` +
    (pipeline.phraseFilter ? ` phrase="${pipeline.phraseFilter}" filtered=${pipeline.afterPhraseFilter}` : "") +
    ` buckets=${pipeline.phraseBuckets} pair=${pipeline.suggestedPair ? "yes" : "no"}` +
    (bedroomSummary ? ` (${bedroomSummary})` : ""),
  );
}

function applyFiltersToPool(
  pool: CityVrboListing[],
  basePipeline: CityVrboScrapeCacheEntry["normalizePipeline"],
  bedroomPlan: number[],
  nights: number,
  filterPhrase?: string,
): {
  listings: CityVrboListing[];
  byBedroom: Record<number, CityVrboListing[]>;
  suggestedPair: CityVrboComboPair | null;
  filterPipeline: CityVrboFilterPipeline;
} {
  const phrase = String(filterPhrase ?? "").trim() || null;
  const filtered = phrase ? filterCityVrboListingsByPhrase(pool, phrase) : pool;
  const byBedroomMap = groupCityVrboByBedroom(filtered);
  const byBedroom: Record<number, CityVrboListing[]> = {};
  for (const [br, rows] of byBedroomMap) byBedroom[br] = rows;
  const suggestedPair = suggestCityVrboComboPair(filtered, bedroomPlan, nights);
  const filterPipeline = buildFilterPipeline(basePipeline, filtered, phrase, suggestedPair);
  return { listings: filtered, byBedroom, suggestedPair, filterPipeline };
}

async function scrapeCityVrboPool(args: {
  community: string;
  checkIn: string;
  checkOut: string;
  bedroomPlan: number[];
}): Promise<CityVrboScrapeCacheEntry | null> {
  const citySearchTerm = searchLocationForBuyInMarket(args.community)
    ?? `${args.community}, Hawaii`;
  const nights = Math.max(
    1,
    Math.round(
      (new Date(`${args.checkOut}T12:00:00`).getTime() - new Date(`${args.checkIn}T12:00:00`).getTime()) / 86_400_000,
    ),
  );
  const marketLoc = BUY_IN_MARKET_LOCATIONS[args.community];
  const mapSearchCenter = marketLoc
    ? { lat: marketLoc.lat, lng: marketLoc.lng }
    : undefined;
  const inventoryBedrooms = Math.min(2, ...args.bedroomPlan.filter((br) => br > 0));

  const { searchVrboViaSidecar } = await import("./vrbo-sidecar-queue");
  const r = await searchVrboViaSidecar({
    destination: citySearchTerm,
    searchTerm: citySearchTerm,
    checkIn: args.checkIn,
    checkOut: args.checkOut,
    bedrooms: inventoryBedrooms,
    searchMode: "map_bounds",
    cityWideInventory: true,
    mapSearch: {
      enabled: true,
      bounds: undefined,
      center: mapSearchCenter,
      radiusKm: 6,
      deepHarvest: true,
    },
    walletBudgetMs: 240_000,
    queueBudgetMs: 300_000,
    queueContext: {
      scanLabel: `city-vrbo-inventory:${args.community}`,
      dateLabel: `${args.checkIn}→${args.checkOut}`,
      skipResultCache: true,
    },
  });

  if (!r) {
    return null;
  }

  const { listings, pipeline } = normalizeSidecarCandidates(r.candidates ?? [], nights);
  return {
    expiresAt: Date.now() + CITY_VRBO_CACHE_TTL_MS,
    citySearchTerm,
    nights,
    listings,
    sidecar: {
      workerOnline: r.workerOnline,
      durationMs: r.durationMs,
      reason: r.reason,
      rawCount: r.candidates?.length ?? 0,
      mapHarvest: r?.mapHarvest ?? null,
    },
    normalizePipeline: pipeline,
  };
}

export async function runCityVrboInventoryScan(args: {
  community: string;
  checkIn: string;
  checkOut: string;
  bedroomPlan: number[];
  filterPhrase?: string;
  skipCache?: boolean;
}): Promise<{
  citySearchTerm: string;
  nights: number;
  listings: CityVrboListing[];
  byBedroom: Record<number, CityVrboListing[]>;
  suggestedPair: CityVrboComboPair | null;
  filterPipeline: CityVrboFilterPipeline;
  fromCache: boolean;
  sidecar: {
    workerOnline: boolean;
    durationMs: number;
    reason: string;
    rawCount: number;
    mapHarvest: Record<string, unknown> | null;
  };
}> {
  const citySearchTerm = searchLocationForBuyInMarket(args.community)
    ?? `${args.community}, Hawaii`;
  const nights = Math.max(
    1,
    Math.round(
      (new Date(`${args.checkOut}T12:00:00`).getTime() - new Date(`${args.checkIn}T12:00:00`).getTime()) / 86_400_000,
    ),
  );
  const cacheKey = cacheKeyForScrape(args.community, args.checkIn, args.checkOut);
  let fromCache = false;
  let scrapeEntry: CityVrboScrapeCacheEntry | null = null;

  if (!args.skipCache) {
    const cached = cityVrboScrapeCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      scrapeEntry = cached;
      fromCache = true;
    }
  }

  if (!scrapeEntry) {
    scrapeEntry = await scrapeCityVrboPool(args);
    if (scrapeEntry) {
      cityVrboScrapeCache.set(cacheKey, scrapeEntry);
    }
  }

  if (!scrapeEntry) {
    const emptyPipeline: CityVrboFilterPipeline = {
      rawSidecar: 0,
      droppedNoPrice: 0,
      droppedBelowMinBedrooms: 0,
      afterNormalize: 0,
      phraseFilter: args.filterPhrase?.trim() || null,
      afterPhraseFilter: 0,
      byBedroom: {},
      phraseBuckets: 0,
      suggestedPair: false,
    };
    logFilterPipeline(args.community, args.checkIn, args.checkOut, emptyPipeline, false);
    return {
      citySearchTerm,
      nights,
      listings: [],
      byBedroom: {},
      suggestedPair: null,
      filterPipeline: emptyPipeline,
      fromCache: false,
      sidecar: {
        workerOnline: false,
        durationMs: 0,
        reason: "VRBO sidecar unavailable (cooldown or offline)",
        rawCount: 0,
        mapHarvest: null,
      },
    };
  }

  const filtered = applyFiltersToPool(
    scrapeEntry.listings,
    scrapeEntry.normalizePipeline,
    args.bedroomPlan,
    scrapeEntry.nights,
    args.filterPhrase,
  );
  logFilterPipeline(args.community, args.checkIn, args.checkOut, filtered.filterPipeline, fromCache);

  return {
    citySearchTerm: scrapeEntry.citySearchTerm,
    nights: scrapeEntry.nights,
    listings: filtered.listings,
    byBedroom: filtered.byBedroom,
    suggestedPair: filtered.suggestedPair,
    filterPipeline: filtered.filterPipeline,
    fromCache,
    sidecar: scrapeEntry.sidecar,
  };
}

/** Evict cached city pools (tests or admin). */
export function clearCityVrboInventoryCache(community?: string): number {
  if (!community) {
    const size = cityVrboScrapeCache.size;
    cityVrboScrapeCache.clear();
    return size;
  }
  let removed = 0;
  for (const key of cityVrboScrapeCache.keys()) {
    if (key.startsWith(`${community.toLowerCase()}|`)) {
      cityVrboScrapeCache.delete(key);
      removed += 1;
    }
  }
  return removed;
}
