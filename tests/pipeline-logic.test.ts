// Deterministic tests for the photo-pipeline sanity guards and the route
// module's fact extractors. Runs without hitting Anthropic/Apify —
// injects synthetic inputs and asserts the branches behave correctly.
//
// Run: npx tsx tests/pipeline-logic.test.ts

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  auditTopMarketSevenEightFromCuratedSeeds,
  filterTopScanComboCandidates,
  hasAnyTopScanComboPotential,
  hasFourBedroomComboPotential,
  hasFiveBedroomComboPotential,
  hasSixBedroomComboPotential,
  hasSevenEightBedroomComboPotential,
  isTopScanComboCandidate,
  parseCommunityResearchJsonArray,
  researchCommunitiesForCity,
  TOP_MARKET_SEEDS,
} from "../server/community-research";
import { unitBuilderData } from "../client/src/data/unit-builder-data";
import { dedupeListingRoomsByNumber, normalizeGuestyBedType, sanitizeListingRoomsForGuesty, syncSleepsInTitle, syncSleepsInDescription } from "../client/src/data/guesty-listing-config";
import {
  discoveryCityForPhotoSearch,
  discoverySearchCitiesForPhotoSearch,
  discoveryCommunityNameAliases,
  hawaiiHyphenStreetSlugTokens,
  inferCommunityStreetAddress,
  normalizePlatformCheckCity,
  parseCityFromMailingAddress,
  resolveBulkComboListingStreet,
  validateCommunityStreetAddress,
} from "../shared/community-addresses";
import { bulkComboProgressPercent, bulkComboRemainingMs } from "../shared/bulk-combo-queue-progress";
import {
  classifyFailureText,
  suggestRemediations,
  buildOperationDiagnostics,
} from "../shared/operation-diagnostics";
import { MAX_COMBO_PHOTO_OTA_ATTEMPTS } from "../server/combo-ota-preflight";
import { checkCommunityType } from "../shared/community-type";
import {
  formatTypicalComboLabel,
  inferTypicalComboPair,
  normalizeCombinedBedroomsTypical,
  pickBestAvailableComboPairing,
} from "../shared/community-combo";
import { unitVerificationClaims } from "../shared/folder-unit-map";
import { verificationTokensForFolder } from "../shared/photo-folder-utils";
import { MAX_BUY_IN_WALK_MINUTES } from "../shared/walking-distance";
import {
  filterCityVrboListingsByPhrase,
  sharedResortPhraseKeys,
  suggestCityVrboComboPair,
  type CityVrboListing,
} from "../shared/city-vrbo-combo";
import {
  BUY_IN_MARKET_BOUNDS,
  BUY_IN_MARKET_LOCATIONS,
  BUY_IN_MARKETS,
  SIMILAR_BUY_IN_MARKETS,
} from "../shared/buy-in-market";
import { isCommunityOrSharedPhotoCandidate, isStrongLensMatch, lensMatchConfidence } from "../server/photo-match-guardrails";
import {
  buildUnitPhotoResolverProof,
  compareUnitPhotoProofs,
  MIN_INDEPENDENT_UNIT_PHOTOS,
  UNIT_GALLERY_MAX_KEEP,
  unitGalleryMaxKeep,
} from "../server/unit-photo-resolver";
import {
  extractBodyFromRawEmail,
  headersFromInboundEmailPayload,
  isGuestBookingAliasEmail,
  parseEmailHeaders,
  parseGuestInboxEmailFromRaw,
  resolveGuestAliasEmail,
} from "../server/guest-inbox-sync";
import { parseArrivalDetailsFromText, stripHtmlForEmailParse, isBlocklistedPropertyAddress, looksLikeHtmlGarbage, isPlausiblePropertyAddressForBuyIn, pickBestPropertyAddressFromText } from "../server/buy-in-email";
import { mergeArrivalDetailsIntoBuyIn } from "../server/guest-inbox-arrival";
import { buildArrivalDetailsGuestMessage } from "../shared/arrival-details-message";

// ---------- Import the internals we want to test ----------
// The sanity check and fact extractors aren't exported, so we
// replicate their exact logic here from source to test the shape
// of inputs they handle. This is a fixture-level check, not a mock.

// Kept in sync with server/photo-pipeline.ts applyCategorySanityCheck.
const BEDROOM_KEYWORDS = /\b(bed|bedroom|suite|master|guest room|sleeping|primary|bunk|twin|queen|king|double|full)\b/i;
const BATHROOM_KEYWORDS = /\b(bath|bathroom|shower|tub|toilet|vanity|powder|half bath|lavatory|washroom|ensuite|en-suite|jetted)\b/i;
const KITCHEN_KEYWORDS = /\b(kitchen|kitchenette|pantry|breakfast bar)\b/i;
const HARD_CONFIDENCE_FLOOR = 0.40;

type R = { label: string | null; category: string | null; confidence: number };

function sanity(r: R): R {
  if (!r.category || !r.label) return r;
  const label = r.label;
  const cat = r.category;
  const labelHasBed = BEDROOM_KEYWORDS.test(label);
  const labelHasBath = BATHROOM_KEYWORDS.test(label);
  const labelHasKitchen = KITCHEN_KEYWORDS.test(label);
  if ((cat === "Bedrooms" || cat === "Bathrooms") && labelHasKitchen && !labelHasBed && !labelHasBath) {
    return { ...r, category: "Kitchen" };
  }
  if (cat === "Bedrooms" && !labelHasBed) {
    return { ...r, category: "Other" };
  }
  if (cat === "Bathrooms" && !labelHasBath) {
    return { ...r, category: "Other" };
  }
  if ((cat === "Bedrooms" || cat === "Bathrooms") && r.confidence < HARD_CONFIDENCE_FLOOR) {
    return { ...r, category: "Other" };
  }
  return r;
}

// ---------- Tests for the sanity check ----------
console.log("sanity check suite");

// Case 1: Legit bedroom — passes through.
assert.equal(
  sanity({ label: "King Bedroom", category: "Bedrooms", confidence: 0.95 }).category,
  "Bedrooms",
  "legit bedroom should pass through",
);
console.log("  ✓ legit bedroom passes");

// Case 2: Kitchen photo accidentally tagged Bedrooms (the Unit B bug).
assert.equal(
  sanity({ label: "Updated Kitchen With Island", category: "Bedrooms", confidence: 0.9 }).category,
  "Kitchen",
  "kitchen-labeled Bedrooms should demote to Kitchen",
);
console.log("  ✓ kitchen-labeled-as-Bedrooms demotes to Kitchen");

// Case 3: Bedrooms category but label has no bed vocabulary.
assert.equal(
  sanity({ label: "Open Floor Plan", category: "Bedrooms", confidence: 0.9 }).category,
  "Other",
  "Bedrooms category with no bed keywords should demote to Other",
);
console.log("  ✓ Bedrooms with no bed keywords demotes to Other");

// Case 4: Bathrooms with no bath vocabulary.
assert.equal(
  sanity({ label: "Wraparound Porch", category: "Bathrooms", confidence: 0.9 }).category,
  "Other",
  "Bathrooms with no bath keywords should demote to Other",
);
console.log("  ✓ Bathrooms with no bath keywords demotes to Other");

// Case 5: Moderate-confidence Bedroom with bed keywords — TRUST it.
// Previously we demoted anything below 0.70, which under-counted real
// bedrooms. Now only very-low confidence (< 0.40) gets demoted.
assert.equal(
  sanity({ label: "Queen Bedroom", category: "Bedrooms", confidence: 0.65 }).category,
  "Bedrooms",
  "moderate-confidence Bedroom with bed keywords should be trusted",
);
console.log("  ✓ moderate-confidence Bedroom with bed keywords is trusted");

// Case 5b: Very-low confidence Bedroom → demote.
assert.equal(
  sanity({ label: "King Bedroom", category: "Bedrooms", confidence: 0.3 }).category,
  "Other",
  "very-low-confidence Bedroom should demote to Other",
);
console.log("  ✓ very-low-confidence (<0.40) Bedroom demotes");

// Case 6: Low confidence but Kitchen stays (guard only applies to Bed/Bath).
assert.equal(
  sanity({ label: "Updated Kitchen", category: "Kitchen", confidence: 0.5 }).category,
  "Kitchen",
  "low-confidence Kitchen should NOT demote",
);
console.log("  ✓ low-confidence Kitchen stays (only private rooms guarded)");

// Case 6b: "Bedroom With Built-in Cabinet" — previously demoted by
// cabinet-keyword false-positive, now should stay.
assert.equal(
  sanity({ label: "Bedroom With Built-in Cabinet", category: "Bedrooms", confidence: 0.9 }).category,
  "Bedrooms",
  "bedroom with cabinet word should NOT demote to Kitchen",
);
console.log("  ✓ 'Bedroom With Cabinet' stays Bedrooms (cabinet no longer a kitchen trigger)");

// Case 6c: "Kitchen With Island" still demotes when categorized as Bedrooms.
assert.equal(
  sanity({ label: "Kitchen With Island", category: "Bedrooms", confidence: 0.9 }).category,
  "Kitchen",
  "label starting 'Kitchen' in Bedrooms category should demote to Kitchen",
);
console.log("  ✓ 'Kitchen With Island' mislabeled as Bedrooms demotes to Kitchen");

const preflightPhotoVerifyTokens = (unitNumber: string, address: string, folder: string): string[] => {
  const unitScopedTokens = unitVerificationClaims(unitNumber, address);
  return unitScopedTokens.length > 0 ? unitScopedTokens : verificationTokensForFolder(folder) ?? [];
};

assert.deepEqual(
  preflightPhotoVerifyTokens("Unit 5", "4100 Queen Emma's Dr, Princeville, HI 96722, Unit 5", "kaiulani-52"),
  ["5"],
  "preflight photo check should not let shared kaiulani folder tokens verify Unit 5 as the other selected unit",
);
assert.deepEqual(
  preflightPhotoVerifyTokens("Unit 6", "4100 Queen Emma's Dr, Princeville, HI 96722, Unit 6", "kaiulani-52"),
  ["6"],
  "Kaiulani preflight should check the second selected unit only, not split it into units 6 and 7",
);
const preflightSource = readFileSync("client/src/pages/builder-preflight.tsx", "utf8");
const preflightPhotoDiscoverySource = readFileSync("shared/preflight-photo-discovery.ts", "utf8");
const preflightJobsSource = readFileSync("server/preflight-background-jobs.ts", "utf8");
// The audit now runs as a server-side background job; its per-unit payload is
// built from effectiveUnits (which carry unit overrides), and each unit passes
// its photoFolder — so a re-check scans a swapped unit's replacement photo
// folder instead of skipping _isReplaced units. (Was: a `hasUnitPhoto` local in
// the old client-side per-unit loop; relocated, intent preserved.)
assert.match(
  preflightSource,
  /photoFolder: \(unit as any\)\.photoFolder \|\| ""/,
  "preflight audit must include each unit's (replacement) photo folder so re-checks scan swapped units, not skip them",
);
const routesSource = readFileSync("server/routes.ts", "utf8");
assert.match(
  routesSource,
  /Replacement unit found, but its photos could not be saved/,
  "unit replacement must reject swaps when replacement photos cannot be saved",
);
assert.match(
  routesSource,
  /unitSwapPhotoFolderSavedCount[\s\S]*photoCount < MIN_INDEPENDENT_UNIT_PHOTOS[\s\S]*proof\?\.status !== "rejected"[\s\S]*return valid \? savedCount : null/,
  "unit replacement must revalidate existing replacement photo folders before treating them as already hydrated",
);
assert.match(
  routesSource,
  /stagingFolder = `\.\$\{folder\}\.staging[\s\S]*downloadAndPrioritize\(\{[\s\S]*folder: stagingFolder[\s\S]*fs\.promises\.rename\(stagingPath, folderPath\)/,
  "unit replacement photo hydration must stage downloads and only swap into the final folder after proof checks pass",
);
assert.match(
  routesSource,
  /propertyId < 0 && swaps\.length > 0[\s\S]*unit1PhotoFolder/,
  "commit replacement must point promoted-draft unit photo folders at the replacement gallery",
);
const builderPageSource = readFileSync("client/src/pages/builder.tsx", "utf8");
assert.doesNotMatch(
  builderPageSource,
  /propertyId < 0\)\s*\{[\s\S]*setUnitSwaps\(\{\}\)/,
  "builder must load committed unit swaps for promoted drafts (negative propertyId)",
);
assert.match(
  routesSource,
  /COMBO_PHOTO_FETCH_HEARTBEAT_MS/,
  "combo photo fetch jobs must keep heartbeating while long photo discovery is in progress",
);
assert.match(
  routesSource,
  /releaseStaleComboPhotoFetchLease/,
  "combo photo fetch polling must release stale dead-worker leases so Step 4 can resume after deploys",
);
assert.match(
  routesSource,
  /maxCandidates: bedroomOverride === "any" \? 10 : 6/,
  "combo photo fetch discovery must bound candidate scans so Step 4 does not appear stuck on weak markets",
);
assert.match(
  routesSource,
  /Photo discovery failed proof checks/,
  "combo photo fetch items must fail instead of completing when either unit lacks independent photo proof",
);
assert.match(
  routesSource,
  /compareUnitPhotoProofs\(item\.unit1Proof, item\.unit2Proof\)/,
  "combo photo fetch must compare Unit A and Unit B proof before accepting a combo gallery",
);
assert.match(
  routesSource,
  /location root[\s\S]*does not match requested/,
  "bounded unit photo discovery must reject off-street candidates instead of accepting broad-city fallback photos",
);
// Best-gallery scan (2026-07-08): a thin candidate (typically a SOLD listing
// stripped to ~1 og:image) must NOT short-circuit discovery. The loop remembers
// the best thin match, keeps scanning for a >= MIN gallery, and only falls back
// to the thin match if the whole pool comes up short. This is what stops a
// Redfin-heavy resort from failing on a 1-photo sold row that sorted before its
// one full-gallery active listing.
assert.match(
  routesSource,
  /if \(responsePhotos\.length < MIN_INDEPENDENT_UNIT_PHOTOS\) \{[\s\S]*bestThinMatch = \{[\s\S]*continue;/,
  "bounded unit photo discovery must defer thin (<MIN) candidates instead of returning the first >=1-photo listing",
);
assert.match(
  routesSource,
  /if \(bestThinMatch\) \{[\s\S]*return res\.json\(\{[\s\S]*photos: bestThinMatch\.photos/,
  "bounded unit photo discovery must fall back to the best thin match only after scanning the whole pool for a full gallery",
);
// Sidecar photo rescue in the BOUNDED discovery loop (2026-07-09): with
// ScrapingBee dead and Redfin bot-walling BOTH Railway's direct fetch and the
// Apify actor (live: bcj_mrco70f7 — the same unit returned 25 photos once,
// then 0 on every later call), every candidate scraped thin while the
// operator's home-IP Chrome sidecar sat online but unreachable, because the
// loop hardcoded SCRAPE_WITHOUT_SIDECAR. The rescue is BOUNDED (default 2 per
// request, env COMBO_SIDECAR_PHOTO_RESCUES, 0 disables), host-gated to portals
// that HAVE a sidecar leg, bedroom-gated so a wrong-BR candidate never burns a
// credit, budget-gated against the discovery wall, and KEEP-BETTER (a 0-photo
// sidecar run never clobbers the thin result anchoring bestThinMatch). Do NOT
// widen the primary scrape to sidecar wholesale — same rationale as the
// find-unit rescue cap (2026-07-06).
assert.match(
  routesSource,
  /isBoundedDiscovery &&\s*\n\s*!cachedSidecarTried &&\s*\n\s*clusterUrls\.some\(\(clusterUrl\) => \/redfin\\\.com\|homes\\\.com\|zillow\\\.com\/i\.test\(clusterUrl\)\) &&\s*\n\s*dual\.photos\.length < MIN_INDEPENDENT_UNIT_PHOTOS &&\s*\n\s*sidecarPhotoRescuesUsed < maxSidecarPhotoRescues/,
  "bounded unit photo discovery must run a bounded, host-gated sidecar rescue when the datacenter tiers scrape thin",
);
assert.match(
  routesSource,
  /COMBO_SIDECAR_PHOTO_RESCUES \?\? 2/,
  "the discovery sidecar rescue cap must stay env-tunable with a default of 2 per request",
);
assert.match(
  routesSource,
  /bedroomCompatible && \(remainingMs === null \|\| remainingMs >= SIDECAR_PHOTO_RESCUE_MIN_BUDGET_MS\)/,
  "the discovery sidecar rescue must be bedroom-compatible and leave wall-budget headroom before firing",
);
assert.match(
  routesSource,
  /if \(rescued\.photos\.length > dual\.photos\.length\) \{[\s\S]{0,400}dual = rescued;/,
  "the discovery sidecar rescue must keep-better: only a strictly larger rescued gallery replaces the thin result",
);
// Discovery caching + SearchAPI budget guard (2026-07-09, P0 after the quota
// burnout): the same listing URL was re-scraped 8-20x per job and the same
// SERP queries re-fired every pass — burning the entire 100k/month SearchAPI
// allowance (8,398 queries in one hour) and LOSING already-won galleries.
// Wiring guards; the cache/circuit semantics themselves are unit-tested in
// tests/discovery-cache.test.ts + tests/searchapi-budget.test.ts.
// 2026-07-10: the cache READ is now gated by the operator nocache bypass
// (bypassDiscoveryCaches) — a deliberate preflight "re-pull"/"find new photos"
// click must hit the live portals. Bulk-combo never sets nocache, so its
// budget/keep-better protections are unchanged; tests/discovery-cache.test.ts
// locks the bypass wiring from the other side.
assert.match(
  routesSource,
  /const cachedScrape = bypassDiscoveryCaches \? null : listingScrapeCache\.get\(clusterKey\);/,
  "the discovery loop must consult the keep-better scrape cache before re-scraping a candidate (skippable only via the operator nocache bypass)",
);
assert.match(
  routesSource,
  /const newlyDiscoveredMirrorUrls = cachedScrape[\s\S]{0,500}cachedMirrorKeys\.has\(canonicalListingUrlKey\(clusterUrl\)\)/,
  "a cached physical-unit winner must still scrape newly discovered portal mirrors once",
);
assert.match(
  routesSource,
  /listingScrapeCache\.remember\(\s*clusterKey,[\s\S]{0,500}mirrorKeys: Array\.from\(new Set\(\[[\s\S]{0,300}cachedScrape\?\.result\.mirrorKeys[\s\S]{0,200}clusterMirrorKeys/,
  "the discovery loop must keep one stable physical-unit cache entry and remember every portal mirror already tried",
);
assert.match(
  routesSource,
  /createKeepBetterScrapeCache<[\s\S]{0,300}minFullPhotos: MIN_INDEPENDENT_UNIT_PHOTOS/,
  "the scrape cache's thin/full TTL split must key off the same MIN photo floor the proof gates use",
);
assert.match(
  routesSource,
  /const cached = bypassDiscoveryCaches \? null : discoverySerpCache\.get\(q\);[\s\S]{0,600}searchApiDiscoveryCircuit\.isOpen\(\)[\s\S]{0,900}searchApiDiscoveryCircuit\.record429\(\);[\s\S]{0,900}discoverySerpCache\.remember\(q, organic\);/,
  "discovery SERP queries must go through the shared cache (read skippable only via the operator nocache bypass) + 429 circuit wrapper",
);
assert.match(
  routesSource,
  /searchApiSerpStats\.attempted > 0 &&\s*\n\s*searchApiSerpStats\.rateLimited >= searchApiSerpStats\.attempted/,
  "an all-429 zero-candidate discovery must be classified as a quota blackout (503), never as 'no listings exist'",
);
assert.match(
  routesSource,
  /const quota = await getSearchApiQuota\(\);[\s\S]{0,200}searchApiQuotaExhausted\(quota\)/,
  "the bulk combo runner must preflight the SearchAPI quota before research/scraping each item",
);
assert.match(
  routesSource,
  /err\.bulkComboQuotaOutage = true;/,
  "a quota-exhausted preflight must flag the error so the failure message is the outage, not a resort skip",
);
assert.match(
  routesSource,
  /quotaOutage\s*\?\s*\(item\.error \|\| "SearchAPI quota exhausted[\s\S]{0,120}noSourceInventory/,
  "the failure classifier must surface a quota outage verbatim ahead of the genuine-scarcity skip messages",
);
// P2 cleanups (2026-07-09):
// (a) The default Zillow harvest actor (igolaizola) is LOCATION-driven and has
// no URL input — the harvest passed city="" state="" and got 0 items on every
// query (Zillow discovery dead weight). city/state + leg + minBeds must thread
// through, and the sold leg must use the actor's native operation switch.
assert.match(
  routesSource,
  /harvestZillowUrlsViaApifySearchForUrl\(forSaleUrl, forSaleMax, timeoutMs, options, actor, token, "for-sale", city, state\)/,
  "the Zillow Apify harvest must thread real city/state into the location-driven actor input (empty strings dead the whole leg)",
);
assert.match(
  routesSource,
  /if \(leg === "sold"\) input\.operation = "sold";/,
  "the Zillow sold leg must use the actor's native operation switch (the sold search URL is ignored by the location-driven actor)",
);
assert.match(
  routesSource,
  /homeTypes: \["condos", "townhomes"\]/,
  "the Zillow harvest must include townhomes (parity with the Realtor condo-townhome filter; villa communities are townhome-typed)",
);
// (b) Discovery fan-out early-stop: queries run in priority-ordered batches
// and stop once the pool holds ~3x the bounded try limit; in street-gated
// bounded mode only ON-STREET candidates count so off-street noise can't
// starve the queries that find the real building. The sold list is fetched
// ONCE with all four portal patterns (it used to fire 4x for identical SERPs).
assert.match(
  routesSource,
  /if \(enoughDiscoveryCandidates\(\)\) \{[\s\S]{0,400}skipping \$\{unique\.length - i\} remaining \$\{source\} queries/,
  "discovery SERP queries must early-stop once enough candidates are pooled",
);
assert.ok(
  routesSource.includes("const usefulCandidateCount = () => new Set(")
    && routesSource.includes("listingIdentityForCandidate(candidate).streetRoot === suppliedStreetRoot")
    && routesSource.includes("listingIdentityClusterKey(listingIdentityForCandidate(candidate))"),
  "the early-stop target must count distinct on-street unit clusters in bounded street-gated mode",
);
assert.match(
  routesSource,
  /runSoldDiscoveryQueries\(\),\s*\]\);/,
  "the sold sweep must run as ONE multi-pattern pass, not four per-portal re-fetches of the same queries",
);
assert.match(
  routesSource,
  /searchApiSerpStats\.attempted >= maxSerpQueriesPerRequest/,
  "each fetch-unit-photos request must cap its live SERP query spend",
);
// (c) Shared SearchAPI limiter: bulk-combo discovery and the top-market
// research sweep starved each other into 429s when run concurrently — both
// must route their SearchAPI fetches through the shared slot.
assert.match(
  routesSource,
  /const resp = await runWithSearchApiSlot\(\(\) => fetch\(/,
  "bulk-combo discovery SERP fetches must go through the shared SearchAPI limiter",
);
assert.match(
  readFileSync("server/community-research.ts", "utf8"),
  /runWithSearchApiSlot\(\(\) => fetch\(/,
  "top-market research SearchAPI fetches must go through the shared SearchAPI limiter",
);
// Exact-pass loopback timeout (2026-07-09): must outlive the endpoint's 175s
// bounded discovery wall. The old 75s abort silently discarded exact-pass scans
// (including sidecar rescues) that ran past 75s, letting a wrong-BR relaxed
// gallery win over a bedroom-EXACT one the server had already found.
assert.match(
  routesSource,
  /timeoutMs: attempt\.relaxed \? undefined : 190_000/,
  "the combo photo exact pass must not abort before the endpoint's bounded discovery wall (175s) elapses",
);
// Interrupted-attempt refund (2026-07-09): a deploy/restart that kills an item
// mid-attempt must refund that attempt (bounded by the interruption credits) —
// previously only an item already AT max attempts got one back, so a deploy
// landing mid-attempt-1/2 silently ate a genuine retry (live: Ocean Villas
// "Max attempts reached (3)" on bcj_mrco70f7 after the 23:52 deploy).
assert.match(
  routesSource,
  /if \(canRefundAttempt && item\.attemptCount > 0\) \{[\s\S]{0,300}item\.attemptCount -= 1;/,
  "bulk combo recovery must refund the interrupted attempt while interruption credits remain",
);
assert.match(
  routesSource,
  /item\.attemptCount >= BULK_COMBO_LISTING_ITEM_MAX_ATTEMPTS && !item\.draftId && !canRefundAttempt/,
  "bulk combo recovery must still drop an item at max attempts once its interruption credits are exhausted",
);
assert.match(
  routesSource,
  /photo set duplicates .*existing photo source/,
  "one-sided preflight photo persistence must compare against the sibling unit's existing source proof",
);
assert.match(
  routesSource,
  /resolverProof/,
  "fetch-unit-photos must return resolver proof so diagnostics can self-fix based on exact evidence",
);
assert.match(
  routesSource,
  /unitPhotoResolverProof/,
  "persisted draft and replacement photo folders must stamp the resolver proof in _source.json",
);
assert.match(
  routesSource,
  /result\.kept < MIN_INDEPENDENT_UNIT_PHOTOS/,
  "replacement commits must reject photo folders with too few kept photos",
);
assert.match(
  preflightJobsSource,
  /nextProof\.status !== "rejected"/,
  "preflight photo jobs must keep searching instead of persisting proof-rejected candidates",
);
assert.match(
  preflightJobsSource,
  /Only \$\{saved\} photo/,
  "preflight photo jobs must fail when persistence saves fewer than the required independent photos",
);
assert.match(
  preflightJobsSource,
  /withDraftPhotoProofLock[\s\S]*reserveDraftPhotoProof/,
  "parallel preflight unit photo jobs must reserve proof so Unit A and Unit B cannot save the same gallery",
);
assert.match(
  preflightPhotoDiscoverySource,
  /replacingExistingPhotos \? 10 : 12/,
  "preflight Find Photos must bound candidate scans so a no-match does not run for several minutes",
);
assert.match(
  preflightPhotoDiscoverySource,
  /bedrooms: "any", maxCandidates: replacingExistingPhotos \? 14 : 16/,
  "preflight Find Photos must fall back to any bedroom count for representative resort photos",
);
assert.doesNotMatch(
  preflightPhotoDiscoverySource,
  /minBedrooms:/,
  "preflight Find Photos must not require minBedrooms on the relaxed attempt — Zillow often lacks matching BR at the resort",
);
const acceptedUnitProof = buildUnitPhotoResolverProof({
  photos: [
    { url: "https://photos.zillowstatic.com/fp/abc11111-test.jpg" },
    { url: "https://photos.zillowstatic.com/fp/abc22222-test.jpg" },
    { url: "https://photos.zillowstatic.com/fp/abc33333-test.jpg" },
  ],
  sourceUrl: "https://www.zillow.com/homedetails/example/123_zpid/",
  requestedBedrooms: 3,
  facts: { bedrooms: 3 },
});
assert.equal(acceptedUnitProof.status, "accepted", "three distinct photos with matching bedrooms should be accepted");
const sparseUnitProof = buildUnitPhotoResolverProof({
  photos: [
    { url: "https://photos.zillowstatic.com/fp/abc11111-test.jpg" },
    { url: "https://photos.zillowstatic.com/fp/abc11111-other-size.jpg?width=960" },
  ],
  sourceUrl: "https://www.zillow.com/homedetails/example/123_zpid/",
  requestedBedrooms: 3,
  facts: { bedrooms: 3 },
});
assert.equal(sparseUnitProof.status, "rejected", "duplicate photo variants must not count as independent unit proof");
assert.equal(sparseUnitProof.distinctPhotoCount, 1, "Zillow photo fingerprints should collapse size variants");
const contentProof = buildUnitPhotoResolverProof({
  photos: [
    { url: "https://cdn-a.example.com/photo-1.jpg" },
    { url: "https://cdn-b.example.com/photo-2.jpg" },
    { url: "https://cdn-c.example.com/photo-3.jpg" },
  ],
  sourceUrl: "https://www.realtor.com/realestateandhomes-detail/example",
  contentFingerprints: ["sha256:one", "sha256:one", "sha256:two"],
});
assert.equal(contentProof.status, "rejected", "post-download content hashes must be allowed to reject duplicate image bytes across different URLs");
assert.equal(contentProof.distinctPhotoCount, 2, "content hashes should drive distinct photo counts when available");
const duplicateProof = compareUnitPhotoProofs(acceptedUnitProof, buildUnitPhotoResolverProof({
  photos: [
    { url: "https://photos.zillowstatic.com/fp/abc11111-test.jpg" },
    { url: "https://photos.zillowstatic.com/fp/abc22222-test.jpg" },
    { url: "https://photos.zillowstatic.com/fp/abc33333-test.jpg" },
  ],
  sourceUrl: "https://www.zillow.com/homedetails/example/123_zpid/",
  requestedBedrooms: 3,
  facts: { bedrooms: 3 },
}));
assert.equal(duplicateProof.duplicate, true, "same-source/same-photo proof must be treated as duplicate combo evidence");
const contentDuplicateProof = compareUnitPhotoProofs(
  buildUnitPhotoResolverProof({
    photos: [
      { url: "https://zillow.example/a.jpg" },
      { url: "https://zillow.example/b.jpg" },
      { url: "https://zillow.example/c.jpg" },
    ],
    sourceUrl: "https://www.zillow.com/homedetails/example-a/1_zpid/",
    contentFingerprints: ["sha256:a", "sha256:b", "sha256:c"],
  }),
  buildUnitPhotoResolverProof({
    photos: [
      { url: "https://realtor.example/renamed-a.jpg" },
      { url: "https://realtor.example/renamed-b.jpg" },
      { url: "https://realtor.example/renamed-c.jpg" },
    ],
    sourceUrl: "https://www.realtor.com/realestateandhomes-detail/example-b",
    contentFingerprints: ["sha256:a", "sha256:b", "sha256:c"],
  }),
);
assert.equal(contentDuplicateProof.duplicate, true, "same image bytes from different platforms must count as duplicate unit proof");
const relaxedUnitProof = buildUnitPhotoResolverProof({
  photos: [
    { url: "https://photos.zillowstatic.com/fp/relaxed11111-test.jpg" },
    { url: "https://photos.zillowstatic.com/fp/relaxed22222-test.jpg" },
    { url: "https://photos.zillowstatic.com/fp/relaxed33333-test.jpg" },
  ],
  sourceUrl: "https://www.zillow.com/homedetails/example/456_zpid/",
  relaxedSearch: true,
  facts: { bedrooms: 2 },
});
assert.equal(relaxedUnitProof.status, "review", "relaxed bedroom fallback proof must not be marked fully accepted");
assert.equal(MIN_INDEPENDENT_UNIT_PHOTOS, 3, "photo proof minimum should remain aligned with combo/preflight acceptance");
assert.equal(unitGalleryMaxKeep(114), 114, "114-photo replacement gallery should keep all scraped photos");
assert.equal(unitGalleryMaxKeep(200), UNIT_GALLERY_MAX_KEEP, "unit gallery keep should cap at UNIT_GALLERY_MAX_KEEP");
assert.match(
  routesSource,
  /unitGalleryMaxKeep\(scraped\.length\)/,
  "unit replacement photo hydrate must not hard-cap galleries at 25",
);
assert.match(
  preflightSource,
  /replacingExistingPhotos[\s\S]*siblingSourceUrls/,
  "preflight Find different photos must skip a sibling unit's saved source URL so both units cannot re-save the same listing",
);
assert.match(
  preflightSource,
  /photoCountForUnit\(u\.id, u\.photos/,
  "preflight must only block sibling source URLs when that sibling already has saved photos",
);
// "Re-pull all photos" rescrapes the unit's OWN saved listing first (the
// operator wants the full original gallery, not a discovery wander to a
// different/wrong-community listing). Safe because the Redfin comp-carousel
// isolation below guarantees the rescrape returns only the subject listing.
// 2026-07-10: the operator "Find new photos" mode (findNewSource) deliberately
// SKIPS the own-source rescrape — discovery hunts a NEW listing with the current
// source in skipUrls. Plain Re-pull keeps rescraping the saved source first.
assert.match(
  preflightSource,
  /rescrapeSourceUrl: !findNewSource && replacingExistingPhotos && currentSourceUrl/,
  "preflight Re-pull all photos must rescrape the unit's own saved source first (except in find-new-source mode)",
);
assert.match(
  preflightJobsSource,
  /rescrapeSourceUrl[\s\S]*MIN_INDEPENDENT_UNIT_PHOTOS[\s\S]*photos = nextPhotos/,
  "preflight photo job must rescrape the saved source, then fall back to discovery when it yields fewer than MIN_INDEPENDENT_UNIT_PHOTOS",
);
assert.match(
  routesSource,
  /\/api\/preflight\/photo-fetch-jobs[\s\S]*rescrapeSourceUrl[\s\S]*startPreflightPhotoFetchJob/,
  "preflight photo-fetch-jobs API must forward rescrapeSourceUrl into the background job (not drop it at the route boundary)",
);
// Root-cause guard: the Redfin gallery extractor must isolate the subject
// listing's photo set so a unit folder never fills with the nearby/comparable
// homes carousel (the mixed-photos / wrong-community contamination).
assert.match(
  routesSource,
  /isolateRedfinSubjectGallery\(html, urls\)/,
  "Redfin gallery scrape must isolate the subject listing and drop the comparable-homes carousel",
);
// Host-agnostic guard: the generic gallery extractor (Homes.com + other portals,
// not just Redfin) must prefer the subject unit's JSON-LD gallery so the greedy
// page harvest can't bleed the "Nearby similar homes" carousel of OTHER units'
// photos into one unit folder (the jumbled-photos contamination on re-pull).
assert.match(
  routesSource,
  /subjectGalleryFromJsonLd\(html\)[\s\S]*MIN_JSONLD_SUBJECT_GALLERY/,
  "generic gallery scrape must isolate the subject unit via its JSON-LD gallery for non-Redfin portals too",
);
// 2026-07-06 (operator): Redfin's datacenter rescue tier is Apify, replacing
// ScrapingBee (subscription lapsed, quota permanently exhausted). The actor
// must default to a LIMITED_PERMISSIONS Apify actor — a FULL_PERMISSIONS one
// 403s ("full-permission-actor-not-approved") until console-approved, the
// silent-403 class from the 2026-07-06 commit-phase incident.
assert.ok(
  routesSource.includes('(process.env.APIFY_REDFIN_ACTOR || "kawsar~redfin-details-scraper")'),
  "Redfin Apify tier must default to the verified limited-permissions detail actor (APIFY_REDFIN_ACTOR overridable)",
);
// 2026-07-08 (operator, bulk-combo queue skipping Ko Olina resorts): the Redfin
// rescue trigger is WIDENED from zero-only to < MIN_INDEPENDENT_UNIT_PHOTOS —
// Redfin's bot wall serves Railway a page whose static HTML carries ONLY the
// og:image, so an ACTIVE listing scraped to exactly 1 photo and the old === 0
// trigger never fired (proven live: Kuilima Dr units returning 24-30 photos via
// the healthy Apify actor scraped 0-1 direct). The rescue must also KEEP-BETTER:
// an empty/failed Apify run must never clobber the fetch's photos (a lone
// og:image still anchors bestThinMatch's sourceUrl). Do NOT narrow back to === 0.
assert.match(
  routesSource,
  /result\.urls\.length < MIN_INDEPENDENT_UNIT_PHOTOS && isRedfinTarget && process\.env\.APIFY_API_TOKEN[\s\S]{0,2200}scrapeRedfinViaApify\(primaryUrl, options\?\.scrapingBeeTimeoutMs \?\? 180_000\)/,
  "Redfin branch must rescue via the Apify actor (bounded by the caller's rescue-tier timeout) when the direct fetch returns fewer than MIN photos",
);
assert.match(
  routesSource,
  /urls: apify\.urls\.length > result\.urls\.length \? apify\.urls : result\.urls/,
  "Redfin Apify rescue must keep the direct fetch's photos when Apify does not improve on them",
);
assert.match(
  routesSource,
  /result\.urls\.length < MIN_INDEPENDENT_UNIT_PHOTOS && !isRedfinTarget && process\.env\.SCRAPINGBEE_API_KEY/,
  "ScrapingBee must no longer run for Redfin URLs (Homes.com keeps its ScrapingBee leg, also on the widened thin trigger)",
);
assert.match(
  routesSource,
  /result\.urls\.length < MIN_INDEPENDENT_UNIT_PHOTOS[\s\S]{0,1600}sidecar\.photos\.length > result\.urls\.length/,
  "sidecar gallery tier must fire on a thin (not just empty) result and only replace when strictly larger",
);
// The Apify tier must keep the dominant photo-set-id isolation so a leaked
// comparable-homes carousel can never contaminate a unit folder.
assert.match(
  routesSource,
  /scrapeRedfinViaApify[\s\S]{0,3000}redfinPhotoSetId\(u\)/,
  "Redfin Apify tier must apply the dominant photo-set-id isolation guard",
);
assert.match(
  preflightSource,
  /\/api\/preflight\/photo-fetch-jobs/,
  "preflight Find Photos must run on a server-side job so tab close does not abort discovery",
);
assert.match(
  preflightSource,
  /handleScrapePhotosForAllUnits[\s\S]*Promise\.all/,
  "preflight must start photo-fetch jobs for all units needing photos in parallel",
);
assert.match(
  preflightSource,
  /button-scrape-photos-all-units/,
  "preflight must expose Find Photos for All Units when two or more units lack photos",
);
assert.match(
  preflightJobsSource,
  /withDraftPhotoProofLock/,
  "parallel preflight unit photo jobs must serialize proof reservation so Unit A and Unit B cannot save the same gallery",
);
{
  const fetchUnitStart = routesSource.indexOf('app.post("/api/community/fetch-unit-photos"');
  const fetchUnitEnd = routesSource.indexOf('app.post("/api/community/generate-listing"', fetchUnitStart);
  const fetchUnitSource = routesSource.slice(fetchUnitStart, fetchUnitEnd);
  assert.ok(
    fetchUnitSource.includes("groupListingUrlsByIdentity")
      && fetchUnitSource.includes("listingIdentityClusterKey")
      && fetchUnitSource.includes("listingUrlsByCluster.get(clusterKey) ?? [candidate.url]")
      && !fetchUnitSource.includes("const clusterUrls = [candidate.url]"),
    "Add Combo must group same-unit portal mirrors with the shared unit-aware cluster helper",
  );
  assert.ok(
    fetchUnitSource.includes("MAX_FULL_GALLERY_OPTIONS")
      && fetchUnitSource.includes("selectBestPhotoGalleryOption(fullGalleryOptions)"),
    "Add Combo must inspect a bounded set of viable galleries and select the best instead of returning the first adequate result",
  );
}
assert.match(
  routesSource,
  /rescrape-unit-photos[\s\S]*unitGalleryMaxKeep\(scraped\.length\)/,
  "preflight rescrape-unit-photos must not hard-cap galleries at 25",
);
assert.match(
  preflightJobsSource,
  /preflightPhotoDiscoveryAttempts/,
  "preflight photo-fetch jobs must reuse the shared discovery attempt caps",
);
assert.match(
  routesSource,
  /discoveryWallBudgetMs = isBoundedDiscovery \? 175_000 : 130_000/,
  "bounded photo discovery gets a 175s wall budget; the unbounded add-community path gets a 130s budget so the best-gallery scan can't run to the 180s client timeout and surface as zero photos",
);
assert.match(
  routesSource,
  /discoverySearchCitiesForPhotoSearch/,
  "fetch-unit-photos must search multiple Zillow index cities for resorts with mailing-city aliases",
);
assert.match(
  routesSource,
  /triedCandidateUrls/,
  "fetch-unit-photos must return exhausted candidate URLs so preflight retries do not rescrape the same listings",
);
assert.match(
  routesSource,
  /runApifyDiscovery[\s\S]*harvestApifyPhotoDiscoveryBatch/,
  "fetch-unit-photos must always run Apify discovery in the stacked pass even when SearchAPI only surfaced Redfin/Homes",
);
assert.match(
  routesSource,
  /harvestApifyPhotoDiscoveryBatch/,
  "fetch-unit-photos must use stacked Apify discovery batch",
);
assert.match(
  routesSource,
  /runApifyDiscovery[\s\S]*runZillowSearchApiDiscovery[\s\S]*runRealtyApiDiscovery[\s\S]*Promise\.all/,
  "fetch-unit-photos must run Apify, Zillow SearchAPI, and RealtyAPI discovery in parallel",
);
assert.match(
  routesSource,
  /runMarketReconDiscovery[\s\S]*buildMarketReconSearchQueries/,
  "fetch-unit-photos must run a parallel market-recon aggregator sweep",
);
assert.match(
  routesSource,
  /const \[\s*marketReconAdded,\s*apifyCounts,\s*zillowSearchApiAdded,\s*,\s*realtyApiCounts,\s*\] = await Promise\.all\(\[\s*runMarketReconDiscovery\(\),\s*runApifyDiscovery\(\),\s*runZillowSearchApiDiscovery\(\),\s*runSupplementalSearchApiDiscovery\(\),\s*runRealtyApiDiscovery\(\),\s*\]\)/,
  "fetch-unit-photos must not read RealtyAPI counts from the void supplemental SearchAPI promise",
);
assert.match(
  routesSource,
  /runRealtyApiPhotoDiscoveryLeg/,
  "fetch-unit-photos must harvest Realtor URLs via RealtyAPI",
);
assert.match(
  routesSource,
  /isRealtyApiDiscoveryEnabled/,
  "fetch-unit-photos must honor RealtyAPI discovery enablement",
);
assert.match(
  readFileSync("server/realtyapi-discovery.ts", "utf8"),
  /realtyApiPhotoDiscoverySearchType[\s\S]*For_Sale,Sold/,
  "photo discovery must use RealtyAPI For_Sale,Sold search types",
);
assert.match(
  routesSource,
  /isBoundedDiscovery[\s\S]*c\.source === "zillow" \|\| c\.source === "realtor" \|\| c\.source === "redfin" \|\| c\.source === "homes"/,
  "bounded preflight must try all four portal scrapers in parallel stack",
);
assert.match(
  routesSource,
  /hasApifyDiscovery[\s\S]*runApifyDiscovery/,
  "fetch-unit-photos must run stacked Apify discovery when APIFY_API_TOKEN is set",
);
assert.match(
  routesSource,
  /harvestApifyPhotoDiscoveryBatch[\s\S]*cities: apifyCities/,
  "fetch-unit-photos must search multiple Zillow/Realtor index cities via stacked Apify batch",
);
assert.match(
  routesSource,
  /isBoundedDiscovery && suppliedStreetRoot[\s\S]*listingStreetRoot\(link\) === suppliedStreetRoot[\s\S]*addCandidate\(link, "zillow"\)/,
  "bounded preflight must only admit Apify Zillow URLs that match the requested resort street root",
);
// streetRootFromListingAddress moved VERBATIM to shared/listing-url-address.ts
// (2026-07-17, same-unit photo hunt) — routes.ts imports it, so the Hawaii
// slug-normalization guard now reads the shared module.
assert.match(
  readFileSync("shared/listing-url-address.ts", "utf8"),
  /Redfin slugs like "92-1070-1-Olani-St"/,
  "Hawaii Redfin unit slugs must normalize to the same street root as the resort address",
);
assert.match(
  routesSource,
  /import \{ parseListingAddressFromUrl, parseListingAddressFromText, streetRootFromListingAddress \} from "@shared\/listing-url-address"/,
  "routes.ts must import the shared street-root canonicalizers (single implementation)",
);
assert.match(
  routesSource,
  /scrapeListingPhotosDualSource[\s\S]*Promise\.all\(parallelTargets\.map/,
  "listing photo scrape must run all portal URLs in parallel when discovery surfaced them",
);
assert.match(
  routesSource,
  /parallelStackUrlsFromCandidates[\s\S]*redfinUrl[\s\S]*homesUrl/,
  "parallel photo stack must include Redfin and Homes URLs",
);
assert.match(
  routesSource,
  /find-clean-unit[\s\S]*runApifyDiscovery[\s\S]*runZillowSearchApiDiscovery[\s\S]*runRealtyApiDiscovery[\s\S]*Promise\.all/,
  "find-clean-unit must stack Apify, Zillow SearchAPI, and RealtyAPI discovery in parallel",
);
assert.match(
  routesSource,
  /find-unit[\s\S]*runFindUnitStackedRealtyApiDiscovery[\s\S]*runRealtyApiPhotoDiscoveryLeg/,
  "find-unit must run RealtyAPI discovery in parallel with Apify and SearchAPI",
);
assert.doesNotMatch(
  routesSource,
  /harvestRentCastSaleListings|resolveRentCastCandidatesToPortalUrls|isRentCastDiscoveryEnabled/,
  "photo discovery routes must not wire RentCast (RealtorAPI replaces it)",
);
assert.match(
  routesSource,
  /fetch-unit-photos[\s\S]*scrapeListingPhotosDualSource\(clusterUrls/,
  "fetch-unit-photos must parallel-scrape Realtor+Zillow per address cluster",
);
const comboOtaPreflightSource = readFileSync("server/combo-ota-preflight.ts", "utf8");
assert.doesNotMatch(
  comboOtaPreflightSource,
  /void apiKey;[\s\S]*return \{ matches: \{ airbnb: \[\], vrbo: \[\], booking: \[\] \}, checked: 0 \};/,
  "combo photo finding must keep Google Lens reverse-image checks enabled for OTA contamination detection",
);
assert.match(
  routesSource,
  /api\/operations\/reverse-image-listings[\s\S]*Google Lens reverse-image search is disabled/,
  "buy-in on-demand reverse image endpoint must stay disabled for SearchAPI quota preservation",
);
assert.match(
  routesSource,
  /unitGalleryMaxKeep\(rawPhotos\.length\)/,
  "bulk combo photo fetch must not hard-cap galleries at 25",
);
assert.match(
  routesSource,
  /const MAX_PER_UNIT = UNIT_GALLERY_MAX_KEEP/,
  "persist-photos must keep every scraped unit photo up to UNIT_GALLERY_MAX_KEEP",
);
assert.match(
  routesSource,
  /contentFingerprint: `sha256:/,
  "persist-photos must stamp post-download content hashes into resolver proof",
);
assert.match(
  routesSource,
  /stagingPath[\s\S]*fs\.promises\.rename\(unit\.stagingPath, unit\.finalPath\)/,
  "persist-photos must stage downloads and swap into final folders only after proof checks pass",
);
assert.match(
  routesSource,
  /candidateScores/,
  "fetch-unit-photos diagnostics should explain candidate scores and reasons",
);
// 2026-07-06 top-markets/combo-queue hardening locks:
// (1) STRICT bulk mode must never fall back to an OTA-listed candidate's photos
// on attempt exhaustion — the strict callers pass rejectOtaListedFallback and
// fetchComboPhotosForUnit returns the unit EMPTY when the best candidate failed
// the OTA preflight.
assert.match(
  routesSource,
  /rejectOtaListedFallback: strictDistinctBothUnits/,
  "strict combo photo fetch must reject an OTA-listed fallback candidate",
);
assert.match(
  routesSource,
  /if \(bestFailedOta && options\.rejectOtaListedFallback && !unit\?\.url\)/,
  "fetchComboPhotosForUnit must return empty when the exhausted best failed the OTA preflight (search mode; manual URLs are the deep gate's job)",
);
// (2) The bulk combo queue runs a POST-SAVE deep OTA scan gate over the fresh
// draft unit folders (full-gallery Lens) and skips/rolls back on a positive
// found — fail-open on infra, kill switch COMBO_POST_OTA_SCAN=0.
assert.match(
  routesSource,
  /COMBO_POST_OTA_SCAN[\s\S]*?runBulkComboListingStep\(job, item, "ota-scan"[\s\S]*?evaluateComboOtaScanGate/,
  "bulk combo queue must gate publish on the post-save OTA deep scan",
);
assert.match(
  routesSource,
  /"ota-scan": 10 \* 60 \* 1000/,
  "ota-scan step needs its own timeout entry",
);
// (3) The top-markets sweep must research BEYOND the curated Hawaii seeds
// (discoverBeyondSeeds) so curated markets can still surface NEW resorts.
assert.match(
  routesSource,
  /researchCommunitiesForCity\(market\.city, market\.state, "combo", \{ discoverBeyondSeeds: true \}\)/,
  "top-market scan job must pass discoverBeyondSeeds",
);
const communityResearchSource = readFileSync("server/community-research.ts", "utf8");
assert.match(
  communityResearchSource,
  /mode === "combo" && isHawaii && knownComboSeeds\.length > 0 && !deepDiscovery/,
  "the Hawaii seed short-circuit must be bypassable by discoverBeyondSeeds",
);
// (4) Address discovery carries the portal-SERP + Claude web-search rescues
// (both precision-gated) behind the existing maps + reverse-geocode ladder.
const addressDiscoverySource = readFileSync("server/community-address-discovery.ts", "utf8");
assert.match(
  addressDiscoverySource,
  /selectSerpListingAddressCandidate\(results, communityName, query\)/,
  "address discovery must run the portal-SERP slug rescue",
);
assert.match(
  addressDiscoverySource,
  /discoverAddressViaClaudeWebSearch\(\{ communityName, city, state \}\)/,
  "address discovery must run the Claude web-search rescue as the last resort",
);
const dashboardSource = readFileSync("client/src/pages/home.tsx", "utf8");
assert.match(
  dashboardSource,
  /matchedUnits:/,
  "dashboard photo-match aggregation must retain which Unit A/B folder produced a platform match",
);
assert.match(
  dashboardSource,
  /photo-match-units/,
  "dashboard photo-match column must visibly name affected Unit A/B folders when a platform match is found",
);
assert.match(
  dashboardSource,
  /communityUnitCountDisplay\(property\)/,
  "dashboard Units column must use the display helper instead of rendering a dash for unknown community unit counts",
);
assert.match(
  dashboardSource,
  /label: `\$\{low\.toLocaleString\(\)\}-\$\{high\.toLocaleString\(\)\}`/,
  "dashboard Units column must fall back to a numeric range when exact community unit count is unavailable",
);
assert.equal(
  dashboardSource.includes('property.communityUnitCount?.toLocaleString() ?? "—"'),
  false,
  "dashboard Units column must never render a dash for community unit count",
);
const addCommunitySource = readFileSync("client/src/pages/add-community.tsx", "utf8");
assert.match(
  addCommunitySource,
  /button-cancel-photo-fetch-job/,
  "combo photo Step 4 must expose cancellation for a running server photo-fetch job",
);
assert.match(
  addCommunitySource,
  /city-research-history/,
  "Add Combo Listing should show the last city research run and its yielded communities before rerunning a search",
);
assert.match(
  addCommunitySource,
  /resetSweepToMarketPicker/,
  "top-market Scan different markets must clear the completed sweep job before returning to the picker",
);
assert.match(
  addCommunitySource,
  /ignoredSweepJobIdsRef/,
  "top-market polling must ignore a completed job after the operator chooses to scan different markets",
);
assert.match(
  addCommunitySource,
  /Unit 1: \{unit1Photos\.length\} photo/,
  "combo Step 4 photo summary must show Unit 1 and Unit 2 counts independently",
);
assert.doesNotMatch(
  addCommunitySource,
  /Saved \(photos pending\)/,
  "Add Community save must not hide unit-photo persistence failures behind a soft success toast",
);
assert.match(
  addCommunitySource,
  /photos did not persist/,
  "Add Community save must keep the operator on the page when unit-photo persistence fails",
);
assert.match(
  addCommunitySource,
  /photo-empty-\$\{key\}/,
  "combo Step 4 must visibly show when a unit has no attached photos instead of rendering an empty grid",
);
assert.match(
  routesSource,
  /\/api\/community\/research-history/,
  "city research history must be available without starting a new community research job",
);
assert.match(
  routesSource,
  /\/api\/admin\/cleanup-waikiki-4br-drafts/,
  "admin cleanup must expose a narrow route for deleting existing Waikiki 4BR dashboard drafts",
);
assert.match(
  routesSource,
  /eq\(communityDrafts\.combinedBedrooms, 4\)[\s\S]*communityDrafts\.bookingTitle, "%4BR%"/,
  "Waikiki cleanup must delete dashboard drafts with structured or title-based 4BR signals",
);
for (const communityName of ["Waikiki Banyan", "Waikiki Beach Tower", "Waikiki Shore", "Waikiki Sunset"]) {
  assert.match(
    routesSource,
    new RegExp(communityName),
    `Waikiki cleanup must explicitly target ${communityName}`,
  );
}
assert.match(
  routesSource,
  /propertyMarketRates\.propertyId, negativeDraftIds/,
  "Waikiki cleanup must remove market-rate rows keyed by negative draft ids",
);
assert.match(
  routesSource,
  /upsertCommunityResearchSearch/,
  "community research results must be persisted after manual city searches",
);
const schemaSource = readFileSync("shared/schema.ts", "utf8");
assert.match(
  schemaSource,
  /communityResearchSearches/,
  "city research history should have a dedicated table instead of overloading sidecar search variations",
);
const sidecarLaneSource = readFileSync("server/sidecar-lane.ts", "utf8");
assert.match(
  schemaSource,
  /workResourceLocks/,
  "shared resource locks must be schema-backed so long sidecar producers survive restarts and timeouts",
);
assert.match(
  sidecarLaneSource,
  /SIDECAR_LANE_RESOURCE_KEY = "sidecar-browser"/,
  "sidecar lane should protect one shared Chrome/browser resource",
);
assert.match(
  sidecarLaneSource,
  /onConflictDoUpdate[\s\S]*workResourceLocks\.expiresAt[\s\S]*workResourceLocks\.ownerType/,
  "sidecar lane acquisition must atomically keep other buy-in/combo producers out while the lock is active",
);
assert.match(
  routesSource,
  /ownerType: "bulk-combo-listing"/,
  "bulk combo listing queue must participate in the shared sidecar lane",
);
assert.match(
  routesSource,
  /ownerType: "find-buy-in"/,
  "Operations find-buy-in must participate in the shared sidecar lane",
);
console.log("  ✓ combo photo and city research state stay observable");

// ── Bulk "Select all" multi-city sweep: cross-city dedup + already-in-system skip ──
// The operator runs many cities at once and clicks Select all; the SAME resort can
// surface under two adjacent towns. The bulk enqueue must (1) collapse duplicate
// resorts across cities (process each once) and (2) never re-add a community already
// in the system. Both are enforced server-side as the 100%-sure backstop.
assert.ok(
  /dedupSeen|Cross-resort dedup/.test(routesSource)
    && /\$\{nameKey\}\|\$\{stateKey\}/.test(routesSource),
  "bulk-combo enqueue must dedup incoming items by normalized name|state (collapse the same resort across cities)",
);
assert.ok(
  routesSource.includes("isCommunityAlreadyInSystem")
    && /skipIfCommunityInSystem && !input\.allowDuplicate/.test(routesSource),
  "bulk-combo enqueue must drop sweep items whose community is already in the system (skipIfCommunityInSystem)",
);
assert.ok(
  /getComboInventoryForCommunity\(\{ communityName: name, state: target\.state \}\)/.test(routesSource),
  "isCommunityAlreadyInSystem must check inventory CITY-AGNOSTICALLY so a resort saved under another town still counts",
);
assert.ok(
  routesSource.includes("res.status(200).json({ job: null, skipped, deduped })"),
  "bulk-combo enqueue must report (not error) when every item was a duplicate or already in the system",
);
// Client: Select all must not tick resorts already in the system, and the bulk queue
// now hands the RAW community list to the SERVER (research + skip-in-system happen
// server-side, so the whole sweep survives the phone leaving Safari mid-run instead
// of stalling in a client-side "Preparing X/Y…" loop).
assert.ok(
  addCommunitySource.includes("const resortAlreadyInSystem = ")
    && /if \(resortAlreadyInSystem\(c\)\) return;/.test(addCommunitySource),
  "Select-all-eligible sweep must skip resorts already in the system",
);
assert.ok(
  /bulk-combo-listing-jobs\/from-communities/.test(addCommunitySource),
  "bulk sweep/community queue must hand the raw community list to the server-side research endpoint (not build items in the browser)",
);
// Server: the from-communities endpoint resolves each combo (needsResearch →
// "researching" phase) and drops already-in-system resorts as the backstop.
assert.ok(
  /from-communities[\s\S]{0,4000}isCommunityAlreadyInSystem/.test(routesSource),
  "from-communities endpoint must drop resorts already in the system server-side",
);
assert.ok(
  /item\.needsResearch[\s\S]{0,2000}researchBulkComboPairingForItem/.test(routesSource),
  "the durable job must research each sweep item's best combo server-side (needsResearch → researching phase)",
);
console.log("  ✓ bulk sweep dedups resorts across cities and skips already-in-system communities (server-side research)");

// Case 7: Primary Bathroom — valid (has \"Primary\" + \"Bathroom\").
assert.equal(
  sanity({ label: "Primary Bathroom With Shower", category: "Bathrooms", confidence: 0.9 }).category,
  "Bathrooms",
  "primary bathroom should pass",
);
console.log("  ✓ Primary Bathroom passes");

// Case 8: Suite detected as master-adjacent (has \"suite\" keyword).
assert.equal(
  sanity({ label: "Master Suite", category: "Bedrooms", confidence: 0.92 }).category,
  "Bedrooms",
  "master suite should pass",
);
console.log("  ✓ Master Suite passes");

// ---------- Photo match guardrails ----------
console.log("\nphoto match guardrail suite");

assert.equal(
  isStrongLensMatch({ position: 1 }, "visual", 1),
  true,
  "top visual Lens result should be considered strong when SearchAPI omits explicit confidence",
);
assert.equal(
  isStrongLensMatch({ position: 4 }, "visual", 4),
  false,
  "lower-ranked visual Lens results should not count as strong duplicate-photo proof",
);
assert.equal(
  isStrongLensMatch({ score: "82%" }, "organic", 18),
  true,
  "explicit SearchAPI confidence should override source/position fallback",
);
assert.equal(
  lensMatchConfidence({ position: 3 }, "visual", 3),
  0.8,
  "visual result position 3 is the hard edge of the strong-match threshold",
);
assert.equal(
  isCommunityOrSharedPhotoCandidate({
    folder: "unit-721",
    filename: "pool.jpg",
    category: "Pool",
    label: "Resort pool",
  }),
  true,
  "shared amenity photos should be excluded from photo-match evidence",
);
assert.equal(
  isCommunityOrSharedPhotoCandidate({
    folder: "unit-721",
    filename: "14-bedroom-detail.jpg",
    category: "Bedrooms",
    label: "Guest bedroom",
  }),
  false,
  "private bedroom photos should remain eligible for Lens checks",
);
console.log("  ✓ SearchAPI Lens rows are scored and shared photos are filtered");

// ---------- Tests for extractFactsFromJsonLd ----------
// (copied from server/routes.ts for the fixture test)
function extractFactsFromJsonLd(html: string) {
  const out: { bedrooms?: number; bathrooms?: number } = {};
  const matches = Array.from(html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi));
  for (const m of matches) {
    try {
      const parsed = JSON.parse(m[1]);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const obj of items) {
        if (!obj || typeof obj !== "object") continue;
        const bd = obj.numberOfBedrooms ?? obj.numberOfRooms;
        const ba = obj.numberOfBathroomsTotal ?? obj.numberOfFullBathrooms;
        if (out.bedrooms == null && typeof bd === "number" && bd > 0 && bd < 50) {
          out.bedrooms = Math.round(bd);
        }
        if (out.bathrooms == null && typeof ba === "number" && ba > 0 && ba < 50) {
          out.bathrooms = Math.floor(ba);
        }
      }
    } catch {}
  }
  return out;
}

console.log("\nJSON-LD extraction suite");

const jsonLdHtml = `
<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"SingleFamilyResidence","numberOfBedrooms":3,"numberOfBathroomsTotal":2}
</script>
</head></html>`;
const jsonLdResult = extractFactsFromJsonLd(jsonLdHtml);
assert.equal(jsonLdResult.bedrooms, 3, "should extract bedrooms from JSON-LD");
assert.equal(jsonLdResult.bathrooms, 2, "should extract bathrooms from JSON-LD");
console.log("  ✓ extracts bedrooms and bathrooms from SingleFamilyResidence");

// Malformed JSON-LD — should not crash.
const badHtml = `<script type="application/ld+json">{not json</script>`;
const badResult = extractFactsFromJsonLd(badHtml);
assert.equal(badResult.bedrooms, undefined, "malformed JSON-LD should not populate");
console.log("  ✓ malformed JSON-LD doesn't crash");

// ---------- Tests for extractFactsFromText ----------
function extractFactsFromText(html: string) {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const out: { bedrooms?: number; bathrooms?: number } = {};
  const bedMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:beds?\b|bd\b|bedrooms?\b)/i);
  const bathMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:baths?\b|ba\b|bathrooms?\b)/i);
  if (bedMatch) {
    const n = parseFloat(bedMatch[1]);
    if (n > 0 && n < 50) out.bedrooms = Math.round(n);
  }
  if (bathMatch) {
    const n = parseFloat(bathMatch[1]);
    if (n > 0 && n < 50) out.bathrooms = Math.round(n * 2) / 2;
  }
  return out;
}

console.log("\ntext-regex extraction suite");

assert.deepEqual(
  extractFactsFromText("<span>3 bd</span><span>2.5 ba</span>"),
  { bedrooms: 3, bathrooms: 2.5 },
  "should extract 3 bd / 2.5 ba",
);
console.log("  ✓ extracts '3 bd 2.5 ba'");

assert.deepEqual(
  extractFactsFromText("<p>Beautiful 4 bedroom, 3 bathroom home.</p>"),
  { bedrooms: 4, bathrooms: 3 },
  "should extract 4 bedroom 3 bathroom",
);
console.log("  ✓ extracts '4 bedroom 3 bathroom' prose");

assert.deepEqual(
  extractFactsFromText("<strong>3 beds</strong> | <strong>2 baths</strong>"),
  { bedrooms: 3, bathrooms: 2 },
  "should extract 3 beds 2 baths",
);
console.log("  ✓ extracts '3 beds | 2 baths'");

// Half-bath precision check
assert.equal(
  extractFactsFromText("3 bed 2.5 bath").bathrooms,
  2.5,
  "should preserve 2.5 bathrooms",
);
console.log("  ✓ preserves half-bath precision");

// ---------- Tests for extractListingFacts (recursive tree walk) ----------
function extractListingFacts(payload: any) {
  const facts: { bedrooms?: number; bathrooms?: number } = {};
  function walk(o: any, depth: number): void {
    if (depth > 8 || !o || typeof o !== "object") return;
    if (Array.isArray(o)) { for (const v of o) walk(v, depth + 1); return; }
    if (facts.bedrooms == null && typeof o.bedrooms === "number" && o.bedrooms > 0 && o.bedrooms < 50) {
      facts.bedrooms = Math.round(o.bedrooms);
    }
    if (facts.bathrooms == null) {
      let b: number | undefined;
      if (typeof o.bathrooms === "number") b = o.bathrooms;
      else if (typeof o.bathroomsFull === "number") {
        b = o.bathroomsFull + (typeof o.bathroomsHalf === "number" ? o.bathroomsHalf * 0.5 : 0);
      } else if (typeof o.bathroomsTotalInteger === "number") b = o.bathroomsTotalInteger;
      if (typeof b === "number" && b > 0 && b < 50) {
        facts.bathrooms = Math.round(b * 2) / 2;
      }
    }
    for (const v of Object.values(o)) walk(v, depth + 1);
  }
  walk(payload, 0);
  return facts;
}

console.log("\nlisting-facts extraction suite");

// Real Zillow __NEXT_DATA__ shape (simplified).
assert.deepEqual(
  extractListingFacts({
    props: { pageProps: { initialData: { data: { homeInfo: { bedrooms: 3, bathrooms: 2.5 } } } } },
  }),
  { bedrooms: 3, bathrooms: 2.5 },
  "should extract from homeInfo path",
);
console.log("  ✓ walks into homeInfo path and preserves half-bath");

// bathroomsFull + bathroomsHalf reconstruction when `bathrooms` is missing.
assert.deepEqual(
  extractListingFacts({
    props: { pageProps: { data: { bathroomsFull: 2, bathroomsHalf: 1, bedrooms: 3 } } },
  }),
  { bedrooms: 3, bathrooms: 2.5 },
  "should reconstruct 2.5 from Full=2 + Half=1",
);
console.log("  ✓ reconstructs 2.5 from bathroomsFull + bathroomsHalf");

// bathroomsTotalInteger as last-resort.
assert.deepEqual(
  extractListingFacts({ data: { bathroomsTotalInteger: 3, bedrooms: 4 } }),
  { bedrooms: 4, bathrooms: 3 },
  "should use integer fallback",
);
console.log("  ✓ falls back to bathroomsTotalInteger");

// Zero bedrooms (studio) → skipped (kept null).
assert.equal(
  extractListingFacts({ data: { bedrooms: 0, bathrooms: 1 } }).bedrooms,
  undefined,
  "zero bedrooms (studio) should be skipped",
);
console.log("  ✓ skips studios (bedrooms: 0)");

// Junk-huge value → skipped.
assert.equal(
  extractListingFacts({ data: { bedrooms: 999, bathrooms: 1 } }).bedrooms,
  undefined,
  "absurd bedroom count should be skipped",
);
console.log("  ✓ skips absurd bedroom counts");

// Nested array of listings — picks the shallowest match.
assert.deepEqual(
  extractListingFacts({
    searchResults: { listResults: [{ beds: 3, baths: 2 }, { bedrooms: 3, bathrooms: 2 }] },
  }),
  { bedrooms: 3, bathrooms: 2 },
  "should find nested listing data",
);
console.log("  ✓ finds nested list data");

// ---------- Tests for property-units duplicate guard ----------
// Validates that two listings in the same community cannot claim the
// same physical unit. Placeholder ids ("A", "B", "main") are exempt —
// they are display labels used before a real resort unit number has
// been backfilled, so they don't denote identity.
import {
  findDuplicateUnitsInCommunity,
  PROPERTY_UNIT_CONFIGS,
  type PropertyUnitConfig,
} from "../shared/property-units.ts";

console.log("\nproperty-units duplicate guard suite");

// Case 1: Clean config returns no duplicates.
assert.deepEqual(
  findDuplicateUnitsInCommunity({
    100: { community: "Poipu Kai", units: [{ unitId: "721", unitLabel: "Unit 721", bedrooms: 3 }] },
    101: { community: "Poipu Kai", units: [{ unitId: "812", unitLabel: "Unit 812", bedrooms: 3 }] },
  } as Record<number, PropertyUnitConfig>),
  [],
  "distinct unit ids in same community should not collide",
);
console.log("  ✓ distinct unit ids pass");

// Case 2: Same unit id, same community, different properties → collision.
const dupes = findDuplicateUnitsInCommunity({
  100: { community: "Poipu Kai", units: [{ unitId: "721", unitLabel: "Unit 721", bedrooms: 3 }] },
  101: { community: "Poipu Kai", units: [{ unitId: "721", unitLabel: "Unit 721", bedrooms: 3 }] },
} as Record<number, PropertyUnitConfig>);
assert.equal(dupes.length, 1, "should detect one duplicate unit");
assert.equal(dupes[0].community, "Poipu Kai");
assert.equal(dupes[0].unitId, "721");
assert.deepEqual(dupes[0].propertyIds.sort(), [100, 101]);
console.log("  ✓ cross-property collision detected");

// Case 3: Same unit id in different communities → NOT a collision.
assert.deepEqual(
  findDuplicateUnitsInCommunity({
    100: { community: "Poipu Kai",   units: [{ unitId: "A1", unitLabel: "A1", bedrooms: 3 }] },
    101: { community: "Princeville", units: [{ unitId: "A1", unitLabel: "A1", bedrooms: 3 }] },
  } as Record<number, PropertyUnitConfig>),
  [],
  "same unit id across different communities should not collide",
);
console.log("  ✓ cross-community same id is allowed");

// Case 4: Placeholder ids ("A"/"B"/"main") are exempt.
assert.deepEqual(
  findDuplicateUnitsInCommunity({
    100: { community: "Poipu Kai", units: [
      { unitId: "A", unitLabel: "Unit A", bedrooms: 3 },
      { unitId: "B", unitLabel: "Unit B", bedrooms: 3 },
    ] },
    101: { community: "Poipu Kai", units: [
      { unitId: "A", unitLabel: "Unit A", bedrooms: 3 },
      { unitId: "B", unitLabel: "Unit B", bedrooms: 2 },
    ] },
    102: { community: "Windsor Hills", units: [
      { unitId: "main", unitLabel: "Main", bedrooms: 3 },
    ] },
  } as Record<number, PropertyUnitConfig>),
  [],
  "placeholder ids A/B/main should be exempt from the collision check",
);
console.log("  ✓ placeholders A/B/main exempt");

// Case 5: Live config has no duplicates (regression guard against a
// future edit that accidentally reuses a real unit number).
assert.deepEqual(
  findDuplicateUnitsInCommunity(PROPERTY_UNIT_CONFIGS),
  [],
  "live PROPERTY_UNIT_CONFIGS should be free of community+unitId duplicates",
);
console.log("  ✓ live config has no duplicates");

// ---------- Combo draft bedroom reconciliation ----------
import { resolveComboUnitBedrooms } from "../shared/draft-unit-bedrooms.ts";

console.log("\ndraft-unit-bedrooms suite");

assert.deepEqual(
  resolveComboUnitBedrooms({
    listingTitle: "Sunny 6BR for 12 at Waikoloa Villas!",
    unit1Bedrooms: 2,
    unit2Bedrooms: 2,
    combinedBedrooms: 6,
  }),
  { unit1: 3, unit2: 3, combined: 6 },
  "under-counted symmetric units should split combined total",
);
console.log("  ✓ 2+2 vs 6BR title reconciles to 3+3");

assert.deepEqual(
  resolveComboUnitBedrooms({
    listingTitle: "Sunny 6BR for 12 at Waikoloa Villas!",
    unit1Bedrooms: 2,
    unit2Bedrooms: 2,
  }),
  { unit1: 3, unit2: 3, combined: 6 },
  "combined total inferred from listing title when field missing",
);
console.log("  ✓ infers combined from listing title");

assert.deepEqual(
  resolveComboUnitBedrooms({
    unit1Bedrooms: 3,
    unit2Bedrooms: 3,
    combinedBedrooms: 6,
  }),
  { unit1: 3, unit2: 3, combined: 6 },
  "already-correct counts should stay unchanged",
);
console.log("  ✓ correct 3+3 unchanged");

// ---------- Pricing tables (shared/pricing-rates) ----------
console.log("\npricing tables suite");

import { getBuyInRate, suggestPricingArea, BUY_IN_RATES, setLivePropertyMarketRates, targetMarginForProperty, MARKET_RATE_TARGET_MARGIN, PROPERTY_TARGET_MARGIN_OVERRIDES, LODGING_TAX_PCT, applyLodgingTaxGrossUp } from "../shared/pricing-rates";
import { buyInMarketKeyForScoutCommunity, resolveBuyInMarket, searchLocationForBuyInMarket, textMatchesResortPhrase } from "../shared/buy-in-market";
import { buildPricingAuditReceipt } from "../server/pricing-audit-receipt";

// Global market-rate markup is 20% (operator 2026-07-01, was 15%). The
// per-property override chokepoint still returns the global for anyone not
// allow-listed.
assert.equal(MARKET_RATE_TARGET_MARGIN, 0.20, "global default margin is 20%");
assert.equal(targetMarginForProperty(-3), 0.20, "Menehune Shores -3 combo margin 20%");
assert.equal(targetMarginForProperty(4), MARKET_RATE_TARGET_MARGIN, "an unlisted property uses the global 20%");
assert.equal(targetMarginForProperty(undefined), MARKET_RATE_TARGET_MARGIN, "missing propertyId falls back to the global");
assert.equal(targetMarginForProperty(null), MARKET_RATE_TARGET_MARGIN, "null propertyId falls back to the global");
assert.equal(PROPERTY_TARGET_MARGIN_OVERRIDES[-3], 0.20, "override map records the -3 entry");
assert.ok(!(0 in PROPERTY_TARGET_MARGIN_OVERRIDES), "no accidental propertyId 0 override");
console.log("  ✓ targetMarginForProperty overrides only allow-listed properties");

// Lodging-tax table/helper: retained ONLY for the dormant Claude static/all-in
// engine (STATIC_RATE_ENGINE=1). The LIVE median engine stores the raw SearchAPI
// median — the market-rate checkout-tax uplift was REMOVED on operator
// directive 2026-07-10 (see the source guard below).
assert.equal(LODGING_TAX_PCT.hawaii, 0.18, "Hawaii lodging tax ~18%");
assert.equal(LODGING_TAX_PCT.florida, 0.125, "Florida lodging tax ~12.5%");
assert.equal(applyLodgingTaxGrossUp(1000, "Poipu Kai"), 1180, "HI basis grossed up ×1.18");
assert.equal(applyLodgingTaxGrossUp(1000, "Windsor Hills"), 1125, "FL basis grossed up ×1.125");
assert.equal(applyLodgingTaxGrossUp(1000, "Totally Unknown Resort"), 1180, "unknown community defaults to Hawaii");
assert.equal(applyLodgingTaxGrossUp(0, "Poipu Kai"), 0, "zero basis is left unchanged");
// A real BUY_IN_RATES HI key (genuinely region-mapped, not the unknown default).
assert.equal(applyLodgingTaxGrossUp(933, "Poipu Kai"), Math.round(933 * 1.18), "named HI community (Poipu Kai) grossed up ×1.18");
console.log("  ✓ applyLodgingTaxGrossUp stays a pure helper for the dormant static engine");

// SOURCE GUARD (operator 2026-07-10): the live market-rate update path (dashboard
// queue + Pricing-tab "Update Market Rates" button, both via hybrid-pricing)
// must NOT gross the stored basis up for lodging/checkout tax. If either
// assertion trips, someone re-wired the tax uplift into the median engine.
const hybridPricingSource = readFileSync("server/hybrid-pricing.ts", "utf8");
assert.ok(
  !hybridPricingSource.includes("applyLodgingTaxGrossUp"),
  "server/hybrid-pricing.ts must not apply the lodging-tax gross-up (removed 2026-07-10)",
);
assert.ok(
  !hybridPricingSource.includes("MARKET_RATE_LODGING_TAX_DISABLED"),
  "the MARKET_RATE_LODGING_TAX_DISABLED kill-switch went away with the gross-up call site",
);
console.log("  ✓ live median engine stores the raw SearchAPI median (no lodging-tax uplift)");

// SOURCE GUARD (operator 2026-07-15): "Update Market Rates Now" must use the
// SearchAPI Airbnb median engine. The Claude static-rate engine stays dormant
// and OPT-IN only (STATIC_RATE_ENGINE=1), and the Pricing tab no longer renders
// the static-rate plan panel (it advertised the dormant engine and confused the
// operator about which engine the button runs).
assert.ok(
  routesSource.includes('process.env.STATIC_RATE_ENGINE === "1"'),
  "staticRateEngineEnabled must be opt-in — default OFF routes the market-rate update to the SearchAPI Airbnb median engine",
);
assert.ok(
  routesSource.includes("if (staticRateEngineEnabled() && hooks?.forceSearchApi !== true)") &&
  routesSource.includes("forceSearchApi?: boolean"),
  "strict callers can bypass STATIC_RATE_ENGINE and force the live SearchAPI pricing path",
);

const pricingReceipt = buildPricingAuditReceipt({
  propertyId: 23,
  runId: "pricing-test",
  completedAt: "2026-07-17T12:00:00.000Z",
  rows: [{
    bedrooms: 2,
    monthlyRates: {
      "2026-08": {
        medianNightly: 410,
        channelCount: 1,
        sampleCount: 8,
        evidence: { searchedAt: "2026-07-17T11:00:00.000Z" },
        hybrid: { notes: ["Stored SearchAPI median from live Airbnb comps."] },
      },
      "2026-09": {
        medianNightly: 390,
        channelCount: 0,
        sampleCount: 0,
        hybrid: { notes: ["No usable exact-2BR SearchAPI comps; priced from static seasonal buy-in $390."] },
      },
      "2027-08": {
        medianNightly: 422,
        channelCount: 0,
        sampleCount: 0,
        hybrid: { notes: ["Year-2 extrapolation: 2026-08 SearchAPI basis + 3%."] },
      },
    },
  }],
});
assert.equal(pricingReceipt.engine, "searchapi-airbnb");
assert.equal(pricingReceipt.searchAttemptMonths, 2, "live and thin first-year SearchAPI attempts are both receipted");
assert.equal(pricingReceipt.liveCompMonths, 1);
assert.equal(pricingReceipt.staticFallbackMonths, 1);
assert.equal(pricingReceipt.extrapolatedMonths, 1);
assert.match(pricingReceipt.rowFingerprint, /^sha256:[0-9a-f]{64}$/);
assert.throws(
  () => buildPricingAuditReceipt({ propertyId: 23, runId: "none", rows: [{ bedrooms: 2, monthlyRates: {} }] }),
  /no durable SearchAPI monthly research evidence/,
  "a successful HTTP shell without monthly SearchAPI evidence cannot satisfy strict audit provenance",
);
console.log("  ✓ strict pricing receipt proves this invocation's SearchAPI attempts and saved monthly mix");
assert.ok(
  routesSource.includes("forceSearchApi,") &&
  routesSource.includes("refreshHybridPricingForDraft(") &&
  routesSource.includes("refreshHybridPricingForProperty({"),
  "the pricing-tab wrapper forwards forceSearchApi and the bypass falls through to the hybrid SearchAPI engines",
);
assert.equal(
  routesSource.split("(req.body as any)?.forceSearchApi === true").length - 1,
  2,
  "both draft and configured-property refresh routes forward the audit's forceSearchApi request",
);
const builderIndexSource = readFileSync("client/src/components/GuestyListingBuilder/index.tsx", "utf8");
assert.ok(
  !builderIndexSource.includes("StaticRatePlanPanel"),
  "the Pricing tab must not import/render the static-rate plan panel (removed 2026-07-15)",
);
assert.ok(
  !existsSync("client/src/components/GuestyListingBuilder/StaticRatePlanPanel.tsx"),
  "StaticRatePlanPanel.tsx was deleted 2026-07-15 — the dormant static engine is server-side only",
);
console.log("  ✓ Pricing tab is SearchAPI-Airbnb-median only (static-rate panel removed, engine opt-in)");

// Pili Mai 5BR is priced as its actual 3BR + 2BR component buy-ins, not
// as a single 5BR villa comp. The operator-verified September 8-15, 2026
// Airbnb buy-in comps are $532 for 3BR and $384 for 2BR.
assert.equal(getBuyInRate("Pili Mai", 3, undefined, "LOW", "2026-09"), 532);
assert.equal(getBuyInRate("Pili Mai", 2, undefined, "LOW", "2026-09"), 384);
assert.equal(
  getBuyInRate("Pili Mai", 3, undefined, "LOW", "2026-09") +
    getBuyInRate("Pili Mai", 2, undefined, "LOW", "2026-09"),
  916,
  "Pili Mai 3BR + 2BR low-season buy-in should match operator-verified Sep 8-15 comps",
);
console.log("  ✓ Pili Mai component buy-in basis matches operator Sep 2026 comps");

// Windsor Hills now carries a 2BR entry too — without it the dashboard
// fell through to the FALLBACK_RATE_PER_BEDROOM (Hawaii-tier $270/BR)
// for any 2BR Disney-area draft.
assert.equal(getBuyInRate("Windsor Hills", 2), 150, "Windsor Hills 2BR base should be $150");
assert.equal(getBuyInRate("Southern Dunes", 2), 85, "Southern Dunes 2BR base should be $85");
console.log("  ✓ Florida 2BR rates filled in");

// Region-aware fallback: a Florida community not in the table picks
// the FL per-BR rate, NOT the Hawaii one. The bug we just fixed had a
// global $270/BR fallback that produced $540 per 2BR unit on Florida
// drafts where the real cost basis is closer to $125.
assert.equal(
  getBuyInRate("Southern Dunes", 5),
  80 * 5,
  "unknown bedroom count on a Florida community should use the FL fallback ($80/BR)",
);
console.log("  ✓ Florida fallback is $80/BR");

setLivePropertyMarketRates([{
  propertyId: 900001,
  bedrooms: 2,
  medianNightly: 100,
  medianNightlyHigh: 150,
  medianNightlyHoliday: 225,
  monthlyRates: {
    "2026-07": { medianNightly: 60, season: "HIGH", sampleCount: 1 },
  },
  sampleCount: 12,
  refreshedAt: "2026-05-13T00:00:00.000Z",
  source: "season-band-multichannel-median",
}]);
assert.equal(
  getBuyInRate("Windsor Hills", 2, 900001, "HIGH", "2026-07"),
  60,
  "live monthly median should drive pricing when yearMonth is supplied",
);
assert.equal(
  getBuyInRate("Windsor Hills", 2, 900001, "HIGH", "2026-06"),
  150,
  "seasonal HIGH basis should be used when no monthly sample exists for that month",
);
assert.equal(
  getBuyInRate("Windsor Hills", 2, 900001, "LOW"),
  100,
  "seasonless callers still use canonical LOW basis",
);
console.log("  ✓ monthly samples override season basis when yearMonth is supplied");

setLivePropertyMarketRates([{
  propertyId: 900002,
  bedrooms: 3,
  medianNightly: 1900,
  medianNightlyHigh: 2400,
  medianNightlyHoliday: 3200,
  monthlyRates: {
    "2026-09": { medianNightly: 1900, season: "LOW", sampleCount: 18 },
  },
  sampleCount: 18,
  refreshedAt: "2026-06-02T00:00:00.000Z",
  source: "airbnb",
}]);
assert.equal(
  getBuyInRate("Pili Mai", 3, 900002, "LOW", "2026-09"),
  1900,
  "monthly SearchAPI Airbnb medians should not fall back to the calibrated static basis",
);
console.log("  ✓ monthly SearchAPI Airbnb medians bypass static fallback caps");

// suggestPricingArea: a Kissimmee draft with no remaining named market match
// should default to the Windsor Hills tier.
assert.equal(
  suggestPricingArea("Kissimmee", "Florida", "Unknown Resort"),
  "Windsor Hills",
  "unknown Kissimmee community should use city default",
);
assert.equal(
  suggestPricingArea("Kissimmee", "Florida"),
  "Windsor Hills",
  "Kissimmee with no community name still defaults to Windsor Hills",
);
assert.equal(
  suggestPricingArea("Bonita Springs", "Florida", "Bonita National 2 Bedroom Condo"),
  "Bonita National",
  "Bonita Springs draft should resolve to the Bonita National buy-in market",
);
assert.equal(
  suggestPricingArea("Fort Myers Beach", "Florida", "Santa Maria Resort - 2BR Condo - Sleeps 6"),
  "Santa Maria Resort",
  "Santa Maria drafts should resolve to the Santa Maria resort market, not Bonita National or Florida Generic",
);
assert.equal(
  suggestPricingArea("Fort Myers Beach", "Florida", "Unmapped Gulf Condo"),
  "Florida Generic",
  "unknown Florida drafts should get the Florida fallback instead of a Hawaii market",
);
assert.equal(
  resolveBuyInMarket({
    name: "Bonita National 2 Bedroom Condo",
    city: "Bonita Springs",
    state: "Florida",
  }),
  "Bonita National",
  "shared resolver should classify Bonita National before find-buy-in starts",
);
assert.equal(
  resolveBuyInMarket({
    name: "Santa Maria Resort - 2BR Condo - Sleeps 6",
    city: "Fort Myers Beach",
    state: "Florida",
  }),
  "Santa Maria Resort",
  "shared resolver should classify Santa Maria Resort before find-buy-in starts",
);
assert.equal(
  resolveBuyInMarket({
    name: "New Florida Condo",
    city: "Fort Myers Beach",
    state: "FL",
  }),
  "Florida Generic",
  "shared resolver should preserve Florida geography for unknown future listings",
);
assert.equal(
  searchLocationForBuyInMarket("Florida Generic"),
  "Florida, United States",
  "Florida fallback must have a real non-Hawaii search destination",
);
console.log("  ✓ suggestPricingArea matches by community name first");

// ---------- SearchAPI airbnb engine listing parser ----------
console.log("\nairbnb engine listing parser suite");

import { extractBedroomsFromListing } from "../server/community-research";

// SearchAPI's airbnb engine never returns `bedrooms` as a top-level
// number — the count lives in the title. These cases mirror the real
// shapes returned during a prod probe (PR that introduced
// this test). If the engine starts returning a structured `bedrooms`
// field one day we can simplify, but until then this regex path is
// what stands between the engine and a useful pricing sample.
assert.equal(
  extractBedroomsFromListing({ title: "Boho Chic 2BR Condo Near Disney w/ Scenic Patio" }),
  2,
  "title with '2BR' → 2",
);
assert.equal(
  extractBedroomsFromListing({ name: "Spacious 3 Bedroom Vacation Home", description: "Apartment in Kissimmee" }),
  3,
  "title with '3 Bedroom' → 3",
);
assert.equal(
  extractBedroomsFromListing({ title: "Studio condo by the pool" }),
  0,
  "title with 'Studio' → 0",
);
assert.equal(
  extractBedroomsFromListing({ title: "Cozy efficiency unit" }),
  0,
  "title with 'efficiency' → 0",
);
assert.equal(
  extractBedroomsFromListing({ title: "Beautiful Two Bedroom by Disney" }),
  2,
  "title with 'Two Bedroom' → 2",
);
assert.equal(
  extractBedroomsFromListing({
    title: "Condo near parks",
    accommodations: ["3 bedrooms", "2 baths", "sleeps 8"],
  }),
  3,
  "accommodations array fallback when title is generic",
);
assert.ok(
  Number.isNaN(extractBedroomsFromListing({ title: "Vacation home rental" })),
  "title with no bedroom signal → NaN",
);
console.log("  ✓ extractBedroomsFromListing handles real engine shapes");

// ---------- VRBO compliance detection (getChannelStatus) ----------
// Replicates the vrboLicense block from
// client/src/services/guestyService.ts. The original implementation only
// read listing.channels.homeaway, which doesn't exist on real Guesty
// payloads — every listing reported "not yet in Guesty" even when the
// data was clearly present. New detection layers tags + Booking.com
// Hawaii variant + channels.homeaway, returning whichever has data.

type VrboLicense = { licenseNumber: string | null; taxId: string | null; parcelNumber: string | null } | null;

function detectVrboLicense(listing: Record<string, unknown>): VrboLicense {
  const integrations = Array.isArray(listing.integrations)
    ? listing.integrations as Record<string, unknown>[]
    : [];

  const tagsArr: string[] = Array.isArray(listing.tags) ? listing.tags as string[] : [];
  const tagValue = (prefix: string): string | null => {
    const m = tagsArr.find((t) => typeof t === "string" && t.startsWith(prefix));
    return m ? m.slice(prefix.length).trim() || null : null;
  };
  const fromTagsTat = tagValue("TAT:");
  const fromTagsGet = tagValue("GET:");
  const fromTagsTmk = tagValue("TMK:");

  const fromTopLevelTat = typeof listing.licenseNumber === "string" && (listing.licenseNumber as string).trim() ? (listing.licenseNumber as string).trim() : null;
  const fromTopLevelGet = typeof listing.taxId === "string" && (listing.taxId as string).trim() ? (listing.taxId as string).trim() : null;

  const bookingInteg = integrations.find((i) => i.platform === "bookingCom" || i.platform === "bookingCom2");
  const bookingLicenseInfo = ((bookingInteg?.bookingCom as Record<string, unknown> | undefined)?.license as Record<string, unknown> | undefined)?.information as Record<string, unknown> | undefined;
  const contentData = bookingLicenseInfo?.contentData as Array<{ name?: string; value?: string }> | undefined;
  const contentValue = (name: string): string | null => {
    if (!Array.isArray(contentData)) return null;
    const m = contentData.find((c) => c?.name === name);
    return (m?.value && typeof m.value === "string") ? m.value : null;
  };
  const fromBookingTat = contentValue("number");
  const fromBookingTmk = contentValue("tmk_number");

  const homeaway = ((listing.channels as Record<string, unknown> | undefined)?.homeaway || {}) as Record<string, string | undefined>;

  const licenseNumber = fromTagsTat || fromTopLevelTat || fromBookingTat || homeaway.licenseNumber || null;
  const taxId         = fromTagsGet || fromTopLevelGet || homeaway.taxId || null;
  const parcelNumber  = fromTagsTmk || fromBookingTmk || homeaway.parcelNumber || null;
  if (!licenseNumber && !taxId && !parcelNumber) return null;
  return { licenseNumber, taxId, parcelNumber };
}

console.log("\nVRBO compliance detection suite");

// Case 1: Real production Pili Mai shape (no channels object, all data
// in tags + bookingCom Hawaii variant). This was the failing case.
{
  const detected = detectVrboLicense({
    tags: ["TMK:420140050001", "TAT:TA-024-120-9012-01", "GET:GE-024-120-9012-01"],
    integrations: [
      { platform: "homeaway2", homeaway2: { advertiserId: "58d6Q4", status: "COMPLETED" } },
      {
        platform: "bookingCom",
        bookingCom: {
          license: {
            information: {
              variantId: 6,
              contentData: [
                { name: "number", value: "TA-024-120-9012-01" },
                { name: "tmk_number", value: "420140050001" },
                { name: "permit_number", value: "TVR-2022-037" },
              ],
            },
          },
        },
      },
    ],
    // No `channels` key — like every real listing.
  });
  assert.ok(detected, "tags + bookingCom should return a non-null vrboLicense");
  assert.equal(detected?.licenseNumber, "TA-024-120-9012-01", "TAT from tags");
  assert.equal(detected?.taxId, "GE-024-120-9012-01", "GET from tags");
  assert.equal(detected?.parcelNumber, "420140050001", "TMK from tags");
  console.log("  ✓ Production Pili Mai shape (tags + bookingCom) detects all three");
}

// Case 2: tags-only fallback (Booking.com not connected).
{
  const detected = detectVrboLicense({
    tags: ["TMK:420140050001", "TAT:TA-024-120-9012-01", "GET:GE-024-120-9012-01"],
    integrations: [],
  });
  assert.equal(detected?.licenseNumber, "TA-024-120-9012-01", "TAT from tags");
  assert.equal(detected?.taxId, "GE-024-120-9012-01", "GET from tags");
  assert.equal(detected?.parcelNumber, "420140050001", "TMK from tags");
  console.log("  ✓ Tags-only listing detects all three");
}

// Case 3: Booking.com Hawaii variant only (no tags) — TAT + TMK only,
// GET will be null because the Hawaii variant doesn't carry it.
{
  const detected = detectVrboLicense({
    tags: [],
    integrations: [
      {
        platform: "bookingCom",
        bookingCom: {
          license: {
            information: {
              variantId: 6,
              contentData: [
                { name: "number", value: "TA-024-120-9012-01" },
                { name: "tmk_number", value: "420140050001" },
              ],
            },
          },
        },
      },
    ],
  });
  assert.ok(detected, "bookingCom-only should still return non-null");
  assert.equal(detected?.licenseNumber, "TA-024-120-9012-01", "TAT from bookingCom");
  assert.equal(detected?.taxId, null, "GET is null when only bookingCom is present");
  assert.equal(detected?.parcelNumber, "420140050001", "TMK from bookingCom");
  console.log("  ✓ Booking.com-only fallback returns TAT+TMK with GET null");
}

// Case 4: Empty listing → null (the "actually not in Guesty" case).
{
  const detected = detectVrboLicense({ tags: [], integrations: [] });
  assert.equal(detected, null, "empty listing should return null");
  console.log("  ✓ Empty listing returns null");
}

// Case 5: Legacy/future-proof channels.homeaway path still works.
{
  const detected = detectVrboLicense({
    tags: [],
    integrations: [],
    channels: { homeaway: { licenseNumber: "X", taxId: "Y", parcelNumber: "Z" } },
  });
  assert.equal(detected?.licenseNumber, "X");
  assert.equal(detected?.taxId, "Y");
  assert.equal(detected?.parcelNumber, "Z");
  console.log("  ✓ channels.homeaway legacy fallback still works");
}

// Case 6: tags take priority over bookingCom when both present.
{
  const detected = detectVrboLicense({
    tags: ["TAT:TAGS-WINS"],
    integrations: [
      {
        platform: "bookingCom",
        bookingCom: {
          license: { information: { contentData: [{ name: "number", value: "BOOKING-LOSES" }] } },
        },
      },
    ],
  });
  assert.equal(detected?.licenseNumber, "TAGS-WINS", "tags should win priority");
  console.log("  ✓ tags take priority over bookingCom contentData");
}

// Case 7: top-level licenseNumber/taxId path (Kaha Lani 2026-04-28
// case). The operator filled the "Vrbo license requirements" panel
// in Guesty admin which writes to the listing's TOP-LEVEL
// licenseNumber + taxId, but no GET tag was written. Without the
// top-level path, taxId comes back null and the UI shows
// "Compliance on file but incomplete" even though Guesty has GET.
{
  const detected = detectVrboLicense({
    tags: [],
    licenseNumber: "TA-024-630-2345-01",
    taxId: "GE-024-630-2345-01",
    integrations: [
      {
        platform: "bookingCom",
        bookingCom: {
          license: {
            information: {
              variantId: 6,
              contentData: [
                { name: "number", value: "TA-024-630-2345-01" },
                { name: "tmk_number", value: "430150130001" },
              ],
            },
          },
        },
      },
    ],
  });
  assert.equal(detected?.licenseNumber, "TA-024-630-2345-01", "TAT from top-level (or bookingCom)");
  assert.equal(detected?.taxId, "GE-024-630-2345-01", "GET from top-level taxId");
  assert.equal(detected?.parcelNumber, "430150130001", "TMK from bookingCom");
  console.log("  ✓ Top-level licenseNumber/taxId surfaces GET when not in tags");
}

// Case 8: top-level + tags both present — tags still win.
{
  const detected = detectVrboLicense({
    tags: ["TAT:TAGS-WIN", "GET:GET-TAGS-WIN"],
    licenseNumber: "TOP-LEVEL-LOSES",
    taxId: "GET-TOP-LOSES",
    integrations: [],
  });
  assert.equal(detected?.licenseNumber, "TAGS-WIN", "tags TAT wins over top-level");
  assert.equal(detected?.taxId, "GET-TAGS-WIN", "tags GET wins over top-level");
  console.log("  ✓ Tags still win priority when top-level fields also exist");
}

// ---------- Hawaii compliance lookup helpers ----------
console.log("\nHawaii compliance lookup suite");
import {
  extractHawaiiComplianceFromPublicText,
  extractHawaiiComplianceFromGuestyListing,
  formatGeodataTaxMapKey,
  formatKauaiCountyPermit,
  matchKauaiStrPermit,
  pairHawaiiTaxLicense,
  parseKauaiTvrPdfText,
  tmkMatchKeys,
} from "../server/hawaii-compliance-lookup";

assert.equal(formatGeodataTaxMapKey("369008014"), "369008014000", "Big Island master parcel pads to 12 digits");
assert.equal(formatGeodataTaxMapKey("370110060", "1"), "370110060001", "numeric unit suffix replaces CPR tail");
assert.equal(formatGeodataTaxMapKey("370110060001"), "370110060001", "already-12-digit TMK passes through");

assert.equal(formatKauaiCountyPermit("218"), "TVNC-0218");
assert.equal(formatKauaiCountyPermit("TVR-2022-037"), "TVR-2022-037");

const sampleTvrText = [
  "1317",
  "12006014",
  "Ishihara Cottage9730 'Oi'oi Rd., Waimea",
  "Active",
  "X",
  "31-Jul",
].join("\n");
const parsedTvr = parseKauaiTvrPdfText(sampleTvrText);
assert.equal(parsedTvr.length, 1);
assert.equal(parsedTvr[0]?.permitNumber, "TVNC-1317");
assert.equal(parsedTvr[0]?.tmkKey, "12006014");

const tmkMatch = matchKauaiStrPermit(parsedTvr, "412006014000", "Waimea");
assert.equal(tmkMatch?.value, "TVNC-1317");
assert.ok(tmkMatchKeys("412006014000").includes("412006014"));

// Fixture values are real-SHAPED (2026-07-10): the sample-family values
// this suite previously used (TA-024-120-9012-01, TVR-2022-037,
// 420140050001…) are now recognized placeholders and correctly null out
// through usableLicenseValue — see tests/license-compliance-samples.test.ts.
const extracted = extractHawaiiComplianceFromGuestyListing({
  tags: ["TMK:428014033000", "TAT:TA-042-123-8571-01", "GET:GE-042-123-8571-01", "STR:TVR-2020-101"],
  licenseNumber: "SHOULD-NOT-WIN",
  taxId: "SHOULD-NOT-WIN",
  publicDescription: {
    notes: "=== Rental License Compliance ===\nShort-Term Rental Registration / Permit: NOTES-STR",
  },
});
assert.equal(extracted.tatLicense, "TA-042-123-8571-01");
assert.equal(extracted.getLicense, "GE-042-123-8571-01");
assert.equal(extracted.strPermit, "TVR-2020-101");

const strOnLicenseNumber = extractHawaiiComplianceFromGuestyListing({
  licenseNumber: "TVR-2020-101",
  taxId: "GE-042-123-8571-01",
  tags: [],
});
assert.equal(strOnLicenseNumber.strPermit, "TVR-2020-101");
assert.equal(strOnLicenseNumber.getLicense, "GE-042-123-8571-01");
assert.equal(strOnLicenseNumber.tatLicense, null);

const fromHomeaway = extractHawaiiComplianceFromGuestyListing({
  tags: [],
  channels: {
    homeaway: {
      licenseNumber: "TA-063-217-4905-01",
      taxId: "GE-063-217-4905-01",
      parcelNumber: "435006012000",
    },
  },
});
assert.equal(fromHomeaway.tatLicense, "TA-063-217-4905-01");
assert.equal(fromHomeaway.getLicense, "GE-063-217-4905-01");
assert.equal(pairHawaiiTaxLicense("TA-042-123-8571-01", "getLicense"), "GE-042-123-8571-01");

const publicMauiValues = extractHawaiiComplianceFromPublicText(
  "Property Registration Number 2390010850095, TA-006-753-6384-01, GE-006-753-6384-01",
);
assert.equal(publicMauiValues.taxMapKey, "2390010850095");
assert.equal(publicMauiValues.tatLicense, "TA-006-753-6384-01");
assert.equal(publicMauiValues.getLicense, "GE-006-753-6384-01");

const publicMauiPermit = extractHawaiiComplianceFromPublicText(
  "TA-192-286-5152-01 STPH 20150004 TMK (2) 2-7-003:135-0000",
);
assert.equal(publicMauiPermit.strPermit, "STPH 20150004");
assert.equal(publicMauiPermit.taxMapKey, "2270031350000");

import { isPlaceholderLicenseValue } from "../shared/license-compliance";
assert.ok(isPlaceholderLicenseValue("GE-025-430-9876-01"), "Makahuena sample GET");
assert.ok(isPlaceholderLicenseValue("TA-025-430-9876-01"), "Makahuena sample TAT");
assert.ok(isPlaceholderLicenseValue("TVR-2024-999"), "Makahuena sample STR");
assert.ok(isPlaceholderLicenseValue("420090060001"), "Makahuena sample TMK");

import { sampleLicensesForLocation } from "../client/src/data/adapt-draft";
const poipuSamples = sampleLicensesForLocation("Koloa", "HI");
assert.equal(poipuSamples.tatLicense, "TA-025-430-9876-01");
assert.equal(poipuSamples.getLicense, "GE-025-430-9876-01");
assert.equal(poipuSamples.strPermit, "TVR-2022-048");
const kauaiHomestay = sampleLicensesForLocation("Lihue", "Hawaii");
assert.equal(kauaiHomestay.strPermit, "TVNC-0342");
console.log("  ✓ Hawaii compliance extraction + Kauai TVR parsing");

// ---------- Guesty session cache layered read ----------
// Locks in the priority order the cache layer uses for the cookie /
// Okta-token resolvers. Pure logic — no Browserbase, no Playwright.
// Covers the case that broke us: env vars set + cache populated → cache
// must win (otherwise the auto-refresh path can't take effect without a
// redeploy).

console.log("\nGuesty session cache priority suite");

{
  // We re-implement the resolver shape inline so this test doesn't
  // need to mock fs. Mirrors the priority logic in
  // server/guesty-session-cache.ts (readMemory → readFile → env).
  type CookieRecord = { name: string; value: string; domain: string };
  type Cached = { cookies: CookieRecord[]; oktaTokenStorage: string | null };
  let memCache: Cached | null = null;
  let fileCache: Cached | null = null;
  let envCookies: string | null = null;
  let envOkta: string | null = null;

  const resolveCookies = (): string | null => {
    if (memCache && memCache.cookies.length > 0) return JSON.stringify(memCache.cookies);
    if (fileCache && fileCache.cookies.length > 0) return JSON.stringify(fileCache.cookies);
    return envCookies;
  };
  const resolveOkta = (): string | null => {
    if (memCache?.oktaTokenStorage) return memCache.oktaTokenStorage;
    if (fileCache?.oktaTokenStorage) return fileCache.oktaTokenStorage;
    return envOkta;
  };

  // Case 1: only env vars → env wins.
  envCookies = JSON.stringify([{ name: "env", value: "v", domain: ".guesty.com" }]);
  envOkta = "env-okta";
  assert.equal(JSON.parse(resolveCookies()!)[0].name, "env", "env-only cookies win when nothing else is set");
  assert.equal(resolveOkta(), "env-okta");
  console.log("  ✓ env-only path");

  // Case 2: file cache populated → file wins over env.
  fileCache = {
    cookies: [{ name: "file", value: "v", domain: ".guesty.com" }],
    oktaTokenStorage: "file-okta",
  };
  assert.equal(JSON.parse(resolveCookies()!)[0].name, "file", "file cache should beat env var");
  assert.equal(resolveOkta(), "file-okta");
  console.log("  ✓ file beats env");

  // Case 3: memory populated → memory wins over file + env (the
  // self-healing refresh path's hot signal).
  memCache = {
    cookies: [{ name: "mem", value: "v", domain: ".guesty.com" }],
    oktaTokenStorage: "mem-okta",
  };
  assert.equal(JSON.parse(resolveCookies()!)[0].name, "mem", "memory cache should beat file + env");
  assert.equal(resolveOkta(), "mem-okta");
  console.log("  ✓ memory beats file + env");

  // Case 4: empty cookies array on the cache should NOT shadow env. A
  // partially-populated cache (e.g. okta-token-storage saved but
  // cookies cleared) shouldn't leave us cookieless — fall through.
  memCache = { cookies: [], oktaTokenStorage: "mem-okta-only" };
  fileCache = null;
  envCookies = JSON.stringify([{ name: "env-fallback", value: "v", domain: ".guesty.com" }]);
  assert.equal(
    JSON.parse(resolveCookies()!)[0].name,
    "env-fallback",
    "empty cookies array in cache should fall through to env",
  );
  assert.equal(resolveOkta(), "mem-okta-only", "okta token still served from cache when only it is populated");
  console.log("  ✓ empty cookies array in cache falls through to env");
}

// ---------- Buy-in Poipu Kai target guard ----------
// Mirrors the narrow Poipu Kai candidate guard in server/routes.ts.
// This prevents generic neighborhood / nearby-POI copy from qualifying a
// detached-home aggregator listing as real Poipu Kai resort inventory.

console.log("\nPoipu Kai buy-in target guard suite");

{
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const isPoipuKaiCondoLike = (haystack: string): boolean => {
    const n = norm(haystack);
    const hasWrongPoipuKaiLocation = /\b(nihi kai|kipu|pili mai|kiahuna|makahuena|waikomo)\b/.test(n);
    if (hasWrongPoipuKaiLocation) return false;
    const hasNamedPoipuKaiComplex = /\b(regency|kahala|manualoha|poipu sands)\b/.test(n);
    if (hasNamedPoipuKaiComplex) return true;
    const hasPoipuKai = /\bpoipu kai\b/.test(n);
    const hasCondoSignal = /\b(condo|condominium|villa|villas|apartment|townhome|townhouse|unit|suite)\b/.test(n);
    return hasPoipuKai && hasCondoSignal;
  };

  assert.equal(
    isPoipuKaiCondoLike("Pool, Spa, Gourmet Kitchen and Private Backyard. Prime Poipu Kai location, walk to Shipwreck Beach."),
    false,
    "generic private-backyard listing near Poipu Kai should not pass",
  );
  console.log("  ✓ generic near-Poipu-Kai home copy is rejected");

  assert.equal(
    isPoipuKaiCondoLike("Poipu Sands at Poipu Kai #523 - 3 bedroom condo"),
    true,
    "named Poipu Kai sub-community should pass",
  );
  assert.equal(
    isPoipuKaiCondoLike("Poipu Kai 3 Bedroom with Pool and Spa - spacious apartment"),
    true,
    "Poipu Kai plus apartment/condo-style signal should pass",
  );
  console.log("  ✓ Poipu Kai condo/sub-community listings still pass");

  assert.equal(
    isPoipuKaiCondoLike("Nihi Kai 201, Kipu, 96756, United States"),
    false,
    "Nihi Kai / Kipu should not pass as Poipu Kai inventory",
  );
  console.log("  ✓ Nihi Kai / Kipu rows are rejected as off-target");
}

// ---------- Buy-in final target bedroom proof ----------
// Mirrors the split in server/routes.ts: unknown-bedroom candidates may
// enter sidecar verification, but final/search-result rows require proof
// that they match the requested bedroom count.

console.log("\nBuy-in bedroom proof suite");

{
  type BuyInCandidate = {
    title: string;
    snippet?: string;
    url: string;
    bedrooms?: number;
  };
  const requestedBedrooms = 3;
  const bedroomFromText = (text: string): number | null => {
    const t = text.toLowerCase();
    if (/\bstudio\b|\befficiency\b/.test(t)) return 0;
    const m = t.match(/(\d+)\s*(?:br|bd|bdr|bedrooms?)\b/);
    if (m) return parseInt(m[1], 10);
    const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
    for (const [w, n] of Object.entries(words)) {
      if (new RegExp(`\\b${w}[\\s-]bedroom\\b`).test(t)) return n;
    }
    return null;
  };
  const bedroomSignal = (c: BuyInCandidate): number | null =>
    typeof c.bedrooms === "number" ? c.bedrooms : bedroomFromText(`${c.title} ${c.snippet ?? ""} ${c.url}`);
  const fits = (c: BuyInCandidate, requireBedroomProof = false): boolean => {
    const inferred = bedroomSignal(c);
    if (inferred !== null && inferred !== requestedBedrooms) return false;
    if (requireBedroomProof && inferred === null) return false;
    return true;
  };

  assert.equal(
    fits({ title: "Poipu Kai condo with pool", url: "https://example.com/unit-812" }),
    true,
    "unknown bedroom rows can still be sent to sidecar for inspection",
  );
  assert.equal(
    fits({ title: "Poipu Kai condo with pool", url: "https://example.com/unit-812" }, true),
    false,
    "unknown bedroom rows must not reach final search results",
  );
  assert.equal(
    fits({ title: "Poipu Kai 2BR condo", url: "https://example.com/unit-812" }, true),
    false,
    "explicit 2BR rows must not reach final search results",
  );
  assert.equal(
    fits({ title: "Poipu Kai 3BR condo", url: "https://example.com/unit-812" }, true),
    true,
    "explicit 3BR rows can reach final search results",
  );
  console.log("  ✓ final target rows require exact 3BR proof");
}

// ---------- Sidecar generic date-price trust guard ----------
// Mirrors worker.mjs: generic visible prices are only trusted when both
// requested dates are visible. A stale total for another search window is
// downgraded to unclear.

console.log("\nSidecar date signal suite");

{
  const dateHintVariants = (iso: string): string[] => {
    const hints = [iso];
    const d = new Date(`${iso}T12:00:00Z`);
    if (Number.isFinite(d.getTime())) {
      const monthShort = d.toLocaleString("en-US", { timeZone: "UTC", month: "short" });
      const monthLong = d.toLocaleString("en-US", { timeZone: "UTC", month: "long" });
      hints.push(`${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`);
      hints.push(`${d.getUTCMonth() + 1}/${d.getUTCDate()}/${String(d.getUTCFullYear()).slice(-2)}`);
      hints.push(`${monthShort} ${d.getUTCDate()}`);
      hints.push(`${monthLong} ${d.getUTCDate()}`);
    }
    return hints;
  };
  const hasBothDates = (text: string, checkIn: string, checkOut: string): boolean => {
    const lower = text.toLowerCase();
    return dateHintVariants(checkIn).some((hint) => lower.includes(hint.toLowerCase())) &&
      dateHintVariants(checkOut).some((hint) => lower.includes(hint.toLowerCase()));
  };

  assert.equal(hasBothDates("June 13 total $3,200", "2026-06-13", "2026-06-20"), false);
  assert.equal(hasBothDates("Jun 13 to Jun 20 total $3,200", "2026-06-13", "2026-06-20"), true);
console.log("  ✓ generic sidecar prices require both requested dates");
}

const workerSource = readFileSync(new URL("../daemon/vrbo-sidecar/worker.mjs", import.meta.url), "utf8");
assert.match(
  workerSource,
  /correctionReasons\.includes\("destination"\)/,
  "VRBO post-submit forgiveness must not ignore destination drift to the wrong resort",
);
assert.match(
  workerSource,
  /allowEscape: false/,
  "VRBO date entry must not dismiss the open calendar with Escape",
);
assert.match(
  workerSource,
  /readVrboHomepageFormSnapshot/,
  "VRBO search must verify visible destination and dates before clicking Search",
);
console.log("  ✓ VRBO homepage search guards stay strict on destination drift");

assert.match(
  workerSource,
  /function vrboMapMinBedrooms/,
  "VRBO map searches should enforce at least 2 bedrooms in URL/filter to reduce 1BR map noise",
);
assert.match(
  workerSource,
  /vrboMapMinBedrooms\(bedrooms\)/,
  "VRBO map URL builder should use the shared 2BR floor helper",
);
assert.ok(
  !workerSource.includes("mouse?.wheel?.(0, 1400)"),
  "VRBO map harvest must not wheel-scroll the map pane (causes repeated zoom-out on Princeville)",
);
assert.match(
  workerSource,
  /looksLikeMapPane/,
  "VRBO map harvest should scroll only the results list, not the map viewport",
);
assert.match(
  workerSource,
  /scrolledResultsList/,
  "VRBO map harvest diagnostics should report list-only scrolling",
);
console.log("  ✓ VRBO map harvest avoids map zoom-out and enforces 2BR floor");

assert.match(
  workerSource,
  /function bookingRequiredTargetTokens/,
  "Booking card filtering should use server filter tokens plus resort/city context",
);
assert.match(
  workerSource,
  /function bookingCardTargetTokens/,
  "Booking card filtering should ignore unit-number tokens like 123 when matching listing cards",
);
assert.match(
  workerSource,
  /booking_search_variant/,
  "Booking variant loop should click each autocomplete option before dated results URL",
);
assert.match(
  workerSource,
  /runBookingMapBoundsSearchVariant/,
  "Booking sidecar should support map-bounds searches for buy-in scans",
);
assert.match(
  workerSource,
  /buildBookingMapSearchUrl/,
  "Booking map-bounds searches should load dated Booking.com map/result URLs",
);
assert.match(
  workerSource,
  /booking_map_search_results/,
  "Booking map-bounds cards should be marked as map-search inventory proof",
);
assert.match(
  workerSource,
  /bookingCardMatchMinHits/,
  "Booking card filtering should allow partial token matches for resort-area inventory",
);
assert.match(
  workerSource,
  /targetSuggestion[\s\S]*anchored/,
  "Booking autocomplete should prefer the intended variant suggestion over a higher-scoring property row",
);
assert.match(
  workerSource,
  /datedSearchTerm = String\(variant\?\.suggestionText/,
  "Booking dated results URL should use the confirmed variant destination text",
);
console.log("  ✓ Booking.com search keeps variant destination and relaxes card token matching");

// ---------- Community research/type guards ----------
console.log("\ncommunity research/type suite");

assert.equal(
  checkCommunityType("condo-style villas", "Attached condominium-style resort units").eligible,
  true,
  "attached condo villa language should be allowed",
);
console.log("  ✓ allows condo-style villas when the condo signal is explicit");

assert.equal(
  checkCommunityType("detached villas", "Standalone vacation villas").eligible,
  false,
  "detached villas should remain disqualified",
);
console.log("  ✓ detached villas remain disqualified");

const parsedMultiArrayResearch = parseCommunityResearchJsonArray(`[]\n[
  {"communityName":"Colony One at Sea Mountain","unitTypes":"condos","confidenceScore":74}
]`);
assert.equal(
  parsedMultiArrayResearch?.[0]?.communityName,
  "Colony One at Sea Mountain",
  "community research parser should recover a non-empty array after an empty-array preface",
);
console.log("  ✓ Claude multi-array community research output is parsed");

const originalFetch = globalThis.fetch;
const originalSearchKey = process.env.SEARCHAPI_API_KEY;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
process.env.SEARCHAPI_API_KEY = "test-search-key";
delete process.env.ANTHROPIC_API_KEY;
globalThis.fetch = (async () => new Response(JSON.stringify({ organic_results: [] }), {
  status: 200,
  headers: { "Content-Type": "application/json" },
})) as typeof fetch;

try {
  const kona = await researchCommunitiesForCity("Kailua-Kona", "Hawaii");
  assert.ok(kona.length >= 3, "Kailua-Kona should fall back to curated condo/townhome candidates");
  assert.ok(
    kona.some((c) => c.name === "Na Hale O Keauhou"),
    "Kailua-Kona fallback should include Na Hale O Keauhou",
  );
  assert.ok(
    kona.every((c) => checkCommunityType(c.unitTypes, c.researchSummary).eligible),
    "curated fallback candidates should pass the shared community type guard",
  );
  console.log("  ✓ Kailua-Kona has curated fallback communities when search/AI under-find it");

  const waiohinu = await researchCommunitiesForCity("Waiohinu", "Hawaii");
  assert.ok(
    waiohinu.some((c) => c.name === "Colony One at Sea Mountain"),
    "South Big Island towns should fall back to the known Punalu'u/Sea Mountain condo candidate",
  );
  console.log("  ✓ South Big Island small towns have a deterministic combo fallback");

  const waikiki = await researchCommunitiesForCity("Waikiki", "Hawaii");
  const noFourBedroomWaikikiCombos = [
    "Waikiki Banyan",
    "Waikiki Beach Tower",
    "Waikiki Shore by Outrigger",
    "Waikiki Sunset",
  ];
  for (const name of noFourBedroomWaikikiCombos) {
    const community = waikiki.find((c) => c.name === name);
    assert.ok(community, `${name} should remain in curated Waikiki research results`);
    assert.notEqual(community?.combinedBedroomsTypical, 4, `${name} should not advertise a 4BR combo`);
    assert.ok(!(community?.availableBedrooms ?? []).includes(4), `${name} should not advertise 4BR units`);
  }
  console.log("  ✓ selected Waikiki communities no longer advertise 4BR combos");

  const poipuSeeds = await researchCommunitiesForCity("Poipu", "Hawaii");
  const regency = poipuSeeds.find((c) => c.name === "Regency at Poipu Kai");
  assert.ok(regency, "Poipu seeds should include Regency at Poipu Kai");
  assert.ok((regency?.availableBedrooms ?? []).includes(4), "Regency seed should list 4BR units");
  assert.match(regency?.bedroomMix ?? "", /4BR/i, "Regency bedroom mix text should mention 4BR units");
  assert.ok(hasSevenEightBedroomComboPotential(regency!), "Regency 3BR+4BR should qualify for 7/8BR market badge");
  const piliMai = poipuSeeds.find((c) => c.name === "Pili Mai");
  assert.ok(piliMai && !hasSevenEightBedroomComboPotential(piliMai!), "Pili Mai (2/3BR only) should not claim 7/8BR");
  assert.ok(piliMai && hasFiveBedroomComboPotential(piliMai!), "Pili Mai (2BR+3BR) should support a 5BR combo");
  assert.ok(regency && hasFiveBedroomComboPotential(regency!), "Regency (2BR+3BR) should support a 5BR combo");
  console.log("  ✓ 7/8BR combo potential requires 4BR inventory");
  console.log("  ✓ 4BR/5BR combos surface from existing 2BR/3BR curated inventory");

  const princeville = await researchCommunitiesForCity("Princeville", "Hawaii");
  const kaiulani = princeville.find((c) => c.name === "Kaiulani of Princeville");
  assert.ok(kaiulani && hasSevenEightBedroomComboPotential(kaiulani), "Kaiulani should enable 7/8BR in Princeville");
  const cliffs = princeville.find((c) => c.name === "The Cliffs at Princeville");
  assert.ok(cliffs && hasSevenEightBedroomComboPotential(cliffs), "The Cliffs should enable 7/8BR in Princeville");
  console.log("  ✓ Princeville curated seeds include 4BR townhome/condo inventory");
} finally {
  globalThis.fetch = originalFetch;
  if (originalSearchKey == null) delete process.env.SEARCHAPI_API_KEY;
  else process.env.SEARCHAPI_API_KEY = originalSearchKey;
  if (originalAnthropicKey == null) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
}

// --- Top-market sweep: 4BR (2+2) and 5BR (2+3) combo detection -------------
// The sweep used to gate purely on the 6BR (two-3BR) pair, which hid condo
// communities whose 2BR/3BR mix only makes a 4BR or 5BR combo. These pure
// synthetic checks lock the new pair semantics + the widened candidate filter
// (no network — only availableBedrooms / estimatedBedroomUnitCounts matter).
{
  const mk = (availableBedrooms: number[], counts?: Record<string, number>) => ({
    name: "Test Resort",
    unitTypes: "condo",
    researchSummary: "Individually owned condo vacation rentals listed on Airbnb and VRBO.",
    availableBedrooms,
    estimatedBedroomUnitCounts: counts,
  } as any);

  // 2BR + 3BR: 5BR (2+3) yes, 4BR (2+2, unknown count) yes, 6BR (3+3, unknown
  // count) yes, but 7/8BR no (needs a 4BR unit).
  const twoThree = mk([2, 3]);
  assert.ok(hasFiveBedroomComboPotential(twoThree), "2BR+3BR supports a 5BR combo");
  assert.ok(hasFourBedroomComboPotential(twoThree), "2BR present (unknown count) allows a 4BR combo");
  assert.ok(!hasSevenEightBedroomComboPotential(twoThree), "2BR/3BR cannot make a 7/8BR combo");

  // 2BR only: 4BR (2+2) yes; 5BR/6BR/7-8BR no.
  const twoOnly = mk([2]);
  assert.ok(hasFourBedroomComboPotential(twoOnly), "two 2BR units make a 4BR combo");
  assert.ok(!hasFiveBedroomComboPotential(twoOnly), "2BR-only cannot make a 5BR combo");
  assert.ok(!hasSixBedroomComboPotential(twoOnly), "2BR-only cannot make a 6BR combo");

  // Same-size 2+2 needs at least two 2BR units when unit counts are known.
  assert.ok(!hasFourBedroomComboPotential(mk([2], { "2BR": 1 })), "a single 2BR unit cannot make a 4BR combo");
  assert.ok(hasFourBedroomComboPotential(mk([2], { "2BR": 2 })), "two 2BR units make a 4BR combo");

  // The behavior change this feature is about: a 2BR-only condo community is now
  // a sweep candidate (via the 4BR combo) even though it has NO 6BR potential —
  // it would previously have been filtered out entirely.
  assert.ok(hasAnyTopScanComboPotential(twoOnly), "2BR-only community has 4BR combo potential");
  assert.ok(!hasSixBedroomComboPotential(twoOnly), "...and explicitly no 6BR potential");
  assert.ok(isTopScanComboCandidate(mk([2], { "2BR": 4 })), "2BR-only condo community is a top-scan combo candidate");
  assert.equal(
    filterTopScanComboCandidates([mk([2], { "2BR": 4 })]).length,
    1,
    "a 2BR-only condo community now passes the sweep candidate filter",
  );
  // Detached / single-family inventory is still rejected even with a valid pair.
  assert.equal(
    filterTopScanComboCandidates([{ ...mk([2, 3]), unitTypes: "detached single family homes" }]).length,
    0,
    "detached homes are excluded from the sweep regardless of bedroom mix",
  );
  console.log("  ✓ sweep surfaces 4BR (2+2) and 5BR (2+3) combos, not just 6BR/7-8BR");
}

const routeSource = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
const findBuyInRouteSource = routeSource.slice(
  routeSource.indexOf('app.get("/api/operations/find-buy-in"'),
  routeSource.indexOf('// POST /api/operations/direct-booking-sites'),
);
const autoReplySource = readFileSync(new URL("../server/auto-reply.ts", import.meta.url), "utf8");
const homeSource = readFileSync(new URL("../client/src/pages/home.tsx", import.meta.url), "utf8");
const builderSource = readFileSync(new URL("../client/src/components/GuestyListingBuilder/index.tsx", import.meta.url), "utf8");
const unitReplacementSource = readFileSync(new URL("../client/src/components/unit-replacement-flow.tsx", import.meta.url), "utf8");
assert.ok(
  routeSource.includes("FOUR_BEDROOM_COMBO_BLOCKED_COMMUNITIES") && routeSource.includes("total === 4"),
  "search-units should keep the explicit Waikiki 4BR combo block",
);
console.log("  ✓ selected Waikiki communities block 4BR pairing suggestions");
assert.equal(
  routeSource.includes("${DISCLOSURE}"),
  false,
  "generate-listing fallback must not reference removed DISCLOSURE constant",
);
console.log("  ✓ generate-listing fallback has no stale DISCLOSURE reference");

assert.match(
  routeSource,
  /unit1Bedrooms and unit2Bedrooms are required for combo drafts/,
  "community/save must reject combo drafts without explicit per-unit bedroom counts",
);
assert.match(
  routeSource,
  // 2026-07-17: wrapped in withConfirmedBedding (Bedding-tab grounding) —
  // the normalize call inside still coerces bedrooms to the selected unit.
  /unitA: withConfirmedBedding\(normalizeGeneratedUnitDraft\(parsed\.unitA, unit1\)/,
  "generate-listing must coerce AI Unit A bedrooms back to selected unit bedrooms",
);
assert.match(
  addCommunitySource,
  /unit1Bedrooms: unit1BedroomCount/,
  "add-community save must send the selected pairing's Unit A bedroom count",
);
assert.match(
  homeSource,
  /unitBedroomSum > 0 \? unitBedroomSum/,
  "dashboard draft rows must prefer per-unit bedroom sums over inferred title text",
);
console.log("  ✓ combo draft bedroom counts stay structured from selection through dashboard");

assert.match(
  routeSource,
  /dismissHandledAutoReplyDrafts\(limit\)/,
  "AI Draft Approval logs endpoint must remove stale drafts before returning queue items",
);
assert.match(
  autoReplySource,
  /hasManualHostReplyAfterTrigger/,
  "auto-reply scheduler must detect manual host replies after the guest trigger post",
);
assert.match(
  autoReplySource,
  /status: "dismissed"/,
  "manual host replies should dismiss stale AI approval drafts automatically",
);
assert.match(
  autoReplySource,
  /await dismissHandledDraftsForConversation\(conv\._id, posts\)/,
  "auto-reply polling must clean stale drafts when a thread no longer needs a host reply",
);

assert.equal(MAX_BUY_IN_WALK_MINUTES, 10, "buy-in unit walking-distance guardrail should stay at 10 minutes");
console.log("  ✓ buy-in walking-distance guardrail is pinned at 10 minutes");

const countLiteral = (source: string, literal: string): number => source.split(literal).length - 1;
assert.equal(
  countLiteral(routeSource, 'app.post("/api/pricing/bulk-refresh"'),
  1,
  "bulk market pricing should only register the server-owned queue route",
);
assert.equal(
  countLiteral(routeSource, 'app.post("/api/property/:id/refresh-market-rates"'),
  1,
  "property market pricing should only register one route",
);
assert.equal(
  countLiteral(routeSource, 'app.post("/api/property/:id/refresh-progress/cancel"'),
  1,
  "pricing refresh should expose one server-owned cancel route",
);
assert.equal(
  countLiteral(routeSource, 'app.post("/api/community/:id/refresh-pricing"'),
  1,
  "draft market pricing should only register one route",
);
assert.ok(
  routeSource.includes("largerPayload as any)?.hybrid?.baseAirbnbMedian == null"),
  "fresh SearchAPI monthly market rows must not be adjacent-bedroom capped before client hydration",
);
console.log("  ✓ market-pricing routes are not shadowed by legacy handlers");

assert.ok(
  routeSource.includes("pushLeadTimePolicyPricesToGuesty"),
  "bulk/Pricing-tab market-rate pushes must layer fixed lead-time scarcity prices after monthly base rates",
);
assert.ok(
  routeSource.includes("leadTimePushed"),
  "bulk-pricing queue events must expose lead-time scarcity push counts",
);
console.log("  ✓ market-pricing pushes include lead-time scarcity overlays");

assert.ok(
  routeSource.includes("const ROUTE_BUDGET_MS = expandedSearch ? 285_000 : 260_000"),
  "replacement search should use most of Railway's request window before giving up",
);
assert.ok(
  routeSource.includes("const DISCOVERY_BUDGET_MS = expandedSearch ? 75_000 : 65_000"),
  "replacement discovery must cap SearchAPI/Apify time so candidate checks keep budget",
);
assert.ok(
  routeSource.includes("const DISCOVERY_CANDIDATE_TARGET = (expandedSearch && requiredBedroomCount)"),
  "replacement discovery must stop once enough qualifying bedroom candidates are queued for checking",
);
assert.ok(
  routeSource.includes("const DISCOVERY_BEDROOM_EXPLICIT_TARGET = expandedSearch ? 8 : 5"),
  "replacement discovery must track explicit bedroom matches for Apify supplement decisions",
);
assert.ok(
  routeSource.includes("const discoveryTargetMet = (): boolean =>"),
  "replacement discovery early-stop must count qualifying bedroom candidates, not wrong-size inventory",
);
assert.ok(
  routeSource.includes("bedroomHint < requiredBedroomCount"),
  "replacement discovery must skip harvesting Google hits that advertise too few bedrooms",
);
assert.ok(
  routeSource.includes("harvestApifyPhotoDiscoveryBatch"),
  "replacement discovery must use stacked Apify batch for Zillow+Realtor native search",
);
assert.ok(
  routeSource.includes("Street-root expansion: roots="),
  "replacement discovery must run second-wave Google queries scoped to resort street roots",
);
assert.ok(
  routeSource.includes("harvestZillowBuildingPageUrls"),
  "replacement discovery must harvest homedetails URLs from Zillow building pages",
);
assert.ok(
  routeSource.includes("zillowStreetSearchUrl"),
  "replacement Apify supplement must support address-specific Zillow search URLs",
);
assert.ok(
  routeSource.includes("extractListingUrlsFromApifyItems"),
  "replacement Apify supplement must filter dataset items by minimum bedroom count",
);
assert.ok(
  routeSource.includes("zillowBuildingUrl"),
  "community address rules may pin a Zillow building page for deep unit discovery",
);
assert.ok(
  routeSource.includes("discoveryUnitLabelSearchQueries"),
  "replacement discovery must run unit-label Google queries for alphanumeric condo resorts",
);
assert.ok(
  routeSource.includes("stacked Apify discovery started in parallel with SearchAPI/Google discovery"),
  "replacement discovery must start Apify in parallel with SearchAPI so bedroom pools are not starved",
);
assert.ok(
  routeSource.includes("site:redfin.com/inurl:"),
  "replacement discovery must use Redfin inurl queries for Hawaii hyphenated street slugs",
);
assert.ok(
  routeSource.includes("runFindUnitStackedApifyDiscovery"),
  "replacement discovery must centralize stacked Apify discovery invoked parallel with SearchAPI",
);
assert.match(
  routeSource,
  /find-unit[\s\S]*runMarketReconDiscovery[\s\S]*market-recon sweep/,
  "replacement find-unit must run a parallel market-recon aggregator sweep before strict discovery",
);
{
  const replacementRouteStart = routeSource.indexOf('app.post("/api/replacement/find-unit"');
  const replacementRouteEnd = routeSource.indexOf("// ============================================================\n  // Unit Swaps", replacementRouteStart);
  const replacementRouteSource = routeSource.slice(replacementRouteStart, replacementRouteEnd);
  assert.equal(
    /runFindUnitStackedRealtyApiDiscovery|runRealtyApiPhotoDiscoveryLeg/.test(replacementRouteSource),
    true,
    "replacement find-unit must run RealtyAPI discovery (replaces RentCast for community Realtor harvest)",
  );
}
assert.match(
  routeSource,
  /find-unit[\s\S]*scrapeListingPhotosDualSource\(clusterUrls/,
  "replacement find-unit must parallel-scrape all portal URLs per address cluster",
);
// The portal cluster must key on street root + UNIT NUMBER, not a bare street root —
// otherwise a single-address condo building (every unit at one street) collapses all
// units into one cluster and the dual-source scrape stamps one unit's bedroom count +
// photos onto its neighbors (real 3BRs wrongly rejected as the cluster's 1BR).
assert.ok(
  routeSource.includes("listingIdentityClusterKey(listingIdentityFor(url, contextText))")
    && routeSource.includes("const listingUrlsByCluster = groupListingUrlsByIdentity("),
  "replacement find-unit must use the shared street-root + unit identity cluster helper",
);
assert.ok(
  !/const clusterKey = streetRootFromListingAddress\(/.test(routeSource)
    && routeSource.includes("const clusterKey = listingClusterKeyFor("),
  "replacement find-unit cluster lookups must use the unit-aware listingClusterKeyFor helper",
);
// 2026-06-22 follow-up to #808 (Cocoa Beach Towers): /api/single-listing/find-clean-unit
// had the SAME single-address collapse. Its photo cluster keyed on a bare street root
// (streetRootFromAddress(addressGuess)), so every unit in a one-address condo building
// (e.g. 220 Young Ave) merged into one cluster and the dual-source scrape stamped one
// unit's bedroom count + photos onto its neighbors. (That build loop was also a dead
// path — it referenced the addressFromSlug/streetRootFromAddress aliases before their
// declaration, a TDZ that threw at runtime.) It must cluster by unit identity too.
{
  const fcuStart = routeSource.indexOf('app.post("/api/single-listing/find-clean-unit"');
  const fcuEnd = routeSource.indexOf('app.post("/api/community/save"', fcuStart);
  assert.ok(fcuStart >= 0 && fcuEnd > fcuStart, "find-clean-unit route must be locatable for source-lock");
  const fcuSource = routeSource.slice(fcuStart, fcuEnd);
  assert.ok(
    fcuSource.includes("listingIdentityClusterKey(listingIdentityFor(url, contextText))")
      && fcuSource.includes("groupListingUrlsByIdentity(candidateUrls"),
    "find-clean-unit must use the shared street-root + unit identity cluster helper",
  );
  assert.ok(
    !/streetRootFromAddress\(addressGuess\)\s*\?\?\s*`__url:/.test(fcuSource)
      && fcuSource.includes("groupListingUrlsByIdentity(candidateUrls")
      && fcuSource.includes("const clusterKey = listingClusterKeyFor("),
    "find-clean-unit cluster build + lookup must both use the unit-aware listingClusterKeyFor helper",
  );
}
assert.ok(
  routeSource.includes("const candidatePhaseStartedAt = Date.now()"),
  "replacement search must reserve a dedicated candidate-check budget after discovery",
);
assert.ok(
  routeSource.includes("hasRouteBudget(PLATFORM_CHECK_RESERVE_MS)"),
  "replacement search must keep checking more candidates until platform-check reserve is exhausted",
);
assert.ok(
  routeSource.includes("hasRouteBudget(PHOTO_PIPELINE_RESERVE_MS)"),
  "replacement search must not start a photo scrape it cannot finish inside the route budget",
);
assert.ok(
  routeSource.includes("skipDiscovery"),
  "replacement find-unit must support continuation passes without re-running discovery",
);
assert.ok(
  routeSource.includes("uncheckedCandidates"),
  "replacement diagnostics must return unchecked candidates for job continuation",
);
assert.ok(
  preflightJobsSource.includes("MAX_REPLACEMENT_FIND_CONTINUATIONS"),
  "replacement background job must continue checking when route budget stops early",
);
assert.ok(
  preflightJobsSource.includes("REPLACEMENT_FIND_UNIT_LOOPBACK_TIMEOUT_MS = 350_000"),
  "replacement background job must outlive find-unit route budget plus a photo-scrape step",
);
assert.ok(
  routeSource.includes("!budgetStopped"),
  "replacement diagnostics must not claim the candidate cap was checked when the route stopped early",
);
assert.ok(
  routeSource.includes('found on ${cleanChannel ? "the enforced channel" : "Airbnb/VRBO/Booking.com"}'),
  "default replacement diagnostics should explain that all OTA channels are enforced",
);
assert.ok(
  unitReplacementSource.includes("const hasActiveReplacement = allUnits.some(u => Boolean(u.replacementSourceUrl));"),
  "after one replacement is active, follow-up replacement searches should automatically use expanded mode",
);
assert.ok(
  unitReplacementSource.includes("onClick={() => search({ expanded: hasActiveReplacement })}"),
  "the initial Find Replacement Unit action should expand automatically when replacing another unit",
);
assert.match(
  unitReplacementSource,
  /\/api\/preflight\/replacement-find-jobs/,
  "preflight replacement search must run on a server-side job so tab close does not abort find-unit",
);
assert.ok(
  routeSource.includes("const canonicalStreet = inferCommunityStreetAddress({"),
  "replacement find-unit must resolve canonical resort street when folder map is missing (e.g. Waikoloa)",
);
assert.ok(
  routeSource.includes("isSameHawaiiStreetFamily"),
  "replacement find-unit must allow sibling Hawaii street-number roots for same-street resort communities like Coconut Plantation",
);
assert.ok(
  routeSource.includes("if (canonicalStreetRoot) harvestRootCounts.set(canonicalStreetRoot, 2);"),
  "replacement find-unit must pre-seed street roots so Apify supplement can run before SearchAPI hits",
);
assert.ok(
  routeSource.includes("const apifyDiscoveryCities = [...new Set(discoverySearchCitiesForPhotoSearch({"),
  "replacement find-unit Apify supplement must search all discovery cities, not only the first",
);
assert.ok(
  preflightSource.includes("const replacementStreetAddress = inferCommunityStreetAddress({"),
  "preflight replacement flow must pass canonical resort street like Find Photos does",
);
assert.ok(
  preflightSource.includes("setReplacementSkipUrl(skipReplacementUrl);"),
  "Change replacement must skip the unit being replaced so search can find a different one",
);
assert.ok(
  routeSource.includes('"skipped-internal-duplicate": 0'),
  "replacement diagnostics must count same-community duplicate rejections",
);
assert.ok(
  routeSource.includes("skipped-outside-resort"),
  "replacement find-unit must reject listings outside the resort street (URL-only match, not snippet context)",
);
assert.ok(
  routeSource.includes("Match on the listing URL only. Snippet/title context often mentions"),
  "replacement find-unit resort gate must not trust Google snippet address mentions",
);
assert.ok(
  routeSource.includes("const canonicalStreet = inferCommunityStreetAddress({"),
  "replacement find-unit must resolve canonical resort street when folder map is missing (e.g. Waikoloa)",
);
assert.ok(
  routeSource.includes("if (canonicalStreetRoot) harvestRootCounts.set(canonicalStreetRoot, 2);"),
  "replacement find-unit must pre-seed street roots so Apify supplement can run before SearchAPI hits",
);
assert.ok(
  routeSource.includes("const apifyDiscoveryCities = [...new Set(discoverySearchCitiesForPhotoSearch({"),
  "replacement find-unit Apify supplement must search all discovery cities, not only the first",
);
assert.ok(
  preflightSource.includes("const replacementStreetAddress = inferCommunityStreetAddress({"),
  "preflight replacement flow must pass canonical resort street like Find Photos does",
);
assert.ok(
  preflightSource.includes("setReplacementSkipUrl(skipReplacementUrl);"),
  "Change replacement must skip the unit being replaced so search can find a different one",
);
assert.ok(
  routeSource.includes('"skipped-internal-duplicate": 0'),
  "replacement diagnostics must count same-community duplicate rejections",
);
assert.ok(
  routeSource.includes("skipped-outside-resort"),
  "replacement find-unit must reject listings outside the resort street (URL-only match, not snippet context)",
);
assert.ok(
  routeSource.includes("Match on the listing URL only. Snippet/title context often mentions"),
  "replacement find-unit resort gate must not trust Google snippet address mentions",
);
assert.ok(
  routeSource.includes("const addressRule = communityAddressRuleForName(communityName);"),
  "replacement find-unit must prefer canonical resort city over mailing-city payloads like Mauna Kea",
);
assert.ok(
  unitReplacementSource.includes("Replacement search session expired"),
  "lost replacement job polls must surface an error instead of silently resetting to idle",
);
assert.ok(
  unitReplacementSource.includes("isTransientReplacementJobPollStatus"),
  "replacement job polls must keep polling through transient Railway 502/503/504 responses",
);
assert.ok(
  unitReplacementSource.includes("Search finished without a replacement unit"),
  "completed replacement jobs without a unit must show an error state",
);

// ── allowOtaListed override (Waikoloa Beach Villas / STVR-saturated communities) ──
// In a community where nearly every for-sale unit is also an active Airbnb/VRBO
// rental, the default "clean unit" requirement rejects everything (skipped-found).
// The operator opt-in `allowOtaListed` relaxes ONLY the unit-name OTA gate, never
// the photo-reuse gate, and flags the accepted unit `otaListedOn`.
assert.ok(
  routeSource.includes("const allowOtaListed = requestedAllowOtaListed === true;"),
  "find-unit must parse the operator allowOtaListed opt-in",
);
assert.ok(
  routeSource.includes("if (foundOn && !allowOtaListed)")
    && routeSource.includes("if (foundOn && allowOtaListed)"),
  "allowOtaListed must bypass the unit-name skipped-found gate while leaving the default-off path intact",
);
assert.ok(
  routeSource.includes("otaListedOn: otaListedHost"),
  "an OTA-listed unit kept by allowOtaListed must be flagged otaListedOn on the returned unit",
);
assert.ok(
  /verdict:\s*"skipped-photo-found"/.test(routeSource)
    && !/allowOtaListed[\s\S]{0,160}skipped-photo-found/.test(routeSource),
  "allowOtaListed must NOT relax the photo-reuse gate (skipped-photo-found stays enforced; PR #338 anti-feedback-loop)",
);
assert.ok(
  routeSource.includes('found on ${cleanChannel ? "the enforced channel" : "Airbnb/VRBO/Booking.com"}'),
  "the load-bearing skipped-found diagnostic substring must remain intact (append-only diagnostic hint)",
);

// ── Find-a-New-Unit candidate-cap fix (Tiers 1-4): deeper scan + multi-building breadth + cost guardrail ──
assert.ok(
  routeSource.includes("const MAX_CANDIDATES_TO_CHECK = expandedSearch ? 120 : 70;"),
  "Tier 2: per-pass candidate cap raised (120/70) so a bigger discovery pool can be drained",
);
assert.match(
  routeSource,
  /DISCOVERY_CANDIDATE_TARGET[\s\S]*?\?\s*80[\s\S]*?\?\s*60[\s\S]*?\?\s*48[\s\S]*?:\s*40;/,
  "Tier 2: discovery early-stop target raised (80/60/48/40) so hundreds-unit communities surface more than ~20",
);
assert.ok(
  routeSource.includes("const capExceeded = totalCandidates > MAX_CANDIDATES_TO_CHECK;")
    && routeSource.includes("const uncheckedCandidates = (budgetStopped || capExceeded)")
    && routeSource.includes("? candidates.slice(attempts.length).map((c) => ({"),
  "Tier 2: cap overflow is resumable — uncheckedCandidates sourced from the FULL sorted pool on budgetStopped OR capExceeded",
);
assert.ok(
  routeSource.includes("capExceeded,") && routeSource.includes("searchApiCalls,"),
  "Tier 2/4: the diagnostic must return capExceeded + searchApiCalls (continuation trigger + observability)",
);
// 2026-07-04: the pass-continuation decision moved from an inline check in
// preflight-background-jobs.ts into the pure, unit-tested
// shared/replacement-search-continuation.ts (decideReplacementContinuation —
// which still continues on capExceeded OR budgetStopped, plus the new
// exhaustive collectAllOptions mode). The job runner must consume it and keep
// the 12-pass cap.
assert.ok(
  preflightJobsSource.includes("decideReplacementContinuation")
    && preflightJobsSource.includes("MAX_REPLACEMENT_FIND_CONTINUATIONS = 12"),
  "Tier 2: the background job delegates pass continuation to decideReplacementContinuation with the 12-pass cap",
);
{
  const continuationSource = readFileSync("shared/replacement-search-continuation.ts", "utf8");
  assert.ok(
    continuationSource.includes("f.budgetStopped || f.capExceeded"),
    "Tier 2: the continuation decision still fires on capExceeded (not only budgetStopped)",
  );
}
// 2026-07-04 false-FOUND guard: the scanner's community-compat context must
// resolve for replacement-p<prop>-u<unit> folders on builder properties
// (positive embedded id). Without this OR-clause, a replaced unit's folder
// scanned with NO community brake and generic look-alike Lens hits (wrong
// island, hub pages) tripped multi-photo agreement into a false FOUND.
{
  const scannerSource = readFileSync("server/photo-listing-scanner.ts", "utf8");
  assert.ok(
    scannerSource.includes("ref !== null && ref.propertyId > 0 && b.propertyId === ref.propertyId"),
    "folderCommunityContext must resolve builder community for replacement-* folders (false-FOUND guard)",
  );
}
{
  const sharedOpDiagnosticsSource = readFileSync("shared/operation-diagnostics.ts", "utf8");
  assert.ok(
    sharedOpDiagnosticsSource.includes("(budgetStopped || capExceeded) && unchecked > 0"),
    "Tier 2: the manual continue-search remediation also offers on capExceeded",
  );
}
assert.ok(
  routeSource.includes("SEARCHAPI_CALL_BUDGET")
    && routeSource.includes("REPLACEMENT_SEARCHAPI_CALL_BUDGET")
    && routeSource.includes("searchApiCalls += 1;"),
  "Tier 4: a per-pass SearchAPI call budget guards the shared plan and is counted on every Google query",
);
{
  const communityAddressesSource = readFileSync("shared/community-addresses.ts", "utf8");
  assert.ok(
    communityAddressesSource.includes("buildingStreetRoots?: string[]"),
    "Tier 3: CommunityAddressRule exposes buildingStreetRoots for multi-building resorts",
  );
}
assert.ok(
  routeSource.includes("?.buildingStreetRoots ?? []"),
  "Tier 3: communityKnownAddressRoots threads curated buildingStreetRoots into the resort-street gate",
);
assert.ok(
  routeSource.includes("learnedBuildingRoots") && routeSource.includes("buildingAllowedRoots"),
  "Tier 3: the Zillow /b/ harvest auto-learns sibling building roots (>=2x on the page) to admit other buildings",
);
assert.ok(
  unitReplacementSource.includes('data-testid="button-include-ota-listed-retry"')
    && unitReplacementSource.includes("search({ allowOtaListed: true"),
  "Tier 1: the replacement flow offers a one-click 'Include OTA-listed & retry' when skipped-found dominates",
);
assert.ok(
  routeSource.includes("Found ${totalCandidates} for-sale"),
  "Tier 1: the failure diagnostic reframes the count as the discovered for-sale pool, not a scan limit",
);
assert.ok(
  unitReplacementSource.includes("allowOtaListed,")
    && unitReplacementSource.includes("setAllowOtaListed"),
  "the builder replacement flow must expose the allowOtaListed toggle and send it in the payload",
);
assert.ok(
  unitReplacementSource.includes("result.otaListedOn"),
  "the replacement result must surface otaListedOn so the green 'clean' shield never lies about an OTA-listed unit",
);
assert.ok(
  preflightSource.includes("replacementSourceUrl: unitOverrides[u.id]?.sourceUrl"),
  "preflight replacement flow must pass active swap URLs so follow-up searches use expanded mode",
);
assert.ok(
  preflightSource.includes("parseCityFromMailingAddress(property.address)"),
  "preflight platform check must parse Kapolei from Hawaii mailing addresses",
);
assert.ok(
  preflightSource.includes("name: searchCommunityName"),
  "preflight platform check must search by resort/community name, not listing title",
);
assert.ok(
  routeSource.includes("normalizePlatformCheckCity"),
  "platform-check API must normalize a full mailing address sent as city",
);
assert.ok(
  routeSource.includes("const SCRAPE_WITHOUT_SIDECAR: ScrapeOptions = { sidecarWalletMs: 0 }"),
  "preflight photo paths must define a no-sidecar scrape option",
);
assert.ok(
  routeSource.includes("scrapeListingPhotos(sourceUrl, undefined, listingFacts, SCRAPE_WITH_SIDECAR)"),
  "builder rescrape (a fire-and-walk-away background job) must opt INTO the residential-IP sidecar to rescue a bot-walled own-listing scrape that returns zero photos on Railway's datacenter IP",
);
assert.ok(
  routeSource.includes("...SCRAPE_WITHOUT_SIDECAR"),
  "fetch-unit-photos discovery path must stay sidecar-free (only the opt-in direct rescrape may use the sidecar)",
);
// "Re-pull all photos" (preflight background job, Stage 1 — rescrape of the
// unit's OWN saved listing) opts INTO the residential-IP sidecar so a
// Redfin/Homes/Zillow listing that bot-walls to a single og:image on Railway's
// datacenter IP is still fully recovered instead of re-pulling thin. Synchronous
// wizard callers omit the flag and stay sidecar-free. See Load-Bearing #45.
assert.ok(
  routeSource.includes("const SCRAPE_WITH_SIDECAR: ScrapeOptions = { sidecarWalletMs: 90_000 }"),
  "the background re-pull path must define a sidecar-enabled scrape option",
);
assert.ok(
  routeSource.includes("const directScrapeOptions = useSidecar === true ? SCRAPE_WITH_SIDECAR : SCRAPE_WITHOUT_SIDECAR"),
  "fetch-unit-photos direct rescrape must enable the sidecar ONLY when the caller opts in",
);
assert.ok(
  routeSource.includes("scrapeListingPhotos(listingUrl, undefined, facts, directScrapeOptions)"),
  "fetch-unit-photos direct rescrape must use the opt-in (sidecar-aware) scrape options",
);
assert.ok(
  preflightJobsSource.includes("useSidecar: true"),
  "Re-pull all photos (own-listing rescrape) must opt into the residential-IP sidecar",
);
assert.ok(
  routeSource.includes("scrapeListingPhotosDualSource(clusterUrls, candidateFacts, SCRAPE_WITHOUT_SIDECAR)"),
  "replacement find-unit must not open local Chrome during photo scrape",
);
{
  const legacyStart = routeSource.indexOf('app.post("/api/photos/find-replacement"');
  const legacyEnd = routeSource.indexOf("// ============================================================\n  // Fetch Zillow listing photos", legacyStart);
  const legacySource = routeSource.slice(legacyStart, legacyEnd);
  assert.ok(
    legacySource.includes('/api/replacement/find-unit')
      && !legacySource.includes("site:zillow.com")
      && !legacySource.includes("scrapeListingPhotos(url"),
    "the legacy replacement endpoint must delegate to the canonical four-portal finder instead of maintaining a divergent source pool",
  );
}
assert.ok(
  routeSource.includes("if (scrapedPhotoUrls.length < MIN_PHOTOS) {"),
  "replacement find-unit must try equivalent portal sources when the primary scrape is photo-sparse",
);
{
  const equivalentStart = routeSource.indexOf("const findEquivalentPhotoSource = async");
  const equivalentEnd = routeSource.indexOf("// PR #322", equivalentStart);
  const equivalentSource = routeSource.slice(equivalentStart, equivalentEnd);
  assert.ok(
    equivalentSource.includes("buildEquivalentPortalQueries({")
      && equivalentSource.includes("[...knownClusterUrls, link]")
      && !equivalentSource.includes('source === "realtor"'),
    "replacement equivalent lookup must use the shared four-portal query builder and admit Realtor results",
  );
}
assert.ok(
  routeSource.includes("signal: AbortSignal.timeout(280_000)")
    && preflightJobsSource.includes("}, 190_000);"),
  "shared replacement callers must leave enough time for the canonical finder and the bounded three-gallery Add Combo scan",
);
assert.ok(
  routeSource.includes("cdn-redfin"),
  "generic real-estate fetch must harvest Redfin CDN gallery URLs",
);
assert.ok(
  routeSource.includes("hawaiiStreetSlugKey"),
  "replacement discovery must accept Hawaii hyphenated street slugs when URL parsing misses the root",
);
assert.ok(
  routeSource.includes("const DISCOVERY_SEARCH_TIMEOUT_MS = 15_000"),
  "replacement Google discovery must not reuse the 8s platform-check SearchAPI timeout",
);
assert.ok(
  routeSource.includes("DISCOVERY_QUERY_CONCURRENCY"),
  "replacement discovery should run SearchAPI queries in parallel batches",
);
assert.ok(
  routeSource.includes("const filterRoots = allowedRoots.size > 0")
    && routeSource.includes('for (const link of batch.realtor) addCandidateUrl(link, "realtor", "", "", filterRoots);')
    && routeSource.includes('for (const link of batch.zillow) addCandidateUrl(link, "zillow", "", "", filterRoots);'),
  "replacement stacked Apify discovery must filter Zillow/Realtor through the resort root SET (canonical + curated buildingStreetRoots + learned), not a single narrowed root",
);
assert.ok(
  routeSource.includes("(?:[-\\\\s]+\\\\d{1,4})?[-\\\\s]+"),
  "Hawaii street slug matching must allow an optional unit token between the street number and name",
);
assert.ok(
  routeSource.includes("site:zillow.com \"Coconut Plantation\" Ko Olina condo"),
  "Ko Olina replacement discovery must include Coconut Plantation-specific SearchAPI probes",
);
console.log("  ✓ replacement search budget and follow-up expanded mode are guarded");

assert.equal(
  routeSource.includes('ownerType: "bulk-pricing"'),
  false,
  "bulk market pricing should not acquire the Chrome sidecar lane",
);
assert.equal(
  routeSource.includes('Local Chrome sidecar is offline. Start the VRBO sidecar supervisor on the Mac first, then run bulk market pricing again.'),
  false,
  "bulk market pricing should not require sidecar heartbeat",
);
assert.ok(
  routeSource.includes('label: "Running SearchAPI Airbnb seasonal pricing"'),
  "pricing-tab market-rate refresh should enter the SearchAPI Airbnb seasonal pricing path used by the dashboard queue",
);
assert.ok(
  routeSource.includes("shouldCancel,"),
  "bulk market pricing should pass the cancel hook into the monthly SearchAPI pricing engine",
);
assert.ok(
  routeSource.includes('phase: "cancelling"'),
  "bulk market pricing cancel should visibly mark the active item as cancelling",
);
assert.ok(
  routeSource.indexOf('label: "Running SearchAPI Airbnb seasonal pricing"') < routeSource.indexOf('fetchMultiChannelBuyInBySeason({'),
  "pricing-tab refresh route should hit SearchAPI Airbnb seasonal pricing before any legacy sidecar season-band code",
);
assert.ok(
  routeSource.includes("releasePricingRefreshLockForProperty(propertyId);"),
  "stale pricing progress must clear the duplicate-refresh lock",
);
assert.ok(
  builderSource.includes("refresh-progress/cancel"),
  "Pricing tab Cancel should clear the server progress lock, not only abort the browser fetch",
);
assert.ok(
  builderSource.includes("activeMarketPricingQueueJobRef"),
  "Pricing tab market-rate refresh should track the dashboard bulk-pricing queue job so Cancel can stop it",
);
assert.ok(
  builderSource.includes("if (activeMarketPricingQueueJobRef.current) return;"),
  "Pricing tab market-rate refresh should not mark bulk-queue progress as lost because the legacy progress endpoint is empty",
);
assert.ok(
  builderSource.includes("/api/pricing/bulk-refresh/${jobId}"),
  "Pricing tab market-rate refresh should poll the same bulk-pricing queue endpoint as the dashboard",
);
assert.equal(
  builderSource.includes("/api/property/${propertyId}/refresh-market-rates"),
  false,
  "Pricing tab refresh button should not call the legacy direct market-rate refresh endpoint",
);
assert.equal(
  builderSource.includes("refresh-pricing?mode=banded"),
  false,
  "Pricing tab refresh button should not call the legacy draft season-band endpoint",
);
assert.equal(
  builderSource.includes("mode=banded"),
  false,
  "Pricing tab refresh button should not request the old season-band mode",
);
console.log("  ✓ bulk and Pricing tab market pricing stay on SearchAPI Airbnb path, not sidecar");

const multichannelBuyInSource = readFileSync(new URL("../server/multichannel-buy-in.ts", import.meta.url), "utf8");
assert.ok(
  multichannelBuyInSource.includes("const searchApiResults = await Promise.all(searchApiOps)"),
  "multichannel buy-in should await SearchAPI before starting browser sidecar ops",
);
assert.ok(
  multichannelBuyInSource.indexOf("const searchApiResults = await Promise.all(searchApiOps)") <
    multichannelBuyInSource.indexOf("const [sidecarBrowserResults, pmResults] = await Promise.all"),
  "multichannel buy-in should finish SearchAPI before browser sidecar enqueue",
);
assert.ok(
  findBuyInRouteSource.includes("const [airbnb, googleHotelsRows] = alternativeScoutOtaMapOnly") &&
    findBuyInRouteSource.includes("withTimeout(airbnbPromise, sidecarSourceBudgetMs") &&
    findBuyInRouteSource.includes("withTimeout(googleHotelsPromise, googleHotelsBudgetMs"),
  "find-buy-in should run SearchAPI Airbnb + Google Hotels before sidecar VRBO resort dropdown search",
);
assert.ok(
  findBuyInRouteSource.indexOf("const [airbnb, googleHotelsRows] = alternativeScoutOtaMapOnly") <
    findBuyInRouteSource.indexOf("const [booking, vrbo] = await Promise.all"),
  "find-buy-in should finish SearchAPI before VRBO resort dropdown sidecar search",
);
assert.ok(
  findBuyInRouteSource.includes('searchMode: "destination_dropdown"')
    && !findBuyInRouteSource.includes('searchMode: "map_bounds"')
    && findBuyInRouteSource.includes("maxVariations: 1")
    && findBuyInRouteSource.includes("searchVariations: [targetSearchTerm]"),
  "find-buy-in should request a single resort dropdown VRBO search instead of map-bounds or multi-variation repeats",
);
assert.ok(
  findBuyInRouteSource.includes("sources: {")
    && findBuyInRouteSource.includes("vrboAll:")
    && findBuyInRouteSource.includes("vrboMatchesBedroomAndTitle"),
  "find-buy-in should export all VRBO rows then filter by bedroom count and resort tokens in titles",
);
assert.ok(
  findBuyInRouteSource.includes("const bookingPromise: Promise<Candidate[]> = Promise.resolve([])") &&
    findBuyInRouteSource.includes("Booking.com buy-in searches are disabled") &&
    !findBuyInRouteSource.includes("const { searchBookingViaSidecar }") &&
    !findBuyInRouteSource.includes("sourceLabel: \"Booking.com\""),
  "find-buy-in should not launch Booking.com sidecar searches",
);
assert.ok(
  findBuyInRouteSource.includes("const candidateHasDateSpecificOtaSearchProof = (c: Candidate): boolean =>"),
  "find-buy-in should centralize date-specific OTA search proof for unit-type confidence",
);
assert.ok(
  routeSource.includes("sidecar searched vrbo.com with the resort destination dropdown"),
  "Vrbo resort dropdown sidecar search proof should contribute to unit-type confidence",
);
assert.ok(
  routeSource.includes("if (candidateHasDateSpecificOtaSearchProof(c)) score += 30"),
  "Vrbo resort dropdown sidecar rows should not stall under the 85 confidence threshold after passing bedroom/title proof",
);
console.log("  ✓ buy-in SearchAPI phases complete before local-Chrome sidecar phases");

assert.ok(
  routeSource.includes("const allowInFlightJoin = req.query.nocache !== \"1\""),
  "find-buy-in should keep in-flight dedup unless caller opts out with nocache=1",
);
assert.ok(
  routeSource.includes("client disconnected; continuing detached scan"),
  "find-buy-in should continue detached scans after the browser tab closes the socket",
);
console.log("  ✓ find-buy-in in-flight join survives tab disconnect");

assert.equal(
  routeSource.includes("/api/builder/push-channel-markups"),
  false,
  "bulk/manual Guesty pricing should push marked-up base rates only; Guesty owns channel pricing rules",
);
assert.equal(
  routeSource.includes("computeChannelMarkups"),
  false,
  "bulk pricing route should not compute or push per-channel price adjustments",
);
const schedulerSource = readFileSync(new URL("../server/availability-scheduler.ts", import.meta.url), "utf8");
assert.equal(
  schedulerSource.includes("computeChannelMarkups"),
  false,
  "scheduler rate push should not compute or push per-channel price adjustments",
);
assert.ok(
  routeSource.includes("const success = fullyVerified;"),
  "Guesty seasonal-rate push should trust read-back verification when deciding whether the desired rates landed",
);
assert.ok(
  routeSource.includes("confirmed the desired prices anyway"),
  "Guesty seasonal-rate push should explain benign range errors when read-back verifies the final calendar state",
);
assert.ok(
  routeSource.includes("First failed range:"),
  "bulk Guesty pricing errors should include the first failed range instead of only HTTP 200",
);
console.log("  ✓ Guesty pricing pushes marked-up base rates only");

assert.ok(
  routeSource.includes("guestyCalendarRequestWithRetry"),
  "Guesty seasonal calendar pushes should retry throttled calendar writes instead of firing all ranges in a tight loop",
);
assert.ok(
  routeSource.includes("status === 403"),
  "Guesty seasonal calendar pushes should retry transient mid-stream 403 calendar writes before failing the item",
);
assert.ok(
  routeSource.includes("Pushed ${pushedRanges}/${ranges.length} ranges; first failed range"),
  "Guesty seasonal calendar pushes should surface partial range failures instead of reporting them as completed",
);
assert.ok(
  routeSource.includes("Guesty read-back deferred because Guesty rate limited verification"),
  "Guesty seasonal calendar pushes should not mark fully written rates as skipped just because read-back verification was rate-limited",
);
assert.equal(
  routeSource.includes("Market rates saved; Guesty push skipped: ${reason}"),
  false,
  "Bulk market pricing should retry/fail Guesty push errors instead of hiding them as completed skipped pushes",
);
console.log("  ✓ bulk Guesty calendar pushes retry and do not hide partial failures");

assert.ok(
  schedulerSource.includes("storage.getCommunityDraft(Math.abs(propertyId))"),
  "availability scheduler should resolve mapped draft-backed properties instead of rejecting negative property ids",
);
assert.ok(
  schedulerSource.includes("configFromMappedGuestyListing(propertyId)"),
  "availability scheduler should fall back to mapped Guesty listing details when a draft-backed property row is incomplete",
);
assert.ok(
  schedulerSource.includes("title nickname name bedrooms bedroomsCount bedroomCount beds"),
  "availability scheduler Guesty fallback should request bedroom/title fields needed to infer standalone mapped drafts",
);
assert.equal(
  schedulerSource.includes("if (mapping.propertyId <= 0)"),
  false,
  "daily availability policy sync should include mapped draft-backed Guesty listings",
);
const availabilityTabSource = readFileSync(new URL("../client/src/components/GuestyListingBuilder/AvailabilityTab.tsx", import.meta.url), "utf8");
assert.equal(
  availabilityTabSource.includes("isSyntheticDraftProperty"),
  false,
  "Availability tab should ask the server whether a mapped draft-backed property is supported",
);
assert.equal(
  availabilityTabSource.includes("autoEnableCheckedRef"),
  false,
  "Availability tab must not silently auto-enable the pricing scheduler",
);
assert.equal(
  availabilityTabSource.includes("updateSchedule({ enabled: true })"),
  false,
  "Availability scheduler must remain explicit opt-in",
);
assert.ok(
  availabilityTabSource.includes("updateSchedule({ enabled: !schedule?.enabled })"),
  "Availability tab should retain the explicit enable/disable control",
);
assert.ok(
  routeSource.includes("enabled: body.enabled ?? existing?.enabled ?? false"),
  "Availability schedule rows should default to disabled unless explicitly enabled",
);
console.log("  ✓ availability scheduler supports mapped draft-backed listings");

assert.ok(
  builderSource.includes("const listingOptions = useMemo"),
  "Builder should synthesize the mapped Guesty listing option before the full dropdown fetch finishes",
);
assert.ok(
  builderSource.includes('current === "checking" || current === "rate-limited" ? "connected" : current'),
  "Builder should let persisted Guesty mappings override transient first-load rate-limit state",
);
assert.equal(
  builderSource.includes("if (!propertyId || listings.length === 0) return;"),
  false,
  "Builder should not wait for the full Guesty listing dropdown before selecting the mapped listing",
);
console.log("  ✓ builder hydrates mapped Guesty listings before dropdown listing fetch completes");

assert.ok(
  builderSource.includes("?fields=pictures"),
  "Photos tab should read Guesty pictures with an explicit fields=pictures projection",
);
assert.ok(
  builderSource.includes("fallbackCount"),
  "Photos tab should not show a false zero when a verified last push exists",
);
const guestyServiceSource = readFileSync(new URL("../client/src/services/guestyService.ts", import.meta.url), "utf8");
assert.ok(
  guestyServiceSource.includes("isListed integrations airBnb homeAway bookingCom channels tags licenseNumber taxId"),
  "Channel status should request the fields it needs instead of relying on Guesty's default listing shape",
);
const guestySyncSource = readFileSync(new URL("../server/guesty-sync.ts", import.meta.url), "utf8");
assert.ok(
  guestySyncSource.includes("waitForGuestyRequestSlot"),
  "Server Guesty calls should share a process-wide request gate to prevent background jobs from stampeding the rate limit",
);
assert.ok(
  guestySyncSource.includes("guestyRateLimitPauseUntil"),
  "Server Guesty calls should honor a shared pause after a 429 response",
);
console.log("  ✓ Guesty readbacks request explicit listing fields and server calls are rate-gated");

const schemaMaintenanceSource = readFileSync(new URL("../server/schema-maintenance.ts", import.meta.url), "utf8");
for (const col of ["single_listing", "booking_title", "property_type", "unit1_bathrooms", "unit2_bathrooms"]) {
  assert.ok(
    schemaMaintenanceSource.includes(`ADD COLUMN IF NOT EXISTS ${col}`),
    `runtime schema maintenance must ensure community_drafts.${col}`,
  );
}
console.log("  ✓ runtime schema guard covers community_drafts listing draft columns");

for (const col of ["bedroom_cluster_id", "bedroom_bed_type"]) {
  assert.ok(
    schemaMaintenanceSource.includes(`ADD COLUMN IF NOT EXISTS ${col}`),
    `runtime schema maintenance must ensure photo_labels.${col}`,
  );
}
console.log("  ✓ runtime schema guard covers photo_labels bedroom cluster columns");

// ---------- Community address guards ----------
console.log("\ncommunity address guard suite");

assert.equal(
  inferCommunityStreetAddress({
    communityName: "Pili Mai",
    city: "Koloa",
    state: "HI",
    unitAddresses: ["2253 Poipu Rd, Unit A, Koloa, HI 96756"],
  }),
  "2611 Kiahuna Plantation Dr",
  "known communities should use the canonical resort address instead of a stale unit/source address",
);
console.log("  ✓ Pili Mai canonical address beats stale unit/source address");

assert.equal(
  inferCommunityStreetAddress({
    communityName: "Waipouli Beach Resort",
    city: "Waipouli",
    state: "Hawaii",
    unitAddresses: [],
    addressHint: "4-820 Kuhio Hwy",
  }),
  "4-820 Kuhio Hwy",
  "bulk combo queue should preserve researched address hints for communities without hardcoded rules",
);
assert.equal(
  validateCommunityStreetAddress({
    communityName: "Waipouli Beach Resort",
    city: "Waipouli",
    state: "Hawaii",
    streetAddress: "4-820 Kuhio Hwy",
  }).ok,
  true,
  "valid Hawaii highway resort addresses should not fail community draft save validation",
);
console.log("  ✓ Waipouli address hint validates for bulk combo draft saves");

assert.equal(
  validateCommunityStreetAddress({
    communityName: "Kuilima Estates",
    city: "Kahuku",
    state: "Hawaii",
    streetAddress: "57-101 Kuilima Dr",
  }).ok,
  true,
  "valid Hawaii hyphenated Kuilima resort addresses should pass community draft validation",
);
console.log("  ✓ Kuilima hyphenated address validates for bulk combo draft saves");

assert.equal(
  inferCommunityStreetAddress({
    communityName: "Waikoloa Beach Villas",
    city: "Waikoloa",
    state: "Hawaii",
    unitAddresses: ["Waikoloa, Hawaii"],
  }),
  "69-180 Waikoloa Beach Dr",
  "bulk combo queue should use Waikoloa Beach Villas canonical address instead of stale market-only payloads",
);
assert.equal(
  validateCommunityStreetAddress({
    communityName: "Waikoloa Beach Villas",
    city: "Mauna Kea",
    state: "Hawaii",
    streetAddress: "69-180 Waikoloa Beach Dr",
  }).ok,
  true,
  "Waikoloa Beach Villas should accept Mauna Kea as the queued market city while validating its canonical street",
);
console.log("  ✓ Waikoloa Beach Villas canonical address validates for bulk combo draft saves");

assert.equal(
  inferCommunityStreetAddress({
    communityName: "Fairway Villas Waikoloa",
    city: "Waikoloa",
    state: "Hawaii",
    unitAddresses: [],
  }),
  "69-200 Pohakulana Pl",
  "bulk combo queue should use Fairway Villas Waikoloa canonical address instead of an empty market-only payload",
);
assert.equal(
  validateCommunityStreetAddress({
    communityName: "Halii Kai",
    city: "Mauna Kea",
    state: "Hawaii",
    streetAddress: "69-1029 Nawahine Pl",
  }).ok,
  true,
  "Halii Kai should accept Mauna Kea as the queued market city while validating its canonical street",
);
console.log("  ✓ Fairway Villas + Halii Kai canonical addresses validate for bulk combo draft saves");

assert.equal(
  discoveryCityForPhotoSearch({
    city: "Mauna Kea",
    communityName: "Waikoloa Beach Villas",
    streetAddress: "69-180 Waikoloa Beach Dr",
  }),
  "Waikoloa",
  "preflight Find Photos should search Waikoloa, not Mauna Kea mailing city",
);
assert.ok(
  discoveryCommunityNameAliases("Waikoloa Villas").includes("Waikoloa Beach Villas"),
  "Waikoloa Villas draft title should alias to Waikoloa Beach Villas for Zillow discovery",
);
console.log("  ✓ Waikoloa preflight photo-discovery city + name aliases");

assert.equal(
  inferCommunityStreetAddress({
    communityName: "Mauna Lani Point",
    city: "Waikoloa",
    state: "Hawaii",
    unitAddresses: ["Waikoloa, Hawaii"],
  }),
  "68-1050 Mauna Lani Point Dr",
  "bulk combo queue should use Mauna Lani Point canonical address instead of stale market-only payloads",
);
assert.equal(
  validateCommunityStreetAddress({
    communityName: "Mauna Lani Point",
    city: "Mauna Kea",
    state: "Hawaii",
    streetAddress: "68-1050 Mauna Lani Point Dr",
  }).ok,
  true,
  "Mauna Lani Point should accept Mauna Kea as the queued market city while validating its canonical street",
);
const maunaLaniDiscoveryCities = discoverySearchCitiesForPhotoSearch({
  city: "Mauna Kea",
  communityName: "Mauna Lani Point",
  streetAddress: "68-1050 Mauna Lani Point Dr",
});
assert.ok(
  maunaLaniDiscoveryCities.includes("Kamuela") && maunaLaniDiscoveryCities.includes("Waikoloa"),
  "Mauna Lani Point photo discovery should search Kamuela and Waikoloa, not only the draft mailing city",
);
assert.equal(discoveryCityForPhotoSearch({
  city: "Mauna Kea",
  communityName: "Mauna Lani Point",
  streetAddress: "68-1050 Mauna Lani Point Dr",
}), "Kamuela");
assert.ok(
  discoveryCommunityNameAliases("Mauna Lani Point").some((n) => /mauna lani/i.test(n)),
  "Mauna Lani Point should expose Mauna Lani name variants for Zillow discovery",
);
console.log("  ✓ Mauna Lani Point canonical address validates for bulk combo draft saves");
console.log("  ✓ Mauna Lani Point preflight photo-discovery cities + name aliases");

assert.equal(
  inferCommunityStreetAddress({
    communityName: "Honua Kai Resort",
    city: "Kaanapali",
    state: "Hawaii",
    unitAddresses: [],
  }),
  "130 Kai Malina Pkwy",
  "bulk combo queue should use Honua Kai canonical address instead of an empty market-only payload",
);
assert.equal(
  validateCommunityStreetAddress({
    communityName: "Honua Kai Resort",
    city: "Kaanapali",
    state: "Hawaii",
    streetAddress: "130 Kai Malina Pkwy",
  }).ok,
  true,
  "Honua Kai should accept Kaanapali as the queued market city while validating its canonical street",
);
assert.equal(
  inferCommunityStreetAddress({
    communityName: "Kaanapali Alii",
    city: "Kaanapali",
    state: "Hawaii",
    unitAddresses: [],
  }),
  "50 Nohea Kai Dr",
  "bulk combo queue should use Kaanapali Alii canonical address instead of an empty market-only payload",
);
assert.equal(
  validateCommunityStreetAddress({
    communityName: "Kaanapali Alii",
    city: "Kaanapali",
    state: "Hawaii",
    streetAddress: "50 Nohea Kai Dr",
  }).ok,
  true,
  "Kaanapali Alii should accept Kaanapali as the queued market city while validating its canonical street",
);
console.log("  ✓ Honua Kai + Kaanapali Alii canonical addresses validate for bulk combo draft saves");

assert.equal(
  inferCommunityStreetAddress({
    communityName: "Ko Olina Beach Villas",
    city: "Ko Olina",
    state: "Hawaii",
    unitAddresses: [],
  }),
  "92-102 Waialii Pl",
  "bulk combo queue should use Ko Olina Beach Villas canonical address instead of an empty market-only payload",
);
assert.equal(
  validateCommunityStreetAddress({
    communityName: "Ko Olina Beach Villas",
    city: "Ko Olina",
    state: "Hawaii",
    streetAddress: "92-102 Waialii Pl",
  }).ok,
  true,
  "Ko Olina Beach Villas should accept Ko Olina as the queued market city while validating its canonical street",
);
assert.equal(
  inferCommunityStreetAddress({
    communityName: "Coconut Plantation at Ko Olina",
    city: "Ko Olina",
    state: "Hawaii",
    unitAddresses: [],
  }),
  "92-1070 Olani St",
  "bulk combo queue should use Coconut Plantation canonical address instead of an empty market-only payload",
);
assert.ok(
  discoverySearchCitiesForPhotoSearch({
    city: "Ko Olina",
    communityName: "Ko Olina Beach Villas",
    streetAddress: "92-102 Waialii Pl",
  }).includes("Kapolei"),
  "Ko Olina Beach Villas photo discovery should search Kapolei, not only the draft mailing city",
);
assert.equal(
  parseCityFromMailingAddress("92-1070 Olani St, Kapolei, Hawaii"),
  "Kapolei",
  "preflight platform check must parse city when the state is spelled out instead of HI + zip",
);
assert.equal(
  normalizePlatformCheckCity("92-1070 Olani St, Kapolei, Hawaii"),
  "Kapolei",
  "platform-check API must recover Kapolei when the client sends the full mailing address as city",
);
assert.deepEqual(
  Array.from(hawaiiHyphenStreetSlugTokens("92-102 Waialii Pl")).sort(),
  ["102", "92"],
  "Hawaii street-number tokens must not be mistaken for condo unit IDs in Zillow slugs",
);
assert.ok(
  routeSource.includes("hawaiiStreetSlugTokens.has(part)"),
  "find-unit must skip Hawaii hyphenated street-number tokens when parsing listing slugs",
);
console.log("  ✓ Ko Olina Beach Villas + Coconut Plantation canonical addresses validate for bulk combo draft saves");

assert.equal(
  inferCommunityStreetAddress({
    communityName: "The Cliffs at Princeville",
    city: "Hanalei",
    state: "Hawaii",
    unitAddresses: [],
  }),
  "3811 Edward Rd",
  "bulk combo queue should use The Cliffs canonical address when queued from a north-shore city search",
);
assert.equal(
  validateCommunityStreetAddress({
    communityName: "The Cliffs at Princeville",
    city: "Hanalei",
    state: "Hawaii",
    streetAddress: "3811 Edward Rd",
  }).ok,
  true,
  "The Cliffs at Princeville should accept Hanalei as the research city while using the Princeville street",
);
assert.ok(
  discoverySearchCitiesForPhotoSearch({
    communityName: "The Cliffs at Princeville",
    city: "Hanalei",
    streetAddress: "3811 Edward Rd",
  }).includes("Princeville"),
  "The Cliffs photo discovery should search Princeville, not only Hanalei",
);
console.log("  ✓ The Cliffs at Princeville canonical address validates for bulk combo draft saves");

assert.equal(
  resolveBulkComboListingStreet({
    communityName: "Ko Olina Beach Villas",
    city: "Kapolei",
    state: "Hawaii",
    streetAddress: "",
  }),
  "92-102 Waialii Pl",
  "bulk combo hydrate should backfill canonical street for in-flight queue rows with empty streetAddress",
);
console.log("  ✓ bulk combo street backfill helper");

assert.equal(
  bulkComboProgressPercent({ status: "queued", phase: "queued" }),
  2,
  "queued bulk combo items should show minimal progress",
);
assert.ok(
  bulkComboProgressPercent({ status: "running", phase: "photos", message: "Searching for Unit B photos" }) >= 30,
  "photos phase with Unit B message should be past the halfway mark of the photo step",
);
assert.ok(
  bulkComboRemainingMs({ status: "queued", phase: "queued" }, { queueAhead: 1 })! > 600_000,
  "queued item behind another should estimate more than ten minutes remaining",
);
assert.ok(
  bulkComboProgressPercent({ status: "running", phase: "photos", message: "OTA preflight (12 photos)" }) >= 20,
  "OTA preflight message should advance photos sub-progress",
);
assert.equal(MAX_COMBO_PHOTO_OTA_ATTEMPTS, 8, "combo photo OTA retry cap (default; env COMBO_PHOTO_OTA_ATTEMPTS overrides)");
// The two post-persist verification gates have their own progress floors so the
// bar no longer parks at 86-98% during Sonnet vision / the OTA deep scan.
assert.ok(
  bulkComboProgressPercent({ status: "running", phase: "photo-community" }) >= 90,
  "photo-community phase should advance the progress bar past persist",
);
assert.ok(
  bulkComboProgressPercent({ status: "running", phase: "ota-scan" }) >= 94,
  "ota-scan phase should advance the progress bar past photo-community",
);
// One-click multi-batch: the sweep auto-queues the NEXT batch when the current
// job completes, instead of asking the operator to click "Queue again".
assert.ok(
  addCommunitySource.includes("sweepAutoContinueArmedRef"),
  "sweep overflow must auto-queue the next batch on job completion",
);
assert.ok(
  !routeSource.includes("assertQueueCircuitOpen(circuitKey)"),
  "bulk combo loopback photo fetch must not use endpoint circuit breakers",
);
assert.ok(
  routeSource.includes("headers: loopbackRequestHeaders()"),
  "bulk combo loopback photo fetch must carry loopback auth headers",
);
console.log("  ✓ bulk combo queue progress + ETA helpers");

const honuaKaiTypical = inferTypicalComboPair({ availableBedrooms: [1, 2, 3] });
assert.deepEqual(honuaKaiTypical, { unitBeds: 3, secondUnitBeds: 3, totalBeds: 6 });
assert.equal(formatTypicalComboLabel(honuaKaiTypical), " · 2×3BR=6BR");
const regencyTypical = inferTypicalComboPair({
  availableBedrooms: [2, 3, 4],
  estimatedBedroomUnitCounts: { "2": 25, "3": 45, "4": 10 },
});
assert.equal(regencyTypical?.totalBeds, 8, "4BR inventory should surface 8BR as the headline combo");
assert.equal(formatTypicalComboLabel(regencyTypical), " · 2×4BR=8BR");
const kahalaTypical = inferTypicalComboPair({ availableBedrooms: [2, 3] });
assert.deepEqual(kahalaTypical, { unitBeds: 3, secondUnitBeds: 3, totalBeds: 6 });
assert.equal(formatTypicalComboLabel({ unitBeds: 2, secondUnitBeds: 3, totalBeds: 5 }), " · 2BR+3BR=5BR");
assert.equal(
  normalizeCombinedBedroomsTypical({ availableBedrooms: [1,  2, 3], combinedBedroomsTypical: 5 }),
  6,
);
console.log("  ✓ typical combo labels distinguish 2×same-BR vs mixed-BR pairs");

// 4BR-minimum combo floor (operator rule 2026-07-07): a combo is a 4BR-or-higher
// combination — a 3BR pair (e.g. 2BR+1BR) is never a valid/typical combo.
// With a single 2BR unit the only same-total-3 pairing (1BR+2BR) must be
// rejected rather than surfaced as the headline combo (locks the shared
// inferTypicalComboPair floor).
assert.equal(
  inferTypicalComboPair({ availableBedrooms: [1, 2], estimatedBedroomUnitCounts: { "2": 1 } }),
  null,
  "a lone 2BR beside a 1BR must not surface a 3BR (1BR+2BR) combo",
);
// Two 2BR units still make a valid 4BR combo (the floor is inclusive of 4).
assert.deepEqual(
  inferTypicalComboPair({ availableBedrooms: [1, 2], estimatedBedroomUnitCounts: { "2": 2 } }),
  { unitBeds: 2, secondUnitBeds: 2, totalBeds: 4 },
  "two 2BR units make a 4BR combo (4BR floor is inclusive)",
);
// Server generator gate (search-units) enforces the same 4BR floor, and the
// two save/runner choke points reject a resolved <4BR combo.
assert.ok(
  routesSource.includes("4-bedroom-or-higher combination"),
  "search-units pairing generator must enforce the 4BR combo floor",
);
assert.ok(
  routesSource.includes("Combo drafts must have at least 4 combined bedrooms"),
  "community/save must reject combo drafts below 4 combined bedrooms",
);
assert.ok(
  routesSource.includes("min-bedrooms-skip") && routesSource.includes("effTotalBeds < 4"),
  "bulk-combo runner must skip a resolved <4BR combo before persisting a draft",
);
console.log("  ✓ combo listings enforce a 4BR-minimum combined-bedroom floor");

const sixBrPairing = {
  unit1Beds: 3,
  unit2Beds: 3,
  totalBeds: 6,
  matchScore: 5,
  availability: "available" as const,
};
const eightBrPairing = {
  unit1Beds: 4,
  unit2Beds: 4,
  totalBeds: 8,
  matchScore: 5,
  availability: "available" as const,
};
assert.equal(
  pickBestAvailableComboPairing([sixBrPairing, eightBrPairing])?.totalBeds,
  8,
  "bulk queue should prefer 8BR over 6BR when both are unused",
);
assert.equal(
  pickBestAvailableComboPairing([
    { ...sixBrPairing, availability: "existing", alreadyExists: true },
    eightBrPairing,
  ])?.totalBeds,
  8,
  "bulk queue should fall through to 8BR when 6BR is already built",
);
assert.equal(
  pickBestAvailableComboPairing([
    { ...eightBrPairing, availability: "reserved", reserved: true, alreadyExists: true },
    sixBrPairing,
  ])?.totalBeds,
  6,
  "bulk queue should use 6BR when 8BR is already reserved or built",
);
console.log("  ✓ pickBestAvailableComboPairing prefers largest unused combo");

const requiredMapMarkets = new Set<string>();
for (const [market, related] of Object.entries(SIMILAR_BUY_IN_MARKETS)) {
  requiredMapMarkets.add(market);
  for (const relatedMarket of related) requiredMapMarkets.add(relatedMarket);
}
for (const market of Object.values(BUY_IN_MARKETS)) {
  if (market.key !== "Florida Generic" && (market.location || requiredMapMarkets.has(market.key))) {
    assert.ok(BUY_IN_MARKET_LOCATIONS[market.key], `${market.key} should have a map-search location`);
    assert.ok(BUY_IN_MARKET_BOUNDS[market.key], `${market.key} should have a community boundary box`);
  }
}
for (const [market, bounds] of Object.entries(BUY_IN_MARKET_BOUNDS)) {
  const loc = BUY_IN_MARKET_LOCATIONS[market];
  assert.ok(loc, `${market} boundary should have a matching location`);
  assert.ok(bounds.sw_lat < bounds.ne_lat && bounds.sw_lng < bounds.ne_lng, `${market} boundary should be SW→NE ordered`);
  assert.ok(
    loc.lat >= bounds.sw_lat && loc.lat <= bounds.ne_lat && loc.lng >= bounds.sw_lng && loc.lng <= bounds.ne_lng,
    `${market} location should be inside its community boundary box`,
  );
}
console.log("  ✓ buy-in community map boundary boxes are complete and ordered");

assert.ok(TOP_MARKET_SEEDS.length >= 86, "top markets sweep should not shrink below the original 86-market coverage");
const topMarketAudit = auditTopMarketSevenEightFromCuratedSeeds();
assert.equal(topMarketAudit.length, TOP_MARKET_SEEDS.length);
const sevenEightMarkets = topMarketAudit.filter((row) => row.sevenEight);
const marketHasSevenEight = (city: string, state: string) =>
  sevenEightMarkets.some((row) => row.city === city && row.state === state);
assert.ok(marketHasSevenEight("Poipu", "Hawaii"), "Poipu should have 7/8BR via Regency 4BR inventory");
assert.ok(marketHasSevenEight("Koloa", "Hawaii"), "Koloa should share Poipu Kai 7/8BR seeds");
assert.ok(marketHasSevenEight("Princeville", "Hawaii"), "Princeville should have Kaiulani/Cliffs 4BR inventory");
assert.ok(marketHasSevenEight("Hanalei", "Hawaii"), "Hanalei should inherit Princeville north-shore 4BR seeds");
assert.ok(marketHasSevenEight("Destin", "Florida"), "Destin should have Emerald Towers 4BR condos");
assert.ok(marketHasSevenEight("Panama City Beach", "Florida"), "Panama City Beach should have Shores of Panama 4BR condos");
assert.ok(
  !marketHasSevenEight("Fort Myers Beach", "Florida"),
  "Fort Myers Beach seeds should not claim 7/8BR without 4BR inventory",
);
const seededFourBedroom = topMarketAudit.filter((row) => row.fourBedroomCommunities.length > 0);
assert.ok(seededFourBedroom.length >= 8, "multiple top markets should surface curated 4BR communities");
console.log(
  `  ✓ top-market 4BR audit: ${sevenEightMarkets.length}/${TOP_MARKET_SEEDS.length} markets with curated 7/8BR potential`,
);

assert.match(
  routeSource,
  /nameLooksSameCommunity/,
  "community research should use strict community-name matching for already-in-system flags",
);
assert.match(
  routeSource,
  /WEAK_COMMUNITY_NAME_TOKENS/,
  "community research should ignore single-token kai/beach overlaps when flagging existing listings",
);
console.log("  ✓ already-in-system uses strict community-name matching");

assert.equal(
  validateCommunityStreetAddress({
    communityName: "Pili Mai",
    city: "Koloa",
    state: "HI",
    streetAddress: "2253 Poipu Rd",
  }).ok,
  false,
  "Pili Mai should reject Kiahuna Plantation's 2253 Poipu Rd address",
);
console.log("  ✓ Pili Mai rejects the Kiahuna 2253 Poipu Rd mismatch");

const dashboardPropertyIds = new Set([4, 9, 19, 20, 23, 24, 27, 29, 32, 33]);
for (const prop of unitBuilderData.filter((p) => dashboardPropertyIds.has(p.propertyId))) {
  const check = validateCommunityStreetAddress({
    communityName: prop.complexName,
    city: prop.address.split(",").at(-2)?.trim(),
    state: prop.address.split(",").at(-1)?.trim().split(/\s+/)[0],
    streetAddress: prop.address,
  });
  assert.equal(check.ok, true, `${prop.propertyId} ${prop.complexName} should have a valid canonical community address`);
}
console.log("  ✓ active dashboard property addresses match their communities");

const maunaKaiFiveBr = unitBuilderData.find((p) => p.propertyId === 19);
assert.ok(maunaKaiFiveBr, "property 19 Mauna Kai config should exist");
const maunaKaiFiveBrFolders = maunaKaiFiveBr.units.map((u) => u.photoFolder).filter(Boolean);
assert.equal(
  new Set(maunaKaiFiveBrFolders).size,
  maunaKaiFiveBrFolders.length,
  "property 19 Mauna Kai units must not share the same photo folder",
);
assert.deepEqual(
  maunaKaiFiveBrFolders,
  ["mauna-kai-unit-9", "mauna-kai-unit-11"],
  "property 19 Mauna Kai unit photo folders should match the actual unit claims",
);
console.log("  ✓ property 19 Mauna Kai units use isolated photo folders");

console.log("\nall suites passed ✅");

// ── Surgical addition: market-rate sampler helpers (random near-future windows) ──
import { pickRandom7NightInSeason, AIRBNB_TO_MARKET_MARKUPS, applyAirbnbBiasAndCombo } from "../shared/pricing-rates";

function testMarketPicker() {
  const w = pickRandom7NightInSeason("hawaii", "LOW", 10);
  if (!w) throw new Error("picker returned null");
  const d = new Date(w.checkIn);
  const daysAhead = (d.getTime() - Date.now()) / 86400000;
  if (daysAhead > 400) throw new Error("picker produced far-future window (>400d) — the 2028 bug");
  if (daysAhead < 1) throw new Error("picker produced past window");
  console.log("[test] pickRandom7NightInSeason LOW ok, daysAhead~", Math.round(daysAhead));
  const adj = applyAirbnbBiasAndCombo(500, "LOW", 2, true);
  if (adj < 1100) throw new Error("combo+markup math off");
  console.log("[test] applyAirbnbBiasAndCombo combo LOW ok ->", adj);
  if (!AIRBNB_TO_MARKET_MARKUPS.LOW) throw new Error("missing markup table");
  console.log("[test] market picker + markup + combo: PASS");
}

testMarketPicker();

import {
  driveMinutesBetweenBuyInMarkets,
  nearbyBuyInMarketsForScout,
  oceanfrontComparableBuyInMarket,
} from "../shared/buy-in-market";
import {
  inferResortCommunityLabel,
  looksLikeIndividualListingTitle,
  looksLikeHotelNotVacationRentalResort,
} from "../shared/alternative-scout-resort";

assert.equal(oceanfrontComparableBuyInMarket("Kapaa Beachfront"), true);
assert.equal(oceanfrontComparableBuyInMarket("Poipu Kai"), false);
assert.equal(oceanfrontComparableBuyInMarket("Makahuena"), true);
assert.equal(oceanfrontComparableBuyInMarket("Princeville"), false);

const poipuToOceanfront = driveMinutesBetweenBuyInMarkets("Poipu Kai", "Poipu Oceanfront");
assert.ok(poipuToOceanfront !== null && poipuToOceanfront <= 20, "Poipu Oceanfront should be within 20 min of Poipu Kai");

const poipuToKapaa = driveMinutesBetweenBuyInMarkets("Poipu Kai", "Kapaa Beachfront");
assert.ok(poipuToKapaa !== null && poipuToKapaa > 20, "Kapaa should be outside the 20 min drive scout radius from Poipu Kai");

const poipuNearbyAll = nearbyBuyInMarketsForScout("Poipu Kai", { maxDriveMinutes: 20, oceanfrontOnly: false });
assert.ok(poipuNearbyAll.includes("Pili Mai"), "Pili Mai should be within 20 min of Poipu Kai");
assert.ok(!poipuNearbyAll.includes("Kapaa Beachfront"), "Kapaa should be outside 20 min from Poipu Kai");

const poipuNearbyOcean = nearbyBuyInMarketsForScout("Poipu Kai", { maxDriveMinutes: 20, oceanfrontOnly: true });
assert.ok(poipuNearbyOcean.includes("Poipu Oceanfront"), "oceanfront scout should include Poipu Oceanfront");
assert.ok(poipuNearbyOcean.includes("Poipu Brenneckes"), "Poipu Brenneckes counts as oceanfront-comparable");
assert.ok(poipuNearbyOcean.includes("Makahuena"), "Makahuena should be within 20 min oceanfront scout");
assert.ok(!poipuNearbyOcean.includes("Pili Mai"), "Pili Mai is not oceanfront-comparable");
assert.ok(!poipuNearbyOcean.includes("Kapaa Beachfront"), "Kapaa should be excluded at 20 min for Poipu Kai oceanfront scout");
console.log("[test] nearby buy-in markets by drive: PASS");

assert.equal(
  looksLikeIndividualListingTitle("2/2 BEACH FRONT RESORT-AC-Poipu Bch, Kiahuna-Garden View"),
  true,
  "individual Airbnb listing titles must not become scout community names",
);
assert.equal(looksLikeIndividualListingTitle("Kiahuna Plantation"), false);
assert.equal(looksLikeIndividualListingTitle("Whalers Cove Resort"), false);
assert.ok(looksLikeHotelNotVacationRentalResort("Marriott Kauai Beach Resort Hotel"));
assert.ok(!looksLikeHotelNotVacationRentalResort("Kiahuna Plantation condominium resort vacation rentals"));
assert.equal(
  inferResortCommunityLabel(
    [{ title: "2BR Garden View at Kiahuna Plantation - Poipu" }],
    "2/2 BEACH FRONT RESORT w AC, Kiahuna Gardenview",
  ),
  "Kiahuna Plantation",
);
console.log("  ✓ resort vs listing title guards");

const bookingsSource = readFileSync("client/src/pages/bookings.tsx", "utf8");
const buyInCheckoutSource = readFileSync("server/buy-in-checkout-job.ts", "utf8");
const vrboWorkerSource = readFileSync("daemon/vrbo-sidecar/worker.mjs", "utf8");

assert.ok(
  !routesSource.includes('app.post("/api/operations/alternative-buy-in-scout"'),
  "alternative-buy-in-scout route should be removed",
);
assert.ok(
  !routesSource.includes('app.post("/api/bookings/:reservationId/alternative-message-draft"'),
  "alternative-message-draft route should be removed",
);
assert.ok(
  !bookingsSource.includes('alternativeScout: "1"') &&
    !bookingsSource.includes("AlternativeMapInventoryPanel") &&
    !bookingsSource.includes("attachAlternativeReplacementSet") &&
    !bookingsSource.includes("scoutAlternativeCommunities") &&
    !bookingsSource.includes("shouldAutoTriggerAlternativeScout") &&
    !bookingsSource.includes("autoAlternativeScoutAfterSearchRef") &&
    !bookingsSource.includes("mergeAlternativeFindBuyInResponses"),
  "bookings UI should not expose alternative community scout workflow",
);
assert.ok(
  routesSource.includes("looksLikeIndividualListingTitle"),
  "listing title guards should remain for resort inference",
);
assert.equal(buyInMarketKeyForScoutCommunity("Princeville, Hawaii"), "Princeville");
assert.ok(
  textMatchesResortPhrase("Villas of Kamalii 30 · Princeville", "Kamalii"),
  "resort phrase filter should match Kamalii listing titles",
);
// The auto-fill escalation ladder + the buy-in ATTACH moved SERVER-SIDE
// (server/auto-fill-job.ts) so it survives the operator leaving the bookings page
// (see AGENTS.md "Auto-fill cheapest is a SERVER-SIDE background job"). These
// guards therefore assert on the server job + the shared matcher, not the retired
// client mutation that used to live in bookings.tsx.
const autoFillJobSource = readFileSync("server/auto-fill-job.ts", "utf8");
const cityComboSource = readFileSync("shared/city-vrbo-combo.ts", "utf8");
assert.ok(
  !routesSource.includes("candidate.verified !== \"yes\"") &&
    routesSource.includes("const configuredSlot = pid") &&
    autoFillJobSource.includes("unitTypeConfidence: Math.round(pick.unitTypeConfidence)"),
  "attached buy-ins should not depend on a non-persisted verified column and should persist search confidence when available (server-side auto-fill job)",
);
assert.ok(
  cityComboSource.includes("pairIsWalkable") &&
    cityComboSource.includes("MAX_BUY_IN_WALK_MINUTES") &&
    cityComboSource.includes("sharedResortPhraseKeys") &&
    autoFillJobSource.includes("reconcileComboAllOrNothing") &&
    routesSource.includes("Buy-in units too far apart"),
  "auto-fill combo selection should reject non-walkable pairs (shared matcher walkability + attach proximity guard) and roll back partial combos all-or-nothing",
);
assert.ok(
  autoFillJobSource.includes("/api/operations/city-vrbo-inventory") &&
    autoFillJobSource.includes("single-unit-city"),
  "auto-fill should fall back to city-wide VRBO inventory (server-side single-unit-city stage)",
);

	assert.ok(
	  vrboWorkerSource.includes("createVrboGraphqlCollector") &&
	    vrboWorkerSource.includes("propertySearchListings") &&
	    vrboWorkerSource.includes("extractLatLngDeep") &&
	    vrboWorkerSource.includes("extractVrboBathroomsFromText") &&
	    vrboWorkerSource.includes("extractVrboSleepsFromText") &&
	    vrboWorkerSource.includes("reviewCount") &&
	    vrboWorkerSource.includes("captureSource: \"vrbo_graphql_propertySearchListings\""),
	  "VRBO map-bounds search should passively capture propertySearchListings inventory, coordinates, and basic listing details from the visible search",
	);
assert.ok(
  vrboWorkerSource.includes("disableVrboSearchAsMapMoves") &&
    vrboWorkerSource.includes("city map search has no provider mapBounds") &&
    vrboWorkerSource.includes("if (bounds)") &&
    vrboWorkerSource.includes("clickVrboSearchThisArea") &&
    vrboWorkerSource.includes("logProviderMapSearchPlan") &&
    vrboWorkerSource.includes("map-search-plan") &&
    vrboWorkerSource.includes("urlHasMapBounds"),
  "VRBO city map scans should turn off map auto-search and avoid binding city searches to the visible map viewport",
);
assert.ok(
  vrboWorkerSource.includes("starting dropdown list harvest") &&
    vrboWorkerSource.includes("harvestVrboMapResultCards") &&
    vrboWorkerSource.includes("dropdown export merged") &&
    vrboWorkerSource.includes("graphql settled") &&
    vrboWorkerSource.includes("post-map-view") &&
    vrboWorkerSource.includes("createVrboGraphqlCollector") &&
    vrboWorkerSource.includes("paginateVrboGraphqlInventory") &&
    vrboWorkerSource.includes("replayNextGraphqlPage") &&
    vrboWorkerSource.includes("extractVrboGraphqlPaginationMeta") &&
    vrboWorkerSource.includes("clickVrboResultsNextPage") &&
    vrboWorkerSource.includes("hasNextPage=false") &&
    routesSource.includes("resort destination dropdown, dates, and bedroom export"),
  "VRBO resort dropdown search should paginate GraphQL inventory via cursor replay with UI Next fallback, then merge DOM harvest",
);
	assert.ok(
	  vrboWorkerSource.includes("finalHarvestTotal") &&
	    vrboWorkerSource.includes("harvestSeenInExtract") &&
	    vrboWorkerSource.includes("graphqlPaginationStop") &&
	    vrboWorkerSource.includes("graphqlTotalCount"),
	  "VRBO harvest stats should return pagination diagnostics to the server",
	);

assert.equal(classifyFailureText("HTTP 502 while waiting for sidecar lane").failureClass, "transient");
assert.equal(classifyFailureText("waiting-sidecar-lane held by bulk combo").failureClass, "sidecar");
assert.equal(
  suggestRemediations({
    jobType: "replacement-find",
    failureClass: "search-exhausted",
    errorText: "No eligible replacement",
    diagnostic: { budgetStopped: true, uncheckedCandidates: [{ url: "https://zillow.com/x" }] },
  }).some((r) => r.playbook === "continue-search"),
  true,
  "replacement diagnostics should offer continue-search when budget stopped with unchecked candidates",
);
assert.ok(
  buildOperationDiagnostics({
    title: "Test",
    severity: "error",
    summary: "failed",
    context: { jobId: "j1" },
    remediation: suggestRemediations({
      jobType: "bulk-combo-listing",
      failureClass: "address",
      errorText: "Fix the property address",
    }),
  }).report.includes("Suggested actions"),
  "operation diagnostics report should list remediations",
);
const opsApi = readFileSync("server/operation-diagnostics-api.ts", "utf8");
assert.ok(opsApi.includes('app.get("/api/operations/diagnostics"'), "operations diagnostics route should exist");
assert.ok(opsApi.includes('app.post("/api/operations/remediate"'), "operations remediate route should exist");
assert.ok(
  unitReplacementSource.includes("OperationFailureActions"),
  "replacement flow should expose Check logs on failure",
);
assert.ok(
  addCommunitySource.includes("OperationFailureActions"),
  "add-community should expose Check logs for bulk combo and photo fetch failures",
);
console.log("  ✓ operation diagnostics + remediate helpers");

const liveSearchSectionStart = bookingsSource.indexOf("function LiveSearchSection");
assert.ok(liveSearchSectionStart >= 0, "LiveSearchSection should exist in bookings page");
const liveSearchSectionBody = bookingsSource.slice(liveSearchSectionStart);
assert.ok(
  !liveSearchSectionBody.includes("autoAlternativeScoutAfterSearchRef") &&
    !liveSearchSectionBody.includes("onScoutAlternatives"),
  "LiveSearchSection should not auto-trigger alternative community scout",
);
assert.ok(
  liveSearchSectionBody.includes("return fetchFindBuyInWithRetry("),
  "LiveSearchSection should use retrying find-buy-in fetch that survives transient disconnects",
);
assert.ok(
  liveSearchSectionBody.includes("visibilitychange"),
  "LiveSearchSection should refetch find-buy-in when the tab becomes visible again",
);
assert.ok(
  bookingsSource.includes("sidecarLaneSummary"),
  "Operations progress should surface when find-buy-in is waiting behind another sidecar lane owner",
);
console.log("  ✓ LiveSearchSection resort find-buy-in only");

const bookingsComboSource = readFileSync("client/src/pages/bookings.tsx", "utf8");
const searchApiSource = readFileSync("server/searchapi.ts", "utf8");
assert.ok(
  bookingsComboSource.includes("ComboOptionWalkDistance"),
  "bookings combo panel should show walking distance between combo units",
);
assert.ok(
  bookingsComboSource.includes("/api/tools/listing-pair-proximity"),
  "bookings combo panel should call listing-pair-proximity API",
);
assert.ok(
  routesSource.includes('app.post("/api/tools/listing-pair-proximity"'),
  "listing-pair-proximity route should exist",
);
console.log("  ✓ combo option walking distance UI + API");

assert.ok(
  !bookingsComboSource.includes('apiRequest("POST", "/api/operations/alternative-scout-direct-probes"'),
  "alternative buy-in workflow should skip Google Lens direct-site probes before sidecar",
);
assert.ok(
  routesSource.includes("const includePm = false") &&
    routesSource.includes("if (!includePm) return [];"),
  "find-buy-in (and the server-side auto-fill ladder that calls it) should not run PM/direct source discovery",
);
assert.ok(
  routesSource.includes("Google Lens reverse-image search is disabled to preserve SearchAPI quota"),
  "reverse-image-listings should return a disabled response before spending SearchAPI Lens quota",
);
assert.ok(
  routesSource.includes('app.post("/api/operations/alternative-scout-direct-probes"'),
  "alternative-scout-direct-probes compatibility route should exist",
);
assert.ok(
  routesSource.includes("const alternativeScoutMinPhotoMatches = 0"),
  "alternative scout Lens probe compatibility response should report a disabled threshold",
);
assert.ok(
  routesSource.includes('status: "skipped" as const') && routesSource.includes("Google Lens reverse-image direct-booking probes are disabled"),
  "alternative scout direct probes should mark samples skipped without calling Lens",
);
assert.ok(
  routesSource.includes("Google Lens reverse-image direct-booking proof is disabled to preserve SearchAPI quota"),
  "direct-booking-sites should return a disabled no-match response without scraping Lens",
);
assert.ok(
  routesSource.includes("airbnbDirectLensEnabled = false"),
  "find-buy-in direct Lens discovery should be hard-disabled by default",
);
// 2026-07-09 (operator): key rotation restored — a second SearchAPI key
// (SEARCHAPI_API_KEY_2) rotates in on quota/rate-limit responses.
assert.ok(
  searchApiSource.includes("process.env.SEARCHAPI_API_KEY_2") &&
    searchApiSource.includes("process.env.SEARCHAPI_API_KEY_SECONDARY"),
  "SearchAPI key resolution should read the SEARCHAPI_API_KEY_2 rotation key",
);
assert.ok(
  searchApiSource.includes("process.env.SEARCHAPI_API_KEY"),
  "SearchAPI key resolution should read the primary SEARCHAPI_API_KEY",
);
assert.ok(
  routesSource.includes("type DirectBookingProof"),
  "direct booking discovery should expose a structured proof ledger",
);
assert.ok(
  routesSource.includes("direct PM price/availability must be verified before recording"),
  "Lens-discovered direct rows should not inherit Airbnb price as direct proof",
);
assert.ok(
  bookingsComboSource.includes("directProofShortLabel"),
  "bookings UI should display direct proof level for Lens/direct matches",
);
assert.ok(
  !bookingsComboSource.includes("Optimize direct booking sites") &&
    !bookingsComboSource.includes('apiRequest("POST", "/api/operations/direct-booking-sites"') &&
    !bookingsComboSource.includes("Direct-booking Airbnb picks") &&
    !bookingsComboSource.includes("button-direct-booking-airbnb-scan"),
  "bookings UI should not expose manual direct-booking site optimize/scan actions",
);
console.log("  ✓ direct booking probe compatibility API");

const kamalii3: CityVrboListing = {
  url: "https://www.vrbo.com/111",
  title: "Villas of Kamalii 30 · Princeville",
  bedrooms: 3,
  totalPrice: 4200,
  lat: 22.217,
  lng: -159.478,
};
const kamalii2: CityVrboListing = {
  url: "https://www.vrbo.com/222",
  title: "Villas of Kamalii 12 · Princeville",
  bedrooms: 2,
  totalPrice: 3100,
  lat: 22.2171,
  lng: -159.4781,
};
assert.ok(
  sharedResortPhraseKeys(kamalii3).some((key) => key.includes("villas of kamalii")),
  "city VRBO combo matcher should extract Villas of Kamalii phrase keys",
);
const kamaliiPair = suggestCityVrboComboPair([kamalii3, kamalii2], [3, 2], 6);
assert.ok(kamaliiPair && kamaliiPair.picks.length === 2, "city VRBO combo matcher should pair 3BR+2BR with shared title");
assert.equal(kamaliiPair?.resortPhrase.includes("kamalii"), true);
assert.equal(
  filterCityVrboListingsByPhrase([kamalii3, kamalii2, { url: "https://www.vrbo.com/9", title: "Random Princeville condo", bedrooms: 3, totalPrice: 5000 }], "Kamalii").length,
  2,
  "phrase filter should narrow the in-memory pool before pairing",
);
assert.ok(
  routesSource.includes("/api/operations/city-vrbo-inventory") &&
    routesSource.includes("runCityVrboInventoryScan"),
  "routes should expose city VRBO inventory scan for full dropdown export + combo pairing",
);
const cityInventorySource = readFileSync("server/city-vrbo-inventory.ts", "utf8");
	assert.ok(
	  cityInventorySource.includes("cityWideInventory: true") &&
	    cityInventorySource.includes("rawListings") &&
	    vrboWorkerSource.includes("cityWideInventory") &&
	    vrboWorkerSource.includes("clickVrboListViewControl") &&
	    vrboWorkerSource.includes("paginateVrboGraphqlInventory") &&
	    vrboWorkerSource.includes("walkVrboResultsUiPages") &&
	    vrboWorkerSource.includes('data-stid="next-button"') &&
    cityInventorySource.includes('searchMode: "destination_dropdown"') &&
    !cityInventorySource.includes('searchMode: "map_bounds"') &&
    !cityInventorySource.includes("mapSearch:"),
  "city VRBO inventory should use one city dropdown term and must not run map-bounds harvest",
);
	assert.ok(
	  cityInventorySource.includes("cityVrboScrapeCache") &&
	    cityInventorySource.includes("filterPipeline") &&
	    cityInventorySource.includes("logFilterPipeline") &&
	    cityInventorySource.includes("CITY_VRBO_INVENTORY_WALLET_BUDGET_MS"),
	  "city VRBO inventory should cache the full scrape pool, use an export-sized budget, and log per-stage filter counts",
	);
assert.ok(
  autoFillJobSource.includes("/api/operations/city-vrbo-inventory") &&
    autoFillJobSource.includes('stage: "resort"') &&
    autoFillJobSource.includes("reconcileComboAllOrNothing") &&
    autoFillJobSource.includes("single-unit-city"),
  "server-side auto-fill should attach the resort combo all-or-nothing, then fall back to city-wide VRBO (home-city + single-unit-city) without per-community scout",
);
	assert.ok(
	  bookingsSource.includes("CityVrboInventoryPanel") &&
	    bookingsSource.includes("format: \"csv\"") &&
	    bookingsSource.includes("<Download"),
	  "bookings UI should expose a city VRBO CSV download for the raw inventory export",
	);
	assert.ok(
	  routesSource.includes("cityVrboInventoryCsv") &&
	    routesSource.includes("Content-Disposition") &&
	    routesSource.includes("format") &&
	    routesSource.includes("rawListings"),
	  "city VRBO inventory route should return JSON plus a CSV download of the raw export rows",
	);
assert.ok(
  bookingsSource.includes("guestAlternativePageMutation") &&
    bookingsSource.includes("slotsForPage") &&
    bookingsSource.includes("manualBuyInPhotoUrlsFromNotes") &&
    bookingsSource.includes("/unit-proximity") &&
    bookingsSource.includes("originalCommunity") &&
    bookingsSource.includes("alternativeCommunity") &&
    bookingsSource.includes("getUnitBuilderByPropertyId") &&
    bookingsSource.includes("unitWalkMinutes") &&
    bookingsSource.includes("walkMinutes"),
  "buy-in Guest Page action should submit the full attached combo, saved listing photos, and community proximity context",
);
assert.ok(
  bookingsSource.includes("Manually attached from combo\\s+(.+?)\\s+—\\s+\\d+\\s*BR") &&
    bookingsSource.includes("usableGuestAlternativeCommunity") &&
    bookingsSource.includes("comboLabel.split"),
  "buy-in Guest Page action should parse combo community names from the saved label without using the operational note prefix",
);
// UNIFIED ALIAS (2026-07-19): the traveler email IS the unit-scoped reservation
// alias — the legacy firstname.lastname per-guest scheme (whose unit-index
// disambiguation could silently store ONE address on two units) must stay gone.
assert.ok(
  buyInCheckoutSource.includes("getOrCreateReservationAlias") &&
    buyInCheckoutSource.includes("travelerEmailNeedsRemint") &&
    !buyInCheckoutSource.includes("unitEmailIndexForBuyIn"),
  "the VRBO traveler email must reuse the unit-scoped reservation alias (one alias per unit), not a per-guest local-part scheme",
);
assert.ok(
  routesSource.includes("sharedVrboResortPhotos") &&
    routesSource.includes("isBrandingVrboPhotoUrl") &&
    routesSource.includes("pageCommunityPhotos") &&
    routesSource.includes("vacation rental option"),
  "booking alternatives should derive community photos from shared VRBO resort shots and reject generic scrape titles",
);
assert.ok(
  bookingsSource.includes("fetchAttachedBuyInSlots") &&
    bookingsSource.includes("fetchAttachedBuyInSlots(reservation)"),
  "guest page builders should re-fetch all attached buy-ins before composing combo alternatives",
);
assert.ok(
  bookingsSource.includes("refreshBookingsAfterBuyInChange") &&
    bookingsSource.includes('queryKey: ["/api/bookings/guesty-all"]') &&
    bookingsSource.includes("globalBookingsQuery.isLoading && !globalBookingsQuery.data"),
  "detach/attach should refresh the global guesty-all summary and avoid blocking the page on background refetch",
);
assert.ok(
  bookingsSource.includes("vrbo-payment-schedule") &&
    bookingsSource.includes("manually recorded buy-in") &&
    bookingsSource.includes("usableGuestAlternativeCommunity(listingTitle) ? listingTitle : \"\""),
  "manual VRBO buy-in attach should read checkout total and defer guest-page titles to server VRBO scrape",
);
assert.ok(
  routesSource.includes("MIN_GUEST_ALTERNATIVE_GALLERY_PHOTOS = 10") &&
    routesSource.includes("const vrboDetailsList = await Promise.all") &&
    routesSource.includes("scrapeVrboAlternativeDetails(sourceUrl)") &&
    routesSource.includes("isUnusableAlternativeTitle") &&
    routesSource.includes("manualBuyInPhotoUrlsFromNotes") &&
    routesSource.includes("pageCommunityPhotos") &&
    routesSource.includes("sharedVrboResortPhotos") &&
    routesSource.includes("photoSource") &&
    routesSource.includes("photoScrapeReason"),
  "booking alternatives route should scrape attached VRBO URLs when buy-in notes do not already carry a gallery",
);
assert.ok(
  routesSource.includes('class="carousel" data-carousel') &&
    routesSource.includes("data-carousel-prev") &&
    routesSource.includes("data-carousel-next") &&
    routesSource.includes("carousel-track") &&
    routesSource.includes("Unit ${index + 1}") &&
    routesSource.includes("We have availability in ${escapeHtml(alternativeCommunityDisplay)}. This community is in ${escapeHtml(areaNameDisplay)}") &&
    routesSource.includes("communityDriveMinutes") &&
    routesSource.includes("unitWalkMinutes") &&
    routesSource.includes("overviewDetails") &&
    routesSource.includes("Community & Amenity Preview") &&
    routesSource.includes("Unit A/B Walk") &&
    routesSource.includes("amenity-showcase") &&
    routesSource.includes("vacation-rental-expertz-mark.png") &&
    routesSource.includes("communityAmenityFallbackTags") &&
    routesSource.includes("fallbackWalkForResort(String(alternativeCommunity") &&
    routesSource.includes("const topCommunityPhotos = communityPhotoUrls.slice(0, 8)") &&
    !routesSource.includes("attachedPhotoUrls") &&
    !routesSource.includes("vacation-rental-expertz-horizontal-transparent.png") &&
    !routesSource.includes("Instead of ${escapeHtml(originalCommunity)}"),
  "guest-facing alternatives page should render scraped listing photos as a carousel with unit labels, details, and community drive copy",
);
assert.ok(
  routesSource.includes("bathrooms") &&
    routesSource.includes("sleeps") &&
    routesSource.includes("basicDetails") &&
    routesSource.includes("extractAlternativeFactsFromText") &&
    routesSource.includes("formatAlternativeDisplayDate") &&
    routesSource.includes("${totalBedrooms} Bedroom Total") &&
    routesSource.includes("Bed Types") &&
    routesSource.includes("Unit Features") &&
    routesSource.includes("@media (max-width:480px)") &&
    routesSource.includes("chip-label") &&
    routesSource.includes("overflow-wrap:anywhere") &&
    routesSource.includes("html,body{max-width:100%;overflow-x:hidden}") &&
    !routesSource.includes("font-size:clamp(") &&
    routesSource.includes("Do not mention photo counts") &&
    routesSource.includes("This is property-detail copy for a review page") &&
    routesSource.includes("usableCommunityContext") &&
    routesSource.includes("communityFromAlternativeTitle") &&
    !routesSource.includes("photoCount: Array.isArray(item.photos)") &&
    !routesSource.includes("guestName: normalizeAlternativeText(stay.guestName"),
  "guest-facing alternatives page should include unit detail facts and keep AI descriptions from addressing the guest by name",
);
assert.ok(
  routesSource.indexOf("${carousel}") >= 0 &&
    routesSource.indexOf("${description ? `<p class=\"description\"") > routesSource.indexOf("${carousel}"),
  "guest-facing alternatives page should place each AI unit description below that unit's photo carousel",
);
assert.ok(
  vrboWorkerSource.includes("deepHarvest") && vrboWorkerSource.includes("deepMapHarvest"),
  "VRBO sidecar worker should still support map_bounds deep harvest for legacy callers only",
);
console.log("  ✓ city VRBO inventory export + combo pairing");

// ── Bedding push: dedupe duplicate roomNumber (combo "Unknown error") ──────
// A 2-unit combo (e.g. Ko Olina 6BR = two 3BR units) numbers bedrooms with a
// running counter (1..6, unique) but emits one roomNumber-0 "Living Room" per
// unit. Guesty's PUT /listings rejects two rooms sharing a roomNumber with a
// generic "Unknown error when updating listing"; dedupeListingRoomsByNumber
// must collapse them into ONE shared space carrying the summed sofa beds.
{
  const comboRooms = [
    { roomNumber: 1, name: "Master Bedroom", beds: [{ type: "KING_BED", quantity: 1 }] },
    { roomNumber: 2, name: "Bedroom 2", beds: [{ type: "QUEEN_BED", quantity: 1 }] },
    { roomNumber: 3, name: "Bedroom 3", beds: [{ type: "KING_BED", quantity: 1 }] },
    { roomNumber: 0, name: "Living Room", beds: [{ type: "SOFA_BED", quantity: 1 }] },
    { roomNumber: 4, name: "Bedroom 4", beds: [{ type: "KING_BED", quantity: 1 }] },
    { roomNumber: 5, name: "Bedroom 5", beds: [{ type: "QUEEN_BED", quantity: 1 }] },
    { roomNumber: 6, name: "Bedroom 6", beds: [{ type: "QUEEN_BED", quantity: 1 }] },
    { roomNumber: 0, name: "Living Room", beds: [{ type: "SOFA_BED", quantity: 1 }] },
  ];
  const deduped = dedupeListingRoomsByNumber(comboRooms);

  const roomNumbers = deduped.map((r) => r.roomNumber);
  assert.equal(deduped.length, 7, "combo rooms should collapse 8 -> 7 (two living rooms merge)");
  assert.equal(
    new Set(roomNumbers).size,
    roomNumbers.length,
    "every roomNumber must be unique after dedupe (no duplicate roomNumber 0)",
  );
  assert.equal(
    roomNumbers.filter((n) => n === 0).length,
    1,
    "exactly one shared-space room (roomNumber 0) after dedupe",
  );
  const sharedSpace = deduped.find((r) => r.roomNumber === 0)!;
  assert.equal(
    sharedSpace.beds.find((b) => b.type === "SOFA_BED")?.quantity,
    2,
    "the merged shared space carries both units' sofa beds (SOFA_BED x2)",
  );
  // Insertion order preserved: roomNumber 0 stays where it first appeared.
  assert.deepEqual(roomNumbers, [1, 2, 3, 0, 4, 5, 6], "first-seen order preserved");
  // Bedrooms are untouched.
  assert.equal(deduped.find((r) => r.roomNumber === 1)?.beds[0]?.quantity, 1);

  // Single shared space (single-unit listing) is unchanged / idempotent.
  const singleUnit = [
    { roomNumber: 1, name: "Master Bedroom", beds: [{ type: "KING_BED", quantity: 1 }] },
    { roomNumber: 0, name: "Living Room", beds: [{ type: "SOFA_BED", quantity: 1 }] },
  ];
  assert.deepEqual(
    dedupeListingRoomsByNumber(singleUnit),
    singleUnit,
    "single-unit rooms (one roomNumber 0) pass through unchanged",
  );
  // Does not mutate the caller's array/objects.
  assert.equal(comboRooms.length, 8, "input array is not mutated");
  assert.equal(comboRooms[3].beds[0].quantity, 1, "input room objects are not mutated");
}
console.log("  ✓ bedding listingRooms dedupe (combo duplicate roomNumber 0)");

// ── Bedding push: bed-type sanitization (the REAL "Unknown error") ─────────
// VERIFIED against live Guesty (2026-06-16): PUT /listings 500s with
// "Unknown error when updating listing" when ANY bed.type is not an accepted
// enum (TWIN_BED, FULL_BED, FUTON, MURPHY_BED, a bare "KING", null, …). One
// bad bed in a stale/legacy config sinks the whole bedding push. The sanitizer
// must coerce known aliases to a valid enum and drop the unmappable.
{
  // Accepted enums pass through unchanged.
  for (const t of ["KING_BED", "QUEEN_BED", "DOUBLE_BED", "SINGLE_BED", "SOFA_BED", "BUNK_BED", "COUCH", "CRIB"]) {
    assert.equal(normalizeGuestyBedType(t), t, `${t} should be accepted as-is`);
  }
  // Legacy / shorthand / mixed-case → nearest valid enum.
  assert.equal(normalizeGuestyBedType("TWIN_BED"), "SINGLE_BED");
  assert.equal(normalizeGuestyBedType("TWIN"), "SINGLE_BED");
  assert.equal(normalizeGuestyBedType("FULL_BED"), "DOUBLE_BED");
  assert.equal(normalizeGuestyBedType("FUTON"), "SOFA_BED");
  assert.equal(normalizeGuestyBedType("MURPHY_BED"), "QUEEN_BED");
  assert.equal(normalizeGuestyBedType("King"), "KING_BED");
  assert.equal(normalizeGuestyBedType("queen bed"), "QUEEN_BED");
  // Unmappable / invalid → null (caller drops the bed).
  assert.equal(normalizeGuestyBedType("XYZ"), null);
  assert.equal(normalizeGuestyBedType(""), null);
  assert.equal(normalizeGuestyBedType(null), null);
  assert.equal(normalizeGuestyBedType(undefined), null);

  // sanitizeListingRoomsForGuesty coerces in place and drops unmappable beds.
  const rooms = [
    { roomNumber: 1, name: "Master Bedroom", beds: [{ type: "KING_BED", quantity: 1 }] },
    { roomNumber: 3, name: "Bedroom 3", beds: [{ type: "TWIN_BED", quantity: 2 }] },
    { roomNumber: 0, name: "Living Room", beds: [{ type: "FUTON", quantity: 1 }] },
    { roomNumber: 4, name: "Bogus", beds: [{ type: "WHATEVER", quantity: 1 }, { type: "QUEEN_BED", quantity: 1 }] },
  ];
  const clean = sanitizeListingRoomsForGuesty(rooms);
  const allTypes = clean.flatMap((r) => r.beds.map((b) => b.type));
  const VALID = new Set(["KING_BED", "QUEEN_BED", "DOUBLE_BED", "SINGLE_BED", "SOFA_BED", "BUNK_BED", "AIR_MATTRESS", "FLOOR_MATTRESS", "WATER_BED", "TODDLER_BED", "CRIB", "COUCH"]);
  assert.ok(allTypes.every((t) => VALID.has(t)), `all bed types must be valid Guesty enums; got ${allTypes.join(",")}`);
  assert.equal(clean[1].beds[0].type, "SINGLE_BED", "TWIN_BED coerced to SINGLE_BED");
  assert.equal(clean[1].beds[0].quantity, 2, "quantity preserved through coercion");
  assert.equal(clean[2].beds[0].type, "SOFA_BED", "FUTON coerced to SOFA_BED");
  assert.equal(clean[3].beds.length, 1, "unmappable bed dropped, valid sibling kept");
  assert.equal(clean[3].beds[0].type, "QUEEN_BED");
  // Original input is not mutated.
  assert.equal(rooms[1].beds[0].type, "TWIN_BED", "sanitizer does not mutate the input");
}
console.log("  ✓ bedding bed-type sanitization (invalid type -> coerce/drop, the real Guesty 500)");

// ── Title "Sleeps N" stays in sync with the bed-derived occupancy ──────────
// The operator hit a listing whose title said "Sleeps 14" while Guesty said 12
// and the beds sleep 16. syncSleepsInTitle rewrites ONLY an existing "Sleeps N"
// token to the bed-derived count (the source of truth), leaving everything else.
{
  assert.equal(
    syncSleepsInTitle("Ko Olina - 6BR Condos - Sleeps 14", 16),
    "Ko Olina - 6BR Condos - Sleeps 16",
    "stale Sleeps 14 -> 16; the 6BR token is untouched",
  );
  // Case of the word is preserved.
  assert.equal(syncSleepsInTitle("Cozy condo, sleeps 8", 10), "Cozy condo, sleeps 10");
  // No "Sleeps N" token -> returned unchanged (never appended).
  assert.equal(syncSleepsInTitle("Ko Olina 6BR Condos", 16), "Ko Olina 6BR Condos");
  // Non-positive / empty -> unchanged (guards a not-yet-loaded bedding config).
  assert.equal(syncSleepsInTitle("Resort - Sleeps 14", 0), "Resort - Sleeps 14");
  assert.equal(syncSleepsInTitle("", 16), "");
  // Multi-digit + already-correct are both fine (idempotent).
  assert.equal(syncSleepsInTitle("Villa - Sleeps 22", 16), "Villa - Sleeps 16");
  assert.equal(syncSleepsInTitle("Villa - Sleeps 16", 16), "Villa - Sleeps 16");
}
console.log("  ✓ title Sleeps token sync (occupancy consistency: title == beds == accommodates)");

// ── Description body occupancy sync (the Descriptions-tab "N guests" prose) ─
// The AI summary said "Sleep up to 14 guests ... accommodate up to 14 guests"
// after the title/accommodates were corrected to 16. syncSleepsInDescription
// rewrites only the listing-level "... N guests" phrases, never bedroom counts,
// sqft, or per-unit "Sleeps N with <beds>" sentences.
{
  const summary =
    "Sleep up to 14 guests in two side-by-side 3-bedroom condos at Coconut Plantation. " +
    "Typical bedding across the two units can accommodate up to 14 guests comfortably, " +
    "with a mix of king, queen, and twin beds plus sleeper sofa options.";
  const fixed = syncSleepsInDescription(summary, 16);
  assert.ok(fixed.includes("Sleep up to 16 guests"), "leading 'Sleep up to N guests' -> 16");
  assert.ok(fixed.includes("accommodate up to 16 guests"), "'accommodate up to N guests' -> 16");
  assert.ok(!fixed.includes(" 14 guests"), "no stale '14 guests' remains");
  assert.ok(fixed.includes("two side-by-side 3-bedroom condos"), "bedroom count is untouched");

  // Per-unit "Sleeps N with <beds>" has no 'guests' token -> left alone.
  const perUnit = "Sleeps 8 with a King bed, Queen bed, 2 Twins, and a queen sleeper sofa.";
  assert.equal(syncSleepsInDescription(perUnit, 16), perUnit, "per-unit bed sentence untouched");

  // sqft / bedroom numbers untouched.
  assert.equal(
    syncSleepsInDescription("~1,800 sq ft condo with 6 bedrooms.", 16),
    "~1,800 sq ft condo with 6 bedrooms.",
    "sqft and bedroom counts untouched (no 'guests' token)",
  );
  // Idempotent + guards.
  assert.equal(syncSleepsInDescription("accommodate up to 16 guests", 16), "accommodate up to 16 guests");
  assert.equal(syncSleepsInDescription("Sleep up to 12 guests", 0), "Sleep up to 12 guests", "0 sleeps -> unchanged");
  assert.equal(syncSleepsInDescription("", 16), "");
}
console.log("  ✓ description body occupancy sync (prose 'N guests' -> listing sleeps)");

// ── ImgBB photo-push resilience (the failed Photos push) ───────────────────
// A free-tier ImgBB quota error (a 4xx saying "limit"/"exceeded", not just
// "rate limit") must be treated as retryable so a transient blip doesn't
// cascade the whole multi-photo push into a hard failure.
assert.ok(
  /function isImgBbRateLimit/.test(routesSource) &&
    /quota|exceeded|limit reached/i.test(
      routesSource.slice(routesSource.indexOf("function isImgBbRateLimit"), routesSource.indexOf("function isImgBbRateLimit") + 400),
    ),
  "isImgBbRateLimit should flag quota/limit-exceeded bodies as retryable, not only 'rate limit'",
);
assert.ok(
  routesSource.includes("uploadBufferToImgBbWithRetry") &&
    /transientNetwork/.test(routesSource) &&
    /ECONNRESET|ETIMEDOUT|fetch failed/.test(routesSource),
  "ImgBB upload retry should also retry transient network failures (no HTTP status)",
);
console.log("  ✓ ImgBB photo-push retry resilience (quota + transient network)");

// ── Guest inbox mailbox sync (VRBO guest thread) ───────────────────────────
const sampleGuestEmailRaw = [
  "From: VRBO <noreply@vrbo.com>",
  "To: cecilio.marquez@emailprivacy.com",
  "X-SimpleLogin-Envelope-To: cecilio.marquez@emailprivacy.com",
  "X-SimpleLogin-Envelope-From: noreply@vrbo.com",
  "Subject: Your reservation is confirmed",
  "Message-ID: <vrbo-test-123@vrbo.com>",
  "Date: Thu, 19 Jun 2026 17:00:00 +0000",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Your VRBO reservation is confirmed for Townhome A.",
].join("\r\n");

assert.ok(
  routesSource.includes("syncGuestInboxForAlias") &&
    routesSource.includes("./guest-inbox-sync"),
  "GET /api/guest-inbox should sync from SimpleLogin mailbox before reading DB",
);
assert.ok(isGuestBookingAliasEmail("cecilio.marquez@emailprivacy.com"), "emailprivacy.com should match guest alias domains");
assert.ok(isGuestBookingAliasEmail("cecilio.marquez2@emailprivaccy.com"), "configured traveler domain should match");
assert.ok(!isGuestBookingAliasEmail("noreply@vrbo.com"), "non-alias addresses should not match");
const parsedGuest = parseGuestInboxEmailFromRaw(sampleGuestEmailRaw);
assert.ok(parsedGuest, "should parse SimpleLogin-forwarded guest email");
assert.equal(parsedGuest!.aliasEmail, "cecilio.marquez@emailprivacy.com");
assert.equal(parsedGuest!.fromEmail, "noreply@vrbo.com");
assert.equal(parsedGuest!.subject, "Your reservation is confirmed");
assert.match(parsedGuest!.body, /reservation is confirmed/i);
assert.equal(parseEmailHeaders(sampleGuestEmailRaw)["x-simplelogin-envelope-to"], "cecilio.marquez@emailprivacy.com");
assert.match(extractBodyFromRawEmail(sampleGuestEmailRaw), /Townhome A/);
const webhookHeaders = headersFromInboundEmailPayload({
  to: "reservations@magicalislandvacations.com",
  headers: { "X-SimpleLogin-Envelope-To": "cecilio.marquez@emailprivacy.com" },
});
assert.equal(resolveGuestAliasEmail(webhookHeaders, "reservations@magicalislandvacations.com"), "cecilio.marquez@emailprivacy.com");
assert.ok(
  routesSource.includes("headersFromInboundEmailPayload") &&
    routesSource.includes("resolveGuestAliasEmail"),
  "inbound email webhook should resolve guest alias from SimpleLogin envelope headers",
);
assert.ok(
  readFileSync("server/index.ts", "utf8").includes("startGuestInboxSyncScheduler"),
  "server boot should start background guest inbox mailbox sync",
);
console.log("  ✓ guest inbox mailbox sync (SimpleLogin envelope headers + IMAP pull on fetch)");

// ── Guest inbox → buy-in arrival extraction ────────────────────────────────
const vrboArrivalSample = [
  "Property address: 2253 Poipu Rd, Unit B, Koloa, HI 96756",
  "Door code: 4821",
  "Gate code: 9912",
  "Elevator code: 4455",
  "Wi-Fi name: GuestNetwork",
  "Wi-Fi password: stay2026",
  "Parking: Stall #12 in the garage",
  "Check-in time: 4:00 PM",
].join("\n");
const parsedArrival = parseArrivalDetailsFromText(vrboArrivalSample);
assert.equal(parsedArrival.unitAddress, "2253 Poipu Rd, Unit B, Koloa, HI 96756");
assert.equal(parsedArrival.accessCode, "4821");
assert.match(parsedArrival.arrivalNotes ?? "", /Gate code: 9912/);
assert.match(parsedArrival.arrivalNotes ?? "", /Elevator code: 4455/);
assert.equal(parsedArrival.wifiName, "GuestNetwork");
assert.equal(parsedArrival.wifiPassword, "stay2026");
const mergedArrival = mergeArrivalDetailsIntoBuyIn(
  { unitAddress: "", accessCode: "", wifiName: "", wifiPassword: "", parkingInfo: "", arrivalNotes: "" },
  parsedArrival,
);
assert.equal(mergedArrival.unitAddress, parsedArrival.unitAddress);
assert.equal(mergedArrival.accessCode, "4821");
assert.ok(
  routesSource.includes("applyArrivalDetailsFromGuestInbox") &&
    routesSource.includes("guest-inbox-arrival") &&
    bookingsSource.includes("BuyInArrivalSummary") &&
    bookingsSource.includes("from VRBO email"),
  "guest inbox should extract arrival details and show them inline on the buy-in",
);
const htmlGlitchSample = 'Address: </span><span style="width:1.38pt">131 Continental Drive <br />Newark<br />DE 19702</span>';
const cleanedGlitch = stripHtmlForEmailParse(htmlGlitchSample);
assert.ok(!looksLikeHtmlGarbage(cleanedGlitch), "HTML glitch sample should strip to plain text");
assert.ok(isBlocklistedPropertyAddress("131 Continental Drive, Newark, DE 19702"), "Expedia HQ address should be blocklisted");
const parsedGlitch = parseArrivalDetailsFromText(htmlGlitchSample);
assert.equal(parsedGlitch.unitAddress, "", "blocklisted corporate address should not populate unitAddress");
const parsedSecureCode = parseArrivalDetailsFromText("Your secure code is 933195 - never share this code.");
assert.equal(parsedSecureCode.accessCode, "933195");
const paymentEmailSample = [
  "Billing address: 11920 Alterra Pkwy Austin, TX 78758",
  "Property address: 3830 Edward Rd 13C, Princeville, HI 96722",
].join("\n");
assert.equal(
  parseArrivalDetailsFromText(paymentEmailSample, {
    buyIn: { propertyName: "Townhome B", unitLabel: "Townhome B", notes: "Princeville Kauai" },
    communityState: "HI",
  }).unitAddress,
  "3830 Edward Rd 13C, Princeville, HI 96722",
);
assert.equal(
  pickBestPropertyAddressFromText(paymentEmailSample, { propertyName: "Townhome B", notes: "Princeville" }, "HI"),
  "3830 Edward Rd 13C, Princeville, HI 96722",
);
assert.ok(!isPlausiblePropertyAddressForBuyIn("11920 Alterra Pkwy Austin, TX 78758", { propertyName: "Townhome B", notes: "Princeville" }, "HI"));
assert.ok(
  routesSource.includes("isPlausiblePropertyAddressForBuyIn(saved, buyIn"),
  "walking-distance address guess should ignore untrusted saved unitAddress values",
);
console.log("  ✓ guest inbox arrival extraction (address, codes, Wi‑Fi → buy-in fields)");

// ── Operations guest messaging (Alternative Unit + Message AD) ─────────────
const adDraft = buildArrivalDetailsGuestMessage({
  guestFirstName: "Cecilio",
  propertyName: "Princeville Townhomes",
  checkInIso: "2026-06-20",
  units: [
    { unitLabel: "Townhome A", unitAddress: "3830 Edward Rd, Princeville, HI 96722", accessCode: "1234" },
    { unitLabel: "Townhome B", unitAddress: "3831 Edward Rd, Princeville, HI 96722", accessCode: "933195" },
  ],
});
assert.match(adDraft, /Townhome A/);
assert.match(adDraft, /Townhome B/);
assert.match(adDraft, /933195/);
assert.ok(
  bookingsSource.includes("Alternative Unit") &&
    bookingsSource.includes("Message AD") &&
    bookingsSource.includes("ArrivalDetailsMessageDialog") &&
    bookingsSource.includes("/arrival-details"),
  "Operations should offer Alternative Unit + Message AD arrival-details draft/send",
);
assert.ok(
  bookingsSource.includes("invalidateArrivalDetailsQueries") &&
    bookingsSource.includes('refetchOnMount: "always"') &&
    bookingsSource.includes("staleTime: 0"),
  "Message AD should refetch arrival details after manual edits (not serve stale Infinity cache)",
);
assert.ok(
  bookingsSource.includes("messageEditedRef") &&
    bookingsSource.includes("apiPostJsonWithTimeout") &&
    bookingsSource.includes("AbortController"),
  "Message AD send should not overwrite user edits and should time out instead of spinning forever",
);
const guestyOtaMessagingSource = readFileSync("server/guesty-ota-messaging.ts", "utf8");
assert.ok(
  routesSource.includes("guesty-ota-messaging") &&
    routesSource.includes("verified") &&
    routesSource.includes("deliveryModuleType") &&
    guestyOtaMessagingSource.includes("verifyOtaHostPostDelivered") &&
    guestyOtaMessagingSource.includes("buildOtaSendModuleAttempts"),
  "send-guest-message should verify OTA delivery via conversation posts, not trust Guesty HTTP 200 alone",
);
console.log("  ✓ Operations Alternative Unit + Message AD guest messaging");
