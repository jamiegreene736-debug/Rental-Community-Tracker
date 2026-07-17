import sharp from "sharp";

import { VIRTUAL_STAGING_PROMPT } from "@shared/virtual-staging";
import type {
  VirtualStagingGenerationInput,
  VirtualStagingGenerationResult,
  VirtualStagingImageProvider,
} from "./virtual-staging-service";

const DEFAULT_REPLICATE_MODEL = "black-forest-labs/flux-kontext-pro";
const REPLICATE_API_ROOT = "https://api.replicate.com/v1";
const REQUEST_TIMEOUT_MS = 30_000;
const PREDICTION_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const TRANSIENT_RETRY_ATTEMPTS = 3;

type ReplicateFile = {
  id?: string;
  urls?: { get?: string };
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
  input: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithTransientRetry(
  input: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  let lastResponse: Response | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < TRANSIENT_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchWithTimeout(input, init, timeoutMs);
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

function safeFilename(filename: string, format: "jpeg" | "png" | "webp"): string {
  const stem = filename
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "room";
  return `${stem}.${format === "jpeg" ? "jpg" : format}`;
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
 * keeps the immutable source private from the browser while giving Kontext a
 * short-lived image-edit input; the generated result is immediately copied to
 * the app's durable photo volume.
 */
export class ReplicateVirtualStagingProvider implements VirtualStagingImageProvider {
  readonly id = "replicate";
  readonly model: string;

  constructor(
    private readonly apiToken = (
      process.env.REPLICATE_API_TOKEN
      ?? process.env.REPLICATE_API_KEY
      ?? ""
    ).trim(),
    model = (process.env.REPLICATE_VIRTUAL_STAGING_MODEL ?? "").trim() || DEFAULT_REPLICATE_MODEL,
  ) {
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(model)) {
      throw new Error("REPLICATE_VIRTUAL_STAGING_MODEL must use owner/model format");
    }
    this.model = model;
  }

  isConfigured(): boolean {
    return this.apiToken.length > 0;
  }

  async generate(input: VirtualStagingGenerationInput): Promise<VirtualStagingGenerationResult> {
    if (!this.isConfigured()) {
      throw new Error("REPLICATE_API_TOKEN or REPLICATE_API_KEY is not configured");
    }

    const sourceMetadata = await sharp(input.source, { failOn: "error" }).metadata();
    if (
      !sourceMetadata.width
      || !sourceMetadata.height
      || (sourceMetadata.format !== "jpeg" && sourceMetadata.format !== "png" && sourceMetadata.format !== "webp")
    ) {
      throw new Error("Replicate virtual staging requires a readable JPEG, PNG, or WebP source");
    }
    const sourceWidth = sourceMetadata.autoOrient?.width ?? sourceMetadata.width;
    const sourceHeight = sourceMetadata.autoOrient?.height ?? sourceMetadata.height;
    const sourceAspectRatio = sourceWidth / sourceHeight;
    const sourceMimeType = sourceMetadata.format === "jpeg" ? "image/jpeg" : `image/${sourceMetadata.format}`;

    const form = new FormData();
    form.append(
      "content",
      new Blob([new Uint8Array(input.source)], { type: sourceMimeType }),
      safeFilename(input.sourceFilename, sourceMetadata.format),
    );

    const uploaded = await fetchWithTimeout(`${REPLICATE_API_ROOT}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiToken}` },
      body: form,
    });
    if (!uploaded.ok) {
      throw new Error(`Replicate source upload failed (HTTP ${uploaded.status})`);
    }
    const file = await uploaded.json() as ReplicateFile;
    if (!file.id || !file.urls?.get) throw new Error("Replicate source upload returned no file URL");

    try {
      const created = await fetchWithTimeout(
        `${REPLICATE_API_ROOT}/models/${this.model}/predictions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            "Content-Type": "application/json",
            "Cancel-After": "5m",
          },
          body: JSON.stringify({
            input: {
              prompt: VIRTUAL_STAGING_PROMPT,
              input_image: file.urls.get,
              aspect_ratio: "match_input_image",
              output_format: "jpg",
              safety_tolerance: 2,
              prompt_upsampling: false,
            },
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
        const polled = await fetchWithTransientRetry(pollUrl, {
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
      const downloaded = await fetchWithTransientRetry(generatedUrl, {
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
        throw new Error("Replicate changed the source crop or aspect ratio too much to review safely");
      }
      const buffer = await sharp(rawOutput, { failOn: "error" })
        .rotate()
        .jpeg({ quality: 92, mozjpeg: true })
        .toBuffer();
      console.info(`[virtual-staging] Replicate prediction ${predictionId} succeeded with ${this.model}`);
      return {
        buffer,
        mimeType: "image/jpeg",
        width: outputMetadata.width,
        height: outputMetadata.height,
        model: prediction.version ? `${this.model}@${prediction.version}` : this.model,
        provider: this.id,
      };
    } finally {
      // The immutable app snapshot remains; only the provider's short-lived
      // upload is cleaned up after its prediction reaches a terminal state.
      void fetch(`${REPLICATE_API_ROOT}/files/${encodeURIComponent(file.id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.apiToken}` },
      }).catch(() => undefined);
    }
  }
}
