// SearchAPI Google Hotels supplement for find-buy-in (date-specific vacation rentals).
import { extractBedroomsFromListing } from "./community-research";
import { BUY_IN_MARKETS, resolveBuyInMarket } from "@shared/buy-in-market";

export type GoogleHotelsBuyInCandidate = {
  source: "pm";
  sourceLabel: string;
  title: string;
  url: string;
  originalSourceUrl: string;
  nightlyPrice: number;
  totalPrice: number;
  bedrooms?: number;
  snippet?: string;
  verified: "yes";
  verifiedNightlyPrice: number;
  verifiedReason: string;
};

function searchApiBoundingBoxFromCenter(center?: { lat: number; lng: number }): {
  googleHotels: string;
} | null {
  if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lng)) return null;
  const halfDeg = 0.015;
  const swLat = center.lat - halfDeg;
  const swLng = center.lng - halfDeg;
  const neLat = center.lat + halfDeg;
  const neLng = center.lng + halfDeg;
  return { googleHotels: `[${swLng},${swLat},${neLng},${neLat}]` };
}

function priceNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value.replace(/[^\d.]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function googleHotelCandidateKey(candidate: any): string {
  const link = String(candidate?.link ?? "").trim();
  if (link) {
    try {
      const u = new URL(link);
      u.search = "";
      u.hash = "";
      return u.toString().toLowerCase();
    } catch {
      return link.toLowerCase();
    }
  }
  return [
    candidate?.name ?? "",
    candidate?.gps_coordinates?.latitude ?? "",
    candidate?.gps_coordinates?.longitude ?? "",
  ].join("|").toLowerCase();
}

function targetTokens(value: string): string[] {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter((token) => token.length >= 3);
}

function textMatchesTarget(text: string, target: string): boolean {
  const tokens = targetTokens(target);
  if (tokens.length === 0) return true;
  const hay = text.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  return tokens.every((token) => hay.includes(token));
}

function coordsNearCenter(candidate: any, center?: { lat: number; lng: number }, pad = 0.02): boolean {
  if (!center) return false;
  const lat = Number(candidate?.gps_coordinates?.latitude ?? candidate?.gpsCoordinates?.latitude);
  const lng = Number(candidate?.gps_coordinates?.longitude ?? candidate?.gpsCoordinates?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return Math.abs(lat - center.lat) <= pad && Math.abs(lng - center.lng) <= pad;
}

function googleHotelEvidenceText(candidate: any): string {
  const fields: unknown[] = [
    candidate?.name,
    candidate?.title,
    candidate?.description,
    candidate?.link,
    ...(Array.isArray(candidate?.essential_info) ? candidate.essential_info : []),
    ...(Array.isArray(candidate?.nearby_places) ? candidate.nearby_places.map((place: any) => place?.name) : []),
    ...(Array.isArray(candidate?.offers) ? candidate.offers.map((offer: any) => offer?.source) : []),
  ];
  return fields
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");
}

function googleHotelBedroomSignal(candidate: any): number | null {
  const explicitFields = [
    candidate?.bedrooms,
    candidate?.bedroom_count,
    candidate?.bedroomCount,
    candidate?.extracted_bedrooms,
  ];
  for (const value of explicitFields) {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/[^\d.]/g, "")) : NaN;
    if (Number.isFinite(n) && n > 0 && n < 20) return Math.round(n);
  }
  return extractBedroomsFromListing({
    name: candidate?.name,
    title: candidate?.title ?? candidate?.name,
    description: googleHotelEvidenceText(candidate),
  });
}

function googleHotelTargetMatched(candidate: any, opts: {
  community: string;
  searchName?: string;
  sidecarDestination: string;
}): boolean {
  const evidence = googleHotelEvidenceText(candidate);
  const marketKey = resolveBuyInMarket({
    marketKey: opts.community,
    name: opts.community,
    listingTitle: opts.searchName,
    bookingTitle: opts.sidecarDestination,
  });
  const market = marketKey ? BUY_IN_MARKETS[marketKey] : null;
  if (market?.aliases.some((pattern) => pattern.test(evidence))) return true;

  const targets = [
    opts.searchName,
    opts.community,
    market?.key,
    market?.location?.searchName,
  ]
    .map((value) => String(value ?? "").trim())
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);

  return targets.some((target) => textMatchesTarget(evidence, target));
}

export async function fetchGoogleHotelsBuyInCandidates(args: {
  apiKey: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  bedrooms: number;
  buyInBedroomFloor: number;
  community: string;
  resortName?: string | null;
  searchLocation: string;
  bboxCenter?: { lat: number; lng: number };
  signal?: AbortSignal;
}): Promise<{ candidates: GoogleHotelsBuyInCandidate[]; rawCount: number; reason: string }> {
  const sidecarDestination = args.resortName ?? args.community;
  const params: Record<string, string> = {
    engine: "google_hotels",
    check_in_date: args.checkIn,
    check_out_date: args.checkOut,
    adults: "2",
    bedrooms: String(args.bedrooms),
    property_type: "vacation_rental",
    sort_by: "lowest_price",
    currency: "USD",
    api_key: args.apiKey,
  };
  const bbox = searchApiBoundingBoxFromCenter(args.bboxCenter);
  if (bbox) params.bounding_box = bbox.googleHotels;
  else params.q = `${sidecarDestination} ${args.searchLocation} vacation rentals`;

  const response = await fetch(
    `https://www.searchapi.io/api/v1/search?${new URLSearchParams(params).toString()}`,
    { signal: args.signal },
  );
  if (!response.ok) {
    return { candidates: [], rawCount: 0, reason: `SearchAPI Google Hotels HTTP ${response.status}` };
  }
  const data = await response.json() as any;
  if (data?.error) {
    return { candidates: [], rawCount: 0, reason: `SearchAPI Google Hotels: ${data.error}` };
  }

  const properties = Array.isArray(data?.properties) ? data.properties : [];
  const seen = new Set<string>();
  const candidates: GoogleHotelsBuyInCandidate[] = [];

  for (const row of properties) {
    if (String(row?.type ?? "").toLowerCase() && !String(row?.type ?? "").toLowerCase().includes("vacation")) continue;
    const key = googleHotelCandidateKey(row);
    if (seen.has(key)) continue;
    seen.add(key);

    const targetMatched = googleHotelTargetMatched(row, {
      community: args.community,
      searchName: sidecarDestination,
      sidecarDestination,
    });
    const locationMatched = args.bboxCenter
      ? targetMatched && coordsNearCenter(row, args.bboxCenter)
      : targetMatched;
    if (!locationMatched) continue;

    const parsedBedrooms = googleHotelBedroomSignal(row);
    if (parsedBedrooms == null || parsedBedrooms < args.buyInBedroomFloor) continue;

    const total = Math.round(priceNumber(row?.total_price?.extracted_price));
    const nightly = Math.round(
      total > 0 ? total / args.nights : priceNumber(row?.price_per_night?.extracted_price),
    );
    if (!(nightly > 0)) continue;

    const link = String(row?.link ?? "").trim();
    if (!link) continue;

    candidates.push({
      source: "pm",
      sourceLabel: "Google Hotels",
      title: String(row?.name ?? row?.title ?? "Google Hotels listing").slice(0, 100),
      originalSourceUrl: link,
      url: link,
      nightlyPrice: nightly,
      totalPrice: total > 0 ? total : nightly * args.nights,
      bedrooms: parsedBedrooms,
      snippet: `Google Hotels vacation rental · ${parsedBedrooms}BR · SearchAPI date-specific quote`,
      verified: "yes",
      verifiedNightlyPrice: nightly,
      verifiedReason: "SearchAPI Google Hotels engine returned a date-specific vacation-rental price for the resort window and bedroom filter",
    });
  }

  return {
    candidates,
    rawCount: properties.length,
    reason: `SearchAPI Google Hotels returned ${properties.length} vacation-rental listing(s); kept ${candidates.length}`,
  };
}
