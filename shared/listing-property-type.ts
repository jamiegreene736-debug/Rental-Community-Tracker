// Listing PROPERTY-TYPE detection + condo-community gating (pure, shared).
//
// Root-caused 2026-07-22 (Mauna Lani Point draft -13, unit A): the dashboard
// replace flow committed 68-1034 Mauna Lani Point Dr — a 4BR SINGLE-FAMILY
// HOUSE that happens to sit on the condo community's street — as a replacement
// unit for a CONDO slot (unit_swaps 65). Every gate that ran was blind to
// property type: the resort-street community gate matches by street, the
// Claude-vision community check judges scenery (a luxury tropical house reads
// "same community" next to resort condos), and the find-unit candidate loop
// only checked bedrooms/photos. Redfin's page carried
// `"propertyType": "single family residential"` the whole time — the fact was
// scraped (ListingFacts.homeType) but only the single-listing find-clean-unit
// wizard ever consulted it.
//
// This module is the ONE source of truth for:
//  - normalizing raw portal type strings (Zillow homeType enums, Redfin
//    propertyTypeName, JSON-LD @type, visible text),
//  - deciding whether a community context EXPECTS condo-like units, and
//  - producing the rejection reason a replacement/find-new candidate gets when
//    its type contradicts that expectation.
//
// Fail-open by design: an unknown/absent type NEVER rejects — only a POSITIVE
// house/lot/mobile detection does, and only when the community context is
// positively condo-like. Communities of standalone homes keep working.

export type NormalizedListingPropertyType =
  | "single_family"
  | "condo"
  | "townhouse"
  | "apartment"
  | "lot"
  | "manufactured"
  | "other";

/** Raw portal type string → normalized bucket (null when absent/unrecognized). */
export function normalizeListingPropertyType(raw: unknown): NormalizedListingPropertyType | null {
  const s = String(raw ?? "").trim().toLowerCase().replace(/[_-]+/g, " ");
  if (!s) return null;
  if (/(^|\b)(vacant )?(lot|land)s?\b/.test(s)) return "lot";
  if (/manufactured|mobile home|mobile\b/.test(s)) return "manufactured";
  if (/condo|co ?op\b|condominium/.test(s)) return "condo";
  if (/town ?(house|home)|townhome/.test(s)) return "townhouse";
  if (/apartment|multi family|multifamily/.test(s)) return "apartment";
  if (/single family|singlefamily|single fam\b|detached|(^|\b)house\b|(^|\b)home\b(?!s\.com)/.test(s)) return "single_family";
  return "other";
}

/**
 * Does this community context expect CONDO-LIKE units? Derived from the
 * draft/builder's own stored type ("Condominium", unitTypes "condominium",
 * "condo", "apartment", "townhome" …). Unknown → false (gate stays off).
 */
export function condoCommunityExpected(
  propertyType: string | null | undefined,
  unitTypes?: string | null,
): boolean {
  const text = `${propertyType ?? ""} ${unitTypes ?? ""}`.toLowerCase();
  return /condo|apartment|townho/.test(text);
}

/**
 * Rejection reason for a replacement / find-new candidate whose detected type
 * contradicts a condo-community expectation. Null = candidate acceptable
 * (including every unknown-type case — absence of evidence never rejects).
 */
export function replacementPropertyTypeRejection(input: {
  expectCondoUnits: boolean;
  homeType?: string | null;
  propertySubType?: string | null;
}): string | null {
  if (!input.expectCondoUnits) return null;
  const primary = normalizeListingPropertyType(input.homeType);
  const sub = normalizeListingPropertyType(input.propertySubType);
  // A condo-ish PRIMARY type wins over a noisy sub-type (Redfin stuffs the same
  // string into both; Zillow can pair homeType CONDO with an odd sub-type).
  if (primary === "condo" || primary === "townhouse" || primary === "apartment") return null;
  const detected = primary ?? sub;
  if (detected === "single_family" || detected === "lot" || detected === "manufactured") {
    const rawShown = String(input.homeType ?? input.propertySubType ?? "").trim();
    return `Wrong property type for a condo community: listing is ${rawShown || detected.replace("_", " ")} (need condo / townhouse / apartment).`;
  }
  return null;
}

/**
 * Deterministic property-type extraction from a listing page's raw HTML.
 * Covers Redfin (`propertyTypeName":"Single Family Residential"` and
 * `"propertyType": "single family residential"`), Zillow
 * (`"homeType":"SINGLE_FAMILY"` / `"CONDO"`), JSON-LD @type
 * (SingleFamilyResidence / Apartment), and the visible "Property Type" text.
 * Returns the RAW matched string (feed it to normalizeListingPropertyType);
 * null when nothing recognizable is present.
 */
export function detectPropertyTypeFromListingHtml(html: string): string | null {
  const safe = typeof html === "string" ? html : "";
  if (!safe) return null;
  const patterns: RegExp[] = [
    // Redfin's plain-JSON subject-property record FIRST — the escaped
    // propertyTypeName form also appears in nearby-homes/land rows whose first
    // occurrence can belong to a NEIGHBOR (live-verified on 68-1034: the first
    // propertyTypeName was a nearby "Vacant Land" row).
    /"propertyType"\s*:\s*"([^"]{3,40})"/i,
    // Zillow homeType enum.
    /"homeType"\s*:\s*"([A-Z_]{3,30})"/,
    // Redfin escaped embedded JSON (fallback).
    /propertyTypeName\\?"\s*:\s*\\?"([^"\\]{3,40})/i,
    // JSON-LD @type (only the residence-shaped ones — never Organization etc).
    /"@type"\s*:\s*"(SingleFamilyResidence|Apartment|House|Condominium)"/i,
    // Visible spec-table text: "Property Type</span>...Single Family Residential".
    /Property\s*Type(?:\s|<[^>]{0,120}>|[^a-zA-Z<]){0,80}(Single[- ]Family(?: Residen\w+)?|Condo(?:minium|\/Co-op)?|Townho(?:use|me)|Apartment|Mobile\/Manufactured|Vacant Land)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(safe);
    if (m?.[1] && normalizeListingPropertyType(m[1]) !== null) return m[1];
  }
  return null;
}

/**
 * Deterministic bedroom-count extraction from a listing page's raw HTML —
 * structured JSON keys first (Redfin numBeds, Zillow bedrooms), visible
 * "N beds" text last. Null when nothing parseable. Used by the source-page
 * fact cross-check; sanity-bounded to 1..20.
 */
export function detectBedroomsFromListingHtml(html: string): number | null {
  const safe = typeof html === "string" ? html : "";
  if (!safe) return null;
  const patterns: RegExp[] = [
    /numBeds\\?"\s*:\s*(\d{1,2})/i,
    /"bedrooms"\s*:\s*(\d{1,2})/i,
    /"numberOfBedrooms"\s*:\s*(\d{1,2})/i,
    /"beds"\s*:\s*(\d{1,2})/i,
    /(\d{1,2})\s*(?:<[^>]+>\s*)*(?:Beds?\b|bd\b|Bedrooms?\b)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(safe);
    if (m?.[1]) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 1 && n <= 20) return n;
    }
  }
  return null;
}

/**
 * Human-readable contradiction between a source listing's SCRAPED facts and the
 * unit's CONFIGURED identity (bedrooms + condo expectation) — the line the
 * "Check photo community" report shows so a wrong-type / wrong-size source page
 * is caught the moment a human (or gate) looks. Null = no contradiction proven.
 * Absence of scraped facts never contradicts.
 */
export function sourceListingFactContradiction(input: {
  unitLabel: string;
  configuredBedrooms?: number | null;
  scrapedBedrooms?: number | null;
  expectCondoUnits: boolean;
  scrapedPropertyType?: string | null;
}): string | null {
  const problems: string[] = [];
  const cfg = input.configuredBedrooms;
  const scraped = input.scrapedBedrooms;
  if (
    typeof cfg === "number" && cfg > 0 &&
    typeof scraped === "number" && scraped > 0 &&
    scraped !== cfg
  ) {
    problems.push(`source listing says ${scraped}BR but this unit is configured as ${cfg}BR`);
  }
  const type = normalizeListingPropertyType(input.scrapedPropertyType);
  if (input.expectCondoUnits && (type === "single_family" || type === "lot" || type === "manufactured")) {
    problems.push(
      `source listing is a ${String(input.scrapedPropertyType).trim() || type.replace("_", " ")} — this community's units are condos`,
    );
  }
  if (problems.length === 0) return null;
  return `${input.unitLabel}: ${problems.join("; ")}`;
}
