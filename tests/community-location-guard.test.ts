// Locks the community location guard that keeps a resort from being attached to
// the wrong state in the Top Markets Sweep and the Add-a-Community wizard.
//
// Reported case (2026-06-22): "Bay Watch" is a North Myrtle Beach, SOUTH
// CAROLINA resort but kept surfacing under FLORIDA (and was saved as a Florida
// community draft, property 900039). The guard drops/rejects KNOWN
// mis-locations while leaving every legitimate (unknown) community untouched.
import {
  checkCommunityState,
  isCommunityInWrongState,
  communityHomeState,
  canonicalStateName,
  statesEquivalent,
  normalizeCommunityLocationKey,
  COMMUNITY_HOME_STATE,
} from "../shared/community-location-guard";
import {
  filterTopScanComboCandidates,
  knownComboSeedsForCity,
  knownSingleListingSeedsForCity,
  TOP_MARKET_SEEDS,
} from "../server/community-research";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("community-location-guard: wrong-state detection + sweep filtering");

// ── State canonicalization ──────────────────────────────────────────────────
check("canonicalStateName abbrev → full", canonicalStateName("fl") === "Florida");
check("canonicalStateName full passthrough", canonicalStateName("Florida") === "Florida");
check("canonicalStateName case-insensitive full", canonicalStateName("south carolina") === "South Carolina");
check("canonicalStateName blank → ''", canonicalStateName("") === "" && canonicalStateName(null) === "");
check("statesEquivalent FL == Florida", statesEquivalent("FL", "Florida"));
check("statesEquivalent SC != FL", !statesEquivalent("SC", "Florida"));
check("statesEquivalent blank never equal", !statesEquivalent("", ""));

// ── Name normalization ──────────────────────────────────────────────────────
check("normalize strips trailing 'Resort'", normalizeCommunityLocationKey("Bay Watch Resort") === "bay watch");
check("normalize strips leading 'The' + punctuation", normalizeCommunityLocationKey("The Bay-Watch Condos") === "bay watch");
check("normalize blank", normalizeCommunityLocationKey("") === "" && normalizeCommunityLocationKey(null) === "");

// ── communityHomeState ──────────────────────────────────────────────────────
check("Bay Watch home state = South Carolina", communityHomeState("Bay Watch") === "South Carolina");
check("Bay Watch Resort variant resolves", communityHomeState("Bay Watch Resort") === "South Carolina");
check("unknown community → null home state", communityHomeState("Santa Maria Resort") === null);

// ── checkCommunityState / isCommunityInWrongState ───────────────────────────
check("Bay Watch in Florida is WRONG", isCommunityInWrongState("Bay Watch", "Florida"));
check("Bay Watch (Resort) in FL abbrev is WRONG", isCommunityInWrongState("Bay Watch Resort", "FL"));
check("Bay Watch in South Carolina is OK", !isCommunityInWrongState("Bay Watch", "South Carolina"));
check("Bay Watch in SC abbrev is OK", !isCommunityInWrongState("Bay Watch", "SC"));
check("unknown community is never wrong (recall-safe)", !isCommunityInWrongState("Santa Maria Resort", "Florida"));
check("blank name is never wrong", !isCommunityInWrongState("", "Florida"));
check("blank claimed state is never wrong", !isCommunityInWrongState("Bay Watch", ""));

const verdict = checkCommunityState("Bay Watch", "Florida");
check("verdict surfaces home state for operator message", verdict.wrong && verdict.homeState === "South Carolina", verdict);

// ── filterTopScanComboCandidates drops the wrong-state community ─────────────
// Minimal communities that otherwise PASS the combo-candidate filter (condo
// type + a 2BR/3BR mix → a 4BR/5BR combo), so the ONLY thing that can remove
// them is the location guard.
const comboShape = { unitTypes: "condos", researchSummary: "individually owned condo resort", availableBedrooms: [2, 3] };
const flBayWatch = { name: "Bay Watch", city: "Destin", state: "Florida", ...comboShape };
const scBayWatch = { name: "Bay Watch", city: "Myrtle Beach", state: "South Carolina", ...comboShape };
const flSantaMaria = { name: "Santa Maria Resort", city: "Fort Myers Beach", state: "Florida", ...comboShape };

const filtered = filterTopScanComboCandidates([flBayWatch, scBayWatch, flSantaMaria] as any[]);
const filteredNames = filtered.map((c: any) => `${c.name}|${c.state}`);
check("sweep filter DROPS Bay Watch under Florida", !filteredNames.includes("Bay Watch|Florida"), filteredNames);
check("sweep filter KEEPS Bay Watch under South Carolina", filteredNames.includes("Bay Watch|South Carolina"), filteredNames);
check("sweep filter KEEPS a legitimate Florida community", filteredNames.includes("Santa Maria Resort|Florida"), filteredNames);

// ── Audit EVERY curated community in EVERY top market ────────────────────────
// "Check every single community being listed/researched": no curated combo seed
// may be attached to a state it does not belong to. This fails loudly if a
// future seed addition collides with a COMMUNITY_HOME_STATE entry.
const wrongStateSeeds: string[] = [];
let auditedSeeds = 0;
for (const market of TOP_MARKET_SEEDS) {
  // Both curated seed registries — combo (sweep) AND single-listing — must be
  // audited, since both are injected into researchCommunitiesForCity results.
  const seeds = [
    ...knownComboSeedsForCity(market.city, market.state),
    ...knownSingleListingSeedsForCity(market.city, market.state),
  ];
  for (const seed of seeds) {
    auditedSeeds++;
    if (isCommunityInWrongState(seed.name, seed.state)) {
      wrongStateSeeds.push(`${seed.name} @ ${market.city}, ${market.state}`);
    }
  }
}
check(
  `all ${auditedSeeds} curated combo + single-listing seeds across ${TOP_MARKET_SEEDS.length} markets are in the right state`,
  wrongStateSeeds.length === 0,
  wrongStateSeeds,
);

// Registry sanity: every value is a canonical full state name.
const badRegistryValues = Object.entries(COMMUNITY_HOME_STATE).filter(
  ([, state]) => canonicalStateName(state) !== state,
);
check("COMMUNITY_HOME_STATE values are canonical full state names", badRegistryValues.length === 0, badRegistryValues);

console.log(`\ncommunity-location-guard: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
