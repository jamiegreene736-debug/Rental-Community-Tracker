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
};
function sampleLicensesForState(state: string): LicenseSamples {
  const s = (state || "").toLowerCase();
  if (s === "hawaii" || s === "hi") {
    return {
      taxMapKey: "XXXXXXXXXXXX (sample — replace with the 12-digit TMK)",
      getLicense: "GE-XXX-XXX-XXXX-XX (sample — replace with GE Tax license)",
      tatLicense: "TA-XXX-XXX-XXXX-XX (sample — replace with TAT Tax license)",
    };
  }
  if (s === "florida" || s === "fl") {
    return {
      taxMapKey: "DWE/COND-XXXXXXXXXX (sample — Florida DBPR Vacation Rental Dwelling/Condo License)",
      getLicense: "XX-XXXXXXXXXX-X (sample — Florida DOR Sales & Use Tax Certificate)",
      tatLicense: "Account # XXXXXXX (sample — county Tourist Development Tax registration)",
    };
  }
  return {
    taxMapKey: "(no parcel/license id required for this state — verify with local jurisdiction)",
    getLicense: "(no state sales tax cert required — verify with local jurisdiction)",
    tatLicense: "(no occupancy tax registration required — verify with local jurisdiction)",
  };
}

export function adaptDraftToPropertyUnitBuilder(
  draft: CommunityDraft,
  photoFiles: Record<string, string[]> = {},
): PropertyUnitBuilder {
  const u1Br = draft.unit1Bedrooms ?? 2;
  const u2Br = draft.unit2Bedrooms ?? 2;
  const blank = "";
  const licenseSamples = sampleLicensesForState(draft.state);
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
    strPermit: draft.strPermit ?? blank,
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
  return adaptDraftToPropertyUnitBuilder(match, filesByFolder);
}
