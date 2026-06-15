// Locks the curated street addresses that let the bulk combo listing queue SAVE
// a draft (validateCommunityStreetAddress hard-rejects without a real numbered
// street). These three Wailea/Maui resorts were missing and failed the queue's
// save step until added; this guards against regressing them.
import {
  validateCommunityStreetAddress,
  inferCommunityStreetAddress,
  resolveBulkComboListingStreet,
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

console.log(`\ncommunity-addresses: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
