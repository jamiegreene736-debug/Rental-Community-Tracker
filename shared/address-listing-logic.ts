// Pure helpers for the address-on-OTA leg of the photo/unit audit.
//
// The reverse-image scanner (server/photo-listing-scanner.ts) answers
// "are this unit's PHOTOS re-posted on Airbnb/VRBO/Booking?". This module
// is the complementary text-search leg: "does this unit's street ADDRESS
// appear on an Airbnb/VRBO/Booking listing page?". A thief who relists the
// same physical unit can swap the photos but not the address, so the two
// signals together close the gap the photo scan alone leaves.
//
// Mirrors the single-listing qualifier's proven query + filter shape
// (server/routes.ts runOtaQualifier): one Google `site:` query per
// platform for the street + city, then keep only results whose URL is a
// real listing-page shape AND whose title/snippet actually contains the
// street (so "Koloa, HI" alone can't match every Kauai rental).
//
// Everything here is network-free and deterministic so it can be unit
// tested without SearchAPI. The scanner supplies the SERP rows.

export type AddressPlatformKey = "airbnb" | "vrbo" | "booking";

export type AddressPlatform = {
  key: AddressPlatformKey;
  site: string;
  // A real listing page (not a search/region/help page) on that host.
  urlPattern: RegExp;
};

export const ADDRESS_PLATFORMS: AddressPlatform[] = [
  { key: "airbnb", site: "airbnb.com", urlPattern: /airbnb\.com\/(rooms|h)\// },
  { key: "vrbo", site: "vrbo.com", urlPattern: /vrbo\.com\/\d+/ },
  { key: "booking", site: "booking.com", urlPattern: /booking\.com\/(hotel|apartments)\// },
];

export type SerpRow = { link?: unknown; title?: unknown; snippet?: unknown };
export type AddressSerpMatch = { url: string; title: string; snippet: string };

// The street portion is everything before the first comma — "1831 Poipu
// Rd, Unit 423, Koloa, HI" → "1831 Poipu Rd". Callers pass the resort's
// canonical street (shared across units); unit disambiguation is done
// separately by the scanner's unit-number verification.
export function streetPortionOf(address: string): string {
  if (!address) return "";
  const trimmed = address.trim();
  return (trimmed.includes(",") ? trimmed.split(",")[0] : trimmed).trim();
}

export function buildAddressQuery(site: string, street: string, city: string): string {
  const cityClause = city ? ` "${city}"` : "";
  return `site:${site} "${street}"${cityClause}`;
}

// Keep only SERP rows that (a) are a real listing-page URL on the host and
// (b) actually surface the street in the title/snippet. The street check is
// what keeps a region/landing page ("Vacation rentals in Koloa") from
// counting as an address hit.
export function filterAddressSerpRows(
  rows: SerpRow[],
  platform: AddressPlatform,
  street: string,
): AddressSerpMatch[] {
  const streetLower = street.trim().toLowerCase();
  if (!streetLower) return [];
  const out: AddressSerpMatch[] = [];
  for (const r of rows) {
    const url = String(r?.link ?? "");
    const title = String(r?.title ?? "");
    const snippet = String(r?.snippet ?? "");
    if (!url) continue;
    if (!platform.urlPattern.test(url.toLowerCase())) continue;
    const haystack = `${title} ${snippet}`.toLowerCase();
    if (!haystack.includes(streetLower)) continue;
    out.push({ url, title, snippet });
  }
  return out;
}
