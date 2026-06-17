// Locks the decisive YES/NO merge for the builder Pre-Flight "Full unit audit"
// (shared/preflight-verdict.ts mergeUnitVerdict).
import assert from "node:assert";
import {
  mergeUnitVerdict,
  DEEP_PHOTO_MIN,
  type PreflightTextResult,
  type PreflightPhotoStatus,
} from "../shared/preflight-verdict";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

const text = (
  status: PreflightTextResult["status"],
  extra: Partial<PreflightTextResult> = {},
): PreflightTextResult => ({ status, url: null, detection: "", ...extra });

const dual = (
  t: PreflightTextResult | undefined,
  p: PreflightPhotoStatus | undefined,
  deep: boolean,
  extra: { photoPending?: boolean } = {},
) => mergeUnitVerdict(t, p, deep, { requireDual: true, hasPhotoFolder: true, ...extra })?.status;

const quick = (
  t: PreflightTextResult | undefined,
  p: PreflightPhotoStatus | undefined,
  deep: boolean,
) => mergeUnitVerdict(t, p, deep)?.status;

console.log("preflight-verdict: dual + quick merge");

// ── Full unit audit (requireDual) ────────────────────────────────────────────
check("dual: text confirmed + photo found → Listed",
  dual(text("confirmed", { url: "https://airbnb.com/rooms/1" }), "found", true) === "confirmed");

check("dual: photo found WITHOUT text confirm → No (Texas false-positive guard)",
  dual(text("not-listed"), "found", true) === "not-listed");

check("dual: photo found + legacy unconfirmed → No",
  dual(text("unconfirmed", { reason: "generic-unit" }), "found", true) === "not-listed");

check("dual: text confirmed + DEEP clean → No",
  dual(text("confirmed", { url: "https://vrbo.com/1" }), "clean", true) === "not-listed");

check("dual: text not-listed + DEEP clean → No",
  dual(text("not-listed"), "clean", true) === "not-listed");

check("dual: legacy unconfirmed + DEEP clean → No",
  dual(text("unconfirmed", { reason: "generic-unit" }), "clean", true) === "not-listed");

check("dual: photo pending → undefined (still checking)",
  mergeUnitVerdict(text("confirmed"), undefined, false, { requireDual: true, hasPhotoFolder: true, photoPending: true }) === undefined);

check("dual without photo folder: text confirmed → Listed (text-only fallback)",
  mergeUnitVerdict(text("confirmed", { url: "https://airbnb.com/rooms/1" }), undefined, false, { requireDual: true, hasPhotoFolder: false })?.status === "confirmed");

// ── Quick platform check (legacy) ─────────────────────────────────────────────
check("quick: text confirmed → Listed, unchanged",
  quick(text("confirmed", { url: "https://airbnb.com/rooms/1" }), undefined, false) === "confirmed");

check("quick: photo found alone → No (never Listed without text)",
  quick(text("not-listed"), "found", true) === "not-listed");

check("quick: confirmed text is NOT downgraded by a clean photo scan",
  quick(text("confirmed", { url: "https://vrbo.com/123" }), "clean", true) === "confirmed");

check("quick: legacy unconfirmed + DEEP clean → No",
  quick(text("unconfirmed", { reason: "generic-unit" }), "clean", true) === "not-listed");

check("quick: no text + deep clean → No",
  quick(undefined, "clean", true) === "not-listed");

check("quick: no text + found → No",
  quick(undefined, "found", true) === "not-listed");

// ── DEEP_PHOTO_MIN sanity ───────────────────────────────────────────────────────
check("DEEP_PHOTO_MIN is above the background scheduler's 3-photo scan", DEEP_PHOTO_MIN > 3);

console.log(failed === 0
  ? `preflight-verdict: all ${passed} checks passed`
  : `preflight-verdict: ${passed} passed, ${failed} FAILED`);
if (failed > 0) process.exit(1);
