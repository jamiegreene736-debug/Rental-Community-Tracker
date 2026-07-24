import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type FingerprintCacheEntry = {
  size: number;
  mtimeMs: number;
  fingerprint: string;
};

const fingerprintCache = new Map<string, FingerprintCacheEntry>();
const MAX_CACHE_ENTRIES = 20_000;

async function fileFingerprint(absolutePath: string): Promise<string | null> {
  try {
    const stat = await fs.promises.stat(absolutePath);
    if (!stat.isFile()) return null;
    const cached = fingerprintCache.get(absolutePath);
    if (cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return cached.fingerprint;
    }
    const fingerprint = createHash("sha256")
      .update(await fs.promises.readFile(absolutePath))
      .digest("hex");
    if (fingerprintCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = fingerprintCache.keys().next().value;
      if (oldest) fingerprintCache.delete(oldest);
    }
    fingerprintCache.set(absolutePath, { size: stat.size, mtimeMs: stat.mtimeMs, fingerprint });
    return fingerprint;
  } catch {
    return null;
  }
}

/**
 * Keep the first occurrence of each byte-identical local image.
 *
 * Guesty collapses identical image bytes even when they were uploaded under
 * different filenames/URLs. Counting those aliases as separate pictures makes
 * an otherwise successful whole-gallery replacement look one photo short.
 * Unreadable or invalid paths remain so normal validation reports the error.
 */
export async function dedupeLocalPhotoItems<T>(
  items: readonly T[],
  absolutePathFor: (item: T) => string | null,
): Promise<{ unique: T[]; duplicates: Array<{ item: T; duplicateOf: T }> }> {
  const unique: T[] = [];
  const duplicates: Array<{ item: T; duplicateOf: T }> = [];
  const firstByFingerprint = new Map<string, T>();
  const candidates = await Promise.all(items.map(async (item) => {
    const rawPath = absolutePathFor(item);
    if (!rawPath) return { item, absolutePath: null, size: null };
    const absolutePath = path.resolve(rawPath);
    try {
      const stat = await fs.promises.stat(absolutePath);
      return stat.isFile()
        ? { item, absolutePath, size: stat.size }
        : { item, absolutePath: null, size: null };
    } catch {
      return { item, absolutePath: null, size: null };
    }
  }));
  const countBySize = new Map<number, number>();
  for (const candidate of candidates) {
    if (candidate.size != null) {
      countBySize.set(candidate.size, (countBySize.get(candidate.size) ?? 0) + 1);
    }
  }

  for (const { item, absolutePath, size } of candidates) {
    // Exact duplicates must have equal byte length. Avoid reading/hashing the
    // overwhelmingly common unique-size files on every gallery load.
    const fingerprint = absolutePath && size != null && (countBySize.get(size) ?? 0) > 1
      ? await fileFingerprint(absolutePath)
      : null;
    if (!fingerprint) {
      unique.push(item);
      continue;
    }
    if (firstByFingerprint.has(fingerprint)) {
      duplicates.push({ item, duplicateOf: firstByFingerprint.get(fingerprint)! });
      continue;
    }
    firstByFingerprint.set(fingerprint, item);
    unique.push(item);
  }
  return { unique, duplicates };
}
