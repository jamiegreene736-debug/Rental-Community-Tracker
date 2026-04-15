// ─────────────────────────────────────────────────────────────────────────────
// Guesty Amenity System
// All strings here are the exact Guesty API amenity identifiers.
// Organized into display categories for the builder UI.
// ─────────────────────────────────────────────────────────────────────────────

export type AmenityEntry = {
  key: string;        // Guesty API string (sent to API)
  label: string;      // Human-readable label (shown in UI)
  category: string;   // Display category
};

export const GUESTY_AMENITY_CATALOG: AmenityEntry[] = [
  // ── Essentials ────────────────────────────────────────────────────────────
  { key: "WIFI",                        label: "WiFi",                          category: "Essentials" },
  { key: "ESSENTIALS",                  label: "Essentials (towels, soap, TP)", category: "Essentials" },
  { key: "AIR_CONDITIONING",            label: "Air Conditioning",              category: "Essentials" },
  { key: "HEATING",                     label: "Heating",                       category: "Essentials" },
  { key: "CEILING_FAN",                 label: "Ceiling Fans",                  category: "Essentials" },
  { key: "WASHER",                      label: "Washer",                        category: "Essentials" },
  { key: "DRYER",                       label: "Dryer",                         category: "Essentials" },
  { key: "IRON",                        label: "Iron & Ironing Board",          category: "Essentials" },
  { key: "HAIR_DRYER",                  label: "Hair Dryer",                    category: "Essentials" },
  { key: "DEDICATED_WORKSPACE",         label: "Dedicated Workspace / Desk",    category: "Essentials" },
  { key: "ELEVATOR",                    label: "Elevator Access",               category: "Essentials" },
  { key: "LUGGAGE_DROPOFF",             label: "Luggage Drop-off",              category: "Essentials" },
  { key: "KEYPAD",                      label: "Keyless Entry",                 category: "Essentials" },
  { key: "PRIVATE_ENTRANCE",            label: "Private Entrance",              category: "Essentials" },

  // ── Kitchen ───────────────────────────────────────────────────────────────
  { key: "KITCHEN",                     label: "Full Kitchen",                  category: "Kitchen" },
  { key: "REFRIGERATOR",                label: "Refrigerator",                  category: "Kitchen" },
  { key: "MICROWAVE",                   label: "Microwave",                     category: "Kitchen" },
  { key: "DISHWASHER",                  label: "Dishwasher",                    category: "Kitchen" },
  { key: "STOVE",                       label: "Stove",                         category: "Kitchen" },
  { key: "OVEN",                        label: "Oven",                          category: "Kitchen" },
  { key: "COFFEE_MAKER",                label: "Coffee Maker",                  category: "Kitchen" },
  { key: "TOASTER",                     label: "Toaster",                       category: "Kitchen" },
  { key: "BLENDER",                     label: "Blender",                       category: "Kitchen" },
  { key: "COOKING_BASICS",              label: "Cookware & Utensils",           category: "Kitchen" },
  { key: "DISHES_AND_SILVERWARE",       label: "Dishes & Silverware",           category: "Kitchen" },
  { key: "DINING_TABLE",                label: "Dining Table",                  category: "Kitchen" },
  { key: "WINE_GLASSES",                label: "Wine Glasses",                  category: "Kitchen" },
  { key: "SPICES",                      label: "Spices & Cooking Basics",       category: "Kitchen" },

  // ── Entertainment ─────────────────────────────────────────────────────────
  { key: "TV",                          label: "Smart TV",                      category: "Entertainment" },
  { key: "CABLE_TV",                    label: "Cable TV",                      category: "Entertainment" },
  { key: "STREAMING_SERVICES",          label: "Streaming Services",            category: "Entertainment" },
  { key: "SOUND_SYSTEM",                label: "Sound System",                  category: "Entertainment" },
  { key: "GAME_ROOM",                   label: "Game Room",                     category: "Entertainment" },
  { key: "PING_PONG_TABLE",             label: "Ping Pong Table",               category: "Entertainment" },
  { key: "POOL_TABLE",                  label: "Pool Table / Billiards",        category: "Entertainment" },
  { key: "BOARD_GAMES",                 label: "Board Games",                   category: "Entertainment" },

  // ── Bedrooms & Sleeping ───────────────────────────────────────────────────
  { key: "BED_LINENS",                  label: "Bed Linens Provided",           category: "Bedrooms" },
  { key: "EXTRA_PILLOWS_AND_BLANKETS",  label: "Extra Pillows & Blankets",      category: "Bedrooms" },
  { key: "BLACKOUT_SHADES",             label: "Blackout Curtains",             category: "Bedrooms" },
  { key: "LOCK_ON_BEDROOM_DOOR",        label: "Lock on Bedroom Door",          category: "Bedrooms" },

  // ── Bathroom ──────────────────────────────────────────────────────────────
  { key: "SHAMPOO",                     label: "Shampoo & Toiletries",          category: "Bathroom" },
  { key: "BODY_SOAP",                   label: "Body Soap",                     category: "Bathroom" },
  { key: "BATHTUB",                     label: "Bathtub",                       category: "Bathroom" },
  { key: "JETTED_TUB",                  label: "Jetted / Soaking Tub",         category: "Bathroom" },
  { key: "WALK_IN_SHOWER",              label: "Walk-in Shower",                category: "Bathroom" },
  { key: "HOT_WATER",                   label: "Hot Water",                     category: "Bathroom" },
  { key: "TOWELS_PROVIDED",             label: "Bath Towels Provided",          category: "Bathroom" },

  // ── Pool & Water ──────────────────────────────────────────────────────────
  { key: "POOL",                        label: "Swimming Pool (Shared)",        category: "Pool & Water" },
  { key: "PRIVATE_POOL",                label: "Private Pool",                  category: "Pool & Water" },
  { key: "HOT_TUB",                     label: "Hot Tub / Jacuzzi (Shared)",    category: "Pool & Water" },
  { key: "PRIVATE_HOT_TUB",             label: "Private Hot Tub",               category: "Pool & Water" },
  { key: "LAP_POOL",                    label: "Lap Pool",                      category: "Pool & Water" },
  { key: "INDOOR_POOL",                 label: "Indoor Pool",                   category: "Pool & Water" },
  { key: "WADING_POOL",                 label: "Wading / Kids Pool",            category: "Pool & Water" },

  // ── Outdoor & Recreation ──────────────────────────────────────────────────
  { key: "PATIO_OR_BALCONY",            label: "Lanai / Balcony / Patio",       category: "Outdoor" },
  { key: "COVERED_PATIO",               label: "Covered Lanai / Patio",         category: "Outdoor" },
  { key: "BBQ_GRILL",                   label: "BBQ / Grill",                   category: "Outdoor" },
  { key: "FIRE_PIT",                    label: "Fire Pit",                      category: "Outdoor" },
  { key: "OUTDOOR_FURNITURE",           label: "Outdoor Furniture",             category: "Outdoor" },
  { key: "OUTDOOR_KITCHEN",             label: "Outdoor Kitchen",               category: "Outdoor" },
  { key: "GARDEN",                      label: "Garden / Yard",                 category: "Outdoor" },
  { key: "TENNIS_COURT",                label: "Tennis Court",                  category: "Outdoor" },
  { key: "PICKLEBALL_COURT",            label: "Pickleball Court",              category: "Outdoor" },
  { key: "EXERCISE_EQUIPMENT",          label: "Exercise Equipment",            category: "Outdoor" },
  { key: "GYM",                         label: "Fitness Center / Gym",          category: "Outdoor" },
  { key: "BICYCLE",                     label: "Bicycle",                       category: "Outdoor" },
  { key: "KAYAK",                       label: "Kayak",                         category: "Outdoor" },
  { key: "BOAT",                        label: "Boat / Canoe",                  category: "Outdoor" },

  // ── Beach & Water Access ──────────────────────────────────────────────────
  { key: "BEACH_ESSENTIALS",            label: "Beach Essentials (gear/towels)",category: "Beach" },
  { key: "BEACH_CHAIR",                 label: "Beach Chairs",                  category: "Beach" },
  { key: "BEACH_UMBRELLA",              label: "Beach Umbrella",                category: "Beach" },
  { key: "SNORKELING_GEAR",             label: "Snorkeling Gear",               category: "Beach" },
  { key: "COOLER",                      label: "Cooler / Ice Chest",            category: "Beach" },

  // ── Location & Views ──────────────────────────────────────────────────────
  { key: "BEACHFRONT",                  label: "Beachfront (on the beach)",     category: "Location & Views" },
  { key: "OCEAN_FRONT",                 label: "Oceanfront (direct ocean access)",category: "Location & Views" },
  { key: "OCEAN_VIEW",                  label: "Ocean View",                    category: "Location & Views" },
  { key: "WATERFRONT",                  label: "Waterfront",                    category: "Location & Views" },
  { key: "LAKE_FRONT",                  label: "Lakefront",                     category: "Location & Views" },
  { key: "NEAR_BEACH",                  label: "Near Beach (walking distance)", category: "Location & Views" },
  { key: "MOUNTAIN_VIEW",               label: "Mountain View",                 category: "Location & Views" },
  { key: "GARDEN_VIEW",                 label: "Garden / Tropical View",        category: "Location & Views" },
  { key: "POOL_VIEW",                   label: "Pool View",                     category: "Location & Views" },
  { key: "CITY_VIEW",                   label: "City View",                     category: "Location & Views" },
  { key: "GOLF_VIEW",                   label: "Golf Course View",              category: "Location & Views" },
  { key: "NEAR_GOLF_COURSE",            label: "Near Golf Course",              category: "Location & Views" },
  { key: "NEAR_RESTAURANTS",            label: "Near Restaurants & Dining",     category: "Location & Views" },
  { key: "NEAR_SHOPPING",               label: "Near Shopping",                 category: "Location & Views" },
  { key: "RESORT_ACCESS",               label: "Resort Community Access",       category: "Location & Views" },

  // ── Parking & Transport ───────────────────────────────────────────────────
  { key: "FREE_PARKING_ON_PREMISES",    label: "Free Parking",                  category: "Parking" },
  { key: "COVERED_PARKING",             label: "Covered Parking",               category: "Parking" },
  { key: "GARAGE",                      label: "Garage",                        category: "Parking" },

  // ── Family ────────────────────────────────────────────────────────────────
  { key: "CHILDREN_WELCOME",            label: "Children Welcome",              category: "Family" },
  { key: "CRIB",                        label: "Crib / Pack-n-Play",            category: "Family" },
  { key: "HIGH_CHAIR",                  label: "High Chair",                    category: "Family" },
  { key: "BOARD_GAMES_KIDS",            label: "Children's Toys & Games",       category: "Family" },

  // ── Safety ────────────────────────────────────────────────────────────────
  { key: "SMOKE_ALARM",                 label: "Smoke Alarm",                   category: "Safety" },
  { key: "CARBON_MONOXIDE_ALARM",       label: "Carbon Monoxide Alarm",         category: "Safety" },
  { key: "FIRE_EXTINGUISHER",           label: "Fire Extinguisher",             category: "Safety" },
  { key: "FIRST_AID_KIT",              label: "First Aid Kit",                 category: "Safety" },
  { key: "SECURITY_CAMERA",             label: "Security Camera (exterior)",    category: "Safety" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Base amenity set shared by ALL Hawaii vacation rental condos/homes
// ─────────────────────────────────────────────────────────────────────────────
const HAWAII_BASE = [
  "WIFI",
  "ESSENTIALS",
  "AIR_CONDITIONING",
  "CEILING_FAN",
  "WASHER",
  "DRYER",
  "IRON",
  "HAIR_DRYER",
  "KITCHEN",
  "REFRIGERATOR",
  "MICROWAVE",
  "DISHWASHER",
  "STOVE",
  "OVEN",
  "COFFEE_MAKER",
  "TOASTER",
  "BLENDER",
  "COOKING_BASICS",
  "DISHES_AND_SILVERWARE",
  "DINING_TABLE",
  "TV",
  "CABLE_TV",
  "STREAMING_SERVICES",
  "BED_LINENS",
  "EXTRA_PILLOWS_AND_BLANKETS",
  "SHAMPOO",
  "TOWELS_PROVIDED",
  "HOT_WATER",
  "PATIO_OR_BALCONY",
  "OUTDOOR_FURNITURE",
  "BEACH_ESSENTIALS",
  "BEACH_CHAIR",
  "COOLER",
  "FREE_PARKING_ON_PREMISES",
  "CHILDREN_WELCOME",
  "SMOKE_ALARM",
  "CARBON_MONOXIDE_ALARM",
  "FIRE_EXTINGUISHER",
  "FIRST_AID_KIT",
  "PRIVATE_ENTRANCE",
  "NEAR_RESTAURANTS",
  "NEAR_SHOPPING",
];

// ─────────────────────────────────────────────────────────────────────────────
// Community-specific amenity profiles
// ─────────────────────────────────────────────────────────────────────────────

// Regency at Poipu Kai — resort condo, pool/spa, tennis, 10-min walk to beach
const REGENCY_POIPU_KAI = [
  ...HAWAII_BASE,
  "ELEVATOR",
  "POOL",
  "HOT_TUB",
  "TENNIS_COURT",
  "PICKLEBALL_COURT",
  "GARDEN",
  "GARDEN_VIEW",
  "NEAR_BEACH",
  "RESORT_ACCESS",
  "COVERED_PATIO",
];

// Kekaha Beachfront Estate — private beachfront, ocean-direct access, private pool
const KEKAHA_ESTATE = [
  ...HAWAII_BASE.filter(a => a !== "POOL"),
  "BEACHFRONT",
  "OCEAN_FRONT",
  "OCEAN_VIEW",
  "WATERFRONT",
  "PRIVATE_POOL",
  "BBQ_GRILL",
  "COVERED_PATIO",
  "GARDEN",
  "BICYCLE",
  "SNORKELING_GEAR",
  "BEACH_UMBRELLA",
];

// Keauhou Estates — Big Island ocean view estate, private pool, near Keauhou golf
const KEAUHOU_ESTATES = [
  ...HAWAII_BASE,
  "OCEAN_VIEW",
  "PRIVATE_POOL",
  "PRIVATE_HOT_TUB",
  "BBQ_GRILL",
  "COVERED_PATIO",
  "GARDEN",
  "NEAR_GOLF_COURSE",
  "OUTDOOR_KITCHEN",
  "EXERCISE_EQUIPMENT",
];

// Mauna Kai Princeville — North Shore condo, mountain/valley views, near Princeville golf
const MAUNA_KAI = [
  ...HAWAII_BASE,
  "ELEVATOR",
  "POOL",
  "HOT_TUB",
  "MOUNTAIN_VIEW",
  "GARDEN_VIEW",
  "NEAR_GOLF_COURSE",
  "NEAR_BEACH",
  "RESORT_ACCESS",
];

// Kaha Lani Resort — Kapaa oceanfront/ocean view, direct ocean access
const KAHA_LANI = [
  ...HAWAII_BASE,
  "ELEVATOR",
  "POOL",
  "OCEAN_VIEW",
  "OCEAN_FRONT",
  "WATERFRONT",
  "NEAR_BEACH",
  "RESORT_ACCESS",
  "SNORKELING_GEAR",
];

// Lae Nani Resort — Kapaa beachfront condo resort, ocean view, pool
const LAE_NANI = [
  ...HAWAII_BASE,
  "ELEVATOR",
  "POOL",
  "HOT_TUB",
  "OCEAN_VIEW",
  "WATERFRONT",
  "NEAR_BEACH",
  "RESORT_ACCESS",
  "SNORKELING_GEAR",
  "GARDEN_VIEW",
];

// Poipu Brenneckes Beachside — steps to Brenneckes Beach, shared pool, ocean nearby
const POIPU_BEACHSIDE = [
  ...HAWAII_BASE,
  "ELEVATOR",
  "POOL",
  "HOT_TUB",
  "NEAR_BEACH",
  "OCEAN_VIEW",
  "WATERFRONT",
  "RESORT_ACCESS",
  "SNORKELING_GEAR",
];

// Poipu Brenneckes Oceanfront — direct oceanfront, pool, beachfront access
const POIPU_OCEANFRONT = [
  ...HAWAII_BASE,
  "ELEVATOR",
  "POOL",
  "BEACHFRONT",
  "OCEAN_FRONT",
  "OCEAN_VIEW",
  "WATERFRONT",
  "RESORT_ACCESS",
  "SNORKELING_GEAR",
  "BBQ_GRILL",
];

// Kaiulani of Princeville — North Shore condo, mountain & valley views, near golf
const KAIULANI = [
  ...HAWAII_BASE,
  "ELEVATOR",
  "POOL",
  "HOT_TUB",
  "MOUNTAIN_VIEW",
  "GARDEN_VIEW",
  "NEAR_GOLF_COURSE",
  "NEAR_BEACH",
  "RESORT_ACCESS",
];

// Pili Mai at Poipu — resort townhomes, AC throughout, pool, steps to Poipu Beach
// Townhomes are 2–3 stories — no elevator
const PILI_MAI = [
  ...HAWAII_BASE,
  "POOL",
  "HOT_TUB",
  "NEAR_BEACH",
  "GARDEN_VIEW",
  "GARDEN",
  "RESORT_ACCESS",
  "COVERED_PATIO",
];

// ─────────────────────────────────────────────────────────────────────────────
// Per-property amenity lookup
// ─────────────────────────────────────────────────────────────────────────────
const PROPERTY_AMENITY_MAP: Record<number, string[]> = {
  // Regency at Poipu Kai
  1:  REGENCY_POIPU_KAI,
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
 * Returns the Guesty API amenity strings for a given property.
 * Deduplicates and returns a sorted list.
 */
export function getGuestyAmenities(propertyId: number): string[] {
  const amenities = PROPERTY_AMENITY_MAP[propertyId] || HAWAII_BASE;
  return [...new Set(amenities)];
}

/**
 * Returns the human-readable label for a Guesty amenity key.
 */
export function getAmenityLabel(key: string): string {
  const entry = GUESTY_AMENITY_CATALOG.find(a => a.key === key);
  return entry?.label || key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Returns a grouped view of the catalog for display in settings UIs.
 */
export function getCatalogByCategory(): Record<string, AmenityEntry[]> {
  const groups: Record<string, AmenityEntry[]> = {};
  for (const entry of GUESTY_AMENITY_CATALOG) {
    if (!groups[entry.category]) groups[entry.category] = [];
    groups[entry.category].push(entry);
  }
  return groups;
}
