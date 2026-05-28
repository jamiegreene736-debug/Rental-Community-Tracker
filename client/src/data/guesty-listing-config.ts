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

export function parseSqft(sqftStr: string): number {
  return parseInt(sqftStr.replace(/[^0-9]/g, ""), 10) || 0;
}
