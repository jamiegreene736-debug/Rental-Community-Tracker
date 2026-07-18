// Guesty "separate published address" — pure logic (2026-07-17).
//
// Guesty listings carry TWO addresses: the private `address` (exact unit
// location, shared with confirmed guests) and an optional `publishedAddress`
// that booking channels display publicly when `isPublishedAddressEnabled` is
// true. The operator wants that feature ON for EVERY listing, pointed at the
// community's CLUBHOUSE address when one can be found, else the main
// building's GENERIC address — never a specific unit number.
//
// API CONTRACT (verified against Guesty's OpenAPI reference 2026-07-17,
// open-api-docs.guesty.com/reference/addresscontroller_updateaddress):
//   PUT /v1/address/{guestyPropertyId}/update with ALL THREE keys required:
//     { address, publishedAddress, isPublishedAddressEnabled }
//   — so the engine must GET /v1/address/{id} first and ECHO the private
//   address back verbatim (clobbering it would corrupt the real location).
//   PUT /listings/{id} does NOT accept publishedAddress (response-only there).
//   Read-back verification = GET /v1/address/{id} asserting the flag AND the
//   published street/city echo; never infer enablement from mere presence.
//
// This module is browser-safe (no server imports) and holds every pure,
// unit-testable piece: unit-designator stripping, the PUT payload builder
// (which structurally CANNOT carry a unit number), the idempotence compare,
// the resolution-cache store shape, and the ledger summary wording.

import {
  isLikelyStreetAddress,
  normalizeCommunityAddressToken,
  streetRootFromAddress,
} from "./community-addresses";

// ── Shapes ───────────────────────────────────────────────────────────────────

/** Tolerant mirror of Guesty's address object (Address controller rich shape
 *  + the listing document's flat lat/lng variant). */
export type GuestyAddressLike = {
  full?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zipcode?: string | number | null;
  country?: string | null;
  county?: string | null;
  neighborhood?: string | null;
  searchable?: string | null;
  apartment?: string | null;
  unitNumber?: string | null;
  floor?: string | null;
  buildingName?: string | null;
  location?: { lat?: number | null; lng?: number | null } | null;
  lat?: number | null;
  lng?: number | null;
};

export type PublishedAddressSource = "clubhouse" | "community";

export type PublishedAddressParts = {
  street: string; // numbered street root — unit designators already stripped
  city?: string;
  state?: string;
  zipcode?: string;
  country?: string;
  lat?: number;
  lng?: number;
};

export type ResolvedPublishedAddress = PublishedAddressParts & {
  source: PublishedAddressSource;
  /** Operator-facing provenance, e.g. the matched maps title
   *  "Poipu Kai Resort Clubhouse" or "main building address". */
  label: string;
  resolvedAt: string; // ISO
};

// ── Unit-designator handling ─────────────────────────────────────────────────

// Three strip layers on top of the canonical streetRootFromAddress, each
// covering a form it misses (all found/locked by this module's tests):
//  • the bare "#1834" form — streetRootFromAddress's `\b(?:…|#)` boundary can
//    never match a "#" after a space;
//  • the trailing hyphenated building-unit form "2695 S Kihei Rd 10-201" —
//    its trailing strip only allows `[A-Za-z]?\d{1,5}[A-Za-z]?`, so the
//    internal hyphen slips through (the $-anchor after a street-suffix word
//    keeps LEADING Hawaii hyphenated house numbers "75-6082 Alii Dr" intact);
//  • "Villa <unit>" — constrained to unit-SHAPED tokens ("Villa 2903",
//    "Villa B") so real street names like "100 Villa Del Mar Dr" and
//    "70 Venice Villas Ln" are never mangled into a different street.
const STREET_SUFFIX_WORDS =
  "Rd|Road|Dr|Drive|St|Street|Ave|Avenue|Ln|Lane|Hwy|Highway|Blvd|Boulevard|Way|Cir|Circle|Ct|Court|Pl|Place|Trl|Trail|Pkwy|Parkway";
const UNIT_DESIGNATOR_RE = new RegExp(
  "(?:\\b(?:apartment|apt|unit|suite|ste|building|bldg)\\s*\\.?\\s*[a-z0-9-]+\\b" +
    "|\\bvillas?\\s*\\.?\\s*\\d[a-z0-9-]*\\b" +
    "|\\bvilla\\s+[a-z]\\b" +
    "|#\\s*[a-z0-9-]+\\b" +
    `|\\b(?:${STREET_SUFFIX_WORDS})\\s+[a-z]?\\d{1,5}-\\d{1,5}[a-z]?\\s*$)`,
  "i",
);

/** True when a street/full line still carries a unit/apt/#/bldg designator. */
export function hasUnitDesignator(value: string | null | undefined): boolean {
  return UNIT_DESIGNATOR_RE.test(String(value ?? ""));
}

/** Remove every unit designator (incl. the bare "#1834" and trailing
 *  "Rd 10-201" forms) from a street line. Idempotent; collapses whitespace. */
export function stripPublishedUnitTokens(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/#\s*[A-Za-z0-9-]+\b/g, " ")
    .replace(/\b(?:apartment|apt|unit|suite|ste|building|bldg)\s*\.?\s*[A-Za-z0-9-]+\b/gi, " ")
    .replace(/\bvillas?\s*\.?\s*\d[A-Za-z0-9-]*\b/gi, " ")
    .replace(/\bvilla\s+[A-Za-z]\b/gi, " ")
    .replace(
      new RegExp(`\\b(${STREET_SUFFIX_WORDS})\\s+[A-Za-z]?\\d{1,5}-\\d{1,5}[A-Za-z]?\\s*$`, "i"),
      "$1",
    )
    .replace(/\s+/g, " ")
    .replace(/[\s,]+$/g, "")
    .trim();
}

/** The published-address street root: canonical streetRootFromAddress plus
 *  the bare-# strip. Returns "" when no numbered street survives. */
export function publishedStreetRoot(value: string | null | undefined): string {
  const root = stripPublishedUnitTokens(streetRootFromAddress(value));
  return root && isLikelyStreetAddress(root) ? root : "";
}

/**
 * Derive the GENERIC main-building published parts from a listing's PRIVATE
 * address: the numbered street root with every unit designator stripped
 * (via the canonical streetRootFromAddress), keeping the private city/state/
 * zip/country/coords so channels still pin the right area. Returns null when
 * no numbered street can be derived — the caller falls back to local data
 * (curated rule / builder config / draft columns) instead of guessing.
 */
export function genericPublishedPartsFromPrivateAddress(
  addr: GuestyAddressLike | null | undefined,
): PublishedAddressParts | null {
  if (!addr || typeof addr !== "object") return null;
  const candidates = [addr.full, addr.street];
  let street = "";
  for (const c of candidates) {
    const root = publishedStreetRoot(String(c ?? ""));
    if (root) {
      street = root;
      break;
    }
  }
  if (!street) return null;
  const zip = addr.zipcode == null ? "" : String(addr.zipcode).trim();
  const lat = addressLat(addr);
  const lng = addressLng(addr);
  return {
    street,
    city: str(addr.city),
    state: str(addr.state),
    zipcode: zip || undefined,
    country: str(addr.country),
    ...(lat != null && lng != null ? { lat, lng } : {}),
  };
}

function str(v: unknown): string | undefined {
  const s = String(v ?? "").trim();
  return s ? s : undefined;
}

// Type-checked coordinate parse (the repo's numberFromCandidate posture):
// Number(null) === 0, so a raw Number() coercion would turn Guesty's
// present-but-null coords into 0/0 — Null Island — and durably cache them.
export function finiteCoord(v: unknown, absMax: number): number | null {
  const n =
    typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && Math.abs(n) <= absMax ? n : null;
}

export function addressLat(addr: GuestyAddressLike | null | undefined): number | null {
  return finiteCoord(addr?.location?.lat, 90) ?? finiteCoord(addr?.lat, 90);
}

export function addressLng(addr: GuestyAddressLike | null | undefined): number | null {
  return finiteCoord(addr?.location?.lng, 180) ?? finiteCoord(addr?.lng, 180);
}

// ── PUT payload builder ──────────────────────────────────────────────────────

/** "1831 Poipu Rd, Koloa, HI 96756, United States" (parts optional). */
export function composePublishedFull(parts: PublishedAddressParts): string {
  const stateZip = [str(parts.state), str(parts.zipcode)].filter(Boolean).join(" ");
  return [str(parts.street), str(parts.city), stateZip || undefined, str(parts.country)]
    .filter(Boolean)
    .join(", ");
}

/**
 * The `publishedAddress` object for the Address-controller PUT. Structurally
 * generic: unitNumber / apartment / floor / buildingName are NEVER emitted —
 * the whole point of the feature is that no specific unit is published.
 * `location` is included only with finite coordinates (the PUT schema wants
 * one; the engine falls back to the private address's coords upstream).
 */
export function buildGuestyPublishedAddress(parts: PublishedAddressParts): Record<string, unknown> {
  const out: Record<string, unknown> = {
    full: composePublishedFull(parts),
    street: parts.street,
  };
  if (str(parts.city)) out.city = str(parts.city);
  if (str(parts.state)) out.state = str(parts.state);
  if (str(parts.zipcode)) out.zipcode = str(parts.zipcode);
  if (str(parts.country)) out.country = str(parts.country);
  const lat = finiteCoord(parts.lat, 90);
  const lng = finiteCoord(parts.lng, 180);
  if (lat != null && lng != null) {
    out.location = { lat, lng };
  }
  return out;
}

// ── Idempotence compare ──────────────────────────────────────────────────────

/**
 * Does Guesty's CURRENT publishedAddress already satisfy the target?
 * Street-root + city compare, normalized (case / punctuation / suffix
 * abbreviations / Hawaiian diacritics). Used by the ensure hooks so a weekly
 * audit or a mapping-birth event doesn't re-PUT an address that's already
 * right. A missing/streetless current published address never satisfies.
 */
export function publishedAddressSatisfiesTarget(
  current: GuestyAddressLike | null | undefined,
  target: PublishedAddressParts,
): boolean {
  if (!current || typeof current !== "object") return false;
  // `||` (not `??`) — an empty-string `full` must fall through to `street`.
  const currentStreet = stripPublishedUnitTokens(
    streetRootFromAddress(String(current.full || current.street || "")),
  );
  if (!currentStreet) return false;
  const curNorm = normalizeCommunityAddressToken(currentStreet);
  const targetNorm = normalizeCommunityAddressToken(stripPublishedUnitTokens(target.street));
  if (!curNorm || !targetNorm || curNorm !== targetNorm) return false;
  const targetCity = normalizeCommunityAddressToken(String(target.city ?? ""));
  if (!targetCity) return true; // no target city to compare — street match is enough
  const currentCity = normalizeCommunityAddressToken(String(current.city ?? ""));
  // A current published address that omits city still counts when the street
  // matches — some channel-synced docs drop subfields.
  return !currentCity || currentCity === targetCity;
}

// ── Resolution cache store (app_settings `published_addresses.v1`) ──────────
// Keyed by the app's builder propertyId (positive core id OR negative
// -draftId, the guesty_property_map convention) so a clubhouse discovered
// during the combo pipeline (before any listing exists) is reused the moment
// the mapping is born — no second SearchAPI spend.

export const PUBLISHED_ADDRESS_STORE_KEY = "published_addresses.v1";
export const PUBLISHED_ADDRESS_CACHE_CAP = 300;

export type PublishedAddressStoreEntry = ResolvedPublishedAddress & { updatedAt: string };

export type PublishedAddressStore = {
  version: 1;
  properties: Record<string, PublishedAddressStoreEntry>;
};

const isValidIso = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(new Date(value).getTime());

export function parsePublishedAddressStore(raw: string | null | undefined): PublishedAddressStore {
  const empty: PublishedAddressStore = { version: 1, properties: {} };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as Partial<PublishedAddressStore> | null;
    if (!parsed || typeof parsed !== "object" || !parsed.properties || typeof parsed.properties !== "object") {
      return empty;
    }
    const properties: PublishedAddressStore["properties"] = {};
    for (const [key, value] of Object.entries(parsed.properties)) {
      if (!key || !value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      const street = String(v.street ?? "").trim();
      if (!street) continue;
      const source: PublishedAddressSource = v.source === "clubhouse" ? "clubhouse" : "community";
      const entry: PublishedAddressStoreEntry = {
        street,
        city: str(v.city),
        state: str(v.state),
        zipcode: str(v.zipcode),
        country: str(v.country),
        source,
        label: String(v.label ?? "").trim() || (source === "clubhouse" ? "clubhouse" : "main building address"),
        resolvedAt: isValidIso(v.resolvedAt) ? new Date(v.resolvedAt).toISOString() : new Date(0).toISOString(),
        updatedAt: isValidIso(v.updatedAt) ? new Date(v.updatedAt).toISOString() : new Date(0).toISOString(),
      };
      const lat = finiteCoord(v.lat, 90);
      const lng = finiteCoord(v.lng, 180);
      if (lat != null && lng != null) {
        entry.lat = lat;
        entry.lng = lng;
      }
      properties[key] = entry;
    }
    return { version: 1, properties };
  } catch {
    return empty;
  }
}

/** LRU-evicts past the cap at write time so the app_settings blob stays bounded. */
export function serializePublishedAddressStore(store: PublishedAddressStore): string {
  const keys = Object.keys(store.properties);
  if (keys.length > PUBLISHED_ADDRESS_CACHE_CAP) {
    keys
      .sort((a, b) =>
        (store.properties[b].updatedAt || "").localeCompare(store.properties[a].updatedAt || ""),
      )
      .slice(PUBLISHED_ADDRESS_CACHE_CAP)
      .forEach((k) => {
        delete store.properties[k];
      });
  }
  return JSON.stringify(store);
}

// ── Clubhouse discovery queries ──────────────────────────────────────────────

/** google_maps query phrasings for the community's clubhouse, most-specific
 *  first. The mailing city can be wrong on swept resorts, so a city-less
 *  variant is included. */
export function clubhouseDiscoveryQueries(
  communityName: string,
  city?: string | null,
  state?: string | null,
): string[] {
  const name = String(communityName ?? "").trim();
  if (!name) return [];
  const c = String(city ?? "").trim();
  const s = String(state ?? "").trim();
  const raw = [
    [name, "clubhouse", c, s].filter(Boolean).join(" "),
    [name, "resort clubhouse", s].filter(Boolean).join(" "),
    [name, "clubhouse", s].filter(Boolean).join(" "),
  ];
  return Array.from(new Set(raw.map((q) => q.trim()).filter(Boolean)));
}

/** Title words that mark a maps POI as the amenity/front-desk building rather
 *  than the resort's generic pin. Used only to RANK candidates — a plain
 *  resort-pin hit is still acceptable (its pin is usually the office). */
export const CLUBHOUSE_TITLE_HINT_RE = /\b(?:club\s*house|clubhouse|amenity center|recreation center|front desk|reception|office)\b/i;

// ── ASCII fold for Guesty's Address PUT validator ────────────────────────────
// Live-observed 2026-07-17 (Na Hale O Keauhou): GET /v1/address returns the
// stored "78-6833 Ali‘i Dr" (curly-quote okina), but PUTting that VERBATIM
// echo back 400s — Guesty's write validator rejects the non-ASCII character
// its own store contains. Folding the okina/macrons ("Ali‘i" → "Alii") is
// semantically the same address and matches how every other Kona address in
// the portfolio is written. Applied only as a bounded 400-retry, never on the
// first attempt (echo-verbatim stays the rule).

export function hasNonAsciiAddressChars(value: unknown): boolean {
  return /[^\x20-\x7E]/.test(JSON.stringify(value ?? ""));
}

/** Deep-copy an address-shaped object with every STRING value diacritic-
 *  folded (okina/macron dropped); numbers/objects pass through untouched. */
export function foldAddressObjectStrings<T>(value: T, fold: (s: string) => string): T {
  if (typeof value === "string") return fold(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => foldAddressObjectStrings(v, fold)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = foldAddressObjectStrings(v, fold);
    }
    return out as unknown as T;
  }
  return value;
}

// ── Ledger summary (test-locked wording) ─────────────────────────────────────

export function publishedAddressSourceLabel(source: PublishedAddressSource): string {
  return source === "clubhouse" ? "clubhouse" : "main building";
}

export function summarizePublishedAddressPush(street: string, source: PublishedAddressSource): string {
  return `Published address pushed (${street} · ${publishedAddressSourceLabel(source)})`;
}
