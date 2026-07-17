import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  VIRTUAL_STAGING_PROMPT,
  resolveVirtualStagingSources,
  reusableVirtualStagingJobId,
  sameVirtualStagingSelection,
  summarizeCandidateStatuses,
  validateVirtualStagingSelection,
  type SelectableVirtualStagingCandidate,
  type VirtualStagingLabelSnapshot,
} from "../shared/virtual-staging";

let passed = 0;

function test(name: string, run: () => void): void {
  try {
    run();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

function label(
  filename: string,
  overrides: Partial<VirtualStagingLabelSnapshot> = {},
): VirtualStagingLabelSnapshot {
  return {
    filename,
    label: filename,
    category: "Interior",
    confidence: 0.9,
    userLabel: null,
    userCategory: null,
    hidden: false,
    sortOrder: null,
    model: "test",
    perceptualHash: null,
    bedroomClusterId: null,
    bedroomBedType: null,
    channelUsage: null,
    ...overrides,
  };
}

function candidate(
  id: string,
  overrides: Partial<SelectableVirtualStagingCandidate> = {},
): SelectableVirtualStagingCandidate {
  return {
    id,
    status: "succeeded",
    propertyId: 42,
    unitId: "unit-a",
    jobId: "job-1",
    ...overrides,
  };
}

console.log("virtual staging workflow");

test("Unit A source planning contains only Unit A's supplied gallery", () => {
  const sources = resolveVirtualStagingSources({
    diskFilenames: ["a-living.jpg", "a-bed.jpg"],
    labels: [label("a-living.jpg"), label("a-bed.jpg")],
    variants: [],
  });
  assert.deepEqual(sources.map((source) => source.originalFilename), ["a-living.jpg", "a-bed.jpg"]);
  assert.ok(sources.every((source) => !source.originalFilename.startsWith("b-")));
});

test("Unit B source planning contains only Unit B's supplied gallery", () => {
  const sources = resolveVirtualStagingSources({
    diskFilenames: ["b-living.jpg"],
    labels: [label("b-living.jpg")],
    variants: [],
  });
  assert.deepEqual(sources.map((source) => source.originalFilename), ["b-living.jpg"]);
});

test("planning generation does not mutate the gallery inputs", () => {
  const files = ["living.jpg"];
  const labels = [label("living.jpg")];
  const before = JSON.stringify({ files, labels });
  resolveVirtualStagingSources({ diskFilenames: files, labels, variants: [] });
  assert.equal(JSON.stringify({ files, labels }), before);
});

test("cancel can discard a plan without changing active metadata", () => {
  const labels = [label("living.jpg", { userLabel: "Ocean-view living room", sortOrder: 3 })];
  const before = structuredClone(labels);
  const planned = resolveVirtualStagingSources({ diskFilenames: ["living.jpg"], labels, variants: [] });
  assert.equal(planned.length, 1);
  assert.deepEqual(labels, before);
});

test("confirmation validation returns only checked candidate IDs", () => {
  const candidates = [candidate("one"), candidate("two")];
  assert.deepEqual(validateVirtualStagingSelection({
    candidateIds: ["two"], candidates, propertyId: 42, unitId: "unit-a", jobId: "job-1",
  }), ["two"]);
});

test("unchecked candidates are not implicitly selected", () => {
  const candidates = [candidate("one"), candidate("two")];
  const selected = validateVirtualStagingSelection({
    candidateIds: ["one"], candidates, propertyId: 42, unitId: "unit-a", jobId: "job-1",
  });
  assert.equal(selected.includes("two"), false);
});

test("failed generations cannot be applied", () => {
  assert.throws(() => validateVirtualStagingSelection({
    candidateIds: ["bad"],
    candidates: [candidate("bad", { status: "failed" })],
    propertyId: 42,
    unitId: "unit-a",
    jobId: "job-1",
  }), /successfully generated/);
});

test("generated candidate files never become immutable source inputs", () => {
  const sources = resolveVirtualStagingSources({
    diskFilenames: ["original.jpg", "vs-original-abc.jpg"],
    labels: [label("original.jpg", { hidden: true }), label("vs-original-abc.jpg")],
    variants: [{ originalFilename: "original.jpg", candidateFilename: "vs-original-abc.jpg", active: true }],
  });
  assert.deepEqual(sources.map((source) => source.originalFilename), ["original.jpg"]);
  assert.equal(sources[0].activeFilename, "vs-original-abc.jpg");
});

test("existing order and user metadata follow the current active version", () => {
  const sources = resolveVirtualStagingSources({
    diskFilenames: ["second.jpg", "first.jpg", "vs-first.jpg"],
    labels: [
      label("second.jpg", { sortOrder: 2 }),
      label("first.jpg", { hidden: true, sortOrder: 1 }),
      label("vs-first.jpg", { userLabel: "Primary bedroom", userCategory: "Bedroom", sortOrder: 1 }),
    ],
    variants: [{ originalFilename: "first.jpg", candidateFilename: "vs-first.jpg", active: true }],
  });
  assert.deepEqual(sources.map((source) => source.originalFilename), ["first.jpg", "second.jpg"]);
  assert.equal(sources[0].roomLabel, "Primary bedroom");
  assert.equal(sources[0].metadata?.userCategory, "Bedroom");
});

test("invalid mixed-unit selection fails before any apply step", () => {
  assert.throws(() => validateVirtualStagingSelection({
    candidateIds: ["foreign"],
    candidates: [candidate("foreign", { unitId: "unit-b" })],
    propertyId: 42,
    unitId: "unit-a",
    jobId: "job-1",
  }), /does not belong to this unit/);
});

test("duplicate start clicks reuse one active unit job", () => {
  const jobs = [
    { id: "other", propertyId: 42, unitId: "unit-b", status: "running" as const },
    { id: "active", propertyId: 42, unitId: "unit-a", status: "queued" as const },
  ];
  assert.equal(reusableVirtualStagingJobId(jobs, 42, "unit-a"), "active");
});

test("completed jobs are not reused as duplicate submissions", () => {
  assert.equal(reusableVirtualStagingJobId([
    { id: "done", propertyId: 42, unitId: "unit-a", status: "confirmed" },
  ], 42, "unit-a"), null);
});

test("an empty unit produces no stageable photos", () => {
  assert.deepEqual(resolveVirtualStagingSources({ diskFilenames: [], labels: [], variants: [] }), []);
});

test("partial generation success is reviewable with an individual failure", () => {
  assert.deepEqual(summarizeCandidateStatuses(["succeeded", "failed"]), {
    status: "ready",
    total: 2,
    completed: 2,
    failed: 1,
  });
});

test("all-photo generation failure keeps the job failed", () => {
  assert.equal(summarizeCandidateStatuses(["failed", "failed"]).status, "failed");
});

test("re-running staging maps an active variant back to its immutable original", () => {
  const sources = resolveVirtualStagingSources({
    diskFilenames: ["01-room.jpg", "vs-01-room-old.jpg"],
    labels: [label("01-room.jpg", { hidden: true }), label("vs-01-room-old.jpg")],
    variants: [{ originalFilename: "01-room.jpg", candidateFilename: "vs-01-room-old.jpg", active: true }],
  });
  assert.equal(sources[0].originalFilename, "01-room.jpg");
  assert.notEqual(sources[0].originalFilename, sources[0].activeFilename);
});

test("idempotent confirmation accepts the same set in any order", () => {
  assert.equal(sameVirtualStagingSelection(["a", "b"], ["b", "a"]), true);
  assert.equal(sameVirtualStagingSelection(["a"], ["b"]), false);
});

test("candidate IDs from another job are rejected", () => {
  assert.throws(() => validateVirtualStagingSelection({
    candidateIds: ["foreign-job"],
    candidates: [candidate("foreign-job", { jobId: "job-2" })],
    propertyId: 42,
    unitId: "unit-a",
    jobId: "job-1",
  }), /does not belong to this unit/);
});

test("the maintained prompt protects architecture, perspective, and originals", () => {
  assert.match(VIRTUAL_STAGING_PROMPT, /exact base image/i);
  assert.match(VIRTUAL_STAGING_PROMPT, /walls, ceilings, floors, windows, doors/i);
  assert.match(VIRTUAL_STAGING_PROMPT, /camera position, lens perspective, crop/i);
  assert.match(VIRTUAL_STAGING_PROMPT, /Do not move openings/i);
});

test("frontend uses the accessible dialog and keeps zero-photo controls visible", () => {
  const componentPath = path.resolve(
    process.cwd(),
    "client/src/components/GuestyListingBuilder/VirtualStagingDialog.tsx",
  );
  const source = fs.readFileSync(componentPath, "utf8");
  assert.match(source, /DialogTitle/);
  assert.match(source, /Review Virtual Staging/);
  assert.match(source, /Use staged photo/);
  assert.match(source, /onEscapeKeyDown|DialogContent/);

  const builderSource = fs.readFileSync(
    path.resolve(process.cwd(), "client/src/components/GuestyListingBuilder/index.tsx"),
    "utf8",
  );
  assert.match(builderSource, /virtualStagingUnits\?\.length/);
});

test("backend keeps credentials server-side and edits immutable image input", () => {
  const service = fs.readFileSync(
    path.resolve(process.cwd(), "server/virtual-staging-service.ts"),
    "utf8",
  );
  assert.match(service, /process\.env\.OPENAI_API_KEY/);
  assert.match(service, /process\.env\.OPENAI_IMAGE_MODEL/);
  assert.match(service, /images\.edit/);
  assert.match(service, /VIRTUAL_STAGING_PROMPT/);
  assert.doesNotMatch(service, /VITE_OPENAI|NEXT_PUBLIC_OPENAI|REACT_APP_OPENAI/);

  const replicate = fs.readFileSync(
    path.resolve(process.cwd(), "server/replicate-virtual-staging-provider.ts"),
    "utf8",
  );
  assert.match(replicate, /input_image: file\.urls\.get/);
  assert.match(replicate, /aspect_ratio: "match_input_image"/);
  assert.match(replicate, /generatedUrl[\s\S]*Authorization: `Bearer \$\{this\.apiToken\}`/);
  assert.match(replicate, /fetchWithTransientRetry/);
});

test("confirmation uses locked transaction state and hidden file preparation", () => {
  const routes = fs.readFileSync(
    path.resolve(process.cwd(), "server/virtual-staging-routes.ts"),
    "utf8",
  );
  assert.match(routes, /prepareConfirmationFiles\(selected\)/);
  assert.match(routes, /db\.transaction\(async \(tx\)/);
  assert.match(routes, /for\("update"\)/);
  assert.match(routes, /activeFilenameAtRequest/);
  assert.match(routes, /sameVirtualStagingSelection/);
  assert.match(routes, /activatedLabelValues\(candidate, currentLabel\)/);
});

test("confirmation preparation is append-only under concurrent requests", () => {
  const routes = fs.readFileSync(
    path.resolve(process.cwd(), "server/virtual-staging-routes.ts"),
    "utf8",
  );
  const start = routes.indexOf("async function prepareConfirmationFiles");
  const end = routes.indexOf("async function validateConfirmationState", start);
  const preparation = routes.slice(start, end);
  assert.match(preparation, /ensureVirtualStagingGalleryFile/);
  assert.doesNotMatch(preparation, /unlink|delete\(photoLabels\)/);
});

test("generation recovery uses fenced expiring leases", () => {
  const routes = fs.readFileSync(
    path.resolve(process.cwd(), "server/virtual-staging-routes.ts"),
    "utf8",
  );
  assert.match(routes, /generationToken/);
  assert.match(routes, /generationLeaseExpiresAt/);
  assert.match(routes, /lt\(virtualStagingCandidates\.generationLeaseExpiresAt, now\)/);
  assert.match(routes, /status: "pending"[\s\S]*previous generation worker lease expired/i);
  assert.match(routes, /eq\(virtualStagingCandidates\.generationToken, generationToken\)/);

  const schema = fs.readFileSync(
    path.resolve(process.cwd(), "server/schema-maintenance.ts"),
    "utf8",
  );
  assert.match(schema, /ADD COLUMN IF NOT EXISTS generation_token text/);
  assert.match(schema, /ADD COLUMN IF NOT EXISTS generation_lease_expires_at timestamp/);
});

test("retry enqueue is atomic and every detached task is observed", () => {
  const routes = fs.readFileSync(
    path.resolve(process.cwd(), "server/virtual-staging-routes.ts"),
    "utf8",
  );
  const retryStart = routes.indexOf('app.post("/api/virtual-staging/jobs/:jobId/candidates/:candidateId/retry"');
  const retryEnd = routes.indexOf('app.post("/api/virtual-staging/jobs/:jobId/confirm"', retryStart);
  const retryRoute = routes.slice(retryStart, retryEnd);
  assert.match(retryRoute, /db\.transaction\(async \(tx\)/);
  assert.match(retryRoute, /tx\.update\(virtualStagingJobs\)/);
  assert.match(retryRoute, /tx\.update\(virtualStagingCandidates\)/);
  assert.match(retryRoute, /scheduleVirtualStagingTask/);
  assert.doesNotMatch(routes, /void (?:runJob|processCandidate|recoverInterruptedJobs)\(/);
});

test("rescraping preserves approved staged assets and human visibility metadata", () => {
  const pipeline = fs.readFileSync(
    path.resolve(process.cwd(), "server/photo-pipeline.ts"),
    "utf8",
  );
  assert.match(pipeline, /!isVirtualStagingCandidateFilename\(f\)/);
  assert.doesNotMatch(pipeline, /deletePhotoLabelsByFolder\(folder\)/);
  assert.match(pipeline, /upsertPhotoLabel/);
});

test("folder inventory resolves visibility on the server before client refresh", () => {
  const routes = fs.readFileSync(path.resolve(process.cwd(), "server/routes.ts"), "utf8");
  const builder = fs.readFileSync(path.resolve(process.cwd(), "client/src/pages/builder.tsx"), "utf8");
  assert.match(routes, /hiddenFiles\.has\(f\)/);
  assert.match(routes, /resolveVirtualStagingGalleryFiles/);
  assert.match(builder, /data\.filter\(\(d\) => d\.hidden !== true\)/);
  assert.match(builder, /propertyId=.*unitId=/);
  assert.match(builder, /unitPhotoInventoryKey/);
  assert.match(builder, /photoInventoryReady/);
});

test("confirmation and downstream galleries isolate shared physical folders", () => {
  const stagingRoutes = fs.readFileSync(
    path.resolve(process.cwd(), "server/virtual-staging-routes.ts"),
    "utf8",
  );
  const activationStart = stagingRoutes.indexOf("async function activateCandidates");
  const activationEnd = stagingRoutes.indexOf("type AsyncRoute", activationStart);
  const activation = stagingRoutes.slice(activationStart, activationEnd);
  assert.match(activation, /filenamesToHide = sameOriginal\.map/);
  assert.doesNotMatch(activation, /filenamesToHide = \[candidate\.originalFilename/);

  const repush = fs.readFileSync(path.resolve(process.cwd(), "server/guesty-photo-repush.ts"), "utf8");
  assert.match(repush, /resolveVirtualStagingGalleryFiles/);
  assert.match(repush, /unit\.id/);
});

test("legacy remediation assembles scoped logical galleries before deduplication", () => {
  const routes = fs.readFileSync(path.resolve(process.cwd(), "server/routes.ts"), "utf8");
  const start = routes.indexOf("const assemblePhotosFor = async");
  const end = routes.indexOf("const successes: string[]", start);
  const assembly = routes.slice(start, end);
  assert.match(assembly, /resolveActiveUnitPhotoFolders/);
  assert.match(assembly, /resolveVirtualStagingGalleryFiles/);
  assert.match(assembly, /unit\.id/);
  assert.match(assembly, /assembleGuestyPushPhotos\(galleries\)/);
  assert.doesNotMatch(assembly, /seen\.has\(f\)/);
});

test("folder-only scanners and channel pushes fail closed around scoped staged galleries", () => {
  const gallery = fs.readFileSync(
    path.resolve(process.cwd(), "server/virtual-staging-gallery.ts"),
    "utf8",
  );
  const scanner = fs.readFileSync(
    path.resolve(process.cwd(), "server/photo-listing-scanner.ts"),
    "utf8",
  );
  const selector = fs.readFileSync(
    path.resolve(process.cwd(), "server/photo-clean-selector.ts"),
    "utf8",
  );
  const routes = fs.readFileSync(path.resolve(process.cwd(), "server/routes.ts"), "utf8");
  const replaceStart = routes.indexOf('app.post("/api/listings/:id/replace-channel-photos"');
  const replaceEnd = routes.indexOf('app.post("/api/listings/:id/isolate-replace-disconnect"', replaceStart);
  const replaceRoute = routes.slice(replaceStart, replaceEnd);

  assert.match(gallery, /export async function folderHasActiveVirtualStagingVariants/);
  assert.match(scanner, /folderHasActiveVirtualStagingVariants\(folder\)/);
  assert.match(scanner, /folder-only scan skipped/);
  assert.match(scanner, /persist\(result, priorRow, \{ inconclusive: true \}\)/);
  assert.match(selector, /allowedFilenames\?: readonly string\[\]/);
  assert.match(selector, /allowedFilenames\.has\(l\.filename\)/);
  assert.match(replaceRoute, /propertyId and unitId are required when a folder has active virtual-staging variants/);
  assert.match(replaceRoute, /resolveVirtualStagingUnit\(propertyId, unitId\)/);
  assert.match(replaceRoute, /resolvedUnit\.folder !== folder/);
  assert.match(replaceRoute, /folder does not belong to the supplied propertyId and unitId/);
  assert.match(replaceRoute, /resolveVirtualStagingGalleryFiles/);
  assert.match(replaceRoute, /allowedFilenames,/);
});

test("Photos-tab community checks preserve logical units that share a folder", () => {
  const guestyTypes = fs.readFileSync(
    path.resolve(process.cwd(), "client/src/services/guestyService.ts"),
    "utf8",
  );
  const builder = fs.readFileSync(
    path.resolve(process.cwd(), "client/src/pages/builder.tsx"),
    "utf8",
  );
  const listingBuilder = fs.readFileSync(
    path.resolve(process.cwd(), "client/src/components/GuestyListingBuilder/index.tsx"),
    "utf8",
  );

  assert.match(guestyTypes, /export type GuestyPhoto = \{[\s\S]*?unitId\?: string;/);
  assert.match(builder, /entryFor\(u\.photoFolder, f, source, u\.id\)/);
  assert.match(listingBuilder, /const byGallery = new Map<string, ReqGroup>\(\)/);
  assert.match(listingBuilder, /`unit:\$\{parsed\.folder\}:\$\{unitId \?\? src\}`/);
  assert.match(listingBuilder, /\.\.\.\(unitId \? \{ unitId \} : \{\}\)/);
});

console.log(`virtual-staging tests passed (${passed})`);
