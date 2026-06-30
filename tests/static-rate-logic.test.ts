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
  allInSeasonalBasis,
  allInNightlyFromComponents,
  grossUpRentToAllIn,
  reconcileChannelAllIn,
  computeSeasonWindows,
  clampedSeasonsAgainst,
  normalizeChannelKey,
  LODGING_TAX_PCT,
  CLEANING_FEE_ESTIMATE,
  ALL_IN_REFERENCE_NIGHTS,
  type StaticRateAnchors,
  type ChannelKey,
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

console.log("static-rate-logic: defaultStaticAnchors (now ALL-IN)");
{
  const a = defaultStaticAnchors("Poipu Kai", 3);
  const allIn = allInSeasonalBasis("Poipu Kai", 3);
  const rent = staticSeasonalBasis("Poipu Kai", 3);
  check("year1 equals the ALL-IN basis (not rent-only)", a.year1.LOW === allIn.LOW && a.year1.HIGH === allIn.HIGH, a.year1);
  check(
    "year2 grown by YoY growth off all-in",
    a.year2.LOW === Math.round(allIn.LOW * STATIC_RATE_YOY_GROWTH),
    a.year2,
  );
  // MENEHUNE REGRESSION LOCK: the fail-soft fallback must price ABOVE bare rent
  // (rent + cleaning + service + taxes), so the 15% markup is never applied to
  // rent-only numbers. All-in should be ~1.2×–1.5× the rent-only basis.
  check("all-in LOW > rent-only LOW", a.year1.LOW > rent.LOW, { allIn: a.year1.LOW, rent: rent.LOW });
  const ratio = a.year1.LOW / rent.LOW;
  check("all-in uplift is in the 1.2×–1.5× band", ratio >= 1.2 && ratio <= 1.5, ratio);
}

console.log("static-rate-logic: sanitizeSeasonAnchors");
{
  const basis = { LOW: 500, HIGH: 800, HOLIDAY: 1100 };
  // Absurd high value gets clamped to ≤ 3× basis.
  const s = sanitizeSeasonAnchors({ LOW: 480, HIGH: 99999, HOLIDAY: 1050 }, basis);
  check("absurd HIGH clamped to 3× basis", s.HIGH === Math.round(800 * 3), s);
  // Ordering re-asserted: HOLIDAY pulled up to ≥ HIGH.
  check("HOLIDAY >= HIGH after clamp", s.HOLIDAY >= s.HIGH, s);

  // Too-low value clamped up to 0.55× basis floor (raised from 0.4×).
  const low = sanitizeSeasonAnchors({ LOW: 1, HIGH: 800, HOLIDAY: 1100 }, basis);
  check("tiny LOW clamped to 0.55× basis floor", low.LOW === Math.round(500 * 0.55), low);

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

  // Claude web-verified the resort → confirmed even when non-curated and the
  // community key isn't literally in the label. This is the Ko Olina case.
  const claudeVerified = confirmResearchCommunity({
    community: "Coconut Plantation at Ko Olina",
    searchLabel: "Coconut Plantation at Ko Olina, Kapolei, Hawaii",
    expectedCity: "Kapolei",
    expectedState: "Hawaii",
    curated: false,
    claudeConfirmed: true,
    verifiedResort: "Marriott's Ko Olina Beach Club / Coconut Plantation",
    verifiedCity: "Kapolei",
    verifiedState: "Hawaii",
  });
  check("Claude-verified → confirmed", claudeVerified.confirmed === true, claudeVerified);
  check("claudeConfirmed flag set", claudeVerified.claudeConfirmed === true, claudeVerified);

  // Claude's verified city satisfies the location even if the label omits it.
  const verifiedCityOnly = confirmResearchCommunity({
    community: "Hidden Resort",
    searchLabel: "Hidden Resort vacation rental",
    expectedCity: "Koloa",
    expectedState: "Hawaii",
    curated: false,
    claudeConfirmed: true,
    verifiedCity: "Koloa",
    verifiedState: "Hawaii",
  });
  check("verified city/state satisfy location", verifiedCityOnly.locationMatch && verifiedCityOnly.confirmed, verifiedCityOnly);

  // Even Claude confirmation can't override a genuine location contradiction.
  const claudeButWrongState = confirmResearchCommunity({
    community: "Poipu Kai",
    searchLabel: "Poipu Kai, Louisiana",
    expectedCity: "Koloa",
    expectedState: "Hawaii",
    curated: true,
    claudeConfirmed: true,
    verifiedCity: "Baton Rouge",
    verifiedState: "Louisiana",
  });
  check("wrong state not overridden by claudeConfirmed", claudeButWrongState.confirmed === false, claudeButWrongState);
}

console.log("static-rate-logic: rates are STATIC per season per year (not per-month)");
{
  const anchors: StaticRateAnchors = {
    year1: { LOW: 400, HIGH: 700, HOLIDAY: 1000 },
    year2: { LOW: 420, HIGH: 720, HOLIDAY: 1050 },
  };
  const expanded = expandAnchorsToMonthlyRates(anchors, "Poipu Kai", ASOF, 24);
  // Group year-1 months (offset 0-11) by season; every LOW month must share ONE
  // value, every HIGH month one value, December (HOLIDAY) one value.
  const months = Object.keys(expanded).sort();
  const y1 = months.slice(0, 12);
  const lowVals = new Set(y1.filter((m) => expanded[m].season === "LOW").map((m) => expanded[m].medianNightly));
  const highVals = new Set(y1.filter((m) => expanded[m].season === "HIGH").map((m) => expanded[m].medianNightly));
  check("all year-1 LOW months share one static rate", lowVals.size <= 1 && (lowVals.size === 0 || lowVals.has(400)), [...lowVals]);
  check("all year-1 HIGH months share one static rate", highVals.size <= 1 && (highVals.size === 0 || highVals.has(700)), [...highVals]);
  // At most 3 distinct values per year (LOW/HIGH/HOLIDAY).
  const y1Distinct = new Set(y1.map((m) => expanded[m].medianNightly));
  check("year 1 has at most 3 distinct nightly rates", y1Distinct.size <= 3, [...y1Distinct]);
}

console.log("static-rate-logic: allInNightlyFromComponents (taxes + fees, 7-night amortized)");
{
  // VRBO HIGH 3BR: rent 950/n × 7 = 6650 + cleaning 285 + service 10% of (6650+285)
  // + HI tax 18% of (6650+285), all ÷ 7.
  const rent = 950, nights = 7, cleaning = 285, servicePct = 0.10, region = "hawaii" as const;
  const subtotal = rent * nights + cleaning; // 6935
  const expectedTotal = rent * nights + cleaning + subtotal * servicePct + subtotal * LODGING_TAX_PCT.hawaii;
  const expected = Math.round(expectedTotal / nights);
  const got = allInNightlyFromComponents({ rentNightly: rent, nights, cleaningPerStay: cleaning, serviceFeePct: servicePct, region });
  check("exact all-in math (HI, VRBO, 7 nights)", got === expected, { got, expected });
  check("all-in nightly exceeds bare rent", got > rent, got);

  // Florida tax rate differs.
  const fl = allInNightlyFromComponents({ rentNightly: 200, nights: 7, cleaningPerStay: 175, serviceFeePct: 0, region: "florida" });
  const flSub = 200 * 7 + 175;
  const flExpected = Math.round((200 * 7 + 175 + flSub * LODGING_TAX_PCT.florida) / 7);
  check("exact all-in math (FL, PM 0% service)", fl === flExpected, { fl, flExpected });

  // Longer min-stay amortizes the flat cleaning over more nights → lower nightly.
  const seven = allInNightlyFromComponents({ rentNightly: 500, nights: 7, cleaningPerStay: 350, serviceFeePct: 0, region: "hawaii" });
  const fourteen = allInNightlyFromComponents({ rentNightly: 500, nights: 14, cleaningPerStay: 350, serviceFeePct: 0, region: "hawaii" });
  check("longer stay amortizes cleaning lower", fourteen < seven, { seven, fourteen });

  // nights=0 guards to the 7-night reference, never divides by zero.
  const guarded = allInNightlyFromComponents({ rentNightly: 500, nights: 0, cleaningPerStay: 250, serviceFeePct: 0, region: "hawaii" });
  check("nights<=0 falls back to reference nights (finite)", Number.isFinite(guarded) && guarded > 0, guarded);
}

console.log("static-rate-logic: grossUpRentToAllIn + allInSeasonalBasis");
{
  const hi = grossUpRentToAllIn(500, "hawaii");
  const fl = grossUpRentToAllIn(500, "florida");
  check("HI gross-up > bare rent", hi > 500, hi);
  check("FL gross-up > bare rent", fl > 500, fl);
  check("HI gross-up > FL gross-up (higher tax)", hi > fl, { hi, fl });
  check("cleaning estimate amortized in (matches /7 component)", CLEANING_FEE_ESTIMATE.hawaii / ALL_IN_REFERENCE_NIGHTS > 0);

  // allInSeasonalBasis grosses up EACH rent-only season.
  const rent = staticSeasonalBasis("Poipu Kai", 3);
  const allIn = allInSeasonalBasis("Poipu Kai", 3);
  check("all-in LOW > rent LOW", allIn.LOW > rent.LOW, { allIn, rent });
  check("all-in HIGH > rent HIGH", allIn.HIGH > rent.HIGH);
  check("all-in HOLIDAY > rent HOLIDAY", allIn.HOLIDAY > rent.HOLIDAY);
  check("all-in keeps LOW < HIGH < HOLIDAY", allIn.LOW < allIn.HIGH && allIn.HIGH < allIn.HOLIDAY, allIn);
}

console.log("static-rate-logic: reconcileChannelAllIn");
{
  type Row = { channel: ChannelKey; rentNightly: number; allInNightly: number; feesObserved: boolean };
  const rentBasis = 500;

  // Two credible channels close together → cheapest wins.
  const a = reconcileChannelAllIn(
    [
      { channel: "vrbo", rentNightly: 520, allInNightly: 700, feesObserved: true },
      { channel: "airbnb", rentNightly: 540, allInNightly: 740, feesObserved: true },
    ] as Row[],
    rentBasis,
  );
  check("lowest credible chosen", a.chosen === 700 && a.channel === "vrbo", a);
  check("spread reported", a.spread.n === 2 && a.spread.min === 700 && a.spread.max === 740, a.spread);

  // A too-cheap, fees-NOT-observed row whose rent is < 0.5× basis = teaser → dropped.
  const b = reconcileChannelAllIn(
    [
      { channel: "booking", rentNightly: 200, allInNightly: 260, feesObserved: false }, // 200 < 250 → teaser
      { channel: "vrbo", rentNightly: 520, allInNightly: 705, feesObserved: true },
    ] as Row[],
    rentBasis,
  );
  check("teaser dropped, real channel chosen", b.chosen === 705 && b.dropped.some((d) => /teaser/.test(d)), b);

  // Cheapest >15% below 2nd-cheapest → use 2nd-cheapest (don't price into a loss).
  const c = reconcileChannelAllIn(
    [
      { channel: "pm", rentNightly: 480, allInNightly: 500, feesObserved: true }, // 500 < 0.85×680=578
      { channel: "vrbo", rentNightly: 560, allInNightly: 680, feesObserved: true },
      { channel: "airbnb", rentNightly: 600, allInNightly: 760, feesObserved: true },
    ] as Row[],
    rentBasis,
  );
  check("cheapest >15% below 2nd → 2nd-cheapest used", c.chosen === 680 && /second-cheapest/.test(c.rule), c);

  // Tie-break within 5%: prefer higher-trust channel (PM over VRBO).
  const d = reconcileChannelAllIn(
    [
      { channel: "vrbo", rentNightly: 520, allInNightly: 700, feesObserved: true },
      { channel: "pm", rentNightly: 520, allInNightly: 712, feesObserved: true }, // within 5% of 700
    ] as Row[],
    rentBasis,
  );
  check("tie-break prefers PM over VRBO", d.channel === "pm" && /tie-break/.test(d.rule), d);

  // No credible rows → null chosen.
  const e = reconcileChannelAllIn([], rentBasis);
  check("no evidence → chosen null", e.chosen === null && e.channel === null, e);
}

console.log("static-rate-logic: computeSeasonWindows");
{
  const w = computeSeasonWindows(new Date(2026, 5, 30), "hawaii"); // 2026-06-30
  check("6 windows (3 seasons × 2 years)", w.length === 6, w.length);
  const y1High = w.find((x) => x.season === "HIGH" && x.year === 1)!;
  const y1Low = w.find((x) => x.season === "LOW" && x.year === 1)!;
  const y1Hol = w.find((x) => x.season === "HOLIDAY" && x.year === 1)!;
  check("HIGH window is mid-July", /-07-/.test(y1High.checkIn), y1High);
  check("LOW window is mid-September", /-09-/.test(y1Low.checkIn), y1Low);
  check("HOLIDAY window is late December", /-12-/.test(y1Hol.checkIn), y1Hol);
  const nights = (ci: string, co: string) => (new Date(co).getTime() - new Date(ci).getTime()) / 86400000;
  check("each window is 7 nights", w.every((x) => nights(x.checkIn, x.checkOut) === ALL_IN_REFERENCE_NIGHTS), w.map((x) => nights(x.checkIn, x.checkOut)));
  const y2High = w.find((x) => x.season === "HIGH" && x.year === 2)!;
  check("year 2 HIGH is year 1 HIGH + 1 year", Number(y2High.checkIn.slice(0, 4)) === Number(y1High.checkIn.slice(0, 4)) + 1, { y1: y1High.checkIn, y2: y2High.checkIn });
}

console.log("static-rate-logic: clampedSeasonsAgainst");
{
  const basis = { LOW: 600, HIGH: 1000, HOLIDAY: 1400 };
  // 1.4× basis survives (in band); 0.5× below floor (0.55); 4× above ceiling (3).
  const flagged = clampedSeasonsAgainst({ LOW: Math.round(600 * 1.4), HIGH: Math.round(1000 * 0.5), HOLIDAY: Math.round(1400 * 4) }, basis, "Y1");
  check("in-band LOW not flagged", !flagged.includes("Y1 LOW"), flagged);
  check("below-floor HIGH flagged", flagged.includes("Y1 HIGH"), flagged);
  check("above-ceiling HOLIDAY flagged", flagged.includes("Y1 HOLIDAY"), flagged);
}

console.log("static-rate-logic: clamp uses the ALL-IN basis (legit all-in survives)");
{
  // A legitimate all-in holiday rate ~2.2× the all-in basis must NOT be clamped
  // (it's under the 3× ceiling), but a 4× outlier is capped.
  const allIn = allInSeasonalBasis("Poipu Kai", 3);
  const legit = Math.round(allIn.HOLIDAY * 2.2);
  const sane = sanitizeAnchors(
    { year1: { LOW: allIn.LOW, HIGH: allIn.HIGH, HOLIDAY: legit }, year2: { LOW: allIn.LOW, HIGH: allIn.HIGH, HOLIDAY: legit } },
    allIn,
  );
  check("legit 2.2× all-in holiday survives clamp", sane.year1.HOLIDAY === legit, { legit, got: sane.year1.HOLIDAY });
  const outlier = sanitizeAnchors(
    { year1: { LOW: allIn.LOW, HIGH: allIn.HIGH, HOLIDAY: allIn.HOLIDAY * 4 }, year2: { LOW: allIn.LOW, HIGH: allIn.HIGH, HOLIDAY: allIn.HOLIDAY * 4 } },
    allIn,
  );
  check("4× outlier holiday capped at 3× all-in basis", outlier.year1.HOLIDAY === Math.round(allIn.HOLIDAY * 3), outlier.year1.HOLIDAY);
}

console.log("static-rate-logic: normalizeChannelKey");
{
  check("VRBO → vrbo", normalizeChannelKey("VRBO") === "vrbo");
  check("Booking.com → booking", normalizeChannelKey("Booking.com") === "booking");
  check("Airbnb → airbnb", normalizeChannelKey("airbnb") === "airbnb");
  check("property manager → pm", normalizeChannelKey("Property Manager direct") === "pm");
  check("resort site → resort", normalizeChannelKey("resort official site") === "resort");
  check("unknown → other", normalizeChannelKey("some travel blog") === "other");
}

console.log(`\nstatic-rate-logic: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
