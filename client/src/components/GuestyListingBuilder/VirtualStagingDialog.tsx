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
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type {
  VirtualStagingCandidateDto,
  VirtualStagingJobDto,
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
  onOpenChange: (open: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  onConfirmed?: (result: VirtualStagingConfirmedResult) => void | Promise<void>;
  returnFocusElement?: HTMLElement | null;
  returnFocusFallbackElement?: HTMLElement | null;
};

const ACTIVE_JOB_STATUSES = new Set<VirtualStagingJob["status"]>(["queued", "running"]);
const POLL_INTERVAL_MS = 1_500;

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
  onOpenChange,
  onBusyChange,
  onConfirmed,
  returnFocusElement,
  returnFocusFallbackElement,
}: VirtualStagingDialogProps) {
  const { toast } = useToast();
  const [job, setJob] = useState<VirtualStagingJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<Set<string>>(new Set());
  const [retryingCandidateIds, setRetryingCandidateIds] = useState<Set<string>>(new Set());
  const [startAttempt, setStartAttempt] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const startRequestRef = useRef<{ key: string; promise: Promise<VirtualStagingJob> } | null>(null);
  const retryingRef = useRef<Set<string>>(new Set());
  const confirmingRef = useRef(false);

  // Opening a fresh dialog starts exactly one server job. Keeping the promise in
  // a ref also prevents React effect replays from issuing duplicate POSTs.
  useEffect(() => {
    if (!open || !unit.id || !Number.isFinite(propertyId)) return;

    let cancelled = false;
    const requestKey = `${propertyId}:${unit.id}:${startAttempt}`;
    setJob(null);
    setStarting(true);
    setStartError(null);
    setPollError(null);
    setConfirmError(null);
    setSelectedCandidateIds(new Set());

    let request = startRequestRef.current;
    if (!request || request.key !== requestKey) {
      request = {
        key: requestKey,
        promise: apiRequest("POST", "/api/virtual-staging/jobs", {
          propertyId,
          unitId: unit.id,
        }).then(readJob),
      };
      startRequestRef.current = request;
    }

    request.promise
      .then((nextJob) => {
        if (cancelled) return;
        setJob(nextJob);
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
  }, [open, propertyId, startAttempt, toast, unit.id, unit.label]);

  // Poll in the background even if the operator closes the modal. That keeps
  // the launch controls disabled until the live job actually reaches a terminal
  // state and prevents a second click from creating a duplicate job.
  useEffect(() => {
    if (!job || !ACTIVE_JOB_STATUSES.has(job.status)) return;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const response = await apiRequest("GET", `/api/virtual-staging/jobs/${encodeURIComponent(job.id)}`);
        const nextJob = await readJob(response);
        if (!cancelled) {
          setJob(nextJob);
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
  }, [job?.id, job?.status]);

  const successfulCandidates = useMemo(
    () => job?.candidates.filter(candidateIsSelectable) ?? [],
    [job?.candidates],
  );

  // A retry can move a formerly successful candidate back into a generating or
  // failed state. Never leave an ineligible candidate selected for confirmation.
  useEffect(() => {
    const selectableIds = new Set(successfulCandidates.map((candidate) => candidate.id));
    setSelectedCandidateIds((current) => {
      const next = new Set(Array.from(current).filter((id) => selectableIds.has(id)));
      const unchanged = next.size === current.size && Array.from(current).every((id) => next.has(id));
      return unchanged ? current : next;
    });
  }, [successfulCandidates]);

  const activeJob = !!job && ACTIVE_JOB_STATUSES.has(job.status);
  const busy = (open && !job && !startError) || starting || activeJob || confirming || retryingCandidateIds.size > 0;
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  const finishedCount = job
    ? job.candidates.filter((candidate) => candidate.status === "succeeded" || candidate.status === "failed").length
    : 0;
  const totalCount = job?.total ?? unit.photoCount;
  const progressPercent = totalCount > 0 ? Math.min(100, Math.round((finishedCount / totalCount) * 100)) : 0;
  const selectedSuccessfulIds = successfulCandidates
    .filter((candidate) => selectedCandidateIds.has(candidate.id))
    .map((candidate) => candidate.id);

  const toggleCandidate = useCallback((candidateId: string, checked: boolean) => {
    setSelectedCandidateIds((current) => {
      const next = new Set(current);
      if (checked) next.add(candidateId);
      else next.delete(candidateId);
      return next;
    });
  }, []);

  const retryCandidate = useCallback(async (candidateId: string) => {
    if (!job || retryingRef.current.has(candidateId)) return;
    retryingRef.current.add(candidateId);
    setRetryingCandidateIds(new Set(retryingRef.current));
    setPollError(null);
    setSelectedCandidateIds((current) => {
      const next = new Set(current);
      next.delete(candidateId);
      return next;
    });

    try {
      const response = await apiRequest(
        "POST",
        `/api/virtual-staging/jobs/${encodeURIComponent(job.id)}/candidates/${encodeURIComponent(candidateId)}/retry`,
      );
      setJob(await readJob(response));
    } catch (error: unknown) {
      const message = errorMessage(error);
      setPollError(message);
      toast({ title: "Couldn't retry this photo", description: message, variant: "destructive" });
    } finally {
      retryingRef.current.delete(candidateId);
      setRetryingCandidateIds(new Set(retryingRef.current));
    }
  }, [job, toast]);

  const confirmSelection = useCallback(async () => {
    if (!job || selectedSuccessfulIds.length === 0 || confirmingRef.current) return;
    confirmingRef.current = true;
    setConfirming(true);
    setConfirmError(null);

    try {
      const response = await apiRequest(
        "POST",
        `/api/virtual-staging/jobs/${encodeURIComponent(job.id)}/confirm`,
        { candidateIds: selectedSuccessfulIds },
      );
      const payload = await response.json() as { job?: unknown; swappedCount?: unknown };
      const confirmedJob = jobFromPayload(payload);
      const swappedCount = typeof payload.swappedCount === "number"
        ? payload.swappedCount
        : selectedSuccessfulIds.length;
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
  }, [job, onConfirmed, onOpenChange, selectedSuccessfulIds, toast, unit]);

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
            : `Preparing ${unit.photoCount} photos for review.`;

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

          {job && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 p-3">
              <div className="text-sm" aria-live="polite">
                <span className="font-medium">{selectedSuccessfulIds.length} of {totalCount}</span>{" "}
                staged photos selected
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={successfulCandidates.length === 0 || confirming}
                  onClick={() => setSelectedCandidateIds(new Set(successfulCandidates.map((candidate) => candidate.id)))}
                  data-testid="button-select-all-staged"
                >
                  Select all successful
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={selectedCandidateIds.size === 0 || confirming}
                  onClick={() => setSelectedCandidateIds(new Set())}
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
              const selected = selectable && selectedCandidateIds.has(candidate.id);
              const retrying = retryingCandidateIds.has(candidate.id);
              const label = candidate.roomLabel?.trim() || candidate.originalFilename || `Photo ${index + 1}`;
              const checkboxId = `use-staged-${candidate.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

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
                        </>
                      ) : candidate.status === "failed" ? (
                        <div className="flex min-h-44 flex-col items-center justify-center rounded-md border border-dashed border-destructive/40 bg-destructive/5 p-5 text-center">
                          <p className="text-sm font-medium text-destructive">This photo could not be staged.</p>
                          {candidate.error && <p className="mt-1 text-xs text-muted-foreground">{candidate.error}</p>}
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="mt-3"
                            disabled={retrying || confirming}
                            onClick={() => void retryCandidate(candidate.id)}
                            data-testid={`button-retry-staging-${candidate.id}`}
                          >
                            {retrying ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                            {retrying ? "Retrying…" : "Retry this photo"}
                          </Button>
                        </div>
                      ) : (
                        <div className="flex min-h-44 items-center justify-center gap-2 rounded-md border border-dashed bg-muted/20 p-5 text-sm text-muted-foreground">
                          <Loader2 className="animate-spin" />
                          {candidate.status === "generating" ? "Generating staged preview…" : "Waiting to generate…"}
                        </div>
                      )}
                    </figure>
                  </div>

                  <div className="border-t px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id={checkboxId}
                        checked={selected}
                        disabled={!selectable || confirming}
                        onCheckedChange={(checked) => toggleCandidate(candidate.id, checked === true)}
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
          <p className="text-xs text-muted-foreground">
            Originals remain preserved. Only checked staged versions will become active.
          </p>
          <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
            <Button type="button" variant="outline" disabled={confirming} onClick={() => safelyChangeOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={selectedSuccessfulIds.length === 0 || confirming || !job || job.status === "confirmed"}
              onClick={() => void confirmSelection()}
              data-testid="button-confirm-virtual-staging"
            >
              {confirming && <Loader2 className="animate-spin" />}
              {confirming
                ? "Saving selected photos…"
                : `Confirm & Swap ${selectedSuccessfulIds.length} ${selectedSuccessfulIds.length === 1 ? "Photo" : "Photos"}`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
