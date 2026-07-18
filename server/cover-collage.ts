// AI cover-collage engine — disk + vision + sharp IO for
// POST /api/builder/auto-cover-collage (server/routes.ts). All pure decisions
// (prompt, reply parsing, heuristic fallback, ESRGAN gate, geometry) live in
// shared/cover-collage-logic.ts, locked by tests/cover-collage-logic.test.ts.
//
// Flow: the client sends its rendered (visible) photos array — same
// client-driven posture as photo-community-check/photo-dedupe, so drafts and
// single listings work. We keep the candidates whose bytes exist on disk,
// show them ALL to Claude vision in ONE batched call (downscaled, capped),
// and compose the two picks into the 1600×800 2-up cover the manual canvas
// flow has always produced.
//
// Vision is FAIL-SOFT by design: no ANTHROPIC key, kill switch, a vision
// error, or an unparseable/ineligible reply degrades the pick to the caption
// heuristic (the exact pre-AI client behavior) — the button always yields a
// collage when >=2 local photos exist.

import fs from "fs";
import path from "path";
import sharp from "sharp";
import {
  buildCollageVisionPrompt,
  collageEsrganScale,
  evenSampleIndices,
  heuristicCollagePick,
  parseCollageVisionPick,
  parseLocalPhotoUrl,
  resolveForcedCollagePick,
  COLLAGE_HEIGHT,
  COLLAGE_PANEL_PX,
  COLLAGE_WIDTH,
  type CollageCandidate,
  type CollagePickIndices,
  type ForcedCollagePick,
} from "../shared/cover-collage-logic";

const MODEL = process.env.COVER_COLLAGE_MODEL || "claude-sonnet-4-6";
const ANTHROPIC_TIMEOUT_MS = 120_000;
// Cap on photos inlined into the single vision call (even-sampled beyond it —
// gallery order means front-loaded hero shots always stay in the pool).
const VISION_PHOTO_CAP = Number(process.env.COVER_COLLAGE_VISION_CAP || 60);
// Cover choice doesn't need full resolution; 640px keeps 60 photos well under
// the request-size ceiling (mirrors the photo-dedupe vision call).
const VISION_IMAGE_WIDTH = 640;

function photosRoot(): string {
  return path.join(process.cwd(), "client/public/photos");
}

export type CoverCollagePick = {
  url: string;
  caption: string | null;
  source: string | null;
};

export type AutoCoverCollageResult = {
  /** Composed 1600×800 JPEG, ready for ImgBB + the Guesty cover PUT. */
  buffer: Buffer;
  left: CoverCollagePick;
  right: CoverCollagePick;
  /** How the pair was chosen. "manual" = the operator picked both photos in
   * the Photos-tab picker (forcedPick) — no vision spend, no fallback. */
  method: "vision" | "heuristic" | "manual";
  reasoning: string | null;
  /** Model that made the pick — null on the heuristic and manual paths. */
  model: string | null;
  candidateCount: number;
};

type ResolvedCandidate = CollageCandidate & { absPath: string };

function resolveLocalCandidates(photos: CollageCandidate[]): ResolvedCandidate[] {
  const out: ResolvedCandidate[] = [];
  const seen = new Set<string>();
  for (const p of photos) {
    const parsed = parseLocalPhotoUrl(p.url);
    if (!parsed) continue; // external (Guesty CDN) photo — no bytes to read
    // Same sanitization as every other photo route — the folder/filename came
    // off the client and must stay inside the photos root.
    const safeFolder = parsed.folder.replace(/[^a-zA-Z0-9_-]+/g, "-");
    const safeFile = parsed.filename.replace(/\.\./g, "");
    const absPath = path.join(photosRoot(), safeFolder, safeFile);
    if (seen.has(absPath)) continue;
    if (!fs.existsSync(absPath)) continue;
    seen.add(absPath);
    out.push({ ...p, absPath });
  }
  return out;
}

async function downscaleForVision(buffer: Buffer): Promise<{ data: string; mime: string }> {
  try {
    const out = await sharp(buffer)
      .rotate()
      .resize({ width: VISION_IMAGE_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toBuffer();
    return { data: out.toString("base64"), mime: "image/jpeg" };
  } catch {
    return { data: buffer.toString("base64"), mime: "image/jpeg" };
  }
}

async function callCollageVision(
  apiKey: string,
  photos: Array<{ buffer: Buffer; caption?: string | null; source?: string | null }>,
): Promise<unknown> {
  const content: any[] = [];
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    const cap = p.caption ? ` · caption: "${p.caption}"` : "";
    const src = p.source ? ` · section: "${p.source}"` : "";
    content.push({ type: "text", text: `--- photo ${i + 1}${cap}${src} ---` });
    const img = await downscaleForVision(p.buffer);
    content.push({ type: "image", source: { type: "base64", media_type: img.mime, data: img.data } });
  }
  content.push({ type: "text", text: buildCollageVisionPrompt(photos.length) });

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      messages: [{ role: "user", content }],
    }),
    signal: AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS),
  });
  const data = await resp.json().catch(() => null) as any;
  if (!resp.ok) throw new Error(data?.error?.message ?? `HTTP ${resp.status}`);
  const text: string = data?.content?.[0]?.text ?? "";
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("vision response was not JSON");
  return JSON.parse(match[0]);
}

/** Vision pick over the (sampled) candidate pool. Throws on any failure —
 * the caller catches and falls back to the heuristic. */
async function visionPick(
  apiKey: string,
  candidates: ResolvedCandidate[],
  requirePatioProof = false,
): Promise<CollagePickIndices> {
  const sample = evenSampleIndices(candidates.length, VISION_PHOTO_CAP);
  const sampled = sample.map((i) => candidates[i]);
  const photos = sampled.map((c) => ({
    buffer: fs.readFileSync(c.absPath),
    caption: c.caption ?? null,
    source: c.source ?? null,
  }));
  const raw = await callCollageVision(apiKey, photos);
  const pick = parseCollageVisionPick(raw, sampled.length);
  if (!pick) throw new Error("vision reply was not a usable pick");
  const sampledCommunity = sampled.map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => (candidate.source ?? "").toLowerCase().startsWith("community"));
  const sampledUnits = sampled.map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => !(candidate.source ?? "").toLowerCase().startsWith("community"));
  if (requirePatioProof && sampledCommunity.length === 0) {
    throw new Error("vision pick has no published community-photo pool for the left panel");
  }
  if (requirePatioProof && sampledUnits.length === 0) {
    throw new Error("vision pick has no published unit-photo pool for the right patio panel");
  }
  if (sampledCommunity.length > 0 && !sampledCommunity.some(({ index }) => index === pick.leftIndex)) {
    throw new Error("vision pick did not place a community photo on the left");
  }
  if (sampledUnits.length > 0 && !sampledUnits.some(({ index }) => index === pick.rightIndex)) {
    throw new Error("vision pick did not place a unit patio photo on the right");
  }
  if (requirePatioProof && !new Set([
    "patio", "lanai", "balcony", "deck", "porch", "outdoor-transition",
  ]).has(pick.rightScene ?? "")) {
    throw new Error("vision pick did not prove the right panel is a patio, lanai, balcony, deck, porch, or outdoor-transition space");
  }
  return {
    leftIndex: sample[pick.leftIndex],
    rightIndex: sample[pick.rightIndex],
    reasoning: pick.reasoning,
  };
}

function mimeForFile(absPath: string): string {
  const ext = path.extname(absPath).toLowerCase();
  return ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
}

/** Load one pick's bytes, ESRGAN-upscale only when genuinely below the panel
 * size (short-side gate — see collageEsrganScale), then cover-crop to the
 * square panel. */
async function preparePanel(
  candidate: ResolvedCandidate,
  upscale?: (buf: Buffer, mimeType: string, scale: number) => Promise<Buffer | null>,
): Promise<Buffer> {
  let bytes = fs.readFileSync(candidate.absPath);
  if (upscale) {
    try {
      const dims = await sharp(bytes, { failOn: "none" }).metadata();
      const scale = collageEsrganScale(dims.width, dims.height);
      if (scale != null) {
        const up = await upscale(bytes, mimeForFile(candidate.absPath), scale);
        if (up) bytes = up;
      }
    } catch {
      // Unreadable metadata / upscale failure — compose from the original.
    }
  }
  return sharp(bytes, { failOn: "none" })
    .rotate()
    .resize(COLLAGE_PANEL_PX, COLLAGE_PANEL_PX, { fit: "cover", position: "centre" })
    .toBuffer();
}

export async function generateAutoCoverCollage(opts: {
  photos: CollageCandidate[];
  /** Dashboard full-audit rail: Claude must make the pick. Manual callers
   * omit this and retain the existing fail-soft caption heuristic. */
  requireVision?: boolean;
  /** Real-ESRGAN hook (routes.ts passes upscaleWithReplicateKw). Absent/null
   * result → classical resize only. */
  upscale?: (buf: Buffer, mimeType: string, scale: number) => Promise<Buffer | null>;
  /** "pick manually": the operator's two chosen photo URLs. Bypasses vision
   * and the heuristic entirely — see the forcedPick branch below. */
  forcedPick?: ForcedCollagePick;
}): Promise<AutoCoverCollageResult> {
  const candidates = resolveLocalCandidates(opts.photos ?? []);
  if (candidates.length < 2) {
    throw new Error(
      `Need at least 2 local photos on disk to build a collage (got ${candidates.length}). ` +
      "Pull photos into the gallery first, or pick two photos manually.",
    );
  }

  let pick: CollagePickIndices | null = null;
  let method: "vision" | "heuristic" | "manual" = "heuristic";

  // ── "pick manually" ────────────────────────────────────────────────────────
  // The operator already made the choice, so there is nothing to decide: no
  // vision call (no spend, no latency) and NO fallback. An unresolvable pick
  // throws — silently composing Claude's pair instead is the exact 2026-07-18
  // bug ("I selected the two photos … it reverted back to the collage that was
  // chosen by Claude AI").
  if (opts.forcedPick) {
    if (opts.requireVision) {
      throw new Error("A manually picked pair cannot satisfy a Claude-vision-required collage");
    }
    pick = resolveForcedCollagePick(candidates, opts.forcedPick);
    if (!pick) {
      throw new Error(
        "The two photos you picked could not be resolved to files on disk. " +
        "Re-open the picker and choose two different photos from this gallery.",
      );
    }
    method = "manual";
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const visionEnabled = !!apiKey && process.env.COVER_COLLAGE_VISION_DISABLED !== "1";
  if (opts.requireVision && !visionEnabled) {
    throw new Error(
      !apiKey
        ? "Claude cover selection requires ANTHROPIC_API_KEY"
        : "Claude cover selection is disabled by COVER_COLLAGE_VISION_DISABLED",
    );
  }

  if (!pick && visionEnabled) {
    try {
      pick = await visionPick(apiKey!, candidates, opts.requireVision === true);
      method = "vision";
    } catch (e: any) {
      if (opts.requireVision) {
        throw new Error(`Claude could not select the cover collage: ${e?.message ?? e}`);
      }
      console.warn(`[cover-collage] vision pick failed (falling back to caption heuristic): ${e?.message ?? e}`);
    }
  }
  if (!pick) {
    if (opts.requireVision) throw new Error("Claude did not return a usable cover-collage pair");
    pick = heuristicCollagePick(candidates);
    method = "heuristic";
  }
  if (!pick) throw new Error("Could not pick two photos for the collage");

  const left = candidates[pick.leftIndex];
  const right = candidates[pick.rightIndex];

  const [leftPanel, rightPanel] = await Promise.all([
    preparePanel(left, opts.upscale),
    preparePanel(right, opts.upscale),
  ]);

  // 2-up compose — mirrors the manual client canvas: two square panels on a
  // 1600×800 canvas with a thin translucent-white divider between them.
  const buffer = await sharp({
    create: {
      width: COLLAGE_WIDTH,
      height: COLLAGE_HEIGHT,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([
      { input: leftPanel, left: 0, top: 0 },
      { input: rightPanel, left: COLLAGE_PANEL_PX, top: 0 },
      {
        input: {
          create: {
            width: 2,
            height: COLLAGE_HEIGHT,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 0.6 },
          },
        },
        left: COLLAGE_PANEL_PX - 1,
        top: 0,
      },
    ])
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();

  const toPick = (c: ResolvedCandidate): CoverCollagePick => ({
    url: c.url,
    caption: c.caption ?? null,
    source: c.source ?? null,
  });

  return {
    buffer,
    left: toPick(left),
    right: toPick(right),
    method,
    reasoning: pick.reasoning,
    model: method === "vision" ? MODEL : null,
    candidateCount: candidates.length,
  };
}
