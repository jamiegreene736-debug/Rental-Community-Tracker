import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  assembleGuestyPushPhotos,
  captionFromFilename,
  recentUnitSwapPropertyIds,
  type GuestyPushGallery,
} from "../shared/guesty-photo-repush";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("guesty-photo-repush: post-replacement Guesty gallery re-push");

// ── captionFromFilename ─────────────────────────────────────────────────────
check("captionFromFilename humanizes and title-cases",
  captionFromFilename("03-master_bedroom-king.jpg") === "Master Bedroom King");
check("captionFromFilename mirrors the client (bare numeric stem kept; empty stem → Photo)",
  captionFromFilename("01.jpg") === "01" && captionFromFilename("03-.jpg") === "Photo");

// ── assembleGuestyPushPhotos ────────────────────────────────────────────────
const unitGallery: GuestyPushGallery = {
  folder: "replacement-p32-ukia-a",
  scope: "unit",
  files: ["01-bedroom.jpg", "02-living-room.jpg", "03-kitchen.jpg", "04-hidden.jpg"],
  labels: [
    { filename: "01-bedroom.jpg", label: "Primary Bedroom — King" },
    { filename: "02-living-room.jpg", label: "Living Room", userLabel: "Great Room With Ocean View" },
    { filename: "04-hidden.jpg", label: "Blurry Duplicate", hidden: true },
  ],
  staticLabels: { "03-kitchen.jpg": "Chef's Kitchen" },
};
const communityGallery: GuestyPushGallery = {
  folder: "community-poipu-kai",
  scope: "community",
  files: ["10-tennis.jpg", "11-pool.jpg"],
  labels: [
    { filename: "10-tennis.jpg", label: "Tennis Courts" },
    { filename: "11-pool.jpg", label: "Resort Pool" },
  ],
};

{
  const photos = assembleGuestyPushPhotos([unitGallery, communityGallery]);
  check("hidden photos are dropped",
    !photos.some((p) => p.localPath.includes("04-hidden.jpg")));
  check("localPath is /photos/<folder>/<file>",
    photos.every((p) => /^\/photos\/[^/]+\/[^/]+$/.test(p.localPath)));
  check("userLabel beats the labeler caption",
    photos.some((p) => p.caption === "Great Room With Ocean View"));
  check("static label fills in when no labeler row exists",
    photos.some((p) => p.caption === "Chef's Kitchen"));
  check("unit gallery is hero-first (living before bedroom)",
    photos.findIndex((p) => p.localPath.includes("02-living-room.jpg"))
      < photos.findIndex((p) => p.localPath.includes("01-bedroom.jpg")));
  check("community gallery comes after the unit gallery (caller order preserved)",
    photos.findIndex((p) => p.localPath.startsWith("/photos/community-poipu-kai/"))
      > photos.findIndex((p) => p.localPath.startsWith("/photos/replacement-p32-ukia-a/")));
  check("community gallery is hero-first (pool before tennis)",
    photos.findIndex((p) => p.localPath.includes("11-pool.jpg"))
      < photos.findIndex((p) => p.localPath.includes("10-tennis.jpg")));
}

check("manual sort_order wins over the hero-first default", (() => {
  const photos = assembleGuestyPushPhotos([{
    folder: "unit-x",
    scope: "unit",
    files: ["living.jpg", "bedroom.jpg"],
    labels: [
      { filename: "living.jpg", label: "Living Room", sortOrder: 5 },
      { filename: "bedroom.jpg", label: "Primary Bedroom", sortOrder: 1 },
    ],
  }]);
  return photos[0].localPath.includes("bedroom.jpg");
})());

check("photos with no label row at all fall back to the filename caption", (() => {
  const photos = assembleGuestyPushPhotos([{
    folder: "unit-x", scope: "unit", files: ["05-lanai-view.jpg"], labels: [],
  }]);
  return photos[0]?.caption === "Lanai View";
})());

check("identical files from a shared folder are emitted only once", (() => {
  const photos = assembleGuestyPushPhotos([unitGallery, unitGallery]);
  return photos.filter((p) => p.localPath.includes("01-bedroom.jpg")).length === 1;
})());

check("shared folders preserve distinct per-unit staged candidates", (() => {
  const photos = assembleGuestyPushPhotos([
    {
      folder: "shared-unit-gallery",
      scope: "unit",
      files: ["virtual-staged-unit-a.jpg", "02-kitchen.jpg"],
    },
    {
      folder: "shared-unit-gallery",
      scope: "unit",
      files: ["virtual-staged-unit-b.jpg", "02-kitchen.jpg"],
    },
  ]);
  return photos.filter((p) => p.localPath.endsWith("/02-kitchen.jpg")).length === 1
    && photos.some((p) => p.localPath.endsWith("/virtual-staged-unit-a.jpg"))
    && photos.some((p) => p.localPath.endsWith("/virtual-staged-unit-b.jpg"));
})());

check("empty folders contribute nothing",
  assembleGuestyPushPhotos([{ folder: "unit-x", scope: "unit", files: [] }]).length === 0);

// ── recentUnitSwapPropertyIds ───────────────────────────────────────────────
const NOW = Date.parse("2026-07-05T12:00:00Z");
const day = 24 * 60 * 60 * 1000;

{
  const ids = recentUnitSwapPropertyIds([
    { propertyId: 32, createdAt: new Date(NOW - 1 * day) },
    { propertyId: 20, createdAt: new Date(NOW - 2.5 * day) },
    { propertyId: 32, createdAt: new Date(NOW - 2 * day) },   // dup property
    { propertyId: 7, createdAt: new Date(NOW - 5 * day) },    // outside window
  ], NOW, 3);
  check("3-day window keeps recent swaps and drops older ones",
    ids.length === 2 && ids[0] === 32 && ids[1] === 20);
}
check("ISO-string createdAt is accepted",
  recentUnitSwapPropertyIds([{ propertyId: 9, createdAt: "2026-07-04T00:00:00.000Z" }], NOW, 3)
    .includes(9));
check("rows without a parseable createdAt are skipped",
  recentUnitSwapPropertyIds([
    { propertyId: 9, createdAt: null },
    { propertyId: 10, createdAt: "not-a-date" },
  ], NOW, 3).length === 0);
check("boundary: a swap exactly windowDays old is still included",
  recentUnitSwapPropertyIds([{ propertyId: 5, createdAt: new Date(NOW - 3 * day) }], NOW, 3)
    .includes(5));

// ── source assertions — the wiring the pure tests can't see ────────────────
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(here, "..", rel), "utf8");

{
  const src = read("server/auto-replace-jobs.ts");
  check("auto-replace commit opts out of the route's fire-and-forget push (skipGuestyPhotoPush)",
    src.includes("skipGuestyPhotoPush: true"));
  check("auto-replace phase 3 awaits its own Guesty photo re-push",
    src.includes("repushGuestyPhotosForProperty(record.propertyId"));
  check("auto-replace surfaces a push failure with the manual fallback hint",
    src.includes("Push Photos to Guesty"));
}
{
  const src = read("server/routes.ts");
  check("POST /api/unit-swaps fires the Guesty photo re-push after commit",
    src.includes("repushGuestyPhotosForProperty(parsed.data.propertyId"));
  check("POST /api/unit-swaps honors the skipGuestyPhotoPush opt-out",
    src.includes("skipGuestyPhotoPush === true"));
  check("retroactive repush endpoint exists",
    src.includes("/api/replacement/repush-guesty-photos"));
  check("strict final-audit push pins the trusted current URL directly instead of failing on a stale pre-read",
    src.includes('? { original: requiredCoverCollageUrl, caption: "Cover Collage" }')
    && src.includes("if (!requiredCoverCollageUrl) {")
    && src.includes("prove the whole exact ordered gallery with the retrying read-back below"));
  check("required collage identity is rejected unless the request is authenticated internal loopback",
    src.includes("rawRequiredCoverCollageUrl != null && !isAuthenticatedInternalGalleryPush(req)")
    && src.includes('req.headers["x-admin-secret"]')
    && src.includes("supplied.length === expected.length && timingSafeEqual(supplied, expected)"));
  check("strict final-audit verification compares the exact normalized ordered gallery with Cover Collage first",
    src.includes("strictGuestyPicturesExactlyMatch(savedPictures, picturesForPut())")
    && src.includes('savedFirst?.caption === "Cover Collage"')
    && src.includes('strictGalleryVerification ? exactMatch : savedLen >= expectedTotal')
    && src.includes('strictGalleryVerified'));
  check("strict gallery mode requires the explicit trusted URL; intermediate/manual pushes keep count verification",
    src.includes("const strictGalleryVerification = requiredCoverCollageUrl != null")
    && !src.includes("strictGalleryVerificationRequirement")
    && src.includes("intermediate replacement")
    && src.includes('strictGalleryVerification ? exactMatch : savedLen >= expectedTotal'));

  // Execute the production comparison helpers directly from their marked
  // source block. Regression: count-only verification used to accept both of
  // these stale galleries, even though hidden/old photos were still present.
  const helperStart = src.indexOf("type NormalizedGuestyPicture");
  const helperEnd = src.indexOf("const AMENITY_SCAN_RECEIPTS_SETTING_KEY", helperStart);
  let strictMatch: ((actual: unknown, expected: unknown) => boolean) | null = null;
  if (helperStart >= 0 && helperEnd > helperStart) {
    const helperSource = `${src.slice(helperStart, helperEnd)}\n(globalThis as any).__strictMatch = strictGuestyPicturesExactlyMatch;`;
    const js = ts.transpileModule(helperSource, {
      compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const context: Record<string, unknown> = { URL };
    vm.runInNewContext(js, context);
    strictMatch = context.__strictMatch as typeof strictMatch;
  }
  const expected = [
    { original: "https://cdn.example/collage.jpg", caption: "Cover Collage" },
    { original: "https://cdn.example/new-unit.jpg", caption: "Unit Patio" },
  ];
  const staleEqualCount = [
    { original: "https://cdn.example/collage.jpg", caption: "Cover Collage" },
    { original: "https://cdn.example/hidden-old.jpg", caption: "Old Angle" },
  ];
  const staleLargerCount = [...staleEqualCount, { original: "https://cdn.example/extra-old.jpg", caption: "Old Bedroom" }];
  const normalizedEquivalent = [
    { url: "https://CDN.EXAMPLE/collage.jpg#stale-fragment", caption: "  Cover   Collage " },
    { url: "https://cdn.example/new-unit.jpg", caption: "Unit Patio" },
  ];
  check("strict gallery regression: stale equal/greater counts fail, while normalized exact order passes",
    !!strictMatch
    && !strictMatch(staleEqualCount, expected)
    && !strictMatch(staleLargerCount, expected)
    && strictMatch(normalizedEquivalent, expected));
  check("strict gallery regression: an older captioned Cover Collage cannot satisfy this audit's URL identity",
    !!strictMatch
    && !strictMatch([
      { original: "https://cdn.example/older-collage.jpg", caption: "Cover Collage" },
      expected[1],
    ], expected));

  // Execute the internal-auth boundary. A valid portal/admin secret alone is
  // insufficient from a browser/remote socket; the exact URL capability is
  // reserved for the same-process loopback repush.
  const authStart = src.indexOf("function isAuthenticatedInternalGalleryPush(");
  const authEnd = src.indexOf("type NormalizedGuestyPicture", authStart);
  let trustedInternal: ((req: unknown) => boolean) | null = null;
  let normalizeRequiredUrl: ((raw: unknown) => string | null) | null = null;
  let trustedAuthCasesPass = false;
  let emptySecretRejected = false;
  if (authStart >= 0 && authEnd > authStart) {
    const authSource = `${src.slice(authStart, authEnd)}\n(globalThis as any).__trustedInternal = isAuthenticatedInternalGalleryPush;\n(globalThis as any).__normalizeRequiredUrl = normalizeRequiredCoverCollageUrl;`;
    const js = ts.transpileModule(authSource, {
      compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const authEnv = { ADMIN_SECRET: "internal-secret" };
    const context: Record<string, unknown> = {
      Buffer,
      URL,
      timingSafeEqual,
      process: { env: authEnv },
      isLoopback: (req: any) => req?.socket?.remoteAddress === "127.0.0.1",
    };
    vm.runInNewContext(js, context);
    trustedInternal = context.__trustedInternal as typeof trustedInternal;
    normalizeRequiredUrl = context.__normalizeRequiredUrl as typeof normalizeRequiredUrl;
    const internalRequest = { socket: { remoteAddress: "127.0.0.1" }, headers: { "x-admin-secret": "internal-secret" } };
    trustedAuthCasesPass = !!trustedInternal
      && trustedInternal(internalRequest)
      && !trustedInternal({ socket: { remoteAddress: "203.0.113.10" }, headers: { "x-admin-secret": "internal-secret" } })
      && !trustedInternal({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-admin-secret": "wrong-secret" } });
    authEnv.ADMIN_SECRET = "";
    emptySecretRejected = !!trustedInternal && !trustedInternal(internalRequest);
  }
  check("required collage auth regression: only loopback plus the internal secret is accepted",
    trustedAuthCasesPass && emptySecretRejected);
  check("required collage URL regression: only bounded absolute http(s) identities are accepted",
    !!normalizeRequiredUrl
    && normalizeRequiredUrl(" https://cdn.example/current.jpg ") === "https://cdn.example/current.jpg"
    && normalizeRequiredUrl("http://cdn.example/current.jpg") === "http://cdn.example/current.jpg"
    && normalizeRequiredUrl("javascript:alert(1)") === null
    && normalizeRequiredUrl("http://") === null
    && normalizeRequiredUrl(`https://cdn.example/${"x".repeat(2_100)}`) === null);
}
{
  const src = read("server/guesty-photo-repush.ts");
  check("server re-push drives the existing push-photos endpoint (full pictures[] replace)",
    src.includes("/api/builder/push-photos"));
  check("server re-push resolves ACTIVE folders (replacement wins over the stale original)",
    src.includes("resolveActiveUnitPhotoFolders"));
  check("per-property pushes are serialized (no concurrent PUT race on pictures[])",
    src.includes("pushTails"));
  check("push waits (bounded) for the fresh folder's Claude labels before publishing captions",
    src.includes("waitForFolderLabels"));
  check("a partial upload or short Guesty read-back is never reported as a completed gallery sync",
    src.includes("successCount === expectedPushCount") &&
    src.includes("verifiedCount >= successCount") &&
    src.includes("only ${verifiedCount}/${successCount} pushed photos were verified on Guesty"));
  check("strict repush sends the required collage identity and requires both exact completion flags",
    src.includes("...(requiredCoverCollageUrl ? { requiredCoverCollageUrl } : {})")
    && src.includes("collagePinned && strictGalleryVerified")
    && src.includes("the exact audit-generated Cover Collage and ordered gallery were not verified on Guesty"));
}

console.log(`\nguesty-photo-repush: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
