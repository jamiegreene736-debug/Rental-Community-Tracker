// ─────────────────────────────────────────────────────────────────────────────
// Server-side BULK "Auto-fill cheapest" queue.
//
// WHY THIS EXISTS (see AGENTS.md Load-Bearing "Bulk buy-in queue is a SERVER-SIDE
// background job"): the bookings-page bulk queue used to be a CLIENT-DRIVEN
// `for` loop (bookings.tsx startBulkBuyInQueue) that, per reservation, detached
// units then `await`ed a server-side auto-fill job to terminal before starting
// the next. The PER-RESERVATION search was already server-side and resilient
// (server/auto-fill-job.ts), but the ORCHESTRATION — deciding which reservation
// runs next — lived in the browser tab. So when Safari suspended the tab
// overnight (screen sleep / Mac idle / tab backgrounded), the JS event loop
// froze mid-`await`, no further jobs were POSTed, and the queue silently stalled.
// The screen wake-lock only holds while the tab is visible, and the daemon's
// `caffeinate` guard only engages when the sidecar already has pending work — so
// nothing kept the queue alive. The operator left it running overnight and not a
// single reservation ran. The cancel button also did nothing, because it flipped
// a client ref the frozen loop never read.
//
// This module moves the WHOLE queue server-side as a fire-and-forget job (modeled
// on server/auto-fill-job.ts + server/city-vrbo-expansion.ts): the client posts
// the entire list ONCE, the server walks it sequentially — for each reservation
// it detaches the listed buy-ins then drives the EXISTING startAutoFillJob to
// terminal — and the client merely polls for per-item progress. Once started, the
// operator can close Safari entirely and the local sidecar daemon (kept awake by
// caffeinate, now continuously fed by the server) finishes every search. Cancel
// hits a real endpoint that stops the loop AND the in-flight auto-fill job.
//
// It reuses 100% of the per-reservation ladder (resort -> home-city -> nearby
// expansion -> single-unit fallback), the $100 profit gate, the all-or-nothing
// combo rule, and the loss-combo capture — startAutoFillJob is called in-process,
// not re-implemented.
// ─────────────────────────────────────────────────────────────────────────────

import { storage } from "./storage";
import {
  startAutoFillJob,
  getAutoFillJob,
  cancelAutoFillJob,
  serializeAutoFillJob,
  type AutoFillSlotInput,
} from "./auto-fill-job";

// How often the orchestrator re-reads a running auto-fill job's status. Matches
// the client AutoFillJobPoller cadence so progress feels live without hammering.
const POLL_INTERVAL_MS = 3_000;
// Hard ceiling per reservation (the auto-fill job's own expansion poll cap is
// ~40 min; allow headroom so a slow-but-progressing search isn't cut off, but
// don't let a wedged job pin the whole queue forever).
const ITEM_CAP_MS = 50 * 60_000;
// A finished bulk job is kept this long so a returning client (reload right after
// completion) can still render the final summary. In-memory; lost on redeploy —
// that's fine, every attached pick is already persisted to Postgres.
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

export class BulkAutoFillValidationError extends Error {
  constructor(message: string) { super(message); this.name = "BulkAutoFillValidationError"; }
}

// ── types ────────────────────────────────────────────────────────────────────
export type BulkItemStatus = "queued" | "running" | "completed" | "failed" | "skipped" | "cancelled";

// One reservation's fully self-contained payload. The CLIENT computes every field
// at queue-start (ground-floor scan + net revenue + the attached buy-in ids) and
// posts the whole list, because the server can't re-derive the Guesty-conversation
// ground-floor requirement or the client's getNetRevenue in-process. See the
// "client-derived inputs" finding in AGENTS.md.
export type BulkAutoFillItemInput = {
  reservationId: string;
  propertyId: number;
  listingId?: string | null;
  propertyName: string;
  community?: string | null;
  checkIn: string;
  checkOut: string;
  // ALL slots (not just empty) — the queue detaches every attached unit and
  // re-fills the full set, so the fill report is against the total unit count.
  slots: AutoFillSlotInput[];
  groundFloorBedrooms?: number[];
  expectedRevenue?: number;
  // Buy-in ids currently attached to this reservation, to detach for a fresh
  // search (the override behavior). Empty when the reservation has open slots.
  buyInIdsToDetach?: number[];
  // Display-only fields echoed back so a reopened browser can rebuild the dialog
  // on rediscovery without the original reservation objects.
  guestName?: string;
  queuedFor?: string;
};

type BulkItemState = {
  reservationId: string;
  propertyId: number;
  listingId: string | null;
  propertyName: string;
  guestName: string;
  checkIn: string;
  checkOut: string;
  queuedFor: string;
  status: BulkItemStatus;
  message: string;
  error?: string;
  filled: number;
  totalSlots: number;
  autoFillJobId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  // Over-budget combos found but not attached (would lose money) + the per-city
  // loss ledger, so the queue dialog can show + attach them. AutoFillComboOption[]
  // (isLoss) and CityEconomics[] (accepted !== true).
  lossCombos: any[];
  lossLog: any[];
  // Gate-passing ALTERNATIVE combos from the same pool (isAlternative) — the OTHER
  // distinct same-community combos VRBO's broad regional pool holds beyond the one
  // attached, so the operator gets more than the duplicate combo.
  altCombos: any[];
  // retained for processing, not serialized to the client
  _input: BulkAutoFillItemInput;
};

type BulkJobStatus = "running" | "completed" | "cancelled";

type BulkJob = {
  id: string;
  status: BulkJobStatus;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  canceled: boolean;
  currentIndex: number;
  items: BulkItemState[];
};

export type BulkAutoFillItemView = {
  reservationId: string;
  propertyId: number;
  listingId: string | null;
  propertyName: string;
  guestName: string;
  checkIn: string;
  checkOut: string;
  queuedFor: string;
  status: BulkItemStatus;
  message: string;
  error?: string;
  filled: number;
  totalSlots: number;
  startedAt: string | null;
  finishedAt: string | null;
  lossCombos: any[];
  lossLog: any[];
  altCombos: any[];
};

export type BulkAutoFillJobStatus = {
  bulkJobId: string;
  status: BulkJobStatus;
  done: boolean;
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  cancelled: number;
  running: number;
  queued: number;
  currentIndex: number;
  items: BulkAutoFillItemView[];
  timestamps: { createdAt: number; startedAt: number | null; finishedAt: number | null };
};

// ── state ────────────────────────────────────────────────────────────────────
const bulkJobs = new Map<string, BulkJob>();
// Only ONE bulk queue runs at a time (the operator runs one queue). This points
// at the most-recent bulk job — running OR recently finished — so the client's
// /active rediscovery can rebuild the dialog (incl. the final summary on a
// reload right after completion). A double-clicked Start reuses a still-running
// job instead of spawning a second.
let latestBulkJobId: string | null = null;
let jobSeq = 0;

function newId(): string {
  jobSeq += 1;
  return `bulk-${Date.now().toString(36)}-${jobSeq}`;
}

function isTerminalBulk(status: BulkJobStatus): boolean {
  return status === "completed" || status === "cancelled";
}

function touch(job: BulkJob): void { job.updatedAt = Date.now(); }

function cleanupStale(): void {
  const now = Date.now();
  for (const [id, job] of Array.from(bulkJobs.entries())) {
    const age = now - (job.finishedAt ?? job.updatedAt);
    if (isTerminalBulk(job.status) && age > JOB_TTL_MS) {
      bulkJobs.delete(id);
      if (latestBulkJobId === id) latestBulkJobId = null;
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Is the local Chrome sidecar reachable? getHeartbeat().isOnline is the same
// signal the expansion ladder trusts (worker polled within the ~90s window).
// Dynamic import avoids a load-time cycle (vrbo-sidecar-queue ↔ auto-fill paths).
async function sidecarIsOnline(): Promise<boolean> {
  try {
    const { getHeartbeat } = await import("./vrbo-sidecar-queue");
    return getHeartbeat().isOnline;
  } catch { return true; } // unknowable → assume online, let the ladder decide
}

// ── orchestration ──────────────────────────────────────────────────────────
async function runBulkJob(job: BulkJob): Promise<void> {
  job.status = "running";
  job.startedAt = Date.now();
  touch(job);

  for (let i = 0; i < job.items.length; i += 1) {
    job.currentIndex = i;
    const item = job.items[i];

    if (job.canceled) {
      item.status = "cancelled";
      item.message = "Cancelled by operator";
      item.finishedAt = Date.now();
      touch(job);
      continue;
    }

    // ── Circuit breaker (M5): if the sidecar worker is offline (Mac asleep /
    // daemon stopped), don't grind every remaining reservation through the
    // ladder's ~40-min expansion timeouts attaching nothing. Stop cleanly with a
    // clear reason. A momentary gap is tolerated by a single 10s re-check (the
    // worker idle-polls between items, so offline here is genuine). caffeinate
    // (kept alive by the bulk-active /status signal) is what PREVENTS this.
    if (!(await sidecarIsOnline())) {
      await sleep(10_000);
      if (!(await sidecarIsOnline())) {
        for (let k = i; k < job.items.length; k += 1) {
          const it = job.items[k];
          if (it.status === "queued" || it.status === "running") {
            it.status = "failed";
            it.message = "Sidecar offline (Mac asleep or daemon stopped) — restart the queue once it's back online";
            it.error = it.message;
            it.finishedAt = Date.now();
          }
        }
        touch(job);
        console.error("[bulk-auto-fill] sidecar offline — stopping queue with", job.items.length - i, "item(s) unrun");
        break;
      }
    }

    item.status = "running";
    item.startedAt = Date.now();
    item.message = "Running buy-in search";
    touch(job);

    try {
      // ── Override: detach every currently-attached buy-in so the reservation is
      // searched FRESH from scratch (operator: a queued reservation with units
      // already attached is OVERRIDDEN, not topped-up). storage.detachBuyIn just
      // nulls guestyReservationId/attachedAt — no side effects — so a direct call
      // is safe and complete (the HTTP route does exactly this).
      //
      // ATOMIC (B2): detach is reversible until the search starts. We track what
      // we detached; if ANY detach throws, we RE-ATTACH the already-detached units
      // so the reservation ends EXACTLY as it began — never stranded partially
      // detached on the money path — then fail the item.
      const toDetach = (item._input.buyInIdsToDetach ?? []).map(Number).filter((n) => Number.isFinite(n));
      if (toDetach.length > 0) {
        item.message = `Detaching ${toDetach.length} attached unit${toDetach.length === 1 ? "" : "s"} for a fresh search…`;
        touch(job);
        const detached: number[] = [];
        try {
          for (const buyInId of toDetach) {
            await storage.detachBuyIn(buyInId);
            detached.push(buyInId);
          }
        } catch (e: any) {
          for (const id of detached) {
            try { await storage.attachBuyIn(id, item._input.reservationId); }
            catch (re: any) { console.error("[bulk-auto-fill] detach rollback re-attach failed", id, re?.message ?? re); }
          }
          throw new Error(`Could not detach existing units for a fresh search (rolled back, reservation unchanged): ${e?.message ?? e}`);
        }
      }

      if (job.canceled) {
        item.status = "cancelled";
        item.message = "Cancelled by operator";
        item.finishedAt = Date.now();
        touch(job);
        continue;
      }

      // ── Run the EXISTING server-side auto-fill (full ladder + profit gate +
      // expansion + loss-combo capture). forceRestart supersedes any in-flight
      // job for this reservation (e.g. a manual "Auto-fill cheapest") so the
      // just-detached fresh search isn't dropped onto a stale reused job. The
      // auto-fill job runs the nearby-city expansion ITSELF, so we just poll to
      // terminal — no separate expansion orchestration here.
      const { jobId } = startAutoFillJob({
        reservationId: item._input.reservationId,
        propertyId: item._input.propertyId,
        listingId: item._input.listingId ?? null,
        propertyName: item._input.propertyName,
        community: item._input.community ?? null,
        checkIn: item._input.checkIn,
        checkOut: item._input.checkOut,
        slots: item._input.slots,
        groundFloorBedrooms: item._input.groundFloorBedrooms ?? [],
        expectedRevenue: item._input.expectedRevenue,
        silent: true,
        forceRestart: true,
        // owner=bulk so the row-level /active rediscovery skips this reservation
        // and never re-attaches a competing poller / forceRestart (B1).
        owner: "bulk",
      });
      item.autoFillJobId = jobId;
      touch(job);

      const itemStartedAt = Date.now();
      let last = null as ReturnType<typeof serializeAutoFillJob> | null;
      while (!job.canceled) {
        const af = getAutoFillJob(jobId);
        if (!af) {
          // Only reachable if the auto-fill job vanished mid-poll — i.e. a TTL
          // eviction (impossible this fast) or a superseding restart. Treat as a
          // lost search; in practice a Railway redeploy kills THIS bulk job too.
          throw new Error("Auto-fill job was lost (server restart)");
        }
        last = serializeAutoFillJob(af);
        item.filled = last.slotsFilled;
        item.totalSlots = last.slotsTotal;
        // Surface the auto-fill job's LIVE phase message (e.g. "Searching the home
        // city on VRBO…", "Widening to nearby cities…") so the dialog reflects real
        // progress instead of freezing on the pre-search "Detaching…" notice.
        if (last.message) item.message = last.message;
        touch(job);
        if (last.done) break;
        if (Date.now() - itemStartedAt > ITEM_CAP_MS) break;
        await sleep(POLL_INTERVAL_MS);
      }

      if (job.canceled) {
        // Stop the in-flight auto-fill (best-effort: no in-flight HTTP abort, but
        // it stops attaching new units) and mark this item cancelled. Surface any
        // partial fill HONESTLY (B3) — a reservation may have attached some slots
        // before the cancel landed; the operator must see that, not a clean
        // "cancelled" that hides a half-filled booking.
        if (item.autoFillJobId) cancelAutoFillJob(item.autoFillJobId);
        item.status = "cancelled";
        item.message = item.filled > 0
          ? `Cancelled — attached ${item.filled}/${item.totalSlots} before stopping (review this booking)`
          : "Cancelled by operator";
        item.finishedAt = Date.now();
        touch(job);
        continue;
      }

      const filled = last?.slotsFilled ?? 0;
      const total = last?.slotsTotal ?? item.totalSlots;
      item.filled = filled;
      item.totalSlots = total;
      // Carry the over-budget combos + per-city loss ledger onto the item so the
      // queue dialog can show "found in city X / Y but would lose money" + a
      // one-click attach, without a second fetch. (Also persisted durably via the
      // auto-fill job's finalize → auto_fill_loss_options.)
      item.lossCombos = (last?.comboOptions ?? []).filter((c: any) => c?.isLoss);
      item.lossLog = (last?.cityEconomics ?? []).filter((c: any) => c?.accepted !== true);
      // The OTHER distinct same-community combos found in the same pool (beyond the
      // one attached) — surfaced in the queue dialog with a one-click attach.
      item.altCombos = (last?.comboOptions ?? []).filter((c: any) => !c?.isLoss && c?.isAlternative);
      if (filled === 0) {
        // Surface the REAL reason so "checking the failed-scan logs" distinguishes a
        // genuine outcome from a bug. The old code always showed a generic "No
        // verified priced candidate was attached", which hid WHY — even when the
        // auto-fill job had a precise terminal message (profit-gated loss combos,
        // an empty scrape, a thrown error). Three cases:
        //   • job still running at the item cap → it timed out (not a no-inventory)
        //   • job ended "failed" (threw)        → the exception / per-slot skips
        //   • job ended "completed" but 0 filled → the auto-fill doneMessage, which
        //     already explains it ("No profitable combination found … Best option …"
        //     with per-city economics, or "No verified priced candidate could be
        //     attached. Home city returned N listings …" so a 0-listing SCRAPE
        //     problem reads differently from a matched-but-unprofitable result).
        const skipReasons = (last?.skipped ?? []).map((s) => s.reason).filter(Boolean);
        let reason: string;
        if (last && !last.done) {
          reason = `Search timed out after ${Math.round(ITEM_CAP_MS / 60_000)} min before completing — re-run to retry`;
        } else if (last?.status === "failed") {
          reason = last.error || skipReasons[0] || "Auto-fill failed";
        } else {
          reason = last?.message || skipReasons[0] || last?.error || "No verified priced candidate was attached";
        }
        item.status = "failed";
        item.message = reason;
        // The red error box carries the per-slot skip breakdown (extra detail beyond
        // the headline); leave it empty when there are no skips so the message isn't
        // duplicated verbatim into the box.
        item.error = skipReasons.length ? skipReasons.join(" | ") : undefined;
      } else {
        item.status = filled === total ? "completed" : "skipped";
        item.message = filled === total
          ? `Attached ${filled}/${total} buy-in${total === 1 ? "" : "s"}`
          : `Attached ${filled}/${total}; review remaining slots`;
      }
      item.finishedAt = Date.now();
      touch(job);
    } catch (err: any) {
      const raw = String(err?.message ?? err ?? "Unknown bulk buy-in error");
      item.status = "failed";
      item.message = raw;
      item.error = raw;
      item.finishedAt = Date.now();
      touch(job);
      console.error("[bulk-auto-fill] item failed", item.reservationId, raw);
    }
  }

  job.status = job.canceled ? "cancelled" : "completed";
  job.finishedAt = Date.now();
  job.currentIndex = job.items.length;
  touch(job);
  console.log(`[bulk-auto-fill] job ${job.id} ${job.status} — ${job.items.length} item(s)`);
}

// ── public API ──────────────────────────────────────────────────────────────
export function startBulkAutoFillJob(items: BulkAutoFillItemInput[]): { bulkJobId: string; reused: boolean } {
  cleanupStale();
  if (!Array.isArray(items) || items.length === 0) {
    throw new BulkAutoFillValidationError("items required (at least one reservation)");
  }

  // Idempotency: a still-running bulk job (double-clicked Start, or a duplicate
  // POST) is REUSED rather than spawning a second concurrent queue.
  if (latestBulkJobId) {
    const existing = bulkJobs.get(latestBulkJobId);
    if (existing && existing.status === "running") {
      return { bulkJobId: existing.id, reused: true };
    }
  }

  const id = newId();
  const now = Date.now();
  const itemStates: BulkItemState[] = items.map((input) => {
    const slots = Array.isArray(input.slots) ? input.slots : [];
    return {
      reservationId: String(input.reservationId),
      propertyId: Number(input.propertyId),
      listingId: input.listingId ?? null,
      propertyName: input.propertyName || `Property ${input.propertyId}`,
      guestName: input.guestName || "Guest",
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      queuedFor: input.queuedFor || "",
      status: "queued",
      message: "Queued",
      filled: 0,
      totalSlots: slots.length,
      autoFillJobId: null,
      startedAt: null,
      finishedAt: null,
      lossCombos: [],
      lossLog: [],
      altCombos: [],
      _input: { ...input, slots },
    };
  });

  const job: BulkJob = {
    id,
    status: "running",
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    canceled: false,
    currentIndex: 0,
    items: itemStates,
  };
  bulkJobs.set(id, job);
  latestBulkJobId = id;

  // Clicking Start is explicit intent to run — make sure the sidecar queue isn't
  // left PAUSED (a prior "Clear Queue" pause makes the queue REFUSE every enqueue,
  // so every search would silently fail). Fire-and-forget resume.
  void import("./vrbo-sidecar-queue")
    .then((m) => { try { m.resumeQueue(); } catch { /* best effort */ } })
    .catch(() => { /* best effort */ });

  void runBulkJob(job).catch((err) => {
    job.status = "completed";
    job.finishedAt = Date.now();
    console.error("[bulk-auto-fill] orchestrator crashed", err);
  });

  return { bulkJobId: id, reused: false };
}

export function getBulkAutoFillJob(jobId: string): BulkJob | null {
  cleanupStale();
  return bulkJobs.get(jobId) ?? null;
}

// The latest bulk job (running OR recently finished) so the client can rediscover
// + rebuild the queue dialog after a reload / reopened browser.
export function getLatestBulkAutoFillJob(): BulkJob | null {
  cleanupStale();
  return latestBulkJobId ? bulkJobs.get(latestBulkJobId) ?? null : null;
}

export function cancelBulkAutoFillJob(jobId: string): boolean {
  const job = bulkJobs.get(jobId);
  if (!job) return false;
  job.canceled = true;
  touch(job);
  // Stop the currently-running reservation's auto-fill job immediately; the loop
  // will mark every still-queued item cancelled on its next iteration.
  const current = job.items[job.currentIndex];
  if (current?.autoFillJobId) cancelAutoFillJob(current.autoFillJobId);
  return true;
}

export function serializeBulkAutoFillJob(job: BulkJob): BulkAutoFillJobStatus {
  const by = (s: BulkItemStatus) => job.items.filter((it) => it.status === s).length;
  return {
    bulkJobId: job.id,
    status: job.status,
    done: isTerminalBulk(job.status),
    total: job.items.length,
    completed: by("completed"),
    failed: by("failed"),
    skipped: by("skipped"),
    cancelled: by("cancelled"),
    running: by("running"),
    queued: by("queued"),
    currentIndex: job.currentIndex,
    items: job.items.map((it) => ({
      reservationId: it.reservationId,
      propertyId: it.propertyId,
      listingId: it.listingId,
      propertyName: it.propertyName,
      guestName: it.guestName,
      checkIn: it.checkIn,
      checkOut: it.checkOut,
      queuedFor: it.queuedFor,
      status: it.status,
      message: it.message,
      error: it.error,
      filled: it.filled,
      totalSlots: it.totalSlots,
      startedAt: it.startedAt ? new Date(it.startedAt).toISOString() : null,
      finishedAt: it.finishedAt ? new Date(it.finishedAt).toISOString() : null,
      lossCombos: it.lossCombos ?? [],
      lossLog: it.lossLog ?? [],
      altCombos: it.altCombos ?? [],
    })),
    timestamps: { createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt },
  };
}
