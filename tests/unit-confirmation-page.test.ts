// Locks the 2026-07-19 bookings-row changes:
// 1. "Send unit confirmation to guest" — the /alternatives guest page's
//    pageKind "unit-confirmation" (same machinery as the relocation page, with
//    the relocation framing swapped for confirmation copy) + the shared
//    buildUnitConfirmationGuestMessage draft.
// 2. "Mark as bought in" — the operator-recorded purchase affordance that
//    REPLACED the old "Buy this unit in" sidecar-checkout trigger (the server
//    scaffold in server/buy-in-checkout-job.ts stays dormant; only the client
//    trigger was removed).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildUnitConfirmationGuestMessage } from "../shared/unit-confirmation-message";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${detail !== undefined ? ` — ${String(detail)}` : ""}`);
  }
};

console.log("unit-confirmation: message builder");

const twoUnitMessage = buildUnitConfirmationGuestMessage({
  guestName: "Thien Tran",
  confirmationUrl: "https://example.com/alternatives/abc123",
  units: [
    { bedrooms: 3, sleeps: 8 },
    { bedrooms: 2, sleeps: 6 },
  ],
  totalSleeps: 14,
  partySize: 12,
  walkMinutes: 4,
});

check("greets by first name", twoUnitMessage.startsWith("Hi Thien,"));
check("spells out each unit's bedrooms + sleeps",
  twoUnitMessage.includes("The first unit has 3 bedrooms and sleeps up to 8 guests")
  && twoUnitMessage.includes("the second unit has 2 bedrooms and sleeps up to 6 guests"));
check("claims the combined sleeps + party fit",
  twoUnitMessage.includes("Together they sleep up to 14 guests, so your party of 12 will fit comfortably."));
check("page URL sits on its OWN line (Booking.com link delivery)",
  twoUnitMessage.split("\n").includes("https://example.com/alternatives/abc123"));
check("includes the walk-between-units line",
  twoUnitMessage.includes("about a 4-minute walk from each other"));
check("asks the guest to confirm everything looks as expected",
  /let me know that everything looks as you expected/.test(twoUnitMessage));
check("signed like every guest message", twoUnitMessage.trimEnd().endsWith("Mahalo,\nJohn Carpenter"));
check("NEVER relocation-framed (no apology/move/refund/comparable/alternative)",
  // The page URL's real-world path is /alternatives/:token — exclude the URL
  // line; the COPY itself must never carry relocation vocabulary.
  !/sorry|moved|relocat|refund|comparable|alternative|replacement/i.test(
    twoUnitMessage.split("\n").filter((line) => !/^https?:\/\//.test(line)).join("\n"),
  ));
check("plain ASCII by construction (Booking.com-safe)",
  /^[\x09\x0A\x0D\x20-\x7E]*$/.test(twoUnitMessage));
check("no labeled access-code lines (arrival-details matcher must not fire)",
  !/code:/i.test(twoUnitMessage));

const singleUnitMessage = buildUnitConfirmationGuestMessage({
  guestName: "Cheryl Parker",
  confirmationUrl: "https://example.com/alternatives/tok",
  units: [{ bedrooms: 2, sleeps: 6 }],
  totalSleeps: 6,
  partySize: 4,
  walkMinutes: 9,
});
check("single unit reads 'The unit has …' (no ordinal)",
  singleUnitMessage.includes("The unit has 2 bedrooms and sleeps up to 6 guests.")
  && !singleUnitMessage.includes("first unit"));
check("single unit gets NO walk line even when minutes are present",
  !singleUnitMessage.includes("walk from each other"));
check("single unit uses the singular 'unit you will be staying in'",
  singleUnitMessage.includes("the exact unit you will be staying in"));

const sameBuildingMessage = buildUnitConfirmationGuestMessage({
  guestName: "A B",
  confirmationUrl: "https://example.com/alternatives/tok2",
  units: [{ bedrooms: 2, sleeps: 4 }, { bedrooms: 2, sleeps: 4 }],
  sameBuilding: true,
  walkMinutes: 3,
});
check("same building beats the walk line",
  sameBuildingMessage.includes("Both units are in the same building")
  && !sameBuildingMessage.includes("walk from each other"));

const noFactsMessage = buildUnitConfirmationGuestMessage({
  guestName: "Guest",
  confirmationUrl: "https://example.com/alternatives/tok3",
  units: [{}, {}],
});
check("placeholder 'Guest' name → neutral greeting", noFactsMessage.startsWith("Hi,"));
check("no capacity facts → nothing invented",
  !/bedroom|sleeps/i.test(noFactsMessage));

const partialFit = buildUnitConfirmationGuestMessage({
  guestName: "C D",
  confirmationUrl: "https://example.com/alternatives/tok4",
  units: [{ bedrooms: 2, sleeps: 4 }, { bedrooms: 1, sleeps: 2 }],
  totalSleeps: 6,
  partySize: 8,
});
check("no comfort-fit claim when the party outnumbers the combined sleeps",
  partialFit.includes("Together they sleep up to 6 guests.")
  && !partialFit.includes("fit comfortably"));

// ── Source assertions: the wiring in routes.ts + bookings.tsx ───────────────
console.log("unit-confirmation: source wiring");
const here = path.dirname(fileURLToPath(import.meta.url));
const routesSrc = fs.readFileSync(path.join(here, "..", "server", "routes.ts"), "utf8");
const bookingsSrc = fs.readFileSync(path.join(here, "..", "client", "src", "pages", "bookings.tsx"), "utf8");

check("routes: POST accepts pageKind (unit-confirmation vs default relocation)",
  routesSrc.includes('req.body?.pageKind === "unit-confirmation"'));
check("routes: pageKind persisted on the page payload",
  routesSrc.includes("pageKind,\n        reservationId,"));
check("routes: confirmation pages return the shared confirmation draft",
  routesSrc.includes('from "@shared/unit-confirmation-message"')
  && routesSrc.includes("buildUnitConfirmationGuestMessage({"));
check("routes: GET branches on the persisted page kind",
  routesSrc.includes('const pageIsConfirmation = payload.pageKind === "unit-confirmation";')
  && routesSrc.includes("Your Units for Your Stay"));
check("routes: confirmation page renders the exact-units intro",
  routesSrc.includes("with the exact photos of"));
check("routes: relocation-only chips suppressed on confirmation pages",
  routesSrc.includes("!pageIsConfirmation && pageSameCommunity")
  && routesSrc.includes("!pageIsConfirmation && !pageSameCommunity && Number.isFinite(communityDriveMinutes)"));
check("routes: AI unit copy told the unit is confirmed, never an alternative",
  routesSrc.includes("When confirmationPage is true"));
check("routes: deterministic fallback copy drops 'comparable' on confirmation pages",
  routesSrc.includes("is reserved for your stay"));
check("routes: sent-status exposes the sent page's kind for the row badge",
  routesSrc.includes('pageKind: (sent.payload as any)?.pageKind === "unit-confirmation"'));

check("bookings: 'Send unit confirmation to guest' button next to Alternative Unit",
  bookingsSrc.includes("Send unit confirmation to guest")
  && bookingsSrc.includes("button-send-unit-confirmation-"));
check("bookings: the confirmation button reuses the relocation dialog with kind",
  bookingsSrc.includes('setRelocateGuestTarget({ reservation: r, kind: "unit-confirmation" })')
  && bookingsSrc.includes('pageKind: isConfirmation ? "unit-confirmation" : "relocation"')
  && bookingsSrc.includes("data.confirmationMessage"));
check("bookings: row badge is kind-aware",
  bookingsSrc.includes("Unit confirmation sent"));

// ── "Mark as bought in" replaced the old "Buy this unit in" trigger ─────────
console.log("unit-confirmation: bought-in marking");
check("bookings: operator can record a completed purchase (PATCH booked)",
  bookingsSrc.includes("Mark as bought in")
  && bookingsSrc.includes("button-mark-bought-in-")
  && bookingsSrc.includes('{ bookingStatus: "booked" }'));
check("bookings: the payment handoff offers the PAID exit next to the reset",
  bookingsSrc.includes("Paid — mark booked")
  && bookingsSrc.includes("Not paid — reset"));
check("bookings: the old 'Buy this unit in' checkout trigger is GONE (client no longer drives the dormant sidecar checkout job)",
  !bookingsSrc.includes("Buy this unit in")
  && !bookingsSrc.includes("/api/operations/buy-in-checkout")
  && !bookingsSrc.includes("BuyThisUnitInButton"));
check("bookings: durable checkout lifecycle badges survive (awaiting_payment / request_submitted)",
  bookingsSrc.includes('data-booking-status="awaiting_payment"')
  && bookingsSrc.includes('data-booking-status="request_submitted"'));

console.log(`\nunit-confirmation-page: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
