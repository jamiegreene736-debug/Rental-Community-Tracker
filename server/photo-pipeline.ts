// Download + label + prioritize pipeline for unit photos.
//
// Problem this solves: the scraper returns photos in Apify's arbitrary order.
// If we take the first N, we can miss bedroom/bathroom shots that happen to
// sit past position N (the probe would show bedrooms exist, but the download
// trim would drop them).
//
// Methodology:
//   1. Download every scraped URL to a temp filename in the unit's folder.
//   2. Label every downloaded photo via Claude Haiku vision.
//   3. Sort by category priority (Bedrooms → Bathrooms → Living → Dining →
//      Kitchen → Lanai → Views → Exterior → Other). Ties broken by original
//      scrape order (preserves the listing's intended sequence).
//   4. Rename the top N to photo_00.jpg, photo_01.jpg, ... in sorted order.
//   5. Delete the rest.
//   6. Persist labels keyed by the final filename.
//
// Consequence: if a listing has ANY bedroom photos anywhere in its 60+ image
// carousel, they're guaranteed to be in the kept top-N set because they sort
// first. No more "probe said yes but downloaded set has no bedrooms."

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { labelPhoto } from "./photo-labeler";
import { storage } from "./storage";

// Category priority. Lower index = higher priority (kept first).
// Matches the vocabulary the unit-kind prompt returns in photo-labeler.ts.
const CATEGORY_PRIORITY: Record<string, number> = {
  "Bedrooms":          0,
  "Bathrooms":         1,
  "Living Areas":      2,
  "Dining":            3,
  "Kitchen":           4,
  "Outdoor & Lanai":   5,
  "Views":             6,
  "Building Exterior": 7,
  "Other":             8,
};
const UNKNOWN_PRIORITY = 99;
const REJECT_CATEGORY = "Reject";

// Per-category cap for the kept set. Prevents a category-dominated listing
// (e.g. Zillow MLS with 10 kitchen angles) from crowding out bedrooms or
// outdoor shots. Total across all categories should be at or below the
// caller's maxKeep.
const PER_CATEGORY_CAP: Record<string, number> = {
  "Bedrooms":          6,
  "Bathrooms":         5,
  "Living Areas":      4,
  "Kitchen":           4,
  "Dining":            2,
  "Outdoor & Lanai":   4,
  "Views":             2,
  "Building Exterior": 2,
  "Other":             2,
};

type DownloadResult = {
  tempName: string;
  url: string;
  originalIndex: number;
};

type LabeledResult = DownloadResult & {
  label: string | null;
  category: string | null;
};

const LABEL_CONCURRENCY = 8;

// Returns the MD5 of the bytes we wrote (hex) on success, null on failure.
// Caller uses the hash to dedupe — two URLs with identical bytes collapse
// to one saved file.
async function downloadOne(srcUrl: string, destPath: string): Promise<string | null> {
  try {
    const r = await fetch(srcUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; VacationRentalBot/1.0)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 5000) return null;
    const hash = crypto.createHash("md5").update(buf).digest("hex");
    await fs.promises.writeFile(destPath, buf);
    return hash;
  } catch {
    return null;
  }
}

// Run an async mapper over items with bounded concurrency.
async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

export type DownloadAndPrioritizeResult = {
  downloaded: number;
  labeled: number;
  kept: number;
  dropped: number;
  bedroomCount: number;
  bathroomCount: number;
  categorySummary: Record<string, number>;
  keptFilenames: string[];
};

// Main pipeline. Scrapes a Zillow URL, downloads every photo, labels every
// photo via Claude Haiku, sorts by category priority, keeps top N, wipes the
// rest, and persists labels under the kept filenames.
//
// Safe to call concurrently for different folders; NOT safe to call twice for
// the same folder simultaneously (last write wins).
export async function downloadAndPrioritize(opts: {
  folder: string;
  folderPath: string;
  scrapedUrls: string[];
  maxKeep: number;
  anthropicKey: string | undefined;
  kind: "unit" | "community";
  model?: string;
}): Promise<DownloadAndPrioritizeResult> {
  const { folder, folderPath, scrapedUrls, maxKeep, anthropicKey, kind } = opts;
  await fs.promises.mkdir(folderPath, { recursive: true });

  // Step 0: clear existing images. Leave _source.json + other metadata.
  const existing = await fs.promises.readdir(folderPath).catch(() => []);
  for (const f of existing) {
    if (/\.(jpg|jpeg|png|webp)$/i.test(f)) {
      await fs.promises.unlink(path.join(folderPath, f)).catch(() => {});
    }
  }

  // Step 1: download each URL to a temp filename. The _pending_ prefix keeps
  // them distinguishable from final photo_NN.jpg names so we can clean up
  // correctly even if the process dies mid-run.
  //
  // SECOND-LINE DEDUPE: track MD5 of the bytes we write. If two URLs
  // return identical content (a real problem — Zillow serves the same
  // photo under multiple filename variants and the URL-level dedupe
  // can miss some), drop the duplicate immediately and move on.
  const downloaded: DownloadResult[] = [];
  const seenHashes = new Set<string>();
  let duplicateCount = 0;
  for (let i = 0; i < scrapedUrls.length; i++) {
    const tempName = `_pending_${String(i).padStart(3, "0")}.jpg`;
    const dest = path.join(folderPath, tempName);
    const hash = await downloadOne(scrapedUrls[i], dest);
    if (!hash) continue;
    if (seenHashes.has(hash)) {
      // Byte-for-byte duplicate of one we already kept — discard.
      await fs.promises.unlink(dest).catch(() => {});
      duplicateCount++;
      continue;
    }
    seenHashes.add(hash);
    downloaded.push({ tempName, url: scrapedUrls[i], originalIndex: i });
  }
  if (duplicateCount > 0) {
    console.log(`[downloadAndPrioritize] ${folder}: dropped ${duplicateCount} byte-identical duplicates`);
  }

  if (downloaded.length === 0) {
    return { downloaded: 0, labeled: 0, kept: 0, dropped: 0, bedroomCount: 0, bathroomCount: 0, categorySummary: {}, keptFilenames: [] };
  }

  // Step 2: label every download in parallel batches. If no Anthropic key,
  // we skip labeling and fall back to scrape order.
  let labeledResults: LabeledResult[];
  if (anthropicKey) {
    labeledResults = await mapConcurrent(downloaded, LABEL_CONCURRENCY, async (d) => {
      try {
        const res = await labelPhoto(path.join(folderPath, d.tempName), kind, anthropicKey);
        return { ...d, label: res?.label ?? null, category: res?.category ?? null };
      } catch {
        return { ...d, label: null, category: null };
      }
    });
  } else {
    labeledResults = downloaded.map((d) => ({ ...d, label: null, category: null }));
  }

  // Step 3a: drop explicitly-rejected photos (agent headshots, logos,
  // unrelated marketing images). Claude Haiku flagged them with category
  // "Reject" via the strict prompt. Delete their files too.
  const rejectedResults = labeledResults.filter((r) => r.category === REJECT_CATEGORY);
  for (const r of rejectedResults) {
    await fs.promises.unlink(path.join(folderPath, r.tempName)).catch(() => {});
  }
  const survivors = labeledResults.filter((r) => r.category !== REJECT_CATEGORY);
  if (rejectedResults.length > 0) {
    console.log(`[downloadAndPrioritize] ${folder}: dropped ${rejectedResults.length} rejected photos (agents/logos/etc)`);
  }

  // Step 3b: sort by category priority, ties broken by original scrape order.
  survivors.sort((a, b) => {
    const aPri = a.category ? (CATEGORY_PRIORITY[a.category] ?? UNKNOWN_PRIORITY) : UNKNOWN_PRIORITY;
    const bPri = b.category ? (CATEGORY_PRIORITY[b.category] ?? UNKNOWN_PRIORITY) : UNKNOWN_PRIORITY;
    if (aPri !== bPri) return aPri - bPri;
    return a.originalIndex - b.originalIndex;
  });

  // Step 4: keep top N with per-category caps. This prevents a kitchen-heavy
  // listing (10 kitchen shots + 2 bedroom shots) from pushing the bedrooms
  // off the end of the kept set. Caps are tuned in PER_CATEGORY_CAP above.
  const kept: LabeledResult[] = [];
  const dropped: LabeledResult[] = [];
  const perCategoryCounts: Record<string, number> = {};
  for (const r of survivors) {
    if (kept.length >= maxKeep) { dropped.push(r); continue; }
    const cat = r.category ?? "Other";
    const cap = PER_CATEGORY_CAP[cat] ?? 2;  // unknown categories cap at 2
    const seen = perCategoryCounts[cat] ?? 0;
    if (seen >= cap) { dropped.push(r); continue; }
    kept.push(r);
    perCategoryCounts[cat] = seen + 1;
  }
  for (const d of dropped) {
    await fs.promises.unlink(path.join(folderPath, d.tempName)).catch(() => {});
  }

  // Step 5: rename kept in sorted order to photo_00.jpg, photo_01.jpg, ...
  // Two-step rename (temp → _renaming_NN → photo_NN) avoids filename
  // collisions when the sorted order overlaps the temp order.
  const keptFilenames: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    const stage = path.join(folderPath, `_renaming_${String(i).padStart(3, "0")}.jpg`);
    await fs.promises.rename(path.join(folderPath, kept[i].tempName), stage);
  }
  for (let i = 0; i < kept.length; i++) {
    const finalName = `photo_${String(i).padStart(2, "0")}.jpg`;
    const stage = path.join(folderPath, `_renaming_${String(i).padStart(3, "0")}.jpg`);
    await fs.promises.rename(stage, path.join(folderPath, finalName));
    keptFilenames.push(finalName);
  }

  // Step 6: persist labels under final filenames.
  if (anthropicKey) {
    await storage.deletePhotoLabelsByFolder(folder).catch(() => {});
    for (let i = 0; i < kept.length; i++) {
      const k = kept[i];
      if (k.label) {
        await storage.upsertPhotoLabel({
          folder,
          filename: keptFilenames[i],
          label: k.label,
          category: k.category ?? "Other",
          model: opts.model ?? "claude-haiku-4-5",
        }).catch(() => {});
      }
    }
  }

  const categorySummary: Record<string, number> = {};
  for (const r of kept) {
    const key = r.category ?? "Unlabeled";
    categorySummary[key] = (categorySummary[key] ?? 0) + 1;
  }

  return {
    downloaded: downloaded.length,
    labeled: labeledResults.filter((r) => r.label).length,
    kept: kept.length,
    dropped: dropped.length + rejectedResults.length,
    bedroomCount: kept.filter((k) => k.category === "Bedrooms").length,
    bathroomCount: kept.filter((k) => k.category === "Bathrooms").length,
    categorySummary,
    keptFilenames,
  };
}
