// Locks the find-unit replacement resort gate's Hawaii "same street family"
// matching (shared/hawaii-street-family.ts).
//
// Regression context (2026-06-22): the replacement search for Waikoloa Beach
// Villas (69-180 Waikoloa Beach Dr) reported "Replacement unit found" but
// returned a Redfin unit at 69-555 Waikoloa Beach Dr — which is Waikoloa COLONY
// Villas, a DIFFERENT resort. The street-family match ignored the lot number, so
// every "69-### Waikoloa Beach Dr" resort collapsed into one. The fix requires
// the lot number to match on lot-significant streets, while KEEPING the lot-
// agnostic match everywhere else so genuine multi-building resorts (Coconut
// Plantation on Olani St) still match across their buildings.
import {
  isSameHawaiiStreetFamily,
  HAWAII_STREETS_WITH_DISTINCT_RESORTS_BY_LOT,
} from "../shared/hawaii-street-family";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

const BEACH_VILLAS = "69 180 waikoloa beach dr";   // Waikoloa Beach Villas (configured -12 community)
const COLONY_VILLAS = "69 555 waikoloa beach dr";  // Waikoloa Colony Villas (a different resort)

// --- The bug: distinct resorts on Waikoloa Beach Dr must NOT be merged ---
check(
  "Beach Villas (69-180) does NOT match Colony Villas (69-555)",
  isSameHawaiiStreetFamily(COLONY_VILLAS, BEACH_VILLAS) === false,
);
check(
  "rejection is symmetric (allowed/candidate swapped)",
  isSameHawaiiStreetFamily(BEACH_VILLAS, COLONY_VILLAS) === false,
);
check(
  "a third Waikoloa Beach Dr resort (Marriott 69-275) is also rejected for Beach Villas",
  isSameHawaiiStreetFamily("69 275 waikoloa beach dr", BEACH_VILLAS) === false,
);

// --- Exact same building still matches ---
check(
  "identical Beach Villas root still matches",
  isSameHawaiiStreetFamily(BEACH_VILLAS, BEACH_VILLAS) === true,
);

// --- Recall preserved: multi-building single resort on a non-listed street ---
// Coconut Plantation (Ko Olina) spans 92-1001 … 92-1097 Olani St as ONE resort;
// Olani St is NOT lot-significant, so sibling buildings must still match.
check(
  "Coconut Plantation siblings on Olani St (92-1001 vs 92-1075) still match (lot-agnostic)",
  isSameHawaiiStreetFamily("92 1075 olani st", "92 1001 olani st") === true,
);
check(
  "Olani St is intentionally NOT in the lot-significant set",
  HAWAII_STREETS_WITH_DISTINCT_RESORTS_BY_LOT.has("olani st") === false,
);
check(
  "Waikoloa Beach Dr IS in the lot-significant set",
  HAWAII_STREETS_WITH_DISTINCT_RESORTS_BY_LOT.has("waikoloa beach dr") === true,
);

// --- Other guards unchanged ---
check(
  "different street name never matches",
  isSameHawaiiStreetFamily("69 180 waikoloa beach dr", "69 180 alii dr") === false,
);
check(
  "different district prefix never matches",
  isSameHawaiiStreetFamily("75 180 waikoloa beach dr", "69 180 waikoloa beach dr") === false,
);
check(
  "non-Hawaii / malformed roots return false",
  isSameHawaiiStreetFamily("220 young ave", "220 young ave") === false,
);

console.log(`\nhawaii-street-family: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
