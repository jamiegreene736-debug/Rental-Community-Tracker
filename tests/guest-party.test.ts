// Network-free unit tests for shared/guest-party.ts — parsing Guesty's two
// numberOfGuests shapes (plain number vs breakdown object) + the display
// formatter used on the bookings rows, the inbox reservation panel, and the
// Cowork buy-in prompts.
import {
  guestPartyFromReservation,
  formatGuestParty,
  guestPartyLabelFromReservation,
} from "../shared/guest-party";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("guest-party: guestPartyFromReservation");

// Full breakdown (Airbnb/VRBO shape).
const vrbo = guestPartyFromReservation({
  guestsCount: 4,
  numberOfGuests: { numberOfAdults: 2, numberOfChildren: 2, numberOfInfants: 1, numberOfPets: 0 },
});
check("breakdown: total from guestsCount", vrbo?.total === 4, vrbo);
check("breakdown: adults", vrbo?.adults === 2, vrbo);
check("breakdown: children", vrbo?.children === 2, vrbo);
check("breakdown: infants", vrbo?.infants === 1, vrbo);
check("breakdown: pets zero preserved", vrbo?.pets === 0, vrbo);

// Total-only (Booking.com often sends just guestsCount).
const bdc = guestPartyFromReservation({ guestsCount: 3 });
check("total-only: total", bdc?.total === 3, bdc);
check("total-only: null breakdown", bdc?.adults === null && bdc?.children === null, bdc);

// Legacy numeric numberOfGuests (the inbox has treated this as a
// guestsCount fallback since 2026 — keep parsing it).
const legacy = guestPartyFromReservation({ numberOfGuests: 5 });
check("legacy numeric numberOfGuests → total", legacy?.total === 5, legacy);

// Breakdown without guestsCount → total derived from adults+children.
const derived = guestPartyFromReservation({
  numberOfGuests: { numberOfAdults: 2, numberOfChildren: 1 },
});
check("derived total = adults + children", derived?.total === 3, derived);

// String counts (defensive — Guesty numbers occasionally arrive as strings).
const stringy = guestPartyFromReservation({ guestsCount: "4", numberOfGuests: { numberOfAdults: "2" } });
check("string counts coerced", stringy?.total === 4 && stringy?.adults === 2, stringy);

// No data at all → null (absence ≠ party of zero).
check("empty reservation → null", guestPartyFromReservation({}) === null);
check("null reservation → null", guestPartyFromReservation(null) === null);
check("zero-only counts → null", guestPartyFromReservation({ guestsCount: 0 }) === null);
check("junk values → null", guestPartyFromReservation({ guestsCount: "lots", numberOfGuests: { numberOfAdults: NaN } }) === null);

console.log("guest-party: formatGuestParty");

check(
  "full breakdown formats with parens",
  formatGuestParty(vrbo) === "4 guests (2 adults, 2 children, 1 infant)",
  formatGuestParty(vrbo),
);
check("total-only formats without parens", formatGuestParty(bdc) === "3 guests", formatGuestParty(bdc));
check(
  "adults-only parens skipped when redundant",
  formatGuestParty(guestPartyFromReservation({ guestsCount: 2, numberOfGuests: { numberOfAdults: 2, numberOfChildren: 0 } })) === "2 guests",
);
check(
  "adults differing from total keeps parens",
  formatGuestParty(guestPartyFromReservation({ guestsCount: 4, numberOfGuests: { numberOfAdults: 2 } })) === "4 guests (2 adults)",
);
check(
  "singulars: 1 guest / 1 child",
  formatGuestParty(guestPartyFromReservation({ numberOfGuests: { numberOfAdults: 0, numberOfChildren: 1 } })) === "1 guest (1 child)",
  formatGuestParty(guestPartyFromReservation({ numberOfGuests: { numberOfAdults: 0, numberOfChildren: 1 } })),
);
check(
  "pets surface",
  formatGuestParty(guestPartyFromReservation({ guestsCount: 2, numberOfGuests: { numberOfAdults: 2, numberOfPets: 1 } })) === "2 guests (2 adults, 1 pet)",
);
check("null party → null label", formatGuestParty(null) === null);
check(
  "one-call convenience matches",
  guestPartyLabelFromReservation({ guestsCount: 4, numberOfGuests: { numberOfAdults: 2, numberOfChildren: 2 } }) === "4 guests (2 adults, 2 children)",
);

console.log(`\nguest-party: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
