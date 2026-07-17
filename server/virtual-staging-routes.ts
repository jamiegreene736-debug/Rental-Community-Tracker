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
  resolveVirtualStagingSources,
  isVirtualStagingCandidateFilename,
  sameVirtualStagingSelection,
  summarizeCandidateStatuses,
  validateVirtualStagingSelection,
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
const GENERATION_LEASE_MS = 8 * 60 * 1_000;
const RECOVERY_SWEEP_MS = 30 * 1_000;

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

export function validateVirtualStagingCandidateIds(body: unknown): string[] {
  const raw = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).candidateIds
    : undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 200) {
    throw new VirtualStagingHttpError(400, "candidateIds must be a non-empty array");
  }
  const ids = raw.map((id) => typeof id === "string" ? id.trim() : "");
  if (ids.some((id) => !UUID_RE.test(id))) {
    throw new VirtualStagingHttpError(400, "candidateIds contains an invalid ID");
  }
  if (new Set(ids).size !== ids.length) {
    throw new VirtualStagingHttpError(400, "candidateIds contains duplicates");
  }
  return ids;
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
  return resolveVirtualStagingSources({
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

async function findActiveJob(propertyId: number, unitId: string): Promise<VirtualStagingJob | undefined> {
  const [job] = await db
    .select()
    .from(virtualStagingJobs)
    .where(and(
      eq(virtualStagingJobs.propertyId, propertyId),
      eq(virtualStagingJobs.unitId, unitId),
      inArray(virtualStagingJobs.status, [...ACTIVE_JOB_STATUSES]),
    ))
    .orderBy(desc(virtualStagingJobs.createdAt))
    .limit(1);
  return job;
}

function candidateDto(jobId: string, candidate: VirtualStagingCandidate): VirtualStagingCandidateDto {
  const status = candidate.status as VirtualStagingCandidateStatus;
  return {
    id: candidate.id,
    originalFilename: candidate.originalFilename,
    originalUrl: `/api/virtual-staging/jobs/${jobId}/candidates/${candidate.id}/original`,
    roomLabel: candidate.roomLabel,
    stagedUrl: status === "succeeded"
      ? `/api/virtual-staging/jobs/${jobId}/candidates/${candidate.id}/staged`
      : null,
    status,
    error: candidate.error,
    attempt: candidate.attempt,
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
  const [job] = await db.select().from(virtualStagingJobs).where(eq(virtualStagingJobs.id, jobId)).limit(1);
  if (!job || job.status === "confirmed") return;
  const rows = await db.select({ status: virtualStagingCandidates.status })
    .from(virtualStagingCandidates)
    .where(eq(virtualStagingCandidates.jobId, jobId));
  const summary = summarizeCandidateStatuses(rows.map((row) => row.status as VirtualStagingCandidateStatus));
  await db.update(virtualStagingJobs).set({ ...summary, updatedAt: new Date() })
    .where(and(eq(virtualStagingJobs.id, jobId), or(
      eq(virtualStagingJobs.status, "queued"),
      eq(virtualStagingJobs.status, "running"),
      eq(virtualStagingJobs.status, "ready"),
      eq(virtualStagingJobs.status, "failed"),
    )));
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
  try {
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
    const result = await getVirtualStagingService().generate({
      source,
      sourceFilename: claimed.originalFilename,
      endUserId: job.requestedBy ?? undefined,
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
  const active = await db.select({ id: virtualStagingJobs.id })
    .from(virtualStagingJobs)
    .where(inArray(virtualStagingJobs.status, [...ACTIVE_JOB_STATUSES]));
  if (active.length === 0) return;
  const ids = active.map((job) => job.id);
  const now = new Date();
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
  const existing = await findActiveJob(unit.propertyId, unit.unitId);
  if (existing) return { dto: await requireJobDto(existing.id), duplicate: true };

  const service = getVirtualStagingService();
  service.assertConfigured();
  const sources = await listUnitSources(unit);
  if (sources.length === 0) throw new VirtualStagingHttpError(409, `${unit.unitLabel} has no visible photos`);
  const assets = await Promise.all(
    sources.map((source) => ensureOriginalAsset(unit, source.originalFilename)),
  );
  const jobId = crypto.randomUUID();
  const createdMs = Date.now();
  try {
    await db.transaction(async (tx) => {
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
        model: service.model,
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
    });
  } catch (error) {
    if (pgErrorCode(error) === "23505") {
      const raced = await findActiveJob(unit.propertyId, unit.unitId);
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
  candidateIds: string[],
): Promise<VirtualStagingCandidate[]> {
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

async function activateCandidates(
  jobId: string,
  candidateIds: string[],
  approvedBy: string,
): Promise<{ alreadyConfirmed: boolean }> {
  return db.transaction(async (tx) => {
    const [job] = await tx.select().from(virtualStagingJobs)
      .where(eq(virtualStagingJobs.id, jobId)).limit(1).for("update");
    if (!job) throw new VirtualStagingHttpError(404, "Virtual-staging job was not found");
    if (job.status === "confirmed") {
      if (sameVirtualStagingSelection(job.selectedCandidateIds, candidateIds)) {
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
    const { job, candidate } = await candidateContext(
      routeParam(req, "jobId"),
      routeParam(req, "candidateId"),
    );
    if (job.status === "confirmed") throw new VirtualStagingHttpError(409, "Confirmed jobs cannot be retried");
    if (candidate.status !== "failed") throw new VirtualStagingHttpError(409, "Only failed photos can be retried");
    getVirtualStagingService().assertConfigured();
    try {
      await db.transaction(async (tx) => {
        const [lockedJob] = await tx.select({ status: virtualStagingJobs.status })
          .from(virtualStagingJobs)
          .where(eq(virtualStagingJobs.id, job.id))
          .limit(1)
          .for("update");
        if (!lockedJob) throw new VirtualStagingHttpError(404, "Virtual-staging job was not found");
        if (lockedJob.status === "confirmed") {
          throw new VirtualStagingHttpError(409, "Confirmed jobs cannot be retried");
        }
        await tx.update(virtualStagingJobs).set({ status: "running", updatedAt: new Date() })
          .where(eq(virtualStagingJobs.id, job.id));
        const [queued] = await tx.update(virtualStagingCandidates).set({
          status: "pending",
          error: null,
          generationToken: null,
          generationLeaseExpiresAt: null,
          updatedAt: new Date(),
        }).where(and(
          eq(virtualStagingCandidates.id, candidate.id),
          eq(virtualStagingCandidates.jobId, job.id),
          eq(virtualStagingCandidates.status, "failed"),
        )).returning({ id: virtualStagingCandidates.id });
        if (!queued) throw new VirtualStagingHttpError(409, "This photo is already being retried");
      });
    } catch (error) {
      if (pgErrorCode(error) === "23505") {
        throw new VirtualStagingHttpError(409, "Another virtual-staging job is already active for this unit");
      }
      throw error;
    }
    scheduleVirtualStagingTask(`candidate ${candidate.id}`, () => processCandidate(candidate.id));
    res.status(202).json(await requireJobDto(job.id));
  }));

  app.post("/api/virtual-staging/jobs/:jobId/confirm", route(async (req, res) => {
    const session = requireAdmin(res);
    if (!session) return;
    const jobId = routeParam(req, "jobId");
    if (!UUID_RE.test(jobId)) throw new VirtualStagingHttpError(404, "Virtual-staging job was not found");
    const candidateIds = validateVirtualStagingCandidateIds(req.body);
    const [job] = await db.select().from(virtualStagingJobs)
      .where(eq(virtualStagingJobs.id, jobId)).limit(1);
    if (!job) throw new VirtualStagingHttpError(404, "Virtual-staging job was not found");
    if (job.status === "confirmed") {
      if (!sameVirtualStagingSelection(job.selectedCandidateIds, candidateIds)) {
        throw new VirtualStagingHttpError(409, "This job was already confirmed with a different selection");
      }
      res.json({
        job: await requireJobDto(job.id),
        swappedCount: candidateIds.length,
        alreadyConfirmed: true,
      });
      return;
    }
    if (job.status !== "ready") {
      throw new VirtualStagingHttpError(409, "Wait for virtual staging to finish before confirming");
    }
    const selected = await validateConfirmationState(job, candidateIds);
    await prepareConfirmationFiles(selected);
    // Re-resolve immediately before the locked transaction as a final guard
    // against a unit swap that landed during filesystem preparation.
    const currentUnit = await resolveVirtualStagingUnit(job.propertyId, job.unitId);
    if (currentUnit.folder !== job.folder) {
      throw new VirtualStagingHttpError(409, "This unit's photo folder changed while staging was being confirmed");
    }
    const activated = await activateCandidates(job.id, candidateIds, session.username);
    res.json({
      job: await requireJobDto(job.id),
      swappedCount: candidateIds.length,
      ...(activated.alreadyConfirmed ? { alreadyConfirmed: true } : {}),
    });
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
    res.setHeader("Content-Type", asset.mimeType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.sendFile(file);
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
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.sendFile(file);
  }));

  startRecoverySweep();
}
