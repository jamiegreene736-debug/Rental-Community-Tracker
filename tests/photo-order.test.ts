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
  isAltView,
  orderGallery,
  bestOrderIndices,
  isOutdoorGrillText,
  parseBedroomSuiteNumber,
  parseBathroomSuiteNumber,
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

// ── suite parsers ────────────────────────────────────────────────────────────
assert.equal(parseBedroomSuiteNumber("Master Bedroom — King"), 1);
assert.equal(parseBedroomSuiteNumber("Bedroom 2 — Queen"), 2);
assert.equal(parseBedroomSuiteNumber("Second Bedroom — Queen"), 2);
assert.equal(parseBedroomSuiteNumber("Primary Bathroom"), null);
assert.equal(parseBathroomSuiteNumber("Primary Bathroom"), 1);
assert.equal(parseBathroomSuiteNumber("Bathroom 2 — Shower/Tub"), 2);
assert.equal(parseBathroomSuiteNumber("Guest Bathroom"), null);
assert.equal(parseBathroomSuiteNumber("Half Bath"), null);
assert.equal(parseBedroomSuiteNumber("Master Bedroom — King (Unit A)"), 1);
assert.equal(parseBedroomSuiteNumber("Bedroom 2 — Queen (Unit B)"), 2);
assert.equal(parseBathroomSuiteNumber("Primary Bathroom (Unit A)"), 1);
assert.equal(parseBathroomSuiteNumber("Bathroom 2 — Alt View (Unit B)"), 2);
console.log("  ✓ bedroom/bathroom suite parsers");

// ── outdoor grill detection ──────────────────────────────────────────────────
assert.equal(isOutdoorGrillText("Gas Grill on Deck"), true);
assert.equal(isOutdoorGrillText("Outdoor BBQ Area"), true);
assert.equal(isOutdoorGrillText("Kitchen with gas grill"), false);
assert.equal(isOutdoorGrillText("Updated Kitchen"), false);
console.log("  ✓ outdoor grill detected separately from kitchen");

// ── categoryRank: unit hero-first ────────────────────────────────────────────
assert.ok(categoryRank("Living Room", "unit") < categoryRank("Primary Bedroom — King", "unit"));
assert.ok(categoryRank("Ocean View Lanai", "unit") < categoryRank("Kitchen", "unit"));
assert.ok(categoryRank("Kitchen", "unit") < categoryRank("Guest Bedroom — Queen", "unit"));
assert.ok(categoryRank("Primary Bedroom", "unit") < categoryRank("Second Bedroom", "unit"));
assert.ok(categoryRank("Guest Bathroom", "unit") > categoryRank("Bedroom — Queen", "unit"));
assert.equal(categoryRank("photo_07", "unit"), OTHER_CATEGORY_RANK);
assert.equal(categoryRank("", "unit"), OTHER_CATEGORY_RANK);
console.log("  ✓ unit category ranks: living/view < kitchen < bedroom < bath < other");

// ── categoryRank: cluster-suffix + keyword-collision fixes ───────────────────
// "Alt View" is the bedroom/bath CLUSTER suffix, not a scenic VIEW — an
// alt-angle must rank with its ROOM so a room's photos stay clustered, instead
// of being pulled to the front like a hero view shot.
assert.equal(
  categoryRank("Master Bedroom — Alt View", "unit"),
  categoryRank("Master Bedroom — King", "unit"),
  "a Master Bedroom alt-view ranks with the master bedroom, not as a scenic view",
);
assert.ok(
  categoryRank("Master Bedroom — Alt View", "unit") > categoryRank("Ocean View Lanai", "unit"),
  "a bedroom alt-view is not a hero scenic shot",
);
// "Primary Bathroom" is a BATH, not a bedroom — the word "primary" must not win.
assert.ok(
  categoryRank("Primary Bathroom — Alt View", "unit") > categoryRank("Master Bedroom — King", "unit"),
  "Primary Bathroom ranks after the master bedroom (bath, not bedroom)",
);
assert.equal(
  categoryRank("Primary Bathroom — Shower", "unit"),
  categoryRank("Bathroom 2 — Double Vanity", "unit"),
  "all bathrooms share the bath rank",
);
// A plain "… Bathroom" caption (no shower/vanity keyword) still ranks as a
// bath, not OTHER — a bare /\bbath\b/ never matched the word "bathroom".
assert.ok(
  categoryRank("Bathroom 2 — Alt View", "unit") < OTHER_CATEGORY_RANK,
  "a plain 'Bathroom' caption ranks as a bath, not OTHER",
);
assert.equal(categoryRank("Guest Bathroom", "unit"), categoryRank("Primary Bathroom — Shower", "unit"));
// A scenic word inside a ROOM caption ranks by the room, not as a view.
assert.ok(
  categoryRank("Dining Room With Mountain View", "unit") > categoryRank("Kitchen", "unit"),
  "Dining Room With Mountain View ranks as dining, not a view",
);
console.log("  ✓ cluster suffixes + bathroom/primary keyword collisions resolved");

// ── isAltView + room-cluster grouping ────────────────────────────────────────
assert.equal(isAltView("Master Bedroom — Alt View"), true);
assert.equal(isAltView("Master Bedroom — King"), false);
assert.equal(isAltView("Outdoor Lanai With Ocean View"), false, "'… View' alone is not an alt view");
const mbr: OrderablePhoto[] & Array<{ id: string }> = [
  { id: "alt1", text: "Master Bedroom — Alt View" },
  { id: "king", text: "Master Bedroom — King" },
  { id: "alt2", text: "Master Bedroom — Alt View" },
  { id: "kitchen", text: "Kitchen With Island" },
  { id: "bathAlt", text: "Primary Bathroom — Alt View" },
  { id: "bath", text: "Primary Bathroom — Shower" },
] as any;
assert.deepEqual(
  orderGallery(mbr, "unit").map((p: any) => p.id),
  ["kitchen", "king", "alt1", "alt2", "bath", "bathAlt"],
  "bedroom + bathroom clusters stay together (primary first), after the kitchen",
);
console.log("  ✓ room clusters group together with the primary shot leading");

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

// Bedroom suites interleave ensuite baths (post-relabel captions).
const suites: P[] = [
  { id: "living", text: "Living Room" },
  { id: "bath2", text: "Bathroom 2 — Shower/Tub" },
  { id: "bed2", text: "Bedroom 2 — Queen" },
  { id: "bath1", text: "Primary Bathroom" },
  { id: "bed1", text: "Master Bedroom — King" },
  { id: "kitchen", text: "Kitchen" },
  { id: "grill", text: "Outdoor BBQ Grill on Deck" },
];
assert.deepEqual(
  orderGallery(suites, "unit").map((p) => p.id),
  ["living", "kitchen", "bed1", "bath1", "bed2", "bath2", "grill"],
  "bedroom suites should pair with ensuite baths; outdoor grill last",
);
console.log("  ✓ orderGallery interleaves bedroom + ensuite bath suites");

const suffixedSuites: P[] = [
  { id: "bath2", text: "Bathroom 2 — Shower/Tub (Unit B)" },
  { id: "bed2", text: "Bedroom 2 — Queen (Unit B)" },
  { id: "bath1", text: "Primary Bathroom (Unit B)" },
  { id: "bed1", text: "Master Bedroom — King (Unit B)" },
];
assert.deepEqual(
  orderGallery(suffixedSuites, "unit").map((p) => p.id),
  ["bed1", "bath1", "bed2", "bath2"],
  "unit suffixes must not break suite/bathroom interleaving",
);
console.log("  ✓ suffixed captions preserve bedroom + ensuite ordering");

// 2BR unit: many master alt views, then primary bath, bedroom 2, bath 2 — not all baths clustered.
const unitB2br: P[] = [
  { id: "k1", text: "Kitchen With Island" },
  { id: "mbr_king", text: "Master Bedroom — King" },
  { id: "mbr_alt1", text: "Master Bedroom — Alt View" },
  { id: "mbr_alt2", text: "Master Bedroom — Alt View" },
  { id: "mbr_alt3", text: "Master Bedroom — Alt View" },
  { id: "pbath1", text: "Primary Bathroom — Shower" },
  { id: "pbath2", text: "Primary Bathroom — Alt View" },
  { id: "bed2", text: "Bedroom 2 — Queen" },
  { id: "bath2a", text: "Bathroom 2 — Double Vanity" },
  { id: "bath2b", text: "Bathroom 2 — Alt View" },
  { id: "laundry", text: "Laundry Room With Washer/Dryer" },
  { id: "grill", text: "Outdoor Grill Station" },
];
assert.deepEqual(
  orderGallery(unitB2br, "unit").map((p) => p.id),
  ["k1", "mbr_king", "mbr_alt1", "mbr_alt2", "mbr_alt3", "pbath1", "pbath2", "bed2", "bath2a", "bath2b", "laundry", "grill"],
  "2BR suites: master+primary bath, then bedroom 2+bath 2; grill last",
);
console.log("  ✓ orderGallery keeps ensuite baths with their bedroom (2BR scenario)");

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
assert.deepEqual(
  bestOrderIndices(
    ["Bathroom 2", "Master Bedroom — King", "Primary Bathroom", "Bedroom 2", "Outdoor BBQ"],
    "unit",
  ),
  [1, 2, 3, 0, 4],
  "bestOrderIndices interleaves suites and puts grill last",
);
console.log("  ✓ bestOrderIndices returns a hero-first permutation");

console.log("photo-order: all assertions passed");
