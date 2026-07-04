// Same-community SIBLING-UNIT look-alike detection for the photo scanner.
//
// Live incident (2026-07-04, property 32 / Pili Mai): a freshly committed
// replacement unit (#8J, photos straight off Redfin) was immediately
// re-flagged "found on VRBO" — but every match was ANOTHER Pili Mai unit's
// own listing (Pili Mai 8K, 08D, 13F, 7J). Same-model condos in one
// community photograph nearly identically, so Google Lens VISUAL matches
// sibling listings for any unit we could ever put there — the multi-photo
// agreement fallback (which deliberately skips unit-text verification) then
// declares FOUND forever: an infinite replace loop.
//
// The discriminator: a hit whose title/URL clearly names a DIFFERENT unit of
// the community, when Lens only claims VISUAL similarity, is a sibling
// owner's listing — not our photos. Real theft still gets caught:
//   • Lens "known-source" hits (the page provably contains OUR image) are
//     never suppressed, whatever the title says;
//   • the VERIFIED path (the listing's page text mentions OUR unit number)
//     is unaffected;
//   • hits with no readable unit token keep counting toward agreement.

import { normalizeUnitClaim } from "./folder-unit-map";

// Canonical compare form: uppercase + leading zeros stripped from the numeric
// run so "08D" == "8D" and "Unit #8J" claims match "8J" tokens.
export function canonicalUnitToken(value: string): string {
  return normalizeUnitClaim(String(value ?? ""))
    .replace(/^#/, "")
    .replace(/^0+(?=\d)/, "")
    .trim();
}

// Extract plausible unit identifiers from a listing title/URL.
//   "Pili Mai 8K – 3BR/3BA…"        → ["8K"]
//   "Pili Mai 08D by Parrish Kauai"  → ["8D"]
//   "…/unit-7j/home/123"             → ["7J"]
//   "Condo 13F, Spacious 1st Floor"  → ["13F"]
// Deliberately conservative: bare tokens must be digit(s)+one letter (the
// "8K"/"13F" condo shape — "3BR"/"2BA" never match), marker-prefixed tokens
// (unit/apt/condo/#) may be alphanumeric but pure numbers of 4+ digits
// (street numbers, zips, years) are dropped.
export function unitTokensFromListingText(text: string): string[] {
  const haystack = String(text ?? "").replace(/&[#a-z0-9]+;/gi, " ");
  const out = new Set<string>();
  const push = (raw: string | undefined) => {
    const token = canonicalUnitToken(raw ?? "");
    if (!token) return;
    if (/^\d{4,}$/.test(token)) return; // street number / zip / year
    out.add(token);
  };
  for (const m of haystack.matchAll(/(?:\bunit|\bapt|\bapartment|\bcondo|\bvilla|\bsuite|#)[-_\s]*([A-Za-z]?\d{1,4}[A-Za-z]{0,2})\b/gi)) {
    push(m[1]);
  }
  for (const m of haystack.matchAll(/\b(\d{1,3}[A-Za-z])\b/g)) {
    push(m[1]);
  }
  for (const m of haystack.matchAll(/\bunit[-_/]([A-Za-z0-9]{1,6})\b/gi)) {
    push(m[1]);
  }
  return Array.from(out);
}

// Does this hit's title/URL name a unit that CONFLICTS with all of ours?
// Returns the conflicting token (for logging) or null when there's no
// readable token, no claims of our own, or any token matches ours.
export function conflictingSiblingUnitToken(
  listingText: string,
  ourUnitClaims: string[],
): string | null {
  const ours = new Set(ourUnitClaims.map(canonicalUnitToken).filter(Boolean));
  if (ours.size === 0) return null;
  const tokens = unitTokensFromListingText(listingText);
  if (tokens.length === 0) return null;
  for (const token of tokens) {
    if (ours.has(token)) return null; // names OUR unit — not a sibling
  }
  return tokens[0];
}

// Full policy: suppress a hit from the multi-photo-agreement tally only when
// it names a different unit AND Lens merely claims visual similarity.
// "known-source" (the page provably serves our image) is never suppressed.
export function isSiblingUnitLookalikeHit(input: {
  title: string;
  link: string;
  lensSource: string;
  ourUnitClaims: string[];
}): boolean {
  if (String(input.lensSource ?? "").toLowerCase() === "known-source") return false;
  return conflictingSiblingUnitToken(`${input.title} ${input.link}`, input.ourUnitClaims) !== null;
}
