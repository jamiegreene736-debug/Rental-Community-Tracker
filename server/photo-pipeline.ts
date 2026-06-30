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
import { inferKindFromFolder, labelPhoto, listPhotoFiles } from "./photo-labeler";
import { backfillBedroomPrecomputeForFolder } from "./bedroom-precompute";
import {
  mergeBedroomClustersByCaption,
  mergeBedroomClustersSameRoom,
} from "../shared/photo-bedroom-coverage-logic";
import {
  applySameRoomGroups,
  needsSameRoomVision,
} from "../shared/bedroom-same-room-logic";
import { groupSameBedroomsViaVision, type SameRoomRep } from "./bedroom-same-room-vision";
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
  contentFingerprint: string;
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
// Narrowed deliberately. Earlier regex included `cabinet` / `island` /
// `countertop` / `stove` which gave false positives — a "Bedroom With
// Built-In Cabinet" got wrongly demoted to Kitchen. Only keep words that
// are unambiguously kitchen-specific.
const KITCHEN_KEYWORDS = /\b(kitchen|kitchenette|pantry|breakfast bar)\b/i;
// Very-low-confidence threshold: below this, demote regardless of
// keywords — Claude is flagging that it has no idea. Above this we
// trust the keyword signal. Previously 0.70 was demoting legitimate
// bedroom photos that Claude captioned correctly ("King Bedroom")
// but with modest confidence (0.65), which under-counted rooms.
const HARD_CONFIDENCE_FLOOR = 0.40;

function applyCategorySanityCheck(r: LabeledResult): LabeledResult {
  if (!r.category || !r.label) return r;
  const label = r.label;
  const cat = r.category;
  const labelHasBed = BEDROOM_KEYWORDS.test(label);
  const labelHasBath = BATHROOM_KEYWORDS.test(label);
  const labelHasKitchen = KITCHEN_KEYWORDS.test(label);

  // Label → category contradicts (kitchen words in a Bedrooms/Bathrooms
  // pick). Label wins — Claude saw a kitchen but picked the wrong bucket.
  if ((cat === "Bedrooms" || cat === "Bathrooms") && labelHasKitchen && !labelHasBed && !labelHasBath) {
    console.log(`[sanity] demoting "${label}" from ${cat}→Kitchen (kitchen keywords, no bed/bath keywords)`);
    return { ...r, category: "Kitchen" };
  }
  // Bedrooms category but label has no bed vocabulary at all. Vision
  // models sometimes drop the room type into the category field while
  // the descriptive label reflects what they actually saw.
  if (cat === "Bedrooms" && !labelHasBed) {
    console.log(`[sanity] demoting "${label}" from Bedrooms→Other (no bed keywords)`);
    return { ...r, category: "Other" };
  }
  if (cat === "Bathrooms" && !labelHasBath) {
    console.log(`[sanity] demoting "${label}" from Bathrooms→Other (no bath keywords)`);
    return { ...r, category: "Other" };
  }
  // Label backs up the category (bed keywords for Bedrooms, bath for
  // Bathrooms) — trust it even at moderate confidence. Only demote when
  // Claude is REALLY unsure (< 0.40). The earlier 0.70 threshold was
  // under-counting bedroom photos that the model labeled correctly but
  // scored with modest confidence.
  if ((cat === "Bedrooms" || cat === "Bathrooms") && r.confidence < HARD_CONFIDENCE_FLOOR) {
    console.log(`[sanity] demoting "${label}" from ${cat}→Other (confidence ${r.confidence.toFixed(2)} < ${HARD_CONFIDENCE_FLOOR})`);
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

// Magic-byte MIME sniff for the vision request — files land as .jpg but may be
// PNG/WebP bytes, and Anthropic rejects a mismatched media_type. Falls back to
// JPEG (the download pipeline's default extension).
function sniffImageMime(buffer: Buffer): string {
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  const head = buffer.slice(0, 6).toString("ascii");
  if (head.startsWith("GIF87") || head.startsWith("GIF89")) return "image/gif";
  return "image/jpeg";
}

const SAME_ROOM_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Send one representative per bedroom cluster to the conservative same-room vision
// pass and fold the clusters it confirms are the same physical room. If ANY
// representative can't be loaded/encoded we skip entirely (a partial set could
// make the model partition only some rooms and mis-merge) — fail-safe = no merge.
async function visionFoldSameRoomBedrooms<T extends { id: string; caption?: string; item: LabeledResult }>(
  groups: T[][],
  folderPath: string,
  apiKey: string,
): Promise<T[][]> {
  const reps = groups.map((g) => g[0]).filter(Boolean) as T[];
  if (reps.length !== groups.length || reps.length < 2) return groups;
  const repInputs: SameRoomRep[] = [];
  for (const ref of reps) {
    try {
      const buf = await fs.promises.readFile(path.join(folderPath, ref.item.tempName));
      if (buf.length === 0 || buf.length > SAME_ROOM_MAX_IMAGE_BYTES) return groups;
      repInputs.push({ id: ref.id, mime: sniffImageMime(buf), base64: buf.toString("base64"), caption: ref.caption });
    } catch {
      return groups;
    }
  }
  const partition = await groupSameBedroomsViaVision(repInputs, { apiKey });
  if (!partition) return groups;
  const { clusters: folded, mergedCount } = applySameRoomGroups(groups, reps.map((r) => r.id), partition);
  if (mergedCount > 0) {
    console.log(`[photo-pipeline] same-room vision folded ${mergedCount} bedroom angle cluster(s) → ${folded.length} room(s)`);
  }
  return folded;
}

// Label bedroom photos in place — NO DROPPING. Groups by visual cluster
// like coalesceBedrooms did, picks a master cluster (King bed preferred,
// else largest cluster), and re-captions each photo as "Master Bedroom",
// "Bedroom 2", etc. with the bed type appended when detected. Unlike
// coalesceBedrooms this keeps every photo — user curates manually.
async function labelBedroomsInPlace(
  items: LabeledResult[],
  folderPath: string,
  opts: { expectedBedrooms?: number | null; apiKey?: string | null } = {},
): Promise<LabeledResult[]> {
  if (items.length === 0) return items;
  const hashes = await Promise.all(
    items.map((it) => computeDHash(path.join(folderPath, it.tempName)))
  );
  const clusterOf = clusterByDHash(hashes, DHASH_SIMILARITY_THRESHOLD);
  const clusters = new Map<number, LabeledResult[]>();
  const clusterOrder: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const c = clusterOf[i];
    if (!clusters.has(c)) { clusters.set(c, []); clusterOrder.push(c); }
    clusters.get(c)!.push(items[i]);
  }

  type BedroomRef = { id: string; caption: string; item: LabeledResult };
  let bedroomGroups: BedroomRef[][] = clusterOrder.map((c) =>
    (clusters.get(c) ?? []).map((it) => ({
      id: it.tempName,
      caption: it.label ?? "",
      item: it,
    })),
  );

  // dHash splits different angles of one room — fold same-room pairs first.
  bedroomGroups = mergeBedroomClustersSameRoom(bedroomGroups).clusters;
  if (opts.expectedBedrooms != null && opts.expectedBedrooms > 0
    && bedroomGroups.length > opts.expectedBedrooms) {
    bedroomGroups = mergeBedroomClustersByCaption(
      bedroomGroups,
      opts.expectedBedrooms,
    ).clusters;
  }

  // Vision same-room fold: hash + captions miss angles of one room that look
  // different and were captioned independently ("King Bedroom" + "Bedroom With
  // TV"). A conservative Sonnet pass reads the pixels and only merges clusters it
  // can prove are the same physical room. This runs REGARDLESS of expectedBedrooms
  // (the over-count usually equals expected — e.g. a 3BR whose 3rd bedroom was
  // never photographed shows master + master-angle + guest = 3), so the room
  // count reflects the rooms actually photographed and a coverage gap surfaces
  // instead of being masked. No key / disabled / unreadable file → no-op.
  if (opts.apiKey && needsSameRoomVision(bedroomGroups.length)) {
    bedroomGroups = await visionFoldSameRoomBedrooms(bedroomGroups, folderPath, opts.apiKey);
  }

  const clusterBedType = (group: BedroomRef[]): string | null => {
    for (const ref of group) {
      const bt = detectBedType(ref.caption);
      if (bt) return bt;
    }
    return null;
  };
  const clusterSize = (group: BedroomRef[]) => group.length;
  const kingClusterIdx = bedroomGroups.findIndex((g) => clusterBedType(g) === "King");
  const twoKingsIdx = bedroomGroups.findIndex((g) => clusterBedType(g) === "Two Kings");
  const masterClusterIdx = kingClusterIdx >= 0 ? kingClusterIdx
    : twoKingsIdx >= 0 ? twoKingsIdx
    : bedroomGroups
      .map((g, i) => ({ i, size: clusterSize(g) }))
      .sort((a, b) => b.size - a.size)[0]?.i ?? 0;

  const renderType = (bt: string | null) => bt ? ` — ${bt}` : "";
  const labelCluster = (group: BedroomRef[], name: string) => {
    const bt = clusterBedType(group);
    group.forEach((ref, i) => {
      ref.item.label = i === 0 ? `${name}${renderType(bt)}` : `${name} — Alt View`;
    });
  };
  labelCluster(bedroomGroups[masterClusterIdx] ?? [], "Master Bedroom");
  let bedroomNum = 2;
  for (let idx = 0; idx < bedroomGroups.length; idx++) {
    if (idx === masterClusterIdx) continue;
    labelCluster(bedroomGroups[idx], `Bedroom ${bedroomNum}`);
    bedroomNum++;
  }
  // Return every item (not just masters) — labels mutated in place above.
  return items;
}

// Label bathroom photos in place — NO DROPPING. Buckets by fixture
// fingerprint, labels first non-half group's photos as "Primary Bathroom",
// numbered guest bathrooms thereafter. Keeps every photo.
function labelBathroomsInPlace(items: LabeledResult[]): LabeledResult[] {
  if (items.length === 0) return items;
  const byFp = new Map<string, LabeledResult[]>();
  const order: string[] = [];
  for (const it of items) {
    const fp = detectBathFingerprint(it.label ?? "");
    if (!byFp.has(fp)) { byFp.set(fp, []); order.push(fp); }
    byFp.get(fp)!.push(it);
  }
  const primaryFp = order.find((fp) => fp !== "Half") ?? order[0];
  const renderFp = (fp: string) => fp === "Generic" ? "" : ` — ${fp}`;
  (byFp.get(primaryFp) ?? []).forEach((it, i) => {
    it.label = i === 0 ? `Primary Bathroom${renderFp(primaryFp)}` : `Primary Bathroom — Alt View`;
  });
  let bathNum = 2;
  for (const fp of order) {
    if (fp === primaryFp) continue;
    const group = byFp.get(fp) ?? [];
    if (fp === "Half") {
      group.forEach((it, i) => { it.label = i === 0 ? "Half Bath" : "Half Bath — Alt View"; });
      continue;
    }
    group.forEach((it, i) => {
      it.label = i === 0 ? `Bathroom ${bathNum}${renderFp(fp)}` : `Bathroom ${bathNum} — Alt View`;
    });
    if (group.length > 0) bathNum++;
  }
  return items;
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
  keptSourceUrls: string[];
  keptContentFingerprints: string[];
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
    downloaded.push({ tempName, url: scrapedUrls[i], originalIndex: i, contentFingerprint: `md5:${hash}` });
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
      categorySummary: {}, keptFilenames: [], keptSourceUrls: [], keptContentFingerprints: [],
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

  // Step 3a.5: Bedroom/bathroom LABELING only — no photo dropping.
  //
  // We still run coalesceBedrooms so the first bedroom gets captioned
  // "Master Bedroom — King" etc., but we DON'T discard extras: every
  // photo Zillow returned survives to the final set. The user reviews
  // the resulting tile grid and deletes manually. That matches the
  // explicit ask: "just want the tool to pull the photos from Zillow,
  // all of them, in Zillow's order — that's it."
  //
  // Earlier revisions dropped identical-label photos (kitchen×4 angles
  // → 1) and capped rooms to MAX_PER_ROOM=2. Both were helpful when
  // Zillow's output was noisy, but now the scraper is scoped to only
  // the listing's own responsivePhotos array — any duplicates that
  // survive are Zillow's own doing, and the user wants to see them.
  const bedroomItems = survivors.filter((r) => r.category === "Bedrooms");
  const bathroomItems = survivors.filter((r) => r.category === "Bathrooms");
  const relabeledBedrooms = await labelBedroomsInPlace(bedroomItems, folderPath, {
    expectedBedrooms: opts.requiredBedrooms ?? null,
    apiKey: anthropicKey,
  });
  const relabeledBathrooms = labelBathroomsInPlace(bathroomItems);
  // Rebuild survivors by overlaying the re-labeled bedrooms/bathrooms
  // into their original positions — labels change, order doesn't.
  const labelByTemp = new Map<string, LabeledResult>();
  for (const r of [...relabeledBedrooms, ...relabeledBathrooms]) labelByTemp.set(r.tempName, r);
  survivors = survivors.map((r) => labelByTemp.get(r.tempName) ?? r);

  // Step 3b: preserve Zillow's own photo order. Earlier revisions sorted
  // by CATEGORY_PRIORITY (Bedrooms first, Bathrooms next, …) — that was
  // the right call when the listing might return photos in an arbitrary
  // order, but users want to see the photos Zillow presents in the
  // sequence Zillow presents them. The labeler still runs for captions;
  // we just don't reorder based on it.
  survivors.sort((a, b) => a.originalIndex - b.originalIndex);

  // Step 4: keep up to maxKeep photos in scrape order. No per-category
  // caps — the user explicitly wants every photo the listing has (up to
  // a reasonable ceiling). With the scrapers now scoped to the listing's
  // own responsivePhotos array, we don't expect the set to be inflated
  // by unrelated images, so the cap is just a safety rail for listings
  // with unusually large photo counts.
  const kept: LabeledResult[] = [];
  const dropped: LabeledResult[] = [];
  for (const r of survivors) {
    if (kept.length >= maxKeep) { dropped.push(r); continue; }
    kept.push(r);
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
          confidence: k.confidence ?? null,
          model: opts.model ?? "claude-haiku-4-5",
        }).catch(() => {});
      }
    }
  }

  // Step 7: compute perceptual hashes for the kept photos so the
  // photo-listing scanner can detect edited-photo theft and the
  // channel-photo-independence selector can filter visually-duplicate
  // candidates. Per-file errors don't fail the pipeline — the scanner's
  // backfillFolderHashes() will retry later.
  try {
    const { computeDhash } = await import("./photo-hashing");
    for (let i = 0; i < keptFilenames.length; i++) {
      const filename = keptFilenames[i];
      const filePath = path.join(folderPath, filename);
      try {
        const buf = await fs.promises.readFile(filePath);
        const hash = await computeDhash(buf);
        await storage.updatePhotoLabelHash(folder, filename, hash);
      } catch (e: any) {
        console.error(`[photo-pipeline] hash failed for ${folder}/${filename}: ${e?.message ?? e}`);
      }
    }
  } catch (e: any) {
    console.error(`[photo-pipeline] hashing module load failed: ${e?.message ?? e}`);
  }

  // Step 7b: persist bedroom cluster ids on photo_labels for fast community checks.
  try {
    const bedroomFiles: Array<{ filename: string; label: string; absPath: string }> = [];
    for (let i = 0; i < kept.length; i++) {
      if (kept[i].category !== "Bedrooms") continue;
      bedroomFiles.push({
        filename: keptFilenames[i],
        label: kept[i].label ?? "",
        absPath: path.join(folderPath, keptFilenames[i]),
      });
    }
    if (bedroomFiles.length > 0) {
      const { persistBedroomPrecomputeForFolder } = await import("./bedroom-precompute");
      const pre = await persistBedroomPrecomputeForFolder(folder, bedroomFiles);
      if (pre.clusters > 0) {
        console.log(`[photo-pipeline] ${folder}: precomputed ${pre.clusters} bedroom cluster(s) on ${pre.filesUpdated} photo(s)`);
      }
    }
  } catch (e: any) {
    console.warn(`[photo-pipeline] bedroom precompute failed for ${folder}: ${e?.message ?? e}`);
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
    dropped: dropped.length + rejectedResults.length + unlabeledResults.length,
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
    keptSourceUrls: kept.map((photo) => photo.url),
    keptContentFingerprints: kept.map((photo) => photo.contentFingerprint),
  };
}

export type RelabelFolderProgress = {
  done: number;
  total: number;
  filename: string;
  ok: boolean;
  label?: string;
};

async function readFolderExpectedBedrooms(folderPath: string): Promise<number | null> {
  try {
    const raw = await fs.promises.readFile(path.join(folderPath, "_source.json"), "utf8");
    const data = JSON.parse(raw) as {
      bedrooms?: unknown;
      referencedBy?: Array<{ bedrooms?: unknown }>;
    };
    const direct = Number(data?.bedrooms);
    if (Number.isFinite(direct) && direct > 0 && direct <= 12) return direct;
    const fromRef = Number(data?.referencedBy?.[0]?.bedrooms);
    if (Number.isFinite(fromRef) && fromRef > 0 && fromRef <= 12) return fromRef;
    return null;
  } catch {
    return null;
  }
}

/** Re-run Claude vision labels for every photo in a folder, then re-cluster bedrooms/bathrooms. */
export async function relabelFolderPhotos(
  folder: string,
  folderPath: string,
  anthropicKey: string,
  opts: { onProgress?: (evt: RelabelFolderProgress) => void } = {},
): Promise<{ relabeled: number; failed: number; total: number }> {
  const files = await listPhotoFiles(folderPath);
  const kind = inferKindFromFolder(folder);
  const sleepMs = 1400;

  type Row = LabeledResult & { filename: string; model: string };
  const rows: Row[] = [];
  let failed = 0;

  for (let i = 0; i < files.length; i++) {
    const filename = files[i];
    const abs = path.join(folderPath, filename);
    const result = await labelPhoto(abs, kind, anthropicKey);
    if (!result || result.category === REJECT_CATEGORY) {
      failed++;
      opts.onProgress?.({ done: i + 1, total: files.length, filename, ok: false });
    } else {
      rows.push({
        filename,
        tempName: filename,
        url: "",
        originalIndex: i,
        contentFingerprint: "",
        label: result.label,
        category: result.category,
        confidence: result.confidence,
        model: result.model,
      });
      opts.onProgress?.({
        done: i + 1,
        total: files.length,
        filename,
        ok: true,
        label: result.label,
      });
    }
    if (i < files.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }

  const bedroomItems = rows.filter((r) => r.category === "Bedrooms");
  const bathroomItems = rows.filter((r) => r.category === "Bathrooms");
  const expectedBedrooms = await readFolderExpectedBedrooms(folderPath);
  const relabeledBedrooms = await labelBedroomsInPlace(bedroomItems, folderPath, { expectedBedrooms, apiKey: anthropicKey });
  const relabeledBathrooms = labelBathroomsInPlace(bathroomItems);
  const labelByName = new Map<string, LabeledResult>();
  for (const r of [...relabeledBedrooms, ...relabeledBathrooms]) labelByName.set(r.tempName, r);

  let relabeled = 0;
  for (const row of rows) {
    const final = labelByName.get(row.tempName) ?? row;
    if (!final.label || !final.category) continue;
    await storage.applyRelabeledPhotoLabel({
      folder,
      filename: row.filename,
      label: final.label,
      category: final.category,
      confidence: final.confidence ?? null,
      model: row.model,
    });
    relabeled++;
  }

  await backfillBedroomPrecomputeForFolder(folder, folderPath);

  return { relabeled, failed, total: files.length };
}
