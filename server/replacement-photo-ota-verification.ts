import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  agreementImageIdentityHolds,
  hammingDistance,
  THUMBNAIL_IDENTITY_DISTANCE,
} from "@shared/photo-hash-distance";
import { otaPlatformForUrl, type OtaPlatformKey } from "@shared/ota-host-match";
import sharp from "sharp";
import { isStrongLensMatch, lensMatchConfidence } from "./photo-match-guardrails";
import { fetchRemoteImage, type RemoteImage } from "./remote-image-fetch";
import { runWithSearchApiSlot } from "./searchapi-budget";

export const REPLACEMENT_PHOTO_OTA_POLICY = "all-proposed-photos-all-otas-v1";
export const REPLACEMENT_PHOTO_RECEIPT_TTL_MS = 2 * 60 * 60 * 1_000;
export const REPLACEMENT_PHOTO_MAX_URLS = 150;

const OTA_PLATFORMS: readonly OtaPlatformKey[] = ["airbnb", "vrbo", "booking"];
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_LENS_TIMEOUT_MS = 12_000;
const DEFAULT_IMAGE_TIMEOUT_MS = 12_000;
const DEFAULT_THUMBNAIL_TIMEOUT_MS = 8_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_LENS_ATTEMPTS = 2;
const MAX_MATCH_THUMBNAILS_PER_PLATFORM_PER_PHOTO = 6;
const SOURCE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const MATCH_THUMBNAIL_MAX_BYTES = 3 * 1024 * 1024;

export type ReplacementPhotoOtaStatus = "verified" | "matched" | "incomplete";

export type ReplacementPhotoOtaMatch = {
  platform: OtaPlatformKey;
  sourcePhotoUrl: string;
  listingUrl: string;
  matchImageUrl: string;
  confidence: number;
  perceptualDistance: number;
};

export type ReplacementPhotoOtaFailure = {
  photoUrl: string;
  stage: "source-image" | "lens" | "match-image" | "deadline";
  reason: string;
};

export type ReplacementPhotoEvidence = {
  url: string;
  contentSha256: string;
  perceptualHash: string;
  lensChecked: boolean;
};

export type ReplacementPhotoOtaVerification = {
  status: ReplacementPhotoOtaStatus;
  policy: typeof REPLACEMENT_PHOTO_OTA_POLICY;
  sourceUrl: string;
  totalPhotos: number;
  checkedPhotos: number;
  lensCalls: number;
  checkedAt: number;
  durationMs: number;
  platformsChecked: OtaPlatformKey[];
  photos: ReplacementPhotoEvidence[];
  matches: ReplacementPhotoOtaMatch[];
  failures: ReplacementPhotoOtaFailure[];
};

export type ReplacementPhotoReceiptClaims = {
  version: 1;
  policy: typeof REPLACEMENT_PHOTO_OTA_POLICY;
  sourceDigest: string;
  targetDigest: string;
  photoUrlDigest: string;
  photoContentDigest: string;
  photoCount: number;
  checkedAt: number;
  expiresAt: number;
};

export type ReplacementPhotoReceiptValidation =
  | { ok: true; claims: ReplacementPhotoReceiptClaims }
  | { ok: false; error: string };

type LensFetchResult =
  | { ok: true; data: any }
  | { ok: false; error: string; retryable: boolean };

type VerificationDependencies = {
  fetchImage?: (
    url: string,
    opts: { timeoutMs: number; minBytes: number; maxBytes: number },
  ) => Promise<RemoteImage | null>;
  fetchLens?: (photoUrl: string, attempt: number, timeoutMs: number) => Promise<LensFetchResult>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

type VerifyReplacementPhotoSetInput = {
  apiKey: string;
  sourceUrl: string;
  photoUrls: string[];
  concurrency?: number;
  lensTimeoutMs?: number;
  imageTimeoutMs?: number;
  thumbnailTimeoutMs?: number;
  overallTimeoutMs?: number;
  maxLensAttempts?: number;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function computePhotoDhash(buffer: Buffer): Promise<string> {
  const { data, info } = await sharp(buffer)
    .grayscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== 9 || info.height !== 8 || data.length !== 72) {
    throw new Error(`unexpected photo hash shape ${info.width}x${info.height}`);
  }
  let hex = "";
  for (let row = 0; row < 8; row += 1) {
    let byte = 0;
    for (let col = 0; col < 8; col += 1) {
      byte = (byte << 1) | (data[row * 9 + col] > data[row * 9 + col + 1] ? 1 : 0);
    }
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function stableSourceUrl(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  try {
    const url = new URL(trimmed);
    url.hash = "";
    return url.toString();
  } catch {
    return trimmed;
  }
}

function stablePhotoUrl(raw: string): string | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || url.username
      || url.password
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeReplacementPhotoUrls(photoUrls: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of photoUrls) {
    if (typeof raw !== "string") continue;
    const url = stablePhotoUrl(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    normalized.push(url);
    if (normalized.length >= REPLACEMENT_PHOTO_MAX_URLS) break;
  }
  return normalized;
}

function photoUrlDigest(photoUrls: readonly string[]): string {
  return sha256(JSON.stringify(photoUrls));
}

export function replacementPhotoContentDigest(
  photos: readonly Pick<ReplacementPhotoEvidence, "url" | "contentSha256">[],
): string {
  return sha256(JSON.stringify(photos.map((photo) => [photo.url, photo.contentSha256])));
}

function sourceDigest(sourceUrl: string): string {
  return sha256(stableSourceUrl(sourceUrl));
}

function targetDigest(propertyId: number, targetUnitId: string): string {
  return sha256(`${Math.trunc(propertyId)}:${String(targetUnitId ?? "").trim()}`);
}

function signingInput(payload: string): string {
  return Buffer.from(payload, "utf8").toString("base64url");
}

function signatureFor(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function safeEqual(first: string, second: string): boolean {
  const a = Buffer.from(first);
  const b = Buffer.from(second);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function replacementPhotoReceiptSigningKey(): string | null {
  const key = String(
    process.env.OTA_PHOTO_RECEIPT_SECRET
      || process.env.ADMIN_SECRET
      || process.env.SESSION_SECRET
      || "",
  ).trim();
  return key || null;
}

export function issueReplacementPhotoReceipt(args: {
  verification: ReplacementPhotoOtaVerification;
  secret: string;
  propertyId: number;
  targetUnitId: string;
  now?: number;
  ttlMs?: number;
}): { receipt: string; claims: ReplacementPhotoReceiptClaims } {
  if (args.verification.status !== "verified") {
    throw new Error("Only a complete, match-free photo verification can issue a receipt");
  }
  if (!Number.isFinite(args.propertyId) || !String(args.targetUnitId ?? "").trim()) {
    throw new Error("Photo verification receipt requires an exact property and target unit");
  }
  const normalized = normalizeReplacementPhotoUrls(args.verification.photos.map((photo) => photo.url));
  if (
    normalized.length === 0
    || normalized.length !== args.verification.totalPhotos
    || args.verification.photos.length !== args.verification.totalPhotos
  ) {
    throw new Error("Photo verification coverage is incomplete");
  }
  const now = args.now ?? Date.now();
  const claims: ReplacementPhotoReceiptClaims = {
    version: 1,
    policy: REPLACEMENT_PHOTO_OTA_POLICY,
    sourceDigest: sourceDigest(args.verification.sourceUrl),
    targetDigest: targetDigest(args.propertyId, args.targetUnitId),
    photoUrlDigest: photoUrlDigest(normalized),
    photoContentDigest: replacementPhotoContentDigest(args.verification.photos),
    photoCount: normalized.length,
    checkedAt: args.verification.checkedAt,
    expiresAt: now + Math.max(1_000, args.ttlMs ?? REPLACEMENT_PHOTO_RECEIPT_TTL_MS),
  };
  const encodedPayload = signingInput(JSON.stringify(claims));
  return {
    receipt: `${encodedPayload}.${signatureFor(encodedPayload, args.secret)}`,
    claims,
  };
}

export function validateReplacementPhotoReceipt(args: {
  receipt: string;
  secret: string;
  sourceUrl: string;
  propertyId: number;
  targetUnitId: string;
  photoUrls: string[];
  now?: number;
}): ReplacementPhotoReceiptValidation {
  const [encodedPayload, suppliedSignature, extra] = String(args.receipt ?? "").split(".");
  if (!encodedPayload || !suppliedSignature || extra !== undefined) {
    return { ok: false, error: "Photo verification receipt is malformed" };
  }
  const expectedSignature = signatureFor(encodedPayload, args.secret);
  if (!safeEqual(suppliedSignature, expectedSignature)) {
    return { ok: false, error: "Photo verification receipt signature is invalid" };
  }

  let claims: ReplacementPhotoReceiptClaims;
  try {
    claims = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "Photo verification receipt payload is invalid" };
  }
  if (
    claims?.version !== 1
    || claims?.policy !== REPLACEMENT_PHOTO_OTA_POLICY
    || !/^[a-f0-9]{64}$/.test(String(claims?.sourceDigest ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(claims?.targetDigest ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(claims?.photoUrlDigest ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(claims?.photoContentDigest ?? ""))
    || !Number.isFinite(claims?.checkedAt)
    || !Number.isFinite(claims?.expiresAt)
    || !Number.isInteger(claims?.photoCount)
    || claims.photoCount <= 0
  ) {
    return { ok: false, error: "Photo verification receipt policy is invalid" };
  }
  const now = args.now ?? Date.now();
  if (claims.expiresAt <= now) {
    return { ok: false, error: "Photo verification receipt expired; run the replacement search again" };
  }
  const normalized = normalizeReplacementPhotoUrls(args.photoUrls);
  if (claims.sourceDigest !== sourceDigest(args.sourceUrl)) {
    return { ok: false, error: "Replacement source changed after photo verification" };
  }
  if (claims.targetDigest !== targetDigest(args.propertyId, args.targetUnitId)) {
    return { ok: false, error: "Photo verification receipt belongs to a different property or unit" };
  }
  if (
    claims.photoCount !== normalized.length
    || claims.photoUrlDigest !== photoUrlDigest(normalized)
  ) {
    return { ok: false, error: "Replacement photo list changed after verification" };
  }
  return { ok: true, claims };
}

function rowsFrom(source: string, rows: any[] | undefined): Array<{ source: string; row: any; position: number }> {
  if (!Array.isArray(rows)) return [];
  return rows.map((row, index) => ({
    source,
    row,
    position: Number(row?.position ?? index + 1),
  }));
}

function lensRows(data: any): Array<{ source: string; row: any; position: number }> {
  return [
    ...rowsFrom("visual", data?.visual_matches),
    ...rowsFrom("page", data?.pages_with_matching_images),
    ...rowsFrom("image", data?.image_results),
    ...rowsFrom("organic", data?.organic_results),
  ];
}

function listingUrlFromLensRow(row: any): string {
  return String(
    row?.link
      || row?.url
      || row?.source_url
      || row?.source?.link
      || row?.source?.url
      || "",
  ).trim();
}

function matchImageUrlFromLensRow(row: any): string {
  return String(
    row?.thumbnail
      || row?.image
      || row?.image_url
      || row?.source?.thumbnail
      || row?.source?.image
      || "",
  ).trim();
}

async function defaultFetchLens(
  apiKey: string,
  photoUrl: string,
  timeoutMs: number,
): Promise<LensFetchResult> {
  return runWithSearchApiSlot(async () => {
    try {
      const response = await fetch(
        `https://www.searchapi.io/api/v1/search?engine=google_lens&url=${encodeURIComponent(photoUrl)}&api_key=${encodeURIComponent(apiKey)}`,
        { signal: AbortSignal.timeout(Math.max(1, timeoutMs)) },
      );
      if (!response.ok) {
        const body = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
        return {
          ok: false,
          error: `SearchAPI HTTP ${response.status}${body ? `: ${body}` : ""}`,
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        };
      }
      return { ok: true, data: await response.json() };
    } catch (error: any) {
      return {
        ok: false,
        error: error?.name === "TimeoutError" || error?.name === "AbortError"
          ? `Google Lens timed out after ${Math.round(timeoutMs / 1_000)}s`
          : `Google Lens request failed: ${error?.message ?? String(error)}`,
        retryable: true,
      };
    }
  });
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await worker(values[index], index);
    }
  });
  await Promise.all(runners);
  return output;
}

type PerPhotoResult = {
  evidence: ReplacementPhotoEvidence | null;
  lensCalls: number;
  matches: ReplacementPhotoOtaMatch[];
  failures: ReplacementPhotoOtaFailure[];
};

export async function verifyReplacementPhotoSet(
  input: VerifyReplacementPhotoSetInput,
  dependencies: VerificationDependencies = {},
): Promise<ReplacementPhotoOtaVerification> {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = dependencies.random ?? Math.random;
  const fetchImage = dependencies.fetchImage ?? fetchRemoteImage;
  const startedAt = now();
  const checkedAt = startedAt;
  const sourceUrl = stableSourceUrl(input.sourceUrl);
  const photoUrls = normalizeReplacementPhotoUrls(input.photoUrls);
  const overallTimeoutMs = Math.max(1_000, input.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS);
  const deadlineAt = startedAt + overallTimeoutMs;
  const lensTimeoutMs = Math.max(1_000, input.lensTimeoutMs ?? DEFAULT_LENS_TIMEOUT_MS);
  const imageTimeoutMs = Math.max(1_000, input.imageTimeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS);
  const thumbnailTimeoutMs = Math.max(1_000, input.thumbnailTimeoutMs ?? DEFAULT_THUMBNAIL_TIMEOUT_MS);
  const maxLensAttempts = Math.max(1, input.maxLensAttempts ?? DEFAULT_MAX_LENS_ATTEMPTS);
  const fetchLens = dependencies.fetchLens
    ?? ((photoUrl: string, _attempt: number, timeoutMs: number) =>
      defaultFetchLens(input.apiKey, photoUrl, timeoutMs));

  if (!input.apiKey.trim()) {
    return {
      status: "incomplete",
      policy: REPLACEMENT_PHOTO_OTA_POLICY,
      sourceUrl,
      totalPhotos: photoUrls.length,
      checkedPhotos: 0,
      lensCalls: 0,
      checkedAt,
      durationMs: Math.max(0, now() - startedAt),
      platformsChecked: [...OTA_PLATFORMS],
      photos: [],
      matches: [],
      failures: photoUrls.map((photoUrl) => ({
        photoUrl,
        stage: "lens",
        reason: "SEARCHAPI_API_KEY is not configured",
      })),
    };
  }
  if (photoUrls.length === 0) {
    return {
      status: "incomplete",
      policy: REPLACEMENT_PHOTO_OTA_POLICY,
      sourceUrl,
      totalPhotos: 0,
      checkedPhotos: 0,
      lensCalls: 0,
      checkedAt,
      durationMs: Math.max(0, now() - startedAt),
      platformsChecked: [...OTA_PLATFORMS],
      photos: [],
      matches: [],
      failures: [{
        photoUrl: "",
        stage: "source-image",
        reason: "No valid replacement photos were supplied",
      }],
    };
  }

  const results = await mapConcurrent(
    photoUrls,
    input.concurrency ?? DEFAULT_CONCURRENCY,
    async (photoUrl): Promise<PerPhotoResult> => {
      const failures: ReplacementPhotoOtaFailure[] = [];
      if (now() >= deadlineAt) {
        return {
          evidence: null,
          lensCalls: 0,
          matches: [],
          failures: [{ photoUrl, stage: "deadline", reason: "Photo verification deadline expired" }],
        };
      }

      const sourceImage = await fetchImage(photoUrl, {
        timeoutMs: Math.min(imageTimeoutMs, Math.max(1, deadlineAt - now())),
        minBytes: 1,
        maxBytes: SOURCE_IMAGE_MAX_BYTES,
      });
      if (!sourceImage) {
        return {
          evidence: null,
          lensCalls: 0,
          matches: [],
          failures: [{ photoUrl, stage: "source-image", reason: "Photo could not be downloaded and fingerprinted" }],
        };
      }

      let perceptualHash: string;
      try {
        perceptualHash = await computePhotoDhash(sourceImage.buffer);
      } catch {
        return {
          evidence: null,
          lensCalls: 0,
          matches: [],
          failures: [{ photoUrl, stage: "source-image", reason: "Photo fingerprint could not be computed" }],
        };
      }
      const contentSha256 = sha256(sourceImage.buffer);

      let lens: LensFetchResult | null = null;
      let lensCalls = 0;
      for (let attempt = 1; attempt <= maxLensAttempts; attempt += 1) {
        const remainingMs = deadlineAt - now();
        if (remainingMs <= 0) break;
        lensCalls += 1;
        lens = await fetchLens(photoUrl, attempt, Math.min(lensTimeoutMs, remainingMs));
        if (lens.ok || !lens.retryable || attempt >= maxLensAttempts) break;
        const backoffMs = Math.min(2_500, 350 * (2 ** (attempt - 1)) + Math.floor(random() * 250));
        if (now() + backoffMs >= deadlineAt) break;
        await sleep(backoffMs);
      }
      if (!lens?.ok) {
        return {
          evidence: null,
          lensCalls,
          matches: [],
          failures: [{
            photoUrl,
            stage: now() >= deadlineAt ? "deadline" : "lens",
            reason: lens && !lens.ok ? lens.error : "Photo verification deadline expired",
          }],
        };
      }

      const grouped = new Map<OtaPlatformKey, Array<{ row: any; source: string; position: number; confidence: number }>>();
      for (const candidate of lensRows(lens.data)) {
        if (!isStrongLensMatch(candidate.row, candidate.source, candidate.position)) continue;
        const listingUrl = listingUrlFromLensRow(candidate.row);
        const platform = otaPlatformForUrl(listingUrl);
        if (!platform || !OTA_PLATFORMS.includes(platform)) continue;
        const current = grouped.get(platform) ?? [];
        current.push({
          ...candidate,
          confidence: lensMatchConfidence(candidate.row, candidate.source, candidate.position),
        });
        grouped.set(platform, current);
      }

      const matches: ReplacementPhotoOtaMatch[] = [];
      for (const platform of OTA_PLATFORMS) {
        const allCandidates = (grouped.get(platform) ?? [])
          .sort((a, b) => b.confidence - a.confidence);
        const candidates = allCandidates.slice(0, MAX_MATCH_THUMBNAILS_PER_PLATFORM_PER_PHOTO);
        for (const candidate of candidates) {
          const listingUrl = listingUrlFromLensRow(candidate.row);
          const matchImageUrl = matchImageUrlFromLensRow(candidate.row);
          if (!matchImageUrl) {
            failures.push({
              photoUrl,
              stage: "match-image",
              reason: `Strong ${platform} result could not be identity-verified because it had no match image`,
            });
            continue;
          }
          const matchImage = await fetchImage(matchImageUrl, {
            timeoutMs: Math.min(thumbnailTimeoutMs, Math.max(1, deadlineAt - now())),
            minBytes: 1,
            maxBytes: MATCH_THUMBNAIL_MAX_BYTES,
          });
          if (!matchImage) {
            failures.push({
              photoUrl,
              stage: "match-image",
              reason: `Strong ${platform} result could not be identity-verified because its match image was unavailable`,
            });
            continue;
          }
          try {
            const matchHash = await computePhotoDhash(matchImage.buffer);
            const identity = agreementImageIdentityHolds(
              perceptualHash,
              matchHash,
              THUMBNAIL_IDENTITY_DISTANCE,
            );
            if (identity) {
              matches.push({
                platform,
                sourcePhotoUrl: photoUrl,
                listingUrl,
                matchImageUrl,
                confidence: candidate.confidence,
                perceptualDistance: hammingDistance(perceptualHash, matchHash),
              });
            }
          } catch {
            failures.push({
              photoUrl,
              stage: "match-image",
              reason: `Strong ${platform} result match image could not be fingerprinted`,
            });
          }
        }
        if (allCandidates.length > candidates.length) {
          failures.push({
            photoUrl,
            stage: "match-image",
            reason:
              `${allCandidates.length - candidates.length} additional strong ${platform} result` +
              `${allCandidates.length - candidates.length === 1 ? " was" : "s were"} not identity-verified within the bounded match-image budget`,
          });
        }
      }

      return {
        evidence: {
          url: photoUrl,
          contentSha256,
          perceptualHash,
          lensChecked: true,
        },
        lensCalls,
        matches,
        failures,
      };
    },
  );

  const photos = results.flatMap((result) => result.evidence ? [result.evidence] : []);
  const matches = results.flatMap((result) => result.matches);
  const failures = results.flatMap((result) => result.failures);
  const lensCalls = results.reduce((sum, result) => sum + result.lensCalls, 0);
  const checkedPhotos = photos.filter((photo) => photo.lensChecked).length;
  const status: ReplacementPhotoOtaStatus = matches.length > 0
    ? "matched"
    : failures.length > 0 || checkedPhotos !== photoUrls.length || photos.length !== photoUrls.length
      ? "incomplete"
      : "verified";

  return {
    status,
    policy: REPLACEMENT_PHOTO_OTA_POLICY,
    sourceUrl,
    totalPhotos: photoUrls.length,
    checkedPhotos,
    lensCalls,
    checkedAt,
    durationMs: Math.max(0, now() - startedAt),
    platformsChecked: [...OTA_PLATFORMS],
    photos,
    matches,
    failures,
  };
}

export function publicReplacementPhotoVerification(
  verification: ReplacementPhotoOtaVerification,
  expiresAt?: number,
): {
  status: ReplacementPhotoOtaStatus;
  checkedPhotos: number;
  totalPhotos: number;
  checkedAt: number;
  expiresAt?: number;
  platforms: string[];
} {
  return {
    status: verification.status,
    checkedPhotos: verification.checkedPhotos,
    totalPhotos: verification.totalPhotos,
    checkedAt: verification.checkedAt,
    expiresAt,
    platforms: ["Airbnb", "VRBO", "Booking.com"],
  };
}
