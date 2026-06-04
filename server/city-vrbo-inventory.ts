import {
  groupCityVrboByBedroom,
  suggestCityVrboComboPair,
  type CityVrboComboPair,
  type CityVrboListing,
} from "@shared/city-vrbo-combo";
import { BUY_IN_MARKET_LOCATIONS, searchLocationForBuyInMarket } from "@shared/buy-in-market";

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

function rawCandidateBedroomSignal(candidate: SidecarVrboCandidate): number | null {
  if (typeof candidate.bedrooms === "number" && Number.isFinite(candidate.bedrooms) && candidate.bedrooms > 0) {
    return Math.round(candidate.bedrooms);
  }
  const text = `${candidate.title ?? ""} ${candidate.snippet ?? ""}`;
  const match = text.match(/\b(\d{1,2})\s*(?:br|bd|bdr|bedrooms?)\b/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function mapSidecarToListing(candidate: SidecarVrboCandidate, nights: number): CityVrboListing | null {
  const total = Math.round(Number(candidate.totalPrice) || 0);
  const nightly = Number(candidate.nightlyPrice) > 0
    ? Math.round(Number(candidate.nightlyPrice))
    : total > 0
      ? Math.round(total / Math.max(1, nights))
      : 0;
  if (total <= 0 && nightly <= 0) return null;
  const bedrooms = rawCandidateBedroomSignal(candidate);
  if (bedrooms === null || bedrooms < 2) return null;
  return {
    url: candidate.url,
    title: candidate.title,
    bedrooms,
    nightlyPrice: nightly > 0 ? nightly : undefined,
    totalPrice: total > 0 ? total : nightly * Math.max(1, nights),
    lat: typeof candidate.lat === "number" && Number.isFinite(candidate.lat) ? candidate.lat : null,
    lng: typeof candidate.lng === "number" && Number.isFinite(candidate.lng) ? candidate.lng : null,
    sourceLabel: "Vrbo",
  };
}

export async function runCityVrboInventoryScan(args: {
  community: string;
  checkIn: string;
  checkOut: string;
  bedroomPlan: number[];
}): Promise<{
  citySearchTerm: string;
  nights: number;
  listings: CityVrboListing[];
  byBedroom: Record<number, CityVrboListing[]>;
  suggestedPair: CityVrboComboPair | null;
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
  const marketLoc = BUY_IN_MARKET_LOCATIONS[args.community];
  const mapSearchCenter = marketLoc
    ? { lat: marketLoc.lat, lng: marketLoc.lng }
    : undefined;
  const mapSearchRadiusKm = 6;
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
      radiusKm: mapSearchRadiusKm,
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
    return {
      citySearchTerm,
      nights,
      listings: [],
      byBedroom: {},
      suggestedPair: null,
      sidecar: {
        workerOnline: false,
        durationMs: 0,
        reason: "VRBO sidecar unavailable (cooldown or offline)",
        rawCount: 0,
        mapHarvest: null,
      },
    };
  }

  const deduped = new Map<string, CityVrboListing>();
  for (const candidate of r.candidates ?? []) {
    const mapped = mapSidecarToListing(candidate, nights);
    if (!mapped) continue;
    const previous = deduped.get(mapped.url);
    const mappedTotal = mapped.totalPrice ?? 0;
    const previousTotal = previous?.totalPrice ?? Number.POSITIVE_INFINITY;
    if (!previous || mappedTotal < previousTotal) deduped.set(mapped.url, mapped);
  }
  const listings = Array.from(deduped.values()).sort((a, b) => (a.totalPrice ?? 0) - (b.totalPrice ?? 0));
  const byBedroomMap = groupCityVrboByBedroom(listings);
  const byBedroom: Record<number, CityVrboListing[]> = {};
  for (const [br, rows] of byBedroomMap) byBedroom[br] = rows;

  const suggestedPair = suggestCityVrboComboPair(listings, args.bedroomPlan, nights);

  console.log(
    `[city-vrbo-inventory] community="${args.community}" term="${citySearchTerm}" ` +
    `${args.checkIn}→${args.checkOut} raw=${r.candidates?.length ?? 0} exported=${listings.length} ` +
    `pair=${suggestedPair ? suggestedPair.resortPhrase : "none"}`,
  );

  return {
    citySearchTerm,
    nights,
    listings,
    byBedroom,
    suggestedPair,
    sidecar: {
      workerOnline: r.workerOnline,
      durationMs: r.durationMs,
      reason: r.reason,
      rawCount: r.candidates?.length ?? 0,
      mapHarvest: r?.mapHarvest ?? null,
    },
  };
}
