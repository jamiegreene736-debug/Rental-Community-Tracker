// Perceptual hashing for photo deduplication and theft detection.
//
// We use dHash (difference hash). For each photo:
//   1. Resize to 9x8 grayscale.
//   2. Compare each pixel to the one to its right → 64 bits.
//   3. Encode as a 16-char hex string.
//
// Two photos are "the same image" when their dHashes have a hamming
// distance ≤ DUPLICATE_DISTANCE. The default of 5 catches:
//   - Lossy recompression (JPEG→JPEG or JPEG→WebP)
//   - Resize (1920px → 1024px and back)
//   - Light crop (≤ 5% of the frame)
//   - Watermark removal in a corner
// Without firing on actually-different photos of the same room.
//
// Stored in photo_labels.perceptual_hash. Computed inline by
// downloadAndPrioritize() during scrape, and backfilled lazily for
// legacy rows by `backfillFolderHashes()` (called by the photo-listing
// scanner before it picks heros, so the smart selector and re-theft
// checker always have hashes to work with).

import sharp from "sharp";
import path from "path";
import fs from "fs";
import { storage } from "./storage";

const HASH_BITS = 64;
export const DUPLICATE_DISTANCE = 5;

// Compute a 16-char hex dHash from a JPEG/PNG/WebP buffer. Throws on
// unreadable input — caller decides whether to swallow.
export async function computeDhash(buffer: Buffer): Promise<string> {
  // 9x8 grayscale → 8 columns of 9 pixels each. dHash compares each
  // pixel with its right neighbor, giving 8x8 = 64 bits. We use the
  // 9x8 (width=9, height=8) shape because that matches the canonical
  // dHash algorithm — 9 columns produce 8 left-vs-right comparisons
  // per row.
  const { data, info } = await sharp(buffer)
    .grayscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== 9 || info.height !== 8 || data.length !== 72) {
    throw new Error(`unexpected raw shape ${info.width}x${info.height} (${data.length} bytes)`);
  }
  let bits = "";
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = data[row * 9 + col];
      const right = data[row * 9 + col + 1];
      bits += left > right ? "1" : "0";
    }
  }
  // 64 bits → 16 hex chars. Build in 8-bit (2-hex-char) groups so we
  // don't hit BigInt issues on Node.
  let hex = "";
  for (let i = 0; i < HASH_BITS; i += 8) {
    const byte = parseInt(bits.slice(i, i + 8), 2);
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

// Hamming distance between two equal-length hex hashes. Returns
// HASH_BITS (worst case) for malformed input rather than throwing —
// callers treat unknown-vs-known as "not a match" and move on.
export function hammingDistance(a: string, b: string): number {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return HASH_BITS;
  let diff = 0;
  for (let i = 0; i < a.length; i += 2) {
    const x = parseInt(a.slice(i, i + 2), 16);
    const y = parseInt(b.slice(i, i + 2), 16);
    if (Number.isNaN(x) || Number.isNaN(y)) return HASH_BITS;
    let xor = x ^ y;
    while (xor) {
      diff += xor & 1;
      xor >>>= 1;
    }
  }
  return diff;
}

// True if two hashes are within DUPLICATE_DISTANCE — i.e. likely the
// same image up to recompression / light crop / watermark removal.
export function isDuplicateHash(a: string, b: string, tolerance = DUPLICATE_DISTANCE): boolean {
  return hammingDistance(a, b) <= tolerance;
}

// Backfill perceptual_hash for any photos in a folder that don't have
// one yet. Idempotent: skips rows that already have a hash. Errors
// per-file are logged and the loop continues — a single unreadable
// jpeg shouldn't poison the whole folder.
//
// Returns { computed, skipped, errored } counts.
export async function backfillFolderHashes(folder: string): Promise<{ computed: number; skipped: number; errored: number }> {
  const photosRoot = path.join(process.cwd(), "client/public/photos");
  const folderPath = path.join(photosRoot, folder);
  const stat = await fs.promises.stat(folderPath).catch(() => null);
  if (!stat?.isDirectory()) return { computed: 0, skipped: 0, errored: 0 };

  const labels = await storage.getPhotoLabelsByFolder(folder);
  let computed = 0;
  let skipped = 0;
  let errored = 0;
  for (const row of labels) {
    if (row.perceptualHash) { skipped++; continue; }
    const filePath = path.join(folderPath, row.filename);
    try {
      const buf = await fs.promises.readFile(filePath);
      const hash = await computeDhash(buf);
      await storage.updatePhotoLabelHash(folder, row.filename, hash);
      computed++;
    } catch (e: any) {
      console.error(`[photo-hashing] backfill ${folder}/${row.filename}: ${e?.message ?? e}`);
      errored++;
    }
  }
  if (computed > 0 || errored > 0) {
    console.log(`[photo-hashing] backfill ${folder}: computed=${computed} skipped=${skipped} errored=${errored}`);
  }
  return { computed, skipped, errored };
}
