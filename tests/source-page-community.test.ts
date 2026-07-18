import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  extractLastJsonObject,
  extractSourcePageSignals,
  looksLikeBotWallPage,
  signalsAreEmpty,
  signalsFromListingJson,
  buildSourcePageCommunityPrompt,
  parseSourcePageVerdict,
  sourcePageIsStrongContradiction,
  sourceCommunityNamesMatch,
  summarizeSourcePages,
  type SourcePageVerdict,
} from "../shared/source-page-community-logic";
import { verifyUnitSourcePages } from "../server/source-page-community-check";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import {
  evaluateComboPhotoCommunityGate,
  planComboBedroomRetry,
  type ComboPhotoGateInput,
} from "../shared/combo-photo-community-gate";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("source-page-community: extraction");

const HTML = `
<html><head>
<title>123 Kiahuna Plantation Dr #45, Koloa, HI 96756 | Redfin</title>
<meta name="description" content="Beautiful condo at Kiahuna Plantation in Koloa, Kauai." />
<meta property="og:title" content="Kiahuna Plantation Condo #45" />
<meta property="og:description" content="Poipu-area resort living" />
<script type="application/ld+json">
{"@type":"Residence","address":{"streetAddress":"123 Kiahuna Plantation Dr","addressLocality":"Koloa","addressRegion":"HI","postalCode":"96756"}}
</script>
</head><body>
<h1>Kiahuna Plantation Unit 45</h1>
<p>Located in the Kiahuna Plantation resort in Koloa on Kauai's south shore.</p>
<script>var x = 1;</script>
</body></html>`;

const sig = extractSourcePageSignals(HTML);
check("title extracted", /Kiahuna Plantation/.test(sig.title ?? ""));
check("meta description extracted", /Koloa, Kauai/.test(sig.metaDescription ?? ""));
check("og:title extracted", sig.ogTitle === "Kiahuna Plantation Condo #45");
check("JSON-LD street address extracted", sig.addressHints.includes("123 Kiahuna Plantation Dr"));
check("JSON-LD locality extracted", sig.addressHints.includes("Koloa"));
check("heading extracted", sig.headings.some((h) => /Unit 45/.test(h)));
check("snippet strips script/tags", !!sig.snippet && !/var x = 1/.test(sig.snippet) && /south shore/.test(sig.snippet));
check("non-empty signals", !signalsAreEmpty(sig));

check("empty html → empty signals", signalsAreEmpty(extractSourcePageSignals("<html></html>")));
check("garbage input does not throw", (() => { extractSourcePageSignals(undefined as any); return true; })());

// CodeQL regressions: &amp; decoded last (no double-unescape), and whitespace/attr
// tolerant script stripping.
const ampSig = extractSourcePageSignals('<title>A &amp;#39; B &amp; C</title>');
check("&amp; is not double-unescaped", ampSig.title === "A &#39; B & C");
const spacedScript = extractSourcePageSignals('<body>keep<script type="x">DROP</script >more</body>');
check("strips script with spaced/attr end tag", !!spacedScript.snippet && !/DROP/.test(spacedScript.snippet) && /keep/.test(spacedScript.snippet) && /more/.test(spacedScript.snippet));
const junkEndScript = extractSourcePageSignals('<body>keep<script>DROP</script\t\n bar>more</body>');
check("strips script with junk end tag", !!junkEndScript.snippet && !/DROP/.test(junkEndScript.snippet) && /keep/.test(junkEndScript.snippet) && /more/.test(junkEndScript.snippet));

console.log("source-page-community: bot-wall detection");
const PX_WALL = `
<html><head><title>Access to this page has been denied</title></head>
<body><div id="px-captcha"></div><p>Press &amp; Hold to confirm you are a human (and not a bot).</p></body></html>`;
check("PerimeterX wall page detected", looksLikeBotWallPage(PX_WALL));
check("Imperva wall title detected", looksLikeBotWallPage("<html><head><title>Pardon Our Interruption</title></head><body></body></html>"));
check("real listing page is NOT a wall", !looksLikeBotWallPage(HTML));
const bigPageWithCf = `<html><head><title>123 Kiahuna Plantation Dr | Zillow</title></head><body>${"listing text ".repeat(400)}<script>var cdn="cloudflare"; var x="perimeterx-sdk";</script></body></html>`;
check("big real page mentioning vendors in scripts is NOT a wall", !looksLikeBotWallPage(bigPageWithCf));
check("empty/garbage input does not throw", (() => { looksLikeBotWallPage(""); looksLikeBotWallPage(undefined as any); return true; })());

console.log("source-page-community: signals from Apify listing JSON");
const zillowItem = {
  address: { streetAddress: "2611 Kiahuna Plantation Dr", city: "Koloa", state: "HI", zipcode: "96756" },
  abbreviatedAddress: "2611 Kiahuna Plantation Dr APT 12",
  description: "Beautiful ground-floor condo inside the Kiahuna Plantation resort on Kauai's sunny south shore, steps from Poipu Beach.",
  bedrooms: 2,
  similarHomes: [{ address: { streetAddress: "1 Wailea Beach Villas Blvd", city: "Wailea", state: "HI" } }],
  photos: [{ url: "https://photos.zillowstatic.com/x.jpg" }],
};
const jsonSig = signalsFromListingJson(zillowItem);
check("street address extracted from item", jsonSig.addressHints.includes("2611 Kiahuna Plantation Dr"));
check("city extracted from item", jsonSig.addressHints.includes("Koloa"));
check("state extracted from item", jsonSig.addressHints.includes("HI"));
check("description carried as signal", /Kiahuna Plantation resort/.test(jsonSig.metaDescription ?? ""));
check("title derived from item", /Kiahuna Plantation Dr/.test(jsonSig.title ?? ""));
check("similarHomes subtree skipped (no Wailea contamination)",
  !jsonSig.addressHints.some((h) => /Wailea/.test(h)));
check("item signals are non-empty", !signalsAreEmpty(jsonSig));
check("string address form accepted", signalsFromListingJson({ address: "100 Poipu Rd, Koloa, HI" }).addressHints.includes("100 Poipu Rd, Koloa, HI"));
check("empty item → empty signals", signalsAreEmpty(signalsFromListingJson({})));
check("garbage item does not throw", (() => { signalsFromListingJson(null); signalsFromListingJson("x"); return true; })());

console.log("source-page-community: prompt");
const prompt = buildSourcePageCommunityPrompt("Kiahuna Plantation", "Unit A (2BR)", sig);
check("prompt names expected community", prompt.includes("Kiahuna Plantation"));
check("prompt names the unit", prompt.includes("Unit A (2BR)"));
check("prompt includes address signals", prompt.includes("Koloa"));
check("prompt asks for minified JSON", prompt.includes('"match":"yes|no|uncertain"'));
// The slot label ("Unit A") must be declared NOT-a-unit-number — live smoke
// showed the model answering "no" for a matching community because the page's
// "Unit B310" differed from our "Unit A" slot label.
check("prompt marks the unit label as an internal slot name", prompt.includes("internal slot label"));

console.log("source-page-community: extractLastJsonObject");
// The exact live pattern: JSON verdict → reconsider-aloud prose → corrected JSON.
const twoObjects = `{"match":"no","identifiedCommunity":"Wavecrest Resort","reason":"unit differs"}

Wait, re-reading the rules: the community IS Wavecrest Resort. The unit number difference doesn't make it a different community.

{"match":"yes","identifiedCommunity":"Wavecrest Resort","confidence":0.95,"reason":"Community matches."}`;
const lastObj = extractLastJsonObject(twoObjects);
check("two-objects-with-prose → LAST object wins", lastObj?.match === "yes" && lastObj?.confidence === 0.95);
check("single object parses", extractLastJsonObject('x {"a":1} y')?.a === 1);
check("braces inside strings do not break the scan",
  extractLastJsonObject('{"reason":"has a } and { inside","ok":true}')?.ok === true);
check("no JSON → null", extractLastJsonObject("no braces here") === null);
check("truncated JSON → null", extractLastJsonObject('{"match":"yes","reason":"cut off') === null);
check("garbage input does not throw", (() => { extractLastJsonObject(undefined as any); extractLastJsonObject(""); return true; })());

console.log("source-page-community: parse verdict");
const yesV = parseSourcePageVerdict(
  { match: "yes", identifiedCommunity: "Kiahuna Plantation", identifiedLocation: "Koloa, HI", confidence: 0.9, reason: "Names Kiahuna." },
  "Unit A", "https://redfin.com/x", "Kiahuna Plantation",
);
check("parse yes", yesV.match === "yes" && yesV.confidence === 0.9);

const noV = parseSourcePageVerdict(
  { match: "no", identifiedCommunity: "Wailea Beach Villas", identifiedLocation: "Wailea, HI", confidence: 0.8, reason: "Different resort." },
  "Unit B", "https://redfin.com/y", "Kiahuna Plantation",
);
check("parse no", noV.match === "no");

const selfContra = parseSourcePageVerdict(
  { match: "no", identifiedCommunity: "Kiahuna Plantation Resort", confidence: 0.7, reason: "..." },
  "Unit C", "https://x", "Kiahuna Plantation",
);
check("self-contradicting no → yes", selfContra.match === "yes");

const clamp = parseSourcePageVerdict({ match: "maybe", confidence: 5 }, "U", "https://x", "X");
check("unknown match → uncertain", clamp.match === "uncertain");
check("confidence clamped to 1", clamp.confidence === 1);

check("name match tolerant", sourceCommunityNamesMatch("Kiahuna Plantation", "kiahuna plantation resort"));
check("name match rejects unrelated", !sourceCommunityNamesMatch("Kiahuna", "Wailea Beach Villas"));

console.log("source-page-community: strong contradiction");
check("named no with confidence → strong", sourcePageIsStrongContradiction(noV));
check("uncertain → not strong", !sourcePageIsStrongContradiction(yesV));
check("unreadable no → not strong", !sourcePageIsStrongContradiction({ ...noV, unreadable: true }));
check("no without named place → not strong",
  !sourcePageIsStrongContradiction({ unitLabel: "U", url: "x", match: "no", reason: "unclear" }));
check("low-confidence no → not strong",
  !sourcePageIsStrongContradiction({ ...noV, confidence: 0.3 }));

console.log("source-page-community: summarize");
const rollAllYes = summarizeSourcePages([yesV, { ...yesV, unitLabel: "Unit B" }]);
check("all yes → overall yes", rollAllYes.overall === "yes" && rollAllYes.matched === 2);
const rollContra = summarizeSourcePages([yesV, noV]);
check("any contradiction → overall no", rollContra.overall === "no" && rollContra.contradicted === 1);
check("empty → n/a", summarizeSourcePages([]).overall === "n/a");

console.log("source-page-community: verifyUnitSourcePages (fail-soft, offline)");
(async () => {
  // No URL → uncertain + unreadable, no fetch/Claude.
  const noUrl = await verifyUnitSourcePages([{ label: "Unit A" }], "Kiahuna Plantation", "", async () => "should-not-be-called");
  check("no-URL unit is skipped from results", noUrl.length === 0);

  // Fetch returns null AND the Apify rescue has nothing → unreadable uncertain.
  const nullFetch = await verifyUnitSourcePages(
    [{ label: "Unit A", sourceUrl: "https://redfin.com/x" }],
    "Kiahuna Plantation",
    "",
    async () => null,
    async () => null,
  );
  check("null fetch + null rescue → uncertain unreadable", nullFetch[0].match === "uncertain" && nullFetch[0].unreadable === true);

  // Guesty URL → unreadable without any fetch (and no rescue attempt).
  let fetched = false;
  let guestyRescued = false;
  const guesty = await verifyUnitSourcePages(
    [{ label: "Unit A", sourceUrl: "https://app.guesty.com/properties/abc/property/v2" }],
    "Kiahuna Plantation",
    "",
    async () => { fetched = true; return "x"; },
    async () => { guestyRescued = true; return null; },
  );
  check("guesty URL → unreadable, no fetch, no rescue", guesty[0].unreadable === true && fetched === false && guestyRescued === false);

  // Readable page, no ANTHROPIC key → uncertain (analysis unavailable), never throws —
  // and the rescue is NOT consulted when the direct fetch already produced signals.
  let readableRescued = false;
  const readable = await verifyUnitSourcePages(
    [{ label: "Unit A", sourceUrl: "https://redfin.com/x" }],
    "Kiahuna Plantation",
    "",
    async () => HTML,
    async () => { readableRescued = true; return null; },
  );
  check("readable + no key → uncertain (no throw)", readable[0].match === "uncertain" && readable[0].unreadable !== true);
  check("readable page skips the Apify rescue", readableRescued === false);

  console.log("source-page-community: Apify rescue tier");
  // Direct fetch blocked (403 → null) but the Apify rescue returns real signals →
  // the check proceeds to analysis (no key here, so "analysis unavailable") and is
  // NOT flagged unreadable — the exact class of the "Page unreadable" incident.
  const rescuedVerdicts = await verifyUnitSourcePages(
    [{ label: "Unit A (2BR)", sourceUrl: "https://www.zillow.com/homedetails/x/123_zpid/" }],
    "Kiahuna Plantation",
    "",
    async () => null,
    async () => jsonSig,
  );
  check("blocked fetch + Apify signals → NOT unreadable", rescuedVerdicts[0].unreadable !== true);
  check("blocked fetch + Apify signals → reached analysis", /analysis unavailable/i.test(rescuedVerdicts[0].reason));

  // A 200-with-bot-wall page must ALSO fall through to the rescue — the wall's
  // "Access denied" title must never be sent to Claude as listing signals.
  let wallRescueCalls = 0;
  const wallVerdicts = await verifyUnitSourcePages(
    [{ label: "Unit A", sourceUrl: "https://www.zillow.com/homedetails/x/123_zpid/" }],
    "Kiahuna Plantation",
    "",
    async () => PX_WALL,
    async () => { wallRescueCalls++; return null; },
  );
  check("bot-wall 200 page triggers the rescue", wallRescueCalls === 1);
  check("bot-wall 200 page + null rescue → unreadable", wallVerdicts[0].unreadable === true);

  // SOURCE GUARDS: the engine must keep the Apify rescue as the default rescue
  // seam and the bot-wall screen on the direct fetch — simplifying either back
  // out silently reintroduces the "Page unreadable" class for every Zillow URL.
  const engineSource = readFileSync(path.join(__dirname, "..", "server", "source-page-community-check.ts"), "utf8");
  check("engine defaults rescue to fetchSourcePageSignalsViaApify",
    engineSource.includes("= fetchSourcePageSignalsViaApify"));
  check("engine screens direct fetches through looksLikeBotWallPage",
    engineSource.includes("looksLikeBotWallPage(html)"));
  check("engine maps zillow/redfin/realtor hosts to Apify actors",
    engineSource.includes("zillow.com") && engineSource.includes("redfin.com") && engineSource.includes("realtor.com"));
  check("engine honors the SOURCE_PAGE_APIFY_RESCUE kill switch",
    engineSource.includes('SOURCE_PAGE_APIFY_RESCUE === "0"'));
  check("engine retries once on a JSON parse failure",
    /parse JSON/.test(engineSource) && engineSource.includes("await callOnce()"));
  check("engine salvages the LAST JSON object before failing a parse",
    engineSource.includes("extractLastJsonObject(res.raw)"));

  console.log("source-page-community: combo gate leg");
  const base: ComboPhotoGateInput = {
    expectedCommunity: "Kiahuna Plantation",
    warning: undefined,
    community: { matchesExpected: "yes", overallStatus: "verified", identifiedCommunity: "Kiahuna Plantation" },
    units: [
      { label: "Unit A", sameAsCommunity: "yes", reason: "12/12 match." },
      { label: "Unit B", sameAsCommunity: "yes", reason: "10/10 match." },
    ],
    bedroomCoverage: {
      tier: "pass",
      units: [
        { label: "Unit A", matchesListing: "yes", bedroomsFound: 2, expectedBedrooms: 2 },
        { label: "Unit B", matchesListing: "yes", bedroomsFound: 2, expectedBedrooms: 2 },
      ],
    },
  };

  const cleanNoSources = evaluateComboPhotoCommunityGate(base);
  check("gate: no sourcePages → publish", cleanNoSources.decision === "publish");

  const cleanSources = evaluateComboPhotoCommunityGate({ ...base, sourcePages: [yesV, { ...yesV, unitLabel: "Unit B" }] });
  check("gate: all source pages confirm → publish", cleanSources.decision === "publish");

  const contraSources = evaluateComboPhotoCommunityGate({ ...base, sourcePages: [{ ...noV, unitLabel: "Unit B" }] });
  check("gate: source page different community → skip", contraSources.decision === "skip"
    && contraSources.reasons.some((r) => /source page is/.test(r)));

  const unreadableSources = evaluateComboPhotoCommunityGate({
    ...base,
    sourcePages: [{ unitLabel: "Unit A", url: "x", match: "uncertain", reason: "blocked", unreadable: true }],
  });
  check("gate: unreadable source → publish (fail-open)", unreadableSources.decision === "publish");

  // Retry plan: a bedroom-short unit alongside a source contradiction is NOT retryable.
  const bedroomShort: ComboPhotoGateInput = {
    ...base,
    bedroomCoverage: {
      tier: "fail",
      units: [
        { label: "Unit A", matchesListing: "no", bedroomsFound: 0, expectedBedrooms: 3 },
        { label: "Unit B", matchesListing: "yes", bedroomsFound: 2, expectedBedrooms: 2 },
      ],
    },
  };
  check("retry: bedroom-only short → retryable", planComboBedroomRetry(bedroomShort).retryable === true);
  const shortPlusContra = planComboBedroomRetry({ ...bedroomShort, sourcePages: [{ ...noV, unitLabel: "Unit A" }] });
  check("retry: source contradiction blocks bedroom retry", shortPlusContra.retryable === false);

  console.log(`\nsource-page-community: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
