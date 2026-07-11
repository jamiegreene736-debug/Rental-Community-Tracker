// ─────────────────────────────────────────────────────────────────────────────
// Guesty Amenity System — SHARED catalog
//
// Moved here from client/src/data/guesty-amenities.ts (2026-07-09) so the SERVER
// (photo-driven amenity scan + the bulk-combo-listing job) and the CLIENT share
// ONE source of truth for the amenity catalog + the standard Hawaii baseline.
// The client file (`@/data/guesty-amenities`) re-exports everything here and
// keeps the client-only per-property profile map.
//
// All `key` strings are the app's stable amenity identifiers. The server's
// push-amenities route translates them to Guesty's canonical names at push time
// (norm() + aliasMap), so these keys are safe to send straight to Guesty.
// ─────────────────────────────────────────────────────────────────────────────

export type AmenityEntry = {
  key: string;        // Stable amenity identifier (sent to the push route)
  label: string;      // Human-readable label (shown in UI)
  category: string;   // Display category
};

export const GUESTY_AMENITY_CATALOG: AmenityEntry[] = [
  // ── Essentials ────────────────────────────────────────────────────────────
  { key: "WIFI",                        label: "WiFi",                          category: "Essentials" },
  { key: "WIRELESS_INTERNET",           label: "Wireless Internet",             category: "Essentials" },
  { key: "INTERNET",                    label: "Internet (Ethernet)",           category: "Essentials" },
  { key: "ESSENTIALS",                  label: "Essentials (towels, soap, TP)", category: "Essentials" },
  { key: "HANGERS",                     label: "Hangers",                       category: "Essentials" },
  { key: "AIR_CONDITIONING",            label: "Air Conditioning",              category: "Essentials" },
  { key: "HEATING",                     label: "Heating",                       category: "Essentials" },
  { key: "CEILING_FAN",                 label: "Ceiling Fans",                  category: "Essentials" },
  { key: "WASHER",                      label: "Washer",                        category: "Essentials" },
  { key: "DRYER",                       label: "Dryer",                         category: "Essentials" },
  { key: "IRON",                        label: "Iron & Ironing Board",          category: "Essentials" },
  { key: "HAIR_DRYER",                  label: "Hair Dryer",                    category: "Essentials" },
  { key: "DEDICATED_WORKSPACE",         label: "Laptop-Friendly Workspace",     category: "Essentials" },
  { key: "LONG_TERM_STAYS_ALLOWED",     label: "Long-Term Stays Allowed",       category: "Essentials" },
  { key: "ELEVATOR",                    label: "Elevator Access",               category: "Essentials" },
  { key: "LUGGAGE_DROPOFF",             label: "Luggage Drop-off",              category: "Essentials" },
  { key: "KEYPAD",                      label: "Keyless Entry",                 category: "Essentials" },
  { key: "PRIVATE_ENTRANCE",            label: "Private Entrance",              category: "Essentials" },

  // ── Kitchen ───────────────────────────────────────────────────────────────
  { key: "KITCHEN",                     label: "Full Kitchen",                  category: "Kitchen" },
  { key: "REFRIGERATOR",                label: "Refrigerator",                  category: "Kitchen" },
  { key: "FREEZER",                     label: "Freezer",                       category: "Kitchen" },
  { key: "ICE_MAKER",                   label: "Ice Maker",                     category: "Kitchen" },
  { key: "MICROWAVE",                   label: "Microwave",                     category: "Kitchen" },
  { key: "DISHWASHER",                  label: "Dishwasher",                    category: "Kitchen" },
  { key: "STOVE",                       label: "Stove",                         category: "Kitchen" },
  { key: "OVEN",                        label: "Oven",                          category: "Kitchen" },
  { key: "COFFEE_MAKER",                label: "Coffee Maker",                  category: "Kitchen" },
  { key: "KETTLE",                      label: "Electric Kettle",               category: "Kitchen" },
  { key: "TOASTER",                     label: "Toaster",                       category: "Kitchen" },
  { key: "BLENDER",                     label: "Blender",                       category: "Kitchen" },
  { key: "COOKING_BASICS",              label: "Cookware & Utensils",           category: "Kitchen" },
  { key: "BAKING_SHEET",                label: "Baking Sheet",                  category: "Kitchen" },
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
  { key: "CLOTHING_STORAGE",            label: "Clothing Storage (closet/wardrobe)", category: "Bedrooms" },
  { key: "BLACKOUT_SHADES",             label: "Blackout Curtains",             category: "Bedrooms" },
  { key: "LOCK_ON_BEDROOM_DOOR",        label: "Lock on Bedroom Door",          category: "Bedrooms" },

  // ── Bathroom ──────────────────────────────────────────────────────────────
  { key: "SHAMPOO",                     label: "Shampoo & Toiletries",          category: "Bathroom" },
  { key: "BODY_SOAP",                   label: "Body Soap",                     category: "Bathroom" },
  { key: "BATHTUB",                     label: "Bathtub",                       category: "Bathroom" },
  { key: "JETTED_TUB",                  label: "Jetted / Soaking Tub",          category: "Bathroom" },
  { key: "WALK_IN_SHOWER",              label: "Walk-in Shower",                category: "Bathroom" },
  { key: "HOT_WATER",                   label: "Hot Water",                     category: "Bathroom" },
  { key: "TOWELS_PROVIDED",             label: "Bath Towels Provided",          category: "Bathroom" },

  // ── Pool & Water ──────────────────────────────────────────────────────────
  { key: "POOL",                        label: "Swimming Pool (Shared)",        category: "Pool & Water" },
  { key: "OUTDOOR_POOL",                label: "Outdoor Pool",                  category: "Pool & Water" },
  { key: "COMMUNAL_POOL",               label: "Communal Pool",                 category: "Pool & Water" },
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
  { key: "OUTDOOR_SEATING",             label: "Outdoor Seating / Dining",      category: "Outdoor" },
  { key: "OUTDOOR_KITCHEN",             label: "Outdoor Kitchen",               category: "Outdoor" },
  { key: "GARDEN",                      label: "Garden / Yard",                 category: "Outdoor" },
  { key: "PICKLEBALL_COURT",            label: "Pickleball Court",              category: "Outdoor" },
  { key: "EXERCISE_EQUIPMENT",          label: "Exercise Equipment",            category: "Outdoor" },
  { key: "BICYCLE",                     label: "Bicycle",                       category: "Outdoor" },
  { key: "KAYAK",                       label: "Kayak",                         category: "Outdoor" },
  { key: "BOAT",                        label: "Boat / Canoe",                  category: "Outdoor" },

  // ── Activities (Nearby) ───────────────────────────────────────────────────
  { key: "CYCLING",                     label: "Cycling / Bike Path Nearby",    category: "Activities" },
  { key: "FISHING",                     label: "Fishing Nearby",                category: "Activities" },
  { key: "HIKING",                      label: "Hiking Trails Nearby",          category: "Activities" },
  { key: "GOLF",                        label: "Golf Nearby",                   category: "Activities" },
  { key: "SHOPPING",                    label: "Shopping Nearby",               category: "Activities" },
  { key: "WATER_PARK",                  label: "Water Park Nearby",             category: "Activities" },
  { key: "THEME_PARK",                  label: "Theme Park Nearby",             category: "Activities" },

  // ── Beach & Water Access ──────────────────────────────────────────────────
  { key: "BEACH_ESSENTIALS",            label: "Beach Essentials (gear/towels)",category: "Beach" },
  { key: "BEACH_UMBRELLA",              label: "Beach Umbrella",                category: "Beach" },

  // ── Location & Views ──────────────────────────────────────────────────────
  { key: "BEACHFRONT",                  label: "Beachfront (on the beach)",     category: "Location & Views" },
  { key: "OCEAN_FRONT",                 label: "Oceanfront (direct ocean access)",category: "Location & Views" },
  { key: "OCEAN_VIEW",                  label: "Ocean View",                    category: "Location & Views" },
  { key: "WATERFRONT",                  label: "Waterfront",                    category: "Location & Views" },
  { key: "LAKE_FRONT",                  label: "Lakefront",                     category: "Location & Views" },
  { key: "NEAR_BEACH",                  label: "Near Beach (walking distance)", category: "Location & Views" },
  { key: "BEACH_VIEW",                  label: "Beach View",                    category: "Location & Views" },
  { key: "BEACH_ACCESS",                label: "Beach Access (direct)",         category: "Location & Views" },
  { key: "SEA_VIEW",                    label: "Sea View",                      category: "Location & Views" },
  { key: "WATER_VIEW",                  label: "Water View",                    category: "Location & Views" },
  { key: "MOUNTAIN_VIEW",               label: "Mountain / Valley View",        category: "Location & Views" },
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
  { key: "EV_CHARGER",                  label: "EV Charger",                    category: "Parking" },

  // ── Wellness ──────────────────────────────────────────────────────────────
  { key: "GYM",                         label: "Fitness Center / Gym",          category: "Wellness" },
  { key: "SPA",                         label: "Spa Services",                  category: "Wellness" },

  // ── Family ────────────────────────────────────────────────────────────────
  { key: "CHILDREN_WELCOME",            label: "Children Welcome",              category: "Family" },
  { key: "CRIB",                        label: "Crib / Pack-n-Play",            category: "Family" },
  { key: "HIGH_CHAIR",                  label: "High Chair",                    category: "Family" },
  { key: "BOARD_GAMES_KIDS",            label: "Children's Toys & Games",       category: "Family" },

  // ── Safety ────────────────────────────────────────────────────────────────
  { key: "SMOKE_ALARM",                        label: "Smoke Detector",                    category: "Safety" },
  { key: "CARBON_MONOXIDE_ALARM",              label: "Carbon Monoxide Alarm",             category: "Safety" },
  { key: "FIRE_EXTINGUISHER",                  label: "Fire Extinguisher",                 category: "Safety" },
  { key: "FIRST_AID_KIT",                      label: "First Aid Kit",                     category: "Safety" },
  { key: "SECURITY_CAMERA",                    label: "Security Camera (exterior)",        category: "Safety" },
  { key: "HIGH_TOUCH_SURFACES_DISINFECTED",    label: "High-Touch Surfaces Disinfected",   category: "Safety" },
];

/** Every valid catalog key, for O(1) validation of scanned/persisted keys. */
export const AMENITY_CATALOG_KEYS: Set<string> = new Set(
  GUESTY_AMENITY_CATALOG.map((a) => a.key),
);

// ─────────────────────────────────────────────────────────────────────────────
// Base amenity set shared by ALL Hawaii vacation rental condos/homes.
// This is the "fill out where available" standard baseline — the things every
// managed unit has that photos usually can't prove (WiFi, kitchen, essentials).
// The photo scan UNIONS this baseline with what it visually detects.
// ─────────────────────────────────────────────────────────────────────────────
export const HAWAII_BASE_AMENITY_KEYS: string[] = [
  // Essentials
  "WIFI",
  "WIRELESS_INTERNET",   // Guesty/Airbnb "Wireless Internet" — distinct from WIFI in some OTA mappings
  "INTERNET",            // Guesty/Airbnb "Internet" (general/ethernet)
  "ESSENTIALS",
  "HANGERS",
  "AIR_CONDITIONING",    // Not every Hawaii unit has A/C — deselect in the builder if needed
  "CEILING_FAN",
  "WASHER",
  "DRYER",
  "IRON",
  "HAIR_DRYER",
  "DEDICATED_WORKSPACE",
  "LONG_TERM_STAYS_ALLOWED",
  "KEYPAD",              // Keyless entry — standard for all managed units
  "PRIVATE_ENTRANCE",
  // Kitchen
  "KITCHEN",
  "REFRIGERATOR",
  "FREEZER",
  "ICE_MAKER",
  "MICROWAVE",
  "DISHWASHER",
  "STOVE",
  "OVEN",
  "COFFEE_MAKER",
  "KETTLE",
  "TOASTER",
  "BLENDER",
  "COOKING_BASICS",
  "BAKING_SHEET",
  "DISHES_AND_SILVERWARE",
  "DINING_TABLE",
  "WINE_GLASSES",
  // Entertainment
  "TV",
  "CABLE_TV",
  "STREAMING_SERVICES",
  // Bedrooms
  "BED_LINENS",
  "EXTRA_PILLOWS_AND_BLANKETS",
  "CLOTHING_STORAGE",    // Guesty/Airbnb "Clothing storage" (closet/wardrobe)
  // Bathroom
  "SHAMPOO",
  "BODY_SOAP",           // Body soap provided in all units
  "TOWELS_PROVIDED",
  "HOT_WATER",
  "BATHTUB",
  // Outdoor
  "PATIO_OR_BALCONY",
  "COVERED_PATIO",       // All units have a covered lanai/patio
  "OUTDOOR_FURNITURE",
  // Beach
  "BEACH_ESSENTIALS",
  // Parking
  "FREE_PARKING_ON_PREMISES",
  // Family
  "CHILDREN_WELCOME",
  // Safety
  "SMOKE_ALARM",
  "CARBON_MONOXIDE_ALARM",
  "FIRE_EXTINGUISHER",
  "FIRST_AID_KIT",
  "HIGH_TOUCH_SURFACES_DISINFECTED",
];

/**
 * Returns the human-readable label for an amenity key.
 */
export function getAmenityLabel(key: string): string {
  const entry = GUESTY_AMENITY_CATALOG.find((a) => a.key === key);
  return entry?.label || key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// Guesty push-name aliases — SINGLE SOURCE OF TRUTH (2026-07-10).
//
// Guesty's /properties-api/amenities/supported list (187 fixed names) has no
// entry whose normalized form matches these catalog keys/labels, so a plain
// norm() lookup fails and the push rejects them ("Guesty didn't recognise N
// amenities"). Every value below is the EXACT Guesty canonical display name,
// verified against the live supported list on 2026-07-10 (see
// tests/amenity-scan-logic.test.ts, which locks each value against a snapshot
// of that list). Both the server push route (push-amenities aliasMap) and the
// client key→Guesty-name mapper consume THIS table — never grow a private
// alias list on either side again; the two had drifted (e.g. an alias keyed
// COVERED_LANAI_PATIO while the catalog key is COVERED_PATIO), which is what
// caused the 13-reject push on 2026-07-10.
//
// Mapping posture: an alias may GENERALIZE (LAP_POOL → "Swimming pool",
// PICKLEBALL_COURT → "Tennis court") because the claim stays true; it must
// never STRENGTHEN a claim (NEAR_GOLF_COURSE maps to "Golf - Optional", not
// "Golf course front"). Keys with no true Guesty equivalent belong in
// GUESTY_UNSUPPORTED_AMENITY_KEYS below instead.
// ─────────────────────────────────────────────────────────────────────────────
export const GUESTY_PUSH_NAME_ALIASES: Record<string, string> = {
  // Essentials
  WIFI: "Wireless Internet",
  LUGGAGE_DROPOFF: "Luggage dropoff allowed",
  DEDICATED_WORKSPACE: "Laptop friendly workspace", // raw-key pushes (scan auto-push) need this; the label already matches
  // Kitchen
  COOKING_BASICS: "Cookware",
  // Bedrooms
  BLACKOUT_SHADES: "Room-darkening shades",
  // Bathroom
  JETTED_TUB: "Bathtub",
  // Pool & Water
  POOL: "Outdoor pool",            // Hawaii default (operator-confirmed alias)
  PRIVATE_HOT_TUB: "Hot tub",
  LAP_POOL: "Swimming pool",
  WADING_POOL: "Swimming pool",
  // Outdoor
  COVERED_PATIO: "Patio or balcony",
  OUTDOOR_SEATING: "Outdoor seating (furniture)",
  OUTDOOR_FURNITURE: "Outdoor seating (furniture)",
  GARDEN: "Garden or backyard",
  PICKLEBALL_COURT: "Tennis court", // vision hint covers "pickleball OR tennis court"
  EXERCISE_EQUIPMENT: "Gym",
  BICYCLE: "Bicycles available",
  BEACH_UMBRELLA: "Beach essentials",
  // Activities (nearby)
  GOLF: "Golf - Optional",
  NEAR_GOLF_COURSE: "Golf - Optional",
  WATER_PARK: "Water Parks",        // Guesty's name is plural
  THEME_PARK: "Theme Parks",        // Guesty's name is plural
  NEAR_SHOPPING: "Shopping",
  // Location & Views
  NEAR_BEACH: "Beach",
  BEACHFRONT: "Beach Front",
  OCEAN_VIEW: "Sea view",
  // Family
  CHILDREN_WELCOME: "Family/kid friendly",
  BOARD_GAMES_KIDS: "Children’s books and toys",
  // Safety
  SMOKE_ALARM: "Smoke detector",
  CARBON_MONOXIDE_ALARM: "Carbon monoxide detector",
};

// Catalog keys with NO Guesty-supported equivalent (checked against the full
// 187-name list — nothing close enough to claim truthfully). They stay
// selectable and persist in-system; a Guesty push cannot deliver them as
// CANONICAL amenities. Since 2026-07-11 the push route additionally attempts
// Guesty's free-text "Other amenities" bucket for them (undocumented as a PUT
// input — the docs only list `otherAmenities` on responses — so delivery is
// proven per-name via read-back, never assumed). Delivered names render as
// "delivered to Other amenities"; the rest as "no Guesty equivalent".
export const GUESTY_UNSUPPORTED_AMENITY_KEYS: Set<string> = new Set([
  "KEYPAD",               // no keyless-entry / smart-lock amenity in Guesty
  "SPICES",
  "STREAMING_SERVICES",
  "LOCK_ON_BEDROOM_DOOR",
  "WALK_IN_SHOWER",       // Guesty only has accessibility shower variants
  "BOAT",
  "HIKING",
  "POOL_VIEW",
  "NEAR_RESTAURANTS",
  "COVERED_PARKING",      // covered/carport ≠ "Garage"; don't overclaim
  "SECURITY_CAMERA",
]);

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

// ─────────────────────────────────────────────────────────────────────────────
// Vision-detectable amenities.
//
// The photo scan is ADD-ONLY: it only turns amenities ON, never off (Jamie's
// choice, 2026-07-09) — "not visible in a photo" almost never proves absence
// (WiFi/heating are never photographable). So we only need PRESENCE detection,
// and only for amenities a camera can actually reveal. This curated list keeps
// the vision model focused on visually-meaningful features (pools, views,
// balconies, appliances, resort amenities) and out of non-visual noise. Each
// `hint` is fed to the model verbatim so it uses our exact keys.
//
// Community amenities (pool/gym/tennis/BBQ/grounds views) count when shown in a
// community-folder photo; unit amenities count when shown in unit-folder photos.
// ─────────────────────────────────────────────────────────────────────────────
export type AmenityVisionTarget = { key: string; hint: string };

export const AMENITY_VISION_TARGETS: AmenityVisionTarget[] = [
  // Pool & Water
  { key: "POOL",            hint: "a shared / resort swimming pool" },
  { key: "OUTDOOR_POOL",    hint: "an outdoor swimming pool (open to the sky)" },
  { key: "COMMUNAL_POOL",   hint: "a large communal/resort pool serving the whole complex" },
  { key: "PRIVATE_POOL",    hint: "a private pool attached to THIS unit/home only (not a shared resort pool)" },
  { key: "HOT_TUB",         hint: "a hot tub / jacuzzi / spa (shared)" },
  { key: "PRIVATE_HOT_TUB", hint: "a private hot tub on THIS unit's own lanai/yard" },
  { key: "LAP_POOL",        hint: "a long narrow lap pool for swimming laps" },
  { key: "INDOOR_POOL",     hint: "an indoor (enclosed) swimming pool" },
  // Outdoor
  { key: "PATIO_OR_BALCONY", hint: "a lanai, balcony, or patio off the unit" },
  { key: "COVERED_PATIO",    hint: "a covered/roofed lanai or patio" },
  { key: "BBQ_GRILL",        hint: "a BBQ or grill" },
  { key: "FIRE_PIT",         hint: "an outdoor fire pit" },
  { key: "OUTDOOR_FURNITURE",hint: "outdoor furniture (lanai/patio chairs, table, loungers)" },
  { key: "OUTDOOR_SEATING",  hint: "an outdoor seating or dining area" },
  { key: "OUTDOOR_KITCHEN",  hint: "an outdoor kitchen / built-in outdoor cooking area" },
  { key: "GARDEN",           hint: "a landscaped garden, lawn, or private yard" },
  { key: "PICKLEBALL_COURT", hint: "a pickleball or tennis court" },
  { key: "EXERCISE_EQUIPMENT", hint: "outdoor exercise equipment" },
  // Kitchen appliances (unit interiors)
  { key: "KITCHEN",       hint: "a full equipped kitchen" },
  { key: "REFRIGERATOR",  hint: "a refrigerator" },
  { key: "FREEZER",       hint: "a freezer / freezer compartment" },
  { key: "ICE_MAKER",     hint: "an ice maker (in-fridge dispenser or standalone)" },
  { key: "MICROWAVE",     hint: "a microwave oven" },
  { key: "DISHWASHER",    hint: "a built-in dishwasher" },
  { key: "STOVE",         hint: "a stovetop / cooktop" },
  { key: "OVEN",          hint: "an oven" },
  { key: "COFFEE_MAKER",  hint: "a coffee maker / espresso machine" },
  { key: "KETTLE",        hint: "an electric kettle" },
  { key: "TOASTER",       hint: "a toaster or toaster oven" },
  { key: "BLENDER",       hint: "a blender" },
  { key: "DINING_TABLE",  hint: "an indoor dining table with seating" },
  { key: "WINE_GLASSES",  hint: "wine glasses / stemware" },
  // Entertainment
  { key: "TV",            hint: "a flat-screen / smart TV" },
  { key: "SOUND_SYSTEM",  hint: "a sound system / speakers / stereo" },
  { key: "GAME_ROOM",     hint: "a dedicated game room" },
  { key: "PING_PONG_TABLE", hint: "a ping pong table" },
  { key: "POOL_TABLE",    hint: "a pool / billiards table" },
  { key: "BOARD_GAMES",   hint: "board games or a stocked games shelf" },
  // Bathroom
  { key: "BATHTUB",       hint: "a bathtub" },
  { key: "JETTED_TUB",    hint: "a jetted / soaking tub" },
  { key: "WALK_IN_SHOWER",hint: "a walk-in (glass-door, no-tub) shower" },
  // Bedrooms
  { key: "CLOTHING_STORAGE", hint: "a closet, wardrobe, or dresser for clothing storage" },
  { key: "BLACKOUT_SHADES",  hint: "blackout curtains / room-darkening shades" },
  // Essentials / appliances visible in interiors
  { key: "AIR_CONDITIONING", hint: "an A/C unit — wall/window unit, split-system head, or clearly labeled thermostat" },
  { key: "CEILING_FAN",      hint: "a ceiling fan" },
  { key: "WASHER",           hint: "a clothes washer" },
  { key: "DRYER",            hint: "a clothes dryer" },
  { key: "ELEVATOR",         hint: "a building elevator" },
  { key: "DEDICATED_WORKSPACE", hint: "a desk / dedicated laptop workspace" },
  // Views & location (from the windows/lanai in the photos)
  { key: "OCEAN_VIEW",    hint: "an ocean view from the unit or grounds" },
  { key: "SEA_VIEW",      hint: "a sea/ocean view (use if OCEAN_VIEW already applies too)" },
  { key: "BEACHFRONT",    hint: "the unit/building sits directly ON the beach (sand meets the property)" },
  { key: "OCEAN_FRONT",   hint: "the unit/building sits directly on the oceanfront with direct water access" },
  { key: "WATERFRONT",    hint: "the property fronts water (ocean, lagoon, canal)" },
  { key: "BEACH_VIEW",    hint: "a view of a beach" },
  { key: "WATER_VIEW",    hint: "a view of water (ocean, lagoon, pond)" },
  { key: "MOUNTAIN_VIEW", hint: "a mountain / valley view" },
  { key: "GARDEN_VIEW",   hint: "a garden / tropical-landscaping view" },
  { key: "POOL_VIEW",     hint: "the unit looks out onto the pool" },
  { key: "GOLF_VIEW",     hint: "a golf-course view" },
  // Parking
  { key: "FREE_PARKING_ON_PREMISES", hint: "an on-site parking lot / stall" },
  { key: "COVERED_PARKING", hint: "covered / carport parking" },
  { key: "GARAGE",        hint: "a private garage" },
  { key: "EV_CHARGER",    hint: "an EV charging station" },
  // Wellness / resort
  { key: "GYM",           hint: "a fitness center / gym with exercise machines" },
  { key: "SPA",           hint: "an on-site spa / spa treatment room" },
  // Family
  { key: "CRIB",          hint: "a crib / pack-n-play" },
  { key: "HIGH_CHAIR",    hint: "a baby high chair" },
  // Beach
  { key: "BEACH_UMBRELLA", hint: "beach umbrellas provided" },
  { key: "BEACH_ESSENTIALS", hint: "beach gear provided (chairs, cooler, snorkel, boogie boards, sand toys)" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Location-research amenities (SURROUNDING-AREA, not photo-visible).
//
// "Shopping Nearby" / "Golf Nearby" / "Near Restaurants" can NEVER be proven by
// a photo, so they are deliberately absent from AMENITY_VISION_TARGETS — which
// is why the photo scan never checked them. This curated list is researched by
// a separate Claude WEB-SEARCH leg (server/amenity-location-research.ts) that
// looks up the community's actual surroundings and only confirms an amenity
// when it can name a real place within the hint's distance. Same ADD-ONLY
// posture as the vision scan. Keys are DISJOINT from AMENITY_VISION_TARGETS
// (views/beachfront claims stay vision-proven; "nearby" claims are researched).
// ─────────────────────────────────────────────────────────────────────────────
export const AMENITY_LOCATION_TARGETS: AmenityVisionTarget[] = [
  // Beach proximity (walking distance / access — not "on the sand", which is vision's BEACHFRONT)
  { key: "NEAR_BEACH",       hint: "a public beach within comfortable walking distance (~1 mile / 15-minute walk)" },
  { key: "BEACH_ACCESS",     hint: "the community/resort has direct beach access (path or entrance onto a beach)" },
  // Shopping & dining
  { key: "SHOPPING",         hint: "shops, a shopping village/center, or a supermarket within ~3 miles" },
  { key: "NEAR_SHOPPING",    hint: "shopping within ~2 miles (walkable or a very short drive)" },
  { key: "NEAR_RESTAURANTS", hint: "restaurants or cafes within ~2 miles" },
  // Activities
  { key: "GOLF",             hint: "a golf course within ~5 miles" },
  { key: "NEAR_GOLF_COURSE", hint: "a golf course directly adjacent or within ~2 miles" },
  { key: "HIKING",           hint: "hiking trails or a trailhead within ~10 miles" },
  { key: "FISHING",          hint: "shore/pier fishing or fishing charters within ~5 miles" },
  { key: "CYCLING",          hint: "a bike path, bike-friendly road network, or bike rentals nearby (~3 miles)" },
  { key: "WATER_PARK",       hint: "a water park within ~15 miles" },
  { key: "THEME_PARK",       hint: "a theme/amusement park within ~15 miles" },
  // Community type
  { key: "RESORT_ACCESS",    hint: "the property is part of a resort community whose shared amenities guests can use" },
];
