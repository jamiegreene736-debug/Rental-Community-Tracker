import {
  staticSeasonalBasis,
  defaultStaticAnchors,
  sanitizeSeasonAnchors,
  sanitizeAnchors,
  mergeLockedAnchors,
  staticSeasonForMonth,
  staticRateWindowMonths,
  expandAnchorsToMonthlyRates,
  seasonColumnsFromAnchors,
  confirmResearchCommunity,
  STATIC_RATE_YOY_GROWTH,
  type StaticRateAnchors,
} from "../shared/static-rate-logic";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`, extra ?? "");
  }
};

const ASOF = new Date(2026, 5, 1); // 2026-06-01 (local) — month index 5 = June

console.log("static-rate-logic: staticSeasonalBasis");
{
  // Poipu Kai 3BR baseline 636, Hawaii multipliers LOW 0.80 / HIGH 1.30 / HOLIDAY 1.80.
  const basis = staticSeasonalBasis("Poipu Kai", 3);
  check("LOW = baseline × 0.80", basis.LOW === Math.round(636 * 0.8), basis);
  check("HIGH = baseline × 1.30", basis.HIGH === Math.round(636 * 1.3), basis);
  check("HOLIDAY = baseline × 1.80", basis.HOLIDAY === Math.round(636 * 1.8), basis);
  check("ordering LOW < HIGH < HOLIDAY", basis.LOW < basis.HIGH && basis.HIGH < basis.HOLIDAY);

  // Unknown community/bedroom falls back per region (hawaii default 270/BR).
  const fb = staticSeasonalBasis("Totally Unknown Resort", 2);
  check("fallback uses 270/BR hawaii default", fb.LOW === Math.round(270 * 2 * 0.8), fb);

  // Florida community uses florida multipliers + 80/BR fallback.
  const fl = staticSeasonalBasis("Florida Generic", 3);
  check("florida fallback uses 80/BR + 0.75 LOW", fl.LOW === Math.round(80 * 3 * 0.75), fl);
}

console.log("static-rate-logic: defaultStaticAnchors");
{
  const a = defaultStaticAnchors("Poipu Kai", 3);
  const basis = staticSeasonalBasis("Poipu Kai", 3);
  check("year1 equals static basis", a.year1.LOW === basis.LOW && a.year1.HIGH === basis.HIGH);
  check(
    "year2 grown by YoY growth",
    a.year2.LOW === Math.round(basis.LOW * STATIC_RATE_YOY_GROWTH),
    a.year2,
  );
}

console.log("static-rate-logic: sanitizeSeasonAnchors");
{
  const basis = { LOW: 500, HIGH: 800, HOLIDAY: 1100 };
  // Absurd high value gets clamped to ≤ 3× basis.
  const s = sanitizeSeasonAnchors({ LOW: 480, HIGH: 99999, HOLIDAY: 1050 }, basis);
  check("absurd HIGH clamped to 3× basis", s.HIGH === Math.round(800 * 3), s);
  // Ordering re-asserted: HOLIDAY pulled up to ≥ HIGH.
  check("HOLIDAY >= HIGH after clamp", s.HOLIDAY >= s.HIGH, s);

  // Too-low value clamped up to 0.4× basis floor.
  const low = sanitizeSeasonAnchors({ LOW: 1, HIGH: 800, HOLIDAY: 1100 }, basis);
  check("tiny LOW clamped to 0.4× basis floor", low.LOW === Math.round(500 * 0.4), low);

  // Inverted input (LOW > HIGH) gets corrected.
  const inv = sanitizeSeasonAnchors({ LOW: 700, HIGH: 600, HOLIDAY: 650 }, basis);
  check("inverted LOW>HIGH corrected", inv.HIGH >= inv.LOW && inv.HOLIDAY >= inv.HIGH, inv);
}

console.log("static-rate-logic: sanitizeAnchors year-2 band");
{
  const basis = { LOW: 500, HIGH: 800, HOLIDAY: 1100 };
  const out = sanitizeAnchors(
    { year1: { LOW: 500, HIGH: 800, HOLIDAY: 1100 }, year2: { LOW: 9999, HIGH: 800, HOLIDAY: 1100 } },
    basis,
  );
  check("year2 LOW banded to ≤ 1.2× year1", out.year2.LOW <= Math.round(out.year1.LOW * 1.2), out);
  check("year2 LOW banded to ≥ 0.95× year1", out.year2.LOW >= Math.round(out.year1.LOW * 0.95), out);
}

console.log("static-rate-logic: mergeLockedAnchors");
{
  const generated: StaticRateAnchors = {
    year1: { LOW: 400, HIGH: 700, HOLIDAY: 1000 },
    year2: { LOW: 420, HIGH: 720, HOLIDAY: 1020 },
  };
  const prior: StaticRateAnchors = {
    year1: { LOW: 555, HIGH: 777, HOLIDAY: 999 },
    year2: { LOW: 560, HIGH: 780, HOLIDAY: 1010 },
  };
  const merged = mergeLockedAnchors(generated, { year1: { LOW: true } }, prior);
  check("locked year1 LOW keeps prior value", merged.year1.LOW === 555, merged);
  check("unlocked year1 HIGH takes generated value", merged.year1.HIGH === 700, merged);
  check("unlocked year2 untouched by year1 lock", merged.year2.LOW === 420, merged);
  check("no locks → generated unchanged", mergeLockedAnchors(generated, undefined, prior) === generated);
}

console.log("static-rate-logic: staticSeasonForMonth");
{
  check("December → HOLIDAY (hawaii)", staticSeasonForMonth("2026-12", "hawaii") === "HOLIDAY");
  check("December → HOLIDAY (florida)", staticSeasonForMonth("2026-12", "florida") === "HOLIDAY");
  // 2026-05 is LOW in the Hawaii map, 2026-07 is HIGH.
  check("May → LOW (hawaii map)", staticSeasonForMonth("2026-05", "hawaii") === "LOW");
  check("July → HIGH (hawaii map)", staticSeasonForMonth("2026-07", "hawaii") === "HIGH");
}

console.log("static-rate-logic: staticRateWindowMonths");
{
  const months = staticRateWindowMonths(ASOF, 24);
  check("24 months", months.length === 24, months.length);
  check("starts at asOf month", months[0] === "2026-06", months[0]);
  check("rolls forward 24 months", months[23] === "2028-05", months[23]);
  check("unique months", new Set(months).size === 24);
}

console.log("static-rate-logic: expandAnchorsToMonthlyRates");
{
  const anchors: StaticRateAnchors = {
    year1: { LOW: 400, HIGH: 700, HOLIDAY: 1000 },
    year2: { LOW: 420, HIGH: 720, HOLIDAY: 1050 },
  };
  const expanded = expandAnchorsToMonthlyRates(anchors, "Poipu Kai", ASOF, 24);
  check("24 month entries", Object.keys(expanded).length === 24);
  // 2026-07 is HIGH year1.
  check("year1 HIGH month uses year1.HIGH", expanded["2026-07"].medianNightly === 700, expanded["2026-07"]);
  // 2026-12 is HOLIDAY year1.
  check("year1 December uses year1.HOLIDAY", expanded["2026-12"].medianNightly === 1000, expanded["2026-12"]);
  // 2027-12 is HOLIDAY year2.
  check("year2 December uses year2.HOLIDAY", expanded["2027-12"].medianNightly === 1050, expanded["2027-12"]);
  // 2027-08 is HIGH year2 (offset 14 ≥ 12).
  check("year2 HIGH month uses year2.HIGH", expanded["2027-08"].medianNightly === 720, expanded["2027-08"]);
  check("every entry tagged claude-static", Object.values(expanded).every((e) => e.source === "claude-static"));
  check("every entry has a season", Object.values(expanded).every((e) => !!e.season));
}

console.log("static-rate-logic: seasonColumnsFromAnchors");
{
  const cols = seasonColumnsFromAnchors({
    year1: { LOW: 400, HIGH: 700, HOLIDAY: 1000 },
    year2: { LOW: 420, HIGH: 720, HOLIDAY: 1050 },
  });
  check("columns come from year1", cols.low === 400 && cols.high === 700 && cols.holiday === 1000, cols);
}

console.log("static-rate-logic: confirmResearchCommunity");
{
  // Curated positive property: searchLabel carries resort + city + state.
  const ok = confirmResearchCommunity({
    community: "Poipu Kai",
    searchLabel: "Poipu Kai Resort, Koloa, Kauai, Hawaii",
    expectedCity: "Koloa",
    expectedState: "Hawaii",
    curated: true,
  });
  check("curated match → confirmed", ok.confirmed === true, ok);
  check("name + city + state all matched", ok.nameMatch && ok.cityMatch && ok.stateMatch, ok);

  // State abbreviation alias: draft stores "HI", label says "Hawaii".
  const abbrev = confirmResearchCommunity({
    community: "Poipu Kai",
    searchLabel: "Poipu Kai Resort, Koloa, Hawaii",
    expectedCity: "Koloa",
    expectedState: "HI",
    curated: true,
  });
  check("state abbrev HI matches Hawaii", abbrev.stateMatch && abbrev.confirmed, abbrev);

  // Wrong state (the Baton Rouge-LA vs Kauai-HI class of bug): not confirmed.
  const wrongState = confirmResearchCommunity({
    community: "Poipu Kai",
    searchLabel: "Charming Baton Rouge Retreat, Baton Rouge, Louisiana",
    expectedCity: "Koloa",
    expectedState: "Hawaii",
    curated: true,
  });
  check("wrong state → not confirmed", wrongState.confirmed === false, wrongState);
  check("wrong state → stateMatch false", wrongState.stateMatch === false, wrongState);

  // Draft whose listing name doesn't contain the community key but location
  // matches and community is curated → still confirmed (location is the guard).
  const draftCurated = confirmResearchCommunity({
    community: "Kapaa Beachfront",
    searchLabel: "Sunny Condo on the Sand, Kapaa, HI",
    expectedCity: "Kapaa",
    expectedState: "HI",
    curated: true,
  });
  check("curated draft confirms on location", draftCurated.confirmed === true, draftCurated);
  check("name not literally matched there", draftCurated.nameMatch === false, draftCurated);

  // Non-curated draft, name absent → not confirmed (operator should verify).
  const nonCurated = confirmResearchCommunity({
    community: "Some Unknown Resort",
    searchLabel: "Beach House, Kapaa, HI",
    expectedCity: "Kapaa",
    expectedState: "HI",
    curated: false,
  });
  check("non-curated, no name match → not confirmed", nonCurated.confirmed === false, nonCurated);
  check("location still matched on non-curated", nonCurated.locationMatch === true, nonCurated);
}

console.log(`\nstatic-rate-logic: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
