// Live street-address discovery for the bulk combo listing queue.
//
// WHY THIS EXISTS: the address gate (`validateCommunityStreetAddress`) hard-rejects
// a combo listing without a real numbered street. For resorts in the curated
// `COMMUNITY_ADDRESS_RULES` that's instant; for everything else the queue used to
// resolve the street PURELY from curated rules + an operator `addressHint`. The
// Top Markets Sweep queues resorts straight off VRBO/Airbnb with NO street and NO
// hint (and an often-wrong mailing city), so any non-curated resort failed the
// address pre-check with "No usable street address" before a single photo was
// fetched (observed live 2026-06-17: Lae Nani, Puu Poa, Hanalei Bay Resort,
// Waipouli Beach Resort all dropped this way). This module gives the pre-check a
// last-resort DISCOVERY step: ask SearchAPI's `google_maps` engine for the resort
// by name and lift a real numbered street out of the result. This is the same
// engine `walking-distance.ts` already uses for resort geocoding; it covers gated
// resorts OSM/Nominatim doesn't. It is NOT a substitute for a curated rule — a
// curated rule still wins (and is still validated) upstream.
//
// REVERSE-GEOCODE RESCUE (added because the map address is OFTEN just a locality):
// google_maps frequently knows a resort's exact location — we get correct
// coordinates and a name-matched title — but returns its `address` as the bare town
// ("Princeville, HI 96722") with no house number, so the direct street path finds
// nothing and the item failed. When that happens we now take the coordinates of the
// title-matched place and reverse-geocode them (Nominatim, free) into a real numbered
// street. This is the lever that lets discovery resolve nearly every real resort
// rather than only the minority whose map card already carries a street.
//
// PRECISION over recall: a WRONG address is worse than a missing one (it would save
// a real listing pointing at the wrong place — see the Alii Kai/Halii Kai mix-up
// that motivated the `communityAddressRuleForName` word-boundary fix). So a
// candidate is only accepted when (a) its address parses to a real numbered street
// and (b) every distinctive token of the resort name appears as a whole word in the
// map result's title. A streetless POI ("Lae Nani Beach") or an unrelated business
// is rejected, and the item simply fails the pre-check exactly as it did before —
// no regression, just an extra chance to succeed.

import {
  isLikelyStreetAddress,
  normalizeCommunityAddressToken,
  streetRootFromAddress,
} from "@shared/community-addresses";
import { statesEquivalent } from "@shared/community-location-guard";
import { parseListingAddressFromUrl } from "@shared/listing-url-address";
import { CLUBHOUSE_TITLE_HINT_RE, clubhouseDiscoveryQueries } from "@shared/published-address";
import { reverseGeocodeToStreetAddress } from "./walking-distance";
import { callClaudeWebSearchJson } from "./claude-json";

export type DiscoveredStreetAddress = {
  street: string;
  fullAddress: string;
  matchedTitle: string;
  query: string;
};

export type MapsAddressCandidate = {
  title?: string | null;
  address?: string | null;
  gps_coordinates?: { latitude?: number | null; longitude?: number | null } | null;
};

/** A name-matched map place that carries coordinates but NO usable street. */
export type CoordinateFallbackCandidate = {
  lat: number;
  lng: number;
  matchedTitle: string;
  fullAddress: string;
};

// Generic descriptors that carry no identifying signal on their own. Stripped from
// the resort name before token-matching so "Waipouli Beach Resort" keys off
// "waipouli"/"beach" and not the boilerplate "resort". Deliberately does NOT
// include place-distinctive words like "beach"/"bay"/"poipu".
const GENERIC_NAME_TOKENS = new Set([
  "resort", "resorts", "village", "villas", "villa", "condo", "condos",
  "condominium", "condominiums", "apartment", "apartments", "hotel", "hotels",
  "suites", "suite", "the", "at", "by", "of", "and", "spa", "club", "vacation",
  "vacations", "rentals", "rental", "luxury", "inn", "lodge",
]);

function nameTokens(name: string): string[] {
  return normalizeCommunityAddressToken(String(name ?? ""))
    .split(" ")
    .filter((t) => t.length >= 3);
}

/** Distinctive (non-generic) name tokens; falls back to all >=3-char tokens. */
export function distinctiveResortTokens(name: string): string[] {
  const all = nameTokens(name);
  const distinctive = all.filter((t) => !GENERIC_NAME_TOKENS.has(t));
  return distinctive.length > 0 ? distinctive : all;
}

/**
 * A map result's title matches the resort iff every distinctive resort token
 * appears as a WHOLE WORD in the title. Word-boundary matching prevents an
 * "Alii Kai" query from latching onto a "Halii Kai" result.
 */
export function titleMatchesResort(title: string | null | undefined, resortName: string): boolean {
  const need = distinctiveResortTokens(resortName);
  if (need.length === 0) return false;
  const titlePadded = ` ${normalizeCommunityAddressToken(String(title ?? ""))} `;
  return need.every((t) => titlePadded.includes(` ${t} `));
}

/**
 * Pick the first map candidate whose address is a real numbered street AND whose
 * title matches the resort. Candidates are scanned in the order the maps engine
 * returned them (relevance order). Pure — no network — so it is unit-testable.
 */
export function selectDiscoveredStreet(
  candidates: MapsAddressCandidate[],
  resortName: string,
  query: string,
): DiscoveredStreetAddress | null {
  for (const c of candidates) {
    const fullAddress = String(c?.address ?? "").trim();
    if (!fullAddress) continue;
    const street = streetRootFromAddress(fullAddress);
    if (!street || !isLikelyStreetAddress(street)) continue;
    if (!titleMatchesResort(c?.title, resortName)) continue;
    return { street, fullAddress, matchedTitle: String(c?.title ?? "").trim(), query };
  }
  return null;
}

/**
 * Pick the first map candidate whose TITLE matches the resort (same precision gate
 * as `selectDiscoveredStreet`) but whose `address` is NOT a usable numbered street,
 * provided it exposes GPS coordinates. This is the input to the reverse-geocode
 * rescue: google_maps very often knows a resort's location (so we have correct
 * coordinates + a name-matched title) yet only returns its locality ("Princeville,
 * HI") with no house number — the single most common discovery miss. Because the
 * title gate has ALREADY confirmed the resort identity, the coordinates belong to
 * the correct place, so reverse-geocoding them is precision-safe (a streetless
 * wrong-resort hit is still rejected by the title gate, exactly as before).
 *
 * Pure / no network so it stays unit-testable. Candidates already carrying a real
 * street are skipped here — those are handled by `selectDiscoveredStreet`.
 */
export function selectCoordinateFallbackCandidate(
  candidates: MapsAddressCandidate[],
  resortName: string,
): CoordinateFallbackCandidate | null {
  for (const c of candidates) {
    if (!titleMatchesResort(c?.title, resortName)) continue;
    const fullAddress = String(c?.address ?? "").trim();
    const street = streetRootFromAddress(fullAddress);
    if (street && isLikelyStreetAddress(street)) continue; // street path owns this one
    const lat = Number(c?.gps_coordinates?.latitude);
    const lng = Number(c?.gps_coordinates?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    return { lat, lng, matchedTitle: String(c?.title ?? "").trim(), fullAddress };
  }
  return null;
}

function buildQueries(communityName: string, city: string, state: string): string[] {
  const name = String(communityName ?? "").trim();
  const c = String(city ?? "").trim();
  const s = String(state ?? "").trim();
  // Several phrasings, most-specific first. The mailing city is often wrong on
  // swept resorts, so a name+state-only and a "condominium" variant are included
  // as fallbacks (verified to resolve Lae Nani/Puu Poa even with a wrong city).
  const raw = [
    [name, c, s].filter(Boolean).join(" "),
    [name, "resort", c, s].filter(Boolean).join(" "),
    [name, "condominium", c, s].filter(Boolean).join(" "),
    [name, "condominium resort", s].filter(Boolean).join(" "),
    [name, s].filter(Boolean).join(" "),
  ];
  return Array.from(new Set(raw.map((q) => q.trim()).filter(Boolean)));
}

async function fetchMapsCandidates(query: string, apiKey: string): Promise<MapsAddressCandidate[]> {
  const sp = new URLSearchParams({ engine: "google_maps", q: query, api_key: apiKey });
  const r = await fetch(`https://www.searchapi.io/api/v1/search?${sp.toString()}`, {
    signal: AbortSignal.timeout(12000),
  });
  // THROW (not return []) on a non-2xx so the caller treats a 429/5xx as a
  // TRANSIENT failure and does NOT negative-cache it — otherwise one rate-limit
  // blip would permanently skip a resort's discovery for the process lifetime.
  if (!r.ok) throw new Error(`searchapi ${r.status}`);
  const data = (await r.json()) as any;
  const out: MapsAddressCandidate[] = [];
  // `place_results` = a single exact hit; `local_results` = ranked POI list. Both
  // carry `title` + `address` + `gps_coordinates` (the coords feed the reverse-geocode
  // rescue for streetless-but-name-matched places). Scan place_results first, then
  // the list in order.
  if (data?.place_results) {
    out.push({
      title: data.place_results.title,
      address: data.place_results.address,
      gps_coordinates: data.place_results.gps_coordinates,
    });
  }
  if (Array.isArray(data?.local_results)) {
    for (const lr of data.local_results) {
      out.push({ title: lr?.title, address: lr?.address, gps_coordinates: lr?.gps_coordinates });
    }
  }
  return out;
}

// ── Portal-SERP address rescue ───────────────────────────────────────────────
// google_maps only resolves resorts it indexes by OUR name (the Kahaluu Reef
// class fails: maps knows it as "Kahaluu Beach Villas"). But Zillow/Realtor/
// Redfin DETAIL URLs encode each unit's full numbered street in the slug, and a
// quoted-phrase SERP for the resort name surfaces those exact listings. Lifting
// the street from a name-matched listing URL is the same trick manual mode uses
// (parseListingAddressFromUrl on the pasted URLs) — the unit's street IS the
// community's street.
export type SerpListingResult = { title?: string | null; link?: string | null; snippet?: string | null };

/**
 * Pick a street from portal SERP results. PRECISION over recall, two tiers:
 *   1. TITLE match — the resort's distinctive tokens appear in the result title
 *      (same whole-word gate as the maps path) and the URL slug parses to a real
 *      numbered street → accept immediately.
 *   2. SNIPPET consensus — results that only mention the resort in the snippet
 *      can be "minutes from <resort>" neighbors, so a snippet-only match is
 *      accepted ONLY when >=2 DISTINCT listings agree on the same street root.
 * Pure / no network so it is unit-testable.
 */
export function selectSerpListingAddressCandidate(
  results: SerpListingResult[],
  resortName: string,
  query: string,
): DiscoveredStreetAddress | null {
  const snippetVotes = new Map<string, { street: string; fullAddress: string; matchedTitle: string; links: Set<string> }>();
  for (const r of results) {
    const link = String(r?.link ?? "").trim();
    if (!link) continue;
    const parsed = parseListingAddressFromUrl(link);
    if (!parsed) continue;
    const street = streetRootFromAddress(parsed);
    if (!street || !isLikelyStreetAddress(street)) continue;
    if (titleMatchesResort(r?.title, resortName)) {
      return { street, fullAddress: parsed, matchedTitle: String(r?.title ?? "").trim(), query };
    }
    if (titleMatchesResort(r?.snippet, resortName)) {
      const key = street.toLowerCase();
      const vote = snippetVotes.get(key) ?? { street, fullAddress: parsed, matchedTitle: String(r?.title ?? "").trim(), links: new Set<string>() };
      vote.links.add(link);
      snippetVotes.set(key, vote);
    }
  }
  for (const vote of Array.from(snippetVotes.values())) {
    if (vote.links.size >= 2) {
      return { street: vote.street, fullAddress: vote.fullAddress, matchedTitle: vote.matchedTitle, query: `${query} (snippet consensus ×${vote.links.size})` };
    }
  }
  return null;
}

async function fetchPortalSerpResults(query: string, apiKey: string): Promise<SerpListingResult[]> {
  const sp = new URLSearchParams({ engine: "google", q: query, num: "10", api_key: apiKey });
  const r = await fetch(`https://www.searchapi.io/api/v1/search?${sp.toString()}`, {
    signal: AbortSignal.timeout(12000),
  });
  // THROW on non-2xx (same transient contract as fetchMapsCandidates — never
  // negative-cache a rate-limit blip).
  if (!r.ok) throw new Error(`searchapi ${r.status}`);
  const data = (await r.json()) as any;
  return Array.isArray(data?.organic_results) ? (data.organic_results as SerpListingResult[]) : [];
}

// ── Claude web-search address rescue (LAST resort) ──────────────────────────
// When maps + reverse-geocode + portal SERPs all come up empty, ask Claude (with
// the server-side web_search tool) for the resort's street address. The answer is
// NEVER trusted raw — `acceptClaudeAddressCandidate` applies the same
// deterministic precision gates as every other leg (numbered street, state
// equivalence, resort-token match in the cited source evidence). Kill switch:
// BULK_COMBO_ADDRESS_CLAUDE=0.
export type ClaudeAddressCandidate = {
  street?: string | null;
  city?: string | null;
  state?: string | null;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  evidence?: string | null;
};

/** Deterministic acceptance gate for a Claude-researched address. Pure. */
export function acceptClaudeAddressCandidate(
  candidate: ClaudeAddressCandidate | null | undefined,
  input: { communityName: string; state?: string | null },
): DiscoveredStreetAddress | null {
  if (!candidate) return null;
  const rawStreet = String(candidate.street ?? "").trim();
  if (!rawStreet) return null;
  const street = streetRootFromAddress(rawStreet);
  if (!street || !isLikelyStreetAddress(street)) return null;
  const expectedState = String(input.state ?? "").trim();
  if (expectedState && !statesEquivalent(candidate.state, expectedState)) return null;
  // The community must be named in the cited evidence (title or quote) — the
  // same whole-word token gate the maps/SERP legs use, so a confidently wrong
  // answer about a different resort is rejected.
  const evidenceText = `${String(candidate.sourceTitle ?? "")} ${String(candidate.evidence ?? "")}`;
  if (!titleMatchesResort(evidenceText, input.communityName)) return null;
  const cityState = [String(candidate.city ?? "").trim(), String(candidate.state ?? "").trim()].filter(Boolean).join(", ");
  return {
    street,
    fullAddress: cityState ? `${rawStreet}, ${cityState}` : rawStreet,
    matchedTitle: String(candidate.sourceTitle ?? "").trim() || "Claude web research",
    query: `claude web search${candidate.sourceUrl ? ` (${String(candidate.sourceUrl).trim()})` : ""}`,
  };
}

async function discoverAddressViaClaudeWebSearch(input: {
  communityName: string;
  city: string;
  state: string;
}): Promise<{ found: DiscoveredStreetAddress | null; transient: boolean }> {
  if (process.env.BULK_COMBO_ADDRESS_CLAUDE === "0") return { found: null, transient: false };
  if (!process.env.ANTHROPIC_API_KEY) return { found: null, transient: false };
  const model = process.env.ADDRESS_DISCOVERY_CLAUDE_MODEL || "claude-sonnet-4-6";
  const locationHint = [input.city, input.state].filter(Boolean).join(", ");
  const res = await callClaudeWebSearchJson<ClaudeAddressCandidate>({
    model,
    maxTokens: 800,
    maxSearches: 4,
    timeoutMs: 75_000,
    prompt: `Find the real street address (house/lot number + street name) of the vacation-rental condo community "${input.communityName}"${locationHint ? ` in or near ${locationHint}` : ""}. Search the web (resort site, HOA, property managers, real-estate portals). The community may be indexed under a slightly different name — that is fine as long as it is the SAME physical resort.

Reply with ONLY a JSON object:
{"street":"<number + street, e.g. 78-6082 Alii Dr>","city":"<city>","state":"<state>","sourceUrl":"<page you got it from>","sourceTitle":"<that page's title>","evidence":"<verbatim sentence from the page that names the community and/or its address>"}

If you cannot find a reliable numbered street address for this exact community, reply {"street":null}. Never guess or fabricate an address.`,
  });
  if (!res.ok) {
    console.warn(`[address-discovery] claude web search "${input.communityName}": ${res.error}`);
    return { found: null, transient: true };
  }
  const found = acceptClaudeAddressCandidate(res.data, input);
  return { found, transient: false };
}

// ── Clubhouse discovery (separate published address, 2026-07-17) ─────────────
// The Guesty "separate published address" feature wants the community's
// CLUBHOUSE address published instead of the unit's. Same google_maps engine +
// the SAME whole-word title gate as street discovery (precision over recall —
// a sibling resort's clubhouse must never win), but clubhouse-flavored queries
// and a rank preference for POIs whose title actually says clubhouse/front
// desk/office. A plain resort-pin hit is still acceptable (the resort's own
// map pin is usually its office/clubhouse); the caller falls back to the
// generic main-building address when nothing clears the gate.

export type ClubhouseAddressCandidate = {
  street: string;
  fullAddress: string;
  matchedTitle: string;
  query: string;
  lat?: number;
  lng?: number;
};

/**
 * Pick the best clubhouse candidate: two passes over the relevance-ordered
 * maps results, both requiring the resort-token title gate + a real numbered
 * street — pass 1 takes a title with a clubhouse-ish hint word, pass 2 takes
 * any title-matched place. Pure / no network so it is unit-testable.
 */
export function selectClubhouseCandidate(
  candidates: MapsAddressCandidate[],
  resortName: string,
  query: string,
): ClubhouseAddressCandidate | null {
  const usable = (c: MapsAddressCandidate): ClubhouseAddressCandidate | null => {
    const fullAddress = String(c?.address ?? "").trim();
    if (!fullAddress) return null;
    const street = streetRootFromAddress(fullAddress);
    if (!street || !isLikelyStreetAddress(street)) return null;
    if (!titleMatchesResort(c?.title, resortName)) return null;
    const lat = Number(c?.gps_coordinates?.latitude);
    const lng = Number(c?.gps_coordinates?.longitude);
    return {
      street,
      fullAddress,
      matchedTitle: String(c?.title ?? "").trim(),
      query,
      ...(Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : {}),
    };
  };
  for (const c of candidates) {
    if (!CLUBHOUSE_TITLE_HINT_RE.test(String(c?.title ?? ""))) continue;
    const hit = usable(c);
    if (hit) return hit;
  }
  for (const c of candidates) {
    const hit = usable(c);
    if (hit) return hit;
  }
  return null;
}

const clubhouseCache = new Map<string, ClubhouseAddressCandidate | null>();

/**
 * Resolve a community's clubhouse street address from SearchAPI google_maps.
 * Null when the key is missing, the kill switch is set, or nothing clears the
 * precision gate — callers fall back to the generic main-building address.
 * Same transient-error contract as discoverCommunityStreetAddress: only a
 * definitive outcome is cached, so a 429 blip never permanently skips a
 * community's clubhouse.
 */
export async function discoverCommunityClubhouseAddress(input: {
  communityName?: string | null;
  city?: string | null;
  state?: string | null;
}): Promise<ClubhouseAddressCandidate | null> {
  const communityName = String(input.communityName ?? "").trim();
  if (!communityName) return null;
  if (process.env.PUBLISHED_ADDRESS_CLUBHOUSE_DISCOVERY === "0") return null;
  const apiKey = process.env.SEARCHAPI_API_KEY;
  if (!apiKey) return null;

  const city = String(input.city ?? "").trim();
  const state = String(input.state ?? "").trim();
  const cacheKey = ["clubhouse", communityName, city, state].map((v) => v.toLowerCase()).join("|");
  if (clubhouseCache.has(cacheKey)) return clubhouseCache.get(cacheKey) ?? null;

  let found: ClubhouseAddressCandidate | null = null;
  let anyTransientError = false;
  // A title-matched (ideally clubhouse-hinted) place with coordinates but no
  // usable street — reverse-geocoded only when no direct street hit lands.
  let coordsFallback: { lat: number; lng: number; matchedTitle: string; fullAddress: string; query: string } | null = null;
  for (const query of clubhouseDiscoveryQueries(communityName, city, state)) {
    let candidates: MapsAddressCandidate[] = [];
    try {
      candidates = await fetchMapsCandidates(query, apiKey);
    } catch (e: any) {
      anyTransientError = true;
      console.warn(`[clubhouse-discovery] "${query}": ${e?.message ?? e}`);
      continue;
    }
    const hit = selectClubhouseCandidate(candidates, communityName, query);
    if (hit) {
      found = hit;
      break;
    }
    if (!coordsFallback) {
      const cf = selectCoordinateFallbackCandidate(candidates, communityName);
      if (cf) coordsFallback = { ...cf, query };
    }
  }

  if (!found && coordsFallback) {
    try {
      const street = await reverseGeocodeToStreetAddress(coordsFallback.lat, coordsFallback.lng);
      if (street && isLikelyStreetAddress(street)) {
        found = {
          street: streetRootFromAddress(street),
          fullAddress: coordsFallback.fullAddress || street,
          matchedTitle: coordsFallback.matchedTitle,
          query: `${coordsFallback.query} (reverse-geocoded)`,
          lat: coordsFallback.lat,
          lng: coordsFallback.lng,
        };
      }
    } catch (e: any) {
      anyTransientError = true;
      console.warn(`[clubhouse-discovery] reverse-geocode "${communityName}": ${e?.message ?? e}`);
    }
  }

  if (found || !anyTransientError) clubhouseCache.set(cacheKey, found);
  return found;
}

const discoveryCache = new Map<string, DiscoveredStreetAddress | null>();

/**
 * Resolve a resort's real street address from SearchAPI google_maps. Returns null
 * (never throws to the caller via this signature; callers should still guard) when
 * the key is missing, the engine returns nothing usable, or no candidate clears the
 * precision gate. Results (including negative) are cached in-memory per process.
 */
export async function discoverCommunityStreetAddress(input: {
  communityName?: string | null;
  city?: string | null;
  state?: string | null;
}): Promise<DiscoveredStreetAddress | null> {
  const communityName = String(input.communityName ?? "").trim();
  if (!communityName) return null;
  if (process.env.BULK_COMBO_ADDRESS_DISCOVERY === "0") return null;
  const apiKey = process.env.SEARCHAPI_API_KEY;
  if (!apiKey) return null;

  const city = String(input.city ?? "").trim();
  const state = String(input.state ?? "").trim();
  const cacheKey = [communityName, city, state].map((v) => v.toLowerCase()).join("|");
  if (discoveryCache.has(cacheKey)) return discoveryCache.get(cacheKey) ?? null;

  let found: DiscoveredStreetAddress | null = null;
  let anyTransientError = false;
  // Best streetless-but-name-matched place seen across all queries; reverse-geocoded
  // into a real street only if NO direct street hit is found (a real street always
  // wins). Captured from the most-specific query that surfaced it.
  let coordsFallback: CoordinateFallbackCandidate | null = null;
  let coordsQuery = "";
  for (const query of buildQueries(communityName, city, state)) {
    let candidates: MapsAddressCandidate[] = [];
    try {
      candidates = await fetchMapsCandidates(query, apiKey);
    } catch (e: any) {
      anyTransientError = true; // network throw / timeout / non-2xx → not definitive
      console.warn(`[address-discovery] "${query}": ${e?.message ?? e}`);
      continue;
    }
    const hit = selectDiscoveredStreet(candidates, communityName, query);
    if (hit) { found = hit; break; }
    if (!coordsFallback) {
      const cf = selectCoordinateFallbackCandidate(candidates, communityName);
      if (cf) { coordsFallback = cf; coordsQuery = query; }
    }
  }

  // RESCUE: no direct numbered-street hit, but a correctly-named place exposed
  // coordinates — reverse-geocode the resort's own location into a real street. This
  // is precision-safe (the title gate already confirmed the resort) and converts the
  // most common miss (google_maps returns only the locality) into a usable address.
  // A reverse-geocode throw is transient (don't negative-cache); a clean null just
  // means the centroid has no house-numbered road and we fail exactly as before.
  if (!found && coordsFallback) {
    try {
      const street = await reverseGeocodeToStreetAddress(coordsFallback.lat, coordsFallback.lng);
      if (street && isLikelyStreetAddress(street)) {
        found = {
          street: streetRootFromAddress(street),
          fullAddress: coordsFallback.fullAddress || street,
          matchedTitle: coordsFallback.matchedTitle,
          query: `${coordsQuery} (reverse-geocoded)`,
        };
      }
    } catch (e: any) {
      anyTransientError = true;
      console.warn(`[address-discovery] reverse-geocode "${communityName}": ${e?.message ?? e}`);
    }
  }

  // RESCUE 2 (portal SERPs): google_maps only knows resorts indexed by OUR name.
  // Zillow/Realtor/Redfin detail URLs carry the unit's numbered street in the
  // slug, so a quoted-phrase SERP for the resort name can resolve the street even
  // when maps can't (the Kahaluu Reef name-indexing class). Precision-gated by
  // selectSerpListingAddressCandidate (title match, or >=2-listing snippet
  // consensus).
  if (!found) {
    const serpQueries = [
      `site:zillow.com "${communityName}" ${state}`.trim(),
      `site:realtor.com "${communityName}" ${state}`.trim(),
      `site:redfin.com "${communityName}" ${state}`.trim(),
    ];
    for (const query of serpQueries) {
      let results: SerpListingResult[] = [];
      try {
        results = await fetchPortalSerpResults(query, apiKey);
      } catch (e: any) {
        anyTransientError = true;
        console.warn(`[address-discovery] portal serp "${query}": ${e?.message ?? e}`);
        continue;
      }
      const hit = selectSerpListingAddressCandidate(results, communityName, query);
      if (hit) { found = hit; break; }
    }
  }

  // RESCUE 3 (Claude web research, LAST resort): only when every deterministic
  // leg came up empty. The answer passes the same precision gates (numbered
  // street + state + resort named in the cited evidence) before it is used.
  if (!found) {
    const claude = await discoverAddressViaClaudeWebSearch({ communityName, city, state })
      .catch((e: any) => {
        console.warn(`[address-discovery] claude rescue "${communityName}": ${e?.message ?? e}`);
        return { found: null, transient: true };
      });
    if (claude.found) found = claude.found;
    if (claude.transient) anyTransientError = true;
  }

  // Only cache a DEFINITIVE outcome: a hit, or a clean "no match" where every
  // query actually completed. A run marred by a transient error stays uncached so
  // a later retry (or the next item for the same resort) can try again.
  if (found || !anyTransientError) discoveryCache.set(cacheKey, found);
  return found;
}
