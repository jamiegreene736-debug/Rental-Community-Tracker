// Builds the copy-to-clipboard prompt the operator hands to Cowork (an agent
// session with access to this app) so it can search the open web — Google, PM
// company sites, Airbnb / VRBO / Booking.com — for the cheapest TWO buy-in units
// for a reservation and attach them via the existing manual-attach API.
//
// LOAD-BEARING (operator's spec): same-community first; if one or both units
// can't be found in the configured community, fall back to a CITY-WIDE search
// and STOP THERE — never expand to nearby cities / regions. The attach path is
// the manual method: POST /api/buy-ins (create) then
// POST /api/bookings/:reservationId/attach-buy-in (attach) — one pair, one per
// unit slot. This mirrors `ManualBuyInDialog` in client/src/pages/bookings.tsx.
import { BUY_IN_MARKETS, resolveBuyInMarketFromText } from "./buy-in-market";

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

Find ONE distinct listing per unit slot above (${listingsTotal}). Among listings that
satisfy ALL of 1–4, pick the **cheapest**${distinctNote}

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
     "airbnbListingUrl": "<the listing URL you found>",
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
     listings are genuinely in the same community/city per your research.
${n === 1 ? "" : `
Repeat steps 1–2 for each remaining unit slot.`}
## Done
When ${bothOrAll === "the unit" ? "the slot is" : "all slots are"} attached, report for each pick: the listing URL,
bedrooms, unit type, its ADDRESS and how you confirmed it's in/adjacent to
**${primaryTarget}**, the total price, whether it came from the resort or the
city-wide fallback, the combined cost, and any slot you could not fill.`;
}
