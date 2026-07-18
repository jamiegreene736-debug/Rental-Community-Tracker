import fs from "node:fs";
import path from "node:path";

import {
  blockedBeddingPushReason,
  describeBedroomReconciliation,
  reconcileUnitBedroomSlots,
  type ReconcileBedroomSlot,
} from "../shared/bedding-bedroom-reconcile";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

console.log("bedding-bedroom-reconcile: stale bedroom slots, push guard, wiring");

const slot = (
  roomNumber: number,
  label: string,
  type = "QUEEN_BED",
  quantity = 1,
): ReconcileBedroomSlot => ({
  roomNumber,
  label,
  beds: [{ type, quantity }],
  hasEnsuite: roomNumber === 1,
  ensuiteFeatures: roomNumber === 1 ? ["walk-in-shower"] : [],
});

// ── The live incident: Cliffs at Princeville draft 20 ────────────────────────
// unit1Bedrooms was corrected 3 → 2, but this browser's stored bedding kept a
// third slot. Header read 7 BR (3+4), headlineSleeps inflated accommodates to
// 18, and the Guesty listing was written as a 7BR under a "6BR for 16" title.
const cliffsStored = [
  slot(1, "Master Bedroom", "KING_BED"),
  slot(2, "Bedroom 2", "QUEEN_BED", 2),
  slot(3, "Bedroom 3", "SINGLE_BED", 1), // stale — the unit is a 2BR
];
const cliffsAuthoritative = [slot(1, "Master Bedroom"), slot(2, "Bedroom 2")];
const cliffs = reconcileUnitBedroomSlots(cliffsStored, cliffsAuthoritative);

check("Cliffs draft 20: a 3-slot config against a 2BR record reconciles to 2",
  cliffs.bedrooms.length === 2 && cliffs.dropped === 1 && cliffs.added === 0 && cliffs.changed);
check("Cliffs draft 20: the surviving slots keep the operator's/scan's bed edits verbatim",
  cliffs.bedrooms[0].beds[0].type === "KING_BED" &&
  cliffs.bedrooms[1].beds[0].type === "QUEEN_BED" &&
  cliffs.bedrooms[1].beds[0].quantity === 2 &&
  cliffs.bedrooms[0].hasEnsuite === true &&
  cliffs.bedrooms[0].ensuiteFeatures[0] === "walk-in-shower");
check("Cliffs draft 20: the STALE trailing slot is the one dropped, not a real bedroom",
  cliffs.bedrooms.every((b) => b.beds[0].type !== "SINGLE_BED"));

// ── Length reconciliation ────────────────────────────────────────────────────
check("stored shorter than the record tops up from the defaults",
  (() => {
    const r = reconcileUnitBedroomSlots([slot(1, "Master Bedroom", "KING_BED")],
      [slot(1, "Master Bedroom"), slot(2, "Bedroom 2"), slot(3, "Bedroom 3")]);
    return r.bedrooms.length === 3 && r.added === 2 && r.dropped === 0 && r.changed &&
      r.bedrooms[0].beds[0].type === "KING_BED" && // operator edit preserved
      r.bedrooms[2].label === "Bedroom 3";
  })());
check("matching lengths are a no-op and report no change",
  (() => {
    const stored = [slot(1, "Master Bedroom", "KING_BED"), slot(2, "Bedroom 2")];
    const r = reconcileUnitBedroomSlots(stored, [slot(1, "Master Bedroom"), slot(2, "Bedroom 2")]);
    return !r.changed && r.dropped === 0 && r.added === 0 && r.bedrooms === stored;
  })());
check("roomNumber is renumbered 1..N (buildGuestyListingRooms and the tab's mutators key on it)",
  (() => {
    const r = reconcileUnitBedroomSlots(
      [slot(4, "Master Bedroom"), slot(9, "Bedroom 2"), slot(11, "Bedroom 3")],
      [slot(1, "a"), slot(2, "b")]);
    return r.bedrooms.map((b) => b.roomNumber).join(",") === "1,2";
  })());

// ── Honesty rules ────────────────────────────────────────────────────────────
check("HONESTY: an EMPTY authoritative list is 'unknown', never 'zero bedrooms'",
  (() => {
    const stored = [slot(1, "Master Bedroom"), slot(2, "Bedroom 2")];
    const r = reconcileUnitBedroomSlots(stored, []);
    // A draft whose row hasn't loaded must not empty a real config — that would
    // push `bedrooms: undefined` and an empty listingRooms to the live listing.
    return r.bedrooms.length === 2 && !r.changed && r.bedrooms === stored;
  })());
check("HONESTY: a reconciliation is always describable (never silent)",
  describeBedroomReconciliation("A", { dropped: 1, added: 0 })?.includes("removed 1 bedroom") === true &&
  describeBedroomReconciliation("B", { dropped: 0, added: 2 })?.includes("added 2 bedrooms") === true &&
  describeBedroomReconciliation("A", { dropped: 0, added: 0 }) === null);
check("non-array inputs degrade safely instead of throwing",
  (() => {
    const r = reconcileUnitBedroomSlots(undefined as any, undefined as any);
    return Array.isArray(r.bedrooms) && r.bedrooms.length === 0 && !r.changed;
  })());

// ── Push guard ───────────────────────────────────────────────────────────────
check("push guard BLOCKS the exact live regression (config 7 vs record 6)",
  (() => {
    const reason = blockedBeddingPushReason(7, 6);
    return typeof reason === "string" && reason.includes("7 bedrooms") && reason.includes("6");
  })());
check("push guard allows an agreeing count",
  blockedBeddingPushReason(6, 6) === null);
check("push guard never blocks on an UNKNOWN record count (0 = not loaded yet)",
  blockedBeddingPushReason(6, 0) === null && blockedBeddingPushReason(6, -1) === null);
check("push guard degrades safely on non-finite input",
  blockedBeddingPushReason(NaN, 6) === null && blockedBeddingPushReason(6, NaN) === null);

// ── Wiring guards (the fix is only real if it's on the load + push paths) ────
const cfgSrc = read("client/src/data/bedding-config.ts");
const tabSrc = read("client/src/components/GuestyListingBuilder/BeddingTab.tsx");

check("wiring: normalizeUnit reconciles instead of taking the stored array wholesale",
  cfgSrc.includes("reconcileUnitBedroomSlots(storedBedrooms, def.bedrooms)") &&
  !/const bedrooms: BedroomDetail\[\] = Array\.isArray\(stored\.bedrooms\)/.test(cfgSrc));
check("wiring: loadBeddingConfig routes through the reconciling loader",
  /export function loadBeddingConfig\([^)]*\)[^{]*\{\s*return loadBeddingConfigWithReconciliation\(propertyId\)\.config;/.test(cfgSrc));
check("wiring: the authoritative count is rebuilt from the record, not from stored config",
  /export function authoritativeTotalBedrooms[\s\S]{0,200}buildDefaultBeddingConfig\(propertyId\)/.test(cfgSrc));
check("wiring: the Guesty bedding push is guarded before it sends anything",
  tabSrc.includes("blockedBeddingPushReason(") &&
  tabSrc.includes("authoritativeTotalBedrooms(configToPush.propertyId)") &&
  tabSrc.indexOf("blockedBeddingPushReason(") < tabSrc.indexOf("guestyService.updateListingDetails"));
check("wiring: a blocked push returns ok:false and records the failure (never a silent skip)",
  /if \(blocked\) \{\s*onGuestyPushRecorded\?\.\("error", blocked\);\s*return \{ ok: false/.test(tabSrc));
check("wiring: the scan auto-push shares the guarded push function (no second Guesty write path)",
  (tabSrc.match(/guestyService\.updateListingDetails/g) || []).length === 1 &&
  tabSrc.includes("await pushBeddingConfigToGuesty(scannedGuestyListingId, nextConfig)"));
check("wiring: reconciliations are surfaced to the operator, not applied silently",
  tabSrc.includes("loadBeddingConfigWithReconciliation(propertyId)") &&
  tabSrc.includes('data-testid="bedding-reconciled-notice"') &&
  tabSrc.includes("setReconciledNotes(reconciled)"));

console.log(`\nbedding-bedroom-reconcile: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
