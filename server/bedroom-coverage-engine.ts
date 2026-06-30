// Bedroom coverage engine — category-first, batched vision, hard cap, cross-unit dedupe.

import fs from "fs";
import path from "path";
import {
  batchBedroomVisionRepresentatives,
  capBedroomClustersToExpected,
  classifyBedroomPhotoCandidate,
  clusterBedroomPhotosByHash,
  compareBedInventory,
  computeListingBedroomCoverage,
  computeUnitBedroomCoverage,
  dedupeCrossUnitBedroomClusters,
  isAmbiguousBedroomCaption,
  isBedroomCategory,
  isBedroomPhotoCaption,
  mergeBedroomClustersByCaption,
  parseExpectedBedInventory,
  parseExpectedBedroomsFromLabel,
  shouldExpandBedroomSearch,
  summarizeBedroomCluster,
  type BedroomPhotoSource,
  type ListingBedroomCoverage,
} from "../shared/photo-bedroom-coverage-logic";
import { isInteriorPhoto } from "../shared/photo-community-check-logic";
import {
  applySameRoomGroups,
  needsSameRoomVision,
} from "../shared/bedroom-same-room-logic";
import { groupSameBedroomsViaVision, type SameRoomRep } from "./bedroom-same-room-vision";
import { computeDhash } from "./photo-hashing";
import type { CheckGroupInput } from "./photo-community-check";

const BEDROOM_FOLDER_CAP = 150;
const BEDROOM_VISION_BATCH_SIZE = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif)$/i;

type BedroomPhotoSample = {
  id: string;
  filename: string;
  caption?: string;
  category?: string | null;
  buffer: Buffer;
  mime: string;
  hash?: string;
  bedroomSource: BedroomPhotoSource;
  bedroomClusterId?: string | null;
  precomputedBedType?: string | null;
};

type BedroomVisionClassification = {
  description: string;
  isBedroom: "yes" | "no";
};

function publicPhotoDir(folder: string): string {
  const safe = folder.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return path.resolve(process.cwd(), "client/public/photos", safe);
}

function mimeForBuffer(buffer: Buffer, filename: string): string {
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  const head = buffer.slice(0, 6).toString("ascii");
  if (head.startsWith("GIF87") || head.startsWith("GIF89")) return "image/gif";
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

function categoryFor(group: CheckGroupInput, filename: string): string | null {
  return group.categories?.[filename] ?? null;
}

function bedroomClusterIdFor(group: CheckGroupInput, filename: string): string | null {
  return group.bedroomClusterIds?.[filename] ?? null;
}

function precomputedBedTypeFor(group: CheckGroupInput, filename: string): string | null {
  return group.bedroomBedTypes?.[filename] ?? null;
}

function perceptualHashFor(group: CheckGroupInput, filename: string): string | undefined {
  return group.perceptualHashes?.[filename];
}

async function resolveAllGroupFiles(
  group: CheckGroupInput,
): Promise<Array<{ filename: string; caption?: string; category?: string | null }>> {
  const dir = publicPhotoDir(group.folder);
  let diskFiles: string[] = [];
  try {
    diskFiles = (await fs.promises.readdir(dir)).filter((f) => IMAGE_EXT.test(f));
  } catch {
    return [];
  }
  const diskSet = new Set(diskFiles);
  const requested = Array.isArray(group.filenames) && group.filenames.length > 0
    ? group.filenames.map((f) => path.basename(String(f))).filter((f) => IMAGE_EXT.test(f) && diskSet.has(f))
    : diskFiles.slice().sort();
  return Array.from(new Set(requested)).map((filename) => ({
    filename,
    caption: group.captions?.[filename],
    category: categoryFor(group, filename),
  }));
}

function matchesBedroomMode(
  f: { filename: string; caption?: string; category?: string | null },
  group: CheckGroupInput,
  mode: BedroomPhotoSource | "interior_sweep",
  exclude: Set<string>,
): boolean {
  if (exclude.has(f.filename)) return false;
  const clusterId = bedroomClusterIdFor(group, f.filename);
  const source = classifyBedroomPhotoCandidate(f.caption, f.category, clusterId);
  if (mode === "precomputed") return source === "precomputed";
  if (mode === "category") return source === "category" || isBedroomCategory(f.category);
  if (mode === "strict") return source === "strict" || isBedroomPhotoCaption(f.caption);
  if (mode === "ambiguous") return source === "ambiguous" || isAmbiguousBedroomCaption(f.caption);
  if (mode === "interior_sweep") {
    if (source) return false;
    return isInteriorPhoto(f.caption) && !/\b(bath|kitchen|pool|exterior|lobby)\b/i.test(f.caption ?? "");
  }
  return false;
}

async function loadBedroomPhotosForUnit(
  group: CheckGroupInput,
  idPrefix: string,
  mode: BedroomPhotoSource | "interior_sweep",
  excludeFilenames: Set<string> = new Set(),
  startIndex = 0,
): Promise<BedroomPhotoSample[]> {
  const ordered = await resolveAllGroupFiles(group);
  const bedroomFiles = ordered.filter((f) => matchesBedroomMode(f, group, mode, excludeFilenames)).slice(0, BEDROOM_FOLDER_CAP);
  const dir = publicPhotoDir(group.folder);
  const out: BedroomPhotoSample[] = [];
  let n = startIndex;
  for (const f of bedroomFiles) {
    n += 1;
    const abs = path.join(dir, f.filename);
    try {
      const buffer = await fs.promises.readFile(abs);
      if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) continue;
      const storedHash = perceptualHashFor(group, f.filename);
      let hash = storedHash;
      if (!hash) {
        try {
          hash = await computeDhash(buffer);
        } catch {
          hash = undefined;
        }
      }
      out.push({
        id: `${idPrefix}${n}`,
        filename: f.filename,
        caption: f.caption,
        category: f.category,
        buffer,
        mime: mimeForBuffer(buffer, f.filename),
        hash,
        bedroomSource: mode === "interior_sweep" ? "interior_sweep" : mode,
        bedroomClusterId: bedroomClusterIdFor(group, f.filename),
        precomputedBedType: precomputedBedTypeFor(group, f.filename),
      });
    } catch {
      // skip unreadable
    }
  }
  return out;
}

function pickClusterRepresentative(cluster: BedroomPhotoSample[]): BedroomPhotoSample {
  const nonAlt = cluster.find((p) => !/alt view/i.test(p.caption ?? ""));
  return nonAlt ?? cluster[0];
}

// Conservative vision fold: collapse bedroom clusters that are the SAME physical
// room from a different angle (the bed head-on + the same room's TV/dresser wall),
// which hash + caption merges miss. Runs before the cap so bedroomsFound reflects
// the rooms actually photographed instead of masking a missing bedroom. Skips
// entirely if any representative can't be encoded — fail-safe = no merge.
async function visionFoldSameRoomBedroomSamples(
  clusters: BedroomPhotoSample[][],
): Promise<BedroomPhotoSample[][]> {
  const reps = clusters.map(pickClusterRepresentative);
  if (reps.length !== clusters.length || reps.length < 2) return clusters;
  const repInputs: SameRoomRep[] = [];
  for (const r of reps) {
    if (!r.buffer || r.buffer.length === 0 || r.buffer.length > MAX_IMAGE_BYTES) return clusters;
    repInputs.push({ id: r.id, mime: r.mime, base64: r.buffer.toString("base64"), caption: r.caption });
  }
  const partition = await groupSameBedroomsViaVision(repInputs, {});
  if (!partition) return clusters;
  return applySameRoomGroups(clusters, reps.map((r) => r.id), partition).clusters;
}

function clusterCountsAsBedroom(
  cluster: BedroomPhotoSample[],
  repId: string,
  classification: Map<string, BedroomVisionClassification>,
): boolean {
  const cls = classification.get(repId);
  if (cls?.isBedroom === "no") return false;
  if (cluster.some((s) => s.bedroomSource === "precomputed" && s.bedroomClusterId)) return true;
  const hasStrictCaption = cluster.some((s) =>
    s.bedroomSource === "strict" || s.bedroomSource === "category" || isBedroomPhotoCaption(s.caption),
  );
  if (hasStrictCaption) return cls?.isBedroom !== "no";
  return cls?.isBedroom === "yes";
}

function buildBedroomVisionInstruction(unitLabel: string, hasAmbiguous: boolean): string {
  const ambiguousNote = hasAmbiguous
    ? "Some photos may be mislabeled (Office, Den, Bonus Room, Loft, etc.) — set isBedroom to yes ONLY if a bed is clearly visible."
    : "";
  return [
    `You are identifying DISTINCT BEDROOMS in unit photos for "${unitLabel}".`,
    "Each photo ID is ONE representative shot of a visually distinct bedroom.",
    "Multiple angles of the SAME room were already merged — treat each ID as a separate room.",
    ambiguousNote,
    "",
    "For EACH photo ID, return:",
    '  - bedDescription: concise bedding summary (e.g. "Two Twin Beds", "King Bed", "Queen Bed + Bunk").',
    '  - isBedroom: "yes" if this is clearly a bedroom; "no" if mislabeled (living room, kitchen, office without bed, etc.).',
    "",
    "Respond with ONLY minified JSON:",
    '{"rooms":[{"id":"BR1","bedDescription":"Two Twin Beds","isBedroom":"yes"}]}',
  ].filter(Boolean).join("\n");
}

type VisionCaller = (content: unknown[]) => Promise<{ parsed: Record<string, unknown> }>;

async function visionBedroomClassificationBatched(
  callVision: VisionCaller,
  unitLabel: string,
  representatives: BedroomPhotoSample[],
): Promise<Map<string, BedroomVisionClassification>> {
  const out = new Map<string, BedroomVisionClassification>();
  if (representatives.length === 0) return out;
  const batches = batchBedroomVisionRepresentatives(representatives, BEDROOM_VISION_BATCH_SIZE);
  for (const batch of batches) {
    const hasAmbiguous = batch.some((s) =>
      s.bedroomSource === "ambiguous" || s.bedroomSource === "interior_sweep",
    );
    const content: unknown[] = [];
    for (const s of batch) {
      const cap = s.caption ? ` · caption: "${s.caption}"` : "";
      content.push({ type: "text", text: `--- BEDROOM representative ${s.id}${cap} ---` });
      content.push({ type: "image", source: { type: "base64", media_type: s.mime, data: s.buffer.toString("base64") } });
    }
    content.push({ type: "text", text: buildBedroomVisionInstruction(unitLabel, hasAmbiguous) });
    try {
      const { parsed } = await callVision(content);
      const rows = Array.isArray(parsed.rooms) ? parsed.rooms : [];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const id = String((row as any).id ?? "").trim();
        if (!id) continue;
        out.set(id, {
          isBedroom: String((row as any).isBedroom ?? "").toLowerCase() === "yes" ? "yes" : "no",
          description: String((row as any).bedDescription ?? "").trim(),
        });
      }
    } catch {
      // strict/category clusters still evaluated via clusterCountsAsBedroom rules
    }
  }
  return out;
}

async function loadPrecomputedClusters(
  group: CheckGroupInput,
  idPrefix: string,
): Promise<{ samples: BedroomPhotoSample[]; clusterGroups: Map<string, BedroomPhotoSample[]> }> {
  const ordered = await resolveAllGroupFiles(group);
  const withCluster = ordered.filter((f) => bedroomClusterIdFor(group, f.filename));
  const clusterGroups = new Map<string, BedroomPhotoSample[]>();
  let n = 0;
  for (const f of withCluster) {
    const clusterId = bedroomClusterIdFor(group, f.filename)!;
    n += 1;
    const abs = path.join(publicPhotoDir(group.folder), f.filename);
    try {
      const buffer = await fs.promises.readFile(abs);
      if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) continue;
      const sample: BedroomPhotoSample = {
        id: `${idPrefix}${n}`,
        filename: f.filename,
        caption: f.caption,
        category: f.category,
        buffer,
        mime: mimeForBuffer(buffer, f.filename),
        hash: perceptualHashFor(group, f.filename),
        bedroomSource: "precomputed",
        bedroomClusterId: clusterId,
        precomputedBedType: precomputedBedTypeFor(group, f.filename),
      };
      if (!sample.hash) {
        try {
          sample.hash = await computeDhash(buffer);
        } catch {
          sample.hash = undefined;
        }
      }
      if (!clusterGroups.has(clusterId)) clusterGroups.set(clusterId, []);
      clusterGroups.get(clusterId)!.push(sample);
    } catch {
      // skip
    }
  }
  const samples = Array.from(clusterGroups.values()).flat();
  return { samples, clusterGroups };
}

async function analyzeUnitBedrooms(
  callVision: VisionCaller,
  g: CheckGroupInput,
  idPrefix: string,
): Promise<{
  rooms: ReturnType<typeof summarizeBedroomCluster>[];
  repHashes: (string | undefined)[];
  trimmedClusterCount: number;
  usedPrecomputed: boolean;
}> {
  const expected =
    typeof g.expectedBedrooms === "number" && g.expectedBedrooms > 0
      ? g.expectedBedrooms
      : parseExpectedBedroomsFromLabel(g.label);

  const pre = await loadPrecomputedClusters(g, idPrefix);
  let samples: BedroomPhotoSample[] = [];
  let clusters: BedroomPhotoSample[][] = [];
  let usedPrecomputed = false;

  if (pre.clusterGroups.size > 0) {
    usedPrecomputed = true;
    clusters = Array.from(pre.clusterGroups.values());
    samples = pre.samples;
    if (shouldExpandBedroomSearch(clusters.length, expected)) {
      usedPrecomputed = false;
      const preFiles = new Set(samples.map((s) => s.filename));
      const category = await loadBedroomPhotosForUnit(g, idPrefix, "category", preFiles);
      const strict = await loadBedroomPhotosForUnit(g, idPrefix, "strict", new Set([...preFiles, ...category.map((s) => s.filename)]));
      samples = [...samples, ...category, ...strict];
      clusters = clusterBedroomPhotosByHash(samples);
    }
  } else {
    samples = await loadBedroomPhotosForUnit(g, idPrefix, "category");
    let strict = await loadBedroomPhotosForUnit(g, idPrefix, "strict", new Set(samples.map((s) => s.filename)));
    samples = [...samples, ...strict.filter((s) => !samples.some((x) => x.filename === s.filename))];
    clusters = clusterBedroomPhotosByHash(samples);

    if (shouldExpandBedroomSearch(clusters.length, expected)) {
      const exclude = new Set(samples.map((s) => s.filename));
      const ambiguous = await loadBedroomPhotosForUnit(g, idPrefix, "ambiguous", exclude, samples.length);
      if (ambiguous.length > 0) {
        samples = [...samples, ...ambiguous];
        clusters = clusterBedroomPhotosByHash(samples);
      }
    }

    if (shouldExpandBedroomSearch(clusters.length, expected)) {
      const exclude = new Set(samples.map((s) => s.filename));
      const sweep = await loadBedroomPhotosForUnit(g, idPrefix, "interior_sweep", exclude, samples.length);
      if (sweep.length > 0) {
        samples = [...samples, ...sweep];
        clusters = clusterBedroomPhotosByHash(samples);
      }
    }
  }

  // Fold same-room shots that hash-split (a master from two angles, a twin room
  // captioned "Twin Beds" + "Two Beds") back together BEFORE trimming, so the
  // room count and bed inventory reflect the real bedrooms — not duplicate views.
  const { clusters: mergedClusters } = mergeBedroomClustersByCaption(clusters, expected);
  clusters = mergedClusters;

  // Vision same-room fold — the reliable signal for "same room, other angle" that
  // hash distance + scraped captions can't see. Runs AFTER all expansion so it
  // can't be undone, and BEFORE the cap so an over-count that equals the expected
  // bedroom count (e.g. a 3BR photographed as master + master-angle + guest)
  // collapses to the real room count and the missing bedroom is no longer masked.
  if (needsSameRoomVision(clusters.length)) {
    clusters = await visionFoldSameRoomBedroomSamples(clusters);
  }

  // Expected bed inventory steers the cap so a unique bed type (e.g. a Queen)
  // is never trimmed in favour of a duplicate (e.g. a second King).
  const expectedBedInventory =
    g.expectedBedInventory ?? (g.unitDescription ? parseExpectedBedInventory(g.unitDescription) : []);
  const { clusters: cappedClusters, trimmedCount } = capBedroomClustersToExpected(clusters, expected, {
    expectedBedInventory,
  });
  clusters = cappedClusters;

  const representatives = clusters.map(pickClusterRepresentative);
  const needsVision = representatives.filter((rep) => {
    const cluster = clusters.find((c) => c.some((s) => s.id === rep.id)) ?? [rep];
    return !cluster.every((s) => s.bedroomSource === "precomputed" && s.precomputedBedType);
  });
  const classification = await visionBedroomClassificationBatched(callVision, g.label, needsVision);

  const rooms: ReturnType<typeof summarizeBedroomCluster>[] = [];
  const repHashes: (string | undefined)[] = [];
  let roomIndex = 0;
  for (const cluster of clusters) {
    const rep = pickClusterRepresentative(cluster);
    if (!clusterCountsAsBedroom(cluster, rep.id, classification)) continue;
    const cls = classification.get(rep.id);
    const visionDesc = cls?.description || rep.precomputedBedType || undefined;
    const source = cluster[0]?.bedroomSource;
    rooms.push(summarizeBedroomCluster(cluster, roomIndex, visionDesc, source));
    repHashes.push(rep.hash);
    roomIndex += 1;
  }

  return { rooms, repHashes, trimmedClusterCount: trimmedCount, usedPrecomputed };
}

export async function analyzeBedroomCoverage(
  callVision: VisionCaller,
  unitInputs: CheckGroupInput[],
  expectedListingBedrooms: number | null,
): Promise<ListingBedroomCoverage> {
  const unitClusterResults: Array<{
    label: string;
    rooms: ReturnType<typeof summarizeBedroomCluster>[];
    repHashes: (string | undefined)[];
    trimmedClusterCount: number;
    usedPrecomputed: boolean;
    group: CheckGroupInput;
  }> = [];

  for (let u = 0; u < unitInputs.length; u++) {
    const g = unitInputs[u];
    const idPrefix = `BR${u + 1}-`;
    const result = await analyzeUnitBedrooms(callVision, g, idPrefix);
    unitClusterResults.push({ label: g.label, ...result, group: g });
  }

  const dedupeInput = unitClusterResults.map((u) => ({
    label: u.label,
    rooms: u.rooms,
    repHashes: u.repHashes,
  }));
  const { units: dedupedUnits, dedupedCount } = dedupeCrossUnitBedroomClusters(dedupeInput);

  const unitResults = dedupedUnits.map((du, ui) => {
    const src = unitClusterResults[ui];
    const expected =
      typeof src.group.expectedBedrooms === "number" && src.group.expectedBedrooms > 0
        ? src.group.expectedBedrooms
        : parseExpectedBedroomsFromLabel(src.group.label);
    const expectedBedInventory = src.group.expectedBedInventory ?? (
      src.group.unitDescription ? parseExpectedBedInventory(src.group.unitDescription) : []
    );
    const detectedTypes = du.rooms.map((r) => r.bedType ?? r.description).filter(Boolean) as string[];
    const inv = compareBedInventory(expectedBedInventory, detectedTypes);
    return computeUnitBedroomCoverage(
      du.label,
      src.group.folder,
      du.rooms,
      expected,
      {
        trimmedClusterCount: src.trimmedClusterCount,
        expectedBedInventory: expectedBedInventory.length > 0 ? expectedBedInventory : undefined,
        bedInventoryMatch: inv.matches,
        bedInventoryReason: inv.missing.length > 0
          ? `missing ${inv.missing.join(", ")}`
          : inv.extra.length > 0
            ? `extra ${inv.extra.join(", ")}`
            : undefined,
        usedPrecomputed: src.usedPrecomputed,
      },
    );
  });

  const listingTrimmed = unitResults.reduce((s, u) => s + (u.trimmedClusterCount ?? 0), 0);
  return computeListingBedroomCoverage(unitResults, expectedListingBedrooms, dedupedCount, listingTrimmed);
}
