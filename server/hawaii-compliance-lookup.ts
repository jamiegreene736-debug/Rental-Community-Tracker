import pdf from "pdf-parse/lib/pdf-parse.js";
import { isPlaceholderLicenseValue, usableLicenseValue } from "../shared/license-compliance";

export type HawaiiComplianceLookupResult = {
  value: string;
  confidence: "guesty-listing" | "property-record" | "paired-tax-license" | "public-listing" | "kauai-tvr-registry" | "maui-strh-registry" | "unit-cpr" | "master-parcel";
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
// State of Hawaii Statewide GIS "Statewide TMKs" parcel layer. Covers EVERY
// island (Hawaii/Big Island, Maui, Oahu, Molokai, Lanai, Kauai) and exposes
// the authoritative master-parcel TMK (`tmk_txt`) + the public qPublic record
// link (`qpub_link`). Kauai keeps its dedicated CPR-aware parcel layer above
// (it surfaces individual condo CPR units); this statewide layer is the
// fallback for the other counties, which previously had NO official TMK source
// at all and fell through to unreliable public OTA snippet scraping.
const HAWAII_STATEWIDE_TMK_LAYER =
  "https://geodata.hawaii.gov/arcgis/rest/services/ParcelsZoning/MapServer/25/query";
const HAWAII_ISLAND_LABELS: Record<string, string> = {
  HAW: "Hawaii (Big Island)",
  MAU: "Maui",
  OAH: "Oahu",
  KAU: "Kauai",
  MOL: "Molokai",
  LAN: "Lanai",
  NII: "Niihau",
  KAH: "Kahoolawe",
};

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

// County of Maui "Approved Short-Term Rental Homes" list — the Maui
// analog of the Kauai TVR registry above. The county publishes one PDF
// with every approved STRH permit: permit number (ST<region>YYYYNNNN,
// e.g. STKM20120001 for Kihei-Makena), 13-digit TMK (2-x-x-xxx-xxx-0000),
// property name, street address, and town. Permit numbers here are the
// exact strings the county requires in all STRH advertising.
const MAUI_STRH_PDF_URL =
  "https://www.mauicounty.gov/DocumentCenter/View/14762/Approved-Short-Term-Rental-Homes-List";

export type MauiStrhRecord = {
  permitNumber: string;
  tmkKey: string;
  name: string;
  address: string;
};

// pdf-parse renders each row as one line shaped like
//   "STKM20120001HALE ALANA2210170400000-4059 3 13378 KEHA DRIVE 5KKIHEI"
// (permit + name + 13-digit TMK + per-row file number + rooms/dwellings
// digits glued onto the street number + town glued onto the street).
// Matching is TMK-first, so the address is kept as the raw tail — the
// scorer's substring check tolerates the glued digit prefix/town suffix.
export function parseMauiStrhPdfText(text: string): MauiStrhRecord[] {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const records: MauiStrhRecord[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const permitMatch = lines[i].match(/^(ST[A-Z]{2}\d{8})(.*)$/);
    if (!permitMatch) continue;
    let rest = permitMatch[2] ?? "";
    // Wrap tolerance: a long property name can push the TMK 1-3 lines
    // down (e.g. "DREAMS COME TRUE ON LANAI SHORT-TERM RENTAL" / "HOME" /
    // "<TMK row>"). Join lookahead lines until the TMK appears, stopping
    // at a new permit row or a row-number line; consume the joined lines
    // only when the TMK was actually found.
    if (!/2\d{12}/.test(rest)) {
      let joined = rest;
      let j = i + 1;
      while (j < lines.length && j - i <= 3) {
        const next = lines[j];
        if (/^ST[A-Z]{2}\d{8}/.test(next) || /^\d{1,3}\.$/.test(next)) break;
        joined = `${joined} ${next}`;
        j += 1;
        if (/2\d{12}/.test(joined)) break;
      }
      if (!/2\d{12}/.test(joined)) continue;
      rest = joined;
      i = j - 1;
    }
    // No leading \b — the TMK is glued to the property name in the
    // pdf-parse rendering ("HALE ALANA2210170400000-…"); the (?!\d)
    // tail plus the row's "-<file number>" separator anchor the match.
    const tmkMatch = rest.match(/(2\d{12})(?!\d)/);
    if (!tmkMatch) continue;
    const tmkIndex = rest.indexOf(tmkMatch[1]);
    records.push({
      permitNumber: permitMatch[1],
      tmkKey: tmkMatch[1],
      name: rest.slice(0, tmkIndex).trim(),
      address: rest.slice(tmkIndex + tmkMatch[1].length).trim(),
    });
  }
  return records;
}

// Maui STRH permits are single-family parcels (the list's TMKs all end
// in a 0000 CPR), so the 9-digit division+zone+section+plat+parcel root
// identifies the property. The statewide GIS lookup returns 12-digit
// TMKs whose first 9 digits are that same root.
export function matchMauiStrhPermit(
  records: MauiStrhRecord[],
  taxMapKey: string,
  address?: string | null,
): { value: string; record: MauiStrhRecord; note: string } | null {
  const digits = String(taxMapKey ?? "").replace(/\D/g, "");
  const root = digits.length >= 9 && digits.startsWith("2") ? digits.slice(0, 9) : null;
  const normalizedAddress = normalizeAddressText(address);
  const streetLead = normalizedAddress.split(" ").slice(0, 3).join(" ");
  const ranked = records
    .map((record) => {
      let score = 0;
      if (root && record.tmkKey.slice(0, 9) === root) score += 120;
      if (streetLead && normalizeAddressText(record.address).includes(streetLead)) score += 40;
      return { record, score };
    })
    .filter(({ score }) => score >= 120)
    .sort((a, b) => b.score - a.score);
  const best = ranked[0]?.record;
  if (!best) return null;
  return {
    value: best.permitNumber,
    record: best,
    note: `Matched Maui County Approved STRH list ${best.permitNumber} for TMK ${best.tmkKey} (${best.name || best.address || "approved rental home"}).`,
  };
}

let mauiStrhCache: { loadedAt: number; records: MauiStrhRecord[] } | null = null;

export async function fetchMauiStrhRecords(): Promise<MauiStrhRecord[]> {
  const oneDay = 24 * 60 * 60 * 1000;
  if (mauiStrhCache && Date.now() - mauiStrhCache.loadedAt < oneDay) {
    return mauiStrhCache.records;
  }
  const resp = await fetch(MAUI_STRH_PDF_URL, {
    headers: { "User-Agent": "NexStay/1.0" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`Maui STRH registry download failed (${resp.status})`);
  const parsed = await pdf(Buffer.from(await resp.arrayBuffer()));
  const records = parseMauiStrhPdfText(parsed.text || "");
  mauiStrhCache = { loadedAt: Date.now(), records };
  return records;
}

// Shared ArcGIS geocode step used by both the Kauai parcel/CPR lookup and the
// statewide (Big Island / Maui / Oahu) parcel lookup. Returns the best-scoring
// point candidate; throws the same "No geocoded Hawaii address found" message
// the routes layer already maps to a 404.
async function geocodeHawaiiAddress(searchedAddress: string): Promise<{ x: number; y: number; address: string }> {
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
  return { x: bestGeocode.location.x, y: bestGeocode.location.y, address: bestGeocode.address };
}

export async function lookupKauaiTmkFromAddress(address: string): Promise<KauaiTmkLookupResult> {
  const searchedAddress = address.trim();
  const bestGeocode = { location: await geocodeHawaiiAddress(searchedAddress) };

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
    geocodedAddress: bestGeocode.location.address,
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

/** Convert geodata.hawaii.gov `tmk_txt` (9-digit) into the 12-digit bare TMK Guesty/Airbnb expect. */
export function formatGeodataTaxMapKey(tmkTxt: unknown, unitToken?: string): string | null {
  const digits = String(tmkTxt ?? "").replace(/\D/g, "");
  if (digits.length === 12) return digits;
  if (digits.length === 9) {
    const numericUnit = unitToken && /^\d+$/.test(unitToken)
      ? unitToken.replace(/^0+/, "").padStart(3, "0").slice(-3)
      : null;
    if (numericUnit) return `${digits}${numericUnit}`;
    return `${digits}000`;
  }
  if (digits.length >= 11 && digits.length <= 13) return digits;
  return null;
}

// Big Island (Hawaii County), Maui, and Oahu TMK lookup via the State of Hawaii
// Statewide GIS parcel layer. Mirrors lookupKauaiTmkFromAddress's contract so the
// tmk-lookup route can return it unchanged, but the statewide layer only exposes
// the MASTER parcel (no individual CPR/condo units), so confidence is always
// "master-parcel". This is the path that fixes Big Island resorts like Waikoloa
// Beach Villas, which previously had no authoritative TMK source and fell through
// to public OTA snippet scraping (which finds nothing for heavily-rented resorts).
export async function lookupHawaiiStatewideTmkFromAddress(address: string): Promise<KauaiTmkLookupResult> {
  const searchedAddress = address.trim();
  const geo = await geocodeHawaiiAddress(searchedAddress);
  const unitToken = extractUnitTokenFromAddress(searchedAddress);

  const params = new URLSearchParams({
    f: "json",
    where: "1=1",
    geometry: JSON.stringify({ x: geo.x, y: geo.y, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "tmk_txt,cty_tmk,county,island,division,zone,section,plat1,parcel1,qpub_link",
    returnGeometry: "false",
  });
  const resp = await fetch(`${HAWAII_STATEWIDE_TMK_LAYER}?${params.toString()}`, {
    headers: { "User-Agent": "NexStay/1.0" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`Hawaii statewide parcel query failed (${resp.status})`);
  const data = await resp.json() as any;
  const features: Array<Record<string, unknown>> = Array.isArray(data?.features)
    ? data.features.map((f: any) => f?.attributes ?? {}).filter(Boolean)
    : [];
  const tmkDigits = (value: unknown): string => String(value ?? "").replace(/\D/g, "");
  const selected = features.find((row) => tmkDigits(row.tmk_txt));
  const taxMapKey = formatGeodataTaxMapKey(selected?.tmk_txt, unitToken);
  if (!selected || !taxMapKey) {
    throw new Error("No Hawaii parcel TMK found for this address");
  }

  const islandCode = String(selected.island ?? "").toUpperCase();
  const islandLabel = HAWAII_ISLAND_LABELS[islandCode] || String(selected.county ?? "Hawaii");
  const qpubLink = typeof selected.qpub_link === "string" ? selected.qpub_link : undefined;
  const numericUnit = Boolean(unitToken && /^\d+$/.test(unitToken));
  const isUnitCpr = numericUnit && !taxMapKey.endsWith("000");

  return {
    taxMapKey,
    confidence: isUnitCpr ? "unit-cpr" : "master-parcel",
    note: isUnitCpr
      ? `Matched the official State of Hawaii (${islandLabel}) GIS parcel ${taxMapKey} (numeric unit ${unitToken}) from the exact Guesty listing address.`
      : `Matched the official State of Hawaii (${islandLabel}) GIS master parcel for the exact Guesty listing address. The statewide layer exposes the master TMK, not individual CPR/condo units — verify the qPublic link before pushing if the channel requires a unit-level CPR.`,
    searchedAddress,
    geocodedAddress: geo.address,
    source: `State of Hawaii Statewide GIS Parcels (${islandLabel})`,
    sourceUrl: qpubLink || HAWAII_STATEWIDE_TMK_LAYER,
    parcel: {
      PARTXT: taxMapKey,
      COTMK: Number(tmkDigits(selected.cty_tmk)) || undefined,
      TYPE: "Statewide TMK parcel",
      LINKQ: qpubLink,
    },
    candidates: features.slice(0, 8).map((row) => ({
      taxMapKey: formatGeodataTaxMapKey(row.tmk_txt),
      cprUnit: "",
      owner: null,
      project: typeof row.county === "string" ? row.county : null,
      type: "Statewide TMK parcel",
      sourceUrl: typeof row.qpub_link === "string" ? row.qpub_link : null,
    })),
  };
}

const HAWAII_TAT_PATTERN = /\bTA-\d{3}-\d{3}-\d{4}-\d{2}\b/i;
const HAWAII_GET_PATTERN = /\bGE-\d{3}-\d{3}-\d{4}-\d{2}\b/i;
// Per-county STR permit shapes, in the forms counties actually issue
// (2026-07-10): Kauai TVR-YYYY-NN / TVNC-#### (registry also renders
// "TVNC #1317"); Big Island STVR-19-#### and NUC-19-#### (the county's
// renewal form numbers certificates "STVR - 19 - ____" — the legacy
// STVR-YYYY-###### alternative stays for values we pushed historically);
// Maui ST<region>YYYYNNNN from the Approved STRH list (STKM/STWM/STHA/
// STWK/STMP/STPH/STLA + generic STRH); Oahu NUC-##-####. Longer
// alternatives are listed before their shorter prefixes so the ordered
// alternation never truncates a full permit (e.g. NUC-24-001-0134).
const HAWAII_STR_PATTERN = /\b(?:TVR-\d{4}-\d{2,4}|TVNC[-\s#]{0,2}\d{3,4}|STVR-\d{4}-\d{6}|STVR[-\s]?\d{2}[-\s]?\d{3,6}|ST(?:HA|WK|KM|MP|PH|WM|LA|RH)[-\s]?\d{8}|STPH[-\s]?\d{4,8}|NUC-\d{2}-\d{3}-\d{4}|NUC[-\s]?\d{2}[-\s]?\d{3,4})\b/i;

const classifyTopLevelLicense = (value: unknown): "tat" | "get" | "str" | null => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (HAWAII_TAT_PATTERN.test(raw)) return "tat";
  if (HAWAII_GET_PATTERN.test(raw)) return "get";
  if (HAWAII_STR_PATTERN.test(raw)) return "str";
  return null;
};

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

type HawaiiPublicLicenseLookupInput = {
  address: string;
  listingName?: string | null;
};

type HawaiiPublicLicenseLookupResult = Required<HawaiiComplianceValues> & {
  source: string;
  sourceUrl?: string;
  note: string;
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
  const licenseNumberKind = classifyTopLevelLicense(listing.licenseNumber);
  const taxIdKind = classifyTopLevelLicense(listing.taxId);
  const fromTopLevelTat = licenseNumberKind === "tat"
    ? usableLicenseValue(listing.licenseNumber)
    : taxIdKind === "tat"
      ? usableLicenseValue(listing.taxId)
      : null;
  const fromTopLevelGet = taxIdKind === "get"
    ? usableLicenseValue(listing.taxId)
    : licenseNumberKind === "get"
      ? usableLicenseValue(listing.licenseNumber)
      : null;
  const fromTopLevelStr = licenseNumberKind === "str"
    ? usableLicenseValue(listing.licenseNumber)
    : taxIdKind === "str"
      ? usableLicenseValue(listing.taxId)
      : null;
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
    const permitMatch = notes.match(HAWAII_STR_PATTERN);
    return permitMatch ? usableLicenseValue(permitMatch[0]) : null;
  })();

  return {
    taxMapKey: tagValue(tags, "TMK:") || contentValue("tmk_number") || fromHomeawayTmk,
    tatLicense,
    getLicense,
    strPermit: tagValue(tags, "STR:") || fromTopLevelStr || contentValue("permit_number") || strFromNotes,
  };
}

const normalizePublicTmk = (value: unknown): string | null => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 11 && digits.length <= 13 ? digits : null;
};

export function extractHawaiiComplianceFromPublicText(text: string): Required<HawaiiComplianceValues> {
  const tmkLabeledPatterns = [
    /(?:Property\s+Registration\s+Number|Tax\s+Map\s+Key|TMK|MAP\s+License|MAP)\s*[:#]?\s*((?:\(?\d\)?\s*)?\d[-\s]?\d[-\s]?\d{3}[-:\s]?\d{3}(?:[-:\s]?\d{3,4})?|\d{11,13})/i,
    /\bTMK\s*\(?\s*(\d\s*\)?\s*\d[-\s]?\d[-\s]?\d{3}[-:\s]?\d{3}(?:[-:\s]?\d{3,4})?)\b/i,
  ];
  const taxMapKey = (() => {
    for (const pattern of tmkLabeledPatterns) {
      const match = text.match(pattern);
      const normalized = normalizePublicTmk(match?.[1]);
      if (normalized) return normalized;
    }
    return null;
  })();
  const tatLicense = usableLicenseValue(text.match(HAWAII_TAT_PATTERN)?.[0]);
  const getLicense = usableLicenseValue(text.match(HAWAII_GET_PATTERN)?.[0]);
  const strPermit = usableLicenseValue(text.match(HAWAII_STR_PATTERN)?.[0]);
  return { taxMapKey, tatLicense, getLicense, strPermit };
}

const chooseTaxMapKey = (current: string | null, candidate: string | null): string | null => {
  if (!candidate) return current;
  if (!current) return candidate;
  return candidate.length > current.length && candidate.endsWith(current) ? candidate : current;
};

const mergeHawaiiValues = (base: Required<HawaiiComplianceValues>, next: HawaiiComplianceValues): Required<HawaiiComplianceValues> => ({
  taxMapKey: chooseTaxMapKey(base.taxMapKey, usableLicenseValue(next.taxMapKey)),
  tatLicense: base.tatLicense || usableLicenseValue(next.tatLicense) || null,
  getLicense: base.getLicense || usableLicenseValue(next.getLicense) || null,
  strPermit: base.strPermit || usableLicenseValue(next.strPermit) || null,
});

const compactListingSearchText = (value: unknown): string => {
  return String(value ?? "")
    .replace(/\b(?:sleeps?|bedrooms?|bdrm|br|bathrooms?|baths?|condos?|units?)\b/gi, " ")
    .replace(/[^\w\s'-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const searchApiGoogle = async (query: string): Promise<Array<{ title?: string; link?: string; snippet?: string }>> => {
  const apiKey = process.env.SEARCHAPI_API_KEY;
  if (!apiKey) return [];
  const params = new URLSearchParams({ engine: "google", q: query, num: "6", api_key: apiKey });
  const resp = await fetch(`https://www.searchapi.io/api/v1/search?${params.toString()}`, {
    headers: { "User-Agent": "NexStay/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`SearchAPI Google lookup failed (${resp.status})`);
  const data = await resp.json() as any;
  return Array.isArray(data?.organic_results) ? data.organic_results : [];
};

const fetchPublicLicensePageText = async (url: string): Promise<string | null> => {
  const allowed = /(?:^|\.)((booking|redawning|vrbo|hawaiilife)\.com)$/i;
  let host = "";
  try { host = new URL(url).hostname; } catch { return null; }
  if (!allowed.test(host)) return null;
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "NexStay/1.0" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 250_000);
  } catch {
    return null;
  }
};

export async function lookupHawaiiPublicListingLicenses(input: HawaiiPublicLicenseLookupInput): Promise<HawaiiPublicLicenseLookupResult | null> {
  const address = input.address.trim();
  const listingName = compactListingSearchText(input.listingName);
  const querySeeds = new Set<string>();
  if (listingName) {
    querySeeds.add(`"${listingName}" Hawaii "TA-" "GE-"`);
    querySeeds.add(`"${listingName}" "Property Registration Number"`);
  }
  querySeeds.add(`"${address}" Hawaii "TA-" "GE-"`);
  querySeeds.add(`"${address}" "Property Registration Number"`);
  if (/menehune\s+shores/i.test(`${listingName} ${address}`)) {
    querySeeds.add(`"Menehune Shores" Kihei "TA-" "GE-" "Property Registration Number"`);
  }

  let values: Required<HawaiiComplianceValues> = { taxMapKey: null, tatLicense: null, getLicense: null, strPermit: null };
  let bestSourceUrl: string | undefined;
  let bestSource = "public OTA/direct listing search";
  const pagesToFetch = new Set<string>();

  for (const query of Array.from(querySeeds).slice(0, 5)) {
    let results: Array<{ title?: string; link?: string; snippet?: string }> = [];
    try {
      results = await searchApiGoogle(query);
    } catch (e: any) {
      console.warn(`[hawaii-public-license] ${e?.message ?? e}`);
      continue;
    }
    for (const result of results) {
      const haystack = `${result.title ?? ""}\n${result.snippet ?? ""}\n${result.link ?? ""}`;
      const extracted = extractHawaiiComplianceFromPublicText(haystack);
      const before = JSON.stringify(values);
      values = mergeHawaiiValues(values, extracted);
      if (JSON.stringify(values) !== before && result.link) {
        bestSourceUrl = result.link;
        bestSource = result.title || bestSource;
      }
      if (result.link && /(booking|redawning|hawaiilife)\.com/i.test(result.link)) pagesToFetch.add(result.link);
      if (values.taxMapKey && values.tatLicense && values.getLicense && values.strPermit) break;
    }
    if (values.taxMapKey && values.tatLicense && values.getLicense && values.strPermit) break;
  }

  if (!(values.taxMapKey && values.tatLicense && values.getLicense && values.strPermit)) {
    for (const url of Array.from(pagesToFetch).slice(0, 3)) {
      const pageText = await fetchPublicLicensePageText(url);
      if (!pageText) continue;
      values = mergeHawaiiValues(values, extractHawaiiComplianceFromPublicText(pageText));
      bestSourceUrl = url;
      if (values.taxMapKey && values.tatLicense && values.getLicense && values.strPermit) break;
    }
  }

  if (!values.taxMapKey && !values.tatLicense && !values.getLicense && !values.strPermit) return null;
  return {
    ...values,
    source: bestSource,
    sourceUrl: bestSourceUrl,
    note: `Pulled public Hawaii compliance values from ${bestSourceUrl ? "a public listing result" : "public listing search snippets"}. Verify against the owner/official records before publishing.`,
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
  listingName?: string | null;
  listingId?: string | null;
  taxMapKey?: string | null;
  propertyValues?: HawaiiComplianceValues | null;
  fetchGuestyListing?: (listingId: string) => Promise<Record<string, unknown>>;
}): Promise<HawaiiComplianceLookupResult> {
  const { field, address, listingName, listingId, taxMapKey, propertyValues, fetchGuestyListing } = options;
  const searchedAddress = address.trim();
  const label = fieldLabel(field);

  // FAIL-OPEN on the Guesty read (2026-07-15): all Guesty calls queue behind
  // guesty-sync's global rate-limit gate, so this fetch can time out while a
  // 429 pause drains. That must not abort the whole lookup — the county
  // registry + public-listing legs below can still find the value. The
  // failure is remembered so a no-value outcome stays honest about the
  // skipped source.
  let guestyFetchError: string | null = null;
  if (listingId && fetchGuestyListing) {
    try {
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
    } catch (e: any) {
      guestyFetchError = e?.message ?? String(e);
      console.warn(`[hawaii-compliance] Guesty listing read failed for ${listingId} (${guestyFetchError}) — falling through to registry/public sources`);
    }
  }

  if (field === "strPermit") {
    if (/\b(kauai|koloa|poipu|princeville|kapaa|lihue|wailua|hanalei|waimea|kekaha)\b/i.test(searchedAddress)) {
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
    } else if (/\b(maui|kihei|wailea|makena|lahaina|kaanapali|kapalua|napili|kahului|wailuku|hana|paia|haiku|makawao|pukalani|kula|lanai|molokai|kaunakakai)\b/i.test(searchedAddress)) {
      // Maui County: match the county's published Approved STRH list by
      // TMK root (+ address confirmation). Fail-open — a registry fetch
      // problem falls through to the public-listing search below instead
      // of failing the whole lookup (unlike Kauai, most legal Maui
      // short-term rentals are permit-exempt apartment/hotel-district
      // condos that will never appear on this list).
      try {
        const effectiveTmk = usableLicenseValue(taxMapKey)
          || (await lookupHawaiiStatewideTmkFromAddress(searchedAddress)).taxMapKey;
        const records = await fetchMauiStrhRecords();
        const match = matchMauiStrhPermit(records, effectiveTmk, searchedAddress);
        if (match) {
          return {
            value: match.value,
            confidence: "maui-strh-registry",
            note: match.note,
            searchedAddress,
            taxMapKey: effectiveTmk,
            source: "County of Maui Approved STRH list",
            sourceUrl: MAUI_STRH_PDF_URL,
          };
        }
      } catch (e: any) {
        console.warn(`[maui-strh-registry] lookup skipped: ${e?.message ?? e}`);
      }
    }
  }

  const publicValues = await lookupHawaiiPublicListingLicenses({ address: searchedAddress, listingName });
  const publicValue = publicValues ? resolveTaxField(field, publicValues) : null;
  if (publicValue) {
    return {
      value: publicValue,
      confidence: "public-listing",
      note: publicValues.note,
      searchedAddress,
      taxMapKey: publicValues.taxMapKey ?? undefined,
      source: publicValues.source,
      sourceUrl: publicValues.sourceUrl,
    };
  }

  throw new Error(
    listingId
      ? `No real ${label} license was found on the connected Guesty listing. Push compliance to Guesty after you have the official Hawaii ${label} license, or paste it manually.${guestyFetchError ? ` (The Guesty listing itself could not be read: ${guestyFetchError} — Guesty may be rate-limited; try again in a couple of minutes.)` : ""}`
      : `Select a connected Guesty listing to pull the real ${label} license from Guesty compliance fields, or paste it manually.`,
  );
}
