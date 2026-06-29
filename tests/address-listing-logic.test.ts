import assert from "node:assert";
import {
  ADDRESS_PLATFORMS,
  streetPortionOf,
  buildAddressQuery,
  filterAddressSerpRows,
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
