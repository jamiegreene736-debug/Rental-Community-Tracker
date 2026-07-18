import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  VIRTUAL_STAGING_PROMPT,
  buildVirtualStagingPrompt,
  resolveStageableVirtualStagingSources,
  resolveVirtualStagingSources,
  reusableVirtualStagingJobId,
  sameVirtualStagingSelection,
  summarizeCandidateStatuses,
  validateVirtualStagingSelection,
  virtualStagingContextForSource,
  virtualStagingRecipeSignature,
  virtualStagingSessionAction,
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

test("the staging recipe signature invalidates previews from older prompts", () => {
  assert.equal(
    virtualStagingRecipeSignature(),
    "virtual-staging-recipe::context-aware-furnishings-v2",
  );
});

test("unconfirmed terminal jobs remain resumable after the Photos tab remounts", () => {
  assert.equal(reusableVirtualStagingJobId([
    { id: "review", propertyId: 42, unitId: "unit-a", status: "ready" },
  ], 42, "unit-a"), "review");
  assert.equal(reusableVirtualStagingJobId([
    { id: "failed", propertyId: 42, unitId: "unit-a", status: "failed" },
  ], 42, "unit-a"), "failed");
});

test("completed jobs are not reused as duplicate submissions", () => {
  assert.equal(reusableVirtualStagingJobId([
    { id: "done", propertyId: 42, unitId: "unit-a", status: "confirmed" },
  ], 42, "unit-a"), null);
});

test("a newer confirmed job supersedes an older unconfirmed review", () => {
  assert.equal(reusableVirtualStagingJobId([
    { id: "newer", propertyId: 42, unitId: "unit-a", status: "confirmed" },
    { id: "older", propertyId: 42, unitId: "unit-a", status: "ready" },
  ], 42, "unit-a"), null);
});

test("an unconfirmed staging session resumes only for its own unit", () => {
  assert.equal(virtualStagingSessionAction({
    requestedUnitId: "unit-a",
    sessionUnitId: null,
    hasResumableSession: false,
  }), "start");
  assert.equal(virtualStagingSessionAction({
    requestedUnitId: "unit-a",
    sessionUnitId: "unit-a",
    hasResumableSession: true,
  }), "resume");
  assert.equal(virtualStagingSessionAction({
    requestedUnitId: "unit-b",
    sessionUnitId: "unit-a",
    hasResumableSession: true,
  }), "blocked");
});

test("an empty unit produces no stageable photos", () => {
  assert.deepEqual(resolveStageableVirtualStagingSources({ diskFilenames: [], labels: [], variants: [] }), []);
});

test("only private rooms and private outdoor spaces are eligible for paid staging", () => {
  const cases = [
    ["Living Areas", "living-area"],
    ["Bedrooms", "bedroom"],
    ["Kitchen", "kitchen"],
    ["Bathrooms", "bathroom"],
    ["Dining", "dining"],
    ["Outdoor & Lanai", "private-outdoor"],
  ] as const;
  for (const [category, scene] of cases) {
    const context = virtualStagingContextForSource({
      originalFilename: `${scene}.jpg`,
      roomLabel: category,
      metadata: label(`${scene}.jpg`, { label: category, category }),
    });
    assert.equal(context?.scene, scene, category);
    assert.equal(context?.placement, scene === "private-outdoor" ? "outdoor" : "indoor", category);
  }

  for (const category of [
    "Views",
    "Building Exterior",
    "Reject",
    "Other",
    "Pool & Spa",
    "Beach Access",
    "Grounds & Landscaping",
    "Common Areas",
    "Activities",
    "Amenities",
  ]) {
    assert.equal(virtualStagingContextForSource({
      originalFilename: "scenic.jpg",
      roomLabel: "Scenic Photo",
      metadata: label("scenic.jpg", { label: "Scenic Photo", category }),
    }), null, category);
  }
});

test("room categories win over incidental view words", () => {
  assert.deepEqual(virtualStagingContextForSource({
    originalFilename: "living.jpg",
    roomLabel: "Living Room With Ocean View",
    metadata: label("living.jpg", { label: "Living Room With Ocean View", category: "Living Areas" }),
  }), { scene: "living-area", placement: "indoor" });
  assert.deepEqual(virtualStagingContextForSource({
    originalFilename: "lanai.jpg",
    roomLabel: "Lanai With Ocean View",
    metadata: label("lanai.jpg", { label: "Lanai With Ocean View", category: "Outdoor & Lanai" }),
  }), { scene: "private-outdoor", placement: "outdoor" });
  assert.equal(virtualStagingContextForSource({
    originalFilename: "sunset.jpg",
    roomLabel: "Sunset From Lanai",
    metadata: label("sunset.jpg", { label: "Sunset From Lanai", category: "Outdoor & Lanai" }),
  }), null);
});

test("a clearly furnished lanai corrects a legacy indoor category", () => {
  for (const [roomLabel, category] of [
    ["Covered Dining Lanai", "Living Areas"],
    ["Living Room Seating And Lanai", "Living Areas"],
    ["Primary Bedroom Lanai", "Bedrooms"],
    ["Master Bedroom Suite Lanai", "Bedrooms"],
  ]) {
    assert.deepEqual(virtualStagingContextForSource({
      originalFilename: `${roomLabel}.jpg`,
      roomLabel,
      metadata: label(`${roomLabel}.jpg`, { label: roomLabel, category }),
    }), { scene: "private-outdoor", placement: "outdoor" }, roomLabel);
  }
  for (const [roomLabel, category, scene] of [
    ["Living Room And Lanai", "Living Areas", "living-area"],
    ["Primary Bedroom Suite And Lanai", "Bedrooms", "bedroom"],
    ["Master Bedroom With Lanai Access", "Bedrooms", "bedroom"],
  ] as const) {
    assert.deepEqual(virtualStagingContextForSource({
      originalFilename: `${roomLabel}.jpg`,
      roomLabel,
      metadata: label(`${roomLabel}.jpg`, { label: roomLabel, category }),
    }), { scene, placement: "indoor" }, roomLabel);
  }
});

test("obvious beach and shared-amenity labels backstop a bad generated category", () => {
  assert.equal(virtualStagingContextForSource({
    originalFilename: "beach.jpg",
    roomLabel: "Private Beach Cove",
    metadata: label("beach.jpg", { label: "Private Beach Cove", category: "Living Areas" }),
  }), null);
  assert.equal(virtualStagingContextForSource({
    originalFilename: "restaurant.jpg",
    roomLabel: "Resort Restaurant",
    metadata: label("restaurant.jpg", { label: "Resort Restaurant", category: "Dining" }),
  }), null);
  for (const roomLabel of [
    "Ocean View",
    "Oceanfront Sunset",
    "Coastline",
    "Mountain Vista",
    "Pool With Ocean Backdrop",
  ]) {
    assert.equal(virtualStagingContextForSource({
      originalFilename: `${roomLabel}.jpg`,
      roomLabel,
      metadata: label(`${roomLabel}.jpg`, { label: roomLabel, category: "Living Areas" }),
    }), null, roomLabel);
  }
  assert.deepEqual(virtualStagingContextForSource({
    originalFilename: "pool-view.jpg",
    roomLabel: "Living Room With Pool View",
    metadata: label("pool-view.jpg", { label: "Living Room With Pool View", category: "Living Areas" }),
  }), { scene: "living-area", placement: "indoor" });
  assert.deepEqual(virtualStagingContextForSource({
    originalFilename: "open-floor-plan.jpg",
    roomLabel: "Open Floor Plan",
    metadata: label("open-floor-plan.jpg", { label: "Open Floor Plan", category: "Living Areas" }),
  }), { scene: "living-area", placement: "indoor" });
  assert.equal(virtualStagingContextForSource({
    originalFilename: "floor-plan.jpg",
    roomLabel: "Floor Plan",
    metadata: label("floor-plan.jpg", { label: "Floor Plan", category: "Living Areas" }),
  }), null);
});

test("human category overrides control staging eligibility", () => {
  assert.deepEqual(virtualStagingContextForSource({
    originalFilename: "patio.jpg",
    roomLabel: "Private Patio",
    metadata: label("patio.jpg", { category: "Views", userCategory: " Patio " }),
  }), { scene: "private-outdoor", placement: "outdoor" });
  assert.equal(virtualStagingContextForSource({
    originalFilename: "view.jpg",
    roomLabel: "Ocean View",
    metadata: label("view.jpg", { category: "Living Areas", userCategory: "Views" }),
  }), null);
});

test("legacy Exterior only admits a usable private outdoor space", () => {
  for (const roomLabel of ["Covered Lanai", "Lanai Seating", "Oceanfront Patio", "Outdoor Dining"]) {
    assert.equal(virtualStagingContextForSource({
      originalFilename: `${roomLabel}.jpg`,
      roomLabel,
      metadata: label(`${roomLabel}.jpg`, { label: roomLabel, category: "Exterior" }),
    })?.scene, "private-outdoor", roomLabel);
  }
  for (const roomLabel of [
    "Balcony View",
    "Sunset From Lanai",
    "Garden View From Lanai",
    "Beach Access",
    "Building Exterior",
  ]) {
    assert.equal(virtualStagingContextForSource({
      originalFilename: `${roomLabel}.jpg`,
      roomLabel,
      metadata: label(`${roomLabel}.jpg`, { label: roomLabel, category: "Exterior" }),
    }), null, roomLabel);
  }
});

test("generic legacy metadata requires an explicit furnished-space signal", () => {
  assert.deepEqual(virtualStagingContextForSource({
    originalFilename: "patio-sofa.jpg",
    roomLabel: "Patio Sofa",
    metadata: label("patio-sofa.jpg", { label: "Patio Sofa", category: null }),
  }), { scene: "private-outdoor", placement: "outdoor" });
  assert.deepEqual(virtualStagingContextForSource({
    originalFilename: "living-room.jpg",
    roomLabel: "Living Room",
    metadata: null,
  }), { scene: "living-area", placement: "indoor" });
  assert.deepEqual(virtualStagingContextForSource({
    originalFilename: "primary-bedroom-lanai.jpg",
    roomLabel: "Primary Bedroom Lanai",
    metadata: null,
  }), { scene: "private-outdoor", placement: "outdoor" });
  assert.equal(virtualStagingContextForSource({
    originalFilename: "photo-10.jpg",
    roomLabel: "Photo 10",
    metadata: null,
  }), null);
});

test("candidate planning ignores scenic and shared photos without reordering rooms", () => {
  const sources = resolveStageableVirtualStagingSources({
    diskFilenames: ["01-living.jpg", "02-beach.jpg", "03-lanai.jpg", "04-pool.jpg"],
    labels: [
      label("01-living.jpg", { label: "Living Room With Ocean View", category: "Living Areas" }),
      label("02-beach.jpg", { label: "Private Beach Cove", category: "Views" }),
      label("03-lanai.jpg", { label: "Lanai Dining With Ocean View", category: "Outdoor & Lanai" }),
      label("04-pool.jpg", { label: "Community Pool", category: "Pool & Spa" }),
    ],
    variants: [],
  });
  assert.deepEqual(sources.map((source) => source.originalFilename), ["01-living.jpg", "03-lanai.jpg"]);
  assert.deepEqual(sources.map((source) => source.stagingContext.placement), ["indoor", "outdoor"]);
});

test("active staged metadata determines whether an immutable original is restaged", () => {
  const sources = resolveStageableVirtualStagingSources({
    diskFilenames: ["room.jpg", "virtual-staged-active.jpg"],
    labels: [
      label("room.jpg", { category: "Living Areas", hidden: true }),
      label("virtual-staged-active.jpg", { label: "Ocean Sunset", category: "Views" }),
    ],
    variants: [{
      originalFilename: "room.jpg",
      candidateFilename: "virtual-staged-active.jpg",
      active: true,
    }],
  });
  assert.deepEqual(sources, []);
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
  assert.match(VIRTUAL_STAGING_PROMPT, /Hawaiian, tropical, island, coastal/i);
  assert.match(VIRTUAL_STAGING_PROMPT, /sofa with sofa/i);
  assert.match(VIRTUAL_STAGING_PROMPT, /visible photograph is authoritative/i);
  assert.match(VIRTUAL_STAGING_PROMPT, /Hawaiian-style sofa only with another tasteful Hawaiian-style sofa/i);
  assert.match(VIRTUAL_STAGING_PROMPT, /If no suitable movable furnishing is visible, make no changes/i);
  assert.doesNotMatch(VIRTUAL_STAGING_PROMPT, /Add .*neutral contemporary luxury/i);

  const outdoorPrompt = buildVirtualStagingPrompt({ scene: "private-outdoor", placement: "outdoor" });
  assert.match(outdoorPrompt, /weather-resistant, outdoor-rated furniture/i);
  assert.match(outdoorPrompt, /Never add an indoor sofa/i);
  const indoorPrompt = buildVirtualStagingPrompt({ scene: "living-area", placement: "indoor" });
  assert.match(indoorPrompt, /metadata indicates an indoor living area/i);
  assert.match(indoorPrompt, /never introduce patio, deck, or pool furniture/i);
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
  const startLifecycle = source.slice(
    source.indexOf("A keyed staging session"),
    source.indexOf("// Poll in the background"),
  );
  assert.doesNotMatch(startLifecycle, /if \(!open/);
  assert.doesNotMatch(startLifecycle, /\[open,/);

  const builderSource = fs.readFileSync(
    path.resolve(process.cwd(), "client/src/components/GuestyListingBuilder/index.tsx"),
    "utf8",
  );
  assert.match(builderSource, /virtualStagingUnits\?\.length/);

  const curatorSource = fs.readFileSync(
    path.resolve(process.cwd(), "client/src/components/GuestyListingBuilder/PhotoCurator.tsx"),
    "utf8",
  );
  assert.match(curatorSource, /virtualStagingSessionResumable/);
  assert.match(curatorSource, /action === "resume"[\s\S]*setVirtualStagingOpen\(true\)/);
  assert.match(curatorSource, /Review \$\{unit\.label\} staging/);
  assert.match(curatorSource, /onFinished=\{handleVirtualStagingFinished\}/);
  assert.match(curatorSource, /onResolvedExternally=\{handleVirtualStagingResolvedExternally\}/);
  assert.match(curatorSource, /virtualStagingPropertyId === propertyId/);
  assert.match(source, /button-finish-virtual-staging-without-swaps/);
  assert.match(source, /job\?\.status !== "confirmed"/);
});

test("backend keeps credentials server-side and edits immutable image input", () => {
  const service = fs.readFileSync(
    path.resolve(process.cwd(), "server/virtual-staging-service.ts"),
    "utf8",
  );
  assert.match(service, /process\.env\.OPENAI_API_KEY/);
  assert.match(service, /process\.env\.OPENAI_IMAGE_MODEL/);
  assert.match(service, /images\.edit/);
  assert.match(service, /buildVirtualStagingPrompt/);
  assert.match(service, /prompt: input\.prompt/);
  assert.match(service, /get recipeSignature/);
  assert.doesNotMatch(service, /VITE_OPENAI|NEXT_PUBLIC_OPENAI|REACT_APP_OPENAI/);

  const replicate = fs.readFileSync(
    path.resolve(process.cwd(), "server/replicate-virtual-staging-provider.ts"),
    "utf8",
  );
  assert.match(replicate, /input_image: file\.urls\.get/);
  assert.match(replicate, /prompt: input\.prompt/);
  assert.match(replicate, /aspect_ratio: "match_input_image"/);
  assert.match(replicate, /generatedUrl[\s\S]*Authorization: `Bearer \$\{this\.apiToken\}`/);
  assert.match(replicate, /fetchWithTransientRetry/);

  const routes = fs.readFileSync(
    path.resolve(process.cwd(), "server/virtual-staging-routes.ts"),
    "utf8",
  );
  assert.match(routes, /sendFile\(file, \{ dotfiles: "allow" \}\)/);
  assert.match(routes, /sendVirtualStagingPreview\(res, file, asset\.mimeType\)/);
  assert.match(routes, /sendVirtualStagingPreview\(res, file, "image\/jpeg"\)/);
  assert.match(routes, /original\?v=\$\{previewVersion\}/);
  assert.match(routes, /staged\?v=\$\{previewVersion\}/);
  assert.match(routes, /RESUMABLE_JOB_STATUSES = \["queued", "running", "ready", "failed"\]/);
  assert.match(routes, /\/api\/virtual-staging\/jobs\/:jobId\/finish/);
  assert.match(routes, /selectedCandidateIds: \[\]/);
  assert.match(routes, /resolveStageableVirtualStagingSources/);
  assert.match(routes, /virtualStagingContextForSource/);
  assert.match(routes, /job\.model !== (?:service\.)?recipeSignature/);
  assert.match(routes, /Superseded by an updated virtual-staging recipe/);
  assert.match(routes, /NOT LIKE \$\{`\$\{VIRTUAL_STAGING_RECIPE_SIGNATURE_PREFIX\}%`\}/);
  assert.match(routes, /jobIsResumableForUnit\(latest, unit\)[\s\S]*latest\.model === recipeSignature/);
  assert.match(routes, /latest\.model\?\.startsWith\(VIRTUAL_STAGING_RECIPE_SIGNATURE_PREFIX\)/);
  assert.match(routes, /tx\.update\(virtualStagingJobs\)[\s\S]*tx\.insert\(virtualStagingJobs\)/);
});

test("confirmation rejects obsolete staging recipes before preparing files", () => {
  const routes = fs.readFileSync(
    path.resolve(process.cwd(), "server/virtual-staging-routes.ts"),
    "utf8",
  );
  const confirmStart = routes.indexOf('app.post("/api/virtual-staging/jobs/:jobId/confirm"');
  const finishStart = routes.indexOf('app.post("/api/virtual-staging/jobs/:jobId/finish"', confirmStart);
  const confirmRoute = routes.slice(confirmStart, finishStart);
  assert.match(confirmRoute, /job\.model !== getVirtualStagingService\(\)\.recipeSignature/);
  assert.ok(
    confirmRoute.indexOf("job.model !== getVirtualStagingService().recipeSignature")
      < confirmRoute.indexOf("prepareConfirmationFiles(selected)"),
  );
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

test("runtime virtual-staging tables stay outside Railway's db:push schema", () => {
  const sharedSchema = fs.readFileSync(
    path.resolve(process.cwd(), "shared/schema.ts"),
    "utf8",
  );
  const runtimeSchema = fs.readFileSync(
    path.resolve(process.cwd(), "server/virtual-staging-schema.ts"),
    "utf8",
  );
  const drizzleConfig = fs.readFileSync(
    path.resolve(process.cwd(), "drizzle.config.ts"),
    "utf8",
  );

  for (const table of [
    "photo_original_assets",
    "virtual_staging_jobs",
    "virtual_staging_candidates",
  ]) {
    assert.doesNotMatch(sharedSchema, new RegExp(table));
    assert.match(runtimeSchema, new RegExp(table));
    assert.match(drizzleConfig, new RegExp(`!${table}`));
  }
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
