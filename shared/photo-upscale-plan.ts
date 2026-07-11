// Pure decisions for the Guesty photo-push upscaling pipeline
// (POST /api/builder/push-photos + /api/builder/upscale-photo in
// server/routes.ts, validated by server/photo-validator.ts).
//
// WHY THIS EXISTS (2026-07-11 operator report: "photos pushed to Guesty look
// like they're upscaled"): the push pipeline used to degrade photos two ways.
//   1. With upscale:true (every automated push), Real-ESRGAN 2x ran on EVERY
//      photo regardless of size — a 4032px Zillow/iPhone original was
//      AI-upscaled to 8064px (inventing/smoothing detail) and then immediately
//      Lanczos-downscaled back to the 1920px push spec. Net effect: the
//      AI-processed look with ZERO resolution benefit, plus ~30s and a
//      Replicate charge per photo.
//   2. A fixed 2x was too little for genuinely tiny photos (a 418px PM-site
//      original became 836px, still under spec, and the validator then
//      plain-stretched it the rest of the way to 1920 — soft).
//
// The rule now: only AI-upscale photos genuinely BELOW the push spec, and pick
// the smallest ESRGAN scale that clears the spec so the classical resize step
// afterwards only ever shrinks (crisp), never stretches.
//
// NOTE FOR CODEX (load-bearing): the long-side comparison (not width) is
// deliberate — server/photo-validator.ts rotates portrait photos 90° to
// landscape before resizing, so a 3024x4032 portrait becomes 4032 wide and
// needs no upscaling. Gating on width alone would send big portraits to
// Real-ESRGAN for nothing.

/** The push spec width every photo is normalized to (mirrors
 * server/photo-validator.ts TARGET_WIDTH — callers pass that constant in). */
export const PUSH_TARGET_WIDTH = 1920;

/** Real-ESRGAN scale bounds. 2 is the cheapest useful step; 4 is the model's
 * default/maximum sensible factor — beyond it cost balloons for detail the
 * 1920px spec throws away anyway. */
export const ESRGAN_MIN_SCALE = 2;
export const ESRGAN_MAX_SCALE = 4;

/**
 * Decide whether a photo should be AI-upscaled before the push, and by how
 * much. Returns null to SKIP Real-ESRGAN (photo already meets/exceeds the
 * spec, or dimensions are unreadable — let the validator handle it), else the
 * smallest integer scale in [ESRGAN_MIN_SCALE, ESRGAN_MAX_SCALE] whose output
 * long side clears targetWidth (capped at ESRGAN_MAX_SCALE when even 4x can't
 * reach it — the validator's Lanczos+sharpen finishes the last stretch).
 */
export function esrganScaleForPhoto(
  width: number | undefined,
  height: number | undefined,
  targetWidth: number = PUSH_TARGET_WIDTH,
): number | null {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const longSide = Math.max(w, h);
  if (longSide >= targetWidth) return null;
  for (let scale = ESRGAN_MIN_SCALE; scale <= ESRGAN_MAX_SCALE; scale += 1) {
    if (longSide * scale >= targetWidth) return scale;
  }
  return ESRGAN_MAX_SCALE;
}

export type PushComplianceProbe = {
  /** sharp metadata().format, e.g. "jpeg" | "png" | "webp" */
  format?: string;
  width?: number;
  height?: number;
  /** EXIF orientation; undefined or 1 = stored pixels are already upright */
  orientation?: number;
  /** encoded file size in bytes */
  bytes: number;
};

/**
 * True when a photo ALREADY meets the push spec exactly (upright landscape
 * JPEG, width === targetWidth, within the size budget) so the validator can
 * pass the original bytes through untouched instead of decoding + re-encoding
 * them. Every needless re-encode is a JPEG generation lost — re-pushes of
 * previously-normalized galleries hit this path constantly.
 */
export function isAlreadyPushCompliant(
  probe: PushComplianceProbe,
  targetWidth: number,
  maxBytes: number,
): boolean {
  if (probe.format !== "jpeg") return false;
  if (probe.orientation !== undefined && probe.orientation !== 1) return false;
  const w = Number(probe.width);
  const h = Number(probe.height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return false;
  if (w !== targetWidth) return false;
  if (h > w) return false; // portrait still needs the rotate step
  if (!Number.isFinite(probe.bytes) || probe.bytes <= 0 || probe.bytes > maxBytes) return false;
  return true;
}
