import assert from "node:assert";
import {
  agreementImageIdentityHolds,
  hammingDistance,
  THUMBNAIL_IDENTITY_DISTANCE,
} from "../shared/photo-hash-distance";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("photo-hashing-identity: agreement-path image-identity gate (Makahuena / Mauna Lani sibling look-alikes)");

// Real dHash fixtures captured from the 2026-07-06 live incident (our photo vs
// the Google Lens gstatic thumbnail of the matched listing):
//   REAL  = prop24 Makahuena 3BR photo_07 vs Airbnb "1302 Seaside" — the SAME
//           physical unit (we sourced the for-sale I302 listing; it's also an
//           active Airbnb rental). IDENTICAL image → dist 11.
//   LOOK  = draft-13 Mauna Lani Point lanai vs VRBO 2348849 — a DIFFERENT photo
//           of the same shared golf-course view (sibling unit). dist 26.
const REAL_OURS = "0f0f5f796c0e4e0f";
const REAL_THUMB = "0f0f5e2a6cae8e4e"; // identical repost through Google thumbnail
const LOOK_OURS = "5636141a4f676665";
const LOOK_THUMB = "9bb65a0b6c0f96d4"; // shared-view sibling look-alike

// ── the observed distances hold ──────────────────────────────────────────────
check("identical repost measures 11 (well under the 16 default)", hammingDistance(REAL_OURS, REAL_THUMB) === 11);
check("shared-view look-alike measures 26 (well over the 16 default)", hammingDistance(LOOK_OURS, LOOK_THUMB) === 26);
check("default threshold sits in the gap", THUMBNAIL_IDENTITY_DISTANCE === 16);

// ── the gate keeps the REAL repost, drops the LOOK-ALIKE ──────────────────────
check("REAL identical repost still counts toward agreement", agreementImageIdentityHolds(REAL_OURS, REAL_THUMB) === true);
check("LOOK-ALIKE sibling/view does NOT count toward agreement", agreementImageIdentityHolds(LOOK_OURS, LOOK_THUMB) === false);

// ── fail-toward-counting when a hash is missing (no theft-detection regression) ─
check("missing our-photo hash → counts (fail open)", agreementImageIdentityHolds(null, LOOK_THUMB) === true);
check("missing thumbnail hash → counts (fail open)", agreementImageIdentityHolds(REAL_OURS, null) === true);
check("both missing → counts (fail open)", agreementImageIdentityHolds(undefined, undefined) === true);
check("empty-string hash treated as missing → counts", agreementImageIdentityHolds("", "0f0f5e2a6cae8e4e") === true);

// ── boundary + tunability ─────────────────────────────────────────────────────
// A pair exactly AT the threshold counts; one bit past it does not.
const base = "0000000000000000";
const at16 = "000000000000ffff";  // 16 set bits → distance 16
const at17 = "000000000001ffff";  // 17 set bits → distance 17
check("distance exactly == threshold counts", hammingDistance(base, at16) === 16 && agreementImageIdentityHolds(base, at16) === true);
check("distance one past threshold does not count", hammingDistance(base, at17) === 17 && agreementImageIdentityHolds(base, at17) === false);
check("custom (tighter) maxDistance can drop the real fixture", agreementImageIdentityHolds(REAL_OURS, REAL_THUMB, 5) === false);
check("custom (looser) maxDistance can keep the look-alike", agreementImageIdentityHolds(LOOK_OURS, LOOK_THUMB, 30) === true);

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0);
