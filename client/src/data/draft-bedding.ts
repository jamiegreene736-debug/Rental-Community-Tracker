// Bedding-config generator for community drafts (negative propertyIds).
//
// `buildDefaultBeddingConfig(propertyId)` only knows about the static
// PROPERTY_UNIT_CONFIGS + GUESTY_PROPERTY_CONFIGS, returning empty
// units for promoted drafts. This module produces a PropertyBeddingConfig
// in the same shape, parsing the AI-generated `unit1Bedding`/`unit2Bedding`
// text strings ("King master, Queen second, Twin third") into structured
// `BedroomDetail[]` / `BathroomDetail[]` objects.
//
// Falls back to "Queen + Queen" if the text can't be parsed — better
// than a blank Bedding tab; the operator edits to actuals once they
// confirm the unit's real layout.

import type { CommunityDraft } from "@shared/schema";
import type {
  PropertyBeddingConfig,
  UnitBeddingConfig,
  BedroomDetail,
  BathroomDetail,
} from "./bedding-config";
import type { GuestyBed, GuestyBedType } from "./guesty-listing-config";

const labelForBedroom = (idx: number): string =>
  idx === 0 ? "Master Bedroom" : `Bedroom ${idx + 1}`;

// Map common natural-language bed words → Guesty bed types. Recognizes
// plural ("kings"), the "California King" prefix, and the various
// twin/single/full/double synonyms. Anything unmatched defaults to QUEEN.
function bedTypeFromText(s: string): GuestyBedType {
  const t = s.toLowerCase();
  if (/\bcalifornia\s+king\b|\bcal\s*king\b/.test(t)) return "CAL_KING_BED";
  if (/\bking\b/.test(t)) return "KING_BED";
  if (/\bqueen\b/.test(t)) return "QUEEN_BED";
  if (/\bfull\b|\bdouble\b/.test(t)) return "FULL_BED";
  if (/\btwin\b|\bsingle\b/.test(t)) return "TWIN_BED";
  if (/\bsofa\b|\bsleeper\b|\bpullout\b|\bpull-out\b/.test(t)) return "SOFA_BED";
  if (/\bbunk\b/.test(t)) return "BUNK_BED";
  if (/\bcrib\b/.test(t)) return "CRIB";
  if (/\bairbed|\bair\s*mattress/.test(t)) return "AIR_MATTRESS";
  return "QUEEN_BED";
}

// Parse Claude's free-text bedding string into per-bedroom bed lists.
// Handles inputs like:
//   "King master, Queen second, 2 Twins third"
//   "King in master + Queen + sofa bed"
//   "1 King, 1 Queen, 2 Twin"
function parseBedding(beddingText: string | null | undefined, expectedBedrooms: number): BedroomDetail[] {
  const text = (beddingText || "").trim();
  if (!text) return [];

  // Split on common separators: comma, " + ", " and ", " & ".
  const segments = text
    .split(/(?:,|\s+\+\s+|\s+and\s+|\s+&\s+|;)/i)
    .map((s) => s.trim())
    .filter(Boolean);

  // Each segment is one BEDROOM's worth of beds (segment 1 = master,
  // segment 2 = bedroom 2, etc.). Inside a segment, the operator may
  // list multiple beds — "2 Twins" = 1 segment with quantity 2.
  const bedrooms: BedroomDetail[] = [];
  for (let i = 0; i < segments.length && i < expectedBedrooms; i++) {
    const seg = segments[i];
    // Match leading quantity ("2 Twins")
    const qtyMatch = seg.match(/^\s*(\d+)\s+/);
    const qty = qtyMatch ? Math.max(1, parseInt(qtyMatch[1], 10)) : 1;
    const rest = qtyMatch ? seg.slice(qtyMatch[0].length) : seg;
    const type = bedTypeFromText(rest);
    const beds: GuestyBed[] = [{ type, quantity: qty }];
    bedrooms.push({
      roomNumber: i + 1,
      label: labelForBedroom(i),
      beds,
      hasEnsuite: i === 0, // master = ensuite by convention
      ensuiteFeatures: i === 0 ? ["walk-in-shower", "soaking-tub"] : [],
    });
  }
  // Pad if the parsed count is less than the expected bedrooms.
  while (bedrooms.length < expectedBedrooms) {
    const idx = bedrooms.length;
    bedrooms.push({
      roomNumber: idx + 1,
      label: labelForBedroom(idx),
      beds: [{ type: "QUEEN_BED", quantity: 1 }],
      hasEnsuite: false,
      ensuiteFeatures: [],
    });
  }
  return bedrooms;
}

function defaultBathrooms(bathroomCount: number, hasMasterEnsuite: boolean): BathroomDetail[] {
  const fullCount = Math.floor(bathroomCount);
  const halfCount = bathroomCount - fullCount > 0 ? 1 : 0;
  const out: BathroomDetail[] = [];
  for (let i = 0; i < fullCount; i++) {
    if (i === 0 && hasMasterEnsuite) {
      out.push({
        id: `bath-${i}`,
        label: "Master Ensuite",
        isHalf: false,
        features: ["walk-in-shower", "soaking-tub"],
      });
    } else {
      out.push({
        id: `bath-${i}`,
        label: i === 0 ? "Hall Bath" : `Bath ${i + 1}`,
        isHalf: false,
        features: ["shower-tub-combo"],
      });
    }
  }
  for (let i = 0; i < halfCount; i++) {
    out.push({ id: `bath-h${i}`, label: "Powder Room", isHalf: true, features: [] });
  }
  return out;
}

function unitFromDraft(
  unitId: string,
  unitLabel: string,
  bedrooms: number,
  bathroomsRaw: string | null | undefined,
  beddingText: string | null | undefined,
): UnitBeddingConfig {
  const bedroomDetails = parseBedding(beddingText, Math.max(1, bedrooms));
  const bathroomCount = (() => {
    const n = parseFloat(String(bathroomsRaw ?? "").replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : 1;
  })();

  // Detect sofa bed in the bedding text — many drafts list it
  // separately ("King master, Queen second, sofa sleeper in living room").
  const hasSofa = /(sofa|sleeper|pullout|pull-out)\s*(bed|sleeper)?/i.test(beddingText || "");

  return {
    unitId,
    unitLabel,
    bedrooms: bedroomDetails,
    bathrooms: defaultBathrooms(bathroomCount, bedroomDetails[0]?.hasEnsuite ?? true),
    livingRoom: {
      hasSofaBed: hasSofa,
      sofaBedType: "SOFA_BED",
      count: hasSofa ? 1 : 0,
    },
  };
}

export function buildDraftBeddingConfig(
  draft: CommunityDraft,
  propertyId: number,
): PropertyBeddingConfig {
  const u1Br = draft.unit1Bedrooms ?? 2;
  const u2Br = draft.unit2Bedrooms ?? 2;
  return {
    propertyId,
    units: [
      unitFromDraft(`draft${draft.id}-unit-a`, "A", u1Br, draft.unit1Bathrooms, draft.unit1Bedding),
      unitFromDraft(`draft${draft.id}-unit-b`, "B", u2Br, draft.unit2Bathrooms, draft.unit2Bedding),
    ],
  };
}
