export type GuestyBedType = "KING_BED" | "QUEEN_BED" | "SINGLE_BED" | "SOFA_BED" | "DOUBLE_BED" | "BUNK_BED";

export type GuestyBed = { type: GuestyBedType; quantity: number };

export type GuestyRoom = {
  roomNumber: number;
  name?: string;   // e.g. "Master Bedroom", "Bedroom 2", "Living Room"
  beds: GuestyBed[];
};

export type GuestyUnitConfig = {
  unitId: string;
  rooms: GuestyRoom[];
};

export type GuestyPropertyConfig = {
  propertyId: number;
  publicAddress: string;
  units: GuestyUnitConfig[];
};

const k = (n = 1): GuestyBed => ({ type: "KING_BED", quantity: n });
const q = (n = 1): GuestyBed => ({ type: "QUEEN_BED", quantity: n });
const tw = (n = 2): GuestyBed => ({ type: "SINGLE_BED", quantity: n });
const sofa = (): GuestyBed => ({ type: "SOFA_BED", quantity: 1 });

function room(num: number, ...beds: GuestyBed[]): GuestyRoom {
  return { roomNumber: num, beds };
}
function living(...beds: GuestyBed[]): GuestyRoom {
  return { roomNumber: 0, beds };
}

export const GUESTY_PROPERTY_CONFIGS: GuestyPropertyConfig[] = [
  {
    propertyId: 1,
    publicAddress: "1941 Poipu Rd, Koloa, HI 96756",
    units: [
      { unitId: "unit-924", rooms: [room(1, k()), room(2, q()), room(3, tw()), living(sofa())] },
      { unitId: "unit-114", rooms: [room(1, q()), room(2, k()), living(sofa())] },
      { unitId: "unit-911", rooms: [room(1, k()), room(2, k()), living(sofa())] },
    ],
  },
  {
    propertyId: 4,
    publicAddress: "1941 Poipu Rd, Unit 423, Koloa, HI 96756",
    units: [
      { unitId: "unit-423", rooms: [room(1, k()), room(2, q()), room(3, tw()), living(sofa())] },
      { unitId: "unit-621", rooms: [room(1, k()), room(2, q()), room(3, tw()), living(sofa())] },
    ],
  },
  {
    propertyId: 7,
    publicAddress: "1941 Poipu Rd, Koloa, HI 96756",
    units: [
      { unitId: "prop7-3br-a", rooms: [room(1, k()), room(2, q()), room(3, tw()), living(sofa())] },
      { unitId: "prop7-3br-b", rooms: [room(1, k()), room(2, q()), room(3, tw())] },
      { unitId: "prop7-2br",   rooms: [room(1, q()), room(2, k()), living(sofa())] },
    ],
  },
  {
    propertyId: 8,
    publicAddress: "1941 Poipu Rd, Koloa, HI 96756",
    units: [
      { unitId: "prop8-3br-a", rooms: [room(1, k()), room(2, q()), room(3, tw()), living(sofa())] },
      { unitId: "prop8-3br-b", rooms: [room(1, k()), room(2, q()), room(3, tw()), living(sofa())] },
    ],
  },
  {
    propertyId: 9,
    publicAddress: "1941 Poipu Rd, Koloa, HI 96756",
    units: [
      { unitId: "prop9-3br", rooms: [room(1, k()), room(2, q()), room(3, tw()), living(sofa())] },
      { unitId: "prop9-2br", rooms: [room(1, q()), room(2, k())] },
    ],
  },
  {
    propertyId: 10,
    publicAddress: "8497 Kekaha Rd, Kekaha, HI 96752",
    units: [
      { unitId: "prop10-home",    rooms: [room(1, k()), room(2, q()), room(3, tw()), living(sofa())] },
      { unitId: "prop10-cottage", rooms: [room(1, k()), room(2, q()), living(sofa())] },
    ],
  },
  {
    propertyId: 12,
    publicAddress: "8515 Kekaha Rd, Kekaha, HI 96752",
    units: [
      { unitId: "prop12-home",    rooms: [room(1, k()), room(2, q())] },
      { unitId: "prop12-cottage", rooms: [room(1, k())] },
    ],
  },
  {
    propertyId: 14,
    publicAddress: "78-6855 Ali'i Dr, Kailua-Kona, HI 96740",
    units: [
      { unitId: "prop14-estate",  rooms: [room(1, k()), room(2, k()), room(3, k()), room(4, k())] },
      { unitId: "prop14-casita",  rooms: [room(1, k()), room(2, k())] },
    ],
  },
  {
    propertyId: 18,
    publicAddress: "1941 Poipu Rd, Koloa, HI 96756",
    units: [
      { unitId: "prop18-3br-a", rooms: [room(1, k()), room(2, q()), room(3, tw()), living(sofa())] },
      { unitId: "prop18-3br-b", rooms: [room(1, k()), room(2, q()), room(3, tw()), living(sofa())] },
    ],
  },
  {
    propertyId: 19,
    publicAddress: "3920 Wyllie Rd, Unit 9, Princeville, HI 96722",
    units: [
      { unitId: "prop19-3br", rooms: [room(1, k()), room(2, q()), living(sofa())] },
      { unitId: "prop19-2br", rooms: [room(1, q()), living(sofa())] },
    ],
  },
  {
    propertyId: 20,
    publicAddress: "3920 Wyllie Rd, Unit 7B, Princeville, HI 96722",
    units: [
      { unitId: "prop20-3br-a", rooms: [room(1, k()), room(2, q()), living(sofa())] },
      { unitId: "prop20-3br-b", rooms: [room(1, k()), room(2, q()), room(3, tw()), living(sofa())] },
    ],
  },
  {
    propertyId: 21,
    publicAddress: "1941 Poipu Rd, Koloa, HI 96756",
    units: [
      { unitId: "prop21-3br-a", rooms: [room(1, k()), room(2, q()), room(3, tw())] },
      { unitId: "prop21-3br-b", rooms: [room(1, k()), room(2, q()), room(3, tw()), living(sofa())] },
      { unitId: "prop21-2br",   rooms: [room(1, k()), room(2, k()), living(sofa())] },
    ],
  },
  {
    propertyId: 23,
    publicAddress: "Kaha Lani Resort, 4460 Nehe Rd, Kapaa, HI 96746",
    units: [
      { unitId: "prop23-3br", rooms: [room(1, k()), room(2, q()), room(3, tw()), living(sofa())] },
      { unitId: "prop23-2br", rooms: [room(1, k()), room(2, q())] },
    ],
  },
  {
    propertyId: 24,
    publicAddress: "Makahuena at Poipu, 1661 Pe'e Rd, Koloa, HI 96756",
    units: [
      { unitId: "prop24-3br", rooms: [room(1, k()), room(2, q()), room(3, tw()), living(sofa())] },
      { unitId: "prop24-2br", rooms: [room(1, k()), room(2, q()), living(sofa())] },
    ],
  },
  {
    propertyId: 26,
    publicAddress: "78-6920 Ali'i Dr, Kailua-Kona, HI 96740",
    units: [
      { unitId: "prop26-estate-main",  rooms: [room(1, k()), room(2, k()), room(3, k()), room(4, k()), room(5, k())] },
      { unitId: "prop26-estate-guest", rooms: [room(1, k()), room(2, k())] },
    ],
  },
  {
    propertyId: 27,
    publicAddress: "1941 Poipu Rd, Unit 114, Koloa, HI 96756",
    units: [
      { unitId: "prop27-unit-a", rooms: [room(1, k()), room(2, q()), living(sofa())] },
      { unitId: "prop27-unit-b", rooms: [room(1, k()), room(2, k()), living(sofa())] },
    ],
  },
  {
    propertyId: 28,
    publicAddress: "2298 Ho'one Rd, Koloa, HI 96756",
    units: [
      { unitId: "prop28-house-a", rooms: [room(1, k()), room(2, q()), room(3, tw()), living(sofa())] },
      { unitId: "prop28-house-b", rooms: [room(1, k()), room(2, q()), room(3, tw()), living(sofa())] },
    ],
  },
  {
    propertyId: 29,
    publicAddress: "4100 Queen Emma's Dr, Princeville, HI 96722",
    units: [
      { unitId: "prop29-kai-3br", rooms: [room(1, k()), room(2, q()), room(3, tw()), living(sofa())] },
      { unitId: "prop29-kai-4br", rooms: [room(1, k()), room(2, q()), room(3, k()), room(4, q()), living(sofa()), living(sofa())] },
    ],
  },
  {
    propertyId: 31,
    publicAddress: "2350 Ho'one Rd, Koloa, HI 96756",
    units: [
      { unitId: "prop31-main",  rooms: [room(1, k()), room(2, q()), room(3, q()), room(4, tw()), living(sofa())] },
      { unitId: "prop31-guest", rooms: [room(1, q()), room(2, q())] },
    ],
  },
  {
    propertyId: 32,
    publicAddress: "2611 Kiahuna Plantation Dr, Bldg 38, Koloa, HI 96756",
    units: [
      { unitId: "prop32-kia-3br", rooms: [room(1, k()), room(2, q()), room(3, tw()), living(sofa())] },
      { unitId: "prop32-kia-2br", rooms: [room(1, k()), room(2, q()), living(sofa())] },
    ],
  },
  {
    propertyId: 33,
    publicAddress: "2611 Kiahuna Plantation Dr, Bldg 10, Koloa, HI 96756",
    units: [
      { unitId: "prop33-kia-3br-a", rooms: [room(1, k()), room(2, q()), room(3, tw()), living(sofa())] },
      { unitId: "prop33-kia-3br-b", rooms: [room(1, k()), room(2, q()), room(3, tw()), living(sofa())] },
    ],
  },
  {
    propertyId: 34,
    publicAddress: "1941 Poipu Rd, Koloa, HI 96756",
    units: [
      { unitId: "unit-524", rooms: [room(1, k()), room(2, q()), room(3, tw()), living(sofa())] },
      { unitId: "unit-324", rooms: [room(1, k()), room(2, q()), room(3, tw()), living(sofa())] },
    ],
  },
];

export function getPropertyConfig(propertyId: number): GuestyPropertyConfig | undefined {
  return GUESTY_PROPERTY_CONFIGS.find((c) => c.propertyId === propertyId);
}

export function buildListingRooms(propertyId: number): GuestyRoom[] {
  const config = getPropertyConfig(propertyId);
  if (!config) return [];

  const allRooms: GuestyRoom[] = [];
  let bedroomCounter = 1;

  for (const unit of config.units) {
    for (const room of unit.rooms) {
      if (room.roomNumber > 0) {
        allRooms.push({ roomNumber: bedroomCounter++, beds: room.beds });
      } else {
        allRooms.push({ roomNumber: 0, beds: room.beds });
      }
    }
  }
  return allRooms;
}

// The set of bed `type` values Guesty's PUT /listings actually accepts —
// VERIFIED empirically against the live Open API (2026-06-16). Anything else
// (FUTON, MURPHY_BED, FULL_BED, TWIN_BED, a bare "KING", null, …) makes the
// whole update fail with HTTP 500 { code: ERR_UPDATE_LISTING_FAILED,
// message: "Unknown error when updating listing" } — the opaque error the
// operator hit on the bedding push. This is the ACTUAL root cause (duplicate
// roomNumber 0 is fine — Guesty accepts it; see dedupeListingRoomsByNumber,
// kept only because one shared space is cleaner).
const VALID_GUESTY_BED_TYPES = new Set<string>([
  "KING_BED", "QUEEN_BED", "DOUBLE_BED", "SINGLE_BED", "SOFA_BED", "BUNK_BED",
  "AIR_MATTRESS", "FLOOR_MATTRESS", "WATER_BED", "TODDLER_BED", "CRIB", "COUCH",
]);

// Legacy / alias / shorthand bed-type values (e.g. stale localStorage configs,
// the "twin" wording) → the nearest VALID Guesty enum.
const BED_TYPE_ALIASES: Record<string, string> = {
  TWIN_BED: "SINGLE_BED", TWIN: "SINGLE_BED", SINGLE: "SINGLE_BED",
  FULL_BED: "DOUBLE_BED", FULL: "DOUBLE_BED", DOUBLE: "DOUBLE_BED",
  KING: "KING_BED", QUEEN: "QUEEN_BED", BUNK: "BUNK_BED",
  SOFA: "SOFA_BED", SOFABED: "SOFA_BED", SLEEPER: "SOFA_BED",
  PULLOUT: "SOFA_BED", PULL_OUT: "SOFA_BED", FUTON: "SOFA_BED",
  MURPHY: "QUEEN_BED", MURPHY_BED: "QUEEN_BED", WALL_BED: "QUEEN_BED",
};

// Map any bed-type string to a Guesty-accepted enum, or null if unmappable.
export function normalizeGuestyBedType(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const up = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!up) return null;
  if (VALID_GUESTY_BED_TYPES.has(up)) return up;
  if (BED_TYPE_ALIASES[up]) return BED_TYPE_ALIASES[up];
  if (VALID_GUESTY_BED_TYPES.has(`${up}_BED`)) return `${up}_BED`;
  return null;
}

// Coerce every bed in every room to a Guesty-accepted type, dropping beds whose
// type cannot be mapped. Without this, a single bad bed type (legacy localStorage
// data) makes the ENTIRE bedding push fail with the opaque "Unknown error when
// updating listing". An empty beds[] is fine — Guesty accepts it.
export function sanitizeListingRoomsForGuesty<
  R extends { roomNumber: number; name?: string; beds: Array<{ type: string; quantity: number }> },
>(rooms: R[]): R[] {
  return rooms.map((r) => ({
    ...r,
    beds: r.beds.flatMap((b) => {
      const type = normalizeGuestyBedType(b.type);
      return type ? [{ ...b, type }] : [];
    }),
  }) as R);
}

// Guesty models exactly ONE shared space per listing at roomNumber 0; bedrooms
// are 1..N. Both room builders above emit one roomNumber-0 "Living Room" entry
// PER unit, so a multi-unit combo emits TWO roomNumber-0 rooms. Guesty actually
// ACCEPTS duplicate roomNumbers, but collapsing them into one shared space
// (summing sofa beds, e.g. SOFA_BED x2) matches Guesty/Airbnb's one-shared-space
// model and is cleaner. Insertion order preserved; first non-empty name wins.
export function dedupeListingRoomsByNumber<
  R extends { roomNumber: number; name?: string; beds: Array<{ type: string; quantity: number }> },
>(rooms: R[]): R[] {
  const byNumber = new Map<number, R>();
  for (const r of rooms) {
    const existing = byNumber.get(r.roomNumber);
    if (!existing) {
      byNumber.set(r.roomNumber, { ...r, beds: r.beds.map((b) => ({ ...b })) } as R);
      continue;
    }
    for (const bed of r.beds) {
      const match = existing.beds.find((b) => b.type === bed.type);
      if (match) match.quantity += bed.quantity;
      else existing.beds.push({ ...bed });
    }
    if (!existing.name && r.name) existing.name = r.name;
  }
  return Array.from(byNumber.values());
}

// Keep the "Sleeps N" token in a listing title in sync with the bed-derived
// occupancy (accommodates). The operator hit a listing whose title said
// "Sleeps 14" and Guesty said 12 while the beds actually sleep 16 — three
// different numbers. The bed config is the source of truth, so this rewrites
// ONLY an existing "Sleeps <number>" token to match it (preserving the rest of
// the title and the word's casing). Titles without a "Sleeps N" token, and
// non-positive counts, are returned unchanged (never append one).
export function syncSleepsInTitle(title: string, sleeps: number): string {
  if (!title || !Number.isFinite(sleeps) || sleeps <= 0) return title;
  return title.replace(/\bsleeps\s+\d+\b/i, (token) => token.replace(/\d+/, String(sleeps)));
}

// Keep occupancy numbers in the DESCRIPTION body in sync with the listing's
// sleeps. After an occupancy change the AI-written prose still says things like
// "Sleep up to 14 guests" / "accommodate up to 14 guests". This rewrites only
// the LISTING-LEVEL "... N guests" occupancy phrases to the total sleeps; it
// deliberately leaves bedroom counts ("two 3-bedroom condos"), square footage,
// and per-unit "Sleeps N with <beds>" sentences (which describe one unit's beds,
// not the whole-listing total) untouched — those have no "guests" token.
export function syncSleepsInDescription(text: string, sleeps: number): string {
  if (!text || !Number.isFinite(sleeps) || sleeps <= 0) return text;
  return text
    // "Sleep(s)/Sleeping/accommodate(s)/host(s) [up to] N guests"
    .replace(
      /((?:sleeps?|sleeping|accommodates?|hosts?)\s+(?:up\s+to\s+)?)\d+(\s+guests?\b)/gi,
      (_m, pre, post) => `${pre}${sleeps}${post}`,
    )
    // bare "up to N guests" / "for N guests" not already caught above
    .replace(/(\b(?:up\s+to|for)\s+)\d+(\s+guests?\b)/gi, (_m, pre, post) => `${pre}${sleeps}${post}`);
}

export function parseSqft(sqftStr: string): number {
  return parseInt(sqftStr.replace(/[^0-9]/g, ""), 10) || 0;
}
