// Missing buy-in warning for imminent check-ins (dashboard popup).
//
// Operator ask (2026-07-04): raise a red-flag alert — same visual language as
// the failed-payment popup — whenever a reservation checks in within the next
// 15 days (widened from 7 on 2026-07-07) and the units required to host it have NOT all been purchased
// (bought in) yet. A guest arriving with no physical unit behind the listing
// is the most expensive failure in this business, worse than a declined card.
//
// Pure helpers only — the server route (GET /api/dashboard/buyin-coverage)
// owns the data fetch (a loopback self-call to /api/bookings/guesty-all, which
// already resolves each reservation's required unit slots + attached buy-ins
// for core properties, promoted drafts, ad-hoc listings AND manual bookings)
// and client/src/pages/home.tsx owns rendering. This module only decides,
// from an enriched reservation row, whether it warrants a warning.
//
// "Purchased" = a buy-in row attached to the reservation's unit slot
// (slot.buyIn from enrichGuestyReservationForOperations). A cancelled buy-in
// does NOT count as coverage — the unit was un-bought.

export const BUYIN_COVERAGE_WINDOW_DAYS = 15;

const DAY_MS = 24 * 60 * 60 * 1000;

export type BuyInCoverageSlot = {
  unitId: string;
  unitLabel?: string | null;
  buyIn?: { status?: string | null } | null;
};

// Shape of a row from GET /api/bookings/guesty-all (Guesty-enriched or the
// merged manual-reservation clone) — only the fields this module reads.
export type BuyInCoverageReservationLike = {
  _id?: string | null;
  id?: string | null;
  status?: string | null;
  checkIn?: string | null;
  checkInDateLocalized?: string | null;
  checkOut?: string | null;
  checkOutDateLocalized?: string | null;
  confirmationCode?: string | null;
  guest?: any;
  integration?: any;
  source?: string | null;
  listing?: any;
  operationsPropertyId?: number | null;
  operationsPropertyName?: string | null;
  slots?: BuyInCoverageSlot[] | null;
};

export type BuyInMissingUnit = { unitId: string; unitLabel: string };

export type BuyInCoverageWarning = {
  reservationId: string;
  confirmationCode: string | null;
  guestName: string | null;
  listingNickname: string | null;
  channel: string | null;
  checkIn: string | null;
  checkOut: string | null;
  propertyId: number | null;
  propertyName: string | null;
  // 0 = checks in today; negative = guest is already in-house.
  daysUntilCheckIn: number;
  slotsTotal: number;
  slotsFilled: number;
  missingUnits: BuyInMissingUnit[];
};

// Mirror of routes.ts isCommittedGuestyReservation's status exclusions (same
// list the payment-failure warning uses): a cancelled/inquiry/expired booking
// doesn't need units purchased. Manual rows ("manual"/"confirmed") pass.
export function reservationExcludedFromBuyInWarnings(
  reservation: { status?: string | null } | null | undefined,
): boolean {
  const status = String(reservation?.status ?? "").toLowerCase();
  return /(cancel|declin|inquir|request|expired|closed|draft)/.test(status);
}

// Guesty dates arrive either as plain "YYYY-MM-DD" (checkInDateLocalized,
// manual rows) or full ISO timestamps — day precision is all we need.
function dayOf(iso: string | null | undefined): string | null {
  const s = String(iso ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function checkInDayOf(reservation: BuyInCoverageReservationLike): string | null {
  return dayOf(reservation?.checkInDateLocalized) ?? dayOf(reservation?.checkIn);
}

function checkOutDayOf(reservation: BuyInCoverageReservationLike): string | null {
  return dayOf(reservation?.checkOutDateLocalized) ?? dayOf(reservation?.checkOut);
}

// Whole days from "today" (derived from nowMs, UTC day) to the check-in day.
// null when the reservation has no parseable check-in date.
export function daysUntilCheckIn(
  reservation: BuyInCoverageReservationLike,
  nowMs: number,
): number | null {
  const checkInDay = checkInDayOf(reservation);
  if (!checkInDay) return null;
  const todayDay = dayOf(new Date(nowMs).toISOString());
  if (!todayDay) return null;
  return Math.round((dayMs(checkInDay) - dayMs(todayDay)) / DAY_MS);
}

// A slot counts as purchased when a buy-in is attached and not cancelled.
export function buyInSlotCovered(slot: BuyInCoverageSlot | null | undefined): boolean {
  const buyIn = slot?.buyIn;
  if (!buyIn || typeof buyIn !== "object") return false;
  return !/cancel/i.test(String(buyIn.status ?? ""));
}

export function missingBuyInUnits(reservation: BuyInCoverageReservationLike): BuyInMissingUnit[] {
  const slots = Array.isArray(reservation?.slots) ? reservation.slots : [];
  return slots
    .filter((slot) => !buyInSlotCovered(slot))
    .map((slot) => ({
      unitId: String(slot?.unitId ?? ""),
      unitLabel: String(slot?.unitLabel ?? slot?.unitId ?? "Unit"),
    }));
}

// Window rule: check-in within the next `windowDays` (inclusive, incl. today),
// PLUS stays already in-house (checked in, not yet out) — a guest currently
// on-property with no unit purchased is the reddest possible flag, and the
// checkOut bound keeps long-gone historical rows from nagging.
export function checkInWithinBuyInWarningWindow(
  reservation: BuyInCoverageReservationLike,
  nowMs: number,
  windowDays: number = BUYIN_COVERAGE_WINDOW_DAYS,
): boolean {
  const days = daysUntilCheckIn(reservation, nowMs);
  if (days == null || days > windowDays) return false;
  if (days >= 0) return true;
  const checkOutDay = checkOutDayOf(reservation);
  const todayDay = dayOf(new Date(nowMs).toISOString());
  return !!checkOutDay && !!todayDay && checkOutDay >= todayDay;
}

function guestNameOf(reservation: BuyInCoverageReservationLike): string | null {
  const guest = reservation?.guest ?? {};
  const joined = [guest.firstName ?? guest.first_name, guest.lastName ?? guest.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  return joined || guest.fullName || guest.full_name || guest.name || null;
}

export function collectBuyInCoverageWarnings(
  reservations: BuyInCoverageReservationLike[] | null | undefined,
  nowMs: number,
  opts?: { windowDays?: number },
): BuyInCoverageWarning[] {
  const windowDays = opts?.windowDays ?? BUYIN_COVERAGE_WINDOW_DAYS;
  const warnings: BuyInCoverageWarning[] = [];
  const seen = new Set<string>();
  for (const reservation of Array.isArray(reservations) ? reservations : []) {
    if (!reservation || typeof reservation !== "object") continue;
    if (reservationExcludedFromBuyInWarnings(reservation)) continue;
    const slots = Array.isArray(reservation.slots) ? reservation.slots : [];
    // No configured unit slots → requirements unknown, nothing to warn about.
    if (slots.length === 0) continue;
    if (!checkInWithinBuyInWarningWindow(reservation, nowMs, windowDays)) continue;
    const missing = missingBuyInUnits(reservation);
    if (missing.length === 0) continue;
    const reservationId = String(reservation._id ?? reservation.id ?? "").trim();
    if (!reservationId || seen.has(reservationId)) continue;
    seen.add(reservationId);
    warnings.push({
      reservationId,
      confirmationCode: reservation.confirmationCode ?? null,
      guestName: guestNameOf(reservation),
      listingNickname:
        reservation.listing?.nickname ??
        reservation.listing?.title ??
        reservation.operationsPropertyName ??
        null,
      channel: reservation.integration?.platform ?? reservation.source ?? null,
      checkIn: checkInDayOf(reservation),
      checkOut: checkOutDayOf(reservation),
      propertyId:
        reservation.operationsPropertyId != null && Number.isFinite(Number(reservation.operationsPropertyId))
          ? Number(reservation.operationsPropertyId)
          : null,
      propertyName: reservation.operationsPropertyName ?? null,
      daysUntilCheckIn: daysUntilCheckIn(reservation, nowMs) ?? 0,
      slotsTotal: slots.length,
      slotsFilled: slots.length - missing.length,
      missingUnits: missing,
    });
  }
  // Most imminent arrival first — that's the one to fix right now.
  warnings.sort((a, b) => a.daysUntilCheckIn - b.daysUntilCheckIn);
  return warnings;
}

// Order-independent signature of the current coverage facts (mirrors
// paymentFailureWarningSignature). Persisted on dismiss; the popup only
// auto-reopens when the facts change — a new uncovered reservation, a changed
// check-in date, or a different set of missing units re-raises a dismissed
// warning, while page reloads stay quiet.
export function buyInCoverageWarningSignature(warnings: BuyInCoverageWarning[]): string {
  if (!Array.isArray(warnings) || warnings.length === 0) return "";
  return warnings
    .map(
      (w) =>
        `${w.reservationId}:${w.checkIn ?? ""}:${w.missingUnits
          .map((u) => u.unitId)
          .sort()
          .join(",")}`,
    )
    .sort()
    .join(";");
}
