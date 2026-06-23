// Pure helpers for ordering a listing's photos before they're pushed to
// Guesty. The published order the operator asked for (2026-06-19) is:
//
//   cover collage (pushed separately, prepended as the Guesty cover)
//     → Unit A → Unit B → … → Community
//
// and WITHIN each gallery a "best presentation" hero-first order
// (living / view / kitchen → bedrooms → bathrooms → … for a unit; pool /
// beach / exterior → grounds → amenities → … for the community) UNLESS the
// operator has manually dragged the photos. A manual drag persists an
// explicit per-photo `sortOrder` on photo_labels.sort_order; when present it
// wins over the category heuristic for that gallery.
//
// Everything here is deterministic + side-effect free so it can be unit
// tested and shared between the builder assembly (client) and any server
// code that needs the same ordering contract.

export type PhotoScope = "unit" | "community";

export type OrderablePhoto = {
  /**
   * Free text used to infer the room/scene category — typically the photo's
   * effective caption joined with its label/category and filename. More
   * signal = better placement; an empty string just sorts to the tail.
   */
  text?: string | null;
  /**
   * Manual operator order, persisted on `photo_labels.sort_order`. `null` /
   * `undefined` means "no manual order — use the hero-first default".
   */
  sortOrder?: number | null;
};

// Lower rank = earlier in the gallery. The first regex that matches the
// photo text wins, so the lists are ordered most-specific-first where it
// matters (e.g. "primary/master" before the generic "bedroom").
// Order matters: the FIRST regex that matches wins, so collisions are resolved
// by listing the more-specific rule first even when its rank value is higher.
const UNIT_CATEGORY_RANK: Array<[RegExp, number]> = [
  // Bathroom is matched BEFORE the primary/master bedroom rule so a "Primary
  // Bathroom" / "Master Bath" ranks as a bath (6), not a bedroom (4). NOTE the
  // `(?:room|s|tub)?` — a bare `\bbath\b` does NOT match the word "bathroom"
  // (no word boundary inside "bath·room"), which previously dropped every
  // plain "… Bathroom" caption to OTHER.
  [/\b(bath(?:room|rooms|s|tub)?|shower|ensuite|en-?suite|powder|toilet|vanity|tub)\b/, 6],
  [/\b(living|great ?room|family ?room|lounge|sitting|loft|den|main ?room)\b/, 0],
  [/\b(kitchen|kitchenette)\b/, 2],
  [/\b(dining|breakfast|eat-?in)\b/, 3],
  [/\b(primary|master)\b/, 4],
  [/\b(bed ?room|\bbeds?\b|king|queen|twin|bunk|murphy|sleeper)\b/, 5],
  // Scenic/outdoor is matched AFTER the room rules so a bedroom/bath "— Alt
  // View" (or a "Dining Room With Mountain View") ranks by its ROOM — keeping a
  // room's photos clustered together — instead of being pulled to the front as
  // a scenic shot. Bare "view" is deliberately NOT a keyword: it matched the
  // "— Alt View" cluster suffix and scattered every alt-angle photo.
  [/\b(ocean ?front|ocean ?view|sea ?view|water ?view|sunset|lanai|balcon|patio|deck|terrace|veranda)\b/, 1],
  [/\b(laundry|washer|dryer|closet|garage|entry|hallway|foyer|office|desk|workspace|stair)\b/, 7],
];

const COMMUNITY_CATEGORY_RANK: Array<[RegExp, number]> = [
  [/\b(pool|hot ?tub|jacuzzi|spa|whirlpool|infinity)\b/, 0],
  [/\b(beach|ocean|sand|shore|surf|sunset|lagoon|waterfront)\b/, 1],
  [/\b(aerial|exterior|building|resort|property|entrance|drone|complex|facade)\b/, 2],
  [/\b(garden|landscap|grounds|courtyard|walkway|path|tropical|palm|koi|waterfall)\b/, 3],
  [/\b(gym|fitness|tennis|pickle|bbq|grill|barbecue|clubhouse|lobby|lounge|game|playground|amenit)\b/, 4],
];

// Photos with no recognizable category keyword sort after every categorized
// photo but keep their original relative order (stable).
export const OTHER_CATEGORY_RANK = 8;

export function categoryRank(text: string | null | undefined, scope: PhotoScope): number {
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return OTHER_CATEGORY_RANK;
  const table = scope === "community" ? COMMUNITY_CATEGORY_RANK : UNIT_CATEGORY_RANK;
  for (const [re, rank] of table) if (re.test(t)) return rank;
  return OTHER_CATEGORY_RANK;
}

/**
 * True when the photo is a clustered ALT-ANGLE shot (the bedroom/bathroom
 * clustering appends "— Alt View"). Within a category these sort AFTER the
 * primary shot so a room's cluster leads with its hero photo
 * (e.g. "Master Bedroom — King" before "Master Bedroom — Alt View").
 */
export function isAltView(text: string | null | undefined): boolean {
  return /\balt(?:ernate)?\.?\s*view\b/i.test(text ?? "");
}

/** "Community — Pili Mai" → community; anything else → unit. */
export function scopeForSource(source: string | null | undefined): PhotoScope {
  return /community/i.test(source ?? "") ? "community" : "unit";
}

/** True when at least one photo carries an explicit manual order. */
export function hasManualOrder(photos: ReadonlyArray<OrderablePhoto>): boolean {
  return photos.some((p) => p.sortOrder != null);
}

/**
 * Order one gallery (a single unit folder, or the community folder).
 *
 * - If ANY photo carries a manual `sortOrder`, the gallery is ordered by it
 *   (operator drag wins; ties + un-ordered photos fall back to the original
 *   index so the result is fully deterministic).
 * - Otherwise the gallery is ordered hero-first by category, stable on the
 *   original index.
 *
 * Returns a NEW array and never mutates the input.
 */
export function orderGallery<T extends OrderablePhoto>(photos: T[], scope: PhotoScope): T[] {
  const indexed = photos.map((p, i) => ({ p, i }));
  if (hasManualOrder(photos)) {
    indexed.sort((a, b) => {
      const sa = a.p.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const sb = b.p.sortOrder ?? Number.MAX_SAFE_INTEGER;
      return sa - sb || a.i - b.i;
    });
  } else {
    indexed.sort((a, b) => {
      const ra = categoryRank(a.p.text, scope);
      const rb = categoryRank(b.p.text, scope);
      if (ra !== rb) return ra - rb;
      // Within a category, the primary shot leads and alt angles follow, then
      // stable on the original index — keeps a room's cluster together.
      const aa = isAltView(a.p.text) ? 1 : 0;
      const ab = isAltView(b.p.text) ? 1 : 0;
      return aa - ab || a.i - b.i;
    });
  }
  return indexed.map((x) => x.p);
}

/**
 * Hero-first ordering of a section expressed as a permutation of indices.
 * Used by the Photos-tab "Best order" button to compute (and then persist)
 * the recommended order without re-deriving it on the server.
 */
export function bestOrderIndices(
  texts: ReadonlyArray<string | null | undefined>,
  scope: PhotoScope,
): number[] {
  return texts
    .map((text, i) => ({ i, rank: categoryRank(text, scope), alt: isAltView(text) ? 1 : 0 }))
    .sort((a, b) => a.rank - b.rank || a.alt - b.alt || a.i - b.i)
    .map((x) => x.i);
}
