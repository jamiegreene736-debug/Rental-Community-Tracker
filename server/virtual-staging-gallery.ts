import { and, eq } from "drizzle-orm";

import { resolveScopedVirtualStagingGallery } from "@shared/virtual-staging";
import { db } from "./db";
import { virtualStagingCandidates } from "./virtual-staging-schema";

/**
 * Folder-only consumers cannot safely choose between active variants because a
 * physical gallery may be shared by multiple logical units. Use this guard to
 * require unit context before reading or mutating such a gallery.
 */
export async function folderHasActiveVirtualStagingVariants(folder: string): Promise<boolean> {
  const [variant] = await db.select({
    candidateFilename: virtualStagingCandidates.candidateFilename,
  }).from(virtualStagingCandidates).where(and(
    eq(virtualStagingCandidates.folder, folder),
    eq(virtualStagingCandidates.active, true),
  )).limit(1);

  return variant !== undefined;
}

/** Resolve one physical photo folder through the active variants for one unit. */
export async function resolveVirtualStagingGalleryFiles(input: {
  diskFilenames: readonly string[];
  propertyId: number;
  unitId: string;
  folder: string;
}): Promise<string[]> {
  const variants = await db.select({
    propertyId: virtualStagingCandidates.propertyId,
    unitId: virtualStagingCandidates.unitId,
    folder: virtualStagingCandidates.folder,
    originalFilename: virtualStagingCandidates.originalFilename,
    candidateFilename: virtualStagingCandidates.candidateFilename,
    active: virtualStagingCandidates.active,
  }).from(virtualStagingCandidates).where(eq(virtualStagingCandidates.folder, input.folder));

  return resolveScopedVirtualStagingGallery({ ...input, variants });
}
