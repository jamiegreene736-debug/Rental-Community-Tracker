// Geographic guard tests. THE bug: VRBO resolved nearby "Port Allen" to Port
// Allen, LOUISIANA and a "Charming Baton Rouge Retreat ~ 3 Mi to LSU!" got
// attached to a Poipu Kai (Hawaii) booking. We must drop out-of-state listings
// WITHOUT over-dropping genuine Hawaii units that just lack a state token.
import { listingIsOutOfArea, mentionsHawaii, mentionsNonHawaiiState } from "../shared/listing-geo";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("listing-geo: out-of-area guard for Hawaii buy-in markets");

// ── THE bug cases: drop Louisiana / mainland ─────────────────────────────────
check("drop 'Baton Rouge, Louisiana'", listingIsOutOfArea("Baton Rouge, Louisiana"));
check("drop 'Port Allen, Louisiana, United States of America'", listingIsOutOfArea("Port Allen, Louisiana, United States of America"));
check("drop 'Baton Rouge, LA'", listingIsOutOfArea("Baton Rouge, LA"));
check("drop 'Baton Rouge, LA 70802'", listingIsOutOfArea("Baton Rouge, LA 70802"));
check("drop 'Orlando, Florida'", listingIsOutOfArea("Orlando, Florida"));
check("drop 'Austin, TX'", listingIsOutOfArea("Austin, TX"));

// ── KEEP genuine Hawaii listings (the must-not-over-drop cases) ───────────────
check("keep 'Koloa, Hawaii'", !listingIsOutOfArea("Koloa, Hawaii"));
check("keep 'Princeville, HI'", !listingIsOutOfArea("Princeville, HI"));
check("keep 'Poipu, Kauai'", !listingIsOutOfArea("Poipu, Kauai"));
check("keep 'Lawai, Hawaii, United States'", !listingIsOutOfArea("Lawai, Hawaii, United States"));
check("keep 'Wailea, Maui'", !listingIsOutOfArea("Wailea, Maui"));
check("keep 'Princeville, Kauai, Hawaii'", !listingIsOutOfArea("Princeville, Kauai, Hawaii"));

// ── ambiguous (no recognizable state) → KEEP (conservative) ──────────────────
check("keep '' (empty)", !listingIsOutOfArea(""));
check("keep null", !listingIsOutOfArea(null));
check("keep 'Oceanfront condo' (no location)", !listingIsOutOfArea("Oceanfront condo"));
check("keep 'Villas of Kamalii 39' (community name, no state)", !listingIsOutOfArea("Villas of Kamalii 39"));

// ── abbreviation must not false-fire inside words ────────────────────────────
check("keep 'Lahaina villa' (no ', LA' slot — 'la' inside word)", !listingIsOutOfArea("Lahaina villa"));
check("keep 'Kailua, HI' (HI abbr is Hawaii)", !listingIsOutOfArea("Kailua, HI"));
check("'Kailua, HI' mentionsHawaii", mentionsHawaii("Kailua, HI"));

// ── a Hawaii token always wins over a stray state word ───────────────────────
check("keep 'Hanalei, Hawaii (formerly listed in Oregon)' — Hawaii wins",
  !listingIsOutOfArea("Hanalei, Hawaii (formerly listed in Oregon)"));

// ── helpers ──────────────────────────────────────────────────────────────────
check("mentionsNonHawaiiState('Baton Rouge, Louisiana')", mentionsNonHawaiiState("Baton Rouge, Louisiana"));
check("NOT mentionsNonHawaiiState('Koloa, Hawaii')", !mentionsNonHawaiiState("Koloa, Hawaii"));
check("NOT mentionsNonHawaiiState('Lahaina') — 'la' not a state slot", !mentionsNonHawaiiState("Lahaina"));

// ── non-Hawaii target state → never drop (future markets) ────────────────────
check("targetState non-Hawaii → never drop", !listingIsOutOfArea("Baton Rouge, Louisiana", "Louisiana"));

console.log(`\nlisting-geo: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
