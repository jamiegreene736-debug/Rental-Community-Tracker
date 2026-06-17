// Unit-match predicate for the find-unit OTA-presence check
// (`checkOnePlatform` in server/routes.ts). Extracted as a pure, testable
// module because this is a precision-sensitive matcher: a false "found" wrongly
// rejects a genuinely-clean replacement unit (the dominant reason letter-coded,
// STVR-saturated resorts like Waikoloa Beach Villas return no replacement), while
// a false "clean" risks suggesting a double-listed unit. See
// tests/listing-unit-match.test.ts.

// Mirror of `normalizeSearchText` in server/routes.ts (kept verbatim-equivalent —
// the matcher must normalize hit text the same way the route does). Lowercase,
// strip diacritics + HTML entities, collapse every non-alphanumeric run to a
// single space.
export function normalizeListingMatchText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&[#a-z0-9]+;/gi, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type ListingHit = { title?: string | null; snippet?: string | null; link?: string | null };

/**
 * True when a search hit (a Google result whose link is already host-scoped to
 * the OTA by the caller) plausibly refers to the SAME unit as `unit`.
 *
 * Numeric units (e.g. Poipu Kai "721") require an adjacent unit-context keyword
 * so a bare number can't collide across listings — UNCHANGED.
 *
 * Letter-coded units (e.g. Waikoloa Beach Villas "C1"/"A4"/"I4") used to match a
 * bare `\bcode\b` anywhere in title+snippet+link. That false-matches a multi-unit
 * VRBO/Airbnb ROUNDUP page whose snippet enumerates several codes ("…C1, A4, I4…"),
 * wrongly flagging a clean unit as already listed. So a letter code now matches
 * only when ANCHORED:
 *   (a) it is a bounded token in the hit's TITLE — a real single listing titles
 *       its unit ("Waikoloa Beach Villas C1"); a roundup title is generic; OR
 *   (b) it sits next to a GENERIC unit-designator keyword (unit/apt/condo/suite/
 *       building) anywhere in the text. The keyword set deliberately EXCLUDES the
 *       resort/"villas" word so a roundup snippet "…Beach Villas C1, A4…" cannot
 *       anchor via "villas c1".
 * The reverse-image photo-reuse gate ("skipped-photo-found") downstream is the
 * backstop: anything that slips through here but reuses OTA photos is still
 * rejected, so tightening this never reintroduces the photo-feedback loop.
 */
export function hitTextMatchesUnit(unit: string, hit: ListingHit): boolean {
  const normalizedUnit = normalizeListingMatchText(unit).replace(/\s+/g, "");
  if (!normalizedUnit) return true;

  const text = normalizeListingMatchText(`${hit.title || ""} ${hit.snippet || ""} ${hit.link || ""}`);
  const unitPattern = escapeRegExp(normalizedUnit);

  if (!/^\d+$/.test(normalizedUnit)) {
    const titleText = normalizeListingMatchText(hit.title || "");
    if (new RegExp(`\\b${unitPattern}\\b`).test(titleText)) return true;
    return (
      new RegExp(`\\b(?:unit|apt|apartment|condo|suite|bldg|building)\\s+${unitPattern}\\b`).test(text) ||
      new RegExp(`\\b${unitPattern}\\s+(?:unit|apt|apartment|condo|suite)\\b`).test(text)
    );
  }

  return (
    new RegExp(
      `\\b(?:unit|apt|apartment|condo|villa|villas|suite|regency|manualoha|makahuena|pili\\s+mai|kai\\s+nui|poipu\\s+kai|building)\\s+${unitPattern}\\b`,
    ).test(text) ||
    new RegExp(`\\b${unitPattern}\\s+(?:unit|apt|apartment|condo|villa|villas|suite)\\b`).test(text)
  );
}
