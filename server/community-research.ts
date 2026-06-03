// Community research helper — pulled out of routes.ts so both the single-city
// endpoint (/api/community/research) and the multi-city scanner
// (/api/community/scan-top-markets) can reuse the same Google + Claude pipeline.

import { checkCommunityType } from "@shared/community-type";
import { geocode } from "./walking-distance";

export type ResearchedCommunity = {
  name: string;
  city: string;
  state: string;
  estimatedLowRate: number | null;
  estimatedHighRate: number | null;
  unitTypes: string;
  confidenceScore: number;
  researchSummary: string;
  sourceUrl: string;
  bedroomMix?: string;
  combinedBedroomsTypical?: number;
  combinabilityScore?: number;
  fromWorldKnowledge?: boolean;
  /** Populated by the research endpoint (not the pure research fn) to flag
   *  resorts where the operator already has at least one draft/listing in
   *  community_drafts for the same name+city. UI renders a ✓ badge. */
  hasExistingListing?: boolean;
  // CODEX NOTE (2026-05-04, claude/single-listing-bedroom-list):
  // Single-mode research returns the actual bedroom counts a
  // community offers (e.g. Santa Maria Resort = [2, 3]) so the
  // single-listing wizard can render only valid bedroom buttons.
  // Combo mode also uses it as display context on research cards.
  // Empty array means "Claude doesn't know" — wizard falls back to
  // common condo sizes plus the Any escape hatch.
  availableBedrooms?: number[];
  // CODEX NOTE (2026-05-05, claude/biggest-resorts-first):
  // Single-mode research returns Claude's rough estimate of the
  // resort's total unit count (e.g. Reunion ~2000, Santa Maria
  // ~75). Wizard sorts by this descending and slices to the top
  // 10 biggest. Combo mode shows it as resort-size context. 0 means
  // Claude doesn't know.
  estimatedTotalUnits?: number;
  // Optional rough per-bedroom inventory, keyed by bedroom count:
  // {"2": 45, "3": 30}. This is display-only context for cards.
  estimatedBedroomUnitCounts?: Record<string, number>;
  // Community-wide minimum-night rule from published resort/HOA/PM
  // evidence. Null/undefined means unknown; 0 means a reliable
  // source says no published community minimum; positive means a
  // likely minimum imposed at the community level.
  minimumStayNights?: number | null;
  minimumStayEvidence?: string;
  minimumStaySourceUrl?: string;
  addressHint?: string;
};

type KnownSingleListingCommunityFact = {
  city: RegExp;
  state: RegExp;
  aliases: RegExp[];
  canonicalName: string;
  availableBedrooms: number[];
  estimatedTotalUnits: number;
};

type KnownSingleListingCommunitySeed = {
  city: RegExp;
  state: RegExp;
  name: string;
  availableBedrooms: number[];
  estimatedTotalUnits: number;
  unitTypes: string;
  researchSummary: string;
  sourceUrl?: string;
};

type KnownComboCommunitySeed = {
  city: RegExp;
  state: RegExp;
  name: string;
  unitTypes: string;
  bedroomMix: string;
  availableBedrooms?: number[];
  estimatedTotalUnits?: number;
  estimatedBedroomUnitCounts?: Record<string, number>;
  combinedBedroomsTypical: number;
  confidenceScore: number;
  combinabilityScore: number;
  researchSummary: string;
  sourceUrl: string;
};

const COMMUNITY_RESEARCH_SEARCH_TIMEOUT_MS = 6_000;
const COMMUNITY_RESEARCH_CLAUDE_TIMEOUT_MS = 35_000;
const COMMUNITY_RESEARCH_RATE_TIMEOUT_MS = 5_000;
const COMMUNITY_RESEARCH_RATE_SPOT_CHECK_LIMIT = {
  combo: 2,
  single: 4,
} as const;

// CODEX NOTE (2026-05-05, codex/single-listing-known-facts):
// The single-listing wizard depends on Claude's resort research
// for the card name, bedroom buttons, and rough resort unit count.
// That works well most of the time, but a misspelled resort name
// breaks the downstream community-anchored Zillow/Realtor search.
// Keep tiny, operator-validated corrections here instead of trying
// to repair names in the browser. Add only facts we are comfortable
// treating as stable.
const KNOWN_SINGLE_LISTING_COMMUNITY_FACTS: KnownSingleListingCommunityFact[] = [
  {
    city: /^fort myers beach$/i,
    state: /^(fl|florida)$/i,
    aliases: [/^santia maria resort$/i, /^santa maria resort$/i],
    canonicalName: "Santa Maria Resort",
    availableBedrooms: [2, 3],
    estimatedTotalUnits: 75,
  },
];

// Deterministic market seeds for single-listing city research. These do
// not replace SearchAPI/Claude; they make sure operator-known resort
// markets still produce useful choices when an upstream model call,
// organic search, or rate spot-check comes back empty. Keep this list
// intentionally small and market-specific so it stays trustworthy.
const KNOWN_SINGLE_LISTING_COMMUNITY_SEEDS: KnownSingleListingCommunitySeed[] = [
  {
    city: /^fort myers beach$/i,
    state: /^(fl|florida)$/i,
    name: "Estero Beach & Tennis Club",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 280,
    unitTypes: "Individually owned beachfront condominium resort",
    researchSummary: "Large Fort Myers Beach condo community with individually owned units and active vacation-rental inventory.",
  },
  {
    city: /^fort myers beach$/i,
    state: /^(fl|florida)$/i,
    name: "Pointe Estero Resort",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 100,
    unitTypes: "Individually owned beachfront condominium resort",
    researchSummary: "Recognizable Gulf-front condo resort with standalone vacation-rental units.",
  },
  {
    city: /^fort myers beach$/i,
    state: /^(fl|florida)$/i,
    name: "Diamond Head Beach Resort",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 120,
    unitTypes: "Condominium resort with individually owned units",
    researchSummary: "Known Fort Myers Beach condo resort; included as a single-listing candidate for unit-level onboarding.",
  },
  {
    city: /^fort myers beach$/i,
    state: /^(fl|florida)$/i,
    name: "Santa Maria Resort",
    availableBedrooms: [2, 3],
    estimatedTotalUnits: 75,
    unitTypes: "Individually owned condominium resort",
    researchSummary: "Operator-validated Fort Myers Beach condo resort with 2BR and 3BR vacation-rental units.",
  },
  {
    city: /^fort myers beach$/i,
    state: /^(fl|florida)$/i,
    name: "Sandcastle Beach Club",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 50,
    unitTypes: "Beachfront condominium resort",
    researchSummary: "Fort Myers Beach beachfront condo community suitable for standalone unit research.",
  },
  {
    city: /^fort myers beach$/i,
    state: /^(fl|florida)$/i,
    name: "Casa Playa Beach Resort",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 35,
    unitTypes: "Beachfront condominium resort",
    researchSummary: "Smaller Fort Myers Beach condo resort with individually rented units.",
  },
  {
    city: /^fort myers beach$/i,
    state: /^(fl|florida)$/i,
    name: "Sea Castle Condominiums",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 35,
    unitTypes: "Condominium community",
    researchSummary: "Fort Myers Beach condo community included as a fallback candidate for single-listing onboarding.",
  },
  {
    city: /^fort myers beach$/i,
    state: /^(fl|florida)$/i,
    name: "Mariner's Boathouse & Beach Resort",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 40,
    unitTypes: "Condominium resort",
    researchSummary: "Fort Myers Beach resort-style condo property with vacation-rental relevance.",
  },
  {
    city: /^fort myers beach$/i,
    state: /^(fl|florida)$/i,
    name: "Surf & Sun Beach Resort",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 30,
    unitTypes: "Beachfront condominium resort",
    researchSummary: "Fort Myers Beach beachfront condo resort candidate for standalone listing research.",
  },
  {
    city: /^fort myers beach$/i,
    state: /^(fl|florida)$/i,
    name: "The Sunset Beach Club",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 25,
    unitTypes: "Condominium resort",
    researchSummary: "Known Fort Myers Beach condo resort candidate for the single-listing flow.",
  },
];

const SOUTH_BIG_ISLAND_CITY_PATTERN = /^(waiohinu|wai[ʻ'’]?ohinu|naalehu|na[ʻ'’]?alehu|punaluu|punalu[ʻ'’]?u|pahala|hilea|ninole|kipuka nahuaopala)$/i;
const KAUAI_NORTH_CITY_PATTERN = /^(princeville|hanalei|wainiha|haena|kilauea)$/i;
const KAUAI_EAST_CITY_PATTERN = /^(kapaa|kapa[ʻ'’]?a|wailua|waipouli|lihue|nawiliwili|puhi)$/i;
const MAUI_WAILEA_CITY_PATTERN = /^(wailea|makena)$/i;
const MAUI_MAALAEA_CITY_PATTERN = /^maalaea$/i;
const MAUI_WEST_CITY_PATTERN = /^(lahaina|kaanapali|ka[ʻ'’]?anapali|kapalua|napili-honokowai|napili|kahana|honokowai)$/i;
const BIG_ISLAND_RESORT_CITY_PATTERN = /^(waikoloa|kohala coast|mauna lani|mauna kea|puako|kamuela)$/i;
const OAHU_WAIKIKI_CITY_PATTERN = /^(honolulu|waikiki)$/i;
const OAHU_WEST_CITY_PATTERN = /^(kapolei|ko olina|ewa beach|ewa)$/i;
const OAHU_NORTH_CITY_PATTERN = /^(kahuku|turtle bay|laie|haleiwa)$/i;
const OAHU_LEEWARD_CITY_PATTERN = /^(waianae|makaha)$/i;

const KNOWN_COMBO_COMMUNITY_SEEDS: KnownComboCommunitySeed[] = [
  {
    city: /^(kailua-kona|kona|keauhou|kahaluu-keauhou|holualoa)$/i,
    state: /^(hi|hawaii)$/i,
    name: "Na Hale O Keauhou",
    unitTypes: "townhomes",
    bedroomMix: "2BR and 3BR townhomes",
    combinedBedroomsTypical: 5,
    confidenceScore: 84,
    combinabilityScore: 72,
    sourceUrl: "https://www.alohacondos.com/bigisland/na-hale-o-keauhou",
    researchSummary: "Keauhou townhome community with recurring 2BR/3BR vacation-rental inventory suitable for bundling nearby units.",
  },
  {
    city: /^(kailua-kona|kona|keauhou|kahaluu-keauhou|holualoa)$/i,
    state: /^(hi|hawaii)$/i,
    name: "Alii Cove",
    unitTypes: "condos and townhomes",
    bedroomMix: "2BR and 3BR condos/townhomes",
    combinedBedroomsTypical: 5,
    confidenceScore: 80,
    combinabilityScore: 68,
    sourceUrl: "https://www.hawaiigaga.com/big-island/condos/alii-cove.aspx",
    researchSummary: "Gated Kailua-Kona condo/townhome community with 2BR and 3BR vacation-rental inventory.",
  },
  {
    city: /^(kailua-kona|kona|keauhou|kahaluu-keauhou|holualoa)$/i,
    state: /^(hi|hawaii)$/i,
    name: "Kona Reef Resort",
    unitTypes: "condos",
    bedroomMix: "mostly 1BR and 2BR condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 78,
    combinabilityScore: 56,
    sourceUrl: "https://www.hawaiigaga.com/big-island/condos/kona-reef.aspx",
    researchSummary: "Kailua-Kona oceanfront condominium resort with individually rented condo units; strongest for 2BR plus 2BR bundles.",
  },
  {
    city: /^(kailua-kona|kona|keauhou|kahaluu-keauhou|holualoa)$/i,
    state: /^(hi|hawaii)$/i,
    name: "Keauhou Kona Surf & Racquet Club",
    unitTypes: "condos and townhomes",
    bedroomMix: "2BR and 3BR condos/townhomes",
    combinedBedroomsTypical: 5,
    confidenceScore: 78,
    combinabilityScore: 66,
    sourceUrl: "https://www.alohacondos.com/bigisland/keauhou-kona-surf-and-racquet-club",
    researchSummary: "Large Keauhou condo/townhome resort community with 2BR/3BR vacation rental inventory.",
  },
  {
    city: /^(kailua-kona|kona|keauhou|kahaluu-keauhou|holualoa)$/i,
    state: /^(hi|hawaii)$/i,
    name: "White Sands Village",
    unitTypes: "condos",
    bedroomMix: "mostly 2BR condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 72,
    combinabilityScore: 54,
    sourceUrl: "https://www.hawaiigaga.com/big-island/condos/white-sands-village.aspx",
    researchSummary: "Kailua-Kona condo community near Magic Sands with recurring 2BR vacation-rental inventory.",
  },
  {
    city: SOUTH_BIG_ISLAND_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Colony One at Sea Mountain",
    unitTypes: "condos and townhouse-style condos",
    bedroomMix: "1BR and 2BR condos/townhouse-style condos",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 76,
    estimatedBedroomUnitCounts: { "1": 40, "2": 24 },
    combinedBedroomsTypical: 4,
    confidenceScore: 74,
    combinabilityScore: 54,
    sourceUrl: "https://www.expedia.com/Pahala-Hotels-52-2-Bedroom2-Bath-Beautifully-Furnished-Polynesian-Style-Townhouse-With-2.h85475959.Hotel-Information",
    researchSummary: "South Big Island condo resort near Punalu'u Black Sand Beach with recurring 1BR/2BR whole-condo vacation rental inventory; suitable for 2x2BR bundles when larger resorts are sparse.",
  },
  // Poipu / Koloa (Kauai south shore) — added to ensure combo research for Poipu HI
  // surfaces all major individually-owned condo/townhome vacation-rental communities.
  // These are pre-seeded so they reliably appear even when Google organic results
  // are sparse for the exact city string "Poipu". All are condo/townhome (no villas,
  // hotels, or timeshares). See checkCommunityType + DISQUALIFYING_TERMS.
  {
    city: /^(poipu|koloa|poipu kai)$/i,
    state: /^(hi|hawaii)$/i,
    name: "Pili Mai",
    unitTypes: "townhomes",
    bedroomMix: "2BR and 3BR townhomes",
    combinedBedroomsTypical: 6,
    confidenceScore: 86,
    combinabilityScore: 80,
    sourceUrl: "https://www.kauaicalls.com/poipus-hidden-gem/",
    researchSummary: "Poipu Kai luxury townhome community with 2BR/3BR individually owned vacation-rental units; strong for combo bundles near golf course.",
    availableBedrooms: [2, 3],
    estimatedTotalUnits: 140,
    estimatedBedroomUnitCounts: {"2": 60, "3": 80},
  },
  {
    city: /^(poipu|koloa|poipu kai)$/i,
    state: /^(hi|hawaii)$/i,
    name: "Regency at Poipu Kai",
    unitTypes: "condos",
    bedroomMix: "2BR and 3BR condos",
    combinedBedroomsTypical: 5,
    confidenceScore: 82,
    combinabilityScore: 72,
    sourceUrl: "https://www.parrishkauai.com/36044/regency-at-poipu-kai-new-kauai-vacation-rentals-available/",
    researchSummary: "Refined condo complex at Poipu Kai with individually owned 2BR/3BR units, air-conditioned, popular vacation rental inventory.",
    availableBedrooms: [2, 3, 4],
    estimatedTotalUnits: 80,
  },
  {
    city: /^(poipu|koloa|poipu kai)$/i,
    state: /^(hi|hawaii)$/i,
    name: "Poipu Kapili",
    unitTypes: "condos",
    bedroomMix: "1BR and 2BR oceanfront condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 78,
    combinabilityScore: 58,
    sourceUrl: "https://poipukapili.com/",
    researchSummary: "Small intimate 60-unit oceanfront condo resort in Poipu with 1-2BR units; good for 2x2BR combos, individually owned vacation rentals.",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 60,
  },
  {
    city: /^(poipu|koloa)$/i,
    state: /^(hi|hawaii)$/i,
    name: "Poipu Shores",
    unitTypes: "condos",
    bedroomMix: "2BR oceanfront condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 76,
    combinabilityScore: 62,
    sourceUrl: "https://www.kauaivacationrentals.com/vacation-rentals/poipu-shores-106a",
    researchSummary: "Shoreline 2BR condo resort right on the ocean in Poipu, strong vacation rental demand, individually owned units.",
    availableBedrooms: [2],
    estimatedTotalUnits: 50,
  },
  {
    city: /^(poipu|koloa|poipu kai)$/i,
    state: /^(hi|hawaii)$/i,
    name: "Kahala at Poipu Kai",
    unitTypes: "condos",
    bedroomMix: "2BR and 3BR condos",
    combinedBedroomsTypical: 5,
    confidenceScore: 80,
    combinabilityScore: 70,
    sourceUrl: "https://www.parrishkauai.com/801748",
    researchSummary: "Well-maintained landscaped condo complex in Poipu Kai, short walk to beaches, recurring individual vacation rental condos.",
    availableBedrooms: [2, 3],
    estimatedTotalUnits: 100,
  },
  {
    city: /^(poipu|koloa|poipu kai)$/i,
    state: /^(hi|hawaii)$/i,
    name: "Manualoha at Poipu Kai",
    unitTypes: "condos",
    bedroomMix: "2BR and 3BR condos",
    combinedBedroomsTypical: 5,
    confidenceScore: 77,
    combinabilityScore: 68,
    sourceUrl: "https://mykauaivacationrental.com/manualoha-poipu-kai-vacation-rental/",
    researchSummary: "Closest condo development in Poipu Kai to beaches, individually owned units rented as vacation rentals.",
    availableBedrooms: [2, 3],
    estimatedTotalUnits: 120,
  },
  {
    city: /^(kihei|south kihei|north kihei)$/i,
    state: /^(hi|hawaii)$/i,
    name: "Kamaole Sands",
    unitTypes: "condos",
    bedroomMix: "1BR, 2BR, and 3BR vacation condos",
    combinedBedroomsTypical: 5,
    confidenceScore: 86,
    combinabilityScore: 74,
    sourceUrl: "https://www.castleresorts.com/pdf/ksm-fact-sheet.pdf",
    researchSummary: "Large South Kihei condominium resort across from Kamaole Beach Park III with one-, two-, and three-bedroom vacation condos; strong 2BR/3BR combo candidate.",
    availableBedrooms: [1, 2, 3],
    estimatedTotalUnits: 440,
  },
  {
    city: /^(kihei|south kihei|north kihei)$/i,
    state: /^(hi|hawaii)$/i,
    name: "Maui Banyan",
    unitTypes: "condos",
    bedroomMix: "1BR, 2BR, and 3BR condos",
    combinedBedroomsTypical: 5,
    confidenceScore: 84,
    combinabilityScore: 72,
    sourceUrl: "https://www.mauibanyan.com/",
    researchSummary: "South Kihei resort property with one-, two-, and three-bedroom condos across from Kamaole Beach II; suitable for bundled same-resort condo listings.",
    availableBedrooms: [1, 2, 3],
    estimatedTotalUnits: 256,
  },
  {
    city: /^(kihei|south kihei|north kihei)$/i,
    state: /^(hi|hawaii)$/i,
    name: "Menehune Shores",
    unitTypes: "condos",
    bedroomMix: "mostly 2BR condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 82,
    combinabilityScore: 66,
    sourceUrl: "https://www.hawaiigaga.com/menehune-shores-rentals.aspx",
    researchSummary: "Oceanfront North Kihei condo resort with recurring 2BR/2BA vacation rental inventory; good for 2BR + 2BR combo products.",
    availableBedrooms: [2],
    estimatedTotalUnits: 154,
  },
  {
    city: /^(kihei|south kihei|north kihei)$/i,
    state: /^(hi|hawaii)$/i,
    name: "Maui Vista",
    unitTypes: "condos",
    bedroomMix: "1BR and 2BR condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 80,
    combinabilityScore: 64,
    sourceUrl: "https://www.mauivistacondos.net/",
    researchSummary: "Central Kihei condo resort with one- and two-bedroom vacation condos in three four-story buildings near Charley Young Beach.",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 280,
  },
  {
    city: /^(kihei|south kihei|north kihei)$/i,
    state: /^(hi|hawaii)$/i,
    name: "Maui Kamaole",
    unitTypes: "condos",
    bedroomMix: "1BR and 2BR condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 80,
    combinabilityScore: 64,
    sourceUrl: "https://www.hawaiigaga.com/maui-kamaole-rentals.aspx",
    researchSummary: "South Kihei low-rise condo resort near Kamaole III and Wailea with recurring 1BR/2BR vacation rental inventory.",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 316,
  },
  {
    city: /^(kihei|south kihei|north kihei)$/i,
    state: /^(hi|hawaii)$/i,
    name: "Kihei Akahi",
    unitTypes: "condos",
    bedroomMix: "1BR and 2BR condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 78,
    combinabilityScore: 62,
    sourceUrl: "https://mauiownercondos.com/locations/south-maui/kihei/kihei-akahi",
    researchSummary: "Kihei condo complex with individually rented vacation condos near Kamaole Beach II; viable for 2BR + 2BR bundles when inventory is available.",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 240,
  },
  {
    city: /^(kihei|south kihei|north kihei)$/i,
    state: /^(hi|hawaii)$/i,
    name: "Hale Kamaole",
    unitTypes: "condos",
    bedroomMix: "1BR and 2BR condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 78,
    combinabilityScore: 62,
    sourceUrl: "https://www.hawaiigaga.com/hale-kamaole-rentals.aspx",
    researchSummary: "South Kihei condominium resort by Kamaole Beach Park III with recurring vacation-rental condo inventory.",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 188,
  },
  {
    city: /^(kihei|south kihei|north kihei)$/i,
    state: /^(hi|hawaii)$/i,
    name: "Maui Sunset",
    unitTypes: "condos",
    bedroomMix: "1BR and 2BR condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 78,
    combinabilityScore: 62,
    sourceUrl: "https://www.mauisunset.com/2-bedroom",
    researchSummary: "Beachfront Kihei resort condominium complex with 2BR vacation rentals and resort-style amenities; suitable for 2BR combo research.",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 225,
  },
  {
    city: /^(kihei|south kihei|north kihei)$/i,
    state: /^(hi|hawaii)$/i,
    name: "Kauhale Makai",
    unitTypes: "condos",
    bedroomMix: "1BR and 2BR condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 76,
    combinabilityScore: 60,
    sourceUrl: "https://www.hawaiigaga.com/kauhale-makai-rentals.aspx",
    researchSummary: "Kihei oceanfront condo resort also known as Village by the Sea, with 1BR/2BR vacation-rental condo inventory.",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 169,
  },
  {
    city: /^(kihei|south kihei|north kihei)$/i,
    state: /^(hi|hawaii)$/i,
    name: "Kamaole Nalu",
    unitTypes: "condos",
    bedroomMix: "mostly 2BR condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 76,
    combinabilityScore: 60,
    sourceUrl: "https://www.mauicondohomes.com/vacation-rentals/kamaole-nalu-102/",
    researchSummary: "Oceanfront South Kihei condo resort near Kamaole Beach II with 2BR vacation-rental condos.",
    availableBedrooms: [2],
    estimatedTotalUnits: 36,
  },
  {
    city: OAHU_WAIKIKI_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Waikiki Shore by Outrigger",
    unitTypes: "condos",
    bedroomMix: "studio, 1BR, and 2BR beachfront condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 86,
    combinabilityScore: 58,
    sourceUrl: "https://hawaiivacationcondos.outrigger.com/hawaii/oahu/waikiki-shore-by-outrigger/accommodations",
    researchSummary: "Waikiki beachfront condominium vacation-rental building with studio, 1BR, and rare 2BR condos; viable for 2BR plus 2BR bundles when inventory is available.",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 168,
  },
  {
    city: OAHU_WAIKIKI_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Ilikai",
    unitTypes: "condos",
    bedroomMix: "studio, 1BR, and 2BR condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 84,
    combinabilityScore: 58,
    sourceUrl: "https://www.ilikaicollection.com/",
    researchSummary: "Landmark Waikiki high-rise with individually owned vacation-rental condos, including 2BR inventory near Ala Moana and Waikiki Beach.",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 575,
  },
  {
    city: OAHU_WAIKIKI_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Waikiki Banyan",
    unitTypes: "condos",
    bedroomMix: "mostly 1BR condos, some 2BR combo opportunities",
    combinedBedroomsTypical: 4,
    confidenceScore: 82,
    combinabilityScore: 54,
    sourceUrl: "https://www.hawaiigaga.com/waikiki-banyan-rentals.aspx",
    researchSummary: "Large Waikiki condominium resort one block from the beach with active vacation-rental inventory; strongest for adjacent 1BR/2BR-style bundled products.",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 876,
  },
  {
    city: OAHU_WAIKIKI_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Waikiki Beach Tower",
    unitTypes: "condos",
    bedroomMix: "2BR condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 82,
    combinabilityScore: 66,
    sourceUrl: "https://www.hawaiigaga.com/waikiki-beach-tower-rentals.aspx",
    researchSummary: "Waikiki high-rise condo resort with recurring 2BR vacation-rental inventory; suitable for 2BR plus 2BR combo listings.",
    availableBedrooms: [2],
    estimatedTotalUnits: 140,
  },
  {
    city: OAHU_WAIKIKI_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Waikiki Sunset",
    unitTypes: "condos",
    bedroomMix: "1BR and 2BR condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 78,
    combinabilityScore: 56,
    sourceUrl: "https://www.hawaiigaga.com/waikiki-sunset-rentals.aspx",
    researchSummary: "Waikiki condominium resort with full-kitchen vacation rentals near Kuhio Avenue and the beach.",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 435,
  },
  {
    city: OAHU_WAIKIKI_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Island Colony",
    unitTypes: "condos",
    bedroomMix: "studio and 1BR condos",
    combinedBedroomsTypical: 2,
    confidenceScore: 74,
    combinabilityScore: 50,
    sourceUrl: "https://www.hawaiigaga.com/island-colony-rentals.aspx",
    researchSummary: "Large Waikiki condo building with active vacation-rental inventory; marginal but valid for small-unit bundles.",
    availableBedrooms: [1],
    estimatedTotalUnits: 740,
  },
  {
    city: OAHU_WEST_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Ko Olina Beach Villas",
    unitTypes: "condos",
    bedroomMix: "2BR and 3BR condos",
    combinedBedroomsTypical: 5,
    confidenceScore: 86,
    combinabilityScore: 74,
    sourceUrl: "https://www.olaproperties.com/ko-olina-beach-villas/",
    researchSummary: "Ko Olina beachfront condo resort with 2BR/3BR vacation-rental villas in shared-wall condominium towers.",
    availableBedrooms: [2, 3],
    estimatedTotalUnits: 247,
  },
  {
    city: OAHU_WEST_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Coconut Plantation at Ko Olina",
    unitTypes: "townhomes",
    bedroomMix: "2BR and 3BR townhomes",
    combinedBedroomsTypical: 5,
    confidenceScore: 80,
    combinabilityScore: 68,
    sourceUrl: "https://www.olaproperties.com/coconut-plantation/",
    researchSummary: "Ko Olina townhome community with recurring 2BR/3BR vacation-rental inventory suitable for bundled adjacent-unit products.",
    availableBedrooms: [2, 3],
    estimatedTotalUnits: 270,
  },
  {
    city: OAHU_NORTH_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Kuilima Estates",
    unitTypes: "condos and townhomes",
    bedroomMix: "1BR, 2BR, and 3BR condos/townhomes",
    combinedBedroomsTypical: 5,
    confidenceScore: 82,
    combinabilityScore: 66,
    sourceUrl: "https://www.turtlebayrentals.com/",
    researchSummary: "Turtle Bay/Kuilima condo and townhome community with legal vacation-rental inventory near Oahu's North Shore.",
    availableBedrooms: [1, 2, 3],
    estimatedTotalUnits: 400,
  },
  {
    city: OAHU_LEEWARD_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Makaha Valley Towers",
    unitTypes: "condos",
    bedroomMix: "1BR and 2BR condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 76,
    combinabilityScore: 54,
    sourceUrl: "https://www.hawaiigaga.com/makaha-valley-towers-rentals.aspx",
    researchSummary: "Large Makaha condominium property with individually rented vacation condos; viable for small-to-mid combo products.",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 586,
  },
  {
    city: MAUI_WAILEA_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Wailea Ekahi Village",
    unitTypes: "condos",
    bedroomMix: "1BR and 2BR condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 82,
    combinabilityScore: 64,
    sourceUrl: "https://www.hawaiigaga.com/wailea-ekahi-rentals.aspx",
    researchSummary: "Large Wailea beachfront condo village with recurring vacation-rental condos and 1BR/2BR inventory.",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 294,
  },
  {
    city: MAUI_WAILEA_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Wailea Elua Village",
    unitTypes: "condos",
    bedroomMix: "1BR, 2BR, and 3BR condos",
    combinedBedroomsTypical: 5,
    confidenceScore: 82,
    combinabilityScore: 70,
    sourceUrl: "https://www.hawaiigaga.com/wailea-elua-rentals.aspx",
    researchSummary: "Wailea beachfront condo village with individually rented 1BR/2BR/3BR vacation condos.",
    availableBedrooms: [1, 2, 3],
    estimatedTotalUnits: 152,
  },
  {
    city: MAUI_WAILEA_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Grand Champions Villas",
    unitTypes: "condo-style villas",
    bedroomMix: "1BR, 2BR, and 3BR condos",
    combinedBedroomsTypical: 5,
    confidenceScore: 78,
    combinabilityScore: 66,
    sourceUrl: "https://www.hawaiigaga.com/grand-champions-rentals.aspx",
    researchSummary: "Wailea shared-wall condo-style villa community with vacation-rental inventory across 1BR/2BR/3BR units.",
    availableBedrooms: [1, 2, 3],
    estimatedTotalUnits: 188,
  },
  {
    city: MAUI_MAALAEA_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Maalaea Banyans",
    unitTypes: "condos",
    bedroomMix: "1BR and 2BR condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 76,
    combinabilityScore: 56,
    sourceUrl: "https://www.hawaiigaga.com/maalaea-banyans-rentals.aspx",
    researchSummary: "Maalaea oceanfront condominium resort with vacation-rental condo inventory near the harbor.",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 64,
  },
  {
    city: MAUI_WEST_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Honua Kai Resort",
    unitTypes: "condos",
    bedroomMix: "1BR, 2BR, and 3BR condos",
    combinedBedroomsTypical: 5,
    confidenceScore: 86,
    combinabilityScore: 72,
    sourceUrl: "https://www.hawaiigaga.com/honua-kai-rentals.aspx",
    researchSummary: "Kaanapali/North Beach condominium resort with individually owned 1BR/2BR/3BR vacation-rental condos.",
    availableBedrooms: [1, 2, 3],
    estimatedTotalUnits: 628,
  },
  {
    city: MAUI_WEST_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Kaanapali Alii",
    unitTypes: "condos",
    bedroomMix: "1BR, 2BR, and 3BR condos",
    combinedBedroomsTypical: 5,
    confidenceScore: 82,
    combinabilityScore: 70,
    sourceUrl: "https://www.hawaiigaga.com/kaanapali-alii-rentals.aspx",
    researchSummary: "Kaanapali Beach condominium resort with large individually rented condos, including 2BR/3BR inventory.",
    availableBedrooms: [1, 2, 3],
    estimatedTotalUnits: 264,
  },
  {
    city: MAUI_WEST_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Maui Eldorado",
    unitTypes: "condos",
    bedroomMix: "studio, 1BR, and 2BR condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 78,
    combinabilityScore: 56,
    sourceUrl: "https://www.hawaiigaga.com/maui-eldorado-rentals.aspx",
    researchSummary: "Kaanapali condominium resort with active vacation-rental inventory and 1BR/2BR units.",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 204,
  },
  {
    city: MAUI_WEST_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Kapalua Golf Villas",
    unitTypes: "condos",
    bedroomMix: "1BR and 2BR condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 78,
    combinabilityScore: 60,
    sourceUrl: "https://www.hawaiigaga.com/kapalua-golf-villas-rentals.aspx",
    researchSummary: "Kapalua shared-wall golf villa condominium community with recurring 1BR/2BR vacation rentals.",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 186,
  },
  {
    city: MAUI_WEST_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Royal Kahana",
    unitTypes: "condos",
    bedroomMix: "studio, 1BR, and 2BR condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 76,
    combinabilityScore: 54,
    sourceUrl: "https://www.hawaiigaga.com/royal-kahana-rentals.aspx",
    researchSummary: "Kahana oceanfront condo tower with vacation-rental inventory and 1BR/2BR units.",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 236,
  },
  {
    city: BIG_ISLAND_RESORT_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Waikoloa Beach Villas",
    unitTypes: "condos",
    bedroomMix: "2BR and 3BR condos",
    combinedBedroomsTypical: 5,
    confidenceScore: 84,
    combinabilityScore: 72,
    sourceUrl: "https://www.hawaiigaga.com/waikoloa-beach-villas-rentals.aspx",
    researchSummary: "Waikoloa Beach Resort condominium community with 2BR/3BR vacation-rental units.",
    availableBedrooms: [2, 3],
    estimatedTotalUnits: 120,
  },
  {
    city: BIG_ISLAND_RESORT_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Fairway Villas Waikoloa",
    unitTypes: "condos",
    bedroomMix: "2BR and 3BR condos",
    combinedBedroomsTypical: 5,
    confidenceScore: 82,
    combinabilityScore: 70,
    sourceUrl: "https://www.hawaiigaga.com/fairway-villas-waikoloa-rentals.aspx",
    researchSummary: "Waikoloa Beach Resort condo community with 2BR/3BR vacation-rental inventory.",
    availableBedrooms: [2, 3],
    estimatedTotalUnits: 165,
  },
  {
    city: BIG_ISLAND_RESORT_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Halii Kai",
    unitTypes: "condos",
    bedroomMix: "2BR and 3BR condos",
    combinedBedroomsTypical: 5,
    confidenceScore: 82,
    combinabilityScore: 70,
    sourceUrl: "https://www.hawaiigaga.com/halii-kai-rentals.aspx",
    researchSummary: "Waikoloa oceanfront condominium community with individually rented 2BR/3BR units.",
    availableBedrooms: [2, 3],
    estimatedTotalUnits: 192,
  },
  {
    city: BIG_ISLAND_RESORT_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Mauna Lani Point",
    unitTypes: "condos",
    bedroomMix: "1BR, 2BR, and 3BR condos",
    combinedBedroomsTypical: 5,
    confidenceScore: 80,
    combinabilityScore: 68,
    sourceUrl: "https://www.hawaiigaga.com/mauna-lani-point-rentals.aspx",
    researchSummary: "Mauna Lani condominium resort with large 1BR/2BR/3BR vacation rentals.",
    availableBedrooms: [1, 2, 3],
    estimatedTotalUnits: 116,
  },
  {
    city: KAUAI_NORTH_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Hanalei Bay Resort",
    unitTypes: "condos",
    bedroomMix: "studio, 1BR, and 2BR condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 80,
    combinabilityScore: 56,
    sourceUrl: "https://www.hawaiigaga.com/hanalei-bay-resort-rentals.aspx",
    researchSummary: "Princeville/Hanalei Bay condo resort with individually rented vacation condos and some 2BR inventory.",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 134,
  },
  {
    city: KAUAI_NORTH_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Puu Poa",
    unitTypes: "condos",
    bedroomMix: "2BR condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 78,
    combinabilityScore: 62,
    sourceUrl: "https://www.hawaiigaga.com/puu-poa-rentals.aspx",
    researchSummary: "Princeville ocean-bluff condominium community with recurring 2BR vacation rentals.",
    availableBedrooms: [2],
    estimatedTotalUnits: 56,
  },
  {
    city: KAUAI_NORTH_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Alii Kai",
    unitTypes: "condos",
    bedroomMix: "1BR and 2BR condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 76,
    combinabilityScore: 58,
    sourceUrl: "https://www.hawaiigaga.com/alii-kai-rentals.aspx",
    researchSummary: "Princeville condominium community with vacation-rental inventory and 2BR options.",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 150,
  },
  {
    city: KAUAI_EAST_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Waipouli Beach Resort",
    unitTypes: "condos",
    bedroomMix: "1BR, 2BR, and 3BR condos",
    combinedBedroomsTypical: 5,
    confidenceScore: 84,
    combinabilityScore: 70,
    sourceUrl: "https://www.hawaiigaga.com/waipouli-beach-resort-rentals.aspx",
    researchSummary: "Kapaa/Waipouli beachfront condominium resort with 1BR/2BR/3BR vacation rental inventory.",
    availableBedrooms: [1, 2, 3],
    estimatedTotalUnits: 196,
    addressHint: "4-820 Kuhio Hwy",
  },
  {
    city: KAUAI_EAST_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Lae Nani",
    unitTypes: "condos",
    bedroomMix: "1BR and 2BR condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 78,
    combinabilityScore: 60,
    sourceUrl: "https://www.hawaiigaga.com/lae-nani-rentals.aspx",
    researchSummary: "Wailua/Kapaa oceanfront condominium community with recurring 1BR/2BR vacation rentals.",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 84,
  },
  {
    city: KAUAI_EAST_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Kaha Lani",
    unitTypes: "condos",
    bedroomMix: "1BR and 2BR condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 78,
    combinabilityScore: 60,
    sourceUrl: "https://www.hawaiigaga.com/kaha-lani-rentals.aspx",
    researchSummary: "Lihue/Wailua oceanfront condo resort with active vacation-rental inventory and 1BR/2BR units.",
    availableBedrooms: [1, 2],
    estimatedTotalUnits: 74,
  },
  {
    city: KAUAI_EAST_CITY_PATTERN,
    state: /^(hi|hawaii)$/i,
    name: "Banyan Harbor",
    unitTypes: "condos",
    bedroomMix: "2BR condos",
    combinedBedroomsTypical: 4,
    confidenceScore: 76,
    combinabilityScore: 60,
    sourceUrl: "https://www.hawaiigaga.com/banyan-harbor-rentals.aspx",
    researchSummary: "Lihue/Nawiliwili condominium community with individually rented 2BR vacation-rental units.",
    availableBedrooms: [2],
    estimatedTotalUnits: 148,
  },
];

function knownSingleListingSeedsForCity(city: string, state: string): ResearchedCommunity[] {
  return KNOWN_SINGLE_LISTING_COMMUNITY_SEEDS
    .filter((seed) => seed.city.test(city.trim()) && seed.state.test(state.trim()))
    .map((seed) => ({
      name: seed.name,
      city,
      state,
      estimatedLowRate: null,
      estimatedHighRate: null,
      unitTypes: seed.unitTypes,
      confidenceScore: 88,
      researchSummary: seed.researchSummary,
      sourceUrl: seed.sourceUrl ?? "",
      bedroomMix: seed.availableBedrooms.length > 0 ? `${seed.availableBedrooms.join("/")}BR` : undefined,
      combinabilityScore: undefined,
      fromWorldKnowledge: true,
      availableBedrooms: seed.availableBedrooms,
      estimatedTotalUnits: seed.estimatedTotalUnits,
    }));
}

function knownComboSeedsForCity(city: string, state: string): ResearchedCommunity[] {
  return KNOWN_COMBO_COMMUNITY_SEEDS
    .filter((seed) => seed.city.test(city.trim()) && seed.state.test(state.trim()))
    .filter((seed) => checkCommunityType(seed.unitTypes, seed.researchSummary).eligible)
    .map((seed) => ({
      name: seed.name,
      city,
      state,
      estimatedLowRate: null,
      estimatedHighRate: null,
      unitTypes: seed.unitTypes,
      confidenceScore: seed.confidenceScore,
      researchSummary: seed.researchSummary,
      sourceUrl: seed.sourceUrl,
      bedroomMix: seed.bedroomMix,
      availableBedrooms: seed.availableBedrooms,
      estimatedTotalUnits: seed.estimatedTotalUnits,
      estimatedBedroomUnitCounts: seed.estimatedBedroomUnitCounts,
      combinedBedroomsTypical: seed.combinedBedroomsTypical,
      combinabilityScore: seed.combinabilityScore,
      fromWorldKnowledge: true,
    }));
}

export function hasSixBedroomComboPotential(
  community: Pick<ResearchedCommunity, "availableBedrooms" | "estimatedBedroomUnitCounts" | "combinedBedroomsTypical" | "bedroomMix">,
): boolean {
  if (typeof community.combinedBedroomsTypical === "number" && community.combinedBedroomsTypical >= 6) {
    return true;
  }

  if ((community.availableBedrooms ?? []).some((bedrooms) => Number.isFinite(bedrooms) && bedrooms >= 3)) {
    return true;
  }

  if (community.estimatedBedroomUnitCounts) {
    for (const [bedrooms, count] of Object.entries(community.estimatedBedroomUnitCounts)) {
      if (Number(bedrooms) >= 3 && Number(count) > 0) return true;
    }
  }

  return /\b(?:3|4)\s*(?:br|bd|bed(?:room)?s?)\b/i.test(community.bedroomMix ?? "");
}

export function hasKnownSixBedroomComboMarketPotential(city: string, state: string): boolean {
  return knownComboSeedsForCity(city, state).some(hasSixBedroomComboPotential);
}

function normalizeCommunityName(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

export function parseCommunityResearchJsonArray(rawText: string): Array<any> | null {
  const cleaned = String(rawText || "").replace(/```(?:json)?\s*/g, "").replace(/```/g, "");
  const candidates: Array<any>[] = [];
  for (let start = 0; start < cleaned.length; start += 1) {
    if (cleaned[start] !== "[") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < cleaned.length; i += 1) {
      const ch = cleaned[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === "\"") inString = false;
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "[") depth += 1;
      if (ch === "]") {
        depth -= 1;
        if (depth === 0) {
          const slice = cleaned.slice(start, i + 1);
          try {
            const parsed = JSON.parse(slice);
            if (Array.isArray(parsed)) candidates.push(parsed);
          } catch {
            // Try the next bracket-balanced candidate.
          }
          break;
        }
      }
    }
  }
  if (candidates.length === 0) return null;
  return candidates.find((arr) => arr.some((item) => item && typeof item === "object" && !Array.isArray(item))) ?? candidates[0];
}

function normalizeBedroomList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return Array.from(new Set(
    value
      .map((n: unknown) => typeof n === "number" ? Math.round(n) : null)
      .filter((n: number | null): n is number => n != null && n >= 1 && n <= 12),
  )).sort((a, b) => a - b);
}

function normalizeBedroomUnitCounts(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const counts: Record<string, number> = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const bedroomCount = Math.round(Number(String(rawKey).replace(/[^\d.]/g, "")));
    const unitCount = Math.round(Number(rawValue));
    if (
      Number.isFinite(bedroomCount) &&
      bedroomCount >= 1 &&
      bedroomCount <= 12 &&
      Number.isFinite(unitCount) &&
      unitCount > 0 &&
      unitCount <= 50000
    ) {
      counts[String(bedroomCount)] = unitCount;
    }
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

function normalizeMinimumStayNights(value: unknown): number | null | undefined {
  if (value == null) return null;
  if (typeof value === "string" && value.trim().toLowerCase() === "null") return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 60) return null;
  return n;
}

function applyKnownSingleListingFacts(
  rawName: string,
  city: string,
  state: string,
  availableBedrooms: number[] | undefined,
  estimatedTotalUnits: number | undefined,
): { name: string; availableBedrooms: number[] | undefined; estimatedTotalUnits: number | undefined } {
  const rawKey = normalizeCommunityName(rawName);
  const fact = KNOWN_SINGLE_LISTING_COMMUNITY_FACTS.find((f) =>
    f.city.test(city.trim()) &&
    f.state.test(state.trim()) &&
    f.aliases.some((alias) => alias.test(rawKey)),
  );
  if (!fact) {
    return { name: rawName, availableBedrooms, estimatedTotalUnits };
  }
  return {
    name: fact.canonicalName,
    availableBedrooms: fact.availableBedrooms,
    estimatedTotalUnits: fact.estimatedTotalUnits,
  };
}

// Pull a bedroom count out of a SearchAPI airbnb engine listing. The
// engine returns `bedrooms` only as part of the title text — never as
// a structured top-level field — so this function mostly reads the
// title. `accommodations` (an array of strings like "2 bedrooms",
// "1 bath") is a fallback when the title is too marketing-heavy to
// parse.
//
//   "Boho Chic 2BR Condo Near Disney"           → 2
//   "Spacious 3 Bedroom Vacation Home"          → 3
//   "Studio condo by the pool"                  → 0
//   "Cozy efficiency unit"                      → 0
//
// Returns NaN when nothing matches; callers drop the listing.
export function extractBedroomsFromListing(p: any): number {
  const title = String(p?.name ?? p?.title ?? "");
  const desc = String(p?.description ?? "");
  const accommodations = Array.isArray(p?.accommodations)
    ? p.accommodations.join(" ")
    : "";
  const text = `${title} ${desc} ${accommodations}`.toLowerCase();
  if (/\b(studio|efficiency)\b/.test(text)) return 0;
  // "2BR", "3 br", "2-bedroom", "3 bedroom", "Three Bedroom", etc.
  const numericMatch = text.match(/(\d+)\s*[-]?\s*(?:br\b|bd\b|bed\b|bedroom)/);
  if (numericMatch) {
    const n = parseInt(numericMatch[1], 10);
    if (Number.isFinite(n) && n >= 0 && n <= 10) return n;
  }
  const wordMap: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  };
  for (const [word, num] of Object.entries(wordMap)) {
    if (new RegExp(`\\b${word}[- ]bedroom`).test(text)) return num;
  }
  return NaN;
}

// 7-night amortized nightly lookup against SearchAPI's airbnb engine.
//
// `extracted_total_price` from the engine includes nightly + cleaning +
// service fees for the date range, so dividing by 7 gives the *amortized*
// per-night cost the way a real booking would actually price out — which
// is what we need for buy-in (cost basis) numbers.
//
// Why 7 nights / 30 days out:
//   - 7 nights = the assumption that a typical vacation-rental booking is
//     a week, so cleaning + service fees should amortize over 7 nights,
//     not 1. A 1-night quote inflates the apparent nightly by ~50% on
//     properties with $150-$300 cleaning fees.
//   - 30 days out = far enough that popular listings haven't blocked the
//     calendar (Airbnb often blocks last-minute) and that we dodge the
//     next-7-days surge pricing.
//
// Listing matching is layered (most specific to least):
//   1. If `addressHint` is provided AND geocodes successfully, the
//      function passes a tight ~500m bounding box to SearchAPI as
//      `sw_lat`/`ne_lat`/`sw_lng`/`ne_lng` AND post-filters listings
//      whose `gps_coordinates` fall outside that box. This is the most
//      reliable path: many listings don't name the resort in title or
//      description (e.g. Caribe Cove condos call themselves "Disney
//      Vacation Condo") so a name-only filter drops them all.
//   2. If `addressHint` is missing or geocode fails, the function falls
//      back to token-based name match: every word of length ≥3 in the
//      community name must appear in title or description. Looser than
//      a substring match but tight enough to filter "Caribe Royale" out
//      of a Caribe Cove search.
//
// Returns rates grouped by bedroom count + a `bboxApplied` flag so callers
// can distinguish "geocoded path used (high confidence)" from "name-token
// fallback used (lower confidence)". Nightly rates outside $50-$3000 are
// dropped (junk / regional outliers).
//
// BBOX_HALF_DEG = 0.015° ≈ 1.65km at FL/HI latitudes. Started at 0.005°
// (~500m) to fit a single resort, but Airbnb anonymizes coordinates until
// a booking is confirmed — typically ±0.5-1.0km offset from the actual
// unit. A 500m box dropped every Caribe Cove listing on the live engine
// even though the resort has 16+ listings on Airbnb. 1.65km is wide
// enough to absorb the anonymization without picking up neighbors —
// for resort-dense areas (Kissimmee, Poipu) the next nearest condo
// complex is generally >2km away.
const BBOX_HALF_DEG = 0.015;

export type AmortizedNightlyResult = {
  ratesByBR: Record<number, number[]>;
  bboxApplied: boolean;
  // Geocoded center of the bbox + radius for debugging. Surfaced by the
  // refresh-pricing endpoint so the operator can sanity-check the
  // coordinates without redeploying — e.g. "Treasure Trove Lane"
  // resolved to the right resort and not a same-named street elsewhere.
  bboxCenter?: { lat: number; lng: number };
  // Drop counters for diagnosing "engine returned listings but I got 0
  // rates" failures. Each filter reports how many listings it rejected;
  // `engineCount` is the raw count from SearchAPI before any filtering.
  drops?: {
    engineCount: number;
    outsideBbox: number;
    nameMismatch: number;
    noPrice: number;
    badBedrooms: number;
    nightlyOutOfRange: number;
  };
  // First-listing diagnostic — surfaced when no rates were captured so
  // the operator can see why filters dropped everything (e.g. bedrooms
  // arriving as a string instead of a number).
  firstListingSample?: unknown;
};

export async function fetchAmortizedNightlyByBR(
  communityName: string,
  city: string,
  state: string,
  addressHint?: string,
  // Optional explicit bbox center. When supplied, skips Nominatim
  // geocoding entirely. Useful for static properties where we have
  // operator-validated coordinates (e.g. Regency at Poipu Kai), since
  // Nominatim can't resolve specific street numbers in resort areas
  // and falls back to matching the road itself — which can land
  // ~1km+ off the actual building when the road is long. The
  // 2026-04-28 backfill failed for the Poipu Kai cluster because
  // Nominatim resolved "1831 Poipu Rd" to the road's northern end
  // and the resort sits at the southern end, putting all 19 returned
  // listings outside the bbox after Airbnb's ±0.5-1km anonymization.
  bboxCenterOverride?: { lat: number; lng: number },
  // Optional explicit window. When supplied, overrides the default
  // "30d-out, 7-night" behavior. Used by the multi-season scan (PR
  // #282) to pull per-season basis from the engine.
  dateOverride?: { checkIn: string; checkOut: string },
  // PR #288: optional sparse-BR retry. When `bedrooms` is supplied,
  // the engine query includes `bedrooms=N` so the engine prioritises
  // that BR. `bboxScale` widens the bounding box (e.g. 2 = 2× the
  // default ±0.015° half-width = ~3.3km radius), helping when the
  // default Kapaa-tight bbox returns 0 listings for sparse BRs like
  // 3BR. Use only as a fallback when the initial scan came up empty
  // — costs an extra SearchAPI call per missing BR.
  options?: {
    bedrooms?: number;
    bboxScale?: number;
    signal?: AbortSignal;
  },
): Promise<AmortizedNightlyResult> {
  const searchApiKey = process.env.SEARCHAPI_API_KEY;
  if (!searchApiKey) return { ratesByBR: {}, bboxApplied: false };

  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  let checkInDate: Date;
  let checkOutDate: Date;
  if (dateOverride) {
    checkInDate = new Date(`${dateOverride.checkIn}T00:00:00Z`);
    checkOutDate = new Date(`${dateOverride.checkOut}T00:00:00Z`);
  } else {
    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);
    checkInDate = new Date(now);
    checkInDate.setUTCDate(checkInDate.getUTCDate() + 30);
    checkOutDate = new Date(checkInDate);
    checkOutDate.setUTCDate(checkOutDate.getUTCDate() + 7);
  }

  // Resolve a bbox center, in priority order:
  //   1. explicit `bboxCenterOverride` (operator-validated lat/lng)
  //   2. Nominatim geocode of `addressHint, city, state`
  //   3. fall through to name-token match (no bbox)
  const halfDeg = BBOX_HALF_DEG * (options?.bboxScale ?? 1);
  let bbox: { sw_lat: number; sw_lng: number; ne_lat: number; ne_lng: number } | null = null;
  let bboxCenter: { lat: number; lng: number } | undefined;
  if (bboxCenterOverride && Number.isFinite(bboxCenterOverride.lat) && Number.isFinite(bboxCenterOverride.lng)) {
    bboxCenter = bboxCenterOverride;
    bbox = {
      sw_lat: bboxCenter.lat - halfDeg,
      sw_lng: bboxCenter.lng - halfDeg,
      ne_lat: bboxCenter.lat + halfDeg,
      ne_lng: bboxCenter.lng + halfDeg,
    };
  } else if (addressHint && addressHint.trim()) {
    const fullAddress = `${addressHint.trim()}, ${city}, ${state}`;
    const coord = await geocode(fullAddress);
    if (coord) {
      bboxCenter = coord;
      bbox = {
        sw_lat: coord.lat - halfDeg,
        sw_lng: coord.lng - halfDeg,
        ne_lat: coord.lat + halfDeg,
        ne_lng: coord.lng + halfDeg,
      };
    }
  }

  // Token-based name match — every word of length ≥3 in the community
  // name must appear in the haystack. Used when bbox is unavailable.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const nameTokens = norm(communityName).split(" ").filter((t) => t.length >= 3);
  const nameMatches = (haystack: string): boolean => {
    if (nameTokens.length === 0) return true;
    const n = norm(haystack);
    return nameTokens.every((t) => n.includes(t));
  };

  const ratesByBR: Record<number, number[]> = {};
  const drops = {
    engineCount: 0,
    outsideBbox: 0,
    nameMismatch: 0,
    noPrice: 0,
    badBedrooms: 0,
    nightlyOutOfRange: 0,
  };
  try {
    const sp: Record<string, string> = {
      engine: "airbnb",
      q: `${communityName} ${city} ${state}`,
      check_in_date: ymd(checkInDate),
      check_out_date: ymd(checkOutDate),
      adults: "2",
      type_of_place: "entire_home",
      ...(options?.bedrooms ? { bedrooms: String(options.bedrooms) } : {}),
      currency: "USD",
      api_key: searchApiKey,
    };
    if (bbox) {
      sp.sw_lat = String(bbox.sw_lat);
      sp.sw_lng = String(bbox.sw_lng);
      sp.ne_lat = String(bbox.ne_lat);
      sp.ne_lng = String(bbox.ne_lng);
    }
    const resp = await fetch(
      `https://www.searchapi.io/api/v1/search?${new URLSearchParams(sp).toString()}`,
      { signal: options?.signal },
    );
    if (!resp.ok) return { ratesByBR, bboxApplied: !!bbox, bboxCenter, drops };
    const data = await resp.json() as any;
    const properties: any[] = Array.isArray(data?.properties) ? data.properties : [];
    drops.engineCount = properties.length;
    for (const p of properties) {
      if (bbox) {
        const lat = Number(p?.gps_coordinates?.latitude);
        const lng = Number(p?.gps_coordinates?.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          if (lat < bbox.sw_lat || lat > bbox.ne_lat || lng < bbox.sw_lng || lng > bbox.ne_lng) {
            drops.outsideBbox++;
            continue;
          }
        }
      } else {
        const title = String(p?.name ?? p?.title ?? "");
        const desc = String(p?.description ?? "");
        if (!nameMatches(`${title} ${desc}`)) {
          drops.nameMismatch++;
          continue;
        }
      }
      // Engine never surfaces `bedrooms` as a top-level number. The
      // count lives in the title (e.g. "Boho Chic 2BR Condo …",
      // "Spacious 3 Bedroom Disney Vacation Home", "Studio condo by
      // pool"). Fall back to `accommodations` if the title regex
      // doesn't catch it — some listings encode it there as a
      // structured field.
      const br = extractBedroomsFromListing(p);
      const total = Number(p?.price?.extracted_total_price);
      // Engine pre-computes the per-night rate via
      // `extracted_price_per_qualifier` when the qualifier is
      // "X nights x $Y" — that's the same number we'd compute
      // ourselves from total/7, just without rounding. Prefer the
      // engine value when present; fall back to total/7.
      let nightly: number;
      const perQualifier = Number(p?.price?.extracted_price_per_qualifier);
      if (Number.isFinite(perQualifier) && perQualifier > 0) {
        nightly = Math.round(perQualifier);
      } else if (Number.isFinite(total) && total > 0) {
        nightly = Math.round(total / 7);
      } else {
        drops.noPrice++;
        continue;
      }
      if (!Number.isFinite(br) || br < 1 || br > 6) { drops.badBedrooms++; continue; }
      if (nightly < 50 || nightly > 3000) { drops.nightlyOutOfRange++; continue; }
      if (!ratesByBR[br]) ratesByBR[br] = [];
      ratesByBR[br].push(nightly);
    }
  } catch {
    /* network / parse error — return whatever we accumulated */
  }
  // Surface a sample of the first engine result when we collected no
  // rates — lets the refresh-pricing endpoint diagnose schema drift
  // (e.g. bedrooms arriving as "2 bedrooms" string instead of `2`).
  // We can't add this without re-fetching since the loop above doesn't
  // hold onto the first property; in practice this matters once per
  // schema-drift incident, so just refetch when we'd otherwise return
  // empty.
  let firstListingSample: unknown;
  const totalCollected = Object.values(ratesByBR).reduce((s, l) => s + l.length, 0);
  if (totalCollected === 0 && drops.engineCount > 0) {
    try {
      const sp: Record<string, string> = {
        engine: "airbnb",
        q: `${communityName} ${city} ${state}`,
        check_in_date: ymd(checkInDate),
        check_out_date: ymd(checkOutDate),
        adults: "2",
        type_of_place: "entire_home",
        currency: "USD",
        api_key: searchApiKey,
      };
      if (bbox) {
        sp.sw_lat = String(bbox.sw_lat);
        sp.sw_lng = String(bbox.sw_lng);
        sp.ne_lat = String(bbox.ne_lat);
        sp.ne_lng = String(bbox.ne_lng);
      }
      const resp2 = await fetch(
        `https://www.searchapi.io/api/v1/search?${new URLSearchParams(sp).toString()}`,
        { signal: options?.signal },
      );
      if (resp2.ok) {
        const data2 = await resp2.json() as any;
        const props2 = Array.isArray(data2?.properties) ? data2.properties : [];
        if (props2.length > 0) firstListingSample = props2[0];
      }
    } catch {
      /* non-fatal — diagnostic only */
    }
  }
  return { ratesByBR, bboxApplied: !!bbox, bboxCenter, drops, firstListingSample };
}

// Median of a numeric list, or null on empty input.
export function medianRate(arr: number[]): number | null {
  if (!arr?.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export async function researchCommunitiesForCity(
  city: string,
  state: string,
  // CODEX NOTE (2026-05-04, claude/single-listing-research): mode
  // parameter added to support the single-listing wizard's
  // discovery flow. Combo mode (default) keeps the original behavior
  // — combinabilityScore-gated, max 10 results, max 3 world-
  // knowledge entries, Haiku model. Single mode drops the
  // combinability filter (irrelevant for standalone listings),
  // lifts the world-knowledge cap to 15, returns up to 20, runs on
  // Sonnet for better recall on niche named resorts (e.g. Santa
  // Maria Resort in Fort Myers Beach), and uses extra targeted
  // SearchAPI queries that hit lists/round-ups instead of just
  // listing snippets. See Load-Bearing #36.
  // HI override (2026-06): for any Hawaii city in combo mode (Add Combo
  // Listing tool), Sonnet + exhaustive prompt + 12-15 cap ensures the
  // research autonomously finds all qualifying VR-only condo/townhome
  // resorts without requiring manual Codex/Grok additions.
  mode: "combo" | "single" = "combo",
): Promise<ResearchedCommunity[]> {
  // Normalize inputs so queries and downstream logic are consistent
  // regardless of how the operator typed the city (e.g. "fort myers beach"
  // vs "Fort Myers Beach, FL").
  const normalizedCity = String(city || "").trim();
  const normalizedState = String(state || "").trim();
  if (!normalizedCity || !normalizedState) {
    throw new Error("city and state are required");
  }
  // Use normalized for all query construction and return values.
  const cityForQuery = normalizedCity;
  const stateForQuery = normalizedState;

  // Hawaii detection for exhaustive combo research (addresses operator requirement
  // that any HI city search in the Add Combo Listing tool must autonomously surface
  // all qualifying vacation-rental-only condo/townhome communities, no hotels/timeshares/SFH).
  const isHawaii = /^(hi|hawaii)$/i.test(stateForQuery);
  const knownComboSeeds = mode === "combo" ? knownComboSeedsForCity(cityForQuery, stateForQuery) : [];

  // Hawaii combo searches sit in an operator-facing wizard and top-market sweep.
  // When we already have curated market coverage, return it immediately instead
  // of making the user wait for SearchAPI/Claude; upstream timeouts should not
  // make known resort markets look empty.
  if (mode === "combo" && isHawaii && knownComboSeeds.length > 0) {
    return [...knownComboSeeds].sort((a, b) =>
      (b.confidenceScore + (b.combinabilityScore ?? 50)) -
      (a.confidenceScore + (a.combinabilityScore ?? 50)),
    );
  }

  const searchApiKey = process.env.SEARCHAPI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!searchApiKey) throw new Error("SEARCHAPI_API_KEY not configured");
  const knownComboNames = knownComboSeeds.map((seed) => `"${seed.name}"`).join(" OR ");

  // Strong, uniform negative operators to keep Google results focused on
  // individually-owned condo/townhome vacation rentals and away from hotels,
  // timeshares, condo-hotels, and large branded resort chains.
  const commonExclusions = '-hotel -timeshare -"condo hotel" -"condo-hotel" -marriott -hilton -westin -sheraton -hyatt -"vacation club" -villa -"single family"';

  // Combo queries focus on individually-owned 2BR/3BR mix (combinable).
  // Single-listing queries expand to lists/round-ups of "best vacation
  // rental resorts/condos in {city}" — those pages routinely name 5–10
  // specific resorts (Santa Maria Resort, Sandcastle Beach Club, etc.)
  // that the bare site:airbnb-style queries miss.
  const queries = mode === "single"
    ? [
        `"${cityForQuery}" "${stateForQuery}" condo OR condominium resort vacation rental airbnb vrbo ${commonExclusions}`,
        `"${cityForQuery}" "${stateForQuery}" "best" condo resort vacation rental airbnb vrbo ${commonExclusions}`,
        `"${cityForQuery}" "${stateForQuery}" condo townhome vacation rental "individually owned" OR "owner rents" airbnb ${commonExclusions}`,
        `"top" condo resorts "${cityForQuery}" "${stateForQuery}" airbnb vrbo ${commonExclusions}`,
        `"${cityForQuery}" "${stateForQuery}" beach resort condo 2BR 3BR vacation rental airbnb ${commonExclusions}`,
      ]
    : [
        `"${cityForQuery}" "${stateForQuery}" (condo OR condominium) complex vacation rental 2-bedroom OR 3-bedroom airbnb vrbo individually owned ${commonExclusions} -efficiency -studio`,
        `"${cityForQuery}" "${stateForQuery}" townhome OR townhouse cluster 3 bedroom vacation rental airbnb individually owned ${commonExclusions} -studio`,
        `"${cityForQuery}" "${stateForQuery}" beach condo resort 2BR 3BR individually owned vacation rental ${commonExclusions} -efficiency`,
        `"${cityForQuery}" "${stateForQuery}" "2 bedroom" "condo" "vacation rental" resort ${commonExclusions}`,
        `"${cityForQuery}" "${stateForQuery}" "3 bedroom" "condo" OR "townhome" "vacation rental" ${commonExclusions}`,
        ...(knownComboNames
          ? [`"${cityForQuery}" "${stateForQuery}" (${knownComboNames}) condo townhome vacation rental 2BR 3BR ${commonExclusions}`]
          : []),
        // Extra HI-specific queries for exhaustive coverage on any Hawaii city (used only for HI to keep non-HI sweeps fast).
        ...(isHawaii ? [
          `"${cityForQuery}" hawaii (condo OR townhome OR condominium) ("vacation rental" OR airbnb OR vrbo) ("individually owned" OR "owner managed" OR "private owner") ${commonExclusions}`,
          `maui OR kauai OR "big island" OR oahu "${cityForQuery}" (condo OR townhome) resort "vacation rental" -hotel -timeshare ${commonExclusions}`,
        ] : []),
      ];

  const allResults: Array<{ title: string; link: string; snippet: string }> = [];
  // Single-listing scans pull more results per query so Claude has
  // wider context to surface niche named resorts. Combo flow stays
  // tight to keep wall time bounded for the top-markets sweep.
  const numPerQuery = mode === "single" ? 12 : 8;
  const googleResults = await Promise.all(queries.map(async (q) => {
    try {
      const resp = await fetch(
        `https://www.searchapi.io/api/v1/search?engine=google&q=${encodeURIComponent(q)}&num=${numPerQuery}&api_key=${searchApiKey}`,
        { signal: AbortSignal.timeout(COMMUNITY_RESEARCH_SEARCH_TIMEOUT_MS) },
      );
      if (!resp.ok) return [];
      const data = await resp.json() as any;
      return (data.organic_results || []) as Array<{ title: string; link: string; snippet: string }>;
    } catch (e: any) {
      console.warn(`[research] SearchAPI error for ${city}:`, e.message);
      return [];
    }
  }));
  allResults.push(...googleResults.flat());

  const seen = new Set<string>();
  const uniqueCap = mode === "single" ? 30 : 15;
  const unique = allResults.filter(r => {
    const key = r.title?.toLowerCase().slice(0, 60) ?? r.link;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, uniqueCap);

  // Single-listing mode tolerates an empty SearchAPI response — the
  // world-knowledge fallback below can still surface known named
  // resorts. Combo now also attempts LLM (for nearby-city pivots in Add
  // Combo flow when Google signals are sparse but real inventory exists).
  // Post-filters (confidence>=60 && combinability>=50) still apply.


  // Spot-check the typical per-unit nightly rate for a community by
  // hitting SearchAPI's airbnb engine for a 7-night window 30 days out
  // and averaging across the cheapest bedroom tier (so a 2BR draft and
  // a 3BR draft don't get the same `estimatedLowRate`). Per-night is
  // amortized via total / 7, which matches what a real guest would pay
  // including cleaning + service fees — a 1-night quote inflates the
  // apparent rate by ~50% because cleaning fees fall on a single night.
  //
  // Earlier revision regex-grepped `$XXX/night` headlines from the raw
  // Google JSON. That swept in headline "from $X" rates (often 1-night
  // quotes), peak-season screenshots from review sites, and rates from
  // unrelated nearby properties — producing a `low` ~3x the actual cost
  // basis. For Caribe Cove specifically (operator-validated 2BR ≈ $125
  // all-in), the regex hack returned null entirely on Florida pages
  // because Google snippets don't carry that exact format. Replacing
  // it with the priced-engine lookup is both more accurate AND more
  // reliable — same methodology as `/api/community/search-units`.
  async function spotCheckRate(communityName: string): Promise<{ low: number | null; high: number | null }> {
    try {
      const { ratesByBR } = await fetchAmortizedNightlyByBR(
        communityName,
        city,
        state,
        undefined,
        undefined,
        undefined,
        undefined,
        { signal: AbortSignal.timeout(COMMUNITY_RESEARCH_RATE_TIMEOUT_MS) },
      );
      const allRates: number[] = [];
      for (const list of Object.values(ratesByBR)) allRates.push(...list);
      if (allRates.length === 0) return { low: null, high: null };
      const sorted = [...allRates].sort((a, b) => a - b);
      return { low: sorted[0], high: sorted[sorted.length - 1] };
    } catch (e: any) {
      console.warn(`[research] rate spot-check skipped for ${communityName}: ${e?.message ?? String(e)}`);
      return { low: null, high: null };
    }
  }

  const results: ResearchedCommunity[] = [];
  let remainingRateSpotChecks = COMMUNITY_RESEARCH_RATE_SPOT_CHECK_LIMIT[mode];

  if (anthropicKey) {
    // Single-listing prompt: focused on naming as many qualifying
    // condo/townhouse resorts as possible (no combinability angle).
    // Lifts world-knowledge cap to 15 and explicitly enumerates
    // example resorts per major Florida market so Claude has a
    // strong grounding for niche resorts that don't always show up
    // in SearchAPI's organic results (the documented bug:
    // Santa Maria Resort missing from Fort Myers Beach scans).
    //
    // Combo prompt: unchanged — combinabilityScore-gated, max 3
    // world-knowledge entries, max 10 results.
    const prompt = mode === "single"
      ? `You are sourcing standalone vacation-rental condo/townhouse resorts for Magical Island Rentals's "Add a Single Listing" tool, which onboards individually-owned condos and townhouses one unit at a time.

THE BUSINESS MODEL (single-listing mode):
  We onboard ONE unit at a time from a known condo or townhouse resort. The unit is rented as a standalone listing — NOT combined with another unit.
  So the VALUE of a community = whether it is a recognizable, individually-owned condo/townhouse resort with active vacation rental inventory.
  We do NOT care about "combinability" — single-unit standalones, large 4BR townhouses, small 1BR condos all qualify if the resort fits.

QUALIFYING CRITERIA:
1. PROPERTY TYPE: Condos in a multi-unit building OR townhouses with shared walls. NO villas, detached homes, or single-family residences.
2. OWNERSHIP MODEL: Individually owned (each unit has its own deed), not a single-owner timeshare/hotel.
3. VACATION RENTAL USAGE: Primarily nightly vacation rentals on Airbnb/VRBO/Booking.
4. SIZE: 10+ units of any size. Studio/1BR resorts qualify too.

EXAMPLES of resorts that qualify (use these as a recall anchor):
  Fort Myers Beach, FL: Santa Maria Resort, Sandcastle Beach Club, Diamond Head Beach Resort, Pointe Estero Resort, Surf & Sun Beach Resort, Casa Playa Beach Resort, Estero Beach & Tennis Club, Sea Castle Condominiums, Mariner's Boathouse & Beach Resort, The Sunset Beach Club.
  Destin, FL: Silver Shells Beach Resort, Sandestin Beach Resort, Henderson Park Inn, Crystal Beach, Emerald Towers, Sterling Shores, Mainsail Condominiums.
  Panama City Beach, FL: Edgewater Beach Resort, Calypso Resort, Splash Resort, Aqua Resort, Long Beach Resort, Shores of Panama.
  Kissimmee/Orlando, FL: Windsor Hills Resort, Caribe Cove Resort, Reunion Resort, Encore Resort, Solterra Resort, Champions Gate, Vista Cay Resort, Storey Lake Resort.
  Lihue/Kapaa/Poipu, HI: Pili Mai, Kaha Lani Resort, Lae Nani, Lawai Beach Resort, Whalers Cove, Poipu Kapili, Regency at Poipu Kai.

DISQUALIFIED:
  ❌ Pure-villa or single-family-home resorts (no shared walls).
  ❌ Marriott / Hilton / Westin / Sheraton timeshares (single-owner-corp).
  ❌ Hotels with front-desk check-in and centrally-managed inventory.

SCORING:
  confidenceScore (0–100): sure this is individually-owned condo/townhouse? 90+ household name, 70–89 very likely, 50–69 probably, <50 don't include.
  (No combinabilityScore for single-listing mode — leave it null.)

Use (1) the search results below AND (2) your own world knowledge. **You MAY (and should) add UP TO 15 well-known condo/townhouse resorts from your own knowledge** that fit "${city}, ${state}", marked fromWorldKnowledge:true. Aim for 15–20 total entries when the city has that many known resorts. **For any city named in the EXAMPLES list above, you MUST surface every example resort listed for that city as fromWorldKnowledge entries** unless you have a specific reason to disqualify one.

CRITICAL: For each resort, return availableBedrooms as an array of integers — the bedroom counts that resort actually offers (e.g. Santa Maria Resort: [2, 3]; Pili Mai: [2, 3, 4]; Caribe Cove: [2, 3, 4]; Reunion Resort: [2, 3, 4, 5, 6, 7, 8]). Only include bedroom counts you are confident the resort offers. If you don't know, return an empty array []. The wizard uses this to render bedroom buttons — wrong counts cause failed Zillow lookups, missing counts hide valid options. Default to including 2 and 3 if you're sure the resort exists but uncertain about exact mix. NEVER include studio/0 or 1 unless the resort is genuinely studio/1BR-dominated.

ALSO CRITICAL: For each resort, return estimatedTotalUnits — your best estimate of the TOTAL number of condo/townhouse units in the resort (rough is fine). The wizard sorts by this descending and shows the biggest 10 first. Examples:
  - Caribe Cove (Kissimmee): ~250 units
  - Reunion Resort (Kissimmee): ~2000 units across the whole community
  - Santa Maria Resort (Fort Myers Beach): ~75 units (single-tower condo)
  - Pili Mai (Poipu Kai): ~140 townhomes
  - Edgewater Beach Resort (Panama City Beach): ~520 units
A rough order-of-magnitude estimate is much better than null. Use 0 only when you have NO idea about the resort's size.

ADDRESS HINT (additive for photo/address lookup in wizards): If you can confidently name a real street address (number + name) for the resort entrance or a representative listing from knowledge or snippets (e.g. "9000 Treasure Trove Ln"), include "addressHint" in the object. Use only when sure; otherwise omit or empty. This fixes blank street + weak photo discovery for researched communities.

MINIMUM-STAY POLICY:
  Return minimumStayNights ONLY when you have reliable published evidence of a community/resort/HOA/property-manager minimum-night rule. Use:
  - positive integer: a likely community-wide minimum stay, e.g. 7
  - 0: a reliable source explicitly says there is no community minimum / one-night stays are allowed
  - null: unknown, or only individual OTA listings mention a minimum
  Do NOT infer a community minimum from one Airbnb/VRBO/Booking listing, unavailable dates, seasonal pricing, or generic destination rules. If the rule is seasonal, return the lowest published community-wide minimum and explain the seasonal condition in minimumStayEvidence.

SEARCH RESULTS for "${city}, ${state}":
${unique.length > 0 ? unique.map((r, i) => `[${i}] TITLE: ${r.title}\nURL: ${r.link}\nSNIPPET: ${r.snippet}`).join("\n\n") : "(no organic results — rely on world knowledge)"}

Output JSON array. Each element:
{"communityName":"...","bedroomMix":"...","availableBedrooms":[N,N,...],"estimatedTotalUnits":N,"minimumStayNights":N|null,"minimumStayEvidence":"short source-backed note or empty","minimumStaySourceUrl":"source url or empty","unitTypes":"...","confidenceScore":0-100,"reason":"...","sourceUrl":"...","fromWorldKnowledge":true|false,"addressHint":"optional representative street like 9000 Treasure Trove Ln"}

Include ONLY entries with confidenceScore >= 60. Max 20 results. Sort by confidenceScore descending. No markdown, no prose.`
      : `You are sourcing condo/townhome resorts for Magical Island Rentals, which bundles TWO individually-owned units in the SAME complex into one large-group vacation listing.

THE BUSINESS MODEL:
  We rent unit A (e.g. 3BR) + unit B (e.g. 3BR) in the same building → list them together as one "6BR sleeps 14" villa-style product.
  So the VALUE of a community = bedrooms of (typical unit × 2). If a complex is dominated by studios/efficiencies/1BRs, combining them is pointless — 2×studio is still too small.

CONCRETE EXAMPLES of what we want:
  ✅ Santa Maria Resort (Fort Myers Beach, FL) — condo building, mostly 2BR/3BR units, individually owned, all listed on Airbnb/VRBO. Combining 2×3BR = 6BR. This is the gold standard.
  ✅ Pili Mai (Poipu Kai, HI) — townhome complex, 2BR/3BR, individually owned.
  ✅ Kaha Lani (Kauai) — beachfront condo complex, 2BR/3BR.
  ⚠️ BB&T / Bay Beach & Tennis (Bonita Springs, FL) — mostly efficiency/1BR. 2×1BR = 2BR is WEAK. combinabilityScore 20–35.
  ❌ Fort Myers Beach "villa" resorts — standalone structures, disqualified.
  ❌ Marriott / Hilton / Westin timeshares — single-owner, disqualified.
  ❌ Hotel-run condo-hotels with front desk check-in — disqualified.

STRICT QUALIFYING CRITERIA:
1. PROPERTY TYPE: Condos in multi-unit building OR townhomes with shared walls. NO villas/detached/single-family.
2. OWNERSHIP MODEL: Individually owned, not timeshare or single-owner.
3. VACATION RENTAL USAGE: Primarily nightly rentals.
4. UNIT SHARE-WALLS: Same building or contiguous townhome row.
5. SIZE: 10+ units with 2BR+ options.

SCORING:
  confidenceScore (0–100): sure this is individually-owned condo/townhome? 90+ household name, 70–89 very likely, 50–69 probably, <50 don't include.
  combinabilityScore (0–100): value of combining 2 units?
    90+: mostly 3BR → 2×3BR = 6BR (ideal)
    70–89: 2BR/3BR mix → 4BR–6BR
    50–69: mostly 2BR → 4BR combined
    30–49: mostly 1BR → 2BR combined (marginal)
    <30: mostly studios → skip

Use (1) the search results below, and (2) your own knowledge — add up to ${isHawaii ? 12 : 3} well-known communities in "${city}, ${state}" that fit, marked fromWorldKnowledge:true.
${isHawaii ? `**HAWAII EXHAUSTIVE MODE (for Add Combo Listing tool):** For any Hawaii city, be exhaustive and complete. Surface EVERY qualifying individually-owned condo/townhome vacation-rental resort (majority condos or townhomes, no hotels, no timeshares, no single-family/villa complexes) that your knowledge or the results know for "${city}" or its resort market area. The operator must be able to discover new HI cities without manual intervention — do not under-report. ` : ""}If a resort markets attached condominium/townhome inventory as "villas", only call it a fit when the units are shared-wall condos/townhomes; detached villas remain disqualified. In that case, set unitTypes to "condos", "townhomes", or "condo-style villas" rather than generic "villas".

KNOWN LOCAL CANDIDATES to consider for "${city}, ${state}" if the search results are sparse:
${knownComboSeeds.length
  ? knownComboSeeds.map((seed) => `- ${seed.name}: ${seed.unitTypes}; ${seed.bedroomMix}; ${seed.researchSummary}`).join("\n")
  : "- none"}

RESORT SIZE CONTEXT:
  For each resort, include the best approximate unit count you can find or infer from trustworthy public resort, HOA, property-management, or real-estate sources.
  - availableBedrooms: integer bedroom counts offered by the resort, e.g. [2,3].
  - estimatedTotalUnits: rough total condos/townhomes in the resort, e.g. 122.
  - estimatedBedroomUnitCounts: rough per-bedroom inventory when known, e.g. {"2":45,"3":77}. Use {} when unknown.
  Rough counts are useful, but do not invent fake precision. If you only know the total, provide estimatedTotalUnits and leave estimatedBedroomUnitCounts as {}.

ADDRESS HINT (critical for combo wizard address gen + photo discovery): For each, if confident, also include "addressHint": a real street address (e.g. "2611 Kiahuna Plantation Dr" or "9000 Treasure Trove Ln") for the resort from knowledge or results. This is used to anchor Zillow/Realtor discovery for unit photos when no hardcoded rule exists. Only include when you have a specific reliable one; do not fabricate.

MINIMUM-STAY POLICY:
  Return minimumStayNights ONLY when you have reliable published evidence of a community/resort/HOA/property-manager minimum-night rule. Use:
  - positive integer: a likely community-wide minimum stay, e.g. 7
  - 0: a reliable source explicitly says there is no community minimum / one-night stays are allowed
  - null: unknown, or only individual OTA listings mention a minimum
  Do NOT infer a community minimum from one Airbnb/VRBO/Booking listing, unavailable dates, seasonal pricing, or generic destination rules. If the rule is seasonal, return the lowest published community-wide minimum and explain the seasonal condition in minimumStayEvidence.

SEARCH RESULTS for "${city}, ${state}":
${unique.length
  ? unique.map((r, i) => `[${i}] TITLE: ${r.title}\nURL: ${r.link}\nSNIPPET: ${r.snippet}`).join("\n\n")
  : "(No organic results returned. Use only well-known local candidates you can classify with high confidence.)"}

Output JSON array. Each element:
{"communityName":"...","bedroomMix":"...","availableBedrooms":[N,N,...],"estimatedTotalUnits":N,"estimatedBedroomUnitCounts":{"2":N,"3":N},"minimumStayNights":N|null,"minimumStayEvidence":"short source-backed note or empty","minimumStaySourceUrl":"source url or empty","combinedBedroomsTypical":N,"unitTypes":"...","confidenceScore":0-100,"combinabilityScore":0-100,"reason":"...","sourceUrl":"...","fromWorldKnowledge":false,"addressHint":"optional e.g. 2611 Kiahuna Plantation Dr"}

Include ONLY entries with confidenceScore >= 60 AND combinabilityScore >= 50. Max ${isHawaii ? 15 : 10} results${isHawaii ? " (exhaustive for Hawaii cities)" : ""}. Sort by (confidenceScore + combinabilityScore) descending. No markdown, no prose.`;

    try {
      const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        signal: AbortSignal.timeout(COMMUNITY_RESEARCH_CLAUDE_TIMEOUT_MS),
        body: JSON.stringify({
          // Single-listing mode runs on Sonnet (better world-
          // knowledge recall for niche named resorts like Santa
          // Maria Resort or Casa Playa Beach Resort). Combo mode
          // stays on Haiku — it's used inside the top-markets sweep
          // which iterates 12+ markets, so the Haiku speed/cost
          // advantage matters there. Single mode is per-operator-
          // click, so the per-call latency is acceptable.
          // For Hawaii cities in combo mode (Add Combo Listing tool), force
          // Sonnet + higher budget: exhaustive research for any HI city must
          // surface all qualifying VR condo/townhome resorts without operator
          // needing to ask Codex/Grok to manually add communities.
          model: (mode === "single" || isHawaii) ? "claude-sonnet-4-6" : "claude-haiku-4-5-20251001",
          max_tokens: (mode === "single" || isHawaii) ? 8000 : 4000,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      const claudeData = await claudeResp.json().catch(() => null) as any;

      if (!claudeResp.ok) {
        const upstreamMsg =
          claudeData?.error?.message ??
          claudeData?.error?.type ??
          `HTTP ${claudeResp.status}`;
        console.error(`[research] Anthropic ${claudeResp.status} for ${city}, ${state}: ${upstreamMsg}`);
      } else if (claudeData?.error) {
        const upstreamMsg = claudeData.error.message ?? claudeData.error.type ?? "unknown";
        console.error(`[research] Anthropic error envelope for ${city}, ${state}: ${upstreamMsg}`);
      } else {
        const text: string = claudeData?.content?.[0]?.text ?? "";
        // Tolerate Markdown fences and occasional multi-array output
        // such as `[]\n[{...}]`. The old greedy regex parsed that as
        // one invalid JSON string, which made valid city research look
        // empty in the UI.
        const scored = parseCommunityResearchJsonArray(text);
        if (!scored) {
          console.error(`[research] Claude returned no JSON array for ${city}, ${state}. Raw text head: ${text.slice(0, 200)}`);
        } else {
          // Single mode keeps up to 20; combo mode keeps the original 10.
          const sliceCap = mode === "single" ? 20 : 10;
          for (const s of scored.slice(0, sliceCap)) {
            // Hard post-filter. The prompt warns against villas/SFH, but
            // Claude occasionally lets one through. Drop anything whose
            // unitTypes or reason contains a disqualifying term.
            const check = checkCommunityType(s.unitTypes, s.reason);
            if (!check.eligible) {
              console.log(`[research] dropped "${s.communityName}" (${city}, ${state}): ${check.reason}`);
              continue;
            }
            const normalizedBedrooms = normalizeBedroomList(s.availableBedrooms);
            const normalizedBedroomUnitCounts = normalizeBedroomUnitCounts(s.estimatedBedroomUnitCounts);
            const normalizedMinimumStayNights = normalizeMinimumStayNights(s.minimumStayNights);
            const normalizedUnitsFromCounts = normalizedBedroomUnitCounts
              ? Object.values(normalizedBedroomUnitCounts).reduce((sum, count) => sum + count, 0)
              : undefined;
            const normalizedUnits = typeof s.estimatedTotalUnits === "number" && s.estimatedTotalUnits >= 0 && s.estimatedTotalUnits <= 50000
              ? Math.round(s.estimatedTotalUnits)
              : normalizedUnitsFromCounts;
            const normalized = mode === "single"
              ? applyKnownSingleListingFacts(String(s.communityName ?? ""), city, state, normalizedBedrooms, normalizedUnits)
              : { name: String(s.communityName ?? ""), availableBedrooms: normalizedBedrooms, estimatedTotalUnits: normalizedUnits };
            const rates = remainingRateSpotChecks-- > 0
              ? await spotCheckRate(normalized.name)
              : { low: null, high: null };
            results.push({
              name: normalized.name,
              city,
              state,
              estimatedLowRate: rates.low,
              estimatedHighRate: rates.high,
              unitTypes: s.unitTypes,
              confidenceScore: s.confidenceScore,
              researchSummary: s.reason,
              sourceUrl: s.sourceUrl || "",
              bedroomMix: s.bedroomMix,
              combinedBedroomsTypical: s.combinedBedroomsTypical,
              // Single mode doesn't ask for combinabilityScore — it
              // can come back undefined. The downstream sort uses 50
              // as the default when undefined, which is fine.
              combinabilityScore: typeof s.combinabilityScore === "number" ? s.combinabilityScore : undefined,
              fromWorldKnowledge: s.fromWorldKnowledge === true,
              // Filter to integers in [1,12] and dedupe. Single
              // mode uses this to render bedroom buttons; combo
              // mode uses it as display context on research cards.
              availableBedrooms: normalized.availableBedrooms,
              // CODEX NOTE (2026-05-05, claude/biggest-resorts-first):
              // estimatedTotalUnits comes back as a plain integer
              // from Claude. Clamp to [0, 50000] to prevent a
              // misformatted response from breaking the wizard's
              // sort. 0 = Claude doesn't know.
              estimatedTotalUnits: normalized.estimatedTotalUnits,
              estimatedBedroomUnitCounts: normalizedBedroomUnitCounts,
              minimumStayNights: normalizedMinimumStayNights,
              minimumStayEvidence: typeof s.minimumStayEvidence === "string" ? s.minimumStayEvidence.trim().slice(0, 240) : "",
              minimumStaySourceUrl: typeof s.minimumStaySourceUrl === "string" ? s.minimumStaySourceUrl.trim() : "",
              addressHint: typeof s.addressHint === "string" && s.addressHint.trim() ? s.addressHint.trim() : undefined,
            });
          }
        }
      }
    } catch (e: any) {
      console.error(`[research] Claude exception for ${city}, ${state}: ${e.message}`);
    }
  } else {
    // No Claude — fall back to raw results (low-confidence)
    for (const r of unique.slice(0, 8)) {
      results.push({
        name: r.title?.split(" - ")[0]?.split(" | ")[0] ?? r.title,
        city,
        state,
        estimatedLowRate: null,
        estimatedHighRate: null,
        unitTypes: "Unknown",
        confidenceScore: 50,
        researchSummary: r.snippet,
        sourceUrl: r.link,
      });
    }
  }

  if (mode === "single") {
    const knownSeeds = knownSingleListingSeedsForCity(cityForQuery, stateForQuery);
    for (const seed of knownSeeds) {
      const existing = results.find((r) =>
        normalizeCommunityName(r.name) === normalizeCommunityName(seed.name) &&
        r.city.toLowerCase() === seed.city.toLowerCase() &&
        r.state.toLowerCase() === seed.state.toLowerCase(),
      );
      if (existing) {
        existing.availableBedrooms = existing.availableBedrooms?.length ? existing.availableBedrooms : seed.availableBedrooms;
        existing.estimatedTotalUnits = existing.estimatedTotalUnits && existing.estimatedTotalUnits > 0
          ? existing.estimatedTotalUnits
          : seed.estimatedTotalUnits;
        existing.unitTypes = existing.unitTypes || seed.unitTypes;
        existing.researchSummary = existing.researchSummary || seed.researchSummary;
        existing.fromWorldKnowledge = existing.fromWorldKnowledge || seed.fromWorldKnowledge;
        existing.confidenceScore = Math.max(existing.confidenceScore ?? 0, seed.confidenceScore);
      } else {
        results.push(seed);
      }
    }
  }

  if (mode === "combo") {
    for (const seed of knownComboSeeds) {
      const existing = results.find((r) =>
        normalizeCommunityName(r.name) === normalizeCommunityName(seed.name) &&
        r.city.toLowerCase() === seed.city.toLowerCase() &&
        r.state.toLowerCase() === seed.state.toLowerCase(),
      );
      if (!existing) results.push(seed);
    }
  }

  results.sort((a, b) => {
    const sa = a.confidenceScore + (a.combinabilityScore ?? 50);
    const sb = b.confidenceScore + (b.combinabilityScore ?? 50);
    return sb - sa;
  });
  const deduped: ResearchedCommunity[] = [];
  const seenCommunities = new Set<string>();
  for (const result of results) {
    const key = `${normalizeCommunityName(result.name)}|${result.city.toLowerCase()}|${result.state.toLowerCase()}`;
    if (seenCommunities.has(key)) continue;
    seenCommunities.add(key);
    deduped.push(result);
  }
  return deduped;
}

// ─── TOP MARKETS ─────────────────────────────────────────────────────────────
// Curated list of US vacation-rental hotspots known for individually-owned
// condo/townhome inventory. Used by /api/community/scan-top-markets to
// auto-discover untapped communities across all of them.
//
// Criteria for inclusion:
//   - Strong Airbnb/VRBO presence
//   - Known condo/townhome inventory (not just SFRs)
//   - Geographically diverse (coast, ski, desert, mountain)

export type TopMarketSeed = {
  city: string;
  state: string;
  tag: string;
  estimatedComboLow: number;
  estimatedComboHigh: number;
  sixBedroomPossible?: boolean;
};

export const TOP_MARKET_SEEDS: TopMarketSeed[] = [
  // Gulf Coast Florida — classic condo country
  { city: "Fort Myers Beach",    state: "Florida",        tag: "Gulf Coast", estimatedComboLow: 450, estimatedComboHigh: 850, sixBedroomPossible: true },
  { city: "Destin",              state: "Florida",        tag: "Gulf Coast", estimatedComboLow: 500, estimatedComboHigh: 950, sixBedroomPossible: true },
  { city: "Panama City Beach",   state: "Florida",        tag: "Gulf Coast", estimatedComboLow: 375, estimatedComboHigh: 750, sixBedroomPossible: true },
  { city: "Santa Rosa Beach",    state: "Florida",        tag: "30A",        estimatedComboLow: 650, estimatedComboHigh: 1200, sixBedroomPossible: true },
  { city: "Naples",              state: "Florida",        tag: "Gulf Coast", estimatedComboLow: 500, estimatedComboHigh: 950, sixBedroomPossible: true },
  // Atlantic Florida + Southeast
  { city: "Clearwater Beach",    state: "Florida",        tag: "Gulf Coast", estimatedComboLow: 450, estimatedComboHigh: 850, sixBedroomPossible: true },
  { city: "Hilton Head",         state: "South Carolina", tag: "Atlantic",   estimatedComboLow: 500, estimatedComboHigh: 1000, sixBedroomPossible: true },
  { city: "Myrtle Beach",        state: "South Carolina", tag: "Atlantic",   estimatedComboLow: 300, estimatedComboHigh: 650, sixBedroomPossible: true },
  // Gulf Alabama
  { city: "Gulf Shores",         state: "Alabama",        tag: "Gulf Coast", estimatedComboLow: 350, estimatedComboHigh: 700, sixBedroomPossible: true },
  { city: "Orange Beach",        state: "Alabama",        tag: "Gulf Coast", estimatedComboLow: 425, estimatedComboHigh: 850, sixBedroomPossible: true },
  // Tennessee Smokies — condo/cabin mix (cabins dominate; fewer shared-wall 3BR condo pairs)
  { city: "Gatlinburg",          state: "Tennessee",      tag: "Smokies",    estimatedComboLow: 450, estimatedComboHigh: 900, sixBedroomPossible: false },
  { city: "Pigeon Forge",        state: "Tennessee",      tag: "Smokies",    estimatedComboLow: 450, estimatedComboHigh: 900, sixBedroomPossible: false },
  // Mountain West — ski condos
  { city: "Breckenridge",        state: "Colorado",       tag: "Ski",        estimatedComboLow: 700, estimatedComboHigh: 1400, sixBedroomPossible: true },
  { city: "Park City",           state: "Utah",           tag: "Ski",        estimatedComboLow: 750, estimatedComboHigh: 1500, sixBedroomPossible: true },
  { city: "Mammoth Lakes",       state: "California",     tag: "Ski",        estimatedComboLow: 650, estimatedComboHigh: 1300, sixBedroomPossible: true },
  // Desert / SoCal
  { city: "Palm Springs",        state: "California",     tag: "Desert",     estimatedComboLow: 550, estimatedComboHigh: 1100, sixBedroomPossible: true },
  // Texas coast
  { city: "South Padre Island",  state: "Texas",          tag: "Gulf Coast", estimatedComboLow: 300, estimatedComboHigh: 650, sixBedroomPossible: true },
  { city: "Galveston",           state: "Texas",          tag: "Gulf Coast", estimatedComboLow: 325, estimatedComboHigh: 700, sixBedroomPossible: true },
  // Hawaii - operator home market. These are intentionally city/area
  // seeds, not individual resort names; the research pipeline then
  // discovers the actual condo/townhome communities inside each market.
  // Kauai
  { city: "Koloa",               state: "Hawaii",         tag: "Hawaii - Kauai",       estimatedComboLow: 850, estimatedComboHigh: 1900, sixBedroomPossible: true },
  { city: "Poipu",               state: "Hawaii",         tag: "Hawaii - Kauai",       estimatedComboLow: 900, estimatedComboHigh: 2000, sixBedroomPossible: true },
  { city: "Princeville",         state: "Hawaii",         tag: "Hawaii - Kauai",       estimatedComboLow: 850, estimatedComboHigh: 1800, sixBedroomPossible: true },
  { city: "Hanalei",             state: "Hawaii",         tag: "Hawaii - Kauai",       estimatedComboLow: 900, estimatedComboHigh: 2000, sixBedroomPossible: true },
  { city: "Wainiha",             state: "Hawaii",         tag: "Hawaii - Kauai",       estimatedComboLow: 800, estimatedComboHigh: 1800, sixBedroomPossible: true },
  { city: "Haena",               state: "Hawaii",         tag: "Hawaii - Kauai",       estimatedComboLow: 850, estimatedComboHigh: 1900, sixBedroomPossible: true },
  { city: "Kilauea",             state: "Hawaii",         tag: "Hawaii - Kauai",       estimatedComboLow: 750, estimatedComboHigh: 1600, sixBedroomPossible: true },
  { city: "Kapaa",               state: "Hawaii",         tag: "Hawaii - Kauai",       estimatedComboLow: 700, estimatedComboHigh: 1500, sixBedroomPossible: true },
  { city: "Wailua",              state: "Hawaii",         tag: "Hawaii - Kauai",       estimatedComboLow: 700, estimatedComboHigh: 1500, sixBedroomPossible: true },
  { city: "Waipouli",            state: "Hawaii",         tag: "Hawaii - Kauai",       estimatedComboLow: 725, estimatedComboHigh: 1550, sixBedroomPossible: true },
  { city: "Lihue",               state: "Hawaii",         tag: "Hawaii - Kauai",       estimatedComboLow: 650, estimatedComboHigh: 1400, sixBedroomPossible: true },
  { city: "Nawiliwili",          state: "Hawaii",         tag: "Hawaii - Kauai",       estimatedComboLow: 650, estimatedComboHigh: 1400, sixBedroomPossible: true },
  { city: "Puhi",                state: "Hawaii",         tag: "Hawaii - Kauai",       estimatedComboLow: 600, estimatedComboHigh: 1300, sixBedroomPossible: true },
  { city: "Kalaheo",             state: "Hawaii",         tag: "Hawaii - Kauai",       estimatedComboLow: 650, estimatedComboHigh: 1400, sixBedroomPossible: true },
  { city: "Lawai",               state: "Hawaii",         tag: "Hawaii - Kauai",       estimatedComboLow: 650, estimatedComboHigh: 1400, sixBedroomPossible: true },
  { city: "Eleele",              state: "Hawaii",         tag: "Hawaii - Kauai",       estimatedComboLow: 600, estimatedComboHigh: 1300, sixBedroomPossible: true },
  { city: "Hanapepe",            state: "Hawaii",         tag: "Hawaii - Kauai",       estimatedComboLow: 600, estimatedComboHigh: 1300, sixBedroomPossible: true },
  { city: "Port Allen",          state: "Hawaii",         tag: "Hawaii - Kauai",       estimatedComboLow: 600, estimatedComboHigh: 1300, sixBedroomPossible: true },
  { city: "Waimea",              state: "Hawaii",         tag: "Hawaii - Kauai",       estimatedComboLow: 600, estimatedComboHigh: 1300, sixBedroomPossible: true },
  { city: "Kekaha",              state: "Hawaii",         tag: "Hawaii - Kauai",       estimatedComboLow: 575, estimatedComboHigh: 1200, sixBedroomPossible: true },
  { city: "Kaumakani",           state: "Hawaii",         tag: "Hawaii - Kauai",       estimatedComboLow: 575, estimatedComboHigh: 1200, sixBedroomPossible: true },
  { city: "Numila",              state: "Hawaii",         tag: "Hawaii - Kauai",       estimatedComboLow: 575, estimatedComboHigh: 1200, sixBedroomPossible: true },
  // Maui
  { city: "Kihei",               state: "Hawaii",         tag: "Hawaii - Maui",        estimatedComboLow: 850, estimatedComboHigh: 1700, sixBedroomPossible: true },
  { city: "Wailea",              state: "Hawaii",         tag: "Hawaii - Maui",        estimatedComboLow: 1000, estimatedComboHigh: 2300, sixBedroomPossible: true },
  { city: "Makena",              state: "Hawaii",         tag: "Hawaii - Maui",        estimatedComboLow: 1000, estimatedComboHigh: 2300, sixBedroomPossible: true },
  { city: "Maalaea",             state: "Hawaii",         tag: "Hawaii - Maui",        estimatedComboLow: 750, estimatedComboHigh: 1600, sixBedroomPossible: true },
  { city: "Lahaina",             state: "Hawaii",         tag: "Hawaii - Maui",        estimatedComboLow: 900, estimatedComboHigh: 2100, sixBedroomPossible: true },
  { city: "Kaanapali",           state: "Hawaii",         tag: "Hawaii - Maui",        estimatedComboLow: 1000, estimatedComboHigh: 2400, sixBedroomPossible: true },
  { city: "Kapalua",             state: "Hawaii",         tag: "Hawaii - Maui",        estimatedComboLow: 1000, estimatedComboHigh: 2400, sixBedroomPossible: true },
  { city: "Napili-Honokowai",    state: "Hawaii",         tag: "Hawaii - Maui",        estimatedComboLow: 850, estimatedComboHigh: 1900, sixBedroomPossible: true },
  { city: "Kahana",              state: "Hawaii",         tag: "Hawaii - Maui",        estimatedComboLow: 850, estimatedComboHigh: 1900, sixBedroomPossible: true },
  { city: "Honokowai",           state: "Hawaii",         tag: "Hawaii - Maui",        estimatedComboLow: 800, estimatedComboHigh: 1800, sixBedroomPossible: true },
  { city: "Wailuku",             state: "Hawaii",         tag: "Hawaii - Maui",        estimatedComboLow: 650, estimatedComboHigh: 1400, sixBedroomPossible: true },
  { city: "Kahului",             state: "Hawaii",         tag: "Hawaii - Maui",        estimatedComboLow: 625, estimatedComboHigh: 1300, sixBedroomPossible: true },
  { city: "Paia",                state: "Hawaii",         tag: "Hawaii - Maui",        estimatedComboLow: 700, estimatedComboHigh: 1500, sixBedroomPossible: true },
  { city: "Hana",                state: "Hawaii",         tag: "Hawaii - Maui",        estimatedComboLow: 700, estimatedComboHigh: 1500, sixBedroomPossible: true },
  // Big Island
  { city: "Kailua-Kona",         state: "Hawaii",         tag: "Hawaii - Big Island",  estimatedComboLow: 750, estimatedComboHigh: 1500, sixBedroomPossible: true },
  { city: "Keauhou",             state: "Hawaii",         tag: "Hawaii - Big Island",  estimatedComboLow: 775, estimatedComboHigh: 1600, sixBedroomPossible: true },
  { city: "Holualoa",            state: "Hawaii",         tag: "Hawaii - Big Island",  estimatedComboLow: 700, estimatedComboHigh: 1500, sixBedroomPossible: true },
  { city: "Captain Cook",        state: "Hawaii",         tag: "Hawaii - Big Island",  estimatedComboLow: 675, estimatedComboHigh: 1400, sixBedroomPossible: true },
  { city: "Waikoloa",            state: "Hawaii",         tag: "Hawaii - Big Island",  estimatedComboLow: 800, estimatedComboHigh: 1700, sixBedroomPossible: true },
  { city: "Kohala Coast",        state: "Hawaii",         tag: "Hawaii - Big Island",  estimatedComboLow: 950, estimatedComboHigh: 2200, sixBedroomPossible: true },
  { city: "Mauna Lani",          state: "Hawaii",         tag: "Hawaii - Big Island",  estimatedComboLow: 950, estimatedComboHigh: 2200, sixBedroomPossible: true },
  { city: "Mauna Kea",           state: "Hawaii",         tag: "Hawaii - Big Island",  estimatedComboLow: 950, estimatedComboHigh: 2200, sixBedroomPossible: true },
  { city: "Puako",               state: "Hawaii",         tag: "Hawaii - Big Island",  estimatedComboLow: 875, estimatedComboHigh: 1900, sixBedroomPossible: true },
  { city: "Kamuela",             state: "Hawaii",         tag: "Hawaii - Big Island",  estimatedComboLow: 700, estimatedComboHigh: 1500, sixBedroomPossible: true },
  { city: "Hilo",                state: "Hawaii",         tag: "Hawaii - Big Island",  estimatedComboLow: 550, estimatedComboHigh: 1200, sixBedroomPossible: true },
  { city: "Volcano",             state: "Hawaii",         tag: "Hawaii - Big Island",  estimatedComboLow: 550, estimatedComboHigh: 1200, sixBedroomPossible: true },
  { city: "Pahoa",               state: "Hawaii",         tag: "Hawaii - Big Island",  estimatedComboLow: 500, estimatedComboHigh: 1100, sixBedroomPossible: true },
  { city: "Punaluu",             state: "Hawaii",         tag: "Hawaii - Big Island",  estimatedComboLow: 500, estimatedComboHigh: 1100, sixBedroomPossible: true },
  { city: "Pahala",              state: "Hawaii",         tag: "Hawaii - Big Island",  estimatedComboLow: 500, estimatedComboHigh: 1100, sixBedroomPossible: true },
  { city: "Naalehu",             state: "Hawaii",         tag: "Hawaii - Big Island",  estimatedComboLow: 500, estimatedComboHigh: 1100, sixBedroomPossible: true },
  // Oahu
  { city: "Kapolei",             state: "Hawaii",         tag: "Hawaii - Oahu",        estimatedComboLow: 850, estimatedComboHigh: 1800, sixBedroomPossible: true },
  { city: "Ko Olina",            state: "Hawaii",         tag: "Hawaii - Oahu",        estimatedComboLow: 950, estimatedComboHigh: 2100, sixBedroomPossible: true },
  { city: "Honolulu",            state: "Hawaii",         tag: "Hawaii - Oahu",        estimatedComboLow: 700, estimatedComboHigh: 1600, sixBedroomPossible: true },
  { city: "Waikiki",             state: "Hawaii",         tag: "Hawaii - Oahu",        estimatedComboLow: 750, estimatedComboHigh: 1700, sixBedroomPossible: true },
  { city: "Kailua",              state: "Hawaii",         tag: "Hawaii - Oahu",        estimatedComboLow: 750, estimatedComboHigh: 1700, sixBedroomPossible: true },
  { city: "Kaneohe",             state: "Hawaii",         tag: "Hawaii - Oahu",        estimatedComboLow: 650, estimatedComboHigh: 1500, sixBedroomPossible: true },
  { city: "Kahuku",              state: "Hawaii",         tag: "Hawaii - Oahu",        estimatedComboLow: 800, estimatedComboHigh: 1800, sixBedroomPossible: true },
  { city: "Turtle Bay",          state: "Hawaii",         tag: "Hawaii - Oahu",        estimatedComboLow: 900, estimatedComboHigh: 2000, sixBedroomPossible: true },
  { city: "Haleiwa",             state: "Hawaii",         tag: "Hawaii - Oahu",        estimatedComboLow: 700, estimatedComboHigh: 1600, sixBedroomPossible: true },
  { city: "Laie",                state: "Hawaii",         tag: "Hawaii - Oahu",        estimatedComboLow: 650, estimatedComboHigh: 1450, sixBedroomPossible: true },
  { city: "Waianae",             state: "Hawaii",         tag: "Hawaii - Oahu",        estimatedComboLow: 600, estimatedComboHigh: 1350, sixBedroomPossible: true },
  { city: "Makaha",              state: "Hawaii",         tag: "Hawaii - Oahu",        estimatedComboLow: 600, estimatedComboHigh: 1350, sixBedroomPossible: true },
  { city: "Ewa Beach",           state: "Hawaii",         tag: "Hawaii - Oahu",        estimatedComboLow: 650, estimatedComboHigh: 1450, sixBedroomPossible: true },
  // Molokai and Lanai
  { city: "Kaunakakai",          state: "Hawaii",         tag: "Hawaii - Molokai",     estimatedComboLow: 450, estimatedComboHigh: 950, sixBedroomPossible: true },
  { city: "Maunaloa",            state: "Hawaii",         tag: "Hawaii - Molokai",     estimatedComboLow: 450, estimatedComboHigh: 950, sixBedroomPossible: true },
  { city: "Lanai City",          state: "Hawaii",         tag: "Hawaii - Lanai",       estimatedComboLow: 600, estimatedComboHigh: 1300, sixBedroomPossible: true },
];
