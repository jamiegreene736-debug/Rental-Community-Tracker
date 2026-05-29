export type LicenseFieldKey =
  | "taxMapKey"
  | "tatLicense"
  | "getLicense"
  | "strPermit"
  | "dbprLicense"
  | "touristTaxAccount";

export type LicenseRequirement = {
  key: LicenseFieldKey;
  label: string;
  shortLabel: string;
  required: boolean;
  requiredForOtas: Array<"Airbnb" | "VRBO" | "Booking.com">;
  sample: string;
  helpText: string;
};

export type LicenseComplianceProfile = {
  jurisdiction: "hawaii" | "fort_myers_beach_fl" | "lee_county_fl" | "florida" | "unknown";
  title: string;
  summary: string;
  requirements: LicenseRequirement[];
  sources: Array<{ label: string; url: string }>;
};

function norm(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function isPlaceholderLicenseValue(value: unknown): boolean {
  const raw = String(value ?? "").trim();
  if (!raw) return true;

  const normalized = norm(raw);
  if (/\b(sample|example|placeholder|dummy|test)\b/.test(normalized)) return true;
  if (normalized.includes("license number")) return true;
  if (normalized.includes("account number")) return true;
  if (normalized.includes("county tdt account")) return true;

  const digitsOnly = raw.replace(/\D/g, "");
  if (/9{4,}/.test(digitsOnly)) return true;
  if (/^(cnd|dwe)\s+(or|and)\s+(cnd|dwe)/.test(normalized)) return true;

  const knownSamples = new Set([
    "420150080001",
    "420090060001",
    "ta 023 450 1234 01",
    "ge 023 450 1234 01",
    "ta 025 430 9876 01",
    "ge 025 430 9876 01",
    "tvr 2024 012 or tvnc 0342",
    "tvr 2024 999",
    "cnd4600000 or dwe4600000",
    "19 0096",
    "19 0096 or lbtr 999999",
  ]);
  if (knownSamples.has(normalized)) return true;
  // Obvious demo permit numbers (e.g. Makahuena portfolio placeholders).
  if (/^tvr 20\d{2} 999$/.test(normalized)) return true;
  return false;
}

export function usableLicenseValue(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  return raw && !isPlaceholderLicenseValue(raw) ? raw : null;
}

export function isFloridaLicenseJurisdiction(jurisdiction: LicenseComplianceProfile["jurisdiction"]): boolean {
  return jurisdiction === "fort_myers_beach_fl" || jurisdiction === "lee_county_fl" || jurisdiction === "florida";
}

export function resolveLicenseComplianceProfile(input: {
  city?: string | null;
  state?: string | null;
  address?: string | null;
}): LicenseComplianceProfile {
  const city = norm(input.city);
  const state = norm(input.state);
  const address = norm(input.address);
  const haystack = `${address} ${city} ${state}`;
  const isHawaii = state === "hi" || state === "hawaii" || /\bhawaii\b|\bkoloa\b|\bpoipu\b|\bprinceville\b|\bkapaa\b|\bkauai\b/.test(haystack);
  const isFlorida = state === "fl" || state === "florida" || /\bflorida\b/.test(haystack);
  const isFortMyersBeach = isFlorida && /\bfort myers beach\b|\bestero blvd\b|\b33931\b/.test(haystack);
  const isLeeCounty = isFlorida && /\blee county\b|\bbonita springs\b|\bbonita national\b|\bcape coral\b|\bsanibel\b|\bfort myers\b|\bestero\b|\b34135\b|\b34134\b|\b33904\b|\b33908\b|\b33912\b|\b33913\b|\b33916\b|\b33919\b|\b33928\b|\b33957\b/.test(haystack);

  if (isFortMyersBeach) {
    return {
      jurisdiction: "fort_myers_beach_fl",
      title: "Fort Myers Beach, Florida license requirements",
      summary: "Use the Town STR registration number and Florida DBPR vacation-rental license on OTA listings. The Town STR number is specifically required on internet advertising.",
      requirements: [
        {
          key: "strPermit",
          label: "Town of Fort Myers Beach STR Registration / Local Business Tax Receipt",
          shortLabel: "Town STR / LBTR",
          required: true,
          requiredForOtas: ["Airbnb", "VRBO", "Booking.com"],
          sample: "19-0096 or LBTR-999999",
          helpText: "Track the Town registration or local business tax receipt used for Fort Myers Beach short-term rental advertising.",
        },
        {
          key: "dbprLicense",
          label: "Florida DBPR Vacation Rental License",
          shortLabel: "Florida DBPR License",
          required: true,
          requiredForOtas: ["Airbnb", "VRBO", "Booking.com"],
          sample: "CND4600000 or DWE4600000",
          helpText: "Florida state vacation-rental license. Condo licenses commonly start with CND; dwelling licenses commonly start with DWE.",
        },
        {
          key: "touristTaxAccount",
          label: "Lee County Tourist Development Tax Account",
          shortLabel: "Lee County TDT",
          required: false,
          requiredForOtas: [],
          sample: "Lee County TDT account number",
          helpText: "Tax account/reference. Airbnb collects Lee County TDT on-platform, but the operator should still track tax registration outside the OTA listing fields.",
        },
      ],
      sources: [
        { label: "Town of Fort Myers Beach STR page", url: "https://www.fortmyersbeachfl.gov/1024/Short-Term-Rentals" },
        { label: "Town STR public portal", url: "https://str-public-portal.deckard.com/" },
        { label: "Florida DBPR license search", url: "https://www.myfloridalicense.com/wl11.asp" },
      ],
    };
  }

  if (isHawaii) {
    return {
      jurisdiction: "hawaii",
      title: "Hawaii license requirements",
      summary: "Use the real property address to pull the Tax Map Key and keep TAT/GET/STR permit data available for OTA compliance fields.",
      requirements: [
        {
          key: "taxMapKey",
          label: "Tax Map Key Number",
          shortLabel: "TMK",
          required: true,
          requiredForOtas: ["Airbnb", "VRBO", "Booking.com"],
          sample: "420150080001",
          helpText: "Parcel identifier verified from the address that is sent to Guesty.",
        },
        {
          key: "getLicense",
          label: "General Excise Tax License",
          shortLabel: "GET License",
          required: true,
          requiredForOtas: ["Airbnb", "VRBO", "Booking.com"],
          sample: "GE-023-450-1234-01",
          helpText: "Hawaii general excise tax license.",
        },
        {
          key: "tatLicense",
          label: "Transient Accommodations Tax License",
          shortLabel: "TAT License",
          required: true,
          requiredForOtas: ["Airbnb", "VRBO", "Booking.com"],
          sample: "TA-023-450-1234-01",
          helpText: "Hawaii transient accommodations tax license.",
        },
        {
          key: "strPermit",
          label: "County STR Permit Number",
          shortLabel: "STR Permit",
          required: false,
          requiredForOtas: ["Airbnb", "VRBO", "Booking.com"],
          sample: "TVR-2024-012 or TVNC-0342",
          helpText: "County-specific permit when applicable.",
        },
      ],
      sources: [
        { label: "Kauai real property search", url: "https://kauairpt.ehawaii.gov" },
        { label: "Hawaii Tax Online", url: "https://hitax.hawaii.gov" },
      ],
    };
  }

  if (isLeeCounty) {
    return {
      jurisdiction: "lee_county_fl",
      title: "Lee County / Bonita Springs, Florida license requirements",
      summary: "Pull the Florida DBPR vacation-rental license from state lodging records and track Lee County tourist tax plus any local business tax receipt used for compliance.",
      requirements: [
        {
          key: "dbprLicense",
          label: "Florida DBPR Vacation Rental License",
          shortLabel: "Florida DBPR License",
          required: true,
          requiredForOtas: ["Airbnb", "VRBO", "Booking.com"],
          sample: "CND4600000 or DWE4600000",
          helpText: "State vacation-rental license. Condo licenses commonly start with CND; dwelling licenses commonly start with DWE.",
        },
        {
          key: "getLicense",
          label: "Florida Sales Tax Certificate",
          shortLabel: "Florida Sales Tax Cert",
          required: false,
          requiredForOtas: [],
          sample: "Florida sales tax certificate number",
          helpText: "Track the Florida sales tax certificate if the operator, owner, or manager collects taxable rentals outside OTA-collected tax.",
        },
        {
          key: "touristTaxAccount",
          label: "Lee County Tourist Development Tax Account",
          shortLabel: "Lee County TDT",
          required: false,
          requiredForOtas: [],
          sample: "Lee County TDT account number",
          helpText: "Lee County tourist development tax account/reference for direct bookings or off-platform collection tracking.",
        },
        {
          key: "strPermit",
          label: "Lee County / Bonita Springs Business Tax Receipt",
          shortLabel: "LBTR",
          required: false,
          requiredForOtas: [],
          sample: "Lee County or Bonita Springs BTR number",
          helpText: "Local business tax receipt or related local registration number when one applies to the listing/operator.",
        },
      ],
      sources: [
        { label: "Florida DBPR lodging public records", url: "https://www2.myfloridalicense.com/hotels-restaurants/lodging-public-records/" },
        { label: "Florida DBPR license search", url: "https://www.myfloridalicense.com/wl11.asp" },
        { label: "Lee County Tourist Development Tax", url: "https://www.leeclerk.org/i-want-to/pay/tourist-tax" },
      ],
    };
  }

  if (isFlorida) {
    return {
      jurisdiction: "florida",
      title: "Florida license requirements",
      summary: "Florida vacation rentals generally need a DBPR vacation-rental license; local registration and advertising-display rules vary by municipality.",
      requirements: [
        {
          key: "dbprLicense",
          label: "Florida DBPR Vacation Rental License",
          shortLabel: "Florida DBPR License",
          required: true,
          requiredForOtas: ["Airbnb", "VRBO", "Booking.com"],
          sample: "CND or DWE license number",
          helpText: "State vacation-rental license. Check local city/county rules for additional registration numbers.",
        },
      ],
      sources: [
        { label: "Florida DBPR license search", url: "https://www.myfloridalicense.com/wl11.asp" },
        { label: "Airbnb Florida rules", url: "https://www.airbnb.com/help/article/2371/" },
      ],
    };
  }

  return {
    jurisdiction: "unknown",
    title: "License requirements not mapped",
    summary: "This address does not match a mapped Hawaii or Florida jurisdiction yet. Verify local OTA registration rules before publishing.",
    requirements: [],
    sources: [],
  };
}
