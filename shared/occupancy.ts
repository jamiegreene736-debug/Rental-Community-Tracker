// Canonical headline-occupancy rule — shared by client and server so the
// listing TITLE, the SUMMARY prose ("up to N guests"), the dashboard "Guests"
// column, the Guesty `accommodates` field, generated community-draft titles,
// and the guest-reply assistant ALL report the same "Sleeps N" for a given
// bedroom count. Before this existed each surface derived occupancy its own way
// (sum of per-unit maxGuests, raw bed capacity, an LLM guess, b*2+2) and a
// single listing routinely showed three or four different numbers.
//
// Operator anchors (2026-06-16): 2BR→6, 4BR→12, 5BR→14, 6BR→16, 7BR→18.
// The pattern is "2 guests per bedroom + sleeper sofas": +2 for a single-condo
// listing (≤2BR), +4 for the multi-condo combos (≥3BR), so 3→10 and 8→20.
//
// This is the SINGLE source of truth — never re-derive occupancy from beds or
// maxGuests for a whole-listing headline; call this instead.
export function occupancyForBedrooms(bedrooms: number): number {
  if (!Number.isFinite(bedrooms) || bedrooms <= 0) return 0;
  if (bedrooms <= 2) return bedrooms * 2 + 2;
  return bedrooms * 2 + 4;
}
