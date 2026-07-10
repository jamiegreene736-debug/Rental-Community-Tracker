// Pure builder for the day-of-booking "unit setup confirmation" message.
//
// Fired once per newly-booked reservation by server/booking-confirmations.ts
// so the guest 100% knows what's going on the moment they book: how their
// accommodation is arranged (one listing = N separate units in the same
// resort), that the listing photos are REPRESENTATIVE of the unit standard
// (the expectation that matters most for dispute prevention — mirrors the
// rental-agreement clause and the manual "Unit setup confirmation" template),
// the stay specifics they booked (dates, nights, confirmation code, any
// scheduled balance), and what happens next (arrival details ~14 days out).
// Kept pure + dependency-light so it's unit-testable and the copy can be
// reasoned about in one place.
//
// LOAD-BEARING — the body must be ASCII-clean (straight quotes, hyphens, no
// em-dashes, no bullet glyphs, no emoji). It ships to EVERY booking channel,
// and Booking.com only reliably delivers plain ASCII (see the relocation
// message notes in AGENTS.md). Writing it clean here means no per-channel
// sanitization is needed downstream.
//
// LOAD-BEARING — wording vs the inbox guest-stay timeline (inbox.tsx):
//   - The representative line DELIBERATELY contains "assigned units will
//     match" so the timeline's manual "Unit setup confirmation" step reads
//     sent once this automated message posts (the disclosure genuinely went
//     out — the manual follow-up is covered).
//   - The balance line DELIBERATELY avoids the phrase "remaining balance"
//     (and "payment method" / "credit card") so it can never trip the
//     timeline's "Guesty invoice / payment method" sent-detection.
//   - Nothing here may match looksLikeArrivalDetailsMessage
//     (shared/arrival-details-message.ts) — the 14-day promise must not read
//     as the arrival details themselves. No line may start with the AD detail
//     labels (Unit N: / Address: / Access code: / Wi-Fi: / Parking:).
//
// Region-aware voice: Hawaii stays open "Aloha"/close "Mahalo", say "'ohana",
// add "E komo mai!" and name the island when known ("here on Kauai");
// mainland (Florida, etc.) stays use "Hi"/"Thanks"/"family" with none of the
// Hawaiian touches. The signature (John Carpenter / VacationRentalExpertz) is
// constant. This mirrors the 2026-06-20 region-aware greeting work across the
// inbox templates.

import { occupancyForBedrooms } from "./occupancy";
import {
  nextScheduledChargeDate,
  paymentRowLooksScheduled,
  scheduledChargeDateIso,
  type GuestyPaymentRow,
} from "./guesty-payment-schedule";

export interface BookingConfirmationStay {
  /** Guest's first name; "" is fine (greeting drops the name). */
  guestFirstName: string;
  /** The listing/OTA title the guest booked ("Beautiful 6 Bedroom ... in Poipu!"). */
  propertyName: string;
  /** The resort / community grounds the units sit in ("Regency at Poipu Kai"). */
  resortName: string;
  /** How many separate units make up this booking (1 for a single-unit listing). */
  unitCount: number;
  /** Combined bedrooms across the units; 0 when unknown (specifics omitted). */
  totalBedrooms: number;
  /** Approx. walking minutes between units; only used for multi-unit stays. */
  walkMinutes: number;
  /** True → Hawaiian voice; false → mainland voice. */
  isHawaii: boolean;
  /** Guest's booked party size when the channel provided it; used only when it fits the listing. */
  partyTotal?: number | null;
  /**
   * Island label from resolveIslandRegion via hawaiianIslandLabel ("Kauai",
   * "the Big Island of Hawaii", ...). Rendered only on Hawaii stays; null/""
   * omits the island mention.
   */
  islandName?: string | null;
  /** Stay dates as YYYY-MM-DD (longer ISO strings are truncated); omitted when absent. */
  checkInIso?: string | null;
  checkOutIso?: string | null;
  /** Night count; rendered next to check-out when > 0. */
  nights?: number | null;
  /** Channel confirmation code; line omitted when absent. */
  confirmationCode?: string | null;
  /**
   * Outstanding balance backed by a REAL Guesty scheduled payment
   * (nextScheduledChargeDate). The server only passes this when the
   * reservation is verifiably not fully paid AND a deposit was already
   * collected AND Guesty has a concrete scheduled charge — stating a wrong
   * balance is worse than staying quiet, so absence simply omits the line.
   */
  balanceDue?: { amountUsd: number; dueIso: string } | null;
}

// UTC integer night count from two YYYY-MM-DD strings; null when either date
// is malformed or the range is non-positive. Fallback for reservations whose
// nightsCount is absent.
export function nightsBetweenYmd(checkInYmd: string, checkOutYmd: string): number | null {
  const parse = (ymd: string): number | null => {
    const [y, m, d] = ymd.split("-").map(Number);
    if (!y || !m || !d) return null;
    return Date.UTC(y, m - 1, d);
  };
  const a = parse(checkInYmd);
  const b = parse(checkOutYmd);
  if (a === null || b === null) return null;
  const nights = Math.round((b - a) / (24 * 60 * 60 * 1000));
  return nights > 0 ? nights : null;
}

// The outstanding balance backed by a REAL Guesty scheduled charge — the only
// case the confirmation may state one. Guards, in order:
//   - `money.isFullyPaid === true` → never claim a balance (Booking.com ships
//     isFullyPaid:true with totalPaid:0 — see the payment-collected memory);
//   - nothing collected yet (totalPaid <= 0) → stay quiet rather than guess
//     whether the deposit merely hasn't processed;
//   - no scheduled payment row with a concrete charge date
//     (nextScheduledChargeDate, keyed on shouldBePaidAt) → no line;
//   - the next scheduled row's OWN amount must equal the outstanding balance
//     (within $1) — the sentence says "THE balance ... collected on <date>",
//     which is false for a multi-installment schedule, so those omit instead.
// Absence of the line is always safe; a WRONG stated balance is not.
export function scheduledBalanceDueFromReservation(
  r: { money?: any; payments?: unknown } | null | undefined,
  nowMs: number,
): { amountUsd: number; dueIso: string } | null {
  const money = r?.money ?? {};
  if (money?.isFullyPaid === true) return null;
  const totalPrice = Number(money?.totalPrice);
  const totalPaid = Number(money?.totalPaid);
  if (!Number.isFinite(totalPrice) || !Number.isFinite(totalPaid) || totalPaid <= 0) return null;
  const balance = Math.round((totalPrice - totalPaid) * 100) / 100;
  if (balance <= 0) return null;
  const payments: GuestyPaymentRow[] = Array.isArray(money?.payments)
    ? money.payments
    : Array.isArray((r as any)?.payments)
      ? ((r as any).payments as GuestyPaymentRow[])
      : [];
  const next = nextScheduledChargeDate(payments, nowMs);
  if (!next) return null;
  const nextIsoDay = next.toISOString().slice(0, 10);
  const nextRowAmount = payments
    .filter((p) => p && typeof p === "object" && paymentRowLooksScheduled(p))
    .filter((p) => String(scheduledChargeDateIso(p) ?? "").slice(0, 10) === nextIsoDay)
    .map((p) => Number((p as any)?.amount))
    .find((a) => Number.isFinite(a) && a > 0);
  if (nextRowAmount === undefined || Math.abs(nextRowAmount - balance) > 1) return null;
  return { amountUsd: balance, dueIso: next.toISOString() };
}

function greetingLine(firstName: string, isHawaii: boolean): string {
  const opener = isHawaii ? "Aloha" : "Hi";
  return firstName ? `${opener} ${firstName},` : `${opener},`;
}

function signoffLines(isHawaii: boolean): string[] {
  return [isHawaii ? "Mahalo," : "Thanks,", "John Carpenter", "VacationRentalExpertz"];
}

// "Monday, July 20, 2026" from a YYYY-MM-DD (or longer ISO) string. Falls back
// to the raw input when unparseable so a malformed date never drops the line.
function formatLongDateYmd(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

// "$2,612.50" — explicit en-US so the body is deterministic regardless of the
// server locale.
function formatUsd(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// "with plenty of room for your group of 6" — only when we know the party AND
// the listing genuinely seats it. We never surface the party number when it
// would read as a shortfall (party > capacity).
function partyClause(partyTotal: number | null | undefined, sleeps: number): string {
  const p = typeof partyTotal === "number" && partyTotal > 0 ? partyTotal : null;
  if (p === null || sleeps <= 0 || sleeps < p) return "";
  return `, with plenty of room for your group of ${p}`;
}

export function buildBookingConfirmationMessage(stay: BookingConfirmationStay): string {
  const {
    guestFirstName,
    propertyName,
    resortName,
    unitCount,
    totalBedrooms,
    walkMinutes,
    isHawaii,
    partyTotal,
    islandName,
    checkInIso,
    checkOutIso,
    nights,
    confirmationCode,
    balanceDue,
  } = stay;

  const family = isHawaii ? "'ohana" : "family";
  const thanks = isHawaii ? "Mahalo" : "Thank you";
  const multiUnit = unitCount >= 2;

  // Listing titles routinely end with their own "!" — trim trailing sentence
  // punctuation so we don't emit "...for 16!!".
  const cleanName = propertyName.replace(/[\s!?.]+$/, "") || propertyName;

  // "welcome you to Mauna Kai here on Kauai. E komo mai!" — the island mention
  // and the E komo mai welcome are Hawaii-only touches; mainland stays keep the
  // plain sentence.
  const island = isHawaii && islandName ? ` here on ${islandName}` : "";
  const welcomeTouch = isHawaii ? " E komo mai!" : "";

  const lines: string[] = [];
  lines.push(greetingLine(guestFirstName, isHawaii));
  lines.push("");
  lines.push(
    `${thanks} for booking ${cleanName}! We're honored to host your ${family} and can't wait to welcome you to ${resortName}${island}.${welcomeTouch}`,
  );
  lines.push("");

  // Stay specifics — guests re-read confirmations to double-check dates, so
  // restate what they booked. Every line degrades independently (absent data
  // simply omits its line; no block at all when we know neither date).
  const checkInYmd = String(checkInIso ?? "").slice(0, 10);
  const checkOutYmd = String(checkOutIso ?? "").slice(0, 10);
  const code = String(confirmationCode ?? "").trim();
  if (checkInYmd || checkOutYmd) {
    lines.push("Your stay at a glance:");
    lines.push("");
    if (checkInYmd) lines.push(`- Check-in: ${formatLongDateYmd(checkInYmd)}`);
    if (checkOutYmd) {
      const nightsSuffix =
        typeof nights === "number" && nights > 0 ? ` (${nights} night${nights === 1 ? "" : "s"})` : "";
      lines.push(`- Check-out: ${formatLongDateYmd(checkOutYmd)}${nightsSuffix}`);
    }
    if (code) lines.push(`- Confirmation code: ${code}`);
    lines.push("");
  }

  if (multiUnit) {
    // Combos advertise "Sleeps N" via occupancyForBedrooms — the same number
    // the guest saw when booking, so it's safe to restate here.
    const sleeps = totalBedrooms > 0 ? occupancyForBedrooms(totalBedrooms) : 0;
    const walkPhrase =
      walkMinutes <= 1
        ? "just steps apart on the resort grounds"
        : `about a ${walkMinutes}-minute walk apart on the resort grounds`;

    lines.push("Here's how your stay is set up, so you know exactly what to expect:");
    lines.push("");

    const setup: string[] = [];
    setup.push(`Your group is booked across ${unitCount} separate units within ${resortName}, ${walkPhrase}.`);
    if (totalBedrooms > 0) {
      setup.push(
        ` Together they give you ${totalBedrooms} bedrooms that comfortably sleep up to ${sleeps} guests${partyClause(partyTotal, sleeps)}.`,
      );
    }
    setup.push(
      " Each unit has its own private entrance and keys, so everyone has their own space while staying together on the same resort grounds.",
    );
    lines.push(setup.join(""));
    lines.push("");
    // The representative-photos expectation, set the day they book. Keep
    // "assigned units will match" verbatim — the inbox timeline's manual
    // "Unit setup confirmation" step keys on it (see the header note).
    lines.push(
      `One more thing worth knowing: the listing photos show the style and standard of our units at ${resortName}. Your assigned units will match the same bedroom count and quality shown, though small details like furnishings or views can vary a little from unit to unit.`,
    );
  } else {
    lines.push("Here's what to expect:");
    lines.push("");
    const unitPhrase = totalBedrooms > 0 ? `a ${totalBedrooms}-bedroom unit` : "your unit";
    lines.push(
      `Your stay is ${unitPhrase} at ${resortName}. We'll have everything ready for a smooth, easy check-in.`,
    );
    lines.push("");
    lines.push(
      `One more thing worth knowing: the listing photos show the style and standard of our units at ${resortName}. Your assigned unit will match the same bedroom count and quality shown, though small details like furnishings or views can vary a little.`,
    );
  }

  lines.push("");
  lines.push("What happens next:");
  lines.push("");
  lines.push(
    "- Right now there's nothing you need to do. Your booking is confirmed and we're getting everything ready on our end.",
  );
  if (balanceDue && balanceDue.amountUsd > 0 && String(balanceDue.dueIso ?? "").slice(0, 10)) {
    // Phrasing note: never "remaining balance" (see the header's timeline
    // wording constraints).
    lines.push(
      `- The balance of ${formatUsd(balanceDue.amountUsd)} is scheduled to be collected automatically on ${formatLongDateYmd(String(balanceDue.dueIso).slice(0, 10))}, so there's nothing extra to do there either.`,
    );
  }
  lines.push(
    `- About 14 days before your check-in date, we'll send your full arrival details: ${
      multiUnit ? "unit assignments, " : ""
    }door and lockbox codes, parking, WiFi, and a few local recommendations.`,
  );
  lines.push("- Have a question before then? Just reply right here anytime.");
  lines.push("");
  lines.push("We're looking forward to hosting you!");
  lines.push("");
  lines.push(...signoffLines(isHawaii));

  return lines.join("\n");
}
