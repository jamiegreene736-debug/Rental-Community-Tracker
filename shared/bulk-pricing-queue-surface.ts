// Which bulk market-pricing job should the dashboard surface on load?
//
// The queue is a server-side background job: the operator can start a mass
// update from a phone, close Safari, and come back later. On return the
// dashboard must show (1) a still-running queue so they can watch it, or
// (2) the queue that FINISHED while they were away — so the terminal Guesty
// push-confirmation banner is actually seen — while (3) never re-surfacing a
// queue the operator already dismissed with "Clear queue". Pure so it's
// unit-testable; the client persists dismissed ids in localStorage.

export type SurfaceableBulkPricingJob = {
  id: string;
  status: string;
  finishedAt?: string | null;
};

// A finished queue is only worth re-surfacing while it's still "news" — after
// a day it's history (visible in the queue history list), not a notification.
export const BULK_PRICING_RESURFACE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function selectBulkPricingJobToSurface<T extends SurfaceableBulkPricingJob>(
  jobs: T[],
  dismissedIds: Iterable<string>,
  nowMs: number,
): T | null {
  const dismissed = new Set(dismissedIds);
  // A live queue always wins — even a previously dismissed id (dismissal of a
  // running queue force-cancels it server-side, so a live job with a dismissed
  // id means that cancel never landed and the operator should see it).
  const active = jobs.find((job) => job.status === "queued" || job.status === "running");
  if (active) return active;
  const terminal = jobs
    .filter((job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled")
    .filter((job) => !dismissed.has(job.id))
    .map((job) => {
      const finishedMs = job.finishedAt ? Date.parse(job.finishedAt) : NaN;
      return { job, finishedMs };
    })
    .filter(({ finishedMs }) => Number.isFinite(finishedMs) && nowMs - finishedMs <= BULK_PRICING_RESURFACE_WINDOW_MS && finishedMs <= nowMs + 60_000)
    .sort((a, b) => b.finishedMs - a.finishedMs);
  return terminal[0]?.job ?? null;
}
