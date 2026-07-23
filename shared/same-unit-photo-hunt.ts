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
 * A Hawaii inline unit token: "92-1070-1-Olani-St" carries unit "1" BETWEEN
 * the district-lot street number and the street name, with no Apt/Unit marker
 * for extractListingUnitIdentity to find. Without this, two neighboring units
 * in that slug family parse to identical unit-less identities and a neighbor's
 * gallery could pass as "the same home". Only fires on the exact
 * district(1-2) lot(3-5) unit(1-4) digit shape before a letter — a plain
 * "2827 Poipu Rd" or district-only "57-091 Kamehameha Hwy" never matches.
 */
export function hawaiiInlineUnitClaim(address: string | null | undefined): string | null {
  const raw = String(address ?? "").replace(/-+/g, " ").replace(/\s+/g, " ").trim();
  const m = raw.match(/\b\d{1,2}\s+\d{3,5}\s+(\d{1,4})\s+(?=[A-Za-z])/);
  return m ? m[1] : null;
}

/**
 * Build the identity anchor for the hunt from the unit's saved source listing
 * URL. A parseable STREET ROOT is required: unit-claim-only anchors are
 * rejected (return null) because a bare unit number with no provable street is
 * exactly how a different building's same-numbered unit would slip through the
 * candidate filter. Returns null when the URL carries no parseable address.
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
  if (!streetRoot) return null;
  const unitClaim = extractListingUnitIdentity(address, decodeURIComponentSafe(sourceUrl), input.contextText ?? undefined)
    ?? hawaiiInlineUnitClaim(address);
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
 * Prove that two listing URLs identify the same physical unit.
 *
 * Exact canonical URLs are safe even when a portal uses an opaque path.
 * Cross-portal matches fail closed unless both URLs carry the same numbered
 * street root and the same normalized unit claim. A unit-bearing listing can
 * never match a unit-less page in the same building.
 */
export function sameUnitSourceUrlsMatch(
  authoritativeUrl: string | null | undefined,
  candidateUrl: string | null | undefined,
  options: {
    /** Stronger unit evidence supplied by the committed swap or operator record. */
    expectedUnitClaim?: string | null;
    /** Only set after positively establishing that this is a unique-address home. */
    allowUnitlessStreetMatch?: boolean;
  } = {},
): boolean {
  const authoritative = String(authoritativeUrl ?? "").trim();
  const candidate = String(candidateUrl ?? "").trim();
  if (!authoritative || !candidate) return false;
  const authoritativeKey = canonicalListingUrlKey(authoritative);
  const candidateKey = canonicalListingUrlKey(candidate);
  if (authoritativeKey && authoritativeKey === candidateKey) return true;

  const expected = sameUnitHuntIdentity({ sourceUrl: authoritative });
  const actual = sameUnitHuntIdentity({ sourceUrl: candidate });
  if (!expected?.streetRoot || !actual?.streetRoot) return false;
  if (expected.streetRoot.toLowerCase() !== actual.streetRoot.toLowerCase()) return false;

  const expectedUnit = normalizedUnitKey(options.expectedUnitClaim)
    || normalizedUnitKey(expected.unitClaim);
  const actualUnit = normalizedUnitKey(actual.unitClaim);
  if (expectedUnit || actualUnit) {
    return !!expectedUnit && expectedUnit === actualUnit;
  }
  return options.allowUnitlessStreetMatch === true;
}

/**
 * Choose the hunt anchor without letting a stale browser value outrank server
 * identity. Replacement folders require both a readable committed authority
 * and the server-reconciled folder URL; ordinary folders may fall back to the
 * client value when their source document is missing.
 */
export function chooseSameUnitHuntAnchor(input: {
  replacementFolder: boolean;
  authorityAvailable: boolean;
  folderUrl?: string | null;
  clientUrl?: string | null;
}): string | null {
  const folderUrl = String(input.folderUrl ?? "").trim();
  if (input.replacementFolder) {
    if (!input.authorityAvailable || !folderUrl) return null;
    return folderUrl;
  }
  return folderUrl || String(input.clientUrl ?? "").trim() || null;
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
    // The candidate's unit claim comes from the URL slug + the parsed address
    // ONLY — never from raw title/snippet text, where "Similar homes: Apt 5…"
    // junk would inject a unit claim onto a page that has none (falsely
    // rejecting a unique-address mirror) or onto the wrong listing.
    const candidateUnit = normalizedUnitKey(
      extractListingUnitIdentity(candidateAddress, decodeURIComponentSafe(url))
        ?? hawaiiInlineUnitClaim(candidateAddress),
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
      // The candidate must also prove the SAME street root (from its URL slug
      // or SERP title/snippet) — unit "201" in a different (or unprovable)
      // building is a different home. sameUnitHuntIdentity guarantees the
      // anchor's root is non-empty, so this check always applies.
      if (wantedRoot && candidateRoot !== wantedRoot) {
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
 * Did the SERP sweep actually COMPLETE? A partial outage (some queries 429'd
 * or timed out) means candidates could have been missed — "no different photos
 * exist" may then only be asserted for what WAS searched, never as a verdict.
 */
export function sameUnitHuntSearchComplete(serp: { attempted: number; responded: number }): boolean {
  return serp.attempted > 0 && serp.responded === serp.attempted;
}

/**
 * Was exhaustion PROVEN? Only candidates whose gallery was actually scraped
 * and judged (duplicate-set / too-thin) count as checked. A candidate that
 * failed on scrape infra (scrape-failed / no-photos — often a bot wall) or
 * whose photos couldn't be hashed (unverifiable) proves nothing; if ANY
 * candidate ended that way, "no different photos exist" is not established
 * and recommendReplaceUnit must stay false (transient infra must never push
 * the operator toward a destructive unit swap).
 */
export function sameUnitHuntExhaustionProven(checked: readonly SameUnitCheckedCandidate[]): boolean {
  return checked.length > 0
    && checked.every((c) => c.verdict === "duplicate-set" || c.verdict === "too-thin");
}

/**
 * Operator-facing summary for a hunt that did NOT accept a candidate.
 * Wording matters: "no different photos exist" + the Find-replacement-unit
 * pointer only render when the verdict is PROVEN (complete search, every
 * candidate substantively judged) — unproven outcomes read as transient.
 */
export function summarizeSameUnitHuntFailure(input: {
  outcome: Exclude<SameUnitHuntOutcome, "accepted">;
  bedrooms: number;
  communityName: string;
  checked: readonly SameUnitCheckedCandidate[];
  minNewPhotos: number;
  /** Whether a saved source URL existed at all vs existed-but-unparseable. */
  anchor?: "missing" | "unparseable";
  /** True when some SERP queries failed — the search did not complete. */
  searchIncomplete?: boolean;
}): string {
  const { outcome, checked } = input;
  if (outcome === "no-anchor") {
    return input.anchor === "unparseable"
      ? "This unit's saved source listing URL doesn't carry a parseable street address, so a same-unit photo search can't prove another listing is the same unit. Use Find replacement unit to swap in a different unit, or Replace with URL if you have a better listing link for this exact unit."
      : "This unit has no saved source listing to anchor a same-unit photo search, so there's no way to hunt its photos on other portals. Use Find replacement unit to swap in a different unit, or Replace with URL if you have this unit's listing link.";
  }
  if (outcome === "search-unavailable") {
    return "The photo search couldn't run — every listing search query failed or was rate-limited. This is temporary; try again in a few minutes. The existing gallery was kept.";
  }
  if (outcome === "no-candidates") {
    if (input.searchIncomplete) {
      return "No other listing of this exact unit surfaced, but some search queries failed or were rate-limited, so the sweep was incomplete. This may be temporary — try again in a few minutes. The existing gallery was kept.";
    }
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
  const lead = `Checked ${checked.length} listing${checked.length === 1 ? "" : "s"} of this exact unit on other portals${parts.length ? ` — ${parts.join(", ")}` : ""}.${bestNote}`;
  if (!sameUnitHuntExhaustionProven(checked) || input.searchIncomplete) {
    // Some legs failed on infra — the verdict is NOT proven, so no
    // replacement push. Transient copy instead.
    return `${lead} Some checks didn't complete (search or scrape outage), so it's not yet proven that no different photos exist — try again in a few minutes before considering a unit replacement. The existing gallery was kept.`;
  }
  return `${lead} No genuinely different photo set exists for this unit — use Find replacement unit to swap in a different unit with better photos. The existing gallery was kept.`;
}
