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

export function canonicalListingUrlKey(rawUrl: string): string {
  const value = String(rawUrl ?? "").trim();
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, "").toLowerCase();
    return `${host}${path}`;
  } catch {
    return value.toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

export function detectRealEstateListingPortal(url: string): RealEstateListingPortal | null {
  if (/zillow\.com\/homedetails\//i.test(url)) return "zillow";
  if (/realtor\.com\/realestateandhomes-detail\//i.test(url)) return "realtor";
  if (/redfin\.com\/.+\/home\/\d+/i.test(url)) return "redfin";
  if (/homes\.com\/property\//i.test(url)) return "homes";
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

  const condoOrVillaClaims = texts.flatMap((text) => {
    const match = text.match(
      /\b(?:condo|villa)\s*#?\s*([a-z]?\d+[a-z]?(?:\s+[a-z]?\d+[a-z]?)?)\b/i,
    );
    return match?.[1] ? [match[1]] : [];
  });
  const condoOrVilla = mostSpecific(condoOrVillaClaims);
  if (condoOrVilla) return condoOrVilla;

  const trailingStreetClaims = texts.flatMap((text) => {
    const match = text.match(
      /\b(?:Blvd|Boulevard|Rd|Road|St|Street|Ave|Avenue|Dr|Drive|Ln|Lane|Way|Cir|Circle|Ct|Court|Pkwy|Parkway|Pl|Place|Ter|Terrace|Trail)\s+([A-Za-z]?\d{1,5}[A-Za-z]?(?:\s+[A-Za-z]?\d{1,5}[A-Za-z]?)?)\b/i,
    );
    return match?.[1] ? [match[1]] : [];
  });
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
