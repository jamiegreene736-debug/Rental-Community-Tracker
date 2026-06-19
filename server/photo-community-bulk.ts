// Bulk photo community check for the dashboard — one property at a time,
// results persisted for the Community QA column. Jobs persist server-side so
// work continues after the browser tab closes or the process restarts.

import { randomUUID } from "crypto";
import {
  BULK_PHOTO_COMMUNITY_PROPERTY_TIMEOUT_MS,
  shouldFailStaleBulkPhotoCommunityItem,
  shouldReclaimBulkPhotoCommunityItem,
} from "../shared/photo-community-bulk-logic";
import {
  derivePhotoCommunityRowStatus,
  type PhotoCommunityRowStatus,
} from "../shared/photo-community-status-logic";
import { buildPhotoCommunityCheckRequestForProperty } from "./builder-photo-groups";
import { storage } from "./storage";
import { runPhotoCommunityCheck, type PhotoCommunityCheckResult } from "./photo-community-check";

const STATUS_SETTING_KEY = "photo_community_check.status_by_property";
const JOB_SETTING_KEY = "photo_community_check.active_job";
const BULK_PHOTO_COMMUNITY_RESUME_INTERVAL_MS = 60 * 1000;

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
let jobLoaded = false;
let resumeScheduled = false;
const runningJobIds = new Set<string>();

export { buildPhotoCommunityCheckRequestForProperty };

async function persistStatuses(): Promise<void> {
  const obj: Record<string, PhotoCommunityRowStatus> = {};
  for (const [id, row] of statusByProperty.entries()) obj[String(id)] = row;
  await storage.setSetting(STATUS_SETTING_KEY, JSON.stringify(obj));
}

async function persistJob(job: BulkPhotoCommunityJob | null): Promise<void> {
  if (!job || job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    await storage.setSetting(JOB_SETTING_KEY, "");
    return;
  }
  await storage.setSetting(JOB_SETTING_KEY, JSON.stringify(job));
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

async function loadPersistedJobOnce(): Promise<void> {
  if (jobLoaded) return;
  jobLoaded = true;
  await reloadActiveJobFromStorage();
}

async function reloadActiveJobFromStorage(): Promise<BulkPhotoCommunityJob | null> {
  try {
    const raw = await storage.getSetting(JOB_SETTING_KEY);
    if (!raw?.trim()) {
      activeJobId = null;
      return null;
    }
    const job = JSON.parse(raw) as BulkPhotoCommunityJob;
    if (!job?.id || !Array.isArray(job.items)) {
      await storage.setSetting(JOB_SETTING_KEY, "");
      activeJobId = null;
      return null;
    }
    jobs.set(job.id, job);
    if (job.status === "queued" || job.status === "running") {
      activeJobId = job.id;
    } else {
      activeJobId = null;
    }
    await refreshJobCounts(job);
    return job;
  } catch {
    await storage.setSetting(JOB_SETTING_KEY, "");
    activeJobId = null;
    return null;
  }
}

function propertyCheckTimedOut(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error(`Photo community check timed out after ${Math.round(ms / 60_000)} minutes`)),
      ms,
    );
  });
}

async function runPropertyPhotoCommunityCheck(
  request: Parameters<typeof runPhotoCommunityCheck>[0],
  apiKey: string,
): Promise<Awaited<ReturnType<typeof runPhotoCommunityCheck>>> {
  return Promise.race([
    runPhotoCommunityCheck(request, apiKey, Date.now()),
    propertyCheckTimedOut(BULK_PHOTO_COMMUNITY_PROPERTY_TIMEOUT_MS),
  ]);
}

async function ensureJobsHydrated(): Promise<void> {
  await loadStatusesOnce();
  await loadPersistedJobOnce();
}

function isTerminalItemStatus(status: BulkPhotoCommunityItemStatus): boolean {
  return status === "completed" || status === "failed" || status === "skipped" || status === "cancelled";
}

export async function getPhotoCommunityStatuses(): Promise<Record<number, PhotoCommunityRowStatus>> {
  await ensureJobsHydrated();
  const out: Record<number, PhotoCommunityRowStatus> = {};
  for (const [id, row] of statusByProperty.entries()) out[id] = row;
  return out;
}

/** Persist a single listing check so the dashboard Community QA column matches the photos tab. */
export async function savePhotoCommunityCheckResult(
  propertyId: number,
  result: PhotoCommunityCheckResult,
): Promise<PhotoCommunityRowStatus> {
  await ensureJobsHydrated();
  const row = derivePhotoCommunityRowStatus(propertyId, result, new Date().toISOString());
  statusByProperty.set(propertyId, row);
  await persistStatuses();
  return row;
}

export async function getBulkPhotoCommunityJob(jobId: string): Promise<BulkPhotoCommunityJob | null> {
  await ensureJobsHydrated();
  return jobs.get(jobId) ?? null;
}

export async function getActiveBulkPhotoCommunityJob(): Promise<BulkPhotoCommunityJob | null> {
  await ensureJobsHydrated();
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
  if (runningJobIds.has(job.id)) return;
  runningJobIds.add(job.id);
  const workerSessionStartedAt = Date.now();
  try {
  job.status = "running";
  job.startedAt = job.startedAt ?? Date.now();
  await persistJob(job);

  for (const item of job.items) {
    if (isTerminalItemStatus(item.status)) continue;
    if (job.cancelRequested) {
      item.status = "cancelled";
      continue;
    }

    if (shouldFailStaleBulkPhotoCommunityItem(item)) {
      item.status = "failed";
      item.finishedAt = Date.now();
      item.error = "Photo community check timed out (stale running item recovered)";
      statusByProperty.set(item.propertyId, {
        propertyId: item.propertyId,
        checkedAt: new Date().toISOString(),
        bedroomsOk: null,
      bedroomsTier: null,
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
      await refreshJobCounts(job);
      await persistStatuses();
      await persistJob(job);
      continue;
    }

    if (shouldReclaimBulkPhotoCommunityItem(item, workerSessionStartedAt)) {
      console.warn(
        `[photo-community-bulk] reclaiming stale running item property ${item.propertyId} (${item.label})`,
      );
      item.startedAt = undefined;
      item.error = undefined;
    }

    item.status = "running";
    item.startedAt = Date.now();
    statusByProperty.set(item.propertyId, {
      propertyId: item.propertyId,
      checkedAt: null,
      running: true,
      bedroomsOk: null,
      bedroomsTier: null,
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
    await persistJob(job);

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
      bedroomsTier: null,
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
      const result = await runPropertyPhotoCommunityCheck(built.request, apiKey);
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
      bedroomsTier: null,
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
    await persistJob(job);
  }
  await refreshJobCounts(job);
  job.finishedAt = Date.now();
  job.status = job.cancelRequested ? "cancelled" : job.failed > 0 ? "failed" : "completed";
  activeJobId = null;
  await persistJob(null);
  } finally {
    runningJobIds.delete(job.id);
  }
}

export async function startBulkPhotoCommunityCheck(
  propertyIds: number[],
  labels: Record<string, string>,
  apiKey: string,
): Promise<BulkPhotoCommunityJob> {
  await ensureJobsHydrated();
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
  await persistJob(job);
  void runBulkPhotoCommunityJob(job, apiKey);
  return job;
}

export async function cancelBulkPhotoCommunityJob(jobId: string): Promise<BulkPhotoCommunityJob | null> {
  await ensureJobsHydrated();
  const job = jobs.get(jobId);
  if (!job) return null;
  job.cancelRequested = true;
  for (const item of job.items) {
    if (item.status === "queued") item.status = "cancelled";
  }
  await persistJob(job);
  return job;
}

export async function isPropertyEligibleForPhotoCommunityCheck(propertyId: number): Promise<boolean> {
  const built = await buildPhotoCommunityCheckRequestForProperty(propertyId);
  return built != null;
}

/** Resume a queued/running job after server restart or worker loss. Safe to call repeatedly. */
export async function resumeBulkPhotoCommunityJobs(): Promise<void> {
  await loadStatusesOnce();
  const job = await reloadActiveJobFromStorage();
  if (!job || (job.status !== "queued" && job.status !== "running")) return;
  if (runningJobIds.has(job.id)) return;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) {
    console.warn("[photo-community-bulk] cannot resume — ANTHROPIC_API_KEY not configured");
    return;
  }
  console.log(`[photo-community-bulk] resuming job ${job.id} (${job.completed}/${job.items.length} done)`);
  void runBulkPhotoCommunityJob(job, apiKey);
}

export function scheduleBulkPhotoCommunityResume(): void {
  if (resumeScheduled) return;
  resumeScheduled = true;
  const tick = () => void resumeBulkPhotoCommunityJobs();
  setTimeout(tick, 4_000).unref?.();
  setInterval(tick, BULK_PHOTO_COMMUNITY_RESUME_INTERVAL_MS).unref?.();
}
