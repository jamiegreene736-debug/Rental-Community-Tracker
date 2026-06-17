import { textMatchesResortPhrase } from "./buy-in-market";
import {
  communityAddressRuleForName,
  normalizeCommunityAddressToken,
  streetRootFromAddress,
} from "./community-addresses";
import { sharedResortPhraseKeys } from "./city-vrbo-combo";
import { listingIsOutOfArea } from "./listing-geo";
import {
  isCompoundUnitClaim,
  normalizeUnitClaim,
  unitVerificationClaims,
} from "./folder-unit-map";

export type PreflightPlatformKey = "airbnb" | "vrbo" | "booking";

export type PreflightMatchStatus = "confirmed" | "not-listed";

export type PreflightSearchResult = {
  title?: string | null;
  snippet?: string | null;
  link?: string | null;
};

export type PreflightMatchContext = {
  complexName: string;
  city: string;
  street: string;
  unitNumber: string;
  address?: string;
  bedrooms?: number | null;
};

export type PreflightMatchVerdict = {
  status: PreflightMatchStatus;
  url: string | null;
  detection: string;
};

const PLATFORM_DOMAINS: Record<PreflightPlatformKey, string> = {
  airbnb: "airbnb.com",
  vrbo: "vrbo.com",
  booking: "booking.com",
};

export function normalizePreflightSearchText(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isPreflightListingUrl(url: string, platform: PreflightPlatformKey): boolean {
  const lu = String(url || "").toLowerCase();
  if (!lu) return false;
  if (platform === "airbnb") {
    return lu.includes("airbnb.com/rooms/") || lu.includes("airbnb.com/h/");
  }
  if (platform === "vrbo") {
    if (/vrbo\.com\/\d+[a-z]{0,3}(?:[\/?#]|$)/.test(lu)) return true;
    if (/vrbo\.com\/[a-z]{2}-[a-z]{2}\/p\d+/.test(lu)) return true;
    if (/vrbo\.com\/vacation-rental\/p\d+/.test(lu)) return true;
    return false;
  }
  if (platform === "booking") {
    return lu.includes("booking.com/hotel/") || lu.includes("booking.com/apartments/");
  }
  return lu.includes(PLATFORM_DOMAINS[platform]);
}

function resultHaystack(result: PreflightSearchResult): string {
  return `${result.title || ""} ${result.snippet || ""} ${result.link || ""}`;
}

function escapeUnitRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unitClaimVariants(claim: string): string[] {
  const normalized = normalizeUnitClaim(claim);
  return Array.from(new Set([
    normalized,
    normalized.replace(/\s+/g, "-"),
    normalized.replace(/[\s-]+/g, ""),
  ].filter((v) => v && (v === normalized || v.length >= 3))));
}

function isShortUnitNumber(value: string): boolean {
  return /^\d{1,2}$/.test(normalizeUnitClaim(value));
}

export function snippetMentionsUnit(
  result: PreflightSearchResult,
  unitNumber: string,
  streetTail = "",
): boolean {
  const text = resultHaystack(result).toLowerCase();
  const claims = unitVerificationClaims(unitNumber, "");
  const unitClaims = claims.length > 0 ? claims : [normalizeUnitClaim(unitNumber)].filter(Boolean);
  if (unitClaims.length === 0) return false;

  for (const claim of unitClaims) {
    const num = normalizeUnitClaim(claim).replace(/^0+(?=\d)/, "");
    if (!num) continue;
    const markerPatterns = unitClaimVariants(num).flatMap((variant) => {
      const escaped = escapeUnitRegex(variant.toLowerCase());
      return [
        new RegExp(`\\b(?:unit|apt\\.?|apartment|villa|townhome|townhouse|building|bldg|cottage|casita)\\s*(?:#|no\\.?\\s*)?\\s*${escaped}\\b`, "i"),
        new RegExp(`#\\s*${escaped}\\b`, "i"),
        new RegExp(`-${escaped}(?:[\\/\\?\\-]|$)`, "i"),
      ];
    });
    if (markerPatterns.some((re) => re.test(text))) return true;

    if (streetTail && !isShortUnitNumber(unitNumber)) {
      const tail = streetTail.toLowerCase();
      for (const variant of unitClaimVariants(num)) {
        const adjacent = new RegExp(
          `\\b${escapeUnitRegex(tail)}\\s*,?\\s*#?\\s*${escapeUnitRegex(variant.toLowerCase())}\\b`,
          "i",
        );
        if (adjacent.test(text)) return true;
      }
    }
  }
  return false;
}

export function addressEvidenceInResult(result: PreflightSearchResult, street: string): boolean {
  const normalizedStreet = normalizePreflightSearchText(street);
  if (!normalizedStreet || normalizedStreet.length < 5) return false;
  const hay = normalizePreflightSearchText(resultHaystack(result));
  if (hay.includes(normalizedStreet)) return true;
  const parts = normalizedStreet.split(" ").filter(Boolean);
  const streetNumber = parts[0] || "";
  const streetNameParts = parts.slice(1).filter((p) => p.length > 2);
  const streetNameHits = streetNameParts.filter((p) => hay.includes(p)).length;
  return /^\d+$/.test(streetNumber) && hay.includes(streetNumber) && streetNameHits >= Math.min(2, streetNameParts.length);
}

function allowedCityTokens(city: string, complexName: string): string[] {
  const rule = communityAddressRuleForName(complexName);
  const cities = [city, ...(rule?.cityAliases ?? []), rule?.city ?? ""]
    .map((c) => normalizeCommunityAddressToken(c))
    .filter(Boolean);
  return Array.from(new Set(cities));
}

export function cityEvidenceInResult(result: PreflightSearchResult, city: string, complexName: string): boolean {
  const hay = normalizePreflightSearchText(resultHaystack(result));
  return allowedCityTokens(city, complexName).some((token) => token.length >= 3 && hay.includes(token));
}

function resortDictKeysForText(text: string): Set<string> {
  const keys = sharedResortPhraseKeys({
    title: text,
    sourceLabel: "",
    snippet: text,
  });
  return new Set(keys.filter((key) => key.startsWith("dict:")).map((key) => key.slice(5)));
}

const INCOMPATIBLE_FOREIGN_LOCATION_PATTERNS = [
  /\brunaway\s+bay\b/i,
  /\bmontego\s+bay\b/i,
  /\bnegril\b/i,
  /\bocho\s+rios\b/i,
  /\bjamaica\b/i,
  /\bcancun\b/i,
  /\baruba\b/i,
];

export function listingHaystackIncompatibleWithCommunity(
  haystack: string,
  complexName: string,
  city = "",
): boolean {
  const hay = normalizePreflightSearchText(haystack);
  if (!hay) return false;
  if (listingIsOutOfArea(haystack)) return true;
  const rule = communityAddressRuleForName(complexName);
  const hawaiiTarget = (rule?.state || "").toUpperCase() === "HI"
    || /\b(hawaii|kauai|princeville|hanalei|kilauea)\b/i.test(`${complexName} ${city}`);
  if (hawaiiTarget && INCOMPATIBLE_FOREIGN_LOCATION_PATTERNS.some((re) => re.test(hay))) return true;
  return false;
}

export function communityEvidenceInResult(result: PreflightSearchResult, complexName: string): boolean {
  const hay = resultHaystack(result);
  if (textMatchesResortPhrase(hay, complexName)) return true;
  const targetKeys = resortDictKeysForText(complexName);
  if (targetKeys.size === 0) return false;
  const resultKeys = resortDictKeysForText(hay);
  for (const key of targetKeys) {
    if (resultKeys.has(key)) return true;
  }
  return false;
}

export function communityConflictsWithResult(result: PreflightSearchResult, complexName: string): string | null {
  const targetKeys = resortDictKeysForText(complexName);
  const resultKeys = resortDictKeysForText(resultHaystack(result));
  if (resultKeys.size === 0) return null;
  if (targetKeys.size === 0) {
    const first = Array.from(resultKeys)[0];
    return first ? `Different resort detected (${first})` : null;
  }
  for (const key of resultKeys) {
    if (!targetKeys.has(key)) return `Different resort detected (${key})`;
  }
  return null;
}

export function bedroomCountInSnippet(text: string): number | null {
  const normalized = String(text ?? "").toLowerCase();
  const patterns = [
    /\b(\d+)\s*(?:br|bed(?:room)?s?)\b/i,
    /\b(?:studio|one|two|three|four|five|six)\s*(?:bed(?:room)?s?)\b/i,
  ];
  const wordMap: Record<string, number> = {
    studio: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
  };
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const raw = match[1];
    if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
    const mapped = wordMap[raw];
    if (mapped != null) return mapped;
  }
  return null;
}

export function bedroomConflictsWithResult(
  result: PreflightSearchResult,
  expectedBedrooms?: number | null,
): string | null {
  if (expectedBedrooms == null || !Number.isFinite(expectedBedrooms) || expectedBedrooms <= 0) return null;
  const found = bedroomCountInSnippet(resultHaystack(result));
  if (found == null) return null;
  if (found !== expectedBedrooms) return `Bedroom mismatch (${found}BR in listing vs ${expectedBedrooms}BR unit)`;
  return null;
}

export function buildPreflightSearchQueries(input: {
  platform: PreflightPlatformKey;
  street: string;
  complexName: string;
  city: string;
  unitNumber: string;
}): string[] {
  const domain = PLATFORM_DOMAINS[input.platform];
  const bareUnit = String(input.unitNumber || "").trim();
  const ambiguousUnit = /^\d{1,2}$/.test(bareUnit);
  const unitQueryFragment = !bareUnit
    ? ""
    : ambiguousUnit
      ? `(${["Unit", "Apt", "Apartment", "Suite", "Villa", "Townhome", "Building"].map((w) => `"${w} ${bareUnit}"`).join(" OR ")})`
      : `"${bareUnit}"`;
  const cityFragment = input.city ? `"${input.city}"` : "";
  return Array.from(new Set([
    input.street ? `site:${domain} "${input.street}" ${unitQueryFragment} ${cityFragment}`.trim() : "",
    input.complexName ? `site:${domain} "${input.complexName}" ${unitQueryFragment} ${cityFragment}`.trim() : "",
  ].filter(Boolean)));
}

export function evaluatePreflightSearchResult(
  result: PreflightSearchResult,
  platform: PreflightPlatformKey,
  context: PreflightMatchContext,
): PreflightMatchVerdict | null {
  const link = String(result.link || "").trim();
  if (!link || !isPreflightListingUrl(link, platform)) return null;

  const hay = resultHaystack(result);
  if (listingHaystackIncompatibleWithCommunity(hay, context.complexName, context.city)) {
    return null;
  }
  if (listingIsOutOfArea(hay)) {
    return null;
  }

  const conflict = communityConflictsWithResult(result, context.complexName);
  if (conflict) return null;

  const bedroomConflict = bedroomConflictsWithResult(result, context.bedrooms);
  if (bedroomConflict) return null;

  const street = streetRootFromAddress(context.street || context.address || "");
  const streetName = street.replace(/^\d+\s*/, "").trim();
  const unitMentioned = snippetMentionsUnit(result, context.unitNumber, streetName);
  if (!unitMentioned) return null;

  const communityMatch = communityEvidenceInResult(result, context.complexName);
  const streetMatch = street ? addressEvidenceInResult(result, street) : false;
  const cityMatch = context.city ? cityEvidenceInResult(result, context.city, context.complexName) : false;

  if (!communityMatch) return null;
  if (!streetMatch && !cityMatch) return null;

  const snippet = `${result.title || ""} — ${result.snippet || ""}`.replace(/\s+/g, " ").trim().slice(0, 200);
  return {
    status: "confirmed",
    url: link,
    detection: snippet || "Listing matched community, location, and unit",
  };
}

export function preflightStreetFromAddress(address: string): string {
  const a = String(address || "").trim();
  if (!a) return "";
  if (a.includes(",")) return a.split(",")[0].trim();
  const m = a.match(/^(.*?\b(?:rd|road|st|street|ave|avenue|dr|drive|blvd|boulevard|ln|lane|way|ct|court|pl|place|ter|terrace|cir|circle|pkwy|parkway|hwy|highway))\b/i);
  return (m ? m[1] : a).trim();
}

export function stripUnitFromPreflightAddress(addr: string, unitNumber: string): string {
  const claims = unitVerificationClaims(unitNumber, addr);
  const primary = claims[0] || normalizeUnitClaim(unitNumber);
  if (!primary || !addr) return addr;
  const re = new RegExp(
    `(?:[,\\s])(?:unit\\s*#?|apt\\.?\\s*#?|apartment\\s*#?|suite\\s*#?|ste\\.?\\s*#?|no\\.?\\s*|#)?\\s*${escapeUnitRegex(primary)}(?=[,\\s]|$)`,
    "i",
  );
  return addr.replace(re, " ").replace(/\s*,\s*/g, ", ").replace(/\s{2,}/g, " ").trim();
}

export function buildPreflightMatchContext(input: {
  complexName: string;
  city: string;
  unitNumber: string;
  address: string;
  bedrooms?: number | null;
}): PreflightMatchContext {
  const cleanedAddr = stripUnitFromPreflightAddress(input.address, input.unitNumber);
  const rule = communityAddressRuleForName(input.complexName);
  const street = rule?.street || preflightStreetFromAddress(cleanedAddr);
  return {
    complexName: input.complexName,
    city: input.city,
    street,
    unitNumber: input.unitNumber,
    address: input.address,
    bedrooms: input.bedrooms ?? null,
  };
}

export function notListedVerdict(): PreflightMatchVerdict {
  return {
    status: "not-listed",
    url: null,
    detection: "No matching listing found",
  };
}