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

export function adaptDraftToPropertyUnitBuilder(
  draft: CommunityDraft,
  photoFiles: Record<string, string[]> = {},
): PropertyUnitBuilder {
  const u1Br = draft.unit1Bedrooms ?? 2;
  const u2Br = draft.unit2Bedrooms ?? 2;
  const blank = "";
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
    taxMapKey: blank,
    tatLicense: blank,
    getLicense: blank,
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
