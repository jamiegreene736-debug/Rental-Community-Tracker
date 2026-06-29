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

  const unitLines = input.units
    .map((u, i) => `  ${i + 1}. unitId "${u.unitId}" (${u.unitLabel}) — needs a ${u.bedrooms}BR unit`)
    .join("\n");

  const bedroomPlan = input.units.map((u) => `${u.bedrooms}BR`).join(" + ");
  const cityLabel = city ? `${city}${state ? `, ${state}` : ""}` : "(unknown — infer from the resort/community)";
  const cityWideLabel = cityWideSearch ?? cityLabel;

  return `# Task: Find the two cheapest buy-in units for a reservation and attach them

You are operating inside the Rental Community Tracker (NexStay) app as Cowork.
Search the open web — Google, property-manager (PM) company websites, Airbnb,
VRBO, and Booking.com — to find the **cheapest two replacement ("buy-in") units**
for the reservation below, then **attach them using the manual-attach method**.

## Reservation
- Reservation ID: ${input.reservationId}
- Guest: ${input.guestName?.trim() || "(unknown)"}
- Property: ${input.propertyName} (propertyId ${input.propertyId})
- Community / resort: ${input.community}
- Curated resort search name: ${resortSearchName}
- City: ${cityLabel}
- Check-in: ${input.checkIn}
- Check-out: ${input.checkOut}
- Nights: ${nights || "(compute from the dates)"}

## Units to fill (the bedroom plan is ${bedroomPlan})
${unitLines}

You must find ONE distinct listing per unit slot above (two listings total),
each matching that slot's exact bedroom count, available for the FULL stay
(${input.checkIn} → ${input.checkOut}), and book-able for those exact dates.

## Where to search (in priority order)
1. **Same community first.** Look for both units inside **${resortSearchName}**
   (the resort/community itself). Search Google for the resort name + dates,
   the PM companies that manage that resort, and the resort's listings on
   Airbnb, VRBO, and Booking.com. Prefer two listings in the SAME community.
2. **City-wide fallback.** If you cannot find a qualifying listing for one
   and/or both unit slots inside the community, widen to a
   **city-wide search of ${cityWideLabel}** — any qualifying same-bedroom
   listing in that city.
3. **STOP at city-wide.** Do **NOT** expand beyond the city: no nearby towns,
   no neighboring cities, no county/region/island-wide search. If a slot still
   has no qualifying unit after the city-wide search, leave that slot unfilled
   and report it — do not reach outside ${cityLabel}.

For each candidate, capture: the listing URL, the bedroom count, and the TOTAL
price for the exact ${input.checkIn} → ${input.checkOut} stay (all-in: nightly ×
nights + cleaning/fees). Pick the **cheapest** qualifying listing for each slot,
making sure the two picks are two DISTINCT listings (never the same URL twice).

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
   → If this returns 409 with "canForce": true, the two units may be flagged as
     too far apart. Re-POST with { "buyInId": <id>, "force": true,
     "overrideNote": "<short reason these are an acceptable pair>" } ONLY if the
     two listings are genuinely in the same community/city per your research.

Repeat steps 1–2 for the second unit slot.

## Done
When both slots are attached, report: the two listings (URL + bedrooms + total
price), whether each came from the community or the city-wide fallback, the
combined cost, and any slot you could not fill within ${cityLabel}.`;
}
