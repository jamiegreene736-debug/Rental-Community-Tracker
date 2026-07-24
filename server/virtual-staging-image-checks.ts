import sharp from "sharp";

import {
  type VirtualStagingManifestTarget,
  type VirtualStagingNormalizedRegion,
  type VirtualStagingSourceManifest,
} from "@shared/virtual-staging";
import { hammingDistance, HASH_BITS } from "@shared/photo-hash-distance";
import { VirtualStagingViewpointRejectedError } from "./virtual-staging-viewpoint-verifier";

const REGION_COMPARE_SIZE = 96;
const REGION_DHASH_DISTANCE_FLOOR = 3;
const REGION_MEAN_PIXEL_DELTA_FLOOR = 7;
const EDGE_THRESHOLD = 18;
const MIN_SOURCE_EDGE_DENSITY = 0.005;
const MIN_EDGE_DENSITY_RATIO = 0.25;
const MAX_EDGE_DENSITY_RATIO = 4;

type PreparedImage = {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
};

async function prepareImage(buffer: Buffer): Promise<PreparedImage> {
  const { data, info } = await sharp(buffer, { failOn: "error" })
    .rotate()
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data,
    width: info.width,
    height: info.height,
    channels: info.channels,
  };
}

function pixelRegion(
  image: PreparedImage,
  region: VirtualStagingNormalizedRegion,
): { left: number; top: number; width: number; height: number } {
  const left = Math.min(image.width - 1, Math.max(0, Math.floor(region.x * image.width)));
  const top = Math.min(image.height - 1, Math.max(0, Math.floor(region.y * image.height)));
  const right = Math.min(
    image.width,
    Math.max(left + 1, Math.ceil((region.x + region.width) * image.width)),
  );
  const bottom = Math.min(
    image.height,
    Math.max(top + 1, Math.ceil((region.y + region.height) * image.height)),
  );
  return { left, top, width: right - left, height: bottom - top };
}

async function normalizedRegionPixels(
  buffer: Buffer,
  image: PreparedImage,
  region: VirtualStagingNormalizedRegion,
): Promise<Buffer> {
  return sharp(buffer, { failOn: "error" })
    .rotate()
    .extract(pixelRegion(image, region))
    .removeAlpha()
    .toColourspace("srgb")
    .resize(REGION_COMPARE_SIZE, REGION_COMPARE_SIZE, { fit: "fill" })
    .raw()
    .toBuffer();
}

async function regionDhash(pixels: Buffer): Promise<string> {
  const { data, info } = await sharp(pixels, {
    raw: { width: REGION_COMPARE_SIZE, height: REGION_COMPARE_SIZE, channels: 3 },
  })
    .grayscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== 9 || info.height !== 8 || data.length !== 72) {
    throw new Error("Virtual-staging target region could not be compared");
  }
  let hex = "";
  for (let bitOffset = 0; bitOffset < HASH_BITS; bitOffset += 8) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      const index = bitOffset + bit;
      const row = Math.floor(index / 8);
      const column = index % 8;
      if (data[row * 9 + column] > data[row * 9 + column + 1]) {
        byte |= 1 << (7 - bit);
      }
    }
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function meanPixelDelta(source: Buffer, generated: Buffer): number {
  if (source.length !== generated.length || source.length === 0) return Number.POSITIVE_INFINITY;
  let total = 0;
  for (let index = 0; index < source.length; index += 1) {
    total += Math.abs(source[index] - generated[index]);
  }
  return total / source.length;
}

function edgeDensity(pixels: Buffer): number {
  let edges = 0;
  let comparisons = 0;
  const channels = 3;
  const stride = REGION_COMPARE_SIZE * channels;
  const luminance = (offset: number): number =>
    (pixels[offset] * 0.299) + (pixels[offset + 1] * 0.587) + (pixels[offset + 2] * 0.114);
  for (let y = 0; y < REGION_COMPARE_SIZE; y += 1) {
    for (let x = 0; x < REGION_COMPARE_SIZE; x += 1) {
      const offset = (y * stride) + (x * channels);
      const current = luminance(offset);
      if (x + 1 < REGION_COMPARE_SIZE) {
        comparisons += 1;
        if (Math.abs(current - luminance(offset + channels)) >= EDGE_THRESHOLD) edges += 1;
      }
      if (y + 1 < REGION_COMPARE_SIZE) {
        comparisons += 1;
        if (Math.abs(current - luminance(offset + stride)) >= EDGE_THRESHOLD) edges += 1;
      }
    }
  }
  return comparisons > 0 ? edges / comparisons : 0;
}

async function assertTargetChanged(
  source: Buffer,
  generated: Buffer,
  sourceImage: PreparedImage,
  generatedImage: PreparedImage,
  target: VirtualStagingManifestTarget,
): Promise<void> {
  const [sourcePixels, generatedPixels] = await Promise.all([
    normalizedRegionPixels(source, sourceImage, target.region),
    normalizedRegionPixels(generated, generatedImage, target.region),
  ]);
  const [sourceHash, generatedHash] = await Promise.all([
    regionDhash(sourcePixels),
    regionDhash(generatedPixels),
  ]);
  const hashDistance = hammingDistance(sourceHash, generatedHash);
  const pixelDelta = meanPixelDelta(sourcePixels, generatedPixels);
  if (hashDistance <= REGION_DHASH_DISTANCE_FLOOR
    && pixelDelta < REGION_MEAN_PIXEL_DELTA_FLOOR) {
    throw new VirtualStagingViewpointRejectedError(
      `Required target ${target.id} did not change visibly`,
    );
  }
}

async function assertPreserveTargetHasStableStructure(
  source: Buffer,
  generated: Buffer,
  sourceImage: PreparedImage,
  generatedImage: PreparedImage,
  target: VirtualStagingManifestTarget,
): Promise<void> {
  const [sourcePixels, generatedPixels] = await Promise.all([
    normalizedRegionPixels(source, sourceImage, target.region),
    normalizedRegionPixels(generated, generatedImage, target.region),
  ]);
  const sourceDensity = edgeDensity(sourcePixels);
  if (sourceDensity < MIN_SOURCE_EDGE_DENSITY) return;
  const ratio = edgeDensity(generatedPixels) / sourceDensity;
  if (ratio < MIN_EDGE_DENSITY_RATIO || ratio > MAX_EDGE_DENSITY_RATIO) {
    throw new VirtualStagingViewpointRejectedError(
      `Permanent structure around ${target.id} changed too dramatically`,
    );
  }
}

/**
 * Deterministic first-pass guards. They prove that each required region is not
 * a no-op and that structural detail has not collapsed. Semantic correctness
 * still requires unanimous itemized vision reviews.
 */
export async function assertManifestDrivenImageChecks(input: {
  source: Buffer;
  generated: Buffer;
  manifest: VirtualStagingSourceManifest;
  provider: string;
}): Promise<void> {
  if (input.provider === "mock") return;
  const [sourceImage, generatedImage] = await Promise.all([
    prepareImage(input.source),
    prepareImage(input.generated),
  ]);
  await Promise.all([
    ...[...input.manifest.mustChangeTargets, ...input.manifest.finishOnlyTargets].map(
      (target) => assertTargetChanged(
        input.source,
        input.generated,
        sourceImage,
        generatedImage,
        target,
      ),
    ),
    ...input.manifest.preserveTargets.map(
      (target) => assertPreserveTargetHasStableStructure(
        input.source,
        input.generated,
        sourceImage,
        generatedImage,
        target,
      ),
    ),
  ]);
}
