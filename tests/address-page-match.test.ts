import assert from "node:assert";
import { ADDRESS_PLATFORMS } from "../shared/address-listing-logic";
import {
  selectDeepFetchCandidates,
  normalizePageTextForMatch,
  matchAddressInText,
} from "../shared/address-page-match";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("address-page-match: deep-fetch recall helpers");

const airbnb = ADDRESS_PLATFORMS.find((p) => p.key === "airbnb")!;
const vrbo = ADDRESS_PLATFORMS.find((p) => p.key === "vrbo")!;

// ---- selectDeepFetchCandidates ----------------------------------------------
// A listing-page URL whose snippet does NOT surface the street is a deep-fetch
// candidate (the cheap path dropped it; the quoted SERP still returned it).
check(
  "keeps a listing URL whose snippet lacks the street (worth a full read)",
  selectDeepFetchCandidates(
    [{ link: "https://www.airbnb.com/rooms/12345", title: "Sunny Poipu Condo", snippet: "Steps from the beach, sleeps 6" }],
    airbnb,
    "1831 Poipu Rd",
  ).length === 1,
);

// A snippet that already proves the street is handled by the cheap path — NOT a
// deep-fetch candidate (would be a wasted fetch / double count).
check(
  "excludes a row whose snippet already contains the street",
  selectDeepFetchCandidates(
    [{ link: "https://www.airbnb.com/rooms/12345", title: "x", snippet: "Located at 1831 Poipu Rd, Koloa" }],
    airbnb,
    "1831 Poipu Rd",
  ).length === 0,
);

check(
  "excludes a non-listing URL even when the snippet lacks the street",
  selectDeepFetchCandidates(
    [{ link: "https://www.airbnb.com/koloa-hi/stays", title: "Stays in Koloa", snippet: "Beach rentals" }],
    airbnb,
    "1831 Poipu Rd",
  ).length === 0,
);

check(
  "dedupes repeated URLs",
  selectDeepFetchCandidates(
    [
      { link: "https://www.vrbo.com/4567890", title: "a", snippet: "no street here" },
      { link: "https://www.vrbo.com/4567890", title: "b", snippet: "still no street" },
    ],
    vrbo,
    "1831 Poipu Rd",
  ).length === 1,
);

check(
  "empty street yields no candidates",
  selectDeepFetchCandidates(
    [{ link: "https://www.vrbo.com/1", title: "x", snippet: "y" }],
    vrbo,
    "",
  ).length === 0,
);

// ---- normalizePageTextForMatch ----------------------------------------------
check(
  "strips tags, lowercases, collapses whitespace",
  normalizePageTextForMatch("<div>  Hello\n\n  WORLD </div>") === "hello world",
);
check(
  "keeps text inside <script> (JSON-LD) after tag strip",
  normalizePageTextForMatch('<script type="application/ld+json">{"streetAddress":"1831 Poipu Rd"}</script>')
    .includes("1831 poipu rd"),
);
check(
  "decodes &amp; and numeric entities",
  normalizePageTextForMatch("A &amp; B &#38; C") === "a & b & c",
);

// ---- matchAddressInText -----------------------------------------------------
check(
  "matches an exact street in visible page text",
  matchAddressInText("<p>Our condo at 1831 Poipu Rd is lovely</p>", { street: "1831 Poipu Rd" }).matched === true,
);
check(
  "matches an exact street present only in a JSON-LD block",
  matchAddressInText(
    '<html><body>Great condo</body><script type="application/ld+json">{"address":{"streetAddress":"1831 Poipu Rd","addressLocality":"Koloa"}}</script></html>',
    { street: "1831 Poipu Rd" },
  ).matched === true,
);
{
  // Street WITHOUT the house number is reported for provenance but NOT acted on
  // (matched:false) — every unit on the road would otherwise trip the flag.
  const m = matchAddressInText("<p>Located on Poipu Rd near the cliffs</p>", { street: "1831 Poipu Rd" });
  check("street-without-number is reported but not a match", m.matched === false && m.matchType === "street-no-number");
}
check(
  "no street anywhere → matchType none",
  matchAddressInText("<p>Beautiful oceanfront escape in Koloa, HI</p>", { street: "1831 Poipu Rd" }).matchType === "none",
);
check(
  "empty html → no match",
  matchAddressInText("", { street: "1831 Poipu Rd" }).matched === false,
);
check(
  "empty street → no match",
  matchAddressInText("<p>1831 Poipu Rd</p>", { street: "" }).matched === false,
);
check(
  "match is case- and whitespace-insensitive",
  matchAddressInText("<p>1831   POIPU   RD</p>", { street: "1831 Poipu Rd" }).matched === true,
);
{
  const m = matchAddressInText("<p>Our condo at 1831 Poipu Rd is lovely</p>", { street: "1831 Poipu Rd" });
  check("evidence includes the matched street", m.evidence.includes("1831 poipu rd"));
}

console.log(`\naddress-page-match: ${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, "address-page-match tests failed");
