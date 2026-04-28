// Adapter from CommunityDraft (the AI-generated rich shape from the
// Add a New Community wizard) into the PropertyUnitBuilder shape that
// the rest of the builder/preflight code expects. Promoted drafts
// take this path because they don't (yet) live in the static
// `unit-builder-data.ts` array; this adapter lets the existing
// builder UI render against draft data without a code-side migration.
//
// `photoFiles` is an optional per-folder file list — when supplied,
// each unit's `photos` array is populated from disk so the builder's
// Photo tab shows the operator's scraped photos. When omitted, photos
// come up empty (Guesty connection / push flow handles them later).

import { type PropertyUnitBuilder } from "@/data/unit-builder-data";
import { apiRequest } from "@/lib/queryClient";
import type { CommunityDraft } from "@shared/schema";
import { buildDraftPropertyPricing } from "@/data/draft-pricing";
import { buildDraftBeddingConfig } from "@/data/draft-bedding";
import { registerDraftBeddingDefaults, type PropertyBeddingConfig } from "@/data/bedding-config";
import { registerDraftPropertyPricing, type PropertyPricing } from "@/data/pricing-data";

// Sample license placeholders for promoted drafts. Active properties
// in unit-builder-data have hand-curated values for the four
// Compliance fields; the wizard doesn't collect them, so the builder's
// Compliance & Registration card was rendering all four fields blank
// for promoted drafts — operator complaint: "nothing inserted for
// sample license data". Insert state-aware placeholders so the
// operator sees the expected format and replaces with the real values
// before pushing to Guesty.
//
// Hawaii uses TMK (parcel id) + GE (general excise tax) + TAT
// (transient accom. tax) + STR (per-county permit).
//
// Florida re-uses the same four UI fields for the Florida vacation-
// rental compliance stack (the field labels are state-aware in the
// builder — see complianceLabels there):
//   - field 1 (TMK slot)  → DBPR Vacation Rental License
//   - field 2 (GE slot)   → Florida DOR Sales Tax Certificate
//   - field 3 (TAT slot)  → County Tourist Development Tax account
//   - field 4 (STR slot)  → Local Business Tax Receipt (LBTR)
type LicenseSamples = {
  taxMapKey: string;
  getLicense: string;
  tatLicense: string;
  strPermit: string;
};

// Map a city → Hawaii county. Used to pick the right STR permit format
// (each county has its own — Kauai uses TVR/TVNC, Big Island STVR,
// Maui STRH, Oahu NUC). VDA = Visitor Destination Area, the Kauai
// distinction between resort zones (TVR) and residential (TVNC).
function hawaiiCountyFromCity(city: string): "kauai-vda" | "kauai-non-vda" | "big-island" | "maui" | "oahu" | "unknown" {
  const c = (city || "").toLowerCase();
  // Oahu: Honolulu / Waikiki / Kailua / North Shore / Pearl City etc.
  if (/honolulu|waikiki|kailua|kaneohe|aiea|pearl|wahiawa|haleiwa|kapolei|ewa|north shore/.test(c)) return "oahu";
  // Maui County: Maui island + Lanai + Molokai
  if (/maui|lahaina|kihei|wailea|kaanapali|kapalua|kahului|hana|paia|makawao|lanai|molokai/.test(c)) return "maui";
  // Big Island (Hawaii County)
  if (/keauhou|kona|kailua-kona|hilo|waikoloa|mauna|volcano|pahoa|naalehu|big island|hawaii island/.test(c)) return "big-island";
  // Kauai VDA zones (resort areas)
  if (/poipu|princeville|kapaa beachfront|hanalei|koloa/.test(c)) return "kauai-vda";
  // Kauai non-VDA (residential)
  if (/kekaha|waimea|lihue|kapaa|kalaheo|wailua/.test(c)) return "kauai-non-vda";
  return "unknown";
}

function strPermitSampleHawaii(city: string): string {
  switch (hawaiiCountyFromCity(city)) {
    case "kauai-vda":
      return "TVR-2024-XX (sample — Kauai VDA-zone Transient Vacation Rental permit)";
    case "kauai-non-vda":
      return "TVNC-XXXX (sample — Kauai non-VDA Transient Vacation Non-Conforming permit)";
    case "big-island":
      return "STVR-2024-XXXXXX (sample — Hawaii County Short-Term Vacation Rental permit)";
    case "maui":
      return "STRH-XXXXXXXX (sample — Maui County Short-Term Rental Home permit)";
    case "oahu":
      return "NUC-XX-XXX-XXXX (sample — Honolulu Non-Conforming Use Certificate)";
    default:
      return "(verify county-specific STR permit format)";
  }
}

// Map a Florida city → county. Drives the Florida sample set, since
// Tourist Development Tax and Local Business Tax Receipts are issued
// per-county, and the sales-tax certificate's leading two digits encode
// the county the business registered in (Osceola=49, Orange=48,
// Polk=53). Davenport sits across the Polk/Osceola line — most resort
// communities ("ChampionsGate", Reunion-area condos) bill from Osceola
// addresses, so Davenport is grouped with Osceola here. Operators with
// a Polk-side Davenport address should overwrite the BTR/TDT/sales-tax
// samples with their actual numbers; the fields aren't used until the
// operator pushes compliance to Guesty.
function floridaCountyFromCity(city: string): "osceola" | "orange" | "polk" | "lake" | "brevard" | "unknown" {
  const c = (city || "").toLowerCase();
  if (/(kissimmee|davenport|celebration|poinciana|st\.?\s*cloud|championsgate|reunion)/.test(c)) return "osceola";
  if (/(orlando|windermere|lake\s+buena\s+vista|ocoee|apopka|winter\s+garden|dr\.?\s*phillips)/.test(c)) return "orange";
  if (/(haines\s*city|lakeland|winter\s+haven|auburndale|bartow|lake\s+wales)/.test(c)) return "polk";
  if (/(clermont|groveland|minneola|mascotte|mount\s+dora|tavares|leesburg)/.test(c)) return "lake";
  if (/(melbourne|cocoa|titusville|palm\s+bay|merritt\s+island|cape\s+canaveral|viera|rockledge)/.test(c)) return "brevard";
  return "unknown";
}

type FloridaCountyLabel = { label: string; salesTaxCountyCode: string };
function floridaCountyLabel(c: ReturnType<typeof floridaCountyFromCity>): FloridaCountyLabel {
  switch (c) {
    case "osceola": return { label: "Osceola County",  salesTaxCountyCode: "49" };
    case "orange":  return { label: "Orange County",   salesTaxCountyCode: "48" };
    case "polk":    return { label: "Polk County",     salesTaxCountyCode: "53" };
    case "lake":    return { label: "Lake County",     salesTaxCountyCode: "35" };
    case "brevard": return { label: "Brevard County",  salesTaxCountyCode: "05" };
    default:        return { label: "FL county",       salesTaxCountyCode: "XX" };
  }
}

function sampleLicensesForLocation(city: string, state: string): LicenseSamples {
  const s = (state || "").toLowerCase();
  if (s === "hawaii" || s === "hi") {
    return {
      taxMapKey: "XX-X-X-XXX-XXX-XXXX (sample — replace with 12-digit TMK: county-district-section-parcel)",
      getLicense: "GE-XXX-XXX-XXXX-XX (sample — replace with GE Tax license)",
      tatLicense: "TA-XXX-XXX-XXXX-XX (sample — replace with TAT Tax license)",
      strPermit: strPermitSampleHawaii(city),
    };
  }
  if (s === "florida" || s === "fl") {
    const fc = floridaCountyFromCity(city);
    const { label, salesTaxCountyCode } = floridaCountyLabel(fc);
    return {
      taxMapKey: "DWE/COND-XXXXXXX (sample — Florida DBPR Vacation Rental Dwelling/Condo License, 7-digit cert)",
      getLicense: `${salesTaxCountyCode}-XXXXXXXXXX-X (sample — Florida DOR Sales & Use Tax Certificate; ${salesTaxCountyCode === "XX" ? "first two digits = your county code" : `${salesTaxCountyCode} = ${label} code`})`,
      tatLicense: `${label} TDT Acct # XXXXXXX (sample — ${label} Tourist Development Tax registration${fc === "osceola" ? ", 6% local lodging tax" : ""})`,
      strPermit: `LBTR-XXXXXX (sample — ${label} Local Business Tax Receipt for short-term rental)`,
    };
  }
  return {
    taxMapKey: "(no parcel/license id required for this state — verify with local jurisdiction)",
    getLicense: "(no state sales tax cert required — verify with local jurisdiction)",
    tatLicense: "(no occupancy tax registration required — verify with local jurisdiction)",
    strPermit: "(verify local short-term rental permit requirements)",
  };
}

// True when the saved value looks like a sample placeholder we generated
// (contains "sample —" / "sample -", or is purely the verify-with-
// jurisdiction fallback). When the operator typed a real permit, the
// string won't contain those markers, and we keep their value verbatim.
//
// Drafts created before location detection landed (or before the
// current Florida county-aware samples) saved the older generic
// fallback as `draft.strPermit`. Treating those as "no real value"
// lets the freshly adapted draft display the new, location-specific
// sample without the operator having to clear the field by hand.
function looksLikeSamplePlaceholder(value: string): boolean {
  const v = value.toLowerCase();
  return v.includes("sample —") || v.includes("sample -") || v.includes("(verify ") || v.includes("verify with local");
}

export function adaptDraftToPropertyUnitBuilder(
  draft: CommunityDraft,
  photoFiles: Record<string, string[]> = {},
): PropertyUnitBuilder {
  const u1Br = draft.unit1Bedrooms ?? 2;
  const u2Br = draft.unit2Bedrooms ?? 2;
  const blank = "";
  const licenseSamples = sampleLicensesForLocation(draft.city, draft.state);
  const filesToPhotos = (folder: string | null | undefined) => {
    if (!folder) return [];
    const files = photoFiles[folder] ?? [];
    return files.map((filename) => ({
      filename,
      label: "Photo",
      category: "interior" as const,
    }));
  };
  return {
    propertyId: -draft.id, // matches the synthetic negative id the dashboard uses
    propertyName: draft.listingTitle || draft.name,
    complexName: draft.name,
    // Street address (when the operator filled it in on Step 5) gives
    // the preflight a real per-unit address to text-search; falls
    // back to "city, state" so older drafts keep rendering.
    address: draft.streetAddress
      ? `${draft.streetAddress}, ${draft.city}, ${draft.state}`
      : `${draft.city}, ${draft.state}`,
    bookingTitle: draft.bookingTitle || draft.listingTitle || draft.name,
    sampleDisclaimer: blank,
    combinedDescription: draft.listingDescription ?? blank,
    propertyType: draft.propertyType ?? "Condominium",
    neighborhood: draft.neighborhood ?? blank,
    transit: draft.transit ?? blank,
    taxMapKey: licenseSamples.taxMapKey,
    tatLicense: licenseSamples.tatLicense,
    getLicense: licenseSamples.getLicense,
    // Use the operator-entered STR permit if they typed one on Step 5,
    // otherwise drop in the county-appropriate sample format. Drafts
    // saved before the Florida county-aware samples landed have the
    // old generic placeholder stored as `draft.strPermit`; treat those
    // as "no real value typed" so the new county-specific sample wins.
    strPermit: draft.strPermit && draft.strPermit.trim() && !looksLikeSamplePlaceholder(draft.strPermit)
      ? draft.strPermit
      : licenseSamples.strPermit,
    hasPhotos: ((draft.unit1PhotoFolder && photoFiles[draft.unit1PhotoFolder]?.length) ||
                 (draft.unit2PhotoFolder && photoFiles[draft.unit2PhotoFolder]?.length)) ? true : false,
    communityPhotos: [],
    communityPhotoFolder: blank,
    units: [
      {
        id: `draft${draft.id}-unit-a`,
        unitNumber: "A",
        bedrooms: u1Br,
        bathrooms: draft.unit1Bathrooms ?? "",
        sqft: draft.unit1Sqft ?? "",
        maxGuests: draft.unit1MaxGuests ?? u1Br * 2,
        shortDescription: draft.unit1ShortDescription ?? "",
        longDescription: draft.unit1LongDescription ?? "",
        photoFolder: draft.unit1PhotoFolder ?? "",
        photos: filesToPhotos(draft.unit1PhotoFolder),
      },
      {
        id: `draft${draft.id}-unit-b`,
        unitNumber: "B",
        bedrooms: u2Br,
        bathrooms: draft.unit2Bathrooms ?? "",
        sqft: draft.unit2Sqft ?? "",
        maxGuests: draft.unit2MaxGuests ?? u2Br * 2,
        shortDescription: draft.unit2ShortDescription ?? "",
        longDescription: draft.unit2LongDescription ?? "",
        photoFolder: draft.unit2PhotoFolder ?? "",
        photos: filesToPhotos(draft.unit2PhotoFolder),
      },
    ],
  } as PropertyUnitBuilder;
}

// Fetch + adapt a draft by its negative property id (`-draftId`).
// Returns null when no draft matches. Pulls per-unit photo file lists
// alongside the draft so the resulting PropertyUnitBuilder has its
// units' photos arrays populated.
export async function loadDraftPropertyByNegativeId(
  propertyId: number,
): Promise<PropertyUnitBuilder | null> {
  const full = await loadDraftFullDataByNegativeId(propertyId);
  return full?.property ?? null;
}

// All-in-one loader: fetches the draft, adapts it to the builder shape,
// AND generates pricing/bedding defaults so the Pricing and Bedding
// tabs have something to render. The bedding default also gets
// registered with the bedding-config cache as a side effect, since
// the Bedding tab loads its config sync via buildDefaultBeddingConfig.
export type DraftFullData = {
  draft: CommunityDraft;
  property: PropertyUnitBuilder;
  pricing: PropertyPricing;
  bedding: PropertyBeddingConfig;
};

export async function loadDraftFullDataByNegativeId(
  propertyId: number,
): Promise<DraftFullData | null> {
  if (propertyId >= 0) return null;
  const draftId = -propertyId;
  const r = await apiRequest("GET", "/api/community/drafts");
  const drafts = (await r.json()) as CommunityDraft[];
  const match = drafts.find((d) => d.id === draftId);
  if (!match) return null;
  const folders = [match.unit1PhotoFolder, match.unit2PhotoFolder]
    .filter((f): f is string => !!f);
  const filesByFolder: Record<string, string[]> = {};
  await Promise.all(
    folders.map(async (folder) => {
      try {
        const fr = await apiRequest("GET", `/api/photos/community/${encodeURIComponent(folder)}`);
        const list = (await fr.json()) as Array<{ filename: string }> | null;
        filesByFolder[folder] = Array.isArray(list) ? list.map((f) => f.filename) : [];
      } catch {
        filesByFolder[folder] = [];
      }
    }),
  );
  const property = adaptDraftToPropertyUnitBuilder(match, filesByFolder);
  const pricing = buildDraftPropertyPricing(match, propertyId);
  const bedding = buildDraftBeddingConfig(match, propertyId);
  // Register so sync helpers (loadBeddingConfig, getPropertyPricing)
  // find the draft data when called inside the GuestyListingBuilder.
  registerDraftBeddingDefaults(propertyId, bedding);
  registerDraftPropertyPricing(propertyId, pricing);
  return { draft: match, property, pricing, bedding };
}
