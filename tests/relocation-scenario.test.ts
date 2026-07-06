// Network-free unit tests for shared/relocation-scenario.ts — the
// same-community "Alternative Unit" relocation: verdict consensus over the
// attached buy-ins, honest bedroom parsing from listing titles, scenario
// classification, and the bedroom-count-focused message lines. Plus source
// assertions locking the routes.ts / bookings.tsx wiring.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  sameCommunityConsensusFromVerdicts,
  anyDifferentCommunityVerdict,
  bedroomsFromListingTitleText,
  classifyRelocationScenario,
  buildSameCommunityRelocationLines,
  stripListingTitleCruftFromCommunityLabel,
  sameCommunityLabelMatch,
  sameBuildingFromAddresses,
} from "../shared/relocation-scenario";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("relocation-scenario: sameCommunityConsensusFromVerdicts");
check("all same_building → same_building", sameCommunityConsensusFromVerdicts(["same_building", "same_building"]) === "same_building");
check("mixed positives → same_community", sameCommunityConsensusFromVerdicts(["same_building", "same_community"]) === "same_community");
check("all same_community → same_community", sameCommunityConsensusFromVerdicts(["same_community"]) === "same_community");
check("any different → null", sameCommunityConsensusFromVerdicts(["same_community", "different"]) === null);
check("any missing verdict → null", sameCommunityConsensusFromVerdicts(["same_community", null]) === null);
check("legacy/unknown value → null", sameCommunityConsensusFromVerdicts(["same_community", "maybe"]) === null);
check("empty list → null", sameCommunityConsensusFromVerdicts([]) === null);
check("case/whitespace tolerated", sameCommunityConsensusFromVerdicts([" Same_Building "]) === "same_building");

console.log("relocation-scenario: anyDifferentCommunityVerdict");
check("different present → true", anyDifferentCommunityVerdict(["same_community", "different"]) === true);
check("no different → false", anyDifferentCommunityVerdict(["same_community", null]) === false);
check("empty → false", anyDifferentCommunityVerdict([]) === false);

console.log("relocation-scenario: bedroomsFromListingTitleText");
check("1BR/1BA style", bedroomsFromListingTitleText("Poipu Sands 1BR/1BA Oceanview") === 1);
check("skips the BA, finds the BR", bedroomsFromListingTitleText("Gorgeous 2BA/3BR condo") === 3);
check("spelled-out bedroom", bedroomsFromListingTitleText("Spacious 2 Bedroom Condo at Pili Mai") === 2);
check("hyphenated 3-bed", bedroomsFromListingTitleText("Cozy 3-bed villa") === 3);
check("bdrm abbreviation", bedroomsFromListingTitleText("1 Bdrm Garden View") === 1);
check("'2 beds' is furniture, not bedrooms", bedroomsFromListingTitleText("Sleeps 4 with 2 beds") === null);
check("no bedroom token → null", bedroomsFromListingTitleText("Unit 38 at Pili Mai, sleeps 6") === null);
check("empty/null → null", bedroomsFromListingTitleText(null) === null && bedroomsFromListingTitleText("") === null);

console.log("relocation-scenario: classifyRelocationScenario");
check("not same community → different-community", classifyRelocationScenario({ sameCommunity: false, originalBedrooms: 4, newBedrooms: 3 }).kind === "different-community");
const drop1 = classifyRelocationScenario({ sameCommunity: true, originalBedrooms: 4, newBedrooms: 3 });
check("4→3 → fewer-bedrooms", drop1.kind === "same-community-fewer-bedrooms", drop1);
check("4→3 dropped = 1", drop1.bedroomsDropped === 1, drop1);
check("equal bedrooms → same-community", classifyRelocationScenario({ sameCommunity: true, originalBedrooms: 4, newBedrooms: 4 }).kind === "same-community");
check("more bedrooms → same-community (no drop)", classifyRelocationScenario({ sameCommunity: true, originalBedrooms: 3, newBedrooms: 5 }).bedroomsDropped === 0);
check("missing counts → same-community", classifyRelocationScenario({ sameCommunity: true, originalBedrooms: null, newBedrooms: 3 }).kind === "same-community");

console.log("relocation-scenario: buildSameCommunityRelocationLines (flagship: 4BR booking → 2BR+1BR same community, party of 6)");
const flagship = buildSameCommunityRelocationLines({
  placeLabel: "Pili Mai",
  sameBuilding: false,
  originalBedrooms: 4,
  newBedrooms: 3,
  totalSleeps: 10,
  partySize: 6,
  unitCount: 2,
});
check("arrange: two replacement units", flagship.arrangeLine.includes("two replacement units"), flagship.arrangeLine);
check("arrange: names the place", flagship.arrangeLine.includes("at Pili Mai"), flagship.arrangeLine);
check("arrange: same community you originally booked", flagship.arrangeLine.includes("the same community you originally booked"), flagship.arrangeLine);
check("bedroom: both units still in the same community", flagship.bedroomLine.includes("Both units are still in the same community"), flagship.bedroomLine);
check("bedroom: 3 instead of 4", flagship.bedroomLine.includes("3 bedrooms in total instead of 4"), flagship.bedroomLine);
check("bedroom: just one less bedroom", flagship.bedroomLine.includes("just one less bedroom"), flagship.bedroomLine);
check("bedroom: two units together sleep up to 10", flagship.bedroomLine.includes("two units together sleep up to 10 guests"), flagship.bedroomLine);
check("bedroom: party of 6 fits comfortably", flagship.bedroomLine.includes("your party of 6 will fit comfortably"), flagship.bedroomLine);
check("no community-move framing", !/comparable|drive|moved/i.test(`${flagship.arrangeLine} ${flagship.bedroomLine} ${flagship.pitchLine}`), flagship);
check("ASCII only (Booking.com sanitizer-safe)", !/[^\x00-\x7F]/.test(`${flagship.arrangeLine} ${flagship.bedroomLine} ${flagship.pitchLine}`));

const building = buildSameCommunityRelocationLines({
  placeLabel: "Waikiki Banyan", sameBuilding: true, originalBedrooms: 4, newBedrooms: 3, totalSleeps: 8, partySize: 6, unitCount: 2,
});
check("same building wording", building.arrangeLine.includes("the same building you originally booked") && building.bedroomLine.includes("still in the same building"), building);

const tooSmall = buildSameCommunityRelocationLines({
  placeLabel: "Pili Mai", originalBedrooms: 4, newBedrooms: 3, totalSleeps: 6, partySize: 8, unitCount: 2,
});
check("never claims a fit the sleeps can't cover", !tooSmall.bedroomLine.includes("fit comfortably"), tooSmall.bedroomLine);
check("still states the sleeps capacity", tooSmall.bedroomLine.includes("sleep up to 6 guests"), tooSmall.bedroomLine);

const noSleeps = buildSameCommunityRelocationLines({
  placeLabel: null, originalBedrooms: 4, newBedrooms: 3, unitCount: 2,
});
check("no sleeps → no sleeps sentence", !/sleep/i.test(noSleeps.bedroomLine), noSleeps.bedroomLine);
check("no place → generic same-community lead", noSleeps.arrangeLine.includes("for you - in the same community"), noSleeps.arrangeLine);

const dropTwo = buildSameCommunityRelocationLines({
  placeLabel: "Pili Mai", originalBedrooms: 5, newBedrooms: 3, totalSleeps: 8, unitCount: 2,
});
check("drop of 2 → two fewer bedrooms", dropTwo.bedroomLine.includes("two fewer bedrooms"), dropTwo.bedroomLine);

const single = buildSameCommunityRelocationLines({
  placeLabel: "Pili Mai", originalBedrooms: 2, newBedrooms: 1, totalSleeps: 4, partySize: 3, unitCount: 1,
});
check("single unit: a replacement unit", single.arrangeLine.includes("a replacement unit"), single.arrangeLine);
check("single unit: The unit is / unit sleeps", single.bedroomLine.includes("The unit is") && single.bedroomLine.includes("unit sleeps up to 4 guests"), single.bedroomLine);

const equal = buildSameCommunityRelocationLines({
  placeLabel: "Pili Mai", originalBedrooms: 4, newBedrooms: 4, totalSleeps: 10, partySize: 6, unitCount: 2,
});
check("equal bedrooms → no 'instead of' change line", !equal.bedroomLine.includes("instead of"), equal.bedroomLine);
check("equal bedrooms → states the total", equal.bedroomLine.includes("with 4 bedrooms in total"), equal.bedroomLine);

console.log("relocation-scenario: stripListingTitleCruftFromCommunityLabel (Ilikai live incident)");
check("listing-title label → community name",
  stripListingTitleCruftFromCommunityLabel("Ilikai - 4BR Condos - Sleeps 12") === "Ilikai");
check("case-insensitive cruft", stripListingTitleCruftFromCommunityLabel("Ilikai - 4br Condos - Sleeps 12") === "Ilikai");
check("legit dash-joined name preserved",
  stripListingTitleCruftFromCommunityLabel("Regency - Poipu Kai") === "Regency - Poipu Kai");
check("plain community untouched", stripListingTitleCruftFromCommunityLabel("Ilikai Resort") === "Ilikai Resort");
check("all-cruft label falls back to raw", stripListingTitleCruftFromCommunityLabel("Sleeps 12") === "Sleeps 12");
check("empty → empty", stripListingTitleCruftFromCommunityLabel("") === "" && stripListingTitleCruftFromCommunityLabel(null) === "");

console.log("relocation-scenario: sameCommunityLabelMatch");
check("Ilikai title-label vs Ilikai resort → match",
  sameCommunityLabelMatch("Ilikai - 4BR Condos - Sleeps 12", "Ilikai resort") === true);
check("generic words ignored (Hotel vs resort)", sameCommunityLabelMatch("Ilikai Hotel", "Ilikai resort") === true);
check("bare market/city never matches a containing resort (no subset match)",
  sameCommunityLabelMatch("Princeville", "Princeville Kamalii") === false);
check("sibling resorts don't match", sameCommunityLabelMatch("Poipu Kai", "Poipu Sands") === false);
check("empty side → false", sameCommunityLabelMatch("", "Ilikai resort") === false);
check("generic-only label → false", sameCommunityLabelMatch("The Resort", "Ilikai resort") === false);

console.log("relocation-scenario: sameBuildingFromAddresses (1777 Ala Moana live incident)");
check("unit-suffixed + bare same street → same building",
  sameBuildingFromAddresses(["1777 Ala Moana Blvd #1834", "1777 Ala Moana Blvd"]) === true);
check("with city tails + Apt marker",
  sameBuildingFromAddresses(["1777 Ala Moana Blvd Apt 4B, Honolulu, HI", "1777 Ala Moana Blvd #212, Honolulu, HI 96815"]) === true);
check("different street numbers → false",
  sameBuildingFromAddresses(["1777 Ala Moana Blvd", "1778 Ala Moana Blvd"]) === false);
check("missing address on one unit → false",
  sameBuildingFromAddresses(["1777 Ala Moana Blvd #1834", ""]) === false);
check("unnumbered resort-name 'address' → false",
  sameBuildingFromAddresses(["Ilikai Resort", "Ilikai Resort"]) === false);
check("single unit → false (nothing to compare)", sameBuildingFromAddresses(["1777 Ala Moana Blvd"]) === false);

// ── Source assertions: the wiring in routes.ts + bookings.tsx ───────────────
console.log("relocation-scenario: source wiring");
const here = path.dirname(fileURLToPath(import.meta.url));
const routesSrc = fs.readFileSync(path.join(here, "..", "server", "routes.ts"), "utf8");
const bookingsSrc = fs.readFileSync(path.join(here, "..", "client", "src", "pages", "bookings.tsx"), "utf8");

check("routes: message builder uses the shared same-community lines",
  routesSrc.includes('from "@shared/relocation-scenario"') && routesSrc.includes("buildSameCommunityRelocationLines({"));
check("routes: relocation message takes the same-community branch on the flag",
  routesSrc.includes("if (args.sameCommunity === true) {"));
check("routes: POST resolves sameCommunity from verdict flag OR address proof OR label match, with the different-verdict veto",
  routesSrc.includes("const sameCommunityVeto = req.body?.sameCommunity === false;")
  && routesSrc.includes("addressSameBuilding")
  && routesSrc.includes("sameCommunityLabelMatch(originalCommunity, alternativeLabelForMatch)"));
check("routes: POST parses originalBedrooms + partySize",
  routesSrc.includes("req.body?.originalBedrooms") && routesSrc.includes("req.body?.partySize"));
check("routes: POST sanitizes listing-title community/area labels",
  routesSrc.includes("stripListingTitleCruftFromCommunityLabel(req.body?.originalCommunity)")
  && routesSrc.includes("stripListingTitleCruftFromCommunityLabel(req.body?.areaName)"));
check("routes: same community suppresses the drive-minutes framing",
  routesSrc.includes("const communityDriveMinutes = sameCommunity\n        ? null"));
check("routes: flags (incl. the binding veto) persisted on the page payload",
  routesSrc.includes("sameCommunity,\n        sameBuilding,\n        sameCommunityVeto,\n        originalBedrooms,\n        partySize,"));
check("routes: GET renders the same-community page framing",
  routesSrc.includes("payload.sameCommunity === true") && routesSrc.includes("Same Community as Your Original Booking"));
check("routes: GET self-heals flag-less pages from address + label signals (veto binding)",
  routesSrc.includes("const pageSameCommunityVeto = payload.sameCommunityVeto === true;")
  && routesSrc.includes("pageAddressSameBuilding")
  && routesSrc.includes("sameCommunityLabelMatch(originalCommunity, alternativeCommunity)"));
check("routes: GET suppresses the walk chip in-building and the drive chip in-community",
  routesSrc.includes("!pageSameBuilding && Number.isFinite(unitWalkMinutes)")
  && routesSrc.includes("!pageSameCommunity && Number.isFinite(communityDriveMinutes)"));
check("routes: combined sleeps only claimed when every unit has a sleeps value",
  routesSrc.includes("allUnitSleepsKnown") && routesSrc.includes("allUnitsHaveSleeps"));
check("routes: message walk line dropped for same-building replacements",
  routesSrc.includes("walkLine && args.sameBuilding !== true"));
check("routes: non-VRBO 0-photo units fall back to the sidecar gallery scrape at page build",
  routesSrc.includes("[booking-alternatives] sidecar gallery recovered")
  && routesSrc.includes("!isVrboAlternativeUrl(sourceUrl)"));
check("routes: guest-visible carousel alt text never uses the raw listing title",
  !routesSrc.includes('alt="${escapeHtml(item.title || item.community'));
check("routes: AI unit description told not to frame a move",
  routesSrc.includes("sameCommunityAsOriginal") && routesSrc.includes("When sameCommunityAsOriginal is true"));

check("bookings: dialog derives verdict consensus from the attached buy-ins",
  bookingsSrc.includes('from "@shared/relocation-scenario"') && bookingsSrc.includes("sameCommunityConsensusFromVerdicts("));
check("bookings: explicit different verdict sends sameCommunity=false",
  bookingsSrc.includes("anyDifferentCommunityVerdict("));
check("bookings: honest per-unit bedrooms from the listing title (slot config fallback)",
  bookingsSrc.includes("bedroomsFromListingTitleText(listingTitle) ?? s.bedrooms"));
check("bookings: sends the booked bedroom total + party size",
  bookingsSrc.includes("originalBedrooms") && bookingsSrc.includes("partySize: guestPartyFromReservation(reservation)?.total ?? null"));

console.log(`\nrelocation-scenario: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
