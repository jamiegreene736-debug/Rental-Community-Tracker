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
  const candidates: PreflightSearchResult[] = [
    ...ordered.slice(0, 12).map(toSearchResult),
    ...extraTexts.filter(Boolean).map((text) => ({ title: text, snippet: "", link: "" })),
  ];

  if (candidates.length === 0) {
    return {
      match: "no",
      reason: "Reverse image search returned no usable matches to verify this photo.",
    };
  }

  const conflicts: Array<{ reason: string; text: string }> = [];
  const evidence: Array<{ text: string }> = [];

  for (const result of candidates) {
    const hay = haystackFromResult(result);
    if (!hay.trim()) continue;

    const siblingConflict = communityPhotoSiblingConflict(hay, expected);
    if (siblingConflict) {
      conflicts.push({ reason: siblingConflict.reason, text: hay });
      continue;
    }

    const conflict = communityConflictsWithResult(result, expected);
    if (conflict) {
      conflicts.push({ reason: conflict, text: hay });
      continue;
    }
    if (communityHaystackSupportsExpected(hay, expected)) {
      evidence.push({ text: hay });
    }
  }

  // Strongest signal: a top visual match names a different resort.
  if (conflicts.length > 0) {
    const top = conflicts[0];
    const identified = extractIdentifiedCommunityName(top.text);
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

  // Generic amenity hits (pool/lounge) with no resort name are OK for community folders.
  const allGeneric = candidates.every((r) => lensHaystackIsGenericAmenity(haystackFromResult(r)));
  if (allGeneric) {
    return {
      match: "yes",
      reason: "Generic resort amenity — no conflicting community identified in search results.",
      identifiedCommunity: expected,
    };
  }

  // Named a community in results but not ours — treat as mismatch.
  for (const result of candidates.slice(0, 5)) {
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
