// ─────────────────────────────────────────────────────────────────────────────
// BEDDING CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
// Methodology
// -----------
// Guesty's API exposes structured fields for:
//   - `bedrooms` (integer)
//   - `bathrooms` (decimal: 2.5 = 2 full + 1 half)
//   - `accommodates` (sleeps)
//   - `listingRooms[]` = [{ roomNumber, beds: [{ type, quantity }] }]
//       roomNumber: 0 = COMMON AREA (living room — used for sofa beds)
//       roomNumber: 1+ = bedroom #
//   - Bed types: KING_BED, QUEEN_BED, DOUBLE_BED, SINGLE_BED, SOFA_BED,
//                BUNK_BED, BABY_BED, AIR_MATTRESS, FLOOR_MATTRESS, WATER_BED
//
// Guesty does NOT model bathroom features structurally (shower vs tub vs
// ensuite). Those are conveyed two ways:
//   1. As AMENITIES (Bathtub, Walk-in shower, Jetted tub, Hair dryer, etc.)
//   2. Inside publicDescription.space free-text ("master with ensuite, jetted
//      tub and walk-in marble shower")
//
// So this module maintains a richer INTERNAL config that captures everything
// (per-bedroom labels, ensuite flag + features, per-bathroom features,
// half-bath, sofa beds in living room) and exports adapters that:
//   - flatten down to Guesty's listingRooms / bedrooms / bathrooms shape
//   - derive bath-related amenities to push (Bathtub, Walk-in shower, etc.)
//   - generate human descriptions for each unit (used in summary/space copy)
//
// Persistence
// -----------
// Default config is built from `GUESTY_PROPERTY_CONFIGS` (bed layout) +
// `unit-builder-data.ts` (bedrooms/bathrooms counts). User overrides are saved
// to localStorage under `nexstay_bedding_${propertyId}` so edits survive
// reloads without requiring a DB migration.
// ─────────────────────────────────────────────────────────────────────────────

import {
  GUESTY_PROPERTY_CONFIGS,
  type GuestyBedType,
  type GuestyBed,
  type GuestyRoom,
} from "./guesty-listing-config";
import { getUnitBuilderByPropertyId } from "./unit-builder-data";

// ── Types ────────────────────────────────────────────────────────────────────

export type BathFeature =
  | "walk-in-shower"
  | "shower-tub-combo"
  | "soaking-tub"
  | "jetted-tub"
  | "double-vanity"
  | "rain-shower";

export const BATH_FEATURE_LABELS: Record<BathFeature, string> = {
  "walk-in-shower":   "Walk-in shower",
  "shower-tub-combo": "Shower / tub combo",
  "soaking-tub":      "Soaking tub",
  "jetted-tub":       "Jetted tub",
  "double-vanity":    "Double vanity",
  "rain-shower":      "Rain shower",
};

export const BED_TYPE_LABELS: Record<GuestyBedType, string> = {
  KING_BED:   "King",
  QUEEN_BED:  "Queen",
  DOUBLE_BED: "Double / Full",
  SINGLE_BED: "Twin / Single",
  SOFA_BED:   "Sofa Bed",
  BUNK_BED:   "Bunk Bed",
};

export const BED_SLEEPS: Record<GuestyBedType, number> = {
  KING_BED:   2,
  QUEEN_BED:  2,
  DOUBLE_BED: 2,
  SINGLE_BED: 1,
  SOFA_BED:   2,
  BUNK_BED:   2,
};

export type BedroomDetail = {
  roomNumber: number;          // 1, 2, 3 …
  label: string;               // "Master Bedroom", "Guest Bedroom 2"
  beds: GuestyBed[];
  hasEnsuite: boolean;
  ensuiteFeatures: BathFeature[];
};

export type BathroomDetail = {
  id: string;                  // stable id for editor keys
  label: string;               // "Master Ensuite", "Hall Bath", "Powder Room"
  isHalf: boolean;             // half-bath = no shower/tub, counts as 0.5
  features: BathFeature[];
};

export type LivingRoomConfig = {
  hasSofaBed: boolean;
  sofaBedType: "SOFA_BED";     // future: queen-sleeper vs futon
  count: number;               // some big units have 2 sofa beds
};

export type UnitBeddingConfig = {
  unitId: string;
  unitLabel: string;
  bedrooms: BedroomDetail[];
  bathrooms: BathroomDetail[];
  livingRoom: LivingRoomConfig;
};

export type PropertyBeddingConfig = {
  propertyId: number;
  units: UnitBeddingConfig[];
};

// ── Defaults & derivation ────────────────────────────────────────────────────

const labelForBedroom = (idx: number): string =>
  idx === 0 ? "Master Bedroom" : `Bedroom ${idx + 1}`;

// Heuristic: most Hawaii vacation rentals = master ensuite (walk-in shower +
// soaking tub) + 1 hall bath (shower-tub combo). Half-baths only when the unit
// has a fractional bathroom count (e.g. 2.5).
function defaultBathrooms(bathroomCount: number, hasMasterEnsuite: boolean): BathroomDetail[] {
  const fullCount = Math.floor(bathroomCount);
  const halfCount = bathroomCount - fullCount > 0 ? 1 : 0;
  const out: BathroomDetail[] = [];
  for (let i = 0; i < fullCount; i++) {
    if (i === 0 && hasMasterEnsuite) {
      out.push({ id: `bath-${i}`, label: "Master Ensuite", isHalf: false,
                 features: ["walk-in-shower", "soaking-tub"] });
    } else {
      out.push({ id: `bath-${i}`, label: i === 0 ? "Hall Bath" : `Bath ${i + 1}`,
                 isHalf: false, features: ["shower-tub-combo"] });
    }
  }
  for (let i = 0; i < halfCount; i++) {
    out.push({ id: `bath-h${i}`, label: "Powder Room", isHalf: true, features: [] });
  }
  return out;
}

function buildDefaultUnitBedding(
  unitId: string,
  unitLabel: string,
  bedroomCount: number,
  bathroomCount: number,
  rooms: GuestyRoom[],
): UnitBeddingConfig {
  // Split rooms into bedrooms (roomNumber > 0) and living-room sofa beds (== 0).
  const bedroomRooms = rooms.filter(r => r.roomNumber > 0);
  const livingRooms  = rooms.filter(r => r.roomNumber === 0);

  const bedrooms: BedroomDetail[] = bedroomRooms.slice(0, bedroomCount).map((r, idx) => ({
    roomNumber: idx + 1,
    label: labelForBedroom(idx),
    beds: r.beds.length > 0 ? r.beds : [{ type: "QUEEN_BED", quantity: 1 }],
    hasEnsuite: idx === 0, // master = ensuite by default
    ensuiteFeatures: idx === 0 ? ["walk-in-shower", "soaking-tub"] : [],
  }));
  // If we have fewer bedroomRooms than bedroomCount, pad with queens.
  while (bedrooms.length < bedroomCount) {
    const idx = bedrooms.length;
    bedrooms.push({
      roomNumber: idx + 1,
      label: labelForBedroom(idx),
      beds: [{ type: "QUEEN_BED", quantity: 1 }],
      hasEnsuite: false,
      ensuiteFeatures: [],
    });
  }

  // Sofa beds in living room
  const sofaBeds = livingRooms.flatMap(r => r.beds.filter(b => b.type === "SOFA_BED"));
  const sofaCount = sofaBeds.reduce((s, b) => s + b.quantity, 0);

  return {
    unitId,
    unitLabel,
    bedrooms,
    bathrooms: defaultBathrooms(bathroomCount, bedrooms[0]?.hasEnsuite ?? true),
    livingRoom: {
      hasSofaBed: sofaCount > 0,
      sofaBedType: "SOFA_BED",
      count: Math.max(1, sofaCount),
    },
  };
}

export function buildDefaultBeddingConfig(propertyId: number): PropertyBeddingConfig {
  const guestyConfig = GUESTY_PROPERTY_CONFIGS.find(c => c.propertyId === propertyId);
  const propData = getUnitBuilderByPropertyId(propertyId);

  const units: UnitBeddingConfig[] = [];
  if (propData) {
    for (const u of propData.units) {
      const guestyUnit = guestyConfig?.units.find(gu => gu.unitId === u.id);
      const rooms: GuestyRoom[] = guestyUnit?.rooms ?? [];
      units.push(buildDefaultUnitBedding(
        u.id,
        u.unitNumber || u.id,
        u.bedrooms,
        parseFloat(u.bathrooms) || 1,
        rooms,
      ));
    }
  }
  return { propertyId, units };
}

// ── Persistence (localStorage) ───────────────────────────────────────────────

const lsKey = (propertyId: number) => `nexstay_bedding_${propertyId}`;

// Deep-merge a stored unit into the freshly built default so any missing
// nested fields (added later to the schema) are filled from defaults.
function normalizeUnit(stored: Partial<UnitBeddingConfig>, def: UnitBeddingConfig): UnitBeddingConfig {
  const bedrooms: BedroomDetail[] = Array.isArray(stored.bedrooms) && stored.bedrooms.length > 0
    ? stored.bedrooms.map((b, i) => ({
        roomNumber: typeof b.roomNumber === "number" ? b.roomNumber : i + 1,
        label: typeof b.label === "string" ? b.label : labelForBedroom(i),
        beds: Array.isArray(b.beds) && b.beds.length > 0 ? b.beds : [{ type: "QUEEN_BED", quantity: 1 }],
        hasEnsuite: !!b.hasEnsuite,
        ensuiteFeatures: Array.isArray(b.ensuiteFeatures) ? b.ensuiteFeatures : [],
      }))
    : def.bedrooms;
  const bathrooms: BathroomDetail[] = Array.isArray(stored.bathrooms)
    ? stored.bathrooms.map((b, i) => ({
        id: typeof b.id === "string" ? b.id : `bath-${i}`,
        label: typeof b.label === "string" ? b.label : `Bath ${i + 1}`,
        isHalf: !!b.isHalf,
        features: Array.isArray(b.features) ? b.features : [],
      }))
    : def.bathrooms;
  const livingRoom: LivingRoomConfig = stored.livingRoom && typeof stored.livingRoom === "object"
    ? {
        hasSofaBed: !!stored.livingRoom.hasSofaBed,
        sofaBedType: "SOFA_BED",
        count: typeof stored.livingRoom.count === "number" && stored.livingRoom.count > 0
          ? stored.livingRoom.count : (stored.livingRoom.hasSofaBed ? 1 : 0),
      }
    : def.livingRoom;
  return { unitId: def.unitId, unitLabel: def.unitLabel, bedrooms, bathrooms, livingRoom };
}

export function loadBeddingConfig(propertyId: number): PropertyBeddingConfig {
  const defaults = buildDefaultBeddingConfig(propertyId);
  try {
    const raw = localStorage.getItem(lsKey(propertyId));
    if (raw) {
      const parsed = JSON.parse(raw) as PropertyBeddingConfig;
      if (parsed && parsed.propertyId === propertyId && Array.isArray(parsed.units)) {
        const mergedUnits = defaults.units.map(d => {
          const stored = parsed.units.find(u => u.unitId === d.unitId);
          return stored ? normalizeUnit(stored, d) : d;
        });
        return { propertyId, units: mergedUnits };
      }
    }
  } catch { /* fall through to defaults */ }
  return defaults;
}

export function saveBeddingConfig(config: PropertyBeddingConfig): void {
  try { localStorage.setItem(lsKey(config.propertyId), JSON.stringify(config)); } catch {}
}

export function resetBeddingConfig(propertyId: number): PropertyBeddingConfig {
  try { localStorage.removeItem(lsKey(propertyId)); } catch {}
  return buildDefaultBeddingConfig(propertyId);
}

// ── Adapters → Guesty ────────────────────────────────────────────────────────

export function totalBedrooms(config: PropertyBeddingConfig): number {
  return config.units.reduce((s, u) => s + u.bedrooms.length, 0);
}

export function totalBathrooms(config: PropertyBeddingConfig): number {
  // full = 1.0, half = 0.5
  let total = 0;
  for (const u of config.units) {
    for (const b of u.bathrooms) total += b.isHalf ? 0.5 : 1;
  }
  return Math.round(total * 2) / 2;
}

export function totalSleeps(config: PropertyBeddingConfig): number {
  let total = 0;
  for (const u of config.units) {
    for (const br of u.bedrooms) {
      for (const bed of br.beds) total += (BED_SLEEPS[bed.type] ?? 2) * bed.quantity;
    }
    if (u.livingRoom.hasSofaBed) {
      total += (BED_SLEEPS.SOFA_BED) * u.livingRoom.count;
    }
  }
  return total;
}

export function buildGuestyListingRooms(config: PropertyBeddingConfig): GuestyRoom[] {
  const out: GuestyRoom[] = [];
  let bedroomNum = 1;
  for (const u of config.units) {
    for (const br of u.bedrooms) {
      if (br.beds.length > 0) {
        out.push({ roomNumber: bedroomNum++, beds: br.beds });
      }
    }
    if (u.livingRoom.hasSofaBed && u.livingRoom.count > 0) {
      out.push({
        roomNumber: 0,
        beds: [{ type: "SOFA_BED", quantity: u.livingRoom.count }],
      });
    }
  }
  return out;
}

// Returns Guesty amenity KEYS (matches `GUESTY_AMENITY_CATALOG[i].key`).
export function deriveBathAmenities(config: PropertyBeddingConfig): string[] {
  const amenities = new Set<string>();
  const addForFeatures = (features: BathFeature[]) => {
    for (const f of features) {
      if (f === "shower-tub-combo" || f === "soaking-tub" || f === "jetted-tub") {
        amenities.add("BATHTUB");
      }
      if (f === "walk-in-shower" || f === "rain-shower" || f === "shower-tub-combo") {
        amenities.add("HOT_WATER");
      }
      if (f === "jetted-tub") amenities.add("HOT_TUB");
    }
  };
  for (const u of config.units) {
    for (const b of u.bathrooms) addForFeatures(b.features);
    for (const br of u.bedrooms) {
      if (br.hasEnsuite) addForFeatures(br.ensuiteFeatures);
    }
  }
  return Array.from(amenities);
}

export function describeUnitBedding(unit: UnitBeddingConfig): string {
  const beds = unit.bedrooms.map((br) => {
    const bedDesc = br.beds.map(b => `${b.quantity > 1 ? `${b.quantity} ` : ""}${BED_TYPE_LABELS[b.type]}${b.quantity > 1 ? "s" : ""}`).join(" + ");
    const ensuite = br.hasEnsuite ? " (ensuite)" : "";
    return `${br.label}: ${bedDesc}${ensuite}`;
  });
  const sofa = unit.livingRoom.hasSofaBed
    ? ` Living room ${unit.livingRoom.count > 1 ? `${unit.livingRoom.count} sofa beds` : "sofa bed"}.`
    : "";
  const baths = unit.bathrooms
    .map(b => `${b.label}${b.features.length ? ` (${b.features.map(f => BATH_FEATURE_LABELS[f]).join(", ")})` : ""}${b.isHalf ? " — half" : ""}`)
    .join("; ");
  return `${beds.join("; ")}.${sofa} Bathrooms: ${baths}.`;
}

// ── Space description builder ─────────────────────────────────────────────────
// Generates a full prose "The Space" description incorporating bedroom names,
// bed types, ensuite features, bathrooms, and sofa beds. Used in the Bedding
// tab to populate publicDescription.space in Guesty so bedroom names "stream
// through" to the actual listing copy.

function bedSentence(br: BedroomDetail): string {
  const bedParts = br.beds.map(b => {
    const qty = b.quantity > 1 ? `${b.quantity} ` : "";
    const name = BED_TYPE_LABELS[b.type];
    const plural = b.quantity > 1 ? (name.endsWith("s") ? "" : "s") : "";
    return `${qty}${name}${plural}`;
  }).join(" and ");
  const ensuiteParts = br.hasEnsuite && br.ensuiteFeatures.length > 0
    ? ` with a private ensuite featuring ${br.ensuiteFeatures.map(f => BATH_FEATURE_LABELS[f]).join(" and ").toLowerCase()}`
    : br.hasEnsuite ? " with private ensuite bathroom" : "";
  return `The ${br.label} offers a ${bedParts} bed${ensuiteParts}.`;
}

function bathSentence(baths: BathroomDetail[]): string {
  const full = baths.filter(b => !b.isHalf);
  const half = baths.filter(b => b.isHalf);
  const parts: string[] = full.map(b => {
    const featureStr = b.features.length > 0
      ? ` with ${b.features.map(f => BATH_FEATURE_LABELS[f]).join(" and ").toLowerCase()}`
      : "";
    return `a ${b.label.toLowerCase()}${featureStr}`;
  });
  if (half.length > 0) parts.push(`${half.length} half-bath${half.length > 1 ? "s" : ""}`);
  if (parts.length === 0) return "";
  if (parts.length === 1) return `The bathroom includes ${parts[0]}.`;
  const last = parts.pop()!;
  return `The bathrooms include ${parts.join(", ")}, and ${last}.`;
}

export function buildSpaceDescription(config: PropertyBeddingConfig): string {
  return config.units.map((unit) => {
    const brCount = unit.bedrooms.length;
    const bathCount = unit.bathrooms.reduce((s, b) => s + (b.isHalf ? 0.5 : 1), 0);
    const sleeps = unit.bedrooms.reduce((s, br) =>
      s + br.beds.reduce((bs, b) => bs + (BED_SLEEPS[b.type] ?? 2) * b.quantity, 0), 0)
      + (unit.livingRoom.hasSofaBed ? 2 * unit.livingRoom.count : 0);
    const header = `Unit ${unit.unitLabel} (${brCount}BR/${bathCount}BA · Sleeps ${sleeps})`;
    const bedroomLines = unit.bedrooms.map(br => bedSentence(br)).join(" ");
    const sofaLine = unit.livingRoom.hasSofaBed
      ? ` The living room has ${unit.livingRoom.count > 1 ? `${unit.livingRoom.count} sofa beds` : "a queen sofa bed"} for additional sleeping.`
      : "";
    const bathLine = bathSentence(unit.bathrooms);
    return `${header}\n${bedroomLines}${sofaLine} ${bathLine}`.trim();
  }).join("\n\n");
}
