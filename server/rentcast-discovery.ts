/**
 * RentCast listing discovery for photo-search flows.
 *
 * RentCast returns structured sale listings (address, beds, status) but not
 * portal URLs or photos. Callers resolve addresses to Zillow/Realtor URLs,
 * then use the existing scrape stack (Apify → ScrapingBee → sidecar).
 *
 * Phase 1: API client + normalization. Route wiring lands in PR 2–4.
 */

const RENTCAST_API_BASE = "https://api.rentcast.io/v1";

/** Listing statuses we reject before portal URL resolution (stub / off-market). */
const REJECTED_LISTING_STATUSES = new Set([
  "pending",
  "sold",
  "closed",
  "off market",
  "off-market",
  "withdrawn",
  "expired",
  "cancelled",
  "canceled",
  "contingent",
  "under contract",
]);

export type RentCastListingCandidate = {
  id: string;
  formattedAddress: string;
  addressLine1: string;
  city: string;
  state: string;
  zipCode: string;
  bedrooms: number | null;
  bathrooms: number | null;
  status: string;
  price: number | null;
  latitude: number | null;
  longitude: number | null;
  propertyType: string | null;
  lastSeenDate: string | null;
  streetRoot: string | null;
};

export type RentCastDiscoveryOptions = {
  cities: string[];
  state: string;
  minBedrooms?: number | null;
  maxBedrooms?: number | null;
  /** Max listings per city query (1–500, RentCast API cap). */
  limitPerCity?: number;
  timeoutMs?: number;
  /** When set, only return listings whose street root matches one of these. */
  allowedStreetRoots?: Set<string>;
  /** Condo + townhouse only (vacation-market default). */
  propertyTypes?: string[];
};

export type RentCastDiscoveryResult = {
  candidates: RentCastListingCandidate[];
  rawCount: number;
  filteredCount: number;
  citiesQueried: string[];
  errors: string[];
};

export function stateToAbbrevForRentCast(state: string): string {
  const s = state.trim();
  if (s.length === 2) return s.toUpperCase();
  const map: Record<string, string> = {
    florida: "FL",
    hawaii: "HI",
    california: "CA",
    texas: "TX",
    "new york": "NY",
  };
  return map[s.toLowerCase()] ?? s.slice(0, 2).toUpperCase();
}

export function isRentCastDiscoveryEnabled(): boolean {
  const key = String(process.env.RENTCAST_API_KEY ?? "").trim();
  if (!key) return false;
  const flag = String(process.env.RENTCAST_DISCOVERY_ENABLED ?? "1").trim().toLowerCase();
  return flag !== "0" && flag !== "false" && flag !== "no";
}

/**
 * Canonical street root for dedupe / community anchoring (aligned with routes.ts).
 */
export function streetRootFromRentCastAddress(address: string | null): string | null {
  if (!address) return null;
  const m = address
    .toLowerCase()
    .replace(/&[#a-z0-9]+;/gi, " ")
    .replace(/[^a-z0-9.'#\s-]+/g, " ")
    .replace(/\b(\d{1,2})-(\d{3,5})(?=[\s-]+[a-z0-9])/gi, "$1 $2")
    .replace(/\b(\d{1,2})\s+(\d{3,5})\s+\d{1,4}\s+(?=[a-z])/gi, "$1 $2 ")
    .replace(/\s+/g, " ")
    .match(/\b(\d{2,6})\s+([a-z0-9.'-]+(?:\s+[a-z0-9.'-]+){0,4})\s+(blvd|boulevard|rd|road|st|street|ave|avenue|dr|drive|ln|lane|way|cir|circle|ct|court|pkwy|parkway|pl|place|ter|terrace|trail)\b/i);
  if (!m) return null;
  const typeMap: Record<string, string> = {
    boulevard: "blvd",
    road: "rd",
    street: "st",
    avenue: "ave",
    drive: "dr",
    lane: "ln",
    circle: "cir",
    court: "ct",
    parkway: "pkwy",
    place: "pl",
    terrace: "ter",
  };
  let streetName = m[2]
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.'’‘-]/g, "")
    .replace(/^(?:n|s|e|w|north|south|east|west)\s+/i, "");
  const streetTokens = streetName.split(/\s+/).filter(Boolean);
  if (streetTokens.length >= 2 && /^\d{3,5}$/.test(streetTokens[1])) {
    streetTokens.splice(1, 1);
    streetName = streetTokens.join(" ");
  }
  const suffix = typeMap[m[3].toLowerCase()] ?? m[3].toLowerCase();
  return `${m[1]} ${streetName} ${suffix}`.replace(/\s+/g, " ").trim();
}

function parseNumberField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizeRentCastListing(raw: Record<string, unknown>): RentCastListingCandidate | null {
  const formattedAddress = String(raw.formattedAddress ?? "").trim();
  const addressLine1 = String(raw.addressLine1 ?? "").trim();
  const city = String(raw.city ?? "").trim();
  const state = String(raw.state ?? "").trim();
  if (!formattedAddress && !addressLine1) return null;
  const id = String(raw.id ?? formattedAddress ?? addressLine1).trim();
  if (!id) return null;

  const bedrooms = parseNumberField(raw.bedrooms);
  const bathrooms = parseNumberField(raw.bathrooms);
  const status = String(raw.status ?? "").trim() || "Unknown";
  const formatted = formattedAddress || [addressLine1, city, state, raw.zipCode].filter(Boolean).join(", ");

  return {
    id,
    formattedAddress: formatted,
    addressLine1: addressLine1 || formatted.split(",")[0]?.trim() || formatted,
    city,
    state: state.length === 2 ? state.toUpperCase() : state,
    zipCode: String(raw.zipCode ?? "").trim(),
    bedrooms: bedrooms != null && bedrooms >= 0 && bedrooms <= 12 ? Math.round(bedrooms) : null,
    bathrooms,
    status,
    price: parseNumberField(raw.price),
    latitude: parseNumberField(raw.latitude),
    longitude: parseNumberField(raw.longitude),
    propertyType: raw.propertyType != null ? String(raw.propertyType).trim() : null,
    lastSeenDate: raw.lastSeenDate != null ? String(raw.lastSeenDate).trim() : null,
    streetRoot: streetRootFromRentCastAddress(formatted),
  };
}

export function shouldRejectRentCastListing(candidate: RentCastListingCandidate): string | null {
  const statusNorm = candidate.status.toLowerCase().trim();
  if (statusNorm && REJECTED_LISTING_STATUSES.has(statusNorm)) {
    return `status:${candidate.status}`;
  }
  if (!candidate.streetRoot) return "no-street-root";
  return null;
}

export function passesRentCastBedroomFilter(
  candidate: RentCastListingCandidate,
  minBedrooms?: number | null,
  maxBedrooms?: number | null,
): boolean {
  if (candidate.bedrooms == null) return true;
  if (minBedrooms != null && candidate.bedrooms < minBedrooms) return false;
  if (maxBedrooms != null && candidate.bedrooms > maxBedrooms) return false;
  return true;
}

export function buildRentCastSaleListingsQuery(params: {
  city: string;
  state: string;
  limit: number;
  offset?: number;
  minBedrooms?: number | null;
  maxBedrooms?: number | null;
  propertyTypes?: string[];
}): URLSearchParams {
  const qs = new URLSearchParams();
  qs.set("city", params.city.trim());
  qs.set("state", stateToAbbrevForRentCast(params.state));
  qs.set("status", "Active");
  qs.set("limit", String(Math.max(1, Math.min(500, Math.floor(params.limit)))));
  if (params.offset != null && params.offset > 0) {
    qs.set("offset", String(Math.floor(params.offset)));
  }
  if (params.minBedrooms != null && params.maxBedrooms != null && params.minBedrooms === params.maxBedrooms) {
    qs.set("bedrooms", String(Math.max(0, Math.floor(params.minBedrooms))));
  } else if (params.minBedrooms != null) {
    const max = params.maxBedrooms != null ? Math.floor(params.maxBedrooms) : 12;
    qs.set("bedrooms", `${Math.floor(params.minBedrooms)}:${max}`);
  }
  const types = params.propertyTypes ?? ["Condo", "Townhouse"];
  if (types.length > 0) {
    qs.set("propertyType", types.join(","));
  }
  return qs;
}

async function fetchRentCastSaleListingsPage(
  query: URLSearchParams,
  apiKey: string,
  timeoutMs: number,
): Promise<{ items: Record<string, unknown>[]; error?: string }> {
  const url = `${RENTCAST_API_BASE}/listings/sale?${query.toString()}`;
  try {
    const resp = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Api-Key": apiKey,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return {
        items: [],
        error: `HTTP ${resp.status} ${body.slice(0, 200)}`,
      };
    }
    const data = await resp.json();
    if (!Array.isArray(data)) {
      return { items: [], error: "non-array response" };
    }
    return { items: data.filter((row): row is Record<string, unknown> => row != null && typeof row === "object") };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { items: [], error: message };
  }
}

/**
 * Search active sale listings across one or more cities (RentCast discovery leg).
 */
export async function harvestRentCastSaleListings(
  options: RentCastDiscoveryOptions,
): Promise<RentCastDiscoveryResult> {
  const apiKey = String(process.env.RENTCAST_API_KEY ?? "").trim();
  if (!apiKey || !isRentCastDiscoveryEnabled()) {
    return { candidates: [], rawCount: 0, filteredCount: 0, citiesQueried: [], errors: [] };
  }

  const cities = Array.from(new Set(options.cities.map((c) => c.trim()).filter(Boolean)));
  const state = String(options.state ?? "").trim();
  if (cities.length === 0 || !state) {
    return { candidates: [], rawCount: 0, filteredCount: 0, citiesQueried: [], errors: ["missing city or state"] };
  }

  const limitPerCity = Math.max(1, Math.min(500, options.limitPerCity ?? 100));
  const timeoutMs = Math.max(3_000, Math.min(30_000, options.timeoutMs ?? 12_000));
  const propertyTypes = options.propertyTypes ?? ["Condo", "Townhouse"];
  const errors: string[] = [];
  const seenIds = new Set<string>();
  const candidates: RentCastListingCandidate[] = [];
  let rawCount = 0;

  await Promise.all(cities.map(async (city) => {
    const query = buildRentCastSaleListingsQuery({
      city,
      state,
      limit: limitPerCity,
      minBedrooms: options.minBedrooms,
      maxBedrooms: options.maxBedrooms,
      propertyTypes,
    });
    const { items, error } = await fetchRentCastSaleListingsPage(query, apiKey, timeoutMs);
    if (error) {
      errors.push(`${city}: ${error}`);
      console.warn(`[rentcast-discovery] ${city}, ${stateToAbbrevForRentCast(state)}: ${error}`);
      return;
    }
    rawCount += items.length;
    for (const item of items) {
      const normalized = normalizeRentCastListing(item);
      if (!normalized) continue;
      if (seenIds.has(normalized.id)) continue;
      const rejectReason = shouldRejectRentCastListing(normalized);
      if (rejectReason) continue;
      if (!passesRentCastBedroomFilter(normalized, options.minBedrooms, options.maxBedrooms)) continue;
      if (options.allowedStreetRoots && options.allowedStreetRoots.size > 0) {
        if (!normalized.streetRoot || !options.allowedStreetRoots.has(normalized.streetRoot)) continue;
      }
      seenIds.add(normalized.id);
      candidates.push(normalized);
    }
  }));

  console.log(
    `[rentcast-discovery] cities=${cities.join("|")} state=${stateToAbbrevForRentCast(state)} ` +
    `raw=${rawCount} kept=${candidates.length} errors=${errors.length}`,
  );

  return {
    candidates,
    rawCount,
    filteredCount: candidates.length,
    citiesQueried: cities,
    errors,
  };
}

export type ResolvedPortalUrls = {
  zillowUrl: string | null;
  realtorUrl: string | null;
};

export function buildRentCastPortalLookupQueries(listing: RentCastListingCandidate): {
  zillow: string;
  realtor: string;
} {
  const street = listing.addressLine1 || listing.formattedAddress.split(",")[0]?.trim() || "";
  const city = listing.city.trim();
  const stateAbbr = listing.state.length === 2
    ? listing.state.toUpperCase()
    : stateToAbbrevForRentCast(listing.state);
  const quotedStreet = `"${street}"`;
  return {
    zillow: `site:zillow.com/homedetails ${quotedStreet} "${city}" "${stateAbbr}"`.replace(/\s+/g, " ").trim(),
    realtor: `site:realtor.com/realestateandhomes-detail ${quotedStreet} "${city}" "${stateAbbr}"`.replace(/\s+/g, " ").trim(),
  };
}

async function searchApiPortalUrl(
  query: string,
  pattern: RegExp,
  apiKey: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const resp = await fetch(
      `https://www.searchapi.io/api/v1/search?engine=google&q=${encodeURIComponent(query)}&num=5&api_key=${apiKey}`,
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!resp.ok) return null;
    const data = await resp.json() as { organic_results?: Array<{ link?: string }> };
    for (const row of data.organic_results ?? []) {
      const link = String(row.link ?? "").split("?")[0].trim();
      if (pattern.test(link)) return link;
    }
  } catch {
    /* try next */
  }
  return null;
}

export async function resolveRentCastListingToPortalUrls(opts: {
  listing: RentCastListingCandidate;
  searchApiKey: string;
  timeoutMs?: number;
}): Promise<ResolvedPortalUrls> {
  const timeoutMs = Math.max(3_000, Math.min(15_000, opts.timeoutMs ?? 10_000));
  const queries = buildRentCastPortalLookupQueries(opts.listing);
  const [zillowUrl, realtorUrl] = await Promise.all([
    searchApiPortalUrl(queries.zillow, /zillow\.com\/homedetails\//i, opts.searchApiKey, timeoutMs),
    searchApiPortalUrl(queries.realtor, /realtor\.com\/realestateandhomes-detail\//i, opts.searchApiKey, timeoutMs),
  ]);
  return { zillowUrl, realtorUrl };
}

export type RentCastPortalResolutionResult = {
  resolvedZillow: number;
  resolvedRealtor: number;
  lookupsRun: number;
  urls: Array<{ zillow: string | null; realtor: string | null; streetRoot: string | null }>;
};

/**
 * Resolve unique RentCast street roots to Zillow/Realtor detail URLs via SearchAPI.
 */
export async function resolveRentCastCandidatesToPortalUrls(opts: {
  listings: RentCastListingCandidate[];
  searchApiKey: string;
  maxLookups?: number;
  timeoutMs?: number;
}): Promise<RentCastPortalResolutionResult> {
  const maxLookups = Math.max(1, Math.min(80, opts.maxLookups ?? 40));
  const timeoutMs = Math.max(3_000, Math.min(15_000, opts.timeoutMs ?? 10_000));
  const byRoot = new Map<string, RentCastListingCandidate>();
  for (const listing of opts.listings) {
    const root = listing.streetRoot;
    if (!root || byRoot.has(root)) continue;
    byRoot.set(root, listing);
  }
  const toResolve = Array.from(byRoot.values()).slice(0, maxLookups);
  const urls: Array<{ zillow: string | null; realtor: string | null; streetRoot: string | null }> = [];
  let resolvedZillow = 0;
  let resolvedRealtor = 0;

  const lookupConcurrency = 6;
  for (let i = 0; i < toResolve.length; i += lookupConcurrency) {
    const batch = toResolve.slice(i, i + lookupConcurrency);
    const batchResults = await Promise.all(batch.map(async (listing) => {
      const resolved = await resolveRentCastListingToPortalUrls({
        listing,
        searchApiKey: opts.searchApiKey,
        timeoutMs,
      });
      return {
        zillow: resolved.zillowUrl,
        realtor: resolved.realtorUrl,
        streetRoot: listing.streetRoot,
      };
    }));
    for (const row of batchResults) {
      urls.push(row);
      if (row.zillow) resolvedZillow += 1;
      if (row.realtor) resolvedRealtor += 1;
    }
  }

  console.log(
    `[rentcast-discovery] portal resolve lookups=${toResolve.length} ` +
    `zillow=${resolvedZillow} realtor=${resolvedRealtor}`,
  );

  return {
    resolvedZillow,
    resolvedRealtor,
    lookupsRun: toResolve.length,
    urls,
  };
}
