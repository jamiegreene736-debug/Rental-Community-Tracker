import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const routes = fs.readFileSync(path.join(root, "server/routes.ts"), "utf8");
const verifier = fs.readFileSync(path.join(root, "server/replacement-photo-ota-verification.ts"), "utf8");
const client = fs.readFileSync(path.join(root, "client/src/components/unit-replacement-flow.tsx"), "utf8");
const autoReplace = fs.readFileSync(path.join(root, "server/auto-replace-jobs.ts"), "utf8");

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`✓ ${name}`);
    return;
  }
  failed += 1;
  console.error(`✗ ${name}`);
}

const findRouteStart = routes.indexOf('app.post("/api/replacement/find-unit"');
const swapRouteStart = routes.indexOf('app.post("/api/unit-swaps"');
const legacyVerifierStart = routes.indexOf("async function runPhotoReverseSearch");
const legacyVerifierEnd = routes.indexOf("async function runOtaQualifier", legacyVerifierStart);
const findRoute = routes.slice(findRouteStart, swapRouteStart);
const swapRoute = routes.slice(swapRouteStart, routes.indexOf('app.get("/api/unit-swaps/', swapRouteStart));
const legacyVerifier = routes.slice(legacyVerifierStart, legacyVerifierEnd);

check(
  "legacy reverse-image helper no longer returns a hard-coded zero-check result",
  !/void apiKey;[\s\S]{0,300}checked:\s*0[\s\S]{0,100}return/.test(legacyVerifier)
    && legacyVerifier.includes("verifyReplacementPhotoSet"),
);

check(
  "candidate discovery scans the complete normalized gallery instead of a 2-3 photo sample",
  findRoute.includes("photoUrls: proposedPhotoUrls")
    && !/runPhotoReverseSearch\([\s\S]{0,180}maxPhotos:\s*expandedSearch\s*\?\s*2\s*:\s*3/.test(findRoute),
);

check(
  "incomplete photo coverage is an explicit rejecting verdict",
  findRoute.includes('"skipped-photo-incomplete"')
    && findRoute.includes('photoOtaVerification.status !== "verified"'),
);

check(
  "allowOtaListed controls only the property-presence branch",
  findRoute.includes("if (foundOn && allowOtaListed)")
    && findRoute.includes("verifyReplacementPhotoSet")
    && !/allowOtaListed[\s\S]{0,180}photoOtaVerification\.status/.test(findRoute),
);

check(
  "accepted candidate carries a signed receipt and a public coverage summary",
  findRoute.includes("issueReplacementPhotoReceipt")
    && findRoute.includes("photoVerificationReceipt,")
    && findRoute.includes("publicReplacementPhotoVerification"),
);

check(
  "commit endpoint requires and validates the signed receipt",
  swapRoute.includes("photoVerificationReceiptInvalid")
    && swapRoute.includes("validateReplacementPhotoReceipt")
    && swapRoute.includes("propertyId: parsed.data.propertyId")
    && swapRoute.includes("targetUnitId: parsed.data.oldUnitId"),
);

check(
  "commit endpoint re-runs full OTA verification before acquiring the write lock",
  swapRoute.indexOf("const commitPhotoVerification = await verifyReplacementPhotoSet")
    < swapRoute.indexOf("return withUnitSwapPropertyWriteLock"),
);

check(
  "commit rejects matched, incomplete, and content-changed galleries",
  swapRoute.includes('commitPhotoVerification.status === "matched"')
    && swapRoute.includes('commitPhotoVerification.status !== "verified"')
    && swapRoute.includes("replacementPhotoContentDigest(commitPhotoVerification.photos)"),
);

check(
  "hydration is constrained to receipt-verified URLs and content hashes",
  routes.includes("verifiedPhotoUrls: fallbackPhotoUrls")
    && routes.includes("verifiedPhotoContentSha256")
    && routes.includes('candidateRejection: "ota-photo-changed"'),
);

check(
  "interactive client sends the receipt and blocks replacement without complete evidence",
  client.includes("photoVerificationReceipt: result.photoVerificationReceipt")
    && client.includes('disabled={stage === "replacing" || !photosConclusive}'),
);

check(
  "operator UI reports exact checked and total photo counts across all three OTAs",
  client.includes("otaPhotoVerification.checkedPhotos")
    && client.includes("otaPhotoVerification.totalPhotos")
    && client.includes("Airbnb, VRBO, and Booking.com"),
);

check(
  "automatic replacements forward the same authoritative receipt",
  autoReplace.includes('photoVerificationReceipt: String(c.photoVerificationReceipt ?? "")'),
);

check(
  "network verifier retries, fingerprints source and match images, and fails closed",
  verifier.includes("maxLensAttempts")
    && verifier.includes("contentSha256")
    && verifier.includes("agreementImageIdentityHolds")
    && verifier.includes('status: "incomplete"'),
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
