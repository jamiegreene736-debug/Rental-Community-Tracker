// Parse a numbered street address out of a real-estate listing URL slug.
//
// Zillow/Realtor/Redfin detail URLs encode the unit's full street address in the
// path ("/homedetails/2827-Poipu-Rd-APT-201-Koloa-HI-96756/..."), which makes a
// title-matched listing URL a high-precision address source for the community the
// unit sits in. Extracted VERBATIM from server/routes.ts (2026-07-06) so
// server/community-address-discovery.ts can reuse it for the portal-SERP address
// rescue without importing the router. routes.ts re-imports this copy — keep ONE
// implementation.
export function parseListingAddressFromUrl(url: string): string | null {
  const titleCase = (value: string) => value.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const clean = (value: string): string | null => {
    const decoded = decodeURIComponent(value)
      .replace(/[_-]+/g, " ")
      .replace(/\b(?:FL|HI|CA|TX|NY|GA|SC|NC|AL|MS|LA|WA|OR|CO|AZ|NV)\b/gi, " ")
      .replace(/\b\d{5}(?: \d{4})?\b/g, " ")
      .replace(/\bM\d{4,}(?: \d+)?\b/gi, " ")
      .replace(/\bzpid\b.*$/i, " ")
      .replace(/\s+/g, " ")
      .trim();
    const m = decoded.match(
      /\b(\d{2,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:Blvd|Boulevard|Rd|Road|St|Street|Ave|Avenue|Dr|Drive|Ln|Lane|Way|Cir|Circle|Ct|Court|Pkwy|Parkway|Pl|Place|Ter|Terrace|Trail)(?:\s*(?:(?:#|Unit|Apt|Apartment|Suite|Ste)\s*)?[A-Za-z]?\d{1,5}[A-Za-z]?)?)\b/i,
    );
    return m?.[1] ? titleCase(m[1].trim()) : null;
  };

  const zillowMatch = url.match(/\/homedetails\/([^/]+)\//i);
  if (zillowMatch) return clean(zillowMatch[1]);

  const realtorMatch = url.match(/\/realestateandhomes-detail\/([^/?#]+)/i);
  if (realtorMatch) {
    const slug = realtorMatch[1];
    const firstSegment = slug.split("_")[0];
    return clean(firstSegment) ?? clean(slug);
  }

  const redfinMatch = url.match(/redfin\.com\/[A-Z]{2}\/[^/]+\/([^/]+)(?:\/unit-([^/]+))?\/home\//i);
  if (redfinMatch) {
    const street = redfinMatch[1];
    const unit = redfinMatch[2] ? ` Unit ${redfinMatch[2]}` : "";
    return clean(`${street}${unit}`);
  }

  const homesMatch = url.match(/homes\.com\/property\/([^/?#]+)(?:\/|$)/i);
  if (homesMatch) return clean(homesMatch[1]);

  return null;
}

// Moved VERBATIM from server/routes.ts (2026-07-17) so
// shared/same-unit-photo-hunt.ts can reuse the SAME address/street-root
// canonicalization the find-unit identity clusters use. routes.ts re-imports
// these copies — keep ONE implementation.
export function parseListingAddressFromText(text: string): string | null {
  const cleaned = text.replace(/&[#a-z0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
  const m = cleaned.match(
    /\b(\d{2,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:Blvd|Boulevard|Rd|Road|St|Street|Ave|Avenue|Dr|Drive|Ln|Lane|Way|Cir|Circle|Ct|Court|Pkwy|Parkway|Pl|Place|Ter|Terrace|Trail)(?:\s*(?:(?:#|Unit|Apt|Apartment|Suite|Ste)\s*)?[A-Za-z]?\d{1,5}[A-Za-z]?)?)\b/i,
  );
  return m?.[1]?.trim().replace(/\b[a-z]/g, (c) => c.toUpperCase()) ?? null;
}

export function streetRootFromListingAddress(address: string | null): string | null {
  if (!address) return null;
  const m = address
    .toLowerCase()
    .replace(/&[#a-z0-9]+;/gi, " ")
    .replace(/[^a-z0-9.'#\s-]+/g, " ")
    // Hawaii street numbers often use a district prefix, e.g.
    // "78-6833 Alii Dr". Treat that as one canonical street number
    // family ("78 6833 ...") so direct resort addresses and listing
    // URL slugs compare to the same root.
    .replace(/\b(\d{1,2})-(\d{3,5})(?=[\s-]+[a-z0-9])/gi, "$1 $2")
    // Redfin slugs like "92-1070-1-Olani-St" include a unit token between
    // the Hawaii street number and name; drop it so roots match "92-1070 Olani St".
    .replace(/\b(\d{1,2})\s+(\d{3,5})\s+\d{1,4}\s+(?=[a-z])/gi, "$1 $2 ")
    .replace(/\s+/g, " ")
    .match(/\b(\d{2,6})\s+([a-z0-9.'-]+(?:\s+[a-z0-9.'-]+){0,4})\s+(blvd|boulevard|rd|road|st|street|ave|avenue|dr|drive|ln|lane|way|cir|circle|ct|court|pkwy|parkway|pl|place|ter|terrace|trail)\b/i);
  if (!m) return null;
  const typeMap: Record<string, string> = {
    boulevard: "blvd",
    road: "rd",
    street: "st",
    avenue: "ave",
    drive: "dr",
    lane: "ln",
    circle: "cir",
    court: "ct",
    parkway: "pkwy",
    place: "pl",
    terrace: "ter",
  };
  let streetName = m[2]
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.'’‘-]/g, "")
    .replace(/^(?:n|s|e|w|north|south|east|west)\s+/i, "");
  const streetTokens = streetName.split(/\s+/).filter(Boolean);
  // Homes.com sometimes emits Hawaii hyphenated addresses as
  // "78-6833-6833-Alii-Dr" for a real "78-6833 Alii Dr" unit.
  // Collapse the duplicated street-number token so community root
  // checks do not reject otherwise valid Na Hale O Keauhou candidates.
  if (/^\d+$/.test(m[1]) && streetTokens.length >= 3 && streetTokens[0] === streetTokens[1]) {
    streetTokens.splice(1, 1);
    streetName = streetTokens.join(" ");
  }
  const streetType = typeMap[m[3]] ?? m[3];
  return `${m[1]} ${streetName} ${streetType}`;
}
