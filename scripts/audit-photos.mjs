#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const PHOTOS_DIR = "client/public/photos";
const DATA_FILE = "client/src/data/unit-builder-data.ts";
const MIN_FILE_BYTES = 20_000;
const MAX_FILE_BYTES = 8_000_000;
const MIN_PHOTOS_PER_UNIT_FOLDER = 8;
const MIN_PHOTOS_PER_COMMUNITY_FOLDER = 5;

function md5(path) {
  return createHash("md5").update(readFileSync(path)).digest("hex");
}

function listImageFiles(dir) {
  return readdirSync(dir)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .map((f) => join(dir, f));
}

function loadReferencedFolders() {
  const src = readFileSync(DATA_FILE, "utf8");
  const used = new Map();
  const re = /photoFolder:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src))) {
    used.set(m[1], (used.get(m[1]) ?? 0) + 1);
  }
  const reC = /communityPhotoFolder:\s*"([^"]+)"/g;
  const community = new Set();
  while ((m = reC.exec(src))) community.add(m[1]);
  return { unit: used, community };
}

const findings = { critical: [], warn: [], info: [] };
function critical(msg) { findings.critical.push(msg); }
function warn(msg) { findings.warn.push(msg); }
function info(msg) { findings.info.push(msg); }

const { unit: refUnit, community: refCommunity } = loadReferencedFolders();
const folderEntries = readdirSync(PHOTOS_DIR).filter((d) => statSync(join(PHOTOS_DIR, d)).isDirectory());

const allHashes = new Map(); // hash -> [paths]
const folderStats = [];

for (const folder of folderEntries) {
  const dir = join(PHOTOS_DIR, folder);
  const files = listImageFiles(dir);
  const isCommunity = folder.startsWith("community-");
  const minExpected = isCommunity ? MIN_PHOTOS_PER_COMMUNITY_FOLDER : MIN_PHOTOS_PER_UNIT_FOLDER;
  const sourcePath = join(dir, "_source.json");
  const hasSource = existsSync(sourcePath);
  let sourceStatus = null;
  if (hasSource) {
    try {
      const parsed = JSON.parse(readFileSync(sourcePath, "utf8"));
      sourceStatus = parsed.verificationStatus ?? null;
      if (sourceStatus === "broken") critical(`_source.json marks folder as BROKEN: ${folder} — ${parsed.notes ?? ""}`);
      else if (sourceStatus === "needs-review") info(`needs human verification: ${folder}`);
      else if (sourceStatus === "unused") info(`marked unused (resolve or delete): ${folder}`);
    } catch (e) {
      warn(`malformed _source.json: ${folder} (${e.message})`);
    }
  }
  const sizes = [];
  for (const f of files) {
    const sz = statSync(f).size;
    sizes.push(sz);
    const h = md5(f);
    if (!allHashes.has(h)) allHashes.set(h, []);
    allHashes.get(h).push(relative(PHOTOS_DIR, f));
    if (sz < MIN_FILE_BYTES) warn(`tiny image (${(sz / 1024).toFixed(0)} KB): ${relative(PHOTOS_DIR, f)}`);
    if (sz > MAX_FILE_BYTES) warn(`oversized image (${(sz / 1024 / 1024).toFixed(1)} MB): ${relative(PHOTOS_DIR, f)}`);
  }
  folderStats.push({ folder, isCommunity, count: files.length, hasSource, sourceStatus, sizes });
  if (files.length === 0) critical(`empty folder: ${folder}`);
  else if (files.length < minExpected) warn(`thin folder (${files.length} photos, expected ≥${minExpected}): ${folder}`);
  if (!hasSource) warn(`missing _source.json: ${folder}`);
  const referenced = isCommunity ? refCommunity.has(folder) : refUnit.has(folder);
  if (!referenced) warn(`folder not referenced in ${DATA_FILE}: ${folder}`);
}

// Cross-folder duplicate detection (per-folder dups & between-folder dups)
const intraFolderDups = [];
const interFolderDups = [];
for (const [hash, paths] of allHashes) {
  if (paths.length < 2) continue;
  const folders = new Set(paths.map((p) => p.split("/")[0]));
  if (folders.size === 1) intraFolderDups.push(paths);
  else interFolderDups.push({ folders: [...folders], paths });
}
for (const dup of intraFolderDups) critical(`duplicate image inside one folder: ${dup.join(" == ")}`);
for (const dup of interFolderDups) {
  const onlyCommunity = dup.folders.every((f) => f.startsWith("community-"));
  if (onlyCommunity) info(`shared community image (${dup.folders.join(", ")}): ${dup.paths[0]}`);
  else critical(`SAME image in different unit/property folders [${dup.folders.join(", ")}]: ${dup.paths.join(" == ")}`);
}

// Folders shared across multiple units in data
for (const [folder, count] of refUnit) {
  if (count > 1) warn(`photoFolder "${folder}" referenced by ${count} units (photos may not match each unit individually)`);
}

// Report
console.log(`\nNexStay photo audit — ${folderEntries.length} folders, ${[...allHashes.values()].reduce((a, b) => a + b.length, 0)} files\n`);
const fmt = (label, arr) => {
  console.log(`${label} (${arr.length})`);
  for (const m of arr) console.log(`  - ${m}`);
  console.log();
};
fmt("CRITICAL", findings.critical);
fmt("WARN", findings.warn);
fmt("INFO", findings.info);
console.log("Folder summary:");
for (const s of folderStats) {
  const flag = (s.sourceStatus ?? (s.hasSource ? "?" : "no-src")).padEnd(13);
  console.log(`  ${flag} ${s.isCommunity ? "C" : "U"} ${s.folder.padEnd(34)} ${String(s.count).padStart(3)} photos`);
}
process.exit(findings.critical.length > 0 ? 1 : 0);
