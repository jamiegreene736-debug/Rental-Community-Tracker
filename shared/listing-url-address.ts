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

  return null;
}
