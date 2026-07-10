// ─────────────────────────────────────────────────────────────────────────────
// Surrounding-area amenity research (Claude WEB SEARCH leg of the amenity scan).
//
// The photo scan (server/amenity-scan.ts) can only detect amenities a camera
// can see — "Shopping Nearby" / "Golf Nearby" / "Near Restaurants" were never
// checked because no photo proves them. This module researches the community's
// ACTUAL surroundings with Claude web search and confirms a location amenity
// only when the model cites a real named place within the target's distance
// hint (see AMENITY_LOCATION_TARGETS). Same ADD-ONLY posture as vision.
//
// Fail-soft by design: no ANTHROPIC key, no resolvable location, a web-search
// error, or the kill switch all return an empty result with a warning — the
// photo scan + baseline fill still complete. Never throws.
//
// Kill switch: AMENITY_LOCATION_RESEARCH_DISABLED=1
// ─────────────────────────────────────────────────────────────────────────────

import { PROPERTY_UNIT_CONFIGS } from "@shared/property-units";
import { BUY_IN_MARKETS } from "@shared/buy-in-market";
import {
  AMENITY_LOCATION_TARGETS,
  getAmenityLabel,
} from "@shared/guesty-amenity-catalog";
import {
  buildAmenityLocationResearchPrompt,
  parseAmenityDetectionJson,
  type AmenityDetection,
} from "@shared/amenity-scan-logic";
import { callClaudeWebSearchJson } from "./claude-json";
import { storage } from "./storage";

const MODEL = process.env.AMENITY_LOCATION_MODEL || "claude-sonnet-4-6";
const MAX_SEARCHES = Number(process.env.AMENITY_LOCATION_MAX_SEARCHES || 6);
const MAX_TOKENS = Number(process.env.AMENITY_LOCATION_MAX_TOKENS || 2500);
// Bounded so the bulk-combo "amenities" step (5-min timeout) always has room
// for the vision batches running concurrently with this leg.
const TIMEOUT_MS = Number(process.env.AMENITY_LOCATION_TIMEOUT_MS || 120_000);

export type AmenityLocationContext = {
  /** Searchable place label, e.g. "Poipu Kai Resort, Koloa, Kauai, Hawaii". */
  searchLabel: string;
  communityName: string;
  city?: string;
  state?: string;
  address?: string;
};

export type AmenityLocationResearch = {
  /** True only when the web research actually ran and parsed. */
  researched: boolean;
  /** Confirmed location amenity keys (confidence high|medium). */
  detected: string[];
  /** Per-key evidence (place name + distance) for UI/diagnostics. */
  detail: AmenityDetection[];
  searchLabel?: string;
  searchCount?: number;
  /** Non-fatal reason the research was skipped or partial. */
  warning?: string;
};

export function amenityLocationResearchDisabled(): boolean {
  return process.env.AMENITY_LOCATION_RESEARCH_DISABLED === "1";
}

/**
 * Resolve the community + city/state the research should anchor on.
 * Positive ids → PROPERTY_UNIT_CONFIGS + the curated BUY_IN_MARKETS registry;
 * negative ids → the community_drafts row's own identity. Null when nothing
 * locatable exists (the scan then skips the leg with a warning).
 */
export async function resolveAmenityLocationContext(
  propertyId: number,
): Promise<AmenityLocationContext | null> {
  if (!Number.isFinite(propertyId) || propertyId === 0) return null;
  if (propertyId > 0) {
    const config = PROPERTY_UNIT_CONFIGS[propertyId];
    if (!config) return null;
    const market = BUY_IN_MARKETS[config.community];
    const city = market?.location?.city;
    const state = market?.location?.state;
    const searchLabel = market?.searchLocation
      || [config.community, city, state].filter(Boolean).join(", ")
      || config.community;
    return {
      searchLabel,
      communityName: config.community,
      city,
      state,
      address: market?.location?.streetAddress || undefined,
    };
  }
  const draft = await storage.getCommunityDraft(Math.abs(propertyId)).catch(() => undefined);
  if (!draft) return null;
  const name = String(draft.name || draft.listingTitle || "").trim();
  const city = String(draft.city || "").trim();
  const state = String(draft.state || "").trim();
  const address = String(draft.streetAddress || "").trim();
  // A bare name with no geography can't anchor a "what's nearby" search.
  if (!name || (!city && !state && !address)) return null;
  return {
    searchLabel: [name, city, state].filter(Boolean).join(", "),
    communityName: name,
    city: city || undefined,
    state: state || undefined,
    address: address || undefined,
  };
}

const EMPTY: Omit<AmenityLocationResearch, "warning"> = {
  researched: false,
  detected: [],
  detail: [],
};

/**
 * Research the surrounding area for the location-amenity targets. Never throws.
 */
export async function researchLocationAmenitiesForProperty(
  propertyId: number,
  opts: { anthropicApiKey?: string } = {},
): Promise<AmenityLocationResearch> {
  try {
    if (amenityLocationResearchDisabled()) {
      return { ...EMPTY, warning: "Area research is disabled (AMENITY_LOCATION_RESEARCH_DISABLED=1)." };
    }
    const apiKey = opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    if (!apiKey) {
      return { ...EMPTY, warning: "No ANTHROPIC_API_KEY — skipped the surrounding-area research." };
    }
    const ctx = await resolveAmenityLocationContext(propertyId);
    if (!ctx) {
      return { ...EMPTY, warning: "No community location (city/state) on file — skipped the surrounding-area research." };
    }
    const prompt = buildAmenityLocationResearchPrompt(AMENITY_LOCATION_TARGETS, {
      communityName: ctx.communityName,
      city: ctx.city,
      state: ctx.state,
      address: ctx.address,
      labelForKey: getAmenityLabel,
    });
    const res = await callClaudeWebSearchJson<unknown>({
      model: MODEL,
      maxTokens: MAX_TOKENS,
      system:
        "You are a precise vacation-rental location researcher. You verify what is genuinely near a specific community with web search, then return only valid JSON — no prose outside the JSON object. Never claim an amenity you could not verify with a named place.",
      prompt,
      maxSearches: MAX_SEARCHES,
      maxRounds: 5,
      apiKey,
      timeoutMs: TIMEOUT_MS,
    });
    if (!res.ok) {
      console.warn(`[amenity-location] research failed (${propertyId} · ${ctx.searchLabel}): ${res.error}`);
      return { ...EMPTY, searchLabel: ctx.searchLabel, warning: `Surrounding-area research failed: ${res.error}` };
    }
    const locationKeys = new Set(AMENITY_LOCATION_TARGETS.map((t) => t.key));
    const { detected, detail } = parseAmenityDetectionJson(res.data, locationKeys);
    console.log(
      `[amenity-location] ${ctx.searchLabel}: ${detected.length} nearby amenit${detected.length === 1 ? "y" : "ies"} confirmed` +
      ` (${res.searchCount ?? 0} web search${(res.searchCount ?? 0) === 1 ? "" : "es"})`,
    );
    return {
      researched: true,
      detected,
      detail,
      searchLabel: ctx.searchLabel,
      searchCount: res.searchCount,
    };
  } catch (e: any) {
    return { ...EMPTY, warning: `Surrounding-area research failed: ${e?.message ?? e}` };
  }
}
