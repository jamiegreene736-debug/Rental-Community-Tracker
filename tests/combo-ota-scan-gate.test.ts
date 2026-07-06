// Locks the pure decision logic of the bulk combo queue's POST-SAVE OTA deep
// scan gate (shared/combo-ota-scan-gate.ts). Posture mirrors the
// photo-community gate: skip ONLY on a POSITIVE "found"; anything unverifiable
// publishes (fail-open) so a SearchAPI outage can never silently skip a batch.
import { evaluateComboOtaScanGate } from "../shared/combo-ota-scan-gate";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

const FOLDERS = ["draft-9-unit-a", "draft-9-unit-b"];
const clean = (folder: string, label: string) => ({
  folder, label, airbnbStatus: "clean", vrboStatus: "clean", bookingStatus: "clean",
});

console.log("combo-ota-scan-gate: decision logic");

// Both units clean → publish, not infra.
{
  const d = evaluateComboOtaScanGate([clean(FOLDERS[0], "Unit A"), clean(FOLDERS[1], "Unit B")], FOLDERS);
  check("both clean → publish", d.decision === "publish" && d.infra === false && d.reasons.length === 0, d);
}

// A single platform "found" on either unit → SKIP, with the platform named.
{
  const d = evaluateComboOtaScanGate([
    clean(FOLDERS[0], "Unit A"),
    { ...clean(FOLDERS[1], "Unit B"), vrboStatus: "found" },
  ], FOLDERS);
  check("VRBO found on Unit B → skip", d.decision === "skip", d);
  check("skip reason names the unit + platform", d.reasons[0]?.includes("Unit B") && d.reasons[0]?.includes("VRBO"), d.reasons);
}

// Multiple platforms found → all named in one reason.
{
  const d = evaluateComboOtaScanGate([
    { ...clean(FOLDERS[0], "Unit A"), airbnbStatus: "found", bookingStatus: "found" },
    clean(FOLDERS[1], "Unit B"),
  ], FOLDERS);
  check("multi-platform found → skip naming both",
    d.decision === "skip" && d.reasons[0]?.includes("Airbnb") && d.reasons[0]?.includes("Booking.com"), d.reasons);
}

// "found" is matched case-insensitively (statuses come from the scanner enum).
{
  const d = evaluateComboOtaScanGate([{ ...clean(FOLDERS[0], "Unit A"), airbnbStatus: "FOUND" }], FOLDERS);
  check("case-insensitive found → skip", d.decision === "skip", d);
}

// unknown / inconclusive statuses are NOT positive findings → publish.
{
  const d = evaluateComboOtaScanGate([
    { folder: FOLDERS[0], label: "Unit A", airbnbStatus: "unknown", vrboStatus: "unknown", bookingStatus: "unknown" },
    { folder: FOLDERS[1], label: "Unit B", airbnbStatus: "clean", vrboStatus: "unknown", bookingStatus: "clean" },
  ], FOLDERS);
  check("unknown statuses → publish (never a skip)", d.decision === "publish", d);
}

// No results at all (scan crashed / returned nothing) → publish flagged infra.
{
  const d = evaluateComboOtaScanGate([], FOLDERS);
  check("no results → publish + infra", d.decision === "publish" && d.infra === true, d);
}
{
  const d = evaluateComboOtaScanGate([null, undefined], FOLDERS);
  check("null rows → publish + infra", d.decision === "publish" && d.infra === true, d);
}

// Partial coverage (one folder missing) → publish, but flagged infra with the
// missing folder named — never a skip.
{
  const d = evaluateComboOtaScanGate([clean(FOLDERS[0], "Unit A")], FOLDERS);
  check("partial coverage → publish + infra naming the missing folder",
    d.decision === "publish" && d.infra === true && d.reasons[0]?.includes(FOLDERS[1]), d);
}

// A found verdict BEATS partial coverage (skip wins over infra).
{
  const d = evaluateComboOtaScanGate([{ ...clean(FOLDERS[0], "Unit A"), airbnbStatus: "found" }], FOLDERS);
  check("found + partial coverage → still skip", d.decision === "skip", d);
}

// Label falls back to the folder name.
{
  const d = evaluateComboOtaScanGate([{ folder: FOLDERS[0], airbnbStatus: "found" }], FOLDERS);
  check("missing label falls back to folder", d.reasons[0]?.includes(FOLDERS[0]), d.reasons);
}

console.log(`\ncombo-ota-scan-gate: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
