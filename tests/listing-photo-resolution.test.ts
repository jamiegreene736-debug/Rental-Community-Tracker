// Network-free unit tests for shared/listing-photo-resolution.ts — the guest
// page photo sharpness upgrade (CDN thumbnail URL → high-res variant of the
// SAME photo). Grounded in the live Thien Tran / Ilikai incident: the sidecar
// harvest embedded media.vrbo.com ...rw=297 srcset thumbnails; the CDN serves
// the identical image at 2738x1825 (verified live 2026-07-06). Plus source
// locks on the routes.ts wiring (render-time self-heal + build-time persist).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  upgradeListingPhotoUrlResolution,
  GUEST_PHOTO_TARGET_WIDTH,
} from "../shared/listing-photo-resolution";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("listing-photo-resolution: upgradeListingPhotoUrlResolution");

const live297 = "https://media.vrbo.com/lodging/38000000/37120000/37119500/37119494/4f242f64.jpg?impolicy=resizecrop&rw=297&ra=fit";
const upgraded = upgradeListingPhotoUrlResolution(live297);
check("live VRBO thumbnail → rw=1200", upgraded.includes(`rw=${GUEST_PHOTO_TARGET_WIDTH}`), upgraded);
check("other params preserved (impolicy + ra)",
  upgraded.includes("impolicy=resizecrop") && upgraded.includes("ra=fit"), upgraded);
check("same path (same photo)", upgraded.includes("/37119494/4f242f64.jpg"), upgraded);

check("rw=598 mid-size also upgraded",
  upgradeListingPhotoUrlResolution("https://media.vrbo.com/lodging/1/2/a.jpg?impolicy=resizecrop&rw=598&ra=fit").includes("rw=1200"));
check("rw at target unchanged (no rewrite churn)",
  upgradeListingPhotoUrlResolution("https://media.vrbo.com/lodging/1/2/a.jpg?rw=1200") === "https://media.vrbo.com/lodging/1/2/a.jpg?rw=1200");
check("larger request never downgraded",
  upgradeListingPhotoUrlResolution("https://media.vrbo.com/lodging/1/2/a.jpg?rw=2000") === "https://media.vrbo.com/lodging/1/2/a.jpg?rw=2000");
check("no rw param (already original) untouched",
  upgradeListingPhotoUrlResolution("https://media.vrbo.com/lodging/1/2/a.jpg") === "https://media.vrbo.com/lodging/1/2/a.jpg");
check("Expedia trvl-media family covered",
  upgradeListingPhotoUrlResolution("https://images.trvl-media.com/lodging/1/2/a.jpg?rw=300").includes("rw=1200"));
check("lookalike host rejected (evil-trvl-media.com)",
  upgradeListingPhotoUrlResolution("https://evil-trvl-media.com/a.jpg?rw=300") === "https://evil-trvl-media.com/a.jpg?rw=300");
check("unknown host untouched (PM sites — no invented variants that could 404)",
  upgradeListingPhotoUrlResolution("https://www.waikikibeachrentals.com/rentals/463/Ilikai-1834-1.jpg")
    === "https://www.waikikibeachrentals.com/rentals/463/Ilikai-1834-1.jpg");
check("relative /photos/ URL untouched",
  upgradeListingPhotoUrlResolution("/photos/ilikai/1.jpg") === "/photos/ilikai/1.jpg");
check("empty/null → empty string",
  upgradeListingPhotoUrlResolution("") === "" && upgradeListingPhotoUrlResolution(null) === "");
check("garbage rw ignored",
  upgradeListingPhotoUrlResolution("https://media.vrbo.com/a.jpg?rw=abc") === "https://media.vrbo.com/a.jpg?rw=abc");

// ── Source assertions: routes.ts wiring ─────────────────────────────────────
console.log("listing-photo-resolution: source wiring");
const here = path.dirname(fileURLToPath(import.meta.url));
const routesSrc = fs.readFileSync(path.join(here, "..", "server", "routes.ts"), "utf8");

check("routes: imports the shared upgrader",
  routesSrc.includes('from "@shared/listing-photo-resolution"'));
check("routes: GET renderer self-heals thumbnails at render time (safeGuestPhotoUrl)",
  routesSrc.includes("return upgradeListingPhotoUrlResolution(url);"));
check("routes: page build persists high-res unit photos post-vision",
  routesSrc.includes("photoFilter.kept.map(upgradeListingPhotoUrlResolution)"));
check("routes: community gallery persisted high-res too",
  routesSrc.includes("pageCommunityPhotos.map(upgradeListingPhotoUrlResolution)"));

console.log(`\nlisting-photo-resolution: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
