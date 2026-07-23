import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import sharp from "sharp";
import {
  acquirePhotoFolderWriteLock,
  commitPhotoFolderStage,
  preparePhotoFolderStage,
} from "../server/photo-folder-transaction";
import { planPhotoLabelMerge } from "../server/photo-label-merge";
import { fetchRemoteImage } from "../server/remote-image-fetch";
import {
  consumePhotoPersistProof,
  issuePhotoPersistProof,
} from "../server/photo-persist-proof";

// Gallery metadata planning preserves human rows for still-live filenames,
// removes rows for departed scrape photos, and never removes staged variants.
{
  const plan = planPhotoLabelMerge(
    [
      { id: 1, filename: "photo_00.jpg" },
      { id: 2, filename: "photo_01.jpg" },
      { id: 3, filename: "photo_12.jpg" },
      { id: 4, filename: "virtual-staged-00000000-0000-0000-0000-000000000000.jpg" },
    ],
    new Set(["photo_00.jpg"]),
    ["photo_00.jpg", "photo_01.jpg"],
  );
  assert.deepEqual(plan.obsoleteIds, [3]);
  assert.deepEqual(plan.unlabeledLiveIds, [2]);
}

// The persistence downloader must use the same non-crawler fetch posture that
// already succeeds during proof hashing.
{
  const seenAgents: string[] = [];
  const payload = await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 3,
      background: { r: 12, g: 34, b: 56 },
    },
  }).jpeg().toBuffer();
  const server = http.createServer((req, res) => {
    const agent = String(req.headers["user-agent"] ?? "");
    seenAgents.push(agent);
    if (/VacationRentalBot|NexStay/i.test(agent)) {
      res.writeHead(403).end();
      return;
    }
    if (req.url === "/chunked.jpg") {
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      for (let i = 0; i < 10; i++) res.write(payload);
      res.end();
      return;
    }
    if (req.url === "/slow.jpg") {
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      let offset = 0;
      const timer = setInterval(() => {
        if (offset >= payload.length) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(payload.subarray(offset, Math.min(offset + 16, payload.length)));
        offset += 16;
      }, 25);
      res.once("close", () => clearInterval(timer));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": payload.length,
    });
    res.end(payload);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const image = await fetchRemoteImage(`http://127.0.0.1:${address.port}/photo.jpg`, {
      minBytes: 1,
      timeoutMs: 2_000,
      allowPrivateNetworkForTests: true,
    });
    assert.equal(image?.buffer.length, payload.length);
    assert.ok(seenAgents.every((agent) => !/VacationRentalBot|NexStay/i.test(agent)));

    const oversized = await fetchRemoteImage(`http://127.0.0.1:${address.port}/chunked.jpg`, {
      maxBytes: payload.length * 2,
      timeoutMs: 2_000,
      allowPrivateNetworkForTests: true,
    });
    assert.equal(oversized, null, "a chunked response is aborted at the real byte limit");

    const slowStartedAt = Date.now();
    const slow = await fetchRemoteImage(`http://127.0.0.1:${address.port}/slow.jpg`, {
      timeoutMs: 60,
      allowPrivateNetworkForTests: true,
    });
    assert.equal(slow, null);
    assert.ok(
      Date.now() - slowStartedAt < 500,
      "the timeout is a wall-clock budget even while response bytes keep arriving",
    );

    const requestCount = seenAgents.length;
    const privateBlocked = await fetchRemoteImage(`http://127.0.0.1:${address.port}/photo.jpg`);
    assert.equal(privateBlocked, null);
    assert.equal(seenAgents.length, requestCount, "private destinations are rejected before fetch");
  } finally {
    server.close();
    await once(server, "close");
  }
}

// Find-phase URLs cross the loopback boundary only through a short-lived,
// source-bound, one-time server proof.
{
  const source = "https://www.homes.com/property/example-unit-920/";
  const photos = [
    "https://images.example.com/one.jpg",
    "file:///etc/passwd",
    "not-a-url",
  ];
  const mismatched = issuePhotoPersistProof(source, photos, 1_000);
  assert.deepEqual(
    consumePhotoPersistProof(mismatched, "https://www.homes.com/property/example-unit-720/", 1_001),
    [],
  );
  assert.deepEqual(consumePhotoPersistProof(mismatched, source, 1_002), [], "a rejected proof is spent");

  const valid = issuePhotoPersistProof(source, photos, 2_000);
  assert.deepEqual(
    consumePhotoPersistProof(valid, source, 2_001),
    ["https://images.example.com/one.jpg"],
  );
  assert.deepEqual(consumePhotoPersistProof(valid, source, 2_002), [], "proofs are single-use");

  const expired = issuePhotoPersistProof(source, photos, 3_000);
  assert.deepEqual(consumePhotoPersistProof(expired, source, 11 * 60_000), []);
}

// Same-folder writers queue; different folders do not block one another.
{
  const releaseFirst = await acquirePhotoFolderWriteLock("folder-a");
  let secondEntered = false;
  const second = (async () => {
    const releaseSecond = await acquirePhotoFolderWriteLock("folder-a");
    secondEntered = true;
    releaseSecond();
  })();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(secondEntered, false);

  const releaseOther = await acquirePhotoFolderWriteLock("folder-b");
  releaseOther();
  releaseFirst();
  await second;
  assert.equal(secondEntered, true);
}

// A failed metadata promotion must restore the live folder byte-for-byte. A
// successful promotion keeps durable virtual-staging assets while swapping the
// scrape-owned gallery and source document.
{
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "photo-folder-transaction-"));
  const live = path.join(root, "unit-920");
  const stage = path.join(root, ".unit-920.staging");
  const backup = path.join(root, ".unit-920.backup");
  const virtual = "virtual-staged-00000000-0000-0000-0000-000000000000.jpg";
  await fs.promises.mkdir(live, { recursive: true });
  await fs.promises.writeFile(path.join(live, "photo_00.jpg"), "old-photo");
  await fs.promises.writeFile(path.join(live, virtual), "approved-stage");
  await fs.promises.writeFile(path.join(live, "_source.json"), '{"unit":"920","version":"old"}');

  try {
    await preparePhotoFolderStage(live, stage);
    assert.equal(fs.existsSync(path.join(stage, "photo_00.jpg")), false);
    assert.equal(await fs.promises.readFile(path.join(stage, virtual), "utf8"), "approved-stage");
    await fs.promises.writeFile(path.join(stage, "photo_00.jpg"), "new-photo");
    await fs.promises.writeFile(path.join(stage, "_source.json"), '{"unit":"920","version":"new"}');

    await assert.rejects(
      commitPhotoFolderStage(live, stage, backup, async () => {
        throw new Error("metadata merge failed");
      }),
      /metadata merge failed/,
    );
    assert.equal(await fs.promises.readFile(path.join(live, "photo_00.jpg"), "utf8"), "old-photo");
    assert.equal(
      await fs.promises.readFile(path.join(live, "_source.json"), "utf8"),
      '{"unit":"920","version":"old"}',
    );

    await preparePhotoFolderStage(live, stage);
    await fs.promises.writeFile(path.join(stage, "photo_00.jpg"), "new-photo");
    await fs.promises.writeFile(path.join(stage, "_source.json"), '{"unit":"920","version":"new"}');
    await commitPhotoFolderStage(live, stage, backup, async () => {});
    assert.equal(await fs.promises.readFile(path.join(live, "photo_00.jpg"), "utf8"), "new-photo");
    assert.equal(await fs.promises.readFile(path.join(live, virtual), "utf8"), "approved-stage");
    assert.equal(
      await fs.promises.readFile(path.join(live, "_source.json"), "utf8"),
      '{"unit":"920","version":"new"}',
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

// Source locks for the route-level invariants that compose the helpers.
{
  const routes = fs.readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
  const jobs = fs.readFileSync(new URL("../server/preflight-background-jobs.ts", import.meta.url), "utf8");
  const remoteFetch = fs.readFileSync(new URL("../server/remote-image-fetch.ts", import.meta.url), "utf8");
  const storage = fs.readFileSync(new URL("../server/storage.ts", import.meta.url), "utf8");
  const client = fs.readFileSync(new URL("../client/src/components/unit-replacement-flow.tsx", import.meta.url), "utf8");

  const stageIndex = routes.indexOf("preparePhotoFolderStage(folderPath, stagingPath)");
  const pipelineIndex = routes.indexOf("folder: stagingFolder", stageIndex);
  const floorIndex = routes.indexOf("result.kept < requiredSaved", pipelineIndex);
  const sourceIndex = routes.indexOf('path.join(stagingPath, "_source.json")', floorIndex);
  const commitIndex = routes.indexOf("commitPhotoFolderStage(folderPath, stagingPath, backupPath", sourceIndex);
  assert.ok(
    stageIndex >= 0
      && pipelineIndex > stageIndex
      && floorIndex > pipelineIndex
      && sourceIndex > floorIndex
      && commitIndex > sourceIndex,
    "rescrape must stage, prove its saved floor, stamp staged metadata, then promote",
  );
  assert.ok(
    routes.includes("mergeStagedPhotoLabelsIntoFolder(")
      && routes.includes("result.keptFilenames,"),
  );
  assert.ok(
    routes.includes('foundVia: "rescrape"')
      && routes.includes("sourceDoc.unitPhotoResolverProof = {")
      && routes.includes("delete sourceDoc.stagedCommunityAudit"),
    "a promoted gallery must replace stale resolver proof and discard the prior gallery audit",
  );
  const rescrapeProofStart = routes.indexOf('foundVia: "rescrape"');
  const rescrapePromotion = routes.indexOf(
    "commitPhotoFolderStage(folderPath, stagingPath, backupPath",
    rescrapeProofStart,
  );
  const rescrapeRejected = routes.indexOf(
    'persistedProof.status === "rejected"',
    rescrapeProofStart,
  );
  assert.ok(
    rescrapeRejected > rescrapeProofStart && rescrapeRejected < rescrapePromotion,
    "a rejected re-pull proof must abort before promotion",
  );
  assert.ok(routes.includes("keptExisting: true"));
  assert.ok(
    jobs.includes("issuePhotoPersistProof(")
      && jobs.includes("photoProofToken,")
      && routes.includes("consumePhotoPersistProof(rawPhotoProofToken, sourceUrl)"),
    "find-phase fallback URLs must cross the loopback boundary through one-time server-held proof",
  );
  assert.ok(routes.includes("acquirePhotoFolderWriteLock(folderPath)"));
  const hydrateStart = routes.indexOf("const hydrateUnitSwapPhotoFolder");
  const hydrateEnd = routes.indexOf("const manualReplacementFromUrl", hydrateStart);
  const hydrateSource = routes.slice(hydrateStart, hydrateEnd);
  assert.ok(
    hydrateSource.includes("acquirePhotoFolderWriteLock(folderPath)")
      && hydrateSource.includes("commitPhotoFolderStage(folderPath, stagingPath, backupPath"),
    "replacement hydration and re-pull must share the same folder lock and atomic promotion",
  );
  const alertWriteStart = routes.indexOf("// 3. Scrape replacement photos into the unit folder");
  const alertWriteEnd = routes.indexOf("// 4. Assemble photos[]", alertWriteStart);
  const alertWriteSource = routes.slice(alertWriteStart, alertWriteEnd);
  assert.ok(
    alertWriteSource.includes("acquirePhotoFolderWriteLock(folderPath)")
      && alertWriteSource.includes("preparePhotoFolderStage(folderPath, stagingPath)")
      && alertWriteSource.includes('persistedProof.status === "rejected"')
      && alertWriteSource.includes("commitPhotoFolderStage(folderPath, stagingPath, backupPath"),
    "alert remediation must share the unit-folder lock and atomic promotion path",
  );
  const communitySaveStart = routes.indexOf('app.post("/api/community-photos/save"');
  const communitySaveEnd = routes.indexOf("// Rescrape a unit", communitySaveStart);
  const communitySaveSource = routes.slice(communitySaveStart, communitySaveEnd);
  assert.ok(
    communitySaveSource.includes("acquirePhotoFolderWriteLock(folderPath)")
      && communitySaveSource.includes("fetchRemoteImage(url")
      && communitySaveSource.includes("commitPhotoFolderStage(folderPath, stagingPath, backupPath"),
    "community-photo saves must be bounded, serialized, and atomic",
  );
  assert.ok(
    remoteFetch.includes("lookup: (_lookupHostname, _lookupOptions, callback)")
      && remoteFetch.includes("callback(null, target.address, target.family)")
      && !remoteFetch.includes("fetch(current"),
    "the outbound connection must use the already-validated DNS address",
  );
  assert.ok(
    storage.includes("planPhotoLabelMerge(destinationRows, stagedFilenames, liveFilenames)")
      && storage.includes("inArray(photoLabels.id, obsoleteDestinationIds)"),
    "metadata promotion must remove orphan scrape labels while preserving virtual-staging rows",
  );
  assert.ok(
    storage.includes("inArray(photoLabels.id, unlabeledLiveIds)")
      && storage.includes('label: ""'),
    "a no-labeler promotion must preserve human rows for live files but clear stale generated metadata",
  );

  assert.ok(
    client.includes("collectAllOptions: false"),
    "interactive replacement search must return its first verified unit",
  );
  assert.ok(
    /const MAX_VIABLE_UNITS = collectAllOptions[\s\S]*?: 1;/.test(routes),
    "non-exhaustive route mode must stop after one viable unit",
  );
  assert.ok(
    !routes.includes("if (currentDraftId === draft.id) continue")
      && !routes.includes("if (currentPropertyId === builder.propertyId) continue")
      && !routes.includes("currentPropertyId === swap.propertyId && targetUnitId"),
    "the unit being replaced must remain in same-community duplicate exclusions",
  );
  const finalGuard = routes.indexOf("const finalBlockedUnitClaim");
  const foundPush = routes.indexOf("foundUnits.push({", finalGuard);
  assert.ok(finalGuard >= 0 && foundPush > finalGuard);
}

console.log("photo-persistence-safety tests passed");
