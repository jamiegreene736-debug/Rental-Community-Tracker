// Buy-in checkout job — the step AFTER a unit is attached to a reservation:
// actually BOOK that VRBO unit on vrbo.com, fully automated UP TO payment, then
// hand the operator the (yellow-bordered) Chrome window to enter card details
// and click "Book now" themselves.
//
// Fire-and-forget background job modeled on server/auto-fill-job.ts. One job per
// buy-in (single-flight). The heavy lifting runs in the local sidecar via the
// `vrbo_book` op (daemon processVrboBook); this module orchestrates: read the
// attached buy-in, mint a UNIQUE per-unit email alias, drive the sidecar, and
// persist the booking lifecycle onto the buy_ins row. Payment itself is 100%
// operator-entered — the worker never touches a card/CVV/billing field.
//
// Surfaced live to the bookings page via the same poller pattern as auto-fill.
// See memory buy-in-checkout-automation-plan + AGENTS.md (VRBO sight+click).

import { storage } from "./storage";
import { bookVrboUnitViaSidecar, getHeartbeat } from "./vrbo-sidecar-queue";
import { createSimpleLoginAlias, extractSimpleLoginAliasEmail } from "./simplelogin";
import { BUY_IN_CHECKOUT_PHONE } from "@shared/buy-in-checkout-profile";
import {
  BuyInCheckoutClaimError,
  claimBuyInCheckout,
  clearBuyInCheckoutClaim,
  completeBuyInCheckoutClaim,
  failBuyInCheckoutClaim,
} from "./buy-in-checkout-claims";

// Operator's fixed VRBO traveler phone for every buy-in (808 460 6509).
export const BUYIN_BOOKING_PHONE = BUY_IN_CHECKOUT_PHONE;

// Per-GUEST booking email domain (operator, 2026-06-10). Each guest gets the
// deterministic address firstname.lastname@emailprivaccy.com — a SimpleLogin
// custom-domain alias that is NEVER deleted and whose received mail is stored in
// that guest's portal inbox. Same guest (any unit / any booking) reuses the same
// address + inbox. Spelled exactly as the operator gave it (double-c).
export const BUYIN_TRAVELER_EMAIL_DOMAIN = process.env.BUYIN_TRAVELER_EMAIL_DOMAIN || "emailprivaccy.com";

function sanitizeNamePart(s: string | null | undefined): string {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

// firstname.lastname (operator scheme). Falls back gracefully for single-name
// guests. The "." separator matches the operator's example jamie.greene.
// Multi-unit reservations append the unit index to the last name (marquez2) so
// each VRBO buy-in gets a distinct SimpleLogin alias.
export function guestEmailLocalPart(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  unitIndex = 1,
): string {
  const f = sanitizeNamePart(firstName);
  let l = sanitizeNamePart(lastName);
  if (unitIndex > 1 && l) l = `${l}${unitIndex}`;
  return [f, l].filter(Boolean).join(".") || "guest";
}

async function unitEmailIndexForBuyIn(buyInId: number, reservationId: string | null | undefined): Promise<number> {
  const rid = String(reservationId ?? "").trim();
  if (!rid) return 1;
  const siblings = await storage.getBuyInsByReservation(rid);
  if (siblings.length <= 1) return 1;
  const sorted = [...siblings].sort((a, b) => {
    const la = String(a.unitLabel ?? a.unitId ?? "");
    const lb = String(b.unitLabel ?? b.unitId ?? "");
    return la.localeCompare(lb, undefined, { numeric: true }) || a.id - b.id;
  });
  const idx = sorted.findIndex((row) => row.id === buyInId);
  return idx >= 0 ? idx + 1 : 1;
}

export type EnsureTravelerEmailInput = {
  buyInId: number;
  reservationId?: string | null;
  guestFirstName?: string | null;
  guestLastName?: string | null;
};

/** Mint or reuse the per-guest VRBO booking email (SimpleLogin alias). */
export async function ensureTravelerEmailForBuyIn(input: EnsureTravelerEmailInput): Promise<string> {
  const buyInId = Number(input.buyInId);
  if (!Number.isFinite(buyInId) || buyInId <= 0) {
    throw new CheckoutValidationError("buyInId required");
  }
  const buyIn = await storage.getBuyIn(buyInId);
  if (!buyIn) throw new CheckoutValidationError(`Buy-in ${buyInId} not found`);

  const existing = String(buyIn.travelerEmail ?? "").trim().toLowerCase();
  if (existing) return existing;

  const firstName = String(input.guestFirstName ?? "").trim();
  const lastName = String(input.guestLastName ?? "").trim();
  if (!firstName || !lastName) {
    throw new CheckoutValidationError("Guest first and last name are required for the booking email");
  }

  const unitIndex = await unitEmailIndexForBuyIn(buyInId, input.reservationId);
  const localPart = guestEmailLocalPart(firstName, lastName, unitIndex);
  let email = `${localPart}@${BUYIN_TRAVELER_EMAIL_DOMAIN}`;
  try {
    const alias = await createSimpleLoginAlias({
      prefix: localPart,
      domain: BUYIN_TRAVELER_EMAIL_DOMAIN,
      guestName: `${firstName} ${lastName}`.trim(),
      note: `Buy-in guest inbox · ${firstName} ${lastName}${input.reservationId ? ` · reservation ${input.reservationId}` : ""}`,
    });
    email = extractSimpleLoginAliasEmail(alias) || email;
  } catch (e: any) {
    const msg = String(e?.message ?? e).toLowerCase();
    if (!/already|in use|exist|duplicate|taken/.test(msg)) {
      throw new Error(`Could not create the guest booking email (${email}): ${String(e?.message ?? e)}`);
    }
  }

  await storage.updateBuyIn(buyInId, { travelerEmail: email });
  return email;
}

type CheckoutStatus = "queued" | "running" | "awaiting_payment" | "completed" | "failed";
const TERMINAL = new Set<CheckoutStatus>(["completed", "failed"]);
const isTerminal = (s: CheckoutStatus) => TERMINAL.has(s);

const JOB_TTL_MS = 2 * 60 * 60_000;

export type StartCheckoutInput = {
  buyInId: number;
  reservationId: string;
  guestFirstName?: string | null;
  guestLastName?: string | null;
};

type CheckoutJob = {
  id: string;
  status: CheckoutStatus;
  phase: string;
  message: string;
  buyInId: number;
  reservationId: string;
  unitLabel: string;
  listingUrl: string | null;
  checkIn: string | null;
  checkOut: string | null;
  guestFirstName: string;
  guestLastName: string;
  travelerEmail: string | null;
  confirmationNumber: string | null;
  error: string | null;
  canceled: boolean;
  controller: AbortController;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

export type CheckoutJobStatus = {
  jobId: string;
  status: CheckoutStatus;
  done: boolean;
  phase: string;
  message: string;
  buyInId: number;
  reservationId: string;
  unitLabel: string;
  travelerEmail: string | null;
  confirmationNumber: string | null;
  error: string | null;
  timestamps: { createdAt: number; startedAt: number | null; finishedAt: number | null };
};

export class CheckoutValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutValidationError";
  }
}

// ── stores ───────────────────────────────────────────────────────────────────
const jobs = new Map<string, CheckoutJob>();
// buyInId -> live jobId (single-flight: one checkout per unit at a time).
const activeJobByBuyIn = new Map<number, string>();
// buyInId -> most-recent jobId (kept after finalize so a returning client can
// re-show the last attempt). reservationId -> set of recent jobIds (for the
// row-level /active rediscovery, which queries by reservation).
const lastJobByBuyIn = new Map<number, string>();

function cleanupStaleJobs(): void {
  const now = Date.now();
  for (const [id, job] of Array.from(jobs.entries())) {
    const ref = job.finishedAt ?? job.updatedAt;
    if (now - ref > JOB_TTL_MS) {
      jobs.delete(id);
      if (activeJobByBuyIn.get(job.buyInId) === id) activeJobByBuyIn.delete(job.buyInId);
    }
  }
}
setInterval(cleanupStaleJobs, 30 * 60_000).unref?.();

function newJobId(): string {
  return `bic_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function touch(job: CheckoutJob, patch: Partial<CheckoutJob> = {}): void {
  Object.assign(job, patch);
  job.updatedAt = Date.now();
}

function setStatus(job: CheckoutJob, status: CheckoutStatus, message: string): void {
  job.status = status;
  job.message = message;
  if (status === "running" && job.startedAt === null) job.startedAt = Date.now();
  job.updatedAt = Date.now();
}

function finalize(job: CheckoutJob): void {
  job.finishedAt = Date.now();
  job.updatedAt = job.finishedAt;
  if (activeJobByBuyIn.get(job.buyInId) === job.id) activeJobByBuyIn.delete(job.buyInId);
}

export function serializeCheckoutJob(job: CheckoutJob): CheckoutJobStatus {
  return {
    jobId: job.id,
    status: job.status,
    done: isTerminal(job.status),
    phase: job.phase,
    message: job.message,
    buyInId: job.buyInId,
    reservationId: job.reservationId,
    unitLabel: job.unitLabel,
    travelerEmail: job.travelerEmail,
    confirmationNumber: job.confirmationNumber,
    error: job.error,
    timestamps: { createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt },
  };
}

// Bedroom count for the listing — parsed from the buy-in notes (same convention
// as the attach route), best-effort. Only used as a soft hint to the worker.
function bedroomsFromBuyIn(notes: string | null | undefined): number | undefined {
  const m = String(notes ?? "").match(/(?:^|[^\d])(\d+)\s*BR\b/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ── job runner ────────────────────────────────────────────────────────────────
async function runCheckoutJob(job: CheckoutJob): Promise<void> {
  const claimToken = `sidecar_${job.id}`;
  let claimActive = false;
  try {
    const buyIn = await storage.getBuyIn(job.buyInId);
    if (!buyIn) throw new CheckoutValidationError(`Buy-in ${job.buyInId} not found`);

    // Idempotency guard: a unit already booked is never re-driven through
    // checkout (no double-purchase).
    if (buyIn.bookingStatus === "booked") {
      job.confirmationNumber = buyIn.bookingConfirmation ?? null;
      setStatus(job, "completed", buyIn.bookingConfirmation ? `Already booked (confirmation ${buyIn.bookingConfirmation})` : "Already booked");
      return;
    }

    const listingUrl = buyIn.airbnbListingUrl;
    if (!listingUrl) throw new CheckoutValidationError("This buy-in has no VRBO listing URL to book");
    if (!buyIn.checkIn || !buyIn.checkOut) throw new CheckoutValidationError("This buy-in is missing check-in/check-out dates");
    touch(job, { listingUrl, checkIn: buyIn.checkIn, checkOut: buyIn.checkOut, unitLabel: buyIn.unitLabel || job.unitLabel });

    const firstName = job.guestFirstName.trim();
    const lastName = job.guestLastName.trim();
    if (!firstName || !lastName) {
      throw new CheckoutValidationError("Guest first and last name are required for the VRBO traveler details");
    }

    // Sidecar must be online before we commit to a long human-paced op.
    if (!getHeartbeat().isOnline) {
      throw new CheckoutValidationError("The local VRBO sidecar is offline — start it before booking a unit in");
    }

    await claimBuyInCheckout({
      reservationId: job.reservationId,
      buyInId: job.buyInId,
      claimToken,
      owner: "sidecar",
    });
    claimActive = true;
    setStatus(job, "running", "Creating a unique booking email for this unit…");

    const email = await ensureTravelerEmailForBuyIn({
      buyInId: job.buyInId,
      reservationId: job.reservationId,
      guestFirstName: firstName,
      guestLastName: lastName,
    });
    job.travelerEmail = email;

    setStatus(job, "running", "Opening VRBO and filling traveler details…");

    const { result, workerOnline, reason } = await bookVrboUnitViaSidecar({
      params: {
        buyInId: job.buyInId,
        listingUrl,
        checkIn: buyIn.checkIn,
        checkOut: buyIn.checkOut,
        firstName,
        lastName,
        email,
        phone: BUYIN_BOOKING_PHONE,
        bedrooms: bedroomsFromBuyIn(buyIn.notes),
      },
      signal: job.controller.signal,
      onStage: (stage) => {
        if (job.canceled || isTerminal(job.status)) return;
        if (stage && /awaiting payment/i.test(stage)) {
          if (job.status !== "awaiting_payment") {
            setStatus(
              job,
              "awaiting_payment",
              "Ready for payment — enter your card details in the Chrome window that just popped up (yellow border), then click “Book now”.",
            );
            void completeBuyInCheckoutClaim({
              reservationId: job.reservationId,
              buyInId: job.buyInId,
              claimToken,
              owner: "sidecar",
            })
              .then(() => { claimActive = false; })
              .catch((error) => console.error("[buy-in-checkout] failed to complete checkout claim", error));
          }
        } else if (stage) {
          touch(job, { phase: stage });
        }
      },
    });

    if (job.canceled) {
      setStatus(job, "failed", "Checkout canceled");
      job.error = "Canceled by operator";
      if (claimActive) {
        await failBuyInCheckoutClaim({
          reservationId: job.reservationId,
          buyInId: job.buyInId,
          claimToken,
          owner: "sidecar",
        }, "Canceled by operator").catch(() => {});
        claimActive = false;
      }
      await storage.updateBuyIn(job.buyInId, { bookingStatus: "failed", bookingError: "Canceled by operator" }).catch(() => {});
      return;
    }

    if (result?.confirmed) {
      if (claimActive) {
        await clearBuyInCheckoutClaim({
          reservationId: job.reservationId,
          buyInId: job.buyInId,
          claimToken,
          owner: "sidecar",
        }).catch(() => {});
        claimActive = false;
      }
      job.confirmationNumber = result.confirmationNumber ?? null;
      setStatus(job, "completed", result.confirmationNumber ? `Booked ✓ — confirmation ${result.confirmationNumber}` : "Booked ✓");
      await storage.updateBuyIn(job.buyInId, {
        bookingStatus: "booked",
        bookingConfirmation: result.confirmationNumber ?? null,
        bookedAt: new Date(),
        bookingError: null,
      });
      return;
    }

    // Not confirmed: distinguish sidecar/transport failure, payment-not-completed
    // timeout, and a generic stop so the operator knows what happened.
    const msg = !workerOnline
      ? `Sidecar went offline or timed out before the booking completed (${reason}).`
      : result?.stage === "awaiting_payment_timeout"
        ? "Payment wasn't completed in time — this unit was NOT booked. Click “Buy this unit in” again to retry."
        : `Checkout did not complete: ${reason}`;
    setStatus(job, "failed", msg);
    job.error = msg;
    if (claimActive) {
      await failBuyInCheckoutClaim({
        reservationId: job.reservationId,
        buyInId: job.buyInId,
        claimToken,
        owner: "sidecar",
      }, msg).catch(() => {});
      claimActive = false;
    }
    await storage.updateBuyIn(job.buyInId, { bookingStatus: "failed", bookingError: msg.slice(0, 500) }).catch(() => {});
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    setStatus(job, "failed", msg);
    job.error = msg;
    if (claimActive) {
      await failBuyInCheckoutClaim({
        reservationId: job.reservationId,
        buyInId: job.buyInId,
        claimToken,
        owner: "sidecar",
      }, msg).catch(() => {});
      claimActive = false;
    } else if (!(e instanceof BuyInCheckoutClaimError && e.status === 409)) {
      await storage.updateBuyIn(job.buyInId, { bookingStatus: "failed", bookingError: msg.slice(0, 500) }).catch(() => {});
    }
  } finally {
    finalize(job);
  }
}

// ── public API ─────────────────────────────────────────────────────────────────
export function startBuyInCheckoutJob(input: StartCheckoutInput): { jobId: string; status: CheckoutStatus; reused: boolean } {
  cleanupStaleJobs();
  const buyInId = Number(input.buyInId);
  if (!Number.isFinite(buyInId) || buyInId <= 0) throw new CheckoutValidationError("buyInId required");
  const reservationId = String(input.reservationId ?? "").trim();
  if (!reservationId) throw new CheckoutValidationError("reservationId required");

  // Single-flight: one live checkout per unit.
  const existingId = activeJobByBuyIn.get(buyInId);
  if (existingId) {
    const existing = jobs.get(existingId);
    if (existing && !isTerminal(existing.status)) {
      return { jobId: existing.id, status: existing.status, reused: true };
    }
    activeJobByBuyIn.delete(buyInId);
  }

  const now = Date.now();
  const job: CheckoutJob = {
    id: newJobId(),
    status: "queued",
    phase: "queued",
    message: "Queued",
    buyInId,
    reservationId,
    unitLabel: "Unit",
    listingUrl: null,
    checkIn: null,
    checkOut: null,
    guestFirstName: String(input.guestFirstName ?? "").trim(),
    guestLastName: String(input.guestLastName ?? "").trim(),
    travelerEmail: null,
    confirmationNumber: null,
    error: null,
    canceled: false,
    controller: new AbortController(),
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
  };
  jobs.set(job.id, job);
  activeJobByBuyIn.set(buyInId, job.id);
  lastJobByBuyIn.set(buyInId, job.id);
  void runCheckoutJob(job).catch((err) => {
    job.status = "failed";
    job.error = String(err?.message ?? err);
    finalize(job);
  });
  return { jobId: job.id, status: job.status, reused: false };
}

export function getBuyInCheckoutJob(jobId: string): CheckoutJob | null {
  cleanupStaleJobs();
  return jobs.get(jobId) ?? null;
}

// Live-or-most-recent checkout job for a unit (so a returning client can resume
// polling without remembering the jobId).
export function getCheckoutJobForBuyIn(buyInId: number): CheckoutJob | null {
  cleanupStaleJobs();
  const liveId = activeJobByBuyIn.get(buyInId);
  if (liveId) {
    const live = jobs.get(liveId);
    if (live) return live;
  }
  const lastId = lastJobByBuyIn.get(buyInId);
  return lastId ? jobs.get(lastId) ?? null : null;
}

// All live-or-recent checkout jobs for a reservation's units (row-level
// rediscovery queries by reservation).
export function getCheckoutJobsForReservation(reservationId: string): CheckoutJob[] {
  cleanupStaleJobs();
  const seen = new Set<number>();
  const out: CheckoutJob[] = [];
  for (const job of Array.from(jobs.values())) {
    if (job.reservationId !== reservationId) continue;
    if (seen.has(job.buyInId)) continue;
    seen.add(job.buyInId);
    out.push(job);
  }
  return out;
}

export function cancelBuyInCheckoutJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.canceled = true;
  try {
    job.controller.abort("canceled by operator");
  } catch {
    /* ignore */
  }
  touch(job);
  return true;
}
