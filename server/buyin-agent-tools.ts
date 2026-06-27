// ─────────────────────────────────────────────────────────────────────────────
// Buy-in agent READ tools (cowork buy-in engine, plan §3 / Phase 1).
//
// Thin, pure wrappers over the EXISTING deterministic logic so the agent reasons
// with the same numbers the legacy ladder uses, and never re-derives an invariant
// in its head. Each function here is what the /api/admin/buyin-agent/tools/*
// endpoints call AND what the unit tests assert against — so "the endpoint matches
// the in-process value" is true by construction.
// ─────────────────────────────────────────────────────────────────────────────

import { PROPERTY_UNIT_CONFIGS, type PropertyUnitConfig } from "@shared/property-units";
import { evaluateComboProfit, type ProfitVerdict } from "@shared/buy-in-profit";
import {
  pairIsWalkable,
  sharedResortPhraseKeys,
  type CityVrboListing,
} from "@shared/city-vrbo-combo";
import { nearbyTownsForCommunity, type NearbyTownForScan } from "./city-vrbo-expansion";

// Same flat/pct knobs the engine uses (server/auto-fill-job.ts) so the agent's
// profit read matches the gate's commit-time decision exactly.
const PROFIT_MIN_FLAT_USD = Number(process.env.AUTOFILL_PROFIT_MIN_FLAT ?? 100) || 0;
const PROFIT_MIN_PCT = Number(process.env.AUTOFILL_PROFIT_MIN_PCT ?? 0) || 0;

export function toolPropertyUnitConfig(propertyId: number): PropertyUnitConfig | null {
  if (!Number.isFinite(propertyId)) return null;
  return PROPERTY_UNIT_CONFIGS[propertyId] ?? null;
}

export async function toolNearbyTowns(
  community: string,
  maxDriveMinutes?: number,
  limit?: number,
): Promise<NearbyTownForScan[]> {
  const c = String(community ?? "").trim();
  if (!c) return [];
  return nearbyTownsForCommunity(
    c,
    Number.isFinite(maxDriveMinutes as number) ? Number(maxDriveMinutes) : undefined,
    Number.isFinite(limit as number) ? Number(limit) : undefined,
  );
}

export type WalkabilityVerdict = {
  ok: boolean;
  walkMinutes: number | null;
  walkSource: ReturnType<typeof pairIsWalkable>["walkSource"];
  // The shared strong text keys (for transparency in the agent's reasoning / logs).
  sharedPhraseKeys: string[];
};

// Coerce loose agent-supplied picks into the CityVrboListing shape pairIsWalkable
// expects. NOTE (plan §4): walkability here runs on AGENT-SUPPLIED coords — it is a
// PRE-FILTER only. The authoritative check is the attach-time proximity gate on
// SERVER-RE-DERIVED coords (wired in propose_attach, Phase 2).
export function toolCheckWalkability(picksRaw: Array<Partial<CityVrboListing>>): WalkabilityVerdict {
  const picks: CityVrboListing[] = (picksRaw ?? []).map((p) => ({
    url: String(p?.url ?? ""),
    title: String(p?.title ?? ""),
    bedrooms: p?.bedrooms ?? null,
    lat: typeof p?.lat === "number" ? p.lat : null,
    lng: typeof p?.lng === "number" ? p.lng : null,
    photoHashes: Array.isArray(p?.photoHashes) ? p.photoHashes : undefined,
    images: Array.isArray(p?.images) ? p.images : undefined,
    image: typeof p?.image === "string" ? p.image : undefined,
    complexName: typeof p?.complexName === "string" ? p.complexName : null,
    propertyManager: typeof p?.propertyManager === "string" ? p.propertyManager : null,
    snippet: typeof p?.snippet === "string" ? p.snippet : undefined,
    locationText: typeof p?.locationText === "string" ? p.locationText : null,
  }));
  const verdict = pairIsWalkable(picks);
  let sharedPhraseKeys: string[] = [];
  if (picks.length >= 2) {
    const aKeys = new Set(sharedResortPhraseKeys(picks[0]));
    sharedPhraseKeys = sharedResortPhraseKeys(picks[1]).filter((k) => aKeys.has(k));
  }
  return { ...verdict, sharedPhraseKeys };
}

export function toolEvaluateProfit(args: {
  expectedRevenue: number;
  existingCost: number;
  comboCost: number;
}): ProfitVerdict {
  return evaluateComboProfit({
    expectedRevenue: Number(args.expectedRevenue) || 0,
    existingCost: Number(args.existingCost) || 0,
    comboCost: Number(args.comboCost) || 0,
    flat: PROFIT_MIN_FLAT_USD,
    pct: PROFIT_MIN_PCT,
  });
}
