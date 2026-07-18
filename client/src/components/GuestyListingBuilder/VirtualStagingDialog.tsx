import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type {
  VirtualStagingCandidateDto,
  VirtualStagingJobDto,
} from "@shared/virtual-staging";
import {
  VIRTUAL_STAGING_FEEDBACK_MAX_LENGTH,
  chooseVirtualStagingJobSnapshot,
  virtualStagingJobMatchesSession,
} from "@shared/virtual-staging";

export type VirtualStagingUnit = {
  id: string;
  label: string;
  photoCount: number;
  photoInventoryReady: boolean;
};

export type VirtualStagingCandidate = VirtualStagingCandidateDto;
export type VirtualStagingJob = VirtualStagingJobDto;

export type VirtualStagingConfirmedResult = {
  job: VirtualStagingJob;
  swappedCount: number;
  unit: VirtualStagingUnit;
};

type VirtualStagingDialogProps = {
  open: boolean;
  propertyId: number;
  unit: VirtualStagingUnit;
  selectedOriginalFilenames?: readonly string[];
  initialJobId?: string;
  onOpenChange: (open: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  onConfirmed?: (result: VirtualStagingConfirmedResult) => void | Promise<void>;
  onFinished?: () => void;
  onResolvedExternally?: (result: VirtualStagingConfirmedResult) => void | Promise<void>;
  returnFocusElement?: HTMLElement | null;
  returnFocusFallbackElement?: HTMLElement | null;
};

const ACTIVE_JOB_STATUSES = new Set<VirtualStagingJob["status"]>(["queued", "running"]);
const POLL_INTERVAL_MS = 1_500;

type JobSnapshotScope = {
  sessionKey: string;
  propertyId: number;
  unitId: string;
  jobId?: string;
};

function jobFromPayload(payload: unknown): VirtualStagingJob {
  const candidate = payload && typeof payload === "object" && "job" in payload
    ? (payload as { job?: unknown }).job
    : payload;
  if (!candidate || typeof candidate !== "object") {
    throw new Error("The virtual-staging service returned an invalid job.");
  }
  const job = candidate as Partial<VirtualStagingJob>;
  if (typeof job.id !== "string" || !Array.isArray(job.candidates)) {
    throw new Error("The virtual-staging service returned an incomplete job.");
  }
  return job as VirtualStagingJob;
}

async function readJob(response: Response): Promise<VirtualStagingJob> {
  return jobFromPayload(await response.json());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function candidateIsSelectable(candidate: VirtualStagingCandidate): boolean {
  return candidate.status === "succeeded" && !!candidate.stagedUrl;
}

function candidateSelectionKey(candidate: Pick<VirtualStagingCandidate, "id" | "attempt">): string {
  return `${candidate.id}:${candidate.attempt}`;
}

function statusLabel(candidate: VirtualStagingCandidate): string {
  switch (candidate.status) {
    case "pending":
      return "Waiting to generate";
    case "generating":
      return "Generating virtual staging";
    case "succeeded":
      return "Virtual staging ready";
    case "failed":
      return "Generation failed";
  }
}

export default function VirtualStagingDialog({
  open,
  propertyId,
  unit,
  selectedOriginalFilenames,
  initialJobId,
  onOpenChange,
  onBusyChange,
  onConfirmed,
  onFinished,
  onResolvedExternally,
  returnFocusElement,
  returnFocusFallbackElement,
}: VirtualStagingDialogProps) {
  const { toast } = useToast();
  const [job, setJob] = useState<VirtualStagingJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [selectedCandidateKeys, setSelectedCandidateKeys] = useState<Set<string>>(new Set());
  const [retryingCandidateIds, setRetryingCandidateIds] = useState<Set<string>>(new Set());
  const [feedbackDrafts, setFeedbackDrafts] = useState<Map<string, string>>(new Map());
  const [startAttempt, setStartAttempt] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const selectedSourcesKey = selectedOriginalFilenames?.join("\u0000") ?? "resume-or-all";
  const sessionKey = `${propertyId}:${unit.id}:${initialJobId ?? "new"}:${selectedSourcesKey}:${startAttempt}`;
  const startRequestRef = useRef<{ key: string; promise: Promise<VirtualStagingJob> } | null>(null);
  const retryingRef = useRef<Set<string>>(new Set());
  const confirmingRef = useRef(false);
  const jobActionVersionRef = useRef(0);
  const locallyResolvedJobRef = useRef<string | null>(null);
  const externallyNotifiedJobRef = useRef<string | null>(null);
  const activeSessionKeyRef = useRef(sessionKey);
  // Update synchronously with the rendered property/unit so an old response
  // cannot land between render and effect cleanup.
  activeSessionKeyRef.current = sessionKey;

  const applyJobSnapshot = useCallback((nextJob: VirtualStagingJob, scope: JobSnapshotScope) => {
    if (activeSessionKeyRef.current !== scope.sessionKey
      || !virtualStagingJobMatchesSession(nextJob, scope)) return;
    setJob((current) => {
      if (activeSessionKeyRef.current !== scope.sessionKey) return current;
      return chooseVirtualStagingJobSnapshot(current, nextJob);
    });
  }, []);

  const refreshJobSnapshot = useCallback(async (
    jobId: string,
    actionVersion: number,
    scope: JobSnapshotScope,
  ): Promise<void> => {
    const response = await apiRequest("GET", `/api/virtual-staging/jobs/${encodeURIComponent(jobId)}`);
    const nextJob = await readJob(response);
    if (jobActionVersionRef.current === actionVersion) applyJobSnapshot(nextJob, scope);
  }, [applyJobSnapshot]);

  // A keyed staging session starts exactly one server job. Its lifecycle is
  // intentionally independent of modal visibility: closing the dialog must not
  // cancel the response handler, strand `starting`, or reset review selections.
  // Keeping the promise in a ref also prevents React effect replays from issuing
  // duplicate POSTs.
  useEffect(() => {
    if (!unit.id || !Number.isFinite(propertyId)) return;

    let cancelled = false;
    const requestKey = sessionKey;
    ++jobActionVersionRef.current;
    retryingRef.current.clear();
    setJob(null);
    setStarting(true);
    setStartError(null);
    setPollError(null);
    setConfirmError(null);
    setFinishError(null);
    setSelectedCandidateKeys(new Set());
    setRetryingCandidateIds(new Set());
    setFeedbackDrafts(new Map());

    let request = startRequestRef.current;
    if (!request || request.key !== requestKey) {
      request = {
        key: requestKey,
        promise: initialJobId
          ? apiRequest(
            "GET",
            `/api/virtual-staging/jobs/${encodeURIComponent(initialJobId)}`,
          ).then(readJob)
          : apiRequest("POST", "/api/virtual-staging/jobs", {
            propertyId,
            unitId: unit.id,
            ...(selectedOriginalFilenames
              ? { selectedOriginalFilenames: [...selectedOriginalFilenames] }
              : {}),
          }).then(readJob),
      };
      startRequestRef.current = request;
    }

    request.promise
      .then((nextJob) => {
        if (cancelled) return;
        applyJobSnapshot(nextJob, {
          sessionKey: requestKey,
          propertyId,
          unitId: unit.id,
          ...(initialJobId ? { jobId: initialJobId } : {}),
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = errorMessage(error);
        setStartError(message);
        toast({
          title: `Couldn't restage ${unit.label}`,
          description: message,
          variant: "destructive",
        });
      })
      .finally(() => {
        if (!cancelled) setStarting(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    applyJobSnapshot,
    initialJobId,
    propertyId,
    selectedOriginalFilenames,
    selectedSourcesKey,
    sessionKey,
    startAttempt,
    toast,
    unit.id,
    unit.label,
  ]);

  // Poll in the background even if the operator closes the modal. That keeps
  // the launch controls disabled until the live job actually reaches a terminal
  // state and prevents a second click from creating a duplicate job.
  useEffect(() => {
    if (!job || !ACTIVE_JOB_STATUSES.has(job.status)) return;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      const actionVersion = jobActionVersionRef.current;
      const scope: JobSnapshotScope = {
        sessionKey,
        propertyId,
        unitId: unit.id,
        jobId: job.id,
      };
      try {
        const response = await apiRequest("GET", `/api/virtual-staging/jobs/${encodeURIComponent(job.id)}`);
        const nextJob = await readJob(response);
        if (!cancelled && jobActionVersionRef.current === actionVersion) {
          applyJobSnapshot(nextJob, scope);
          setPollError(null);
        }
      } catch (error: unknown) {
        if (!cancelled) setPollError(errorMessage(error));
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    timer = window.setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [applyJobSnapshot, job?.id, job?.status, propertyId, sessionKey, unit.id]);

  // A terminal review is not background-polled. Refresh once whenever it is
  // reopened so feedback or confirmation completed in another tab is visible.
  useEffect(() => {
    if (!open || !job?.id) return;
    const actionVersion = jobActionVersionRef.current;
    void refreshJobSnapshot(job.id, actionVersion, {
      sessionKey,
      propertyId,
      unitId: unit.id,
      jobId: job.id,
    }).catch(() => undefined);
  }, [job?.id, open, propertyId, refreshJobSnapshot, sessionKey, unit.id]);

  // Another tab can confirm or finish the retained job while this dialog is
  // starting or polling it. Release the local session as soon as that durable
  // status is observed so it cannot strand the other unit behind stale UI.
  useEffect(() => {
    if (
      job?.status !== "confirmed"
      || locallyResolvedJobRef.current === job.id
      || externallyNotifiedJobRef.current === job.id
    ) return;
    externallyNotifiedJobRef.current = job.id;
    onOpenChange(false);
    void Promise.resolve(onResolvedExternally?.({
      job,
      swappedCount: job.selectedCount ?? 0,
      unit,
    })).catch((error: unknown) => {
      toast({
        title: "Virtual staging was resolved in another tab, but the gallery couldn't refresh",
        description: errorMessage(error),
        variant: "destructive",
      });
    });
  }, [job, onOpenChange, onResolvedExternally, toast, unit]);

  const successfulCandidates = useMemo(
    () => job?.candidates.filter(candidateIsSelectable) ?? [],
    [job?.candidates],
  );
  const hasUnsubmittedFeedback = successfulCandidates.some((candidate) => (
    feedbackDrafts.get(candidateSelectionKey(candidate))?.trim().length ?? 0
  ) > 0);

  // A retry can move a formerly successful candidate back into a generating or
  // failed state. Never leave an ineligible candidate selected for confirmation.
  useEffect(() => {
    const selectableKeys = new Set(successfulCandidates.map(candidateSelectionKey));
    setSelectedCandidateKeys((current) => {
      const next = new Set(Array.from(current).filter((key) => selectableKeys.has(key)));
      const unchanged = next.size === current.size && Array.from(current).every((key) => next.has(key));
      return unchanged ? current : next;
    });
  }, [successfulCandidates]);

  const activeJob = !!job && ACTIVE_JOB_STATUSES.has(job.status);
  const candidateActionInFlight = retryingCandidateIds.size > 0;
  const busy = (open && !job && !startError)
    || starting
    || activeJob
    || confirming
    || finishing
    || candidateActionInFlight;
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  const finishedCount = job
    ? job.candidates.filter((candidate) => candidate.status === "succeeded" || candidate.status === "failed").length
    : 0;
  const requestedPhotoCount = selectedOriginalFilenames?.length ?? unit.photoCount;
  const totalCount = job?.total ?? requestedPhotoCount;
  const progressPercent = totalCount > 0 ? Math.min(100, Math.round((finishedCount / totalCount) * 100)) : 0;
  const selectedSuccessfulCandidates = successfulCandidates
    .filter((candidate) => selectedCandidateKeys.has(candidateSelectionKey(candidate)));
  const selectedCandidateSelections = selectedSuccessfulCandidates
    .map((candidate) => ({ id: candidate.id, attempt: candidate.attempt }));

  const toggleCandidate = useCallback((candidate: VirtualStagingCandidate, checked: boolean) => {
    setSelectedCandidateKeys((current) => {
      const next = new Set(current);
      const key = candidateSelectionKey(candidate);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const retryCandidate = useCallback(async (candidate: VirtualStagingCandidate) => {
    const candidateId = candidate.id;
    if (!job || retryingRef.current.size > 0 || confirmingRef.current) return;
    retryingRef.current.add(candidateId);
    const actionVersion = ++jobActionVersionRef.current;
    setRetryingCandidateIds(new Set(retryingRef.current));
    setPollError(null);

    try {
      const response = await apiRequest(
        "POST",
        `/api/virtual-staging/jobs/${encodeURIComponent(job.id)}/candidates/${encodeURIComponent(candidateId)}/retry`,
        { attempt: candidate.attempt },
      );
      const nextJob = await readJob(response);
      if (jobActionVersionRef.current === actionVersion) applyJobSnapshot(nextJob, {
        sessionKey,
        propertyId,
        unitId: unit.id,
        jobId: job.id,
      });
      if (activeSessionKeyRef.current !== sessionKey) return;
      setSelectedCandidateKeys((current) => new Set(
        Array.from(current).filter((key) => !key.startsWith(`${candidateId}:`)),
      ));
    } catch (error: unknown) {
      if (activeSessionKeyRef.current !== sessionKey) return;
      const message = errorMessage(error);
      setPollError(message);
      toast({ title: "Couldn't retry this photo", description: message, variant: "destructive" });
      await refreshJobSnapshot(job.id, actionVersion, {
        sessionKey,
        propertyId,
        unitId: unit.id,
        jobId: job.id,
      }).catch(() => undefined);
    } finally {
      retryingRef.current.delete(candidateId);
      if (activeSessionKeyRef.current === sessionKey) {
        setRetryingCandidateIds(new Set(retryingRef.current));
      }
    }
  }, [applyJobSnapshot, job, propertyId, refreshJobSnapshot, sessionKey, toast, unit.id]);

  const reviseCandidateWithFeedback = useCallback(async (candidate: VirtualStagingCandidate) => {
    const candidateId = candidate.id;
    const draftKey = candidateSelectionKey(candidate);
    const feedback = feedbackDrafts.get(draftKey)?.trim() ?? "";
    if (!job || retryingRef.current.size > 0 || confirmingRef.current || !feedback) return;
    if (feedback.length > VIRTUAL_STAGING_FEEDBACK_MAX_LENGTH) return;
    retryingRef.current.add(candidateId);
    const actionVersion = ++jobActionVersionRef.current;
    setRetryingCandidateIds(new Set(retryingRef.current));
    setPollError(null);

    try {
      const response = await apiRequest(
        "POST",
        `/api/virtual-staging/jobs/${encodeURIComponent(job.id)}/candidates/${encodeURIComponent(candidateId)}/feedback`,
        { attempt: candidate.attempt, feedback },
      );
      const nextJob = await readJob(response);
      if (jobActionVersionRef.current === actionVersion) applyJobSnapshot(nextJob, {
        sessionKey,
        propertyId,
        unitId: unit.id,
        jobId: job.id,
      });
      if (activeSessionKeyRef.current !== sessionKey) return;
      setSelectedCandidateKeys((current) => new Set(
        Array.from(current).filter((key) => !key.startsWith(`${candidateId}:`)),
      ));
      setFeedbackDrafts((current) => {
        const next = new Map(current);
        next.delete(draftKey);
        return next;
      });
    } catch (error: unknown) {
      if (activeSessionKeyRef.current !== sessionKey) return;
      const message = errorMessage(error);
      setPollError(message);
      toast({ title: "Couldn't apply feedback to this photo", description: message, variant: "destructive" });
      await refreshJobSnapshot(job.id, actionVersion, {
        sessionKey,
        propertyId,
        unitId: unit.id,
        jobId: job.id,
      }).catch(() => undefined);
    } finally {
      retryingRef.current.delete(candidateId);
      if (activeSessionKeyRef.current === sessionKey) {
        setRetryingCandidateIds(new Set(retryingRef.current));
      }
    }
  }, [applyJobSnapshot, feedbackDrafts, job, propertyId, refreshJobSnapshot, sessionKey, toast, unit.id]);

  const restorePreviousPreview = useCallback(async (candidate: VirtualStagingCandidate) => {
    const candidateId = candidate.id;
    if (!job
      || !candidate.previousStagedUrl
      || retryingRef.current.size > 0
      || confirmingRef.current) return;
    retryingRef.current.add(candidateId);
    const actionVersion = ++jobActionVersionRef.current;
    setRetryingCandidateIds(new Set(retryingRef.current));
    setPollError(null);

    try {
      const response = await apiRequest(
        "POST",
        `/api/virtual-staging/jobs/${encodeURIComponent(job.id)}/candidates/${encodeURIComponent(candidateId)}/restore-previous`,
        { attempt: candidate.attempt },
      );
      const nextJob = await readJob(response);
      if (jobActionVersionRef.current === actionVersion) applyJobSnapshot(nextJob, {
        sessionKey,
        propertyId,
        unitId: unit.id,
        jobId: job.id,
      });
      if (activeSessionKeyRef.current !== sessionKey) return;
      setSelectedCandidateKeys((current) => new Set(
        Array.from(current).filter((key) => !key.startsWith(`${candidateId}:`)),
      ));
      toast({
        title: "Previous preview restored for review",
        description: "Select “Use staged photo” on this photo if you want to apply it.",
      });
    } catch (error: unknown) {
      if (activeSessionKeyRef.current !== sessionKey) return;
      const message = errorMessage(error);
      setPollError(message);
      toast({ title: "Couldn't restore the previous preview", description: message, variant: "destructive" });
      await refreshJobSnapshot(job.id, actionVersion, {
        sessionKey,
        propertyId,
        unitId: unit.id,
        jobId: job.id,
      }).catch(() => undefined);
    } finally {
      retryingRef.current.delete(candidateId);
      if (activeSessionKeyRef.current === sessionKey) {
        setRetryingCandidateIds(new Set(retryingRef.current));
      }
    }
  }, [applyJobSnapshot, job, propertyId, refreshJobSnapshot, sessionKey, toast, unit.id]);

  const confirmSelection = useCallback(async () => {
    if (!job
      || selectedCandidateSelections.length === 0
      || confirmingRef.current
      || retryingRef.current.size > 0
      || hasUnsubmittedFeedback) return;
    confirmingRef.current = true;
    setConfirming(true);
    setConfirmError(null);

    try {
      const response = await apiRequest(
        "POST",
        `/api/virtual-staging/jobs/${encodeURIComponent(job.id)}/confirm`,
        { candidateSelections: selectedCandidateSelections },
      );
      const payload = await response.json() as { job?: unknown; swappedCount?: unknown };
      const confirmedJob = jobFromPayload(payload);
      locallyResolvedJobRef.current = confirmedJob.id;
      const swappedCount = typeof payload.swappedCount === "number"
        ? payload.swappedCount
        : selectedCandidateSelections.length;
      setJob(confirmedJob);
      toast({
        title: `${swappedCount} ${unit.label} photo${swappedCount === 1 ? " was" : "s were"} replaced with virtually staged versions.`,
      });
      try {
        await onConfirmed?.({ job: confirmedJob, swappedCount, unit });
      } catch (refreshError: unknown) {
        toast({
          title: "Virtual staging was saved, but the gallery couldn't refresh",
          description: errorMessage(refreshError),
          variant: "destructive",
        });
      }
      onOpenChange(false);
    } catch (error: unknown) {
      const message = errorMessage(error);
      setConfirmError(message);
      toast({ title: "Couldn't swap the selected photos", description: message, variant: "destructive" });
    } finally {
      confirmingRef.current = false;
      setConfirming(false);
    }
  }, [hasUnsubmittedFeedback, job, onConfirmed, onOpenChange, selectedCandidateSelections, toast, unit]);

  const finishWithoutSwaps = useCallback(async () => {
    if (confirmingRef.current
      || activeJob
      || retryingRef.current.size > 0
      || hasUnsubmittedFeedback) return;
    confirmingRef.current = true;
    setFinishing(true);
    setFinishError(null);
    setConfirmError(null);

    try {
      if (job) {
        const response = await apiRequest(
          "POST",
          `/api/virtual-staging/jobs/${encodeURIComponent(job.id)}/finish`,
        );
        const finishedJob = await readJob(response);
        locallyResolvedJobRef.current = finishedJob.id;
        setJob(finishedJob);
      }
      toast({ title: `Kept the original ${unit.label} photos. This staging review is finished.` });
      onFinished?.();
      onOpenChange(false);
    } catch (error: unknown) {
      const message = errorMessage(error);
      setFinishError(message);
      toast({ title: "Couldn't finish this staging review", description: message, variant: "destructive" });
    } finally {
      confirmingRef.current = false;
      setFinishing(false);
    }
  }, [activeJob, hasUnsubmittedFeedback, job, onFinished, onOpenChange, toast, unit.label]);

  const safelyChangeOpen = (nextOpen: boolean) => {
    if (!nextOpen && confirmingRef.current) return;
    onOpenChange(nextOpen);
  };

  const generationSummary = starting
    ? `Starting virtual staging for ${unit.label}…`
    : activeJob
      ? `Restaging ${finishedCount} of ${totalCount} photos…`
      : job?.status === "confirmed"
        ? "Selected staged photos have been applied."
        : job?.status === "failed"
          ? "Virtual staging could not be completed."
          : job
            ? `${successfulCandidates.length} of ${totalCount} staged photos are ready to review.`
            : `Preparing ${requestedPhotoCount} photos for review.`;

  return (
    <Dialog open={open} onOpenChange={safelyChangeOpen}>
      <DialogContent
        className="flex max-h-[92vh] w-[min(96vw,1200px)] max-w-6xl flex-col overflow-hidden p-0"
        data-testid="virtual-staging-dialog"
        aria-busy={busy}
        onEscapeKeyDown={(event) => {
          if (confirmingRef.current) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (confirmingRef.current) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          const triggerDisabled = returnFocusElement instanceof HTMLButtonElement && returnFocusElement.disabled;
          const focusTarget = triggerDisabled ? returnFocusFallbackElement : returnFocusElement;
          if (!focusTarget) return;
          event.preventDefault();
          focusTarget.focus();
        }}
      >
        <DialogHeader className="shrink-0 border-b px-6 pb-4 pt-6 pr-14">
          <DialogTitle>Review Virtual Staging — {unit.label}</DialogTitle>
          <DialogDescription aria-live="polite">{generationSummary}</DialogDescription>
          {(starting || activeJob) && (
            <Progress
              value={progressPercent}
              aria-label={`Virtual staging progress: ${finishedCount} of ${totalCount} photos complete`}
              className="mt-2 h-2"
            />
          )}
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {startError && !job && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4" role="alert">
              <p className="font-medium text-destructive">Virtual staging did not start.</p>
              <p className="mt-1 text-sm text-muted-foreground">{startError}</p>
              <Button className="mt-3" size="sm" variant="outline" onClick={() => setStartAttempt((attempt) => attempt + 1)}>
                <RefreshCw /> Try again
              </Button>
            </div>
          )}

          {pollError && (
            <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm" role="alert">
              <span className="font-medium text-destructive">Progress update failed: </span>
              <span className="text-muted-foreground">{pollError}</span>
            </div>
          )}

          {confirmError && (
            <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm" role="alert">
              <span className="font-medium text-destructive">Nothing was swapped: </span>
              <span className="text-muted-foreground">{confirmError}</span>
            </div>
          )}

          {finishError && (
            <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm" role="alert">
              <span className="font-medium text-destructive">The review is still open: </span>
              <span className="text-muted-foreground">{finishError}</span>
            </div>
          )}

          {job && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 p-3">
              <div className="text-sm" aria-live="polite">
                <span className="font-medium">{selectedSuccessfulCandidates.length} of {totalCount}</span>{" "}
                staged photos selected
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={successfulCandidates.length === 0 || confirming || finishing || candidateActionInFlight}
                  onClick={() => setSelectedCandidateKeys(new Set(successfulCandidates.map(candidateSelectionKey)))}
                  data-testid="button-select-all-staged"
                >
                  Select all successful
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={selectedSuccessfulCandidates.length === 0 || confirming || finishing || candidateActionInFlight}
                  onClick={() => setSelectedCandidateKeys(new Set())}
                  data-testid="button-clear-staged-selection"
                >
                  Clear all
                </Button>
              </div>
            </div>
          )}

          {starting && !job && !startError && (
            <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="animate-spin" /> Preparing photo comparisons…
            </div>
          )}

          {job?.candidates.length === 0 && !activeJob && (
            <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              No eligible photos were found for {unit.label}.
            </div>
          )}

          <div className="space-y-5">
            {job?.candidates.map((candidate, index) => {
              const selectable = candidateIsSelectable(candidate);
              const selectionKey = candidateSelectionKey(candidate);
              const selected = selectable && selectedCandidateKeys.has(selectionKey);
              const retrying = retryingCandidateIds.has(candidate.id);
              const feedbackDraft = feedbackDrafts.get(selectionKey) ?? "";
              const label = candidate.roomLabel?.trim() || candidate.originalFilename || `Photo ${index + 1}`;
              const checkboxId = `use-staged-${candidate.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
              const feedbackId = `staging-feedback-${candidate.id.replace(/[^a-zA-Z0-9_-]/g, "-")}-${candidate.attempt}`;

              return (
                <section
                  key={candidate.id}
                  className="overflow-hidden rounded-lg border bg-card"
                  data-testid={`virtual-staging-candidate-${candidate.id}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2 border-b bg-muted/20 px-4 py-3">
                    <div>
                      <h3 className="font-medium">{label}</h3>
                      <p className="mt-0.5 break-all text-xs text-muted-foreground">{candidate.originalFilename}</p>
                    </div>
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                        candidate.status === "succeeded"
                          ? "bg-emerald-100 text-emerald-800"
                          : candidate.status === "failed"
                            ? "bg-red-100 text-red-800"
                            : "bg-sky-100 text-sky-800"
                      }`}
                    >
                      {statusLabel(candidate)}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
                    <figure className="min-w-0">
                      <figcaption className="mb-2 text-sm font-semibold">Original</figcaption>
                      <div className="flex min-h-44 items-center justify-center overflow-hidden rounded-md bg-muted/40">
                        <img
                          src={candidate.originalUrl}
                          alt={`Original photo: ${label}`}
                          className="h-auto max-h-[62vh] w-full object-contain"
                        />
                      </div>
                      <a
                        href={candidate.originalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        Enlarge original <ExternalLink className="h-3 w-3" />
                      </a>
                    </figure>

                    <figure className="min-w-0">
                      <figcaption className="mb-2 text-sm font-semibold">Virtual Staging</figcaption>
                      {candidate.stagedUrl && candidate.status === "succeeded" ? (
                        <>
                          <div className="flex min-h-44 items-center justify-center overflow-hidden rounded-md bg-muted/40">
                            <img
                              src={candidate.stagedUrl}
                              alt={`Virtually staged photo: ${label}`}
                              className="h-auto max-h-[62vh] w-full object-contain"
                            />
                          </div>
                          <a
                            href={candidate.stagedUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            Enlarge virtual staging <ExternalLink className="h-3 w-3" />
                          </a>
                          <div className="mt-3">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={!!feedbackDraft.trim() || candidateActionInFlight || confirming || finishing}
                              title={feedbackDraft.trim()
                                ? "Submit or clear this photo's feedback before generating another angle."
                                : undefined}
                              onClick={() => void retryCandidate(candidate)}
                              data-testid={`button-regenerate-staging-${candidate.id}`}
                            >
                              {retrying ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                              {retrying ? "Generating another angle…" : "Generate another angle"}
                            </Button>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Replaces this preview with a newly generated nearby viewpoint.
                            </p>
                          </div>
                          <div className="mt-4 rounded-md border bg-muted/20 p-3">
                            <label htmlFor={feedbackId} className="text-sm font-medium">
                              Feedback for this photo
                            </label>
                            <Textarea
                              id={feedbackId}
                              value={feedbackDraft}
                              maxLength={VIRTUAL_STAGING_FEEDBACK_MAX_LENGTH}
                              rows={3}
                              className="mt-2 resize-y bg-background"
                              placeholder="Example: Remove the added chairs and replace the bed linens."
                              disabled={retrying || confirming || finishing}
                              onChange={(event) => {
                                const value = event.target.value;
                                setFeedbackDrafts((current) => {
                                  const next = new Map(current);
                                  next.set(selectionKey, value);
                                  return next;
                                });
                              }}
                              aria-describedby={`${feedbackId}-help`}
                              data-testid={`textarea-staging-feedback-${candidate.id}`}
                            />
                            <div id={`${feedbackId}-help`} className="mt-1 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                              <span>
                                Changes only this preview at the same angle. Unspecified replacements stay close to the room's existing palette, materials, and regional style.
                              </span>
                              <span>{feedbackDraft.length}/{VIRTUAL_STAGING_FEEDBACK_MAX_LENGTH}</span>
                            </div>
                            {candidate.lastFeedback && (
                              <p className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                                Last submitted feedback: “{candidate.lastFeedback}”
                              </p>
                            )}
                            <Button
                              type="button"
                              size="sm"
                              className="mt-3"
                              disabled={!feedbackDraft.trim() || candidateActionInFlight || confirming || finishing}
                              onClick={() => void reviseCandidateWithFeedback(candidate)}
                              data-testid={`button-submit-staging-feedback-${candidate.id}`}
                            >
                              {retrying ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                              {retrying ? "Applying feedback…" : "Regenerate with feedback"}
                            </Button>
                          </div>
                        </>
                      ) : candidate.status === "failed" ? (
                        <div className="flex min-h-44 flex-col items-center justify-center rounded-md border border-dashed border-destructive/40 bg-destructive/5 p-5 text-center">
                          {candidate.previousStagedUrl && (
                            <div className="mb-4 w-full overflow-hidden rounded-md bg-muted/40">
                              <img
                                src={candidate.previousStagedUrl}
                                alt={`Previous virtually staged photo preserved for ${label}`}
                                className="h-auto max-h-[42vh] w-full object-contain"
                              />
                            </div>
                          )}
                          <p className="text-sm font-medium text-destructive">This photo could not be staged.</p>
                          {candidate.error && <p className="mt-1 text-xs text-muted-foreground">{candidate.error}</p>}
                          {candidate.previousStagedUrl && candidate.lastFeedback && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              The prior preview is preserved above. Retrying will keep the same feedback request.
                            </p>
                          )}
                          {candidate.previousStagedUrl && !candidate.lastFeedback && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              The prior preview is preserved above. You can restore it or retry the new angle.
                            </p>
                          )}
                          {candidate.lastFeedback && (
                            <p className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                              Feedback to retry: “{candidate.lastFeedback}”
                            </p>
                          )}
                          <div className="mt-3 flex flex-wrap justify-center gap-2">
                            {candidate.previousStagedUrl && (
                              <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                disabled={candidateActionInFlight || confirming || finishing}
                                onClick={() => void restorePreviousPreview(candidate)}
                                data-testid={`button-restore-previous-staging-${candidate.id}`}
                              >
                                {retrying ? <Loader2 className="animate-spin" /> : null}
                                {retrying ? "Restoring…" : "Restore previous preview for review"}
                              </Button>
                            )}
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={candidateActionInFlight || confirming || finishing}
                              onClick={() => void retryCandidate(candidate)}
                              data-testid={`button-retry-staging-${candidate.id}`}
                            >
                              {retrying ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                              {retrying ? "Retrying…" : "Retry this photo"}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex min-h-44 flex-col items-center justify-center rounded-md border border-dashed bg-muted/20 p-5 text-sm text-muted-foreground">
                          {candidate.previousStagedUrl && (
                            <>
                              <div className="mb-3 w-full overflow-hidden rounded-md bg-muted/40 opacity-80">
                                <img
                                  src={candidate.previousStagedUrl}
                                  alt={`Previous virtually staged photo retained while regenerating ${label}`}
                                  className="h-auto max-h-[42vh] w-full object-contain"
                                />
                              </div>
                              <p className="mb-3 text-xs">Previous preview retained until the replacement succeeds.</p>
                              {candidate.lastFeedback && (
                                <p className="mb-3 whitespace-pre-wrap break-words text-xs">
                                  Applying feedback: “{candidate.lastFeedback}”
                                </p>
                              )}
                            </>
                          )}
                          <div className="flex items-center gap-2">
                            <Loader2 className="animate-spin" />
                            {candidate.status === "generating" ? "Generating staged preview…" : "Waiting to generate…"}
                          </div>
                        </div>
                      )}
                    </figure>
                  </div>

                  <div className="border-t px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id={checkboxId}
                        checked={selected}
                        disabled={!selectable || confirming || finishing || candidateActionInFlight}
                        onCheckedChange={(checked) => toggleCandidate(candidate, checked === true)}
                        aria-describedby={`${checkboxId}-status`}
                        data-testid={`checkbox-use-staged-${candidate.id}`}
                      />
                      <label htmlFor={checkboxId} className={`text-sm font-medium ${selectable ? "cursor-pointer" : "text-muted-foreground"}`}>
                        Use staged photo for {label}
                      </label>
                    </div>
                    <p id={`${checkboxId}-status`} className="mt-1 pl-6 text-xs text-muted-foreground">
                      {selectable
                        ? "Unchecked by default. Select only if you approve this replacement."
                        : candidate.status === "failed"
                          ? "Failed generations remain original and cannot be selected."
                          : "Selection becomes available after generation succeeds."}
                    </p>
                  </div>
                </section>
              );
            })}
          </div>
        </div>

        <DialogFooter className="shrink-0 items-center gap-3 border-t bg-background px-6 py-4 sm:justify-between sm:space-x-0">
          <p
            id="virtual-staging-footer-status"
            role="status"
            aria-live="polite"
            className={`text-xs ${hasUnsubmittedFeedback ? "font-medium text-amber-700" : "text-muted-foreground"}`}
          >
            {hasUnsubmittedFeedback
              ? "Submit or clear typed photo feedback before finishing or confirming."
              : "Originals remain preserved. Only checked staged versions will become active."}
          </p>
          <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
            <Button type="button" variant="outline" disabled={confirming || finishing} onClick={() => safelyChangeOpen(false)}>
              Close for now
            </Button>
            {((job && (job.status === "ready" || job.status === "failed")) || (startError && !job)) && (
              <Button
                type="button"
                variant="secondary"
                aria-describedby="virtual-staging-footer-status"
                disabled={confirming || finishing || candidateActionInFlight || hasUnsubmittedFeedback}
                onClick={() => void finishWithoutSwaps()}
                data-testid="button-finish-virtual-staging-without-swaps"
              >
                {finishing && <Loader2 className="animate-spin" />}
                {finishing ? "Finishing review…" : "Finish without swaps"}
              </Button>
            )}
            <Button
              type="button"
              aria-describedby="virtual-staging-footer-status"
              disabled={selectedSuccessfulCandidates.length === 0
                || confirming
                || finishing
                || candidateActionInFlight
                || hasUnsubmittedFeedback
                || !job
                || job.status === "confirmed"}
              onClick={() => void confirmSelection()}
              data-testid="button-confirm-virtual-staging"
            >
              {confirming && <Loader2 className="animate-spin" />}
              {confirming
                ? "Saving selected photos…"
                : `Confirm & Swap ${selectedSuccessfulCandidates.length} ${selectedSuccessfulCandidates.length === 1 ? "Photo" : "Photos"}`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
