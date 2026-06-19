// Multi-signal community photo verification — Lens + caption + Claude vision.
//
// A single failed reverse-image search no longer hard-fails a photo. Vision runs
// on inconclusive Lens results to recover legitimate resort photos that are not
// well indexed online.

import {
  classifyCommunityPhotoFromLens,
  type LensEvidenceRow,
} from "../shared/community-photo-lens-logic";
import {
  verifyCommunityPhotosFromInputs,
  type CommunityFolderVerification,
  type CommunityPhotoPerPhotoInput,
  type LensClassification,
} from "../shared/community-photo-verify-logic";
import { resolveCuratedCommunityDescription } from "./community-descriptions";
import { communityAddressRuleForName } from "../shared/community-addresses";
import {
  auditCommunityFolderViaLens,
  callGoogleLensInternal,
  lensImageUrlForFile,
  type CommunityLensSample,
} from "./community-photo-lens-check";
import type { CommunityGroupResult, PhotoVerdict } from "./photo-community-check";

export type CommunityPhotoSample = CommunityLensSample & {
  buffer?: Buffer;
  mime?: string;
};

const VISION_MODEL = "claude-sonnet-4-6";
const VISION_BATCH_SIZE = 4;
const VISION_TIMEOUT_MS = 90_000;

type VisionBatchRow = { id: string; confidence: number; reason: string };

async function visionConfidenceBatch(
  apiKey: string,
  expectedCommunity: string,
  communityDescription: string,
  batch: Array<{ id: string; buffer: Buffer; mime: string; caption?: string }>,
): Promise<VisionBatchRow[]> {
  if (!apiKey || batch.length === 0) return [];
  const content: any[] = [
    {
      type: "text",
      text: [
        `You verify whether each photo belongs to the community/resort: "${expectedCommunity}".`,
        communityDescription ? `Known description: ${communityDescription}` : "",
        "",
        "For EACH photo below, estimate how likely (0-100) the image depicts THIS specific community.",
        "Use architecture, signage, landscaping, pool/golf/clubhouse style, and geographic cues.",
        "Generic resort pool shots with no identifying features → 45-60 (neutral).",
        "Clear signage or unique features naming a DIFFERENT resort → 0-20.",
        "",
        "Respond with ONLY minified JSON:",
        '{"photos":[{"id":"C1","confidence":85,"reason":"short"}]}',
      ].join("\n"),
    },
  ];
  for (const row of batch) {
    const cap = row.caption ? ` caption="${row.caption}"` : "";
    content.push({ type: "text", text: `--- PHOTO ${row.id}${cap} ---` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: row.mime, data: row.buffer.toString("base64") },
    });
  }

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content }],
    }),
    signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Vision batch failed (${resp.status}): ${body.slice(0, 200)}`);
  }
  const data = await resp.json() as any;
  const text: string = data?.content?.[0]?.text ?? "";
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return [];
  const parsed = JSON.parse(match[0]) as { photos?: VisionBatchRow[] };
  if (!Array.isArray(parsed.photos)) return [];
  return parsed.photos
    .filter((p) => p?.id)
    .map((p) => ({
      id: String(p.id),
      confidence: Math.max(0, Math.min(100, Number(p.confidence) || 0)),
      reason: String(p.reason ?? "").trim() || "Visual analysis",
    }));
}

/** Primary entry: multi-signal community folder verification. */
export async function verifyCommunityPhotos(
  samples: CommunityPhotoSample[],
  photosTotal: number,
  expectedCommunity: string,
  groupMeta: { label: string; folder: string },
  options: {
    searchApiKey?: string;
    anthropicApiKey?: string;
    onProgress?: (checked: number, total: number) => void;
  } = {},
): Promise<{ community: CommunityGroupResult | null; warning?: string; verification?: CommunityFolderVerification }> {
  const searchApiKey = options.searchApiKey ?? "";
  if (!searchApiKey) {
    return { community: null, warning: "SEARCHAPI_API_KEY not configured" };
  }

  const rule = communityAddressRuleForName(expectedCommunity);
  const city = rule?.city ?? "";
  const communityDescription = resolveCuratedCommunityDescription(expectedCommunity) ?? "";

  const perPhotoInputs: Array<CommunityPhotoPerPhotoInput & { expectedCommunity: string; buffer?: Buffer; mime?: string }> = [];
  let lensFailures = 0;
  let checked = 0;

  for (const sample of samples) {
    const imageUrl = await lensImageUrlForFile(sample.folder, sample.filename);
    let lens: LensClassification = "inconclusive";
    let lensReason = "Could not run reverse image search.";
    let lensIdentified: string | undefined;

    if (!imageUrl) {
      lensReason = "Could not build a public photo URL for reverse image search.";
      lensFailures++;
    } else {
      const lensCall = await callGoogleLensInternal(imageUrl, searchApiKey);
      checked++;
      options.onProgress?.(checked, samples.length);
      if (!lensCall.ok) {
        lensFailures++;
        lensReason = lensCall.error;
      } else {
        const classified = classifyCommunityPhotoFromLens(
          expectedCommunity,
          lensCall.rows,
          lensCall.extraTexts,
          city,
        );
        lens = classified.outcome;
        lensReason = classified.reason;
        lensIdentified = classified.identifiedCommunity;
      }
    }

    perPhotoInputs.push({
      id: sample.id,
      caption: sample.caption,
      filename: sample.filename,
      expectedCommunity,
      lens,
      lensReason,
      lensIdentifiedCommunity: lensIdentified,
      buffer: sample.buffer,
      mime: sample.mime,
    });
  }

  // Vision on inconclusive photos (Lens failure ≠ mismatch).
  const needVision = perPhotoInputs.filter(
    (p) => p.lens === "inconclusive" && p.buffer && p.mime,
  );
  if (options.anthropicApiKey && needVision.length > 0) {
    for (let i = 0; i < needVision.length; i += VISION_BATCH_SIZE) {
      const batch = needVision.slice(i, i + VISION_BATCH_SIZE).map((p) => ({
        id: p.id,
        buffer: p.buffer!,
        mime: p.mime!,
        caption: p.caption,
      }));
      try {
        const rows = await visionConfidenceBatch(
          options.anthropicApiKey,
          expectedCommunity,
          communityDescription,
          batch,
        );
        for (const row of rows) {
          const target = perPhotoInputs.find((p) => p.id === row.id);
          if (target) {
            target.visionConfidence = row.confidence;
            target.visionReason = row.reason;
          }
        }
      } catch (e: any) {
        // Vision is best-effort — inconclusive Lens results stay unconfirmed.
        const msg = e?.message ?? String(e);
        for (const p of batch) {
          const target = perPhotoInputs.find((x) => x.id === p.id);
          if (target && target.lens === "inconclusive") {
            target.visionReason = `Vision unavailable: ${msg}`;
          }
        }
      }
    }
  }

  const verification = verifyCommunityPhotosFromInputs(
    perPhotoInputs.map(({ buffer: _b, mime: _m, ...rest }) => rest),
    expectedCommunity,
    communityDescription,
  );

  const photoVerdicts: PhotoVerdict[] = verification.photoResults.map((p) => ({
    id: p.id,
    folder: groupMeta.folder,
    filename: samples.find((s) => s.id === p.id)?.filename,
    caption: samples.find((s) => s.id === p.id)?.caption,
    match: p.match,
    reason: p.reason,
    lensIdentifiedCommunity: p.lensIdentifiedCommunity,
    status: p.status,
    confidenceScore: p.confidenceScore,
    signals: p.signals,
  }));

  const mismatchCount = verification.counts.mismatch;
  const outliers = verification.photoResults
    .filter((p) => p.status === "mismatch")
    .map((p) => ({
      id: p.id,
      caption: samples.find((s) => s.id === p.id)?.caption,
      reason: p.reason,
    }));

  const matchesExpected =
    verification.overallStatus === "mismatch" ? "no" as const
    : verification.overallStatus === "verified" || verification.overallStatus === "likely" ? "yes" as const
    : "yes" as const;

  const allSameCommunity = mismatchCount === 0;

  let warning: string | undefined;
  if (lensFailures > 0 && verification.overallStatus !== "mismatch") {
    warning = `${lensFailures} photo(s) had no reverse-image confirmation; used visual/caption signals instead.`;
  }

  const matchReason =
    verification.overallStatus === "mismatch"
      ? `${mismatchCount} community photo(s) appear to be from a different place.`
      : verification.overallStatus === "unconfirmed"
      ? verification.recommendation
      : verification.overallStatus === "likely"
      ? verification.recommendation
      : `All ${photoVerdicts.length} community photos verified for ${expectedCommunity}.`;

  return {
    community: {
      role: "community",
      label: groupMeta.label,
      folder: groupMeta.folder,
      photosChecked: photoVerdicts.length,
      photosTotal,
      communityFingerprint: `Multi-signal verification for ${expectedCommunity}`,
      identifiedCommunity: expectedCommunity,
      matchesExpected,
      matchReason,
      allSameCommunity,
      photoVerdicts,
      outliers,
      junk: [],
      confidence: verification.confidenceScore / 100,
      verificationMethod: "google_lens+vision",
      overallStatus: verification.overallStatus,
      confidenceScore: verification.confidenceScore,
      recommendation: verification.recommendation,
      signals: verification.signals,
    },
    warning,
    verification,
  };
}

// Re-export legacy Lens-only path for callers that need it unchanged.
export { auditCommunityFolderViaLens };
