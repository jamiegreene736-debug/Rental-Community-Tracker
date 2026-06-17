// find-unit OTA unit-match precision tests.
//
// THE bug: builder "Find a New Unit" returned nothing for Waikoloa Beach Villas
// (a ~121-unit, ~89-on-VRBO STVR-saturated resort whose units are LETTER-coded:
// C1/A4/I4). The OTA-presence check (checkOnePlatform → hitMatchesUnit) matched a
// bare `\bcode\b` over title+snippet+link, so a multi-unit VRBO/Airbnb ROUNDUP
// page whose snippet enumerates several codes ("…C1, A4, I4…") false-flagged a
// genuinely-clean unit (e.g. for-sale O1) as already listed → skipped-found →
// dropped. Tighten the letter branch to an ANCHORED match while leaving the
// numeric branch (Poipu Kai "721") untouched. The downstream reverse-image
// photo-reuse gate ("skipped-photo-found") is the backstop, so tightening here is
// safe (it never reintroduces the photo-feedback loop).
import { hitTextMatchesUnit } from "../server/listing-unit-match";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("listing-unit-match: letter-coded OTA matching precision (Waikoloa Beach Villas)");

// ── THE bug: roundup snippets enumerating codes must NOT false-match ──────────
const roundup = {
  title: "Waikoloa Beach Villas Vacation Rentals | Vrbo",
  snippet: "Choose from our top units: C1, A4, I4, M2 and more — ground floor, near pool, sleeps 6.",
  link: "https://www.vrbo.com/vacation-rentals/usa/hawaii/.../waikoloa-beach-villa",
};
check("roundup enumerating 'C1, A4, I4' does NOT match clean C1", !hitTextMatchesUnit("C1", roundup), roundup);
check("roundup enumerating codes does NOT match clean I4", !hitTextMatchesUnit("I4", roundup));
check("roundup enumerating codes does NOT match clean A4", !hitTextMatchesUnit("A4", roundup));

// resort-name immediately before the code in a snippet must NOT anchor (villas excluded)
const resortAdjacent = {
  title: "Top 50 Waikoloa Beach Villas Rentals",
  snippet: "Waikoloa Beach Villas C1, A4 and others available this season.",
  link: "https://www.vrbo.com/.../waikoloa-beach-villas",
};
check("'Beach Villas C1' in a snippet does NOT anchor a match", !hitTextMatchesUnit("C1", resortAdjacent), resortAdjacent);

// ── genuine single OTA listings must STILL match (recall preserved) ───────────
check("single listing titled 'Waikoloa Beach Villas C1' matches", hitTextMatchesUnit("C1", {
  title: "Waikoloa Beach Villas C1 - Ground Floor, Near Pool",
  snippet: "3 bedroom townhouse, sleeps 6.",
  link: "https://www.vrbo.com/1234567",
}));
check("marketing title 'PARADISE AWAITS IN J4' matches J4 (code in title)", hitTextMatchesUnit("J4", {
  title: "PARADISE AWAITS IN J4 | Waikoloa Beach Villas",
  snippet: "Luxury end unit.",
  link: "https://www.vrbo.com/208588",
}));
check("code only in snippet but keyword-anchored ('unit C1') matches", hitTextMatchesUnit("C1", {
  title: "Beautiful Beach Resort Condo, Sleeps 6",
  snippet: "This is unit C1, a ground-floor end townhouse near the pool.",
  link: "https://www.airbnb.com/rooms/123",
}));
check("Kona Coast 'Waikoloa Beach Villas I4' rental matches I4", hitTextMatchesUnit("I4", {
  title: "Waikoloa Beach Villas I4 | Kona Coast Vacations",
  snippet: "3BR/3BA ground-floor townhouse along the 3rd fairway.",
  link: "https://www.konacoastvacations.com/waikoloa-beach-villas-i4/",
}));

// ── boundary precision: don't bleed across adjacent codes ────────────────────
check("checking O1 does NOT match a page about O2", !hitTextMatchesUnit("O1", {
  title: "Waikoloa Beach Villas O2 Cottage",
  snippet: "Adjacent to O1 building.",
  link: "https://www.vrbo.com/o2",
}));
check("checking J2 does NOT match 'unit J22'", !hitTextMatchesUnit("J2", {
  title: "Waikoloa Beach Villas J22",
  snippet: "Top floor unit J22.",
  link: "https://www.vrbo.com/j22",
}));
check("checking J22 DOES match 'unit J22'", hitTextMatchesUnit("J22", {
  title: "Waikoloa Beach Villas J22",
  snippet: "Top floor unit J22.",
  link: "https://www.vrbo.com/j22",
}));

// ── numeric branch UNCHANGED (Poipu Kai / Kauai — must keep working) ──────────
check("'Regency at Poipu Kai 721' matches 721", hitTextMatchesUnit("721", {
  title: "Regency at Poipu Kai 721 - Oceanview",
  snippet: "3BR condo.",
  link: "https://www.vrbo.com/721",
}));
check("'unit 721' anchors a numeric match", hitTextMatchesUnit("721", {
  title: "Poipu condo",
  snippet: "Spacious unit 721.",
  link: "https://www.vrbo.com/x",
}));
check("Poipu snippet listing OTHER numbers (312, 821) does NOT match clean 721", !hitTextMatchesUnit("721", {
  title: "Regency at Poipu Kai Rentals",
  snippet: "Available: 312, 821, 621, 423.",
  link: "https://www.vrbo.com/poipu",
}));
check("a BARE number with no unit keyword does NOT match (numeric needs anchor)", !hitTextMatchesUnit("721", {
  title: "Sold for 721,000",
  snippet: "Closed at 721 thousand.",
  link: "https://www.vrbo.com/x",
}));

// ── misc ─────────────────────────────────────────────────────────────────────
check("empty unit matches anything (no unit to disambiguate)", hitTextMatchesUnit("", {
  title: "Anything", snippet: "", link: "",
}));
check("hit with the code ONLY in the link slug, no keyword, no title → clean", !hitTextMatchesUnit("C1", {
  title: "Beach Villas Rental",
  snippet: "Lovely condo.",
  link: "https://www.vrbo.com/listing/beach-villas-c1-rental",
}));

console.log(`\nlisting-unit-match: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
