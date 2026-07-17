import assert from "node:assert/strict";

import { resolveScopedVirtualStagingGallery } from "../shared/virtual-staging";

const stagedA = "virtual-staged-00000000-0000-4000-8000-000000000001.jpg";
const stagedB = "virtual-staged-00000000-0000-4000-8000-000000000002.jpg";
const oldA = "virtual-staged-00000000-0000-4000-8000-000000000003.jpg";
const diskFilenames = ["01-living.jpg", "02-bedroom.jpg", stagedA, stagedB, oldA];
const variants = [
  {
    propertyId: 14,
    unitId: "unit-a",
    folder: "shared-gallery",
    originalFilename: "01-living.jpg",
    candidateFilename: stagedA,
    active: true,
  },
  {
    propertyId: 14,
    unitId: "unit-b",
    folder: "shared-gallery",
    originalFilename: "01-living.jpg",
    candidateFilename: stagedB,
    active: true,
  },
  {
    propertyId: 14,
    unitId: "unit-a",
    folder: "shared-gallery",
    originalFilename: "02-bedroom.jpg",
    candidateFilename: oldA,
    active: false,
  },
];

console.log("virtual staging scoped gallery");

{
  const files = resolveScopedVirtualStagingGallery({
    diskFilenames,
    variants,
    propertyId: 14,
    unitId: "unit-a",
    folder: "shared-gallery",
  });
  assert.deepEqual(files, [stagedA, "02-bedroom.jpg"]);
  assert.ok(!files.includes(stagedB));
  console.log("  ✓ Unit A sees only its active variant in the original slot");
}

{
  const files = resolveScopedVirtualStagingGallery({
    diskFilenames,
    variants,
    propertyId: 14,
    unitId: "unit-b",
    folder: "shared-gallery",
  });
  assert.deepEqual(files, [stagedB, "02-bedroom.jpg"]);
  assert.ok(!files.includes(stagedA));
  console.log("  ✓ Unit B sharing the folder is not changed by Unit A");
}

{
  const files = resolveScopedVirtualStagingGallery({
    diskFilenames,
    variants,
    propertyId: 26,
    unitId: "unit-a",
    folder: "shared-gallery",
  });
  assert.deepEqual(files, ["01-living.jpg", "02-bedroom.jpg"]);
  console.log("  ✓ another property sharing the folder remains on originals");
}

{
  const files = resolveScopedVirtualStagingGallery({
    diskFilenames: ["01-living.jpg", "02-bedroom.jpg", oldA],
    variants: [{ ...variants[0], candidateFilename: stagedA }],
    propertyId: 14,
    unitId: "unit-a",
    folder: "shared-gallery",
  });
  assert.deepEqual(files, ["01-living.jpg", "02-bedroom.jpg"]);
  console.log("  ✓ a missing active candidate falls back to its original");
}

console.log("virtual staging scoped gallery tests passed (4)");
