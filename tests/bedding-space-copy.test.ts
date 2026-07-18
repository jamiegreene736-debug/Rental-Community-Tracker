// Locks the guest-facing Space-description grammar and the Bedding tab's
// manual-edit protection. The generated text is pushed verbatim to Guesty's
// publicDescription.space, so grammar bugs ("offers a 2 Kings bed", a
// hardcoded "queen sofa bed" the config never claimed) reached live listings;
// and the tab used to silently regenerate over the operator's manual textarea
// edits on any bedding change or tab switch.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildSpaceDescription,
  describeUnitBedding,
  type PropertyBeddingConfig,
  type UnitBeddingConfig,
} from "../client/src/data/bedding-config";

console.log("bedding-space-copy");

function unit(partial: Partial<UnitBeddingConfig>): UnitBeddingConfig {
  return {
    unitId: "u1",
    unitLabel: "101",
    bedrooms: [],
    bathrooms: [{ id: "bath-0", label: "Hall Bath", isHalf: false, features: ["shower-tub-combo"] }],
    livingRoom: { hasSofaBed: false, sofaBedType: "SOFA_BED", count: 0 },
    ...partial,
  };
}

function configWith(units: UnitBeddingConfig[]): PropertyBeddingConfig {
  return { propertyId: 1, units };
}

// ── Single bed: "offers a King bed" ──────────────────────────────────────────
{
  const text = buildSpaceDescription(configWith([unit({
    bedrooms: [{ roomNumber: 1, label: "Master Bedroom", beds: [{ type: "KING_BED", quantity: 1 }], hasEnsuite: false, ensuiteFeatures: [] }],
  })]));
  assert.ok(text.includes("The Master Bedroom offers a King bed."), `single king sentence, got: ${text}`);
  console.log("  ✓ single bed: 'offers a King bed'");
}

// ── Multiple of one type: "offers 2 Twin beds", never "a 2 … bed" ────────────
{
  const text = buildSpaceDescription(configWith([unit({
    bedrooms: [{ roomNumber: 1, label: "Bedroom 2", beds: [{ type: "SINGLE_BED", quantity: 2 }], hasEnsuite: false, ensuiteFeatures: [] }],
  })]));
  assert.ok(text.includes("The Bedroom 2 offers 2 Twin beds."), `plural twin sentence, got: ${text}`);
  assert.ok(!/offers a \d/.test(text), `no "offers a 2 …" construction, got: ${text}`);
  console.log("  ✓ plural beds: 'offers 2 Twin beds'");
}

// ── Mixed beds join with "and"; 3+ get an Oxford comma ───────────────────────
{
  const text = buildSpaceDescription(configWith([unit({
    bedrooms: [{
      roomNumber: 1, label: "Guest Bedroom",
      beds: [{ type: "QUEEN_BED", quantity: 1 }, { type: "SINGLE_BED", quantity: 2 }],
      hasEnsuite: false, ensuiteFeatures: [],
    }],
  })]));
  assert.ok(text.includes("offers a Queen bed and 2 Twin beds."), `mixed-bed sentence, got: ${text}`);

  const three = buildSpaceDescription(configWith([unit({
    bedrooms: [{
      roomNumber: 1, label: "Bunk Room",
      beds: [{ type: "QUEEN_BED", quantity: 1 }, { type: "SINGLE_BED", quantity: 2 }, { type: "BUNK_BED", quantity: 1 }],
      hasEnsuite: false, ensuiteFeatures: [],
    }],
  })]));
  assert.ok(three.includes("offers a Queen bed, 2 Twin beds, and a bunk bed."), `3-bed list sentence, got: ${three}`);
  console.log("  ✓ mixed beds join naturally");
}

// ── Sofa/bunk labels never double the word "bed" ("Sofa Bed bed") ────────────
{
  const text = buildSpaceDescription(configWith([unit({
    bedrooms: [{ roomNumber: 1, label: "Den", beds: [{ type: "SOFA_BED", quantity: 1 }], hasEnsuite: false, ensuiteFeatures: [] }],
  })]));
  assert.ok(text.includes("The Den offers a sofa bed."), `sofa-bed sentence, got: ${text}`);
  assert.ok(!/bed bed/i.test(text), `no doubled "bed bed", got: ${text}`);
  console.log("  ✓ no doubled 'bed bed' for Sofa/Bunk labels");
}

// ── Living-room sofa line never invents a size ───────────────────────────────
{
  const one = buildSpaceDescription(configWith([unit({
    bedrooms: [{ roomNumber: 1, label: "Master Bedroom", beds: [{ type: "KING_BED", quantity: 1 }], hasEnsuite: false, ensuiteFeatures: [] }],
    livingRoom: { hasSofaBed: true, sofaBedType: "SOFA_BED", count: 1 },
  })]));
  assert.ok(one.includes("The living room has a sofa bed for additional sleeping."), `single sofa line, got: ${one}`);
  assert.ok(!/queen sofa/i.test(one), `no invented "queen sofa bed" size, got: ${one}`);

  const two = buildSpaceDescription(configWith([unit({
    bedrooms: [{ roomNumber: 1, label: "Master Bedroom", beds: [{ type: "KING_BED", quantity: 1 }], hasEnsuite: false, ensuiteFeatures: [] }],
    livingRoom: { hasSofaBed: true, sofaBedType: "SOFA_BED", count: 2 },
  })]));
  assert.ok(two.includes("The living room has 2 sofa beds for additional sleeping."), `double sofa line, got: ${two}`);
  console.log("  ✓ sofa line: no invented size, plural correct");
}

// ── Ensuite phrasing unchanged ───────────────────────────────────────────────
{
  const text = buildSpaceDescription(configWith([unit({
    bedrooms: [{
      roomNumber: 1, label: "Master Bedroom", beds: [{ type: "KING_BED", quantity: 1 }],
      hasEnsuite: true, ensuiteFeatures: ["walk-in-shower", "soaking-tub"],
    }],
  })]));
  assert.ok(
    text.includes("offers a King bed with a private ensuite featuring walk-in shower and soaking tub."),
    `ensuite sentence, got: ${text}`,
  );
  console.log("  ✓ ensuite phrasing intact");
}

// ── ASCII-clean (Booking.com quirk — the space text reaches OTA channels) ────
{
  const text = buildSpaceDescription(configWith([unit({
    bedrooms: [{ roomNumber: 1, label: "Master Bedroom", beds: [{ type: "KING_BED", quantity: 2 }], hasEnsuite: true, ensuiteFeatures: ["jetted-tub"] }],
    livingRoom: { hasSofaBed: true, sofaBedType: "SOFA_BED", count: 1 },
  })]));
  assert.ok(/^[\x00-\x7F]*$/.test(text), `space text must stay ASCII, got: ${text}`);
  console.log("  ✓ space text is ASCII-clean");
}

// ── Source guards: the Bedding tab preserves manual Space edits ──────────────
// The tab must persist hand-edits (loadSpaceTextOverride/saveSpaceTextOverride),
// pause auto-regeneration while dirty, and offer an explicit regenerate that
// clears the override. Regressing any of these silently re-clobbers operator
// edits on the next bedding tweak or tab switch.
{
  const src = readFileSync(
    path.join(process.cwd(), "client", "src", "components", "GuestyListingBuilder", "BeddingTab.tsx"),
    "utf8",
  );
  for (const marker of [
    "loadSpaceTextOverride(propertyId)",
    "saveSpaceTextOverride(propertyId,",
    "clearSpaceTextOverride(propertyId)",
    "if (!spaceDirty) setSpaceText(buildSpaceDescription(config))",
    "btn-regenerate-space",
  ]) {
    assert.ok(src.includes(marker), `BeddingTab.tsx must contain "${marker}"`);
  }
  console.log("  ✓ BeddingTab preserves manual Space edits (source-guarded)");
}

// ── describeUnitBedding: out-of-union draft bed types never render "undefined"
// draft-bedding.ts's parser emits TWIN_BED / FULL_BED / CAL_KING_BED / CRIB /
// AIR_MATTRESS (outside GuestyBedType); the confirmedBedding grounding string
// (2026-07-17) is guest-adjacent and must humanize them instead.
{
  const text = describeUnitBedding(unit({
    bedrooms: [
      { roomNumber: 1, label: "Master Bedroom", beds: [{ type: "CAL_KING_BED" as never, quantity: 1 }], hasEnsuite: false, ensuiteFeatures: [] },
      { roomNumber: 2, label: "Bedroom 2", beds: [{ type: "TWIN_BED" as never, quantity: 2 }], hasEnsuite: false, ensuiteFeatures: [] },
    ],
  }));
  assert.ok(!/undefined/i.test(text), `no "undefined" in describeUnitBedding output, got: ${text}`);
  assert.ok(text.includes("Cal King Bed"), `CAL_KING_BED humanizes, got: ${text}`);
  assert.ok(text.includes("2 Twin Beds"), `TWIN_BED pluralizes humanized, got: ${text}`);
  console.log("  ✓ describeUnitBedding humanizes out-of-union bed types (no 'undefined')");
}

console.log("bedding-space-copy: all tests passed");
