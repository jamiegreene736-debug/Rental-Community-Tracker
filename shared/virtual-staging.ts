export const VIRTUAL_STAGING_PROMPT =
  "Use the uploaded photograph as the exact base image and perform virtual staging only. " +
  "Preserve the condo's permanent architecture and photographic geometry: walls, ceilings, floors, windows, doors, trim, columns, room dimensions, kitchen cabinets, countertops, appliances, built-ins, permanent fixtures, balcony, exterior view, camera position, lens perspective, crop, and ambient lighting. " +
  "Remove or replace only movable furniture, rugs, lamps, artwork, plants, and decorative accessories. " +
  "Add photorealistic, correctly scaled, neutral contemporary luxury furniture appropriate for the room type. " +
  "Create physically plausible shadows for the new furniture. " +
  "Do not move openings, redesign finishes, enlarge the room, straighten the perspective, change the exterior view, add people, or add text, logos, or watermarks.";

export type VirtualStagingJobStatus =
  | "queued"
  | "running"
  | "ready"
  | "confirmed"
  | "failed";

export type VirtualStagingCandidateStatus =
  | "pending"
  | "generating"
  | "succeeded"
  | "failed";

export type VirtualStagingCandidateDto = {
  id: string;
  originalFilename: string;
  originalUrl: string;
  roomLabel: string;
  stagedUrl: string | null;
  status: VirtualStagingCandidateStatus;
  error: string | null;
  attempt: number;
};

export type VirtualStagingJobDto = {
  id: string;
  propertyId: number;
  unitId: string;
  unitLabel: string;
  status: VirtualStagingJobStatus;
  total: number;
  completed: number;
  failed: number;
  selectedCount: number;
  candidates: VirtualStagingCandidateDto[];
  createdAt: string;
  updatedAt: string;
};

export type VirtualStagingSessionAction = "start" | "resume" | "blocked";

/**
 * Decide whether a unit control starts a new paid run, resumes the retained
 * review session, or stays blocked behind another unit's unconfirmed session.
 */
export function virtualStagingSessionAction(input: {
  requestedUnitId: string;
  sessionUnitId: string | null;
  hasResumableSession: boolean;
}): VirtualStagingSessionAction {
  if (!input.hasResumableSession) return "start";
  return input.requestedUnitId === input.sessionUnitId ? "resume" : "blocked";
}

export type VirtualStagingLabelSnapshot = {
  filename: string;
  label: string;
  category: string | null;
  confidence: number | null;
  userLabel: string | null;
  userCategory: string | null;
  hidden: boolean;
  sortOrder: number | null;
  model: string | null;
  perceptualHash: string | null;
  bedroomClusterId: string | null;
  bedroomBedType: string | null;
  channelUsage: string | null;
};

export type VirtualStagingVariantSnapshot = {
  originalFilename: string;
  candidateFilename: string;
  active: boolean;
};

export type ScopedVirtualStagingVariant = VirtualStagingVariantSnapshot & {
  propertyId: number;
  unitId: string;
  folder: string;
};

export type VirtualStagingSource = {
  originalFilename: string;
  activeFilename: string;
  roomLabel: string;
  metadata: VirtualStagingLabelSnapshot | null;
};

const IMAGE_FILE_RE = /\.(?:jpe?g|png|webp)$/i;
export const VIRTUAL_STAGING_CANDIDATE_FILENAME_RE = /^virtual-staged-[0-9a-f-]{36}\.jpg$/i;

export function isVirtualStagingCandidateFilename(filename: string): boolean {
  return VIRTUAL_STAGING_CANDIDATE_FILENAME_RE.test(filename);
}

/**
 * Project one physical folder into a unit-scoped active gallery. Some legacy
 * listings intentionally share a source folder across units and properties,
 * so photo_labels.hidden cannot safely decide which original or staged variant
 * is active. Generated files are excluded globally, then only this unit's
 * active candidate replaces its own immutable original in-place.
 */
export function resolveScopedVirtualStagingGallery(input: {
  diskFilenames: readonly string[];
  variants: readonly ScopedVirtualStagingVariant[];
  propertyId: number;
  unitId: string;
  folder: string;
}): string[] {
  const disk = new Set(input.diskFilenames);
  const activeByOriginal = new Map(
    input.variants
      .filter((variant) =>
        variant.active
        && variant.propertyId === input.propertyId
        && variant.unitId === input.unitId
        && variant.folder === input.folder
        && disk.has(variant.candidateFilename),
      )
      .map((variant) => [variant.originalFilename, variant.candidateFilename]),
  );

  return input.diskFilenames
    .filter((filename) => !isVirtualStagingCandidateFilename(filename))
    .map((filename) => activeByOriginal.get(filename) ?? filename);
}

/**
 * Resolve the visible unit gallery to immutable source files. Generated
 * candidates are never allowed to become a future image-edit input.
 */
export function resolveVirtualStagingSources(input: {
  diskFilenames: readonly string[];
  labels: readonly VirtualStagingLabelSnapshot[];
  variants: readonly VirtualStagingVariantSnapshot[];
}): VirtualStagingSource[] {
  const labelByFilename = new Map(input.labels.map((row) => [row.filename, row]));
  const candidateFilenames = new Set(input.variants.map((row) => row.candidateFilename));
  const activeByOriginal = new Map(
    input.variants
      .filter((row) => row.active)
      .map((row) => [row.originalFilename, row.candidateFilename]),
  );

  return input.diskFilenames
    .filter((filename) => IMAGE_FILE_RE.test(filename) && !candidateFilenames.has(filename))
    .map((originalFilename, originalIndex) => {
      const activeFilename = activeByOriginal.get(originalFilename) ?? originalFilename;
      const metadata = labelByFilename.get(activeFilename) ?? labelByFilename.get(originalFilename) ?? null;
      return {
        originalFilename,
        activeFilename,
        roomLabel:
          metadata?.userLabel?.trim()
          || metadata?.label?.trim()
          || originalFilename.replace(/\.[^.]+$/, "").replace(/^\d+[-_]/, "").replace(/[-_]+/g, " ")
          || "Photo",
        metadata,
        originalIndex,
      };
    })
    .filter((source) => !source.metadata?.hidden)
    .sort((a, b) => {
      const aOrder = a.metadata?.sortOrder;
      const bOrder = b.metadata?.sortOrder;
      if (aOrder != null && bOrder != null && aOrder !== bOrder) return aOrder - bOrder;
      if (aOrder != null && bOrder == null) return -1;
      if (aOrder == null && bOrder != null) return 1;
      return a.originalIndex - b.originalIndex;
    })
    .map(({ originalIndex: _originalIndex, ...source }) => source);
}

export function summarizeCandidateStatuses(
  statuses: readonly VirtualStagingCandidateStatus[],
): Pick<VirtualStagingJobDto, "status" | "total" | "completed" | "failed"> {
  const total = statuses.length;
  const completed = statuses.filter((status) => status === "succeeded" || status === "failed").length;
  const failed = statuses.filter((status) => status === "failed").length;
  const succeeded = statuses.filter((status) => status === "succeeded").length;
  const running = statuses.some((status) => status === "pending" || status === "generating");
  return {
    status: running ? "running" : succeeded > 0 ? "ready" : "failed",
    total,
    completed,
    failed,
  };
}

export type SelectableVirtualStagingCandidate = {
  id: string;
  status: VirtualStagingCandidateStatus;
  propertyId: number;
  unitId: string;
  jobId: string;
};

/** Validate untrusted confirmation IDs before any storage or DB mutation. */
export function validateVirtualStagingSelection(input: {
  candidateIds: readonly string[];
  candidates: readonly SelectableVirtualStagingCandidate[];
  propertyId: number;
  unitId: string;
  jobId: string;
}): string[] {
  const uniqueIds = Array.from(new Set(input.candidateIds));
  if (uniqueIds.length !== input.candidateIds.length) {
    throw new Error("Candidate selection contains duplicates");
  }
  if (uniqueIds.length === 0) throw new Error("Select at least one staged photo");
  const byId = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
  for (const id of uniqueIds) {
    const candidate = byId.get(id);
    if (!candidate) throw new Error("A selected staged photo does not belong to this job");
    if (
      candidate.propertyId !== input.propertyId
      || candidate.unitId !== input.unitId
      || candidate.jobId !== input.jobId
    ) {
      throw new Error("A selected staged photo does not belong to this unit");
    }
    if (candidate.status !== "succeeded") {
      throw new Error("Only successfully generated staged photos can be applied");
    }
  }
  return uniqueIds;
}

export function sameVirtualStagingSelection(
  left: readonly string[] | null | undefined,
  right: readonly string[] | null | undefined,
): boolean {
  if (!left || !right || left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((id, index) => id === sortedRight[index]);
}

export function reusableVirtualStagingJobId(
  jobs: ReadonlyArray<{
    id: string;
    propertyId: number;
    unitId: string;
    status: VirtualStagingJobStatus;
  }>,
  propertyId: number,
  unitId: string,
): string | null {
  // Callers provide newest-first rows. The newest row is authoritative: a
  // confirmed review must supersede (rather than reveal) an older ready one.
  const latest = jobs.find((job) =>
    job.propertyId === propertyId
    && job.unitId === unitId,
  );
  return latest && latest.status !== "confirmed" ? latest.id : null;
}
