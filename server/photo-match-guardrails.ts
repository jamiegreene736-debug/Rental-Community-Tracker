export const STRONG_PHOTO_MATCH_THRESHOLD = 0.8;
export const MIN_DISTINCT_STRONG_PHOTO_MATCHES = 2;

const SHARED_PHOTO_FOLDER_WORDS = /\b(?:community|amenit(?:y|ies)|grounds?|resort|building|exterior|pool|spa|clubhouse|fitness|gym|lobby|parking|map|logo)\b/i;
const SHARED_PHOTO_CATEGORY_WORDS = /\b(?:building exterior|community|amenit(?:y|ies)|grounds?|resort|pool|spa|hot[ -]?tub|beach|ocean|aerial|drone|map|clubhouse|tennis|pickleball|bbq|grill|parking|garage|fitness|gym|lobby|front desk|logo|icon|sprite|avatar|profile|exterior)\b/i;

export function isCommunityOrSharedPhotoCandidate(input: {
  folder?: string | null;
  filename?: string | null;
  category?: string | null;
  label?: string | null;
  title?: string | null;
  source?: string | null;
  url?: string | null;
}): boolean {
  const folder = String(input.folder ?? "");
  if (SHARED_PHOTO_FOLDER_WORDS.test(folder)) return true;

  const category = String(input.category ?? "");
  if (SHARED_PHOTO_CATEGORY_WORDS.test(category)) return true;

  const text = [
    input.filename,
    input.label,
    input.title,
    input.source,
    input.url,
  ].filter(Boolean).join(" ");

  return SHARED_PHOTO_CATEGORY_WORDS.test(text);
}

function numericConfidence(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 1) return Math.max(0, value);
    if (value <= 100) return Math.max(0, Math.min(1, value / 100));
    return Math.max(0, Math.min(1, value / 1000));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const percent = trimmed.match(/^(\d+(?:\.\d+)?)\s*%$/);
    if (percent) return Math.max(0, Math.min(1, Number(percent[1]) / 100));
    const n = Number(trimmed);
    if (Number.isFinite(n)) return numericConfidence(n);
  }
  return null;
}

export function lensMatchConfidence(row: any, source = "", position = 999): number {
  const explicit = [
    row?.score,
    row?.confidence,
    row?.similarity,
    row?.image_similarity,
    row?.match_score,
    row?.thumbnail_score,
    row?.thumbnailScore,
  ].map(numericConfidence).find((v): v is number => v !== null);
  if (explicit !== undefined) return explicit;

  const src = String(source || row?.__lensSource || "").toLowerCase();
  const pos = Number.isFinite(position) ? position : Number(row?.position ?? row?.__lensPosition ?? 999);

  if (src === "known-source") return 1;
  if (src === "visual") {
    if (pos <= 1) return 0.92;
    if (pos <= 2) return 0.86;
    if (pos <= 3) return 0.8;
    if (pos <= 5) return 0.65;
    return 0.4;
  }
  if (src === "page" || src === "pages_with_matching_images") {
    if (pos <= 1) return 0.82;
    if (pos <= 2) return 0.74;
    return 0.55;
  }
  if (src === "image" || src === "image_results") {
    if (pos <= 1) return 0.74;
    return 0.5;
  }
  return 0.45;
}

export function isStrongLensMatch(row: any, source = "", position = 999): boolean {
  return lensMatchConfidence(row, source, position) >= STRONG_PHOTO_MATCH_THRESHOLD;
}
