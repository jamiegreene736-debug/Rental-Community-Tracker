// Pure logic: judge whether a Google Lens reverse-image result confirms a
// community-folder photo belongs to the expected resort/community.

import {
  communityConflictsWithResult,
  communityEvidenceInResult,
  type PreflightSearchResult,
} from "./preflight-platform-match";
import { textMatchesResortPhrase } from "./buy-in-market";
import { communityNamesMatch, normalizeCommunityName } from "./photo-community-check-logic";
import { sharedResortPhraseKeys } from "./city-vrbo-combo";
import { communityPhotoSiblingConflict } from "./community-photo-subcommunity";

export type LensEvidenceRow = {
  title?: string | null;
  snippet?: string | null;
  link?: string | null;
  source?: string;
  position?: number;
};

export type CommunityLensVerdict = {
  match: "yes" | "no";
  reason: string;
  identifiedCommunity?: string;
};

export type CommunityLensClassification = {
  outcome: "confirmed" | "contradicted" | "generic_amenity" | "inconclusive";
  reason: string;
  identifiedCommunity?: string;
};

function toSearchResult(row: LensEvidenceRow): PreflightSearchResult {
  return {
    title: row.title ?? "",
    snippet: row.snippet ?? "",
    link: row.link ?? "",
  };
}

function haystackFromResult(result: PreflightSearchResult): string {
  return `${result.title ?? ""} ${result.snippet ?? ""} ${result.link ?? ""}`.trim();
}

/** Core resort name without trailing condo/community suffixes (common in AI overviews). */
function coreCommunityLabel(name: string): string {
  return name
    .replace(/\b(condominiums|condos|condo units?|community)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Distinctive tokens for fuzzy name matching (excludes generic resort words). */
function distinctiveCommunityTokens(name: string): string[] {
  const stop = new Set([
    "club", "country", "golf", "resort", "condominiums", "condo", "condos",
    "community", "the", "and", "tennis", "beach",
  ]);
  return normalizeCommunityName(name)
    .split(/\s+/)
    .filter((word) => word.length > 3 && !stop.has(word));
}

function haystackContainsDistinctiveCommunityTokens(hay: string, expectedCommunity: string): boolean {
  const tokens = distinctiveCommunityTokens(expectedCommunity);
  if (tokens.length === 0) return false;
  const normalized = normalizeCommunityName(hay);
  return tokens.every((token) => normalized.includes(token));
}

/**
 * Whether a reverse-image-identified resort sits in the SAME geographic area as
 * the expected community (shares a place token like "poipu" / "princeville").
 *
 * Shared/sibling resorts in one complex (Regency at Poipu Kai, Poipu Sands,
 * Poipu Kapili…) reuse near-identical pool/tennis/grounds photos, so Google Lens
 * routinely cross-matches a real community photo to a sibling resort. A same-area
 * "different resort" hit is therefore NOT decisive evidence of a wrong photo.
 */
export function communitySharesGeoArea(
  identified: string,
  expectedCommunity: string,
  city = "",
): boolean {
  const idTokens = new Set(distinctiveCommunityTokens(identified));
  if (idTokens.size === 0) return false;
  const areaTokens = [
    ...distinctiveCommunityTokens(expectedCommunity),
    ...distinctiveCommunityTokens(city),
  ];
  return areaTokens.some((token) => idTokens.has(token));
}

/** Whether Lens/AI text supports the expected community (dict, phrase, or fuzzy name). */
export function communityHaystackSupportsExpected(hay: string, expectedCommunity: string): boolean {
  const text = hay.trim();
  const expected = expectedCommunity.trim();
  if (!text || !expected) return false;

  if (communityPhotoSiblingConflict(text, expected)) return false;

  const asResult: PreflightSearchResult = { title: text, snippet: "", link: "" };
  if (communityEvidenceInResult(asResult, expected)) return true;

  const core = coreCommunityLabel(expected);
  if (core && textMatchesResortPhrase(text, core)) return true;

  if (haystackContainsDistinctiveCommunityTokens(text, expected)) return true;

  const extracted = extractIdentifiedCommunityName(text);
  if (extracted && communityNamesMatch(extracted, expected)) return true;

  return false;
}

/** True when Lens text names a resort but carries no dict keys (generic VRBO title). */
export function lensHaystackIsGenericAmenity(text: string): boolean {
  const hay = text.toLowerCase();
  if (!hay.trim()) return true;
  const keys = sharedResortPhraseKeys(hay);
  if (keys.size > 0) return false;
  // Obvious community-amenity shots without a named resort in the hit text.
  return /\b(pool|swimming|tennis|golf|clubhouse|resort grounds|amenit)\b/i.test(hay)
    && !/\b(at|in)\s+[a-z]{4,}/i.test(hay);
}

/** Classify Lens hits without collapsing inconclusive results to a hard "no". */
export function classifyCommunityPhotoFromLens(
  expectedCommunity: string,
  rows: LensEvidenceRow[],
  extraTexts: string[] = [],
  city = "",
): CommunityLensClassification {
  const verdict = judgeCommunityPhotoFromLensCore(expectedCommunity, rows, extraTexts, city);
  if (verdict.match === "yes") {
    const generic = verdict.reason.includes("Generic resort amenity");
    return {
      outcome: generic ? "generic_amenity" : "confirmed",
      reason: verdict.reason,
      identifiedCommunity: verdict.identifiedCommunity,
    };
  }
  const inconclusive =
    verdict.reason.includes("no usable matches")
    || verdict.reason.includes("could not confirm");

  // A "different resort" hit that names a SAME-AREA sibling resort (shared
  // pool/tennis/grounds photos cross-match between Poipu resorts) is not decisive
  // — defer to vision instead of hard-failing a real community amenity photo.
  // Hard sibling conflicts (e.g. Regency vs Villas at Poipu Kai) stay contradicted.
  const hardSiblingConflict = verdict.reason.includes("different complex within Poipu Kai");
  if (
    !inconclusive
    && verdict.identifiedCommunity
    && !hardSiblingConflict
    && communitySharesGeoArea(verdict.identifiedCommunity, expectedCommunity, city)
  ) {
    return {
      outcome: "inconclusive",
      reason: `${verdict.reason} Same-area resort — needs visual confirmation.`,
      identifiedCommunity: verdict.identifiedCommunity,
    };
  }

  return {
    outcome: inconclusive ? "inconclusive" : "contradicted",
    reason: verdict.reason,
    identifiedCommunity: verdict.identifiedCommunity,
  };
}

export function judgeCommunityPhotoFromLens(
  expectedCommunity: string,
  rows: LensEvidenceRow[],
  extraTexts: string[] = [],
  city = "",
): CommunityLensVerdict {
  return judgeCommunityPhotoFromLensCore(expectedCommunity, rows, extraTexts, city);
}

/**
 * Google Lens AI Overview = Gemini's own analysis of the image ("These are the
 * tennis courts at the Poipu Kai Resort"). It is far more authoritative than a
 * noisy reverse-image organic title that happens to name a sibling resort, so we
 * consult it FIRST: a positive identification of the expected community confirms
 * the photo even when an organic hit names a different sibling; a different-area
 * resort named by the overview contradicts. A same-area sibling named by the
 * overview is ambiguous (shared amenity photos) → fall through to vision.
 */
export function analyzeAiOverviewForCommunity(
  aiTexts: string[],
  expectedCommunity: string,
  city = "",
): { outcome: "confirms" | "contradicts" | "inconclusive"; identified?: string } {
  const expected = expectedCommunity.trim();
  const texts = aiTexts.filter((t) => typeof t === "string" && t.trim());
  if (!expected || texts.length === 0) return { outcome: "inconclusive" };

  for (const text of texts) {
    if (communityHaystackSupportsExpected(text, expected)) {
      return { outcome: "confirms", identified: expected };
    }
  }
  for (const text of texts) {
    const sibling = communityPhotoSiblingConflict(text, expected);
    if (sibling) {
      return { outcome: "contradicts", identified: sibling.identifiedCommunity };
    }
  }
  for (const text of texts) {
    // sharedResortPhraseKeys reads the candidate's title — pass the AI Overview
    // line as a title-only candidate (not a bare string, which it can't read).
    const keys = sharedResortPhraseKeys({ title: text, sourceLabel: "", snippet: "", complexName: "" });
    for (const key of keys) {
      if (communityNamesMatch(key, expected)) return { outcome: "confirms", identified: expected };
      if (!communitySharesGeoArea(key, expected, city)) {
        return { outcome: "contradicts", identified: key };
      }
    }
  }
  return { outcome: "inconclusive" };
}

function judgeCommunityPhotoFromLensCore(
  expectedCommunity: string,
  rows: LensEvidenceRow[],
  extraTexts: string[] = [],
  city = "",
): CommunityLensVerdict {
  const expected = expectedCommunity.trim();
  if (!expected) {
    return { match: "no", reason: "Expected community name missing — cannot verify photo." };
  }

  const ordered = [...rows].sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
  const rowSlice = ordered.slice(0, 12);
  const rowCandidates = rowSlice.map(toSearchResult);

  if (rowCandidates.length === 0 && extraTexts.filter(Boolean).length === 0) {
    return {
      match: "no",
      reason: "Reverse image search returned no usable matches to verify this photo.",
    };
  }

  // Google Lens AI Overview is the strongest signal — Gemini analysed the image
  // itself. Consult it BEFORE the per-row conflict scan so a real community photo
  // is not hard-failed by a sibling-resort organic title when the overview clearly
  // names the expected resort.
  const ai = analyzeAiOverviewForCommunity(extraTexts, expected, city);
  if (ai.outcome === "confirms") {
    return {
      match: "yes",
      reason: `Google Lens AI Overview identifies this as ${expected}.`,
      identifiedCommunity: expected,
    };
  }
  if (ai.outcome === "contradicts") {
    return {
      match: "no",
      reason: `Google Lens AI Overview identifies a different resort (${ai.identified}).`,
      identifiedCommunity: ai.identified,
    };
  }

  const conflicts: Array<{ reason: string; text: string; position: number }> = [];
  const evidence: Array<{ text: string; position: number }> = [];

  for (let idx = 0; idx < rowCandidates.length; idx++) {
    const result = rowCandidates[idx];
    const hay = haystackFromResult(result);
    if (!hay.trim()) continue;

    const position = rowSlice[idx]?.position ?? idx + 1;

    const siblingConflict = communityPhotoSiblingConflict(hay, expected);
    if (siblingConflict) {
      conflicts.push({ reason: siblingConflict.reason, text: hay, position });
      continue;
    }

    const conflict = communityConflictsWithResult(result, expected);
    if (conflict) {
      conflicts.push({ reason: conflict, text: hay, position });
      continue;
    }
    if (communityHaystackSupportsExpected(hay, expected)) {
      evidence.push({ text: hay, position });
    }
  }

  const bestEvidencePosition = evidence.reduce((min, hit) => Math.min(min, hit.position), Infinity);
  const earliestConflictPosition = conflicts.reduce((min, hit) => Math.min(min, hit.position), Infinity);

  // Strongest signal: a top visual match names a different resort. Prefer the
  // resort key the CONFLICT detector found ("Different resort detected (X)") —
  // it uses the full resort dictionary, whereas extractIdentifiedCommunityName
  // only sees a narrower phrase set and often returns nothing.
  // When BOTH support and sibling noise appear (common in the Poipu Kai umbrella),
  // the higher-ranked hit wins — e.g. Regency #821 at position 1 beats Villas at 2.
  if (
    conflicts.length > 0
    && (evidence.length === 0 || earliestConflictPosition < bestEvidencePosition)
  ) {
    const top = conflicts.sort((a, b) => a.position - b.position)[0];
    const fromReason = top.reason.match(/\(([^)]+)\)\s*$/)?.[1]?.trim();
    const identified = fromReason || extractIdentifiedCommunityName(top.text);
    return {
      match: "no",
      reason: top.reason || `Photo appears to depict a different community (${identified || "not the expected resort"}).`,
      identifiedCommunity: identified,
    };
  }

  if (evidence.length > 0) {
    return {
      match: "yes",
      reason: `Reverse image search confirms ${expected}.`,
      identifiedCommunity: expected,
    };
  }

  const extraCandidates: PreflightSearchResult[] = extraTexts
    .filter(Boolean)
    .map((text) => ({ title: text, snippet: "", link: "" }));

  // Generic amenity hits (pool/lounge) with no resort name are OK for community folders.
  const allHaystacks = [
    ...rowCandidates.map((r) => haystackFromResult(r)),
    ...extraCandidates.map((r) => haystackFromResult(r)),
  ];
  const allGeneric = allHaystacks.every((hay) => lensHaystackIsGenericAmenity(hay));
  if (allGeneric) {
    return {
      match: "yes",
      reason: "Generic resort amenity — no conflicting community identified in search results.",
      identifiedCommunity: expected,
    };
  }

  // Named a community in results but not ours — treat as mismatch.
  const fallbackCandidates = [...rowCandidates, ...extraCandidates];
  for (let idx = 0; idx < Math.min(5, fallbackCandidates.length); idx++) {
    const result = fallbackCandidates[idx];
    const hay = haystackFromResult(result);
    const siblingConflict = communityPhotoSiblingConflict(hay, expected);
    if (siblingConflict) {
      return {
        match: "no",
        reason: siblingConflict.reason,
        identifiedCommunity: siblingConflict.identifiedCommunity,
      };
    }
    const keys = sharedResortPhraseKeys(hay);
    if (keys.size === 0) continue;
    const named = Array.from(keys)[0];
    if (named && !communityNamesMatch(named, expected)) {
      return {
        match: "no",
        reason: `Reverse image search identified "${named}" — not ${expected}.`,
        identifiedCommunity: named,
      };
    }
  }

  return {
    match: "no",
    reason: `Reverse image search could not confirm this photo belongs to ${expected}.`,
  };
}

function extractIdentifiedCommunityName(text: string): string | undefined {
  const keys = sharedResortPhraseKeys(text);
  if (keys.size > 0) return Array.from(keys)[0];
  const m = text.match(/\b(?:at|in)\s+([A-Z][A-Za-z0-9&'.,\s-]{4,60})/);
  return m?.[1]?.trim();
}
