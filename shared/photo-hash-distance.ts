// Pure, zero-dependency perceptual-hash DISTANCE math for photo dedup and
// theft detection. Extracted from server/photo-hashing.ts (which also owns the
// sharp-backed dHash computation + the DB backfill) so the distance predicates
// are unit-testable without pulling in storage/db. server/photo-hashing.ts
// re-exports everything here, so existing `./photo-hashing` importers are
// unaffected.

export const HASH_BITS = 64;
export const DUPLICATE_DISTANCE = 5;

// Hamming distance between two equal-length hex hashes. Returns HASH_BITS
// (worst case) for malformed input rather than throwing — callers treat
// unknown-vs-known as "not a match" and move on.
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

// True if two hashes are within DUPLICATE_DISTANCE — i.e. likely the same
// image up to recompression / light crop / watermark removal.
export function isDuplicateHash(a: string, b: string, tolerance = DUPLICATE_DISTANCE): boolean {
  return hammingDistance(a, b) <= tolerance;
}

// Default tolerance for deciding whether OUR photo and a THIRD-PARTY THUMBNAIL
// (a Google Lens gstatic thumbnail) are the SAME image. Looser than
// DUPLICATE_DISTANCE (5) because Google re-crops and heavily recompresses the
// thumbnail: an empirically-IDENTICAL repost measured a dHash distance of 11,
// while same-view / same-floorplan LOOK-ALIKES clustered at 25-36 (2026-07-06
// Makahuena / Mauna Lani Point sibling-look-alike incident — every unit's
// lanai sees the same golf course; same-model condos share a room shell). 16
// sits in that gap with margin on both sides.
export const THUMBNAIL_IDENTITY_DISTANCE = 16;

// Should a multi-photo-AGREEMENT Lens hit (a strong VISUAL match with no
// per-hit unit-text confirmation) count as evidence that OUR photo was
// reposted? Only when our photo's dHash and the matched thumbnail's dHash are
// within `maxDistance` — i.e. it is actually our image, not a sibling unit /
// shared view that merely photographs alike. When EITHER hash is missing (our
// row never got hashed, or the thumbnail could not be fetched/decoded) this
// FAILS TOWARD COUNTING (returns true): the scanner must never lose theft
// detection because a thumbnail was momentarily unreachable. SearchAPI returns
// look-alikes and true reposts alike in `visual_matches` (no
// `pages_with_matching_images` to lean on), so this image-identity check is
// the only signal that separates them.
export function agreementImageIdentityHolds(
  ourHash: string | null | undefined,
  thumbnailHash: string | null | undefined,
  maxDistance: number = THUMBNAIL_IDENTITY_DISTANCE,
): boolean {
  if (!ourHash || !thumbnailHash) return true;
  return hammingDistance(ourHash, thumbnailHash) <= maxDistance;
}
