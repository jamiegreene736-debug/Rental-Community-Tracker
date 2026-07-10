// Network-free unit tests for shared/booking-confirmation-message.ts — the
// day-of-booking "unit setup confirmation" body sent by
// server/booking-confirmations.ts.
import {
  buildBookingConfirmationMessage,
  nightsBetweenYmd,
  scheduledBalanceDueFromReservation,
  type BookingConfirmationStay,
} from "../shared/booking-confirmation-message";
import { looksLikeArrivalDetailsMessage } from "../shared/arrival-details-message";
import { hawaiianIslandLabel, resolveIslandRegion } from "../shared/area-identity";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

const base: BookingConfirmationStay = {
  guestFirstName: "Michelle",
  propertyName: "Gorgeous Princeville 6 bedroom condos for 16!",
  resortName: "Mauna Kai",
  unitCount: 2,
  totalBedrooms: 6,
  walkMinutes: 3,
  isHawaii: true,
  partyTotal: null,
};

console.log("booking-confirmation-message: Hawaii multi-unit");
const hi = buildBookingConfirmationMessage(base);
check("opens Aloha + name", hi.startsWith("Aloha Michelle,"), hi);
check("Hawaiian 'ohana", hi.includes("'ohana"), hi);
check("E komo mai welcome touch", hi.includes("E komo mai!"), hi);
check("closes Mahalo + signature", hi.includes("\nMahalo,\nJohn Carpenter\nVacationRentalExpertz"), hi);
check("names the listing booked", hi.includes("Gorgeous Princeville 6 bedroom condos for 16!"), hi);
check("explains the multi-unit setup", hi.includes("booked across 2 separate units within Mauna Kai"), hi);
check("walk phrase (3 min)", hi.includes("about a 3-minute walk apart on the resort grounds"), hi);
check("stay specifics: bedrooms + sleeps (occupancy 6BR=16)", hi.includes("6 bedrooms that comfortably sleep up to 16 guests"), hi);
check("next steps: unit assignments in arrival details", hi.includes("unit assignments, door and lockbox codes"), hi);
check("next steps: 14-day arrival promise", hi.includes("About 14 days before your check-in date"), hi);
check("no party clause when party unknown", !hi.includes("plenty of room for your group"), hi);
check("no island mention when islandName absent", !hi.includes("here on "), hi);

console.log("booking-confirmation-message: representative-photos expectation");
check(
  "representative line present (multi-unit)",
  hi.includes("the listing photos show the style and standard of our units at Mauna Kai"),
  hi,
);
check(
  "representative line matches the inbox timeline's unit-setup detection (assigned units will match)",
  /assigned units will match/i.test(hi),
  hi,
);
check("representative line admits small variation", hi.includes("can vary a little"), hi);

console.log("booking-confirmation-message: timeline / arrival-details cross-guards");
check("never claims to BE arrival details (looksLikeArrivalDetailsMessage false)", !looksLikeArrivalDetailsMessage(hi), hi);
check("never says 'remaining balance' (invoice-step regex guard)", !/remaining balance/i.test(hi), hi);

console.log("booking-confirmation-message: stay specifics block");
const detailed = buildBookingConfirmationMessage({
  ...base,
  islandName: "Kauai",
  checkInIso: "2026-07-20",
  checkOutIso: "2026-07-27",
  nights: 7,
  confirmationCode: "HMABC123",
  balanceDue: { amountUsd: 2612, dueIso: "2026-03-20T10:00:00.000Z" },
});
check("at-a-glance header", detailed.includes("Your stay at a glance:"), detailed);
check("check-in long date", detailed.includes("- Check-in: Monday, July 20, 2026"), detailed);
check("check-out long date + nights", detailed.includes("- Check-out: Monday, July 27, 2026 (7 nights)"), detailed);
check("confirmation code line", detailed.includes("- Confirmation code: HMABC123"), detailed);
check("island mention (here on Kauai)", detailed.includes("welcome you to Mauna Kai here on Kauai."), detailed);
check(
  "scheduled balance line (amount + long date, 'automatically')",
  detailed.includes("- The balance of $2,612.00 is scheduled to be collected automatically on Friday, March 20, 2026"),
  detailed,
);
check("detailed body still not arrival details", !looksLikeArrivalDetailsMessage(detailed), detailed);
check("detailed body avoids 'remaining balance'", !/remaining balance/i.test(detailed), detailed);
const noDates = buildBookingConfirmationMessage({ ...base, confirmationCode: "HMABC123" });
check("no at-a-glance block without dates (code alone doesn't render)", !noDates.includes("Your stay at a glance:") && !noDates.includes("Confirmation code:"), noDates);
const noBalance = buildBookingConfirmationMessage({ ...base, checkInIso: "2026-07-20", balanceDue: null });
check("no balance line when balanceDue null", !noBalance.includes("scheduled to be collected"), noBalance);
const singleNight = buildBookingConfirmationMessage({ ...base, checkInIso: "2026-07-20", checkOutIso: "2026-07-21", nights: 1 });
check("singular night suffix", singleNight.includes("(1 night)"), singleNight);

console.log("booking-confirmation-message: ASCII-clean (Booking.com safe)");
// No em-dash, en-dash, curly quotes, or bullet glyphs anywhere in the body —
// checked on the FULLY-populated variant so every new line is covered.
const banned = /[–—‘’“”•…]/;
check("no non-ASCII typographic characters", !banned.test(detailed), JSON.stringify(detailed.match(banned)));
check("every apostrophe is a straight quote", (detailed.match(/['']/g) ?? []).every((c) => c === "'"), detailed);

console.log("booking-confirmation-message: party clause");
const fits = buildBookingConfirmationMessage({ ...base, partyTotal: 12 });
check("party clause appears when party fits (12 <= 16)", fits.includes("with plenty of room for your group of 12"), fits);
const over = buildBookingConfirmationMessage({ ...base, partyTotal: 20 });
check("party clause hidden when party exceeds capacity (20 > 16)", !over.includes("plenty of room for your group"), over);

console.log("booking-confirmation-message: walk <= 1 min");
const steps = buildBookingConfirmationMessage({ ...base, walkMinutes: 1 });
check("steps-apart phrasing at <=1 min", steps.includes("just steps apart on the resort grounds"), steps);
check("no N-minute phrasing at <=1 min", !steps.includes("minute walk apart"), steps);

console.log("booking-confirmation-message: mainland (Florida) voice");
const fl = buildBookingConfirmationMessage({
  ...base,
  resortName: "Bonita National",
  isHawaii: false,
  islandName: "Kauai", // deliberately wrong input — mainland voice must ignore it
  checkInIso: "2026-07-20",
});
check("opens Hi (not Aloha)", fl.startsWith("Hi Michelle,"), fl);
check("no Aloha anywhere", !fl.includes("Aloha"), fl);
check("no Mahalo anywhere", !fl.includes("Mahalo"), fl);
check("no 'ohana (uses family)", !fl.includes("'ohana") && fl.includes("your family"), fl);
check("no E komo mai on mainland", !fl.includes("E komo mai"), fl);
check("no island mention on mainland (even when passed)", !fl.includes("here on "), fl);
check("closes Thanks + signature", fl.includes("\nThanks,\nJohn Carpenter\nVacationRentalExpertz"), fl);
check("opens body with Thank you (not Mahalo)", fl.includes("Thank you for booking"), fl);
check("mainland still gets the representative line", fl.includes("the listing photos show the style and standard of our units at Bonita National"), fl);

console.log("booking-confirmation-message: single-unit variant");
const single = buildBookingConfirmationMessage({
  ...base,
  unitCount: 1,
  totalBedrooms: 3,
  propertyName: "Cozy 3BR at Kaha Lani",
  resortName: "Kaha Lani",
});
check("no 'separate units' language", !single.includes("separate units"), single);
check("no walk phrase", !single.includes("walk apart") && !single.includes("steps apart"), single);
check("no 'unit assignments' in arrival details", !single.includes("unit assignments"), single);
check("states the single-unit bedrooms", single.includes("a 3-bedroom unit at Kaha Lani"), single);
check("still promises arrival details 14 days out", single.includes("About 14 days before your check-in date"), single);
check("single-unit representative line (singular)", single.includes("Your assigned unit will match the same bedroom count and quality shown"), single);
check("single-unit body not arrival details", !looksLikeArrivalDetailsMessage(single), single);

console.log("booking-confirmation-message: graceful degradation");
const noName = buildBookingConfirmationMessage({ ...base, guestFirstName: "" });
check("greeting drops missing name", noName.startsWith("Aloha,"), noName);
const noBeds = buildBookingConfirmationMessage({ ...base, totalBedrooms: 0 });
check("unknown bedrooms: still explains units, omits sleeps sentence", noBeds.includes("booked across 2 separate units") && !noBeds.includes("comfortably sleep up to"), noBeds);

console.log("booking-confirmation-message: scheduledBalanceDueFromReservation guards");
const NOW = Date.UTC(2026, 6, 10, 12);
// The verified real Guesty scheduled-row shape (see guesty-payment-schedule.ts
// header): amount + shouldBePaidAt, no dueAt/paidAt.
const scheduledRow = { status: "PENDING", amount: 2612, shouldBePaidAt: "2026-08-25T01:00:00.000Z", createdAt: "2026-07-10T03:06:10.396Z" };
const payable = {
  money: { totalPrice: 5224, totalPaid: 2612, isFullyPaid: false, payments: [
    { status: "SUCCEEDED", amount: 2612, paidAt: "2026-07-10T00:00:00.000Z" },
    scheduledRow,
  ] },
};
const due = scheduledBalanceDueFromReservation(payable, NOW);
check("real scheduled charge → balance + shouldBePaidAt date", due?.amountUsd === 2612 && due?.dueIso?.slice(0, 10) === "2026-08-25", due);
check(
  "Booking.com quirk (isFullyPaid:true, totalPaid:0) → no balance claim",
  scheduledBalanceDueFromReservation({ money: { ...payable.money, isFullyPaid: true, totalPaid: 0 } }, NOW) === null,
);
check(
  "nothing collected yet (totalPaid 0, not fully paid) → stay quiet",
  scheduledBalanceDueFromReservation({ money: { ...payable.money, totalPaid: 0 } }, NOW) === null,
);
check(
  "no scheduled row → no line",
  scheduledBalanceDueFromReservation({ money: { totalPrice: 5224, totalPaid: 2612, payments: [] } }, NOW) === null,
);
check(
  "multi-installment (next row amount != outstanding balance) → omit rather than misstate",
  scheduledBalanceDueFromReservation(
    { money: { totalPrice: 5224, totalPaid: 1000, payments: [
      { status: "PENDING", amount: 2112, shouldBePaidAt: "2026-08-25T01:00:00.000Z" },
      { status: "PENDING", amount: 2112, shouldBePaidAt: "2026-10-25T01:00:00.000Z" },
    ] } },
    NOW,
  ) === null,
);
check("null-safe", scheduledBalanceDueFromReservation(null, NOW) === null && scheduledBalanceDueFromReservation({}, NOW) === null);

console.log("booking-confirmation-message: nightsBetweenYmd");
check("7-night week", nightsBetweenYmd("2026-07-20", "2026-07-27") === 7);
check("single night", nightsBetweenYmd("2026-07-20", "2026-07-21") === 1);
check("non-positive range → null", nightsBetweenYmd("2026-07-27", "2026-07-20") === null && nightsBetweenYmd("2026-07-20", "2026-07-20") === null);
check("malformed → null", nightsBetweenYmd("", "2026-07-20") === null && nightsBetweenYmd("2026-07-20", "soon") === null);

console.log("booking-confirmation-message: hawaiianIslandLabel gate (area-identity)");
check("Kauai address resolves to island label", hawaiianIslandLabel(resolveIslandRegion("4460 Nehe Rd, Lihue, HI")) === "Kauai");
check("Kona address resolves to the Big Island phrase", hawaiianIslandLabel(resolveIslandRegion("Kailua-Kona, HI")) === "the Big Island of Hawaii");
check("generic Hawaii fallback yields no island label", hawaiianIslandLabel(resolveIslandRegion("Hawaii")) === null);
check("Florida region yields no island label", hawaiianIslandLabel(resolveIslandRegion("Kissimmee, FL")) === null);
check("null-safe", hawaiianIslandLabel(null) === null && hawaiianIslandLabel(undefined) === null);

console.log(`\nbooking-confirmation-message: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
