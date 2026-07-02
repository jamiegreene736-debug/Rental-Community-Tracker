// Locks the "estero" disambiguation: the Fort Myers Beach coastal refs (Estero Blvd /
// Island / Beach / Bay — Santa Maria Resort's own address) must NOT resolve to the
// inland Bonita National golf community, while the inland TOWN of Estero still does.
// Regression guard for the 2026-07-01 cowork buy-in mislabel.
import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";

const { resolveBuyInMarketFromText, resolveBuyInMarket } = await import("../shared/buy-in-market");
const { suggestPricingArea } = await import("../shared/pricing-rates");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("santamaria-geo: estero disambiguation (Fort Myers Beach vs inland Bonita National)");

// ── the incident: Santa Maria's own Estero Blvd address must NOT steal to Bonita National ──
check(
  "Santa Maria + '7317 Estero Blvd' → Santa Maria Resort (not Bonita National)",
  resolveBuyInMarketFromText("Santa Maria Resort, 7317 Estero Blvd, Fort Myers Beach, FL 33931") === "Santa Maria Resort",
  resolveBuyInMarketFromText("Santa Maria Resort, 7317 Estero Blvd, Fort Myers Beach, FL 33931"),
);
check("'Estero Blvd' alone does NOT resolve to Bonita National", resolveBuyInMarketFromText("A condo on Estero Blvd") !== "Bonita National");
check("'Estero Island' does NOT resolve to Bonita National", resolveBuyInMarketFromText("Estero Island getaway") !== "Bonita National");
check("'Estero Beach' does NOT resolve to Bonita National", resolveBuyInMarketFromText("Estero Beach villa") !== "Bonita National");
check(
  "resolveBuyInMarket(Santa Maria, FMB, '7317 Estero Blvd') → Santa Maria Resort",
  resolveBuyInMarket({ name: "Santa Maria Resort", city: "Fort Myers Beach", state: "Florida", streetAddress: "7317 Estero Blvd" }) === "Santa Maria Resort",
  resolveBuyInMarket({ name: "Santa Maria Resort", city: "Fort Myers Beach", state: "Florida", streetAddress: "7317 Estero Blvd" }),
);

// ── the inland TOWN of Estero is preserved → Bonita National ──
check("inland town 'Estero, FL' → Bonita National", resolveBuyInMarketFromText("Lovely place in Estero, FL 33928") === "Bonita National", resolveBuyInMarketFromText("Lovely place in Estero, FL 33928"));
check("bare 'Estero' → Bonita National", resolveBuyInMarketFromText("Estero") === "Bonita National");
check("Bonita National name still resolves", resolveBuyInMarketFromText("Bonita National Golf and Country Club") === "Bonita National");
check("Bonita Springs still resolves", resolveBuyInMarketFromText("Somewhere in Bonita Springs, FL") === "Bonita National");
check("Naples still resolves", resolveBuyInMarketFromText("Naples, FL condo") === "Bonita National");

// ── suggestPricingArea: town preserved; Fort Myers Beach not Bonita National ──
check("suggestPricingArea('Estero','FL') → Bonita National (town)", suggestPricingArea("Estero", "FL") === "Bonita National", suggestPricingArea("Estero", "FL"));
check("suggestPricingArea('Bonita Springs','FL') → Bonita National", suggestPricingArea("Bonita Springs", "FL") === "Bonita National");
check("suggestPricingArea('Estero Beach','FL') is NOT Bonita National", suggestPricingArea("Estero Beach", "FL") !== "Bonita National", suggestPricingArea("Estero Beach", "FL"));
check("suggestPricingArea('Fort Myers Beach','FL','Santa Maria Resort') is NOT Bonita National", suggestPricingArea("Fort Myers Beach", "FL", "Santa Maria Resort") !== "Bonita National", suggestPricingArea("Fort Myers Beach", "FL", "Santa Maria Resort"));

console.log(`\nsantamaria-geo: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
