// Pure builder for the day-of-booking "unit setup confirmation" message.
//
// Fired once per newly-booked reservation by server/booking-confirmations.ts
// so the guest 100% knows what's going on the moment they book: how their
// accommodation is arranged (one listing = N separate units in the same
// resort), the stay specifics they booked, and what happens next (arrival
// details ~14 days out). Kept pure + dependency-light so it's unit-testable
// and the copy can be reasoned about in one place.
//
// LOAD-BEARING — the body must be ASCII-clean (straight quotes, hyphens, no
// em-dashes, no bullet glyphs, no emoji). It ships to EVERY booking channel,
// and Booking.com only reliably delivers plain ASCII (see the relocation
// message notes in AGENTS.md). Writing it clean here means no per-channel
// sanitization is needed downstream.
//
// Region-aware voice: Hawaii stays open "Aloha"/close "Mahalo" and say
// "'ohana"; mainland (Florida, etc.) stays use "Hi"/"Thanks"/"family". The
// signature (John Carpenter / VacationRentalExpertz) is constant. This mirrors
// the 2026-06-20 region-aware greeting work across the inbox templates.

import { occupancyForBedrooms } from "./occupancy";

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
}

function greetingLine(firstName: string, isHawaii: boolean): string {
  const opener = isHawaii ? "Aloha" : "Hi";
  return firstName ? `${opener} ${firstName},` : `${opener},`;
}

function signoffLines(isHawaii: boolean): string[] {
  return [isHawaii ? "Mahalo," : "Thanks,", "John Carpenter", "VacationRentalExpertz"];
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
  } = stay;

  const family = isHawaii ? "'ohana" : "family";
  const thanks = isHawaii ? "Mahalo" : "Thank you";
  const multiUnit = unitCount >= 2;

  // Listing titles routinely end with their own "!" — trim trailing sentence
  // punctuation so we don't emit "...for 16!!".
  const cleanName = propertyName.replace(/[\s!?.]+$/, "") || propertyName;

  const lines: string[] = [];
  lines.push(greetingLine(guestFirstName, isHawaii));
  lines.push("");
  lines.push(
    `${thanks} for booking ${cleanName}! We're honored to host your ${family} and can't wait to welcome you to ${resortName}.`,
  );
  lines.push("");

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
  } else {
    lines.push("Here's what to expect:");
    lines.push("");
    const unitPhrase = totalBedrooms > 0 ? `a ${totalBedrooms}-bedroom unit` : "your unit";
    lines.push(
      `Your stay is ${unitPhrase} at ${resortName}. We'll have everything ready for a smooth, easy check-in.`,
    );
  }

  lines.push("");
  lines.push("What happens next:");
  lines.push("");
  lines.push(
    "- Right now there's nothing you need to do. Your booking is confirmed and we're getting everything ready on our end.",
  );
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
