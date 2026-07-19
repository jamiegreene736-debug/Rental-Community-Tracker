import assert from "node:assert/strict";
import {
  buildPreflightMatchContext,
  evaluatePreflightSearchResult,
  snippetMentionsUnit,
} from "../shared/preflight-platform-match";

function check(label: string, ok: boolean) {
  assert.ok(ok, label);
  console.log(`  ✓ ${label}`);
}

const kaiulaniContext = buildPreflightMatchContext({
  complexName: "Kaiulani of Princeville",
  city: "Princeville",
  unitNumber: "52",
  address: "4100 Queen Emma's Dr, Princeville, HI 96722, Unit 52",
  bedrooms: 3,
});

check(
  "rejects Jupiter Bay listing for a Kaiulani 3BR unit (community mismatch)",
  evaluatePreflightSearchResult(
    {
      title: "Jupiter Bay 2BR Condo · Unit 52",
      snippet: "Princeville vacation rental with 2 bedrooms near Hanalei Bay",
      link: "https://www.airbnb.com/rooms/123456",
    },
    "airbnb",
    kaiulaniContext,
  ) === null,
);

check(
  "rejects bedroom mismatch even when unit number matches",
  evaluatePreflightSearchResult(
    {
      title: "Kaiulani of Princeville Unit 52",
      snippet: "2 bedroom condo at Kaiulani of Princeville in Princeville",
      link: "https://www.airbnb.com/rooms/234567",
    },
    "airbnb",
    kaiulaniContext,
  ) === null,
);

check(
  "accepts a full Kaiulani match with community, city, and unit marker",
  evaluatePreflightSearchResult(
    {
      title: "Kaiulani of Princeville · Unit 52",
      snippet: "3 bedroom condo at Kaiulani of Princeville, 4100 Queen Emma's Dr, Princeville",
      link: "https://www.airbnb.com/rooms/345678",
    },
    "airbnb",
    kaiulaniContext,
  )?.status === "confirmed",
);

check(
  "requires an explicit unit marker (bare unit digits are not enough)",
  snippetMentionsUnit(
    {
      title: "Princeville condo ranked #1 with 52 reviews",
      snippet: "Sleeps 8 guests in Princeville",
      link: "https://www.airbnb.com/rooms/999",
    },
    "52",
    "Queen Emma",
  ) === false,
);

check(
  "accepts explicit unit marker for longer unit numbers",
  snippetMentionsUnit(
    {
      title: "Kaiulani of Princeville Unit 52",
      snippet: "Princeville rental",
      link: "https://www.airbnb.com/rooms/888",
    },
    "52",
    "Queen Emma",
  ) === true,
);

check(
  "rejects Runaway Bay VRBO listing for The Cliffs at Princeville",
  evaluatePreflightSearchResult(
    {
      title: "Runaway Bay Resort 3BR · Unit A",
      snippet: "Jamaica beachfront vacation rental with pool",
      link: "https://www.vrbo.com/1234567",
    },
    "vrbo",
    buildPreflightMatchContext({
      complexName: "The Cliffs at Princeville",
      city: "Princeville",
      unitNumber: "A",
      address: "3811 Edward Rd, Kilauea, Hawaii, Unit A",
      bedrooms: 3,
    }),
  ) === null,
);

check(
  "accepts letter unit A when community, city, and unit marker align",
  evaluatePreflightSearchResult(
    {
      title: "The Cliffs at Princeville · Unit A",
      snippet: "3 bedroom condo at The Cliffs at Princeville, 3811 Edward Rd, Princeville",
      link: "https://www.vrbo.com/7654321",
    },
    "vrbo",
    buildPreflightMatchContext({
      complexName: "The Cliffs at Princeville",
      city: "Princeville",
      unitNumber: "A",
      address: "3811 Edward Rd, Kilauea, Hawaii, Unit A",
      bedrooms: 3,
    }),
  )?.status === "confirmed",
);

// ── Compound-unit-token guard (2026-07-19, Koa Lagoon "Unit B" incident) ──────
// The live SERP row for a Koa Lagoon combo's Unit B carried a snippet describing
// Maui Sunset #B-417 (a DIFFERENT unit in a DIFFERENT Kihei complex); the bare
// letter claim "B" matched inside "#B-417" via `\b` at the hyphen and the check
// rendered a false VRBO "Yes". A claim must match the COMPLETE unit token.
const koaLagoonContext = buildPreflightMatchContext({
  complexName: "Koa Lagoon",
  city: "Kihei",
  unitNumber: "Unit B",
  address: "800 S Kihei Rd, Kihei, Hawaii, Unit B",
  bedrooms: null,
});

check(
  "rejects the Maui Sunset #B-417 snippet for Koa Lagoon Unit B (compound unit token)",
  evaluatePreflightSearchResult(
    {
      title: "Koa Lagoon- Beachfront - Spectacular Location with ...",
      snippet: "Maui Sunset #B-417 Spacious, Renovated Unit, Oceanfront Complex ... Kihei. Located on the beach, this condo is in North Kihei",
      link: "https://www.vrbo.com/1234567",
    },
    "vrbo",
    koaLagoonContext,
  ) === null,
);

check(
  "bare-letter claim does not match inside a hyphenated compound unit ID",
  snippetMentionsUnit(
    { title: "Maui Sunset #B-417 Oceanfront", snippet: "", link: "" },
    "Unit B",
    "S Kihei",
  ) === false,
);

check(
  "bare-letter claim does not match a slug compound like -b-417",
  snippetMentionsUnit(
    { title: "", snippet: "", link: "https://www.vrbo.com/maui-sunset-b-417" },
    "Unit B",
    "",
  ) === false,
);

check(
  "bare-letter claim does not match the tail of a digit-letter compound (417-B)",
  snippetMentionsUnit(
    { title: "Maui Sunset Unit 417-B", snippet: "", link: "" },
    "Unit B",
    "",
  ) === false,
);

check(
  "numeric claim does not match inside a longer compound unit ID (#12-34)",
  snippetMentionsUnit(
    { title: "Oceanfront condo #12-34", snippet: "", link: "" },
    "12",
    "",
  ) === false,
);

check(
  "still accepts a genuine letter unit marker (Unit B)",
  snippetMentionsUnit(
    { title: "Koa Lagoon Unit B — Oceanfront 2BR", snippet: "", link: "" },
    "Unit B",
    "",
  ) === true,
);

check(
  "still accepts a hyphen-into-words title after the unit letter (Unit B - Beachfront)",
  snippetMentionsUnit(
    { title: "Koa Lagoon Unit B - Beachfront condo", snippet: "", link: "" },
    "Unit B",
    "",
  ) === true,
);

check(
  "still accepts a compound claim matched in full (Unit 6-7)",
  snippetMentionsUnit(
    { title: "Beach cottage Unit 6-7 sleeps 10", snippet: "", link: "" },
    "Unit 6-7",
    "",
  ) === true,
);

check(
  "still accepts a letter unit in a URL slug followed by words (-b-kihei)",
  snippetMentionsUnit(
    { title: "", snippet: "", link: "https://www.vrbo.com/koa-lagoon-unit-b-kihei" },
    "Unit B",
    "",
  ) === true,
);

console.log("preflight-platform-match tests passed");