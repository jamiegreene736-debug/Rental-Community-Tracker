// Bedroom photo coverage — pure logic for the photo community check.
// Clusters visually similar bedroom shots so multiple angles of the same
// room count once, then compares distinct rooms to listing bedroom counts.

/** Same-room clustering threshold as photo-pipeline (64-bit dHash). */
export const BEDROOM_CLUSTER_DISTANCE = 16;

export const BEDROOM_VISION_BATCH_SIZE = 6;

const BEDROOM_CAPTION_RE =
  /^(master bedroom|bedroom\s+\d+|king bedroom|queen bedroom|twin bedroom|bunk|two twins?|two queens?|two kings?)/i;

const BEDROOM_KEYWORD_RE =
  /\b(bedroom|king bed|queen bed|twin bed|bunk bed|murphy bed|sleeping area)\b/i;

const NON_BEDROOM_RE =
  /\b(living room|kitchen|bathroom|bath\b|pool|exterior|lobby|dining room|floor\s?plan|map)\b/i;

/** Captions that are often bedrooms but mislabeled in scraped galleries. */
const AMBIGUOUS_BEDROOM_RE =
  /\b(office|den|bonus\s+room|loft|flex\s+room|murphy|sleeping\s+nook|guest\s+room|library|studio|study|retreat|sunroom|upstairs|downstairs)\b/i;

export type BedroomPhotoSource =
  | "strict"
  | "ambiguous"
  | "category"
  | "precomputed"
  | "interior_sweep";

export type BedroomListingTier = "pass" | "warn" | "fail";

export function isBedroomCategory(category?: string | null): boolean {
  if (!category?.trim()) return false;
  return /^bedrooms?$/i.test(category.trim());
}

export function isBedroomPhotoCaption(caption?: string): boolean {
  if (!caption?.trim()) return false;
  const trimmed = caption.trim();
  if (NON_BEDROOM_RE.test(trimmed)) return false;
  if (BEDROOM_CAPTION_RE.test(trimmed)) return true;
  return BEDROOM_KEYWORD_RE.test(trimmed.toLowerCase());
}

/** Often a bedroom in VRBO/Airbnb scrapes but not captioned "Bedroom N". */
export function isAmbiguousBedroomCaption(caption?: string): boolean {
  if (!caption?.trim()) return false;
  const trimmed = caption.trim();
  if (NON_BEDROOM_RE.test(trimmed)) return false;
  if (isBedroomPhotoCaption(trimmed)) return false;
  return AMBIGUOUS_BEDROOM_RE.test(trimmed);
}

/** Stage-1: DB category. Stage-2: strict caption. Stage-3: ambiguous. Stage-4: interior sweep. */
export function classifyBedroomPhotoCandidate(
  caption?: string,
  category?: string | null,
  bedroomClusterId?: string | null,
): BedroomPhotoSource | null {
  if (bedroomClusterId?.trim()) return "precomputed";
  if (isBedroomCategory(category)) return "category";
  if (isBedroomPhotoCaption(caption)) return "strict";
  if (isAmbiguousBedroomCaption(caption)) return "ambiguous";
  return null;
}

export function shouldExpandBedroomSearch(
  bedroomsFound: number,
  expectedBedrooms: number | null,
): boolean {
  return expectedBedrooms != null && expectedBedrooms > 0 && bedroomsFound < expectedBedrooms;
}

/** Parse "Unit A (3BR)" → 3. Returns null when not present. */
export function parseExpectedBedroomsFromLabel(label: string): number | null {
  const m = String(label ?? "").match(/\((\d+)\s*BR\)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 && n <= 12 ? n : null;
}

export function detectBedTypeFromCaption(caption: string): string | null {
  const lower = caption.toLowerCase();
  if (/\btwo twins?\b/.test(lower)) return "Two Twin Beds";
  if (/\btwo queens?\b/.test(lower)) return "Two Queen Beds";
  if (/\btwo kings?\b/.test(lower)) return "Two King Beds";
  if (/\btwo doubles?\b/.test(lower)) return "Two Double Beds";
  if (/\bbunk\b/.test(lower)) return "Bunk Beds";
  if (/\bking\b/.test(lower)) return "King Bed";
  if (/\bqueen\b/.test(lower)) return "Queen Bed";
  if (/\btwin\b/.test(lower)) return "Twin Bed";
  if (/\bdouble\b/.test(lower)) return "Double Bed";
  if (/\bfull\b/.test(lower)) return "Full Bed";
  if (/\bsleeper sofa\b/.test(lower)) return "Sleeper Sofa";
  return null;
}

/** Parse listing/unit copy into expected bed types (e.g. King, Queen, Two Twins). */
export function parseExpectedBedInventory(text: string): string[] {
  const lower = String(text ?? "").toLowerCase();
  const out: string[] = [];
  const patterns: Array<[RegExp, string]> = [
    [/\btwo twins?\b/g, "Two Twin Beds"],
    [/\b2 twins?\b/g, "Two Twin Beds"],
    [/\btwo queens?\b/g, "Two Queen Beds"],
    [/\b2 queens?\b/g, "Two Queen Beds"],
    [/\btwo kings?\b/g, "Two King Beds"],
    [/\bbunk beds?\b/g, "Bunk Beds"],
    [/\bking bed\b/g, "King Bed"],
    [/\bqueen bed\b/g, "Queen Bed"],
    [/\btwin bed\b/g, "Twin Bed"],
    [/\bdouble bed\b/g, "Double Bed"],
    [/\bfull bed\b/g, "Full Bed"],
    [/\bqueen sleeper sofa\b/g, "Queen Sleeper Sofa"],
    [/\bsleeper sofa\b/g, "Sleeper Sofa"],
  ];
  for (const [re, label] of patterns) {
    const matches = lower.match(re);
    if (matches) {
      for (let i = 0; i < matches.length; i++) out.push(label);
    }
  }
  return out;
}

export function normalizeBedType(label: string): string {
  const bt = detectBedTypeFromCaption(label);
  return bt ?? label.trim();
}

/** Compare detected bed types to parsed listing inventory (order-insensitive). */
export function compareBedInventory(
  expected: string[],
  detected: string[],
): { matches: "yes" | "no" | "n/a"; missing: string[]; extra: string[] } {
  if (expected.length === 0) return { matches: "n/a", missing: [], extra: [] };
  const exp = expected.map(normalizeBedType).sort();
  const det = detected.map(normalizeBedType).sort();
  const missing: string[] = [];
  const extra: string[] = [];
  const detCopy = [...det];
  for (const e of exp) {
    const idx = detCopy.indexOf(e);
    if (idx >= 0) detCopy.splice(idx, 1);
    else missing.push(e);
  }
  extra.push(...detCopy);
  return {
    matches: missing.length === 0 && extra.length === 0 ? "yes" : missing.length > 0 ? "no" : "yes",
    missing,
    extra,
  };
}

export type BedroomClusterInput = {
  id: string;
  caption?: string;
  hash?: string;
  clusterSize?: number;
  bedType?: string | null;
};

/** Single-linkage clustering on hex dHash strings (same algorithm as pipeline). */
export function clusterBedroomPhotosByHash<T extends BedroomClusterInput>(
  items: T[],
  threshold: number = BEDROOM_CLUSTER_DISTANCE,
): T[][] {
  if (items.length === 0) return [];
  const clusterOf = new Array(items.length).fill(-1);
  let next = 0;
  for (let i = 0; i < items.length; i++) {
    if (clusterOf[i] !== -1) continue;
    clusterOf[i] = next;
    const hi = items[i].hash;
    if (hi) {
      for (let j = i + 1; j < items.length; j++) {
        if (clusterOf[j] !== -1) continue;
        const hj = items[j].hash;
        if (hj && hammingHex(hi, hj) <= threshold) clusterOf[j] = next;
      }
    }
    next++;
  }
  const buckets = new Map<number, T[]>();
  for (let i = 0; i < items.length; i++) {
    const c = clusterOf[i];
    if (!buckets.has(c)) buckets.set(c, []);
    buckets.get(c)!.push(items[i]);
  }
  return Array.from(buckets.values());
}

function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let diff = 0;
  for (let i = 0; i < a.length; i += 2) {
    const x = parseInt(a.slice(i, i + 2), 16);
    const y = parseInt(b.slice(i, i + 2), 16);
    if (Number.isNaN(x) || Number.isNaN(y)) return 64;
    let xor = x ^ y;
    while (xor) {
      diff += xor & 1;
      xor >>>= 1;
    }
  }
  return diff;
}

export function pickMasterClusterIndex<T extends BedroomClusterInput>(clusters: T[][]): number {
  if (clusters.length === 0) return -1;
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    const rep = cluster[0];
    const captions = cluster.map((c) => c.caption ?? "").join(" ");
    const bt = detectBedTypeFromCaption(captions);
    let score = cluster.length;
    if (bt === "King Bed" || bt === "Two King Beds") score += 100;
    if (/\bmaster\b/i.test(captions)) score += 50;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** Drop smallest non-master clusters when over expected count (photo-pipeline parity). */
export function capBedroomClustersToExpected<T extends BedroomClusterInput>(
  clusters: T[][],
  maxRooms: number | null,
): { clusters: T[][]; trimmedCount: number } {
  if (maxRooms == null || maxRooms <= 0 || clusters.length <= maxRooms) {
    return { clusters, trimmedCount: 0 };
  }
  const masterIdx = pickMasterClusterIndex(clusters);
  const indexed = clusters.map((c, i) => ({
    i,
    size: c.length,
    isMaster: i === masterIdx,
  }));
  const keep = new Set<number>([masterIdx >= 0 ? masterIdx : 0]);
  const others = indexed
    .filter((x) => !x.isMaster)
    .sort((a, b) => b.size - a.size);
  for (const o of others.slice(0, maxRooms - 1)) keep.add(o.i);
  const capped = clusters.filter((_, i) => keep.has(i));
  return { clusters: capped, trimmedCount: clusters.length - capped.length };
}

export type CrossUnitCluster = {
  unitIndex: number;
  clusterIndex: number;
  repHash?: string;
  rooms: BedroomRoomSummary[];
};

/** Remove listing-level duplicate bedrooms that appear in multiple unit folders. */
export function dedupeCrossUnitBedroomClusters(
  unitClusters: Array<{ label: string; rooms: BedroomRoomSummary[]; repHashes: (string | undefined)[] }>,
): {
  units: Array<{ label: string; rooms: BedroomRoomSummary[] }>;
  dedupedCount: number;
} {
  const seenHashes = new Set<string>();
  const out = unitClusters.map((u) => ({ label: u.label, rooms: [] as BedroomRoomSummary[] }));
  let dedupedCount = 0;
  for (let ui = 0; ui < unitClusters.length; ui++) {
    const u = unitClusters[ui];
    for (let ri = 0; ri < u.rooms.length; ri++) {
      const hash = u.repHashes[ri];
      if (hash && seenHashes.has(hash)) {
        dedupedCount += 1;
        continue;
      }
      if (hash) seenHashes.add(hash);
      out[ui].rooms.push(u.rooms[ri]);
    }
  }
  return { units: out, dedupedCount };
}

export type BedroomRoomSummary = {
  name: string;
  description: string;
  photoCount: number;
  photoIds: string[];
  altViewCount: number;
  bedType?: string | null;
  source?: BedroomPhotoSource;
};

export function summarizeBedroomCluster(
  cluster: BedroomClusterInput[],
  index: number,
  visionDescription?: string,
  source?: BedroomPhotoSource,
): BedroomRoomSummary {
  const name = index === 0 ? "Bedroom 1" : `Bedroom ${index + 1}`;
  const captions = cluster.map((c) => c.caption?.trim()).filter(Boolean) as string[];
  let description = visionDescription?.trim() || "";
  let bedType: string | null = null;
  if (!description) {
    for (const cap of captions) {
      const bt = detectBedTypeFromCaption(cap);
      if (bt) {
        description = bt;
        bedType = bt;
        break;
      }
    }
  } else {
    bedType = detectBedTypeFromCaption(description);
  }
  if (!description) {
    const primary = captions.find((c) => !/alt view/i.test(c)) ?? captions[0];
    description = primary ? primary.replace(/\s*—\s*Alt View$/i, "").trim() : "Bedroom (bed type not identified)";
    bedType = detectBedTypeFromCaption(description);
  }
  const altViewCount = captions.filter((c) => /alt view/i.test(c)).length;
  return {
    name,
    description,
    photoCount: cluster.length,
    photoIds: cluster.map((c) => c.id),
    altViewCount: altViewCount || Math.max(0, cluster.length - 1),
    bedType,
    source,
  };
}

export type UnitBedroomCoverage = {
  label: string;
  folder: string;
  expectedBedrooms: number | null;
  bedroomsFound: number;
  bedroomPhotosTotal: number;
  rooms: BedroomRoomSummary[];
  matchesListing: "yes" | "no" | "n/a";
  tier: BedroomListingTier;
  reason: string;
  trimmedClusterCount?: number;
  expectedBedInventory?: string[];
  bedInventoryMatch?: "yes" | "no" | "n/a";
  bedInventoryReason?: string;
  usedPrecomputed?: boolean;
};

export type ListingBedroomCoverage = {
  expectedListingBedrooms: number | null;
  bedroomsFoundCombined: number;
  matchesListing: "yes" | "no" | "n/a";
  tier: BedroomListingTier;
  reason: string;
  units: UnitBedroomCoverage[];
  crossUnitDeduped?: number;
  trimmedClusterCount?: number;
};

export function deriveBedroomListingTier(
  listingMatches: "yes" | "no" | "n/a",
  units: UnitBedroomCoverage[],
  bedInventoryMatch?: "yes" | "no" | "n/a",
): BedroomListingTier {
  if (listingMatches === "no") return "fail";
  const anyUnitFail = units.some((u) => u.matchesListing === "no");
  const anyWarn =
    units.some((u) => u.tier === "warn" || u.trimmedClusterCount)
    || (bedInventoryMatch === "no");
  if (listingMatches === "yes" && (anyUnitFail || anyWarn)) return "warn";
  if (listingMatches === "yes") return "pass";
  return "fail";
}

export function computeListingBedroomCoverage(
  units: UnitBedroomCoverage[],
  expectedListingBedrooms: number | null,
  crossUnitDeduped = 0,
  listingTrimmed = 0,
): ListingBedroomCoverage {
  const bedroomsFoundCombined = units.reduce((s, u) => s + u.bedroomsFound, 0);
  let matchesListing: "yes" | "no" | "n/a" = "n/a";
  let reason = "Listing bedroom count not provided — showing detected rooms only.";
  if (expectedListingBedrooms != null && expectedListingBedrooms > 0) {
    if (bedroomsFoundCombined >= expectedListingBedrooms) {
      matchesListing = "yes";
      const trimNote = listingTrimmed > 0 ? ` (${listingTrimmed} extra cluster${listingTrimmed === 1 ? "" : "s"} trimmed to match listing).` : "";
      const dedupeNote = crossUnitDeduped > 0 ? ` ${crossUnitDeduped} cross-unit duplicate${crossUnitDeduped === 1 ? "" : "s"} removed.` : "";
      reason =
        bedroomsFoundCombined === expectedListingBedrooms
          ? `Found photos for all ${expectedListingBedrooms} listing bedrooms (${bedroomsFoundCombined}/${expectedListingBedrooms}).${dedupeNote}`
          : `Found photos for at least ${expectedListingBedrooms} listing bedrooms (${bedroomsFoundCombined}/${expectedListingBedrooms} detected).${trimNote}${dedupeNote}`;
    } else {
      matchesListing = "no";
      reason = `Only ${bedroomsFoundCombined}/${expectedListingBedrooms} listing bedrooms have distinct bedroom photos.`;
    }
  }
  const tier = deriveBedroomListingTier(matchesListing, units);
  return {
    expectedListingBedrooms,
    bedroomsFoundCombined,
    matchesListing,
    tier,
    reason,
    units,
    crossUnitDeduped,
    trimmedClusterCount: listingTrimmed,
  };
}

export function computeUnitBedroomCoverage(
  label: string,
  folder: string,
  rooms: BedroomRoomSummary[],
  expectedBedrooms: number | null,
  opts?: {
    trimmedClusterCount?: number;
    expectedBedInventory?: string[];
    bedInventoryMatch?: "yes" | "no" | "n/a";
    bedInventoryReason?: string;
    usedPrecomputed?: boolean;
  },
): UnitBedroomCoverage {
  const bedroomsFound = rooms.length;
  const bedroomPhotosTotal = rooms.reduce((s, r) => s + r.photoCount, 0);
  let matchesListing: "yes" | "no" | "n/a" = "n/a";
  let reason = "Unit bedroom count not provided.";
  let tier: BedroomListingTier = "pass";
  if (expectedBedrooms != null && expectedBedrooms > 0) {
    if (bedroomsFound >= expectedBedrooms) {
      matchesListing = "yes";
      const trimNote = opts?.trimmedClusterCount
        ? ` (${opts.trimmedClusterCount} extra cluster${opts.trimmedClusterCount === 1 ? "" : "s"} trimmed).`
        : "";
      reason =
        bedroomsFound === expectedBedrooms
          ? `${bedroomsFound}/${expectedBedrooms} bedrooms photographed.${trimNote}`
          : `${bedroomsFound}/${expectedBedrooms} bedrooms detected.${trimNote}`;
      if (opts?.bedInventoryMatch === "no") {
        tier = "warn";
        reason += ` Bed inventory mismatch: ${opts.bedInventoryReason ?? "review bed types"}.`;
      } else if (opts?.trimmedClusterCount) {
        tier = "warn";
      }
    } else {
      matchesListing = "no";
      tier = "fail";
      reason = `Only ${bedroomsFound}/${expectedBedrooms} bedrooms have photos.`;
    }
  }
  return {
    label,
    folder,
    expectedBedrooms,
    bedroomsFound,
    bedroomPhotosTotal,
    rooms,
    matchesListing,
    tier,
    reason,
    trimmedClusterCount: opts?.trimmedClusterCount,
    expectedBedInventory: opts?.expectedBedInventory,
    bedInventoryMatch: opts?.bedInventoryMatch,
    bedInventoryReason: opts?.bedInventoryReason,
    usedPrecomputed: opts?.usedPrecomputed,
  };
}

/** Split cluster representatives into vision batches. */
export function batchBedroomVisionRepresentatives<T>(items: T[], batchSize = BEDROOM_VISION_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    out.push(items.slice(i, i + batchSize));
  }
  return out;
}
