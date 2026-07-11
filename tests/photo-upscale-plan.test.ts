// Locks the 2026-07-11 Guesty photo-push upscaling fix ("photos pushed to
// Guesty look like they're upscaled"):
//   1. Real-ESRGAN only runs on photos genuinely BELOW the 1920px push spec
//      (an already-large photo was previously AI-upscaled 2x then immediately
//      downscaled back to 1920 — AI-smoothed look, zero benefit).
//   2. The ESRGAN scale is the smallest factor that clears the spec, so the
//      classical resize afterwards only ever shrinks (crisp), never stretches.
//   3. The validator sharpens Lanczos UPSCALES too (previously only
//      downscales), and passes already-compliant JPEGs through byte-untouched
//      instead of burning a JPEG generation on every re-push.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  esrganScaleForPhoto,
  isAlreadyPushCompliant,
  PUSH_TARGET_WIDTH,
  ESRGAN_MAX_SCALE,
} from "../shared/photo-upscale-plan";

console.log("photo-upscale-plan");

// ── esrganScaleForPhoto: skip photos at/above spec ──────────────────────────
assert.equal(esrganScaleForPhoto(1920, 1080), null, "exactly at spec skips");
assert.equal(esrganScaleForPhoto(4032, 3024), null, "iPhone/Zillow original skips");
assert.equal(esrganScaleForPhoto(2738, 1825), null, "VRBO CDN full-res skips");
// Long-side gate: the validator rotates portraits to landscape, so a big
// portrait needs no AI even though its WIDTH is under 1920.
assert.equal(esrganScaleForPhoto(1080, 1920), null, "portrait at spec (long side) skips");
assert.equal(esrganScaleForPhoto(3024, 4032), null, "big portrait skips");
console.log("  ✓ photos at/above the 1920px spec skip Real-ESRGAN");

// ── esrganScaleForPhoto: smallest scale that clears the spec ────────────────
assert.equal(esrganScaleForPhoto(1200, 800), 2, "1200px → 2x (2400 clears 1920)");
assert.equal(esrganScaleForPhoto(960, 640), 2, "960px → 2x lands exactly on 1920");
assert.equal(esrganScaleForPhoto(959, 640), 3, "959px needs 3x (2x = 1918 falls short)");
assert.equal(esrganScaleForPhoto(700, 466), 3, "700px → 3x (2100 clears)");
assert.equal(esrganScaleForPhoto(480, 320), 4, "480px → 4x lands exactly on 1920");
// Even 4x can't reach spec — cap at max and let the validator finish the
// (now small) remaining stretch with Lanczos + sharpen.
assert.equal(esrganScaleForPhoto(418, 270), ESRGAN_MAX_SCALE, "418px PM-site original caps at 4x");
// Portrait long side drives the scale.
assert.equal(esrganScaleForPhoto(800, 1200), 2, "portrait 1200 long side → 2x");
console.log("  ✓ smallest ESRGAN scale that clears the spec, capped at 4x");

// ── esrganScaleForPhoto: unreadable dims never trigger the AI ────────────────
assert.equal(esrganScaleForPhoto(undefined, undefined), null);
assert.equal(esrganScaleForPhoto(0, 1080), null);
assert.equal(esrganScaleForPhoto(NaN, 500), null);
assert.equal(esrganScaleForPhoto(-100, 500), null);
console.log("  ✓ unreadable/invalid dimensions skip the AI step");

// ── isAlreadyPushCompliant: the validator byte-passthrough fast path ─────────
const MAX = 4 * 1024 * 1024;
const compliant = { format: "jpeg", width: 1920, height: 1080, orientation: undefined, bytes: 900_000 };
assert.equal(isAlreadyPushCompliant(compliant, PUSH_TARGET_WIDTH, MAX), true, "upright 1920-wide JPEG passes through");
assert.equal(isAlreadyPushCompliant({ ...compliant, orientation: 1 }, PUSH_TARGET_WIDTH, MAX), true, "orientation 1 is upright");
assert.equal(isAlreadyPushCompliant({ ...compliant, format: "png" }, PUSH_TARGET_WIDTH, MAX), false, "PNG must convert");
assert.equal(isAlreadyPushCompliant({ ...compliant, format: "webp" }, PUSH_TARGET_WIDTH, MAX), false, "WebP must convert");
assert.equal(isAlreadyPushCompliant({ ...compliant, width: 1919 }, PUSH_TARGET_WIDTH, MAX), false, "under-spec width re-encodes");
assert.equal(isAlreadyPushCompliant({ ...compliant, width: 2400 }, PUSH_TARGET_WIDTH, MAX), false, "over-spec width re-encodes");
assert.equal(isAlreadyPushCompliant({ ...compliant, width: 1080, height: 1920 }, PUSH_TARGET_WIDTH, MAX), false, "portrait still needs the rotate step");
assert.equal(isAlreadyPushCompliant({ ...compliant, orientation: 6 }, PUSH_TARGET_WIDTH, MAX), false, "EXIF-rotated JPEG still needs normalizing");
assert.equal(isAlreadyPushCompliant({ ...compliant, bytes: MAX + 1 }, PUSH_TARGET_WIDTH, MAX), false, "over the 4MB budget re-compresses");
assert.equal(isAlreadyPushCompliant({ ...compliant, width: undefined }, PUSH_TARGET_WIDTH, MAX), false, "unreadable dims re-encode");
console.log("  ✓ isAlreadyPushCompliant fast path (spec-exact upright JPEG only)");

// ── SOURCE GUARDS: keep the wiring from silently drifting back ───────────────
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(here, "..", rel), "utf8");

const routes = read("server/routes.ts");
// push-photos + upscale-photo must gate Real-ESRGAN through the shared plan.
assert.ok(
  routes.includes('import { esrganScaleForPhoto } from "@shared/photo-upscale-plan"'),
  "routes.ts imports esrganScaleForPhoto",
);
assert.ok(
  (routes.match(/esrganScaleForPhoto\(dims\.width, dims\.height, PUSH_PHOTO_TARGET_WIDTH\)/g) ?? []).length >= 2,
  "both push-photos and upscale-photo gate ESRGAN on measured dimensions vs the validator's TARGET_WIDTH",
);
// The Replicate call must accept + forward the computed scale (a hardcoded
// `scale: 2` here is the old always-2x behavior sneaking back).
assert.ok(
  /async function upscaleWithReplicateKw\(imageBuffer: Buffer, mimeType: string, scale: number = 2\)/.test(routes),
  "upscaleWithReplicateKw takes a scale param",
);
assert.ok(
  routes.includes("{ input: { image: dataUri, scale, face_enhance: false } }"),
  "the computed scale is forwarded to Real-ESRGAN",
);
assert.ok(
  routes.includes("upscaleWithReplicateKw(rawData, mimeType, esrganScale)"),
  "push-photos passes the per-photo scale",
);
console.log("  ✓ routes.ts wiring (size gate + per-photo scale) locked");

const validator = read("server/photo-validator.ts");
assert.ok(
  validator.includes("isAlreadyPushCompliant("),
  "photo-validator has the byte-passthrough fast path",
);
assert.ok(
  /resizeDirection === "up"\) p = p\.sharpen\(/.test(validator),
  "photo-validator sharpens Lanczos UPSCALES (soft stretched photos were half the report)",
);
assert.ok(
  /resizeDirection === "down"\) p = p\.sharpen\(/.test(validator),
  "photo-validator still sharpens downscales",
);
console.log("  ✓ photo-validator fast path + both-direction sharpening locked");

const builderUi = read("client/src/components/GuestyListingBuilder/index.tsx");
assert.ok(
  builderUi.includes("const [doUpscale, setDoUpscale] = useState(true)"),
  "Photos-tab AI-upscale toggle defaults ON (server only upscales sub-spec photos now)",
);
assert.ok(
  builderUi.includes("upscaleAndUpload(effectivePropertyData?.photos ?? [], doUpscale)"),
  "the publish flow follows the toggle instead of hardcoding upscale off",
);
console.log("  ✓ client defaults locked (toggle ON, publish follows toggle)");

console.log("photo-upscale-plan: all tests passed");
