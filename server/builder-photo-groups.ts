// Build photo-community-check groups the same way the listing builder does:
// published (non-hidden) files from disk, DB labels with static fallbacks.

import fs from "fs";
import { getUnitBuilderByPropertyId, type PropertyUnitBuilder } from "../client/src/data/unit-builder-data";
import { resolveActiveUnitPhotoFolders } from "../shared/unit-swap-photos";
import { resolveCanonicalCommunityPhotoFolder } from "../shared/community-photo-folders";
import { resolveDraftUnitBedrooms, positiveDraftInteger } from "../shared/draft-unit-bedrooms";
import { parseExpectedBedInventory } from "../shared/photo-bedroom-coverage-logic";
import { draftUnitIdForSlot } from "../shared/auto-replace-job-logic";
import { storage } from "./storage";
import type { CheckGroupInput, PhotoCommunityCheckRequest } from "./photo-community-check";
import type { CommunityDraft } from "../shared/schema";

const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif)$/i;

// fs-only source-provenance helpers live in ./photo-folder-source (no storage
// import there, so tests can exercise them without a DATABASE_URL); re-exported
// here because this module is where every existing importer looks for them.
export { publicPhotoDir, readFolderSourceUrl, writeFolderSourceUrlIfMissing } from "./photo-folder-source";
import { publicPhotoDir, readFolderSourceUrl } from "./photo-folder-source";

export function captionFromFilename(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "").replace(/^\d+[-_]/, "");
  if (!stem) return "Photo";
  return stem
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

type LabelRow = {
  userLabel?: string | null;
  label?: string | null;
  userCategory?: string | null;
  category?: string | null;
  hidden?: boolean;
  bedroomClusterId?: string | null;
  bedroomBedType?: string | null;
  perceptualHash?: string | null;
};

function effectiveCategory(row: LabelRow | undefined): string | null {
  if (!row) return null;
  return row.userCategory ?? row.category ?? null;
}

function staticCaptionFor(
  builder: PropertyUnitBuilder,
  folder: string,
  filename: string,
): string | undefined {
  if (folder === builder.communityPhotoFolder) {
    const hit = builder.communityPhotos?.find((p) => p.filename === filename);
    if (hit) return hit.label;
  }
  for (const u of builder.units) {
    if (u.photoFolder !== folder) continue;
    const hit = u.photos?.find((p) => p.filename === filename);
    if (hit) return hit.label;
  }
  return undefined;
}

function staticCategoryFor(
  builder: PropertyUnitBuilder,
  folder: string,
  filename: string,
): string | undefined {
  if (folder === builder.communityPhotoFolder) {
    const hit = builder.communityPhotos?.find((p) => p.filename === filename);
    if (hit?.category) return hit.category;
  }
  for (const u of builder.units) {
    if (u.photoFolder !== folder) continue;
    const hit = u.photos?.find((p) => p.filename === filename);
    if (hit?.category) return hit.category;
  }
  return undefined;
}

function effectiveCaption(
  filename: string,
  labelRow: LabelRow | undefined,
  staticCaption?: string,
): string {
  const fromDb = labelRow?.userLabel ?? labelRow?.label;
  return (fromDb?.trim() || staticCaption?.trim() || captionFromFilename(filename));
}

export async function listPublishedFilenames(folder: string): Promise<string[]> {
  const dir = publicPhotoDir(folder);
  let diskFiles: string[] = [];
  try {
    diskFiles = (await fs.promises.readdir(dir)).filter((f) => IMAGE_EXT.test(f)).sort();
  } catch {
    return [];
  }
  const labels = await storage.getPhotoLabelsByFolder(folder);
  const hidden = new Set(labels.filter((l) => l.hidden).map((l) => l.filename));
  return diskFiles.filter((f) => !hidden.has(f));
}

export type ConfiguredPhotoFolderStatus = {
  role: "community" | "unit";
  label: string;
  /** Null means the listing has no folder configured for this required slot. */
  folder: string | null;
  publishedCount: number;
  unitId?: string;
  expectedBedrooms?: number;
};

async function configuredFolderStatus(
  input: Omit<ConfiguredPhotoFolderStatus, "publishedCount">,
): Promise<ConfiguredPhotoFolderStatus> {
  const folder = String(input.folder ?? "").trim() || null;
  return {
    ...input,
    folder,
    publishedCount: folder ? (await listPublishedFilenames(folder)).length : 0,
  };
}

/**
 * Inventory every photo folder the listing configuration requires, including
 * missing and empty folders. The ordinary community-check request intentionally
 * omits empty groups because its vision engine cannot inspect them; strict
 * Dashboard automation uses this parallel inventory so absence can never look
 * like a smaller, successfully scanned property.
 */
export async function configuredPhotoFolderStatusesForProperty(
  propertyId: number,
): Promise<ConfiguredPhotoFolderStatus[] | null> {
  if (propertyId > 0) {
    const builder = getUnitBuilderByPropertyId(propertyId);
    if (!builder) return null;
    const activeFolders = resolveActiveUnitPhotoFolders(
      propertyId,
      builder.units,
      await storage.getUnitSwaps(propertyId),
    );
    const activeFolderByUnitId = new Map(activeFolders.map((folder) => [folder.unitId, folder]));
    const statuses: ConfiguredPhotoFolderStatus[] = [
      await configuredFolderStatus({
        role: "community",
        label: `Community — ${builder.complexName}`,
        folder: builder.communityPhotoFolder,
      }),
    ];
    for (let i = 0; i < builder.units.length; i += 1) {
      const unit = builder.units[i];
      const active = activeFolderByUnitId.get(unit.id);
      statuses.push(await configuredFolderStatus({
        role: "unit",
        label: `Unit ${String.fromCharCode(65 + i)} (${unit.bedrooms}BR)`,
        folder: active?.activeFolder ?? unit.photoFolder ?? null,
        unitId: unit.id,
        expectedBedrooms: unit.bedrooms,
      }));
    }
    return statuses;
  }

  const draft = await storage.getCommunityDraft(-propertyId);
  if (!draft) return null;
  const isSingle = (draft as any).singleListing === true;
  const u1Br = resolveDraftUnitBedrooms(draft, "unit1");
  const u2Br = isSingle ? 0 : resolveDraftUnitBedrooms(draft, "unit2");
  const communityFolder =
    resolveCanonicalCommunityPhotoFolder(draft.name) ?? `community-draft-${draft.id}`;
  const unitInputs = [
    {
      role: "unit" as const,
      label: `Unit A (${u1Br}BR)`,
      folder: draft.unit1PhotoFolder ?? null,
      unitId: draftUnitIdForSlot(draft.id, "a"),
      expectedBedrooms: u1Br,
    },
    ...(!isSingle
      ? [{
          role: "unit" as const,
          label: `Unit B (${u2Br}BR)`,
          folder: draft.unit2PhotoFolder ?? null,
          unitId: draftUnitIdForSlot(draft.id, "b"),
          expectedBedrooms: u2Br,
        }]
      : []),
  ];
  return Promise.all([
    configuredFolderStatus({
      role: "community",
      label: `Community — ${draft.name}`,
      folder: communityFolder,
    }),
    ...unitInputs.map((input) => configuredFolderStatus(input)),
  ]);
}

export async function buildGroupFromPublishedFolder(
  role: "community" | "unit",
  label: string,
  folder: string,
  builder: PropertyUnitBuilder | null,
  expectedBedrooms?: number,
  unitDescription?: string,
  unitId?: string,
): Promise<CheckGroupInput | null> {
  const filenames = await listPublishedFilenames(folder);
  if (filenames.length === 0) return null;

  const labels = await storage.getPhotoLabelsByFolder(folder);
  const byFile = new Map(labels.map((l) => [l.filename, l]));
  const captions: Record<string, string> = {};
  const categories: Record<string, string> = {};
  const bedroomClusterIds: Record<string, string> = {};
  const bedroomBedTypes: Record<string, string> = {};
  const perceptualHashes: Record<string, string> = {};

  for (const filename of filenames) {
    const row = byFile.get(filename);
    const staticCap = builder ? staticCaptionFor(builder, folder, filename) : undefined;
    const staticCat = builder ? staticCategoryFor(builder, folder, filename) : undefined;
    captions[filename] = effectiveCaption(filename, row, staticCap);
    const cat = effectiveCategory(row) ?? staticCat ?? undefined;
    if (cat) categories[filename] = cat;
    if (row?.bedroomClusterId) bedroomClusterIds[filename] = row.bedroomClusterId;
    if (row?.bedroomBedType) bedroomBedTypes[filename] = row.bedroomBedType;
    if (row?.perceptualHash) perceptualHashes[filename] = row.perceptualHash;
  }

  const expectedBedInventory = unitDescription
    ? parseExpectedBedInventory(unitDescription)
    : undefined;

  // Only unit groups drive the source-page leg (the community folder's source is
  // the resort's own Guesty/master listing, not a per-unit for-sale page).
  const sourceUrl = role === "unit" ? await readFolderSourceUrl(folder) : undefined;

  return {
    role,
    label,
    unitId,
    folder,
    filenames,
    captions,
    categories,
    bedroomClusterIds,
    bedroomBedTypes,
    perceptualHashes,
    expectedBedrooms,
    unitDescription,
    expectedBedInventory: expectedBedInventory?.length ? expectedBedInventory : undefined,
    sourceUrl,
  };
}

function inferCombinedBedrooms(draft: CommunityDraft): number {
  const combined = positiveDraftInteger(draft.combinedBedrooms);
  if (combined) return combined;
  const u1 = resolveDraftUnitBedrooms(draft, "unit1");
  const isSingle = (draft as any).singleListing === true;
  const u2 = isSingle ? 0 : resolveDraftUnitBedrooms(draft, "unit2");
  return u1 + u2;
}

function unitDescriptionFromBuilder(unit: PropertyUnitBuilder["units"][number]): string {
  return [unit.shortDescription, unit.longDescription].filter(Boolean).join(" ");
}

export async function buildPhotoCommunityCheckRequestForProperty(
  propertyId: number,
): Promise<{ request: PhotoCommunityCheckRequest; label: string } | null> {
  const groups: CheckGroupInput[] = [];
  let complexName = "";
  let expectedListingBedrooms: number | null = null;

  if (propertyId > 0) {
    const builder = getUnitBuilderByPropertyId(propertyId);
    if (!builder) return null;
    complexName = builder.complexName;
    expectedListingBedrooms = builder.units.reduce((s, u) => s + (u.bedrooms ?? 0), 0) || null;
    const communityGroup = await buildGroupFromPublishedFolder(
      "community",
      `Community — ${complexName}`,
      builder.communityPhotoFolder,
      builder,
    );
    if (communityGroup) groups.push(communityGroup);
    // Verify each unit's ACTIVE photo folder — the replacement-* folder once
    // the operator swapped the unit's photos ("Replace photos" on the
    // duplicate-photos warning / preflight), else the unit's own folder. This
    // is what makes the Claude-vision community check confirm the photos the
    // listing will actually use; checking the stale original after a swap
    // verified the wrong gallery. Falls back to the original folder if the
    // replacement folder has no published photos yet (hydration pending).
    const activeFolders = resolveActiveUnitPhotoFolders(
      propertyId,
      builder.units,
      await storage.getUnitSwaps(propertyId),
    );
    const activeFolderByUnitId = new Map(activeFolders.map((f) => [f.unitId, f]));
    for (let i = 0; i < builder.units.length; i++) {
      const u = builder.units[i];
      if (!u.photoFolder) continue;
      const letter = String.fromCharCode(65 + i);
      const active = activeFolderByUnitId.get(u.id);
      const label = `Unit ${letter} (${u.bedrooms}BR)`;
      let g: CheckGroupInput | null = null;
      if (active?.replaced && active.activeFolder !== u.photoFolder) {
        g = await buildGroupFromPublishedFolder(
          "unit",
          label,
          active.activeFolder,
          builder,
          u.bedrooms,
          unitDescriptionFromBuilder(u),
          u.id,
        );
      }
      if (!g) {
        g = await buildGroupFromPublishedFolder(
          "unit",
          label,
          u.photoFolder,
          builder,
          u.bedrooms,
          unitDescriptionFromBuilder(u),
          u.id,
        );
      }
      if (g) groups.push(g);
    }
    return groups.length > 0
      ? {
          label: builder.propertyName || complexName,
          request: {
            expectedCommunity: complexName,
            expectedListingBedrooms: expectedListingBedrooms ?? undefined,
            groups,
          },
        }
      : null;
  }

  const draftId = -propertyId;
  const draft = await storage.getCommunityDraft(draftId);
  if (!draft) return null;
  const isSingle = (draft as any).singleListing === true;
  complexName = draft.name;
  const u1Br = resolveDraftUnitBedrooms(draft, "unit1");
  const u2Br = isSingle ? 0 : resolveDraftUnitBedrooms(draft, "unit2");
  expectedListingBedrooms = inferCombinedBedrooms(draft) || null;
  const communityFolder =
    resolveCanonicalCommunityPhotoFolder(draft.name) ?? `community-draft-${draft.id}`;
  const communityGroup = await buildGroupFromPublishedFolder(
    "community",
    `Community — ${complexName}`,
    communityFolder,
    null,
  );
  if (communityGroup) groups.push(communityGroup);
  const draftUnitDesc = (slot: "unit1" | "unit2") =>
    String((draft as any)[`${slot}Description`] ?? (draft as any)[`${slot}LongDescription`] ?? "");
  if (draft.unit1PhotoFolder) {
    const g1 = await buildGroupFromPublishedFolder(
      "unit",
      `Unit A (${u1Br}BR)`,
      draft.unit1PhotoFolder,
      null,
      u1Br,
      draftUnitDesc("unit1"),
      draftUnitIdForSlot(draft.id, "a"),
    );
    if (g1) groups.push(g1);
  }
  if (!isSingle && draft.unit2PhotoFolder) {
    const g2 = await buildGroupFromPublishedFolder(
      "unit",
      `Unit B (${u2Br}BR)`,
      draft.unit2PhotoFolder,
      null,
      u2Br,
      draftUnitDesc("unit2"),
      draftUnitIdForSlot(draft.id, "b"),
    );
    if (g2) groups.push(g2);
  }
  const label = draft.listingTitle || draft.name;
  return groups.length > 0
    ? {
        label,
        request: {
          expectedCommunity: complexName,
          expectedListingBedrooms: expectedListingBedrooms ?? undefined,
          groups,
        },
      }
    : null;
}
