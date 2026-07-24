import OpenAI, { toFile } from "openai";
import sharp from "sharp";

import {
  buildVirtualStagingFeedbackPrompt,
  buildVirtualStagingPrompt,
  virtualStagingRecipeSignature,
  virtualStagingViewpointDirectionForSource,
  type VirtualStagingContext,
  type VirtualStagingSourceManifest,
} from "@shared/virtual-staging";
import { DUPLICATE_DISTANCE, hammingDistance, HASH_BITS } from "@shared/photo-hash-distance";
import { ReplicateVirtualStagingProvider } from "./replicate-virtual-staging-provider";
import {
  AnthropicVirtualStagingViewpointVerifier,
  VirtualStagingViewpointRejectedError,
  VirtualStagingViewpointVerificationUnavailableError,
  type VirtualStagingViewpointVerifier,
} from "./virtual-staging-viewpoint-verifier";
import { assertManifestDrivenImageChecks } from "./virtual-staging-image-checks";

const DEFAULT_MODEL = "gpt-image-2";
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const OPENAI_TIMEOUT_MS = 5 * 60 * 1000;

export type VirtualStagingGenerationRequest = {
  /** Immutable original used as the geometry and property-style authority. */
  source: Buffer;
  sourceFilename: string;
  generationAttempt: number;
  previousPreview?: Buffer;
  context: VirtualStagingContext;
  endUserId?: string;
  mode?: "alternate-angle" | "feedback-revision";
  feedback?: string;
};

export type VirtualStagingGenerationInput = Omit<VirtualStagingGenerationRequest, "source"> & {
  /** Immutable original: always the primary image/edit base. */
  source: Buffer;
  /** Reviewed staged preview supplied only as a visual reference for feedback. */
  referenceSource?: Buffer;
  prompt: string;
  mode: "alternate-angle" | "feedback-revision";
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
 * changing job or route code.
 */
export interface VirtualStagingImageProvider {
  readonly id: string;
  readonly model: string;
  readonly supportsReferenceImages: boolean;
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
    throw new Error("Image provider changed the source photo's aspect ratio");
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

export async function computeVirtualStagingDhash(buffer: Buffer): Promise<string> {
  const { data, info } = await sharp(buffer, { failOn: "error" })
    .rotate()
    .grayscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== 9 || info.height !== 8 || data.length !== 72) {
    throw new Error("Generated preview could not be compared with its source");
  }
  let hex = "";
  for (let bitOffset = 0; bitOffset < HASH_BITS; bitOffset += 8) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      const index = bitOffset + bit;
      const row = Math.floor(index / 8);
      const column = index % 8;
      if (data[row * 9 + column] > data[row * 9 + column + 1]) {
        byte |= 1 << (7 - bit);
      }
    }
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

async function assertMeaningfullyDifferentPreview(
  source: Buffer,
  generated: Buffer,
  provider: string,
  previousPreviewHash?: string,
): Promise<void> {
  // The development mock intentionally echoes the source so the job/review UI
  // can run without spending provider credits. Real providers must produce a
  // visibly distinct image; this hash is only a no-op/duplicate guard. The
  // separate vision verifier decides whether permanent geometry proves that
  // the camera viewpoint actually changed.
  if (provider === "mock") return;
  const [sourceHash, generatedHash] = await Promise.all([
    computeVirtualStagingDhash(source),
    computeVirtualStagingDhash(generated),
  ]);
  if (hammingDistance(sourceHash, generatedHash) <= DUPLICATE_DISTANCE) {
    throw new Error("Image provider returned a preview too visually similar to the source photo");
  }
  if (previousPreviewHash) {
    if (hammingDistance(previousPreviewHash, generatedHash) <= DUPLICATE_DISTANCE) {
      throw new Error("Image provider returned a preview too visually similar to the previous staged angle");
    }
  }
}

function assertRefinementChangedPreview(reviewedPreview: Buffer, generated: Buffer, provider: string): void {
  if (provider === "mock") return;
  if (reviewedPreview.equals(generated)) {
    throw new Error("Image provider returned the reviewed staged preview without applying feedback");
  }
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
  readonly supportsReferenceImages = true;
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
    let image: typeof upload | Array<typeof upload> = upload;
    if (input.referenceSource) {
      const reference = await validateSourceImage(input.referenceSource);
      const sourceRatio = source.width / source.height;
      const referenceRatio = reference.width / reference.height;
      if (Math.abs(referenceRatio - sourceRatio) / sourceRatio > 0.03) {
        throw new Error("Virtual-staging reference photo has a different aspect ratio");
      }
      const referenceUpload = await toFile(
        input.referenceSource,
        safeUploadName(`reviewed-preview-${input.sourceFilename}`, reference.format),
        { type: reference.mimeType },
      );
      image = [upload, referenceUpload];
    }
    const legacyInputFidelity = /^gpt-image-2(?:$|-)/i.test(this.model)
      ? {}
      : { input_fidelity: "high" as const };
    const response = await client.images.edit({
      model: this.model,
      image,
      prompt: input.prompt,
      ...legacyInputFidelity,
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
  readonly supportsReferenceImages = true;
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
    private readonly viewpointVerifier: VirtualStagingViewpointVerifier =
      new AnthropicVirtualStagingViewpointVerifier(),
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

  assertConfigured(mode: "alternate-angle" | "feedback-revision" = "alternate-angle"): void {
    if (process.env.VIRTUAL_STAGING_MOCK === "1" && process.env.NODE_ENV === "production") {
      throw new VirtualStagingConfigurationError("VIRTUAL_STAGING_MOCK cannot be enabled in production");
    }
    const providers = this.providersFor(mode);
    if (providers.length === 0) {
      throw new VirtualStagingConfigurationError(
        mode === "feedback-revision"
          ? "Per-photo feedback requires a configured image-edit provider that supports both the immutable original and reviewed preview"
          : "No virtual-staging image-edit provider is configured",
      );
    }
    if (providers.some((provider) => provider.id !== "mock") && !this.viewpointVerifier.isConfigured()) {
      throw new VirtualStagingConfigurationError(
        "ANTHROPIC_API_KEY is required to verify virtual-staging image edits",
      );
    }
  }

  async generate(input: VirtualStagingGenerationRequest): Promise<VirtualStagingGenerationResult> {
    const mode = input.mode ?? "alternate-angle";
    this.assertConfigured(mode);
    const source = await validateSourceImage(input.source);
    const feedback = input.feedback?.trim();
    if (mode === "feedback-revision" && (!input.previousPreview || !feedback)) {
      throw new Error("Feedback revision requires the exact reviewed staged preview and non-empty feedback");
    }
    // Validate and fingerprint retained previews before spending on a provider
    // call. Corrupt comparison/edit input applies to every provider, so a paid
    // fallback cannot repair it.
    if (input.previousPreview) {
      const previous = await validateSourceImage(input.previousPreview);
      const sourceRatio = source.width / source.height;
      const previousRatio = previous.width / previous.height;
      if (Math.abs(previousRatio - sourceRatio) / sourceRatio > 0.03) {
        throw new Error("The reviewed staged preview has a different aspect ratio from its original");
      }
    }
    const previousPreviewHash = mode === "alternate-angle" && input.previousPreview
      ? await computeVirtualStagingDhash(input.previousPreview)
      : undefined;
    const viewpointDirection = virtualStagingViewpointDirectionForSource(
      input.sourceFilename,
      input.generationAttempt,
    );
    return this.limiter.run(async () => {
      // A strict source manifest is created once, before any image-provider
      // spend, and remains immutable across every provider and retry.
      const hasRealProvider = this.providersFor(mode).some((provider) => provider.id !== "mock");
      const manifest: VirtualStagingSourceManifest | undefined = mode === "alternate-angle"
        && hasRealProvider
        ? await this.viewpointVerifier.analyzeSource({
          source: input.source,
          sourceFilename: input.sourceFilename,
          context: input.context,
        })
        : undefined;
      const basePrompt = mode === "feedback-revision"
        ? buildVirtualStagingFeedbackPrompt(input.context, feedback!)
        : buildVirtualStagingPrompt(input.context, viewpointDirection, manifest);
      const baseProviderInput: VirtualStagingGenerationInput = {
        ...input,
        // The immutable original remains Image 1 for every generation. The
        // reviewed preview is reference-only, preventing iterative edits from
        // compounding generated pixels and architectural drift.
        source: input.source,
        ...(mode === "feedback-revision" ? { referenceSource: input.previousPreview! } : {}),
        mode,
        prompt: basePrompt,
      };
      const errors: string[] = [];
      for (const provider of this.providersFor(mode)) {
        const providerAttempts = mode === "alternate-angle" ? 2 : 1;
        let qualityRetryReason: string | null = null;
        for (let providerAttempt = 1; providerAttempt <= providerAttempts; providerAttempt += 1) {
          try {
            const providerInput: VirtualStagingGenerationInput = qualityRetryReason
              ? {
                ...baseProviderInput,
                prompt: `${basePrompt} QUALITY RETRY: The prior candidate failed strict QA because ${JSON.stringify(qualityRetryReason)}. Correct that exact defect while satisfying every unchanged manifest requirement. Generate again from the immutable original; do not edit the rejected candidate.`,
              }
              : baseProviderInput;
            const result = await provider.generate(providerInput);
            const validated = await validateGeneratedImage(
              result.buffer,
              result.model,
              result.provider,
              { width: source.width, height: source.height },
            );
            if (mode === "feedback-revision") {
              assertRefinementChangedPreview(input.previousPreview!, validated.buffer, result.provider);
            } else {
              await assertMeaningfullyDifferentPreview(
                input.source,
                validated.buffer,
                result.provider,
                previousPreviewHash,
              );
              if (manifest) {
                await assertManifestDrivenImageChecks({
                  source: input.source,
                  generated: validated.buffer,
                  manifest,
                  provider: result.provider,
                });
              }
            }
            if (result.provider !== "mock") {
              await this.viewpointVerifier.verify({
                source: input.source,
                generated: validated.buffer,
                previousGenerated: input.previousPreview,
                requestedDirection: viewpointDirection,
                context: input.context,
                imageProvider: result.provider,
                generationAttempt: input.generationAttempt,
                mode,
                ...(manifest ? { manifest } : {}),
                ...(mode === "feedback-revision" ? { feedback } : {}),
              });
            }
            return validated;
          } catch (error) {
            // A verifier outage applies to every image provider. Stop instead of
            // spending credits on another generation that cannot be validated.
            if (error instanceof VirtualStagingViewpointVerificationUnavailableError) throw error;
            if (
              mode === "alternate-angle"
              && error instanceof VirtualStagingViewpointRejectedError
              && providerAttempt < providerAttempts
            ) {
              qualityRetryReason = safeProviderError(error);
              console.info(`[virtual-staging] ${JSON.stringify({
                event: "quality-retry",
                provider: provider.id,
                generationAttempt: input.generationAttempt,
                providerAttempt,
                reason: qualityRetryReason,
              })}`);
              continue;
            }
            errors.push(`${provider.id}: ${safeProviderError(error)}`);
            break;
          }
        }
      }
      throw new Error(errors.join("; ") || "Virtual staging failed");
    });
  }

  private configuredProviders(): VirtualStagingImageProvider[] {
    return this.providers.filter((provider) => provider.isConfigured());
  }

  private providersFor(mode: "alternate-angle" | "feedback-revision"): VirtualStagingImageProvider[] {
    const configured = this.configuredProviders();
    if (mode !== "feedback-revision") return configured;
    // Feedback is only safe when the provider sees both the immutable original
    // and the exact preview the operator reviewed. Never make a second paid
    // attempt through a single-image provider with silently degraded context.
    return [
      ...configured.filter((provider) => provider.supportsReferenceImages && provider.id === "mock"),
      ...configured.filter((provider) => provider.supportsReferenceImages && provider.id === "openai"),
      ...configured.filter((provider) => provider.supportsReferenceImages
        && provider.id !== "mock"
        && provider.id !== "openai"),
    ];
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
    process.env.REPLICATE_VIRTUAL_STAGING_FEEDBACK_MODEL ?? "",
    process.env.OPENAI_API_KEY ? "openai" : "",
    process.env.OPENAI_IMAGE_MODEL ?? "",
    process.env.ANTHROPIC_API_KEY ? "anthropic" : "",
    process.env.VIRTUAL_STAGING_VIEWPOINT_MODEL ?? "",
    process.env.VIRTUAL_STAGING_MANIFEST_MODEL ?? "",
    process.env.VIRTUAL_STAGING_ADVERSARIAL_MODEL ?? "",
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
