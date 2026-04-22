// Central rule: the business only supports condo / townhome communities.
// Villas, single-family homes, detached houses, estates, and pool homes are
// explicitly disqualified — combining two of them isn't the same product as
// combining two condos in the same building / townhome row.
//
// Used by the add-community flow (pre-filter research results, reject save)
// and client-side rendering (grey out ineligible cards). Keep in /shared so
// both sides of the stack evaluate with identical logic.

// Disqualifying terms — any occurrence in unitTypes / researchSummary flags
// the community as not-a-fit. Order doesn't matter; whole-word not required
// because "single-family" and "singlefamily" are both common.
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

// Required: at least one of these must appear somewhere in the community's
// description. Prevents "Unknown" / unclassified entries from sneaking in.
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

export type CommunityTypeCheck = {
  eligible: boolean;
  reason?: string;
  matchedDisqualifier?: string;
};

export function checkCommunityType(
  unitTypes: string | null | undefined,
  researchSummary?: string | null,
): CommunityTypeCheck {
  const text = `${unitTypes ?? ""} ${researchSummary ?? ""}`.toLowerCase();
  if (!text.trim()) {
    return { eligible: false, reason: "no type info — must be condo or townhome" };
  }

  for (const term of DISQUALIFYING_TERMS) {
    if (text.includes(term)) {
      return {
        eligible: false,
        reason: `contains "${term}" — only condo/townhome communities are supported`,
        matchedDisqualifier: term,
      };
    }
  }

  const hasQualifier = QUALIFYING_TERMS.some((term) => text.includes(term));
  if (!hasQualifier) {
    return {
      eligible: false,
      reason: "no condo/townhome type signal in description",
    };
  }

  return { eligible: true };
}
