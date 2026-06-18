// Bedroom photo coverage — pure logic for the photo community check.
// Clusters visually similar bedroom shots so multiple angles of the same
// room count once, then compares distinct rooms to listing bedroom counts.

/** Same-room clustering threshold as photo-pipeline (64-bit dHash). */
export const BEDROOM_CLUSTER_DISTANCE = 16;

const BEDROOM_CAPTION_RE =
  /^(master bedroom|bedroom\s+\d+|king bedroom|queen bedroom|twin bedroom|bunk|two twins?|two queens?|two kings?)/i;

const BEDROOM_KEYWORD_RE =
  /\b(bedroom|king bed|queen bed|twin bed|bunk bed|murphy bed|sleeping area)\b/i;

const NON_BEDROOM_RE =
  /\b(living room|kitchen|bathroom|bath\b|pool|exterior|lobby|dining room|floor\s?plan|map)\b/i;

export function isBedroomPhotoCaption(caption?: string): boolean {
  if (!caption?.trim()) return false;
  const trimmed = caption.trim();
  if (NON_BEDROOM_RE.test(trimmed)) return false;
  if (BEDROOM_CAPTION_RE.test(trimmed)) return true;
  return BEDROOM_KEYWORD_RE.test(trimmed.toLowerCase());
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
  return null;
}

export type BedroomClusterInput = {
  id: string;
  caption?: string;
  hash?: string;
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

export type BedroomRoomSummary = {
  name: string;
  description: string;
  photoCount: number;
  photoIds: string[];
  altViewCount: number;
};

export function summarizeBedroomCluster(
  cluster: BedroomClusterInput[],
  index: number,
  visionDescription?: string,
): BedroomRoomSummary {
  const name = index === 0 ? "Bedroom 1" : `Bedroom ${index + 1}`;
  const captions = cluster.map((c) => c.caption?.trim()).filter(Boolean) as string[];
  let description = visionDescription?.trim() || "";
  if (!description) {
    for (const cap of captions) {
      const bt = detectBedTypeFromCaption(cap);
      if (bt) {
        description = bt;
        break;
      }
    }
  }
  if (!description) {
    const primary = captions.find((c) => !/alt view/i.test(c)) ?? captions[0];
    description = primary ? primary.replace(/\s*—\s*Alt View$/i, "").trim() : "Bedroom (bed type not identified)";
  }
  const altViewCount = captions.filter((c) => /alt view/i.test(c)).length;
  return {
    name,
    description,
    photoCount: cluster.length,
    photoIds: cluster.map((c) => c.id),
    altViewCount: altViewCount || Math.max(0, cluster.length - 1),
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
  reason: string;
};

export type ListingBedroomCoverage = {
  expectedListingBedrooms: number | null;
  bedroomsFoundCombined: number;
  matchesListing: "yes" | "no" | "n/a";
  reason: string;
  units: UnitBedroomCoverage[];
};

export function computeListingBedroomCoverage(
  units: UnitBedroomCoverage[],
  expectedListingBedrooms: number | null,
): ListingBedroomCoverage {
  const bedroomsFoundCombined = units.reduce((s, u) => s + u.bedroomsFound, 0);
  let matchesListing: "yes" | "no" | "n/a" = "n/a";
  let reason = "Listing bedroom count not provided — showing detected rooms only.";
  if (expectedListingBedrooms != null && expectedListingBedrooms > 0) {
    if (bedroomsFoundCombined >= expectedListingBedrooms) {
      matchesListing = "yes";
      reason =
        bedroomsFoundCombined === expectedListingBedrooms
          ? `Found photos for all ${expectedListingBedrooms} listing bedrooms (${bedroomsFoundCombined}/${expectedListingBedrooms}).`
          : `Found photos for at least ${expectedListingBedrooms} listing bedrooms (${bedroomsFoundCombined}/${expectedListingBedrooms} detected — extra may be duplicate labeling).`;
    } else {
      matchesListing = "no";
      reason = `Only ${bedroomsFoundCombined}/${expectedListingBedrooms} listing bedrooms have distinct bedroom photos.`;
    }
  }
  return {
    expectedListingBedrooms,
    bedroomsFoundCombined,
    matchesListing,
    reason,
    units,
  };
}

export function computeUnitBedroomCoverage(
  label: string,
  folder: string,
  rooms: BedroomRoomSummary[],
  expectedBedrooms: number | null,
): UnitBedroomCoverage {
  const bedroomsFound = rooms.length;
  const bedroomPhotosTotal = rooms.reduce((s, r) => s + r.photoCount, 0);
  let matchesListing: "yes" | "no" | "n/a" = "n/a";
  let reason = "Unit bedroom count not provided.";
  if (expectedBedrooms != null && expectedBedrooms > 0) {
    if (bedroomsFound >= expectedBedrooms) {
      matchesListing = "yes";
      reason =
        bedroomsFound === expectedBedrooms
          ? `${bedroomsFound}/${expectedBedrooms} bedrooms photographed.`
          : `${bedroomsFound}/${expectedBedrooms} bedrooms detected (${bedroomsFound - expectedBedrooms} extra cluster${bedroomsFound - expectedBedrooms === 1 ? "" : "s"} — review labels).`;
    } else {
      matchesListing = "no";
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
    reason,
  };
}
