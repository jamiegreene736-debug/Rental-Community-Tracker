// Tests for the city-scan coverage summary. The load-bearing case: the operator
// saw VRBO's destination count (Koloa = 144, all bedroom counts) vs the tracker's
// "82 listings" and read it as missing inventory — when the sidecar actually
// harvested 142/144 and the 82 is the (correct) >=2BR + priced subset.
import {
  buildCityScanCoverage,
  vrboReportedTotalFromMapHarvest,
  COVERAGE_COMPLETE_RATIO,
} from "../shared/city-vrbo-coverage";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("city-vrbo-coverage: found-vs-usable-vs-VRBO-total + completeness");

// ── THE Koloa case: 142 harvested of 144, 82 usable (≥2BR), 55+5 excluded ────
{
  const c = buildCityScanCoverage({ rawHarvested: 142, usable: 82, droppedBelowMinBedrooms: 55, droppedNoPrice: 5, vrboReportedTotal: 144 });
  check("Koloa: 142/144 harvested → looksComplete (not missing inventory)",
    c.looksComplete && c.rawHarvested === 142 && c.usable === 82 && c.vrboReportedTotal === 144, c);
  check("Koloa: 142 − 55 − 5 = 82 usable accounts for the 144→82 gap",
    c.rawHarvested - c.droppedBelowMinBedrooms - c.droppedNoPrice === c.usable, c);
}

// ── completeness threshold (0.9 of VRBO total) ───────────────────────────────
check("ratio is 0.9", COVERAGE_COMPLETE_RATIO === 0.9);
{
  // floor(0.9 * 144) = 129
  const atThreshold = buildCityScanCoverage({ rawHarvested: 129, usable: 70, droppedBelowMinBedrooms: 50, droppedNoPrice: 9, vrboReportedTotal: 144 });
  const belowThreshold = buildCityScanCoverage({ rawHarvested: 128, usable: 70, droppedBelowMinBedrooms: 50, droppedNoPrice: 8, vrboReportedTotal: 144 });
  check("129/144 (>=floor(0.9·144)=129) → complete", atThreshold.looksComplete, atThreshold);
  check("128/144 (<129) → INCOMPLETE (real under-harvest flagged)", !belowThreshold.looksComplete, belowThreshold);
}
{
  // a genuine pagination shortfall like the bug class this guards against
  const shortfall = buildCityScanCoverage({ rawHarvested: 82, usable: 60, droppedBelowMinBedrooms: 20, droppedNoPrice: 2, vrboReportedTotal: 144 });
  check("82/144 → INCOMPLETE (would surface the ⚠ warning)", !shortfall.looksComplete, shortfall);
}

// ── unknown / unreliable total → never false-alarm (treat as complete) ───────
check("unknown total (null) → looksComplete",
  buildCityScanCoverage({ rawHarvested: 10, usable: 5, droppedBelowMinBedrooms: 5, droppedNoPrice: 0, vrboReportedTotal: null }).looksComplete);
check("total 0 → treated as unknown → looksComplete + vrboReportedTotal null", (() => {
  const c = buildCityScanCoverage({ rawHarvested: 10, usable: 5, droppedBelowMinBedrooms: 5, droppedNoPrice: 0, vrboReportedTotal: 0 });
  return c.looksComplete && c.vrboReportedTotal === null;
})());

// ── empty / offline scan → all zero, complete (no false alarm) ───────────────
{
  const c = buildCityScanCoverage({ rawHarvested: 0, usable: 0, droppedBelowMinBedrooms: 0, droppedNoPrice: 0, vrboReportedTotal: null });
  check("empty scan → zeros + looksComplete", c.rawHarvested === 0 && c.usable === 0 && c.looksComplete, c);
}

// ── garbage inputs coerce safely ─────────────────────────────────────────────
{
  const c = buildCityScanCoverage({ rawHarvested: NaN as unknown as number, usable: -3, droppedBelowMinBedrooms: NaN as unknown as number, droppedNoPrice: 2.7, vrboReportedTotal: NaN as unknown as number });
  check("garbage coerces: rawHarvested 0, usable 0, vrboReportedTotal null",
    c.rawHarvested === 0 && c.usable === 0 && c.vrboReportedTotal === null && c.droppedNoPrice === 3, c);
}

// ── vrboReportedTotalFromMapHarvest ──────────────────────────────────────────
check("mapHarvest {graphqlTotalCount:144} → 144", vrboReportedTotalFromMapHarvest({ graphqlTotalCount: 144 }) === 144);
check("mapHarvest {graphqlTotalCount:'144'} → 144 (coerced)", vrboReportedTotalFromMapHarvest({ graphqlTotalCount: "144" }) === 144);
check("mapHarvest {graphqlTotalCount:0} → null", vrboReportedTotalFromMapHarvest({ graphqlTotalCount: 0 }) === null);
check("mapHarvest null → null", vrboReportedTotalFromMapHarvest(null) === null);
check("mapHarvest {} → null", vrboReportedTotalFromMapHarvest({}) === null);

// ── HomeToGo source completeness (mirrors the VRBO reconciliation) ───────────
console.log("\ncity-vrbo-coverage: HomeToGo feed-total reconciliation");

// VRBO-only call site (HomeToGo did NOT run — harvestComplete undefined) → n/a, complete.
{
  const c = buildCityScanCoverage({ rawHarvested: 142, usable: 82, droppedBelowMinBedrooms: 55, droppedNoPrice: 5, vrboReportedTotal: 144 });
  check("no HomeToGo args → hometogoReportedTotal null, raw 0, looksComplete true (n/a, back-compat)",
    c.hometogoReportedTotal === null && c.hometogoRawHarvested === 0 && c.hometogoLooksComplete === true, c);
}
// Feed total known, pulled >= 90%, cut off → still complete (we got effectively all).
{
  const c = buildCityScanCoverage({ rawHarvested: 0, usable: 0, droppedBelowMinBedrooms: 0, droppedNoPrice: 0, vrboReportedTotal: null,
    hometogoReportedTotal: 100, hometogoRawHarvested: 92, hometogoHarvestComplete: false });
  check("HTG 92/100 + cutoff (>=floor(0.9·100)=90) → hometogoLooksComplete", c.hometogoLooksComplete && c.hometogoReportedTotal === 100, c);
}
// Feed total known, pulled < 90%, harvest cut off by budget → INCOMPLETE (the flag).
{
  const c = buildCityScanCoverage({ rawHarvested: 0, usable: 0, droppedBelowMinBedrooms: 0, droppedNoPrice: 0, vrboReportedTotal: null,
    hometogoReportedTotal: 100, hometogoRawHarvested: 60, hometogoHarvestComplete: false });
  check("HTG 60/100 + budget cutoff → INCOMPLETE (truncation flagged)", !c.hometogoLooksComplete, c);
}
// Plateau (results UI exhausted) below a huge all-provider feed total → complete (the common
// big-metro case: feed says ~1500, the UI only serves a few hundred, we got them all).
{
  const c = buildCityScanCoverage({ rawHarvested: 0, usable: 0, droppedBelowMinBedrooms: 0, droppedNoPrice: 0, vrboReportedTotal: null,
    hometogoReportedTotal: 1503, hometogoRawHarvested: 300, hometogoHarvestComplete: true });
  check("HTG 300/1503 but harvestComplete (plateau) → complete (UI exhausted, not a miss)", c.hometogoLooksComplete, c);
}
// Ran + cut off (harvestComplete=false) with NO exposed feed total → possibly-truncated → INCOMPLETE.
{
  const c = buildCityScanCoverage({ rawHarvested: 0, usable: 0, droppedBelowMinBedrooms: 0, droppedNoPrice: 0, vrboReportedTotal: null,
    hometogoReportedTotal: null, hometogoRawHarvested: 12, hometogoHarvestComplete: false });
  check("HTG unknown total + cutoff → INCOMPLETE (a cutoff is itself truncation evidence)",
    !c.hometogoLooksComplete && c.hometogoReportedTotal === null, c);
}
// Ran + plateau with NO exposed feed total → complete (no false alarm: UI was exhausted).
{
  const c = buildCityScanCoverage({ rawHarvested: 0, usable: 0, droppedBelowMinBedrooms: 0, droppedNoPrice: 0, vrboReportedTotal: null,
    hometogoReportedTotal: null, hometogoRawHarvested: 28, hometogoHarvestComplete: true });
  check("HTG unknown total + plateau → complete (no false alarm)", c.hometogoLooksComplete, c);
}
// Feed total 0 / garbage coerces to null; with a plateau stop → complete.
{
  const c = buildCityScanCoverage({ rawHarvested: 0, usable: 0, droppedBelowMinBedrooms: 0, droppedNoPrice: 0, vrboReportedTotal: null,
    hometogoReportedTotal: 0, hometogoRawHarvested: NaN as unknown as number, hometogoHarvestComplete: true });
  check("HTG feed total 0 → null + raw coerces to 0 + (plateau) complete",
    c.hometogoReportedTotal === null && c.hometogoRawHarvested === 0 && c.hometogoLooksComplete, c);
}

console.log(`\ncity-vrbo-coverage: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
