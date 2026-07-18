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
import {
  AnthropicVirtualStagingViewpointVerifier,
  VirtualStagingViewpointRejectedError,
  VirtualStagingViewpointVerificationUnavailableError,
  type VirtualStagingViewpointVerificationInput,
  type VirtualStagingViewpointVerifier,
} from "../server/virtual-staging-viewpoint-verifier";

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

class TestViewpointVerifier implements VirtualStagingViewpointVerifier {
  readonly id = "test-viewpoint-verifier";
  readonly model = "test-vision";

  constructor(
    private readonly handler: (
      input: VirtualStagingViewpointVerificationInput,
    ) => void | Promise<void> = () => undefined,
  ) {}

  isConfigured(): boolean {
    return true;
  }

  async verify(input: VirtualStagingViewpointVerificationInput): Promise<void> {
    await this.handler(input);
  }
}

function acceptingViewpointVerifier(): TestViewpointVerifier {
  return new TestViewpointVerifier();
}

const square = await sharp({
  create: { width: 24, height: 24, channels: 3, background: "#d1d5db" },
}).jpeg().toBuffer();
const editedPixels = Buffer.alloc(24 * 24 * 3);
for (let y = 0; y < 24; y += 1) {
  for (let x = 0; x < 24; x += 1) {
    const value = Math.max(0, 255 - x * 10);
    const offset = (y * 24 + x) * 3;
    editedPixels[offset] = value;
    editedPixels[offset + 1] = value;
    editedPixels[offset + 2] = value;
  }
}
const editedSquare = await sharp(editedPixels, {
  raw: { width: 24, height: 24, channels: 3 },
}).jpeg().toBuffer();
const alternateEditedPixels = Buffer.alloc(24 * 24 * 3);
for (let y = 0; y < 24; y += 1) {
  for (let x = 0; x < 24; x += 1) {
    const value = x % 2 === 0 ? 240 : 15;
    const offset = (y * 24 + x) * 3;
    alternateEditedPixels[offset] = value;
    alternateEditedPixels[offset + 1] = value;
    alternateEditedPixels[offset + 2] = value;
  }
}
const alternateEditedSquare = await sharp(alternateEditedPixels, {
  raw: { width: 24, height: 24, channels: 3 },
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
    return editedSquare;
  });
  const service = new VirtualStagingService([provider], 1, acceptingViewpointVerifier());
  await service.generate({ source: square, sourceFilename: "room.jpg", generationAttempt: 1, context: indoorContext });
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
    return editedSquare;
  });
  const service = new VirtualStagingService([first, second], 1, acceptingViewpointVerifier());
  await service.generate({ source: square, sourceFilename: "lanai.jpg", generationAttempt: 1, context: outdoorContext });
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0], prompts[1]);
  assert.match(prompts[0], /Hawaiian, tropical, island, coastal/i);
  assert.match(prompts[0], /weather-resistant, outdoor-rated furniture/i);
  assert.match(prompts[0], /Never add an indoor sofa/i);
  assert.match(prompts[0], /one to two feet to the (?:left|right)/i);
  assert.match(prompts[0], /5 to 10 degrees/i);
  assert.match(prompts[0], /mild natural parallax/i);
});

test("a geometry-rejected image falls through to the next configured provider", async () => {
  let firstCalls = 0;
  let secondCalls = 0;
  let verificationCalls = 0;
  const first = new TestProvider(async () => {
    firstCalls += 1;
    return editedSquare;
  });
  const second = new TestProvider(async () => {
    secondCalls += 1;
    return alternateEditedSquare;
  });
  const verifier = new TestViewpointVerifier(() => {
    verificationCalls += 1;
    if (verificationCalls === 1) {
      throw new VirtualStagingViewpointRejectedError("same camera position");
    }
  });
  await new VirtualStagingService([first, second], 1, verifier).generate({
    source: square,
    sourceFilename: "room.jpg",
    generationAttempt: 1,
    context: indoorContext,
  });
  assert.deepEqual({ firstCalls, secondCalls, verificationCalls }, {
    firstCalls: 1,
    secondCalls: 1,
    verificationCalls: 2,
  });
});

test("a viewpoint-verifier outage stops before spending on another image provider", async () => {
  let secondCalls = 0;
  const verifier = new TestViewpointVerifier(() => {
    throw new VirtualStagingViewpointVerificationUnavailableError("vision unavailable");
  });
  const service = new VirtualStagingService([
    new TestProvider(async () => editedSquare),
    new TestProvider(async () => {
      secondCalls += 1;
      return alternateEditedSquare;
    }),
  ], 1, verifier);
  await assert.rejects(
    service.generate({
      source: square,
      sourceFilename: "room.jpg",
      generationAttempt: 1,
      context: indoorContext,
    }),
    /vision unavailable/,
  );
  assert.equal(secondCalls, 0);
});

test("regenerating a preview requests the opposite nearby camera direction", async () => {
  const prompts: string[] = [];
  let generation = 0;
  const provider = new TestProvider(async (input) => {
    prompts.push(input.prompt);
    generation += 1;
    return generation === 1 ? editedSquare : alternateEditedSquare;
  });
  const service = new VirtualStagingService([provider], 1, acceptingViewpointVerifier());
  await service.generate({
    source: square,
    sourceFilename: "living-room.jpg",
    generationAttempt: 1,
    context: indoorContext,
  });
  await service.generate({
    source: square,
    sourceFilename: "living-room.jpg",
    generationAttempt: 2,
    previousPreview: editedSquare,
    context: indoorContext,
  });
  assert.equal(prompts.length, 2);
  assert.notEqual(
    /one to two feet to the left/i.test(prompts[0]),
    /one to two feet to the left/i.test(prompts[1]),
  );
});

test("global image-edit concurrency is bounded", async () => {
  const provider = new TestProvider(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    return editedSquare;
  });
  const service = new VirtualStagingService([provider], 2, acceptingViewpointVerifier());
  await Promise.all(Array.from({ length: 6 }, (_, index) => service.generate({
    source: square,
    sourceFilename: `room-${index}.jpg`,
    generationAttempt: 1,
    context: indoorContext,
  })));
  assert.equal(provider.maxActive, 2);
});

test("one failed photo does not discard another successful photo", async () => {
  const provider = new TestProvider(async (input) => {
    if (input.sourceFilename === "bad.jpg") throw new Error("individual failure");
    return editedSquare;
  });
  const service = new VirtualStagingService([provider], 2, acceptingViewpointVerifier());
  const results = await Promise.allSettled([
    service.generate({ source: square, sourceFilename: "good.jpg", generationAttempt: 1, context: indoorContext }),
    service.generate({ source: square, sourceFilename: "bad.jpg", generationAttempt: 1, context: indoorContext }),
  ]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected"]);
});

test("a no-op provider result is rejected as too similar", async () => {
  const service = new VirtualStagingService(
    [new TestProvider(async (input) => input.source)],
    1,
    acceptingViewpointVerifier(),
  );
  await assert.rejects(
    service.generate({
      source: square,
      sourceFilename: "room.jpg",
      generationAttempt: 1,
      context: indoorContext,
    }),
    /too visually similar/,
  );
});

test("a reroll matching the previous staged preview is rejected", async () => {
  const service = new VirtualStagingService(
    [new TestProvider(async () => editedSquare)],
    1,
    acceptingViewpointVerifier(),
  );
  await assert.rejects(
    service.generate({
      source: square,
      sourceFilename: "room.jpg",
      generationAttempt: 2,
      previousPreview: editedSquare,
      context: indoorContext,
    }),
    /previous staged angle/,
  );
});

test("every real provider result must pass geometry-aware viewpoint verification", async () => {
  let verifiedDirection = "";
  const verifier = new TestViewpointVerifier((input) => {
    verifiedDirection = input.requestedDirection;
    assert.deepEqual(input.source, square);
    assert.deepEqual(input.generated, editedSquare);
  });
  const service = new VirtualStagingService(
    [new TestProvider(async () => editedSquare)],
    1,
    verifier,
  );
  await service.generate({
    source: square,
    sourceFilename: "room.jpg",
    generationAttempt: 1,
    context: indoorContext,
  });
  assert.ok(verifiedDirection === "left" || verifiedDirection === "right");
});

test("the Anthropic verifier compares a reroll with both source and prior staged viewpoints", async () => {
  let requestBody: Record<string, unknown> | null = null;
  const verifier = new AnthropicVirtualStagingViewpointVerifier(
    "test-key",
    "claude-test",
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        content: [{
          type: "text",
          text: JSON.stringify({
            samePhysicalSpace: true,
            viewpointChange: "nearby-natural",
            naturalParallax: true,
            fakeTransformDetected: false,
            architecturePreserved: true,
            distinctFromPreviousViewpoint: false,
            reason: "The new candidate repeats the prior staged camera perspective.",
          }),
        }],
        stop_reason: "end_turn",
        usage: { input_tokens: 120, output_tokens: 30 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  );
  await assert.rejects(
    verifier.verify({
      source: square,
      generated: alternateEditedSquare,
      previousGenerated: editedSquare,
      requestedDirection: "left",
      imageProvider: "test-provider",
      generationAttempt: 2,
    }),
    /failed alternate-angle verification/i,
  );
  assert.equal(requestBody?.model, "claude-test");
  assert.deepEqual(
    (requestBody?.output_config as { format?: { type?: string } })?.format?.type,
    "json_schema",
  );
  const schema = (requestBody?.output_config as {
    format?: { schema?: { properties?: { viewpointChange?: { enum?: string[] } } } };
  })?.format?.schema;
  assert.deepEqual(
    schema?.properties?.viewpointChange?.enum,
    ["none", "nearby-natural", "large-or-invented", "uncertain"],
  );
  const messages = requestBody?.messages as Array<{ content?: Array<{ type?: string }> }>;
  assert.equal(messages[0]?.content?.filter((block) => block.type === "image").length, 3);
});

test("the Anthropic verifier rejects large angles and malformed structured output", async () => {
  const input: VirtualStagingViewpointVerificationInput = {
    source: square,
    generated: editedSquare,
    requestedDirection: "right",
    imageProvider: "test-provider",
    generationAttempt: 1,
  };
  const largeAngleVerifier = new AnthropicVirtualStagingViewpointVerifier(
    "test-key",
    "claude-test",
    async () => new Response(JSON.stringify({
      content: [{
        type: "text",
        text: JSON.stringify({
          samePhysicalSpace: true,
          viewpointChange: "large-or-invented",
          naturalParallax: true,
          fakeTransformDetected: false,
          architecturePreserved: true,
          reason: "The candidate exposes a large unseen reverse angle.",
        }),
      }],
      stop_reason: "end_turn",
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
  await assert.rejects(
    largeAngleVerifier.verify(input),
    /failed alternate-angle verification/i,
  );

  const malformedVerifier = new AnthropicVirtualStagingViewpointVerifier(
    "test-key",
    "claude-test",
    async () => new Response(JSON.stringify({
      content: [{ type: "text", text: "{}" }],
      stop_reason: "end_turn",
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
  await assert.rejects(
    malformedVerifier.verify(input),
    /invalid structured response/i,
  );
});

test("a provider result with a materially changed aspect ratio is rejected", async () => {
  const wide = await sharp({
    create: { width: 48, height: 24, channels: 3, background: "#d1d5db" },
  }).jpeg().toBuffer();
  const service = new VirtualStagingService(
    [new TestProvider(async () => wide)],
    1,
    acceptingViewpointVerifier(),
  );
  await assert.rejects(
    service.generate({ source: square, sourceFilename: "room.jpg", generationAttempt: 1, context: indoorContext }),
    /aspect ratio/,
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
    const service = new VirtualStagingService(
      [new TestProvider(async (input) => input.source)],
      1,
      acceptingViewpointVerifier(),
    );
    assert.throws(() => service.assertConfigured(), /cannot be enabled in production/);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousMock === undefined) delete process.env.VIRTUAL_STAGING_MOCK;
    else process.env.VIRTUAL_STAGING_MOCK = previousMock;
  }
});

test("real staging refuses to run without the fail-closed viewpoint verifier", () => {
  const service = new VirtualStagingService(
    [new TestProvider(async () => editedSquare)],
    1,
    new AnthropicVirtualStagingViewpointVerifier("", "claude-test"),
  );
  assert.throws(
    () => service.assertConfigured(),
    /ANTHROPIC_API_KEY is required to verify alternate virtual-staging viewpoints/,
  );
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
    assert.deepEqual(
      routes.validateVirtualStagingCandidateSelections({
        candidateSelections: [{ id: candidateId, attempt: 2 }],
      }),
      [{ id: candidateId, attempt: 2 }],
    );
    assert.throws(
      () => routes.validateVirtualStagingCandidateSelections({
        candidateSelections: [
          { id: candidateId, attempt: 1 },
          { id: candidateId, attempt: 2 },
        ],
      }),
      /duplicate IDs/,
    );
    assert.throws(
      () => routes.validateVirtualStagingCandidateSelections({
        candidateSelections: [{ id: candidateId, attempt: 0 }],
      }),
      /generation attempt/,
    );
    assert.doesNotThrow(() => routes.assertSelectedGenerationAttempts(
      [{ id: candidateId, attempt: 2 }],
      [{ id: candidateId, attempt: 2 }],
    ));
    assert.throws(
      () => routes.assertSelectedGenerationAttempts(
        [{ id: candidateId, attempt: 3 }],
        [{ id: candidateId, attempt: 2 }],
      ),
      /selected staged preview changed/i,
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
