// Same-unit cross-portal photo hunt — the preflight "Find new photos" engine.
//
// The operator clicks "Find new photos" when a unit's scraped gallery is poor
// quality or missing bedroom shots. The old behavior discovered a DIFFERENT
// listing at the community, which silently swapped in another unit's photos.
// This module instead hunts for the SAME physical unit's listing pages on the
// other real-estate portals (Zillow / Realtor / Redfin / Homes host different
// photo sets for one unit surprisingly often — different listing events,
// different photographers), and only accepts a candidate whose gallery is
// PROVEN different from the photos already on file (dHash novelty check).
//
// When no candidate with genuinely different photos exists, the caller reports
// `recommendReplaceUnit: true` and the UI surfaces "Find replacement unit"
// (the existing UnitReplacementFlow) instead of pretending a re-scrape helped.
//
// HONESTY RULE (load-bearing): `recommendReplaceUnit` may only be set when the
// hunt COMPLETED its search — SERP responded and every surfaced candidate was
// checked. Transient infra failures (SearchAPI quota blackout, zero SERP
// responses) must NOT push the operator toward a destructive unit replacement.
//
// Pure logic only — SERP calls, image fetches, and dHash computation live in
// server/same-unit-photo-hunt.ts.

import {
  parseListingAddressFromUrl,
  parseListingAddressFromText,
  streetRootFromListingAddress,
} from "./listing-url-address";
import {
  buildEquivalentPortalQueries,
  canonicalListingUrlKey,
  detectRealEstateListingPortal,
  extractListingUnitIdentity,
} from "./real-estate-listing-discovery";
import { normalizeUnitClaim } from "./folder-unit-map";
import { NEAR_DUPLICATE_DISTANCE } from "./photo-dedupe-logic";
import { hammingDistance } from "./photo-hash-distance";

/** How many same-unit candidate listings get their gallery scraped per hunt. */
export const SAME_UNIT_HUNT_MAX_CANDIDATES_DEFAULT = 4;
/**
 * How many genuinely-new photos (dHash distance > NEAR_DUPLICATE_DISTANCE from
 * EVERY photo already on file) a candidate gallery must contain before it may
 * replace the current gallery. Below this the candidate is the same photo set
 * (recompressed / resized mirrors) and replacing would be a pointless churn.
 */
export const SAME_UNIT_HUNT_MIN_NEW_PHOTOS_DEFAULT = 3;

export interface SameUnitIdentity {
  /** Full numbered street address (with unit token when present). */
  address: string | null;
  /** Canonical street root ("2827 poipu rd") — house number included. */
  streetRoot: string | null;
  /** Normalized unit claim ("APT 2 301" → "2 301") or null for a unique-address home. */
  unitClaim: string | null;
  /** The current source listing's portal (so other portals can be preferred). */
  sourcePortal: string | null;
}

/**
 * Build the identity anchor for the hunt from the unit's saved source listing
 * URL. Returns null when there is nothing to anchor on — no parseable address
 * AND no unit claim — in which case a same-unit search cannot run at all.
 */
export function sameUnitHuntIdentity(input: {
  sourceUrl?: string | null;
  /** SERP/title context if the caller has any (rarely needed). */
  contextText?: string | null;
}): SameUnitIdentity | null {
  const sourceUrl = String(input.sourceUrl ?? "").trim();
  if (!sourceUrl) return null;
  const address = parseListingAddressFromUrl(sourceUrl)
    ?? (input.contextText ? parseListingAddressFromText(input.contextText) : null);
  const streetRoot = streetRootFromListingAddress(address);
  const unitClaim = extractListingUnitIdentity(address, decodeURIComponentSafe(sourceUrl), input.contextText ?? undefined);
  if (!streetRoot && !unitClaim) return null;
  return {
    address,
    streetRoot,
    unitClaim,
    sourcePortal: detectRealEstateListingPortal(sourceUrl),
  };
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Normalize a unit claim to a comparable key ("APT-2-301" ≡ "apt 2 0301"). */
export function normalizedUnitKey(claim: string | null | undefined): string {
  return normalizeUnitClaim(String(claim ?? ""))
    .replace(/[-#\s]+/g, " ")
    .split(" ")
    .map((part) => part.replace(/^0+(?=\d)/, ""))
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * SERP queries hunting the SAME unit on every real-estate portal: the full
 * slug address (which carries the unit token) on each portal, plus the
 * community street address + unit-claim variants. Reuses PR #1059's
 * buildEquivalentPortalQueries so the query surface never drifts from the
 * find-unit equivalent-source fallback.
 */
export function sameUnitHuntQueries(
  identity: SameUnitIdentity,
  communityStreetAddress?: string | null,
): string[] {
  return buildEquivalentPortalQueries({
    address: identity.address,
    communityAddress: communityStreetAddress ?? null,
    unit: identity.unitClaim,
  });
}

/**
 * Canonical exclusion keys for exact listing URLs that may never be re-picked
 * (the current source + sibling sources). Deliberately URL-level, NOT
 * identity-cluster-level: cross-portal mirrors of the CURRENT source are
 * exactly what this hunt exists to find.
 */
export function canonicalKeysForExclusion(urls: readonly (string | null | undefined)[]): Set<string> {
  const keys = new Set<string>();
  for (const url of urls) {
    const value = String(url ?? "").trim();
    if (!value) continue;
    const key = canonicalListingUrlKey(value);
    if (key) keys.add(key);
  }
  return keys;
}

export interface SameUnitSerpRow {
  link?: string | null;
  title?: string | null;
  snippet?: string | null;
}

export interface SameUnitCandidate {
  url: string;
  portal: string;
  title: string;
}

export interface SameUnitCandidateFilterResult {
  candidates: SameUnitCandidate[];
  rejectedNotPortal: number;
  rejectedExcluded: number;
  rejectedDifferentUnit: number;
}

/**
 * Keep only SERP rows that are (a) real-estate portal listing pages, (b) not
 * the current source / an excluded URL, and (c) provably the SAME unit:
 * matching unit claim when the anchor has one (a different unit on the same
 * street must NEVER pass — that is exactly the old behavior this replaces),
 * else a matching full street root (house number included) for unique-address
 * homes. Candidates from portals OTHER than the current source's portal sort
 * first — a different portal is far more likely to host a different photo set.
 */
export function filterSameUnitSerpRows(
  rows: readonly SameUnitSerpRow[],
  identity: SameUnitIdentity,
  excludeUrlKeys: ReadonlySet<string>,
): SameUnitCandidateFilterResult {
  const wantedUnit = normalizedUnitKey(identity.unitClaim);
  const wantedRoot = String(identity.streetRoot ?? "").trim().toLowerCase();
  const seen = new Set<string>();
  const candidates: Array<SameUnitCandidate & { crossPortal: number; order: number }> = [];
  let rejectedNotPortal = 0;
  let rejectedExcluded = 0;
  let rejectedDifferentUnit = 0;
  rows.forEach((row, order) => {
    const url = String(row?.link ?? "").trim();
    if (!url) return;
    const portal = detectRealEstateListingPortal(url);
    if (!portal) {
      rejectedNotPortal += 1;
      return;
    }
    const key = canonicalListingUrlKey(url);
    if (!key || seen.has(key)) return;
    if (excludeUrlKeys.has(key)) {
      seen.add(key);
      rejectedExcluded += 1;
      return;
    }
    const contextText = `${row?.title ?? ""} ${row?.snippet ?? ""}`;
    const candidateAddress = parseListingAddressFromUrl(url) ?? parseListingAddressFromText(contextText);
    const candidateRoot = String(streetRootFromListingAddress(candidateAddress) ?? "").trim().toLowerCase();
    const candidateUnit = normalizedUnitKey(
      extractListingUnitIdentity(candidateAddress, decodeURIComponentSafe(url), contextText),
    );
    if (wantedUnit) {
      // Unit-anchored: the candidate must claim the SAME unit. A candidate
      // with a DIFFERENT unit claim is a neighbor; a candidate with NO unit
      // claim is unprovable — both rejected (precision over recall: replacing
      // a real gallery with a neighbor's photos is the failure mode).
      if (candidateUnit !== wantedUnit) {
        seen.add(key);
        rejectedDifferentUnit += 1;
        return;
      }
      // When both street roots parse they must agree (same unit number in a
      // different building/resort is a different home).
      if (wantedRoot && candidateRoot && candidateRoot !== wantedRoot) {
        seen.add(key);
        rejectedDifferentUnit += 1;
        return;
      }
    } else {
      // Unique-address home: full street-root equality (house number included)
      // is the identity. Missing candidate root = unprovable = rejected.
      if (!wantedRoot || candidateRoot !== wantedRoot) {
        seen.add(key);
        rejectedDifferentUnit += 1;
        return;
      }
      // A candidate that names a unit token when our anchor has none is a
      // different (sub)unit at the same address — reject.
      if (candidateUnit) {
        seen.add(key);
        rejectedDifferentUnit += 1;
        return;
      }
    }
    seen.add(key);
    candidates.push({
      url,
      portal,
      title: String(row?.title ?? "").trim(),
      crossPortal: identity.sourcePortal && portal !== identity.sourcePortal ? 0 : 1,
      order,
    });
  });
  candidates.sort((a, b) => a.crossPortal - b.crossPortal || a.order - b.order);
  return {
    candidates: candidates.map(({ url, portal, title }) => ({ url, portal, title })),
    rejectedNotPortal,
    rejectedExcluded,
    rejectedDifferentUnit,
  };
}

export interface GalleryNovelty {
  total: number;
  hashed: number;
  unverified: number;
  newCount: number;
  dupCount: number;
}

/**
 * How many of a candidate gallery's photos are genuinely NEW vs the photos
 * already on file. A photo counts as new only when its dHash distance to
 * EVERY existing hash exceeds the near-duplicate threshold — recompressed /
 * resized / lightly-cropped copies of a photo we already have never count.
 * Photos whose hash could not be computed are `unverified` and count as
 * NEITHER new nor duplicate (a missing hash must stay inconclusive — never
 * borrow the theft-scanner's fail-toward-match posture here).
 */
export function evaluateGalleryNovelty(
  existingHashes: readonly string[],
  candidateHashes: readonly (string | null)[],
  threshold: number = NEAR_DUPLICATE_DISTANCE,
): GalleryNovelty {
  let hashed = 0;
  let newCount = 0;
  let dupCount = 0;
  for (const hash of candidateHashes) {
    if (!hash) continue;
    hashed += 1;
    const isDup = existingHashes.some((existing) => hammingDistance(existing, hash) <= threshold);
    if (isDup) dupCount += 1;
    else newCount += 1;
  }
  return {
    total: candidateHashes.length,
    hashed,
    unverified: candidateHashes.length - hashed,
    newCount,
    dupCount,
  };
}

export type SameUnitCandidateVerdict = "accept" | "duplicate-set" | "too-thin" | "unverifiable";

export function sameUnitCandidateVerdict(
  novelty: GalleryNovelty,
  opts: { minPhotos: number; minNewPhotos: number },
): SameUnitCandidateVerdict {
  if (novelty.total < opts.minPhotos) return "too-thin";
  // Enough photos exist but too few could be hashed to PROVE the gallery
  // differs — never replace a real gallery on unproven novelty.
  if (novelty.hashed < opts.minPhotos) return "unverifiable";
  if (novelty.newCount >= opts.minNewPhotos) return "accept";
  return "duplicate-set";
}

export interface SameUnitCheckedCandidate {
  url: string;
  portal: string;
  verdict: SameUnitCandidateVerdict | "no-photos" | "scrape-failed";
  newCount?: number;
  totalCount?: number;
}

export type SameUnitHuntOutcome =
  | "accepted"
  | "no-anchor"
  | "no-candidates"
  | "exhausted"
  | "search-unavailable";

/**
 * Operator-facing summary for a hunt that did NOT accept a candidate.
 * Wording matters: "no different photos exist" is the signal that flips the
 * UI to "Find replacement unit".
 */
export function summarizeSameUnitHuntFailure(input: {
  outcome: Exclude<SameUnitHuntOutcome, "accepted">;
  bedrooms: number;
  communityName: string;
  checked: readonly SameUnitCheckedCandidate[];
  minNewPhotos: number;
}): string {
  const { outcome, checked } = input;
  if (outcome === "no-anchor") {
    return "This unit has no saved source listing to anchor a same-unit photo search, so there's no way to hunt its photos on other portals. Use Find replacement unit to swap in a different unit, or Replace with URL if you have this unit's listing link.";
  }
  if (outcome === "search-unavailable") {
    return "The photo search couldn't run — every listing search query failed or was rate-limited. This is temporary; try again in a few minutes. The existing gallery was kept.";
  }
  if (outcome === "no-candidates") {
    return "Searched Zillow, Realtor, Redfin, and Homes.com for this exact unit's listing on other portals and found none beyond the source already on file. No different photos of this unit exist online — use Find replacement unit to swap in a different unit with better photos.";
  }
  const dupSets = checked.filter((c) => c.verdict === "duplicate-set").length;
  const thin = checked.filter((c) => c.verdict === "too-thin" || c.verdict === "no-photos").length;
  const unverifiable = checked.filter((c) => c.verdict === "unverifiable" || c.verdict === "scrape-failed").length;
  const parts: string[] = [];
  if (dupSets > 0) parts.push(`${dupSets} carried the same photos already on file`);
  if (thin > 0) parts.push(`${thin} had too few photos`);
  if (unverifiable > 0) parts.push(`${unverifiable} couldn't be verified`);
  const bestNew = Math.max(0, ...checked.map((c) => c.newCount ?? 0));
  const bestNote = dupSets > 0 && bestNew > 0
    ? ` The best option had only ${bestNew} new photo${bestNew === 1 ? "" : "s"} (${input.minNewPhotos} needed).`
    : "";
  return `Checked ${checked.length} listing${checked.length === 1 ? "" : "s"} of this exact unit on other portals${parts.length ? ` — ${parts.join(", ")}` : ""}.${bestNote} No genuinely different photo set exists for this unit — use Find replacement unit to swap in a different unit with better photos. The existing gallery was kept.`;
}
