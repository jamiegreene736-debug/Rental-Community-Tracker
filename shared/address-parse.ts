// Generic street-address parsing, shared by server modules that need a
// display address split into components:
//   - server/published-address.ts (separate published address — clubhouse
//     resolution ladder + unit-stripped fallback)
//   - server/unit-audit-sweep.ts (audit target street/city for find-unit)
//   - server/auto-replace-jobs.ts (auto-replace target street/city)
//
// History: this parser was born inside shared/address-listing-logic.ts (the
// address-on-OTA detection leg). That leg was REMOVED 2026-07-18 — the
// separate published address (clubhouse street on every listing) made the
// "someone listed our unit's address" signal moot — but the parser itself is
// general-purpose and its consumers above are unrelated to detection, so it
// lives on here. Tests: tests/address-parse.test.ts.

// Parse a free-form address into { street, city, state }, robust to an embedded
// unit/building segment. "1831 Poipu Rd, Unit 423, Koloa, HI 96756" →
// { street: "1831 Poipu Rd", city: "Koloa", state: "HI" }. The city is the first
// comma-part after the street that is NOT a unit/building segment ("Unit 423",
// "Bldg 3", "#5", "Apt 2") and NOT a bare state/zip token — fixing the old
// `parts[1]` parse that mistook "Unit 423" for the city on 4-part addresses.
const UNIT_SEGMENT_RE = /^(?:unit|apt\.?|apartment|suite|ste\.?|bldg\.?|building|villa|townhome|townhouse|#|no\.?)\b/i;
const STATE_OR_ZIP_RE = /^[A-Za-z]{2}(?:\s+\d{5}(?:-\d{4})?)?$|^\d{5}(?:-\d{4})?$/;

export function parseStreetCityState(address: string): { street: string; city: string; state: string } {
  const raw = String(address ?? "").trim();
  if (!raw) return { street: "", city: "", state: "" };
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const street = parts[0] ?? "";
  let city = "";
  let state = "";
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (!city) {
      if (UNIT_SEGMENT_RE.test(p)) continue;          // skip "Unit 423" / "Bldg 3" / "#5"
      if (STATE_OR_ZIP_RE.test(p)) { state = p.split(/\s+/)[0]; continue; }
      city = p;
      continue;
    }
    if (!state && STATE_OR_ZIP_RE.test(p)) state = p.split(/\s+/)[0];
  }
  // Fallback: a 2-part "street, city" with no later state token.
  if (!city && parts.length >= 2 && !UNIT_SEGMENT_RE.test(parts[1]) && !STATE_OR_ZIP_RE.test(parts[1])) {
    city = parts[1];
  }
  return { street, city, state };
}
