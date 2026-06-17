import { textMatchesResortPhrase } from "./buy-in-market";
import {
  communityAddressRuleForName,
  discoveryCommunityNameAliases,
  normalizeCommunityAddressToken,
} from "./community-addresses";
import { normalizeUnitClaim, unitVerificationClaims } from "./folder-unit-map";

export const MIN_DISTINCT_STRONG_PHOTO_MATCHES = 2;

export const MIN_PHOTOS_FULL_UNIT_AUDIT = 3;

const ISLAND_KEYWORDS: Record<string, string[]> = {
  kauai: ["kauai", "lihue", "kapaa", "koloa", "poipu", "princeville", "hanalei", "kilauea", "waimea", "eleele", "kalaheo", "96766", "96746", "96756", "96765", "96741", "96714"],
  oahu: ["oahu", "honolulu", "waikiki", "kailua", "kaneohe", "aiea", "pearl city", "96815", "96816", "96734", "96701"],
  maui: ["maui", "kihei", "lahaina", "wailea", "paia", "makena", "kapalua", "kahului", "96753", "96761", "96732"],
  "big island": ["big island", "kona", "kailua-kona", "hilo", "waikoloa", "kohala", "waimea", "96740", "96720", "96743"],
  florida: ["florida", "kissimmee", "orlando", "destin", "fort myers", "naples", "miami", "tampa", "clearwater", "panama city"],
};

const INCOMPATIBLE_LOCATION_MARKERS: Array<{ whenIsland: string | null; whenCityIncludes?: string; patterns: RegExp[] }> = [
  {
    whenIsland: "kauai",
    patterns: [
      /\brunaway\s+bay\b/i,
      /\bmontego\s+bay\b/i,
      /\bnegril\b/i,
      /\bocho\s+rios\b/i,
      /\bjamaica\b/i,
      /\bcancun\b/i,
      /\baruba\b/i,
    ],
  },
];

export function normalizePlatformMatchText(value: string): string {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

export function detectIslandFromText(text: string): string | null {
  const lower = String(text || "").toLowerCase();
  for (const [island, keywords] of Object.entries(ISLAND_KEYWORDS)) {
    if (keywords.some((k) => lower.includes(k))) return island;
  }
  return null;
}

export function allowedCityTokens(communityName: string, city: string): string[] {
  const rule = communityAddressRuleForName(communityName);
  const tokens = new Set<string>();
  for (const value of [city, rule?.city, ...(rule?.cityAliases ?? [])]) {
    const normalized = normalizePlatformMatchText(String(value ?? ""));
    if (normalized.length >= 3) tokens.add(normalized);
  }
  return Array.from(tokens);
}

export function resortPhrasesForCommunity(communityName: string): string[] {
  return discoveryCommunityNameAliases(communityName).filter((phrase) => phrase.trim().length >= 4);
}

export function snippetMentionsCommunity(
  haystack: string,
  communityName: string,
  street = "",
  city = "",
): boolean {
  const hay = normalizePlatformMatchText(haystack);
  if (!hay) return false;

  const phrases = resortPhrasesForCommunity(communityName);
  if (phrases.some((phrase) => textMatchesResortPhrase(haystack, phrase))) return true;

  const normalizedStreet = normalizeCommunityAddressToken(street);
  if (normalizedStreet.length >= 5 && hay.includes(normalizedStreet)) return true;

  const streetNumber = normalizedStreet.split(" ")[0] || "";
  const streetNameParts = normalizedStreet.split(" ").slice(1).filter((p) => p.length > 2);
  if (/^\d+$/.test(streetNumber) && hay.includes(streetNumber) && streetNameParts.filter((p) => hay.includes(p)).length >= Math.min(2, streetNameParts.length)) {
    return true;
  }

  return allowedCityTokens(communityName, city).some((token) => token.length >= 4 && hay.includes(token));
}

export function listingLocationConflictsWithTarget(
  haystack: string,
  input: { communityName: string; city: string; state?: string },
): boolean {
  const hay = normalizePlatformMatchText(haystack);
  if (!hay) return false;

  const ourIsland = detectIslandFromText(`${input.city} ${input.communityName}`);
  const matchIsland = detectIslandFromText(haystack);
  if (ourIsland && matchIsland && ourIsland !== matchIsland) return true;

  for (const rule of INCOMPATIBLE_LOCATION_MARKERS) {
    if (rule.whenIsland && ourIsland !== rule.whenIsland) continue;
    if (rule.whenCityIncludes && !normalizePlatformMatchText(input.city).includes(normalizePlatformMatchText(rule.whenCityIncludes))) continue;
    if (rule.patterns.some((pattern) => pattern.test(hay))) return true;
  }

  if ((input.state || "").toUpperCase() === "HI" && /\b(florida|jamaica|texas|arizona|nevada|california)\b/.test(hay) && !/\b(hawaii|kauai|oahu|maui|molokai|lanai|hi)\b/.test(hay)) {
    return true;
  }

  return false;
}

export function explicitLetterUnitMarkers(unitNumber: string): string[] {
  const raw = String(unitNumber || "").trim();
  if (!/^[A-Za-z]$/.test(raw)) return [];
  const letter = raw.toUpperCase();
  return [`Unit ${letter}`, `#${letter}`, `Apt ${letter}`];
}

export function hasVerifiableUnitTokens(unitNumber: string, address = ""): boolean {
  if (unitVerificationClaims(unitNumber, address).length > 0) return true;
  return explicitLetterUnitMarkers(unitNumber).length > 0;
}

export type StrictPlatformCheckInput = {
  textListed: boolean | null;
  textUrl: string | null;
  textTitleMatch: boolean;
  textHasCommunity: boolean;
  textHasLocationConflict: boolean;
  photoFound: boolean;
  photoMatchedUrl: string | null;
  photoMatchCount: number;
  totalPhotos: number;
  photoHasCommunity: boolean;
  photoHasLocationConflict: boolean;
  photoHasUnitEvidence: boolean;
  fullPhotoAudit: boolean;
};

export type StrictPlatformCheckResult = {
  status: "confirmed" | "not-listed" | "error";
  url: string | null;
  detection: string;
};

export function minPhotosRequired(fullPhotoAudit: boolean): number {
  return fullPhotoAudit ? MIN_PHOTOS_FULL_UNIT_AUDIT : MIN_DISTINCT_STRONG_PHOTO_MATCHES;
}

export function photoEvidenceMeetsThreshold(photoMatchCount: number, fullPhotoAudit: boolean): boolean {
  return photoMatchCount >= minPhotosRequired(fullPhotoAudit);
}

export function combineStrictPlatformCheck(input: StrictPlatformCheckInput): StrictPlatformCheckResult {
  if (input.textListed === null) {
    return { status: "error", url: null, detection: "Could not verify" };
  }

  const minPhotos = minPhotosRequired(input.fullPhotoAudit);
  const photoStrongEnough = photoEvidenceMeetsThreshold(input.photoMatchCount, input.fullPhotoAudit);

  const textConfirmed =
    input.textListed === true
    && input.textTitleMatch
    && input.textHasCommunity
    && !input.textHasLocationConflict;

  const photoConfirmed =
    input.photoFound
    && photoStrongEnough
    && input.photoHasCommunity
    && input.photoHasUnitEvidence
    && !input.photoHasLocationConflict;

  if (textConfirmed) {
    return {
      status: "confirmed",
      url: input.textUrl,
      detection: "Unit, street, and community confirmed in listing text",
    };
  }

  if (photoConfirmed) {
    return {
      status: "confirmed",
      url: input.photoMatchedUrl,
      detection: `${input.photoMatchCount} interior photos matched with unit + community evidence (${input.totalPhotos} checked)`,
    };
  }

  if (input.textListed || input.photoFound) {
    return {
      status: "not-listed",
      url: null,
      detection: input.textHasLocationConflict || input.photoHasLocationConflict
        ? "Rejected — listing location does not match this community"
        : `Insufficient evidence (need unit + community + ${minPhotos}+ interior photos)`,
    };
  }

  return {
    status: "not-listed",
    url: null,
    detection: input.totalPhotos > 0
      ? `No listing match (${input.totalPhotos} photo${input.totalPhotos !== 1 ? "s" : ""} checked)`
      : "No listing match",
  };
}

export function letterUnitClaimForVerification(unitNumber: string): string | null {
  const markers = explicitLetterUnitMarkers(unitNumber);
  return markers.length > 0 ? normalizeUnitClaim(markers[0]) : null;
}
