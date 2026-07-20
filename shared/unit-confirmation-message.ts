// Guest-facing UNIT CONFIRMATION message ("Send unit confirmation to guest",
// bookings page). The counterpart of the relocation message
// (buildRelocationGuestMessage in server/routes.ts) with the OPPOSITE framing:
// nothing about the booking changed — the operator just wants the guest to see
// the exact units reserved for their stay, with the exact photos, on the
// tokenized /alternatives/:token guest page (built with pageKind
// "unit-confirmation" so the renderer drops all relocation framing).
//
// Rules shared with the relocation message:
// - Plain ASCII by construction (straight quotes, hyphens) so the Booking.com
//   sanitizer never has to rewrite it; the caller still applies
//   sanitizeForBookingChannel for the booking channel as belt-and-braces.
// - The page URL sits on its OWN line (Booking.com link delivery).
// - Signed "Mahalo, John Carpenter" like every other guest message.
// - NO apology, NO refund offer, NO "moved you" / "comparable" wording — this
//   message must never read like a relocation.
// - Arrival-details wording stays a plain promise with no "Code:"-style
//   labeled lines, so the inbox arrival-details matcher can never mistake it
//   for the real arrival-details send.

export type UnitConfirmationUnit = {
  bedrooms?: number | null;
  sleeps?: number | null;
};

export type UnitConfirmationMessageInput = {
  guestName?: string | null;
  /** The /alternatives/:token guest page URL (pageKind "unit-confirmation"). */
  confirmationUrl: string;
  /** One entry per attached unit, in slot order. */
  units?: UnitConfirmationUnit[];
  /** Combined sleeps — only when EVERY unit has a sleeps value (never a partial sum). */
  totalSleeps?: number | null;
  partySize?: number | null;
  /** Walk minutes between the units (2+ unit combos). */
  walkMinutes?: number | null;
  sameBuilding?: boolean;
};

const ORDINAL_UNIT_LABELS = ["The first unit", "the second unit", "the third unit", "the fourth unit"];

function positiveInt(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.round(num) : null;
}

function describeUnitCapacity(unit: UnitConfirmationUnit): string {
  const bedrooms = positiveInt(unit?.bedrooms);
  const sleeps = positiveInt(unit?.sleeps);
  if (bedrooms && sleeps) return `has ${bedrooms} bedroom${bedrooms === 1 ? "" : "s"} and sleeps up to ${sleeps} guests`;
  if (bedrooms) return `has ${bedrooms} bedroom${bedrooms === 1 ? "" : "s"}`;
  if (sleeps) return `sleeps up to ${sleeps} guests`;
  return "";
}

function firstNameFor(guestName: unknown): string {
  const first = String(guestName ?? "").trim().split(/\s+/)[0] ?? "";
  // "Guest" is the placeholder for a missing name — never greet with it.
  if (!first || /^guest$/i.test(first)) return "";
  return first;
}

export function buildUnitConfirmationGuestMessage(input: UnitConfirmationMessageInput): string {
  const firstName = firstNameFor(input.guestName);
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";
  const units = Array.isArray(input.units) ? input.units : [];
  const unitCount = units.length;
  const unitsWord = unitCount === 1 ? "unit" : "units";

  // Per-unit capacity breakdown ("The first unit has 3 bedrooms and sleeps up
  // to 8 guests, and the second unit has 2 bedrooms..."). Units without any
  // capacity facts are simply omitted — never invented.
  const namedUnits = units
    .map((unit, index) => {
      const desc = describeUnitCapacity(unit);
      return desc ? `${ORDINAL_UNIT_LABELS[index] ?? `unit ${index + 1}`} ${desc}` : "";
    })
    .filter(Boolean);
  let capacityLine = "";
  if (namedUnits.length >= 2) {
    capacityLine = `${namedUnits.slice(0, -1).join(", ")}, and ${namedUnits[namedUnits.length - 1]}.`;
  } else if (namedUnits.length === 1) {
    capacityLine = `${namedUnits[0].replace(/^The first unit/, "The unit")}.`;
  }
  const totalSleeps = positiveInt(input.totalSleeps);
  const partySize = positiveInt(input.partySize);
  if (unitCount >= 2 && totalSleeps) {
    const fitClause = partySize && totalSleeps >= partySize
      ? `, so your party of ${partySize} will fit comfortably`
      : "";
    capacityLine = `${capacityLine} Together they sleep up to ${totalSleeps} guests${fitClause}.`.trim();
  }

  const walkMinutes = positiveInt(input.walkMinutes);
  const proximityLine = unitCount >= 2
    ? input.sameBuilding === true
      ? "Both units are in the same building, so your group will be right next to each other."
      : walkMinutes
        ? `The units are about a ${walkMinutes}-minute walk from each other, so your group will be close together.`
        : ""
    : "";

  const lines = [
    greeting,
    "",
    `Great news - everything is confirmed for your upcoming stay. I wanted to personally send over the exact ${unitsWord} reserved for you, so you know just what to expect when you arrive.`,
    "",
    ...(capacityLine ? [capacityLine, ""] : []),
    `You can see photos and full details of the exact ${unitsWord} you will be staying in on this page:`,
    input.confirmationUrl,
    "",
    ...(proximityLine ? [proximityLine, ""] : []),
    `Please take a look and let me know that everything looks as you expected - and if anything seems off, just message me and I will take care of it right away. Your full arrival details, including the address and access information, will follow before check-in.`,
    "",
    "We are looking forward to hosting you!",
    "",
    "Mahalo,",
    "John Carpenter",
  ];
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
