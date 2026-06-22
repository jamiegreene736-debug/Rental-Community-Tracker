import { preflightPhotoDiscoveryAttempts } from "@shared/preflight-photo-discovery";
import {
  buildUnitPhotoResolverProof,
  compareUnitPhotoProofs,
  MIN_INDEPENDENT_UNIT_PHOTOS,
  summarizeUnitPhotoProof,
  type UnitPhotoResolverProof,
} from "./unit-photo-resolver";

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
  proof: UnitPhotoResolverProof | null;
  diagnostic: Record<string, unknown> | null;
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
const MAX_REPLACEMENT_FIND_CONTINUATIONS = 12;
const photoFetchJobs = new Map<string, PreflightPhotoFetchJob>();
const replacementFindJobs = new Map<string, PreflightReplacementFindJob>();
const activePhotoFetchJobIds = new Set<string>();
const activeReplacementFindJobIds = new Set<string>();
const draftPhotoFetchProofs = new Map<number, Partial<Record<0 | 1, UnitPhotoResolverProof>>>();
const draftPhotoProofLockTails = new Map<number, Promise<void>>();

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

function reserveDraftPhotoProof(
  draftId: number,
  unitIndex: 0 | 1,
  proof: UnitPhotoResolverProof,
): string | null {
  const entry = draftPhotoFetchProofs.get(draftId) ?? {};
  const siblingIndex: 0 | 1 = unitIndex === 0 ? 1 : 0;
  const siblingProof = entry[siblingIndex];
  if (siblingProof) {
    const comparison = compareUnitPhotoProofs(proof, siblingProof);
    if (comparison.duplicate) {
      return `Unit ${unitIndex === 0 ? "A" : "B"} photo source duplicates Unit ${siblingIndex === 0 ? "A" : "B"} (${comparison.issues.join(", ") || "duplicate-photo-overlap"}; overlap ${comparison.overlapCount}, ratio ${comparison.overlapRatio.toFixed(2)}).`;
    }
  }
  entry[unitIndex] = proof;
  draftPhotoFetchProofs.set(draftId, entry);
  return null;
}

function releaseDraftPhotoProof(draftId: number, unitIndex: 0 | 1, proof: UnitPhotoResolverProof | null): void {
  if (!proof) return;
  const entry = draftPhotoFetchProofs.get(draftId);
  if (!entry || entry[unitIndex] !== proof) return;
  delete entry[unitIndex];
  if (!entry[0] && !entry[1]) draftPhotoFetchProofs.delete(draftId);
}

async function withDraftPhotoProofLock<T>(draftId: number, fn: () => Promise<T>): Promise<T> {
  const previous = draftPhotoProofLockTails.get(draftId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  draftPhotoProofLockTails.set(draftId, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (draftPhotoProofLockTails.get(draftId) === tail) {
      draftPhotoProofLockTails.delete(draftId);
    }
  }
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
  /**
   * "Re-pull all photos": rescrape THIS unit's own saved listing URL directly
   * (full gallery) before any discovery. Set by the preflight when a unit
   * already has a saved source. If the source is off-market / yields fewer than
   * MIN_INDEPENDENT_UNIT_PHOTOS, the job falls through to discovery so we still
   * land a usable gallery instead of saving nothing.
   */
  rescrapeSourceUrl?: string;
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
    proof: null,
    diagnostic: null,
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
  const rescrapeSourceUrl = typeof input.rescrapeSourceUrl === "string" && /^https?:\/\//i.test(input.rescrapeSourceUrl)
    ? input.rescrapeSourceUrl.trim()
    : null;
  const attempts = preflightPhotoDiscoveryAttempts(input.bedrooms, replacingExistingPhotos);
  let reservedProof: UnitPhotoResolverProof | null = null;
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
    let lastProof: UnitPhotoResolverProof | null = null;
    let lastDiagnostic: Record<string, unknown> | null = null;

    // "Re-pull all photos": rescrape this unit's OWN saved listing first, so the
    // operator gets the full original gallery rather than a discovery wander to
    // a different (often wrong-community) listing. The Redfin comp-carousel fix
    // (server/redfin-gallery.ts) guarantees the direct rescrape returns only the
    // subject listing's photos. If the saved listing is off-market / too thin
    // (< MIN_INDEPENDENT_UNIT_PHOTOS), fall through to the discovery loop below —
    // the source is in skipUrls so discovery won't re-pick the dead listing.
    if (rescrapeSourceUrl) {
      touchPhotoJob(job, {
        phase: "searching",
        message: "Re-pulling this unit's saved listing",
        progress: 42,
      });
      try {
        const fetchData = await postJson(`${base}/api/community/fetch-unit-photos`, {
          url: rescrapeSourceUrl,
          // No bedroom gate: this IS the unit's own listing — never reject it on
          // a scraped-bedroom mismatch (resort condos often mis-parse).
          bedrooms: "any",
          // Opt into the residential-IP sidecar: a Redfin/Homes/Zillow listing
          // whose datacenter scrape returns 0 usable gallery photos (bot-wall /
          // block page) is otherwise re-pulled thin (missing bedrooms). This is
          // a background job, so the extra sidecar latency is invisible to the
          // UI. The 300s timeout gives headroom for the worst realistic chain —
          // Apify (180s ceiling) then a 90s sidecar wallet — so a genuinely slow
          // re-pull isn't silently dropped into discovery; if it still overruns
          // it fails soft to the discovery loop below (current behavior). The
          // sidecar is inert/fast when the worker is offline. See LB #45.
          useSidecar: true,
        }, 300_000);
        lastNote = typeof fetchData?.note === "string" ? fetchData.note : lastNote;
        const nextPhotos = Array.isArray(fetchData?.photos) ? fetchData.photos as Array<{ url: string }> : [];
        const nextSourceUrl: string | null = fetchData?.sourceUrl ?? rescrapeSourceUrl;
        const nextProof = fetchData?.resolverProof && typeof fetchData.resolverProof === "object"
          ? fetchData.resolverProof as UnitPhotoResolverProof
          : buildUnitPhotoResolverProof({
              photos: nextPhotos,
              sourceUrl: nextSourceUrl,
              foundVia: typeof fetchData?.foundVia === "string" ? fetchData.foundVia : "url",
              facts: fetchData?.facts && typeof fetchData.facts === "object" ? fetchData.facts : null,
            });
        lastProof = nextProof;
        lastDiagnostic = fetchData?.diagnostic && typeof fetchData.diagnostic === "object"
          ? fetchData.diagnostic as Record<string, unknown>
          : null;
        touchPhotoJob(job, { proof: nextProof, diagnostic: lastDiagnostic });
        if (nextPhotos.length >= MIN_INDEPENDENT_UNIT_PHOTOS && nextProof.status !== "rejected") {
          photos = nextPhotos;
          sourceUrl = nextSourceUrl;
        }
      } catch (e: any) {
        // Off-market / unreachable saved listing — discovery takes over below.
        lastNote = e?.message || lastNote;
      }
    }

    // Discovery fallback — DISABLED for "Re-pull all photos" (replacingExistingPhotos).
    // That button rescrapes THIS unit's OWN saved listing only; if the listing can't
    // supply at least MIN_INDEPENDENT_UNIT_PHOTOS usable photos (or there's no saved
    // source URL at all) we KEEP the existing gallery rather than silently
    // substituting a DIFFERENT listing's photos (which is exactly what this discovery
    // loop does). Discovery still runs for "Find Photos" on an EMPTY unit, which is
    // the only flow through this handler that passes replacingExistingPhotos=false.
    const allowDiscoveryFallback = !replacingExistingPhotos;
    for (let i = 0; allowDiscoveryFallback && photos.length === 0 && i < attempts.length; i += 1) {
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
      const nextProof = fetchData?.resolverProof && typeof fetchData.resolverProof === "object"
        ? fetchData.resolverProof as UnitPhotoResolverProof
        : buildUnitPhotoResolverProof({
            photos: nextPhotos,
            sourceUrl: nextSourceUrl,
            foundVia: typeof fetchData?.foundVia === "string" ? fetchData.foundVia : null,
            requestedBedrooms: attempt.bedrooms === "any" ? null : attempt.bedrooms,
            minimumBedrooms: attempt.minBedrooms ?? null,
            facts: fetchData?.facts && typeof fetchData.facts === "object" ? fetchData.facts : null,
            representativeFallback: fetchData?.representativeFallback === true,
            reusedConfiguredSource: fetchData?.reusedConfiguredSource === true,
          });
      lastProof = nextProof;
      lastDiagnostic = fetchData?.diagnostic && typeof fetchData.diagnostic === "object"
        ? fetchData.diagnostic as Record<string, unknown>
        : null;
      touchPhotoJob(job, {
        proof: nextProof,
        diagnostic: lastDiagnostic,
      });
      if (nextPhotos.length > 0 && nextProof.status !== "rejected") {
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
      // "Re-pull all photos" (replacingExistingPhotos) never substitutes a different
      // listing — the discovery loop above is gated off — so the unit's existing
      // gallery is left untouched (we never reach persist) and the message says so.
      const replaceOnlyFailure = replacingExistingPhotos
        ? (rescrapeSourceUrl
            ? `This unit's saved listing didn't return at least ${MIN_INDEPENDENT_UNIT_PHOTOS} usable photos${lastNote ? ` — ${lastNote}` : ""}. Kept the existing gallery; no substitute listing was pulled.`
            : `This unit has no saved source listing to re-pull from. Kept the existing gallery — set a source under “Photo Sources” to refresh it.`)
        : null;
      const proofSummary = lastProof ? summarizeUnitPhotoProof("Photo search", lastProof) : null;
      touchPhotoJob(job, {
        status: "failed",
        phase: "failed",
        message: replaceOnlyFailure || lastNote || proofSummary || `Couldn't find another ${input.bedrooms}BR listing`,
        progress: 100,
        finishedAt: Date.now(),
        error: replaceOnlyFailure || lastNote || proofSummary || `Couldn't find another ${input.bedrooms}BR listing at ${input.communityName}`,
        proof: lastProof,
        diagnostic: lastDiagnostic,
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
    const persistData = await withDraftPhotoProofLock(input.draftId, async () => {
      const duplicateReservation = lastProof
        ? reserveDraftPhotoProof(input.draftId, input.unitIndex, lastProof)
        : null;
      if (duplicateReservation) {
        throw new Error(`${duplicateReservation} Continue candidate search; do not save duplicate photos on both units.`);
      }
      reservedProof = lastProof;
      return postJson(`${base}/api/community/${input.draftId}/persist-photos`, persistBody, 180_000);
    });
    const saved = input.unitIndex === 0 ? persistData?.unit1?.saved : persistData?.unit2?.saved;
    if (typeof saved === "number" && saved < MIN_INDEPENDENT_UNIT_PHOTOS) {
      throw new Error(`Only ${saved} photo${saved === 1 ? "" : "s"} saved after proof checks; at least ${MIN_INDEPENDENT_UNIT_PHOTOS} are required before replacing this unit's gallery.`);
    }

    touchPhotoJob(job, {
      status: "completed",
      phase: "completed",
      message: `Saved ${saved ?? 0} photo${saved === 1 ? "" : "s"}`,
      progress: 100,
      finishedAt: Date.now(),
      savedCount: typeof saved === "number" ? saved : null,
      sourceUrl,
      proof: lastProof,
      diagnostic: lastDiagnostic,
      error: null,
    });
  } catch (e: any) {
    releaseDraftPhotoProof(input.draftId, input.unitIndex, reservedProof);
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
        capExceeded?: boolean;
        uncheckedCandidates?: Array<Record<string, unknown>>;
        attempts?: Array<{ sourceUrl?: string }>;
      } | null;
      const unchecked = Array.isArray(diagnostic?.uncheckedCandidates)
        ? diagnostic!.uncheckedCandidates!
        : [];
      // Continue when the route left candidates unchecked — either the route/SearchAPI
      // budget tripped (budgetStopped) OR discovery overflowed one pass (capExceeded,
      // the hundreds-unit case). Each continuation re-checks the leftover pool with
      // skipDiscovery, so it drains a big community across passes without re-discovering.
      if ((!diagnostic?.budgetStopped && !diagnostic?.capExceeded) || unchecked.length === 0) break;
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
