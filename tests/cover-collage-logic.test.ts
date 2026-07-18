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
//   4. Source guards: manual generation stays fail-soft while the dashboard's
//      full-audit rail can require a real Claude pick (never a heuristic).
//   5. A property-scoped audit can save the JPEG + receipt before Guesty exists;
//      when a listing is mapped, Guesty sync remains an optional second step.
//   6. The relabel-all skip and client one-click + manual-fallback surfaces.
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
  resolveForcedCollagePick,
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
assert.equal(
  parseCollageVisionPick({ left: 1, right: 2, rightScene: "lanai" }, 5)?.rightScene,
  "lanai",
  "right-panel visual classification retained",
);
assert.equal(
  parseCollageVisionPick({ left: 1, right: 2, rightScene: "bedroom" }, 5)?.rightScene,
  undefined,
  "unknown right-panel classification rejected",
);
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

// ── resolveForcedCollagePick: the operator's "pick manually" pair ───────────
// 2026-07-18: manual picks used to go through a client canvas + two
// /api/builder/upscale-photo calls (Real-ESRGAN gated on the 1920 PUSH spec,
// not the 800px panel) — slow enough that the operator read it as "nothing
// happened … it reverted back to the collage that was chosen by Claude AI".
// Manual now rides the same server composer via an explicit pair.
const pool: CollageCandidate[] = [
  { url: "/photos/community-koa-lagoon/01-community.jpg", caption: "Lanai With Ocean View", source: "Community" },
  { url: "/photos/koa-lagoon-a/photo_00.jpg", caption: "Living Room With Ocean View", source: "Unit A" },
  { url: "/photos/koa-lagoon-a/photo_01.jpg", caption: "Kitchen", source: "Unit A" },
];
assert.deepEqual(
  resolveForcedCollagePick(pool, {
    leftUrl: "/photos/community-koa-lagoon/01-community.jpg",
    rightUrl: "/photos/koa-lagoon-a/photo_01.jpg",
  }),
  { leftIndex: 0, rightIndex: 2, reasoning: null },
  "resolves the operator's exact pair (not the heuristic's)",
);
assert.deepEqual(
  resolveForcedCollagePick(pool, {
    leftUrl: "https://admin.vacationrentalexpertz.com/photos/koa-lagoon-a/photo_01.jpg",
    rightUrl: "/photos/community-koa-lagoon/01-community.jpg",
  }),
  { leftIndex: 2, rightIndex: 0, reasoning: null },
  "absolute URL form matches its /photos/ counterpart; operator order is honored",
);
assert.equal(
  resolveForcedCollagePick(pool, { leftUrl: "/photos/koa-lagoon-a/photo_00.jpg", rightUrl: "/photos/gone/missing.jpg" }),
  null,
  "a pick absent from the resolved pool (external/missing on disk) → null, so the caller MUST fail",
);
assert.equal(
  resolveForcedCollagePick(pool, { leftUrl: "/photos/koa-lagoon-a/photo_00.jpg", rightUrl: "/photos/koa-lagoon-a/photo_00.jpg" }),
  null,
  "same photo twice is not a collage",
);
assert.equal(resolveForcedCollagePick([], { leftUrl: "/photos/f/a.jpg", rightUrl: "/photos/f/b.jpg" }), null);
assert.equal(resolveForcedCollagePick(pool, { leftUrl: "", rightUrl: "/photos/f/b.jpg" }), null);
// Indices are resolved against the FILTERED candidate list, so an external
// photo earlier in the gallery must not shift the pair.
assert.deepEqual(
  resolveForcedCollagePick(
    [{ url: "/photos/f/a.jpg" }, { url: "/photos/f/b.jpg" }],
    { leftUrl: "/photos/f/b.jpg", rightUrl: "/photos/f/a.jpg" },
  ),
  { leftIndex: 1, rightIndex: 0, reasoning: null },
);
console.log("  ✓ resolveForcedCollagePick (operator pair, never a silent substitute)");

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
assert.ok(/section: "Community/i.test(prompt), "community-source guidance");
assert.ok(/PATIO\/LANAI\/BALCONY/i.test(prompt), "unit-patio guidance");
assert.ok(/do not put a unit photo on the community side/i.test(prompt), "source-role guard is explicit");
assert.ok(/DIFFERENT subjects/.test(prompt), "no two-angles-of-the-same-thing rule");
assert.ok(/bathrooms, floor plans, maps/.test(prompt), "cover-mistake ban list");
assert.ok(/SQUARE/.test(prompt), "square-crop survival rule");
assert.ok(prompt.includes('"rightScene"'), "right-panel scene classification required");
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
  "manual generation retains the caption-heuristic fallback",
);
assert.ok(
  engine.includes("if (opts.requireVision && !visionEnabled)") &&
  engine.includes("Claude cover selection requires ANTHROPIC_API_KEY") &&
  engine.includes("Claude cover selection is disabled by COVER_COLLAGE_VISION_DISABLED"),
  "strict generation refuses to start when Claude vision is unavailable",
);
assert.ok(
  engine.includes("if (opts.requireVision) {") &&
  engine.includes("Claude could not select the cover collage:") &&
  engine.includes('if (opts.requireVision) throw new Error("Claude did not return a usable cover-collage pair")'),
  "strict generation propagates Claude failures and unusable picks instead of falling back",
);
assert.ok(
  engine.includes("vision pick failed (falling back to caption heuristic)") &&
  engine.indexOf("Claude could not select the cover collage:") < engine.indexOf("vision pick failed (falling back to caption heuristic)"),
  "manual generation still catches a Claude error and falls back after the strict branch",
);
assert.ok(
  engine.includes("parseCollageVisionPick(raw, sampled.length)"),
  "vision reply validated before use",
);
assert.ok(
  engine.includes("vision pick did not place a community photo on the left") &&
  engine.includes("vision pick did not place a unit patio photo on the right") &&
  engine.includes("vision pick did not prove the right panel is a patio"),
  "vision picks are rejected when they contradict community-left/unit-right",
);
assert.ok(
  engine.includes("vision pick has no published community-photo pool for the left panel") &&
  engine.includes("vision pick has no published unit-photo pool for the right patio panel"),
  "strict vision refuses to build a collage without both community and unit candidate pools",
);
assert.ok(
  engine.includes('resize(COLLAGE_PANEL_PX, COLLAGE_PANEL_PX, { fit: "cover", position: "centre" })'),
  "square cover-crop panels",
);
assert.ok(
  engine.includes("collageEsrganScale(dims.width, dims.height)"),
  "ESRGAN gated per pick by the short-side panel rule",
);
// A forced (operator) pick must be resolved BEFORE the vision/heuristic
// branches and must THROW when unresolvable. If this ever degrades to an AI
// pick, the operator gets Claude's collage after choosing their own — the
// exact 2026-07-18 bug.
const forcedBranch = engine.indexOf("if (opts.forcedPick) {");
assert.ok(forcedBranch > 0, "engine handles an operator-forced pair");
assert.ok(
  forcedBranch < engine.indexOf("const visionEnabled ="),
  "forced pick resolves before vision is even considered (no spend, no latency)",
);
assert.ok(
  engine.includes("pick = resolveForcedCollagePick(candidates, opts.forcedPick)") &&
  engine.slice(forcedBranch, forcedBranch + 900).includes("throw new Error("),
  "an unresolvable forced pick throws — it never silently becomes a vision/heuristic pick",
);
assert.ok(
  engine.includes('method = "manual"') &&
  engine.includes('method: "vision" | "heuristic" | "manual"'),
  "manual provenance is reported honestly (not mislabeled as a heuristic pick)",
);
assert.ok(
  engine.includes("if (!pick && visionEnabled) {"),
  "vision is skipped entirely once a forced pick is in hand",
);
console.log("  ✓ server/cover-collage.ts wiring locked");

const routes = read("server/routes.ts");
assert.ok(
  routes.includes('app.post("/api/builder/auto-cover-collage"'),
  "auto endpoint registered",
);
const autoRouteStart = routes.indexOf('app.post("/api/builder/auto-cover-collage"');
const autoRouteEnd = routes.indexOf("// POST /api/builder/resolve-license-requirements", autoRouteStart);
const autoRoute = routes.slice(autoRouteStart, autoRouteEnd);
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
  autoRoute.includes("listingId?: string | null") &&
  autoRoute.includes("propertyId?: number | string | null") &&
  autoRoute.includes('if (!listingId && propertyId == null)') &&
  autoRoute.includes('error: "listingId or propertyId required"'),
  "auto endpoint accepts a propertyId without requiring a Guesty listingId",
);
assert.ok(
  autoRoute.includes("const auditRequest = propertyId != null") &&
  autoRoute.includes("if (!auditRequest && !process.env.IMGBB_API_KEY)") &&
  autoRoute.includes("requireVision: requireVision === true"),
  "property-scoped audit generation does not require ImgBB and forwards the strict-Claude flag",
);
assert.ok(
  autoRoute.includes('`property-${propertyId < 0 ? `neg-${Math.abs(propertyId)}` : propertyId}`') &&
  autoRoute.includes("await fs.promises.writeFile(path.join(dir, file), collage.buffer)") &&
  autoRoute.includes('...(propertyId != null ? [`property:${propertyId}`] : [])') &&
  autoRoute.includes("await persistCoverCollageRecords(recordKeys"),
  "property-scoped JPEG and property:<id> receipt are durably saved",
);
assert.ok(
  autoRoute.indexOf("await fs.promises.writeFile(path.join(dir, file), collage.buffer)") < autoRoute.indexOf("if (listingId) {") &&
  autoRoute.includes("if (auditRequest && (!savedPath || !savedRecord))") &&
  autoRoute.includes('reason: "No Guesty listing mapped"'),
  "local persistence happens before optional Guesty sync and is sufficient when no listing is mapped",
);
assert.ok(
  autoRoute.includes("if (listingId) {") &&
  autoRoute.includes("pushed = await pushCoverCollageToGuesty(") &&
  autoRoute.includes("guestySynced: pushed?.ok === true"),
  "mapped listings still receive the collage and the receipt records Guesty sync status",
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
assert.ok(
  !builderUi.includes("requireVision:"),
  "manual Photos-tab generation does not opt into strict audit behavior",
);
// The manual path posts the SAME composer with an explicit pair. The old
// client canvas + per-pick upscale round-trip is what made a hand-picked
// collage take minutes and look like it had done nothing.
assert.ok(
  builderUi.includes("picks: { left: { url: picks.community.url }, right: { url: picks.patio.url } }"),
  "manual pair is sent to the server composer as an explicit pick",
);
assert.ok(
  !builderUi.includes('fetch("/api/builder/upload-collage"') &&
  !builderUi.includes("canvas.toDataURL(") &&
  !builderUi.includes('fetch("/api/builder/upscale-photo"'),
  "no client-side canvas compose or per-pick ESRGAN round-trip on the manual path",
);
console.log("  ✓ builder client wiring locked");

// Route: a half-specified pair is rejected outright rather than quietly
// becoming an AI pick.
assert.ok(
  autoRoute.includes("picks?: { left?: { url?: string }; right?: { url?: string } }") &&
  autoRoute.includes('error: "picks must supply BOTH left.url and right.url"') &&
  autoRoute.includes("forcedPick,"),
  "endpoint forwards an operator pair and refuses a half-specified one",
);
console.log("  ✓ manual pick contract locked");

console.log("cover-collage-logic: all tests passed");
