// ─────────────────────────────────────────────────────────────────────────────
// Guesty Amenity System — per-property profile map (client)
//
// The amenity CATALOG + the Hawaii baseline moved to @shared/guesty-amenity-catalog
// (2026-07-09) so the SERVER (photo amenity scan + bulk-combo listing job) and
// this client share one source of truth. This file re-exports them and keeps the
// client-only per-property profile map (PROPERTY_AMENITY_MAP / getGuestyAmenities).
// ─────────────────────────────────────────────────────────────────────────────

import {
  GUESTY_AMENITY_CATALOG,
  HAWAII_BASE_AMENITY_KEYS,
  getCatalogByCategory,
  getAmenityLabel,
  type AmenityEntry,
} from "@shared/guesty-amenity-catalog";

export {
  GUESTY_AMENITY_CATALOG,
  getCatalogByCategory,
  getAmenityLabel,
  type AmenityEntry,
};

// Alias kept so the per-property profiles below read the same as before.
const HAWAII_BASE = HAWAII_BASE_AMENITY_KEYS;

// ─────────────────────────────────────────────────────────────────────────────
// Beach-location bonus amenities — added to any community with direct beach /
// ocean-front / waterfront access.  Near-beach (walking distance only) gets
// just NEAR_BEACH from HAWAII_BASE, not the full BEACH_EXTRAS block.
// ─────────────────────────────────────────────────────────────────────────────
const BEACH_EXTRAS = [
  "BEACHFRONT",
  "OCEAN_FRONT",
  "OCEAN_VIEW",
  "WATERFRONT",
  "NEAR_BEACH",
  "BEACH_VIEW",
  "BEACH_ACCESS",
  "SEA_VIEW",
  "WATER_VIEW",
];

// ─────────────────────────────────────────────────────────────────────────────
// Community-specific amenity profiles
// ─────────────────────────────────────────────────────────────────────────────

// Regency at Poipu Kai — resort condo complex, pool/spa/tennis, ~10 min walk to Poipu Beach
// Nearby: Kiahuna & Poipu Bay Golf, Kukuiula Village shopping, cycling paths, Poipu Beach snorkeling
// Walk-in shower confirmed in unit photos (unit-924: master bath has glass walk-in shower)
// Tennis court confirmed in community photo 02
const REGENCY_POIPU_KAI = [
  ...HAWAII_BASE,
  "ELEVATOR",
  "POOL",
  "OUTDOOR_POOL",
  "COMMUNAL_POOL",
  "HOT_TUB",
  "GYM",
  "PICKLEBALL_COURT",
  "WALK_IN_SHOWER",      // confirmed: unit-924 master bath photos
  "BBQ_GRILL",
  "GARDEN",
  "GARDEN_VIEW",
  "NEAR_BEACH",
  "RESORT_ACCESS",
  // Nearby activities
  "NEAR_GOLF_COURSE",
  "NEAR_SHOPPING",
  "CYCLING",
  "FISHING",
  "GOLF",
  "SHOPPING",
];

// Kekaha Beachfront Estate — private beachfront homes, direct ocean access, private pool
// Nearby: Kekaha Beach cycling path, Polihale State Park, deep-sea fishing charters
const KEKAHA_ESTATE = [
  ...HAWAII_BASE,
  ...BEACH_EXTRAS,
  "PRIVATE_POOL",
  "OUTDOOR_POOL",
  "BBQ_GRILL",
  "COVERED_PATIO",
  "GARDEN",
  "BICYCLE",
  "BEACH_UMBRELLA",
  // Nearby activities
  "CYCLING",
  "FISHING",
  "HIKING",
];

// Keauhou Estates — Big Island ocean-view estate, private pool, near Keauhou Golf Course
// Nearby: Keauhou Golf Course, Keauhou Bay snorkeling (manta rays), world-class cycling (Ironman route)
const KEAUHOU_ESTATES = [
  ...HAWAII_BASE,
  "OCEAN_VIEW",
  "PRIVATE_POOL",
  "OUTDOOR_POOL",
  "PRIVATE_HOT_TUB",
  "BBQ_GRILL",
  "COVERED_PATIO",
  "GARDEN",
  "OUTDOOR_KITCHEN",
  "EXERCISE_EQUIPMENT",
  // Nearby activities
  "NEAR_GOLF_COURSE",
  "NEAR_BEACH",
  "CYCLING",
  "FISHING",
  "HIKING",
  "GOLF",
];

// Mauna Kai Princeville — North Shore condo, mountain/valley views, near Princeville Makai Golf
// Nearby: Princeville Makai Golf Course, Hanalei Bay (snorkeling/surfing), Napali hiking, cycling
const MAUNA_KAI = [
  ...HAWAII_BASE,
  "ELEVATOR",
  "POOL",
  "OUTDOOR_POOL",
  "COMMUNAL_POOL",
  "HOT_TUB",
  "GYM",
  "MOUNTAIN_VIEW",
  "GARDEN_VIEW",
  "NEAR_BEACH",
  "RESORT_ACCESS",
  // Nearby activities
  "NEAR_GOLF_COURSE",
  "CYCLING",
  "FISHING",
  "HIKING",
  "GOLF",
];

// Kaha Lani Resort — Kapaa oceanfront condo resort, beachfront, direct ocean access
// Nearby: Kapaa Bike Path (famous 8-mile coastal path), Kapaa Town shopping, snorkeling, fishing
// Walk-in shower confirmed: kaha-lani-109 photo_05 (glass door walk-in shower in master bath)
// Tennis court confirmed: kaha-lani-109 photo_11 aerial (green court with fence, upper left corner)
const KAHA_LANI = [
  ...HAWAII_BASE,
  ...BEACH_EXTRAS,
  "ELEVATOR",
  "POOL",
  "OUTDOOR_POOL",
  "COMMUNAL_POOL",
  "WALK_IN_SHOWER",      // confirmed: kaha-lani-109 master bath photo
  "RESORT_ACCESS",
  // Nearby activities
  "NEAR_SHOPPING",
  "CYCLING",
  "FISHING",
  "SHOPPING",
];

// Lae Nani Resort — Kapaa beachfront condo resort, ocean view, pool
// Nearby: Kapaa Bike Path, Lydgate Beach Park (snorkeling lagoon), Kapaa shopping, fishing
const LAE_NANI = [
  ...HAWAII_BASE,
  ...BEACH_EXTRAS,
  "ELEVATOR",
  "POOL",
  "OUTDOOR_POOL",
  "COMMUNAL_POOL",
  "HOT_TUB",
  "RESORT_ACCESS",
  "GARDEN_VIEW",
  // Nearby activities
  "NEAR_SHOPPING",
  "CYCLING",
  "FISHING",
  "SHOPPING",
];

// Poipu Brenneckes Beachside — steps to Brenneckes Beach, shared pool, ocean nearby
// Nearby: Brenneckes Beach (bodyboarding/surfing), Poipu Beach snorkeling, Poipu Bay Golf, Kukuiula shopping
const POIPU_BEACHSIDE = [
  ...HAWAII_BASE,
  ...BEACH_EXTRAS,
  "ELEVATOR",
  "POOL",
  "OUTDOOR_POOL",
  "COMMUNAL_POOL",
  "HOT_TUB",
  "BBQ_GRILL",
  "RESORT_ACCESS",
  // Nearby activities
  "NEAR_GOLF_COURSE",
  "NEAR_SHOPPING",
  "CYCLING",
  "FISHING",
  "GOLF",
  "SHOPPING",
];

// Poipu Brenneckes Oceanfront — direct oceanfront/beachfront, pool, immediate beach access
// Nearby: Brenneckes Beach (bodyboarding/surfing), Poipu Beach snorkeling, Poipu Bay Golf, Kukuiula shopping
const POIPU_OCEANFRONT = [
  ...HAWAII_BASE,
  ...BEACH_EXTRAS,
  "ELEVATOR",
  "POOL",
  "OUTDOOR_POOL",
  "COMMUNAL_POOL",
  "HOT_TUB",
  "BBQ_GRILL",
  "RESORT_ACCESS",
  // Nearby activities
  "NEAR_GOLF_COURSE",
  "NEAR_SHOPPING",
  "CYCLING",
  "FISHING",
  "GOLF",
  "SHOPPING",
];

// Kaiulani of Princeville — North Shore resort condos, mountain & valley views, near Princeville Golf
// Nearby: Princeville Makai Golf Course, Hanalei Bay, Napali hiking, North Shore surfing, cycling
const KAIULANI = [
  ...HAWAII_BASE,
  "ELEVATOR",
  "POOL",
  "OUTDOOR_POOL",
  "COMMUNAL_POOL",
  "HOT_TUB",
  "GYM",
  "MOUNTAIN_VIEW",
  "GARDEN_VIEW",
  "NEAR_BEACH",
  "RESORT_ACCESS",
  // Nearby activities
  "NEAR_GOLF_COURSE",
  "CYCLING",
  "FISHING",
  "HIKING",
  "GOLF",
];

// Pili Mai at Poipu — resort townhomes, pool, steps to Poipu Beach
// Townhomes are 2–3 stories — no elevator
// Nearby: Poipu Beach Park, Poipu Bay Golf, Kukuiula Village, cycling, snorkeling
const PILI_MAI = [
  ...HAWAII_BASE,
  "POOL",
  "OUTDOOR_POOL",
  "COMMUNAL_POOL",
  "HOT_TUB",
  "GYM",
  "BBQ_GRILL",
  "NEAR_BEACH",
  "GARDEN_VIEW",
  "GARDEN",
  "RESORT_ACCESS",
  "COVERED_PATIO",
  // Nearby activities
  "NEAR_GOLF_COURSE",
  "NEAR_SHOPPING",
  "CYCLING",
  "FISHING",
  "GOLF",
  "SHOPPING",
];

// ─────────────────────────────────────────────────────────────────────────────
// Per-property amenity lookup
// ─────────────────────────────────────────────────────────────────────────────
const PROPERTY_AMENITY_MAP: Record<number, string[]> = {
  // Regency at Poipu Kai
  4:  REGENCY_POIPU_KAI,
  7:  REGENCY_POIPU_KAI,
  8:  REGENCY_POIPU_KAI,
  9:  REGENCY_POIPU_KAI,
  18: REGENCY_POIPU_KAI,
  21: REGENCY_POIPU_KAI,
  27: REGENCY_POIPU_KAI,
  34: REGENCY_POIPU_KAI,

  // Kekaha Beachfront Estate
  10: KEKAHA_ESTATE,
  12: KEKAHA_ESTATE,

  // Keauhou Estates (Big Island)
  14: KEAUHOU_ESTATES,
  26: KEAUHOU_ESTATES,

  // Mauna Kai Princeville
  19: MAUNA_KAI,
  20: MAUNA_KAI,

  // Kaha Lani Resort (Kapaa)
  23: KAHA_LANI,

  // Lae Nani Resort (Kapaa)
  24: LAE_NANI,

  // Poipu Brenneckes Beachside
  28: POIPU_BEACHSIDE,

  // Poipu Brenneckes Oceanfront
  31: POIPU_OCEANFRONT,

  // Kaiulani of Princeville
  29: KAIULANI,

  // Pili Mai at Poipu
  32: PILI_MAI,
  33: PILI_MAI,
};

/**
 * Returns the amenity keys for a given property's static profile.
 * Deduplicates and returns a sorted list. Falls back to the Hawaii baseline.
 */
export function getGuestyAmenities(propertyId: number): string[] {
  const amenities = PROPERTY_AMENITY_MAP[propertyId] || HAWAII_BASE;
  return [...new Set(amenities)];
}
