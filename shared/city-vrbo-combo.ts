import { textMatchesResortPhrase } from "./buy-in-market";
import { haversineFeet, MAX_BUY_IN_WALK_MINUTES, walkMinutesFromFeet } from "./walking-distance";

export type CityVrboListing = {
  url: string;
  title: string;
  bedrooms?: number | null;
  bathrooms?: number | null;
  sleeps?: number | null;
  nightlyPrice?: number;
  totalPrice?: number;
  rating?: number | null;
  reviewCount?: number | null;
  lat?: number | null;
  lng?: number | null;
  sourceLabel?: string;
  locationText?: string | null;
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

export type CityVrboComboPair = {
  resortPhrase: string;
  bedrooms: number[];
  picks: CityVrboListing[];
  totalCost: number;
  walkMinutes: number | null;
  walkSource: "coords" | "shared-phrase" | "unknown";
};

function normalizedIdentityText(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isGenericRentalTitle(value: string): boolean {
  const t = normalizedIdentityText(value);
  if (!t) return true;
  if (/^(?:condo|apartment|townhouse|home|house|villa|rental unit|guest suite|loft|cottage|bungalow|place)\s+in\s+[a-z ]+$/.test(t)) return true;
  if (/^(?:beautiful|lovely|spacious|modern|luxury|elegant)?\s*(?:\d+\s*(?:br|bedroom)\s*)?(?:condo|apartment|townhouse|home|house|villa|rental)$/.test(t)) return true;
  return false;
}

export function sharedResortPhraseKeys(candidate: Pick<CityVrboListing, "title" | "sourceLabel">): string[] {
  const text = normalizedIdentityText([candidate.title, candidate.sourceLabel].filter(Boolean).join(" "));
  if (!text) return [];

  const keys = new Set<string>();
  const patterns = [
    /\b(villas? of [a-z0-9 ]{3,40}?)(?:\s+\d{1,4}|\s+(?:condo|townhome|townhouse|villa|unit|kauai|princeville|hawaii)\b|$)/g,
    /\b([a-z0-9 ]{3,40}? villas?)(?:\s+\d{1,4}|\s+(?:condo|townhome|townhouse|villa|unit|kauai|princeville|hawaii)\b|$)/g,
    /\b([a-z0-9 ]{3,40}? resort)(?:\s+\d{1,4}|\s+(?:condo|townhome|townhouse|villa|unit|kauai|princeville|hawaii)\b|$)/g,
    /\b([a-z0-9 ]{3,40}? plantation)(?:\s+\d{1,4}|\s+(?:condo|townhome|townhouse|villa|unit|kauai|princeville|hawaii)\b|$)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const key = normalizedIdentityText(match[1]);
      if (key.length >= 10 && !isGenericRentalTitle(key)) keys.add(key);
    }
  }
  return Array.from(keys);
}

export function listingTotalPrice(listing: CityVrboListing, nights: number): number {
  if (listing.totalPrice && listing.totalPrice > 0) return listing.totalPrice;
  if (listing.nightlyPrice && listing.nightlyPrice > 0) return listing.nightlyPrice * Math.max(1, nights);
  return 0;
}

function walkMinutesBetween(a: CityVrboListing, b: CityVrboListing): number | null {
  const latA = typeof a.lat === "number" ? a.lat : null;
  const lngA = typeof a.lng === "number" ? a.lng : null;
  const latB = typeof b.lat === "number" ? b.lat : null;
  const lngB = typeof b.lng === "number" ? b.lng : null;
  if (latA === null || lngA === null || latB === null || lngB === null) return null;
  const feet = haversineFeet(latA, lngA, latB, lngB);
  return walkMinutesFromFeet(feet);
}

export function pairIsWalkable(picks: CityVrboListing[]): { ok: boolean; walkMinutes: number | null; walkSource: CityVrboComboPair["walkSource"] } {
  if (picks.length < 2) return { ok: true, walkMinutes: null, walkSource: "unknown" };
  const a = picks[0];
  const b = picks[1];
  const aKeys = new Set(sharedResortPhraseKeys(a));
  if (aKeys.size > 0 && sharedResortPhraseKeys(b).some((key) => aKeys.has(key))) {
    return { ok: true, walkMinutes: null, walkSource: "shared-phrase" };
  }
  const minutes = walkMinutesBetween(a, b);
  if (minutes === null) return { ok: false, walkMinutes: null, walkSource: "unknown" };
  return {
    ok: minutes <= MAX_BUY_IN_WALK_MINUTES,
    walkMinutes: minutes,
    walkSource: "coords",
  };
}

export function suggestCityVrboComboPair(
  listings: CityVrboListing[],
  bedroomPlan: number[],
  nights: number,
): CityVrboComboPair | null {
  const plan = bedroomPlan.filter((br) => Number.isFinite(br) && br > 0);
  const uniquePlan = Array.from(new Set(plan));
  if (uniquePlan.length < 2) return null;

  const priced = listings
    .map((listing) => ({
      listing,
      total: listingTotalPrice(listing, nights),
      br: typeof listing.bedrooms === "number" && Number.isFinite(listing.bedrooms) ? Math.round(listing.bedrooms) : null,
    }))
    .filter((row) => row.total > 0 && row.br !== null && row.br > 0);

  const byPhrase = new Map<string, typeof priced>();
  for (const row of priced) {
    const keys = sharedResortPhraseKeys(row.listing);
    const phraseKey = keys[0] ?? normalizedIdentityText(row.listing.title).slice(0, 48);
    if (!phraseKey || phraseKey.length < 8) continue;
    const bucket = byPhrase.get(phraseKey) ?? [];
    bucket.push(row);
    byPhrase.set(phraseKey, bucket);
  }

  let best: CityVrboComboPair | null = null;
  for (const [resortPhrase, bucket] of byPhrase) {
    const picks: CityVrboListing[] = [];
    for (const targetBr of plan) {
      const match = bucket
        .filter((row) => row.br === targetBr)
        .sort((a, b) => a.total - b.total)[0];
      if (!match) {
        picks.length = 0;
        break;
      }
      picks.push(match.listing);
    }
    if (picks.length !== plan.length) continue;
    const walk = pairIsWalkable(picks);
    if (!walk.ok) continue;
    const totalCost = picks.reduce((sum, pick) => sum + listingTotalPrice(pick, nights), 0);
    if (!best || totalCost < best.totalCost) {
      best = {
        resortPhrase,
        bedrooms: plan,
        picks,
        totalCost,
        walkMinutes: walk.walkMinutes,
        walkSource: walk.walkSource,
      };
    }
  }
  return best;
}

/** Optional operator phrase (e.g. Kamalii) applied to the in-memory scrape pool before pairing. */
export function filterCityVrboListingsByPhrase(listings: CityVrboListing[], phrase: string): CityVrboListing[] {
  const trimmed = String(phrase ?? "").trim();
  if (!trimmed) return listings;
  return listings.filter((listing) =>
    textMatchesResortPhrase(`${listing.title ?? ""} ${listing.sourceLabel ?? ""}`, trimmed),
  );
}

export function countCityVrboPhraseBuckets(listings: CityVrboListing[]): number {
  const keys = new Set<string>();
  for (const listing of listings) {
    const phraseKey = sharedResortPhraseKeys(listing)[0];
    if (phraseKey) keys.add(phraseKey);
  }
  return keys.size;
}

export function groupCityVrboByBedroom(listings: CityVrboListing[]): Map<number, CityVrboListing[]> {
  const map = new Map<number, CityVrboListing[]>();
  for (const listing of listings) {
    const br = typeof listing.bedrooms === "number" && Number.isFinite(listing.bedrooms)
      ? Math.round(listing.bedrooms)
      : 0;
    if (br <= 0) continue;
    const bucket = map.get(br) ?? [];
    bucket.push(listing);
    map.set(br, bucket);
  }
  for (const [br, bucket] of map) {
    bucket.sort((a, b) => listingTotalPrice(a, 1) - listingTotalPrice(b, 1));
    map.set(br, bucket);
  }
  return map;
}
