import type { Express, Request, Response } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  bulkComboListingJobItems as bulkComboListingJobItemRows,
  bulkComboListingJobs as bulkComboListingJobRows,
  comboPhotoFetchJobItems as comboPhotoFetchJobItemRows,
  comboPhotoFetchJobs as comboPhotoFetchJobRows,
  queueJobEvents as queueJobEventRows,
} from "@shared/schema";
import {
  buildOperationDiagnostics,
  classifyFailureText,
  suggestRemediations,
  type OperationDiagnostics,
  type OperationJobType,
} from "@shared/operation-diagnostics";
import {
  communityAddressRuleForName,
  resolveBulkComboListingStreet,
} from "@shared/community-addresses";
import { suggestPricingArea } from "@shared/pricing-rates";
import { db } from "./db";
import {
  getPreflightPhotoFetchJob,
  getPreflightReplacementFindJob,
  startPreflightPhotoFetchJob,
  startPreflightReplacementFindJob,
  type StartPreflightPhotoFetchInput,
} from "./preflight-background-jobs";
import { getSidecarLaneStatus } from "./sidecar-lane";

type QueueHooks = {
  resumeBulkComboListing?: (jobId: string) => void;
  resumeComboPhotoFetch?: (jobId: string) => void;
};

const hooks: QueueHooks = {};

export function setOperationDiagnosticsQueueHooks(next: QueueHooks): void {
  if (next.resumeBulkComboListing) hooks.resumeBulkComboListing = next.resumeBulkComboListing;
  if (next.resumeComboPhotoFetch) hooks.resumeComboPhotoFetch = next.resumeComboPhotoFetch;
}

async function fetchQueueEvents(jobType: string, jobId: string, limit = 40): Promise<Array<{
  phase: string;
  level: string;
  message: string;
  itemKey: string | null;
  createdAt: string;
}>> {
  const rows = await db
    .select()
    .from(queueJobEventRows)
    .where(and(eq(queueJobEventRows.jobType, jobType), eq(queueJobEventRows.jobId, jobId)))
    .orderBy(desc(queueJobEventRows.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    phase: row.phase,
    level: row.level,
    message: row.message,
    itemKey: row.itemKey,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  }));
}

async function sidecarSnapshot(): Promise<Record<string, unknown>> {
  try {
    const sidecarQueue = await import("./vrbo-sidecar-queue");
    return { sidecar: sidecarQueue.getStatus(), sidecarLane: getSidecarLaneStatus() };
  } catch {
    return { sidecar: null, sidecarLane: getSidecarLaneStatus() };
  }
}

async function loadBulkComboJob(jobId: string) {
  const [jobRow] = await db.select().from(bulkComboListingJobRows).where(eq(bulkComboListingJobRows.id, jobId)).limit(1);
  if (!jobRow) return null;
  const itemRows = await db
    .select()
    .from(bulkComboListingJobItemRows)
    .where(eq(bulkComboListingJobItemRows.jobId, jobId))
    .orderBy(asc(bulkComboListingJobItemRows.sortOrder));
  const items = itemRows.map((row) => {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const community = (payload.community ?? {}) as Record<string, unknown>;
    return {
      id: row.itemKey,
      label: row.label,
      status: row.status,
      phase: row.phase,
      message: row.message,
      error: row.error,
      draftId: row.draftId,
      streetAddress: typeof payload.streetAddress === "string" ? payload.streetAddress : "",
      communityName: typeof community.name === "string" ? community.name : "",
      communityCity: typeof community.city === "string" ? community.city : "",
      communityState: typeof community.state === "string" ? community.state : "",
      addressHint: typeof community.addressHint === "string" ? community.addressHint : "",
      payload,
    };
  });
  return { job: jobRow, items };
}

async function loadComboPhotoJob(jobId: string) {
  const [jobRow] = await db.select().from(comboPhotoFetchJobRows).where(eq(comboPhotoFetchJobRows.id, jobId)).limit(1);
  if (!jobRow) return null;
  const itemRows = await db
    .select()
    .from(comboPhotoFetchJobItemRows)
    .where(eq(comboPhotoFetchJobItemRows.jobId, jobId))
    .orderBy(asc(comboPhotoFetchJobItemRows.sortOrder));
  return { job: jobRow, items: itemRows };
}

function eventLines(events: Awaited<ReturnType<typeof fetchQueueEvents>>): string[] {
  return events.map((e) =>
    `${e.createdAt} [${e.level}] ${e.phase}${e.itemKey ? ` · ${e.itemKey}` : ""}: ${e.message}`,
  );
}

export async function buildDiagnosticsForJob(
  jobType: OperationJobType,
  jobId: string,
  itemKey?: string | null,
): Promise<OperationDiagnostics | null> {
  const sidecar = await sidecarSnapshot();

  if (jobType === "replacement-find") {
    const job = getPreflightReplacementFindJob(jobId);
    if (!job) return null;
    const errorText = job.error || job.message || "";
    const { failureClass, hint } = classifyFailureText(errorText);
    const diagnostic = job.diagnostic as Record<string, unknown> | null;
    const issues = errorText
      ? [{ severity: "error" as const, source: "replacement-find", summary: errorText.slice(0, 500), detail: hint }]
      : [];
    const remediation = job.status === "failed"
      ? suggestRemediations({ jobType, failureClass, errorText, diagnostic })
      : [];
    return buildOperationDiagnostics({
      title: "Replacement unit search",
      severity: job.status === "failed" ? "error" : job.status === "completed" && !job.unit ? "warning" : "ok",
      summary: errorText || job.message || `Status: ${job.status}`,
      context: {
        jobId: job.id,
        jobType,
        status: job.status,
        phase: job.phase,
        progress: job.progress,
        failureClass,
        ...sidecar,
      },
      issues,
      extraSections: diagnostic
        ? [{ heading: "Search diagnostic:", lines: [JSON.stringify(diagnostic, null, 2)] }]
        : undefined,
      remediation,
    });
  }

  if (jobType === "preflight-photo-fetch") {
    const job = getPreflightPhotoFetchJob(jobId);
    if (!job) return null;
    const errorText = job.error || job.message || "";
    const { failureClass, hint } = classifyFailureText(errorText);
    const remediation = job.status === "failed"
      ? suggestRemediations({ jobType, failureClass, errorText })
      : [];
    return buildOperationDiagnostics({
      title: "Preflight photo fetch",
      severity: job.status === "failed" ? "error" : "ok",
      summary: errorText || job.message || `Status: ${job.status}`,
      context: {
        jobId: job.id,
        jobType,
        status: job.status,
        phase: job.phase,
        draftId: job.draftId,
        unitId: job.unitId,
        failureClass,
        ...sidecar,
      },
      issues: errorText
        ? [{ severity: "error", source: "preflight-photo-fetch", summary: errorText.slice(0, 500), detail: hint }]
        : [],
      remediation,
    });
  }

  if (jobType === "bulk-combo-listing") {
    const loaded = await loadBulkComboJob(jobId);
    if (!loaded) return null;
    const events = await fetchQueueEvents("bulk-combo-listing", jobId);
    const item = itemKey ? loaded.items.find((i) => i.id === itemKey) : null;
    const failedItems = loaded.items.filter((i) => i.status === "failed");
    const focus = item ?? (failedItems.length === 1 ? failedItems[0] : null);
    const errorText = focus?.error || focus?.message
      || (failedItems.length ? `${failedItems.length} listing(s) failed` : loaded.job.status);
    const textForClass = typeof errorText === "string" ? errorText : String(errorText);
    const { failureClass, hint } = classifyFailureText(textForClass);
    const severity = loaded.job.status === "failed" || failedItems.length > 0 ? "error" : "warning";
    const remediation = failedItems.length > 0 || focus?.status === "failed"
      ? suggestRemediations({
        jobType,
        failureClass,
        errorText: textForClass,
        itemKey: focus?.id ?? null,
      })
      : [];
    return buildOperationDiagnostics({
      title: "Bulk combo listing queue",
      severity,
      summary: textForClass || `Job ${loaded.job.status}`,
      context: {
        jobId,
        jobType,
        status: loaded.job.status,
        completed: loaded.job.completed,
        failed: loaded.job.failed,
        itemKey: focus?.id ?? itemKey ?? null,
        failureClass,
        ...sidecar,
      },
      issues: failedItems.slice(0, 8).map((fi) => ({
        severity: "error" as const,
        source: fi.id,
        summary: (fi.error || fi.message || "Failed").slice(0, 300),
        detail: hint,
      })),
      eventLines: eventLines(events),
      remediation,
    });
  }

  if (jobType === "combo-photo-fetch") {
    const loaded = await loadComboPhotoJob(jobId);
    if (!loaded) return null;
    const events = await fetchQueueEvents("combo-photo-fetch", jobId);
    const item = itemKey
      ? loaded.items.find((i) => i.itemKey === itemKey)
      : null;
    const failedItems = loaded.items.filter((i) => i.status === "failed");
    const focus = item ?? (failedItems.length === 1 ? failedItems[0] : null);
    const errorText = focus?.error || focus?.message
      || (failedItems.length ? `${failedItems.length} photo fetch item(s) failed` : loaded.job.status);
    const textForClass = typeof errorText === "string" ? errorText : String(errorText);
    const { failureClass, hint } = classifyFailureText(textForClass);
    const remediation = failedItems.length > 0
      ? suggestRemediations({ jobType, failureClass, errorText: textForClass, itemKey: focus?.itemKey ?? null })
      : [];
    return buildOperationDiagnostics({
      title: "Combo photo fetch",
      severity: loaded.job.status === "failed" || failedItems.length > 0 ? "error" : "ok",
      summary: textForClass,
      context: {
        jobId,
        jobType,
        status: loaded.job.status,
        completed: loaded.job.completed,
        failed: loaded.job.failed,
        itemKey: focus?.itemKey ?? itemKey ?? null,
        failureClass,
        ...sidecar,
      },
      issues: failedItems.slice(0, 6).map((fi) => ({
        severity: "error" as const,
        source: fi.itemKey,
        summary: (fi.error || fi.message || "Failed").slice(0, 300),
        detail: hint,
      })),
      eventLines: eventLines(events),
      remediation,
    });
  }

  return null;
}

async function remediateBulkCombo(
  jobId: string,
  playbook: string,
  itemKey?: string | null,
): Promise<{ applied: boolean; message: string; retried?: number }> {
  const loaded = await loadBulkComboJob(jobId);
  if (!loaded) return { applied: false, message: "Bulk combo job not found" };

  const resetItem = async (item: (typeof loaded.items)[number]) => {
    const payload = { ...item.payload } as Record<string, unknown>;
    const community = { ...((payload.community ?? {}) as Record<string, unknown>) };
    if (playbook === "fix-canonical-address" && item.communityName) {
      const street = resolveBulkComboListingStreet({
        communityName: item.communityName,
        city: item.communityCity,
        state: item.communityState,
        streetAddress: item.streetAddress,
        addressHint: item.addressHint,
      });
      if (street) payload.streetAddress = street;
      const rule = communityAddressRuleForName(item.communityName);
      if (rule) community.city = rule.city;
      if (!String(payload.pricingArea ?? "").trim()) {
        payload.pricingArea = suggestPricingArea(item.communityCity, item.communityState, item.communityName);
      }
      payload.community = community;
    }
    await db
      .update(bulkComboListingJobItemRows)
      .set({
        status: "queued",
        phase: playbook === "fix-canonical-address" ? "retrying" : "queued",
        message: playbook === "fix-canonical-address" ? "Canonical address applied; queued for retry" : "Queued for retry",
        error: null,
        attemptCount: 0,
        finishedAt: null,
        heartbeatAt: null,
        payload,
        updatedAt: new Date(),
      })
      .where(and(eq(bulkComboListingJobItemRows.jobId, jobId), eq(bulkComboListingJobItemRows.itemKey, item.id)));
  };

  if ((playbook === "retry-item" || playbook === "fix-canonical-address") && !itemKey) {
    return { applied: false, message: "itemKey required for this playbook" };
  }
  let reset = 0;
  for (const item of loaded.items) {
    if (item.status !== "failed") continue;
    if ((playbook === "retry-item" || playbook === "fix-canonical-address") && item.id !== itemKey) continue;
    await resetItem(item);
    reset += 1;
  }

  if (reset === 0) return { applied: false, message: "No failed items to retry" };

  await db
    .update(bulkComboListingJobRows)
    .set({
      status: "queued",
      cancelRequested: false,
      finishedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(bulkComboListingJobRows.id, jobId));

  hooks.resumeBulkComboListing?.(jobId);
  return { applied: true, message: `Re-queued ${reset} listing(s)`, retried: reset };
}

async function remediateComboPhoto(jobId: string, itemKey?: string | null): Promise<{ applied: boolean; message: string; retried?: number }> {
  const loaded = await loadComboPhotoJob(jobId);
  if (!loaded) return { applied: false, message: "Photo fetch job not found" };
  let reset = 0;
  for (const item of loaded.items) {
    if (item.status !== "failed") continue;
    if (itemKey && item.itemKey !== itemKey) continue;
    await db
      .update(comboPhotoFetchJobItemRows)
      .set({
        status: "queued",
        phase: "queued",
        message: "Queued for retry",
        error: null,
        attemptCount: 0,
        finishedAt: null,
        heartbeatAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(comboPhotoFetchJobItemRows.jobId, jobId), eq(comboPhotoFetchJobItemRows.itemKey, item.itemKey)));
    reset += 1;
  }
  if (reset === 0) return { applied: false, message: "No failed photo items to retry" };
  await db
    .update(comboPhotoFetchJobRows)
    .set({ status: "queued", cancelRequested: false, finishedAt: null, updatedAt: new Date() })
    .where(eq(comboPhotoFetchJobRows.id, jobId));
  hooks.resumeComboPhotoFetch?.(jobId);
  return { applied: true, message: `Re-queued ${reset} photo item(s)`, retried: reset };
}

function replacementBodyFromPayload(startPayload: Record<string, unknown>, patch: Record<string, unknown>) {
  return { ...startPayload, ...patch };
}

async function remediateReplacement(
  playbook: string,
  startPayload: Record<string, unknown>,
  priorJobId?: string,
): Promise<{ applied: boolean; message: string; job?: unknown }> {
  const prior = priorJobId ? getPreflightReplacementFindJob(priorJobId) : null;
  const diagnostic = prior?.diagnostic as Record<string, unknown> | null;
  if (!startPayload.communityFolder) {
    return { applied: false, message: "startPayload.communityFolder is required to restart replacement search" };
  }

  if (playbook === "continue-search" && diagnostic) {
    const unchecked = Array.isArray(diagnostic.uncheckedCandidates) ? diagnostic.uncheckedCandidates : [];
    const checkedUrls = Array.isArray(diagnostic.attempts)
      ? (diagnostic.attempts as Array<{ sourceUrl?: string }>).map((r) => String(r?.sourceUrl ?? "").trim()).filter(Boolean)
      : [];
    const priorSkip = Array.isArray(startPayload.skipUrls) ? (startPayload.skipUrls as string[]) : [];
    const job = startPreflightReplacementFindJob(replacementBodyFromPayload(startPayload, {
      skipDiscovery: true,
      resumeCandidates: unchecked,
      skipUrls: [...new Set([...priorSkip, ...checkedUrls])],
      expandedSearch: startPayload.expandedSearch === true,
    }));
    return { applied: true, message: "Continuing replacement search", job };
  }

  if (playbook === "expand-search") {
    const job = startPreflightReplacementFindJob(replacementBodyFromPayload(startPayload, { expandedSearch: true }));
    return { applied: true, message: "Expanded replacement search started", job };
  }

  if (playbook === "retry-search") {
    const job = startPreflightReplacementFindJob(replacementBodyFromPayload(startPayload, {}));
    return { applied: true, message: "Replacement search restarted", job };
  }

  return { applied: false, message: `Unknown replacement playbook: ${playbook}` };
}

export async function runOperationRemediation(body: {
  jobType: OperationJobType;
  jobId: string;
  playbook: string;
  itemKey?: string | null;
  startPayload?: Record<string, unknown>;
}): Promise<{ applied: boolean; message: string; diagnostics?: OperationDiagnostics; job?: unknown; retried?: number }> {
  const { jobType, jobId, playbook, itemKey, startPayload } = body;

  if (jobType === "bulk-combo-listing") {
    if (playbook === "retry-failed" || playbook === "retry-item" || playbook === "fix-canonical-address") {
      const result = await remediateBulkCombo(jobId, playbook, itemKey ?? (playbook === "retry-item" || playbook === "fix-canonical-address" ? itemKey : null));
      const diagnostics = await buildDiagnosticsForJob(jobType, jobId, itemKey ?? null);
      return { ...result, diagnostics: diagnostics ?? undefined };
    }
  }

  if (jobType === "combo-photo-fetch" && playbook === "retry-failed") {
    const result = await remediateComboPhoto(jobId, itemKey ?? null);
    const diagnostics = await buildDiagnosticsForJob(jobType, jobId, itemKey ?? null);
    return { ...result, diagnostics: diagnostics ?? undefined };
  }

  if (jobType === "replacement-find") {
    if (!startPayload || typeof startPayload !== "object") {
      return { applied: false, message: "startPayload required for replacement remediation" };
    }
    const result = await remediateReplacement(playbook, startPayload, jobId);
    const diagnostics = result.job && typeof result.job === "object" && "id" in (result.job as object)
      ? await buildDiagnosticsForJob(jobType, String((result.job as { id: string }).id))
      : await buildDiagnosticsForJob(jobType, jobId);
    return { ...result, diagnostics: diagnostics ?? undefined };
  }

  if (jobType === "preflight-photo-fetch" && playbook === "retry-search") {
    if (!startPayload || typeof startPayload !== "object") {
      return { applied: false, message: "startPayload required to restart preflight photo fetch" };
    }
    const job = startPreflightPhotoFetchJob(startPayload as StartPreflightPhotoFetchInput);
    const diagnostics = await buildDiagnosticsForJob(jobType, job.id);
    return { applied: true, message: "Photo fetch restarted", job, diagnostics: diagnostics ?? undefined };
  }

  return { applied: false, message: `Playbook "${playbook}" is not supported for ${jobType}` };
}

export function registerOperationDiagnosticsRoutes(app: Express): void {
  app.get("/api/operations/diagnostics", async (req: Request, res: Response) => {
    const jobType = String(req.query.jobType ?? "").trim() as OperationJobType;
    const jobId = String(req.query.jobId ?? "").trim();
    const itemKey = typeof req.query.itemKey === "string" ? req.query.itemKey.trim() : null;
    const valid: OperationJobType[] = ["bulk-combo-listing", "combo-photo-fetch", "replacement-find", "preflight-photo-fetch"];
    if (!valid.includes(jobType) || !jobId) {
      return res.status(400).json({ error: "jobType and jobId required" });
    }
    const diagnostics = await buildDiagnosticsForJob(jobType, jobId, itemKey || null);
    if (!diagnostics) return res.status(404).json({ error: "Job not found" });
    res.json({ diagnostics });
  });

  app.post("/api/operations/remediate", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      jobType?: OperationJobType;
      jobId?: string;
      playbook?: string;
      itemKey?: string | null;
      startPayload?: Record<string, unknown>;
    };
    const jobType = body.jobType;
    const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
    const playbook = typeof body.playbook === "string" ? body.playbook.trim() : "";
    if (!jobType || !jobId || !playbook) {
      return res.status(400).json({ error: "jobType, jobId, and playbook required" });
    }
    const result = await runOperationRemediation({
      jobType,
      jobId,
      playbook,
      itemKey: body.itemKey ?? null,
      startPayload: body.startPayload,
    });
    res.json(result);
  });
}
