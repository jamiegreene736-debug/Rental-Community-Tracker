// Builds the TWO copy-to-clipboard prompts the operator hands to Cowork (an
// agent session with access to this app). Split into SEPARATE prompts/buttons
// per operator ask 2026-07-05 ("I want the prompt to check out the VRBO to be
// separate from the prompt for finding the unit"):
//
//   1. buildCoworkBuyInPrompt — SEARCH + ATTACH ONLY. Searches the open web
//      (Google, PM company sites, Airbnb/VRBO/Booking) for the cheapest buy-in
//      units and attaches them via the manual-attach API, then reports. It
//      never books anything — the operator reviews the attached picks first.
//   2. buildCoworkCheckoutPrompt — BOOK ONLY. Takes the ALREADY-ATTACHED (and
//      operator-reviewed) units and checks each one out on vrbo.com. Running
//      this prompt IS the operator's approval; it books without a further
//      checkpoint but keeps every money guard below.
//
// LOAD-BEARING (search prompt, operator's spec): same-community first; if one
// or both units can't be found in the configured community, fall back to a
// CITY-WIDE search and STOP THERE — never expand to nearby cities / regions.
// NEVER attach an airbnb.com link (operator, 2026-07-05): the attached URL
// must be VRBO, Booking.com, or a direct booking/PM site. Airbnb is allowed
// for DISCOVERY only — find the same unit's non-Airbnb page and attach that.
// The attach path is the manual method: POST /api/buy-ins (create) then
// POST /api/bookings/:reservationId/attach-buy-in (attach) — one pair, one per
// unit slot. This mirrors `ManualBuyInDialog` in client/src/pages/bookings.tsx.
//
// LOAD-BEARING (checkout prompt, operator's spec 2026-07-05):
//   - At VRBO checkout, select ONLY the damage waiver / property damage
//     protection — decline travel/trip insurance and every other add-on.
//   - The GUEST's name is used for everything name-related INCLUDING the
//     name-on-card field (operator's explicit 2026-07-05 instruction — never
//     the cardholder's own name); the traveler email
//     is the per-guest alias minted by POST /api/buy-ins/:id/traveler-email
//     (firstname.lastname@emailprivaccy.com); phone is the fixed operator
//     booking phone (808 460 6509 — same constant as BUYIN_BOOKING_PHONE).
//   - CARD DETAILS ARE NEVER IN THIS PROMPT, THIS APP, OR THE REPO. The prompt
//     points the agent at a local file on the operator's Mac
//     (DEFAULT_CARD_FILE_HINT) that the operator maintains themselves. Do not
//     "improve" this by adding card fields to the builder input.
//   - Price guard: never book past costPaid × 1.15 — pause and ask instead.
//   - Never blind-retry the final Book-now click (double-charge risk).
//   - Skip-if-booked: a buy-in already at bookingStatus "booked" is never
//     re-purchased (mirrors the buy-in-checkout-job idempotency guard).
import { BUY_IN_MARKETS, resolveBuyInMarketFromText } from "./buy-in-market";

// Where the operator keeps the standing booking card on the local Mac. The
// operator creates/maintains this file by hand; the agent reads it only at the
// payment step. Kept as an exported constant so the client dialog can show it.
export const DEFAULT_CARD_FILE_HINT = "~/Documents/vrbo-booking-card.txt";

// Fixed operator booking phone — mirrors BUYIN_BOOKING_PHONE in
// server/buy-in-checkout-job.ts (same number, formatted for a form).
export const COWORK_BOOKING_PHONE = "808-460-6509";

// Shared bot-wall / CAPTCHA protocol embedded in ALL Cowork prompts (operator
// spec 2026-07-05: "It skips VRBO because of a VRBO bot check. I need Chrome
// to sit there and wait for me to bypass the bot… make a big beep so I know
// to get back to the laptop"). The alert commands are macOS-native (afplay /
// say / osascript) — Cowork runs on the operator's Mac. NEVER let a prompt
// skip VRBO on a bot check; the operator solves it by hand and the run
// continues.
const BOT_WALL_PROTOCOL = `## Bot-check protocol (VRBO especially — NEVER skip a site over this)
If any site — especially VRBO — shows a bot check (slider puzzle, CAPTCHA,
"verify you are human") or a sign-in wall you can't get past:

1. **Do NOT skip that site and do NOT close the tab.** Leave the page open,
   sitting exactly at the challenge — I will solve it by hand.
2. **ALERT ME LOUDLY** — I may be away from the laptop. Run this in the
   terminal (repeat the whole thing every ~60 seconds until I've solved it,
   up to 15 times):
   for i in 1 2 3 4 5; do afplay /System/Library/Sounds/Sosumi.aiff; done; say -r 170 "Bot check! Come back to the laptop and solve the V R B O bot check."; osascript -e 'display notification "Solve the bot check in the Chrome tab, then I will continue." with title "Cowork needs you" sound name "Sosumi"'
3. **WAIT and WATCH.** Re-check the challenged tab every ~30 seconds. Do NOT
   attempt the challenge yourself and do NOT reload the page — reloading can
   make VRBO's wall stickier.
4. The moment the page is past the challenge, **stop the alerts and CONTINUE
   the task from exactly where you left off** — same tab, same step.
5. If ~15 minutes pass unsolved, pause the task, leave the tab open, and
   report exactly which unit/step is blocked so I can resume later.`;

export interface CoworkBuyInUnit {
  unitId: string;
  unitLabel: string;
  bedrooms: number;
}

export interface CoworkBuyInPromptInput {
  reservationId: string;
  guestName?: string | null;
  propertyId: number;
  propertyName: string;
  /** Configured community for the property, e.g. "Poipu Kai". */
  community: string;
  /** YYYY-MM-DD */
  checkIn: string;
  /** YYYY-MM-DD */
  checkOut: string;
  units: CoworkBuyInUnit[];
  /** App origin for the API calls, e.g. "https://app.example.com". Optional. */
  baseUrl?: string;
}

/** One ALREADY-ATTACHED unit the checkout prompt should book on vrbo.com. */
export interface CoworkCheckoutUnit {
  buyInId: number;
  unitLabel: string;
  /** The attached VRBO listing URL (buy_ins.airbnbListingUrl). */
  listingUrl: string | null;
  /** What the operator approved at attach time (buy_ins.costPaid) — anchors the price guard. */
  costPaid: string | number | null;
}

export interface CoworkCheckoutPromptInput {
  reservationId: string;
  guestName?: string | null;
  propertyName: string;
  /** YYYY-MM-DD */
  checkIn: string;
  /** YYYY-MM-DD */
  checkOut: string;
  units: CoworkCheckoutUnit[];
  /** App origin for the API calls, e.g. "https://app.example.com". Optional. */
  baseUrl?: string;
  /**
   * Local path of the operator-maintained card file the agent reads at the
   * payment step. NEVER the card details themselves — a path only.
   */
  cardFileHint?: string;
}

/** One ALREADY-ATTACHED unit the community-verify prompt should locate. */
export interface CoworkVerifyUnit {
  buyInId: number;
  unitLabel: string;
  listingUrl: string | null;
  /** Whatever address the buy-in row already carries (often empty for Cowork attaches). */
  unitAddress: string | null;
}

export interface CoworkCommunityVerifyPromptInput {
  reservationId: string;
  propertyName: string;
  /** Configured community for the property, if known. */
  community?: string | null;
  units: CoworkVerifyUnit[];
  /** App origin for the API calls, e.g. "https://app.example.com". Optional. */
  baseUrl?: string;
}

function nightsBetween(checkIn: string, checkOut: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) return 0;
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return 0;
  return Math.round((b - a) / 86_400_000);
}

// The configured community can be MISLABELED (e.g. a Fort Myers Beach "Santa Maria
// Resort" mis-mapped to the inland "Bonita National"), which sends the search to the
// wrong place. So anchor the prompt on the PROPERTY's own resort name and trust the
// curated community/city only when the property corroborates it.
const JUNK_PROPERTY_LEAD = /^(home\s*away\d*|homeaway\d*|vrbo|airbnb|booking(\.com)?|expedia|lodgify|guesty|listing|property|unit|rental)\b/i;

/** The resort name derived from the property name (cut at the first " - "/" · "/" | "). */
export function resortNameFromProperty(propertyName: string): string {
  const raw = String(propertyName ?? "").trim();
  if (!raw) return "";
  const head = raw.split(/\s+[-·|]\s+/)[0].trim();
  if (!head || head.length < 3) return "";
  if (JUNK_PROPERTY_LEAD.test(head)) return ""; // "Homeaway2 · Unit 3104" → no real resort name
  if (/^\d+\s*(br|bed|bedroom)/i.test(head)) return ""; // size-only lead
  return head;
}

/** The unit type named in the property name (condo/house/villa/…), if any. */
export function unitTypeFromProperty(propertyName: string): string | null {
  const m = String(propertyName ?? "").match(/\b(condo|townhome|townhouse|villa|apartment|cottage|bungalow|studio|house)\b/i);
  return m ? m[1].toLowerCase() : null;
}

const TOKEN_STOPWORDS = new Set(["the", "and", "resort", "condo", "villa", "suite", "beach", "club", "house", "golf", "country"]);
function significantTokens(s: string): Set<string> {
  return new Set(
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !TOKEN_STOPWORDS.has(t)),
  );
}
/** Do two names share a significant token? (Santa Maria ✗ Bonita National; Poipu Kai ✓ Poipu Kai 6BR). */
export function shareSignificantToken(a: string, b: string): boolean {
  const ta = significantTokens(a);
  if (ta.size === 0) return false;
  for (const t of Array.from(significantTokens(b))) if (ta.has(t)) return true;
  return false;
}

/**
 * Resolve the curated resort search name + city for a community, so the prompt
 * can name the exact resort to search first and the exact city to fall back to.
 */
export function resolveCoworkSearchTargets(community: string): {
  resortSearchName: string;
  city: string | null;
  state: string | null;
  cityWideSearch: string | null;
} {
  const key = resolveBuyInMarketFromText(community);
  const market = key ? BUY_IN_MARKETS[key] : undefined;
  if (!market) {
    return { resortSearchName: community, city: null, state: null, cityWideSearch: null };
  }
  const loc = market.location;
  const city = loc?.city ?? null;
  const state = loc?.state ?? null;
  const cityWide = market.cityWideSearch ?? (city ? `${city}, ${state ?? ""}`.replace(/,\s*$/, "") : null);
  return {
    resortSearchName: loc?.searchName || community,
    city,
    state,
    cityWideSearch: cityWide,
  };
}

export function buildCoworkBuyInPrompt(input: CoworkBuyInPromptInput): string {
  const nights = nightsBetween(input.checkIn, input.checkOut);
  const { resortSearchName, city, state, cityWideSearch } = resolveCoworkSearchTargets(input.community);
  const base = (input.baseUrl ?? "").replace(/\/+$/, "");
  const apiRoot = base || "<APP_BASE_URL>";

  // Anchor on the property's own resort name; trust the curated community/city ONLY
  // when the property corroborates it (else the community is likely mislabeled).
  const resortName = resortNameFromProperty(input.propertyName);
  const unitType = unitTypeFromProperty(input.propertyName);
  const hasCurated = city !== null;
  const curatedTrusted = hasCurated && (!resortName || shareSignificantToken(resortName, resortSearchName) || shareSignificantToken(resortName, input.community));
  const primaryTarget = (resortName && !curatedTrusted)
    ? resortName
    : (curatedTrusted ? resortSearchName : (resortName || input.community || "the resort (infer from the property name)"));
  const mismatch = !!resortName && hasCurated && !curatedTrusted;

  const unitLines = input.units
    .map((u, i) => `  ${i + 1}. unitId "${u.unitId}" (${u.unitLabel}) — needs a ${u.bedrooms}BR ${unitType ?? "unit"}`)
    .join("\n");

  const bedroomPlan = input.units.map((u) => `${u.bedrooms}BR`).join(" + ");
  const cityLabel = city ? `${city}${state ? `, ${state}` : ""}` : "(unknown — infer from the resort/community)";
  const cityWideLabel = cityWideSearch ?? cityLabel;
  // When the community is mislabeled, the curated city is suspect too — tell the agent
  // to determine the real city from the resort's listing instead of assuming it.
  const effectiveCityLabel = curatedTrusted ? cityLabel : "the resort's ACTUAL city (determine it from the resort's own listing — do NOT assume)";
  const effectiveCityWideLabel = curatedTrusted ? cityWideLabel : "the resort's actual city (from the listing)";
  const typeRule = unitType
    ? `a **${unitType}** comparable to the reserved unit (NOT a house or other type — the reservation is a ${unitType})`
    : "the same unit type as the reserved unit (match condo vs. house, etc.)";

  // The prompt is count-aware: a single-unit reservation needs one listing, a
  // combo needs two. Word the "two cheapest" / "both" copy accordingly.
  const n = input.units.length;
  const unitWord = n === 1 ? "unit" : "units";
  const countWord = n === 1 ? "the cheapest" : n === 2 ? "the cheapest two" : `the cheapest ${n}`;
  const listingsTotal = n === 1 ? "one listing total" : `${n} listings total`;
  const themOrIt = n === 1 ? "it" : "them";
  const bothOrAll = n === 1 ? "the unit" : n === 2 ? "both units" : "all units";
  const distinctNote =
    n === 1
      ? "."
      : `, making sure the ${n === 2 ? "two" : n} picks are DISTINCT listings (never the same URL twice).`;

  return `# Task: Find ${countWord} buy-in ${unitWord} for a reservation and attach ${themOrIt}

You are operating inside the Rental Community Tracker (NexStay) app as Cowork.
Search the open web — Google, property-manager (PM) company websites, Airbnb,
VRBO, and Booking.com — to find ${countWord} replacement ("buy-in") ${unitWord}
for the reservation below, then **attach ${themOrIt} using the manual-attach method**.

## Reservation
- Reservation ID: ${input.reservationId}
- Guest: ${input.guestName?.trim() || "(unknown)"}
- Property: ${input.propertyName} (propertyId ${input.propertyId})
- Resort to search (PRIMARY — anchor on this): ${primaryTarget}
- Configured community: ${input.community || "(none — infer from the property name)"}${mismatch ? "  ⚠ MAY BE MISLABELED — it does not match the property/resort name. TRUST the resort name above and verify the real location." : ""}
- City: ${effectiveCityLabel}
- Check-in: ${input.checkIn}
- Check-out: ${input.checkOut}
- Nights: ${nights || "(compute from the dates)"}

## Units to fill (the bedroom plan is ${bedroomPlan})
${unitLines}

## A listing QUALIFIES only if ALL are true (price is the tiebreaker, never a reason to relax these)
1. LOCATION — it is inside **${primaryTarget}** itself, or a complex within a
   ~10-minute walk of it. A listing merely in the same CITY does NOT qualify.
   If you cannot CONFIRM it is in/adjacent to ${primaryTarget}, reject it — do not guess.
2. TYPE — it is ${typeRule}.
3. SIZE — it has the exact bedroom count the slot needs.
4. DATES — available and book-able for the FULL stay (${input.checkIn} → ${input.checkOut}).
5. CHANNEL — the URL you attach is a **VRBO**, **Booking.com**, or **direct
   booking site** (PM company / the property's own site) listing page. **NEVER
   attach an airbnb.com link.** You may still use Airbnb to DISCOVER a unit,
   but you must then find that same unit's VRBO / Booking.com / direct-site
   page and attach THAT; a unit bookable ONLY on Airbnb does not qualify.

Find ONE distinct listing per unit slot above (${listingsTotal}). Among listings that
satisfy ALL of 1–5, pick the **cheapest**${distinctNote}
${n === 1 ? "" : `
PAIR RULE — the picks serve ONE guest group. All ${n === 2 ? "two" : n} picks must be in the
SAME complex — ideally the SAME BUILDING. Two units in different complexes
across town are NOT an acceptable pair even if each qualifies on its own.
If you cannot find a qualifying same-complex pair, attach the closest
qualifying pair ONLY if they are within a ~10-minute walk of each other, and
LEAD your report with the pair's distance and both building names.

PRICE SANITY — if the picks' prices differ by more than ~50% for the same
bedroom count, re-verify the pricier one really is the cheapest qualifying
option for its slot, and call the gap out in your report along with the
next-cheapest alternatives you rejected and why.`}

## Where to search (in priority order)
1. **Same community first.** Look for ${bothOrAll} inside **${primaryTarget}**
   (the resort itself) — search Google for the resort name + dates, the PM companies
   that manage it, and its listings on Airbnb, VRBO, and Booking.com. Search by the
   resort's REAL name, not the configured community if they differ.
2. **City-wide fallback.** If you cannot find a qualifying listing for ${n === 1 ? "the unit" : "one and/or more unit slots"}
   inside the resort/community, widen to a
   **city-wide search of ${effectiveCityWideLabel}** — any qualifying same-bedroom
   ${unitType ?? "listing"} in that city.
3. **STOP at city-wide.** Do **NOT** expand beyond the city: no nearby towns,
   no neighboring cities, no county/region/island-wide search. If a slot still
   has no qualifying unit after the city-wide search, leave that slot unfilled
   and report it.

For each candidate, capture: the listing URL, the bedroom count, the unit type, the
exact ADDRESS (to prove the location), and the TOTAL price for the exact
${input.checkIn} → ${input.checkOut} stay (all-in: nightly × nights + cleaning/fees).

${BOT_WALL_PROTOCOL}

## Attach using the manual-attach method
For EACH unit slot, replicate the manual-attach flow (the "Manually add buy-in"
dialog). It is two API calls:

1. Create the buy-in record:
   POST ${apiRoot}/api/buy-ins
   {
     "propertyId": ${input.propertyId},
     "propertyName": ${JSON.stringify(input.propertyName)},
     "unitId": "<the slot's unitId from the list above>",
     "unitLabel": "<the slot's unitLabel>",
     "checkIn": "${input.checkIn}",
     "checkOut": "${input.checkOut}",
     "costPaid": "<total stay cost for this unit, e.g. 1820.00>",
     "airbnbListingUrl": "<the listing URL you found — VRBO/Booking.com/direct site ONLY, never airbnb.com; the field name is legacy>",
     "unitAddress": "<the unit's exact street address, e.g. 1777 Ala Moana Blvd, Honolulu, HI — REQUIRED; you captured it to prove the location, and the app uses it to verify the units are in the same community>",
     "managementCompany": "<PM company name if known, else null>",
     "groundFloorStatus": "unknown",
     "status": "active",
     "notes": "Manually recorded buy-in for <unitLabel>. Found via Cowork web search — <resort or city scope> — <listing title>."
   }
   → returns the created record; keep its "id".

2. Attach it to the reservation:
   POST ${apiRoot}/api/bookings/${input.reservationId}/attach-buy-in
   { "buyInId": <id from step 1> }
   → If this returns 409 with "canForce": true, the units may be flagged as
     too far apart. Re-POST with { "buyInId": <id>, "force": true,
     "overrideNote": "<short reason these are an acceptable pair>" } ONLY if the
     listings are genuinely in the same complex/community per your research —
     never to push through units in different parts of the city.
${n === 1 ? "" : `
Repeat steps 1–2 for each remaining unit slot.`}
## Done — report and STOP (do NOT book anything)
When ${bothOrAll === "the unit" ? "the slot is" : "all slots are"} attached, report for each pick: the listing URL,
bedrooms, unit type, its ADDRESS and how you confirmed it's in/adjacent to
**${primaryTarget}**, the total price, whether it came from the resort or the
city-wide fallback, the combined cost, and any slot you could not fill.

This task ends at ATTACH. Do **NOT** book, open a checkout page, or enter any
payment details — I review the attached picks first, and booking runs from a
separate checkout prompt I'll start myself.

Finally, TIDY UP THE BROWSER: close every Chrome tab you opened during this
task (search results, listings, PM sites — all of them). Leave any tabs that
were already open before you started untouched. Your report has everything I
need, so nothing needs to stay open.`;
}

export function buildCoworkCheckoutPrompt(input: CoworkCheckoutPromptInput): string {
  const nights = nightsBetween(input.checkIn, input.checkOut);
  const base = (input.baseUrl ?? "").replace(/\/+$/, "");
  const apiRoot = base || "<APP_BASE_URL>";
  const cardFile = String(input.cardFileHint ?? "").trim() || DEFAULT_CARD_FILE_HINT;

  // Guest name split for the traveler-email mint + the traveler form. When the
  // full name is unknown the prompt tells the agent to read it off the
  // reservation row before booking anything.
  const guestFull = String(input.guestName ?? "").trim();
  const guestFirst = guestFull.split(/\s+/)[0] ?? "";
  const guestLast = guestFull.includes(" ") ? guestFull.slice(guestFull.indexOf(" ") + 1).trim() : "";
  const guestNameKnown = Boolean(guestFirst && guestLast);

  const n = input.units.length;
  const money = (v: string | number | null | undefined): string => {
    const num = Number(v);
    return Number.isFinite(num) && num > 0 ? `$${num.toFixed(2)}` : "(not recorded)";
  };
  const unitLines = input.units
    .map(
      (u, i) =>
        `  ${i + 1}. buyInId ${u.buyInId} — ${u.unitLabel}\n` +
        `     Listing: ${u.listingUrl?.trim() || "(no URL recorded — GET the buy-in record; if it has none, stop and ask me)"}\n` +
        `     Approved cost (costPaid): ${money(u.costPaid)}`,
    )
    .join("\n");

  return `# Task: Book ${n === 1 ? "the attached buy-in unit" : `the ${n} attached buy-in units`} on vrbo.com

You are operating inside the Rental Community Tracker (NexStay) app as Cowork.
I have ALREADY reviewed and approved the attached ${n === 1 ? "unit" : "units"} below — running this
prompt is my approval, so book ${n === 1 ? "it" : "them"} now. Do not re-run the search or attach
anything new; if the data below doesn't match what's in the app, stop and ask.

## Reservation
- Reservation ID: ${input.reservationId}
- Guest: ${guestFull || "(unknown — read it off the reservation row before booking)"}
- Property: ${input.propertyName}
- Check-in: ${input.checkIn}
- Check-out: ${input.checkOut}
- Nights: ${nights || "(compute from the dates)"}

## Units to book (already attached + approved)
${unitLines}

## Standing rules for every booking (no exceptions)
- **Damage waiver ONLY.** At checkout, select the damage waiver / property
  damage protection option and NOTHING else — decline travel/trip insurance
  and every other optional add-on or upsell. If the host offers only a
  refundable damage deposit (no waiver option), that's host-mandated: proceed,
  and note it in your report.
- **The guest's name for everything — INCLUDING the name-on-card field.**
  Every name field, on the traveler form AND on the payment form, uses the
  guest's name${guestNameKnown ? ` (${guestFull})` : " (read it off the reservation row first)"}. Do NOT use the
  cardholder's own name anywhere, even if the card file contains one.
- **Traveler email = the minted guest alias**, never a real/personal email.
- **Phone:** ${COWORK_BOOKING_PHONE}.
- **Price guard:** if the checkout total is more than **15% above** the
  unit's approved costPaid above, do NOT book — pause, screenshot, and ask me.
- **One unit at a time**, in the order listed. Never book in parallel.
- **Never blind-retry a final Book-now click.** If the confirmation doesn't
  appear (spinner, error, closed tab), FIRST check VRBO "My Trips" and the
  alias inbox for a confirmation before even considering a retry — a double
  charge is the worst outcome. When unsure, stop and ask me.

${BOT_WALL_PROTOCOL}

## For each unit, in order

1. **Skip-if-booked guard:** GET ${apiRoot}/api/buy-ins/<buyInId>. If
   "bookingStatus" is "booked" or it already has a confirmation recorded,
   skip this unit and say so. Also sanity-check the record matches the unit
   line above (same listing URL, dates covering ${input.checkIn} → ${input.checkOut});
   on any mismatch, stop and ask me.
2. **Mint the guest booking email:**
   POST ${apiRoot}/api/buy-ins/<buyInId>/traveler-email
   { "reservationId": "${input.reservationId}", "guestFirstName": ${JSON.stringify(guestFirst || "<guest first name>")}, "guestLastName": ${JSON.stringify(guestLast || "<guest last name>")} }
   → returns { "email": "firstname.lastname@emailprivaccy.com" }. Reuse
   whatever it returns (it's stable per guest).
3. **Open the unit's VRBO listing** (the listing URL above) in the browser.
   Set the EXACT dates ${input.checkIn} → ${input.checkOut} and a sensible
   guest count, using the page's own date picker (never edit URL parameters).
   Confirm the listing matches the attached unit and the quoted total is
   within the price guard.
4. **Click Book / Reserve** to reach the checkout page. If VRBO throws a bot
   check or sign-in wall, follow the bot-check protocol above — alert me
   loudly and WAIT at the challenge; never skip the unit over it.
5. **Protection step:** apply the damage-waiver-only rule above. List in your
   report exactly what you selected and what you declined.
6. **Traveler details:** guest first/last name, the minted alias email, the
   phone above.
7. **Payment:** read the standing booking card from the local file
   \`${cardFile}\` on this Mac (number, expiry, CVC, billing address/zip).
   Fill the card fields from that file — EXCEPT the name-on-card field, which
   gets the GUEST's name per the standing rule above. Do NOT paste card
   details into this chat, any report, or any app field outside VRBO's
   payment form. Re-verify before the final click: dates, total within the
   price guard, damage waiver only. Then click **Book now / Confirm and pay**.
8. **Record the booking:** capture the confirmation/reservation number from
   the confirmation page (screenshot it), then:
   PATCH ${apiRoot}/api/buy-ins/<buyInId>
   { "bookingStatus": "booked", "bookingConfirmation": "<confirmation number>",
     "airbnbConfirmation": "<confirmation number>",
     "notes": "<existing notes> · Booked on VRBO via Cowork — damage waiver only, traveler <alias email>" }

## Final report
For each unit: listing URL, confirmation number, total charged, the payment
plan if VRBO split it (due now / balance + date), what protection was selected
and what was declined, the traveler name/email used, and anything that needs
my attention (deposit-only host, price-guard pause, skipped already-booked unit).

Then TIDY UP THE BROWSER: after every unit is recorded (confirmation numbers
captured + screenshots taken), close every Chrome tab you opened during this
task — listings, checkout pages, My Trips, all of them. Leave any tabs that
were already open before you started untouched. Do NOT close a checkout tab
mid-booking or before its confirmation is captured and recorded.`;
}

// Verify the attached buy-ins are genuinely in the same community — ideally
// the SAME BUILDING (operator spec 2026-07-05: a combo pair serves one guest
// group, so "same community" means same complex/building, and the app's
// walking-distance panel can only show a real number once each buy-in has a
// confirmed street address). READ-ONLY apart from PATCHing the confirmed
// addresses back onto the buy-in rows — it never books, attaches, or detaches.
export function buildCoworkCommunityVerifyPrompt(input: CoworkCommunityVerifyPromptInput): string {
  const base = (input.baseUrl ?? "").replace(/\/+$/, "");
  const apiRoot = base || "<APP_BASE_URL>";
  const n = input.units.length;
  const unitLines = input.units
    .map(
      (u, i) =>
        `  ${i + 1}. buyInId ${u.buyInId} — ${u.unitLabel}\n` +
        `     Listing: ${u.listingUrl?.trim() || "(no URL recorded — GET the buy-in record; if it has none, say so)"}\n` +
        `     Address on file: ${u.unitAddress?.trim() || "(none — that's part of why this check exists)"}`,
    )
    .join("\n");

  return `# Task: Verify the ${n === 1 ? "attached buy-in unit is" : `${n} attached buy-in units are`} in the same community${n === 1 ? " as the reservation's configured community" : " — ideally the SAME BUILDING"}

You are operating inside the Rental Community Tracker (NexStay) app as Cowork.
This is a VERIFICATION task: locate each attached unit precisely and tell me
whether ${n === 1 ? "it is inside the expected community" : "they belong together"}. Do NOT book anything, do NOT attach or
detach anything, and do NOT modify any field other than the address/notes
updates in step 3.

## Reservation
- Reservation ID: ${input.reservationId}
- Property: ${input.propertyName}
- Configured community: ${input.community?.trim() || "(none configured — judge against the property name and the units themselves)"}

## Units to verify
${unitLines}

${BOT_WALL_PROTOCOL}

## Steps

1. **Locate each unit exactly.** Open its listing page and pin down the
   building/complex it is in and its full street address. Use every signal on
   the page: the map pin (zoom in), the complex/resort name in the title or
   description, host/PM details, and cross-check with a quick web search
   (e.g. the complex name + city) when the listing is vague. If the listing
   only reveals an approximate area, say so — do NOT guess an address.
2. **Compare.** Determine, with evidence:
   - Are ${n === 1 ? "the unit and the configured community the same place?" : "the units in the SAME BUILDING? If not, the same complex/community?"}
   - The real walking distance between ${n === 1 ? "the unit and the community center" : "the units"} (use the map — building
     to building, not city blocks apart "as the crow flies").
   - Whether ${n === 1 ? "the unit matches" : "each unit matches"} the configured community above (or the
     property's own resort name if no community is configured).
3. **Record what you confirmed** so the app can show a real distance instead
   of an estimate — for EACH unit where you confirmed the address:
   PATCH ${apiRoot}/api/buy-ins/<buyInId>
   { "unitAddress": "<the confirmed full street address>",
     "notes": "<existing notes> · Community verified via Cowork: <building/complex name> — <same building / same complex / DIFFERENT community>" }
4. **Record the VERDICT in the app** (this is what flips the reservation's
   walking-distance panel to a verified state):
   POST ${apiRoot}/api/bookings/${input.reservationId}/community-verdict
   { "verdict": "<same_building | same_community | different>", "source": "cowork" }
   Pick the precise value: SAME BUILDING → "same_building"; same complex or
   same community → "same_community"; anything else → "different". (The same
   verdict can also be recorded by clicking the "✓ Same community/building" /
   "✕ Not same" buttons on the reservation's walking-distance panel — the API
   call and the buttons do the same thing; use the API.)
5. **Report** (this is the deliverable):
   - Per unit: building/complex name, confirmed street address, and the
     evidence (map pin, listing text, web search result).
   - The verdict in one line: **SAME BUILDING / same complex / same community
     but different buildings (with walking distance) / DIFFERENT communities**.
   - If ${n === 1 ? "the unit is NOT in the expected community" : "the units do NOT belong together (different complexes or an unacceptable distance for one guest group)"}, say so clearly and recommend
     what I should do (e.g. re-run the find prompt for one slot) — but do NOT
     detach or change anything yourself.

Finally, TIDY UP THE BROWSER: close every Chrome tab you opened during this
task. Leave any tabs that were already open before you started untouched.`;
}
