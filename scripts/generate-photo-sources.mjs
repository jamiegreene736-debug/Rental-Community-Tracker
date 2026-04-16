#!/usr/bin/env node
/**
 * Generate _source.json metadata stubs for every folder under client/public/photos.
 * Pulls property/unit info from client/src/data/unit-builder-data.ts.
 *
 *   --force   overwrite existing _source.json files
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const PHOTOS_DIR = "client/public/photos";
const DATA_FILE = "client/src/data/unit-builder-data.ts";
const FORCE = process.argv.includes("--force");
const TODAY = new Date().toISOString().slice(0, 10);

const lines = readFileSync(DATA_FILE, "utf8").split("\n");

// Single-pass scan, tracking current property + current unit.
const properties = []; // { propertyId, name, address, communityPhotoFolder, units: [{ unitId, unitNumber, bedrooms, bathrooms, photoFolder }] }
let cur = null;
let curUnit = null;
const grab = (line, key) => {
  const m = line.match(new RegExp(`\\b${key}:\\s*"([^"]+)"`));
  return m ? m[1] : undefined;
};
const grabNum = (line, key) => {
  const m = line.match(new RegExp(`\\b${key}:\\s*(\\d+)`));
  return m ? Number(m[1]) : undefined;
};

for (const line of lines) {
  const pid = grabNum(line, "propertyId");
  if (pid !== undefined) {
    if (cur) properties.push(cur);
    cur = { propertyId: pid, name: undefined, address: undefined, communityPhotoFolder: undefined, units: [] };
    curUnit = null;
    continue;
  }
  if (!cur) continue;
  const name = grab(line, "name");
  if (name && cur.name === undefined && !curUnit) cur.name = name;
  const addr = grab(line, "address");
  if (addr) cur.address = addr;
  const cpf = grab(line, "communityPhotoFolder");
  if (cpf) cur.communityPhotoFolder = cpf;
  const uid = grab(line, "id");
  if (uid && /^id:/.test(line.trim())) {
    curUnit = { unitId: uid };
    cur.units.push(curUnit);
  }
  if (curUnit) {
    const un = grab(line, "unitNumber");
    if (un) curUnit.unitNumber = un;
    const br = grabNum(line, "bedrooms");
    if (br !== undefined) curUnit.bedrooms = br;
    const ba = grab(line, "bathrooms");
    if (ba) curUnit.bathrooms = ba;
    const pf = grab(line, "photoFolder");
    if (pf) curUnit.photoFolder = pf;
  }
}
if (cur) properties.push(cur);

// Reverse index
const unitFolderRefs = new Map();
const communityFolderRefs = new Map();
for (const p of properties) {
  if (p.communityPhotoFolder) {
    if (!communityFolderRefs.has(p.communityPhotoFolder)) communityFolderRefs.set(p.communityPhotoFolder, []);
    communityFolderRefs.get(p.communityPhotoFolder).push({ propertyId: p.propertyId, propertyName: p.name, address: p.address });
  }
  for (const u of p.units) {
    if (!u.photoFolder) continue;
    if (!unitFolderRefs.has(u.photoFolder)) unitFolderRefs.set(u.photoFolder, []);
    unitFolderRefs.get(u.photoFolder).push({
      propertyId: p.propertyId,
      propertyName: p.name,
      address: p.address,
      unitId: u.unitId,
      unitNumber: u.unitNumber,
      bedrooms: u.bedrooms,
      bathrooms: u.bathrooms,
    });
  }
}

const folders = readdirSync(PHOTOS_DIR).filter((d) => statSync(join(PHOTOS_DIR, d)).isDirectory());

let written = 0, skipped = 0;
for (const folder of folders) {
  const sourcePath = join(PHOTOS_DIR, folder, "_source.json");
  if (!FORCE && existsSync(sourcePath)) {
    // For previously-written stubs, regenerate if they were marked "unused" but data now references them
    try {
      const existing = JSON.parse(readFileSync(sourcePath, "utf8"));
      if (existing.verifiedBy !== "auto-generated-stub") { skipped++; continue; }
    } catch { /* fall through and regenerate */ }
  }

  const isCommunity = folder.startsWith("community-");
  const refs = isCommunity ? communityFolderRefs.get(folder) : unitFolderRefs.get(folder);
  const used = Array.isArray(refs) && refs.length > 0;

  const stub = {
    folder,
    type: isCommunity ? "community" : (used ? "unit" : "unused"),
    referencedBy: refs ?? [],
    verificationStatus: used ? "needs-review" : "unused",
    verifiedDate: TODAY,
    verifiedBy: "auto-generated-stub",
    sourceListing: { url: null, platform: null, scrapedDate: null },
    notes: used
      ? "Auto-generated stub. Set verificationStatus to 'verified' once each photo has been confirmed against sourceListing.url. See replit.md → Unit Photo Verification Methodology."
      : "Folder is not referenced in unit-builder-data.ts. Either wire it up to a property/unit or delete the folder.",
  };

  if (used && !isCommunity) {
    stub.bedrooms = refs[0].bedrooms;
    stub.bathrooms = refs[0].bathrooms;
    if (refs.length > 1) {
      stub.notes = `Folder is shared by ${refs.length} units across propertyIds [${refs.map(r => r.propertyId).join(", ")}]. Photos must be visually generic enough for every unit, OR each unit needs its own folder. ` + stub.notes;
    }
  }

  writeFileSync(sourcePath, JSON.stringify(stub, null, 2) + "\n");
  written++;
}

console.log(`generate-photo-sources: wrote ${written}, skipped ${skipped} (use --force to overwrite manual edits)`);
console.log(`indexed ${properties.length} properties, ${unitFolderRefs.size} unique unit folders, ${communityFolderRefs.size} unique community folders`);
