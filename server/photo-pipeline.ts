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

// Parse the bed type from a bedroom label like "King Bedroom" or
// "Two Queens Bedroom" → "King" / "Two Queens" / etc. Returns null if
// no recognizable bed type is in the label.
function detectBedType(label: string): string | null {
  const lower = label.toLowerCase();
  if (/\btwo queens?\b/.test(lower)) return "Two Queens";
  if (/\btwo kings?\b/.test(lower))  return "Two Kings";
  if (/\btwo doubles?\b/.test(lower)) return "Two Doubles";
  if (/\bbunk\b/.test(lower))        return "Bunk Beds";
  if (/\bking\b/.test(lower))        return "King";
  if (/\bqueen\b/.test(lower))       return "Queen";
  if (/\btwin\b/.test(lower))        return "Twin";
  if (/\bdouble\b/.test(lower))      return "Double";
  if (/\bfull\b/.test(lower))        return "Full";
  return null;
}

// Detect a bathroom's defining feature from its label, used to dedupe
// photos of the same bathroom from multiple angles.
function detectBathFingerprint(label: string): string {
  const lower = label.toLowerCase();
  if (/\bhalf\b/.test(lower))        return "Half";
  if (/\bjetted\b/.test(lower))      return "Jetted Tub";
  if (/\bdouble vanity|double sink/.test(lower)) return "Double Vanity";
  if (/\btub\b/.test(lower))         return "Tub";
  if (/\bshower\b/.test(lower))      return "Shower";
  return "Generic";
}

// Post-process bedroom photos: group by bed type, pick the master (King
// preferred, then largest group), number the rest as Bedroom 2, 3, ...
// Rewrites the .label field in place. Also caps at MAX_PER_BED_TYPE
// photos per unique bed type to avoid 5 shots of the same room.
const MAX_PER_BED_TYPE = 2;
const MAX_PER_BATH_TYPE = 1;

function coalesceBedrooms(items: LabeledResult[]): LabeledResult[] {
  if (items.length === 0) return items;
  // Bucket by bed type. Items with no recognized bed type land in "Unknown".
  const byType = new Map<string, LabeledResult[]>();
  const order: string[] = [];
  for (const it of items) {
    const bt = detectBedType(it.label ?? "") ?? "Unknown";
    if (!byType.has(bt)) { byType.set(bt, []); order.push(bt); }
    byType.get(bt)!.push(it);
  }
  // Pick master: King group first, else largest group.
  let masterType: string;
  if (byType.has("King") && (byType.get("King")?.length ?? 0) > 0) {
    masterType = "King";
  } else if (byType.has("Two Kings") && (byType.get("Two Kings")?.length ?? 0) > 0) {
    masterType = "Two Kings";
  } else {
    masterType = [...byType.entries()].sort((a, b) => b[1].length - a[1].length)[0][0];
  }
  // Number bedrooms. Master first, then iterate the rest in original order.
  let bedroomNum = 2;
  const out: LabeledResult[] = [];
  const renderType = (bt: string) => bt === "Unknown" ? "" : ` — ${bt}`;
  // Master first
  const masterItems = (byType.get(masterType) ?? []).slice(0, MAX_PER_BED_TYPE);
  masterItems.forEach((it, i) => {
    it.label = i === 0 ? `Master Bedroom${renderType(masterType)}` : `Master Bedroom — Alt View`;
    out.push(it);
  });
  // Other bedrooms in original encounter order
  for (const bt of order) {
    if (bt === masterType) continue;
    const slice = (byType.get(bt) ?? []).slice(0, MAX_PER_BED_TYPE);
    slice.forEach((it, i) => {
      it.label = i === 0 ? `Bedroom ${bedroomNum}${renderType(bt)}` : `Bedroom ${bedroomNum} — Alt View`;
      out.push(it);
    });
    if (slice.length > 0) bedroomNum++;
  }
  return out;
}

// Same idea for bathrooms — Primary, then Guest/Hall numbered.
function coalesceBathrooms(items: LabeledResult[]): LabeledResult[] {
  if (items.length === 0) return items;
  const byFp = new Map<string, LabeledResult[]>();
  const order: string[] = [];
  for (const it of items) {
    const fp = detectBathFingerprint(it.label ?? "");
    if (!byFp.has(fp)) { byFp.set(fp, []); order.push(fp); }
    byFp.get(fp)!.push(it);
  }
  // Primary = first non-Half group (Primary bathroom is rarely a half bath)
  const primaryFp = order.find((fp) => fp !== "Half") ?? order[0];
  let bathNum = 2;
  const out: LabeledResult[] = [];
  const renderFp = (fp: string) => fp === "Generic" ? "" : ` — ${fp}`;
  const primaryItems = (byFp.get(primaryFp) ?? []).slice(0, MAX_PER_BATH_TYPE);
  primaryItems.forEach((it) => {
    it.label = `Primary Bathroom${renderFp(primaryFp)}`;
    out.push(it);
  });
  for (const fp of order) {
    if (fp === primaryFp) continue;
    const slice = (byFp.get(fp) ?? []).slice(0, MAX_PER_BATH_TYPE);
    slice.forEach((it) => {
      const lab = fp === "Half" ? "Half Bath" : `Bathroom ${bathNum}${renderFp(fp)}`;
      it.label = lab;
      out.push(it);
    });
    if (slice.length > 0 && fp !== "Half") bathNum++;
  }
  return out;
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
  bedroomCount: number;          // unique bedrooms detected (one per bed type)
  bathroomCount: number;         // unique bathrooms detected
  bedroomTypes: string[];        // ["King", "Queen", "Twin"]
  bathroomTypes: string[];
  coverage: {
    bedroomsExpected: number | null;
    bedroomsFound: number;
    bedroomsShortfall: number;   // 0 = good, positive = listing missing rooms
    bathroomsExpected: number | null;
    bathroomsFound: number;
    bathroomsShortfall: number;
  };
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
  // When set, the result.coverage block reports whether we found enough
  // unique bedrooms/bathrooms to match the unit's claimed counts.
  requiredBedrooms?: number;
  requiredBathrooms?: number;
}): Promise<DownloadAndPrioritizeResult> {
  const { folder, folderPath, scrapedUrls, maxKeep, anthropicKey, kind, requiredBedrooms, requiredBathrooms } = opts;
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
    return {
      downloaded: 0, labeled: 0, kept: 0, dropped: 0,
      bedroomCount: 0, bathroomCount: 0,
      bedroomTypes: [], bathroomTypes: [],
      coverage: {
        bedroomsExpected: requiredBedrooms ?? null, bedroomsFound: 0,
        bedroomsShortfall: requiredBedrooms ?? 0,
        bathroomsExpected: requiredBathrooms ?? null, bathroomsFound: 0,
        bathroomsShortfall: requiredBathrooms ?? 0,
      },
      categorySummary: {}, keptFilenames: [],
    };
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
  let survivors = labeledResults.filter((r) => r.category !== REJECT_CATEGORY);
  if (rejectedResults.length > 0) {
    console.log(`[downloadAndPrioritize] ${folder}: dropped ${rejectedResults.length} rejected photos (agents/logos/etc)`);
  }

  // Step 3a.5 (NEW): Coalesce bedrooms and bathrooms.
  //
  // Bedrooms: group by bed type (King / Queen / Twin / Two Queens / etc.)
  // detected from the label. Each unique bed type is one distinct room.
  // Pick "Master Bedroom" = the King group (or biggest if no King). Number
  // the rest as "Bedroom 2", "Bedroom 3". Cap each bed type at 2 photos to
  // prevent same-room-five-times duplication.
  //
  // Bathrooms: similar logic with fixture profiles (Tub vs Shower vs
  // Double Vanity vs Half). Primary bathroom + numbered guest bathrooms.
  //
  // The non-bedroom/bathroom photos pass through unchanged.
  const bedroomItems = survivors.filter((r) => r.category === "Bedrooms");
  const bathroomItems = survivors.filter((r) => r.category === "Bathrooms");
  const otherItems = survivors.filter((r) => r.category !== "Bedrooms" && r.category !== "Bathrooms");
  const coalescedBedrooms = coalesceBedrooms(bedroomItems);
  const coalescedBathrooms = coalesceBathrooms(bathroomItems);
  // Files that got dropped during coalesce (excess same-bed-type photos)
  // need to be unlinked.
  const keptIds = new Set([...coalescedBedrooms, ...coalescedBathrooms].map((r) => r.tempName));
  const coalesceDropped = [...bedroomItems, ...bathroomItems].filter((r) => !keptIds.has(r.tempName));
  for (const r of coalesceDropped) {
    await fs.promises.unlink(path.join(folderPath, r.tempName)).catch(() => {});
  }
  if (coalesceDropped.length > 0) {
    console.log(`[downloadAndPrioritize] ${folder}: coalesced ${coalesceDropped.length} duplicate-room shots`);
  }
  survivors = [...coalescedBedrooms, ...coalescedBathrooms, ...otherItems];

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

  // Unique bedroom types in the kept set = how many distinct bedrooms we
  // have photos of. (Two photos of "King Bedroom" still count as one room.)
  const bedroomTypesSet = new Set<string>();
  for (const k of kept) {
    if (k.category === "Bedrooms") {
      const bt = detectBedType(k.label ?? "");
      // After coalesce the label format is "Master Bedroom — King" or
      // "Bedroom 2 — Queen", so the bed type detection here finds the
      // suffix. Items without a recognized type still count as one room.
      bedroomTypesSet.add(bt ?? `Unknown-${k.tempName}`);
    }
  }
  const bathroomTypesSet = new Set<string>();
  for (const k of kept) {
    if (k.category === "Bathrooms") {
      bathroomTypesSet.add(detectBathFingerprint(k.label ?? "") + "-" + (k.label ?? ""));
    }
  }
  const bedroomsFound = bedroomTypesSet.size;
  const bathroomsFound = bathroomTypesSet.size;

  if (requiredBedrooms && bedroomsFound < requiredBedrooms) {
    console.warn(`[downloadAndPrioritize] ${folder}: COVERAGE GAP — listing claims ${requiredBedrooms} bedrooms but only ${bedroomsFound} unique ones detected`);
  }

  return {
    downloaded: downloaded.length,
    labeled: labeledResults.filter((r) => r.label).length,
    kept: kept.length,
    dropped: dropped.length + rejectedResults.length + coalesceDropped.length,
    bedroomCount: bedroomsFound,
    bathroomCount: bathroomsFound,
    bedroomTypes: Array.from(bedroomTypesSet),
    bathroomTypes: Array.from(bathroomTypesSet),
    coverage: {
      bedroomsExpected: requiredBedrooms ?? null,
      bedroomsFound,
      bedroomsShortfall: Math.max(0, (requiredBedrooms ?? 0) - bedroomsFound),
      bathroomsExpected: requiredBathrooms ?? null,
      bathroomsFound,
      bathroomsShortfall: Math.max(0, (requiredBathrooms ?? 0) - bathroomsFound),
    },
    categorySummary,
    keptFilenames,
  };
}
