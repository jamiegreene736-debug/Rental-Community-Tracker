import pdf from "pdf-parse/lib/pdf-parse.js";
import { isPlaceholderLicenseValue, usableLicenseValue } from "../shared/license-compliance";

export type HawaiiComplianceLookupResult = {
  value: string;
  confidence: "guesty-listing" | "property-record" | "paired-tax-license" | "kauai-tvr-registry" | "unit-cpr" | "master-parcel";
  note: string;
  searchedAddress?: string;
  geocodedAddress?: string;
  taxMapKey?: string;
  source: string;
  sourceUrl?: string;
};

export type KauaiTmkLookupResult = {
  taxMapKey: string;
  confidence: "unit-cpr" | "master-parcel";
  note: string;
  searchedAddress: string;
  geocodedAddress: string;
  source: string;
  sourceUrl?: string;
  parcel: KauaiParcelAttributes;
  candidates: Array<{
    taxMapKey: string | null;
    cprUnit: string;
    owner: string | null;
    project: string | null;
    type: string | null;
    sourceUrl: string | null;
  }>;
};

type KauaiParcelAttributes = {
  TMK?: number;
  COTMK?: number;
  PARTXT?: string;
  CPR_UNIT?: string;
  PLAT?: string;
  PARCEL?: string;
  OWN1?: string;
  ALTID?: string;
  LINKQ?: string;
  TYPE?: string;
};

export type KauaiTvrRecord = {
  permitRaw: string;
  permitNumber: string;
  tmkKey: string;
  name: string;
  address: string;
  status: string;
};

const KAUAI_PARCEL_LAYER =
  "https://maps.kauai.gov/server/rest/services/Parcels_and_CPRs_WGS84_Degrees/FeatureServer/0/query";
const ARCGIS_GEOCODER =
  "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates";
const KAUAI_TVR_PDF_URL =
  "https://www.kauai.gov/files/assets/public/v/19/planning-department/documents/tvr/list-of-approved-homestays-and-nonconforming-tvrs-by-tmk.pdf";

const normalizeTmkText = (value: unknown): string | null => {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length === 12 ? digits : null;
};

const normalizeUnitToken = (value: unknown): string => {
  return String(value ?? "")
    .toUpperCase()
    .replace(/\b(?:UNIT|APT|APARTMENT|SUITE|STE|BLDG|BUILDING)\b/g, "")
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^0+(?=\d)/, "");
};

const extractUnitTokenFromAddress = (address: string): string => {
  const match = address.match(/\b(?:unit|apt|apartment|suite|ste|#)\s*([A-Z0-9-]+)\b/i);
  return normalizeUnitToken(match?.[1]);
};

const normalizeAddressText = (value: unknown): string => {
  return String(value ?? "")
    .toUpperCase()
    .replace(/\b(?:UNIT|APT|APARTMENT|SUITE|STE)\b/g, "#")
    .replace(/\bBOULEVARD\b/g, "BLVD")
    .replace(/\bSTREET\b/g, "ST")
    .replace(/\bAVENUE\b/g, "AVE")
    .replace(/\bROAD\b/g, "RD")
    .replace(/\bDRIVE\b/g, "DR")
    .replace(/[^A-Z0-9#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const queryKauaiParcels = async (params: URLSearchParams): Promise<KauaiParcelAttributes[]> => {
  const resp = await fetch(`${KAUAI_PARCEL_LAYER}?${params.toString()}`, {
    headers: { "User-Agent": "NexStay/1.0" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`Kauai parcel query failed (${resp.status})`);
  const data = await resp.json() as any;
  return Array.isArray(data?.features)
    ? data.features.map((f: any) => f?.attributes ?? {}).filter(Boolean)
    : [];
};

const scoreKauaiParcel = (row: KauaiParcelAttributes, unitToken: string): number => {
  const type = String(row.TYPE ?? "").toLowerCase();
  const cpr = normalizeUnitToken(row.CPR_UNIT);
  const partxt = normalizeTmkText(row.PARTXT);
  let score = 0;
  if (type.includes("cpr")) score += 20;
  if (type.includes("parcel")) score += 5;
  if (unitToken && cpr && cpr === unitToken) score += 100;
  if (unitToken && partxt && normalizeUnitToken(partxt.slice(-4)) === unitToken) score += 60;
  if (!unitToken && !type.includes("cpr")) score += 40;
  if (!unitToken && type.includes("cpr")) score -= 20;
  return score;
};

export function tmkMatchKeys(taxMapKey: string): string[] {
  const digits = taxMapKey.replace(/\D/g, "");
  if (!digits) return [];
  const keys = new Set<string>([digits]);
  if (digits.length === 12) {
    keys.add(digits.slice(0, 11));
    keys.add(digits.slice(0, 10));
    keys.add(digits.slice(0, 9));
    keys.add(digits.slice(0, 8));
  }
  return Array.from(keys);
}

export function formatKauaiCountyPermit(rawPermit: string): string {
  const trimmed = String(rawPermit ?? "").trim();
  if (!trimmed) return trimmed;
  if (/^(TVR|TVNC|STVR|STRH|NUC|Z-IV)-/i.test(trimmed)) return trimmed.toUpperCase();
  if (/^Z-IV-/i.test(trimmed)) return trimmed.toUpperCase();
  const digits = trimmed.replace(/\D/g, "");
  if (/^\d{3,4}$/.test(digits)) return `TVNC-${digits.padStart(4, "0")}`;
  return trimmed.toUpperCase();
}

export function parseKauaiTvrPdfText(text: string): KauaiTvrRecord[] {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const records: KauaiTvrRecord[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const permitRaw = lines[i];
    const tmkKey = lines[i + 1] ?? "";
    const nameAddress = lines[i + 2] ?? "";
    const status = lines[i + 3] ?? "";
    if (!/^\d{3,4}$/.test(permitRaw) || !/^\d{8,12}$/.test(tmkKey)) continue;
    if (!/active|inactive|expired|forfeit|cease|pending/i.test(status)) continue;
    const splitAt = nameAddress.search(/\d{2,6}\s/);
    const name = splitAt > 0 ? nameAddress.slice(0, splitAt).trim() : nameAddress;
    const address = splitAt > 0 ? nameAddress.slice(splitAt).trim() : "";
    records.push({
      permitRaw,
      permitNumber: formatKauaiCountyPermit(permitRaw),
      tmkKey,
      name,
      address,
      status,
    });
    i += 3;
  }
  return records;
}

export function matchKauaiStrPermit(
  records: KauaiTvrRecord[],
  taxMapKey: string,
  address?: string | null,
): { value: string; record: KauaiTvrRecord; note: string } | null {
  const keys = tmkMatchKeys(taxMapKey);
  const normalizedAddress = normalizeAddressText(address);
  const tmkMatchesRecord = (key: string, recordKey: string): boolean => {
    if (!key || !recordKey) return false;
    if (key === recordKey || key.includes(recordKey) || recordKey.includes(key)) return true;
    if (key.length === 12 && recordKey.length >= 8) {
      return key.slice(1).startsWith(recordKey) || key.includes(recordKey);
    }
    return false;
  };
  const ranked = records
    .map((record) => {
      let score = 0;
      if (keys.some((key) => tmkMatchesRecord(key, record.tmkKey))) score += 120;
      if (normalizedAddress && normalizeAddressText(record.address).includes(normalizedAddress.split(" ").slice(0, 4).join(" "))) {
        score += 40;
      }
      if (/active/i.test(record.status)) score += 10;
      return { record, score };
    })
    .filter(({ score }) => score >= 120)
    .sort((a, b) => b.score - a.score);
  const best = ranked[0]?.record;
  if (!best) return null;
  return {
    value: best.permitNumber,
    record: best,
    note: `Matched Kauai County TVR registry ${best.permitNumber} for TMK ${best.tmkKey} (${best.name || best.address || "registered property"}).`,
  };
}

let kauaiTvrCache: { loadedAt: number; records: KauaiTvrRecord[] } | null = null;

export async function fetchKauaiTvrRecords(): Promise<KauaiTvrRecord[]> {
  const oneDay = 24 * 60 * 60 * 1000;
  if (kauaiTvrCache && Date.now() - kauaiTvrCache.loadedAt < oneDay) {
    return kauaiTvrCache.records;
  }
  const resp = await fetch(KAUAI_TVR_PDF_URL, {
    headers: { "User-Agent": "NexStay/1.0" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`Kauai TVR registry download failed (${resp.status})`);
  const parsed = await pdf(Buffer.from(await resp.arrayBuffer()));
  const records = parseKauaiTvrPdfText(parsed.text || "");
  kauaiTvrCache = { loadedAt: Date.now(), records };
  return records;
}

export async function lookupKauaiTmkFromAddress(address: string): Promise<KauaiTmkLookupResult> {
  const searchedAddress = address.trim();
  const geocodeParams = new URLSearchParams({
    f: "json",
    SingleLine: searchedAddress,
    outFields: "Match_addr,Addr_type,Score",
    maxLocations: "3",
  });
  const geocodeResp = await fetch(`${ARCGIS_GEOCODER}?${geocodeParams.toString()}`, {
    headers: { "User-Agent": "NexStay/1.0" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!geocodeResp.ok) throw new Error(`Address geocode failed (${geocodeResp.status})`);
  const geocodeData = await geocodeResp.json() as any;
  const geocodeCandidates = Array.isArray(geocodeData?.candidates) ? geocodeData.candidates : [];
  const bestGeocode = geocodeCandidates.find((c: any) => Number(c?.score ?? 0) >= 80 && c?.location?.x && c?.location?.y);
  if (!bestGeocode) {
    throw new Error("No geocoded Hawaii address found");
  }

  const pointParams = new URLSearchParams({
    f: "json",
    where: "1=1",
    geometry: `${bestGeocode.location.x},${bestGeocode.location.y}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "TMK,COTMK,PARTXT,CPR_UNIT,PLAT,PARCEL,OWN1,ALTID,LINKQ,TYPE",
    returnGeometry: "false",
  });
  const pointRows = await queryKauaiParcels(pointParams);

  const cotmkValues = Array.from(new Set(
    pointRows.map((row) => Number(row.COTMK)).filter((n) => Number.isFinite(n)),
  ));
  const relatedRows: KauaiParcelAttributes[] = [];
  for (const cotmk of cotmkValues.slice(0, 3)) {
    const relatedParams = new URLSearchParams({
      f: "json",
      where: `COTMK=${cotmk}`,
      outFields: "TMK,COTMK,PARTXT,CPR_UNIT,PLAT,PARCEL,OWN1,ALTID,LINKQ,TYPE",
      returnGeometry: "false",
      resultRecordCount: "2000",
    });
    relatedRows.push(...await queryKauaiParcels(relatedParams));
  }

  const unitToken = extractUnitTokenFromAddress(searchedAddress);
  const rows = [...pointRows, ...relatedRows]
    .filter((row, idx, all) => {
      const key = normalizeTmkText(row.PARTXT) ?? `${row.COTMK}-${row.CPR_UNIT}-${idx}`;
      return all.findIndex((r, i) => (normalizeTmkText(r.PARTXT) ?? `${r.COTMK}-${r.CPR_UNIT}-${i}`) === key) === idx;
    })
    .sort((a, b) => scoreKauaiParcel(b, unitToken) - scoreKauaiParcel(a, unitToken));

  const selected = rows.find((row) => normalizeTmkText(row.PARTXT));
  const taxMapKey = normalizeTmkText(selected?.PARTXT);
  if (!selected || !taxMapKey) {
    throw new Error("No Kauai parcel TMK found for this address");
  }

  const selectedType = String(selected.TYPE ?? "");
  const selectedCpr = normalizeUnitToken(selected.CPR_UNIT);
  const isUnitCpr = Boolean(unitToken) && selectedType.toLowerCase().includes("cpr")
    && (selectedCpr === unitToken || normalizeUnitToken(taxMapKey.slice(-4)) === unitToken);
  const hasAnyCprRows = rows.some((row) => String(row.TYPE ?? "").toLowerCase().includes("cpr"));
  const note = isUnitCpr
    ? `Matched County of Kauai CPR unit ${String(selected.CPR_UNIT ?? "").trim() || taxMapKey.slice(-4)} from the exact Guesty listing address.`
    : hasAnyCprRows
      ? "Matched the official parcel for the exact Guesty listing address, but not an individual CPR row. Verify the qPublic link before pushing if Airbnb requires unit-level CPR."
      : "Matched the official County of Kauai master parcel for the exact Guesty listing address. The public GIS layer does not expose individual CPR units for this address.";

  return {
    taxMapKey,
    confidence: isUnitCpr ? "unit-cpr" : "master-parcel",
    note,
    searchedAddress,
    geocodedAddress: bestGeocode.address,
    source: "County of Kauai ArcGIS Parcels and CPRs",
    sourceUrl: selected.LINKQ || KAUAI_PARCEL_LAYER,
    parcel: selected,
    candidates: rows.slice(0, 8).map((row) => ({
      taxMapKey: normalizeTmkText(row.PARTXT),
      cprUnit: String(row.CPR_UNIT ?? "").trim(),
      owner: row.OWN1 ?? null,
      project: row.ALTID ?? null,
      type: row.TYPE ?? null,
      sourceUrl: row.LINKQ ?? null,
    })),
  };
}

const HAWAII_TAT_PATTERN = /\bTA-\d{3}-\d{3}-\d{4}-\d{2}\b/i;
const HAWAII_GET_PATTERN = /\bGE-\d{3}-\d{3}-\d{4}-\d{2}\b/i;

const tagValue = (tags: string[], prefix: string): string | null => {
  const match = tags.find((tag) => tag.toUpperCase().startsWith(prefix.toUpperCase()));
  const value = match ? match.slice(prefix.length).trim() : "";
  return usableLicenseValue(value);
};

const licenseInTags = (tags: string[], kind: "tat" | "get"): string | null => {
  const prefix = kind === "tat" ? "TAT:" : "GET:";
  const fromPrefix = tagValue(tags, prefix);
  if (fromPrefix) return fromPrefix;
  const pattern = kind === "tat" ? HAWAII_TAT_PATTERN : HAWAII_GET_PATTERN;
  for (const tag of tags) {
    const match = tag.match(pattern);
    if (match) return usableLicenseValue(match[0]);
  }
  return null;
};

const licenseInText = (text: string, kind: "tat" | "get"): string | null => {
  const pattern = kind === "tat" ? HAWAII_TAT_PATTERN : HAWAII_GET_PATTERN;
  const match = text.match(pattern);
  if (match) return usableLicenseValue(match[0]);
  const label = kind === "tat" ? "Transient Accommodations Tax ID \\(TAT\\)" : "General Excise Tax ID \\(GET\\)";
  const labeled = new RegExp(`${label}\\s*:?\\s*([^\\n]+)`, "i").exec(text);
  return usableLicenseValue(labeled?.[1]);
};

const bookingContentData = (listing: Record<string, unknown>): Array<{ name?: string; value?: string }> => {
  const integrations = Array.isArray(listing.integrations)
    ? listing.integrations as Array<Record<string, unknown>>
    : [];
  const bookingInteg = integrations.find((entry) =>
    ["bookingCom", "bookingCom2", "booking_com"].includes(String(entry.platform ?? "")),
  );
  const fromIntegration = (((bookingInteg?.bookingCom as Record<string, unknown> | undefined)?.license as Record<string, unknown> | undefined)?.information as Record<string, unknown> | undefined)?.contentData;
  if (Array.isArray(fromIntegration)) return fromIntegration as Array<{ name?: string; value?: string }>;

  const channels = listing.channels as Record<string, unknown> | undefined;
  const fromChannels = (((channels?.bookingCom as Record<string, unknown> | undefined)?.license as Record<string, unknown> | undefined)?.information as Record<string, unknown> | undefined)?.contentData;
  if (Array.isArray(fromChannels)) return fromChannels as Array<{ name?: string; value?: string }>;
  return [];
};

export function pairHawaiiTaxLicense(value: unknown, target: "tatLicense" | "getLicense"): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const tatMatch = raw.match(/^TA-(\d{3}-\d{3}-\d{4}-\d{2})$/i);
  if (tatMatch && target === "getLicense") return usableLicenseValue(`GE-${tatMatch[1]}`);
  const getMatch = raw.match(/^GE-(\d{3}-\d{3}-\d{4}-\d{2})$/i);
  if (getMatch && target === "tatLicense") return usableLicenseValue(`TA-${getMatch[1]}`);
  return null;
}

export type HawaiiComplianceValues = {
  taxMapKey?: string | null;
  tatLicense?: string | null;
  getLicense?: string | null;
  strPermit?: string | null;
};

export function extractHawaiiComplianceFromGuestyListing(listing: Record<string, unknown>): Required<HawaiiComplianceValues> {
  const tags = Array.isArray(listing.tags)
    ? (listing.tags as unknown[]).filter((tag): tag is string => typeof tag === "string")
    : [];
  const notes = String(((listing.publicDescription as Record<string, unknown> | undefined)?.notes) ?? "");
  const contentData = bookingContentData(listing);
  const contentValue = (name: string): string | null => {
    const match = contentData.find((entry) => entry?.name === name);
    return usableLicenseValue(match?.value);
  };

  const homeaway = ((listing.channels as Record<string, unknown> | undefined)?.homeaway || {}) as Record<string, string | undefined>;
  const fromTopLevelTat = usableLicenseValue(listing.licenseNumber);
  const fromTopLevelGet = usableLicenseValue(listing.taxId);
  const fromHomeawayTat = usableLicenseValue(homeaway.licenseNumber);
  const fromHomeawayGet = usableLicenseValue(homeaway.taxId);
  const fromHomeawayTmk = usableLicenseValue(homeaway.parcelNumber);

  const tatLicense =
    licenseInTags(tags, "tat")
    || fromTopLevelTat
    || fromHomeawayTat
    || contentValue("number")
    || licenseInText(notes, "tat");
  const getLicense =
    licenseInTags(tags, "get")
    || fromTopLevelGet
    || fromHomeawayGet
    || licenseInText(notes, "get");

  const strFromNotes = (() => {
    const labeled = notes.match(/Short-Term Rental Registration \/ Permit:\s*([^\n]+)/i);
    if (labeled) return usableLicenseValue(labeled[1]);
    const permitMatch = notes.match(/\b(?:TVR-\d{4}-\d{2,4}|TVNC-\d{4}|STVR-\d{4}-\d{6}|STRH-\d{8}|NUC-\d{2}-\d{3}-\d{4})\b/i);
    return permitMatch ? usableLicenseValue(permitMatch[0]) : null;
  })();

  return {
    taxMapKey: tagValue(tags, "TMK:") || contentValue("tmk_number") || fromHomeawayTmk,
    tatLicense,
    getLicense,
    strPermit: tagValue(tags, "STR:") || contentValue("permit_number") || strFromNotes,
  };
}

const fieldLabel = (field: "getLicense" | "tatLicense" | "strPermit"): string =>
  field === "getLicense" ? "GET" : field === "tatLicense" ? "TAT" : "STR";

const resolveTaxField = (
  field: "getLicense" | "tatLicense" | "strPermit",
  values: HawaiiComplianceValues,
): string | null => {
  const direct = usableLicenseValue(values[field]);
  if (direct) return direct;
  if (field === "getLicense") return pairHawaiiTaxLicense(values.tatLicense, "getLicense");
  if (field === "tatLicense") return pairHawaiiTaxLicense(values.getLicense, "tatLicense");
  return null;
};

export async function lookupHawaiiComplianceField(options: {
  field: "getLicense" | "tatLicense" | "strPermit";
  address: string;
  listingId?: string | null;
  taxMapKey?: string | null;
  propertyValues?: HawaiiComplianceValues | null;
  fetchGuestyListing?: (listingId: string) => Promise<Record<string, unknown>>;
}): Promise<HawaiiComplianceLookupResult> {
  const { field, address, listingId, taxMapKey, propertyValues, fetchGuestyListing } = options;
  const searchedAddress = address.trim();
  const label = fieldLabel(field);

  if (listingId && fetchGuestyListing) {
    const listing = await fetchGuestyListing(listingId);
    const extracted = extractHawaiiComplianceFromGuestyListing(listing);
    const guestyValue = resolveTaxField(field, extracted);
    if (guestyValue) {
      const paired = !usableLicenseValue(extracted[field]);
      return {
        value: guestyValue,
        confidence: paired ? "paired-tax-license" : "guesty-listing",
        note: paired
          ? `Derived the ${label} license from the paired ${field === "getLicense" ? "TAT" : "GET"} value already stored on the connected Guesty listing.`
          : `Pulled the real ${label} value already stored on the connected Guesty listing.`,
        searchedAddress,
        source: "Guesty listing compliance fields",
        sourceUrl: `https://app.guesty.com/properties/${listingId}/owners-and-license`,
      };
    }
  }

  if (field === "strPermit") {
    const effectiveTmk = usableLicenseValue(taxMapKey) || (await lookupKauaiTmkFromAddress(searchedAddress)).taxMapKey;
    const records = await fetchKauaiTvrRecords();
    const match = matchKauaiStrPermit(records, effectiveTmk, searchedAddress);
    if (match) {
      return {
        value: match.value,
        confidence: "kauai-tvr-registry",
        note: match.note,
        searchedAddress,
        taxMapKey: effectiveTmk,
        source: "County of Kauai Planning TVR registry",
        sourceUrl: KAUAI_TVR_PDF_URL,
      };
    }
    throw new Error("No Kauai County TVR / homestay permit matched this Guesty address or TMK in the public registry.");
  }

  throw new Error(
    listingId
      ? `No real ${label} license was found on the connected Guesty listing. Push compliance to Guesty after you have the official Hawaii ${label} license, or paste it manually.`
      : `Select a connected Guesty listing to pull the real ${label} license from Guesty compliance fields, or paste it manually.`,
  );
}
