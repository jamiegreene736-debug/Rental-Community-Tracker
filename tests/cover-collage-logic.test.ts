// Locks the 2026-07-11 AI cover collage ("Make Cover Collage" now has Claude
// vision pick the two best photos, the server composes + pushes the 2-up to
// Guesty, and the collage is saved in-system):
//   1. The vision reply parser only accepts a usable pick (two DIFFERENT
//      in-range photo numbers) — anything else falls back to the heuristic.
//   2. The heuristic fallback reproduces the old client pickCollagePhotos
//      scoring (community/destination LEFT, patio RIGHT) and never pairs a
//      photo with itself.
//   3. The panel ESRGAN gate is SHORT-side based (cover-crop scales by the
//      short side), unlike the push spec's long-side gate.
//   4. Source guards: the endpoint wiring, the fail-soft vision posture, the
//      in-system saves, the relabel-all skip, and the client one-click +
//      manual-fallback surfaces.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCollageVisionPrompt,
  collageEsrganScale,
  evenSampleIndices,
  heuristicCollagePick,
  parseCollageVisionPick,
  parseLocalPhotoUrl,
  scoreCommunityShot,
  scorePatioShot,
  COLLAGE_HEIGHT,
  COLLAGE_PANEL_PX,
  COLLAGE_WIDTH,
  COVER_COLLAGE_DISK_FOLDER,
  COVER_COLLAGE_SETTING_KEY,
  type CollageCandidate,
} from "../shared/cover-collage-logic";

console.log("cover-collage-logic");

// ── parseLocalPhotoUrl ───────────────────────────────────────────────────────
assert.deepEqual(parseLocalPhotoUrl("/photos/kaha-lani-109/photo_00.jpg"), { folder: "kaha-lani-109", filename: "photo_00.jpg" });
assert.deepEqual(parseLocalPhotoUrl("https://example.com/photos/f/a.jpg"), { folder: "f", filename: "a.jpg" });
assert.equal(parseLocalPhotoUrl("https://media.vrbo.com/x.jpg"), null, "external CDN photo is not local");
assert.equal(parseLocalPhotoUrl("/photos/only-folder"), null);
assert.equal(parseLocalPhotoUrl(""), null);
console.log("  ✓ parseLocalPhotoUrl");

// ── vision reply parser: strict, falls back on anything unusable ────────────
assert.deepEqual(
  parseCollageVisionPick({ left: 3, right: 7, reasoning: "ocean + living room" }, 10),
  { leftIndex: 2, rightIndex: 6, reasoning: "ocean + living room" },
);
assert.deepEqual(
  parseCollageVisionPick({ left: "2", right: "5" }, 6),
  { leftIndex: 1, rightIndex: 4, reasoning: null },
  "numeric strings tolerated, missing reasoning → null",
);
assert.equal(parseCollageVisionPick({ left: 0, right: 2 }, 5), null, "below range rejected");
assert.equal(parseCollageVisionPick({ left: 1, right: 6 }, 5), null, "above range rejected");
assert.equal(parseCollageVisionPick({ left: 4, right: 4 }, 5), null, "same photo twice rejected");
assert.equal(parseCollageVisionPick({ left: 1.5, right: 2 }, 5), null, "non-integer rejected");
assert.equal(parseCollageVisionPick({ right: 2 }, 5), null, "missing field rejected");
assert.equal(parseCollageVisionPick(null, 5), null);
assert.equal(parseCollageVisionPick("nope", 5), null);
const longReason = parseCollageVisionPick({ left: 1, right: 2, reasoning: "x".repeat(2000) }, 5);
assert.ok(longReason && longReason.reasoning!.length <= 500, "reasoning capped");
console.log("  ✓ parseCollageVisionPick accepts only a usable two-photo pick");

// ── heuristic fallback: old client scoring, community LEFT / patio RIGHT ────
const gallery: CollageCandidate[] = [
  { url: "/photos/f/a.jpg", caption: "Bathroom With Shower", source: "Unit A" },
  { url: "/photos/f/b.jpg", caption: "Resort Pool With Ocean View", source: "Community" },
  { url: "/photos/f/c.jpg", caption: "Living Room", source: "Unit A" },
  { url: "/photos/f/d.jpg", caption: "Lanai With Ocean View", source: "Unit A" },
  { url: "/photos/f/e.jpg", caption: "Community Grounds", source: "Community" },
];
const h = heuristicCollagePick(gallery)!;
assert.equal(h.leftIndex, 1, "best community shot (pool + ocean) goes left");
assert.equal(h.rightIndex, 3, "best patio shot (lanai + ocean) goes right");

// Two-photo gallery where one photo tops BOTH scorers must not self-pair.
const tiny: CollageCandidate[] = [
  { url: "/photos/f/x.jpg", caption: "Ocean View Lanai" },
  { url: "/photos/f/y.jpg", caption: "Kitchen" },
];
const t = heuristicCollagePick(tiny)!;
assert.notEqual(t.leftIndex, t.rightIndex, "never the same photo twice");
assert.equal(heuristicCollagePick([{ url: "/photos/f/x.jpg" }]), null, "one photo → no pick");
assert.equal(heuristicCollagePick([]), null);

// Scorer ports stay faithful to the old client weights.
assert.ok(scoreCommunityShot("Ocean view") > scoreCommunityShot("Resort grounds"));
assert.ok(scorePatioShot("Lanai with ocean view") > scorePatioShot("Back porch"));
console.log("  ✓ heuristicCollagePick (community left, patio right, no self-pair)");

// ── panel ESRGAN gate: SHORT side vs the 800px square panel ─────────────────
assert.equal(collageEsrganScale(4032, 3024), null, "big original skips the AI");
assert.equal(collageEsrganScale(1200, 800), null, "short side exactly at panel skips");
assert.equal(collageEsrganScale(1024, 683), 2, "683 short side → 2x (1366 clears 800)");
assert.equal(collageEsrganScale(418, 270), 3, "270 short side → 3x (810 clears 800)");
assert.equal(collageEsrganScale(300, 190), 4, "even 4x falls short → capped at 4x");
assert.equal(collageEsrganScale(800, 1200), null, "portrait with 800 short side skips");
assert.equal(collageEsrganScale(undefined, 500), null, "unreadable dims skip");
assert.equal(collageEsrganScale(0, 500), null);
console.log("  ✓ collageEsrganScale gates on the SHORT side (cover-crop math)");

// ── even sampling ────────────────────────────────────────────────────────────
assert.deepEqual(evenSampleIndices(3, 60), [0, 1, 2]);
const sampled = evenSampleIndices(200, 60);
assert.equal(sampled[0], 0);
assert.equal(sampled[sampled.length - 1], 199);
assert.ok(sampled.length <= 60);
assert.deepEqual(evenSampleIndices(5, 1), [0], "cap 1 has no divide-by-zero");
assert.deepEqual(evenSampleIndices(0, 10), []);
console.log("  ✓ evenSampleIndices");

// ── prompt: research-derived pairing rules + the JSON contract ───────────────
const prompt = buildCollageVisionPrompt(24);
assert.ok(prompt.includes("numbered 1-24"), "prompt states the photo count");
assert.ok(/LEFT panel/.test(prompt) && /RIGHT panel/.test(prompt), "left/right roles spelled out");
assert.ok(/ocean or beach view/i.test(prompt), "destination shot guidance");
assert.ok(/living area/i.test(prompt), "living-space guidance");
assert.ok(/DIFFERENT subjects/.test(prompt), "no two-angles-of-the-same-thing rule");
assert.ok(/bathrooms, floor plans, maps/.test(prompt), "cover-mistake ban list");
assert.ok(/SQUARE/.test(prompt), "square-crop survival rule");
assert.ok(prompt.includes('{"left": <photo number>, "right": <photo number>'), "JSON contract");
console.log("  ✓ buildCollageVisionPrompt");

// ── geometry constants mirror the manual client canvas ──────────────────────
assert.equal(COLLAGE_WIDTH, 1600);
assert.equal(COLLAGE_HEIGHT, 800);
assert.equal(COLLAGE_PANEL_PX, 800);
console.log("  ✓ collage geometry (1600×800, square panels)");

// ── source guards: wiring that must not drift ───────────────────────────────
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(here, "..", rel), "utf8");

const engine = read("server/cover-collage.ts");
assert.ok(
  engine.includes('process.env.COVER_COLLAGE_MODEL || "claude-sonnet-4-6"'),
  "vision model default + override env",
);
assert.ok(
  engine.includes('process.env.COVER_COLLAGE_VISION_DISABLED !== "1"'),
  "vision kill switch",
);
assert.ok(
  engine.includes("heuristicCollagePick(candidates)"),
  "engine degrades to the caption heuristic (fail-soft) — never hard-fails on a vision error",
);
assert.ok(
  /catch \(e: any\) \{\s*\n\s*console\.warn\(`\[cover-collage\] vision pick failed/.test(engine),
  "vision errors are caught + logged, not thrown",
);
assert.ok(
  engine.includes("parseCollageVisionPick(raw, sampled.length)"),
  "vision reply validated before use",
);
assert.ok(
  engine.includes('resize(COLLAGE_PANEL_PX, COLLAGE_PANEL_PX, { fit: "cover", position: "centre" })'),
  "square cover-crop panels",
);
assert.ok(
  engine.includes("collageEsrganScale(dims.width, dims.height)"),
  "ESRGAN gated per pick by the short-side panel rule",
);
console.log("  ✓ server/cover-collage.ts wiring locked");

const routes = read("server/routes.ts");
assert.ok(
  routes.includes('app.post("/api/builder/auto-cover-collage"'),
  "auto endpoint registered",
);
assert.ok(
  routes.includes("await generateAutoCoverCollage({"),
  "endpoint drives the engine",
);
assert.ok(
  routes.includes("upscale: (buf, mimeType, scale) => upscaleWithReplicateKw(buf, mimeType, scale)"),
  "Real-ESRGAN hook passed through (same upscaler as the push pipeline)",
);
assert.ok(
  routes.includes("await pushCoverCollageToGuesty(") &&
  routes.includes('app.post("/api/builder/upload-collage"'),
  "both collage endpoints share ONE ImgBB + Guesty-pin tail (no drift between manual and AI paths)",
);
assert.ok(
  routes.includes('const withoutOldCollage = existing.filter(p => p.caption !== "Cover Collage")'),
  "regeneration still drops the previous Cover Collage picture",
);
assert.ok(
  routes.includes('path.join(process.cwd(), "client/public/photos", COVER_COLLAGE_DISK_FOLDER)'),
  "collage bytes saved on the photos volume (in-system copy)",
);
assert.ok(
  routes.includes("await storage.getSetting(COVER_COLLAGE_SETTING_KEY)") &&
  routes.includes("await storage.setSetting(COVER_COLLAGE_SETTING_KEY"),
  "collage record persisted in app_settings",
);
assert.ok(
  routes.includes("f !== COVER_COLLAGE_DISK_FOLDER && (!onlyFolder || f === onlyFolder)"),
  "relabel-all-photos skips the cover-collages folder (synthetic composites, not gallery photos)",
);
assert.equal(COVER_COLLAGE_DISK_FOLDER, "cover-collages");
assert.equal(COVER_COLLAGE_SETTING_KEY, "cover_collages.v1");
console.log("  ✓ server/routes.ts endpoint + in-system saves locked");

const curator = read("client/src/components/GuestyListingBuilder/PhotoCurator.tsx");
assert.ok(
  curator.includes("onRequestAutoCoverCollage?: (candidates: PhotoIn[]) => void"),
  "PhotoCurator exposes the one-click AI hook",
);
assert.ok(
  curator.includes("aiEnabled ? startAuto() : openManualPicker()"),
  "primary button is one-click AI (manual picker only when the AI hook is absent)",
);
assert.ok(
  curator.includes(">pick manually</button>"),
  "manual two-photo picker stays one tap away",
);
assert.ok(
  curator.includes("selectableCollagePhotos.map((p) => ({ url: p.url, caption: p.caption, source: p.source }))"),
  "AI candidates are the VISIBLE photos (hidden/soft-deleted never reach the pick)",
);
console.log("  ✓ PhotoCurator one-click + manual fallback locked");

const builderUi = read("client/src/components/GuestyListingBuilder/index.tsx");
assert.ok(
  builderUi.includes('fetch("/api/builder/auto-cover-collage"'),
  "builder calls the auto endpoint",
);
assert.ok(
  builderUi.includes("existingPhotos: lastPushedPictures.length > 0 ? lastPushedPictures : undefined"),
  "race-free pictures list forwarded (same contract as the manual upload-collage call)",
);
console.log("  ✓ builder client wiring locked");

console.log("cover-collage-logic: all tests passed");
