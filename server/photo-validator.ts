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

  // Encode with high-quality settings tuned for photographic content:
  //   - mozjpeg + trellis quantisation → better compression for same visual quality
  //   - chromaSubsampling "4:4:4" → no chroma downsampling, preserves sharp edges
  //     (trim details, text, dividers — important for a cover collage)
  //   - mild post-resize sharpen → counteracts bicubic softening after downscale
  //   - Lanczos3 is sharp's default kernel, already optimal
  const needsSharpen = preResizeW > TARGET_WIDTH; // only sharpen when downscaling
  const buildPipeline = (q: number, subsampling: "4:4:4" | "4:2:0") => {
    let p = sharp(afterRotateBuf).resize({
      width: TARGET_WIDTH,
      fit: "inside",
      withoutEnlargement: false,
      kernel: "lanczos3",
    });
    if (needsSharpen) p = p.sharpen({ sigma: 0.6, m1: 0.3, m2: 0.8 });
    return p.jpeg({
      quality: q,
      mozjpeg: true,
      chromaSubsampling: subsampling,
      trellisQuantisation: true,
      overshootDeringing: true,
      optimiseScans: true,
    }).toBuffer();
  };

  // Start with top-tier settings
  let quality = 90;
  let subsampling: "4:4:4" | "4:2:0" = "4:4:4";
  let outBuf = await buildPipeline(quality, subsampling);

  if (inputMime !== "image/jpeg") {
    changes.push(`converted ${inputMime} → image/jpeg`);
  }

  // If over budget, step 1: drop to 4:2:0 chroma (half the chroma data, minimal perceived loss)
  if (outBuf.length > MAX_FILE_BYTES) {
    subsampling = "4:2:0";
    outBuf = await buildPipeline(quality, subsampling);
  }

  // Step 2: walk quality down in small increments for graceful degradation
  while (outBuf.length > MAX_FILE_BYTES && quality > 72) {
    quality -= 3;
    outBuf = await buildPipeline(quality, subsampling);
  }

  // Step 3: larger steps only if still over
  while (outBuf.length > MAX_FILE_BYTES && quality > 55) {
    quality -= 5;
    outBuf = await buildPipeline(quality, subsampling);
  }

  if (outBuf.length > MAX_FILE_BYTES) {
    // Last resort: shrink to 1600 wide at quality 72 — only triggers for pathologically
    // huge/uncompressible input. Rare in practice.
    outBuf = await sharp(afterRotateBuf)
      .resize({ width: 1600, fit: "inside", withoutEnlargement: false, kernel: "lanczos3" })
      .sharpen({ sigma: 0.5, m1: 0.2, m2: 0.7 })
      .jpeg({ quality: 72, mozjpeg: true, chromaSubsampling: "4:2:0", trellisQuantisation: true })
      .toBuffer();
    const m = await sharp(outBuf).metadata();
    finalWidth = m.width ?? 1600;
    finalHeight = m.height ?? 900;
    changes.push(`emergency resize to ${finalWidth}×${finalHeight} q72 to fit 4MB budget`);
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
