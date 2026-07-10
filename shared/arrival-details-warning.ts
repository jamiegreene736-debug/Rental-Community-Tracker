// Arrival-details-not-sent warning for imminent check-ins (dashboard popup).
//
// Operator ask (2026-07-10): the automated booking confirmation PROMISES the
// guest "about 14 days before your check-in date, we'll send your full arrival
// details" — but sending them is entirely manual (the Message AD dialog /
// inbox timeline draft). Nothing enforced the promise, so a booking could
// reach arrival day with no codes ever sent. This module powers the dashboard
// warning (same visual language as the missing-buy-in popup) listing every
// reservation inside the 14-day window whose Guesty thread shows NO actual
// arrival-details message.
//
// Pure helpers only — the server route (GET /api/dashboard/arrival-details-
// coverage) owns the data fetch (loopback self-call to /api/bookings/
// guesty-all + a per-reservation Guesty posts scan using
// looksLikeArrivalDetailsMessage from shared/arrival-details-message.ts) and
// client/src/pages/home.tsx owns rendering. This module decides which
// reservations are candidates, and builds the dismissal signature.
//
// Deliberate exclusions:
//   - MANUAL reservations ("manual:<id>") — they have no Guesty conversation
//     to verify against, so the warning could never clear and would nag
//     forever. Their arrival details go out via SMS/email at the operator's
//     discretion.
//   - In-house stays (negative daysUntilCheckIn) — the guest already arrived;
//     the pre-arrival promise window is over and the operator is presumably
//     already talking to them.

import { looksLikeArrivalDetailsMessage } from "./arrival-details-message";

export const ARRIVAL_DETAILS_WINDOW_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

// Shape of a row from GET /api/bookings/guesty-all — only the fields read here.
export type ArrivalCoverageReservationLike = {
  _id?: string | null;
  id?: string | null;
  status?: string | null;
  checkIn?: string | null;
  checkInDateLocalized?: string | null;
  confirmationCode?: string | null;
  guest?: any;
  integration?: any;
  source?: string | null;
  listing?: any;
  operationsPropertyName?: string | null;
  slots?: Array<{ buyIn?: { status?: string | null } | null } | null> | null;
};

export type ArrivalDetailsCandidate = {
  reservationId: string;
  confirmationCode: string | null;
  guestName: string | null;
  listingNickname: string | null;
  channel: string | null;
  checkIn: string;
  // 0 = checks in today.
  daysUntilCheckIn: number;
  // How many unit slots have a non-cancelled buy-in attached vs required.
  // When unitsAttached < unitsRequired the operator can't send full arrival
  // details yet — the row's remedy is "attach units first" (the missing-buy-in
  // popup's job), rendered as a hint instead of the plain "send AD" nudge.
  unitsRequired: number;
  unitsAttached: number;
};

// The server stamps each candidate with the thread-scan verdict.
export type ArrivalDetailsWarning = ArrivalDetailsCandidate & {
  // true = a real arrival-details message was found on the Guesty thread.
  adSent: boolean;
  // true = the thread could not be checked (no conversation / posts fetch
  // failed) — surfaced honestly so "unknown" never silently reads as sent.
  scanUnavailable?: boolean;
};

// Mirror of routes.ts isCommittedGuestyReservation's status exclusions (the
// same list the payment-failure + buy-in coverage warnings use).
function reservationExcluded(reservation: { status?: string | null } | null | undefined): boolean {
  const status = String(reservation?.status ?? "").toLowerCase();
  return /(cancel|declin|inquir|request|expired|closed|draft)/.test(status);
}

function dayOf(iso: string | null | undefined): string | null {
  const s = String(iso ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function guestNameOf(reservation: ArrivalCoverageReservationLike): string | null {
  const guest = reservation?.guest ?? {};
  const joined = [guest.firstName ?? guest.first_name, guest.lastName ?? guest.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  return joined || guest.fullName || guest.full_name || guest.name || null;
}

// Reservations the coverage scan should verify: committed, non-manual, with a
// check-in 0..windowDays days out. Sorted most-imminent first so the server's
// per-reservation posts scan spends its cap on the arrivals that matter most.
export function arrivalDetailsCandidates(
  reservations: ArrivalCoverageReservationLike[] | null | undefined,
  nowMs: number,
  opts?: { windowDays?: number },
): ArrivalDetailsCandidate[] {
  const windowDays = opts?.windowDays ?? ARRIVAL_DETAILS_WINDOW_DAYS;
  const todayDay = dayOf(new Date(nowMs).toISOString());
  if (!todayDay) return [];
  const out: ArrivalDetailsCandidate[] = [];
  const seen = new Set<string>();
  for (const reservation of Array.isArray(reservations) ? reservations : []) {
    if (!reservation || typeof reservation !== "object") continue;
    if (reservationExcluded(reservation)) continue;
    const reservationId = String(reservation._id ?? reservation.id ?? "").trim();
    if (!reservationId || seen.has(reservationId)) continue;
    if (reservationId.startsWith("manual:")) continue;
    const checkInDay = dayOf(reservation.checkInDateLocalized) ?? dayOf(reservation.checkIn);
    if (!checkInDay) continue;
    const days = Math.round((dayMs(checkInDay) - dayMs(todayDay)) / DAY_MS);
    if (days < 0 || days > windowDays) continue;
    seen.add(reservationId);
    const slots = Array.isArray(reservation.slots) ? reservation.slots : [];
    const attached = slots.filter(
      (slot) => slot?.buyIn && typeof slot.buyIn === "object" && !/cancel/i.test(String(slot.buyIn.status ?? "")),
    ).length;
    out.push({
      reservationId,
      confirmationCode: reservation.confirmationCode ?? null,
      guestName: guestNameOf(reservation),
      listingNickname:
        reservation.listing?.nickname ?? reservation.listing?.title ?? reservation.operationsPropertyName ?? null,
      channel: reservation.integration?.platform ?? reservation.source ?? null,
      checkIn: checkInDay,
      daysUntilCheckIn: days,
      unitsRequired: slots.length,
      unitsAttached: attached,
    });
  }
  out.sort((a, b) => a.daysUntilCheckIn - b.daysUntilCheckIn);
  return out;
}

// Fold the thread-scan verdict onto a candidate. Pure so the decision "which
// bodies count as arrival details" is testable: only HOST-authored bodies are
// consulted (a guest pasting "the access code: 1234 didn't work" back at us
// must not read as coverage), and any matching body marks the reservation sent.
export function resolveArrivalDetailsWarning(
  candidate: ArrivalDetailsCandidate,
  hostPostBodies: string[] | null,
): ArrivalDetailsWarning {
  if (hostPostBodies === null) {
    return { ...candidate, adSent: false, scanUnavailable: true };
  }
  const adSent = hostPostBodies.some((body) => looksLikeArrivalDetailsMessage(body));
  return { ...candidate, adSent };
}

// Order-independent signature of the current facts (mirrors
// buyInCoverageWarningSignature). Persisted on dismiss; the popup only
// auto-reopens when the facts change — a new uncovered arrival, a moved
// check-in date, or a unit-attachment change re-raises a dismissed warning,
// while page reloads stay quiet.
export function arrivalDetailsWarningSignature(warnings: Array<Pick<ArrivalDetailsWarning, "reservationId" | "checkIn" | "unitsRequired" | "unitsAttached">>): string {
  if (!Array.isArray(warnings) || warnings.length === 0) return "";
  return warnings
    .map((w) => `${w.reservationId}:${w.checkIn}:${w.unitsAttached}/${w.unitsRequired}`)
    .sort()
    .join(";");
}
