// License sample ↔ placeholder-detector sync + county STR format recall
// (2026-07-10).
//
// Three guarantees locked here:
//   1. EVERY value the sample generator (shared/license-samples.ts) can
//      emit — plus the legacy/static demo families checked into
//      unit-builder-data.ts — is recognized by isPlaceholderLicenseValue,
//      so push-compliance can never send a filler license to Guesty/OTAs
//      as real. (Before this, the two lists drifted: "TA-026-780-7890-01"
//      etc. were treated as real licenses.)
//   2. Real-shaped license values are NOT flagged — a false positive here
//      would block pushing an operator's actual license.
//   3. The Hawaii STR extraction pattern recognizes the formats counties
//      actually issue (Big Island STVR-19-####, Maui ST<region>YYYYNNNN,
//      Kauai TVNC #NNNN) so Guesty/public-page pulls can capture them,
//      and the Maui Approved-STRH-list registry parser/matcher works.
import {
  allKnownSampleLicenseValues,
  LEGACY_SAMPLE_LICENSE_VALUES,
  SAMPLE_PROBE_LOCATIONS,
  sampleLicensesForLocation,
} from "../shared/license-samples";
import { isPlaceholderLicenseValue, usableLicenseValue } from "../shared/license-compliance";
import {
  extractHawaiiComplianceFromPublicText,
  matchMauiStrhPermit,
  pairHawaiiTaxLicense,
  parseMauiStrhPdfText,
} from "../server/hawaii-compliance-lookup";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("license-compliance-samples: generator/detector sync + county STR formats");

// ── 1. Every generatable sample is a recognized placeholder ────────────────
{
  const contexts = [undefined, { propertyType: "Condominium" }, { propertyType: "House" }];
  const misses: string[] = [];
  for (const probe of SAMPLE_PROBE_LOCATIONS) {
    for (const context of contexts) {
      const merged = context ? { ...probe.context, ...context } : probe.context;
      const samples = sampleLicensesForLocation(probe.city, probe.state, merged);
      for (const [field, value] of Object.entries(samples)) {
        if (!isPlaceholderLicenseValue(value)) misses.push(`${probe.city},${probe.state} ${field}=${value}`);
      }
    }
  }
  check("every generated sample (all probes × contexts) is flagged as placeholder", misses.length === 0, misses);
  check("enumerated sample set is non-trivial", allKnownSampleLicenseValues().size > 30, allKnownSampleLicenseValues().size);
}

// ── 2. Legacy + static demo values stay flagged forever ────────────────────
{
  const legacyMisses = LEGACY_SAMPLE_LICENSE_VALUES.filter((value) => !isPlaceholderLicenseValue(value));
  check("every LEGACY_SAMPLE_LICENSE_VALUES entry is flagged", legacyMisses.length === 0, legacyMisses);

  // Spot-lock the exact families checked into unit-builder-data.ts —
  // suffix variants of the filler tax cores and the static demo TMKs/permits.
  const staticDemoValues = [
    "TA-023-450-1234-02", "GE-023-450-1234-08", "TA-026-780-7890-02",
    "GE-024-120-9012-02", "TA-022-410-5678-01", "GE-023-910-6789-02",
    "TA-024-630-2345-01", "GE-026-840-8901-01",
    "420150040002", "450040020001", "370110070001",
    "TVR-2021-031", "TVR-2023-075", "TVNC-0218", "TVNC-0342",
    "STVR-2019-003461", "STVR-19-3461", "STVR-19-3462",
    "STRH-20240042", "NUC-24-001-0134", "NUC-89-0134",
    "STKM20190012", "STWM20180034", "STRH20190012",
    "Osceola County TDT Acct # 4502187", "LBTR-548291", "49-8013575941-1",
    "CND7053894", "DWE6841273",
  ];
  const staticMisses = staticDemoValues.filter((value) => !isPlaceholderLicenseValue(value));
  check("static unit-builder-data demo values are flagged", staticMisses.length === 0, staticMisses);

  // usableLicenseValue is the push-compliance gate — samples must null out.
  check("usableLicenseValue nulls a generated sample", usableLicenseValue("TA-026-780-7890-01") === null);
  check("usableLicenseValue nulls a static demo TMK", usableLicenseValue("420150040002") === null);
  // Pairing a sample core must not resurrect it as the sibling license.
  check("paired GE from a sample TA core stays null", pairHawaiiTaxLicense("TA-023-450-1234-05", "getLicense") === null);
  check("paired GE from a real TA core survives", pairHawaiiTaxLicense("TA-042-123-8571-01", "getLicense") === "GE-042-123-8571-01");
}

// ── 3. Real-shaped values are NOT flagged (false-positive guard) ───────────
{
  const realValues = [
    "TA-042-123-8571-01", "GE-115-270-6048-02",   // non-filler cores
    "428014033000", "239004017005",                // real-shaped TMKs
    "STVR-19-368", "NUC-19-407",                   // Big Island real formats
    "STKM20120001", "STWM20180099", "STHA20130003",// Maui real permits
    "TVNC-1317", "TVR-2020-101",                   // Kauai real-shaped
    "CND2301456", "DWE1035782", "39-8012345670-8", // Florida real-shaped
  ];
  const falsePositives = realValues.filter((value) => isPlaceholderLicenseValue(value));
  check("real-shaped values are not flagged", falsePositives.length === 0, falsePositives);
}

// ── 4. STR extraction recognizes real county formats ───────────────────────
{
  const bigIsland = extractHawaiiComplianceFromPublicText("Registered permit STVR-19-368 with Hawaii County.");
  check("extracts Big Island STVR-19-### format", bigIsland.strPermit === "STVR-19-368", bigIsland.strPermit);

  const bigIslandLegacy = extractHawaiiComplianceFromPublicText("Certificate STVR-2020-001234 on record.");
  check("legacy STVR-YYYY-###### format still extracts", bigIslandLegacy.strPermit === "STVR-2020-001234", bigIslandLegacy.strPermit);

  const maui = extractHawaiiComplianceFromPublicText("Maui STRH Permit No. STKM20120001 posted on the listing.");
  check("extracts Maui ST<region>YYYYNNNN format", maui.strPermit === "STKM20120001", maui.strPermit);

  const mauiWest = extractHawaiiComplianceFromPublicText("Permit STWM-20180099 (West Maui).");
  check("extracts dashed Maui region permit", mauiWest.strPermit === "STWM-20180099", mauiWest.strPermit);

  const kauaiHash = extractHawaiiComplianceFromPublicText("Operates under TVNC #1317 per the county registry.");
  check("extracts Kauai 'TVNC #NNNN' rendering", kauaiHash.strPermit === "TVNC #1317", kauaiHash.strPermit);

  const oahuLong = extractHawaiiComplianceFromPublicText("Nonconforming Use Certificate NUC-22-001-0134.");
  check("long NUC format is not truncated by the short alternative", oahuLong.strPermit === "NUC-22-001-0134", oahuLong.strPermit);

  const oahuShort = extractHawaiiComplianceFromPublicText("Certificate NUC-90-0107 renewed annually.");
  check("extracts short NUC-##-#### format", oahuShort.strPermit === "NUC-90-0107", oahuShort.strPermit);

  // Sample-shaped permits appearing in public text must still be rejected.
  const sampleInText = extractHawaiiComplianceFromPublicText("Permit STVR-19-3461 (demo).");
  check("a sample permit found in public text is rejected", sampleInText.strPermit === null, sampleInText.strPermit);
}

// ── 5. Maui Approved-STRH-list parser + TMK matcher ────────────────────────
{
  // Fixture mirrors the county PDF's pdf-parse rendering: permit + name +
  // 13-digit TMK + per-row file number + rooms/dwellings digits glued onto
  // the street number + town glued onto the street.
  const fixture = [
    "Kihei-Makena Community Plan Region - Limited to 46 permits",
    "Permit NumberNameTMKAddressTownRoomsDwellings",
    "STKM20120001HALE ALANA2210170400000-4059 3 13378 KEHA DRIVE 5KKIHEI",
    "1.",
    "STKM20120002MAKENA COTTAGE2210070060000-2123 3 25232 MAKENA RDKIHEI",
    "2.",
    "STHA20130006HALE NOA STRH2130090910000-799 2 1175 ULAINO RD 8EHANA",
    "3.",
    "STWM20180034WRAPPED NAME EXAMPLE",
    "2440050110000-101 2 1123 FRONT STLAHAINA",
    "4.",
    "STLA20160002",
    "DREAMS COME TRUE ON LANAI SHORT-TERM RENTAL",
    "HOME",
    "2490130270000-51324 4 11168 LANAI AVELANAI CITY",
    "5.",
  ].join("\n");
  const records = parseMauiStrhPdfText(fixture);
  check("parses all five fixture permits", records.length === 5, records.map((r) => r.permitNumber));
  check("permit + TMK + name parsed", records[0]?.permitNumber === "STKM20120001" && records[0]?.tmkKey === "2210170400000" && records[0]?.name === "HALE ALANA", records[0]);
  check("wrapped row joins its TMK line", records[3]?.permitNumber === "STWM20180034" && records[3]?.tmkKey === "2440050110000", records[3]);
  check("two-line-wrapped name joins to its TMK line", records[4]?.permitNumber === "STLA20160002" && records[4]?.tmkKey === "2490130270000", records[4]);
  // A property NAME containing the word "STRH" glued to the TMK (e.g.
  // "HALE NOA STRH2130090910000…") must not corrupt the parse.
  check("name containing 'STRH' glued to TMK parses cleanly", records[2]?.tmkKey === "2130090910000" && records[2]?.name === "HALE NOA STRH", records[2]);

  // 12-digit statewide-GIS TMK shares the 9-digit root with the PDF's 13-digit TMK.
  const matched = matchMauiStrhPermit(records, "221017040000", "3378 Keha Drive Unit 5K, Kihei, HI 96753");
  check("matches by TMK root + address", matched?.value === "STKM20120001", matched?.value);

  const rootOnly = matchMauiStrhPermit(records, "213009091000", "somewhere else entirely");
  check("TMK root alone is sufficient (address is a bonus)", rootOnly?.value === "STHA20130006", rootOnly?.value);

  const noMatch = matchMauiStrhPermit(records, "299999911000", "3378 Keha Drive, Kihei HI");
  check("address similarity alone never matches (TMK required)", noMatch === null, noMatch?.value);

  const badTmk = matchMauiStrhPermit(records, "", "3378 Keha Drive, Kihei HI");
  check("missing TMK → no match", badTmk === null, badTmk?.value);
}

console.log(`license-compliance-samples: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
