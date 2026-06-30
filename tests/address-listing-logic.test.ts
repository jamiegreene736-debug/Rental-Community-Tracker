import assert from "node:assert";
import {
  ADDRESS_PLATFORMS,
  streetPortionOf,
  buildAddressQuery,
  filterAddressSerpRows,
  parseStreetCityState,
} from "../shared/address-listing-logic";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("address-listing-logic: address-on-OTA detection helpers");

// streetPortionOf
check("street portion strips unit + city + state", streetPortionOf("1831 Poipu Rd, Unit 423, Koloa, HI 96756") === "1831 Poipu Rd");
check("street portion of a bare street is itself", streetPortionOf("4460 Nehe Rd") === "4460 Nehe Rd");
check("street portion of empty string is empty", streetPortionOf("") === "");

// parseStreetCityState — the city must NOT be the embedded "Unit N"/"Bldg N" segment
// (2026-06-30 fix: the old parts[1] parse fed "Unit 423" into the city clause of the SERP query).
{
  const a = parseStreetCityState("1831 Poipu Rd, Unit 423, Koloa, HI 96756");
  check("4-part w/ Unit segment → city is Koloa, not 'Unit 423'", a.street === "1831 Poipu Rd" && a.city === "Koloa" && a.state === "HI");
  const b = parseStreetCityState("2611 Kiahuna Plantation Dr, Bldg 38, Koloa, HI 96756");
  check("4-part w/ Bldg segment → city is Koloa", b.street === "2611 Kiahuna Plantation Dr" && b.city === "Koloa" && b.state === "HI");
  const c = parseStreetCityState("8497 Kekaha Rd, Kekaha, HI 96752");
  check("3-part → city is the 2nd part", c.street === "8497 Kekaha Rd" && c.city === "Kekaha" && c.state === "HI");
  const d = parseStreetCityState("4460 Nehe Rd, Lihue, HI 96766");
  check("3-part Lihue", d.street === "4460 Nehe Rd" && d.city === "Lihue" && d.state === "HI");
  const e = parseStreetCityState("123 Main St, Apt 5B, Princeville, HI");
  check("Apt segment skipped → Princeville", e.city === "Princeville" && e.state === "HI");
  const f = parseStreetCityState("");
  check("empty address → all empty", f.street === "" && f.city === "" && f.state === "");
  const g = parseStreetCityState("500 Beach Rd, Kapaa");
  check("2-part street,city (no state) → city Kapaa", g.street === "500 Beach Rd" && g.city === "Kapaa");
}

// buildAddressQuery
check(
  "query quotes street + city scoped to host",
  buildAddressQuery("airbnb.com", "1831 Poipu Rd", "Koloa") === 'site:airbnb.com "1831 Poipu Rd" "Koloa"',
);
check(
  "query omits city clause when city is blank",
  buildAddressQuery("vrbo.com", "4460 Nehe Rd", "") === 'site:vrbo.com "4460 Nehe Rd"',
);

const airbnb = ADDRESS_PLATFORMS.find((p) => p.key === "airbnb")!;
const vrbo = ADDRESS_PLATFORMS.find((p) => p.key === "vrbo")!;
const booking = ADDRESS_PLATFORMS.find((p) => p.key === "booking")!;

// filterAddressSerpRows — positive: real listing page that surfaces the street
check(
  "keeps an Airbnb room URL whose snippet contains the street",
  filterAddressSerpRows(
    [{ link: "https://www.airbnb.com/rooms/12345", title: "Sunny Poipu Condo", snippet: "Located at 1831 Poipu Rd, steps from the beach" }],
    airbnb,
    "1831 Poipu Rd",
  ).length === 1,
);

// negative: listing page but the street is nowhere in title/snippet (generic city match)
check(
  "drops an Airbnb listing that only matches the city, not the street",
  filterAddressSerpRows(
    [{ link: "https://www.airbnb.com/rooms/999", title: "Koloa beach getaway", snippet: "Beautiful condo in Koloa, HI" }],
    airbnb,
    "1831 Poipu Rd",
  ).length === 0,
);

// negative: street present but URL is a region/search page, not a listing
check(
  "drops a non-listing Airbnb URL even when the street appears",
  filterAddressSerpRows(
    [{ link: "https://www.airbnb.com/koloa-hi/stays", title: "Stays near 1831 Poipu Rd", snippet: "1831 Poipu Rd area rentals" }],
    airbnb,
    "1831 Poipu Rd",
  ).length === 0,
);

// VRBO numeric listing path
check(
  "keeps a VRBO numeric listing URL that surfaces the street",
  filterAddressSerpRows(
    [{ link: "https://www.vrbo.com/4567890", title: "Poipu Kai 3BR", snippet: "1831 Poipu Rd, Koloa" }],
    vrbo,
    "1831 Poipu Rd",
  ).length === 1,
);

// Booking hotel/apartments path, case-insensitive street match
check(
  "Booking match is case-insensitive on the street",
  filterAddressSerpRows(
    [{ link: "https://www.booking.com/hotel/us/poipu.html", title: "Poipu Condo", snippet: "address: 1831 POIPU RD, koloa" }],
    booking,
    "1831 Poipu Rd",
  ).length === 1,
);

// empty street guard
check(
  "empty street yields no matches",
  filterAddressSerpRows(
    [{ link: "https://www.vrbo.com/123", title: "x", snippet: "y" }],
    vrbo,
    "",
  ).length === 0,
);

// rows without a link are skipped
check(
  "row without a link is skipped",
  filterAddressSerpRows(
    [{ title: "1831 Poipu Rd", snippet: "1831 Poipu Rd" }],
    airbnb,
    "1831 Poipu Rd",
  ).length === 0,
);

console.log(`\naddress-listing-logic: ${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, "address-listing-logic tests failed");
