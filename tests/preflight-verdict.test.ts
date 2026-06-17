// Locks the decisive YES/NO merge for the builder Pre-Flight "Full unit audit"
// (shared/preflight-verdict.ts mergeUnitVerdict). These cases encode the guardrails that came out of
// the adversarial review: a verified photo match is a YES, a DEEP clean is a NO, a SHALLOW clean never
// overrides text (no false Clear), and a real per-unit listing the text pinned is never erased.
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

const verdict = (
  t: PreflightTextResult | undefined,
  p: PreflightPhotoStatus | undefined,
  deep: boolean,
) => mergeUnitVerdict(t, p, deep)?.status;

console.log("preflight-verdict: decisive YES/NO merge");

// ── YES paths ────────────────────────────────────────────────────────────────
check("text confirmed → Listed (confirmed), unchanged",
  verdict(text("confirmed", { url: "https://airbnb.com/rooms/1" }), undefined, false) === "confirmed");

check("photo found (deep) → Listed (photo-confirmed)",
  verdict(text("unconfirmed", { reason: "generic-unit" }), "found", true) === "photo-confirmed");

check("photo found is decisive YES even from a SHALLOW scan (>=2 verified hits is strong)",
  verdict(text("unconfirmed", { reason: "generic-unit" }), "found", false) === "photo-confirmed");

check("photo found overrides a text not-listed → Listed",
  verdict(text("not-listed"), "found", true) === "photo-confirmed");

check("confirmed text is NEVER downgraded by a clean photo scan",
  verdict(text("confirmed", { url: "https://vrbo.com/123" }), "clean", true) === "confirmed");

// ── NO paths (decisive Clear) ──────────────────────────────────────────────────
check("generic-unit unconfirmed + DEEP clean → Clear (the operator's screenshot case)",
  verdict(text("unconfirmed", { reason: "generic-unit", url: "https://booking.com/hotel/x" }), "clean", true) === "not-listed");

check("text not-listed stays Clear (clean photo reinforces)",
  verdict(text("not-listed"), "clean", true) === "not-listed");

check("errored text + DEEP clean → Clear",
  verdict(text("error"), "clean", true) === "not-listed");

// ── Legacy unconfirmed rows collapse to NO unless photos prove YES ───────────────
check("SHALLOW clean + legacy unconfirmed → No (no Review state)",
  verdict(text("unconfirmed", { reason: "generic-unit" }), "clean", false) === "not-listed");

check("unit-pinned legacy unconfirmed + DEEP clean → No",
  verdict(text("unconfirmed", { reason: "unit-pinned", url: "https://airbnb.com/rooms/9" }), "clean", true) === "not-listed");

check("bedroom-conflict legacy unconfirmed + DEEP clean → No",
  verdict(text("unconfirmed", { reason: "bedroom-conflict", url: "https://vrbo.com/77" }), "clean", true) === "not-listed");

check("legacy unconfirmed without photo evidence drops listing URL",
  mergeUnitVerdict(text("unconfirmed", { reason: "unit-pinned", url: "https://airbnb.com/rooms/9" }), "clean", true)?.url == null);

// ── Residual / inconclusive ─────────────────────────────────────────────────────
check("unknown photo + legacy unconfirmed → No",
  verdict(text("unconfirmed", { reason: "generic-unit" }), "unknown", false) === "not-listed");

check("no photo scanned + legacy unconfirmed → No",
  verdict(text("unconfirmed", { reason: "generic-unit" }), undefined, false) === "not-listed");

// ── photo-only collapse (defensive: text endpoint's live path can't emit it, but be safe) ───────────
check("text photo-only → collapses to Listed (photo-confirmed)",
  verdict(text("photo-only", { url: "https://airbnb.com/rooms/2" }), undefined, false) === "photo-confirmed");

check("text photo-only contradicted by a DEEP clean → Clear",
  verdict(text("photo-only", { url: "https://airbnb.com/rooms/2" }), "clean", true) === "not-listed");

// ── No-text branch ──────────────────────────────────────────────────────────────
check("no text + deep clean → Clear",
  verdict(undefined, "clean", true) === "not-listed");
check("no text + shallow clean → undefined (not decisive)",
  mergeUnitVerdict(undefined, "clean", false) === undefined);
check("no text + found → Listed",
  verdict(undefined, "found", true) === "photo-confirmed");

// ── DEEP_PHOTO_MIN sanity ───────────────────────────────────────────────────────
check("DEEP_PHOTO_MIN is above the background scheduler's 3-photo scan", DEEP_PHOTO_MIN > 3);

console.log(failed === 0
  ? `preflight-verdict: all ${passed} checks passed`
  : `preflight-verdict: ${passed} passed, ${failed} FAILED`);
if (failed > 0) process.exit(1);
