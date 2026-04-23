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
import sharp from "sharp";
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
  confidence: number;
};

// High-precision filter applied to Claude's initial category. The vision
// model occasionally misclassifies — a kitchen gets stamped "Bedrooms" when
// the photo has a bar area, or an outdoor patio shot lands in "Bathrooms".
// Two guards:
//   1) Label-text must semantically match the category. A "Bedrooms" photo
//      whose label is "Updated Kitchen" is a contradiction — the model's own
//      descriptive label is a more trustworthy signal than its category
//      choice, so we demote to "Other".
//   2) Low-confidence Bedroom/Bathroom claims get demoted. Those categories
//      carry the most downstream weight (Master Bedroom numbering, coverage
//      checks) so the cost of a false positive is high.
//
// Demotion to "Other" (not rejection) keeps the photo visible in the gallery
// but removes it from bedroom/bathroom coalesce inputs, preventing spurious
// "Master Bedroom" labels on kitchen shots.
const BEDROOM_KEYWORDS = /\b(bed|bedroom|suite|master|guest room|sleeping|primary|bunk|twin|queen|king|double|full)\b/i;
const BATHROOM_KEYWORDS = /\b(bath|bathroom|shower|tub|toilet|vanity|powder|half bath|lavatory|washroom|ensuite|en-suite|jetted)\b/i;
const KITCHEN_KEYWORDS = /\b(kitchen|cabinet|countertop|counter top|stove|oven|refrigerator|fridge|microwave|island|dishwasher|backsplash|pantry)\b/i;
// Applied to bedrooms and bathrooms specifically — rooms whose misclassification
// has expensive downstream consequences. 0.70 roughly matches "confident but
// not unambiguous" per our prompt's confidence-scoring rubric.
const MIN_CONFIDENCE_FOR_PRIVATE_ROOM = 0.70;

function applyCategorySanityCheck(r: LabeledResult): LabeledResult {
  if (!r.category || !r.label) return r;
  const label = r.label;
  const cat = r.category;

  // If the label text mentions kitchen fixtures but the category claims
  // Bedrooms/Bathrooms, the label wins — Claude saw a kitchen but picked
  // the wrong bucket.
  if ((cat === "Bedrooms" || cat === "Bathrooms") && KITCHEN_KEYWORDS.test(label)) {
    console.log(`[sanity] demoting "${label}" from ${cat}→Kitchen (label contains kitchen keywords)`);
    return { ...r, category: "Kitchen" };
  }
  // Category claims Bedrooms but label has no bed vocabulary anywhere.
  // Vision models sometimes drop the room type into category while the
  // descriptive label reflects what they actually saw.
  if (cat === "Bedrooms" && !BEDROOM_KEYWORDS.test(label)) {
    console.log(`[sanity] demoting "${label}" from Bedrooms→Other (label lacks bed keywords)`);
    return { ...r, category: "Other" };
  }
  if (cat === "Bathrooms" && !BATHROOM_KEYWORDS.test(label)) {
    console.log(`[sanity] demoting "${label}" from Bathrooms→Other (label lacks bath keywords)`);
    return { ...r, category: "Other" };
  }
  // Low-confidence Bedroom/Bathroom — Airbnb-style: require ≥0.70 before
  // we treat as authoritative. Below that, we'd rather surface the photo
  // uncategorized than force a wrong label.
  if ((cat === "Bedrooms" || cat === "Bathrooms") && r.confidence < MIN_CONFIDENCE_FOR_PRIVATE_ROOM) {
    console.log(`[sanity] demoting "${label}" from ${cat}→Other (confidence ${r.confidence.toFixed(2)} < ${MIN_CONFIDENCE_FOR_PRIVATE_ROOM})`);
    return { ...r, category: "Other" };
  }
  return r;
}

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

// Post-process bedroom photos: group by visual similarity (dHash) to
// identify distinct rooms, then pick the master (largest cluster, King-bed
// preferred) and number the rest as Bedroom 2, 3, ... Rewrites the .label
// field in place. Caps at MAX_PER_ROOM photos per unique room.
//
// PRIOR BUG: bucketing was by bed type, so two Queen-bed bedrooms collapsed
// into a single "room" with alt views and the unit appeared to have 1
// bedroom instead of 2. Visual similarity is the correct signal — different
// rooms look different regardless of whether their beds happen to match.
const MAX_PER_ROOM = 2;
const MAX_PER_BATH_TYPE = 1;
// Hamming distance threshold on 64-bit dHashes. Photos of the same room
// from different angles typically differ by ~0-14 bits; photos of entirely
// different rooms differ by 20+. 16 is the empirical middle that separates
// them reliably for vacation-rental photography.
const DHASH_SIMILARITY_THRESHOLD = 16;

// Perceptual hash (dHash): resize to 9x8 grayscale, compare each pixel to
// the one to its right, yield a 64-bit hash packed into 8 bytes. Two photos
// of the same room score 0-14 bits apart; photos of different rooms 20+.
// Stored as a Buffer (not bigint) to stay compatible with the repo's TS
// target — popcount is done byte-wise in hammingDistance64.
async function computeDHash(absPath: string): Promise<Buffer | null> {
  try {
    const { data } = await sharp(absPath)
      .greyscale()
      .resize(9, 8, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const hash = Buffer.alloc(8);
    for (let row = 0; row < 8; row++) {
      let byte = 0;
      for (let col = 0; col < 8; col++) {
        const left = data[row * 9 + col];
        const right = data[row * 9 + col + 1];
        byte = (byte << 1) | (left < right ? 1 : 0);
      }
      hash[row] = byte;
    }
    return hash;
  } catch {
    return null;
  }
}

// Precomputed popcount table for 0-255.
const POPCOUNT = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let n = i, c = 0;
    while (n) { c += n & 1; n >>= 1; }
    t[i] = c;
  }
  return t;
})();

function hammingDistance64(a: Buffer, b: Buffer): number {
  let d = 0;
  for (let i = 0; i < 8; i++) d += POPCOUNT[a[i] ^ b[i]];
  return d;
}

// Single-linkage clustering by dHash Hamming distance. Photos whose hashes
// are within threshold of any photo already in a cluster join that cluster.
// Items with null hashes each become their own cluster — we prefer a false
// positive (over-counting bedrooms by one) over a false negative.
function clusterByDHash(hashes: (Buffer | null)[], threshold: number): number[] {
  const clusterOf: number[] = new Array(hashes.length).fill(-1);
  let next = 0;
  for (let i = 0; i < hashes.length; i++) {
    if (clusterOf[i] !== -1) continue;
    clusterOf[i] = next;
    const hi = hashes[i];
    if (hi != null) {
      for (let j = i + 1; j < hashes.length; j++) {
        if (clusterOf[j] !== -1) continue;
        const hj = hashes[j];
        if (hj != null && hammingDistance64(hi, hj) <= threshold) {
          clusterOf[j] = next;
        }
      }
    }
    next++;
  }
  return clusterOf;
}

async function coalesceBedrooms(
  items: LabeledResult[],
  folderPath: string,
  maxRooms?: number,
): Promise<LabeledResult[]> {
  if (items.length === 0) return items;

  // Step 1: compute dHash per photo from the on-disk file.
  const hashes = await Promise.all(
    items.map((it) => computeDHash(path.join(folderPath, it.tempName)))
  );

  // Step 2: cluster by visual similarity — one cluster per distinct room.
  const clusterOf = clusterByDHash(hashes, DHASH_SIMILARITY_THRESHOLD);
  const clusters = new Map<number, LabeledResult[]>();
  let clusterOrder: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const c = clusterOf[i];
    if (!clusters.has(c)) { clusters.set(c, []); clusterOrder.push(c); }
    clusters.get(c)!.push(items[i]);
  }

  // Step 3: pick the master cluster. Prefer a cluster whose photos are
  // labeled with a King bed (common convention for primary bedroom). Tie-
  // break by cluster size (more photos usually = more-emphasized room).
  const clusterBedType = (c: number): string | null => {
    for (const it of clusters.get(c) ?? []) {
      const bt = detectBedType(it.label ?? "");
      if (bt) return bt;
    }
    return null;
  };
  const clusterSize = (c: number) => (clusters.get(c)?.length ?? 0);
  let masterCluster: number;
  const kingCluster = clusterOrder.find((c) => clusterBedType(c) === "King");
  if (kingCluster != null) {
    masterCluster = kingCluster;
  } else {
    const twoKings = clusterOrder.find((c) => clusterBedType(c) === "Two Kings");
    masterCluster = twoKings ?? clusterOrder.slice().sort((a, b) => clusterSize(b) - clusterSize(a))[0];
  }

  // Step 3.5: enforce the listing's declared bedroom count as a hard cap.
  // Vision models occasionally over-count — e.g. a daybed in a den, or dHash
  // splits one room into two clusters when photos are taken from opposite
  // ends. The listing's own bed count (from Zillow's structured data) is far
  // more reliable than photo inference. If we have more clusters than the
  // listing claims, drop the smallest non-master clusters until we match.
  if (maxRooms != null && clusterOrder.length > maxRooms) {
    const keep = new Set<number>([masterCluster]);
    const others = clusterOrder
      .filter((c) => c !== masterCluster)
      .sort((a, b) => clusterSize(b) - clusterSize(a));  // largest first
    for (const c of others.slice(0, maxRooms - 1)) keep.add(c);
    clusterOrder = clusterOrder.filter((c) => keep.has(c));
  }

  // Step 4: number rooms — master first, then the rest in encounter order.
  // Within each room, first photo gets the primary label (with bed type if
  // we detected one), additional photos labeled as alt views. Cap at
  // MAX_PER_ROOM photos per room.
  const out: LabeledResult[] = [];
  const renderType = (bt: string | null) => bt ? ` — ${bt}` : "";
  const labelCluster = (c: number, name: string) => {
    const bt = clusterBedType(c);
    const slice = (clusters.get(c) ?? []).slice(0, MAX_PER_ROOM);
    slice.forEach((it, i) => {
      it.label = i === 0 ? `${name}${renderType(bt)}` : `${name} — Alt View`;
      out.push(it);
    });
  };
  labelCluster(masterCluster, "Master Bedroom");
  let bedroomNum = 2;
  for (const c of clusterOrder) {
    if (c === masterCluster) continue;
    labelCluster(c, `Bedroom ${bedroomNum}`);
    bedroomNum++;
  }
  return out;
}

// Dedupe a room category (Kitchen, Living Areas, Dining) by visual
// similarity. Same dHash clustering as bedrooms, but without bed-type
// aware naming — we just keep one representative photo per distinct
// visual cluster. This catches the "4 Kitchen angles of the same
// kitchen" case where the labeler correctly tags each as Kitchen but
// we only want one of them.
//
// When multiple visually-distinct rooms exist (rare in one unit — e.g.
// a great room + separate family room both labeled "Living Areas"),
// each cluster contributes its own representative, so distinct rooms
// are preserved.
async function coalesceByVisualCluster(
  items: LabeledResult[],
  folderPath: string,
  keepPerCluster: number,
): Promise<LabeledResult[]> {
  if (items.length <= 1) return items;

  // First pass: group by normalized label text. When Claude gives the same
  // exact caption to multiple photos (e.g. 4× "Kitchen With Island"), treat
  // them as the same room — that's a stronger signal than dHash, which can
  // split wide-angle alt views of the same kitchen into "different" clusters
  // when the photos are taken from opposite ends.
  const normalize = (s: string | null) => (s ?? "").toLowerCase().trim().replace(/\s+/g, " ");
  const byLabel = new Map<string, LabeledResult[]>();
  const labelOrder: string[] = [];
  for (const it of items) {
    const key = normalize(it.label);
    if (!byLabel.has(key)) { byLabel.set(key, []); labelOrder.push(key); }
    byLabel.get(key)!.push(it);
  }

  // One representative per unique label. If there really are two distinct
  // kitchens in one unit, Claude typically gives them different labels
  // (e.g. "Updated Kitchen" vs "Galley Kitchen With Window") — so labels
  // diverge and both survive. If they share a label, they're the same room.
  const representatives: LabeledResult[] = [];
  for (const key of labelOrder) {
    const group = byLabel.get(key) ?? [];
    representatives.push(...group.slice(0, keepPerCluster));
  }

  // Second pass (safety net): even with different labels, dHash still
  // catches edge cases — e.g. Claude labels the same kitchen "Kitchen With
  // Island" once and "Modern Kitchen With Island" another time. Cluster the
  // label-unique representatives by dHash; within each visual cluster keep
  // only `keepPerCluster`.
  if (representatives.length <= 1) return representatives;
  const hashes = await Promise.all(
    representatives.map((it) => computeDHash(path.join(folderPath, it.tempName)))
  );
  const clusterOf = clusterByDHash(hashes, DHASH_SIMILARITY_THRESHOLD);
  const byCluster = new Map<number, LabeledResult[]>();
  const order: number[] = [];
  for (let i = 0; i < representatives.length; i++) {
    const c = clusterOf[i];
    if (!byCluster.has(c)) { byCluster.set(c, []); order.push(c); }
    byCluster.get(c)!.push(representatives[i]);
  }
  const out: LabeledResult[] = [];
  for (const c of order) {
    const slice = (byCluster.get(c) ?? []).slice(0, keepPerCluster);
    out.push(...slice);
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
        const labeled: LabeledResult = {
          ...d,
          label: res?.label ?? null,
          category: res?.category ?? null,
          confidence: res?.confidence ?? 0,
        };
        return applyCategorySanityCheck(labeled);
      } catch {
        return { ...d, label: null, category: null, confidence: 0 };
      }
    });
  } else {
    labeledResults = downloaded.map((d) => ({ ...d, label: null, category: null, confidence: 0 }));
  }

  // Step 3a: drop explicitly-rejected photos (agent headshots, logos,
  // unrelated marketing images) AND photos where labeling failed outright.
  // The earlier retry gives Claude two attempts; if both returned null the
  // file is either corrupted, unreadable, or the API is flaking on it.
  // Dropping is safer than keeping — a failed-to-label photo otherwise
  // surfaces in the UI as a generic "Photo" tile with no useful caption,
  // which is what the e2e test caught on 2026-04-23.
  const rejectedResults = labeledResults.filter((r) => r.category === REJECT_CATEGORY);
  const unlabeledResults = labeledResults.filter((r) => r.label == null || r.category == null);
  const toDrop = [...rejectedResults, ...unlabeledResults];
  for (const r of toDrop) {
    await fs.promises.unlink(path.join(folderPath, r.tempName)).catch(() => {});
  }
  let survivors = labeledResults.filter(
    (r) => r.category !== REJECT_CATEGORY && r.label != null && r.category != null,
  );
  if (rejectedResults.length > 0) {
    console.log(`[downloadAndPrioritize] ${folder}: dropped ${rejectedResults.length} rejected photos (agents/logos/etc)`);
  }
  if (unlabeledResults.length > 0) {
    console.log(`[downloadAndPrioritize] ${folder}: dropped ${unlabeledResults.length} unlabeled photos (labeler returned null after retry)`);
  }

  // Step 3a.5: Coalesce duplicate room shots by visual similarity.
  //
  // Bedrooms: dHash clustering + bed-type-aware Master/Bedroom 2/... naming.
  // Bathrooms: fixture-fingerprint clustering + Primary/Bathroom 2/... naming.
  // Kitchen, Living Areas, Dining: plain visual-cluster dedupe — labeler's
  //   label is kept, but multiple angles of the same room collapse to one
  //   photo (was the "4 Kitchen duplicates" bug).
  //
  // Other categories (Outdoor, Views, Exterior, Other) pass through unchanged
  // — those are naturally varied shots where duplicates are much rarer and
  // when they happen the per-category cap already handles them.
  const bedroomItems = survivors.filter((r) => r.category === "Bedrooms");
  const bathroomItems = survivors.filter((r) => r.category === "Bathrooms");
  const livingItems = survivors.filter((r) => r.category === "Living Areas");
  const kitchenItems = survivors.filter((r) => r.category === "Kitchen");
  const diningItems = survivors.filter((r) => r.category === "Dining");
  const coalescedInputs = new Set<string>([
    ...bedroomItems, ...bathroomItems, ...livingItems, ...kitchenItems, ...diningItems,
  ].map((r) => r.tempName));
  const otherItems = survivors.filter((r) => !coalescedInputs.has(r.tempName));
  const coalescedBedrooms = await coalesceBedrooms(bedroomItems, folderPath, requiredBedrooms);
  const coalescedBathrooms = coalesceBathrooms(bathroomItems);
  // For Living/Kitchen/Dining: 1 photo per distinct room is usually right.
  // Living Areas allows 2 (many units have a separate family room or great
  // room worth showing) — visual clustering still collapses alt angles.
  const coalescedLiving = await coalesceByVisualCluster(livingItems, folderPath, 1);
  const coalescedKitchen = await coalesceByVisualCluster(kitchenItems, folderPath, 1);
  const coalescedDining = await coalesceByVisualCluster(diningItems, folderPath, 1);
  const keptIds = new Set([
    ...coalescedBedrooms, ...coalescedBathrooms,
    ...coalescedLiving, ...coalescedKitchen, ...coalescedDining,
  ].map((r) => r.tempName));
  const coalesceDropped = [
    ...bedroomItems, ...bathroomItems,
    ...livingItems, ...kitchenItems, ...diningItems,
  ].filter((r) => !keptIds.has(r.tempName));
  for (const r of coalesceDropped) {
    await fs.promises.unlink(path.join(folderPath, r.tempName)).catch(() => {});
  }
  if (coalesceDropped.length > 0) {
    console.log(`[downloadAndPrioritize] ${folder}: coalesced ${coalesceDropped.length} duplicate-room shots across bedrooms/bathrooms/living/kitchen/dining`);
  }
  survivors = [
    ...coalescedBedrooms, ...coalescedBathrooms,
    ...coalescedLiving, ...coalescedKitchen, ...coalescedDining,
    ...otherItems,
  ];

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

  // Count distinct bedrooms by their post-coalesce room-identity label
  // prefix: "Master Bedroom", "Bedroom 2", "Bedroom 3", ... This reflects
  // the dHash-based clustering done in coalesceBedrooms — one cluster per
  // visually-distinct room. (Counting bed types here was the old bug: two
  // Queen-bed rooms collapsed to 1.)
  const bedroomRoomsSet = new Set<string>();
  const bedroomTypesSet = new Set<string>();
  for (const k of kept) {
    if (k.category !== "Bedrooms") continue;
    const label = k.label ?? "";
    const roomMatch = label.match(/^(Master Bedroom|Bedroom \d+)/);
    bedroomRoomsSet.add(roomMatch ? roomMatch[1] : `Unknown-${k.tempName}`);
    const bt = detectBedType(label);
    if (bt) bedroomTypesSet.add(bt);
  }
  const bathroomTypesSet = new Set<string>();
  for (const k of kept) {
    if (k.category === "Bathrooms") {
      bathroomTypesSet.add(detectBathFingerprint(k.label ?? "") + "-" + (k.label ?? ""));
    }
  }
  const bedroomsFound = bedroomRoomsSet.size;
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
