import {
  discoveryCommunityNameAliases,
  normalizeCommunityAddressToken,
  streetRootFromAddress,
} from "./community-addresses";

export type MarketReconPortal = "zillow" | "realtor" | "redfin" | "homes";

export type MarketReconInput = {
  streetAddress?: string | null;
  communityName?: string | null;
  city?: string | null;
  state?: string | null;
  bedrooms?: number | null;
};

const GENERIC_COMMUNITY_TOKENS = new Set([
  "at", "beach", "condo", "condominium", "condos", "country", "golf", "resort",
  "the", "tower", "villas", "villa", "club", "and", "of", "on", "in",
]);

function pushUnique(queries: string[], seen: Set<string>, query: string) {
  const normalized = query.replace(/\s+/g, " ").trim();
  if (!normalized || seen.has(normalized)) return;
  seen.add(normalized);
  queries.push(normalized);
}

/** Grok-style broad aggregator queries: building address + bedroom + portal site operators. */
export function buildMarketReconSearchQueries(input: MarketReconInput): string[] {
  const street = streetRootFromAddress(input.streetAddress);
  const city = String(input.city ?? "").trim();
  const state = String(input.state ?? "").trim();
  const bedrooms = Number(input.bedrooms);
  const hasBedrooms = Number.isFinite(bedrooms) && bedrooms > 0;
  const brGroup = hasBedrooms
    ? `(${bedrooms} bedroom OR ${bedrooms}BR OR "${bedrooms} bed")`
    : "(condo OR unit)";
  const brQuoted = hasBedrooms ? `"${bedrooms} bedroom"` : "";
  const brShort = hasBedrooms ? `"${bedrooms}BR"` : "";
  const communityNames = input.communityName
    ? Array.from(new Set([
      String(input.communityName).trim(),
      ...discoveryCommunityNameAliases(input.communityName),
    ].filter(Boolean)))
    : [];
  const queries: string[] = [];
  const seen = new Set<string>();

  if (street && city) {
    pushUnique(queries, seen, `"${street}" ${city} ${brGroup} (condo OR unit) site:zillow.com`);
    pushUnique(queries, seen, `"${street}" ${city} ${brGroup} site:realtor.com`);
    pushUnique(queries, seen, `"${street}" ${city} ${brGroup} site:redfin.com`);
    pushUnique(queries, seen, `${street} ${city} ${brGroup} (Zillow OR Redfin OR Realtor)`);
    if (brQuoted) {
      pushUnique(queries, seen, `site:zillow.com/homedetails "${street}" "${city}" ${brQuoted}`);
      pushUnique(queries, seen, `site:realtor.com/realestateandhomes-detail "${street}" "${city}" ${brQuoted}`);
      pushUnique(queries, seen, `site:redfin.com "${street}" "${city}" ${brQuoted}`);
    }
    if (state) {
      pushUnique(queries, seen, `site:zillow.com/homedetails "${street}" "${city}" "${state}"`);
      pushUnique(queries, seen, `site:realtor.com "${street}" "${city}" "${state}"`);
      pushUnique(queries, seen, `site:redfin.com "${street}" "${city}" "${state}"`);
    }
  }

  for (const name of communityNames) {
    if (street && city && brQuoted) {
      pushUnique(queries, seen, `"${street}" "${name}" ${city} ${brQuoted} site:zillow.com`);
      pushUnique(queries, seen, `"${street}" "${name}" ${city} ${brQuoted} site:realtor.com`);
      pushUnique(queries, seen, `"${street}" "${name}" ${city} ${brQuoted} site:redfin.com`);
    }
    if (city) {
      pushUnique(queries, seen, `"${name}" ${city} ${brGroup} (condo OR unit) site:zillow.com`);
      pushUnique(queries, seen, `"${name}" ${city} ${brGroup} site:realtor.com`);
      pushUnique(queries, seen, `"${name}" ${city} ${brGroup} site:redfin.com`);
    }
    if (brShort) {
      pushUnique(queries, seen, `site:zillow.com "${name}" ${brShort}`);
      pushUnique(queries, seen, `site:realtor.com "${name}" ${brShort}`);
      pushUnique(queries, seen, `site:redfin.com "${name}" ${brShort}`);
    }
  }

  return queries;
}

export function detectMarketReconPortal(link: string): MarketReconPortal | null {
  const lower = String(link ?? "").toLowerCase();
  if (/zillow\.com\/homedetails\//i.test(lower)) return "zillow";
  if (/realtor\.com\/realestateandhomes-detail\//i.test(lower)) return "realtor";
  if (/redfin\.com\/.+\/home\/\d+/i.test(lower)) return "redfin";
  if (/homes\.com\/property\//i.test(lower)) return "homes";
  return null;
}

function streetAnchorTokens(street: string): { number: string | null; nameTokens: string[] } {
  const normalized = normalizeCommunityAddressToken(street);
  const match = normalized.match(/^(\d+(?: \d+)?)\s+(.+?)\s+(?:st|rd|dr|ave|blvd|ln|way|ct|pl|pkwy|ter|trail|cir)$/);
  if (!match) {
    const parts = normalized.split(" ").filter(Boolean);
    return {
      number: parts.find((p) => /^\d/.test(p)) ?? null,
      nameTokens: parts.filter((p) => !/^\d/.test(p)),
    };
  }
  return {
    number: match[1],
    nameTokens: match[2].split(" ").filter((token) => token.length > 2),
  };
}

function distinctiveCommunityTokens(communityName: string | null | undefined): string[] {
  const normalized = normalizeCommunityAddressToken(String(communityName ?? ""));
  if (!normalized) return [];
  return normalized
    .split(" ")
    .filter((token) => token.length > 2 && !GENERIC_COMMUNITY_TOKENS.has(token));
}

/**
 * Relaxed first-pass anchor for aggregator sweep results. Accepts a listing when
 * the URL/title/snippet ties it to the known street OR a distinctive community token.
 * Snippet-only street mentions are allowed here (unlike the strict resort URL gate).
 */
export function marketReconLooksAnchored(
  link: string,
  title: string,
  snippet: string,
  input: MarketReconInput,
): boolean {
  if (!detectMarketReconPortal(link)) return false;

  const hay = normalizeCommunityAddressToken(`${link} ${title} ${snippet}`);
  if (!hay) return false;

  const street = streetRootFromAddress(input.streetAddress);
  if (street) {
    const streetNorm = normalizeCommunityAddressToken(street);
    if (streetNorm && hay.includes(streetNorm)) return true;
    const { number, nameTokens } = streetAnchorTokens(street);
    if (number && hay.includes(number)) {
      const nameHit = nameTokens.some((token) => hay.includes(token));
      if (nameHit) return true;
    }
    // When the resort street is known, do not accept community-name-only hits —
    // that would let unrelated inventory on the same city through the recon pass.
    return false;
  }

  const communityTokens = distinctiveCommunityTokens(input.communityName);
  if (communityTokens.length > 0) {
    const hits = communityTokens.filter((token) => hay.includes(token));
    if (hits.length >= Math.min(2, communityTokens.length)) return true;
    if (hits.length === 1 && communityTokens.length === 1) return true;
  }

  return false;
}
