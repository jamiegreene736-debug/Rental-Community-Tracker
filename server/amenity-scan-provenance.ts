import { createHash } from "node:crypto";

import type { AmenityScanProvenance } from "@shared/amenity-scan-logic";

export type AmenityPhotoFingerprintInput = {
  groupLabel: string;
  role: "community" | "unit";
  filename: string;
  bytes: Uint8Array;
};

export type AmenityStrictVisionFailureCode =
  | "missing-api-key"
  | "no-photo-groups"
  | "no-readable-photos"
  | "incomplete-photo-group-coverage"
  | "vision-batch-failed";

/** A typed failure lets HTTP/job callers distinguish strict audit failures. */
export class AmenityStrictVisionError extends Error {
  readonly code: AmenityStrictVisionFailureCode;
  readonly provenance: AmenityScanProvenance;

  constructor(
    code: AmenityStrictVisionFailureCode,
    message: string,
    provenance: AmenityScanProvenance,
  ) {
    super(message);
    this.name = "AmenityStrictVisionError";
    this.code = code;
    this.provenance = provenance;
  }
}

export type AmenityPhotoGroupCoverage = {
  role: "community" | "unit";
  label: string;
  folder: string;
  /** Published images the strict scan intended to send. */
  publishedPhotos?: number;
  readablePhotos: number;
};

/** Every published group must contribute a readable sample to a strict scan. */
export function groupsWithoutReadableAmenityPhotos(
  coverage: readonly AmenityPhotoGroupCoverage[],
): AmenityPhotoGroupCoverage[] {
  return coverage.filter((group) => !Number.isFinite(group.readablePhotos) || group.readablePhotos < 1);
}

export function groupsWithIncompleteAmenityPhotoCoverage(
  coverage: readonly AmenityPhotoGroupCoverage[],
): AmenityPhotoGroupCoverage[] {
  return coverage.filter((group) => {
    if (!Number.isFinite(group.readablePhotos) || group.readablePhotos < 1) return true;
    // Legacy/manual callers may omit the total and retain the historical
    // at-least-one-photo rule. Strict server scans always provide it.
    return Number.isFinite(group.publishedPhotos)
      && (group.publishedPhotos ?? 0) !== group.readablePhotos;
  });
}

export function assertCompleteAmenityPhotoGroupCoverage(
  coverage: readonly AmenityPhotoGroupCoverage[],
  provenance: AmenityScanProvenance,
): void {
  const missing = groupsWithIncompleteAmenityPhotoCoverage(coverage);
  if (missing.length === 0) return;

  const labels = missing.map((group) => {
    const count = Number.isFinite(group.publishedPhotos)
      ? `: ${group.readablePhotos}/${group.publishedPhotos} readable`
      : "";
    return `${group.label} (${group.folder}${count})`;
  }).join(", ");
  throw new AmenityStrictVisionError(
    "incomplete-photo-group-coverage",
    `Claude amenity scan requires every published photo to be readable and scanned. Incomplete: ${labels}.`,
    provenance,
  );
}

function updateLengthPrefixed(hash: ReturnType<typeof createHash>, value: string | Uint8Array): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength, 0);
  hash.update(length);
  hash.update(bytes);
}

/**
 * Hash the sampled photo identities and contents in canonical order. This is
 * deterministic across process restarts and insensitive to directory-read
 * ordering, while still changing if a file is replaced in place.
 */
export function buildAmenityPhotoFingerprint(photos: AmenityPhotoFingerprintInput[]): string | undefined {
  if (photos.length === 0) return undefined;
  const canonical = [...photos].sort((a, b) => {
    const aKey = `${a.role}\u0000${a.groupLabel}\u0000${a.filename}`;
    const bKey = `${b.role}\u0000${b.groupLabel}\u0000${b.filename}`;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
  const hash = createHash("sha256");
  hash.update("amenity-photo-scan.v1\0");
  for (const photo of canonical) {
    updateLengthPrefixed(hash, photo.role);
    updateLengthPrefixed(hash, photo.groupLabel);
    updateLengthPrefixed(hash, photo.filename);
    updateLengthPrefixed(hash, photo.bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

export function buildAmenityScanProvenance(input: {
  model: string;
  photoFingerprint?: string;
  photosConsidered: number;
  groupsConsidered: number;
  groupsWithReadablePhotos: number;
  batchesAttempted: number;
  batchesSucceeded: number;
  batchesFailed: number;
  completedAt?: string;
}): AmenityScanProvenance {
  const completeGroupCoverage = input.groupsConsidered > 0
    && input.groupsWithReadablePhotos === input.groupsConsidered;
  const method = completeGroupCoverage
    && input.batchesAttempted > 0
    && input.batchesSucceeded === input.batchesAttempted
    && input.batchesFailed === 0
    ? "claude-vision"
    : input.batchesSucceeded > 0
      ? "partial-vision"
      : "baseline-only";
  return {
    method,
    ...(method === "baseline-only" ? {} : { model: input.model }),
    ...(input.photoFingerprint ? { photoFingerprint: input.photoFingerprint } : {}),
    photosConsidered: input.photosConsidered,
    groupsConsidered: input.groupsConsidered,
    groupsWithReadablePhotos: input.groupsWithReadablePhotos,
    batchesAttempted: input.batchesAttempted,
    batchesSucceeded: input.batchesSucceeded,
    batchesFailed: input.batchesFailed,
    completedAt: input.completedAt ?? new Date().toISOString(),
  };
}

export function isCompleteClaudeAmenityVision(provenance: AmenityScanProvenance): boolean {
  return provenance.method === "claude-vision"
    && Boolean(provenance.model)
    && Boolean(provenance.photoFingerprint)
    && provenance.photosConsidered > 0
    && provenance.groupsConsidered > 0
    && provenance.groupsWithReadablePhotos === provenance.groupsConsidered
    && provenance.batchesAttempted > 0
    && provenance.batchesSucceeded === provenance.batchesAttempted
    && provenance.batchesFailed === 0;
}
