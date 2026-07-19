import sharp from "sharp";

import type {
  VirtualStagingGenerationInput,
  VirtualStagingGenerationResult,
  VirtualStagingImageProvider,
} from "./virtual-staging-service";

const DEFAULT_REPLICATE_MODEL = "black-forest-labs/flux-2-pro";
const DEFAULT_REPLICATE_FEEDBACK_MODEL = "black-forest-labs/flux-2-pro";
const REPLICATE_API_ROOT = "https://api.replicate.com/v1";
const REQUEST_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const PREDICTION_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
// FLUX.2 allows 9 MP across all inputs plus output. Matching a 2 MP input keeps
// ordinary edits near 4 MP total and two-reference feedback edits near 6 MP,
// leaving headroom without changing the immutable app snapshots.
const MAX_FLUX2_INPUT_IMAGE_PIXELS = 2_000_000;
const TRANSIENT_RETRY_ATTEMPTS = 3;

type SupportedImageFormat = "jpeg" | "png" | "webp";

type ReplicateUpload = {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  width: number;
  height: number;
};

export type ReplicateFetch = (input: string, init: RequestInit) => Promise<Response>;

type ReplicateFileResponse = {
  id?: string;
  urls?: { get?: string };
};

type ReplicateFile = {
  id: string;
  url: string;
};

type ReplicatePrediction = {
  id?: string;
  status?: string;
  output?: string | string[] | null;
  error?: string | null;
  version?: string;
  urls?: { get?: string; cancel?: string };
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  fetcher: ReplicateFetch,
  input: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithTransientRetry(
  fetcher: ReplicateFetch,
  input: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  let lastResponse: Response | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < TRANSIENT_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchWithTimeout(fetcher, input, init, timeoutMs);
      lastResponse = response;
      if (response.status !== 429 && response.status < 500) return response;
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < TRANSIENT_RETRY_ATTEMPTS) {
      const baseDelay = Math.min(2_000, 350 * 2 ** attempt);
      await delay(baseDelay + Math.floor(Math.random() * 250));
    }
  }
  if (lastResponse) return lastResponse;
  throw lastError instanceof Error ? lastError : new Error("Replicate request failed");
}

function safeMessage(raw: unknown, fallback: string): string {
  const message = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  return (message || fallback).slice(0, 400);
}

function safeFilename(filename: string, format: SupportedImageFormat): string {
  const stem = filename
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "room";
  return `${stem}.${format === "jpeg" ? "jpg" : format}`;
}

function assertModelName(model: string, setting: string): void {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(model)) {
    throw new Error(`${setting} must use owner/model format`);
  }
}

function isFlux2Model(model: string): boolean {
  return model.toLowerCase().includes("/flux-2");
}

async function prepareUpload(
  buffer: Buffer,
  filename: string,
  maxPixels?: number,
): Promise<ReplicateUpload> {
  const metadata = await sharp(buffer, { failOn: "error" }).metadata();
  if (
    !metadata.width
    || !metadata.height
    || (metadata.format !== "jpeg" && metadata.format !== "png" && metadata.format !== "webp")
  ) {
    throw new Error("Replicate virtual staging requires a readable JPEG, PNG, or WebP source");
  }
  const width = metadata.autoOrient?.width ?? metadata.width;
  const height = metadata.autoOrient?.height ?? metadata.height;
  if (!maxPixels || width * height <= maxPixels) {
    return {
      buffer,
      filename: safeFilename(filename, metadata.format),
      mimeType: metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}`,
      width,
      height,
    };
  }

  const scale = Math.sqrt(maxPixels / (width * height));
  const resizedWidth = Math.max(1, Math.floor(width * scale));
  const resizedHeight = Math.max(1, Math.floor(height * scale));
  const resized = await sharp(buffer, { failOn: "error" })
    .rotate()
    .resize(resizedWidth, resizedHeight, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
  const resizedMetadata = await sharp(resized, { failOn: "error" }).metadata();
  if (!resizedMetadata.width || !resizedMetadata.height) {
    throw new Error("Replicate feedback upload could not be resized safely");
  }
  return {
    buffer: resized,
    filename: safeFilename(filename, "jpeg"),
    mimeType: "image/jpeg",
    width: resizedMetadata.width,
    height: resizedMetadata.height,
  };
}

function isTrustedReplicateHost(hostname: string, root: string): boolean {
  return hostname === root || hostname.endsWith(`.${root}`);
}

export function trustedReplicateUrl(raw: string, root: string): string | null {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" && isTrustedReplicateHost(parsed.hostname, root)
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function outputUrl(prediction: ReplicatePrediction): string | null {
  const output = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
  if (typeof output !== "string") return null;
  // The HTTP API requires the bearer token when downloading output files.
  // Never forward that credential to an arbitrary HTTPS host supplied in an
  // unexpected provider response.
  return trustedReplicateUrl(output, "replicate.delivery");
}

/**
 * Uses the provider already configured by this application. Replicate Files
 * keeps the immutable source private from the browser while giving each model
 * short-lived image-edit inputs; the generated result is immediately copied
 * to the app's durable photo volume.
 */
export class ReplicateVirtualStagingProvider implements VirtualStagingImageProvider {
  readonly id = "replicate";
  readonly supportsReferenceImages = true;
  readonly model: string;
  readonly feedbackModel: string;

  constructor(
    private readonly apiToken = (
      process.env.REPLICATE_API_TOKEN
      ?? process.env.REPLICATE_API_KEY
      ?? ""
    ).trim(),
    model = (process.env.REPLICATE_VIRTUAL_STAGING_MODEL ?? "").trim() || DEFAULT_REPLICATE_MODEL,
    feedbackModel = (process.env.REPLICATE_VIRTUAL_STAGING_FEEDBACK_MODEL ?? "").trim()
      || DEFAULT_REPLICATE_FEEDBACK_MODEL,
    private readonly fetcher: ReplicateFetch = fetch,
  ) {
    assertModelName(model, "REPLICATE_VIRTUAL_STAGING_MODEL");
    assertModelName(feedbackModel, "REPLICATE_VIRTUAL_STAGING_FEEDBACK_MODEL");
    this.model = model;
    this.feedbackModel = feedbackModel;
  }

  isConfigured(): boolean {
    return this.apiToken.length > 0;
  }

  async generate(input: VirtualStagingGenerationInput): Promise<VirtualStagingGenerationResult> {
    if (!this.isConfigured()) {
      throw new Error("REPLICATE_API_TOKEN or REPLICATE_API_KEY is not configured");
    }

    const isFeedbackRevision = input.mode === "feedback-revision";
    if (isFeedbackRevision && !input.referenceSource) {
      throw new Error("Replicate feedback revision requires the reviewed staged preview");
    }
    const selectedModel = isFeedbackRevision ? this.feedbackModel : this.model;
    const usesFlux2 = isFlux2Model(selectedModel);
    const sourceUpload = await prepareUpload(
      input.source,
      input.sourceFilename,
      usesFlux2 ? MAX_FLUX2_INPUT_IMAGE_PIXELS : undefined,
    );
    const referenceUpload = isFeedbackRevision
      ? await prepareUpload(
        input.referenceSource!,
        `reviewed-preview-${input.sourceFilename}`,
        usesFlux2 ? MAX_FLUX2_INPUT_IMAGE_PIXELS : undefined,
      )
      : null;
    const sourceAspectRatio = sourceUpload.width / sourceUpload.height;
    if (referenceUpload) {
      const referenceAspectRatio = referenceUpload.width / referenceUpload.height;
      if (Math.abs(referenceAspectRatio / sourceAspectRatio - 1) > 0.03) {
        throw new Error("Replicate feedback reference has a different aspect ratio from the original");
      }
    }

    const files: ReplicateFile[] = [];

    try {
      const sourceFile = await this.upload(sourceUpload, "source");
      files.push(sourceFile);
      let referenceFile: ReplicateFile | null = null;
      if (referenceUpload) {
        referenceFile = await this.upload(referenceUpload, "reviewed preview");
        files.push(referenceFile);
      }
      const providerInput = referenceFile || usesFlux2
        ? {
          prompt: input.prompt,
          // FLUX.2 resolves image indices in this exact order. Image 1 is the
          // immutable original; Image 2, when present, is review-only context.
          input_images: referenceFile
            ? [sourceFile.url, referenceFile.url]
            : [sourceFile.url],
          aspect_ratio: "match_input_image",
          resolution: "match_input_image",
          output_format: "jpg",
          output_quality: 90,
          safety_tolerance: 2,
        }
        : {
          prompt: input.prompt,
          input_image: sourceFile.url,
          aspect_ratio: "match_input_image",
          output_format: "jpg",
          safety_tolerance: 2,
          prompt_upsampling: false,
        };
      const created = await fetchWithTimeout(
        this.fetcher,
        `${REPLICATE_API_ROOT}/models/${selectedModel}/predictions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            "Content-Type": "application/json",
            "Cancel-After": "5m",
          },
          body: JSON.stringify({
            input: providerInput,
          }),
        },
      );
      if (!created.ok) {
        throw new Error(`Replicate image edit failed (HTTP ${created.status})`);
      }

      let prediction = await created.json() as ReplicatePrediction;
      const predictionId = prediction.id ?? "unknown";
      const deadline = Date.now() + PREDICTION_TIMEOUT_MS;
      let pollDelayMs = 1_000;
      while (
        prediction.status !== "succeeded"
        && prediction.status !== "failed"
        && prediction.status !== "canceled"
        && prediction.status !== "aborted"
      ) {
        if (Date.now() >= deadline) throw new Error("Replicate image edit timed out after 5 minutes");
        const rawPollUrl = prediction.urls?.get
          ?? (prediction.id ? `${REPLICATE_API_ROOT}/predictions/${prediction.id}` : null);
        const pollUrl = rawPollUrl ? trustedReplicateUrl(rawPollUrl, "api.replicate.com") : null;
        if (!pollUrl) throw new Error("Replicate image edit returned no polling URL");
        await delay(pollDelayMs + Math.floor(Math.random() * 250));
        pollDelayMs = Math.min(5_000, Math.ceil(pollDelayMs * 1.5));
        const polled = await fetchWithTransientRetry(this.fetcher, pollUrl, {
          headers: { Authorization: `Bearer ${this.apiToken}` },
        });
        if (!polled.ok) throw new Error(`Replicate progress check failed (HTTP ${polled.status})`);
        prediction = await polled.json() as ReplicatePrediction;
      }

      if (prediction.status !== "succeeded") {
        throw new Error(safeMessage(prediction.error, `Replicate image edit ${prediction.status ?? "failed"}`));
      }
      const generatedUrl = outputUrl(prediction);
      if (!generatedUrl) throw new Error("Replicate image edit returned no HTTPS image URL");
      const downloaded = await fetchWithTransientRetry(this.fetcher, generatedUrl, {
        // Replicate's HTTP API requires authentication when fetching prediction
        // file outputs, even though the returned value is an HTTPS URL.
        headers: { Authorization: `Bearer ${this.apiToken}` },
      }, REQUEST_TIMEOUT_MS);
      if (!downloaded.ok) throw new Error(`Replicate result download failed (HTTP ${downloaded.status})`);
      const declaredBytes = Number(downloaded.headers.get("content-length") ?? "0");
      if (declaredBytes > MAX_OUTPUT_BYTES) throw new Error("Replicate result exceeded the 50 MB limit");
      const rawOutput = Buffer.from(await downloaded.arrayBuffer());
      if (rawOutput.length === 0 || rawOutput.length > MAX_OUTPUT_BYTES) {
        throw new Error("Replicate returned an empty or oversized image");
      }
      const outputMetadata = await sharp(rawOutput, { failOn: "error" }).metadata();
      if (!outputMetadata.width || !outputMetadata.height) {
        throw new Error("Replicate returned an unreadable image");
      }
      const outputWidth = outputMetadata.autoOrient?.width ?? outputMetadata.width;
      const outputHeight = outputMetadata.autoOrient?.height ?? outputMetadata.height;
      const outputAspectRatio = outputWidth / outputHeight;
      if (Math.abs(outputAspectRatio / sourceAspectRatio - 1) > 0.03) {
        throw new Error("Replicate changed the source aspect ratio too much to review safely");
      }
      const buffer = await sharp(rawOutput, { failOn: "error" })
        .rotate()
        .jpeg({ quality: 92, mozjpeg: true })
        .toBuffer();
      console.info(`[virtual-staging] Replicate prediction ${predictionId} succeeded with ${selectedModel}`);
      return {
        buffer,
        mimeType: "image/jpeg",
        width: outputWidth,
        height: outputHeight,
        model: prediction.version ? `${selectedModel}@${prediction.version}` : selectedModel,
        provider: this.id,
      };
    } finally {
      // The immutable app snapshots remain; only the provider's short-lived
      // upload copies are cleaned after the prediction reaches a terminal state.
      await Promise.allSettled(files.map((file) => fetchWithTimeout(
        this.fetcher,
        `${REPLICATE_API_ROOT}/files/${encodeURIComponent(file.id)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${this.apiToken}` },
        },
        CLEANUP_TIMEOUT_MS,
      )));
    }
  }

  private async upload(upload: ReplicateUpload, label: string): Promise<ReplicateFile> {
    const form = new FormData();
    form.append(
      "content",
      new Blob([new Uint8Array(upload.buffer)], { type: upload.mimeType }),
      upload.filename,
    );
    const uploaded = await fetchWithTimeout(this.fetcher, `${REPLICATE_API_ROOT}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiToken}` },
      body: form,
    });
    if (!uploaded.ok) {
      throw new Error(`Replicate ${label} upload failed (HTTP ${uploaded.status})`);
    }
    const file = await uploaded.json() as ReplicateFileResponse;
    if (!file.id || !file.urls?.get) {
      if (file.id) {
        await Promise.allSettled([fetchWithTimeout(
          this.fetcher,
          `${REPLICATE_API_ROOT}/files/${encodeURIComponent(file.id)}`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${this.apiToken}` },
          },
          CLEANUP_TIMEOUT_MS,
        )]);
      }
      throw new Error(`Replicate ${label} upload returned no file URL`);
    }
    return { id: file.id, url: file.urls.get };
  }
}
