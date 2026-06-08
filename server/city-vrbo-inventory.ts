import {
  countCityVrboPhraseBuckets,
  filterCityVrboListingsByPhrase,
  groupCityVrboByBedroom,
  suggestCityVrboComboPair,
  summarizeCityVrboMatching,
  type CityVrboComboPair,
  type CityVrboListing,
} from "@shared/city-vrbo-combo";
import { cityWideSearchLocationForBuyInMarket } from "@shared/buy-in-market";
import {
  buildCityScanCoverage,
  vrboReportedTotalFromMapHarvest,
  type CityVrboCoverage,
} from "@shared/city-vrbo-coverage";

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
  /** Phase 4: set once detail-page coord/gallery enrichment has run for this pool. */
  detailEnriched?: boolean;
  /** Set once the conservative LLM community classifier has run for this pool. */
  llmClassified?: boolean;
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

// Phase 4 — detail-page enrichment. Coordinates aren't on the VRBO SRP/map
// (AGENTS city-inventory #8), so when the cheap text/photo signals fail to find
// a same-community pair we open the listing DETAIL pages of the top few
// candidates (which DO carry coords + a gallery) and attach lat/lng + gallery
// photos. The matcher then geo-clusters by walk distance. Only runs on a no-pair
// result (rare), is bounded + budgeted, and degrades gracefully (a blocked/slow
// VRBO just yields no coords → same as before). Disable with CITY_VRBO_DETAIL_ENRICH=0.
const CITY_VRBO_DETAIL_ENRICH = (process.env.CITY_VRBO_DETAIL_ENRICH ?? "1") !== "0";
// Conservative LLM community classifier (city-vrbo-community-llm.ts): a no-pair
// recovery step that names generically-titled / misspelled / unknown-complex
// listings so they can cluster. Gated; needs ANTHROPIC_API_KEY. Default on.
const CITY_VRBO_LLM_COMMUNITY = (process.env.CITY_VRBO_LLM_COMMUNITY ?? "1") !== "0";
// Per-scan match diagnostics: logs how many priced listings got a community
// signal (and which kind), pairable clusters, and a sample of listings that
// matched NOTHING — to measure whether more matching machinery is worth it and
// to surface the property-manager / boilerplate over-cluster trap. Read-only;
// disable with CITY_VRBO_MATCH_DIAG=0.
const CITY_VRBO_MATCH_DIAG = (process.env.CITY_VRBO_MATCH_DIAG ?? "1") !== "0";
const CITY_VRBO_ENRICH_MAX = Math.max(2, Number(process.env.CITY_VRBO_ENRICH_MAX ?? 8));
// Keep this well under Railway's HTTP edge timeout once added to the main scrape
// (~60-90s) so the whole request stays comfortably bounded. 75s default.
const CITY_VRBO_ENRICH_BUDGET_MS = Math.max(20_000, Number(process.env.CITY_VRBO_ENRICH_BUDGET_MS ?? 75_000));

/**
 * Open the listing detail pages of the top-K cheapest plan-matching candidates
 * that still lack coordinates, and attach lat/lng + gallery photos in place
 * (mutating the cached pool so re-scans keep them). Returns how many got coords.
 * Best-effort: any per-listing failure is swallowed.
 */
async function enrichCityListingsWithDetail(
  entry: CityVrboScrapeCacheEntry,
  bedroomPlan: number[],
): Promise<number> {
  const plan = Array.from(new Set(bedroomPlan.filter((b) => Number.isFinite(b) && b > 0)));
  if (!plan.length) return 0;
  // `!= null` BEFORE Number() — Number(null) === 0 passes isFinite, which would
  // make every coordless listing look already-enriched and select ZERO targets.
  const hasCoords = (l: CityVrboListing) =>
    l.lat != null && l.lng != null && Number.isFinite(Number(l.lat)) && Number.isFinite(Number(l.lng));
  const perBr = Math.max(2, Math.floor(CITY_VRBO_ENRICH_MAX / plan.length));
  const targets: CityVrboListing[] = [];
  for (const br of plan) {
    const rows = entry.listings
      .filter((l) => Math.round(Number(l.bedrooms)) === br && !hasCoords(l))
      .sort((a, b) => (a.totalPrice ?? Number.POSITIVE_INFINITY) - (b.totalPrice ?? Number.POSITIVE_INFINITY))
      .slice(0, perBr);
    targets.push(...rows);
  }
  if (!targets.length) return 0;

  const { scrapeVrboPhotosViaSidecar } = await import("./vrbo-sidecar-queue");
  const deadline = Date.now() + CITY_VRBO_ENRICH_BUDGET_MS;
  const queue = [...targets];
  let enriched = 0;
  const runOne = async (): Promise<void> => {
    while (queue.length > 0 && Date.now() < deadline) {
      const listing = queue.shift();
      if (!listing) break;
      try {
        const remaining = deadline - Date.now();
        if (remaining < 8_000) break; // not enough time to start another fetch
        const res = await scrapeVrboPhotosViaSidecar({
          url: listing.url,
          maxPhotos: 12,
          walletBudgetMs: Math.max(15_000, Math.min(60_000, remaining)),
        });
        if (Number.isFinite(Number(res.lat)) && Number.isFinite(Number(res.lng))) {
          listing.lat = res.lat;
          listing.lng = res.lng;
          enriched += 1;
        }
        if (res.complexName) listing.complexName = res.complexName;
        if (Array.isArray(res.photos) && res.photos.length) {
          listing.images = Array.from(new Set([...(listing.images ?? []), ...res.photos])).slice(0, 12);
        }
      } catch {
        // best-effort; a blocked/slow detail page just leaves this listing coordless
      }
    }
  };
  const concurrency = Math.min(4, targets.length);
  await Promise.all(Array.from({ length: concurrency }, () => runOne()));
  // DATA-QUALITY GUARD: VRBO detail pages can return a single shared region/
  // centroid coordinate for every listing (observed: all candidates →
  // 21.9067,-159.4692). That collapses every unit to one point and would
  // manufacture FALSE "co-located" geo pairs. If the enriched coords don't
  // resolve to multiple distinct locations, they're not per-listing — strip them
  // so geo-clustering can't fire on garbage. (Real per-building coords differ
  // across a diverse top-K set.)
  const coordKey = (l: CityVrboListing) =>
    l.lat != null && l.lng != null ? `${Number(l.lat).toFixed(4)},${Number(l.lng).toFixed(4)}` : null;
  const enrichedRows = targets.filter((l) => coordKey(l) != null);
  const distinctCoords = new Set(enrichedRows.map((l) => coordKey(l))).size;
  if (enrichedRows.length >= 2 && distinctCoords <= 1) {
    for (const l of enrichedRows) { l.lat = null; l.lng = null; }
    console.warn(
      `[city-vrbo-inventory] detail enrichment: ${enrichedRows.length} listings all share one coordinate ` +
      `(region centroid, not per-listing) — stripping coords to avoid false geo pairs`,
    );
    return 0;
  }
  console.log(
    `[city-vrbo-inventory] detail enrichment: ${enriched}/${targets.length} got coords, ${distinctCoords} distinct location(s)`,
  );
  return enriched;
}

function cacheKeyForScrape(community: string, checkIn: string, checkOut: string): string {
  // v3: bumped when the city-wide destination switched from the resort
  // searchLocation to the town-level cityWideSearch (Poipu Kai → "Koloa, Hawaii"),
  // so stale narrow pools from v2 aren't re-served.
  return `${community.toLowerCase()}|${checkIn}|${checkOut}|city-vrbo-dropdown-v3`;
}

// Term-keyed cache namespace for the nearby-city combo expansion
// (server/city-vrbo-expansion.ts). DELIBERATELY DISJOINT from
// cacheKeyForScrape's community-keyed namespace: a nearby town's pool must NEVER
// be served for the home community (or vice-versa). Both live in the same
// cityVrboScrapeCache Map but can never collide because of the distinct
// `term:`/`city-vrbo-term-v1` shape. See AGENTS.md city-inventory notes + the
// expansion design (cache-key isolation guard).
function cacheKeyForCityTerm(citySearchTerm: string, checkIn: string, checkOut: string): string {
  const normalized = citySearchTerm.toLowerCase().replace(/\s+/g, " ").trim();
  return `term:${normalized}|${checkIn}|${checkOut}|city-vrbo-term-v1`;
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

// Resolve the VRBO destination string for a scan. The community-keyed flow
// (find-buy-in / replacement / manual panel) derives the town from the market
// registry; the nearby-city expansion passes an explicit `citySearchTerm`
// ("Lihue, Hawaii"). Either way the value is a plain "City, State" string typed
// into VRBO's visible destination dropdown — NEVER a vrbo.com/search URL (VRBO
// sight+click policy, AGENTS.md Load-Bearing).
function resolveCityVrboSearchTerm(args: { community?: string; citySearchTerm?: string }): string {
  const explicit = args.citySearchTerm?.trim();
  if (explicit) return explicit;
  if (args.community) return cityWideSearchLocationForBuyInMarket(args.community) ?? `${args.community}, Hawaii`;
  return "Hawaii, United States";
}

async function scrapeCityVrboPool(args: {
  community?: string;
  citySearchTerm?: string;
  checkIn: string;
  checkOut: string;
  bedroomPlan: number[];
  walletBudgetMs?: number;
}): Promise<CityVrboScrapeCacheEntry | null> {
  const citySearchTerm = resolveCityVrboSearchTerm(args);
  const nights = Math.max(
    1,
    Math.round(
      (new Date(`${args.checkOut}T12:00:00`).getTime() - new Date(`${args.checkIn}T12:00:00`).getTime()) / 86_400_000,
    ),
  );
  const { searchVrboViaSidecar } = await import("./vrbo-sidecar-queue");
  const scanLabel = args.community ? `city-vrbo-inventory:${args.community}` : `city-vrbo-expansion:${citySearchTerm}`;
  console.log(
    `[city-vrbo-inventory] vrbo sidecar start label="${args.community ?? citySearchTerm}" ` +
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
    walletBudgetMs: args.walletBudgetMs ?? CITY_VRBO_WALLET_BUDGET_MS,
    queueBudgetMs: CITY_VRBO_QUEUE_BUDGET_MS,
    queueContext: {
      scanLabel,
      dateLabel: `${args.checkIn}→${args.checkOut}`,
      skipResultCache: true,
    },
  });
  if (r) {
    console.log(
      `[city-vrbo-inventory] vrbo sidecar finish label="${args.community ?? citySearchTerm}" ` +
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

export type CityVrboScanResult = {
  citySearchTerm: string;
  nights: number;
  rawListings: CityVrboListing[];
  listings: CityVrboListing[];
  byBedroom: Record<number, CityVrboListing[]>;
  suggestedPair: CityVrboComboPair | null;
  filterPipeline: CityVrboFilterPipeline;
  fromCache: boolean;
  // Found-vs-usable-vs-VRBO-total breakdown so the tracker doesn't read the
  // (correctly) >=2BR-filtered count as missing inventory. See city-vrbo-coverage.
  coverage: CityVrboCoverage;
  sidecar: {
    workerOnline: boolean;
    durationMs: number;
    reason: string;
    rawCount: number;
    mapHarvest: Record<string, unknown> | null;
  };
};

// Shared body for both the community-keyed scan (runCityVrboInventoryScan) and
// the explicit-town scan (runCityVrboInventoryScanForCity). The ONLY differences
// between the two callers are the cache key (disjoint namespaces — see
// cacheKeyForCityTerm), the destination term, and the log label; everything else
// (scrape → normalize → phrase/bedroom filter → suggestCityVrboComboPair) is
// identical, so it lives here once.
async function runCityScanCore(args: {
  cacheKey: string;
  logLabel: string;
  community?: string;
  citySearchTerm?: string;
  checkIn: string;
  checkOut: string;
  bedroomPlan: number[];
  filterPhrase?: string;
  skipCache?: boolean;
  walletBudgetMs?: number;
}): Promise<CityVrboScanResult> {
  const citySearchTerm = resolveCityVrboSearchTerm(args);
  const nights = Math.max(
    1,
    Math.round(
      (new Date(`${args.checkOut}T12:00:00`).getTime() - new Date(`${args.checkIn}T12:00:00`).getTime()) / 86_400_000,
    ),
  );
  const cacheKey = args.cacheKey;
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
    scrapeEntry = await scrapeCityVrboPool({
      community: args.community,
      citySearchTerm: args.citySearchTerm,
      checkIn: args.checkIn,
      checkOut: args.checkOut,
      bedroomPlan: args.bedroomPlan,
      walletBudgetMs: args.walletBudgetMs,
    });
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
    logFilterPipeline(args.logLabel, args.checkIn, args.checkOut, emptyPipeline, false);
    return {
      citySearchTerm,
      nights,
      rawListings: [],
      listings: [],
      byBedroom: {},
      suggestedPair: null,
      filterPipeline: emptyPipeline,
      fromCache: false,
      coverage: buildCityScanCoverage({
        rawHarvested: 0,
        usable: 0,
        droppedBelowMinBedrooms: 0,
        droppedNoPrice: 0,
        vrboReportedTotal: null,
      }),
      sidecar: {
        workerOnline: false,
        durationMs: 0,
        reason: "VRBO sidecar unavailable (cooldown or offline)",
        rawCount: 0,
        mapHarvest: null,
      },
    };
  }

  let filtered = applyFiltersToPool(
    scrapeEntry.listings,
    scrapeEntry.normalizePipeline,
    args.bedroomPlan,
    scrapeEntry.nights,
    args.filterPhrase,
  );

  // No-pair recovery (cheap, runs BEFORE the detail-page enrichment): a
  // conservative LLM names each listing's specific complex so generically-titled
  // / misspelled / unknown-complex units can cluster. Sets listing.complexName,
  // which the matcher resolves through the dictionary (so "poipu kie" still
  // normalizes to poipu kai) or keeps as a specific complex key. Mutual
  // validation (>=2 listings sharing a community) is enforced by the matcher's
  // bucket-size gate, so a singleton LLM label can never form a wrong pair.
  if (
    CITY_VRBO_LLM_COMMUNITY &&
    !filtered.suggestedPair &&
    !scrapeEntry.llmClassified &&
    scrapeEntry.listings.length > 0
  ) {
    scrapeEntry.llmClassified = true;
    try {
      const { classifyCityListingCommunities } = await import("./city-vrbo-community-llm");
      const labeled = await classifyCityListingCommunities(scrapeEntry.listings, {
        targetCommunity: args.community ?? args.citySearchTerm ?? null,
      });
      if (labeled > 0) {
        console.log(`[city-vrbo-inventory] LLM community classifier labeled ${labeled} listing(s); re-running matcher`);
        filtered = applyFiltersToPool(
          scrapeEntry.listings,
          scrapeEntry.normalizePipeline,
          args.bedroomPlan,
          scrapeEntry.nights,
          args.filterPhrase,
        );
      }
    } catch (e: any) {
      console.error("[city-vrbo-inventory] LLM community classify failed:", e?.message ?? e);
    }
  }

  // Phase 4: if the cheap text/photo signals found no same-community pair, open
  // the top candidates' detail pages to harvest coordinates (+ galleries) and
  // re-run the matcher — coords let it geo-cluster nearby units the SRP can't.
  if (
    CITY_VRBO_DETAIL_ENRICH &&
    !filtered.suggestedPair &&
    !scrapeEntry.detailEnriched &&
    scrapeEntry.listings.length > 0
  ) {
    try {
      const enriched = await enrichCityListingsWithDetail(scrapeEntry, args.bedroomPlan);
      scrapeEntry.detailEnriched = true;
      if (enriched > 0) {
        console.log(
          `[city-vrbo-inventory] detail-enriched ${enriched} listing(s) with coords; re-running matcher`,
        );
        filtered = applyFiltersToPool(
          scrapeEntry.listings,
          scrapeEntry.normalizePipeline,
          args.bedroomPlan,
          scrapeEntry.nights,
          args.filterPhrase,
        );
      }
    } catch (e: any) {
      console.error("[city-vrbo-inventory] detail enrichment failed:", e?.message ?? e);
    }
  }
  logFilterPipeline(args.logLabel, args.checkIn, args.checkOut, filtered.filterPipeline, fromCache);

  if (CITY_VRBO_MATCH_DIAG) {
    try {
      const diag = summarizeCityVrboMatching(filtered.listings, args.bedroomPlan, scrapeEntry.nights);
      const s = diag.bySignal;
      console.log(
        `[city-vrbo-match-diag] "${args.logLabel}" ${args.checkIn}→${args.checkOut} ` +
        `priced=${diag.pricedTotal} matched=${diag.matched} unmatched=${diag.unmatched} ` +
        `(dict=${s.dictionary} complex=${s.complex} phrase=${s.phrase} photo=${s.photo} pm=${s.propertyManager} none=${s.none}) ` +
        `pairableClusters=${diag.pairableClusters} pair=${filtered.suggestedPair ? "yes" : "no"}` +
        (diag.topClusters.length
          ? ` top=[${diag.topClusters.map((c) => `${c.label}(${String(c.source)[0]})x${c.size}`).join(", ")}]`
          : ""),
      );
      if (diag.unmatchedSample.length) {
        console.log(
          `[city-vrbo-match-diag] unmatched (no community signal): ` +
          diag.unmatchedSample
            .map((u) => `"${u.title.slice(0, 60)}"${u.bedrooms ? ` (${u.bedrooms}BR)` : ""}`)
            .join(" | "),
        );
      }
    } catch (e: any) {
      console.error("[city-vrbo-match-diag] failed:", e?.message ?? e);
    }
  }

  // rawHarvested = every deduped listing the sidecar saw (all bedroom counts);
  // usable = the priced, >=2BR pool the matcher works from (afterNormalize, the
  // pre-phrase-filter count — phrase filters narrow per-search but the city's
  // usable inventory is the >=2BR total). vrboReportedTotal is VRBO's own count.
  const coverage = buildCityScanCoverage({
    rawHarvested: scrapeEntry.rawListings.length,
    usable: filtered.filterPipeline.afterNormalize,
    droppedBelowMinBedrooms: filtered.filterPipeline.droppedBelowMinBedrooms,
    droppedNoPrice: filtered.filterPipeline.droppedNoPrice,
    vrboReportedTotal: vrboReportedTotalFromMapHarvest(scrapeEntry.sidecar.mapHarvest),
  });
  // Observability for a GENUINE under-harvest (vs the >=2BR filter): if we
  // captured well under VRBO's own reported total, warn so it's greppable and
  // the tracker can surface it. The expected case (filtered <2BR) does NOT warn.
  if (!coverage.looksComplete && coverage.vrboReportedTotal) {
    console.warn(
      `[city-vrbo-inventory] INCOMPLETE harvest "${args.logLabel}" ${args.checkIn}→${args.checkOut}: ` +
      `rawHarvested=${coverage.rawHarvested} of VRBO total ${coverage.vrboReportedTotal} ` +
      `(usable >=2BR=${coverage.usable}); scan may have missed pages`,
    );
  }

  return {
    citySearchTerm: scrapeEntry.citySearchTerm,
    nights: scrapeEntry.nights,
    rawListings: scrapeEntry.rawListings,
    listings: filtered.listings,
    byBedroom: filtered.byBedroom,
    suggestedPair: filtered.suggestedPair,
    filterPipeline: filtered.filterPipeline,
    fromCache,
    coverage,
    sidecar: scrapeEntry.sidecar,
  };
}

export async function runCityVrboInventoryScan(args: {
  community: string;
  checkIn: string;
  checkOut: string;
  bedroomPlan: number[];
  filterPhrase?: string;
  skipCache?: boolean;
}): Promise<CityVrboScanResult> {
  return runCityScanCore({
    cacheKey: cacheKeyForScrape(args.community, args.checkIn, args.checkOut),
    logLabel: args.community,
    community: args.community,
    checkIn: args.checkIn,
    checkOut: args.checkOut,
    bedroomPlan: args.bedroomPlan,
    filterPhrase: args.filterPhrase,
    skipCache: args.skipCache,
  });
}

/**
 * Scan an arbitrary town's full VRBO inventory by an explicit "City, State"
 * destination term (the nearby-city combo expansion). Uses the disjoint
 * term-keyed cache namespace so a nearby town's pool can never be served for the
 * home community. The destination is typed into VRBO's visible dropdown via the
 * sidecar — no injected search URLs (VRBO sight+click policy).
 */
export async function runCityVrboInventoryScanForCity(args: {
  citySearchTerm: string;
  checkIn: string;
  checkOut: string;
  bedroomPlan: number[];
  filterPhrase?: string;
  skipCache?: boolean;
  walletBudgetMs?: number;
}): Promise<CityVrboScanResult> {
  return runCityScanCore({
    cacheKey: cacheKeyForCityTerm(args.citySearchTerm, args.checkIn, args.checkOut),
    logLabel: args.citySearchTerm,
    citySearchTerm: args.citySearchTerm,
    checkIn: args.checkIn,
    checkOut: args.checkOut,
    bedroomPlan: args.bedroomPlan,
    filterPhrase: args.filterPhrase,
    skipCache: args.skipCache,
    walletBudgetMs: args.walletBudgetMs,
  });
}

/** Evict cached city pools (tests or admin). */
export function clearCityVrboInventoryCache(community?: string): number {
  if (!community) {
    // Wipes both the community-keyed (`<community>|…|city-vrbo-dropdown-v3`) and
    // the expansion term-keyed (`term:…|city-vrbo-term-v1`) entries — same Map.
    const size = cityVrboScrapeCache.size;
    cityVrboScrapeCache.clear();
    return size;
  }
  // Community-scoped purge only matches the community-keyed namespace; `term:`
  // expansion entries are town-scoped (not tied to a community) and are left
  // alone here — clear them with the no-arg form.
  let removed = 0;
  for (const key of cityVrboScrapeCache.keys()) {
    if (key.startsWith(`${community.toLowerCase()}|`)) {
      cityVrboScrapeCache.delete(key);
      removed += 1;
    }
  }
  return removed;
}
