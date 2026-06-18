// Bulk photo community check for the dashboard — one property at a time,
// results persisted for the Community QA column.

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { getUnitBuilderByPropertyId } from "../client/src/data/unit-builder-data";
import { resolveCanonicalCommunityPhotoFolder } from "../shared/community-photo-folders";
import { resolveDraftUnitBedrooms, positiveDraftInteger } from "../shared/draft-unit-bedrooms";
import {
  derivePhotoCommunityRowStatus,
  type PhotoCommunityRowStatus,
} from "../shared/photo-community-status-logic";
import { storage } from "./storage";
import {
  runPhotoCommunityCheck,
  type CheckGroupInput,
  type PhotoCommunityCheckRequest,
} from "./photo-community-check";
import type { CommunityDraft } from "../shared/schema";

const STATUS_SETTING_KEY = "photo_community_check.status_by_property";
const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif)$/i;

export type BulkPhotoCommunityItemStatus = "queued" | "running" | "completed" | "failed" | "skipped" | "cancelled";

export type BulkPhotoCommunityItem = {
  propertyId: number;
  label: string;
  status: BulkPhotoCommunityItemStatus;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
};

export type BulkPhotoCommunityJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  cancelRequested: boolean;
  items: BulkPhotoCommunityItem[];
  completed: number;
  failed: number;
  skipped: number;
  cancelled: number;
};

const jobs = new Map<string, BulkPhotoCommunityJob>();
let activeJobId: string | null = null;
const statusByProperty = new Map<number, PhotoCommunityRowStatus>();
let statusLoaded = false;

function publicPhotoDir(folder: string): string {
  const safe = folder.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return path.resolve(process.cwd(), "client/public/photos", safe);
}

async function buildGroupFromFolder(
  role: "community" | "unit",
  label: string,
  folder: string,
  expectedBedrooms?: number,
): Promise<CheckGroupInput | null> {
  const dir = publicPhotoDir(folder);
  let diskFiles: string[] = [];
  try {
    diskFiles = (await fs.promises.readdir(dir)).filter((f) => IMAGE_EXT.test(f)).sort();
  } catch {
    return null;
  }
  if (diskFiles.length === 0) return null;
  const labels = await storage.getPhotoLabelsByFolder(folder);
  const captions: Record<string, string> = {};
  for (const row of labels) {
    const cap = row.userLabel ?? row.label;
    if (cap) captions[row.filename] = cap;
  }
  return {
    role,
    label,
    folder,
    filenames: diskFiles,
    captions,
    expectedBedrooms,
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
    const communityGroup = await buildGroupFromFolder(
      "community",
      `Community — ${complexName}`,
      builder.communityPhotoFolder,
    );
    if (communityGroup) groups.push(communityGroup);
    for (let i = 0; i < builder.units.length; i++) {
      const u = builder.units[i];
      if (!u.photoFolder) continue;
      const letter = String.fromCharCode(65 + i);
      const g = await buildGroupFromFolder(
        "unit",
        `Unit ${letter} (${u.bedrooms}BR)`,
        u.photoFolder,
        u.bedrooms,
      );
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
  const communityGroup = await buildGroupFromFolder(
    "community",
    `Community — ${complexName}`,
    communityFolder,
  );
  if (communityGroup) groups.push(communityGroup);
  if (draft.unit1PhotoFolder) {
    const g1 = await buildGroupFromFolder(
      "unit",
      `Unit A (${u1Br}BR)`,
      draft.unit1PhotoFolder,
      u1Br,
    );
    if (g1) groups.push(g1);
  }
  if (!isSingle && draft.unit2PhotoFolder) {
    const g2 = await buildGroupFromFolder(
      "unit",
      `Unit B (${u2Br}BR)`,
      draft.unit2PhotoFolder,
      u2Br,
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

async function persistStatuses(): Promise<void> {
  const obj: Record<string, PhotoCommunityRowStatus> = {};
  for (const [id, row] of statusByProperty.entries()) obj[String(id)] = row;
  await storage.setSetting(STATUS_SETTING_KEY, JSON.stringify(obj));
}

async function loadStatusesOnce(): Promise<void> {
  if (statusLoaded) return;
  statusLoaded = true;
  try {
    const raw = await storage.getSetting(STATUS_SETTING_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, PhotoCommunityRowStatus>;
    for (const [k, v] of Object.entries(parsed)) {
      const id = Number(k);
      if (Number.isFinite(id)) statusByProperty.set(id, v);
    }
  } catch {
    // corrupt cache — start fresh
  }
}

export async function getPhotoCommunityStatuses(): Promise<Record<number, PhotoCommunityRowStatus>> {
  await loadStatusesOnce();
  const out: Record<number, PhotoCommunityRowStatus> = {};
  for (const [id, row] of statusByProperty.entries()) out[id] = row;
  return out;
}

export function getBulkPhotoCommunityJob(jobId: string): BulkPhotoCommunityJob | null {
  return jobs.get(jobId) ?? null;
}

export function getActiveBulkPhotoCommunityJob(): BulkPhotoCommunityJob | null {
  return activeJobId ? jobs.get(activeJobId) ?? null : null;
}

function summarizeJob(job: BulkPhotoCommunityJob) {
  return {
    id: job.id,
    status: job.status,
    createdAt: new Date(job.createdAt).toISOString(),
    startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : null,
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
    cancelRequested: job.cancelRequested,
    total: job.items.length,
    completed: job.completed,
    failed: job.failed,
    skipped: job.skipped,
    cancelled: job.cancelled,
    items: job.items.map((item) => ({
      ...item,
      startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : null,
      finishedAt: item.finishedAt ? new Date(item.finishedAt).toISOString() : null,
    })),
  };
}

export function serializeBulkPhotoCommunityJob(job: BulkPhotoCommunityJob) {
  return summarizeJob(job);
}

async function refreshJobCounts(job: BulkPhotoCommunityJob): Promise<void> {
  job.completed = job.items.filter((i) => i.status === "completed").length;
  job.failed = job.items.filter((i) => i.status === "failed").length;
  job.skipped = job.items.filter((i) => i.status === "skipped").length;
  job.cancelled = job.items.filter((i) => i.status === "cancelled").length;
}

async function runBulkPhotoCommunityJob(job: BulkPhotoCommunityJob, apiKey: string): Promise<void> {
  job.status = "running";
  job.startedAt = job.startedAt ?? Date.now();
  for (const item of job.items) {
    if (job.cancelRequested) {
      item.status = "cancelled";
      continue;
    }
    item.status = "running";
    item.startedAt = Date.now();
    statusByProperty.set(item.propertyId, {
      propertyId: item.propertyId,
      checkedAt: null,
      running: true,
      bedroomsOk: null,
      communityFolderOk: null,
      sameCommunityOk: null,
      overall: null,
      bedroomsFound: null,
      bedroomsExpected: null,
      communityPhotosChecked: null,
      communityPhotosTotal: null,
      communityAuditComplete: null,
      summary: "Running photo community check…",
      error: null,
    });
    await persistStatuses();

    try {
      const built = await buildPhotoCommunityCheckRequestForProperty(item.propertyId);
      if (!built) {
        item.status = "skipped";
        item.finishedAt = Date.now();
        item.error = "No photo folders on disk for this property.";
        statusByProperty.set(item.propertyId, {
          propertyId: item.propertyId,
          checkedAt: new Date().toISOString(),
          bedroomsOk: null,
          communityFolderOk: null,
          sameCommunityOk: null,
          overall: "skipped",
          bedroomsFound: null,
          bedroomsExpected: null,
          communityPhotosChecked: null,
          communityPhotosTotal: null,
          communityAuditComplete: null,
          summary: null,
          error: item.error,
        });
        continue;
      }
      const result = await runPhotoCommunityCheck(built.request, apiKey, Date.now());
      const row = derivePhotoCommunityRowStatus(item.propertyId, result, new Date().toISOString());
      statusByProperty.set(item.propertyId, row);
      item.status = "completed";
      item.finishedAt = Date.now();
    } catch (e: any) {
      item.status = "failed";
      item.finishedAt = Date.now();
      item.error = e?.message ?? String(e);
      statusByProperty.set(item.propertyId, {
        propertyId: item.propertyId,
        checkedAt: new Date().toISOString(),
        bedroomsOk: null,
        communityFolderOk: null,
        sameCommunityOk: null,
        overall: "fail",
        bedroomsFound: null,
        bedroomsExpected: null,
        communityPhotosChecked: null,
        communityPhotosTotal: null,
        communityAuditComplete: null,
        summary: null,
        error: item.error,
      });
    }
    await refreshJobCounts(job);
    await persistStatuses();
  }
  await refreshJobCounts(job);
  job.finishedAt = Date.now();
  job.status = job.cancelRequested ? "cancelled" : job.failed > 0 ? "failed" : "completed";
  activeJobId = null;
}

export async function startBulkPhotoCommunityCheck(
  propertyIds: number[],
  labels: Record<string, string>,
  apiKey: string,
): Promise<BulkPhotoCommunityJob> {
  await loadStatusesOnce();
  if (activeJobId) {
    const existing = jobs.get(activeJobId);
    if (existing && (existing.status === "queued" || existing.status === "running")) {
      return existing;
    }
  }
  const uniqueIds = Array.from(new Set(propertyIds.filter((id) => Number.isFinite(id))));
  const job: BulkPhotoCommunityJob = {
    id: randomUUID(),
    status: "queued",
    createdAt: Date.now(),
    cancelRequested: false,
    items: uniqueIds.map((propertyId) => ({
      propertyId,
      label: labels[String(propertyId)] ?? `Property ${propertyId}`,
      status: "queued" as const,
    })),
    completed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
  };
  jobs.set(job.id, job);
  activeJobId = job.id;
  void runBulkPhotoCommunityJob(job, apiKey);
  return job;
}

export async function cancelBulkPhotoCommunityJob(jobId: string): Promise<BulkPhotoCommunityJob | null> {
  const job = jobs.get(jobId);
  if (!job) return null;
  job.cancelRequested = true;
  for (const item of job.items) {
    if (item.status === "queued") item.status = "cancelled";
  }
  return job;
}

export async function isPropertyEligibleForPhotoCommunityCheck(propertyId: number): Promise<boolean> {
  const built = await buildPhotoCommunityCheckRequestForProperty(propertyId);
  return built != null;
}
