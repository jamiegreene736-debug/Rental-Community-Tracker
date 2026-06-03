export const MIN_INDEPENDENT_UNIT_PHOTOS = 3;
export const UNIT_PHOTO_DUPLICATE_OVERLAP_RATIO = 0.8;

export type UnitPhotoResolverStatus = "accepted" | "review" | "rejected";

export type UnitPhotoResolverProof = {
  status: UnitPhotoResolverStatus;
  sourceUrl: string | null;
  sourceKey: string | null;
  foundVia: string | null;
  photoCount: number;
  distinctPhotoCount: number;
  photoFingerprints: string[];
  requestedBedrooms: number | null;
  minimumBedrooms: number | null;
  scrapedBedrooms: number | null;
  bedroomMatch: boolean | null;
  representativeFallback: boolean;
  reusedConfiguredSource: boolean;
  relaxedSearch: boolean;
  issues: string[];
  selfFix: string[];
};

export type UnitPhotoProofInput = {
  photos: Array<{ url?: string | null }>;
  sourceUrl?: string | null;
  foundVia?: string | null;
  requestedBedrooms?: number | null;
  minimumBedrooms?: number | null;
  facts?: { bedrooms?: number | null } | null;
  representativeFallback?: boolean;
  reusedConfiguredSource?: boolean;
  relaxedSearch?: boolean;
};

export type UnitPhotoProofComparison = {
  sameSource: boolean;
  overlapCount: number;
  overlapRatio: number;
  duplicate: boolean;
  issues: string[];
};

const positiveIntegerOrNull = (value: unknown): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : null;
};

export function canonicalListingKey(raw: string | null | undefined): string | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    const path = url.pathname.replace(/\/+$/, "").toLowerCase();
    return `${host}${path}`;
  } catch {
    const key = trimmed.toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
    return key || null;
  }
}

export function photoUrlFingerprint(raw: string | null | undefined): string | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    const path = decodeURIComponent(url.pathname).replace(/\/+$/, "").toLowerCase();
    const zillowFp = path.match(/\/fp\/([^/?#-]{8,})/i)?.[1];
    if (zillowFp) return `zillow-fp:${zillowFp.toLowerCase()}`;
    return `${host}${path}`;
  } catch {
    const key = trimmed.toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
    return key || null;
  }
}

export function buildUnitPhotoResolverProof(input: UnitPhotoProofInput): UnitPhotoResolverProof {
  const photos = Array.isArray(input.photos) ? input.photos : [];
  const fingerprints = Array.from(new Set(
    photos
      .map((photo) => photoUrlFingerprint(photo?.url))
      .filter((fingerprint): fingerprint is string => !!fingerprint),
  ));
  const sourceUrl = typeof input.sourceUrl === "string" && input.sourceUrl.trim() ? input.sourceUrl.trim() : null;
  const sourceKey = canonicalListingKey(sourceUrl);
  const requestedBedrooms = positiveIntegerOrNull(input.requestedBedrooms);
  const minimumBedrooms = positiveIntegerOrNull(input.minimumBedrooms);
  const scrapedBedrooms = positiveIntegerOrNull(input.facts?.bedrooms);
  const representativeFallback = input.representativeFallback === true;
  const reusedConfiguredSource = input.reusedConfiguredSource === true;
  const relaxedSearch = input.relaxedSearch === true;
  const bedroomMatch = requestedBedrooms && scrapedBedrooms
    ? scrapedBedrooms === requestedBedrooms
    : !requestedBedrooms && minimumBedrooms && scrapedBedrooms
      ? scrapedBedrooms >= minimumBedrooms
      : null;

  const issues: string[] = [];
  const selfFix: string[] = [];
  if (!sourceKey) {
    issues.push("missing-source-url");
    selfFix.push("retry discovery with broader Zillow/Realtor/Redfin/Homes candidates or require a manual source URL");
  }
  if (photos.length === 0) {
    issues.push("no-photos");
    selfFix.push("continue candidate search; do not persist an empty gallery");
  }
  if (fingerprints.length < MIN_INDEPENDENT_UNIT_PHOTOS) {
    issues.push(`too-few-distinct-photos:${fingerprints.length}`);
    selfFix.push(`continue search until at least ${MIN_INDEPENDENT_UNIT_PHOTOS} distinct unit photos are available`);
  }
  if (bedroomMatch === false && !representativeFallback && !relaxedSearch) {
    issues.push(`bedroom-mismatch:${scrapedBedrooms}-vs-${requestedBedrooms ?? minimumBedrooms}`);
    selfFix.push("reject this candidate and continue with the next same-community listing");
  }
  if (bedroomMatch === false && (representativeFallback || relaxedSearch)) {
    issues.push(`representative-bedroom-mismatch:${scrapedBedrooms}-vs-${requestedBedrooms ?? minimumBedrooms}`);
    selfFix.push("mark the gallery for review because it is representative rather than exact unit proof");
  }

  const hardRejected = issues.some((issue) =>
    issue === "missing-source-url" ||
    issue === "no-photos" ||
    issue.startsWith("too-few-distinct-photos:") ||
    issue.startsWith("bedroom-mismatch:"),
  );
  const status: UnitPhotoResolverStatus = hardRejected
    ? "rejected"
    : representativeFallback || reusedConfiguredSource || relaxedSearch || issues.length > 0
      ? "review"
      : "accepted";

  return {
    status,
    sourceUrl,
    sourceKey,
    foundVia: input.foundVia ?? null,
    photoCount: photos.length,
    distinctPhotoCount: fingerprints.length,
    photoFingerprints: fingerprints,
    requestedBedrooms,
    minimumBedrooms,
    scrapedBedrooms,
    bedroomMatch,
    representativeFallback,
    reusedConfiguredSource,
    relaxedSearch,
    issues,
    selfFix: Array.from(new Set(selfFix)),
  };
}

export function compareUnitPhotoProofs(
  first: UnitPhotoResolverProof,
  second: UnitPhotoResolverProof,
): UnitPhotoProofComparison {
  const sameSource = !!first.sourceKey && !!second.sourceKey && first.sourceKey === second.sourceKey;
  const firstSet = new Set(first.photoFingerprints);
  const overlapCount = second.photoFingerprints.filter((fingerprint) => firstSet.has(fingerprint)).length;
  const denominator = Math.min(first.distinctPhotoCount, second.distinctPhotoCount);
  const overlapRatio = denominator > 0 ? overlapCount / denominator : 0;
  const duplicate = sameSource || (
    denominator >= MIN_INDEPENDENT_UNIT_PHOTOS &&
    overlapRatio >= UNIT_PHOTO_DUPLICATE_OVERLAP_RATIO
  );
  const issues: string[] = [];
  if (sameSource) issues.push("same-source-url");
  if (!sameSource && duplicate) issues.push(`duplicate-photo-overlap:${overlapCount}/${denominator}`);
  return { sameSource, overlapCount, overlapRatio, duplicate, issues };
}

export function summarizeUnitPhotoProof(label: string, proof: UnitPhotoResolverProof): string {
  if (proof.status !== "rejected" && proof.issues.length === 0) {
    return `${label}: ${proof.distinctPhotoCount} distinct photos from ${proof.sourceUrl ?? "unknown source"}`;
  }
  const issueText = proof.issues.length > 0 ? proof.issues.join(", ") : proof.status;
  const fixText = proof.selfFix.length > 0 ? ` Self-fix: ${proof.selfFix.join("; ")}.` : "";
  return `${label}: ${issueText}.${fixText}`;
}
