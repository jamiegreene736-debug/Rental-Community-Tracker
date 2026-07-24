// Locks the decisive YES/NO merge for the builder Pre-Flight "Full unit audit"
// (shared/preflight-verdict.ts mergeUnitVerdict).
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  mergeUnitVerdict,
  DEEP_PHOTO_MIN,
  firstPreflightPhotoMatchEvidence,
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

// ── Full-audit photo evidence selection ────────────────────────────────────────
const evidence = firstPreflightPhotoMatchEvidence([
  { photoUrl: "javascript:alert(1)", listingUrl: "https://vrbo.com/1" },
  {
    photoUrl: "/photos/unit-b/bedroom.jpg",
    listingUrl: "https://www.vrbo.com/123",
    matchImageUrl: "https://images.example.com/matched.jpg",
    title: "Unit B",
  },
]);
check("photo evidence skips unsafe rows and accepts the app-owned /photos path",
  evidence?.photoUrl === "/photos/unit-b/bedroom.jpg" && evidence.listingUrl === "https://www.vrbo.com/123");

check("photo evidence drops an unsafe optional matched-image URL",
  firstPreflightPhotoMatchEvidence([{
    photoUrl: "https://admin.example.com/photos/unit-b/bedroom.jpg",
    listingUrl: "https://www.vrbo.com/123",
    matchImageUrl: "data:image/svg+xml,unsafe",
  }])?.matchImageUrl === null);

check("photo evidence requires both our image and an http(s) listing link",
  firstPreflightPhotoMatchEvidence([
    { photoUrl: "/photos/unit-b/bedroom.jpg", listingUrl: "javascript:alert(1)" },
  ]) === null);

const preflightPageSource = readFileSync(
  new URL("../client/src/pages/builder-preflight.tsx", import.meta.url),
  "utf8",
);
const routesSource = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
check("full-audit UI renders the exact ours-versus-listing photo comparison",
  preflightPageSource.includes("PhotoMatchComparison") &&
    preflightPageSource.includes("Our photo") &&
    preflightPageSource.includes("Matched on {platformLabel}"));

check("legacy evidence resolves the matched listing image instead of leaving a silent blank",
  preflightPageSource.includes('"/api/photo-listing-check/match-image"') &&
    preflightPageSource.includes("Matched photo unavailable — open the listing to compare."));

check("the live preflight photo search carries both image URLs into the audit result",
  routesSource.includes("photoMatches?: PreflightPhotoMatchEvidence[]") &&
    routesSource.includes("photoUrl: ourPhotoUrl") &&
    routesSource.includes("matchImageUrl"));

console.log(failed === 0
  ? `preflight-verdict: all ${passed} checks passed`
  : `preflight-verdict: ${passed} passed, ${failed} FAILED`);
if (failed > 0) process.exit(1);
