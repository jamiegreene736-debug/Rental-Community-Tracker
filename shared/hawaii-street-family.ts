// Hawaii "same street family" matching for the find-unit replacement
// resort gate (server/routes.ts `/api/replacement/find-unit`).
//
// `streetRootFromListingAddress()` canonicalizes a listing address into
// "<district> <lot> <street name> <type>", e.g. "69 180 waikoloa beach dr".
// The find-unit outside-resort gate compares a candidate's root against the
// configured community's allowed root(s). An EXACT root match is ideal, but
// Hawaii address slugs vary (district prefixes, unit tokens, duplicated
// numbers), so the gate also accepts a "same street family" — same district
// prefix + same street name — even when the lot number differs. That lot-
// agnostic tolerance is LOAD-BEARING for resorts that genuinely span multiple
// lot numbers on one street, e.g. Coconut Plantation on Olani St (Ko Olina),
// whose buildings run 92-1001 … 92-1097 Olani St under one resort.
//
// PROBLEM (2026-06-22): some Hawaii streets host MULTIPLE DISTINCT resorts under
// the same district prefix + street name, distinguished ONLY by the lot number.
// Waikoloa Beach Dr is the canonical case:
//   69-180 Waikoloa Beach Dr = Waikoloa Beach Villas  (the configured community)
//   69-555 Waikoloa Beach Dr = Waikoloa Colony Villas (a DIFFERENT resort)
//   69-275 = Marriott, 69-450 = Bay Club, …
// The lot-agnostic family match collapsed all of them into one resort, so the
// find-unit replacement search offered a Colony Villas unit (Redfin #1502) as a
// replacement for Beach Villas. On these streets the lot number is
// resort-significant and must NOT be discarded.

// Canonical "<name> <type>" street keys (lowercased) where the lot number
// distinguishes SEPARATE resorts, so the street-family match must require the
// lot number to match too. Recall-safe: a street NOT listed keeps the prior
// lot-agnostic behavior, so genuine single-resort/multi-building matches
// (Coconut Plantation on Olani St, etc.) are unaffected. Extend with one line
// per newly-confirmed shared street.
export const HAWAII_STREETS_WITH_DISTINCT_RESORTS_BY_LOT: ReadonlySet<string> = new Set([
  "waikoloa beach dr", // 69-180 Beach Villas vs 69-555 Colony Villas vs 69-275 Marriott vs 69-450 Bay Club
]);

// "<district> <lot> <street name + type>" — the shape streetRootFromListingAddress emits.
const ROOT_RE = /^(\d{1,2})\s+(\d{3,5})\s+(.+)$/i;

// True when two canonical street roots belong to the same Hawaii resort family:
// same district prefix + same street name. On streets where the lot number is
// resort-significant (HAWAII_STREETS_WITH_DISTINCT_RESORTS_BY_LOT) the lot
// number must also match, so distinct resorts sharing a street are NOT merged.
//
// On every other street the lot number is intentionally ignored (byte-identical
// to the pre-2026-06-22 behavior) so multi-building single resorts still match.
export function isSameHawaiiStreetFamily(candidateRoot: string, allowedRoot: string): boolean {
  const candidate = candidateRoot.match(ROOT_RE);
  const allowed = allowedRoot.match(ROOT_RE);
  if (!candidate || !allowed) return false;
  // District prefix + street name must always match.
  if (candidate[1] !== allowed[1] || candidate[3] !== allowed[3]) return false;
  // On lot-significant streets, require the lot number to match too so a
  // different resort on the same street is not accepted as a sibling building.
  if (
    HAWAII_STREETS_WITH_DISTINCT_RESORTS_BY_LOT.has(allowed[3].toLowerCase()) &&
    candidate[2] !== allowed[2]
  ) {
    return false;
  }
  return true;
}
