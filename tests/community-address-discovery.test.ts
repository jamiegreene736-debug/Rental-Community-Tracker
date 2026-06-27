// Pure-logic locks for the bulk-combo live address discovery
// (server/community-address-discovery.ts). The network leg is verified live;
// here we lock the candidate-selection precision that keeps a WRONG address from
// ever being accepted. Fixtures mirror real SearchAPI google_maps responses
// captured 2026-06-17 for the resorts that failed the live sweep.
import {
  selectDiscoveredStreet,
  selectCoordinateFallbackCandidate,
  titleMatchesResort,
  distinctiveResortTokens,
  type MapsAddressCandidate,
} from "../server/community-address-discovery";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("community-address-discovery: candidate selection");

// ── titleMatchesResort ────────────────────────────────────────────────────────
check("matches when all distinctive tokens present", titleMatchesResort("Lae Nani", "Lae Nani"));
check("matches with generic suffix in title", titleMatchesResort("Waipouli Beach Resort", "Waipouli Beach Resort"));
check("matches resort name that is a prefix of the title", titleMatchesResort("Puu Poa Condos", "Puu Poa"));
check("rejects a different resort sharing a substring",
  titleMatchesResort("Halii Kai at Waikoloa", "Alii Kai") === false);
check("rejects an unrelated POI", titleMatchesResort("Lae Nani Beach", "Puu Poa") === false);
check("rejects empty title", titleMatchesResort("", "Lae Nani") === false);
// Whole-word: "kai" must not match inside "kailua".
check("token does not match a longer word",
  titleMatchesResort("Kailua Sands", "Alii Kai") === false);

// ── distinctiveResortTokens ───────────────────────────────────────────────────
check("strips generic descriptors",
  JSON.stringify(distinctiveResortTokens("Waipouli Beach Resort")) === JSON.stringify(["waipouli", "beach"]),
  distinctiveResortTokens("Waipouli Beach Resort"));
check("keeps all tokens when every token is generic",
  distinctiveResortTokens("The Resort").length > 0,
  distinctiveResortTokens("The Resort"));

// ── selectDiscoveredStreet: the four resorts that failed the live sweep ────────
// Lae Nani: the FIRST result is a streetless beach POI; the resort (with a street,
// even one carrying an APT suffix) is the second — must be picked, and the unit
// suffix stripped to a clean street root.
const laeNani: MapsAddressCandidate[] = [
  { title: "Lae Nani Beach", address: "Wailua, HI 96746" },
  { title: "Lae Nani", address: "410 Papaloa Rd APT 331, Kapaʻa, HI 96746" },
];
const laeNaniPick = selectDiscoveredStreet(laeNani, "Lae Nani", "q");
check("Lae Nani picks the resort over the streetless beach", laeNaniPick?.street === "410 Papaloa Rd", laeNaniPick);

const hanalei = selectDiscoveredStreet(
  [{ title: "Hanalei Bay Resort", address: "5380 Honoiki Rd, Princeville, HI 96722" }],
  "Hanalei Bay Resort", "q");
check("Hanalei Bay Resort resolves", hanalei?.street === "5380 Honoiki Rd", hanalei);

const waipouli = selectDiscoveredStreet(
  [{ title: "Waipouli Beach Resort", address: "4-820 Kuhio Hwy Suite 1, Kapaʻa, HI 96746" }],
  "Waipouli Beach Resort", "q");
check("Waipouli (hyphenated street + suite) resolves", waipouli?.street === "4-820 Kuhio Hwy", waipouli);

const puuPoa = selectDiscoveredStreet(
  [{ title: "Puu Poa Condos", address: "5454 Ka Haku Rd, Princeville, HI 96722" }],
  "Puu Poa", "q");
check("Puu Poa resolves", puuPoa?.street === "5454 Ka Haku Rd", puuPoa);

// ── PRECISION: never accept a wrong-resort street ─────────────────────────────
// Mirrors the Alii Kai/Halii Kai mix-up. If the maps engine returns the wrong
// resort (Big-Island Halii Kai) for an "Alii Kai" query, it must be rejected — a
// streetless correct hit yields null, NOT the wrong street.
const aliiKaiWrong: MapsAddressCandidate[] = [
  { title: "Halii Kai at Waikoloa", address: "69-1029 Nawahine Pl, Waikoloa Village, HI 96738" },
  { title: "Alii Kai Princeville condo", address: "Princeville, HI 96722" }, // correct resort, no street
];
check("Alii Kai never inherits the Halii Kai street",
  selectDiscoveredStreet(aliiKaiWrong, "Alii Kai", "q") === null,
  selectDiscoveredStreet(aliiKaiWrong, "Alii Kai", "q"));
// But the correct Alii Kai result (with a street) IS accepted.
const aliiKaiRight = selectDiscoveredStreet(
  [{ title: "Alii Kai Resort", address: "3830 Edward Rd, Princeville, HI 96722" }],
  "Alii Kai", "q");
check("Alii Kai resolves to its real Princeville street", aliiKaiRight?.street === "3830 Edward Rd", aliiKaiRight);

// A streetless-only result set yields null (item fails the pre-check, as before).
check("no usable street → null",
  selectDiscoveredStreet([{ title: "Some Resort", address: "Princeville, HI 96722" }], "Some Resort", "q") === null);
// A real street but a non-matching title is rejected (avoids grabbing a random
// numbered business near the resort).
check("matching street but wrong title → null",
  selectDiscoveredStreet([{ title: "Joe's Coffee Shack", address: "123 Main St, Princeville, HI 96722" }], "Puu Poa", "q") === null);

// ── selectCoordinateFallbackCandidate: the reverse-geocode rescue input ────────
// The COMMON miss: google_maps knows the resort (name-matched title + coordinates)
// but returns only the locality, no street. That place must be surfaced as a
// coordinate fallback so the caller can reverse-geocode it.
const streetless: MapsAddressCandidate[] = [
  { title: "Alii Kai Princeville condo", address: "Princeville, HI 96722", gps_coordinates: { latitude: 22.222, longitude: -159.486 } },
];
const cf = selectCoordinateFallbackCandidate(streetless, "Alii Kai");
check("streetless name-matched place yields a coordinate fallback",
  cf?.lat === 22.222 && cf?.lng === -159.486, cf);

// A WRONG-resort streetless place is rejected by the same title gate (no Halii-Kai
// coordinates leak into an Alii Kai lookup).
check("wrong-resort streetless place is rejected",
  selectCoordinateFallbackCandidate(
    [{ title: "Halii Kai at Waikoloa", address: "Waikoloa, HI 96738", gps_coordinates: { latitude: 19.9, longitude: -155.8 } }],
    "Alii Kai",
  ) === null);

// A place that ALREADY has a usable street is NOT a coordinate fallback — the
// direct street path owns it (so we never reverse-geocode when we have a real street).
check("candidate with a real street is not a coordinate fallback",
  selectCoordinateFallbackCandidate(
    [{ title: "Puu Poa Condos", address: "5454 Ka Haku Rd, Princeville, HI 96722", gps_coordinates: { latitude: 22.2, longitude: -159.5 } }],
    "Puu Poa",
  ) === null);

// No coordinates → no fallback (nothing to reverse-geocode).
check("streetless place without coordinates yields null",
  selectCoordinateFallbackCandidate(
    [{ title: "Some Resort", address: "Princeville, HI 96722" }],
    "Some Resort",
  ) === null);

// ── Hawaiian diacritics (okina / macron) in map titles + addresses ────────────
// google_maps returns okina spellings ("Kona Aliʻi", "Casa-De-Emdeko" on
// "75-6082 Aliʻi Dr", "Hōlualoa Bay Villas"); the title gate + street selection
// must fold them so real Kona resorts resolve (live 2026-06-26 — 6 of them failed).
check("title gate matches across okina (Kona Aliʻi ↔ Kona Alii)",
  titleMatchesResort("Kona Aliʻi", "Kona Alii") === true);
check("title gate matches across macron (Hōlualoa Bay Villas)",
  titleMatchesResort("Hōlualoa Bay Villas", "Holualoa Bay Villas") === true);
check("okina street candidate is now selected (was rejected by the char class)",
  selectDiscoveredStreet(
    [{ title: "Casa-De-Emdeko", address: "75-6082 Ali‘i Dr, Kailua-Kona, HI 96740" }],
    "Casa De Emdeko", "q",
  )?.street === "75-6082 Alii Dr");
// Precision preserved: folding does not let a DIFFERENT resort through the gate.
check("okina fold does not match a different resort",
  titleMatchesResort("Kona Aliʻi", "Kona Makai") === false);

console.log(`\ncommunity-address-discovery: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
