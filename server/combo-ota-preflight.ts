import {
  isCommunityOrSharedPhotoCandidate,
  isStrongLensMatch,
  MIN_DISTINCT_STRONG_PHOTO_MATCHES,
} from "./photo-match-guardrails";

const PLATFORM_PATTERNS: Array<{ key: "airbnb" | "vrbo" | "booking"; site: string; urlPattern: RegExp }> = [
  { key: "airbnb", site: "airbnb.com", urlPattern: /airbnb\.com\/(rooms|h)\// },
  { key: "vrbo", site: "vrbo.com", urlPattern: /vrbo\.com\/\d+/ },
  { key: "booking", site: "booking.com", urlPattern: /booking\.com\/(hotel|apartments)\// },
];

export const MAX_COMBO_PHOTO_OTA_ATTEMPTS = 8;

export type ComboOtaPreflightResult = {
  qualifies: boolean;
  reason: string;
  photoChecksRun: number;
  listedOn: Array<"airbnb" | "vrbo" | "booking">;
};

function summarizeComboOtaPreflight(
  platforms: Record<"airbnb" | "vrbo" | "booking", { listed: boolean; matches: unknown[]; photoMatches: string[] }>,
  photoChecksRun: number,
): { qualifies: boolean; reason: string; listedOn: ComboOtaPreflightResult["listedOn"] } {
  const listedOn: ComboOtaPreflightResult["listedOn"] = [];
  const pushListed = (label: "airbnb" | "vrbo" | "booking", result: { listed: boolean; matches: unknown[]; photoMatches: string[] }) => {
    if (!result.listed) return;
    listedOn.push(label);
  };
  pushListed("airbnb", platforms.airbnb);
  pushListed("vrbo", platforms.vrbo);
  pushListed("booking", platforms.booking);
  const qualifies = listedOn.length === 0;
  const listedNames: string[] = [];
  const describe = (label: string, result: { listed: boolean; matches: unknown[]; photoMatches: string[] }) => {
    if (!result.listed) return;
    const sources: string[] = [];
    if (result.matches.length > 0) sources.push("address");
    if (result.photoMatches.length > 0) sources.push("photo match");
    listedNames.push(`${label} (${sources.join(" + ")})`);
  };
  describe("Airbnb", platforms.airbnb);
  describe("VRBO", platforms.vrbo);
  describe("Booking.com", platforms.booking);
  return {
    qualifies,
    listedOn,
    reason: qualifies
      ? `No matches on Airbnb, VRBO, or Booking.com.${photoChecksRun > 0 ? ` (${photoChecksRun} photo Lens check${photoChecksRun === 1 ? "" : "s"}.)` : ""}`
      : `Found existing listing(s) on: ${listedNames.join(", ")}.`,
  };
}

export async function runComboPhotoReverseSearch(
  apiKey: string,
  photoUrls: string[],
): Promise<{
  matches: { airbnb: string[]; vrbo: string[]; booking: string[] };
  checked: number;
}> {
  if (photoUrls.length === 0) {
    return { matches: { airbnb: [], vrbo: [], booking: [] }, checked: 0 };
  }
  const matches = {
    airbnb: new Set<string>(),
    vrbo: new Set<string>(),
    booking: new Set<string>(),
  };
  const sample = photoUrls
    .filter((url) => !isCommunityOrSharedPhotoCandidate({ url }))
    .slice(0, 3);
  let checked = 0;
  const photoHits = {
    airbnb: new Set<string>(),
    vrbo: new Set<string>(),
    booking: new Set<string>(),
  };
  for (const photoUrl of sample) {
    try {
      const url = `https://www.searchapi.io/api/v1/search?engine=google_lens&url=${encodeURIComponent(photoUrl)}&api_key=${apiKey}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(25_000) });
      if (!resp.ok) continue;
      const data: any = await resp.json();
      checked++;
      const rowsFrom = (source: string, rows: any[] | undefined): Array<{ source: string; row: any; idx: number }> =>
        Array.isArray(rows) ? rows.map((row, idx) => ({ source, row, idx })) : [];
      const allRows = [
        ...rowsFrom("visual", data.visual_matches),
        ...rowsFrom("page", data.pages_with_matching_images),
        ...rowsFrom("image", data.image_results),
        ...rowsFrom("organic", data.organic_results),
      ].filter(({ source, row, idx }) => isStrongLensMatch(row, source, Number(row?.position ?? idx + 1)));
      for (const { row } of allRows) {
        const link = String(row?.link || row?.url || row?.source_url || row?.source?.link || row?.source?.url || "");
        if (!link) continue;
        for (const p of PLATFORM_PATTERNS) {
          if (p.urlPattern.test(link)) {
            matches[p.key].add(link);
            photoHits[p.key].add(photoUrl);
          }
        }
      }
    } catch {
      // best effort
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    matches: {
      airbnb: photoHits.airbnb.size >= MIN_DISTINCT_STRONG_PHOTO_MATCHES ? Array.from(matches.airbnb) : [],
      vrbo: photoHits.vrbo.size >= MIN_DISTINCT_STRONG_PHOTO_MATCHES ? Array.from(matches.vrbo) : [],
      booking: photoHits.booking.size >= MIN_DISTINCT_STRONG_PHOTO_MATCHES ? Array.from(matches.booking) : [],
    },
    checked,
  };
}

/** Same gate as find-clean-unit / preflight: listed on Airbnb, VRBO, or Booking rejects the photo set. */
export async function runComboOtaPreflight(
  apiKey: string,
  photoUrls: string[],
  address: string,
  city: string,
  state: string,
): Promise<ComboOtaPreflightResult> {
  const streetPortion = address.includes(",") ? address.split(",")[0].trim() : address.trim();
  const streetLower = streetPortion.toLowerCase();

  const checkPlatformText = async (p: typeof PLATFORM_PATTERNS[0]) => {
    if (!streetPortion) return { matches: [] as Array<{ url: string; title: string; snippet: string }>, query: "" };
    const query = `site:${p.site} "${streetPortion}" "${city}"`;
    try {
      const url = `https://www.searchapi.io/api/v1/search?engine=google&q=${encodeURIComponent(query)}&num=10&api_key=${apiKey}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!resp.ok) return { matches: [], query };
      const data: any = await resp.json();
      const results: any[] = Array.isArray(data?.organic_results) ? data.organic_results : [];
      const matches: Array<{ url: string; title: string; snippet: string }> = [];
      for (const r of results) {
        const link = String(r?.link || "");
        const title = String(r?.title || "");
        const snippet = String(r?.snippet || "");
        if (!p.urlPattern.test(link)) continue;
        const haystack = `${title} ${snippet}`.toLowerCase();
        if (!haystack.includes(streetLower)) continue;
        matches.push({ url: link, title, snippet });
      }
      return { matches, query };
    } catch {
      return { matches: [], query };
    }
  };

  const [textResults, photoSearch] = await Promise.all([
    streetPortion ? Promise.all(PLATFORM_PATTERNS.map(checkPlatformText)) : Promise.resolve(PLATFORM_PATTERNS.map(() => ({ matches: [], query: "" }))),
    runComboPhotoReverseSearch(apiKey, photoUrls),
  ]);

  const platforms = {
    airbnb: {
      listed: textResults[0].matches.length > 0 || photoSearch.matches.airbnb.length > 0,
      matches: textResults[0].matches,
      photoMatches: photoSearch.matches.airbnb,
    },
    vrbo: {
      listed: textResults[1].matches.length > 0 || photoSearch.matches.vrbo.length > 0,
      matches: textResults[1].matches,
      photoMatches: photoSearch.matches.vrbo,
    },
    booking: {
      listed: textResults[2].matches.length > 0 || photoSearch.matches.booking.length > 0,
      matches: textResults[2].matches,
      photoMatches: photoSearch.matches.booking,
    },
  };
  const summary = summarizeComboOtaPreflight(platforms, photoSearch.checked);
  return {
    qualifies: summary.qualifies,
    reason: summary.reason,
    photoChecksRun: photoSearch.checked,
    listedOn: summary.listedOn,
  };
}
