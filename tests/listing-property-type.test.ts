/**
 * Property-type gate + source-fact cross-check (2026-07-22).
 *
 * Root cause (Mauna Lani Point draft -13, unit A): the replace flow committed
 * 68-1034 Mauna Lani Point Dr — a 4BR SINGLE-FAMILY HOUSE on the condo
 * community's street — as a condo unit replacement (unit_swaps 65). Redfin's
 * page said `"propertyType": "single family residential"` and `numBeds:4` the
 * whole time; the fact was scraped into ListingFacts.homeType but only the
 * single-listing find-clean-unit wizard ever consulted it. Later find-new runs
 * then overwrote the unit's gallery/URL/bedrooms with a different condo (E304)
 * while leaving the house's ADDRESS on the draft — a scrambled identity.
 *
 * Locks:
 *  1. the pure detection/normalization/rejection functions,
 *  2. the find-unit + fetch-unit-photos + find-new wiring (source guards),
 *  3. persist-photos identity atomicity wiring,
 *  4. the source-page fact cross-check wiring.
 */
import { readFileSync } from "fs";
import {
  condoCommunityExpected,
  detectBedroomsFromListingHtml,
  detectPropertyTypeFromListingHtml,
  normalizeListingPropertyType,
  replacementPropertyTypeRejection,
  sourceListingFactContradiction,
} from "../shared/listing-property-type";
import { findNewDiscoveryResultRejection } from "../shared/preflight-photo-discovery";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`, extra ?? "");
  }
};

console.log("listing-property-type: normalization");
{
  check("Redfin 'Single Family Residential' → single_family", normalizeListingPropertyType("Single Family Residential") === "single_family");
  check("Redfin 'single family residential' (lowercase JSON) → single_family", normalizeListingPropertyType("single family residential") === "single_family");
  check("Zillow SINGLE_FAMILY enum → single_family", normalizeListingPropertyType("SINGLE_FAMILY") === "single_family");
  check("Redfin 'Condo/Co-op' → condo", normalizeListingPropertyType("Condo/Co-op") === "condo");
  check("Zillow CONDO enum → condo", normalizeListingPropertyType("CONDO") === "condo");
  check("'Condominium' → condo", normalizeListingPropertyType("Condominium") === "condo");
  check("'Townhouse' → townhouse", normalizeListingPropertyType("Townhouse") === "townhouse");
  check("'TOWNHOME' → townhouse", normalizeListingPropertyType("TOWNHOME") === "townhouse");
  check("'Vacant Land' → lot", normalizeListingPropertyType("Vacant Land") === "lot");
  check("'Mobile/Manufactured' → manufactured", normalizeListingPropertyType("Mobile/Manufactured") === "manufactured");
  check("'Apartment' → apartment", normalizeListingPropertyType("Apartment") === "apartment");
  check("empty/absent → null", normalizeListingPropertyType("") === null && normalizeListingPropertyType(null) === null && normalizeListingPropertyType(undefined) === null);
  check("gibberish → other (recognized as present but unclassified)", normalizeListingPropertyType("weird thing") === "other");
}

console.log("listing-property-type: condo-community expectation");
{
  check("draft propertyType 'Condominium' expects condos", condoCommunityExpected("Condominium", null));
  check("unitTypes 'condominium' expects condos", condoCommunityExpected(null, "condominium"));
  check("builder 'Apartment' expects condos", condoCommunityExpected("Apartment", null));
  check("'Townhouse' expects condo-like", condoCommunityExpected("Townhouse", null));
  check("'House' does NOT expect condos", !condoCommunityExpected("House", null));
  check("unknown/empty does NOT expect condos (gate off)", !condoCommunityExpected(null, null) && !condoCommunityExpected("", ""));
}

console.log("listing-property-type: replacement rejection");
{
  // The exact Mauna Lani shape: condo community, Redfin Apify propertyCategory.
  check(
    "single-family house rejected for a condo community",
    replacementPropertyTypeRejection({ expectCondoUnits: true, homeType: "Single Family Residential" }) !== null,
  );
  check(
    "Zillow SINGLE_FAMILY rejected for a condo community",
    replacementPropertyTypeRejection({ expectCondoUnits: true, homeType: "SINGLE_FAMILY" }) !== null,
  );
  check(
    "lot/land rejected for a condo community",
    replacementPropertyTypeRejection({ expectCondoUnits: true, homeType: "Vacant Land" }) !== null,
  );
  check(
    "condo accepted",
    replacementPropertyTypeRejection({ expectCondoUnits: true, homeType: "CONDO" }) === null,
  );
  check(
    "townhouse accepted",
    replacementPropertyTypeRejection({ expectCondoUnits: true, homeType: "Townhouse" }) === null,
  );
  check(
    "unknown type accepted (fail-open — absence of evidence never rejects)",
    replacementPropertyTypeRejection({ expectCondoUnits: true, homeType: null }) === null
      && replacementPropertyTypeRejection({ expectCondoUnits: true }) === null,
  );
  check(
    "house accepted when the community is NOT condo-like (gate conditional)",
    replacementPropertyTypeRejection({ expectCondoUnits: false, homeType: "Single Family Residential" }) === null,
  );
  check(
    "condo-ish PRIMARY type wins over a noisy sub-type",
    replacementPropertyTypeRejection({ expectCondoUnits: true, homeType: "CONDO", propertySubType: "Vacant Land" }) === null,
  );
  check(
    "sub-type-only single-family detection still rejects",
    replacementPropertyTypeRejection({ expectCondoUnits: true, homeType: null, propertySubType: "Single Family Residential" }) !== null,
  );
}

console.log("listing-property-type: HTML detection (live Redfin shapes)");
{
  // Shapes verified live 2026-07-22 against the two real pages of this incident.
  const houseHtml = `<html>{"propertyType": "single family residential","numBeds\\":4,"propertyTypeName\\":\\"Single Family Residential\\"}</html>`;
  const condoHtml = `<html>{"propertyType": "condo/co-op","numBeds\\":3,"propertyTypeName\\":\\"Condo/Co-op\\"}</html>`;
  check("68-1034 house page detects single_family", normalizeListingPropertyType(detectPropertyTypeFromListingHtml(houseHtml)) === "single_family");
  check("E304 condo page detects condo", normalizeListingPropertyType(detectPropertyTypeFromListingHtml(condoHtml)) === "condo");
  check("68-1034 house page detects 4 bedrooms", detectBedroomsFromListingHtml(houseHtml) === 4);
  check("E304 condo page detects 3 bedrooms", detectBedroomsFromListingHtml(condoHtml) === 3);
  const zillowHtml = `<script>{"homeType":"SINGLE_FAMILY","bedrooms":5}</script>`;
  check("Zillow homeType enum detected", normalizeListingPropertyType(detectPropertyTypeFromListingHtml(zillowHtml)) === "single_family");
  check("Zillow bedrooms detected", detectBedroomsFromListingHtml(zillowHtml) === 5);
  const textHtml = `<div>Property Type</div><div>Single-Family</div><div>4 Beds</div>`;
  check("visible spec-table text detected", normalizeListingPropertyType(detectPropertyTypeFromListingHtml(textHtml)) === "single_family");
  check("empty page → nulls", detectPropertyTypeFromListingHtml("") === null && detectBedroomsFromListingHtml("") === null);
  check("bedroom sanity bound: 0 and 25 rejected", detectBedroomsFromListingHtml('{"bedrooms":0}') === null && detectBedroomsFromListingHtml('{"bedrooms":25}') === null);
}

console.log("listing-property-type: source-fact contradiction");
{
  // The exact incident: unit configured 3BR condo, source page = 4BR house.
  const c = sourceListingFactContradiction({
    unitLabel: "Unit A (3BR)",
    configuredBedrooms: 3,
    scrapedBedrooms: 4,
    expectCondoUnits: true,
    scrapedPropertyType: "single family residential",
  });
  check("4BR house vs 3BR condo config → contradiction", c !== null);
  check("contradiction names both problems", !!c && /4BR/.test(c) && /single family/i.test(c));
  check(
    "matching facts → no contradiction",
    sourceListingFactContradiction({
      unitLabel: "Unit B",
      configuredBedrooms: 3,
      scrapedBedrooms: 3,
      expectCondoUnits: true,
      scrapedPropertyType: "Condo/Co-op",
    }) === null,
  );
  check(
    "absent facts never contradict",
    sourceListingFactContradiction({
      unitLabel: "Unit A",
      configuredBedrooms: 3,
      scrapedBedrooms: null,
      expectCondoUnits: true,
      scrapedPropertyType: null,
    }) === null,
  );
  check(
    "house source fine for a non-condo community",
    sourceListingFactContradiction({
      unitLabel: "Unit A",
      configuredBedrooms: 4,
      scrapedBedrooms: 4,
      expectCondoUnits: false,
      scrapedPropertyType: "Single Family Residential",
    }) === null,
  );
}

console.log("listing-property-type: find-new rejection integration");
{
  check(
    "find-new rejects on a property-type rejection reason",
    findNewDiscoveryResultRejection({
      findNewSource: true,
      representativeFallback: false,
      bedroomMatch: true,
      propertyTypeRejection: "Wrong property type for a condo community: listing is Single Family Residential (need condo / townhouse / apartment).",
    }) !== null,
  );
  check(
    "find-new accepts when propertyTypeRejection is null",
    findNewDiscoveryResultRejection({
      findNewSource: true,
      representativeFallback: false,
      bedroomMatch: true,
      propertyTypeRejection: null,
    }) === null,
  );
  check(
    "non-find-new flows unaffected by property-type reasons",
    findNewDiscoveryResultRejection({
      findNewSource: false,
      representativeFallback: false,
      bedroomMatch: null,
      propertyTypeRejection: "anything",
    }) === null,
  );
}

console.log("listing-property-type: wiring source guards");
{
  const routesSrc = readFileSync("server/routes.ts", "utf8");
  check(
    "find-unit candidate loop rejects on replacementPropertyTypeRejection",
    /verdict: "skipped-property-type"/.test(routesSrc)
      && /replacementPropertyTypeRejection\(\{\s*\n\s*expectCondoUnits,\s*\n\s*homeType: candidateFacts\.homeType/.test(routesSrc),
  );
  check(
    "find-unit derives expectCondoUnits from the draft/builder's own type",
    /expectCondoUnits = condoCommunityExpected\(gateDraft\?\.propertyType, gateDraft\?\.unitTypes\)/.test(routesSrc)
      && /condoCommunityExpected\(gateBuilder\?\.propertyType \?\? null, null\)/.test(routesSrc),
  );
  check(
    "fetch-unit-photos discovery loop gates on expectCondoUnits body flag",
    /expectCondoUnits: bodyExpectCondoUnits === true,\s*\n\s*homeType: facts\.homeType/.test(routesSrc),
  );
  check(
    "persist-photos applies unit identity atomically with the source URL",
    /update\.unit1Address = unit1Identity\.address;/.test(routesSrc)
      && /update\.unit2Address = unit2Identity\.address;/.test(routesSrc)
      && /if \(unit1Identity\.bedrooms\) update\.unit1Bedrooms = unit1Identity\.bedrooms;/.test(routesSrc),
  );
  check(
    "persist-photos reconciles combinedBedrooms after an identity bedroom change",
    /combined !== \(freshDraft\.combinedBedrooms \?\? 0\)\) update\.combinedBedrooms = combined;/.test(routesSrc),
  );

  const jobSrc = readFileSync("server/preflight-background-jobs.ts", "utf8");
  check(
    "photo-fetch job derives expectCondoUnits and sends it to fetch-unit-photos",
    /expectCondoUnits = condoCommunityExpected\(gateDraft\?\.propertyType, gateDraft\?\.unitTypes\)/.test(jobSrc)
      && /\n\s*expectCondoUnits,\s*\n/.test(jobSrc),
  );
  check(
    "photo-fetch job passes propertyTypeRejection into findNewDiscoveryResultRejection",
    /propertyTypeRejection: replacementPropertyTypeRejection\(\{/.test(jobSrc),
  );
  check(
    "find-new persist sends the accepted listing's identity (address + bedrooms)",
    /const identity = findNewSource && sourceUrl/.test(jobSrc)
      && /address: parseListingAddressFromUrl\(sourceUrl\)/.test(jobSrc)
      && /unit1Identity: identity/.test(jobSrc)
      && /unit2Identity: identity/.test(jobSrc),
  );

  const spSrc = readFileSync("server/source-page-community-check.ts", "utf8");
  check(
    "source-page check computes the deterministic fact contradiction",
    /sourceListingFactContradiction\(\{/.test(spSrc)
      && /detectBedroomsFromListingHtml\(html\)/.test(spSrc)
      && /detectPropertyTypeFromListingHtml\(html\)/.test(spSrc),
  );
  const pccSrc = readFileSync("server/photo-community-check.ts", "utf8");
  check(
    "photo-community check passes configured bedrooms + condo context to the source-page leg",
    /configuredBedrooms: typeof g\.expectedBedrooms === "number"/.test(pccSrc)
      && /expectCondoUnits: request\.expectCondoUnits === true/.test(pccSrc),
  );
  check(
    "photo-community check FAILS on a source-fact contradiction",
    /if \(sp\.factContradiction\) \{\s*\n\s*fail\(/.test(pccSrc),
  );
  const bpgSrc = readFileSync("server/builder-photo-groups.ts", "utf8");
  check(
    "server-built check requests carry expectCondoUnits for both builders and drafts",
    /expectCondoUnits: condoCommunityExpected\(builder\.propertyType \?\? null, null\)/.test(bpgSrc)
      && /expectCondoUnits: condoCommunityExpected\(draft\.propertyType/.test(bpgSrc),
  );
  const reportSrc = readFileSync("client/src/components/photo-community-check-report.tsx", "utf8");
  check(
    "shared report renders the fact contradiction",
    /sp\.factContradiction/.test(reportSrc),
  );
}

console.log(`\nlisting-property-type: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
