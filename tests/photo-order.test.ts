// Locks the Guesty photo push order the operator asked for (2026-06-19):
//   cover collage → Unit A → Unit B → … → Community,
// hero-first WITHIN each gallery by default, with a manual drag (explicit
// sortOrder) overriding the heuristic. The grouping across galleries is done
// by the builder assembly; this suite locks the pure within-gallery ordering
// + category heuristic that drives both the default order and the
// "Best order" button.
import assert from "node:assert";
import {
  categoryRank,
  scopeForSource,
  hasManualOrder,
  orderGallery,
  bestOrderIndices,
  OTHER_CATEGORY_RANK,
  type OrderablePhoto,
} from "../shared/photo-order";

console.log("photo-order");

// ── scopeForSource ───────────────────────────────────────────────────────────
assert.equal(scopeForSource("Community — Pili Mai"), "community");
assert.equal(scopeForSource("Community - Kaha Lani"), "community");
assert.equal(scopeForSource("Unit A (3BR)"), "unit");
assert.equal(scopeForSource("Unit B (2BR)"), "unit");
assert.equal(scopeForSource(undefined), "unit");
console.log("  ✓ scopeForSource maps community vs unit");

// ── categoryRank: unit hero-first ────────────────────────────────────────────
assert.ok(categoryRank("Living Room", "unit") < categoryRank("Primary Bedroom — King", "unit"));
assert.ok(categoryRank("Ocean View Lanai", "unit") < categoryRank("Kitchen", "unit"));
assert.ok(categoryRank("Kitchen", "unit") < categoryRank("Guest Bedroom — Queen", "unit"));
assert.ok(categoryRank("Primary Bedroom", "unit") < categoryRank("Second Bedroom", "unit"));
assert.ok(categoryRank("Guest Bathroom", "unit") > categoryRank("Bedroom — Queen", "unit"));
assert.equal(categoryRank("photo_07", "unit"), OTHER_CATEGORY_RANK);
assert.equal(categoryRank("", "unit"), OTHER_CATEGORY_RANK);
console.log("  ✓ unit category ranks: living/view < kitchen < bedroom < bath < other");

// ── categoryRank: community hero-first ───────────────────────────────────────
assert.ok(categoryRank("Resort Pool", "community") < categoryRank("Sandy Beach", "community"));
assert.ok(categoryRank("Beach at sunset", "community") < categoryRank("Building Exterior", "community"));
assert.ok(categoryRank("Aerial of the resort", "community") < categoryRank("Tropical Garden", "community"));
assert.ok(categoryRank("Fitness Center", "community") < categoryRank("photo_03", "community"));
console.log("  ✓ community category ranks: pool < beach < exterior < grounds < amenity < other");

// ── hasManualOrder ───────────────────────────────────────────────────────────
assert.equal(hasManualOrder([{ sortOrder: null }, { sortOrder: undefined }]), false);
assert.equal(hasManualOrder([{ sortOrder: null }, { sortOrder: 0 }]), true);
console.log("  ✓ hasManualOrder detects an explicit order");

// ── orderGallery: default hero-first (no manual order) ───────────────────────
type P = OrderablePhoto & { id: string };
const unit: P[] = [
  { id: "bath", text: "Guest Bathroom" },
  { id: "bed2", text: "Second Bedroom — Queen" },
  { id: "kitchen", text: "Kitchen" },
  { id: "living", text: "Living Room" },
  { id: "bedP", text: "Primary Bedroom — King" },
  { id: "lanai", text: "Ocean View Lanai" },
  { id: "misc", text: "photo_09" },
];
assert.deepEqual(
  orderGallery(unit, "unit").map((p) => p.id),
  ["living", "lanai", "kitchen", "bedP", "bed2", "bath", "misc"],
  "default unit order should be hero-first",
);
console.log("  ✓ orderGallery default = hero-first within a unit");

// Stability: equal-rank photos keep their input order.
const tie: P[] = [
  { id: "a", text: "Bedroom — Queen" },
  { id: "b", text: "Bedroom — King" },
  { id: "c", text: "Bedroom — Twin" },
];
assert.deepEqual(orderGallery(tie, "unit").map((p) => p.id), ["a", "b", "c"], "equal ranks are stable");
console.log("  ✓ orderGallery is stable for equal-rank photos");

// ── orderGallery: manual order wins ──────────────────────────────────────────
const dragged: P[] = [
  { id: "living", text: "Living Room", sortOrder: 2 },
  { id: "bath", text: "Guest Bathroom", sortOrder: 0 },
  { id: "bed", text: "Bedroom — King", sortOrder: 1 },
];
assert.deepEqual(
  orderGallery(dragged, "unit").map((p) => p.id),
  ["bath", "bed", "living"],
  "manual sortOrder overrides the hero-first heuristic",
);
console.log("  ✓ orderGallery honors a manual drag over the heuristic");

// Partial manual order: photos without sortOrder fall to the tail by index.
const partial: P[] = [
  { id: "x", text: "Kitchen" },
  { id: "y", text: "Living Room", sortOrder: 0 },
  { id: "z", text: "Bedroom" },
];
assert.deepEqual(orderGallery(partial, "unit").map((p) => p.id), ["y", "x", "z"]);
console.log("  ✓ orderGallery: manual photos lead, un-ordered keep input order");

// Input is not mutated.
const before = unit.map((p) => p.id);
orderGallery(unit, "unit");
assert.deepEqual(unit.map((p) => p.id), before, "orderGallery must not mutate its input");
console.log("  ✓ orderGallery does not mutate input");

// ── bestOrderIndices ─────────────────────────────────────────────────────────
assert.deepEqual(
  bestOrderIndices(["Guest Bathroom", "Living Room", "Kitchen"], "unit"),
  [1, 2, 0],
  "bestOrderIndices returns a hero-first permutation",
);
console.log("  ✓ bestOrderIndices returns a hero-first permutation");

console.log("photo-order: all assertions passed");
