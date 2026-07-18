// Name-anchored sibling street-root RESCUE for the find-unit replacement
// discovery gate (server/routes.ts /api/replacement/find-unit).
//
// The resort-street gate compares every discovered listing URL's street root
// against the community's configured/curated root(s). When the CONFIGURED
// street NUMBER is wrong — a maps/directory address no listing portal uses —
// the gate rejects EVERY real candidate and the search dies with
// "all N were filtered out because they did not match the resort street".
// Live case (2026-07-18): Wavecrest Resort's draft carried the directory
// address "8001 Kamehameha V Hwy" while every Zillow/Redfin/Realtor unit is
// indexed under the BUILDING addresses 7142/7144/7146/7148 Kamehameha V Hwy —
// Google returned 213 hits and all 182 listing links were rejected.
//
// This module learns the resort's REAL building street roots from the rejected
// SERP results themselves, behind four precision rails (each is LOAD-BEARING —
// see tests/discovery-root-rescue.test.ts):
//   1. STRIKEOUT-ONLY: the caller fires it only when the gate admitted ZERO
//      candidates — the signature of a wrong configured number, never of a
//      merely-noisy result set.
//   2. SAME STREET NAME+TYPE: a learned root must match a configured root's
//      street name + type exactly; only the leading street number(s) may
//      differ. The rescue can never jump to a different street.
//   3. COMMUNITY NAME ANCHOR: the rejected result's title/snippet must contain
//      the community name (or a curated alias) as a CONTIGUOUS phrase after
//      generic-token folding. Token-set matching is NOT enough: a "Waikoloa
//      Colony Villas … Waikoloa Beach Dr" snippet contains every token of
//      "Waikoloa Beach Villas" without being that resort — the contiguous
//      phrase check blocks it.
//   4. RECURRENCE: a root must recur across >=2 DISTINCT listing URLs, so one
//      stray mis-titled listing cannot widen the gate.
// Additionally, streets in HAWAII_STREETS_WITH_DISTINCT_RESORTS_BY_LOT are
// excluded wholesale — there the street number IS the resort identity, so a
// number-differs sibling must never be auto-learned.
//
// Candidates admitted via a learned root still flow through every downstream
// gate (bedroom count, OTA-clean checks, Claude-vision community check, photo
// floor), so a wrong-resort unit that somehow slips the SERP anchor is still
// caught before photos are committed.

import { parseListingAddressFromUrl, streetRootFromListingAddress } from "./listing-url-address";
import { foldHawaiianDiacritics } from "./community-addresses";
import { HAWAII_STREETS_WITH_DISTINCT_RESORTS_BY_LOT } from "./hawaii-street-family";

export type RejectedDiscoveryResult = {
  link: string;
  source: string;
  contextText: string;
  thumbnail?: string;
};

export type SiblingRootRescueResult = {
  /** Learned sibling street roots, most-recurring first. Empty = no rescue. */
  roots: string[];
  /** How many rejected results carried a valid community-name anchor. */
  anchoredRejects: number;
};

/**
 * Street NAME + TYPE portion of a canonical street root:
 * "8001 kamehameha v hwy" -> "kamehameha v hwy";
 * "57 101 kuilima dr" (Hawaii district-lot pair) -> "kuilima dr".
 */
export function streetNameKeyFromRoot(root: string | null | undefined): string | null {
  const tokens = String(root ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  while (tokens.length > 0 && /^\d+$/.test(tokens[0])) tokens.shift();
  const key = tokens.join(" ");
  return key || null;
}

// Tokens that carry no resort identity. Deliberately narrow: "villas"/"beach"/
// "estates" ARE identity ("Waikoloa Beach Villas" vs "Kuilima Estates") and must
// never be dropped.
const GENERIC_COMMUNITY_TOKENS = new Set([
  "the", "a", "an", "at", "of", "in", "by", "for", "and",
  "resort", "resorts", "condo", "condos", "condominium", "condominiums",
  "community", "aoao", "inc",
]);

const normalizeAnchorText = (value: string): string =>
  foldHawaiianDiacritics(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t && !GENERIC_COMMUNITY_TOKENS.has(t))
    .join(" ");

/**
 * Core anchor phrases for a community: each provided name/alias normalized with
 * generic tokens folded out. A phrase is dropped when it collapses to nothing OR
 * when it is contained in one of the resort's own street-name keys ("Kamehameha"
 * as a community name would anchor on every Kamehameha-Hwy address — useless, so
 * the rescue must stay silent rather than anchor on street text).
 */
export function communityAnchorPhrases(
  communityNames: Array<string | null | undefined>,
  allowedStreetNameKeys: Iterable<string>,
): string[] {
  const streetKeys = Array.from(allowedStreetNameKeys).map((k) => ` ${normalizeAnchorText(k)} `);
  const phrases = new Set<string>();
  for (const name of communityNames) {
    const phrase = normalizeAnchorText(String(name ?? ""));
    if (!phrase) continue;
    if (streetKeys.some((sk) => sk.includes(` ${phrase} `))) continue;
    phrases.add(phrase);
  }
  return Array.from(phrases);
}

/** True when the text names the community: any anchor phrase appears contiguously. */
export function textNamesCommunity(text: string, anchorPhrases: string[]): boolean {
  if (anchorPhrases.length === 0) return false;
  const hay = ` ${normalizeAnchorText(text)} `;
  return anchorPhrases.some((phrase) => hay.includes(` ${phrase} `));
}

const distinctListingKey = (link: string): string =>
  link
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[?#]/)[0]
    .replace(/\/+$/, "");

/**
 * Learn sibling building street roots from root-gate-rejected discovery results.
 * See the module header for the precision rails. Returns roots ordered by
 * recurrence (desc) then lexicographically, capped at `maxRoots`.
 */
export function learnSiblingStreetRootsFromRejects(input: {
  /** Community name + curated aliases (discoveryCommunityNameAliases output). */
  communityNames: Array<string | null | undefined>;
  /** The gate's current allowed roots (configured + curated). */
  allowedRoots: ReadonlySet<string>;
  /** Results the root gate rejected (link + title/snippet context). */
  rejects: ReadonlyArray<RejectedDiscoveryResult>;
  /** Distinct-listing recurrence floor per learned root (default 2). */
  minRecurrence?: number;
  /** Cap on learned roots (default 4). */
  maxRoots?: number;
}): SiblingRootRescueResult {
  const minRecurrence = Math.max(1, input.minRecurrence ?? 2);
  const maxRoots = Math.max(1, input.maxRoots ?? 4);

  // Rail 2 prep: the street name keys the configured roots live on. Streets where
  // the lot number distinguishes SEPARATE resorts are excluded wholesale.
  const allowedNameKeys = new Set<string>();
  for (const root of Array.from(input.allowedRoots)) {
    const key = streetNameKeyFromRoot(root);
    if (!key) continue;
    if (HAWAII_STREETS_WITH_DISTINCT_RESORTS_BY_LOT.has(key)) continue;
    allowedNameKeys.add(key);
  }
  if (allowedNameKeys.size === 0) return { roots: [], anchoredRejects: 0 };

  // Rail 3 prep: community anchor phrases (street-text phrases already dropped).
  const anchorPhrases = communityAnchorPhrases(input.communityNames, allowedNameKeys);
  if (anchorPhrases.length === 0) return { roots: [], anchoredRejects: 0 };

  let anchoredRejects = 0;
  const rootListings = new Map<string, Set<string>>();
  for (const reject of input.rejects) {
    const link = String(reject?.link ?? "").trim();
    if (!link) continue;
    // The root comes from the listing URL ONLY (mirrors candidateRootMatches):
    // snippets routinely mention the resort street for unrelated nearby inventory.
    const root = streetRootFromListingAddress(parseListingAddressFromUrl(link));
    if (!root || input.allowedRoots.has(root)) continue;
    const nameKey = streetNameKeyFromRoot(root);
    if (!nameKey || !allowedNameKeys.has(nameKey)) continue;
    if (!textNamesCommunity(String(reject?.contextText ?? ""), anchorPhrases)) continue;
    anchoredRejects += 1;
    const listings = rootListings.get(root) ?? new Set<string>();
    listings.add(distinctListingKey(link));
    rootListings.set(root, listings);
  }

  const roots = Array.from(rootListings.entries())
    .filter(([, listings]) => listings.size >= minRecurrence)
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
    .slice(0, maxRoots)
    .map(([root]) => root);

  return { roots, anchoredRejects };
}
