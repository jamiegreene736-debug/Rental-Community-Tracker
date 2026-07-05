import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assembleGuestyPushPhotos,
  captionFromFilename,
  recentUnitSwapPropertyIds,
  type GuestyPushGallery,
} from "../shared/guesty-photo-repush";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("guesty-photo-repush: post-replacement Guesty gallery re-push");

// ── captionFromFilename ─────────────────────────────────────────────────────
check("captionFromFilename humanizes and title-cases",
  captionFromFilename("03-master_bedroom-king.jpg") === "Master Bedroom King");
check("captionFromFilename mirrors the client (bare numeric stem kept; empty stem → Photo)",
  captionFromFilename("01.jpg") === "01" && captionFromFilename("03-.jpg") === "Photo");

// ── assembleGuestyPushPhotos ────────────────────────────────────────────────
const unitGallery: GuestyPushGallery = {
  folder: "replacement-p32-ukia-a",
  scope: "unit",
  files: ["01-bedroom.jpg", "02-living-room.jpg", "03-kitchen.jpg", "04-hidden.jpg"],
  labels: [
    { filename: "01-bedroom.jpg", label: "Primary Bedroom — King" },
    { filename: "02-living-room.jpg", label: "Living Room", userLabel: "Great Room With Ocean View" },
    { filename: "04-hidden.jpg", label: "Blurry Duplicate", hidden: true },
  ],
  staticLabels: { "03-kitchen.jpg": "Chef's Kitchen" },
};
const communityGallery: GuestyPushGallery = {
  folder: "community-poipu-kai",
  scope: "community",
  files: ["10-tennis.jpg", "11-pool.jpg"],
  labels: [
    { filename: "10-tennis.jpg", label: "Tennis Courts" },
    { filename: "11-pool.jpg", label: "Resort Pool" },
  ],
};

{
  const photos = assembleGuestyPushPhotos([unitGallery, communityGallery]);
  check("hidden photos are dropped",
    !photos.some((p) => p.localPath.includes("04-hidden.jpg")));
  check("localPath is /photos/<folder>/<file>",
    photos.every((p) => /^\/photos\/[^/]+\/[^/]+$/.test(p.localPath)));
  check("userLabel beats the labeler caption",
    photos.some((p) => p.caption === "Great Room With Ocean View"));
  check("static label fills in when no labeler row exists",
    photos.some((p) => p.caption === "Chef's Kitchen"));
  check("unit gallery is hero-first (living before bedroom)",
    photos.findIndex((p) => p.localPath.includes("02-living-room.jpg"))
      < photos.findIndex((p) => p.localPath.includes("01-bedroom.jpg")));
  check("community gallery comes after the unit gallery (caller order preserved)",
    photos.findIndex((p) => p.localPath.startsWith("/photos/community-poipu-kai/"))
      > photos.findIndex((p) => p.localPath.startsWith("/photos/replacement-p32-ukia-a/")));
  check("community gallery is hero-first (pool before tennis)",
    photos.findIndex((p) => p.localPath.includes("11-pool.jpg"))
      < photos.findIndex((p) => p.localPath.includes("10-tennis.jpg")));
}

check("manual sort_order wins over the hero-first default", (() => {
  const photos = assembleGuestyPushPhotos([{
    folder: "unit-x",
    scope: "unit",
    files: ["living.jpg", "bedroom.jpg"],
    labels: [
      { filename: "living.jpg", label: "Living Room", sortOrder: 5 },
      { filename: "bedroom.jpg", label: "Primary Bedroom", sortOrder: 1 },
    ],
  }]);
  return photos[0].localPath.includes("bedroom.jpg");
})());

check("photos with no label row at all fall back to the filename caption", (() => {
  const photos = assembleGuestyPushPhotos([{
    folder: "unit-x", scope: "unit", files: ["05-lanai-view.jpg"], labels: [],
  }]);
  return photos[0]?.caption === "Lanai View";
})());

check("a duplicate folder is only emitted once (shared-gallery guard)", (() => {
  const photos = assembleGuestyPushPhotos([unitGallery, unitGallery]);
  return photos.filter((p) => p.localPath.includes("01-bedroom.jpg")).length === 1;
})());

check("empty folders contribute nothing",
  assembleGuestyPushPhotos([{ folder: "unit-x", scope: "unit", files: [] }]).length === 0);

// ── recentUnitSwapPropertyIds ───────────────────────────────────────────────
const NOW = Date.parse("2026-07-05T12:00:00Z");
const day = 24 * 60 * 60 * 1000;

{
  const ids = recentUnitSwapPropertyIds([
    { propertyId: 32, createdAt: new Date(NOW - 1 * day) },
    { propertyId: 20, createdAt: new Date(NOW - 2.5 * day) },
    { propertyId: 32, createdAt: new Date(NOW - 2 * day) },   // dup property
    { propertyId: 7, createdAt: new Date(NOW - 5 * day) },    // outside window
  ], NOW, 3);
  check("3-day window keeps recent swaps and drops older ones",
    ids.length === 2 && ids[0] === 32 && ids[1] === 20);
}
check("ISO-string createdAt is accepted",
  recentUnitSwapPropertyIds([{ propertyId: 9, createdAt: "2026-07-04T00:00:00.000Z" }], NOW, 3)
    .includes(9));
check("rows without a parseable createdAt are skipped",
  recentUnitSwapPropertyIds([
    { propertyId: 9, createdAt: null },
    { propertyId: 10, createdAt: "not-a-date" },
  ], NOW, 3).length === 0);
check("boundary: a swap exactly windowDays old is still included",
  recentUnitSwapPropertyIds([{ propertyId: 5, createdAt: new Date(NOW - 3 * day) }], NOW, 3)
    .includes(5));

// ── source assertions — the wiring the pure tests can't see ────────────────
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(here, "..", rel), "utf8");

{
  const src = read("server/auto-replace-jobs.ts");
  check("auto-replace commit opts out of the route's fire-and-forget push (skipGuestyPhotoPush)",
    src.includes("skipGuestyPhotoPush: true"));
  check("auto-replace phase 3 awaits its own Guesty photo re-push",
    src.includes("repushGuestyPhotosForProperty(record.propertyId"));
  check("auto-replace surfaces a push failure with the manual fallback hint",
    src.includes("Push Photos to Guesty"));
}
{
  const src = read("server/routes.ts");
  check("POST /api/unit-swaps fires the Guesty photo re-push after commit",
    src.includes("repushGuestyPhotosForProperty(parsed.data.propertyId"));
  check("POST /api/unit-swaps honors the skipGuestyPhotoPush opt-out",
    src.includes("skipGuestyPhotoPush === true"));
  check("retroactive repush endpoint exists",
    src.includes("/api/replacement/repush-guesty-photos"));
}
{
  const src = read("server/guesty-photo-repush.ts");
  check("server re-push drives the existing push-photos endpoint (full pictures[] replace)",
    src.includes("/api/builder/push-photos"));
  check("server re-push resolves ACTIVE folders (replacement wins over the stale original)",
    src.includes("resolveActiveUnitPhotoFolders"));
  check("per-property pushes are serialized (no concurrent PUT race on pictures[])",
    src.includes("pushTails"));
  check("push waits (bounded) for the fresh folder's Claude labels before publishing captions",
    src.includes("waitForFolderLabels"));
}

console.log(`\nguesty-photo-repush: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
