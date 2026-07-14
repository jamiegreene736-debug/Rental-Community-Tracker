// Network-free tests for shared/builder-deep-link.ts — the guest inbox's
// Listing-panel "Photos"/"Descriptions" deep links into the unit builder —
// plus source guards drift-locking the wiring:
//   • GuestyListingBuilder's tab strip keys === BUILDER_TAB_KEYS (set equality)
//   • GuestyListingBuilder seeds activeTab from builderTabFromSearch
//   • inbox.tsx renders both links, new-tab, via builderTabLinkForGuestyListing
//   • the URL's step segment matches builder-preflight's step1Url + App.tsx route
// Run: npx tsx tests/builder-deep-link.test.ts

import { readFileSync } from "node:fs";
import {
  BUILDER_TAB_KEYS,
  BUILDER_STEP_SEGMENT,
  isBuilderTabKey,
  builderTabFromSearch,
  builderTabUrl,
  propertyIdForGuestyListing,
  builderTabLinkForGuestyListing,
} from "../shared/builder-deep-link";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("builder-deep-link: tab key validation");
check("photos is a tab key", isBuilderTabKey("photos"));
check("descriptions is a tab key", isBuilderTabKey("descriptions"));
check("otaVisibility is a tab key", isBuilderTabKey("otaVisibility"));
check("unknown key rejected", !isBuilderTabKey("preflight"));
check("non-string rejected", !isBuilderTabKey(42));

console.log("builder-deep-link: builderTabFromSearch");
check("?tab=photos", builderTabFromSearch("?tab=photos") === "photos");
check("no leading ? accepted", builderTabFromSearch("tab=descriptions") === "descriptions");
check("other params ignored", builderTabFromSearch("?foo=1&tab=pricing&bar=2") === "pricing");
check("invalid tab → null", builderTabFromSearch("?tab=nonsense") === null);
check("missing tab → null", builderTabFromSearch("?foo=1") === null);
check("empty search → null", builderTabFromSearch("") === null);
check("null search → null", builderTabFromSearch(null) === null);
check("undefined search → null", builderTabFromSearch(undefined) === null);

console.log("builder-deep-link: builderTabUrl");
check(
  "core property URL",
  builderTabUrl(4, "photos") === `/builder/4/${BUILDER_STEP_SEGMENT}?tab=photos`,
  builderTabUrl(4, "photos"),
);
check(
  "negative draft id supported",
  builderTabUrl(-12, "descriptions") === `/builder/-12/${BUILDER_STEP_SEGMENT}?tab=descriptions`,
  builderTabUrl(-12, "descriptions"),
);
check("zero id → null", builderTabUrl(0, "photos") === null);
check("NaN id → null", builderTabUrl(Number.NaN, "photos") === null);
check("fractional id → null", builderTabUrl(4.5, "photos") === null);
// The round-trip a deep link actually takes: build the URL, then the builder
// parses its own search string back to the same tab.
const roundTrip = builderTabUrl(19, "photos");
check(
  "URL round-trips through builderTabFromSearch",
  roundTrip !== null && builderTabFromSearch(roundTrip.split("?")[1]) === "photos",
  roundTrip,
);

console.log("builder-deep-link: propertyIdForGuestyListing");
const MAP = [
  { propertyId: 4, guestyListingId: "abc123" },
  { propertyId: -12, guestyListingId: "draft456" },
];
check("maps a core listing", propertyIdForGuestyListing("abc123", MAP) === 4);
check("maps a draft listing (negative id)", propertyIdForGuestyListing("draft456", MAP) === -12);
check("unmapped listing → null", propertyIdForGuestyListing("nope", MAP) === null);
check("null listing id → null", propertyIdForGuestyListing(null, MAP) === null);
check("undefined rows → null (query not resolved yet)", propertyIdForGuestyListing("abc123", undefined) === null);
check("empty rows → null", propertyIdForGuestyListing("abc123", []) === null);

console.log("builder-deep-link: builderTabLinkForGuestyListing");
check(
  "mapped listing → photos URL",
  builderTabLinkForGuestyListing("abc123", MAP, "photos") === `/builder/4/${BUILDER_STEP_SEGMENT}?tab=photos`,
);
check(
  "draft listing → descriptions URL",
  builderTabLinkForGuestyListing("draft456", MAP, "descriptions") === `/builder/-12/${BUILDER_STEP_SEGMENT}?tab=descriptions`,
);
check("unmapped listing → null (buttons hidden)", builderTabLinkForGuestyListing("nope", MAP, "photos") === null);

// ── Source guards ────────────────────────────────────────────────────────────
console.log("builder-deep-link: source guards (wiring drift-locks)");
const builderComponentSource = readFileSync("client/src/components/GuestyListingBuilder/index.tsx", "utf8");
const inboxSource = readFileSync("client/src/pages/inbox.tsx", "utf8");
const preflightSource = readFileSync("client/src/pages/builder-preflight.tsx", "utf8");
const appSource = readFileSync("client/src/App.tsx", "utf8");

// The tab strip's rendered key list must stay set-equal to BUILDER_TAB_KEYS —
// adding/renaming a tab in one place but not the other silently breaks deep
// links (an unknown ?tab= falls back to "descriptions" with no error).
const stripMatch = builderComponentSource.match(/\{\(\[([^\]]+)\] as const\)\.map\(\(t\) =>/);
check("tab strip literal list found", !!stripMatch, "tab-strip regex found no match");
if (stripMatch) {
  const stripKeys = stripMatch[1]
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  const shared = new Set<string>(BUILDER_TAB_KEYS);
  check(
    "tab strip keys === BUILDER_TAB_KEYS (set equality)",
    stripKeys.length === shared.size && stripKeys.every((k) => shared.has(k)),
    { stripKeys, shared: Array.from(shared) },
  );
}
check(
  "builder seeds activeTab from builderTabFromSearch(window.location.search)",
  /useState<BuilderTabKey>\(\s*\(\) => builderTabFromSearch\(/.test(builderComponentSource),
);
check(
  "builder default tab stays descriptions",
  builderComponentSource.includes(`?? "descriptions"`),
);

check(
  "inbox renders the Photos deep link",
  inboxSource.includes(`builderTabLinkForGuestyListing(inboxListingId, guestyPropertyMapRows, "photos")`),
);
check(
  "inbox renders the Descriptions deep link",
  inboxSource.includes(`builderTabLinkForGuestyListing(inboxListingId, guestyPropertyMapRows, "descriptions")`),
);
check(
  "inbox photos button testid present",
  inboxSource.includes(`data-testid="button-inbox-listing-photos"`),
);
check(
  "inbox descriptions button testid present",
  inboxSource.includes(`data-testid="button-inbox-listing-descriptions"`),
);
check(
  "inbox links open in a new tab (conversation stays open)",
  /button-inbox-listing-photos[\s\S]{0,400}target="_blank"/.test(inboxSource),
);
check(
  "inbox fetches /api/guesty-property-map",
  inboxSource.includes(`queryKey: ["/api/guesty-property-map"]`),
);

// URL shape must match what the app actually routes: builder-preflight's
// "Continue to Builder" uses /builder/<id>/step-1 and App.tsx routes
// /builder/:propertyId/:step to the Builder page. If either changes, the
// shared BUILDER_STEP_SEGMENT must change with it.
check(
  "preflight step1Url uses the same step segment",
  preflightSource.includes(`/builder/\${id}/${BUILDER_STEP_SEGMENT}`),
);
check(
  "App.tsx routes /builder/:propertyId/:step",
  appSource.includes(`path="/builder/:propertyId/:step"`),
);

console.log(`\nbuilder-deep-link: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
