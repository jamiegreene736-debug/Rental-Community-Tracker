// Sample license placeholders for the unit builder's Compliance &
// Registration card (Descriptions tab). Moved here from
// client/src/data/adapt-draft.ts (2026-07-10) so the placeholder
// DETECTOR in shared/license-compliance.ts and the sample GENERATOR
// share one source of truth — previously the two lists drifted and a
// generated sample (e.g. "TA-026-780-7890-01") was treated as a real
// license by push-compliance. Client code re-imports from here via
// the adapt-draft re-export.
//
// Hawaii uses TMK (parcel id) + GE (general excise tax) + TAT
// (transient accom. tax) + STR (per-county permit).
//
// Florida re-uses the same four UI fields for the Florida vacation-
// rental compliance stack (the field labels are state-aware in the
// builder — see complianceLabels there):
//   - field 1 (TMK slot)  → DBPR Vacation Rental License
//   - field 2 (GE slot)   → Florida DOR Sales Tax Certificate
//   - field 3 (TAT slot)  → County Tourist Development Tax account
//   - field 4 (STR slot)  → Local Business Tax Receipt (LBTR)

export type LicenseSamples = {
  taxMapKey: string;
  getLicense: string;
  tatLicense: string;
  strPermit: string;
};

export type LicenseSampleContext = {
  address?: string;
  propertyType?: string;
};

type HawaiiCounty = "kauai-vda" | "kauai-non-vda" | "big-island" | "maui" | "oahu" | "unknown";

function locationHaystack(city: string, context?: LicenseSampleContext): string {
  return `${city || ""} ${context?.address || ""}`.toLowerCase();
}

// Map a city → Hawaii county. Used to pick the right STR permit format
// (each county has its own — Kauai uses TVR/TVNC, Big Island STVR,
// Maui ST<region>, Oahu NUC/registration). VDA = Visitor Destination
// Area, the Kauai distinction between resort zones (TVR) and
// residential (TVNC).
function hawaiiCountyFromCity(city: string, context?: LicenseSampleContext): HawaiiCounty {
  const c = locationHaystack(city, context);
  // Big Island (Hawaii County). Check before Oahu because Kailua-Kona
  // contains "Kailua" but uses Hawaii County TMK/STVR formats.
  if (/keauhou|kona|kailua-kona|hilo|waikoloa|mauna|volcano|pahoa|naalehu|big island|hawaii island/.test(c)) return "big-island";
  // Oahu: Honolulu / Waikiki / Kailua / North Shore / Pearl City etc.
  if (/honolulu|waikiki|\bkailua\b|kaneohe|aiea|pearl|wahiawa|haleiwa|kapolei|ewa|north shore/.test(c)) return "oahu";
  // Maui County: Maui island + Lanai + Molokai
  if (/maui|lahaina|kihei|wailea|kaanapali|kapalua|kahului|hana|paia|makawao|lanai|molokai/.test(c)) return "maui";
  // Kauai VDA zones (resort areas)
  if (/poipu|princeville|kapaa beachfront|hanalei|koloa/.test(c)) return "kauai-vda";
  // Kauai non-VDA (residential)
  if (/kekaha|waimea|lihue|kapaa|kalaheo|wailua/.test(c)) return "kauai-non-vda";
  return "unknown";
}

// Fully-formed sample values that match the format real properties in
// `unit-builder-data.ts` use (e.g. "TVR-2022-048", "GE-023-450-1234-01",
// "420150080001"). The operator replaces these with the unit's actual
// numbers before pushing to Guesty — the goal here is to show what the
// expected shape is, not provide live license data. Format only:
// every concrete digit string below is filler; nothing identifies a
// real property or owner.
// Hawaii GET/TAT share the same digit groups; only the TA- vs GE- prefix differs.
// Shape matches Hawaii Tax Online: TA|GE-###-###-####-## (see unit-builder-data).
function hawaiiTaxLicenseCore(city: string, county: HawaiiCounty, context?: LicenseSampleContext): string {
  const c = locationHaystack(city, context);
  switch (county) {
    case "kauai-vda":
      if (/princeville/.test(c)) return "026-780-7890-01";
      if (/poipu|koloa/.test(c)) return "025-430-9876-01";
      return "023-450-1234-09";
    case "kauai-non-vda":
      return "024-120-9012-01";
    case "big-island":
      return "018-920-3456-01";
    case "maui":
      return "022-560-7812-01";
    case "oahu":
      return "019-870-2345-01";
    default:
      return "023-450-1234-09";
  }
}

function tatSampleHawaii(city: string, context?: LicenseSampleContext): string {
  return `TA-${hawaiiTaxLicenseCore(city, hawaiiCountyFromCity(city, context), context)}`;
}

function getSampleHawaii(city: string, context?: LicenseSampleContext): string {
  return `GE-${hawaiiTaxLicenseCore(city, hawaiiCountyFromCity(city, context), context)}`;
}

// Per-county STR permit formats, matched to what each county actually
// issues (verified against county sources 2026-07-10):
//   - Kauai: registry lists bare 3-4 digit permits advertised as
//     TVNC-#### outside the VDA; TVR-YYYY-NNN retained for VDA resorts.
//   - Big Island: the county's own STVR/NUC renewal form numbers
//     certificates "STVR - 19 - ____" → STVR-19-XXXX (not a 4-digit year).
//   - Maui: the county's Approved STRH list numbers permits
//     ST<region>YYYYNNNN — STKM (Kihei-Makena), STWM (West Maui),
//     STHA (Hana), STPH (Paia-Haiku), STLA (Lanai), generic STRH.
//   - Oahu: NUCs date to the 1989-90 ordinance era, so the filler year
//     must read as such (a "NUC-24-…" would imply a 2024-issued NUC,
//     which does not exist; new registrations have no published format).
function strPermitSampleHawaii(city: string, context?: LicenseSampleContext): string {
  const c = locationHaystack(city, context);
  const county = hawaiiCountyFromCity(city, context);
  switch (county) {
    case "kauai-vda":
      if (/princeville/.test(c)) return "TVR-2023-074";
      return "TVR-2022-048";
    case "kauai-non-vda":
      if (/kekaha|waimea/.test(c)) return "TVNC-0218";
      return "TVNC-0342";
    case "big-island":
      return "STVR-19-3461";
    case "maui":
      if (/lahaina|kaanapali|kapalua|napili|honokowai/.test(c)) return "STWM20180034";
      if (/kihei|wailea|makena/.test(c)) return "STKM20190012";
      return "STRH20190012";
    case "oahu":
      return "NUC-89-0134";
    default:
      return "TVR-2022-048";
  }
}

// Hawaii TMK serials are 12 digits (county-district-section-plat-parcel-cpr).
// Keep filler digits in the per-county block of the actual TMK ranges —
// 4xxx for Kauai, 3xxx for Big Island, 2xxx for Maui, 1xxx for Oahu —
// so the operator immediately sees which county slot they're filling.
function tmkSampleHawaii(city: string, context?: LicenseSampleContext): string {
  switch (hawaiiCountyFromCity(city, context)) {
    case "kauai-vda":
    case "kauai-non-vda": return "420150080099";
    case "big-island":    return "370110060099";
    case "maui":          return "230080020099";
    case "oahu":          return "190070030099";
    default:              return "420150080099";
  }
}

// Map a Florida city → county. Drives the Florida sample set, since
// Tourist Development Tax and Local Business Tax Receipts are issued
// per-county, and the sales-tax certificate's leading two digits encode
// the county the business registered in (Osceola=49, Orange=48,
// Polk=53). Davenport sits across the Polk/Osceola line — most resort
// communities ("ChampionsGate", Reunion-area condos) bill from Osceola
// addresses, so Davenport is grouped with Osceola here. Operators with
// a Polk-side Davenport address should overwrite the BTR/TDT/sales-tax
// samples with their actual numbers; the fields aren't used until the
// operator pushes compliance to Guesty.
type FloridaCounty = "osceola" | "orange" | "polk" | "lake" | "brevard" | "lee" | "unknown";

function floridaCountyFromCity(city: string, context?: LicenseSampleContext): FloridaCounty {
  const c = locationHaystack(city, context);
  if (/(kissimmee|davenport|celebration|poinciana|st\.?\s*cloud|championsgate|reunion)/.test(c)) return "osceola";
  if (/(orlando|windermere|lake\s+buena\s+vista|ocoee|apopka|winter\s+garden|dr\.?\s*phillips)/.test(c)) return "orange";
  if (/(haines\s*city|lakeland|winter\s+haven|auburndale|bartow|lake\s+wales)/.test(c)) return "polk";
  if (/(clermont|groveland|minneola|mascotte|mount\s+dora|tavares|leesburg)/.test(c)) return "lake";
  if (/(melbourne|cocoa|titusville|palm\s+bay|merritt\s+island|cape\s+canaveral|viera|rockledge)/.test(c)) return "brevard";
  if (/(fort\s+myers|fort\s+myers\s+beach|bonita\s+springs|bonita\s+national|cape\s+coral|sanibel|estero|lee\s+county|33931|33908|33913|33928|34135)/.test(c)) return "lee";
  return "unknown";
}

function floridaDbprSample(context?: LicenseSampleContext): string {
  return /condo|condominium|apartment|unit/i.test(context?.propertyType || "")
    ? "CND7053894"
    : "DWE7053894";
}

// Per-county Florida sample sets. The four FL fields are:
//   - DBPR Vacation Rental License (DWE for dwellings, CND for
//     condo-class units; 7-digit certificate)
//   - DOR Sales & Use Tax Certificate (XX-XXXXXXXXXX-X; the leading
//     two digits encode the county the business registered in)
//   - Tourist Development Tax account (issued per-county by the local
//     Tax Collector; numeric 7-digit account)
//   - Local Business Tax Receipt (LBTR, issued by the same Tax
//     Collector for STR-class businesses)
//
// Concrete digits are filler chosen to match each county's leading
// sales-tax code, so the operator can see at a glance which county
// slot they're in. Operators replace with their actual numbers
// before pushing compliance to Guesty.
type FloridaSamples = { taxMapKey: string; getLicense: string; tatLicense: string; strPermit: string };
function floridaSamples(c: FloridaCounty, context?: LicenseSampleContext): FloridaSamples {
  const dbprLicense = floridaDbprSample(context);
  switch (c) {
    case "osceola": return {
      taxMapKey:  dbprLicense,
      getLicense: "49-8013575941-1",
      tatLicense: "Osceola County TDT Acct # 4502187",
      strPermit:  "LBTR-548291",
    };
    case "orange": return {
      taxMapKey:  dbprLicense.replace(/\d+$/, "6841273"),
      getLicense: "48-8014729384-2",
      tatLicense: "Orange County TDT Acct # 7218394",
      strPermit:  "LBTR-739104",
    };
    case "polk": return {
      taxMapKey:  dbprLicense.replace(/\d+$/, "5928374"),
      getLicense: "53-8024918273-3",
      tatLicense: "Polk County TDT Acct # 3612847",
      strPermit:  "LBTR-462051",
    };
    case "lake": return {
      taxMapKey:  dbprLicense.replace(/\d+$/, "4827193"),
      getLicense: "35-8035102847-4",
      tatLicense: "Lake County TDT Acct # 2841093",
      strPermit:  "LBTR-318472",
    };
    case "brevard": return {
      taxMapKey:  dbprLicense.replace(/\d+$/, "3719284"),
      getLicense: "05-8046283715-5",
      tatLicense: "Brevard County TDT Acct # 1928374",
      strPermit:  "LBTR-294817",
    };
    case "lee": return {
      taxMapKey:  dbprLicense.replace(/\d+$/, "4601287"),
      getLicense: "36-8062451938-6",
      tatLicense: "Lee County TDT Acct # 6184729",
      strPermit:  "LBTR-190096",
    };
    default: return {
      taxMapKey:  dbprLicense.replace(/\d+$/, "9999999"),
      getLicense: "99-9999999999-9",
      tatLicense: "FL County TDT Acct # 9999999",
      strPermit:  "LBTR-999999",
    };
  }
}

export function sampleLicensesForLocation(city: string, state: string, context?: LicenseSampleContext): LicenseSamples {
  const s = (state || "").toLowerCase();
  if (s === "hawaii" || s === "hi") {
    return {
      taxMapKey:  tmkSampleHawaii(city, context),
      getLicense: getSampleHawaii(city, context),
      tatLicense: tatSampleHawaii(city, context),
      strPermit:  strPermitSampleHawaii(city, context),
    };
  }
  if (s === "florida" || s === "fl") {
    return floridaSamples(floridaCountyFromCity(city, context), context);
  }
  return {
    taxMapKey: "(no parcel/license id required for this state — verify with local jurisdiction)",
    getLicense: "(no state sales tax cert required — verify with local jurisdiction)",
    tatLicense: "(no occupancy tax registration required — verify with local jurisdiction)",
    strPermit: "(verify local short-term rental permit requirements)",
  };
}

// Probe locations covering EVERY branch of the generators above. When a
// new city/county branch is added to the samples, add a probe here (a
// test locks that every probed sample is recognized as a placeholder).
export const SAMPLE_PROBE_LOCATIONS: Array<{ city: string; state: string; context?: LicenseSampleContext }> = [
  { city: "Princeville", state: "HI" },
  { city: "Koloa", state: "HI" },
  { city: "Hanalei", state: "HI" },       // kauai-vda default core
  { city: "Kekaha", state: "HI" },
  { city: "Lihue", state: "HI" },         // kauai-non-vda default permit
  { city: "Waikoloa", state: "HI" },
  { city: "Kihei", state: "HI" },
  { city: "Lahaina", state: "HI" },
  { city: "Kaunakakai", state: "HI", context: { address: "Molokai" } }, // maui default permit
  { city: "Honolulu", state: "HI" },
  { city: "Somewhere", state: "HI" },     // unknown-county fallbacks
  { city: "Kissimmee", state: "FL" },
  { city: "Orlando", state: "FL" },
  { city: "Haines City", state: "FL" },
  { city: "Clermont", state: "FL" },
  { city: "Melbourne", state: "FL" },
  { city: "Fort Myers Beach", state: "FL" },
  { city: "Elsewhere", state: "FL" },     // unknown-county fallbacks
  { city: "Nashville", state: "TN" },     // unmapped-state annotated hints
];

// Sample/placeholder license values from RETIRED revisions of the
// generators above and the hand-written demo values checked into
// client/src/data/unit-builder-data.ts. These still live in saved
// drafts and the static portfolio data, so the placeholder detector
// must keep recognizing them forever — a value listed here must NEVER
// be pushed to Guesty as a real license.
export const LEGACY_SAMPLE_LICENSE_VALUES: string[] = [
  // Old-revision / static TMK placeholders (unit-builder-data.ts).
  "420150080001", "420090060001", "370110060001", "370110070001",
  "410090010001", "420140050001", "420140050002", "420150010003",
  "420150030001", "420150040002", "420150060001", "420170030001",
  "420170030002", "430150130001", "450030040001", "450040020001",
  "450040020002",
  // Old-format county STR samples (pre-2026-07-10 generator + statics).
  "STRH-20240042", "NUC-24-001-0134", "STVR-2019-003461", "STVR-2019-003462",
  "TVR-2021-029", "TVR-2021-031", "TVR-2021-065", "TVR-2022-037",
  "TVR-2022-038", "TVR-2022-044", "TVR-2023-012", "TVR-2023-058",
  "TVR-2023-062", "TVR-2023-075",
  // Current-format static demo permits in unit-builder-data.ts
  // (STVR-19-3461 is also emitted by the generator; -3462 is not).
  "STVR-19-3462",
  // Observed live on the Poipu Kapili (-25) Booking.com license object during
  // the 2026-07-19 sample-compliance audit, pushed pre-guard alongside a
  // known sample TAT. PROVEN not a real permit: the County of Kauai TVR
  // registry (all 401 records) contains only TVNC-#### permit numbers and
  // has no "2024-099" in any field. Exact value only — TVR-YYYY-NNN stays a
  // real-shaped format (see the TVR-2020-101 false-positive lock).
  "TVR-2024-099",
];

// Filler GET/TAT license cores used by the sample generators (current
// and retired revisions, incl. the unit-builder-data statics). A TA-/
// GE- value built from one of these exact 10-digit cores is a sample
// regardless of its 2-digit location suffix — the statics vary the
// suffix per property (…-02, …-03, …) while reusing the same core.
export const SAMPLE_TAX_LICENSE_CORES: string[] = [
  "023-450-1234", "025-430-9876", "026-780-7890", "024-120-9012",
  "018-920-3456", "022-560-7812", "019-870-2345",
  // Retired-revision cores still present in unit-builder-data.ts.
  "022-410-5678", "023-910-6789", "024-630-2345", "026-840-8901",
];

let knownSampleValuesCache: Set<string> | null = null;

function normalizeSampleValue(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Every license value the sample generators can emit (all probe
// branches × condo/dwelling context) plus the legacy placeholder
// families. Normalized the same way isPlaceholderLicenseValue
// normalizes, so membership is a direct set lookup.
export function allKnownSampleLicenseValues(): Set<string> {
  if (knownSampleValuesCache) return knownSampleValuesCache;
  const values = new Set<string>();
  const contexts: Array<LicenseSampleContext | undefined> = [
    undefined,
    { propertyType: "Condominium" },
    { propertyType: "House" },
  ];
  for (const probe of SAMPLE_PROBE_LOCATIONS) {
    for (const context of contexts) {
      const merged = context ? { ...probe.context, ...context } : probe.context;
      const samples = sampleLicensesForLocation(probe.city, probe.state, merged);
      for (const value of Object.values(samples)) values.add(normalizeSampleValue(value));
    }
  }
  for (const value of LEGACY_SAMPLE_LICENSE_VALUES) values.add(normalizeSampleValue(value));
  knownSampleValuesCache = values;
  return values;
}

// True when a TA-/GE- Hawaii tax license is built from one of the
// documented filler cores above (any 2-digit suffix). Exact-core
// matching keeps false positives on real licenses ~impossible.
export function isSampleTaxLicenseCore(value: string): boolean {
  const match = value.trim().match(/^(?:TA|GE)-(\d{3}-\d{3}-\d{4})-\d{2}$/i);
  return match ? SAMPLE_TAX_LICENSE_CORES.includes(match[1]) : false;
}
