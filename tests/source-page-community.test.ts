import assert from "node:assert/strict";
import {
  extractSourcePageSignals,
  signalsAreEmpty,
  buildSourcePageCommunityPrompt,
  parseSourcePageVerdict,
  sourcePageIsStrongContradiction,
  sourceCommunityNamesMatch,
  summarizeSourcePages,
  type SourcePageVerdict,
} from "../shared/source-page-community-logic";
import { verifyUnitSourcePages } from "../server/source-page-community-check";
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

console.log("source-page-community: prompt");
const prompt = buildSourcePageCommunityPrompt("Kiahuna Plantation", "Unit A (2BR)", sig);
check("prompt names expected community", prompt.includes("Kiahuna Plantation"));
check("prompt names the unit", prompt.includes("Unit A (2BR)"));
check("prompt includes address signals", prompt.includes("Koloa"));
check("prompt asks for minified JSON", prompt.includes('"match":"yes|no|uncertain"'));

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

  // Fetch returns null → unreadable uncertain.
  const nullFetch = await verifyUnitSourcePages(
    [{ label: "Unit A", sourceUrl: "https://redfin.com/x" }],
    "Kiahuna Plantation",
    "",
    async () => null,
  );
  check("null fetch → uncertain unreadable", nullFetch[0].match === "uncertain" && nullFetch[0].unreadable === true);

  // Guesty URL → unreadable without any fetch.
  let fetched = false;
  const guesty = await verifyUnitSourcePages(
    [{ label: "Unit A", sourceUrl: "https://app.guesty.com/properties/abc/property/v2" }],
    "Kiahuna Plantation",
    "",
    async () => { fetched = true; return "x"; },
  );
  check("guesty URL → unreadable, no fetch", guesty[0].unreadable === true && fetched === false);

  // Readable page, no ANTHROPIC key → uncertain (analysis unavailable), never throws.
  const readable = await verifyUnitSourcePages(
    [{ label: "Unit A", sourceUrl: "https://redfin.com/x" }],
    "Kiahuna Plantation",
    "",
    async () => HTML,
  );
  check("readable + no key → uncertain (no throw)", readable[0].match === "uncertain" && readable[0].unreadable !== true);

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
