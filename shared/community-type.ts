// Central rule: the business only supports condo / townhome communities.
// Villas, single-family homes, detached houses, estates, and pool homes are
// explicitly disqualified — combining two of them isn't the same product as
// combining two condos in the same building / townhome row.
//
// Used by the add-community flow (pre-filter research results, reject save)
// and client-side rendering (grey out ineligible cards). Keep in /shared so
// both sides of the stack evaluate with identical logic.

// Disqualifying terms — when they appear in the short `unitTypes` field,
// that's a strong signal the community is of the wrong type. These are
// matched with word boundaries to avoid false matches on substrings (e.g.
// "villa" inside "Villafranca" or a brand name).
const DISQUALIFYING_TERMS = [
  "villa",
  "villas",
  "detached",
  "single family",
  "single-family",
  "singlefamily",
  "sfh",
  "sfr",
  "estate",
  "estates",
  "standalone",
  "pool home",
  "private home",
  "private house",
  "guest quarters",
  "main house",
];

// Qualifying terms — one of these should appear in `unitTypes` so we don't
// accept unclassified entries.
const QUALIFYING_TERMS = [
  "condo",
  "condos",
  "condominium",
  "condominiums",
  "townhome",
  "townhomes",
  "townhouse",
  "townhouses",
  "apartment",
  "flat",
];

// Word-boundary-aware includes so we don't mis-match "villa" inside e.g.
// "Villafranca", and so multi-word terms still match when surrounded by
// punctuation or other words. Input is expected lowercase.
function containsTerm(haystack: string, term: string): boolean {
  const t = term.toLowerCase();
  // If the term contains non-word chars (space, hyphen) use plain substring.
  if (!/^[a-z0-9]+$/.test(t)) return haystack.includes(t);
  const re = new RegExp(`(?:^|[^a-z0-9])${t}(?:[^a-z0-9]|$)`, "i");
  return re.test(haystack);
}

export type CommunityTypeCheck = {
  eligible: boolean;
  reason?: string;
  matchedDisqualifier?: string;
};

// Two-tier check (rev. 2026-04 after the scan-top-markets feature returned
// zero results on every market — root cause was the old regex scanning
// Claude's reason text, which routinely mentions "villa" as context ("unlike
// the nearby villa developments...") and triggered rejection):
//
//   1. `unitTypes` is the authoritative signal. If it contains a qualifying
//      term AND does not contain a disqualifier, accept. Done. We do NOT
//      consult `researchSummary` in this path — its prose is noisy and
//      often references disqualifying words in a non-disqualifying way.
//
//   2. Only when `unitTypes` is missing / ambiguous (contains neither a
//      qualifier nor a disqualifier) do we fall through to scanning
//      `researchSummary` — as a last-resort tiebreaker.
export function checkCommunityType(
  unitTypes: string | null | undefined,
  researchSummary?: string | null,
): CommunityTypeCheck {
  const typeText = (unitTypes ?? "").toLowerCase();
  const hasType = typeText.trim().length > 0;

  if (hasType) {
    const disq = DISQUALIFYING_TERMS.find((t) => containsTerm(typeText, t));
    if (disq) {
      return {
        eligible: false,
        reason: `unit types field contains "${disq}" — only condo/townhome communities are supported`,
        matchedDisqualifier: disq,
      };
    }
    const hasQualifier = QUALIFYING_TERMS.some((t) => containsTerm(typeText, t));
    if (hasQualifier) return { eligible: true };
    // unitTypes exists but doesn't say one way or the other — fall through
    // to the summary check below rather than rejecting outright.
  }

  const summaryText = (researchSummary ?? "").toLowerCase();
  if (!summaryText.trim() && !hasType) {
    return { eligible: false, reason: "no type info — must be condo or townhome" };
  }

  // Require a positive qualifier in the summary. Don't use disqualifiers here
  // as a hard-reject — Claude's prose is too noisy (see header comment).
  const summaryHasQualifier = QUALIFYING_TERMS.some((t) => containsTerm(summaryText, t));
  if (summaryHasQualifier) return { eligible: true };

  return {
    eligible: false,
    reason: "no condo/townhome signal in unit types or description",
  };
}
