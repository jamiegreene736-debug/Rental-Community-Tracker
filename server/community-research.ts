// Community research helper — pulled out of routes.ts so both the single-city
// endpoint (/api/community/research) and the multi-city scanner
// (/api/community/scan-top-markets) can reuse the same Google + Claude pipeline.

import { checkCommunityType } from "@shared/community-type";
import { geocode } from "./walking-distance";

export type ResearchedCommunity = {
  name: string;
  city: string;
  state: string;
  estimatedLowRate: number | null;
  estimatedHighRate: number | null;
  unitTypes: string;
  confidenceScore: number;
  researchSummary: string;
  sourceUrl: string;
  bedroomMix?: string;
  combinedBedroomsTypical?: number;
  combinabilityScore?: number;
  fromWorldKnowledge?: boolean;
  // CODEX NOTE (2026-05-04, claude/single-listing-bedroom-list):
  // Single-mode research returns the actual bedroom counts a
  // community offers (e.g. Santa Maria Resort = [2, 3]) so the
  // single-listing wizard can render only valid bedroom buttons
  // instead of a generic 1-5BR picker. Combo flow ignores this
  // field. Empty array means "Claude doesn't know" — wizard falls
  // back to the generic picker in that case.
  availableBedrooms?: number[];
};

// Pull a bedroom count out of a SearchAPI airbnb engine listing. The
// engine returns `bedrooms` only as part of the title text — never as
// a structured top-level field — so this function mostly reads the
// title. `accommodations` (an array of strings like "2 bedrooms",
// "1 bath") is a fallback when the title is too marketing-heavy to
// parse.
//
//   "Boho Chic 2BR Condo Near Disney"           → 2
//   "Spacious 3 Bedroom Vacation Home"          → 3
//   "Studio condo by the pool"                  → 0
//   "Cozy efficiency unit"                      → 0
//
// Returns NaN when nothing matches; callers drop the listing.
export function extractBedroomsFromListing(p: any): number {
  const title = String(p?.name ?? p?.title ?? "");
  const desc = String(p?.description ?? "");
  const accommodations = Array.isArray(p?.accommodations)
    ? p.accommodations.join(" ")
    : "";
  const text = `${title} ${desc} ${accommodations}`.toLowerCase();
  if (/\b(studio|efficiency)\b/.test(text)) return 0;
  // "2BR", "3 br", "2-bedroom", "3 bedroom", "Three Bedroom", etc.
  const numericMatch = text.match(/(\d+)\s*[-]?\s*(?:br\b|bd\b|bed\b|bedroom)/);
  if (numericMatch) {
    const n = parseInt(numericMatch[1], 10);
    if (Number.isFinite(n) && n >= 0 && n <= 10) return n;
  }
  const wordMap: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  };
  for (const [word, num] of Object.entries(wordMap)) {
    if (new RegExp(`\\b${word}[- ]bedroom`).test(text)) return num;
  }
  return NaN;
}

// 7-night amortized nightly lookup against SearchAPI's airbnb engine.
//
// `extracted_total_price` from the engine includes nightly + cleaning +
// service fees for the date range, so dividing by 7 gives the *amortized*
// per-night cost the way a real booking would actually price out — which
// is what we need for buy-in (cost basis) numbers.
//
// Why 7 nights / 30 days out:
//   - 7 nights = the assumption that a typical vacation-rental booking is
//     a week, so cleaning + service fees should amortize over 7 nights,
//     not 1. A 1-night quote inflates the apparent nightly by ~50% on
//     properties with $150-$300 cleaning fees.
//   - 30 days out = far enough that popular listings haven't blocked the
//     calendar (Airbnb often blocks last-minute) and that we dodge the
//     next-7-days surge pricing.
//
// Listing matching is layered (most specific to least):
//   1. If `addressHint` is provided AND geocodes successfully, the
//      function passes a tight ~500m bounding box to SearchAPI as
//      `sw_lat`/`ne_lat`/`sw_lng`/`ne_lng` AND post-filters listings
//      whose `gps_coordinates` fall outside that box. This is the most
//      reliable path: many listings don't name the resort in title or
//      description (e.g. Caribe Cove condos call themselves "Disney
//      Vacation Condo") so a name-only filter drops them all.
//   2. If `addressHint` is missing or geocode fails, the function falls
//      back to token-based name match: every word of length ≥3 in the
//      community name must appear in title or description. Looser than
//      a substring match but tight enough to filter "Caribe Royale" out
//      of a Caribe Cove search.
//
// Returns rates grouped by bedroom count + a `bboxApplied` flag so callers
// can distinguish "geocoded path used (high confidence)" from "name-token
// fallback used (lower confidence)". Nightly rates outside $50-$3000 are
// dropped (junk / regional outliers).
//
// BBOX_HALF_DEG = 0.015° ≈ 1.65km at FL/HI latitudes. Started at 0.005°
// (~500m) to fit a single resort, but Airbnb anonymizes coordinates until
// a booking is confirmed — typically ±0.5-1.0km offset from the actual
// unit. A 500m box dropped every Caribe Cove listing on the live engine
// even though the resort has 16+ listings on Airbnb. 1.65km is wide
// enough to absorb the anonymization without picking up neighbors —
// for resort-dense areas (Kissimmee, Poipu) the next nearest condo
// complex is generally >2km away.
const BBOX_HALF_DEG = 0.015;

export type AmortizedNightlyResult = {
  ratesByBR: Record<number, number[]>;
  bboxApplied: boolean;
  // Geocoded center of the bbox + radius for debugging. Surfaced by the
  // refresh-pricing endpoint so the operator can sanity-check the
  // coordinates without redeploying — e.g. "Treasure Trove Lane"
  // resolved to the right resort and not a same-named street elsewhere.
  bboxCenter?: { lat: number; lng: number };
  // Drop counters for diagnosing "engine returned listings but I got 0
  // rates" failures. Each filter reports how many listings it rejected;
  // `engineCount` is the raw count from SearchAPI before any filtering.
  drops?: {
    engineCount: number;
    outsideBbox: number;
    nameMismatch: number;
    noPrice: number;
    badBedrooms: number;
    nightlyOutOfRange: number;
  };
  // First-listing diagnostic — surfaced when no rates were captured so
  // the operator can see why filters dropped everything (e.g. bedrooms
  // arriving as a string instead of a number).
  firstListingSample?: unknown;
};

export async function fetchAmortizedNightlyByBR(
  communityName: string,
  city: string,
  state: string,
  addressHint?: string,
  // Optional explicit bbox center. When supplied, skips Nominatim
  // geocoding entirely. Useful for static properties where we have
  // operator-validated coordinates (e.g. Regency at Poipu Kai), since
  // Nominatim can't resolve specific street numbers in resort areas
  // and falls back to matching the road itself — which can land
  // ~1km+ off the actual building when the road is long. The
  // 2026-04-28 backfill failed for the Poipu Kai cluster because
  // Nominatim resolved "1831 Poipu Rd" to the road's northern end
  // and the resort sits at the southern end, putting all 19 returned
  // listings outside the bbox after Airbnb's ±0.5-1km anonymization.
  bboxCenterOverride?: { lat: number; lng: number },
  // Optional explicit window. When supplied, overrides the default
  // "30d-out, 7-night" behavior. Used by the multi-season scan (PR
  // #282) to pull per-season basis from the engine.
  dateOverride?: { checkIn: string; checkOut: string },
  // PR #288: optional sparse-BR retry. When `bedrooms` is supplied,
  // the engine query includes `bedrooms=N` so the engine prioritises
  // that BR. `bboxScale` widens the bounding box (e.g. 2 = 2× the
  // default ±0.015° half-width = ~3.3km radius), helping when the
  // default Kapaa-tight bbox returns 0 listings for sparse BRs like
  // 3BR. Use only as a fallback when the initial scan came up empty
  // — costs an extra SearchAPI call per missing BR.
  options?: {
    bedrooms?: number;
    bboxScale?: number;
  },
): Promise<AmortizedNightlyResult> {
  const searchApiKey = process.env.SEARCHAPI_API_KEY;
  if (!searchApiKey) return { ratesByBR: {}, bboxApplied: false };

  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  let checkInDate: Date;
  let checkOutDate: Date;
  if (dateOverride) {
    checkInDate = new Date(`${dateOverride.checkIn}T00:00:00Z`);
    checkOutDate = new Date(`${dateOverride.checkOut}T00:00:00Z`);
  } else {
    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);
    checkInDate = new Date(now);
    checkInDate.setUTCDate(checkInDate.getUTCDate() + 30);
    checkOutDate = new Date(checkInDate);
    checkOutDate.setUTCDate(checkOutDate.getUTCDate() + 7);
  }

  // Resolve a bbox center, in priority order:
  //   1. explicit `bboxCenterOverride` (operator-validated lat/lng)
  //   2. Nominatim geocode of `addressHint, city, state`
  //   3. fall through to name-token match (no bbox)
  const halfDeg = BBOX_HALF_DEG * (options?.bboxScale ?? 1);
  let bbox: { sw_lat: number; sw_lng: number; ne_lat: number; ne_lng: number } | null = null;
  let bboxCenter: { lat: number; lng: number } | undefined;
  if (bboxCenterOverride && Number.isFinite(bboxCenterOverride.lat) && Number.isFinite(bboxCenterOverride.lng)) {
    bboxCenter = bboxCenterOverride;
    bbox = {
      sw_lat: bboxCenter.lat - halfDeg,
      sw_lng: bboxCenter.lng - halfDeg,
      ne_lat: bboxCenter.lat + halfDeg,
      ne_lng: bboxCenter.lng + halfDeg,
    };
  } else if (addressHint && addressHint.trim()) {
    const fullAddress = `${addressHint.trim()}, ${city}, ${state}`;
    const coord = await geocode(fullAddress);
    if (coord) {
      bboxCenter = coord;
      bbox = {
        sw_lat: coord.lat - halfDeg,
        sw_lng: coord.lng - halfDeg,
        ne_lat: coord.lat + halfDeg,
        ne_lng: coord.lng + halfDeg,
      };
    }
  }

  // Token-based name match — every word of length ≥3 in the community
  // name must appear in the haystack. Used when bbox is unavailable.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const nameTokens = norm(communityName).split(" ").filter((t) => t.length >= 3);
  const nameMatches = (haystack: string): boolean => {
    if (nameTokens.length === 0) return true;
    const n = norm(haystack);
    return nameTokens.every((t) => n.includes(t));
  };

  const ratesByBR: Record<number, number[]> = {};
  const drops = {
    engineCount: 0,
    outsideBbox: 0,
    nameMismatch: 0,
    noPrice: 0,
    badBedrooms: 0,
    nightlyOutOfRange: 0,
  };
  try {
    const sp: Record<string, string> = {
      engine: "airbnb",
      q: `${communityName} ${city} ${state}`,
      check_in_date: ymd(checkInDate),
      check_out_date: ymd(checkOutDate),
      adults: "2",
      type_of_place: "entire_home",
      ...(options?.bedrooms ? { bedrooms: String(options.bedrooms) } : {}),
      currency: "USD",
      api_key: searchApiKey,
    };
    if (bbox) {
      sp.sw_lat = String(bbox.sw_lat);
      sp.sw_lng = String(bbox.sw_lng);
      sp.ne_lat = String(bbox.ne_lat);
      sp.ne_lng = String(bbox.ne_lng);
    }
    const resp = await fetch(
      `https://www.searchapi.io/api/v1/search?${new URLSearchParams(sp).toString()}`,
    );
    if (!resp.ok) return { ratesByBR, bboxApplied: !!bbox, bboxCenter, drops };
    const data = await resp.json() as any;
    const properties: any[] = Array.isArray(data?.properties) ? data.properties : [];
    drops.engineCount = properties.length;
    for (const p of properties) {
      if (bbox) {
        const lat = Number(p?.gps_coordinates?.latitude);
        const lng = Number(p?.gps_coordinates?.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          if (lat < bbox.sw_lat || lat > bbox.ne_lat || lng < bbox.sw_lng || lng > bbox.ne_lng) {
            drops.outsideBbox++;
            continue;
          }
        }
      } else {
        const title = String(p?.name ?? p?.title ?? "");
        const desc = String(p?.description ?? "");
        if (!nameMatches(`${title} ${desc}`)) {
          drops.nameMismatch++;
          continue;
        }
      }
      // Engine never surfaces `bedrooms` as a top-level number. The
      // count lives in the title (e.g. "Boho Chic 2BR Condo …",
      // "Spacious 3 Bedroom Disney Vacation Home", "Studio condo by
      // pool"). Fall back to `accommodations` if the title regex
      // doesn't catch it — some listings encode it there as a
      // structured field.
      const br = extractBedroomsFromListing(p);
      const total = Number(p?.price?.extracted_total_price);
      // Engine pre-computes the per-night rate via
      // `extracted_price_per_qualifier` when the qualifier is
      // "X nights x $Y" — that's the same number we'd compute
      // ourselves from total/7, just without rounding. Prefer the
      // engine value when present; fall back to total/7.
      let nightly: number;
      const perQualifier = Number(p?.price?.extracted_price_per_qualifier);
      if (Number.isFinite(perQualifier) && perQualifier > 0) {
        nightly = Math.round(perQualifier);
      } else if (Number.isFinite(total) && total > 0) {
        nightly = Math.round(total / 7);
      } else {
        drops.noPrice++;
        continue;
      }
      if (!Number.isFinite(br) || br < 1 || br > 6) { drops.badBedrooms++; continue; }
      if (nightly < 50 || nightly > 3000) { drops.nightlyOutOfRange++; continue; }
      if (!ratesByBR[br]) ratesByBR[br] = [];
      ratesByBR[br].push(nightly);
    }
  } catch {
    /* network / parse error — return whatever we accumulated */
  }
  // Surface a sample of the first engine result when we collected no
  // rates — lets the refresh-pricing endpoint diagnose schema drift
  // (e.g. bedrooms arriving as "2 bedrooms" string instead of `2`).
  // We can't add this without re-fetching since the loop above doesn't
  // hold onto the first property; in practice this matters once per
  // schema-drift incident, so just refetch when we'd otherwise return
  // empty.
  let firstListingSample: unknown;
  const totalCollected = Object.values(ratesByBR).reduce((s, l) => s + l.length, 0);
  if (totalCollected === 0 && drops.engineCount > 0) {
    try {
      const sp: Record<string, string> = {
        engine: "airbnb",
        q: `${communityName} ${city} ${state}`,
        check_in_date: ymd(checkInDate),
        check_out_date: ymd(checkOutDate),
        adults: "2",
        type_of_place: "entire_home",
        currency: "USD",
        api_key: searchApiKey,
      };
      if (bbox) {
        sp.sw_lat = String(bbox.sw_lat);
        sp.sw_lng = String(bbox.sw_lng);
        sp.ne_lat = String(bbox.ne_lat);
        sp.ne_lng = String(bbox.ne_lng);
      }
      const resp2 = await fetch(
        `https://www.searchapi.io/api/v1/search?${new URLSearchParams(sp).toString()}`,
      );
      if (resp2.ok) {
        const data2 = await resp2.json() as any;
        const props2 = Array.isArray(data2?.properties) ? data2.properties : [];
        if (props2.length > 0) firstListingSample = props2[0];
      }
    } catch {
      /* non-fatal — diagnostic only */
    }
  }
  return { ratesByBR, bboxApplied: !!bbox, bboxCenter, drops, firstListingSample };
}

// Median of a numeric list, or null on empty input.
export function medianRate(arr: number[]): number | null {
  if (!arr?.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export async function researchCommunitiesForCity(
  city: string,
  state: string,
  // CODEX NOTE (2026-05-04, claude/single-listing-research): mode
  // parameter added to support the single-listing wizard's
  // discovery flow. Combo mode (default) keeps the original behavior
  // — combinabilityScore-gated, max 10 results, max 3 world-
  // knowledge entries, Haiku model. Single mode drops the
  // combinability filter (irrelevant for standalone listings),
  // lifts the world-knowledge cap to 15, returns up to 20, runs on
  // Sonnet for better recall on niche named resorts (e.g. Santa
  // Maria Resort in Fort Myers Beach), and uses extra targeted
  // SearchAPI queries that hit lists/round-ups instead of just
  // listing snippets. See Load-Bearing #36.
  mode: "combo" | "single" = "combo",
): Promise<ResearchedCommunity[]> {
  const searchApiKey = process.env.SEARCHAPI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!searchApiKey) throw new Error("SEARCHAPI_API_KEY not configured");

  // Combo queries focus on individually-owned 2BR/3BR mix (combinable).
  // Single-listing queries expand to lists/round-ups of "best vacation
  // rental resorts/condos in {city}" — those pages routinely name 5–10
  // specific resorts (Santa Maria Resort, Sandcastle Beach Club, etc.)
  // that the bare site:airbnb-style queries miss.
  const queries = mode === "single"
    ? [
        `"${city}" "${state}" condo OR condominium resort vacation rental airbnb vrbo -villa -"single family" -hotel`,
        `"${city}" "${state}" "best" condo resort vacation rental airbnb vrbo`,
        `"${city}" "${state}" condo townhome vacation rental "individually owned" OR "owner rents" airbnb`,
        `"top" condo resorts "${city}" "${state}" airbnb vrbo`,
        `"${city}" "${state}" beach resort condo 2BR 3BR vacation rental airbnb -hotel -timeshare`,
      ]
    : [
        `"${city}" "${state}" (condo OR condominium) complex vacation rental 2-bedroom OR 3-bedroom airbnb vrbo individually owned -villa -"single family" -efficiency -studio -hotel`,
        `"${city}" "${state}" townhome OR townhouse cluster 3 bedroom vacation rental airbnb individually owned -villa -"single family" -studio`,
        `"${city}" "${state}" beach condo resort 2BR 3BR individually owned vacation rental -hotel -timeshare -efficiency`,
      ];

  const allResults: Array<{ title: string; link: string; snippet: string }> = [];
  // Single-listing scans pull more results per query so Claude has
  // wider context to surface niche named resorts. Combo flow stays
  // tight to keep wall time bounded for the top-markets sweep.
  const numPerQuery = mode === "single" ? 12 : 8;
  for (const q of queries) {
    try {
      const resp = await fetch(
        `https://www.searchapi.io/api/v1/search?engine=google&q=${encodeURIComponent(q)}&num=${numPerQuery}&api_key=${searchApiKey}`,
      );
      if (!resp.ok) continue;
      const data = await resp.json() as any;
      const organic = (data.organic_results || []) as Array<{ title: string; link: string; snippet: string }>;
      allResults.push(...organic);
    } catch (e: any) {
      console.warn(`[research] SearchAPI error for ${city}:`, e.message);
    }
  }

  const seen = new Set<string>();
  const uniqueCap = mode === "single" ? 30 : 15;
  const unique = allResults.filter(r => {
    const key = r.title?.toLowerCase().slice(0, 60) ?? r.link;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, uniqueCap);

  // Single-listing mode tolerates an empty SearchAPI response — the
  // world-knowledge fallback below can still surface known named
  // resorts in major markets (e.g. Fort Myers Beach → Santa Maria
  // Resort) without any organic results to anchor on. Combo mode
  // keeps the original "no results = no results" behavior because
  // its prompt is too combinability-focused to work cold.
  if (unique.length === 0 && mode === "combo") return [];

  // Spot-check the typical per-unit nightly rate for a community by
  // hitting SearchAPI's airbnb engine for a 7-night window 30 days out
  // and averaging across the cheapest bedroom tier (so a 2BR draft and
  // a 3BR draft don't get the same `estimatedLowRate`). Per-night is
  // amortized via total / 7, which matches what a real guest would pay
  // including cleaning + service fees — a 1-night quote inflates the
  // apparent rate by ~50% because cleaning fees fall on a single night.
  //
  // Earlier revision regex-grepped `$XXX/night` headlines from the raw
  // Google JSON. That swept in headline "from $X" rates (often 1-night
  // quotes), peak-season screenshots from review sites, and rates from
  // unrelated nearby properties — producing a `low` ~3x the actual cost
  // basis. For Caribe Cove specifically (operator-validated 2BR ≈ $125
  // all-in), the regex hack returned null entirely on Florida pages
  // because Google snippets don't carry that exact format. Replacing
  // it with the priced-engine lookup is both more accurate AND more
  // reliable — same methodology as `/api/community/search-units`.
  async function spotCheckRate(communityName: string): Promise<{ low: number | null; high: number | null }> {
    const { ratesByBR } = await fetchAmortizedNightlyByBR(communityName, city, state);
    const allRates: number[] = [];
    for (const list of Object.values(ratesByBR)) allRates.push(...list);
    if (allRates.length === 0) return { low: null, high: null };
    const sorted = [...allRates].sort((a, b) => a - b);
    return { low: sorted[0], high: sorted[sorted.length - 1] };
  }

  const results: ResearchedCommunity[] = [];

  if (anthropicKey) {
    // Single-listing prompt: focused on naming as many qualifying
    // condo/townhouse resorts as possible (no combinability angle).
    // Lifts world-knowledge cap to 15 and explicitly enumerates
    // example resorts per major Florida market so Claude has a
    // strong grounding for niche resorts that don't always show up
    // in SearchAPI's organic results (the documented bug:
    // Santa Maria Resort missing from Fort Myers Beach scans).
    //
    // Combo prompt: unchanged — combinabilityScore-gated, max 3
    // world-knowledge entries, max 10 results.
    const prompt = mode === "single"
      ? `You are sourcing standalone vacation-rental condo/townhouse resorts for Magical Island Rentals's "Add a Single Listing" tool, which onboards individually-owned condos and townhouses one unit at a time.

THE BUSINESS MODEL (single-listing mode):
  We onboard ONE unit at a time from a known condo or townhouse resort. The unit is rented as a standalone listing — NOT combined with another unit.
  So the VALUE of a community = whether it is a recognizable, individually-owned condo/townhouse resort with active vacation rental inventory.
  We do NOT care about "combinability" — single-unit standalones, large 4BR townhouses, small 1BR condos all qualify if the resort fits.

QUALIFYING CRITERIA:
1. PROPERTY TYPE: Condos in a multi-unit building OR townhouses with shared walls. NO villas, detached homes, or single-family residences.
2. OWNERSHIP MODEL: Individually owned (each unit has its own deed), not a single-owner timeshare/hotel.
3. VACATION RENTAL USAGE: Primarily nightly vacation rentals on Airbnb/VRBO/Booking.
4. SIZE: 10+ units of any size. Studio/1BR resorts qualify too.

EXAMPLES of resorts that qualify (use these as a recall anchor):
  Fort Myers Beach, FL: Santa Maria Resort, Sandcastle Beach Club, Diamond Head Beach Resort, Pointe Estero Resort, Surf & Sun Beach Resort, Casa Playa Beach Resort, Estero Beach & Tennis Club, Sea Castle Condominiums, Mariner's Boathouse & Beach Resort, The Sunset Beach Club.
  Destin, FL: Silver Shells Beach Resort, Sandestin Beach Resort, Henderson Park Inn, Crystal Beach, Emerald Towers, Sterling Shores, Mainsail Condominiums.
  Panama City Beach, FL: Edgewater Beach Resort, Calypso Resort, Splash Resort, Aqua Resort, Long Beach Resort, Shores of Panama.
  Kissimmee/Orlando, FL: Windsor Hills Resort, Caribe Cove Resort, Reunion Resort, Encore Resort, Solterra Resort, Champions Gate, Vista Cay Resort, Storey Lake Resort.
  Lihue/Kapaa/Poipu, HI: Pili Mai, Kaha Lani Resort, Lae Nani, Lawai Beach Resort, Whalers Cove, Poipu Kapili, Regency at Poipu Kai.

DISQUALIFIED:
  ❌ Pure-villa or single-family-home resorts (no shared walls).
  ❌ Marriott / Hilton / Westin / Sheraton timeshares (single-owner-corp).
  ❌ Hotels with front-desk check-in and centrally-managed inventory.

SCORING:
  confidenceScore (0–100): sure this is individually-owned condo/townhouse? 90+ household name, 70–89 very likely, 50–69 probably, <50 don't include.
  (No combinabilityScore for single-listing mode — leave it null.)

Use (1) the search results below AND (2) your own world knowledge. **You MAY (and should) add UP TO 15 well-known condo/townhouse resorts from your own knowledge** that fit "${city}, ${state}", marked fromWorldKnowledge:true. Aim for 15–20 total entries when the city has that many known resorts. **For any city named in the EXAMPLES list above, you MUST surface every example resort listed for that city as fromWorldKnowledge entries** unless you have a specific reason to disqualify one.

CRITICAL: For each resort, return availableBedrooms as an array of integers — the bedroom counts that resort actually offers (e.g. Santa Maria Resort: [2, 3]; Pili Mai: [2, 3, 4]; Caribe Cove: [2, 3, 4]; Reunion Resort: [2, 3, 4, 5, 6, 7, 8]). Only include bedroom counts you are confident the resort offers. If you don't know, return an empty array []. The wizard uses this to render bedroom buttons — wrong counts cause failed Zillow lookups, missing counts hide valid options. Default to including 2 and 3 if you're sure the resort exists but uncertain about exact mix. NEVER include studio/0 or 1 unless the resort is genuinely studio/1BR-dominated.

SEARCH RESULTS for "${city}, ${state}":
${unique.length > 0 ? unique.map((r, i) => `[${i}] TITLE: ${r.title}\nURL: ${r.link}\nSNIPPET: ${r.snippet}`).join("\n\n") : "(no organic results — rely on world knowledge)"}

Output JSON array. Each element:
{"communityName":"...","bedroomMix":"...","availableBedrooms":[N,N,...],"unitTypes":"...","confidenceScore":0-100,"reason":"...","sourceUrl":"...","fromWorldKnowledge":true|false}

Include ONLY entries with confidenceScore >= 60. Max 20 results. Sort by confidenceScore descending. No markdown, no prose.`
      : `You are sourcing condo/townhome resorts for Magical Island Rentals, which bundles TWO individually-owned units in the SAME complex into one large-group vacation listing.

THE BUSINESS MODEL:
  We rent unit A (e.g. 3BR) + unit B (e.g. 3BR) in the same building → list them together as one "6BR sleeps 14" villa-style product.
  So the VALUE of a community = bedrooms of (typical unit × 2). If a complex is dominated by studios/efficiencies/1BRs, combining them is pointless — 2×studio is still too small.

CONCRETE EXAMPLES of what we want:
  ✅ Santa Maria Resort (Fort Myers Beach, FL) — condo building, mostly 2BR/3BR units, individually owned, all listed on Airbnb/VRBO. Combining 2×3BR = 6BR. This is the gold standard.
  ✅ Pili Mai (Poipu Kai, HI) — townhome complex, 2BR/3BR, individually owned.
  ✅ Kaha Lani (Kauai) — beachfront condo complex, 2BR/3BR.
  ⚠️ BB&T / Bay Beach & Tennis (Bonita Springs, FL) — mostly efficiency/1BR. 2×1BR = 2BR is WEAK. combinabilityScore 20–35.
  ❌ Fort Myers Beach "villa" resorts — standalone structures, disqualified.
  ❌ Marriott / Hilton / Westin timeshares — single-owner, disqualified.
  ❌ Hotel-run condo-hotels with front desk check-in — disqualified.

STRICT QUALIFYING CRITERIA:
1. PROPERTY TYPE: Condos in multi-unit building OR townhomes with shared walls. NO villas/detached/single-family.
2. OWNERSHIP MODEL: Individually owned, not timeshare or single-owner.
3. VACATION RENTAL USAGE: Primarily nightly rentals.
4. UNIT SHARE-WALLS: Same building or contiguous townhome row.
5. SIZE: 10+ units with 2BR+ options.

SCORING:
  confidenceScore (0–100): sure this is individually-owned condo/townhome? 90+ household name, 70–89 very likely, 50–69 probably, <50 don't include.
  combinabilityScore (0–100): value of combining 2 units?
    90+: mostly 3BR → 2×3BR = 6BR (ideal)
    70–89: 2BR/3BR mix → 4BR–6BR
    50–69: mostly 2BR → 4BR combined
    30–49: mostly 1BR → 2BR combined (marginal)
    <30: mostly studios → skip

Use (1) the search results below, and (2) your own knowledge — add up to 3 well-known communities in "${city}, ${state}" that fit, marked fromWorldKnowledge:true.

SEARCH RESULTS for "${city}, ${state}":
${unique.map((r, i) => `[${i}] TITLE: ${r.title}\nURL: ${r.link}\nSNIPPET: ${r.snippet}`).join("\n\n")}

Output JSON array. Each element:
{"communityName":"...","bedroomMix":"...","combinedBedroomsTypical":N,"unitTypes":"...","confidenceScore":0-100,"combinabilityScore":0-100,"reason":"...","sourceUrl":"...","fromWorldKnowledge":false}

Include ONLY entries with confidenceScore >= 60 AND combinabilityScore >= 50. Max 10 results. Sort by (confidenceScore + combinabilityScore) descending. No markdown, no prose.`;

    try {
      const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          // Single-listing mode runs on Sonnet (better world-
          // knowledge recall for niche named resorts like Santa
          // Maria Resort or Casa Playa Beach Resort). Combo mode
          // stays on Haiku — it's used inside the top-markets sweep
          // which iterates 12+ markets, so the Haiku speed/cost
          // advantage matters there. Single mode is per-operator-
          // click, so the per-call latency is acceptable.
          model: mode === "single" ? "claude-sonnet-4-6" : "claude-haiku-4-5-20251001",
          max_tokens: mode === "single" ? 8000 : 4000,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      const claudeData = await claudeResp.json().catch(() => null) as any;

      if (!claudeResp.ok) {
        const upstreamMsg =
          claudeData?.error?.message ??
          claudeData?.error?.type ??
          `HTTP ${claudeResp.status}`;
        console.error(`[research] Anthropic ${claudeResp.status} for ${city}, ${state}: ${upstreamMsg}`);
      } else if (claudeData?.error) {
        const upstreamMsg = claudeData.error.message ?? claudeData.error.type ?? "unknown";
        console.error(`[research] Anthropic error envelope for ${city}, ${state}: ${upstreamMsg}`);
      } else {
        const text: string = claudeData?.content?.[0]?.text ?? "";
        // Tolerate Markdown fences around the JSON — Haiku occasionally
        // wraps array output in ```json … ``` despite the "no markdown"
        // instruction. Strip the fences before regex-matching the array.
        const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "");
        const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
          console.error(`[research] Claude returned no JSON array for ${city}, ${state}. Raw text head: ${text.slice(0, 200)}`);
        } else {
          let scored: Array<any> = [];
          try {
            scored = JSON.parse(jsonMatch[0]) as Array<any>;
          } catch (parseErr: any) {
            console.error(`[research] JSON.parse failed for ${city}, ${state}: ${parseErr.message}. Head: ${jsonMatch[0].slice(0, 200)}`);
          }
          // Single mode keeps up to 20; combo mode keeps the original 10.
          const sliceCap = mode === "single" ? 20 : 10;
          for (const s of scored.slice(0, sliceCap)) {
            // Hard post-filter. The prompt warns against villas/SFH, but
            // Claude occasionally lets one through. Drop anything whose
            // unitTypes or reason contains a disqualifying term.
            const check = checkCommunityType(s.unitTypes, s.reason);
            if (!check.eligible) {
              console.log(`[research] dropped "${s.communityName}" (${city}, ${state}): ${check.reason}`);
              continue;
            }
            const rates = await spotCheckRate(s.communityName);
            results.push({
              name: s.communityName,
              city,
              state,
              estimatedLowRate: rates.low,
              estimatedHighRate: rates.high,
              unitTypes: s.unitTypes,
              confidenceScore: s.confidenceScore,
              researchSummary: s.reason,
              sourceUrl: s.sourceUrl || "",
              bedroomMix: s.bedroomMix,
              combinedBedroomsTypical: s.combinedBedroomsTypical,
              // Single mode doesn't ask for combinabilityScore — it
              // can come back undefined. The downstream sort uses 50
              // as the default when undefined, which is fine.
              combinabilityScore: typeof s.combinabilityScore === "number" ? s.combinabilityScore : undefined,
              fromWorldKnowledge: s.fromWorldKnowledge === true,
              // CODEX NOTE: availableBedrooms only meaningful in
              // single mode. Filter to integers in [1,12] and
              // dedupe; combo mode leaves it undefined.
              availableBedrooms: Array.isArray(s.availableBedrooms)
                ? Array.from(new Set(
                    s.availableBedrooms
                      .map((n: any) => typeof n === "number" ? Math.round(n) : null)
                      .filter((n: number | null): n is number => n != null && n >= 1 && n <= 12),
                  )).sort((a, b) => a - b)
                : undefined,
            });
          }
        }
      }
    } catch (e: any) {
      console.error(`[research] Claude exception for ${city}, ${state}: ${e.message}`);
    }
  } else {
    // No Claude — fall back to raw results (low-confidence)
    for (const r of unique.slice(0, 8)) {
      results.push({
        name: r.title?.split(" - ")[0]?.split(" | ")[0] ?? r.title,
        city,
        state,
        estimatedLowRate: null,
        estimatedHighRate: null,
        unitTypes: "Unknown",
        confidenceScore: 50,
        researchSummary: r.snippet,
        sourceUrl: r.link,
      });
    }
  }

  results.sort((a, b) => {
    const sa = a.confidenceScore + (a.combinabilityScore ?? 50);
    const sb = b.confidenceScore + (b.combinabilityScore ?? 50);
    return sb - sa;
  });
  return results;
}

// ─── TOP MARKETS ─────────────────────────────────────────────────────────────
// Curated list of US vacation-rental hotspots known for individually-owned
// condo/townhome inventory. Used by /api/community/scan-top-markets to
// auto-discover untapped communities across all of them.
//
// Criteria for inclusion:
//   - Strong Airbnb/VRBO presence
//   - Known condo/townhome inventory (not just SFRs)
//   - Geographically diverse (coast, ski, desert, mountain)

export const TOP_MARKET_SEEDS: Array<{ city: string; state: string; tag: string }> = [
  // Gulf Coast Florida — classic condo country
  { city: "Fort Myers Beach",    state: "Florida",        tag: "Gulf Coast" },
  { city: "Destin",              state: "Florida",        tag: "Gulf Coast" },
  { city: "Panama City Beach",   state: "Florida",        tag: "Gulf Coast" },
  { city: "Santa Rosa Beach",    state: "Florida",        tag: "30A" },
  { city: "Naples",              state: "Florida",        tag: "Gulf Coast" },
  // Atlantic Florida + Southeast
  { city: "Clearwater Beach",    state: "Florida",        tag: "Gulf Coast" },
  { city: "Hilton Head",         state: "South Carolina", tag: "Atlantic" },
  { city: "Myrtle Beach",        state: "South Carolina", tag: "Atlantic" },
  // Gulf Alabama
  { city: "Gulf Shores",         state: "Alabama",        tag: "Gulf Coast" },
  { city: "Orange Beach",        state: "Alabama",        tag: "Gulf Coast" },
  // Tennessee Smokies — condo/cabin mix
  { city: "Gatlinburg",          state: "Tennessee",      tag: "Smokies" },
  { city: "Pigeon Forge",        state: "Tennessee",      tag: "Smokies" },
  // Mountain West — ski condos
  { city: "Breckenridge",        state: "Colorado",       tag: "Ski" },
  { city: "Park City",           state: "Utah",           tag: "Ski" },
  { city: "Mammoth Lakes",       state: "California",     tag: "Ski" },
  // Desert / SoCal
  { city: "Palm Springs",        state: "California",     tag: "Desert" },
  // Texas coast
  { city: "South Padre Island",  state: "Texas",          tag: "Gulf Coast" },
  { city: "Galveston",           state: "Texas",          tag: "Gulf Coast" },
  // Hawaii (your home market, for completeness)
  { city: "Kihei",               state: "Hawaii",         tag: "Hawaii" },
  { city: "Kailua-Kona",         state: "Hawaii",         tag: "Hawaii" },
];
