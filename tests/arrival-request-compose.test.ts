import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  bookedListingTitleFromEmailText,
  channelLabelFromListingUrl,
  bookedListingTitleFromNotes,
  buildArrivalRequestEmail,
  resolveBookedListingTitle,
} from "../shared/arrival-request-compose";

console.log("arrival-request-compose suite");

// ── title from buy-in notes (mirrors routes.ts titleFromBuyInNoteText's confident branches) ──
assert.equal(
  bookedListingTitleFromNotes(
    "Manually recorded buy-in for Unit A. Found via Cowork web search — Menehune Shores resort scan — Menehune Shores 106 Oceanfront 2BR. · Booking mode: INSTANT BOOK",
  ),
  "Menehune Shores 106 Oceanfront 2BR",
  "Cowork attach note yields the listing title",
);
assert.equal(
  bookedListingTitleFromNotes("Manually attached from combo poipu — 3BR VRBO — Poipu Sands 421 Ocean View · walkable"),
  "Poipu Sands 421 Ocean View",
  "combo attach note yields the listing title",
);
assert.equal(
  bookedListingTitleFromNotes("Auto-filled from city scan — Kiahuna Plantation 2BR Garden"),
  "Kiahuna Plantation 2BR Garden",
  "auto-fill note yields the listing title",
);
assert.equal(bookedListingTitleFromNotes("Manually recorded buy-in for Unit"), "", "bare boilerplate never becomes a title");
assert.equal(bookedListingTitleFromNotes(""), "", "empty notes yield no title");
console.log("  ✓ notes title extraction (confident branches only)");

// ── title from the VRBO confirmation email (the 2026-07-20 Menehune shape) ──
const vrboConfirmation = [
  "Here are your booking details and next steps.",
  "Get ready for your trip, Jacelyn! Here’s your booking info and other important details.",
  "Hosted by Menehune Shores #623 – Top-Floor Penthouse with Stunning Ocean Views’s rental company",
  "Manage your trip",
  "Share with friends",
  "Menehune Shores #623 – Top-Floor Penthouse with Stunning Ocean Views",
  "",
  "Vrbo reservation ID: 220669",
  "Property ID: 753065",
].join("\n");

assert.equal(
  bookedListingTitleFromEmailText(vrboConfirmation),
  "Menehune Shores #623 – Top-Floor Penthouse with Stunning Ocean Views",
  "Hosted-by line yields the booked listing title with the rental-company suffix stripped",
);
// Without the Hosted-by line the standalone title above "Vrbo reservation ID:" wins.
const noHostedBy = vrboConfirmation.split("\n").filter((l) => !/^Hosted by/.test(l)).join("\n");
assert.equal(
  bookedListingTitleFromEmailText(noHostedBy),
  "Menehune Shores #623 – Top-Floor Penthouse with Stunning Ocean Views",
  "title line above the reservation-ID line is found",
);
assert.equal(bookedListingTitleFromEmailText("Your reservation has been confirmed\nManage your trip"), "", "generic lines never become titles");
assert.equal(bookedListingTitleFromEmailText(""), "", "empty text yields no title");
console.log("  ✓ VRBO confirmation-email title extraction");

// ── resolution order: notes beat thread emails ──
assert.equal(
  resolveBookedListingTitle({
    notes: "Found via Cowork web search — scope — Notes Title Wins Here",
    emailTexts: [vrboConfirmation],
  }),
  "Notes Title Wins Here",
  "notes title wins over thread emails",
);
assert.equal(
  resolveBookedListingTitle({ notes: "", emailTexts: ["junk", vrboConfirmation] }),
  "Menehune Shores #623 – Top-Floor Penthouse with Stunning Ocean Views",
  "thread email fills in when notes have no title",
);
assert.equal(resolveBookedListingTitle({ notes: null, emailTexts: [] }), "", "nothing confident yields empty");
console.log("  ✓ resolution order");

// ── channel label from the booked listing URL ──
assert.equal(channelLabelFromListingUrl("https://www.vrbo.com/753065"), "VRBO");
assert.equal(channelLabelFromListingUrl("https://www.abritel.fr/location/p123"), "VRBO", "VRBO brand family maps to VRBO");
assert.equal(channelLabelFromListingUrl("https://www.booking.com/hotel/us/x.html"), "Booking.com");
assert.equal(channelLabelFromListingUrl("https://www.airbnb.co.uk/rooms/1"), "Airbnb");
assert.equal(channelLabelFromListingUrl("https://www.waikikibeachrentals.com/unit/7b"), "", "PM/direct sites get no channel mention");
assert.equal(channelLabelFromListingUrl(""), "");
console.log("  ✓ channel label derivation");

// ── template: the operator's 2026-07-20 hand-edited shape ──
const withTitle = buildArrivalRequestEmail({
  listingTitle: "Menehune Shores #623 – Top-Floor Penthouse with Stunning Ocean Views",
  listingUrl: "https://www.vrbo.com/753065",
  guestName: "Jacelyn Tsu",
  checkInText: "Jul 21, 2026",
  checkOutText: "Jul 26, 2026",
  paidInFull: true,
  fallbackPropertyName: "Menehune Shores - 4BR Condos - Sleeps 12",
  unitLabel: "unit-b",
});
assert.match(
  withTitle.body,
  /We booked your listing "Menehune Shores #623 – Top-Floor Penthouse with Stunning Ocean Views" on VRBO from Jul 21, 2026 to Jul 26, 2026\. Everything should be paid in full\./,
  "body matches the operator's edited sentence: title + channel + dates + paid-in-full",
);
assert.doesNotMatch(withTitle.body, /https:\/\//, "raw listing URL removed when the title is known");
assert.doesNotMatch(withTitle.body, /booked .* for Jacelyn/, "'for <guest>' clause removed from the booked sentence");
assert.doesNotMatch(withTitle.body, /4BR Condos - Sleeps 12/, "our internal Guesty listing name never leaks when the booked title is known");
assert.match(withTitle.subject, /Menehune Shores #623/, "subject names the booked listing");
assert.match(withTitle.body, /Thank you,\nJacelyn Tsu/, "still signed as the guest");
assert.match(withTitle.body, /access code, Wi-Fi, parking/, "request list intact");

// Unbooked unit: no paid-in-full claim.
const notPaid = buildArrivalRequestEmail({
  listingTitle: "Menehune Shores #623",
  listingUrl: "https://www.vrbo.com/753065",
  guestName: "Jacelyn Tsu",
  paidInFull: false,
});
assert.doesNotMatch(notPaid.body, /paid in full/, "paid-in-full only claimed for booked units");

const urlOnly = buildArrivalRequestEmail({
  listingUrl: "https://www.vrbo.com/753065",
  guestName: "Jacelyn Tsu",
  fallbackPropertyName: "Menehune Shores - 4BR Condos - Sleeps 12",
  unitLabel: "unit-b",
});
assert.match(urlOnly.body, /your listing https:\/\/www\.vrbo\.com\/753065/, "URL survives as the identifier of LAST RESORT (no title)");
assert.doesNotMatch(urlOnly.body, /4BR Condos/, "internal name not used when the URL is known");

const fallbackOnly = buildArrivalRequestEmail({
  guestName: "Jacelyn Tsu",
  fallbackPropertyName: "Menehune Shores",
  unitLabel: "unit-b",
});
assert.match(fallbackOnly.body, /Menehune Shores - unit-b/, "no title/URL falls back to the internal identity");
assert.match(fallbackOnly.subject, /Menehune Shores - unit-b/, "fallback subject keeps the old identity");
console.log("  ✓ template matches the operator's edited shape (no URL/'for guest'; channel + paid-in-full)");

// ── source guards: the panel composes through this module ──
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bookingsSrc = readFileSync(path.join(repoRoot, "client", "src", "pages", "bookings.tsx"), "utf8");
assert.ok(bookingsSrc.includes("buildArrivalRequestEmail"), "panel must build compose defaults through buildArrivalRequestEmail");
assert.ok(bookingsSrc.includes("resolveBookedListingTitle"), "panel must resolve the booked listing title");
assert.ok(/emailTexts:\s*\[[\s\S]{0,200}emails\.map/.test(bookingsSrc), "panel must feed the alias-thread emails into title resolution");
assert.ok(/lastComposeDefaultsRef/.test(bookingsSrc), "compose upgrade must be guarded so operator edits are never clobbered");
assert.ok(
  (bookingsSrc.match(/paidInFull: buyIn\.bookingStatus === "booked"/g) ?? []).length >= 2,
  "both compose call sites must gate paid-in-full on the booked status",
);
assert.ok(/setVendorEmail\(\(cur\) => \(cur\.trim\(\) \? cur : savedEmail\)\)/.test(bookingsSrc), "PM email field must populate from the saved mgmt contact without overwriting typed input");
console.log("  ✓ source guards: panel wiring");

console.log("arrival-request-compose suite passed");
