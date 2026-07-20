// Network-free unit tests for shared/listing-stay-dates.ts — the ONE home for
// appending a stay's check-in/check-out to a listing URL so the click lands
// with the dates pre-filled (operator ask, 2026-07-19). Also source-locks the
// three wirings: routes.ts's find-buy-in withStayDates delegates here, the
// bookings-page attached-unit link decorates via the same helper, and the
// Cowork find prompt requires the ATTACHED URL to carry the dates.
import { readFileSync } from "fs";
import {
  stayDateSourceForUrl,
  toStayDateYmd,
  withListingStayDates,
} from "../shared/listing-stay-dates";
import { buildCoworkBuyInPrompt, type CoworkBuyInPromptInput } from "../shared/cowork-buyin-prompt";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("listing-stay-dates: date normalization");

check("plain YMD passes through", toStayDateYmd("2026-07-20") === "2026-07-20");
check("ISO datetime keeps its stated calendar day (no TZ math)",
  toStayDateYmd("2026-07-20T15:00:00-10:00") === "2026-07-20");
check("whitespace tolerated", toStayDateYmd("  2026-07-20 ") === "2026-07-20");
check("garbage → null", toStayDateYmd("July 20") === null);
check("null → null", toStayDateYmd(null) === null);

console.log("listing-stay-dates: source detection");

check("vrbo detail page → vrbo", stayDateSourceForUrl("https://www.vrbo.com/1234567") === "vrbo");
check("vrbo brand family (fewo-direkt) → vrbo", stayDateSourceForUrl("https://www.fewo-direkt.de/1234567") === "vrbo");
check("booking.com → booking", stayDateSourceForUrl("https://www.booking.com/hotel/us/foo.html") === "booking");
check("airbnb regional → airbnb", stayDateSourceForUrl("https://www.airbnb.co.uk/rooms/99") === "airbnb");
check("unknown PM host → pm", stayDateSourceForUrl("https://www.suiteparadise.com/units/9k") === "pm");

console.log("listing-stay-dates: URL decoration");

const CI = "2026-07-20";
const CO = "2026-07-27";

{
  const out = withListingStayDates("https://www.vrbo.com/1234567", CI, CO);
  const u = new URL(out);
  check("vrbo gets startDate/endDate", u.searchParams.get("startDate") === CI && u.searchParams.get("endDate") === CO, out);
  check("vrbo also gets legacy arrival/departure", u.searchParams.get("arrival") === CI && u.searchParams.get("departure") === CO, out);
}
{
  const out = withListingStayDates("https://www.booking.com/hotel/us/foo.html?aid=1", CI, CO);
  const u = new URL(out);
  check("booking gets checkin/checkout", u.searchParams.get("checkin") === CI && u.searchParams.get("checkout") === CO, out);
  check("booking keeps existing params", u.searchParams.get("aid") === "1", out);
}
{
  const out = withListingStayDates("https://www.airbnb.com/rooms/55", CI, CO);
  const u = new URL(out);
  check("airbnb gets check_in/check_out", u.searchParams.get("check_in") === CI && u.searchParams.get("check_out") === CO, out);
}
{
  const out = withListingStayDates("https://www.suiteparadise.com/units/9k", CI, CO);
  const u = new URL(out);
  check("pm sprinkle covers every common spelling",
    u.searchParams.get("checkin") === CI && u.searchParams.get("check_in") === CI &&
    u.searchParams.get("arrival") === CI && u.searchParams.get("checkout") === CO &&
    u.searchParams.get("check_out") === CO && u.searchParams.get("departure") === CO, out);
}
{
  // NEVER clobber — a Cowork-attached URL may already carry the right dates.
  const out = withListingStayDates("https://www.vrbo.com/1234567?startDate=2026-08-01", CI, CO);
  const u = new URL(out);
  check("existing param wins (no clobber)", u.searchParams.get("startDate") === "2026-08-01", out);
  check("missing sibling param still filled", u.searchParams.get("endDate") === CO, out);
  const again = withListingStayDates(out, CI, CO);
  check("re-decoration is idempotent", again === out, again);
}
{
  check("explicit source overrides host detection",
    new URL(withListingStayDates("https://example.com/x", CI, CO, "booking")).searchParams.get("group_adults") === "2");
  check("invalid URL passes through untouched", withListingStayDates("not a url", CI, CO) === "not a url");
  check("missing dates → unchanged", withListingStayDates("https://www.vrbo.com/1?x=1", null, CO) === "https://www.vrbo.com/1?x=1");
  check("ISO datetime inputs normalize", new URL(withListingStayDates("https://www.vrbo.com/1", "2026-07-20T15:00:00-10:00", "2026-07-27T10:00:00-10:00")).searchParams.get("startDate") === CI);
  check("empty url → empty string", withListingStayDates(null, CI, CO) === "");
}

console.log("listing-stay-dates: Cowork find prompt requires a DATED attach URL");

const promptInput: CoworkBuyInPromptInput = {
  reservationId: "res-dated-url",
  guestName: "Jane Traveler",
  propertyId: 8,
  propertyName: "Poipu Kai 6BR Combo",
  community: "Poipu Kai",
  checkIn: "2026-07-20",
  checkOut: "2026-07-27",
  units: [
    { unitId: "A", unitLabel: "Unit A", bedrooms: 3 },
    { unitId: "B", unitLabel: "Unit B", bedrooms: 3 },
  ],
  baseUrl: "https://app.example.com/",
};
const prompt = buildCoworkBuyInPrompt(promptInput);
check("create-body URL rule embeds concrete vrbo date params",
  prompt.includes("?startDate=2026-07-20&endDate=2026-07-27"));
check("create-body URL rule embeds concrete booking/direct date params",
  prompt.includes("?checkin=2026-07-20&checkout=2026-07-27"));
check("rule says the click should land with dates already filled",
  /dates already filled/i.test(prompt));

console.log("listing-stay-dates: wiring source guards");

const routesSrc = readFileSync("server/routes.ts", "utf8");
check("routes.ts withStayDates delegates to the shared helper",
  /const withStayDates = \(source: "airbnb" \| "vrbo" \| "booking" \| "pm", rawUrl: string\): string =>\s*\n\s*withListingStayDates\(rawUrl, checkIn, checkOut, source\);/.test(routesSrc));
check("routes.ts imports the shared module",
  routesSrc.includes('from "@shared/listing-stay-dates"'));

const bookingsSrc = readFileSync("client/src/pages/bookings.tsx", "utf8");
check("bookings.tsx decorates the attached-unit link with the buy-in's stay dates",
  bookingsSrc.includes("withListingStayDates(") &&
  /withListingStayDates\(\s*slot\.buyIn\.airbnbListingUrl,\s*slot\.buyIn\.checkIn \?\? r\.checkIn,\s*slot\.buyIn\.checkOut \?\? r\.checkOut,\s*\)/.test(bookingsSrc));
check("bookings.tsx offers the incognito copy affordance (browsers can't open incognito from a page)",
  bookingsSrc.includes("button-copy-incognito-") &&
  bookingsSrc.includes("incognito/private window"));

console.log(`\nlisting-stay-dates: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
