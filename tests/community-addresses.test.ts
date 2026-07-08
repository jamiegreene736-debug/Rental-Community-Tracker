// Locks the curated street addresses that let the bulk combo listing queue SAVE
// a draft (validateCommunityStreetAddress hard-rejects without a real numbered
// street). These three Wailea/Maui resorts were missing and failed the queue's
// save step until added; this guards against regressing them.
import {
  validateCommunityStreetAddress,
  inferCommunityStreetAddress,
  resolveBulkComboListingStreet,
  communityAddressRuleForName,
  discoverySearchCitiesForPhotoSearch,
  streetRootFromAddress,
  isLikelyStreetAddress,
  normalizeCommunityAddressToken,
} from "../shared/community-addresses";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("community-addresses: curated resort street resolution");

const CASES: Array<{ name: string; city: string; street: string }> = [
  { name: "Wailea Elua Village", city: "Wailea", street: "3600 Wailea Alanui Dr" },
  { name: "Wailea Ekahi Village", city: "Kihei", street: "3300 Wailea Alanui Dr" },
  { name: "Grand Champions Villas", city: "Wailea", street: "155 Wailea Ike Pl" },
  { name: "Honua Kai Resort", city: "Lahaina", street: "130 Kai Malina Pkwy" }, // pre-existing control
];

for (const c of CASES) {
  const inferred = inferCommunityStreetAddress({ communityName: c.name, city: c.city, state: "HI" });
  check(`${c.name} resolves to a curated street`, inferred === c.street, inferred);

  // The bulk queue resolves with NO operator-supplied street (the failing case).
  const resolved = resolveBulkComboListingStreet({ communityName: c.name, city: c.city, state: "HI", streetAddress: "" });
  check(`${c.name} resolves with empty streetAddress (the queue path)`, resolved === c.street, resolved);

  const verdict = validateCommunityStreetAddress({ communityName: c.name, city: c.city, state: "HI", streetAddress: resolved });
  check(`${c.name} passes save-step validation`, verdict.ok === true, verdict);

  // City alias (Kihei <-> Wailea) is accepted for the Wailea resorts.
  if (c.name.startsWith("Wailea") || c.name.startsWith("Grand")) {
    const altCity = c.city === "Wailea" ? "Kihei" : "Wailea";
    const aliasVerdict = validateCommunityStreetAddress({ communityName: c.name, city: altCity, state: "HI", streetAddress: resolved });
    check(`${c.name} accepts city alias "${altCity}"`, aliasVerdict.ok === true, aliasVerdict);
  }
}

// A community with no curated rule + no real street still fails fast (the precheck relies on this).
const noAddr = validateCommunityStreetAddress({ communityName: "Some Unknown Resort", city: "Kihei", state: "HI", streetAddress: "" });
check("unknown community with no street → validation fails", noAddr.ok === false, noAddr);

// Bare "Grand Champions" still resolves (matches the longer rule name) ...
check('bare "Grand Champions" still resolves to 155 Wailea Ike Pl',
  inferCommunityStreetAddress({ communityName: "Grand Champions", city: "Wailea", state: "HI" }) === "155 Wailea Ike Pl",
  inferCommunityStreetAddress({ communityName: "Grand Champions", city: "Wailea", state: "HI" }));

// ... but a DIFFERENT community sharing the substring must NOT inherit Wailea's address
// (the bare "Grand Champions" name variant was dropped to avoid this false positive).
for (const stranger of ["Grand Champions Spa", "Grand Champions Pool Club"]) {
  const inferred = inferCommunityStreetAddress({ communityName: stranger, city: "Orlando", state: "FL" });
  check(`"${stranger}" does NOT falsely resolve to the Wailea address`, inferred !== "155 Wailea Ike Pl", inferred);
}

// ── Word-boundary fuzzy-match guard ───────────────────────────────────────────
// "Alii Kai" (Princeville, Kauai) must NOT inherit the "Halii Kai" rule (Waikoloa,
// Big Island) just because "alii kai" is a raw substring of "halii kai". A live
// 2026-06-17 sweep saved a Kauai Alii Kai combo against the Big-Island address
// before this was fixed.
const aliiKaiRule = communityAddressRuleForName("Alii Kai");
check('"Alii Kai" does NOT match the Halii Kai rule',
  !(aliiKaiRule && aliiKaiRule.names.some((n) => /halii/i.test(n))),
  aliiKaiRule?.street);
check('"Alii Kai Resort" does NOT match the Halii Kai rule',
  !(() => { const r = communityAddressRuleForName("Alii Kai Resort"); return r && r.names.some((n) => /halii/i.test(n)); })(),
  communityAddressRuleForName("Alii Kai Resort")?.street);
// Halii Kai itself must still resolve to its curated rule.
check('"Halii Kai at Waikoloa" still resolves to its curated rule',
  communityAddressRuleForName("Halii Kai at Waikoloa")?.street === "69-1029 Nawahine Pl",
  communityAddressRuleForName("Halii Kai at Waikoloa")?.street);

// Legit partial matches must survive the word-boundary tightening.
const partials: Array<{ name: string; street: string }> = [
  { name: "Grand Champions", street: "155 Wailea Ike Pl" },           // ⊂ "Wailea Grand Champions"
  { name: "Kahala at Poipu Kai", street: "1831 Poipu Rd" },           // contains "Poipu Kai"
  { name: "Kaiulani", street: "4100 Queen Emma's Dr" },               // bare ⊂ "Kaiulani of Princeville"
  { name: "Wailea Elua", street: "3600 Wailea Alanui Dr" },           // ⊂ "Wailea Elua Village"
];
for (const p of partials) {
  check(`"${p.name}" still resolves (word-boundary partial)`,
    communityAddressRuleForName(p.name)?.street === p.street,
    communityAddressRuleForName(p.name)?.street);
}

// ── Oahu North Shore: Turtle Bay / Kuilima resort zone ────────────────────────
// The bulk-combo sweep market is "Turtle Bay" (a resort name, not a USPS city).
// Zillow/Realtor/Redfin/Homes index these condos under KAHUKU, HI 96731, so photo
// discovery must search Kahuku, not "Turtle Bay" (the live failure: every query
// returned no listings → "missing-source-url, no-photos" → resort skipped).
const turtleBayResorts: Array<{ name: string; street: string }> = [
  { name: "Ocean Villas at Turtle Bay", street: "57-020 Kuilima Dr" },
  { name: "Kuilima Estates", street: "57-101 Kuilima Dr" },
  { name: "Kuilima Estates East", street: "57-101 Kuilima Dr" },
  { name: "Kuilima Estates West", street: "57-101 Kuilima Dr" },
];
for (const r of turtleBayResorts) {
  // The sweep hands the queue city="Turtle Bay"; resolution must still land the street.
  const resolved = resolveBulkComboListingStreet({ communityName: r.name, city: "Turtle Bay", state: "HI", streetAddress: "" });
  check(`"${r.name}" resolves to a curated Kahuku street (queue path)`, resolved === r.street, resolved);

  // Discovery must search KAHUKU first (the Zillow/Realtor index city), not "Turtle Bay".
  const cities = discoverySearchCitiesForPhotoSearch({ communityName: r.name, city: "Turtle Bay", streetAddress: resolved });
  check(`"${r.name}" photo discovery searches Kahuku first`, cities[0] === "Kahuku", cities);

  // Both the resort's mailing city (Kahuku) and the sweep's "Turtle Bay" alias validate.
  for (const city of ["Kahuku", "Turtle Bay"]) {
    const verdict = validateCommunityStreetAddress({ communityName: r.name, city, state: "HI", streetAddress: resolved });
    check(`"${r.name}" passes save-step validation with city "${city}"`, verdict.ok === true, verdict);
  }
}
// East and West are one gated complex, but each must still resolve a rule (not null).
for (const name of ["Kuilima Estates East", "Kuilima Estates West"]) {
  check(`"${name}" matches a curated rule`, communityAddressRuleForName(name) !== null, communityAddressRuleForName(name)?.street);
}
// A look-alike that is NOT a Kuilima/Turtle Bay resort must not inherit the rule.
check('"Turtle Bay Resort" hotel name does not falsely match Ocean Villas',
  communityAddressRuleForName("Turtle Bay Resort")?.street !== "57-020 Kuilima Dr",
  communityAddressRuleForName("Turtle Bay Resort")?.street);

// The 4 Kauai resorts that failed the live sweep have NO curated rule — confirming
// they correctly depend on the live discovery fallback, not a silent mismatch.
for (const unknown of ["Lae Nani", "Puu Poa", "Hanalei Bay Resort", "Waipouli Beach Resort"]) {
  check(`"${unknown}" has no curated rule (depends on live discovery)`,
    communityAddressRuleForName(unknown) === null,
    communityAddressRuleForName(unknown)?.street);
}

// ── Hawaiian diacritics (okina ʻ / ‘, macrons) ───────────────────────────────
// google_maps returns the real spellings ("Kona Aliʻi", "75-6082 Aliʻi Dr",
// "Hōlualoa Bay Villas"); these previously failed the address gate (okina outside
// the street char class) and the discovery title match (okina split the word into
// "ali i"). The fold collapses them to ASCII without crossing word boundaries.
// Live 2026-06-26: 6 Kona resorts dropped at the address pre-check this way.
check("okina street validates",
  isLikelyStreetAddress("75-6082 Ali‘i Dr") === true);
check("okina street root is clean ASCII",
  streetRootFromAddress("75-6082 Ali‘i Dr, Kailua-Kona, HI 96740") === "75-6082 Alii Dr");
check("macron resort name normalizes to ASCII",
  normalizeCommunityAddressToken("Hōlualoa Bay Villas") === "holualoa bay villas");
check("okina name joins, not splits (Kona Aliʻi)",
  normalizeCommunityAddressToken("Kona Aliʻi") === "kona alii");
check("straight apostrophe also joins",
  normalizeCommunityAddressToken("Ali'i Villas") === "alii villas");
// LOAD-BEARING: folding must NOT merge distinct resorts across a word boundary.
check("Alii Kai stays distinct from Halii Kai after folding",
  normalizeCommunityAddressToken("Alii Kai") !== normalizeCommunityAddressToken("Halii Kai"));
// Rural Hawaii: the numbered street is the SECOND comma-segment (Molokai Shores'
// "Star Route, 1000 Kamehameha V Hwy, …"); the scan must pick it, not "Star Route".
check("rural Star Route picks the numbered second segment",
  streetRootFromAddress("Star Route, 1000 Kamehameha V Hwy, Kaunakakai, HI 96748") === "1000 Kamehameha V Hwy");
// No regression on plain ASCII / numberless addresses.
check("plain street unchanged",
  streetRootFromAddress("130 Kai Malina Pkwy, Lahaina, HI") === "130 Kai Malina Pkwy");
check("numberless address falls back to the first segment",
  streetRootFromAddress("Princeville, HI 96722") === "Princeville");
check("plain Hawaii hyphen house number still validates",
  isLikelyStreetAddress("78-261 Manukai St") === true);

// ── Ko Olina: Hillside Villas / Fairways (2026-07-08 live queue failure) ──────
// The sweep research stamped Ko Olina Hillside Villas with "92-1001 Olani Street"
// — COCONUT PLANTATION's street — so photo discovery queried/ordered against the
// wrong street and skipped the resort as "no for-sale listings found". The real
// community spans 92-1483…92-1526 ALIINUI DR.
check('"Ko Olina Hillside Villas" resolves to its Aliinui Dr curated street',
  inferCommunityStreetAddress({ communityName: "Ko Olina Hillside Villas", city: "Ko Olina", state: "HI" }) === "92-1518 Aliinui Dr",
  inferCommunityStreetAddress({ communityName: "Ko Olina Hillside Villas", city: "Ko Olina", state: "HI" }));
check('"The Fairways at Ko Olina" resolves to its curated street',
  inferCommunityStreetAddress({ communityName: "The Fairways at Ko Olina", city: "Ko Olina", state: "HI" }) === "92-1479 Aliinui Dr",
  inferCommunityStreetAddress({ communityName: "The Fairways at Ko Olina", city: "Ko Olina", state: "HI" }));
// The curated rule must WIN over a wrong-but-plausible stored street, so a
// queued/failed item heals on retry (this is the exact live poisoning).
check("curated rule overrides a wrong stored street on hydrate (rule-first)",
  resolveBulkComboListingStreet({
    communityName: "Ko Olina Hillside Villas",
    city: "Ko Olina",
    state: "Hawaii",
    streetAddress: "92-1001 Olani Street",
  }) === "92-1518 Aliinui Dr",
  resolveBulkComboListingStreet({ communityName: "Ko Olina Hillside Villas", city: "Ko Olina", state: "Hawaii", streetAddress: "92-1001 Olani Street" }));
// No-rule communities keep trusting the stored street (unchanged behavior).
check("no-rule community still trusts its stored street",
  resolveBulkComboListingStreet({
    communityName: "Some Unknown Resort",
    city: "Kihei",
    state: "HI",
    streetAddress: "123 Fake St",
  }) === "123 Fake St",
  resolveBulkComboListingStreet({ communityName: "Some Unknown Resort", city: "Kihei", state: "HI", streetAddress: "123 Fake St" }));
// Save-step validation passes with either the mailing city or the sweep's label.
for (const city of ["Kapolei", "Ko Olina"]) {
  const verdict = validateCommunityStreetAddress({ communityName: "Ko Olina Hillside Villas", city, state: "HI", streetAddress: "92-1518 Aliinui Dr" });
  check(`"Ko Olina Hillside Villas" passes save validation with city "${city}"`, verdict.ok === true, verdict);
}
// Coconut Plantation must be unaffected (it legitimately owns Olani St).
check('"Coconut Plantation" keeps its own Olani St rule',
  communityAddressRuleForName("Coconut Plantation")?.street === "92-1070 Olani St",
  communityAddressRuleForName("Coconut Plantation")?.street);

console.log(`\ncommunity-addresses: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
