// Locks the PUBLISHED gallery layout the operator asked for (2026-07-18):
//
//   cover collage → <lead unit> → [community divider] → <next unit> → … → community
//
// This is the ACROSS-gallery contract. Ordering WITHIN a gallery stays
// shared/photo-order.ts (locked by tests/photo-order.test.ts).
//
// The source guards at the bottom are the load-bearing half: the layout MUST be
// applied by BOTH push assemblies (the client builder memo AND the server
// re-push), or an automated re-push after a unit swap silently reverts the
// operator's chosen unit order.
import assert from "node:assert";
import fs from "node:fs";

import {
  DEFAULT_UNIT_DIVIDERS,
  MIN_COMMUNITY_PHOTOS_AFTER_DIVIDERS,
  applyUnitOrder,
  captionWithUnitRoomSuffix,
  dividerCaptionFor,
  dividerCount,
  dividerFilenames,
  parsePhotoGalleryLayouts,
  photoGalleryLayoutKey,
  planGalleryLayout,
  serializePhotoGalleryLayouts,
  stripDividerCaptionSuffix,
  stripUnitRoomCaptionSuffix,
  unitDividersEnabled,
  unitGalleryLabel,
  type PhotoGalleryLayout,
} from "../shared/photo-gallery-layout";
import { assembleGuestyPushPhotos } from "../shared/guesty-photo-repush";

console.log("photo-gallery-layout");

// CWD-relative, like tests/photo-dedupe.test.ts — the suite runs from the repo root.
const read = (rel: string) => fs.readFileSync(rel, "utf8");

// ── applyUnitOrder ───────────────────────────────────────────────────────────
const units = [{ unitId: "a" }, { unitId: "b" }, { unitId: "c" }];

assert.deepEqual(applyUnitOrder(units, undefined).map((u) => u.unitId), ["a", "b", "c"]);
assert.deepEqual(applyUnitOrder(units, []).map((u) => u.unitId), ["a", "b", "c"]);
assert.deepEqual(applyUnitOrder(units, ["b", "a", "c"]).map((u) => u.unitId), ["b", "a", "c"]);
// The 2-unit swap the operator actually clicks.
assert.deepEqual(applyUnitOrder([{ unitId: "a" }, { unitId: "b" }], ["b", "a"]).map((u) => u.unitId), ["b", "a"]);
// Partial order: named ids lead, the rest keep natural order behind them.
assert.deepEqual(applyUnitOrder(units, ["c"]).map((u) => u.unitId), ["c", "a", "b"]);
// A STALE id (unit replaced/removed) is ignored and never drops a gallery.
assert.deepEqual(applyUnitOrder(units, ["zz", "b"]).map((u) => u.unitId), ["b", "a", "c"]);
// A NEW unit missing from the saved order still gets pushed.
assert.deepEqual(applyUnitOrder(units, ["b", "a"]).map((u) => u.unitId), ["b", "a", "c"]);
// Duplicate ids in a corrupt saved order can never duplicate a gallery.
assert.deepEqual(applyUnitOrder(units, ["b", "b", "a"]).map((u) => u.unitId), ["b", "a", "c"]);
// Never mutates the input.
const frozenInput = [{ unitId: "a" }, { unitId: "b" }];
applyUnitOrder(frozenInput, ["b", "a"]);
assert.deepEqual(frozenInput.map((u) => u.unitId), ["a", "b"]);
console.log("  ✓ applyUnitOrder: swap, partial, stale ids, new units, dupes, no mutation");

// ── unitGalleryLabel ─────────────────────────────────────────────────────────
assert.equal(unitGalleryLabel(0, 3), "Unit A (3BR)");
assert.equal(unitGalleryLabel(1, 2), "Unit B (2BR)");
assert.equal(unitGalleryLabel(2, 4), "Unit C (4BR)");
// Missing / invalid bedroom counts degrade to the bare letter — never
// "Unit A (undefinedBR)" / "(0BR)" / "(NaNBR)" in a guest-facing caption.
assert.equal(unitGalleryLabel(0, undefined), "Unit A");
assert.equal(unitGalleryLabel(0, null), "Unit A");
assert.equal(unitGalleryLabel(0, 0), "Unit A");
assert.equal(unitGalleryLabel(1, "not a number"), "Unit B");
console.log("  ✓ unitGalleryLabel: letters + bedrooms, safe degrade");

// ── bedroom/bathroom unit suffix ─────────────────────────────────────────────
assert.equal(
  captionWithUnitRoomSuffix("Master Bedroom — King", "Unit A (3BR)", "Bedrooms"),
  "Master Bedroom — King (Unit A)",
);
assert.equal(
  captionWithUnitRoomSuffix("Primary Bathroom — Alt View", "Unit B (2BR)", "Bathrooms"),
  "Primary Bathroom — Alt View (Unit B)",
);
assert.equal(
  captionWithUnitRoomSuffix("A Quiet Place to Recharge", "Unit C (1BR)", "Bedrooms"),
  "A Quiet Place to Recharge (Unit C)",
  "effective category keeps a human bedroom caption contextual",
);
// Static rows may not have category metadata; only structured room prefixes are
// allowed to trigger the fallback.
assert.equal(
  captionWithUnitRoomSuffix("Bedroom 2 — Two Twin Beds", "Unit B (2BR)"),
  "Bedroom 2 — Two Twin Beds (Unit B)",
);
assert.equal(
  captionWithUnitRoomSuffix("Living Room Near Bathroom", "Unit A (3BR)"),
  "Living Room Near Bathroom",
);
assert.equal(
  captionWithUnitRoomSuffix("Bedroom 2 — Queen", "Unit A (3BR)", "Living Spaces"),
  "Bedroom 2 — Queen",
  "an explicit non-room category wins over the caption fallback",
);
assert.equal(
  captionWithUnitRoomSuffix("Bedroom 2 — Queen (Unit A)", "Unit B (2BR)", "Bedrooms"),
  "Bedroom 2 — Queen (Unit B)",
  "a stale logical suffix is corrected rather than compounded",
);
assert.equal(
  captionWithUnitRoomSuffix("Half Bath (Unit B)", "Unit B (2BR)", "Bathrooms"),
  "Half Bath (Unit B)",
  "reapplying the same suffix is idempotent",
);
assert.equal(
  stripUnitRoomCaptionSuffix("Bathroom 2 — Shower (Unit B)", "Bathrooms"),
  "Bathroom 2 — Shower",
);
assert.equal(
  stripUnitRoomCaptionSuffix("Master Bedroom (Unit A)"),
  "Master Bedroom",
  "a structured category-less room is clean when its generated suffix enters edit mode",
);
assert.equal(
  stripUnitRoomCaptionSuffix("Building Entrance (Unit A)", "Exterior"),
  "Building Entrance (Unit A)",
  "a legitimate non-room parenthetical is not stripped",
);
const longUnitCaption = captionWithUnitRoomSuffix("x".repeat(400), "Unit A (3BR)", "Bedrooms");
assert.ok(longUnitCaption.length <= 200);
assert.ok(longUnitCaption.endsWith(" (Unit A)"), "the bounded caption must preserve the complete suffix");
console.log("  ✓ bedroom/bathroom captions get an idempotent, bounded natural-unit suffix");

// ── dividerCaptionFor / stripDividerCaptionSuffix ────────────────────────────
assert.equal(dividerCaptionFor("Resort Pool", "Unit B (3BR)"), "Resort Pool — next: Unit B (3BR)");
// A caption-less photo still says something honest.
assert.equal(dividerCaptionFor("", "Unit B (3BR)"), "Shared resort amenities — next: Unit B (3BR)");
assert.equal(dividerCaptionFor(null, "Unit B"), "Shared resort amenities — next: Unit B");
// No unit label → the photo's own caption, unchanged.
assert.equal(dividerCaptionFor("Resort Pool", ""), "Resort Pool");
// IDEMPOTENT: re-suffixing never compounds, even if a suffixed caption ever
// round-tripped back into photo_labels as the photo's label.
const once = dividerCaptionFor("Resort Pool", "Unit B (3BR)");
assert.equal(dividerCaptionFor(once, "Unit B (3BR)"), once);
assert.equal(dividerCaptionFor(once, "Unit C (2BR)"), "Resort Pool — next: Unit C (2BR)");
assert.equal(stripDividerCaptionSuffix(once), "Resort Pool");
assert.equal(stripDividerCaptionSuffix("Resort Pool"), "Resort Pool");
assert.equal(stripDividerCaptionSuffix(undefined), "");
// Long captions stay inside the cap.
assert.ok(dividerCaptionFor("x".repeat(400), "Unit B (3BR)").length <= 200);
console.log("  ✓ dividerCaptionFor: suffix, fallback, idempotence, cap");

// ── dividerCount ─────────────────────────────────────────────────────────────
assert.equal(MIN_COMMUNITY_PHOTOS_AFTER_DIVIDERS, 1);
assert.equal(dividerCount(2, 10, true), 1);           // 2 units → 1 gap
assert.equal(dividerCount(3, 10, true), 2);
assert.equal(dividerCount(1, 10, true), 0);           // single listing → none
assert.equal(dividerCount(2, 10, false), 0);          // opted out
// Thin community folder: never empties the community block.
assert.equal(dividerCount(2, 2, true), 1);
assert.equal(dividerCount(2, 1, true), 0);
assert.equal(dividerCount(2, 0, true), 0);
assert.equal(dividerCount(3, 2, true), 1);            // fewer dividers, not a dup
console.log("  ✓ dividerCount: gaps, opt-out, community floor");

// ── unitDividersEnabled ──────────────────────────────────────────────────────
assert.equal(DEFAULT_UNIT_DIVIDERS, true);
assert.equal(unitDividersEnabled(null), true);          // operator default: ON
assert.equal(unitDividersEnabled({}), true);            // pre-flag saved row
assert.equal(unitDividersEnabled({ unitDividers: false }), false);
assert.equal(unitDividersEnabled({ unitDividers: true }), true);
console.log("  ✓ unitDividersEnabled defaults ON, explicit false opts out");

// ── planGalleryLayout ────────────────────────────────────────────────────────
type P = { id: string; caption: string };
const u = (id: string, n: number): P[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${id}${i + 1}`, caption: `${id} photo ${i + 1}` }));
const comm = (n: number): P[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, caption: `Community ${i + 1}` }));

const twoUnits = [
  { unitId: "a", label: "Unit A (3BR)", photos: u("a", 3) },
  { unitId: "b", label: "Unit B (2BR)", photos: u("b", 2) },
];

// Default (dividers ON, natural order).
{
  const out = planGalleryLayout({ units: twoUnits, community: comm(4), layout: null });
  assert.deepEqual(
    out.map((x) => x.photo.id),
    ["a1", "a2", "a3", "c1", "b1", "b2", "c2", "c3", "c4"],
  );
  assert.deepEqual(out.map((x) => x.kind), [
    "unit", "unit", "unit", "divider", "unit", "unit", "community", "community", "community",
  ]);
  // The divider is the community HERO, captioned for the unit that follows.
  const divider = out.find((x) => x.kind === "divider")!;
  assert.equal(divider.photo.id, "c1");
  assert.equal(divider.photo.caption, "Community 1 — next: Unit B (2BR)");
  assert.equal(divider.unitId, "b");
  // MOVED, never duplicated — c1 appears exactly once in the whole gallery.
  assert.equal(out.filter((x) => x.photo.id === "c1").length, 1);
  // Every photo appears exactly once overall.
  assert.equal(new Set(out.map((x) => x.photo.id)).size, out.length);
  assert.equal(out.length, 3 + 2 + 4);
}
console.log("  ✓ default layout: A → divider → B → community, divider moved not copied");

// Operator swaps so Unit B leads — the divider now announces Unit A.
{
  const out = planGalleryLayout({
    units: twoUnits,
    community: comm(4),
    layout: { unitOrder: ["b", "a"] },
  });
  assert.deepEqual(
    out.map((x) => x.photo.id),
    ["b1", "b2", "c1", "a1", "a2", "a3", "c2", "c3", "c4"],
  );
  const divider = out.find((x) => x.kind === "divider")!;
  assert.equal(divider.photo.caption, "Community 1 — next: Unit A (3BR)");
  // LOAD-BEARING: reordering the display must NOT rename the units. Unit A is
  // still labelled "Unit A" even though it is published second.
  assert.equal(divider.unitLabel, "Unit A (3BR)");
}
console.log("  ✓ swapped order: B leads, divider announces Unit A, labels never renamed");

// Unit-room captions use the same natural identity and remain correct when B
// leads. The projection is contextual; folder-level input captions stay clean.
{
  const roomA = { id: "a-bedroom", caption: "Master Bedroom — King", category: "Bedrooms" };
  const roomB = { id: "b-bathroom", caption: "Primary Bathroom", category: "Bathrooms" };
  const roomUnits = [
    { unitId: "a", label: "Unit A (3BR)", photos: [roomA] },
    { unitId: "b", label: "Unit B (2BR)", photos: [roomB] },
  ];
  const out = planGalleryLayout({
    units: roomUnits,
    community: [{ id: "pool", caption: "Resort Pool", category: "Amenities" }],
    layout: { unitOrder: ["b", "a"], unitDividers: false },
  });
  assert.deepEqual(out.map((item) => item.photo.caption), [
    "Primary Bathroom (Unit B)",
    "Master Bedroom — King (Unit A)",
    "Resort Pool",
  ]);
  assert.equal(roomA.caption, "Master Bedroom — King");
  assert.equal(roomB.caption, "Primary Bathroom");
}
console.log("  ✓ room suffix follows natural unit identity after a B-first reorder; inputs stay clean");

// Dividers off → the old grouped behaviour, community intact.
{
  const out = planGalleryLayout({
    units: twoUnits,
    community: comm(4),
    layout: { unitDividers: false },
  });
  assert.deepEqual(out.map((x) => x.photo.id), ["a1", "a2", "a3", "b1", "b2", "c1", "c2", "c3", "c4"]);
  assert.ok(!out.some((x) => x.kind === "divider"));
  // Captions untouched when dividers are off.
  assert.equal(out.find((x) => x.photo.id === "c1")!.photo.caption, "Community 1");
}
console.log("  ✓ dividers off reproduces the plain units-then-community grouping");

// Single unit: nothing to divide, nothing to reorder.
{
  const out = planGalleryLayout({
    units: [{ unitId: "a", label: "Unit A (2BR)", photos: u("a", 2) }],
    community: comm(3),
    layout: null,
  });
  assert.deepEqual(out.map((x) => x.photo.id), ["a1", "a2", "c1", "c2", "c3"]);
  assert.ok(!out.some((x) => x.kind === "divider"));
}
{
  const out = planGalleryLayout({
    units: [{
      unitId: "a",
      label: "Unit A (2BR)",
      photos: [{ id: "bed", caption: "Master Bedroom", category: "Bedrooms" }],
    }],
    community: [],
    layout: null,
  });
  assert.equal(out[0].photo.caption, "Master Bedroom");
}
console.log("  ✓ single-unit listing gets no divider");

// Thin community folder: one photo left → no divider, community never empties.
{
  const out = planGalleryLayout({ units: twoUnits, community: comm(1), layout: null });
  assert.deepEqual(out.map((x) => x.photo.id), ["a1", "a2", "a3", "b1", "b2", "c1"]);
  assert.ok(!out.some((x) => x.kind === "divider"));
  assert.equal(out.filter((x) => x.kind === "community").length, 1);
}
// No community photos at all → still a valid gallery.
{
  const out = planGalleryLayout({ units: twoUnits, community: [], layout: null });
  assert.deepEqual(out.map((x) => x.photo.id), ["a1", "a2", "a3", "b1", "b2"]);
}
console.log("  ✓ thin/empty community folder degrades without duplicating a photo");

// Three units, two dividers.
{
  const three = [...twoUnits, { unitId: "c", label: "Unit C (1BR)", photos: u("d", 1) }];
  const out = planGalleryLayout({ units: three, community: comm(5), layout: null });
  assert.deepEqual(
    out.map((x) => x.photo.id),
    ["a1", "a2", "a3", "c1", "b1", "b2", "c2", "d1", "c3", "c4", "c5"],
  );
  const dividers = out.filter((x) => x.kind === "divider");
  assert.equal(dividers.length, 2);
  assert.equal(dividers[0].photo.caption, "Community 1 — next: Unit B (2BR)");
  assert.equal(dividers[1].photo.caption, "Community 2 — next: Unit C (1BR)");
}
console.log("  ✓ three units get two dividers, each announcing the unit that follows");

// An EMPTY unit gallery still gets its divider slot handled without crashing.
{
  const out = planGalleryLayout({
    units: [
      { unitId: "a", label: "Unit A (3BR)", photos: [] },
      { unitId: "b", label: "Unit B (2BR)", photos: u("b", 2) },
    ],
    community: comm(3),
    layout: null,
  });
  assert.deepEqual(out.map((x) => x.photo.id), ["c1", "b1", "b2", "c2", "c3"]);
}
console.log("  ✓ empty unit gallery does not break the layout");

// ── dividerFilenames ─────────────────────────────────────────────────────────
assert.deepEqual(dividerFilenames(["p1.jpg", "p2.jpg", "p3.jpg"], 2, null), ["p1.jpg"]);
assert.deepEqual(dividerFilenames(["p1.jpg", "p2.jpg", "p3.jpg"], 3, null), ["p1.jpg", "p2.jpg"]);
assert.deepEqual(dividerFilenames(["p1.jpg"], 2, null), []);
assert.deepEqual(dividerFilenames(["p1.jpg", "p2.jpg"], 2, { unitDividers: false }), []);
assert.deepEqual(dividerFilenames([], 2, null), []);
console.log("  ✓ dividerFilenames matches the photos planGalleryLayout lifts");

// ── store parse / serialize ──────────────────────────────────────────────────
assert.equal(photoGalleryLayoutKey(4), "4");
assert.equal(photoGalleryLayoutKey(-46), "-46");   // promoted-draft convention

{
  const parsed = parsePhotoGalleryLayouts(
    JSON.stringify({ "4": { unitOrder: ["b", "a"], unitDividers: false, updatedAt: "2026-07-18T00:00:00.000Z" } }),
  );
  assert.deepEqual(parsed["4"].unitOrder, ["b", "a"]);
  assert.equal(parsed["4"].unitDividers, false);
}
// Fail-soft: unreadable / wrong-shaped stores read as "no layouts" (= defaults).
assert.deepEqual(parsePhotoGalleryLayouts(null), {});
assert.deepEqual(parsePhotoGalleryLayouts(""), {});
assert.deepEqual(parsePhotoGalleryLayouts("not json"), {});
assert.deepEqual(parsePhotoGalleryLayouts("[]"), {});
assert.deepEqual(parsePhotoGalleryLayouts(JSON.stringify({ "4": "nope" })), {});
// A row carrying no signal is dropped rather than stored as an empty object.
assert.deepEqual(parsePhotoGalleryLayouts(JSON.stringify({ "4": { updatedAt: "x" } })), {});
// Junk inside unitOrder is scrubbed; dupes collapse.
{
  const parsed = parsePhotoGalleryLayouts(JSON.stringify({ "4": { unitOrder: ["b", "", null, "b", "a"] } }));
  assert.deepEqual(parsed["4"].unitOrder, ["b", "a"]);
}
// Prototype-pollution defense.
{
  const parsed = parsePhotoGalleryLayouts('{"__proto__":{"unitDividers":false}}');
  assert.deepEqual(Object.keys(parsed), []);
  assert.equal(({} as any).unitDividers, undefined);
}
// Round-trip.
{
  const map: Record<string, PhotoGalleryLayout> = {
    "4": { unitOrder: ["b", "a"], unitDividers: true, updatedAt: "2026-07-18T00:00:00.000Z" },
  };
  assert.deepEqual(parsePhotoGalleryLayouts(serializePhotoGalleryLayouts(map)), map);
}
console.log("  ✓ store parse/serialize: fail-soft, scrubbing, proto defense, round-trip");

// ── the SERVER assembly applies the layout ───────────────────────────────────
// This is the automated re-push (after a unit swap / retroactive sweep). It
// must produce the same gallery the operator's manual push does.
{
  const galleries = [
    {
      folder: "unit-a", scope: "unit" as const, unitId: "a", unitLabel: "Unit A (3BR)",
      files: ["a1.jpg", "a2.jpg"],
      labels: [
        { filename: "a1.jpg", label: "Living Room", sortOrder: 0 },
        { filename: "a2.jpg", label: "Master Bedroom", sortOrder: 1 },
      ],
    },
    {
      folder: "unit-b", scope: "unit" as const, unitId: "b", unitLabel: "Unit B (2BR)",
      files: ["b1.jpg"],
      labels: [{ filename: "b1.jpg", label: "Living Room", sortOrder: 0 }],
    },
    {
      folder: "community", scope: "community" as const,
      files: ["c1.jpg", "c2.jpg"],
      labels: [
        { filename: "c1.jpg", label: "Resort Pool", sortOrder: 0 },
        { filename: "c2.jpg", label: "Beach", sortOrder: 1 },
      ],
    },
  ];

  // Default: dividers ON, natural order.
  const def = assembleGuestyPushPhotos(galleries, null);
  assert.deepEqual(def.map((p) => p.localPath), [
    "/photos/unit-a/a1.jpg", "/photos/unit-a/a2.jpg",
    "/photos/community/c1.jpg",
    "/photos/unit-b/b1.jpg",
    "/photos/community/c2.jpg",
  ]);
  assert.equal(def[2].caption, "Resort Pool — next: Unit B (2BR)");
  assert.equal(def[1].caption, "Master Bedroom (Unit A)");

  // Operator swapped the units — the automated re-push honours it.
  const swapped = assembleGuestyPushPhotos(galleries, { unitOrder: ["b", "a"] });
  assert.deepEqual(swapped.map((p) => p.localPath), [
    "/photos/unit-b/b1.jpg",
    "/photos/community/c1.jpg",
    "/photos/unit-a/a1.jpg", "/photos/unit-a/a2.jpg",
    "/photos/community/c2.jpg",
  ]);
  assert.equal(swapped[1].caption, "Resort Pool — next: Unit A (3BR)");
  assert.equal(
    swapped.find((p) => p.localPath.endsWith("/unit-a/a2.jpg"))?.caption,
    "Master Bedroom (Unit A)",
  );

  // Opted out → the historical grouped order, byte-for-byte.
  const off = assembleGuestyPushPhotos(galleries, { unitDividers: false });
  assert.deepEqual(off.map((p) => p.localPath), [
    "/photos/unit-a/a1.jpg", "/photos/unit-a/a2.jpg",
    "/photos/unit-b/b1.jpg",
    "/photos/community/c1.jpg", "/photos/community/c2.jpg",
  ]);
  assert.equal(off[3].caption, "Resort Pool");

  // Hidden photos are still dropped, and no photo is ever duplicated.
  const hidden = assembleGuestyPushPhotos(
    galleries.map((g) => g.folder === "community"
      ? { ...g, labels: [{ filename: "c1.jpg", label: "Resort Pool", hidden: true }, { filename: "c2.jpg", label: "Beach" }] }
      : g),
    null,
  );
  assert.ok(!hidden.some((p) => p.localPath.endsWith("c1.jpg")));
  assert.equal(new Set(hidden.map((p) => p.localPath)).size, hidden.length);
}
console.log("  ✓ assembleGuestyPushPhotos applies unit order + dividers");

// ── SOURCE GUARDS ────────────────────────────────────────────────────────────
// The layout only holds if BOTH push assemblies apply it. Wire one and not the
// other and an automated re-push silently reverts the operator's unit order.
{
  const builder = read("client/src/pages/builder.tsx");
  assert.ok(
    /planGalleryLayout\(\{/.test(builder),
    "builder.tsx must build propertyData.photos through planGalleryLayout — it is both the Photos-tab gallery and the manual push body",
  );
  assert.ok(
    /layout:\s*galleryLayout/.test(builder),
    "builder.tsx must pass the saved layout into planGalleryLayout",
  );
  assert.ok(
    /galleryLayout\]\)/.test(builder),
    "galleryLayout must be in the propertyData memo deps or the gallery won't rebuild when the operator changes the order",
  );
  assert.ok(
    /staticPhoto\s*&&\s*"category"\s+in\s+staticPhoto\s*\?\s*staticPhoto\.category/.test(builder)
      && /getCategory\(folder,\s*filename\)\s*\?\?\s*staticCategory/.test(builder)
      && /\bcategory:\s*e\.category/.test(builder)
      && /roomUnitLabel:/.test(builder),
    "the manual push/display assembly must carry DB-or-static category and natural unit context for room captions",
  );

  const repush = read("server/guesty-photo-repush.ts");
  assert.ok(
    /getPhotoGalleryLayout\(propertyId\)/.test(repush),
    "the automated re-push must READ the saved layout",
  );
  assert.ok(
    /assembleGuestyPushPhotos\(galleries,\s*layout\)/.test(repush),
    "the automated re-push must PASS the layout into the assembly — dropping it reverts the operator's unit order on the next unit swap",
  );
  assert.ok(
    /unitGalleryLabel\(index,\s*unit\.bedrooms\)/.test(repush),
    "the re-push must label units from their NATURAL index so a reorder never renames Unit B to Unit A",
  );
  const sharedRepush = read("shared/guesty-photo-repush.ts");
  assert.ok(
    /gallery\.staticCategories\?\.\[filename\]/.test(sharedRepush)
      && /category:\s*entry\.category/.test(sharedRepush),
    "the automated re-push assembly must carry effective DB-or-static category into the shared caption projection",
  );
  const routes = read("server/routes.ts");
  assert.ok(
    /assemblePhotosFor[\s\S]{0,5000}unitGalleryLabel\(index,\s*unit\.bedrooms\)[\s\S]{0,500}assembleGuestyPushPhotos\(galleries\)/.test(routes),
    "the alert-remediation Guesty assembly must also pass each unit's natural label into the shared caption projection",
  );

  // The divider keeps the COMMUNITY source — every source-driven consumer
  // (community check role/grouping, dedupe folder label, collage pools)
  // classifies photos by that string.
  assert.ok(
    !/dividerSectionSource/.test(builder),
    "the divider must keep the community `source`; a divider-specific source made the photo-community check build a bogus one-photo unit group",
  );
  assert.ok(
    /isUnitDivider:\s*true/.test(builder),
    "the divider must be marked with the explicit isUnitDivider flag instead",
  );

  // The community folder must never be reordered as a partial set.
  const curator = read("client/src/components/GuestyListingBuilder/PhotoCurator.tsx");
  assert.ok(
    /dividerTilesForFolder/.test(curator),
    "PhotoCurator must fold divider tiles back into their folder's persisted order — storage.reorderPhotosInFolder only stamps the filenames it is handed, so a partial order would drift the divider",
  );
  assert.ok(
    /current\.isDivider !== isDivider/.test(curator),
    "sections must split on the divider flag, or a divider followed by an empty unit gallery merges into the community section",
  );
  assert.ok(
    /stripDividerCaptionSuffix/.test(curator),
    "the '— next: Unit B' tail must be stripped before a caption is persisted back to photo_labels",
  );
  assert.ok(
    /stripUnitRoomCaptionSuffix/.test(curator),
    "the generated '(Unit A/B)' room tail must be stripped before any caption is persisted to folder-global photo_labels",
  );
  assert.ok(
    /const editableCaption = stripUnitRoomCaptionSuffix\(effectiveCaption,\s*effectiveCategory\)/.test(curator)
      && /setDraft\(editableCaption\)/.test(curator)
      && /draft\.trim\(\)\s*!==\s*editableCaption/.test(curator),
    "caption editing must start from the clean base so free-form renames cannot retain a generated unit suffix",
  );
  assert.ok(
    /m\?\.userLabel\s*\|\|\s*m\?\.label\s*\|\|\s*tile\.caption/.test(curator),
    "best-order sorting after relabel must prefer the fresh AI metadata over the stale pre-click tile caption",
  );
}
console.log("  ✓ source guards: both assemblies apply the layout; divider stays community-sourced");

console.log("photo-gallery-layout OK");
