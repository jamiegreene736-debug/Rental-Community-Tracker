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
  // Plural bed phrase ("twin beds", "queen beds") = two of that type — a room
  // captioned "Guest Bedroom With Twin Beds" has two twins, NOT one. Must run
  // before the singular checks below, which would otherwise read it as one bed.
  if (/\btwin beds\b/.test(lower)) return "Two Twin Beds";
  if (/\bqueen beds\b/.test(lower)) return "Two Queen Beds";
  if (/\bking beds\b/.test(lower)) return "Two King Beds";
  if (/\bdouble beds\b/.test(lower)) return "Two Double Beds";
  if (/\bfull beds\b/.test(lower)) return "Two Full Beds";
  // "Queen Bedroom With Two Beds" = two queens, not one queen + generic beds.
  if (/\bqueen\b/.test(lower) && /\btwo\s+beds\b/.test(lower)) return "Two Queen Beds";
  if (/\bking\b/.test(lower) && /\btwo\s+beds\b/.test(lower)) return "Two King Beds";
  if (/\btwin\b/.test(lower) && /\btwo\s+beds\b/.test(lower)) return "Two Twin Beds";
  if (/\bbunk\b/.test(lower)) return "Bunk Beds";
  if (/\bking\b/.test(lower)) return "King Bed";
  if (/\bqueen\b/.test(lower)) return "Queen Bed";
  if (/\btwin\b/.test(lower)) return "Twin Bed";
  if (/\bdouble\b/.test(lower)) return "Double Bed";
  if (/\bfull\b/.test(lower)) return "Full Bed";
  if (/\bsleeper sofa\b/.test(lower)) return "Sleeper Sofa";
  return null;
}

/** Prefer explicit bed types from operator captions over vision (vision often misreads queen/king). */
export function bedTypeFromClusterCaptions(captions: string[]): string | null {
  const types = captions
    .map((c) => detectBedTypeFromCaption(c))
    .filter((t): t is string => Boolean(t));
  if (types.length === 0) return null;
  if (types.some((t) => /queen/i.test(t))) return types.find((t) => /queen/i.test(t)) ?? types[0];
  if (types.some((t) => /king/i.test(t))) return types.find((t) => /king/i.test(t)) ?? types[0];
  return types[0];
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

/**
 * A sleeper sofa / sofa bed lives in the LIVING ROOM, not a bedroom, so it never
 * appears as a bedroom photo cluster. We ASSUME every condo has one, so a sleeper
 * sofa in the expected inventory is treated as always-present and is excluded
 * from the bedroom bed-inventory comparison — it can never be "missing" and can
 * never turn a unit's bedroom photos amber.
 *
 * Tested on the RAW label, BEFORE normalizeBedType, which would otherwise collapse
 * "Queen Sleeper Sofa" -> "Queen Bed" (line below in detectBedTypeFromCaption the
 * `\bqueen\b` branch wins) and silently demand a phantom SECOND queen bedroom.
 */
export function isSofaBedType(label: string): boolean {
  return /\b(?:sleeper\s+sofa|sofa\s+sleeper|sofa\s*beds?)\b/i.test(String(label ?? ""));
}

/** Compare detected bed types to parsed listing inventory (order-insensitive). */
export function compareBedInventory(
  expected: string[],
  detected: string[],
): { matches: "yes" | "no" | "n/a"; missing: string[]; extra: string[] } {
  // Assume every condo has a sleeper sofa: drop sofa-bed entries from BOTH sides
  // (on the raw label, before normalize) so a never-photographed living-room
  // sleeper sofa can't read as "missing" and flip the unit to amber.
  const expectedReal = expected.filter((e) => !isSofaBedType(e));
  const detectedReal = detected.filter((d) => !isSofaBedType(d));
  if (expectedReal.length === 0) return { matches: "n/a", missing: [], extra: [] };
  const exp = expectedReal.map(normalizeBedType).sort();
  const det = detectedReal.map(normalizeBedType).sort();
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
  filename?: string;
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

/** Best-effort bed type for a cluster (captions first, then explicit bedType). */
export function clusterBedTypeLabel<T extends BedroomClusterInput>(cluster: T[]): string | null {
  const captions = cluster.map((c) => c.caption ?? "").filter(Boolean);
  const fromCaptions = bedTypeFromClusterCaptions(captions);
  if (fromCaptions) return normalizeBedType(fromCaptions);
  for (const c of cluster) {
    if (c.bedType) return normalizeBedType(c.bedType);
  }
  for (const cap of captions) {
    const bt = detectBedTypeFromCaption(cap);
    if (bt) return bt;
  }
  return null;
}

function clusterCaptions<T extends BedroomClusterInput>(cluster: T[]): string[] {
  return cluster.map((c) => c.caption ?? "").filter(Boolean);
}

/** master/primary vs guest, from the cluster's captions (null = unknown). */
function clusterRoomRole<T extends BedroomClusterInput>(cluster: T[]): "master" | "guest" | null {
  const joined = clusterCaptions(cluster).join(" ").toLowerCase();
  if (/\b(master|primary|principal)\b/.test(joined)) return "master";
  if (/\bguest\b/.test(joined)) return "guest";
  return null;
}

/** True when a multi-bed type (two of a kind / bunk). */
function isMultiBedType(bedType: string | null): boolean {
  return !!bedType && (/^two\b/i.test(bedType) || /\bbunk\b/i.test(bedType));
}

/** Caption generically mentions more than one bed (e.g. "Two Beds", "twin beds"). */
function clusterMentionsMultipleBeds<T extends BedroomClusterInput>(cluster: T[]): boolean {
  const joined = clusterCaptions(cluster).join(" ").toLowerCase();
  return /\b(two|both)\s+beds\b/.test(joined)
    || /\b(twin|queen|king|double|full)\s+beds\b/.test(joined);
}

/** Are two bedroom clusters confidently the SAME physical room (different angles)? */
export function bedroomClustersSameRoom<T extends BedroomClusterInput>(a: T[], b: T[]): boolean {
  const aRole = clusterRoomRole(a);
  const bRole = clusterRoomRole(b);
  // Never merge a master with a guest room.
  if (aRole && bRole && aRole !== bRole) return false;

  // Two "master"/"primary" shots are almost always the same master bedroom.
  if (aRole === "master" && bRole === "master") return true;

  const aType = clusterBedTypeLabel(a);
  const bType = clusterBedTypeLabel(b);
  // Identical specific bed type → same room (e.g. both "Two Twin Beds").
  if (aType && bType && aType.toLowerCase() === bType.toLowerCase()) return true;

  // One side names a specific multi-bed type, the other generically says it has
  // multiple beds ("Two Beds") — the common "Twin Beds" + "Two Beds" pairing.
  const aMulti = isMultiBedType(aType);
  const bMulti = isMultiBedType(bType);
  if (aMulti && !bType && clusterMentionsMultipleBeds(b)) return true;
  if (bMulti && !aType && clusterMentionsMultipleBeds(a)) return true;

  return false;
}

/**
 * Merge ALL bedroom clusters that are confidently the same physical room.
 * Unlike mergeBedroomClustersByCaption, this is not bounded by expected count —
 * used when assigning Master Bedroom / Alt View labels after vision relabel.
 */
export function mergeBedroomClustersSameRoom<T extends BedroomClusterInput>(
  clusters: T[][],
): { clusters: T[][]; mergedCount: number } {
  const groups = clusters.map((c) => [...c]);
  let mergedCount = 0;
  let progressed = true;
  while (progressed) {
    progressed = false;
    outer: for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (bedroomClustersSameRoom(groups[i], groups[j])) {
          groups[i] = [...groups[i], ...groups[j]];
          groups.splice(j, 1);
          mergedCount += 1;
          progressed = true;
          break outer;
        }
      }
    }
  }
  return { clusters: groups, mergedCount };
}

/**
 * Merge bedroom clusters that are clearly the SAME room before trimming.
 *
 * Hash clustering splits different-angle shots of one bedroom into separate
 * clusters (a master from two angles, a twin room captioned "Twin Beds" once and
 * "Two Beds" once), inflating the room count → false "extra clusters trimmed" +
 * bed-inventory mismatches. This caption-aware pass folds confident same-room
 * pairs back together. It is bounded: it only runs when there are MORE clusters
 * than the listing's bedroom count, and it never merges below that count — so a
 * unit with genuinely distinct bedrooms is left untouched.
 */
export function mergeBedroomClustersByCaption<T extends BedroomClusterInput>(
  clusters: T[][],
  expectedBedrooms: number | null,
): { clusters: T[][]; mergedCount: number } {
  if (expectedBedrooms == null || expectedBedrooms <= 0 || clusters.length <= expectedBedrooms) {
    return { clusters, mergedCount: 0 };
  }
  const groups = clusters.map((c) => [...c]);
  let mergedCount = 0;
  // Greedily merge the first confident same-room pair, then re-scan, until we
  // reach the expected count or no confident pair remains.
  let progressed = true;
  while (groups.length > expectedBedrooms && progressed) {
    progressed = false;
    outer: for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (bedroomClustersSameRoom(groups[i], groups[j])) {
          groups[i] = [...groups[i], ...groups[j]];
          groups.splice(j, 1);
          mergedCount += 1;
          progressed = true;
          break outer;
        }
      }
    }
  }
  return { clusters: groups, mergedCount };
}

/**
 * Trim extra clusters when over the expected room count.
 *
 * Load-bearing: when a unit has more distinct bedroom photo-clusters than the
 * listing has bedrooms (e.g. two angles of a King bedroom that hash-split into
 * two clusters PLUS a Queen bedroom), the trim must KEEP a diverse set of bed
 * types — never drop a unique Queen to keep a duplicate King. The old size-only
 * trim biased toward King (via pickMasterClusterIndex's +100) and produced false
 * "missing Queen Bed" inventory mismatches. Selection priority: (1) cover bed
 * types the listing expects, (2) prefer distinct bed types over duplicates,
 * (3) fill remaining slots by cluster size.
 */
export function capBedroomClustersToExpected<T extends BedroomClusterInput>(
  clusters: T[][],
  maxRooms: number | null,
  opts?: { expectedBedInventory?: string[] },
): { clusters: T[][]; trimmedCount: number } {
  if (maxRooms == null || maxRooms <= 0 || clusters.length <= maxRooms) {
    return { clusters, trimmedCount: 0 };
  }
  const masterIdx = pickMasterClusterIndex(clusters);
  const startIdx = masterIdx >= 0 ? masterIdx : 0;
  const keep = new Set<number>([startIdx]);

  const expectedRemaining = new Map<string, number>();
  for (const t of opts?.expectedBedInventory ?? []) {
    // A sleeper sofa isn't a bedroom — don't let it steer which bedroom clusters
    // we keep (and don't let "Queen Sleeper Sofa" masquerade as a Queen Bed).
    if (isSofaBedType(t)) continue;
    const k = normalizeBedType(t).toLowerCase();
    expectedRemaining.set(k, (expectedRemaining.get(k) ?? 0) + 1);
  }
  const keptTypes = new Set<string>();
  const consume = (idx: number) => {
    const t = clusterBedTypeLabel(clusters[idx]);
    if (!t) return;
    const k = t.toLowerCase();
    keptTypes.add(k);
    const left = expectedRemaining.get(k);
    if (left && left > 0) expectedRemaining.set(k, left - 1);
  };
  consume(startIdx);

  const meta = clusters
    .map((c, i) => ({ i, size: c.length, type: clusterBedTypeLabel(c) }))
    .filter((x) => !keep.has(x.i));

  const fill = (predicate: (x: { i: number; size: number; type: string | null }) => boolean) => {
    while (keep.size < maxRooms) {
      const candidate = meta
        .filter((x) => !keep.has(x.i) && predicate(x))
        .sort((a, b) => b.size - a.size)[0];
      if (!candidate) break;
      keep.add(candidate.i);
      consume(candidate.i);
    }
  };

  // 1) Cover bed types the listing expects but we have not kept yet.
  fill((x) => !!x.type && (expectedRemaining.get(x.type.toLowerCase()) ?? 0) > 0);
  // 2) Prefer distinct bed types over duplicates (diversity).
  fill((x) => !!x.type && !keptTypes.has(x.type.toLowerCase()));
  // 3) Fill any remaining slots, largest cluster first.
  fill(() => true);

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
  /** Filenames in this bedroom cluster (for UI verdict badges). */
  filenames?: string[];
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
  const captionBed = bedTypeFromClusterCaptions(captions);
  let description = "";
  let bedType: string | null = null;

  if (captionBed) {
    description = captionBed;
    bedType = captionBed;
  } else if (visionDescription?.trim()) {
    description = visionDescription.trim();
    bedType = detectBedTypeFromCaption(description);
  }

  if (!description) {
    for (const cap of captions) {
      const bt = detectBedTypeFromCaption(cap);
      if (bt) {
        description = bt;
        bedType = bt;
        break;
      }
    }
  }
  if (!description) {
    const primary = captions.find((c) => !/alt view/i.test(c)) ?? captions[0];
    description = primary ? primary.replace(/\s*—\s*Alt View$/i, "").trim() : "Bedroom (bed type not identified)";
    bedType = detectBedTypeFromCaption(description);
  }
  const altViewCount = captions.filter((c) => /alt view/i.test(c)).length;
  const filenames = cluster
    .map((c) => c.filename)
    .filter((f): f is string => Boolean(f?.trim()));
  return {
    name,
    description,
    photoCount: cluster.length,
    photoIds: cluster.map((c) => c.id),
    filenames: filenames.length > 0 ? filenames : undefined,
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
  // Drive warns off each unit's own tier — a trim that still matched the bed
  // inventory leaves the unit at "pass" and must not re-raise a listing warn.
  const anyWarn =
    units.some((u) => u.tier === "warn")
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
      // A trim whose bed inventory still matches the listing only removed
      // duplicate views of a kept bed type — say so and don't warn on it.
      const cleanTrim = opts?.bedInventoryMatch === "yes";
      const trimNote = opts?.trimmedClusterCount
        ? cleanTrim
          ? ` (${opts.trimmedClusterCount} duplicate bedroom view${opts.trimmedClusterCount === 1 ? "" : "s"} merged).`
          : ` (${opts.trimmedClusterCount} extra cluster${opts.trimmedClusterCount === 1 ? "" : "s"} trimmed).`
        : "";
      reason =
        bedroomsFound === expectedBedrooms
          ? `${bedroomsFound}/${expectedBedrooms} bedrooms photographed.${trimNote}`
          : `${bedroomsFound}/${expectedBedrooms} bedrooms detected.${trimNote}`;
      if (opts?.bedInventoryMatch === "no") {
        tier = "warn";
        reason += ` Bed inventory mismatch: ${opts.bedInventoryReason ?? "review bed types"}.`;
      } else if (opts?.trimmedClusterCount && !cleanTrim) {
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
