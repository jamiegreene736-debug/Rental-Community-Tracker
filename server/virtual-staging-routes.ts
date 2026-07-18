import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { Express, Request, Response } from "express";
import sharp from "sharp";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import {
  communityDrafts,
  photoLabels,
  unitSwaps,
} from "@shared/schema";
import {
  photoOriginalAssets,
  virtualStagingCandidates,
  virtualStagingJobs,
  type PhotoOriginalAsset,
  type VirtualStagingCandidate,
  type VirtualStagingJob,
} from "./virtual-staging-schema";
import {
  resolveStageableVirtualStagingSources,
  isVirtualStagingCandidateFilename,
  sameVirtualStagingSelection,
  summarizeCandidateStatuses,
  validateVirtualStagingSelection,
  VIRTUAL_STAGING_RECIPE_SIGNATURE_PREFIX,
  VIRTUAL_STAGING_SUPERSEDED_RECIPE_SIGNATURES,
  VIRTUAL_STAGING_FEEDBACK_MAX_LENGTH,
  isSupersededVirtualStagingRecipeSignature,
  virtualStagingContextForSource,
  type VirtualStagingCandidateDto,
  type VirtualStagingCandidateStatus,
  type VirtualStagingJobDto,
  type VirtualStagingJobStatus,
  type VirtualStagingLabelSnapshot,
} from "@shared/virtual-staging";
import { draftUnitIdForSlot } from "@shared/auto-replace-job-logic";
import { replacementPhotoFolderForUnit } from "@shared/unit-swap-photos";
import { getUnitBuilderByPropertyId } from "../client/src/data/unit-builder-data";
import type { PortalSession } from "./auth";
import { db } from "./db";
import {
  getVirtualStagingService,
  VirtualStagingConfigurationError,
} from "./virtual-staging-service";

const IMAGE_FILE_RE = /\.(?:jpe?g|png|webp)$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_JOB_STATUSES = ["queued", "running"] as const;
const RESUMABLE_JOB_STATUSES = ["queued", "running", "ready", "failed"] as const;
// Image editing can consume five minutes and the fail-closed vision verifier
// can retry for roughly three more. Keep enough fencing margin that a healthy
// worker cannot lose ownership immediately before publishing its output.
const GENERATION_LEASE_MS = 12 * 60 * 1_000;
const GENERATION_LEASE_HEARTBEAT_MS = 2 * 60 * 1_000;
const RECOVERY_SWEEP_MS = 30 * 1_000;
const OUTDATED_RECIPE_MESSAGE =
  "Superseded by an updated virtual-staging recipe without applying any photos.";
const PREVIOUS_PREVIEW_PATH_KEY = "__virtualStagingPreviousPreviewRelativePath";
const PREVIOUS_PREVIEW_FILENAME_KEY = "__virtualStagingPreviousPreviewFilename";
const GENERATION_MODE_KEY = "__virtualStagingGenerationMode";
const FEEDBACK_KEY = "__virtualStagingFeedback";
const FEEDBACK_SOURCE_ATTEMPT_KEY = "__virtualStagingFeedbackSourceAttempt";
const FEEDBACK_GENERATION_MODE = "feedback-revision";

let recoverySweepTimer: NodeJS.Timeout | null = null;

class VirtualStagingHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "VirtualStagingHttpError";
  }
}

export type VirtualStagingStartInput = { propertyId: number; unitId: string };

export type ResolvedVirtualStagingUnit = {
  propertyId: number;
  unitId: string;
  unitLabel: string;
  folder: string;
};

export type VirtualStagingConfirmationFilePlan = {
  candidateId: string;
  folder: string;
  candidateFilename: string;
  stagedPath: string;
  galleryPath: string;
};

function photosRoot(): string {
  return path.resolve(process.cwd(), "client/public/photos");
}

function assertSafeFolder(folder: string): string {
  const value = folder.trim();
  if (!value || !/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new VirtualStagingHttpError(409, "This unit does not have a valid photo folder");
  }
  return value;
}

function resolveInsidePhotosRoot(relativePath: string): string {
  const root = photosRoot();
  const absolute = path.resolve(root, relativePath);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error("Stored virtual-staging path escaped the photo volume");
  }
  return absolute;
}

function folderFilePath(folder: string, filename: string): string {
  if (!/^[a-zA-Z0-9_.-]+$/.test(filename) || path.basename(filename) !== filename) {
    throw new Error("Invalid photo filename");
  }
  return resolveInsidePhotosRoot(path.join(assertSafeFolder(folder), filename));
}

function sha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function pgErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : undefined;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return "Virtual staging failed";
}

export function scheduleVirtualStagingTask(
  label: string,
  task: () => Promise<void>,
  reportError: (message: string) => void = (message) => console.warn(message),
): void {
  void Promise.resolve()
    .then(task)
    .catch((error) => {
      reportError(`[virtual-staging] ${label} failed: ${safeErrorMessage(error)}`);
    });
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export function validateVirtualStagingStartInput(body: unknown): VirtualStagingStartInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new VirtualStagingHttpError(400, "propertyId and unitId are required");
  }
  const propertyId = (body as Record<string, unknown>).propertyId;
  const unitIdRaw = (body as Record<string, unknown>).unitId;
  if (typeof propertyId !== "number" || !Number.isSafeInteger(propertyId) || propertyId === 0) {
    throw new VirtualStagingHttpError(400, "propertyId must be a non-zero integer");
  }
  if (typeof unitIdRaw !== "string" || !unitIdRaw.trim() || unitIdRaw.trim().length > 200) {
    throw new VirtualStagingHttpError(400, "unitId must be a non-empty string");
  }
  return { propertyId, unitId: unitIdRaw.trim() };
}

export type VirtualStagingCandidateSelectionInput = {
  id: string;
  attempt: number;
};

export function validateVirtualStagingCandidateSelections(
  body: unknown,
): VirtualStagingCandidateSelectionInput[] {
  const raw = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).candidateSelections
    : undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 200) {
    throw new VirtualStagingHttpError(400, "candidateSelections must be a non-empty array");
  }
  const selections = raw.map((selection) => {
    const record = selection && typeof selection === "object" && !Array.isArray(selection)
      ? selection as Record<string, unknown>
      : {};
    return {
      id: typeof record.id === "string" ? record.id.trim() : "",
      attempt: record.attempt,
    };
  });
  if (selections.some((selection) => !UUID_RE.test(selection.id))) {
    throw new VirtualStagingHttpError(400, "candidateSelections contains an invalid ID");
  }
  if (selections.some((selection) => typeof selection.attempt !== "number"
    || !Number.isSafeInteger(selection.attempt)
    || selection.attempt < 1)) {
    throw new VirtualStagingHttpError(400, "candidateSelections contains an invalid generation attempt");
  }
  const ids = selections.map((selection) => selection.id);
  if (new Set(ids).size !== ids.length) {
    throw new VirtualStagingHttpError(400, "candidateSelections contains duplicate IDs");
  }
  return selections as VirtualStagingCandidateSelectionInput[];
}

export type VirtualStagingRetryInput = { attempt: number };
export type VirtualStagingFeedbackInput = VirtualStagingRetryInput & { feedback: string };

function validatedGenerationAttempt(body: unknown): number {
  const attempt = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).attempt
    : undefined;
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new VirtualStagingHttpError(400, "attempt must identify the reviewed generation");
  }
  return attempt;
}

export function validateVirtualStagingRetryInput(body: unknown): VirtualStagingRetryInput {
  return { attempt: validatedGenerationAttempt(body) };
}

export function validateVirtualStagingFeedbackInput(body: unknown): VirtualStagingFeedbackInput {
  const attempt = validatedGenerationAttempt(body);
  const rawFeedback = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).feedback
    : undefined;
  if (typeof rawFeedback !== "string") {
    throw new VirtualStagingHttpError(400, "feedback must be text");
  }
  const feedback = rawFeedback.replace(/\r\n?/g, "\n").trim();
  if (!feedback) throw new VirtualStagingHttpError(400, "feedback cannot be empty");
  if (feedback.length > VIRTUAL_STAGING_FEEDBACK_MAX_LENGTH) {
    throw new VirtualStagingHttpError(
      400,
      `feedback must be ${VIRTUAL_STAGING_FEEDBACK_MAX_LENGTH} characters or fewer`,
    );
  }
  // Keep ordinary Unicode and line breaks, but reject invisible controls that
  // can obscure the true instruction in review or model prompts.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/.test(feedback)) {
    throw new VirtualStagingHttpError(400, "feedback contains unsupported control characters");
  }
  return { attempt, feedback };
}

export function virtualStagingCandidateFilename(candidateId: string): string {
  if (!UUID_RE.test(candidateId)) throw new Error("Invalid candidate ID");
  return `virtual-staged-${candidateId}.jpg`;
}

function candidateStorageRelativePath(jobId: string, candidateId: string): string {
  if (!UUID_RE.test(jobId) || !UUID_RE.test(candidateId)) throw new Error("Invalid virtual-staging ID");
  return path.posix.join(".virtual-staging", "candidates", jobId, `${candidateId}.jpg`);
}

export function buildVirtualStagingConfirmationFilePlan(
  candidates: readonly Pick<VirtualStagingCandidate, "id" | "folder" | "candidateFilename" | "stagingRelativePath">[],
): VirtualStagingConfirmationFilePlan[] {
  return candidates.map((candidate) => {
    if (!candidate.stagingRelativePath) throw new Error("A selected staged photo has no stored image");
    if (!isVirtualStagingCandidateFilename(candidate.candidateFilename)) {
      throw new Error("A selected staged photo has an invalid filename");
    }
    return {
      candidateId: candidate.id,
      folder: assertSafeFolder(candidate.folder),
      candidateFilename: candidate.candidateFilename,
      stagedPath: resolveInsidePhotosRoot(candidate.stagingRelativePath),
      galleryPath: folderFilePath(candidate.folder, candidate.candidateFilename),
    };
  });
}

export async function ensureVirtualStagingGalleryFile(
  stagedPath: string,
  galleryPath: string,
): Promise<"created" | "existing"> {
  try {
    await fs.promises.copyFile(stagedPath, galleryPath, fs.constants.COPYFILE_EXCL);
    return "created";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const [staged, existing] = await Promise.all([
      fs.promises.readFile(stagedPath),
      fs.promises.readFile(galleryPath),
    ]);
    if (sha256(existing) !== sha256(staged)) {
      throw new Error("A staged gallery filename already contains different data");
    }
    return "existing";
  }
}

function requireAdmin(res: Response): PortalSession | null {
  const session = res.locals.portalSession as PortalSession | undefined;
  if (!session || session.role !== "admin") {
    res.status(403).json({ error: "Administrator access is required" });
    return null;
  }
  return session;
}

export async function resolveVirtualStagingUnit(
  propertyId: number,
  unitId: string,
): Promise<ResolvedVirtualStagingUnit> {
  let baseFolder = "";
  let unitLabel = "";

  if (propertyId > 0) {
    const builder = getUnitBuilderByPropertyId(propertyId);
    if (!builder) throw new VirtualStagingHttpError(404, "Property was not found");
    const index = builder.units.findIndex((unit) => unit.id === unitId);
    if (index < 0) throw new VirtualStagingHttpError(404, "Unit was not found for this property");
    baseFolder = builder.units[index].photoFolder ?? "";
    unitLabel = `Unit ${String.fromCharCode(65 + index)}`;
  } else {
    const draftId = -propertyId;
    const [draft] = await db
      .select()
      .from(communityDrafts)
      .where(eq(communityDrafts.id, draftId))
      .limit(1);
    if (!draft) throw new VirtualStagingHttpError(404, "Property draft was not found");
    const unitAId = draftUnitIdForSlot(draftId, "a");
    const unitBId = draftUnitIdForSlot(draftId, "b");
    if (unitId === unitAId) {
      baseFolder = draft.unit1PhotoFolder ?? `draft-${draftId}-unit-a`;
      unitLabel = "Unit A";
    } else if (unitId === unitBId && draft.singleListing !== true) {
      baseFolder = draft.unit2PhotoFolder ?? `draft-${draftId}-unit-b`;
      unitLabel = "Unit B";
    } else {
      throw new VirtualStagingHttpError(404, "Unit was not found for this property");
    }
  }

  // Match the builder exactly: only the newest swap row matters. A newest
  // uncommitted row does not cause an older committed replacement to reappear.
  const [latestSwap] = await db
    .select({ committed: unitSwaps.committed })
    .from(unitSwaps)
    .where(and(eq(unitSwaps.propertyId, propertyId), eq(unitSwaps.oldUnitId, unitId)))
    .orderBy(desc(unitSwaps.createdAt))
    .limit(1);
  const folder = latestSwap?.committed === true
    ? replacementPhotoFolderForUnit(propertyId, unitId)
    : baseFolder;
  return { propertyId, unitId, unitLabel, folder: assertSafeFolder(folder) };
}

function labelSnapshot(row: typeof photoLabels.$inferSelect): VirtualStagingLabelSnapshot {
  return {
    filename: row.filename,
    label: row.label,
    category: row.category,
    confidence: row.confidence,
    userLabel: row.userLabel,
    userCategory: row.userCategory,
    hidden: row.hidden,
    sortOrder: row.sortOrder,
    model: row.model,
    perceptualHash: row.perceptualHash,
    bedroomClusterId: row.bedroomClusterId,
    bedroomBedType: row.bedroomBedType,
    channelUsage: row.channelUsage,
  };
}

async function listUnitSources(unit: ResolvedVirtualStagingUnit) {
  const directory = resolveInsidePhotosRoot(unit.folder);
  const stat = await fs.promises.stat(directory).catch(() => null);
  if (!stat?.isDirectory()) throw new VirtualStagingHttpError(409, `${unit.unitLabel} has no photo folder`);
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const diskFilenames = entries
    .filter((entry) => entry.isFile() && IMAGE_FILE_RE.test(entry.name) && !isVirtualStagingCandidateFilename(entry.name))
    .map((entry) => entry.name)
    .sort();
  const [labels, variants] = await Promise.all([
    db.select().from(photoLabels).where(eq(photoLabels.folder, unit.folder)),
    db.select({
      propertyId: virtualStagingCandidates.propertyId,
      unitId: virtualStagingCandidates.unitId,
      originalFilename: virtualStagingCandidates.originalFilename,
      candidateFilename: virtualStagingCandidates.candidateFilename,
      active: virtualStagingCandidates.active,
    }).from(virtualStagingCandidates).where(eq(virtualStagingCandidates.folder, unit.folder)),
  ]);
  return resolveStageableVirtualStagingSources({
    diskFilenames,
    labels: labels.map(labelSnapshot),
    // Every generated filename in this physical folder is excluded, but only
    // this property+unit's active row may redirect its logical original.
    variants: variants.map((variant) => ({
      originalFilename: variant.originalFilename,
      candidateFilename: variant.candidateFilename,
      active: variant.active
        && variant.propertyId === unit.propertyId
        && variant.unitId === unit.unitId,
    })),
  });
}

export async function ensureImmutableSnapshot(destination: string, buffer: Buffer): Promise<void> {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const temporary = path.join(path.dirname(destination), `.snapshot-${crypto.randomUUID()}.tmp`);
  await fs.promises.writeFile(temporary, buffer, { flag: "wx" });
  try {
    try {
      await fs.promises.link(temporary, destination);
    } catch (error) {
      if (pgErrorCode(error) !== "EEXIST" && (error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      const existing = await fs.promises.readFile(destination);
      if (sha256(existing) !== sha256(buffer)) {
        throw new Error("Immutable original snapshot failed its integrity check");
      }
    }
  } finally {
    await fs.promises.unlink(temporary).catch(() => undefined);
  }
}

async function ensureOriginalAsset(
  unit: ResolvedVirtualStagingUnit,
  filename: string,
): Promise<PhotoOriginalAsset> {
  const sourcePath = folderFilePath(unit.folder, filename);
  const source = await fs.promises.readFile(sourcePath).catch(() => {
    throw new VirtualStagingHttpError(409, `Original photo is missing: ${filename}`);
  });
  const metadata = await sharp(source, { failOn: "error" }).metadata();
  if (!metadata.width || !metadata.height || !["jpeg", "png", "webp"].includes(metadata.format ?? "")) {
    throw new VirtualStagingHttpError(422, `Original photo is not a supported image: ${filename}`);
  }
  const sourceSha256 = sha256(source);
  const extension = metadata.format === "jpeg" ? "jpg" : metadata.format!;
  const storageRelativePath = path.posix.join(
    ".virtual-staging",
    "originals",
    `${sourceSha256}.${extension}`,
  );
  await ensureImmutableSnapshot(resolveInsidePhotosRoot(storageRelativePath), source);

  const lookup = and(
    eq(photoOriginalAssets.propertyId, unit.propertyId),
    eq(photoOriginalAssets.unitId, unit.unitId),
    eq(photoOriginalAssets.folder, unit.folder),
    eq(photoOriginalAssets.filename, filename),
    eq(photoOriginalAssets.sourceSha256, sourceSha256),
  );
  const [existing] = await db.select().from(photoOriginalAssets).where(lookup).limit(1);
  if (existing) return existing;
  const id = crypto.randomUUID();
  try {
    const [inserted] = await db.insert(photoOriginalAssets).values({
      id,
      propertyId: unit.propertyId,
      unitId: unit.unitId,
      folder: unit.folder,
      filename,
      sourceSha256,
      storageRelativePath,
      mimeType: metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}`,
      byteSize: source.length,
      width: metadata.width,
      height: metadata.height,
    }).returning();
    return inserted;
  } catch (error) {
    if (pgErrorCode(error) !== "23505") throw error;
    const [raced] = await db.select().from(photoOriginalAssets).where(lookup).limit(1);
    if (!raced) throw error;
    return raced;
  }
}

function jobIsResumableForUnit(
  job: VirtualStagingJob,
  unit: ResolvedVirtualStagingUnit,
): boolean {
  if (!RESUMABLE_JOB_STATUSES.includes(job.status as typeof RESUMABLE_JOB_STATUSES[number])) {
    return false;
  }
  // An in-flight job remains the unit's singleton even if its folder changes.
  // Terminal previews are only reusable against the same immutable source
  // folder; otherwise a later unit swap should start a fresh review.
  return ACTIVE_JOB_STATUSES.includes(job.status as typeof ACTIVE_JOB_STATUSES[number])
    || job.folder === unit.folder;
}

async function findResumableJob(
  unit: ResolvedVirtualStagingUnit,
  recipeSignature: string,
): Promise<VirtualStagingJob | undefined> {
  const [job] = await db
    .select()
    .from(virtualStagingJobs)
    .where(and(
      eq(virtualStagingJobs.propertyId, unit.propertyId),
      eq(virtualStagingJobs.unitId, unit.unitId),
    ))
    .orderBy(desc(virtualStagingJobs.createdAt))
    .limit(1);
  return job && job.model === recipeSignature && jobIsResumableForUnit(job, unit)
    ? job
    : undefined;
}

function candidateDto(jobId: string, candidate: VirtualStagingCandidate): VirtualStagingCandidateDto {
  const status = candidate.status as VirtualStagingCandidateStatus;
  const snapshot = candidate.metadataSnapshot
    && typeof candidate.metadataSnapshot === "object"
    && !Array.isArray(candidate.metadataSnapshot)
    ? candidate.metadataSnapshot as Record<string, unknown>
    : {};
  const previousPreviewRelativePath = snapshotString(snapshot, PREVIOUS_PREVIEW_PATH_KEY);
  // Candidate timestamps change when generation/retry completes. Versioning
  // the URLs evicts the 404 responses produced by the old dotfile-blocked
  // route and prevents a retry from reusing a stale browser preview.
  const previewVersion = encodeURIComponent(asIso(candidate.updatedAt));
  return {
    id: candidate.id,
    originalFilename: candidate.originalFilename,
    originalUrl: `/api/virtual-staging/jobs/${jobId}/candidates/${candidate.id}/original?v=${previewVersion}`,
    roomLabel: candidate.roomLabel,
    stagedUrl: status === "succeeded"
      ? `/api/virtual-staging/jobs/${jobId}/candidates/${candidate.id}/staged?v=${previewVersion}`
      : null,
    previousStagedUrl: status !== "succeeded" && previousPreviewRelativePath
      ? `/api/virtual-staging/jobs/${jobId}/candidates/${candidate.id}/previous-staged?v=${previewVersion}`
      : null,
    status,
    error: candidate.error,
    attempt: candidate.attempt,
    lastFeedback: snapshotString(snapshot, FEEDBACK_KEY),
  };
}

async function getJobDto(jobId: string): Promise<VirtualStagingJobDto | null> {
  const [job] = await db.select().from(virtualStagingJobs).where(eq(virtualStagingJobs.id, jobId)).limit(1);
  if (!job) return null;
  const candidates = await db
    .select()
    .from(virtualStagingCandidates)
    .where(eq(virtualStagingCandidates.jobId, jobId))
    .orderBy(asc(virtualStagingCandidates.createdAt), asc(virtualStagingCandidates.id));
  return {
    id: job.id,
    propertyId: job.propertyId,
    unitId: job.unitId,
    unitLabel: job.unitLabel,
    status: job.status as VirtualStagingJobStatus,
    total: job.total,
    completed: job.completed,
    failed: job.failed,
    selectedCount: job.selectedCandidateIds?.length ?? 0,
    candidates: candidates.map((candidate) => candidateDto(job.id, candidate)),
    createdAt: asIso(job.createdAt),
    updatedAt: asIso(job.updatedAt),
  };
}

async function requireJobDto(jobId: string): Promise<VirtualStagingJobDto> {
  const dto = await getJobDto(jobId);
  if (!dto) throw new VirtualStagingHttpError(404, "Virtual-staging job was not found");
  return dto;
}

async function refreshJobSummary(jobId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Read candidate state only after owning the job row. Otherwise a summary
    // computed before a concurrent restore commits can wait on this row and
    // then overwrite the newer terminal state with stale counts.
    const [job] = await tx.select().from(virtualStagingJobs)
      .where(eq(virtualStagingJobs.id, jobId))
      .limit(1)
      .for("update");
    if (!job || job.status === "confirmed") return;
    const rows = await tx.select({ status: virtualStagingCandidates.status })
      .from(virtualStagingCandidates)
      .where(eq(virtualStagingCandidates.jobId, jobId));
    const summary = summarizeCandidateStatuses(rows.map((row) => row.status as VirtualStagingCandidateStatus));
    await tx.update(virtualStagingJobs).set({ ...summary, updatedAt: new Date() })
      .where(eq(virtualStagingJobs.id, jobId));
  });
}

async function writeCandidateAtomically(destination: string, buffer: Buffer): Promise<void> {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${crypto.randomUUID()}`;
  try {
    await fs.promises.writeFile(temporary, buffer, { flag: "wx" });
    await fs.promises.rename(temporary, destination);
  } finally {
    await fs.promises.unlink(temporary).catch(() => undefined);
  }
}

function startGenerationLeaseHeartbeat(candidateId: string, generationToken: string): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const schedule = (): void => {
    timer = setTimeout(() => {
      void renew();
    }, GENERATION_LEASE_HEARTBEAT_MS);
    timer.unref?.();
  };
  const renew = async (): Promise<void> => {
    if (stopped) return;
    try {
      const [owned] = await db.update(virtualStagingCandidates).set({
        generationLeaseExpiresAt: new Date(Date.now() + GENERATION_LEASE_MS),
      }).where(and(
        eq(virtualStagingCandidates.id, candidateId),
        eq(virtualStagingCandidates.status, "generating"),
        eq(virtualStagingCandidates.generationToken, generationToken),
      )).returning({ id: virtualStagingCandidates.id });
      if (!owned) {
        stopped = true;
        return;
      }
    } catch (error) {
      console.warn(`[virtual-staging] lease heartbeat failed: ${safeErrorMessage(error)}`);
    }
    if (!stopped) schedule();
  };

  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

async function processCandidate(candidateId: string): Promise<void> {
  const generationToken = crypto.randomUUID();
  const claimedAt = new Date();
  const [claimed] = await db.update(virtualStagingCandidates).set({
    status: "generating",
    error: null,
    generationToken,
    generationLeaseExpiresAt: new Date(claimedAt.getTime() + GENERATION_LEASE_MS),
    attempt: sql`${virtualStagingCandidates.attempt} + 1`,
    updatedAt: claimedAt,
  }).where(and(
    eq(virtualStagingCandidates.id, candidateId),
    eq(virtualStagingCandidates.status, "pending"),
  )).returning();
  if (!claimed) return;
  const stopLeaseHeartbeat = startGenerationLeaseHeartbeat(candidateId, generationToken);
  try {
    const snapshot = claimed.metadataSnapshot && typeof claimed.metadataSnapshot === "object"
      ? claimed.metadataSnapshot as Record<string, unknown>
      : {};
    const context = virtualStagingContextForSource({
      originalFilename: claimed.originalFilename,
      roomLabel: claimed.roomLabel,
      metadata: {
        label: snapshotString(snapshot, "label") ?? claimed.roomLabel,
        category: snapshotString(snapshot, "category"),
        userLabel: snapshotString(snapshot, "userLabel"),
        userCategory: snapshotString(snapshot, "userCategory"),
      },
    });
    if (!context) {
      throw new Error("Photo is not a furnished room or private outdoor living space eligible for virtual staging");
    }
    const [asset] = await db.select().from(photoOriginalAssets)
      .where(eq(photoOriginalAssets.id, claimed.originalAssetId)).limit(1);
    if (!asset) throw new Error("Immutable original asset is missing");
    const source = await fs.promises.readFile(resolveInsidePhotosRoot(asset.storageRelativePath));
    if (sha256(source) !== asset.sourceSha256 || claimed.sourceSha256 !== asset.sourceSha256) {
      throw new Error("Immutable original asset failed its integrity check");
    }
    const [job] = await db.select().from(virtualStagingJobs)
      .where(eq(virtualStagingJobs.id, claimed.jobId)).limit(1);
    if (!job || job.status === "confirmed") throw new Error("Virtual-staging job is no longer active");
    const service = getVirtualStagingService();
    if (job.model !== service.recipeSignature) {
      throw new Error("Virtual-staging job uses an outdated generation recipe");
    }
    const previousPreviewRelativePath = snapshotString(snapshot, PREVIOUS_PREVIEW_PATH_KEY);
    const generationMode = snapshotString(snapshot, GENERATION_MODE_KEY) === FEEDBACK_GENERATION_MODE
      ? FEEDBACK_GENERATION_MODE
      : "alternate-angle";
    const feedback = generationMode === FEEDBACK_GENERATION_MODE
      ? snapshotString(snapshot, FEEDBACK_KEY)?.trim()
      : undefined;
    const feedbackSourceAttempt = generationMode === FEEDBACK_GENERATION_MODE
      ? snapshotNumber(snapshot, FEEDBACK_SOURCE_ATTEMPT_KEY)
      : null;
    if (generationMode === FEEDBACK_GENERATION_MODE
      && (!feedback
        || feedbackSourceAttempt === null
        || !Number.isSafeInteger(feedbackSourceAttempt)
        || feedbackSourceAttempt < 1
        || feedbackSourceAttempt >= claimed.attempt)) {
      throw new Error("Feedback revision is not bound to a valid reviewed preview");
    }
    let previousPreview: Buffer | undefined;
    if (previousPreviewRelativePath) {
      try {
        previousPreview = await fs.promises.readFile(
          resolveInsidePhotosRoot(previousPreviewRelativePath),
        );
      } catch {
        throw new Error("The previous staged preview is missing and cannot be compared safely");
      }
    }
    const result = await service.generate({
      source,
      sourceFilename: claimed.originalFilename,
      generationAttempt: claimed.attempt,
      previousPreview,
      context,
      endUserId: job.requestedBy ?? undefined,
      mode: generationMode,
      ...(feedback ? { feedback } : {}),
    });
    if (!claimed.stagingRelativePath) throw new Error("Candidate storage path is missing");
    await db.transaction(async (tx) => {
      const [owned] = await tx.select({
        id: virtualStagingCandidates.id,
        leaseExpiresAt: virtualStagingCandidates.generationLeaseExpiresAt,
      }).from(virtualStagingCandidates).where(and(
        eq(virtualStagingCandidates.id, candidateId),
        eq(virtualStagingCandidates.status, "generating"),
        eq(virtualStagingCandidates.generationToken, generationToken),
      )).limit(1).for("update");
      if (!owned?.leaseExpiresAt || owned.leaseExpiresAt.getTime() <= Date.now()) return;

      // Keep the row locked while publishing the output so an expired worker
      // can never overwrite the file produced by a newer lease owner.
      await writeCandidateAtomically(resolveInsidePhotosRoot(claimed.stagingRelativePath!), result.buffer);
      await tx.update(virtualStagingCandidates).set({
        status: "succeeded",
        error: null,
        generationToken: null,
        generationLeaseExpiresAt: null,
        model: result.model,
        updatedAt: new Date(),
      }).where(and(
        eq(virtualStagingCandidates.id, candidateId),
        eq(virtualStagingCandidates.status, "generating"),
        eq(virtualStagingCandidates.generationToken, generationToken),
      ));
    });
  } catch (error) {
    await db.update(virtualStagingCandidates).set({
      status: "failed",
      error: safeErrorMessage(error),
      generationToken: null,
      generationLeaseExpiresAt: null,
      updatedAt: new Date(),
    }).where(and(
      eq(virtualStagingCandidates.id, candidateId),
      eq(virtualStagingCandidates.status, "generating"),
      eq(virtualStagingCandidates.generationToken, generationToken),
    ));
  } finally {
    stopLeaseHeartbeat();
    await refreshJobSummary(claimed.jobId);
  }
}

async function runJob(jobId: string): Promise<void> {
  await db.update(virtualStagingJobs).set({ status: "running", updatedAt: new Date() })
    .where(and(eq(virtualStagingJobs.id, jobId), or(
      eq(virtualStagingJobs.status, "queued"),
      eq(virtualStagingJobs.status, "running"),
    )));
  const pending = await db.select({ id: virtualStagingCandidates.id })
    .from(virtualStagingCandidates)
    .where(and(
      eq(virtualStagingCandidates.jobId, jobId),
      eq(virtualStagingCandidates.status, "pending"),
    ));
  await Promise.all(pending.map((candidate) => processCandidate(candidate.id)));
  await refreshJobSummary(jobId);
}

async function recoverInterruptedJobs(): Promise<void> {
  const recipeSignature = getVirtualStagingService().recipeSignature;
  const now = new Date();

  // Retire only unversioned legacy jobs and explicitly known predecessor
  // recipes without activating candidates, so their pollers release retained
  // modal sessions. Unknown versioned jobs may belong to a newer instance
  // during a rolling deploy and must remain untouched.
  await db.update(virtualStagingJobs).set({
    status: "confirmed",
    selectedCandidateIds: [],
    confirmedAt: now,
    error: OUTDATED_RECIPE_MESSAGE,
    updatedAt: now,
  }).where(and(
    inArray(virtualStagingJobs.status, [...RESUMABLE_JOB_STATUSES]),
    or(
      isNull(virtualStagingJobs.model),
      sql`${virtualStagingJobs.model} NOT LIKE ${`${VIRTUAL_STAGING_RECIPE_SIGNATURE_PREFIX}%`}`,
      inArray(virtualStagingJobs.model, [...VIRTUAL_STAGING_SUPERSEDED_RECIPE_SIGNATURES]),
    ),
  ));

  const active = await db.select({ id: virtualStagingJobs.id })
    .from(virtualStagingJobs)
    .where(and(
      inArray(virtualStagingJobs.status, [...ACTIVE_JOB_STATUSES]),
      eq(virtualStagingJobs.model, recipeSignature),
    ));
  if (active.length === 0) return;
  const ids = active.map((job) => job.id);
  const legacyStaleBefore = new Date(now.getTime() - GENERATION_LEASE_MS);
  await db.update(virtualStagingCandidates).set({
    status: "pending",
    error: "The previous generation worker lease expired; retrying automatically.",
    generationToken: null,
    generationLeaseExpiresAt: null,
    updatedAt: now,
  }).where(and(
    inArray(virtualStagingCandidates.jobId, ids),
    eq(virtualStagingCandidates.status, "generating"),
    or(
      lt(virtualStagingCandidates.generationLeaseExpiresAt, now),
      and(
        isNull(virtualStagingCandidates.generationLeaseExpiresAt),
        lt(virtualStagingCandidates.updatedAt, legacyStaleBefore),
      ),
    ),
  ));
  for (const job of active) {
    scheduleVirtualStagingTask(`job ${job.id}`, () => runJob(job.id));
  }
}

function startRecoverySweep(): void {
  scheduleVirtualStagingTask("interrupted-job recovery", recoverInterruptedJobs);
  if (recoverySweepTimer) return;
  recoverySweepTimer = setInterval(() => {
    scheduleVirtualStagingTask("interrupted-job recovery", recoverInterruptedJobs);
  }, RECOVERY_SWEEP_MS);
  recoverySweepTimer.unref();
}

async function createJob(
  unit: ResolvedVirtualStagingUnit,
  requestedBy: string,
): Promise<{ dto: VirtualStagingJobDto; duplicate: boolean }> {
  // POST is intentionally resumable as well as idempotent. If the Photos tab
  // unmounted while generation finished, the next click must reopen that
  // unconfirmed review instead of paying for a second generation run.
  const service = getVirtualStagingService();
  const recipeSignature = service.recipeSignature;
  const existing = await findResumableJob(unit, recipeSignature);
  if (existing) return { dto: await requireJobDto(existing.id), duplicate: true };

  service.assertConfigured();
  const sources = await listUnitSources(unit);
  if (sources.length === 0) {
    throw new VirtualStagingHttpError(
      409,
      `${unit.unitLabel} has no furnished room or private patio/lanai photos eligible for virtual staging`,
    );
  }
  const assets = await Promise.all(
    sources.map((source) => ensureOriginalAsset(unit, source.originalFilename)),
  );
  const jobId = crypto.randomUUID();
  const createdMs = Date.now();
  try {
    const duplicateJobId = await db.transaction(async (tx): Promise<string | null> => {
      const [latest] = await tx
        .select()
        .from(virtualStagingJobs)
        .where(and(
          eq(virtualStagingJobs.propertyId, unit.propertyId),
          eq(virtualStagingJobs.unitId, unit.unitId),
        ))
        .orderBy(desc(virtualStagingJobs.createdAt))
        .limit(1)
        .for("update");
      if (latest && jobIsResumableForUnit(latest, unit)) {
        if (latest.model === recipeSignature) return latest.id;
        if (!isSupersededVirtualStagingRecipeSignature(latest.model)) {
          throw new VirtualStagingHttpError(
            409,
            "A review from a different staging recipe is still open. Try again after the deployment finishes.",
          );
        }
        const retiredAt = new Date();
        await tx.update(virtualStagingJobs).set({
          status: "confirmed",
          selectedCandidateIds: [],
          approvedBy: requestedBy,
          confirmedAt: retiredAt,
          error: OUTDATED_RECIPE_MESSAGE,
          updatedAt: retiredAt,
        }).where(eq(virtualStagingJobs.id, latest.id));
      }
      await tx.insert(virtualStagingJobs).values({
        id: jobId,
        propertyId: unit.propertyId,
        unitId: unit.unitId,
        unitLabel: unit.unitLabel,
        folder: unit.folder,
        status: "queued",
        total: sources.length,
        completed: 0,
        failed: 0,
        model: recipeSignature,
        requestedBy,
        createdAt: new Date(createdMs),
        updatedAt: new Date(createdMs),
      });
      await tx.insert(virtualStagingCandidates).values(sources.map((source, index) => {
        const id = crypto.randomUUID();
        return {
          id,
          jobId,
          propertyId: unit.propertyId,
          unitId: unit.unitId,
          folder: unit.folder,
          originalAssetId: assets[index].id,
          originalFilename: source.originalFilename,
          activeFilenameAtRequest: source.activeFilename,
          candidateFilename: virtualStagingCandidateFilename(id),
          stagingRelativePath: candidateStorageRelativePath(jobId, id),
          sourceSha256: assets[index].sourceSha256,
          roomLabel: source.roomLabel,
          metadataSnapshot: source.metadata ? { ...source.metadata } : null,
          status: "pending",
          attempt: 0,
          model: service.model,
          active: false,
          createdAt: new Date(createdMs + index + 1),
          updatedAt: new Date(createdMs + index + 1),
        };
      }));
      return null;
    });
    if (duplicateJobId) {
      return { dto: await requireJobDto(duplicateJobId), duplicate: true };
    }
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      const raced = await findResumableJob(unit, recipeSignature);
      if (raced) return { dto: await requireJobDto(raced.id), duplicate: true };
    }
    throw error;
  }
  scheduleVirtualStagingTask(`job ${jobId}`, () => runJob(jobId));
  return { dto: await requireJobDto(jobId), duplicate: false };
}

async function candidateContext(jobId: string, candidateId: string): Promise<{
  job: VirtualStagingJob;
  candidate: VirtualStagingCandidate;
  asset: PhotoOriginalAsset;
}> {
  if (!UUID_RE.test(jobId) || !UUID_RE.test(candidateId)) {
    throw new VirtualStagingHttpError(404, "Virtual-staging photo was not found");
  }
  const [[job], [candidate]] = await Promise.all([
    db.select().from(virtualStagingJobs).where(eq(virtualStagingJobs.id, jobId)).limit(1),
    db.select().from(virtualStagingCandidates).where(and(
      eq(virtualStagingCandidates.id, candidateId),
      eq(virtualStagingCandidates.jobId, jobId),
    )).limit(1),
  ]);
  if (!job || !candidate) throw new VirtualStagingHttpError(404, "Virtual-staging photo was not found");
  if (candidate.propertyId !== job.propertyId || candidate.unitId !== job.unitId || candidate.folder !== job.folder) {
    throw new VirtualStagingHttpError(409, "Virtual-staging photo does not belong to this job");
  }
  const [asset] = await db.select().from(photoOriginalAssets)
    .where(eq(photoOriginalAssets.id, candidate.originalAssetId)).limit(1);
  if (!asset || asset.propertyId !== job.propertyId || asset.unitId !== job.unitId || asset.folder !== job.folder) {
    throw new VirtualStagingHttpError(409, "Original photo does not belong to this job");
  }
  return { job, candidate, asset };
}

function snapshotString(snapshot: Record<string, unknown>, key: string): string | null {
  return typeof snapshot[key] === "string" ? String(snapshot[key]) : null;
}

function snapshotNumber(snapshot: Record<string, unknown>, key: string): number | null {
  return typeof snapshot[key] === "number" && Number.isFinite(snapshot[key])
    ? Number(snapshot[key])
    : null;
}

function hiddenLabelValues(candidate: VirtualStagingCandidate) {
  const snapshot = candidate.metadataSnapshot && typeof candidate.metadataSnapshot === "object"
    ? candidate.metadataSnapshot as Record<string, unknown>
    : {};
  return {
    folder: candidate.folder,
    filename: candidate.candidateFilename,
    label: snapshotString(snapshot, "label")?.trim() || candidate.roomLabel,
    category: snapshotString(snapshot, "category"),
    confidence: snapshotNumber(snapshot, "confidence"),
    userLabel: snapshotString(snapshot, "userLabel"),
    userCategory: snapshotString(snapshot, "userCategory"),
    hidden: true,
    sortOrder: snapshotNumber(snapshot, "sortOrder"),
    model: snapshotString(snapshot, "model"),
    // These describe the exact image bytes / exact channel object, not the
    // logical room slot. Carrying them onto edited bytes would create false
    // duplicate matches and false "already pushed" state.
    perceptualHash: null,
    bedroomClusterId: snapshotString(snapshot, "bedroomClusterId"),
    bedroomBedType: snapshotString(snapshot, "bedroomBedType"),
    channelUsage: null,
  };
}

function activatedLabelValues(
  candidate: VirtualStagingCandidate,
  current: typeof photoLabels.$inferSelect | undefined,
) {
  if (!current) return { ...hiddenLabelValues(candidate), hidden: false };
  return {
    label: current.label,
    category: current.category,
    confidence: current.confidence,
    userLabel: current.userLabel,
    userCategory: current.userCategory,
    hidden: current.hidden,
    sortOrder: current.sortOrder,
    model: current.model,
    // Content-derived state must be recomputed for the edited bytes.
    perceptualHash: null,
    bedroomClusterId: current.bedroomClusterId,
    bedroomBedType: current.bedroomBedType,
    channelUsage: null,
    generatedAt: current.generatedAt,
  };
}

async function prepareHiddenLabels(candidates: readonly VirtualStagingCandidate[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (const candidate of candidates) {
      await tx.insert(photoLabels)
        .values(hiddenLabelValues(candidate))
        .onConflictDoNothing();
    }
  });
}

async function prepareConfirmationFiles(candidates: readonly VirtualStagingCandidate[]): Promise<void> {
  const plans = buildVirtualStagingConfirmationFilePlan(candidates);
  await prepareHiddenLabels(candidates);
  for (const plan of plans) {
    const staged = await fs.promises.readFile(plan.stagedPath);
    const metadata = await sharp(staged, { failOn: "error" }).metadata();
    if (!metadata.width || !metadata.height) throw new Error("A staged photo is unreadable");
    await ensureVirtualStagingGalleryFile(plan.stagedPath, plan.galleryPath);
  }

  // Preparation is intentionally monotonic. Hidden labels and inactive files
  // are safe to reuse on retry; deleting them on failure could remove assets
  // that a concurrent confirmation has already adopted.
}

async function validateConfirmationState(
  job: VirtualStagingJob,
  candidateSelections: VirtualStagingCandidateSelectionInput[],
): Promise<VirtualStagingCandidate[]> {
  const candidateIds = candidateSelections.map((selection) => selection.id);
  const candidates = await db.select().from(virtualStagingCandidates)
    .where(eq(virtualStagingCandidates.jobId, job.id));
  try {
    validateVirtualStagingSelection({
      candidateIds,
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        status: candidate.status as VirtualStagingCandidateStatus,
        propertyId: candidate.propertyId,
        unitId: candidate.unitId,
        jobId: candidate.jobId,
      })),
      propertyId: job.propertyId,
      unitId: job.unitId,
      jobId: job.id,
    });
  } catch (error) {
    throw new VirtualStagingHttpError(400, safeErrorMessage(error));
  }
  assertSelectedGenerationAttempts(candidates, candidateSelections);
  const selected = candidates.filter((candidate) => candidateIds.includes(candidate.id));
  const unit = await resolveVirtualStagingUnit(job.propertyId, job.unitId);
  if (unit.folder !== job.folder) {
    throw new VirtualStagingHttpError(409, "This unit's photo folder changed while staging was running");
  }
  const originals = Array.from(new Set(selected.map((candidate) => candidate.originalFilename)));
  const activeRows = await db.select().from(virtualStagingCandidates).where(and(
    eq(virtualStagingCandidates.propertyId, job.propertyId),
    eq(virtualStagingCandidates.unitId, job.unitId),
    eq(virtualStagingCandidates.folder, job.folder),
    eq(virtualStagingCandidates.active, true),
    inArray(virtualStagingCandidates.originalFilename, originals),
  ));
  const activeByOriginal = new Map(activeRows.map((candidate) => [candidate.originalFilename, candidate]));
  const assetIds = Array.from(new Set(selected.map((candidate) => candidate.originalAssetId)));
  const assets = await db.select().from(photoOriginalAssets)
    .where(inArray(photoOriginalAssets.id, assetIds));
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));

  await Promise.all(selected.map(async (candidate) => {
    const currentActive = activeByOriginal.get(candidate.originalFilename)?.candidateFilename
      ?? candidate.originalFilename;
    if (currentActive !== candidate.activeFilenameAtRequest) {
      throw new VirtualStagingHttpError(409, "The active gallery changed while staging was running");
    }
    const asset = assetById.get(candidate.originalAssetId);
    if (!asset
      || asset.propertyId !== job.propertyId
      || asset.unitId !== job.unitId
      || asset.folder !== job.folder
      || asset.filename !== candidate.originalFilename
      || asset.sourceSha256 !== candidate.sourceSha256) {
      throw new VirtualStagingHttpError(409, "A selected staged photo has an invalid original relationship");
    }
    const [canonical, snapshot] = await Promise.all([
      fs.promises.readFile(folderFilePath(job.folder, candidate.originalFilename)),
      fs.promises.readFile(resolveInsidePhotosRoot(asset.storageRelativePath)),
    ]);
    if (sha256(canonical) !== candidate.sourceSha256 || sha256(snapshot) !== candidate.sourceSha256) {
      throw new VirtualStagingHttpError(409, "An original photo changed while staging was running");
    }
  }));
  return selected;
}

export function assertSelectedGenerationAttempts(
  candidates: readonly Pick<VirtualStagingCandidate, "id" | "attempt">[],
  candidateSelections: readonly VirtualStagingCandidateSelectionInput[],
): void {
  const attemptById = new Map(candidates.map((candidate) => [candidate.id, candidate.attempt]));
  if (candidateSelections.some((selection) => attemptById.get(selection.id) !== selection.attempt)) {
    throw new VirtualStagingHttpError(
      409,
      "A selected staged preview changed. Review and select the new preview before confirming.",
    );
  }
}

async function activateCandidates(
  jobId: string,
  candidateSelections: VirtualStagingCandidateSelectionInput[],
  approvedBy: string,
): Promise<{ alreadyConfirmed: boolean }> {
  const candidateIds = candidateSelections.map((selection) => selection.id);
  return db.transaction(async (tx) => {
    const [job] = await tx.select().from(virtualStagingJobs)
      .where(eq(virtualStagingJobs.id, jobId)).limit(1).for("update");
    if (!job) throw new VirtualStagingHttpError(404, "Virtual-staging job was not found");
    if (job.status === "confirmed") {
      if (sameVirtualStagingSelection(job.selectedCandidateIds, candidateIds)) {
        const confirmedCandidates = await tx.select({
          id: virtualStagingCandidates.id,
          attempt: virtualStagingCandidates.attempt,
        }).from(virtualStagingCandidates)
          .where(eq(virtualStagingCandidates.jobId, jobId))
          .for("update");
        assertSelectedGenerationAttempts(confirmedCandidates, candidateSelections);
        return { alreadyConfirmed: true };
      }
      throw new VirtualStagingHttpError(409, "This job was already confirmed with a different selection");
    }
    if (job.status !== "ready") {
      throw new VirtualStagingHttpError(409, "Wait for virtual staging to finish before confirming");
    }
    const jobCandidates = await tx.select().from(virtualStagingCandidates)
      .where(eq(virtualStagingCandidates.jobId, jobId)).for("update");
    try {
      validateVirtualStagingSelection({
        candidateIds,
        candidates: jobCandidates.map((candidate) => ({
          id: candidate.id,
          status: candidate.status as VirtualStagingCandidateStatus,
          propertyId: candidate.propertyId,
          unitId: candidate.unitId,
          jobId: candidate.jobId,
        })),
        propertyId: job.propertyId,
        unitId: job.unitId,
        jobId,
      });
    } catch (error) {
      throw new VirtualStagingHttpError(400, safeErrorMessage(error));
    }
    assertSelectedGenerationAttempts(jobCandidates, candidateSelections);
    const selected = jobCandidates.filter((candidate) => candidateIds.includes(candidate.id));
    const originals = Array.from(new Set(selected.map((candidate) => candidate.originalFilename)));
    const related = await tx.select().from(virtualStagingCandidates).where(and(
      eq(virtualStagingCandidates.propertyId, job.propertyId),
      eq(virtualStagingCandidates.unitId, job.unitId),
      eq(virtualStagingCandidates.folder, job.folder),
      inArray(virtualStagingCandidates.originalFilename, originals),
    )).for("update");
    const activeByOriginal = new Map(
      related.filter((candidate) => candidate.active).map((candidate) => [candidate.originalFilename, candidate]),
    );
    for (const candidate of selected) {
      const activeFilename = activeByOriginal.get(candidate.originalFilename)?.candidateFilename
        ?? candidate.originalFilename;
      if (activeFilename !== candidate.activeFilenameAtRequest) {
        throw new VirtualStagingHttpError(409, "The active gallery changed while staging was running");
      }
      // Lock and clone the CURRENT active row, not the job-start snapshot.
      // A generation may take minutes; edits made in another tab during that
      // time must not be silently replaced by stale captions/order/visibility.
      const [currentLabel] = await tx.select().from(photoLabels).where(and(
        eq(photoLabels.folder, job.folder),
        eq(photoLabels.filename, activeFilename),
      )).limit(1).for("update");
      const sameOriginal = related.filter((row) => row.originalFilename === candidate.originalFilename);
      await tx.update(virtualStagingCandidates).set({ active: false, updatedAt: new Date() }).where(and(
        eq(virtualStagingCandidates.propertyId, job.propertyId),
        eq(virtualStagingCandidates.unitId, job.unitId),
        eq(virtualStagingCandidates.folder, job.folder),
        eq(virtualStagingCandidates.originalFilename, candidate.originalFilename),
      ));
      // Never hide the physical original globally: legacy listings can share a
      // folder across units or properties. The active mapping is unit-scoped;
      // gallery readers replace this original only for the confirmed unit.
      const filenamesToHide = sameOriginal.map((row) => row.candidateFilename);
      await tx.update(photoLabels).set({ hidden: true }).where(and(
        eq(photoLabels.folder, job.folder),
        inArray(photoLabels.filename, filenamesToHide),
      ));
      const activatedRows = await tx.update(photoLabels).set(
        activatedLabelValues(candidate, currentLabel),
      ).where(and(
        eq(photoLabels.folder, job.folder),
        eq(photoLabels.filename, candidate.candidateFilename),
      )).returning({ id: photoLabels.id });
      if (activatedRows.length === 0) throw new Error("Prepared staged photo metadata is missing");
      await tx.update(virtualStagingCandidates).set({
        active: true,
        approvedBy,
        approvedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(virtualStagingCandidates.id, candidate.id));
    }
    await tx.update(virtualStagingJobs).set({
      status: "confirmed",
      selectedCandidateIds: candidateIds,
      approvedBy,
      confirmedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(virtualStagingJobs.id, jobId));
    return { alreadyConfirmed: false };
  });
}

type AsyncRoute = (req: Request, res: Response) => Promise<void>;

function route(handler: AsyncRoute) {
  return (req: Request, res: Response): void => {
    void handler(req, res).catch((error) => {
      if (res.headersSent) return;
      if (error instanceof VirtualStagingHttpError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof VirtualStagingConfigurationError) {
        res.status(503).json({ error: error.message });
        return;
      }
      console.error(`[virtual-staging] ${safeErrorMessage(error)}`);
      res.status(500).json({ error: "Virtual staging failed. Please try again." });
    });
  };
}

export function sendVirtualStagingPreview(
  res: Response,
  file: string,
  contentType: string,
): void {
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "private, max-age=3600");
  // Immutable originals and candidates intentionally live below the hidden
  // `.virtual-staging` directory. Express ignores dot-directories by default.
  // This exception is scoped to canonical, admin-authorized paths validated by
  // candidateContext and resolveInsidePhotosRoot; global static serving remains
  // unchanged and cannot expose other hidden files.
  res.sendFile(file, { dotfiles: "allow" });
}

type CandidateRegenerationMode = "alternate-angle" | "feedback-revision";

async function queueCandidateRegeneration(input: {
  job: VirtualStagingJob;
  candidate: VirtualStagingCandidate;
  expectedAttempt: number;
  mode: CandidateRegenerationMode;
  feedback?: string;
}): Promise<void> {
  const service = getVirtualStagingService();
  service.assertConfigured(input.mode);
  const regenerationId = crypto.randomUUID();
  try {
    await db.transaction(async (tx) => {
      const [lockedJob] = await tx.select({
        status: virtualStagingJobs.status,
        model: virtualStagingJobs.model,
      })
        .from(virtualStagingJobs)
        .where(eq(virtualStagingJobs.id, input.job.id))
        .limit(1)
        .for("update");
      if (!lockedJob) throw new VirtualStagingHttpError(404, "Virtual-staging job was not found");
      if (lockedJob.status === "confirmed") {
        throw new VirtualStagingHttpError(409, "Confirmed jobs cannot be regenerated");
      }
      if (lockedJob.model !== service.recipeSignature) {
        throw new VirtualStagingHttpError(409, "This review used an older staging recipe. Start a new Restage run.");
      }

      const [lockedCandidate] = await tx.select({
        status: virtualStagingCandidates.status,
        attempt: virtualStagingCandidates.attempt,
        candidateFilename: virtualStagingCandidates.candidateFilename,
        stagingRelativePath: virtualStagingCandidates.stagingRelativePath,
        metadataSnapshot: virtualStagingCandidates.metadataSnapshot,
      })
        .from(virtualStagingCandidates)
        .where(and(
          eq(virtualStagingCandidates.id, input.candidate.id),
          eq(virtualStagingCandidates.jobId, input.job.id),
        ))
        .limit(1)
        .for("update");
      if (!lockedCandidate
        || (lockedCandidate.status !== "failed" && lockedCandidate.status !== "succeeded")) {
        throw new VirtualStagingHttpError(409, "This photo is already being regenerated");
      }
      if (lockedCandidate.attempt !== input.expectedAttempt) {
        throw new VirtualStagingHttpError(
          409,
          "This staged preview changed. Review the latest preview before regenerating it.",
        );
      }
      if (input.mode === "feedback-revision" && lockedCandidate.status !== "succeeded") {
        throw new VirtualStagingHttpError(409, "Feedback can only revise a successful staged preview");
      }

      const rotateSuccessfulPreview = lockedCandidate.status === "succeeded";
      const currentSnapshot = lockedCandidate.metadataSnapshot
        && typeof lockedCandidate.metadataSnapshot === "object"
        && !Array.isArray(lockedCandidate.metadataSnapshot)
        ? lockedCandidate.metadataSnapshot as Record<string, unknown>
        : {};
      const effectiveMode = !rotateSuccessfulPreview
        && snapshotString(currentSnapshot, GENERATION_MODE_KEY) === FEEDBACK_GENERATION_MODE
        ? FEEDBACK_GENERATION_MODE
        : input.mode;
      service.assertConfigured(effectiveMode);
      let metadataSnapshot: Record<string, unknown> | undefined;
      if (rotateSuccessfulPreview) {
        if (!lockedCandidate.stagingRelativePath) {
          throw new VirtualStagingHttpError(409, "The current staged preview is missing");
        }
        metadataSnapshot = {
          ...currentSnapshot,
          [PREVIOUS_PREVIEW_PATH_KEY]: lockedCandidate.stagingRelativePath,
          [PREVIOUS_PREVIEW_FILENAME_KEY]: lockedCandidate.candidateFilename,
        };
        if (input.mode === "feedback-revision") {
          metadataSnapshot[GENERATION_MODE_KEY] = FEEDBACK_GENERATION_MODE;
          metadataSnapshot[FEEDBACK_KEY] = input.feedback!;
          metadataSnapshot[FEEDBACK_SOURCE_ATTEMPT_KEY] = input.expectedAttempt;
        } else {
          // An ordinary angle reroll is a fresh recipe run. Do not silently
          // replay feedback that was written for a different reviewed preview.
          delete metadataSnapshot[GENERATION_MODE_KEY];
          delete metadataSnapshot[FEEDBACK_KEY];
          delete metadataSnapshot[FEEDBACK_SOURCE_ATTEMPT_KEY];
        }
      }

      await tx.update(virtualStagingJobs).set({ status: "running", updatedAt: new Date() })
        .where(eq(virtualStagingJobs.id, input.job.id));
      // Successful previews rotate to a fresh immutable path. The old path is
      // retained in metadata both as feedback edit input and as a reviewable
      // fallback if the new generation fails.
      const [queued] = await tx.update(virtualStagingCandidates).set({
        status: "pending",
        error: null,
        generationToken: null,
        generationLeaseExpiresAt: null,
        ...(rotateSuccessfulPreview ? {
          candidateFilename: virtualStagingCandidateFilename(regenerationId),
          stagingRelativePath: candidateStorageRelativePath(input.job.id, regenerationId),
          metadataSnapshot,
        } : {}),
        updatedAt: new Date(),
      }).where(and(
        eq(virtualStagingCandidates.id, input.candidate.id),
        eq(virtualStagingCandidates.jobId, input.job.id),
        eq(virtualStagingCandidates.status, lockedCandidate.status),
        eq(virtualStagingCandidates.attempt, input.expectedAttempt),
      )).returning({ id: virtualStagingCandidates.id });
      if (!queued) throw new VirtualStagingHttpError(409, "This photo is already being regenerated");
    });
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      throw new VirtualStagingHttpError(409, "Another virtual-staging job is already active for this unit");
    }
    throw error;
  }
  scheduleVirtualStagingTask(
    `candidate ${input.candidate.id}`,
    () => processCandidate(input.candidate.id),
  );
}

function retainedPreviewIdentity(
  jobId: string,
  snapshot: Record<string, unknown>,
): { relativePath: string; candidateFilename: string; absolutePath: string } {
  const relativePath = snapshotString(snapshot, PREVIOUS_PREVIEW_PATH_KEY);
  const candidateFilename = snapshotString(snapshot, PREVIOUS_PREVIEW_FILENAME_KEY);
  if (!relativePath || !candidateFilename || !isVirtualStagingCandidateFilename(candidateFilename)) {
    throw new VirtualStagingHttpError(409, "The previous staged preview cannot be restored safely");
  }
  const retainedId = candidateFilename.slice("virtual-staged-".length, -".jpg".length);
  if (!UUID_RE.test(retainedId)
    || relativePath !== candidateStorageRelativePath(jobId, retainedId)) {
    throw new VirtualStagingHttpError(409, "The previous staged preview cannot be restored safely");
  }
  return {
    relativePath,
    candidateFilename,
    absolutePath: resolveInsidePhotosRoot(relativePath),
  };
}

async function restorePreviousCandidatePreview(
  jobId: string,
  candidateId: string,
  expectedAttempt: number,
): Promise<void> {
  if (!UUID_RE.test(jobId) || !UUID_RE.test(candidateId)) {
    throw new VirtualStagingHttpError(404, "Virtual-staging photo was not found");
  }
  const recipeSignature = getVirtualStagingService().recipeSignature;
  await db.transaction(async (tx) => {
    const [lockedJob] = await tx.select({
      status: virtualStagingJobs.status,
      model: virtualStagingJobs.model,
    }).from(virtualStagingJobs)
      .where(eq(virtualStagingJobs.id, jobId))
      .limit(1)
      .for("update");
    if (!lockedJob) throw new VirtualStagingHttpError(404, "Virtual-staging job was not found");
    if (lockedJob.status === "confirmed") {
      throw new VirtualStagingHttpError(409, "Confirmed jobs cannot restore an earlier preview");
    }
    if (lockedJob.model !== recipeSignature) {
      throw new VirtualStagingHttpError(409, "This review used an older staging recipe. Start a new Restage run.");
    }

    const [lockedCandidate] = await tx.select({
      status: virtualStagingCandidates.status,
      attempt: virtualStagingCandidates.attempt,
      metadataSnapshot: virtualStagingCandidates.metadataSnapshot,
    }).from(virtualStagingCandidates)
      .where(and(
        eq(virtualStagingCandidates.id, candidateId),
        eq(virtualStagingCandidates.jobId, jobId),
      ))
      .limit(1)
      .for("update");
    if (!lockedCandidate) {
      throw new VirtualStagingHttpError(404, "Virtual-staging photo was not found");
    }
    if (lockedCandidate.status !== "failed") {
      throw new VirtualStagingHttpError(409, "Only a failed regeneration can restore its previous preview");
    }
    if (lockedCandidate.attempt !== expectedAttempt) {
      throw new VirtualStagingHttpError(
        409,
        "This staged preview changed. Review the latest preview before restoring it.",
      );
    }

    const metadataSnapshot = lockedCandidate.metadataSnapshot
      && typeof lockedCandidate.metadataSnapshot === "object"
      && !Array.isArray(lockedCandidate.metadataSnapshot)
      ? { ...lockedCandidate.metadataSnapshot as Record<string, unknown> }
      : {};
    const retained = retainedPreviewIdentity(jobId, metadataSnapshot);
    const retainedStat = await fs.promises.stat(retained.absolutePath).catch(() => null);
    if (!retainedStat?.isFile()) {
      throw new VirtualStagingHttpError(409, "The previous staged preview file is missing");
    }

    delete metadataSnapshot[PREVIOUS_PREVIEW_PATH_KEY];
    delete metadataSnapshot[PREVIOUS_PREVIEW_FILENAME_KEY];
    delete metadataSnapshot[GENERATION_MODE_KEY];
    delete metadataSnapshot[FEEDBACK_KEY];
    delete metadataSnapshot[FEEDBACK_SOURCE_ATTEMPT_KEY];
    const [restored] = await tx.update(virtualStagingCandidates).set({
      status: "succeeded",
      error: null,
      // Restoration changes the reviewed bytes just like regeneration does.
      // Advance the optimistic version so failed-state actions from another
      // tab cannot immediately reroll or approve the restored preview.
      attempt: expectedAttempt + 1,
      candidateFilename: retained.candidateFilename,
      stagingRelativePath: retained.relativePath,
      metadataSnapshot,
      generationToken: null,
      generationLeaseExpiresAt: null,
      updatedAt: new Date(),
    }).where(and(
      eq(virtualStagingCandidates.id, candidateId),
      eq(virtualStagingCandidates.jobId, jobId),
      eq(virtualStagingCandidates.status, "failed"),
      eq(virtualStagingCandidates.attempt, expectedAttempt),
    )).returning({ id: virtualStagingCandidates.id });
    if (!restored) {
      throw new VirtualStagingHttpError(409, "This staged preview changed before it could be restored");
    }
    const candidateStatuses = await tx.select({ status: virtualStagingCandidates.status })
      .from(virtualStagingCandidates)
      .where(eq(virtualStagingCandidates.jobId, jobId));
    const summary = summarizeCandidateStatuses(
      candidateStatuses.map((row) => row.status as VirtualStagingCandidateStatus),
    );
    await tx.update(virtualStagingJobs).set({ ...summary, updatedAt: new Date() })
      .where(eq(virtualStagingJobs.id, jobId));
  });
}

export function registerVirtualStagingRoutes(app: Express): void {
  app.post("/api/virtual-staging/jobs", route(async (req, res) => {
    const session = requireAdmin(res);
    if (!session) return;
    const input = validateVirtualStagingStartInput(req.body);
    const unit = await resolveVirtualStagingUnit(input.propertyId, input.unitId);
    const result = await createJob(unit, session.username);
    res.status(result.duplicate ? 200 : 202).json(result.dto);
  }));

  app.get("/api/virtual-staging/jobs/:jobId", route(async (req, res) => {
    if (!requireAdmin(res)) return;
    const jobId = routeParam(req, "jobId");
    if (!UUID_RE.test(jobId)) throw new VirtualStagingHttpError(404, "Virtual-staging job was not found");
    res.json(await requireJobDto(jobId));
  }));

  app.post("/api/virtual-staging/jobs/:jobId/candidates/:candidateId/retry", route(async (req, res) => {
    if (!requireAdmin(res)) return;
    const input = validateVirtualStagingRetryInput(req.body);
    const { job, candidate } = await candidateContext(
      routeParam(req, "jobId"),
      routeParam(req, "candidateId"),
    );
    if (job.status === "confirmed") throw new VirtualStagingHttpError(409, "Confirmed jobs cannot be retried");
    if (candidate.status !== "failed" && candidate.status !== "succeeded") {
      throw new VirtualStagingHttpError(409, "Only completed photos can be regenerated");
    }
    const service = getVirtualStagingService();
    if (job.model !== service.recipeSignature) {
      throw new VirtualStagingHttpError(409, "This review used an older staging recipe. Start a new Restage run.");
    }
    await queueCandidateRegeneration({
      job,
      candidate,
      expectedAttempt: input.attempt,
      mode: "alternate-angle",
    });
    res.status(202).json(await requireJobDto(job.id));
  }));

  app.post("/api/virtual-staging/jobs/:jobId/candidates/:candidateId/feedback", route(async (req, res) => {
    if (!requireAdmin(res)) return;
    const input = validateVirtualStagingFeedbackInput(req.body);
    const { job, candidate } = await candidateContext(
      routeParam(req, "jobId"),
      routeParam(req, "candidateId"),
    );
    if (job.status === "confirmed") {
      throw new VirtualStagingHttpError(409, "Confirmed jobs cannot be regenerated");
    }
    if (candidate.status !== "succeeded") {
      throw new VirtualStagingHttpError(409, "Feedback can only revise a successful staged preview");
    }
    const service = getVirtualStagingService();
    if (job.model !== service.recipeSignature) {
      throw new VirtualStagingHttpError(409, "This review used an older staging recipe. Start a new Restage run.");
    }
    await queueCandidateRegeneration({
      job,
      candidate,
      expectedAttempt: input.attempt,
      mode: "feedback-revision",
      feedback: input.feedback,
    });
    res.status(202).json(await requireJobDto(job.id));
  }));

  app.post("/api/virtual-staging/jobs/:jobId/candidates/:candidateId/restore-previous", route(async (req, res) => {
    if (!requireAdmin(res)) return;
    const input = validateVirtualStagingRetryInput(req.body);
    const jobId = routeParam(req, "jobId");
    const candidateId = routeParam(req, "candidateId");
    await restorePreviousCandidatePreview(jobId, candidateId, input.attempt);
    res.json(await requireJobDto(jobId));
  }));

  app.post("/api/virtual-staging/jobs/:jobId/confirm", route(async (req, res) => {
    const session = requireAdmin(res);
    if (!session) return;
    const jobId = routeParam(req, "jobId");
    if (!UUID_RE.test(jobId)) throw new VirtualStagingHttpError(404, "Virtual-staging job was not found");
    const candidateSelections = validateVirtualStagingCandidateSelections(req.body);
    const candidateIds = candidateSelections.map((selection) => selection.id);
    const [job] = await db.select().from(virtualStagingJobs)
      .where(eq(virtualStagingJobs.id, jobId)).limit(1);
    if (!job) throw new VirtualStagingHttpError(404, "Virtual-staging job was not found");
    if (job.status === "confirmed") {
      if (!sameVirtualStagingSelection(job.selectedCandidateIds, candidateIds)) {
        throw new VirtualStagingHttpError(409, "This job was already confirmed with a different selection");
      }
      const confirmedCandidates = await db.select({
        id: virtualStagingCandidates.id,
        attempt: virtualStagingCandidates.attempt,
      }).from(virtualStagingCandidates).where(eq(virtualStagingCandidates.jobId, job.id));
      assertSelectedGenerationAttempts(confirmedCandidates, candidateSelections);
      res.json({
        job: await requireJobDto(job.id),
        swappedCount: candidateIds.length,
        alreadyConfirmed: true,
      });
      return;
    }
    if (job.model !== getVirtualStagingService().recipeSignature) {
      throw new VirtualStagingHttpError(
        409,
        "This review used an older staging recipe. Start a new Restage run.",
      );
    }
    if (job.status !== "ready") {
      throw new VirtualStagingHttpError(409, "Wait for virtual staging to finish before confirming");
    }
    const selected = await validateConfirmationState(job, candidateSelections);
    await prepareConfirmationFiles(selected);
    // Re-resolve immediately before the locked transaction as a final guard
    // against a unit swap that landed during filesystem preparation.
    const currentUnit = await resolveVirtualStagingUnit(job.propertyId, job.unitId);
    if (currentUnit.folder !== job.folder) {
      throw new VirtualStagingHttpError(409, "This unit's photo folder changed while staging was being confirmed");
    }
    const activated = await activateCandidates(job.id, candidateSelections, session.username);
    res.json({
      job: await requireJobDto(job.id),
      swappedCount: candidateIds.length,
      ...(activated.alreadyConfirmed ? { alreadyConfirmed: true } : {}),
    });
  }));

  app.post("/api/virtual-staging/jobs/:jobId/finish", route(async (req, res) => {
    const session = requireAdmin(res);
    if (!session) return;
    const jobId = routeParam(req, "jobId");
    if (!UUID_RE.test(jobId)) throw new VirtualStagingHttpError(404, "Virtual-staging job was not found");
    await db.transaction(async (tx) => {
      const [job] = await tx.select().from(virtualStagingJobs)
        .where(eq(virtualStagingJobs.id, jobId)).limit(1).for("update");
      if (!job) throw new VirtualStagingHttpError(404, "Virtual-staging job was not found");
      if (job.status === "confirmed") {
        if (sameVirtualStagingSelection(job.selectedCandidateIds, [])) return;
        throw new VirtualStagingHttpError(409, "This job was already confirmed with staged photos");
      }
      if (ACTIVE_JOB_STATUSES.includes(job.status as typeof ACTIVE_JOB_STATUSES[number])) {
        throw new VirtualStagingHttpError(409, "Wait for virtual staging to finish before closing the review");
      }
      if (job.status !== "ready" && job.status !== "failed") {
        throw new VirtualStagingHttpError(409, "This virtual-staging review cannot be finished");
      }
      await tx.update(virtualStagingJobs).set({
        status: "confirmed",
        selectedCandidateIds: [],
        approvedBy: session.username,
        confirmedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(virtualStagingJobs.id, jobId));
    });
    res.json({ job: await requireJobDto(jobId), swappedCount: 0 });
  }));

  app.get("/api/virtual-staging/jobs/:jobId/candidates/:candidateId/original", route(async (req, res) => {
    if (!requireAdmin(res)) return;
    const { asset } = await candidateContext(
      routeParam(req, "jobId"),
      routeParam(req, "candidateId"),
    );
    const file = resolveInsidePhotosRoot(asset.storageRelativePath);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new VirtualStagingHttpError(404, "Original photo was not found");
    sendVirtualStagingPreview(res, file, asset.mimeType);
  }));

  app.get("/api/virtual-staging/jobs/:jobId/candidates/:candidateId/staged", route(async (req, res) => {
    if (!requireAdmin(res)) return;
    const { candidate } = await candidateContext(
      routeParam(req, "jobId"),
      routeParam(req, "candidateId"),
    );
    if (candidate.status !== "succeeded" || !candidate.stagingRelativePath) {
      throw new VirtualStagingHttpError(404, "Staged photo is not ready");
    }
    const file = resolveInsidePhotosRoot(candidate.stagingRelativePath);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new VirtualStagingHttpError(404, "Staged photo was not found");
    sendVirtualStagingPreview(res, file, "image/jpeg");
  }));

  app.get("/api/virtual-staging/jobs/:jobId/candidates/:candidateId/previous-staged", route(async (req, res) => {
    if (!requireAdmin(res)) return;
    const { candidate } = await candidateContext(
      routeParam(req, "jobId"),
      routeParam(req, "candidateId"),
    );
    const snapshot = candidate.metadataSnapshot
      && typeof candidate.metadataSnapshot === "object"
      && !Array.isArray(candidate.metadataSnapshot)
      ? candidate.metadataSnapshot as Record<string, unknown>
      : {};
    const previousPreviewRelativePath = snapshotString(snapshot, PREVIOUS_PREVIEW_PATH_KEY);
    if (!previousPreviewRelativePath) {
      throw new VirtualStagingHttpError(404, "Previous staged photo was not found");
    }
    const file = resolveInsidePhotosRoot(previousPreviewRelativePath);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new VirtualStagingHttpError(404, "Previous staged photo was not found");
    sendVirtualStagingPreview(res, file, "image/jpeg");
  }));

  startRecoverySweep();
}
