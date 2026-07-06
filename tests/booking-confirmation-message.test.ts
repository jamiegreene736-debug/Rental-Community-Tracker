// Network-free unit tests for shared/booking-confirmation-message.ts — the
// day-of-booking "unit setup confirmation" body sent by
// server/booking-confirmations.ts.
import { buildBookingConfirmationMessage, type BookingConfirmationStay } from "../shared/booking-confirmation-message";

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
check("closes Mahalo + signature", hi.includes("\nMahalo,\nJohn Carpenter\nVacationRentalExpertz"), hi);
check("names the listing booked", hi.includes("Gorgeous Princeville 6 bedroom condos for 16!"), hi);
check("explains the multi-unit setup", hi.includes("booked across 2 separate units within Mauna Kai"), hi);
check("walk phrase (3 min)", hi.includes("about a 3-minute walk apart on the resort grounds"), hi);
check("stay specifics: bedrooms + sleeps (occupancy 6BR=16)", hi.includes("6 bedrooms that comfortably sleep up to 16 guests"), hi);
check("next steps: unit assignments in arrival details", hi.includes("unit assignments, door and lockbox codes"), hi);
check("next steps: 14-day arrival promise", hi.includes("About 14 days before your check-in date"), hi);
check("no party clause when party unknown", !hi.includes("plenty of room for your group"), hi);

console.log("booking-confirmation-message: ASCII-clean (Booking.com safe)");
// No em-dash, en-dash, curly quotes, or bullet glyphs anywhere in the body.
const banned = /[–—‘’“”•…]/;
check("no non-ASCII typographic characters", !banned.test(hi), JSON.stringify(hi.match(banned)));
check("every apostrophe is a straight quote", (hi.match(/['']/g) ?? []).every((c) => c === "'"), hi);

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
});
check("opens Hi (not Aloha)", fl.startsWith("Hi Michelle,"), fl);
check("no Aloha anywhere", !fl.includes("Aloha"), fl);
check("no Mahalo anywhere", !fl.includes("Mahalo"), fl);
check("no 'ohana (uses family)", !fl.includes("'ohana") && fl.includes("your family"), fl);
check("closes Thanks + signature", fl.includes("\nThanks,\nJohn Carpenter\nVacationRentalExpertz"), fl);
check("opens body with Thank you (not Mahalo)", fl.includes("Thank you for booking"), fl);

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

console.log("booking-confirmation-message: graceful degradation");
const noName = buildBookingConfirmationMessage({ ...base, guestFirstName: "" });
check("greeting drops missing name", noName.startsWith("Aloha,"), noName);
const noBeds = buildBookingConfirmationMessage({ ...base, totalBedrooms: 0 });
check("unknown bedrooms: still explains units, omits sleeps sentence", noBeds.includes("booked across 2 separate units") && !noBeds.includes("comfortably sleep up to"), noBeds);

console.log(`\nbooking-confirmation-message: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
