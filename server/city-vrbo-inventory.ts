import {
  countCityVrboPhraseBuckets,
  filterCityVrboListingsByPhrase,
  groupCityVrboByBedroom,
  suggestCityVrboComboPair,
  type CityVrboComboPair,
  type CityVrboListing,
} from "@shared/city-vrbo-combo";
import { cityWideSearchLocationForBuyInMarket } from "@shared/buy-in-market";

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
  bathrooms?: number;
  sleeps?: number;
  rating?: number;
  reviewCount?: number;
  lat?: number;
  lng?: number;
  locationText?: string;
  snippet?: string;
  image?: string;
  images?: string[];
  basicDetails?: string[];
  vrboId?: string;
  captureSource?: string;
  priceBasis?: string;
  priceIncludesTaxes?: boolean;
  priceIncludesFees?: boolean;
  availabilityOnly?: boolean;
};

type CityVrboScrapeCacheEntry = {
  expiresAt: number;
  citySearchTerm: string;
  nights: number;
  rawListings: CityVrboListing[];
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
const CITY_VRBO_WALLET_BUDGET_MS = Math.max(
  240_000,
  Number(process.env.CITY_VRBO_INVENTORY_WALLET_BUDGET_MS ?? 8 * 60_000),
);
const CITY_VRBO_QUEUE_BUDGET_MS = Math.max(
  CITY_VRBO_WALLET_BUDGET_MS + 60_000,
  Number(process.env.CITY_VRBO_INVENTORY_QUEUE_BUDGET_MS ?? 10 * 60_000),
);
const cityVrboScrapeCache = new Map<string, CityVrboScrapeCacheEntry>();

function cacheKeyForScrape(community: string, checkIn: string, checkOut: string): string {
  // v3: bumped when the city-wide destination switched from the resort
  // searchLocation to the town-level cityWideSearch (Poipu Kai → "Koloa, Hawaii"),
  // so stale narrow pools from v2 aren't re-served.
  return `${community.toLowerCase()}|${checkIn}|${checkOut}|city-vrbo-dropdown-v3`;
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
): { rawListings: CityVrboListing[]; listings: CityVrboListing[]; pipeline: CityVrboScrapeCacheEntry["normalizePipeline"] } {
  const rawDeduped = new Map<string, CityVrboListing>();
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
    const bedrooms = rawCandidateBedroomSignal(candidate);
    const mapped: CityVrboListing = {
      url: candidate.url,
      title: candidate.title,
      bedrooms,
      bathrooms: typeof candidate.bathrooms === "number" && Number.isFinite(candidate.bathrooms) ? candidate.bathrooms : null,
      sleeps: typeof candidate.sleeps === "number" && Number.isFinite(candidate.sleeps) ? Math.round(candidate.sleeps) : null,
      nightlyPrice: nightly > 0 ? nightly : undefined,
      totalPrice: total > 0 ? total : nightly > 0 ? nightly * Math.max(1, nights) : undefined,
      rating: typeof candidate.rating === "number" && Number.isFinite(candidate.rating) ? candidate.rating : null,
      reviewCount: typeof candidate.reviewCount === "number" && Number.isFinite(candidate.reviewCount) ? Math.round(candidate.reviewCount) : null,
      lat: typeof candidate.lat === "number" && Number.isFinite(candidate.lat) ? candidate.lat : null,
      lng: typeof candidate.lng === "number" && Number.isFinite(candidate.lng) ? candidate.lng : null,
      sourceLabel: "Vrbo",
      locationText: candidate.locationText || null,
      snippet: candidate.snippet,
      image: candidate.image,
      images: Array.isArray(candidate.images) ? candidate.images.filter(Boolean).slice(0, 12) : undefined,
      basicDetails: Array.isArray(candidate.basicDetails) ? candidate.basicDetails.filter(Boolean).slice(0, 12) : undefined,
      vrboId: candidate.vrboId,
      captureSource: candidate.captureSource,
      priceBasis: candidate.priceBasis,
      priceIncludesTaxes: candidate.priceIncludesTaxes,
      priceIncludesFees: candidate.priceIncludesFees,
      availabilityOnly: candidate.availabilityOnly,
    };
    const rawPrevious = rawDeduped.get(mapped.url);
    const mappedTotal = mapped.totalPrice ?? 0;
    const rawPreviousTotal = rawPrevious?.totalPrice ?? 0;
    if (!rawPrevious || (mappedTotal > 0 && (rawPreviousTotal <= 0 || mappedTotal < rawPreviousTotal))) {
      rawDeduped.set(mapped.url, mapped);
    }
    if (total <= 0 && nightly <= 0) {
      droppedNoPrice += 1;
      continue;
    }
    if (bedrooms === null || bedrooms < 2) {
      droppedBelowMinBedrooms += 1;
      continue;
    }
    const previous = deduped.get(mapped.url);
    const previousTotal = previous?.totalPrice ?? Number.POSITIVE_INFINITY;
    if (!previous || mappedTotal < previousTotal) deduped.set(mapped.url, mapped);
  }
  const rawListings = Array.from(rawDeduped.values()).sort((a, b) => {
    const aTotal = a.totalPrice ?? Number.POSITIVE_INFINITY;
    const bTotal = b.totalPrice ?? Number.POSITIVE_INFINITY;
    if (aTotal !== bTotal) return aTotal - bTotal;
    return a.title.localeCompare(b.title);
  });
  const listings = Array.from(deduped.values()).sort((a, b) => (a.totalPrice ?? 0) - (b.totalPrice ?? 0));
  const byBedroomMap = groupCityVrboByBedroom(listings);
  const byBedroom: Record<number, number> = {};
  for (const [br, rows] of byBedroomMap) byBedroom[br] = rows.length;
  return {
    rawListings,
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
  const citySearchTerm = cityWideSearchLocationForBuyInMarket(args.community)
    ?? `${args.community}, Hawaii`;
  const nights = Math.max(
    1,
    Math.round(
      (new Date(`${args.checkOut}T12:00:00`).getTime() - new Date(`${args.checkIn}T12:00:00`).getTime()) / 86_400_000,
    ),
  );
  const { searchVrboViaSidecar } = await import("./vrbo-sidecar-queue");
  console.log(
    `[city-vrbo-inventory] vrbo sidecar start community="${args.community}" ` +
    `search="${citySearchTerm}" mode=destination-dropdown-export-all`,
  );
  const r = await searchVrboViaSidecar({
    destination: citySearchTerm,
    searchTerm: citySearchTerm,
    checkIn: args.checkIn,
    checkOut: args.checkOut,
    bedrooms: 1,
    searchMode: "destination_dropdown",
    cityWideInventory: true,
    walletBudgetMs: CITY_VRBO_WALLET_BUDGET_MS,
    queueBudgetMs: CITY_VRBO_QUEUE_BUDGET_MS,
    queueContext: {
      scanLabel: `city-vrbo-inventory:${args.community}`,
      dateLabel: `${args.checkIn}→${args.checkOut}`,
      skipResultCache: true,
    },
  });
  if (r) {
    console.log(
      `[city-vrbo-inventory] vrbo sidecar finish community="${args.community}" ` +
      `exported=${r.candidates?.length ?? 0} reason="${r.reason ?? ""}"`,
    );
  }

  if (!r) {
    return null;
  }

  const { rawListings, listings, pipeline } = normalizeSidecarCandidates(r.candidates ?? [], nights);
  return {
    expiresAt: Date.now() + CITY_VRBO_CACHE_TTL_MS,
    citySearchTerm,
    nights,
    rawListings,
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
  rawListings: CityVrboListing[];
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
  const citySearchTerm = cityWideSearchLocationForBuyInMarket(args.community)
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
      rawListings: [],
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
    rawListings: scrapeEntry.rawListings,
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
