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

console.log("preflight-platform-match tests passed");