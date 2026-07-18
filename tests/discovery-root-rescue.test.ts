// Locks the find-unit sibling street-root rescue (shared/discovery-root-rescue.ts)
// + the Wavecrest curated address rule.
//
// Regression context (2026-07-18): the Wavecrest Resort (Molokai) replacement
// search died with "Google returned 213 listing link(s) … but all 182 were
// filtered out because they did not match the resort street (8001 kamehameha v
// hwy)". The draft carried the DIRECTORY address "8001 Kamehameha V Hwy" while
// every Zillow/Redfin/Realtor unit is indexed under the building addresses
// 7142/7144/7146/7148 Kamehameha V Hwy — and the Hawaii street-family tolerance
// only applies to district-lot pairs (69-180 style), so a plain-numbered street
// required an EXACT number match and the gate rejected everything. Fixes:
//   (1) curated CommunityAddressRule for Wavecrest (real building roots), and
//   (2) the general name-anchored sibling-root rescue, so any community whose
//       configured street NUMBER is wrong self-heals instead of striking out.
import {
  streetNameKeyFromRoot,
  communityAnchorPhrases,
  textNamesCommunity,
  learnSiblingStreetRootsFromRejects,
  type RejectedDiscoveryResult,
} from "../shared/discovery-root-rescue";
import { communityAddressRuleForName, validateCommunityStreetAddress } from "../shared/community-addresses";
import { streetRootFromListingAddress } from "../shared/listing-url-address";
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

// ---------------------------------------------------------------------------
// streetNameKeyFromRoot
// ---------------------------------------------------------------------------
console.log("streetNameKeyFromRoot:");
check("plain number root -> name+type", streetNameKeyFromRoot("8001 kamehameha v hwy") === "kamehameha v hwy");
check("Hawaii district-lot root strips BOTH numbers", streetNameKeyFromRoot("57 101 kuilima dr") === "kuilima dr");
check("null-safe", streetNameKeyFromRoot(null) === null);
check("all-numeric root -> null", streetNameKeyFromRoot("1234 5678") === null);

// ---------------------------------------------------------------------------
// communityAnchorPhrases + textNamesCommunity
// ---------------------------------------------------------------------------
console.log("community anchor phrases:");
{
  const phrases = communityAnchorPhrases(["Wavecrest Resort", "Wavecrest"], ["kamehameha v hwy"]);
  check("generic 'Resort' folded so bare portal titles anchor", phrases.includes("wavecrest"));
  check(
    "Zillow building-page title anchors",
    textNamesCommunity("Wavecrest - 7142 Kamehameha V Hwy Kaunakakai HI | Zillow", phrases),
  );
  check("unrelated title does not anchor", textNamesCommunity("Molokai Shores #A101 condo for sale", phrases) === false);
}
{
  // CONTIGUOUS-PHRASE rail: a snippet containing every TOKEN of the community
  // name scattered across street text + a different resort's name must NOT anchor.
  const phrases = communityAnchorPhrases(["Sunset Beach Villas"], ["palm ave"]);
  check(
    "token-scatter across a different resort + street text does NOT anchor",
    textNamesCommunity("Sunset Colony Villas condo near Sunset Beach Ave, great views", phrases) === false,
  );
  check(
    "contiguous community phrase DOES anchor",
    textNamesCommunity("Sunset Beach Villas #B203 - 200 Palm Ave condo for sale", phrases),
  );
}
{
  // A community name contained in the resort's own street name is a useless
  // anchor (every address would match) — it must be dropped entirely.
  const phrases = communityAnchorPhrases(["Kamehameha"], ["kamehameha v hwy"]);
  check("street-embedded community name yields NO anchor phrases", phrases.length === 0);
}

// ---------------------------------------------------------------------------
// learnSiblingStreetRootsFromRejects — the Wavecrest scenario, real URL parsing
// ---------------------------------------------------------------------------
console.log("learnSiblingStreetRootsFromRejects:");
const wavecrestNames = ["Wavecrest Resort", "Wavecrest"];
const wavecrestAllowed = new Set(["8001 kamehameha v hwy"]);
const wc = (link: string, contextText: string): RejectedDiscoveryResult => ({ link, source: "zillow", contextText });
const wavecrestRejects: RejectedDiscoveryResult[] = [
  wc(
    "https://www.zillow.com/homedetails/7142-Kamehameha-V-Hwy-APT-A308-Kaunakakai-HI-96748/1001_zpid/",
    "7142 Kamehameha V Hwy APT A308, Kaunakakai — Wavecrest condo for sale",
  ),
  wc(
    "https://www.zillow.com/homedetails/7142-Kamehameha-V-Hwy-APT-B306-Kaunakakai-HI-96748/1002_zpid/",
    "Wavecrest - 7142 Kamehameha V Hwy Kaunakakai HI | Zillow",
  ),
  {
    link: "https://www.redfin.com/HI/Kaunakakai/7146-Kamehameha-V-Hwy-96748/unit-C110/home/2001",
    source: "redfin",
    contextText: "7146 Kamehameha V Hwy Unit C110 — Wavecrest Resort oceanfront condo",
  },
  wc(
    "https://www.zillow.com/homedetails/7146-Kamehameha-V-Hwy-APT-B304-Kaunakakai-HI-96748/1003_zpid/",
    "Wavecrest #B304, 7146 Kamehameha V Hwy, Kaunakakai",
  ),
  // Noise rows that must not contaminate the learning:
  wc(
    "https://www.zillow.com/homedetails/1000-Kamehameha-V-Hwy-APT-201-Kaunakakai-HI-96748/1004_zpid/",
    "Molokai Shores #201 condo for sale", // same street, DIFFERENT community, no anchor
  ),
  wc(
    "https://www.zillow.com/homedetails/55-Ocean-Rd-Kaunakakai-HI-96748/1005_zpid/",
    "Wavecrest area home for sale", // anchored but DIFFERENT street name
  ),
];
{
  const rescue = learnSiblingStreetRootsFromRejects({
    communityNames: wavecrestNames,
    allowedRoots: wavecrestAllowed,
    rejects: wavecrestRejects,
  });
  check(
    "learns 7142 + 7146 kamehameha v hwy (recurring, community-named)",
    rescue.roots.length === 2
      && rescue.roots.includes("7142 kamehameha v hwy")
      && rescue.roots.includes("7146 kamehameha v hwy"),
    rescue,
  );
  check("same-street different-community (Molokai Shores 1000) NOT learned", !rescue.roots.includes("1000 kamehameha v hwy"), rescue);
  check("street-jump (55 Ocean Rd) NOT learned even with anchor", !rescue.roots.includes("55 ocean rd"), rescue);
}
{
  // Recurrence floor: one distinct listing is not enough; the same URL twice is
  // still ONE distinct listing.
  const single = learnSiblingStreetRootsFromRejects({
    communityNames: wavecrestNames,
    allowedRoots: wavecrestAllowed,
    rejects: [wavecrestRejects[0]],
  });
  check("single distinct listing does not learn a root", single.roots.length === 0, single);
  const dupSame = learnSiblingStreetRootsFromRejects({
    communityNames: wavecrestNames,
    allowedRoots: wavecrestAllowed,
    rejects: [
      wavecrestRejects[0],
      { ...wavecrestRejects[0], link: wavecrestRejects[0].link.replace("https://www.", "http://") + "?utm=1" },
    ],
  });
  check("same listing twice (scheme/query variants) still counts once", dupSame.roots.length === 0, dupSame);
}
{
  // Name anchor is required even when the street name matches.
  const unanchored = learnSiblingStreetRootsFromRejects({
    communityNames: wavecrestNames,
    allowedRoots: wavecrestAllowed,
    rejects: wavecrestRejects.map((r) => ({ ...r, contextText: "Beautiful oceanfront condo for sale" })),
  });
  check("no community anchor -> nothing learned", unanchored.roots.length === 0, unanchored);
}
{
  // Lot-significant streets (HAWAII_STREETS_WITH_DISTINCT_RESORTS_BY_LOT) are
  // excluded wholesale: on Waikoloa Beach Dr the lot number IS the resort
  // identity (69-180 Beach Villas vs 69-555 Colony Villas), so a number-differs
  // sibling must never be auto-learned — even with a perfect name anchor.
  const lotSignificant = learnSiblingStreetRootsFromRejects({
    communityNames: ["Waikoloa Beach Villas"],
    allowedRoots: new Set(["69 180 waikoloa beach dr"]),
    rejects: [
      wc(
        "https://www.zillow.com/homedetails/69-555-Waikoloa-Beach-Dr-APT-1502-Waikoloa-HI-96738/3001_zpid/",
        "Waikoloa Beach Villas style condo at 69-555 Waikoloa Beach Dr",
      ),
      wc(
        "https://www.zillow.com/homedetails/69-555-Waikoloa-Beach-Dr-APT-2201-Waikoloa-HI-96738/3002_zpid/",
        "Waikoloa Beach Villas resort living — 69-555 Waikoloa Beach Dr #2201",
      ),
    ],
  });
  check("lot-significant street learns NOTHING", lotSignificant.roots.length === 0, lotSignificant);
}
{
  // Roots already allowed are never re-learned.
  const already = learnSiblingStreetRootsFromRejects({
    communityNames: wavecrestNames,
    allowedRoots: new Set(["7142 kamehameha v hwy"]),
    rejects: [wavecrestRejects[0], wavecrestRejects[1]],
  });
  check("already-allowed root is not re-learned", already.roots.length === 0, already);
}

// ---------------------------------------------------------------------------
// Wavecrest curated rule (shared/community-addresses.ts)
// ---------------------------------------------------------------------------
console.log("Wavecrest curated address rule:");
{
  const rule = communityAddressRuleForName("Wavecrest Resort");
  check("rule exists for 'Wavecrest Resort'", rule != null);
  check("canonical street = 7142 Kamehameha V Hwy (Zillow building address, NOT the 8001 directory address)", rule?.street === "7142 Kamehameha V Hwy");
  check("city = Kaunakakai", rule?.city === "Kaunakakai");
  const roots = (rule?.buildingStreetRoots ?? []).map((r) => streetRootFromListingAddress(r));
  check(
    "buildingStreetRoots cover 7142/7144/7146/7148 and all parse to roots",
    ["7142", "7144", "7146", "7148"].every((n) => roots.includes(`${n} kamehameha v hwy`)),
    roots,
  );
  check("alias 'Wavecrest' resolves the same rule", communityAddressRuleForName("Wavecrest")?.street === "7142 Kamehameha V Hwy");
  const validation = validateCommunityStreetAddress({
    communityName: "Wavecrest Resort",
    city: "Kaunakakai",
    state: "HI",
    streetAddress: "8001 Kamehameha V Hwy",
  });
  check(
    "validate rejects the stale 8001 street and offers the curated 7142 fix",
    validation.ok === false && (validation as { expectedStreet?: string }).expectedStreet === "7142 Kamehameha V Hwy",
    validation,
  );
}

// ---------------------------------------------------------------------------
// Source guards: the rescue must stay WIRED into the find-unit discovery flow.
// ---------------------------------------------------------------------------
console.log("routes.ts wiring source guards:");
{
  // Relative to repo root — the npm test chain runs `tsx tests/...` from there
  // (same convention as tests/pipeline-logic.test.ts).
  const routesSrc = readFileSync("server/routes.ts", "utf8");
  check(
    "root-gate rejections are recorded for the rescue",
    routesSrc.includes("rejectedRootGateResults.push({ link, source, contextText, thumbnail })"),
  );
  check(
    "rescue fires only on a TOTAL gate strikeout (zero admissions)",
    routesSrc.includes("rootGateAdmissions === 0"),
  );
  check(
    "rescue calls the shared learner",
    routesSrc.includes("learnSiblingStreetRootsFromRejects({"),
  );
  check(
    "learned roots widen the community root set (feeds second-wave root queries + Apify/RealtyAPI legs)",
    routesSrc.includes("communityAddressRoots.add(root)"),
  );
  check(
    "rejected results are REPLAYED through the widened gate",
    /const replay = rejectedRootGateResults\.splice\(0, rejectedRootGateResults\.length\);/.test(routesSrc),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
