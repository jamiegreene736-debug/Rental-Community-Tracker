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

/** Guest-facing arrival-details message body (Guesty / VRBO / Booking.com thread). */
export function buildArrivalDetailsGuestMessage(args: {
  guestFirstName: string;
  propertyName: string;
  checkInIso?: string;
  units: ArrivalUnitDetail[];
}): string {
  const lines: string[] = [
    `Hi ${args.guestFirstName || "there"},`,
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
  lines.push("Please reply here if anything looks unclear before arrival.");
  lines.push("");
  lines.push("Thanks,");
  lines.push(OUTBOUND_SENDER_NAME);
  lines.push(OUTBOUND_BRAND_NAME);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
