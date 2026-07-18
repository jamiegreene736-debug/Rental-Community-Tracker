import assert from "node:assert";
import { parseStreetCityState } from "../shared/address-parse";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("address-parse: generic street/city/state parsing (published-address + audit/replace targets)");

// parseStreetCityState — the city must NOT be the embedded "Unit N"/"Bldg N" segment
// (2026-06-30 fix: the old parts[1] parse mistook "Unit 423" for the city).
{
  const a = parseStreetCityState("1831 Poipu Rd, Unit 423, Koloa, HI 96756");
  check("4-part w/ Unit segment → city is Koloa, not 'Unit 423'", a.street === "1831 Poipu Rd" && a.city === "Koloa" && a.state === "HI");
  const b = parseStreetCityState("2611 Kiahuna Plantation Dr, Bldg 38, Koloa, HI 96756");
  check("4-part w/ Bldg segment → city is Koloa", b.street === "2611 Kiahuna Plantation Dr" && b.city === "Koloa" && b.state === "HI");
  const c = parseStreetCityState("8497 Kekaha Rd, Kekaha, HI 96752");
  check("3-part → city is the 2nd part", c.street === "8497 Kekaha Rd" && c.city === "Kekaha" && c.state === "HI");
  const d = parseStreetCityState("4460 Nehe Rd, Lihue, HI 96766");
  check("3-part Lihue", d.street === "4460 Nehe Rd" && d.city === "Lihue" && d.state === "HI");
  const e = parseStreetCityState("123 Main St, Apt 5B, Princeville, HI");
  check("Apt segment skipped → Princeville", e.city === "Princeville" && e.state === "HI");
  const f = parseStreetCityState("");
  check("empty address → all empty", f.street === "" && f.city === "" && f.state === "");
  const g = parseStreetCityState("500 Beach Rd, Kapaa");
  check("2-part street,city (no state) → city Kapaa", g.street === "500 Beach Rd" && g.city === "Kapaa");
}

console.log(`\naddress-parse: ${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, "address-parse tests failed");
