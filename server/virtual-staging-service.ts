import OpenAI, { toFile } from "openai";
import sharp from "sharp";

import {
  buildVirtualStagingPrompt,
  virtualStagingRecipeSignature,
  type VirtualStagingContext,
} from "@shared/virtual-staging";
import { ReplicateVirtualStagingProvider } from "./replicate-virtual-staging-provider";

const DEFAULT_MODEL = "gpt-image-1.5";
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const OPENAI_TIMEOUT_MS = 5 * 60 * 1000;

export type VirtualStagingGenerationRequest = {
  source: Buffer;
  sourceFilename: string;
  context: VirtualStagingContext;
  endUserId?: string;
};

export type VirtualStagingGenerationInput = VirtualStagingGenerationRequest & {
  prompt: string;
};

export type VirtualStagingGenerationResult = {
  buffer: Buffer;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  model: string;
  provider: string;
};

/**
 * Small provider seam so a second image-edit backend can be added without
 * changing job or route code. Providers receive the immutable original bytes.
 */
export interface VirtualStagingImageProvider {
  readonly id: string;
  readonly model: string;
  isConfigured(): boolean;
  generate(input: VirtualStagingGenerationInput): Promise<VirtualStagingGenerationResult>;
}

export class VirtualStagingConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VirtualStagingConfigurationError";
  }
}

function safeUploadName(filename: string, format: "jpeg" | "png" | "webp"): string {
  const stem = filename
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "room";
  const extension = format === "jpeg" ? "jpg" : format;
  return `${stem}.${extension}`;
}

async function validateSourceImage(source: Buffer): Promise<{
  format: "jpeg" | "png" | "webp";
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
}> {
  if (source.length === 0 || source.length > MAX_INPUT_BYTES) {
    throw new Error("Source photo must be a non-empty image smaller than 50 MB");
  }
  const metadata = await sharp(source, { failOn: "error" }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("Source photo dimensions could not be read");
  if (metadata.format !== "jpeg" && metadata.format !== "png" && metadata.format !== "webp") {
    throw new Error("Source photo must be JPEG, PNG, or WebP");
  }
  const width = metadata.autoOrient?.width ?? metadata.width;
  const height = metadata.autoOrient?.height ?? metadata.height;
  return {
    format: metadata.format,
    mimeType: metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}`,
    width,
    height,
  };
}

async function validateGeneratedImage(
  buffer: Buffer,
  model: string,
  provider: string,
  sourceDimensions: { width: number; height: number },
): Promise<VirtualStagingGenerationResult> {
  if (buffer.length === 0 || buffer.length > MAX_INPUT_BYTES) {
    throw new Error("Image provider returned an empty or oversized result");
  }
  const metadata = await sharp(buffer, { failOn: "error" }).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("Image provider returned an unreadable result");
  }
  const resultWidth = metadata.autoOrient?.width ?? metadata.width;
  const resultHeight = metadata.autoOrient?.height ?? metadata.height;
  const sourceRatio = sourceDimensions.width / sourceDimensions.height;
  const resultRatio = resultWidth / resultHeight;
  const ratioDrift = Math.abs(resultRatio - sourceRatio) / sourceRatio;
  if (ratioDrift > 0.03) {
    throw new Error("Image provider changed the source photo's crop or aspect ratio");
  }
  return {
    buffer,
    mimeType: "image/jpeg",
    width: resultWidth,
    height: resultHeight,
    model,
    provider,
  };
}

function safeProviderError(error: unknown): string {
  if (error instanceof OpenAI.APIError) {
    return `OpenAI image edit failed${error.status ? ` (HTTP ${error.status})` : ""}`;
  }
  if (error instanceof Error) return error.message.slice(0, 500);
  return "Image edit failed";
}

export class OpenAIVirtualStagingProvider implements VirtualStagingImageProvider {
  readonly id = "openai";
  readonly model: string;

  constructor(
    private readonly apiKey = (process.env.OPENAI_API_KEY ?? "").trim(),
    model = (process.env.OPENAI_IMAGE_MODEL ?? "").trim() || DEFAULT_MODEL,
  ) {
    this.model = model;
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async generate(input: VirtualStagingGenerationInput): Promise<VirtualStagingGenerationResult> {
    if (!this.isConfigured()) throw new VirtualStagingConfigurationError("OPENAI_API_KEY is not configured");
    const source = await validateSourceImage(input.source);
    const client = new OpenAI({
      apiKey: this.apiKey,
      maxRetries: 2,
      timeout: OPENAI_TIMEOUT_MS,
    });
    const upload = await toFile(
      input.source,
      safeUploadName(input.sourceFilename, source.format),
      { type: source.mimeType },
    );
    const response = await client.images.edit({
      model: this.model,
      image: upload,
      prompt: input.prompt,
      input_fidelity: "high",
      quality: "high",
      size: "auto",
      output_format: "jpeg",
      output_compression: 90,
      n: 1,
      ...(input.endUserId ? { user: input.endUserId.slice(0, 128) } : {}),
    });
    const encoded = response.data?.[0]?.b64_json;
    if (!encoded) throw new Error("OpenAI image edit returned no image");
    return validateGeneratedImage(
      Buffer.from(encoded, "base64"),
      this.model,
      this.id,
      { width: source.width, height: source.height },
    );
  }
}

class MockVirtualStagingProvider implements VirtualStagingImageProvider {
  readonly id = "mock";
  readonly model = "virtual-staging-mock";

  isConfigured(): boolean {
    return process.env.VIRTUAL_STAGING_MOCK === "1"
      && (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test");
  }

  async generate(input: VirtualStagingGenerationInput): Promise<VirtualStagingGenerationResult> {
    if (!this.isConfigured()) {
      throw new VirtualStagingConfigurationError("Virtual-staging mock is restricted to development and tests");
    }
    const source = await validateSourceImage(input.source);
    const buffer = await sharp(input.source, { failOn: "error" })
      .rotate()
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer();
    return validateGeneratedImage(
      buffer,
      this.model,
      this.id,
      { width: source.width, height: source.height },
    );
  }
}

export function parseVirtualStagingConcurrency(raw = process.env.VIRTUAL_STAGING_CONCURRENCY): number {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) return 2;
  return Math.max(1, Math.min(4, parsed));
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

export class VirtualStagingService {
  private readonly limiter: Semaphore;

  constructor(
    private readonly providers: readonly VirtualStagingImageProvider[],
    concurrency = parseVirtualStagingConcurrency(),
  ) {
    this.limiter = new Semaphore(concurrency);
  }

  get model(): string {
    return (
      this.configuredProviders()[0]?.model
      ?? (process.env.OPENAI_IMAGE_MODEL ?? "").trim()
    ) || DEFAULT_MODEL;
  }

  get recipeSignature(): string {
    return virtualStagingRecipeSignature();
  }

  assertConfigured(): void {
    if (process.env.VIRTUAL_STAGING_MOCK === "1" && process.env.NODE_ENV === "production") {
      throw new VirtualStagingConfigurationError("VIRTUAL_STAGING_MOCK cannot be enabled in production");
    }
    if (this.configuredProviders().length === 0) {
      throw new VirtualStagingConfigurationError("No virtual-staging image-edit provider is configured");
    }
  }

  async generate(input: VirtualStagingGenerationRequest): Promise<VirtualStagingGenerationResult> {
    this.assertConfigured();
    const source = await validateSourceImage(input.source);
    const providerInput: VirtualStagingGenerationInput = {
      ...input,
      prompt: buildVirtualStagingPrompt(input.context),
    };
    return this.limiter.run(async () => {
      const errors: string[] = [];
      for (const provider of this.configuredProviders()) {
        try {
          const result = await provider.generate(providerInput);
          return await validateGeneratedImage(
            result.buffer,
            result.model,
            result.provider,
            { width: source.width, height: source.height },
          );
        } catch (error) {
          errors.push(`${provider.id}: ${safeProviderError(error)}`);
        }
      }
      throw new Error(errors.join("; ") || "Virtual staging failed");
    });
  }

  private configuredProviders(): VirtualStagingImageProvider[] {
    return this.providers.filter((provider) => provider.isConfigured());
  }
}

let defaultService: VirtualStagingService | null = null;
let defaultServiceSignature = "";

export function getVirtualStagingService(): VirtualStagingService {
  const signature = [
    process.env.NODE_ENV ?? "",
    process.env.VIRTUAL_STAGING_MOCK ?? "",
    process.env.REPLICATE_API_TOKEN ? "replicate-token" : "",
    process.env.REPLICATE_API_KEY ? "replicate-key" : "",
    process.env.REPLICATE_VIRTUAL_STAGING_MODEL ?? "",
    process.env.OPENAI_API_KEY ? "openai" : "",
    process.env.OPENAI_IMAGE_MODEL ?? "",
    parseVirtualStagingConcurrency(),
  ].join("|");
  if (!defaultService || defaultServiceSignature !== signature) {
    const providers: VirtualStagingImageProvider[] = [];
    if (process.env.VIRTUAL_STAGING_MOCK === "1") providers.push(new MockVirtualStagingProvider());
    providers.push(new ReplicateVirtualStagingProvider());
    providers.push(new OpenAIVirtualStagingProvider());
    defaultService = new VirtualStagingService(providers);
    defaultServiceSignature = signature;
  }
  return defaultService;
}
