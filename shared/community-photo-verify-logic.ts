// Multi-signal community photo verification — pure logic (no API/vision deps).
//
// Reverse image search is ONE signal among several. A failed or inconclusive Lens
// result must not alone mark a photo as a mismatch; vision + caption/keyword checks
// provide the deciding evidence.

import { communityNamesMatch, normalizeCommunityName } from "./photo-community-check-logic";
import { sharedResortPhraseKeys } from "./city-vrbo-combo";

export type CommunityPhotoOverallStatus = "verified" | "likely" | "unconfirmed" | "mismatch";

export type CommunityPhotoSignalResult = "support" | "neutral" | "contradict";

export type CommunityPhotoSignal = {
  name: string;
  result: CommunityPhotoSignalResult;
  weight: number;
  detail: string;
};

export type LensClassification =
  | "confirmed"
  | "contradicted"
  | "generic_amenity"
  | "inconclusive";

export type CommunityPhotoPerPhotoInput = {
  id: string;
  caption?: string;
  filename?: string;
  expectedCommunity?: string;
  lens: LensClassification;
  lensReason?: string;
  lensIdentifiedCommunity?: string;
  visionConfidence?: number | null;
  visionReason?: string;
};

export type CommunityPhotoPerPhotoResult = {
  id: string;
  status: CommunityPhotoOverallStatus;
  confidenceScore: number;
  signals: CommunityPhotoSignal[];
  reason: string;
  /** Back-compat for tiles that still use yes/no/uncertain badges. */
  match: "yes" | "no" | "uncertain";
  lensIdentifiedCommunity?: string;
};

export type CommunityFolderVerification = {
  overallStatus: CommunityPhotoOverallStatus;
  confidenceScore: number;
  signals: CommunityPhotoSignal[];
  recommendation: string;
  photoResults: CommunityPhotoPerPhotoResult[];
  /** Counts for UI roll-ups */
  counts: Record<CommunityPhotoOverallStatus, number>;
};

const STOP_WORDS = new Set([
  "the", "and", "at", "in", "of", "a", "an", "club", "country", "golf", "resort",
  "condominiums", "condo", "condos", "community", "villas", "villa",
]);

function distinctiveTokens(name: string): string[] {
  return normalizeCommunityName(name)
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/** Caption / filename keyword overlap with the expected community name. */
export function analyzeCaptionForCommunity(
  expectedCommunity: string,
  caption?: string,
  filename?: string,
): CommunityPhotoSignal {
  const expected = expectedCommunity.trim();
  const hay = `${caption ?? ""} ${filename ?? ""}`.trim();
  if (!expected || !hay) {
    return { name: "caption", result: "neutral", weight: 0.12, detail: "No caption or filename text to analyze." };
  }
  const hayNorm = hay.toLowerCase();
  const tokens = distinctiveTokens(expected);
  if (tokens.length === 0) {
    return { name: "caption", result: "neutral", weight: 0.12, detail: "Community name too generic for caption matching." };
  }
  const hits = tokens.filter((t) => hayNorm.includes(t));
  if (hits.length >= Math.min(2, tokens.length) || (tokens.length === 1 && hits.length === 1)) {
    return {
      name: "caption",
      result: "support",
      weight: 0.22,
      detail: `Caption/filename mentions ${expected} (${hits.join(", ")}).`,
    };
  }
  if (hits.length === 1) {
    return {
      name: "caption",
      result: "support",
      weight: 0.14,
      detail: `Caption/filename partially matches ${expected} (“${hits[0]}”).`,
    };
  }
  // Named a different resort in caption?
  const keys = sharedResortPhraseKeys(hay);
  if (keys.size > 0) {
    const named = Array.from(keys)[0];
    if (named && !communityNamesMatch(named, expected)) {
      return {
        name: "caption",
        result: "contradict",
        weight: 0.35,
        detail: `Caption/filename references “${named}”, not ${expected}.`,
      };
    }
  }
  return { name: "caption", result: "neutral", weight: 0.12, detail: "No community keywords in caption or filename." };
}

export function lensSignalFromClassification(
  classification: LensClassification,
  reason: string,
  identifiedCommunity?: string,
): CommunityPhotoSignal {
  switch (classification) {
    case "confirmed":
      return { name: "reverse_image", result: "support", weight: 0.35, detail: reason || "Reverse image search confirmed the community." };
    case "generic_amenity":
      return { name: "reverse_image", result: "support", weight: 0.15, detail: reason || "Generic resort amenity — no conflicting community in search results." };
    case "contradicted":
      return {
        name: "reverse_image",
        result: "contradict",
        weight: 0.5,
        detail: reason || `Reverse image search identified a different community${identifiedCommunity ? ` (${identifiedCommunity})` : ""}.`,
      };
    default:
      return {
        name: "reverse_image",
        result: "neutral",
        weight: 0.08,
        detail: reason || "Reverse image search could not confirm this photo online (not indexed).",
      };
  }
}

export function visionSignalFromConfidence(
  confidence: number | null | undefined,
  reason?: string,
): CommunityPhotoSignal | null {
  if (confidence == null || !Number.isFinite(confidence)) return null;
  const c = Math.max(0, Math.min(100, confidence));
  if (c >= 78) {
    return { name: "vision", result: "support", weight: 0.45, detail: reason || `Visual analysis ${c}% confident this is the expected community.` };
  }
  if (c >= 55) {
    return { name: "vision", result: "support", weight: 0.28, detail: reason || `Visual analysis ${c}% — plausibly the expected community.` };
  }
  if (c <= 25) {
    return { name: "vision", result: "contradict", weight: 0.42, detail: reason || `Visual analysis ${c}% — likely a different place.` };
  }
  return { name: "vision", result: "neutral", weight: 0.18, detail: reason || `Visual analysis ${c}% — inconclusive.` };
}

function signalScore(signals: CommunityPhotoSignal[]): { support: number; contradict: number } {
  let support = 0;
  let contradict = 0;
  for (const s of signals) {
    if (s.result === "support") support += s.weight;
    else if (s.result === "contradict") contradict += s.weight;
  }
  return { support, contradict };
}

/** Combine per-photo signals into a single photo status + confidence. */
export function synthesizePerPhotoVerdict(input: CommunityPhotoPerPhotoInput): CommunityPhotoPerPhotoResult {
  const signals: CommunityPhotoSignal[] = [
    lensSignalFromClassification(input.lens, input.lensReason ?? "", input.lensIdentifiedCommunity),
    analyzeCaptionForCommunity(input.expectedCommunity ?? "", input.caption, input.filename),
  ].filter(Boolean) as CommunityPhotoSignal[];

  const visionSig = visionSignalFromConfidence(input.visionConfidence, input.visionReason);
  if (visionSig) signals.push(visionSig);

  const { support, contradict } = signalScore(signals);
  let status: CommunityPhotoOverallStatus;
  let reason: string;

  const strongContradict = signals.some((s) => s.result === "contradict" && s.weight >= 0.4);
  if (strongContradict && contradict >= 0.45) {
    status = "mismatch";
    reason = signals.find((s) => s.result === "contradict")?.detail ?? "Multiple signals indicate the wrong community.";
  } else if (support >= 0.55 && contradict < 0.25) {
    status = "verified";
    reason = signals.filter((s) => s.result === "support").map((s) => s.detail).slice(0, 2).join(" ");
  } else if (support >= 0.35 && contradict < 0.35) {
    status = "likely";
    reason = "Most signals agree this photo belongs to the expected community.";
  } else if (contradict >= 0.35 && support < 0.25) {
    status = "mismatch";
    reason = signals.find((s) => s.result === "contradict")?.detail ?? "Signals point to a different community.";
  } else {
    status = "unconfirmed";
    reason = "Reverse image search did not confirm this photo, but nothing strongly contradicts the expected community.";
  }

  const confidenceScore = Math.round(
    Math.max(0, Math.min(100, 50 + (support - contradict) * 80 + (status === "verified" ? 15 : status === "mismatch" ? -25 : 0))),
  );

  const match: "yes" | "no" | "uncertain" =
    status === "verified" || status === "likely" ? "yes"
    : status === "mismatch" ? "no"
    : "uncertain";

  return {
    id: input.id,
    status,
    confidenceScore,
    signals,
    reason,
    match,
    lensIdentifiedCommunity: input.lensIdentifiedCommunity,
  };
}

/** Aggregate per-photo results into folder-level status. Requires expectedCommunity on each input. */
export function verifyCommunityPhotosFromInputs(
  inputs: Array<CommunityPhotoPerPhotoInput & { expectedCommunity: string }>,
  expectedCommunity: string,
  communityDescription?: string,
): CommunityFolderVerification {
  const photoResults = inputs.map((row) =>
    synthesizePerPhotoVerdict({ ...row, expectedCommunity: row.expectedCommunity || expectedCommunity }),
  );

  const counts: Record<CommunityPhotoOverallStatus, number> = {
    verified: 0,
    likely: 0,
    unconfirmed: 0,
    mismatch: 0,
  };
  for (const p of photoResults) counts[p.status] += 1;

  const total = photoResults.length;
  const mismatchRatio = total > 0 ? counts.mismatch / total : 0;
  const positiveRatio = total > 0 ? (counts.verified + counts.likely) / total : 0;
  const unconfirmedRatio = total > 0 ? counts.unconfirmed / total : 0;

  let overallStatus: CommunityPhotoOverallStatus;
  let recommendation: string;

  if (counts.mismatch > 0 && (mismatchRatio >= 0.34 || counts.mismatch >= 2)) {
    overallStatus = "mismatch";
    recommendation = `${counts.mismatch} of ${total} community photo(s) show strong evidence of a different place — review flagged tiles.`;
  } else if (counts.mismatch === 1 && counts.verified + counts.likely === 0) {
    overallStatus = "mismatch";
    recommendation = "One photo strongly appears to be from a different community.";
  } else if (positiveRatio >= 0.7 && counts.mismatch === 0) {
    overallStatus = "verified";
    recommendation = `Strong confirmation: ${counts.verified + counts.likely}/${total} photos match ${expectedCommunity}.`;
  } else if (positiveRatio >= 0.45 && counts.mismatch === 0) {
    overallStatus = "likely";
    recommendation = `Most photos appear consistent with ${expectedCommunity}; ${counts.unconfirmed} could not be confirmed online.`;
  } else if (unconfirmedRatio >= 0.5 && counts.mismatch === 0) {
    overallStatus = "unconfirmed";
    recommendation =
      `Reverse image search could not confirm these photos, but visual analysis suggests they are consistent with ${expectedCommunity}. Manual review recommended.`;
  } else if (counts.mismatch > 0) {
    overallStatus = "likely";
    recommendation = `One possible mismatch among ${total} photos — majority of signals still agree with ${expectedCommunity}.`;
  } else {
    overallStatus = "unconfirmed";
    recommendation = `Unable to fully confirm online; no strong contradictions found for ${expectedCommunity}.`;
  }

  if (communityDescription?.trim()) {
    const descSnippet = communityDescription.trim().slice(0, 120);
    if (overallStatus === "unconfirmed" || overallStatus === "likely") {
      recommendation += ` Expected amenities include: ${descSnippet}${communityDescription.length > 120 ? "…" : ""}`;
    }
  }

  const folderSignals: CommunityPhotoSignal[] = [
    {
      name: "aggregate",
      result: overallStatus === "mismatch" ? "contradict" : overallStatus === "verified" ? "support" : "neutral",
      weight: 0.5,
      detail: `${counts.verified} verified, ${counts.likely} likely, ${counts.unconfirmed} unconfirmed, ${counts.mismatch} mismatch.`,
    },
  ];

  const confidenceScore = Math.round(
    total > 0
      ? photoResults.reduce((s, p) => s + p.confidenceScore, 0) / total
      : 0,
  );

  return {
    overallStatus,
    confidenceScore,
    signals: folderSignals,
    recommendation,
    photoResults,
    counts,
  };
}

export function overallStatusToVerdict(
  status: CommunityPhotoOverallStatus,
): "pass" | "warn" | "fail" {
  if (status === "mismatch") return "fail";
  if (status === "unconfirmed") return "warn";
  return "pass";
}

export function photoStatusMatchLegacy(status: CommunityPhotoOverallStatus): "yes" | "no" {
  return status === "mismatch" ? "no" : "yes";
}
