import assert from "node:assert/strict";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import sharp from "sharp";

import {
  VirtualStagingService,
  type VirtualStagingGenerationInput,
  type VirtualStagingGenerationResult,
  type VirtualStagingImageProvider,
} from "../server/virtual-staging-service";
import { trustedReplicateUrl } from "../server/replicate-virtual-staging-provider";

type AsyncTest = { name: string; run: () => void | Promise<void> };
const tests: AsyncTest[] = [];

function test(name: string, run: AsyncTest["run"]): void {
  tests.push({ name, run });
}

class TestProvider implements VirtualStagingImageProvider {
  readonly id = "test";
  readonly model = "test-image-edit";
  active = 0;
  maxActive = 0;

  constructor(
    private readonly handler: (
      input: VirtualStagingGenerationInput,
    ) => Promise<Buffer>,
  ) {}

  isConfigured(): boolean {
    return true;
  }

  async generate(input: VirtualStagingGenerationInput): Promise<VirtualStagingGenerationResult> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      const buffer = await this.handler(input);
      const metadata = await sharp(buffer).metadata();
      return {
        buffer,
        mimeType: "image/jpeg",
        width: metadata.width ?? 0,
        height: metadata.height ?? 0,
        model: this.model,
        provider: this.id,
      };
    } finally {
      this.active -= 1;
    }
  }
}

const square = await sharp({
  create: { width: 24, height: 24, channels: 3, background: "#d1d5db" },
}).jpeg().toBuffer();
const indoorContext = { scene: "living-area", placement: "indoor" } as const;
const outdoorContext = { scene: "private-outdoor", placement: "outdoor" } as const;

test("preview streaming serves image bytes from hidden staging storage", async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL ||= "postgresql://virtual-staging-test:virtual-staging-test@127.0.0.1:1/unused";
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "virtual-staging-preview-"));
  const preview = path.join(directory, ".virtual-staging", "originals", "preview.jpg");
  let server: Server | null = null;
  try {
    await fs.promises.mkdir(path.dirname(preview), { recursive: true });
    await fs.promises.writeFile(preview, square);
    const { sendVirtualStagingPreview } = await import("../server/virtual-staging-routes");
    const app = express();
    app.get("/preview", (_req, res) => {
      sendVirtualStagingPreview(res, preview, "image/jpeg");
    });
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/preview`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    assert.equal(response.headers.get("cache-control"), "private, max-age=3600");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), square);
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve());
      });
    }
    await fs.promises.rm(directory, { recursive: true, force: true });
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});

test("the provider receives the immutable source bytes unchanged", async () => {
  let receivedHash = "";
  const provider = new TestProvider(async (input) => {
    receivedHash = input.source.toString("base64");
    return input.source;
  });
  const service = new VirtualStagingService([provider], 1);
  await service.generate({ source: square, sourceFilename: "room.jpg", context: indoorContext });
  assert.equal(receivedHash, square.toString("base64"));
});

test("provider fallback receives one identical context-aware prompt", async () => {
  const prompts: string[] = [];
  const first = new TestProvider(async (input) => {
    prompts.push(input.prompt);
    throw new Error("provider unavailable");
  });
  const second = new TestProvider(async (input) => {
    prompts.push(input.prompt);
    return input.source;
  });
  const service = new VirtualStagingService([first, second], 1);
  await service.generate({ source: square, sourceFilename: "lanai.jpg", context: outdoorContext });
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0], prompts[1]);
  assert.match(prompts[0], /Hawaiian, tropical, island, coastal/i);
  assert.match(prompts[0], /weather-resistant, outdoor-rated furniture/i);
  assert.match(prompts[0], /Never add an indoor sofa/i);
});

test("global image-edit concurrency is bounded", async () => {
  const provider = new TestProvider(async (input) => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    return input.source;
  });
  const service = new VirtualStagingService([provider], 2);
  await Promise.all(Array.from({ length: 6 }, (_, index) => service.generate({
    source: square,
    sourceFilename: `room-${index}.jpg`,
    context: indoorContext,
  })));
  assert.equal(provider.maxActive, 2);
});

test("one failed photo does not discard another successful photo", async () => {
  const provider = new TestProvider(async (input) => {
    if (input.sourceFilename === "bad.jpg") throw new Error("individual failure");
    return input.source;
  });
  const service = new VirtualStagingService([provider], 2);
  const results = await Promise.allSettled([
    service.generate({ source: square, sourceFilename: "good.jpg", context: indoorContext }),
    service.generate({ source: square, sourceFilename: "bad.jpg", context: indoorContext }),
  ]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected"]);
});

test("a provider result with materially changed crop is rejected", async () => {
  const wide = await sharp({
    create: { width: 48, height: 24, channels: 3, background: "#d1d5db" },
  }).jpeg().toBuffer();
  const service = new VirtualStagingService([new TestProvider(async () => wide)], 1);
  await assert.rejects(
    service.generate({ source: square, sourceFilename: "room.jpg", context: indoorContext }),
    /crop or aspect ratio/,
  );
});

test("Replicate bearer credentials are only sent to provider-owned hosts", () => {
  assert.equal(
    trustedReplicateUrl("https://api.replicate.com/v1/predictions/example", "api.replicate.com"),
    "https://api.replicate.com/v1/predictions/example",
  );
  assert.equal(
    trustedReplicateUrl("https://pbxt.replicate.delivery/output.jpg", "replicate.delivery"),
    "https://pbxt.replicate.delivery/output.jpg",
  );
  assert.equal(
    trustedReplicateUrl("https://replicate.delivery.attacker.example/output.jpg", "replicate.delivery"),
    null,
  );
  assert.equal(
    trustedReplicateUrl("https://attacker.example/output.jpg", "replicate.delivery"),
    null,
  );
});

test("production refuses the development-only mock switch", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousMock = process.env.VIRTUAL_STAGING_MOCK;
  process.env.NODE_ENV = "production";
  process.env.VIRTUAL_STAGING_MOCK = "1";
  try {
    const service = new VirtualStagingService([new TestProvider(async (input) => input.source)], 1);
    assert.throws(() => service.assertConfigured(), /cannot be enabled in production/);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousMock === undefined) delete process.env.VIRTUAL_STAGING_MOCK;
    else process.env.VIRTUAL_STAGING_MOCK = previousMock;
  }
});

test("API validators accept only canonical property, unit, and candidate IDs", async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL ||= "postgresql://virtual-staging-test:virtual-staging-test@127.0.0.1:1/unused";
  try {
    const routes = await import("../server/virtual-staging-routes");
    assert.deepEqual(routes.validateVirtualStagingStartInput({ propertyId: 42, unitId: "unit-a" }), {
      propertyId: 42,
      unitId: "unit-a",
    });
    assert.throws(() => routes.validateVirtualStagingStartInput({ propertyId: 0, unitId: "unit-a" }), /non-zero/);
    const candidateId = "018f5f24-7b3a-7a50-8c82-42f63bc7a2d1";
    assert.deepEqual(routes.validateVirtualStagingCandidateIds({ candidateIds: [candidateId] }), [candidateId]);
    assert.throws(
      () => routes.validateVirtualStagingCandidateIds({ candidateIds: [candidateId, candidateId] }),
      /duplicates/,
    );
  } finally {
    const { dbPool } = await import("../server/db");
    await dbPool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});

test("immutable snapshots are idempotent and never overwrite different bytes", async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL ||= "postgresql://virtual-staging-test:virtual-staging-test@127.0.0.1:1/unused";
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "virtual-staging-original-"));
  const destination = path.join(directory, "original.jpg");
  try {
    const { ensureImmutableSnapshot } = await import("../server/virtual-staging-routes");
    await ensureImmutableSnapshot(destination, square);
    await ensureImmutableSnapshot(destination, square);
    assert.deepEqual(await fs.promises.readFile(destination), square);
    const different = await sharp(square).tint("#ef4444").jpeg().toBuffer();
    await assert.rejects(
      ensureImmutableSnapshot(destination, different),
      /integrity check/,
    );
    assert.deepEqual(await fs.promises.readFile(destination), square);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});

test("concurrent confirmation copies never delete or overwrite the winning file", async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL ||= "postgresql://virtual-staging-test:virtual-staging-test@127.0.0.1:1/unused";
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "virtual-staging-confirm-"));
  const staged = path.join(directory, "staged.jpg");
  const gallery = path.join(directory, "gallery.jpg");
  const different = path.join(directory, "different.jpg");
  try {
    await fs.promises.writeFile(staged, square);
    const routes = await import("../server/virtual-staging-routes");
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      routes.ensureVirtualStagingGalleryFile(staged, gallery),
    ));
    assert.equal(results.filter((result) => result === "created").length, 1);
    assert.equal(results.filter((result) => result === "existing").length, 11);
    assert.deepEqual(await fs.promises.readFile(gallery), square);

    const differentBytes = await sharp(square).tint("#ef4444").jpeg().toBuffer();
    await fs.promises.writeFile(different, differentBytes);
    await assert.rejects(
      routes.ensureVirtualStagingGalleryFile(different, gallery),
      /already contains different data/,
    );
    assert.deepEqual(await fs.promises.readFile(gallery), square);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});

test("background staging tasks observe rejected promises", async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL ||= "postgresql://virtual-staging-test:virtual-staging-test@127.0.0.1:1/unused";
  try {
    const { scheduleVirtualStagingTask } = await import("../server/virtual-staging-routes");
    const messages: string[] = [];
    scheduleVirtualStagingTask("test task", async () => {
      throw new Error("expected rejection");
    }, (message) => messages.push(message));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(messages.length, 1);
    assert.match(messages[0], /test task failed: expected rejection/);
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});

for (const { name, run } of tests) {
  try {
    await run();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

console.log(`virtual-staging service tests passed (${tests.length})`);
