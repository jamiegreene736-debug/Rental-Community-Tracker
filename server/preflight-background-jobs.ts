import { preflightPhotoDiscoveryAttempts } from "@shared/preflight-photo-discovery";

type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type PreflightPhotoFetchJob = {
  id: string;
  status: JobStatus;
  phase: string;
  message: string;
  progress: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  draftId: number;
  propertyId: number;
  unitId: string;
  unitIndex: 0 | 1;
  savedCount: number | null;
  sourceUrl: string | null;
  error: string | null;
};

export type PreflightReplacementFindJob = {
  id: string;
  status: JobStatus;
  phase: string;
  message: string;
  progress: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  unit: Record<string, unknown> | null;
  diagnostic: Record<string, unknown> | null;
};

const JOB_TTL_MS = 2 * 60 * 60 * 1000;
// find-unit ROUTE_BUDGET_MS is up to 285s (expanded) and may still run one
// PHOTO_SCRAPE_TIMEOUT_MS step that started just inside the budget guard.
const REPLACEMENT_FIND_UNIT_LOOPBACK_TIMEOUT_MS = 350_000;
const MAX_REPLACEMENT_FIND_CONTINUATIONS = 8;
const photoFetchJobs = new Map<string, PreflightPhotoFetchJob>();
const replacementFindJobs = new Map<string, PreflightReplacementFindJob>();
const activePhotoFetchJobIds = new Set<string>();
const activeReplacementFindJobIds = new Set<string>();

import { loopbackRequestHeaders } from "./auth";

const loopbackBaseUrl = () => `http://127.0.0.1:${process.env.PORT || "5000"}`;

function newJobId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function touchPhotoJob(job: PreflightPhotoFetchJob, patch: Partial<PreflightPhotoFetchJob> = {}) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  photoFetchJobs.set(job.id, job);
}

function touchReplacementJob(job: PreflightReplacementFindJob, patch: Partial<PreflightReplacementFindJob> = {}) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  replacementFindJobs.set(job.id, job);
}

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<any> {
  const resp = await fetch(url, {
    method: "POST",
    headers: loopbackRequestHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error || data?.message || `HTTP ${resp.status}`);
  return data;
}

function cleanupStaleJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of photoFetchJobs) {
    if ((job.finishedAt ?? job.createdAt) < cutoff) photoFetchJobs.delete(id);
  }
  for (const [id, job] of replacementFindJobs) {
    if ((job.finishedAt ?? job.createdAt) < cutoff) replacementFindJobs.delete(id);
  }
}

setInterval(cleanupStaleJobs, 30 * 60 * 1000).unref?.();

export function getPreflightPhotoFetchJob(jobId: string): PreflightPhotoFetchJob | null {
  return photoFetchJobs.get(jobId) ?? null;
}

export function getPreflightReplacementFindJob(jobId: string): PreflightReplacementFindJob | null {
  return replacementFindJobs.get(jobId) ?? null;
}

export type StartPreflightPhotoFetchInput = {
  draftId: number;
  propertyId: number;
  unitId: string;
  unitIndex: 0 | 1;
  bedrooms: number;
  communityName: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  skipUrls?: string[];
  replacingExistingPhotos?: boolean;
  skipFirst?: number;
};

export function startPreflightPhotoFetchJob(input: StartPreflightPhotoFetchInput): PreflightPhotoFetchJob {
  const id = newJobId("ppfj");
  const job: PreflightPhotoFetchJob = {
    id,
    status: "queued",
    phase: "queued",
    message: "Queued",
    progress: 4,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    draftId: input.draftId,
    propertyId: input.propertyId,
    unitId: input.unitId,
    unitIndex: input.unitIndex,
    savedCount: null,
    sourceUrl: null,
    error: null,
  };
  photoFetchJobs.set(id, job);
  void runPreflightPhotoFetchJob(job, input);
  return job;
}

async function runPreflightPhotoFetchJob(
  job: PreflightPhotoFetchJob,
  input: StartPreflightPhotoFetchInput,
): Promise<void> {
  if (activePhotoFetchJobIds.has(job.id)) return;
  activePhotoFetchJobIds.add(job.id);
  const base = loopbackBaseUrl();
  const replacingExistingPhotos = input.replacingExistingPhotos === true;
  const attempts = preflightPhotoDiscoveryAttempts(input.bedrooms, replacingExistingPhotos);
  try {
    touchPhotoJob(job, {
      status: "running",
      phase: "searching",
      message: "Checking existing photo sources",
      progress: 12,
      startedAt: job.startedAt ?? Date.now(),
    });

    const triedUrls = new Set((input.skipUrls ?? []).filter(Boolean));
    let photos: Array<{ url: string }> = [];
    let sourceUrl: string | null = null;
    let lastNote: string | undefined;

    for (let i = 0; i < attempts.length; i += 1) {
      const attempt = attempts[i];
      touchPhotoJob(job, {
        phase: "searching",
        message: `Searching real-estate listings (attempt ${i + 1}/${attempts.length})`,
        progress: 18 + Math.round((i / attempts.length) * 58),
      });
      const fetchData = await postJson(`${base}/api/community/fetch-unit-photos`, {
        communityName: input.communityName,
        streetAddress: input.streetAddress,
        city: input.city,
        state: input.state,
        bedrooms: attempt.bedrooms,
        minBedrooms: attempt.minBedrooms,
        skipUrls: Array.from(triedUrls),
        skipFirst: triedUrls.size === 0 && replacingExistingPhotos ? (input.skipFirst ?? 1) : 0,
        maxCandidates: attempt.maxCandidates,
      }, 120_000);
      lastNote = typeof fetchData?.note === "string" ? fetchData.note : undefined;
      const nextPhotos = Array.isArray(fetchData?.photos) ? fetchData.photos as Array<{ url: string }> : [];
      const nextSourceUrl: string | null = fetchData?.sourceUrl ?? null;
      if (nextPhotos.length > 0) {
        photos = nextPhotos;
        sourceUrl = nextSourceUrl;
        break;
      }
      if (nextSourceUrl) triedUrls.add(nextSourceUrl);
      const exhausted = Array.isArray(fetchData?.triedCandidateUrls)
        ? (fetchData.triedCandidateUrls as string[])
        : [];
      for (const u of exhausted) triedUrls.add(u);
    }

    if (photos.length === 0) {
      touchPhotoJob(job, {
        status: "failed",
        phase: "failed",
        message: lastNote || `Couldn't find another ${input.bedrooms}BR listing`,
        progress: 100,
        finishedAt: Date.now(),
        error: lastNote || `Couldn't find another ${input.bedrooms}BR listing at ${input.communityName}`,
      });
      return;
    }

    touchPhotoJob(job, {
      phase: "persisting",
      message: "Saving photos to this draft",
      progress: 86,
    });
    const persistBody = input.unitIndex === 0
      ? { unit1Photos: photos.map((p) => p.url), unit2Photos: [], unit1SourceUrl: sourceUrl }
      : { unit1Photos: [], unit2Photos: photos.map((p) => p.url), unit2SourceUrl: sourceUrl };
    const persistData = await postJson(`${base}/api/community/${input.draftId}/persist-photos`, persistBody, 180_000);
    const saved = input.unitIndex === 0 ? persistData?.unit1?.saved : persistData?.unit2?.saved;

    touchPhotoJob(job, {
      status: "completed",
      phase: "completed",
      message: `Saved ${saved ?? 0} photo${saved === 1 ? "" : "s"}`,
      progress: 100,
      finishedAt: Date.now(),
      savedCount: typeof saved === "number" ? saved : null,
      sourceUrl,
      error: null,
    });
  } catch (e: any) {
    touchPhotoJob(job, {
      status: "failed",
      phase: "failed",
      message: e?.message || "Photo fetch failed",
      progress: 100,
      finishedAt: Date.now(),
      error: e?.message || "Photo fetch failed",
    });
  } finally {
    activePhotoFetchJobIds.delete(job.id);
  }
}

export function startPreflightReplacementFindJob(body: Record<string, unknown>): PreflightReplacementFindJob {
  const id = newJobId("prfj");
  const job: PreflightReplacementFindJob = {
    id,
    status: "queued",
    phase: "queued",
    message: "Queued",
    progress: 4,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    error: null,
    unit: null,
    diagnostic: null,
  };
  replacementFindJobs.set(id, job);
  void runPreflightReplacementFindJob(job, body);
  return job;
}

async function runPreflightReplacementFindJob(
  job: PreflightReplacementFindJob,
  body: Record<string, unknown>,
): Promise<void> {
  if (activeReplacementFindJobIds.has(job.id)) return;
  activeReplacementFindJobIds.add(job.id);
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    if (job.status !== "running") return;
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const progress = elapsed < 2
      ? 12 + elapsed * 10
      : elapsed < 90
        ? Math.min(88, 32 + elapsed * 0.6)
        : Math.min(94, 88 + (elapsed - 90) * 0.05);
    touchReplacementJob(job, {
      phase: elapsed < 2 ? "searching" : "checking",
      message: elapsed < 2
        ? "Searching Zillow, Realtor, and Redfin…"
        : elapsed > 90
          ? "Still checking candidates; this can take a few minutes"
          : "Checking Airbnb, VRBO, and Booking.com for conflicts…",
      progress,
    });
  }, 1_000);
  heartbeat.unref?.();
  try {
    touchReplacementJob(job, {
      status: "running",
      phase: "searching",
      message: "Searching Zillow, Realtor, and Redfin…",
      progress: 12,
      startedAt: Date.now(),
    });
    let requestBody: Record<string, unknown> = { ...body };
    let data: any = null;
    for (let pass = 0; pass <= MAX_REPLACEMENT_FIND_CONTINUATIONS; pass += 1) {
      if (pass > 0) {
        touchReplacementJob(job, {
          phase: "checking",
          message: `Continuing search (pass ${pass + 1})…`,
          progress: Math.min(92, 40 + pass * 6),
        });
      }
      data = await postJson(
        `${loopbackBaseUrl()}/api/replacement/find-unit`,
        requestBody,
        REPLACEMENT_FIND_UNIT_LOOPBACK_TIMEOUT_MS,
      );
      if (data?.unit) break;
      if (!data?.error) break;
      const diagnostic = data.diagnostic as {
        budgetStopped?: boolean;
        uncheckedCandidates?: Array<Record<string, unknown>>;
        attempts?: Array<{ sourceUrl?: string }>;
      } | null;
      const unchecked = Array.isArray(diagnostic?.uncheckedCandidates)
        ? diagnostic!.uncheckedCandidates!
        : [];
      if (!diagnostic?.budgetStopped || unchecked.length === 0) break;
      const checkedUrls = (diagnostic.attempts ?? [])
        .map((row) => String(row?.sourceUrl ?? "").trim())
        .filter(Boolean);
      const priorSkip = Array.isArray(requestBody.skipUrls)
        ? (requestBody.skipUrls as string[])
        : [];
      requestBody = {
        ...body,
        skipDiscovery: true,
        resumeCandidates: unchecked,
        skipUrls: [...new Set([...priorSkip, ...checkedUrls])],
        expandedSearch: body.expandedSearch === true || requestBody.expandedSearch === true,
      };
    }
    if (data?.error) {
      touchReplacementJob(job, {
        status: "failed",
        phase: "failed",
        message: data.error,
        progress: 100,
        finishedAt: Date.now(),
        error: data.error,
        diagnostic: data.diagnostic ?? null,
      });
      return;
    }
    touchReplacementJob(job, {
      status: "completed",
      phase: "completed",
      message: "Replacement unit found",
      progress: 100,
      finishedAt: Date.now(),
      unit: data.unit ?? null,
      diagnostic: data.diagnostic ?? null,
      error: null,
    });
  } catch (e: any) {
    touchReplacementJob(job, {
      status: "failed",
      phase: "failed",
      message: e?.message || "Replacement search failed",
      progress: 100,
      finishedAt: Date.now(),
      error: e?.message || "Replacement search failed",
    });
  } finally {
    clearInterval(heartbeat);
    activeReplacementFindJobIds.delete(job.id);
  }
}
