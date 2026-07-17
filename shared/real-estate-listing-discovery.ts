import { extractMarkedUnitClaims, normalizeUnitClaim } from "./folder-unit-map";

export type RealEstateListingPortal = "zillow" | "realtor" | "redfin" | "homes";

export interface ListingIdentityEvidence {
  url: string;
  streetRoot?: string | null;
  unitClaim?: string | null;
  allowRootOnly?: boolean;
}

export interface EquivalentPortalQueryInput {
  address?: string | null;
  communityAddress?: string | null;
  unit?: string | null;
}

export interface PhotoGalleryOption {
  exactStreetMatch: boolean;
  bedroomEvidence: number;
  photoCount: number;
  discoveryScore: number;
  discoveryIndex: number;
}

export const MAX_FULL_GALLERY_OPTIONS = 3;
export const MAX_EQUIVALENT_PORTAL_QUERIES = 9;
const MAX_IDENTITY_TEXT_LENGTH = 2_048;

function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function listingUrlParts(rawUrl: string): { host: string; path: string } | null {
  const value = String(rawUrl ?? "").trim();
  if (!value) return null;
  try {
    const parsed = new URL(value.includes("://") ? value : `https://${value}`);
    const lowerHost = parsed.hostname.toLowerCase();
    return {
      host: lowerHost.startsWith("www.") ? lowerHost.slice(4) : lowerHost,
      path: parsed.pathname.toLowerCase(),
    };
  } catch {
    return null;
  }
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function isAsciiLetter(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigits(value: string, maxDigits: number): boolean {
  if (value.length < 1 || value.length > maxDigits) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function unitSegment(raw: string | undefined, maxDigits = 4): string | null {
  if (!raw) return null;
  let token = raw.toUpperCase();
  while (token.startsWith("#")) token = token.slice(1);
  while (token.endsWith(".") || token.endsWith(",") || token.endsWith(":") || token.endsWith(";")) {
    token = token.slice(0, -1);
  }
  if (!token) return null;
  let digitStart = 0;
  let digitEnd = token.length;
  if (isAsciiLetter(token[0])) digitStart += 1;
  if (digitEnd > digitStart && isAsciiLetter(token[digitEnd - 1])) digitEnd -= 1;
  const digitCount = digitEnd - digitStart;
  if (digitCount < 1 || digitCount > maxDigits) return null;
  for (let i = digitStart; i < digitEnd; i += 1) {
    const code = token.charCodeAt(i);
    if (code < 48 || code > 57) return null;
  }
  return token;
}

function claimsAfterMarkers(text: string, markers: ReadonlySet<string>): string[] {
  const tokens = text.split(" ");
  const claims: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    let marker = tokens[i].toLowerCase();
    while (marker.endsWith(".")) marker = marker.slice(0, -1);
    if (!markers.has(marker)) continue;
    let nextIndex = i + 1;
    if (tokens[nextIndex] === "#") nextIndex += 1;
    const first = unitSegment(tokens[nextIndex]);
    if (!first) continue;
    const second = unitSegment(tokens[nextIndex + 1]);
    claims.push(second ? `${first} ${second}` : first);
  }
  return claims;
}

export function canonicalListingUrlKey(rawUrl: string): string {
  const value = String(rawUrl ?? "").trim();
  try {
    const parsed = new URL(value);
    const lowerHost = parsed.hostname.toLowerCase();
    const host = lowerHost.startsWith("www.") ? lowerHost.slice(4) : lowerHost;
    const path = withoutTrailingSlashes(parsed.pathname.toLowerCase());
    return `${host}${path}`;
  } catch {
    let normalized = value.toLowerCase();
    const queryIndex = normalized.indexOf("?");
    const hashIndex = normalized.indexOf("#");
    const cutAt = queryIndex < 0
      ? hashIndex
      : hashIndex < 0
        ? queryIndex
        : Math.min(queryIndex, hashIndex);
    if (cutAt >= 0) normalized = normalized.slice(0, cutAt);
    return withoutTrailingSlashes(normalized);
  }
}

export function detectRealEstateListingPortal(url: string): RealEstateListingPortal | null {
  const parts = listingUrlParts(url);
  if (!parts) return null;
  if (hostMatches(parts.host, "zillow.com") && parts.path.includes("/homedetails/")) return "zillow";
  if (hostMatches(parts.host, "realtor.com") && parts.path.includes("/realestateandhomes-detail/")) return "realtor";
  if (hostMatches(parts.host, "homes.com") && parts.path.includes("/property/")) return "homes";
  if (hostMatches(parts.host, "redfin.com")) {
    const marker = "/home/";
    const markerIndex = parts.path.lastIndexOf(marker);
    if (markerIndex >= 0) {
      const homeId = parts.path.slice(markerIndex + marker.length).split("/")[0];
      if (isAsciiDigits(homeId, 20)) return "redfin";
    }
  }
  return null;
}

/**
 * Extract only unit-grade identity evidence. Building numbers are deliberately
 * ignored: "Building 2 Unit 306" identifies unit 306, not every condo in
 * building 2. Separator normalization keeps compound claims equivalent across
 * portal slugs (`APT-2-301`) and display text (`APT 2 301`).
 */
export function extractListingUnitIdentity(...values: Array<string | null | undefined>): string | null {
  const texts = values
    .map((value) => String(value ?? "")
      .slice(0, MAX_IDENTITY_TEXT_LENGTH)
      .replace(/[_/-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim())
    .filter(Boolean);
  const mostSpecific = (claims: string[]): string | null => {
    let best: string | null = null;
    let bestSegments = 0;
    for (const raw of claims) {
      const claim = normalizeUnitClaim(raw);
      const segments = claim.split(/[-#\s]+/).filter(Boolean).length;
      if (!claim || segments <= bestSegments) continue;
      best = claim;
      bestSegments = segments;
    }
    return best;
  };

  // Address parsers intentionally stop after one optional unit token, so a
  // parsed address may say `APT 2` while the portal slug still contains the
  // complete `APT-2-301`. Consider every evidence surface and prefer the most
  // specific explicit claim rather than whichever input happened to come first.
  const marked = mostSpecific(texts.flatMap(extractMarkedUnitClaims));
  if (marked) return marked;

  const condoOrVillaClaims = texts.flatMap((text) =>
    claimsAfterMarkers(text, new Set(["condo", "villa"])),
  );
  const condoOrVilla = mostSpecific(condoOrVillaClaims);
  if (condoOrVilla) return condoOrVilla;

  const streetSuffixes = new Set([
    "blvd", "boulevard", "rd", "road", "st", "street", "ave", "avenue",
    "dr", "drive", "ln", "lane", "way", "cir", "circle", "ct", "court",
    "pkwy", "parkway", "pl", "place", "ter", "terrace", "trail",
  ]);
  const trailingStreetClaims = texts.flatMap((text) => claimsAfterMarkers(text, streetSuffixes));
  return mostSpecific(trailingStreetClaims);
}

/**
 * A physical-unit key shared by every real-estate photo discovery path.
 *
 * The unit suffix is load-bearing for single-address condo towers: a bare
 * street root would combine neighboring units and let the richest neighbor's
 * photos and bedroom facts overwrite the candidate being evaluated. When a
 * portal does not expose a unit token, root-only behavior preserves the
 * established distinct-address-resort grouping only when a caller explicitly
 * opts into `allowRootOnly`. Ambiguous or missing identity evidence keeps the
 * candidate URL-isolated.
 */
export function listingIdentityClusterKey({
  url,
  streetRoot,
  unitClaim,
  allowRootOnly = false,
}: ListingIdentityEvidence): string {
  const root = String(streetRoot ?? "").trim().toLowerCase();
  if (!root) return `__url:${canonicalListingUrlKey(url)}`;
  const unit = normalizeUnitClaim(String(unitClaim ?? ""))
    .replace(/[-#\s]+/g, " ")
    .split(" ")
    .map((part) => part.replace(/^0+(?=\d)/, ""))
    .filter(Boolean)
    .join(" ");
  if (unit) return `${root}#${unit}`;
  return allowRootOnly ? root : `__url:${canonicalListingUrlKey(url)}`;
}

export function groupListingUrlsByIdentity<T>(
  rows: readonly T[],
  identityFor: (row: T) => ListingIdentityEvidence,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const keysByGroup = new Map<string, Set<string>>();
  for (const row of rows) {
    const identity = identityFor(row);
    const clusterKey = listingIdentityClusterKey(identity);
    const canonicalUrl = canonicalListingUrlKey(identity.url);
    const seen = keysByGroup.get(clusterKey) ?? new Set<string>();
    if (seen.has(canonicalUrl)) continue;
    seen.add(canonicalUrl);
    keysByGroup.set(clusterKey, seen);
    const urls = groups.get(clusterKey) ?? [];
    urls.push(identity.url);
    groups.set(clusterKey, urls);
  }
  return groups;
}

export function buildEquivalentPortalQueries(
  input: EquivalentPortalQueryInput,
  maxQueries = MAX_EQUIVALENT_PORTAL_QUERIES,
): string[] {
  const address = String(input.address ?? "").trim();
  const communityAddress = String(input.communityAddress ?? "").trim();
  const unit = normalizeUnitClaim(String(input.unit ?? ""));
  const queries: string[] = [];
  if (address) {
    queries.push(`"${address}" Zillow`);
    queries.push(`site:zillow.com "${address}"`);
    queries.push(`site:realtor.com/realestateandhomes-detail "${address}"`);
    queries.push(`site:redfin.com "${address}"`);
    queries.push(`site:homes.com "${address}"`);
  }
  if (communityAddress && unit) {
    queries.push(`site:zillow.com "${communityAddress}" "${unit}"`);
    queries.push(`site:realtor.com/realestateandhomes-detail "${communityAddress}" "${unit}"`);
    queries.push(`site:redfin.com "${communityAddress}" "${unit}"`);
    queries.push(`site:homes.com "${communityAddress}" "${unit}"`);
  }
  const bounded = Number.isFinite(maxQueries) ? Math.max(0, Math.floor(maxQueries)) : MAX_EQUIVALENT_PORTAL_QUERIES;
  return Array.from(new Set(queries)).slice(0, bounded);
}

export function selectBestPhotoGalleryOption<T extends PhotoGalleryOption>(options: readonly T[]): T | null {
  if (options.length === 0) return null;
  return [...options].sort((a, b) =>
    Number(b.exactStreetMatch) - Number(a.exactStreetMatch)
    || b.bedroomEvidence - a.bedroomEvidence
    || b.photoCount - a.photoCount
    || b.discoveryScore - a.discoveryScore
    || a.discoveryIndex - b.discoveryIndex,
  )[0];
}
