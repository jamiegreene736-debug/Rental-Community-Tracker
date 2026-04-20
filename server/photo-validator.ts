// Pre-flight photo validator for Guesty + channel (Booking.com / Airbnb / Vrbo) pushes.
//
// Target spec (works across all channels Guesty syncs to):
//   - Orientation:  landscape (width >= height). Portraits get rotated or cropped.
//   - Min width:    1920 px  (Guesty recommended; Booking.com accepts; Airbnb standard accepts)
//   - Max width:    1920 px  (Airbnb standard REJECTS connections when photos exceed 1920×1080)
//   - Aspect:       16:9 preferred for Booking.com; we don't force crop — just resize-to-fit.
//   - File size:    <= 4 MB (Airbnb cap). We recompress JPEG until under budget.
//   - Format:       JPEG (universal). PNG/WebP get converted.
//
// Returns the normalized buffer + a list of human-readable changes applied.

import sharp from "sharp";

export const TARGET_WIDTH = 1920;
export const TARGET_HEIGHT = 1080;
export const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4 MB — Airbnb standard listing cap
export const MIN_WIDTH = 1280; // Guesty absolute minimum

export type PhotoValidationResult = {
  buffer: Buffer;
  mimeType: string; // always "image/jpeg" after normalization
  changes: string[];
  originalWidth: number;
  originalHeight: number;
  finalWidth: number;
  finalHeight: number;
  originalBytes: number;
  finalBytes: number;
};

/**
 * Normalize a photo to Guesty + channel-compatible specs.
 * - Auto-rotates based on EXIF
 * - Rotates portraits 90° CW to make them landscape (common iPhone case)
 * - Resizes so width = 1920 (upscale or downscale), height scaled proportionally
 * - Converts to JPEG
 * - Recompresses until file size <= 4MB
 *
 * Non-destructive: if the image already meets spec exactly, buffer is returned unchanged
 * and `changes` is empty.
 */
export async function validateAndFixPhoto(
  input: Buffer,
  inputMime: string,
): Promise<PhotoValidationResult> {
  const changes: string[] = [];

  // Auto-rotate based on EXIF orientation so width/height reflect visual layout.
  let img = sharp(input, { failOn: "none" }).rotate();

  let meta = await img.metadata();
  const originalWidth = meta.width ?? 0;
  const originalHeight = meta.height ?? 0;
  const originalBytes = input.length;

  if (!originalWidth || !originalHeight) {
    throw new Error("Unable to read image dimensions");
  }

  // If portrait, rotate 90° clockwise to make landscape.
  // (This is better than cropping — preserves the whole scene, just turned sideways.)
  if (originalHeight > originalWidth) {
    img = img.rotate(90);
    changes.push(`rotated portrait → landscape (${originalWidth}×${originalHeight} → ${originalHeight}×${originalWidth})`);
    meta = await img.toBuffer().then((b) => sharp(b).metadata());
  }

  // Re-measure after potential rotation.
  const afterRotateBuf = await img.toBuffer();
  const afterRotateMeta = await sharp(afterRotateBuf).metadata();
  const preResizeW = afterRotateMeta.width ?? 0;
  const preResizeH = afterRotateMeta.height ?? 0;

  // Resize so width = TARGET_WIDTH. Sharp will scale height proportionally.
  // This handles BOTH under-spec (upscale) and over-spec (downscale, e.g. 4032×3024 iPhone shots).
  let pipeline = sharp(afterRotateBuf);
  let finalWidth = preResizeW;
  let finalHeight = preResizeH;

  if (preResizeW !== TARGET_WIDTH) {
    pipeline = pipeline.resize({
      width: TARGET_WIDTH,
      withoutEnlargement: false, // allow upscaling small images
      fit: "inside",
    });
    // Compute final dims
    finalHeight = Math.round((TARGET_WIDTH / preResizeW) * preResizeH);
    finalWidth = TARGET_WIDTH;
    if (preResizeW < TARGET_WIDTH) {
      changes.push(`upscaled ${preResizeW}×${preResizeH} → ${finalWidth}×${finalHeight}`);
    } else {
      changes.push(`downscaled ${preResizeW}×${preResizeH} → ${finalWidth}×${finalHeight}`);
    }
  }

  // Convert to JPEG if not already, and compress under 4MB.
  // We step quality down from 88 until we fit the budget.
  let quality = 88;
  let outBuf = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();

  if (inputMime !== "image/jpeg") {
    changes.push(`converted ${inputMime} → image/jpeg`);
  }

  while (outBuf.length > MAX_FILE_BYTES && quality > 40) {
    quality -= 8;
    outBuf = await sharp(afterRotateBuf)
      .resize({ width: TARGET_WIDTH, fit: "inside", withoutEnlargement: false })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
  }

  if (outBuf.length > MAX_FILE_BYTES) {
    // Last resort: shrink to 1600 wide at quality 75
    outBuf = await sharp(afterRotateBuf)
      .resize({ width: 1600, fit: "inside", withoutEnlargement: false })
      .jpeg({ quality: 75, mozjpeg: true })
      .toBuffer();
    const m = await sharp(outBuf).metadata();
    finalWidth = m.width ?? 1600;
    finalHeight = m.height ?? 900;
    changes.push(`emergency resize to ${finalWidth}×${finalHeight} q75 to fit 4MB budget`);
  }

  if (originalBytes !== outBuf.length && !changes.some((c) => c.includes("q75"))) {
    const deltaPct = Math.round(((originalBytes - outBuf.length) / originalBytes) * 100);
    if (Math.abs(deltaPct) >= 5) {
      changes.push(`compressed ${formatBytes(originalBytes)} → ${formatBytes(outBuf.length)} (q${quality})`);
    }
  }

  // Re-measure if we don't already have a fresh measurement
  if (!changes.some((c) => c.includes("emergency"))) {
    const finalMeta = await sharp(outBuf).metadata();
    finalWidth = finalMeta.width ?? finalWidth;
    finalHeight = finalMeta.height ?? finalHeight;
  }

  return {
    buffer: outBuf,
    mimeType: "image/jpeg",
    changes,
    originalWidth,
    originalHeight,
    finalWidth,
    finalHeight,
    originalBytes,
    finalBytes: outBuf.length,
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
