#!/usr/bin/env node
/**
 * Download curated community amenity photos into client/public/photos/community-* folders.
 * Replaces incorrect generic-search images with operator-verified resort sources.
 *
 *   node scripts/refresh-community-photos.mjs
 *   node scripts/refresh-community-photos.mjs --folder community-makahuena
 */
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  COMMUNITY_PHOTO_FOLDER_CONFIGS,
  DASHBOARD_COMMUNITY_PHOTO_FOLDERS,
} = require("../shared/community-photo-folders.ts");

const PHOTOS_ROOT = join(process.cwd(), "client/public/photos");
const ONLY_FOLDER = process.argv.find((a) => a.startsWith("--folder="))?.split("=")[1]
  ?? (process.argv.includes("--folder") ? process.argv[process.argv.indexOf("--folder") + 1] : null);

const MIN_BYTES = 15_000;

async function downloadImage(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": "RentalCommunityTracker/1.0 (community-photo-refresh)" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < MIN_BYTES) throw new Error(`too small (${buf.length} bytes)`);
  return buf;
}

function purgeCommunityImages(dir) {
  for (const f of readdirSync(dir)) {
    if (/\.(?:jpe?g|png|webp)$/i.test(f)) unlinkSync(join(dir, f));
  }
}

function writeSourceJson(dir, config) {
  const doc = {
    folder: config.folder,
    type: "community",
    verificationStatus: "verified",
    verifiedDate: new Date().toISOString().slice(0, 10),
    verifiedBy: "refresh-community-photos.mjs",
    sourceListing: {
      url: config.sourceUrl,
      platform: new URL(config.sourceUrl).hostname,
      scrapedDate: new Date().toISOString().slice(0, 10),
    },
    notes: `Curated on-property amenity photos from ${config.sourceUrl}. Replaced incorrect generic-search community folder images.`,
  };
  writeFileSync(join(dir, "_source.json"), `${JSON.stringify(doc, null, 2)}\n`);
}

async function refreshFolder(config) {
  const dir = join(PHOTOS_ROOT, config.folder);
  mkdirSync(dir, { recursive: true });
  purgeCommunityImages(dir);

  const saved = [];
  const failed = [];
  let index = 1;
  for (const url of config.curatedImageUrls) {
    const filename = `${String(index).padStart(2, "0")}-community.jpg`;
    try {
      const buf = await downloadImage(url);
      writeFileSync(join(dir, filename), buf);
      saved.push(filename);
      console.log(`  ✓ ${filename} ← ${url}`);
      index += 1;
    } catch (e) {
      failed.push({ url, error: e.message });
      console.warn(`  ✗ skip ${url}: ${e.message}`);
    }
  }

  if (saved.length < 5) {
    throw new Error(`only ${saved.length} photos saved (need ≥5)`);
  }

  writeSourceJson(dir, config);
  return { saved, failed };
}

const targets = ONLY_FOLDER
  ? COMMUNITY_PHOTO_FOLDER_CONFIGS.filter((c) => c.folder === ONLY_FOLDER)
  : COMMUNITY_PHOTO_FOLDER_CONFIGS.filter((c) => DASHBOARD_COMMUNITY_PHOTO_FOLDERS.includes(c.folder));

if (!targets.length) {
  console.error(`No config for folder: ${ONLY_FOLDER ?? "(dashboard set)"}`);
  process.exit(1);
}

console.log(`Refreshing ${targets.length} community folder(s)…\n`);
let ok = 0;
const errors = [];
for (const config of targets) {
  console.log(`[${config.folder}] ${config.displayName}`);
  try {
    const result = await refreshFolder(config);
    console.log(`  → ${result.saved.length} saved, ${result.failed.length} skipped\n`);
    ok += 1;
  } catch (e) {
    errors.push(`${config.folder}: ${e.message}`);
    console.error(`  → FAILED: ${e.message}\n`);
  }
}

if (errors.length) {
  console.error("Failures:");
  for (const m of errors) console.error(`  - ${m}`);
  process.exit(1);
}
console.log(`Done — ${ok}/${targets.length} folders refreshed.`);