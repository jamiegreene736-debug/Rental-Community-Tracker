import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  bookedListingTitleFromEmailText,
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

// ── template: identifies the PM's OWN listing, never just our internal name ──
const withTitle = buildArrivalRequestEmail({
  listingTitle: "Menehune Shores #623 – Top-Floor Penthouse with Stunning Ocean Views",
  listingUrl: "https://www.vrbo.com/753065",
  guestName: "Jacelyn Tsu",
  checkInText: "Jul 21, 2026",
  checkOutText: "Jul 26, 2026",
  fallbackPropertyName: "Menehune Shores - 4BR Condos - Sleeps 12",
  unitLabel: "unit-b",
});
assert.match(withTitle.body, /your listing "Menehune Shores #623 – Top-Floor Penthouse with Stunning Ocean Views" \(https:\/\/www\.vrbo\.com\/753065\)/, "body names the booked listing + URL");
assert.doesNotMatch(withTitle.body, /4BR Condos - Sleeps 12/, "our internal Guesty listing name never leaks when the booked title is known");
assert.match(withTitle.subject, /Menehune Shores #623/, "subject names the booked listing");
assert.match(withTitle.body, /Jacelyn Tsu/, "guest name present");
assert.match(withTitle.body, /from Jul 21, 2026 to Jul 26, 2026/, "stay dates present");
assert.match(withTitle.body, /access code, Wi-Fi, parking/, "request list intact");

const urlOnly = buildArrivalRequestEmail({
  listingUrl: "https://www.vrbo.com/753065",
  guestName: "Jacelyn Tsu",
  fallbackPropertyName: "Menehune Shores - 4BR Condos - Sleeps 12",
  unitLabel: "unit-b",
});
assert.match(urlOnly.body, /your listing https:\/\/www\.vrbo\.com\/753065/, "URL alone still identifies the unit");
assert.doesNotMatch(urlOnly.body, /4BR Condos/, "internal name not used when the URL is known");

const fallbackOnly = buildArrivalRequestEmail({
  guestName: "Jacelyn Tsu",
  fallbackPropertyName: "Menehune Shores",
  unitLabel: "unit-b",
});
assert.match(fallbackOnly.body, /Menehune Shores - unit-b/, "no title/URL falls back to the internal identity");
assert.match(fallbackOnly.subject, /Menehune Shores - unit-b/, "fallback subject keeps the old identity");
console.log("  ✓ template identifies the booked listing (title > URL > fallback)");

// ── source guards: the panel composes through this module ──
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bookingsSrc = readFileSync(path.join(repoRoot, "client", "src", "pages", "bookings.tsx"), "utf8");
assert.ok(bookingsSrc.includes("buildArrivalRequestEmail"), "panel must build compose defaults through buildArrivalRequestEmail");
assert.ok(bookingsSrc.includes("resolveBookedListingTitle"), "panel must resolve the booked listing title");
assert.ok(/emailTexts:\s*\[[\s\S]{0,200}emails\.map/.test(bookingsSrc), "panel must feed the alias-thread emails into title resolution");
assert.ok(/lastComposeDefaultsRef/.test(bookingsSrc), "compose upgrade must be guarded so operator edits are never clobbered");
assert.ok(/setVendorEmail\(\(cur\) => \(cur\.trim\(\) \? cur : savedEmail\)\)/.test(bookingsSrc), "PM email field must populate from the saved mgmt contact without overwriting typed input");
console.log("  ✓ source guards: panel wiring");

console.log("arrival-request-compose suite passed");
