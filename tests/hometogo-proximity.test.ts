// HomeToGo onsite source: the safety-gate coords path (2026-06-11).
//
// HomeToGo's /searchdetails feed gives each onsite offer EXACT coordinates, which the
// attach flow stamps into the buy-in notes as "Geo: <lat>,<lon>". The attach-time
// proximity gate (server/routes.ts estimateAttachedBuyInProximity) trusts two REAL
// coordinate pairs to authorize a city-wide cross-complex attach — the (a) branch of the
// 2026-06-10/11 evidence rule that blocked the Puamana + Ka Eo Kai mispair.
//
// These tests lock the two primitives that path is built on:
//   parseGeoNote        — reads the marker (and rejects junk / coordless VRBO notes)
//   walkBetweenCoords   — exact-coord walk (within-limit for same-complex, blocked for far)
// and the KEY safety invariant: a coord unit paired with a COORDLESS (generic VRBO) unit
// can NOT take the trusted coords path (parseGeoNote returns null for one side), so it
// falls back to the existing address/title gate that correctly blocks it.
import { parseGeoNote, walkBetweenCoords, MAX_BUY_IN_WALK_MINUTES } from "../shared/walking-distance";
import { coordsWithinState } from "../shared/listing-geo";
import { unitTokensFromTitle, listingsAreSamePhysicalUnit } from "../shared/city-vrbo-combo";

const samePhysUnit = (ta: string, tb: string, ba?: number, bb?: number) =>
  listingsAreSamePhysicalUnit({ title: ta, bedrooms: ba ?? null }, { title: tb, bedrooms: bb ?? null });

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("hometogo-proximity: Geo-note parsing + exact-coord walk gate");

// ── parseGeoNote ─────────────────────────────────────────────────────────────
const htgNote = "Auto-filled from HomeToGo — Kauai Pili Mai 14K · Matched from city-wide VRBO map for 3BR 2026-07-20→2026-07-27 · Buy-in source: original city (Poipu) · Geo: 21.884595,-159.457816 · Manual photo URLs: https://x/y.jpg";
const parsed = parseGeoNote(htgNote);
check("parses Geo marker out of a full HomeToGo note", !!parsed && Math.abs((parsed!.lat) - 21.884595) < 1e-5 && Math.abs((parsed!.lng) + 159.457816) < 1e-5, parsed);
check("parses bare 'Geo: lat,lng'", JSON.stringify(parseGeoNote("Geo: 21.87,-159.45")) === JSON.stringify({ lat: 21.87, lng: -159.45 }));
check("coordless VRBO note → null (no marker)", parseGeoNote("Auto-filled from Vrbo — Poipu Kai 3BR · Matched from city-wide VRBO map") === null);
check("empty / nullish → null", parseGeoNote("") === null && parseGeoNote(null) === null && parseGeoNote(undefined) === null);
check("0,0 sentinel rejected", parseGeoNote("Geo: 0,0") === null);
check("out-of-range lat rejected", parseGeoNote("Geo: 120.0,-159.4") === null);
check("out-of-range lng rejected", parseGeoNote("Geo: 21.8,-200.0") === null);
check("garbage after Geo → null", parseGeoNote("Geo: not,coords") === null);

// ── walkBetweenCoords: same-complex (within limit) ───────────────────────────
// Real recon coords: Pili Mai 14K vs Pili Mai 6K — same complex, near-adjacent.
const piliMai14K = { lat: 21.8845953, lng: -159.457816 };
const piliMai6K = { lat: 21.884606, lng: -159.457816 };
const wSame = walkBetweenCoords(piliMai14K, piliMai6K, "Pili Mai");
check("same-complex walk uses source 'coords'", wSame.source === "coords", wSame);
check("same-complex Pili Mai pair is WITHIN the walk limit", wSame.minutes <= MAX_BUY_IN_WALK_MINUTES, wSame);

// A modest same-area hop (~Pili Mai → The Palms at Poipu Kai, ~0.012° ≈ a few min).
const palmsPoipuKai = { lat: 21.8747005, lng: -159.46 };
const wHop = walkBetweenCoords(piliMai14K, palmsPoipuKai, "Poipu");
check("nearby-but-distinct pair has a finite minute estimate", Number.isFinite(wHop.minutes) && wHop.feet > 0, wHop);

// ── walkBetweenCoords: genuinely far (must EXCEED the limit → gate blocks) ────
// Poipu (south shore) vs Princeville (north shore) — ~30km apart.
const princeville = { lat: 22.2231, lng: -159.4843 };
const wFar = walkBetweenCoords(piliMai14K, princeville, "Poipu");
check("Poipu↔Princeville EXCEEDS the walk limit (blocked)", wFar.minutes > MAX_BUY_IN_WALK_MINUTES, wFar);

// ── SAFETY INVARIANT: coord unit + coordless (generic VRBO) unit ─────────────
// The gate only takes the trusted coords path when BOTH units parse coords. A HomeToGo
// onsite unit paired with a coordless VRBO unit yields exactly one parse → the gate
// falls back to the address/title path (which blocks an unverified cross-resort city pair).
const htgCoords = parseGeoNote(htgNote);
const vrboCoords = parseGeoNote("Auto-filled from Vrbo — Some Condo · Matched from city-wide VRBO map");
check("mixed pair can NOT take the coords path (one side is null)", !!htgCoords && vrboCoords === null);

// ── coords-region guard (the global-pool safety net) ────────────────────────
// A flaked HomeToGo destination returns a WORLDWIDE pool; we drop offers whose exact
// coords fall outside the target state so Colorado/Cabo/Tahiti never reach the matcher.
// The "Hawaii" guard is scoped to KAUAI (every buy-in market is on Kauai) — it drops the
// other-island padding HomeToGo adds on a deep scroll, not just global junk.
check("Poipu/Kauai IN", coordsWithinState(21.8846, -159.4578, "Hawaii"));
check("Princeville/Kauai (north shore) IN", coordsWithinState(22.223, -159.484, "Hawaii"));
check("Kapaa/Kauai (east) IN", coordsWithinState(22.075, -159.319, "Hawaii"));
check("Big Island (Kona) DROPPED — wrong island", !coordsWithinState(19.62, -155.95, "Hawaii"));
check("Maui (Maui Sands/Kahana) DROPPED — wrong island", !coordsWithinState(20.95, -156.68, "Hawaii"));
check("Oahu (Honolulu) DROPPED — wrong island", !coordsWithinState(21.31, -157.86, "Hawaii"));
check("Colorado (Copper Mtn) DROPPED", !coordsWithinState(39.5019, -106.159, "Hawaii"));
check("Cabo San Lucas DROPPED", !coordsWithinState(22.886, -109.908, "Hawaii"));
check("Park City Utah DROPPED", !coordsWithinState(40.711, -111.549, "Hawaii"));
check("Santa Fe NM DROPPED", !coordsWithinState(35.6947, -105.956, "Hawaii"));
check("Tahiti (intl, no US state) DROPPED — closes the listingIsOutOfArea gap", !coordsWithinState(-17.5, -149.5, "Hawaii"));
check("null/NaN coords DROPPED", !coordsWithinState(null, null, "Hawaii") && !coordsWithinState(NaN, NaN, "Hawaii"));
check("UNKNOWN target state DROPS (safe default)", !coordsWithinState(21.88, -159.45, "Atlantis"));
check("Florida coords IN Florida box", coordsWithinState(28.5, -81.4, "Florida"));
check("Hawaii coords NOT in Florida box", !coordsWithinState(21.88, -159.45, "Florida"));

// ── cross-source dedup (same physical unit on VRBO + HomeToGo, different URLs) ───
// unit-token extraction: real unit IDs kept, incidental counts stripped.
check("unitTokens 'Pili Mai 14K' → 14k", JSON.stringify(unitTokensFromTitle("Pili Mai 14K")) === JSON.stringify(["14k"]));
check("unitTokens 'Poipu Shores A206' → a206", unitTokensFromTitle("Poipu Shores A206").includes("a206"));
check("unitTokens 'Kauai Lawai Beach Resort C103' → c103", unitTokensFromTitle("Kauai Lawai Beach Resort C103").includes("c103"));
check("unitTokens strips counts: '3BR Poipu Kai home 5 min walk' → none", unitTokensFromTitle("3BR Poipu Kai home 5 min walk").length === 0);
check("unitTokens '...Villas 503 – PBAC' → 503", unitTokensFromTitle("Waikomo Stream Villas 503 – PBAC Membership, Walk to Ocean").includes("503"));

// same unit across the two sources' title formats → MATCH (would be deduped)
check("SAME unit: HomeToGo 'Kauai Pili Mai 14K' ↔ VRBO 'Pili Mai 14K – Central AC'", samePhysUnit("Kauai Pili Mai 14K", "Pili Mai 14K – Central AC, walk to pool", 3, 3));
check("SAME unit: 'Kauai Waikomo Stream Villas 503' ↔ 'Waikomo Stream Villas 503 – PBAC'", samePhysUnit("Kauai Waikomo Stream Villas 503", "Waikomo Stream Villas 503 – PBAC Membership"));
// different unit, same resort → NO match (the key precision test)
check("DIFFERENT unit same resort: 'Pili Mai 14K' ↮ 'Pili Mai 15H'", !samePhysUnit("Pili Mai 14K", "Pili Mai 15H – Central"));
check("DIFFERENT unit same resort: 'Waikomo Stream Villas 503' ↮ '...Villas 100'", !samePhysUnit("Kauai Waikomo Stream Villas 503", "Waikomo Stream Villas 100"));
// same unit token, DIFFERENT resort → NO match (resort phrase guards it)
check("SAME token diff resort: 'Waikomo Stream Villas 100' ↮ 'Poipu Sands at Poipu Kai 100'", !samePhysUnit("Waikomo Stream Villas 100", "Poipu Sands at Poipu Kai 100"));
// bedroom conflict → NO match even if resort+token align
check("bedroom conflict blocks match: 'Pili Mai 14K' 3BR ↮ 'Pili Mai 14K' 2BR", !samePhysUnit("Pili Mai 14K", "Pili Mai 14K", 3, 2));
// generic titles (no resort phrase) → NO match (can't confirm same unit)
check("generic titles never dedupe", !samePhysUnit("Family-oriented condo with hot tub & pool", "Lovely 2BR condo near the beach"));

console.log(`\nhometogo-proximity: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
