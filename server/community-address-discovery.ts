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

export type DiscoveredStreetAddress = {
  street: string;
  fullAddress: string;
  matchedTitle: string;
  query: string;
};

export type MapsAddressCandidate = { title?: string | null; address?: string | null };

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
  // carry `title` + `address`. Scan place_results first, then the list in order.
  if (data?.place_results) out.push({ title: data.place_results.title, address: data.place_results.address });
  if (Array.isArray(data?.local_results)) {
    for (const lr of data.local_results) out.push({ title: lr?.title, address: lr?.address });
  }
  return out;
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
  }

  // Only cache a DEFINITIVE outcome: a hit, or a clean "no match" where every
  // query actually completed. A run marred by a transient error stays uncached so
  // a later retry (or the next item for the same resort) can try again.
  if (found || !anyTransientError) discoveryCache.set(cacheKey, found);
  return found;
}
