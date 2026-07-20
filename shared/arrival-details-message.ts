// Does a host message body contain ACTUAL arrival details (as opposed to a
// promise of them)? Used by the inbox guest-stay timeline's "14-day arrival
// details" sent-detection AND the dashboard arrival-details coverage warning
// (GET /api/dashboard/arrival-details-coverage), so the two surfaces can never
// disagree.
//
// LOAD-BEARING — the old timeline regex (/arrival details|access code|check-in
// date/i) false-positived on the AUTOMATED booking confirmation, whose
// what-happens-next bullet PROMISES "your full arrival details ... door and
// lockbox codes" ~14 days out. The step then read ✓ sent the moment the
// confirmation posted, and a guest could reach arrival day with no codes while
// the timeline looked done. So this matcher keys on the message's STRUCTURE,
// not its vocabulary:
//   - a line-anchored access credential label ("Access code: 1234",
//     "Door code:", "Lockbox code:", "Gate code:", "Entry code:"), OR
//   - the AD builder's per-unit block header ("Unit: Kiahuna 3BR",
//     "Unit 2: ..."), which every builder-generated AD with >= 1 unit emits.
// Prose mentions ("we'll send your door and lockbox codes") never match, and
// the zero-unit "I am still confirming the final unit access details" variant
// deliberately doesn't either — a promise is not a delivery. Address:/Wi-Fi:/
// Parking: lines alone are NOT sufficient (they appear in casual host replies
// answering one-off questions).
const ARRIVAL_DETAILS_SIGNAL_RE = /^((access|door|lockbox|gate|entry) code|unit(?: \d+)?): /im;

export function looksLikeArrivalDetailsMessage(body: string | null | undefined): boolean {
  const text = String(body ?? "");
  if (!text.trim()) return false;
  return ARRIVAL_DETAILS_SIGNAL_RE.test(text);
}

export type ArrivalUnitDetail = {
  id?: number;
  unitLabel: string;
  unitAddress?: string;
  accessCode?: string;
  wifiName?: string;
  wifiPassword?: string;
  parkingInfo?: string;
  managementCompany?: string;
  managementContact?: string;
  arrivalNotes?: string;
};

export const OUTBOUND_SENDER_NAME = "John Carpenter";
export const OUTBOUND_BRAND_NAME = "VacationRentalExpertz";

function formatLongDate(isoYmd: string): string {
  const [y, m, d] = isoYmd.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return isoYmd;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

// Region-aware greeting + sign-off. Hawaii stays open with "Aloha [name],"
// and close with "Mahalo,"; mainland (e.g. Florida) stays use "Hi [name],"
// and "Thanks,". Mirrors the inbox composer's guestGreeting/guestSignoffLines
// so every surface speaks in the same voice. Defaults to Hawaii when the caller
// does not pass a region, since the current portfolio is Hawaii.
function arrivalGreeting(firstName: string, isHawaii: boolean): string {
  const name = String(firstName ?? "").trim();
  const opener = isHawaii ? "Aloha" : "Hi";
  return name ? `${opener} ${name},` : `${opener} there,`;
}

// Quo/OpenPhone rejects bodies over 1,600 chars (sendQuoSms throws). Target a
// comfortable margin below that so the operator can still edit before sending.
export const ARRIVAL_SMS_HARD_LIMIT = 1600;
export const ARRIVAL_SMS_TARGET_LIMIT = 1400;

function formatShortDate(isoYmd: string): string {
  const [y, m, d] = isoYmd.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return isoYmd;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/**
 * Compact SMS variant of the arrival-details message. Same facts as the
 * channel message, none of the long prose: greeting + check-in date, per-unit
 * address/code/Wi-Fi/parking/notes lines, short reply invitation, sign-off.
 * ASCII only. If the assembled text would exceed the target limit it sheds
 * detail gracefully (notes first, then parking, then local contact) and as a
 * last resort hard-truncates under the Quo 1,600-char ceiling — a too-long
 * body would otherwise fail the send outright.
 */
export function buildArrivalDetailsSmsMessage(args: {
  guestFirstName: string;
  propertyName: string;
  checkInIso?: string;
  units: ArrivalUnitDetail[];
  isHawaii?: boolean;
}): string {
  const isHawaii = args.isHawaii ?? true;
  const name = String(args.guestFirstName ?? "").trim();

  const assemble = (level: number): string => {
    const lines: string[] = [];
    lines.push(
      `${isHawaii ? "Aloha" : "Hi"}${name ? ` ${name}` : ""} - arrival details for your stay${args.propertyName ? ` at ${args.propertyName}` : ""}${args.checkInIso ? ` (check-in ${formatShortDate(args.checkInIso)})` : ""}:`,
    );
    if (args.units.length === 0) {
      lines.push("");
      lines.push("We are still confirming the final unit access details and will text them shortly.");
    }
    args.units.forEach((unit, index) => {
      lines.push("");
      lines.push(`${args.units.length > 1 ? `Unit ${index + 1}: ` : ""}${unit.unitLabel}`);
      if (unit.unitAddress) lines.push(`Address: ${unit.unitAddress}`);
      if (unit.accessCode) lines.push(`Access code: ${unit.accessCode}`);
      if (unit.wifiName || unit.wifiPassword) {
        lines.push(`Wi-Fi: ${unit.wifiName || "Network TBD"}${unit.wifiPassword ? ` / ${unit.wifiPassword}` : ""}`);
      }
      // Detail-shedding ladder: level 0 = everything, 1 = drop notes,
      // 2 = drop parking + local contact too (codes/address/Wi-Fi never shed).
      if (level < 2 && unit.parkingInfo) lines.push(`Parking: ${unit.parkingInfo}`);
      if (level < 2 && (unit.managementCompany || unit.managementContact)) {
        lines.push(`Local contact: ${[unit.managementCompany, unit.managementContact].filter(Boolean).join(" - ")}`);
      }
      if (level < 1 && unit.arrivalNotes) lines.push(`Notes: ${unit.arrivalNotes}`);
    });
    lines.push("");
    lines.push(`Reply here with any questions. ${isHawaii ? "Mahalo" : "Thanks"}, ${OUTBOUND_SENDER_NAME} - ${OUTBOUND_BRAND_NAME}`);
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  };

  for (let level = 0; level <= 2; level++) {
    const text = assemble(level);
    if (text.length <= ARRIVAL_SMS_TARGET_LIMIT) return text;
  }
  const minimal = assemble(2);
  return minimal.length <= ARRIVAL_SMS_HARD_LIMIT
    ? minimal
    : `${minimal.slice(0, ARRIVAL_SMS_HARD_LIMIT - 3)}...`;
}

/** Guest-facing arrival-details message body (Guesty / VRBO / Booking.com thread). */
export function buildArrivalDetailsGuestMessage(args: {
  guestFirstName: string;
  propertyName: string;
  checkInIso?: string;
  units: ArrivalUnitDetail[];
  isHawaii?: boolean;
}): string {
  const isHawaii = args.isHawaii ?? true;
  const lines: string[] = [
    arrivalGreeting(args.guestFirstName, isHawaii),
    "",
    `Your stay${args.propertyName ? ` at ${args.propertyName}` : ""} is coming up, so I wanted to send the arrival details for the unit${args.units.length === 1 ? "" : "s"} you will be staying in.`,
  ];
  if (args.checkInIso) {
    lines.push("");
    lines.push(`Check-in date: ${formatLongDate(args.checkInIso.slice(0, 10))}`);
  }
  lines.push("");
  if (args.units.length === 0) {
    lines.push("I am still confirming the final unit access details and will send them shortly.");
  } else {
    args.units.forEach((unit, index) => {
      lines.push(`${args.units.length > 1 ? `Unit ${index + 1}` : "Unit"}: ${unit.unitLabel}`);
      if (unit.unitAddress) lines.push(`Address: ${unit.unitAddress}`);
      if (unit.accessCode) lines.push(`Access code: ${unit.accessCode}`);
      if (unit.wifiName || unit.wifiPassword) {
        lines.push(`Wi-Fi: ${unit.wifiName || "Network TBD"}${unit.wifiPassword ? ` / ${unit.wifiPassword}` : ""}`);
      }
      if (unit.parkingInfo) lines.push(`Parking: ${unit.parkingInfo}`);
      if (unit.managementCompany || unit.managementContact) {
        lines.push(`Local contact: ${[unit.managementCompany, unit.managementContact].filter(Boolean).join(" - ")}`);
      }
      if (unit.arrivalNotes) lines.push(`Notes: ${unit.arrivalNotes}`);
      lines.push("");
    });
  }
  lines.push("A quick note: the listing photos are representative sample photos for this bundled stay. The exact assigned units may vary, but they are matched to the same bedroom count and resort/community standard.");
  lines.push("");
  lines.push("Please reply here if anything looks unclear before arrival — we are glad to help.");
  lines.push("");
  lines.push(isHawaii ? "Mahalo," : "Thanks,");
  lines.push(OUTBOUND_SENDER_NAME);
  lines.push(OUTBOUND_BRAND_NAME);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
