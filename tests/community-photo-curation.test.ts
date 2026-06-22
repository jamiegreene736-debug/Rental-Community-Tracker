// Locks the community-photo curation selector used at the tail of the Pre-Flight
// "Re-pull community photos" pipeline: keep ≤10 genuine COMMUNITY-FEATURE photos,
// drop unit interiors / junk / different-community / over-cap photos.
import {
  selectCommunityPhotosToKeep,
  DEFAULT_MAX_COMMUNITY_PHOTOS,
  type CuratableCommunityPhoto,
} from "../shared/community-photo-curation";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("community-photo-curation: keep ≤10 confirmed community features");

const photo = (p: Partial<CuratableCommunityPhoto> & { filename: string }): CuratableCommunityPhoto => ({
  id: p.filename,
  category: "amenity",
  belongs: "yes",
  confidence: 80,
  ...p,
});

// ── cap-to-10 ────────────────────────────────────────────────────────────────
{
  const many = Array.from({ length: 18 }, (_, i) =>
    photo({ filename: `${String(i + 1).padStart(2, "0")}-community.jpg`, confidence: 90 }),
  );
  const r = selectCommunityPhotosToKeep(many);
  check("default cap is 10", DEFAULT_MAX_COMMUNITY_PHOTOS === 10);
  check("keeps at most 10 of 18 amenities", r.keptCount === 10, r.keptCount);
  check("drops the other 8", r.droppedCount === 8, r.droppedCount);
  check("over-cap drops are reasoned as over-limit", r.drop.every((d) => /limit/i.test(d.reason)));
  check("kept + dropped covers every input once", r.keptCount + r.droppedCount === 18);
}

// ── interiors are never kept ─────────────────────────────────────────────────
{
  const r = selectCommunityPhotosToKeep([
    photo({ filename: "01.jpg", category: "amenity" }),
    photo({ filename: "02.jpg", category: "interior" }),
    photo({ filename: "03.jpg", category: "interior", belongs: "yes", confidence: 99 }),
  ]);
  check("keeps the amenity only", r.keep.length === 1 && r.keep[0] === "01.jpg", r.keep);
  check(
    "interiors dropped even at high confidence + belongs:yes",
    r.drop.filter((d) => /interior/i.test(d.reason)).length === 2,
    r.drop,
  );
}

// ── junk / "other" is never kept ─────────────────────────────────────────────
{
  const r = selectCommunityPhotosToKeep([
    photo({ filename: "pool.jpg", category: "amenity" }),
    photo({ filename: "floorplan.jpg", category: "other" }),
    photo({ filename: "logo.jpg", category: "other", confidence: 100 }),
  ]);
  check("keeps only the amenity", r.keep.length === 1 && r.keep[0] === "pool.jpg");
  check("junk dropped with a 'not a community feature' reason", r.drop.filter((d) => /community feature/i.test(d.reason)).length === 2, r.drop);
}

// ── different community is never kept (either signal) ────────────────────────
{
  const r = selectCommunityPhotosToKeep([
    photo({ filename: "ours.jpg", belongs: "yes", communityVerdict: "yes" }),
    photo({ filename: "vision-no.jpg", belongs: "no", confidence: 95 }),
    photo({ filename: "lens-no.jpg", belongs: "yes", communityVerdict: "no", confidence: 95 }),
  ]);
  check("only our community kept", r.keep.length === 1 && r.keep[0] === "ours.jpg", r.keep);
  check("vision belongs:no dropped as different community", r.drop.some((d) => d.filename === "vision-no.jpg" && /different community/i.test(d.reason)));
  check("lens verdict:no dropped as different community", r.drop.some((d) => d.filename === "lens-no.jpg" && /different community/i.test(d.reason)));
}

// ── same-area sibling (uncertain/unsure) STAYS eligible (AGENTS.md #45) ───────
{
  const r = selectCommunityPhotosToKeep([
    photo({ filename: "shared-pool.jpg", belongs: "unsure", communityVerdict: "uncertain" }),
  ]);
  check("uncertain+unsure amenity is kept (not a positive mismatch)", r.keep.length === 1, r.keep);
}

// ── ranking: two-signal confirmation beats one beats none; then confidence ───
{
  const r = selectCommunityPhotosToKeep(
    [
      photo({ filename: "none.jpg", belongs: "unsure", communityVerdict: "uncertain", confidence: 99 }),
      photo({ filename: "both.jpg", belongs: "yes", communityVerdict: "yes", confidence: 50 }),
      photo({ filename: "one.jpg", belongs: "yes", communityVerdict: "uncertain", confidence: 60 }),
    ],
    { max: 3 },
  );
  check("both-signal photo ranks first despite lower confidence", r.keep[0] === "both.jpg", r.keep);
  check("single-signal photo ranks second", r.keep[1] === "one.jpg", r.keep);
  check("no-signal photo ranks last despite highest confidence", r.keep[2] === "none.jpg", r.keep);
}

// ── deterministic: same input → same split, ties break by filename ──────────
{
  const input = [
    photo({ filename: "b.jpg", confidence: 70 }),
    photo({ filename: "a.jpg", confidence: 70 }),
  ];
  const r1 = selectCommunityPhotosToKeep(input, { max: 1 });
  const r2 = selectCommunityPhotosToKeep(input, { max: 1 });
  check("equal-tier/equal-confidence ties break by filename asc", r1.keep[0] === "a.jpg", r1.keep);
  check("deterministic across calls", JSON.stringify(r1) === JSON.stringify(r2));
}

// ── filenames are required to keep/drop a photo ──────────────────────────────
{
  const r = selectCommunityPhotosToKeep([
    photo({ filename: "", id: "C1" }),
    photo({ filename: "real.jpg" }),
  ]);
  check("a photo with no filename is ignored entirely", r.keptCount === 1 && r.droppedCount === 0, r);
}

// ── empty + all-bad inputs ───────────────────────────────────────────────────
{
  check("empty input keeps nothing", selectCommunityPhotosToKeep([]).keptCount === 0);
  const allBad = selectCommunityPhotosToKeep([
    photo({ filename: "i.jpg", category: "interior" }),
    photo({ filename: "o.jpg", category: "other" }),
  ]);
  check("all-interior/junk → keep 0, drop all", allBad.keptCount === 0 && allBad.droppedCount === 2);
}

console.log(`\ncommunity-photo-curation: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
