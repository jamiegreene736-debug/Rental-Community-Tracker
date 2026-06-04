/**
 * RealtyAPI (realtor.realtyapi.io) community listing discovery.
 *
 * Primary strategy (per operator Pili Mai playbook):
 *   1. GET /search/bylocation with community name ("Pili Mai at Poipu", aliases)
 *   2. Fallback: canonical street address, ZIP, city+state
 *   3. Paginate until nextPage=false or profile page cap
 *
 * Returns Realtor detail URLs + structured addresses. Photos still come from
 * the portal scrape stack (Load-Bearing #5); search thumbnails are hints only.
 */

import {
  communityAddressRuleForName,
  discoveryCommunityNameAliases,
  discoverySearchCitiesForPhotoSearch,
} from "@shared/community-addresses";
import { streetRootFromRentCastAddress } from "./rentcast-discovery";

const REALTYAPI_REALTOR_BASES = [
  "https://realtor.realtyapi.io",
  "https://api.realtyapi.io",
] as const;

const REALTOR_DETAIL_PATH = /realtor\.com\/realestateandhomes-detail\//i;

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

export type RealtyApiListingCandidate = {
  propertyId: string | null;
  listingId: string | null;
  listingUrl: string;
  formattedAddress: string;
  addressLine1: string;
  city: string;
  state: string;
  zipCode: string;
  unitNumber: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  sqft: number | null;
  status: string;
  price: number | null;
  streetRoot: string | null;
  searchLocation: string;
};

export type RealtyApiDiscoveryProfile = "bounded" | "standard" | "cityWide" | "findUnit";

export type RealtyApiDiscoveryOptions = {
  communityName: string;
  streetAddress?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  minBedrooms?: number | null;
  maxBedrooms?: number | null;
  profile?: RealtyApiDiscoveryProfile;
  allowedStreetRoots?: Set<string>;
  /** When true, require keyword or street-root match to community (stricter). */
  strictCommunityAnchor?: boolean;
};

export type RealtyApiDiscoveryResult = {
  candidates: RealtyApiListingCandidate[];
  rawCount: number;
  filteredCount: number;
  pagesFetched: number;
  locationsTried: string[];
  errors: string[];
};

export type RealtyApiDiscoveryTuning = {
  resultCount: number;
  maxPagesPerLocation: number;
  maxLocations: number;
  requestTimeoutMs: number;
  pageDelayMs: number;
};

function realtyApiEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

export function isRealtyApiDiscoveryEnabled(): boolean {
  const key = String(process.env.REALTYAPI_API_KEY ?? "").trim();
  if (!key) return false;
  const flag = String(process.env.REALTYAPI_DISCOVERY_ENABLED ?? "1").trim().toLowerCase();
  return flag !== "0" && flag !== "false" && flag !== "no";
}

export function realtyApiDiscoveryTuning(profile: RealtyApiDiscoveryProfile): RealtyApiDiscoveryTuning {
  const defaults: Record<RealtyApiDiscoveryProfile, RealtyApiDiscoveryTuning> = {
    bounded: { resultCount: 50, maxPagesPerLocation: 2, maxLocations: 5, requestTimeoutMs: 15_000, pageDelayMs: 300 },
    standard: { resultCount: 100, maxPagesPerLocation: 8, maxLocations: 10, requestTimeoutMs: 18_000, pageDelayMs: 250 },
    cityWide: { resultCount: 100, maxPagesPerLocation: 5, maxLocations: 6, requestTimeoutMs: 18_000, pageDelayMs: 250 },
    findUnit: { resultCount: 75, maxPagesPerLocation: 4, maxLocations: 8, requestTimeoutMs: 15_000, pageDelayMs: 300 },
  };
  const base = defaults[profile];
  return {
    resultCount: realtyApiEnvInt("REALTYAPI_RESULT_COUNT", base.resultCount, 10, 200),
    maxPagesPerLocation: realtyApiEnvInt("REALTYAPI_MAX_PAGES_PER_LOCATION", base.maxPagesPerLocation, 1, 20),
    maxLocations: realtyApiEnvInt("REALTYAPI_MAX_LOCATIONS", base.maxLocations, 1, 15),
    requestTimeoutMs: realtyApiEnvInt("REALTYAPI_REQUEST_TIMEOUT_MS", base.requestTimeoutMs, 5_000, 45_000),
    pageDelayMs: realtyApiEnvInt("REALTYAPI_PAGE_DELAY_MS", base.pageDelayMs, 0, 2_000),
  };
}

function parseNumberField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickString(...values: unknown[]): string {
  for (const v of values) {
    const s = String(v ?? "").trim();
    if (s) return s;
  }
  return "";
}

function walkObjects(root: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 4 || root == null) return [];
  if (Array.isArray(root)) {
    return root.flatMap((item) => walkObjects(item, depth + 1));
  }
  if (typeof root === "object") return [root as Record<string, unknown>];
  return [];
}

function extractListingRows(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const arrays: unknown[] = [
    root.listings,
    root.results,
    root.properties,
    root.homes,
    root.data,
  ];
  for (const entry of arrays) {
    if (Array.isArray(entry)) return entry.filter((r) => r && typeof r === "object") as Record<string, unknown>[];
    if (entry && typeof entry === "object") {
      const nested = entry as Record<string, unknown>;
      for (const key of ["listings", "results", "properties", "homes", "data"]) {
        const arr = nested[key];
        if (Array.isArray(arr)) return arr.filter((r) => r && typeof r === "object") as Record<string, unknown>[];
      }
    }
  }
  return [];
}

function extractNextPage(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const o = payload as Record<string, unknown>;
  if (typeof o.nextPage === "boolean") return o.nextPage;
  if (typeof o.next_page === "boolean") return o.next_page;
  if (typeof o.hasMore === "boolean") return o.hasMore;
  if (typeof o.has_more === "boolean") return o.has_more;
  const meta = o.meta ?? o.pagination;
  if (meta && typeof meta === "object") {
    const m = meta as Record<string, unknown>;
    if (typeof m.nextPage === "boolean") return m.nextPage;
    if (typeof m.has_more === "boolean") return m.has_more;
  }
  return false;
}

function extractListingUrl(row: Record<string, unknown>): string | null {
  const direct = pickString(
    row.permalink,
    row.href,
    row.url,
    row.link,
    row.listing_url,
    row.listingUrl,
    row.property_url,
    row.propertyUrl,
  );
  if (direct && REALTOR_DETAIL_PATH.test(direct)) return direct.split("?")[0].trim();

  const desc = row.description;
  if (desc && typeof desc === "object") {
    const d = desc as Record<string, unknown>;
    const fromDesc = pickString(d.href, d.url, d.link);
    if (fromDesc && REALTOR_DETAIL_PATH.test(fromDesc)) return fromDesc.split("?")[0].trim();
  }

  const location = row.location;
  if (location && typeof location === "object") {
    const loc = location as Record<string, unknown>;
    const fromLoc = pickString(loc.href, loc.url);
    if (fromLoc && REALTOR_DETAIL_PATH.test(fromLoc)) return fromLoc.split("?")[0].trim();
  }

  for (const nested of walkObjects(row)) {
    const u = pickString(nested.permalink, nested.href, nested.url, nested.link);
    if (u && REALTOR_DETAIL_PATH.test(u)) return u.split("?")[0].trim();
  }

  return null;
}

function extractAddressParts(row: Record<string, unknown>): {
  line1: string;
  city: string;
  state: string;
  zip: string;
  formatted: string;
} {
  const addr = row.address;
  if (addr && typeof addr === "object") {
    const a = addr as Record<string, unknown>;
    const line = pickString(a.line, a.line1, a.street_address, a.streetAddress, a.full_line, a.fullLine);
    const city = pickString(a.city, a.locality, a.address_locality);
    const state = pickString(a.state_code, a.stateCode, a.state);
    const zip = pickString(a.postal_code, a.postalCode, a.zip, a.zipCode);
    const formatted = pickString(a.formatted, a.full, a.full_address) || [line, city, state, zip].filter(Boolean).join(", ");
    return { line1: line, city, state, zip, formatted };
  }

  const location = row.location;
  if (location && typeof location === "object") {
    const loc = location as Record<string, unknown>;
    const addr2 = loc.address;
    if (addr2 && typeof addr2 === "object") {
      const a = addr2 as Record<string, unknown>;
      const line = pickString(a.line, a.line1, a.street_address, a.streetAddress);
      const city = pickString(a.city, a.locality);
      const state = pickString(a.state_code, a.stateCode, a.state);
      const zip = pickString(a.postal_code, a.postalCode, a.zip);
      const formatted = pickString(a.formatted) || [line, city, state, zip].filter(Boolean).join(", ");
      return { line1: line, city, state, zip, formatted };
    }
  }

  const line = pickString(row.street_address, row.streetAddress, row.address_line1, row.addressLine1);
  const city = pickString(row.city, row.locality);
  const state = pickString(row.state_code, row.stateCode, row.state);
  const zip = pickString(row.postal_code, row.postalCode, row.zip_code, row.zipCode);
  const formatted = pickString(row.formatted_address, row.formattedAddress, row.full_address)
    || [line, city, state, zip].filter(Boolean).join(", ");
  return { line1: line, city, state, zip, formatted };
}

function extractUnitNumber(line1: string, formatted: string): string | null {
  const text = `${line1} ${formatted}`;
  const m = text.match(/\b(?:unit|apt|apartment|#|ste|suite)\s*#?\s*([a-z0-9-]+)\b/i)
    || text.match(/\b(?:bldg|building)\s*#?\s*([a-z0-9-]+)\b/i);
  return m?.[1]?.trim() ?? null;
}

export function normalizeRealtyApiListing(
  row: Record<string, unknown>,
  searchLocation: string,
): RealtyApiListingCandidate | null {
  const listingUrl = extractListingUrl(row);
  if (!listingUrl) return null;

  const { line1, city, state, zip, formatted } = extractAddressParts(row);
  if (!formatted && !line1) return null;

  const bedrooms = parseNumberField(row.beds ?? row.bedrooms ?? row.bed ?? row.bedroom_count);
  const bathrooms = parseNumberField(row.baths ?? row.bathrooms ?? row.bath ?? row.bathroom_count);
  const sqft = parseNumberField(row.sqft ?? row.sqft_raw ?? row.square_feet ?? row.living_area);
  const status = pickString(row.status, row.listing_status, row.home_status) || "Unknown";
  const price = parseNumberField(row.price ?? row.list_price ?? row.listPrice);
  const propertyId = pickString(row.property_id, row.propertyId, row.mpr_id, row.mprId) || null;
  const listingId = pickString(row.listing_id, row.listingId) || null;
  const formattedAddress = formatted || line1;
  const streetRoot = streetRootFromRentCastAddress(formattedAddress);

  return {
    propertyId,
    listingId,
    listingUrl,
    formattedAddress,
    addressLine1: line1 || formattedAddress.split(",")[0]?.trim() || formattedAddress,
    city,
    state: state.length === 2 ? state.toUpperCase() : state,
    zipCode: zip,
    unitNumber: extractUnitNumber(line1, formattedAddress),
    bedrooms: bedrooms != null && bedrooms >= 0 && bedrooms <= 12 ? Math.round(bedrooms) : null,
    bathrooms,
    sqft,
    status,
    price,
    streetRoot,
    searchLocation,
  };
}

export function shouldRejectRealtyApiListing(candidate: RealtyApiListingCandidate): string | null {
  const statusNorm = candidate.status.toLowerCase().trim();
  if (statusNorm && REJECTED_LISTING_STATUSES.has(statusNorm)) {
    return `status:${candidate.status}`;
  }
  if (!candidate.listingUrl || !REALTOR_DETAIL_PATH.test(candidate.listingUrl)) {
    return "no-realtor-detail-url";
  }
  return null;
}

export function passesRealtyApiBedroomFilter(
  candidate: RealtyApiListingCandidate,
  minBedrooms?: number | null,
  maxBedrooms?: number | null,
): boolean {
  if (candidate.bedrooms == null) return true;
  if (minBedrooms != null && candidate.bedrooms < minBedrooms) return false;
  if (maxBedrooms != null && candidate.bedrooms > maxBedrooms) return false;
  return true;
}

export function zipFromAddressHint(address: string | null | undefined): string | null {
  if (!address) return null;
  const m = address.match(/\b(\d{5})(?:-\d{4})?\b/);
  return m?.[1] ?? null;
}

/**
 * Ordered RealtyAPI location strings — community-first, then street/ZIP/city fallbacks.
 */
export function buildRealtyApiCommunitySearchLocations(input: {
  communityName: string;
  streetAddress?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
}): string[] {
  const community = String(input.communityName ?? "").trim();
  const street = String(input.streetAddress ?? "").trim();
  const city = String(input.city ?? "").trim();
  const state = String(input.state ?? "").trim();
  const rule = communityAddressRuleForName(community);
  const canonicalStreet = rule?.street || street;
  const zip = String(input.zipCode ?? "").trim() || zipFromAddressHint(canonicalStreet) || zipFromAddressHint(street);
  const cities = discoverySearchCitiesForPhotoSearch({
    city: city || rule?.city,
    communityName: community,
    streetAddress: canonicalStreet || street,
  });
  const names = discoveryCommunityNameAliases(community);
  const locations: string[] = [];

  const push = (value: string) => {
    const v = value.replace(/\s+/g, " ").trim();
    if (!v) return;
    if (!locations.includes(v)) locations.push(v);
  };

  for (const name of names) {
    push(name);
    if (/at\s+/i.test(name)) {
      const short = name.replace(/\s+at\s+.+$/i, "").trim();
      if (short) push(short);
    }
  }

  if (canonicalStreet && city && state) {
    push(`${canonicalStreet}, ${city}, ${state}`);
  } else if (canonicalStreet) {
    push(canonicalStreet);
  }

  if (zip) push(zip);

  for (const searchCity of cities) {
    if (state) push(`${searchCity}, ${state}`);
    for (const name of names.slice(0, 2)) {
      push(`${name}, ${searchCity}, ${state}`);
    }
  }

  if (city && state) push(`${city}, ${state}`);

  return locations;
}

export function buildRealtyApiSearchParams(opts: {
  location: string;
  page: number;
  resultCount: number;
  minBedrooms?: number | null;
  maxBedrooms?: number | null;
  keywords?: string | null;
}): URLSearchParams {
  const qs = new URLSearchParams();
  qs.set("location", opts.location.trim());
  qs.set("page", String(Math.max(1, Math.floor(opts.page))));
  qs.set("resultCount", String(Math.max(1, Math.min(200, Math.floor(opts.resultCount)))));
  qs.set("searchType", "For_Sale");
  qs.set("propertyType", "Condo,Townhome");
  qs.set("pending", "false");
  qs.set("hasPhotos", "true");
  if (opts.keywords?.trim()) qs.set("keywords", opts.keywords.trim());
  if (opts.minBedrooms != null && opts.maxBedrooms != null && opts.minBedrooms === opts.maxBedrooms) {
    qs.set("bedsRange", `min:${Math.floor(opts.minBedrooms)},max:${Math.floor(opts.maxBedrooms)}`);
  } else if (opts.minBedrooms != null) {
    const max = opts.maxBedrooms != null ? Math.floor(opts.maxBedrooms) : 12;
    qs.set("bedsRange", `min:${Math.floor(opts.minBedrooms)},max:${max}`);
  } else if (opts.maxBedrooms != null) {
    qs.set("bedsRange", `max:${Math.floor(opts.maxBedrooms)}`);
  }
  return qs;
}

function realtyApiAuthHeaders(apiKey: string): Record<string, string> {
  return {
    Accept: "application/json",
    "x-realtyapi-key": apiKey,
    Authorization: `Bearer ${apiKey}`,
  };
}

async function fetchRealtyApiSearchPage(
  apiKey: string,
  qs: URLSearchParams,
  timeoutMs: number,
): Promise<{ payload: unknown; error?: string }> {
  let lastError = "no-response";
  for (const base of REALTYAPI_REALTOR_BASES) {
    const url = `${base}/search/bylocation?${qs.toString()}`;
    try {
      const resp = await fetch(url, {
        headers: realtyApiAuthHeaders(apiKey),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        lastError = `HTTP ${resp.status} ${body.slice(0, 200)}`;
        continue;
      }
      const payload = await resp.json().catch(() => null);
      if (payload == null) {
        lastError = "non-json response";
        continue;
      }
      return { payload };
    } catch (e: unknown) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { payload: null, error: lastError };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function communityKeywordTerms(communityName: string): string {
  const names = discoveryCommunityNameAliases(communityName);
  const terms = names
    .map((n) => n.replace(/\s+at\s+/i, " ").trim())
    .filter(Boolean)
    .slice(0, 3);
  return terms.join(",");
}

function passesCommunityAnchor(
  candidate: RealtyApiListingCandidate,
  opts: {
    allowedStreetRoots?: Set<string>;
    strictCommunityAnchor: boolean;
    ruleStreetRoot: string | null;
    communityKeywords: string[];
  },
): boolean {
  if (opts.allowedStreetRoots && opts.allowedStreetRoots.size > 0) {
    if (!candidate.streetRoot || !opts.allowedStreetRoots.has(candidate.streetRoot)) return false;
    return true;
  }
  if (opts.ruleStreetRoot && candidate.streetRoot === opts.ruleStreetRoot) return true;
  if (!opts.strictCommunityAnchor) return true;
  const hay = `${candidate.formattedAddress} ${candidate.addressLine1}`.toLowerCase();
  return opts.communityKeywords.some((term) => {
    const t = term.toLowerCase().trim();
    return t.length >= 4 && hay.includes(t);
  });
}

/**
 * Harvest Realtor.com listings for a vacation community (paginated, multi-location).
 */
export async function harvestRealtyApiCommunityListings(
  options: RealtyApiDiscoveryOptions,
): Promise<RealtyApiDiscoveryResult> {
  const apiKey = String(process.env.REALTYAPI_API_KEY ?? "").trim();
  if (!apiKey || !isRealtyApiDiscoveryEnabled()) {
    return {
      candidates: [],
      rawCount: 0,
      filteredCount: 0,
      pagesFetched: 0,
      locationsTried: [],
      errors: [],
    };
  }

  const profile = options.profile ?? "standard";
  const tuning = realtyApiDiscoveryTuning(profile);
  const locations = buildRealtyApiCommunitySearchLocations({
    communityName: options.communityName,
    streetAddress: options.streetAddress,
    city: options.city,
    state: options.state,
    zipCode: options.zipCode,
  }).slice(0, tuning.maxLocations);

  const rule = communityAddressRuleForName(options.communityName);
  const ruleStreetRoot = streetRootFromRentCastAddress(rule?.street ?? options.streetAddress ?? null);
  const keywords = communityKeywordTerms(options.communityName);
  const communityKeywords = discoveryCommunityNameAliases(options.communityName);
  const strictCommunityAnchor = options.strictCommunityAnchor !== false;

  const seenUrls = new Set<string>();
  const candidates: RealtyApiListingCandidate[] = [];
  const errors: string[] = [];
  let rawCount = 0;
  let pagesFetched = 0;

  for (const location of locations) {
    let page = 1;
    let nextPage = true;
    while (nextPage && page <= tuning.maxPagesPerLocation) {
      const qs = buildRealtyApiSearchParams({
        location,
        page,
        resultCount: tuning.resultCount,
        minBedrooms: options.minBedrooms,
        maxBedrooms: options.maxBedrooms,
        keywords: page === 1 ? keywords : null,
      });
      const { payload, error } = await fetchRealtyApiSearchPage(apiKey, qs, tuning.requestTimeoutMs);
      pagesFetched += 1;
      if (error) {
        errors.push(`${location} p${page}: ${error}`);
        break;
      }
      const rows = extractListingRows(payload);
      rawCount += rows.length;
      for (const row of rows) {
        const normalized = normalizeRealtyApiListing(row, location);
        if (!normalized) continue;
        const reject = shouldRejectRealtyApiListing(normalized);
        if (reject) continue;
        if (!passesRealtyApiBedroomFilter(normalized, options.minBedrooms, options.maxBedrooms)) continue;
        if (!passesCommunityAnchor(normalized, {
          allowedStreetRoots: options.allowedStreetRoots,
          strictCommunityAnchor,
          ruleStreetRoot,
          communityKeywords,
        })) continue;
        const urlKey = normalized.listingUrl.toLowerCase().split("?")[0];
        if (seenUrls.has(urlKey)) continue;
        seenUrls.add(urlKey);
        candidates.push(normalized);
      }
      nextPage = extractNextPage(payload);
      page += 1;
      if (nextPage && tuning.pageDelayMs > 0) await sleep(tuning.pageDelayMs);
    }
    if (tuning.pageDelayMs > 0) await sleep(tuning.pageDelayMs);
  }

  console.log(
    `[realtyapi-discovery] community="${options.communityName}" locations=${locations.length} ` +
    `pages=${pagesFetched} raw=${rawCount} kept=${candidates.length} errors=${errors.length}`,
  );

  return {
    candidates,
    rawCount,
    filteredCount: candidates.length,
    pagesFetched,
    locationsTried: locations,
    errors,
  };
}

export type RealtyApiPhotoLegCounts = {
  raw: number;
  kept: number;
  added: number;
  pages: number;
  locations: number;
};

/** Merge RealtyAPI Realtor URLs into an existing photo-discovery candidate pool. */
export async function runRealtyApiPhotoDiscoveryLeg(opts: {
  communityName: string;
  streetAddress?: string | null;
  city?: string | null;
  state?: string | null;
  profile: RealtyApiDiscoveryProfile;
  minBedrooms?: number | null;
  maxBedrooms?: number | null;
  allowedStreetRoots?: Set<string>;
  strictCommunityAnchor?: boolean;
  addRealtorUrl: (url: string, title?: string) => boolean;
}): Promise<RealtyApiPhotoLegCounts> {
  if (!isRealtyApiDiscoveryEnabled() || !String(opts.state ?? "").trim()) {
    return { raw: 0, kept: 0, added: 0, pages: 0, locations: 0 };
  }
  const harvest = await harvestRealtyApiCommunityListings({
    communityName: opts.communityName,
    streetAddress: opts.streetAddress,
    city: opts.city,
    state: opts.state,
    zipCode: zipFromAddressHint(opts.streetAddress),
    minBedrooms: opts.minBedrooms,
    maxBedrooms: opts.maxBedrooms,
    profile: opts.profile,
    allowedStreetRoots: opts.allowedStreetRoots,
    strictCommunityAnchor: opts.strictCommunityAnchor,
  });
  let added = 0;
  for (const candidate of harvest.candidates) {
    const didAdd = opts.addRealtorUrl(candidate.listingUrl, candidate.formattedAddress);
    if (didAdd) added += 1;
  }
  return {
    raw: harvest.rawCount,
    kept: harvest.filteredCount,
    added,
    pages: harvest.pagesFetched,
    locations: harvest.locationsTried.length,
  };
}
