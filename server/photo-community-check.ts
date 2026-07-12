// Photo Community Check — operator-initiated QA for the photos tab.
//
// Answers three concrete questions with YES or NO (never "uncertain"):
//   1. Are ALL community-folder photos the same place, and does that place
//      match the expected community on the property record?
//   2. For each unit: is it in the SAME community as the community folder?
//      (Requires 5+ interior photos per unit; each photo is voted individually.)
//   3. Are Unit A and Unit B (etc.) in the same community as each other?
//
// Methodology:
//   Pass A — Community folder: Google Lens reverse-image search on EVERY
//            photo in the folder (up to cap), confirming each belongs to the
//            expected community or flagging mismatches (e.g. wrong resort pool).
//   Pass B — Unit verification: one vision call PER unit (up to 12 interior
//            photos each), 3 community anchors, unanimous match required.
//   Bedroom pass — bedroom-tagged photos first; if count is short, also scan
//            ambiguous captions (Den, Office, Loft, …) with vision confirmation.
//   Server-side rules convert votes into binary yes/no.

import fs from "fs";
import path from "path";
import { computeDhash, hammingDistance, DUPLICATE_DISTANCE } from "./photo-hashing";
import {
  UNIT_INTERIOR_MIN,
  canUpgradeWithProvenance,
  communityNamesMatch,
  computeUnitVerdict,
  filterUnitOutliers,
  isInteriorPhoto,
  pickInteriorPhotos,
  unitProvenanceFor,
} from "../shared/photo-community-check-logic";
import {
  type ListingBedroomCoverage,
} from "../shared/photo-bedroom-coverage-logic";
import { analyzeBedroomCoverage } from "./bedroom-coverage-engine";
import {
  detectLikelyMixedCommunityFolder,
} from "../shared/photo-community-folder-logic";
import {
  type CommunityPhotoOverallStatus,
  type CommunityPhotoSignal,
  overallStatusToVerdict,
} from "../shared/community-photo-verify-logic";
import {
  verifyCommunityPhotos,
  type CommunityPhotoSample,
} from "./community-photo-verify";
import { getSearchApiKey } from "./searchapi";
import { verifyUnitSourcePages } from "./source-page-community-check";
import {
  summarizeSourcePages,
  sourcePageIsStrongContradiction,
  type SourcePageVerdict,
} from "../shared/source-page-community-logic";

const MODEL = "claude-sonnet-4-6";

/** Max community photos to load and vision-audit per folder. */
const COMMUNITY_FULL_FOLDER_CAP = 50;
/**
 * Photos sampled per unit for the community-match pass. High enough to cover a
 * whole unit folder so EVERY interior photo gets a verdict badge (green ✓ /
 * red ✕ / amber ?), not just the first dozen. Sent to vision in batches.
 */
const UNIT_PHOTO_CAP = 60;
/** Unit photos per vision call (each batch also carries the community anchors). */
const UNIT_VISION_BATCH_SIZE = 9;
/** Concurrent unit vision batches (keeps latency down without flooding the API). */
const UNIT_VISION_CONCURRENCY = 3;
const COMMUNITY_ANCHOR_COUNT = 3;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ANTHROPIC_TIMEOUT_MS = 90_000;

const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif)$/i;

/** Kill switch for the source-page verification leg (photo legs still run). */
const SOURCE_PAGE_CHECK_DISABLED = process.env.SOURCE_PAGE_COMMUNITY_CHECK_DISABLED === "1";

export type CheckGroupInput = {
  role: "community" | "unit";
  label: string;
  folder: string;
  filenames?: string[];
  captions?: Record<string, string>;
  /** DB category per file (userCategory wins). */
  categories?: Record<string, string>;
  bedroomClusterIds?: Record<string, string>;
  bedroomBedTypes?: Record<string, string>;
  perceptualHashes?: Record<string, string>;
  expectedBedrooms?: number;
  /** Unit listing copy for bed-inventory parsing. */
  unitDescription?: string;
  expectedBedInventory?: string[];
  /**
   * The listing page this folder's photos were scraped from (Zillow / Redfin /
   * VRBO / Airbnb / Guesty). When present on a unit group, the check also verifies
   * the SOURCE PAGE names the expected community — an independent signal from the
   * photo (Lens/vision) legs. Absent → source-page leg skipped for this unit.
   */
  sourceUrl?: string;
  /**
   * PROVENANCE (chain of custody) — stamped by SERVER-side enrichment only
   * (enrichCheckGroupsWithProvenance; the route strips these off client-sent
   * groups so a browser can never assert them):
   *  - swapVerified: this folder's photos came from a COMMITTED unit
   *    replacement (unit_swaps row exists for the folder's unit) — the find
   *    flow community-gates candidates before they can be committed.
   *  - operatorVerified(+At): the operator pinned this folder's CURRENT
   *    published photo set as verified and the pin's fingerprint still matches
   *    (shared/photo-folder-verification.ts).
   * Provenance upgrades UNCERTAIN votes only — a positive "no" always wins.
   */
  swapVerified?: boolean;
  operatorVerified?: boolean;
  operatorVerifiedAt?: string;
};

export type PhotoCommunityCheckRequest = {
  /** When set, server uses the same request builder as bulk/dashboard checks and persists the result. */
  propertyId?: number;
  expectedCommunity?: string;
  /** Combined listing bedroom count (e.g. 6 for two 3BR units). */
  expectedListingBedrooms?: number;
  /**
   * Check ONLY the community folder photos (the preflight "are the current
   * community photos correct?" button). Unit groups are dropped and the result
   * is NOT persisted to the dashboard Community QA status.
   */
  communityOnly?: boolean;
  groups: CheckGroupInput[];
};

type FlaggedPhoto = { id: string; caption?: string; reason: string };

export type PhotoVerdict = {
  id: string;
  folder?: string;
  filename?: string;
  caption?: string;
  match: "yes" | "no" | "uncertain";
  reason: string;
  lensIdentifiedCommunity?: string;
  /** Multi-signal status (verified / likely / unconfirmed / mismatch). */
  status?: CommunityPhotoOverallStatus;
  confidenceScore?: number;
  signals?: CommunityPhotoSignal[];
};

export type CommunityGroupResult = {
  role: "community";
  label: string;
  folder: string;
  photosChecked: number;
  photosTotal: number;
  communityFingerprint: string;
  identifiedCommunity: string;
  matchesExpected: "yes" | "no";
  matchReason: string;
  allSameCommunity: boolean;
  photoVerdicts: PhotoVerdict[];
  outliers: FlaggedPhoto[];
  junk: FlaggedPhoto[];
  confidence: number;
  verificationMethod?: "google_lens" | "vision" | "google_lens+vision";
  overallStatus?: CommunityPhotoOverallStatus;
  confidenceScore?: number;
  recommendation?: string;
  signals?: CommunityPhotoSignal[];
};

export type UnitGroupResult = {
  role: "unit";
  label: string;
  folder: string;
  photosChecked: number;
  photosTotal: number;
  interiorPhotosChecked: number;
  sameAsCommunity: "yes" | "no";
  reason: string;
  photoVerdicts: PhotoVerdict[];
  allSameUnit: boolean;
  outliers: FlaggedPhoto[];
  junk: FlaggedPhoto[];
  confidence: number;
  /** True when provenance verified this unit (see provenanceReason for why). */
  provenanceVerified?: boolean;
  provenanceReason?: string;
};

export type DuplicateFinding = {
  scope: "cross-folder" | "within-folder";
  a: { folder: string; filename: string; id: string };
  b: { folder: string; filename: string; id: string };
  distance: number;
};

export type PhotoCommunityCheckResult = {
  ok: boolean;
  verdict: "pass" | "warn" | "fail";
  expectedCommunity: string;
  summary: string;
  concerns: string[];
  allSameCommunity: "yes" | "no";
  unitsSameCommunity: "yes" | "no" | "n/a";
  community: CommunityGroupResult | null;
  units: UnitGroupResult[];
  bedroomCoverage: ListingBedroomCoverage | null;
  duplicates: DuplicateFinding[];
  /** Per-unit source-listing-page community verdicts (empty when no URLs given). */
  sourcePages: SourcePageVerdict[];
  model: string;
  photosChecked: number;
  elapsedMs: number;
  warning?: string;
};

// Re-export pure helpers for callers/tests that import from the server module.
export {
  communityNamesMatch,
  computeUnitVerdict,
  isInteriorPhoto,
  pickInteriorPhotos,
  isStrongContradiction,
  communityOnlyCheckRequest,
  communityPhotosCorrectAnswer,
} from "../shared/photo-community-check-logic";

// ── Disk helpers ────────────────────────────────────────────────────────────

function publicPhotoDir(folder: string): string {
  const safe = folder.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return path.resolve(process.cwd(), "client/public/photos", safe);
}

function mimeForBuffer(buffer: Buffer, filename: string): string {
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  const head = buffer.slice(0, 6).toString("ascii");
  if (head.startsWith("GIF87") || head.startsWith("GIF89")) return "image/gif";
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

function evenSampleIndices(n: number, cap: number): number[] {
  if (n <= 0) return [];
  if (n <= cap) return Array.from({ length: n }, (_, i) => i);
  const out = new Set<number>();
  for (let i = 0; i < cap; i++) {
    out.add(Math.min(n - 1, Math.round((i * (n - 1)) / (cap - 1))));
  }
  return Array.from(out).sort((a, b) => a - b);
}

type SampledPhoto = {
  id: string;
  groupIdx: number;
  folder: string;
  filename: string;
  caption?: string;
  buffer: Buffer;
  mime: string;
  hash?: string;
  isInterior?: boolean;
};

type ResolvedGroup = {
  input: CheckGroupInput;
  total: number;
  sampled: SampledPhoto[];
  interiorSampled: number;
};

async function resolveGroupFiles(
  group: CheckGroupInput,
  cap: number,
  preferInterior: boolean,
): Promise<{ total: number; chosen: Array<{ filename: string; caption?: string }> }> {
  const dir = publicPhotoDir(group.folder);
  let diskFiles: string[] = [];
  try {
    diskFiles = (await fs.promises.readdir(dir)).filter((f) => IMAGE_EXT.test(f));
  } catch {
    return { total: 0, chosen: [] };
  }
  const diskSet = new Set(diskFiles);
  const requested = Array.isArray(group.filenames) && group.filenames.length > 0
    ? group.filenames.map((f) => path.basename(String(f))).filter((f) => IMAGE_EXT.test(f) && diskSet.has(f))
    : diskFiles.slice().sort();
  const ordered = Array.from(new Set(requested)).map((filename) => ({
    filename,
    caption: group.captions?.[filename],
  }));

  if (preferInterior) {
    const { chosen } = pickInteriorPhotos(ordered, cap);
    return { total: ordered.length, chosen };
  }

  const total = ordered.length;
  const idxs = evenSampleIndices(total, cap);
  return { total, chosen: idxs.map((i) => ordered[i]) };
}

async function resolveAllGroupFiles(
  group: CheckGroupInput,
  maxFiles: number,
): Promise<{ total: number; chosen: Array<{ filename: string; caption?: string }> }> {
  const dir = publicPhotoDir(group.folder);
  let diskFiles: string[] = [];
  try {
    diskFiles = (await fs.promises.readdir(dir)).filter((f) => IMAGE_EXT.test(f));
  } catch {
    return { total: 0, chosen: [] };
  }
  const diskSet = new Set(diskFiles);
  const requested = Array.isArray(group.filenames) && group.filenames.length > 0
    ? group.filenames.map((f) => path.basename(String(f))).filter((f) => IMAGE_EXT.test(f) && diskSet.has(f))
    : diskFiles.slice().sort();
  const ordered = Array.from(new Set(requested)).map((filename) => ({
    filename,
    caption: group.captions?.[filename],
  }));
  const total = ordered.length;
  return { total, chosen: ordered.slice(0, maxFiles) };
}

async function loadCommunityFolderPhotos(
  group: CheckGroupInput,
  groupIdx: number,
): Promise<{ total: number; sampled: SampledPhoto[] }> {
  const { total, chosen } = await resolveAllGroupFiles(group, COMMUNITY_FULL_FOLDER_CAP);
  const sampled = await loadSample(groupIdx, group.folder, "C", chosen);
  for (const s of sampled) {
    try {
      s.hash = await computeDhash(s.buffer);
    } catch {
      s.hash = undefined;
    }
  }
  return { total, sampled };
}

async function auditCommunityFolderFull(
  group: CheckGroupInput,
  samples: SampledPhoto[],
  photosTotal: number,
  expectedCommunity: string,
  anthropicApiKey: string,
): Promise<{ community: CommunityGroupResult | null; warning?: string }> {
  if (samples.length === 0) return { community: null };

  const preScreen = detectLikelyMixedCommunityFolder(
    samples.map((s) => s.hash).filter(Boolean) as string[],
  );

  const verifySamples: CommunityPhotoSample[] = samples.map((s) => ({
    id: s.id,
    folder: s.folder,
    filename: s.filename,
    caption: s.caption,
    buffer: s.buffer,
    mime: s.mime,
  }));

  const audit = await verifyCommunityPhotos(
    verifySamples,
    photosTotal,
    expectedCommunity,
    { label: group.label, folder: group.folder },
    { searchApiKey: getSearchApiKey(), anthropicApiKey },
  );

  if (!audit.community) return audit;

  if (preScreen.mixed && preScreen.reason) {
    audit.community.outliers.push({ id: "pre-screen", reason: preScreen.reason });
    // The dHash pre-screen flags a folder whose photos are visually DIVERSE. For a
    // real resort that is EXPECTED (pool + beach + grounds + lobby look nothing
    // alike), so it must NOT override a POSITIVE vision identification of the
    // expected community — doing so forced a self-contradicting "looks like X, not X"
    // skip (Kanaloa at Kona, bulk combo queue, 2026-06-26: vision said the folder IS
    // Kanaloa at Kona, the pre-screen flipped it to "mismatch", and the gate emitted
    // "looks like Kanaloa at Kona, not Kanaloa at Kona"). Only escalate the mix to a
    // hard mismatch when vision did NOT already confirm the expected community; when
    // it did, keep the positive verdict and leave the mix as an informational
    // outlier note.
    if (audit.community.matchesExpected !== "yes") {
      audit.community.allSameCommunity = false;
      audit.community.overallStatus = "mismatch";
    }
  }

  return audit;
}

async function loadSample(
  groupIdx: number,
  folder: string,
  idPrefix: string,
  files: Array<{ filename: string; caption?: string }>,
): Promise<SampledPhoto[]> {
  const dir = publicPhotoDir(folder);
  const out: SampledPhoto[] = [];
  let n = 0;
  for (const f of files) {
    n += 1;
    const abs = path.join(dir, f.filename);
    try {
      const buffer = await fs.promises.readFile(abs);
      if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) continue;
      out.push({
        id: `${idPrefix}${n}`,
        groupIdx,
        folder,
        filename: f.filename,
        caption: f.caption,
        buffer,
        mime: mimeForBuffer(buffer, f.filename),
        isInterior: isInteriorPhoto(f.caption),
      });
    } catch {
      // skip unreadable
    }
  }
  return out;
}

async function detectDuplicates(samples: SampledPhoto[]): Promise<DuplicateFinding[]> {
  for (const s of samples) {
    try {
      s.hash = await computeDhash(s.buffer);
    } catch {
      s.hash = undefined;
    }
  }
  const findings: DuplicateFinding[] = [];
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      const a = samples[i];
      const b = samples[j];
      if (!a.hash || !b.hash) continue;
      const distance = hammingDistance(a.hash, b.hash);
      if (distance > DUPLICATE_DISTANCE) continue;
      findings.push({
        scope: a.folder === b.folder ? "within-folder" : "cross-folder",
        a: { folder: a.folder, filename: a.filename, id: a.id },
        b: { folder: b.folder, filename: b.filename, id: b.id },
        distance,
      });
    }
  }
  findings.sort((x, y) => (x.scope === y.scope ? 0 : x.scope === "cross-folder" ? -1 : 1));
  return findings;
}

// ── Vision API ──────────────────────────────────────────────────────────────

async function callVisionJson(
  apiKey: string,
  content: any[],
): Promise<{ parsed: any; warning?: string }> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 3000,
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
  return { parsed: JSON.parse(match[0]) };
}

function buildSingleUnitPassInstruction(
  fingerprint: string,
  expectedCommunity: string,
  unitLabel: string,
  minInterior: number,
): string {
  return [
    "You are verifying ONE unit's interior photos belong to the SAME community as the community folder.",
    "",
    `Community visual fingerprint: ${fingerprint}`,
    expectedCommunity.trim() ? `Expected community: "${expectedCommunity.trim()}".` : "",
    "",
    `Unit: ${unitLabel}.`,
    "ANCHOR photos show the verified community. INTERIOR photos are from this unit's folder.",
    "",
    `For EACH unit interior photo (NOT anchors), vote match: "yes" or "no":`,
    "  - yes: finishes, window/lanai views, balcony railings, exterior glimpses, building style, landscaping visible outside are COMPATIBLE with the fingerprint.",
    "  - no: ONLY with POSITIVE contradiction — different resort signage/towels/keycards, incompatible climate/architecture/view that cannot be the same resort.",
    "",
    `Return a verdict for EVERY unit photo shown above (need at least ${minInterior} interior photos). Every interior photo must match for a pass.`,
    "Do NOT use uncertain/unclear — every match is yes or no.",
    "",
    "Outliers = photos that appear to be a DIFFERENT UNIT's interior (incompatible kitchen/bedroom/bath finishes vs the majority).",
    "DO NOT flag as outliers — resort pool, beach, grounds, building exterior, or lanai views showing community landscaping.",
    "",
    "Respond with ONLY minified JSON:",
    '{"photoVerdicts":[{"id":"U1-1","match":"yes|no","reason":"short"}],"allSameUnit":true,"outliers":[{"id":"U1-3","reason":"short"}],"junk":[]}',
  ].join("\n");
}

function asYesNo(v: unknown): "yes" | "no" {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "yes" || s === "true") return "yes";
  return "no";
}

function captionFor(samples: SampledPhoto[], id: string): string | undefined {
  return samples.find((s) => s.id === id)?.caption;
}

function sampleFor(samples: SampledPhoto[], id: string): SampledPhoto | undefined {
  return samples.find((s) => s.id === id);
}

/** Map a vision JSON row id back to a sampled photo (ordinal + caption fallbacks). */
function resolveSampleForVisionRow(
  id: string,
  rowIndex: number,
  samples: SampledPhoto[],
): SampledPhoto | undefined {
  const direct = sampleFor(samples, id);
  if (direct) return direct;

  const ordinal = id.match(/^U(\d+)-(\d+)$/i);
  if (ordinal) {
    const idx = Number(ordinal[2]) - 1;
    if (idx >= 0 && idx < samples.length) return samples[idx];
  }

  const idNorm = id.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (idNorm) {
    const captionHit = samples.find((s) => {
      const cap = (s.caption ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      return cap && (cap.includes(idNorm) || idNorm.includes(cap));
    });
    if (captionHit) return captionHit;
  }

  if (rowIndex >= 0 && rowIndex < samples.length) return samples[rowIndex];
  return undefined;
}

function mapPhotoVerdicts(v: unknown, samples: SampledPhoto[]): PhotoVerdict[] {
  if (!Array.isArray(v)) return [];
  const out: PhotoVerdict[] = [];
  for (let i = 0; i < v.length; i++) {
    const row = v[i];
    if (!row || typeof row !== "object") continue;
    const id = String((row as any).id ?? samples[i]?.id ?? "").trim();
    if (!id) continue;
    const sample = resolveSampleForVisionRow(id, i, samples);
    if (!sample) continue;
    out.push({
      id: sample.id,
      folder: sample.folder,
      filename: sample.filename,
      caption: sample.caption ?? captionFor(samples, id),
      match: asYesNo((row as any).match ?? (row as any).samePlace),
      reason: String((row as any).reason ?? "").trim() || "flagged",
    });
  }
  return out;
}

/**
 * Merge vision verdicts with every sampled photo so the UI badges every tile.
 * `coveredIds` (when given) is the set of photo ids a vision batch actually
 * looked at: a photo whose batch FAILED is marked "uncertain" (amber ?) rather
 * than silently defaulted to "yes", so a coverage gap never reads as a pass.
 * A photo the model simply did not vote on inside a successful batch stays "yes"
 * (compatible) — the prompt only emits "no" on a positive contradiction.
 */
function mergeUnitPhotoVerdicts(
  visionVerdicts: PhotoVerdict[],
  samples: SampledPhoto[],
  coveredIds?: Set<string>,
): PhotoVerdict[] {
  const byId = new Map(visionVerdicts.map((v) => [v.id, v]));
  return samples.map((s) => {
    const vision = byId.get(s.id);
    if (vision) {
      return {
        ...vision,
        folder: s.folder,
        filename: s.filename,
        caption: vision.caption ?? s.caption,
      };
    }
    if (coveredIds && !coveredIds.has(s.id)) {
      return {
        id: s.id,
        folder: s.folder,
        filename: s.filename,
        caption: s.caption,
        match: "uncertain" as const,
        reason: "Vision check did not return a verdict for this photo — review manually.",
      };
    }
    return {
      id: s.id,
      folder: s.folder,
      filename: s.filename,
      caption: s.caption,
      match: "yes" as const,
      reason: "No explicit vision vote — treated as compatible with the community.",
    };
  });
}

/** Run async tasks with a fixed concurrency limit, preserving result order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

function chunkSamples<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + size));
  return out;
}

async function verifyUnitAgainstCommunity(
  apiKey: string,
  r: ResolvedGroup,
  anchors: SampledPhoto[],
  fingerprint: string,
  expectedCommunity: string,
): Promise<UnitGroupResult> {
  // Batch the whole unit folder (not just the first dozen) so EVERY photo gets
  // a verdict badge. Each batch repeats the community anchors so it can judge
  // community-match independently; results are folded back together below.
  const batches = chunkSamples(r.sampled, UNIT_VISION_BATCH_SIZE);
  const batchResults = await mapWithConcurrency(batches, UNIT_VISION_CONCURRENCY, async (batch) => {
    const content: any[] = [];
    for (const a of anchors) {
      const cap = a.caption ? ` · caption: "${a.caption}"` : "";
      content.push({ type: "text", text: `--- ANCHOR community photo ${a.id}${cap} ---` });
      content.push({ type: "image", source: { type: "base64", media_type: a.mime, data: a.buffer.toString("base64") } });
    }
    content.push({
      type: "text",
      text: `=== UNIT: ${r.input.label} (${r.interiorSampled} interior-classified of ${r.sampled.length} total photos; this batch ${batch.length}) ===`,
    });
    for (const s of batch) {
      const cap = s.caption ? ` · caption: "${s.caption}"` : "";
      const kind = s.isInterior ? "INTERIOR" : "OTHER";
      content.push({ type: "text", text: `--- ${kind} photo ${s.id}${cap} ---` });
      content.push({ type: "image", source: { type: "base64", media_type: s.mime, data: s.buffer.toString("base64") } });
    }
    content.push({
      type: "text",
      text: buildSingleUnitPassInstruction(fingerprint, expectedCommunity, r.input.label, UNIT_INTERIOR_MIN),
    });
    try {
      const { parsed } = await callVisionJson(apiKey, content);
      const rawUnit = Array.isArray(parsed.units) ? parsed.units[0] : parsed;
      const rows = Array.isArray(rawUnit?.photoVerdicts)
        ? rawUnit.photoVerdicts
        : Array.isArray(parsed.photoVerdicts) ? parsed.photoVerdicts : [];
      return {
        ok: true,
        rows: rows as any[],
        outliers: Array.isArray(rawUnit?.outliers) ? (rawUnit.outliers as any[]) : [],
        junk: Array.isArray(rawUnit?.junk) ? (rawUnit.junk as any[]) : [],
        ids: batch.map((s) => s.id),
        error: undefined as string | undefined,
      };
    } catch (e: any) {
      return {
        ok: false,
        rows: [] as any[],
        outliers: [] as any[],
        junk: [] as any[],
        ids: batch.map((s) => s.id),
        error: e?.message ?? String(e),
      };
    }
  });

  const anyOk = batchResults.some((b) => b.ok);
  if (!anyOk) {
    throw new Error(batchResults.find((b) => !b.ok)?.error ?? "unit vision returned no verdicts");
  }

  // A photo counts as "covered" only if its batch succeeded AND returned at
  // least one verdict — a successful-but-empty batch did not actually judge its
  // photos, so they fall through to "uncertain" rather than a default green.
  const coveredIds = new Set<string>();
  for (const b of batchResults) if (b.ok && b.rows.length > 0) for (const id of b.ids) coveredIds.add(id);
  const verdictRows = batchResults.flatMap((b) => b.rows);
  const outlierRows = batchResults.flatMap((b) => b.outliers);
  const junkRows = batchResults.flatMap((b) => b.junk);

  const visionVerdicts = mapPhotoVerdicts(verdictRows, r.sampled);
  const photoVerdicts = mergeUnitPhotoVerdicts(visionVerdicts, r.sampled, coveredIds);
  // Decide same-community only on photos with a real yes/no vote — an
  // "uncertain" (failed-batch) photo must not count as a pass or a fail.
  const decisive = photoVerdicts
    .filter((p) => p.match === "yes" || p.match === "no")
    .map((p) => ({ match: p.match as "yes" | "no", reason: p.reason }));
  const computed = computeUnitVerdict(decisive, UNIT_INTERIOR_MIN);
  const outliers = filterUnitOutliers(asFlags(outlierRows, r.sampled));
  return {
    role: "unit",
    label: r.input.label,
    folder: r.input.folder,
    photosChecked: r.sampled.length,
    photosTotal: r.total,
    interiorPhotosChecked: r.interiorSampled,
    sameAsCommunity: computed.sameAsCommunity,
    reason: computed.reason,
    photoVerdicts,
    allSameUnit: outliers.length === 0,
    outliers,
    junk: asFlags(junkRows, r.sampled),
    confidence: computed.confidence,
  };
}

function asFlags(v: unknown, samples: SampledPhoto[]): FlaggedPhoto[] {
  if (!Array.isArray(v)) return [];
  const out: FlaggedPhoto[] = [];
  for (let i = 0; i < v.length; i++) {
    const row = v[i];
    if (!row || typeof row !== "object") continue;
    const id = String((row as any).id ?? "").trim();
    const reason = String((row as any).reason ?? "").trim();
    if (!id) continue;
    const sample = resolveSampleForVisionRow(id, i, samples);
    out.push({
      id: sample?.id ?? id,
      caption: sample?.caption ?? captionFor(samples, id),
      reason: reason || "flagged",
    });
  }
  return out;
}

function unitFailureVerdicts(samples: SampledPhoto[], reason: string): PhotoVerdict[] {
  return samples.map((s) => ({
    id: s.id,
    folder: s.folder,
    filename: s.filename,
    caption: s.caption,
    match: "uncertain" as const,
    reason: `Unit check failed: ${reason}`,
  }));
}

// ── Main entry ──────────────────────────────────────────────────────────────

export async function runPhotoCommunityCheck(
  request: PhotoCommunityCheckRequest,
  apiKey: string,
  startedAt: number,
): Promise<PhotoCommunityCheckResult> {
  const expectedCommunity = String(request.expectedCommunity ?? "").trim();
  const expectedListingBedrooms =
    typeof request.expectedListingBedrooms === "number" && request.expectedListingBedrooms > 0
      ? request.expectedListingBedrooms
      : null;
  const rawGroups = Array.isArray(request.groups) ? request.groups : [];
  const communityInputs = rawGroups.filter((g) => g?.role === "community" && g?.folder);
  const unitInputs = rawGroups.filter((g) => g?.role === "unit" && g?.folder);

  const resolved: ResolvedGroup[] = [];

  const communityByFolder = new Map<string, CheckGroupInput>();
  for (const g of communityInputs) {
    const prev = communityByFolder.get(g.folder);
    if (!prev) {
      communityByFolder.set(g.folder, { ...g, filenames: [...(g.filenames ?? [])], captions: { ...(g.captions ?? {}) } });
    } else {
      prev.filenames = Array.from(new Set([...(prev.filenames ?? []), ...(g.filenames ?? [])]));
      prev.captions = { ...(prev.captions ?? {}), ...(g.captions ?? {}) };
    }
  }

  let communityResolvedIdx = -1;
  for (const g of Array.from(communityByFolder.values())) {
    const { total, sampled } = await loadCommunityFolderPhotos(g, resolved.length);
    communityResolvedIdx = resolved.length;
    resolved.push({
      input: g,
      total,
      sampled,
      interiorSampled: sampled.filter((s) => s.isInterior).length,
    });
    break;
  }

  const unitResolvedIdxs: number[] = [];
  for (let u = 0; u < unitInputs.length; u++) {
    const g = unitInputs[u];
    const { total, chosen } = await resolveGroupFiles(g, UNIT_PHOTO_CAP, true);
    const sampled = await loadSample(resolved.length, g.folder, `U${u + 1}-`, chosen);
    unitResolvedIdxs.push(resolved.length);
    resolved.push({
      input: g,
      total,
      sampled,
      interiorSampled: sampled.filter((s) => s.isInterior).length,
    });
  }

  const allSamples = resolved.flatMap((r) => r.sampled);
  const photosChecked = allSamples.length;
  const duplicates = await detectDuplicates(allSamples);

  if (photosChecked === 0) {
    return {
      ok: false,
      verdict: "fail",
      expectedCommunity,
      summary: "No readable photos found. Re-scrape or attach photos, then run the check again.",
      concerns: ["No photos available to check."],
      allSameCommunity: "no",
      unitsSameCommunity: unitInputs.length >= 2 ? "no" : "n/a",
      community: null,
      units: [],
      bedroomCoverage: null,
      duplicates,
      sourcePages: [],
      model: "google_lens+claude",
      photosChecked: 0,
      elapsedMs: Date.now() - startedAt,
      warning: "no-photos",
    };
  }

  const searchApiKey = getSearchApiKey();
  const needsCommunityLens = communityResolvedIdx >= 0;
  const needsUnitVision = unitInputs.length > 0 || expectedListingBedrooms != null;

  if (needsCommunityLens && !searchApiKey) {
    return {
      ok: false,
      verdict: "fail",
      expectedCommunity,
      summary: "SEARCHAPI_API_KEY is required for community photo reverse-image search.",
      concerns: ["SEARCHAPI_API_KEY not configured."],
      allSameCommunity: "no",
      unitsSameCommunity: unitInputs.length >= 2 ? "no" : "n/a",
      community: null,
      units: [],
      bedroomCoverage: null,
      duplicates,
      sourcePages: [],
      model: "google_lens+claude",
      photosChecked,
      elapsedMs: Date.now() - startedAt,
      warning: "SEARCHAPI_API_KEY not configured",
    };
  }

  if (needsUnitVision && !apiKey) {
    return {
      ok: false,
      verdict: "fail",
      expectedCommunity,
      summary: "ANTHROPIC_API_KEY is required for photo community check.",
      concerns: ["ANTHROPIC_API_KEY not configured."],
      allSameCommunity: "no",
      unitsSameCommunity: unitInputs.length >= 2 ? "no" : "n/a",
      community: null,
      units: [],
      bedroomCoverage: null,
      duplicates,
      sourcePages: [],
      model: "google_lens+claude",
      photosChecked,
      elapsedMs: Date.now() - startedAt,
      warning: "ANTHROPIC_API_KEY not configured",
    };
  }

  let warning: string | undefined;
  let community: CommunityGroupResult | null = null;
  let units: UnitGroupResult[] = [];
  let fingerprint = "";

  // ── Pass A: Full community-folder audit (Google Lens per photo) ───────────
  if (communityResolvedIdx >= 0) {
    const r = resolved[communityResolvedIdx];
    const audit = await auditCommunityFolderFull(
      r.input,
      r.sampled,
      r.total,
      expectedCommunity,
      apiKey,
    );
    community = audit.community;
    if (audit.warning) warning = audit.warning;
    fingerprint = community?.communityFingerprint ?? "";
    if (!community && audit.warning) {
      // fall through — verdict synthesis will fail community checks
    }
  }

  // ── Pass B: Per-unit verification (one vision call each) ─────────────────
  if (unitResolvedIdxs.length > 0) {
    const communityGroup = communityResolvedIdx >= 0 ? resolved[communityResolvedIdx] : null;
    const anchors = communityGroup?.sampled.slice(0, COMMUNITY_ANCHOR_COUNT) ?? [];
    const fp = fingerprint || community?.communityFingerprint || expectedCommunity || "the community folder";

    for (const resolvedIdx of unitResolvedIdxs) {
      const r = resolved[resolvedIdx];
      try {
        units.push(await verifyUnitAgainstCommunity(apiKey, r, anchors, fp, expectedCommunity));
      } catch (e: any) {
        const errMsg = e?.message ?? String(e);
        warning = warning ? `${warning}; ${r.input.label}: ${errMsg}` : `${r.input.label} verification failed: ${errMsg}`;
        units.push({
          role: "unit" as const,
          label: r.input.label,
          folder: r.input.folder,
          photosChecked: r.sampled.length,
          photosTotal: r.total,
          interiorPhotosChecked: r.interiorSampled,
          sameAsCommunity: "no" as const,
          reason: errMsg,
          photoVerdicts: unitFailureVerdicts(r.sampled, errMsg),
          allSameUnit: true,
          outliers: [],
          junk: [],
          confidence: 0,
        });
      }
    }
  }

  // ── Bedroom coverage (all unit bedroom photos, dHash de-dupe) ─────────────
  let bedroomCoverage: ListingBedroomCoverage | null = null;
  if (unitInputs.length > 0) {
    try {
      bedroomCoverage = await analyzeBedroomCoverage(
        (content) => callVisionJson(apiKey, content),
        unitInputs,
        expectedListingBedrooms,
        apiKey,
      );
    } catch (e: any) {
      warning = warning
        ? `${warning}; bedroom coverage: ${e?.message ?? e}`
        : `Bedroom coverage failed: ${e?.message ?? e}`;
    }
  }

  // ── Source-page verification (independent of the Lens/vision photo legs) ──
  // For each unit that carries a source listing URL, confirm the page itself
  // names the expected community. Fail-soft: a blocked/JS-only/auth-gated page
  // resolves to "uncertain" and never fails the check.
  let sourcePages: SourcePageVerdict[] = [];
  const sourceUnitInputs = unitInputs
    .filter((g) => typeof g.sourceUrl === "string" && g.sourceUrl.trim().length > 0)
    .map((g) => ({ label: g.label, sourceUrl: g.sourceUrl }));
  if (sourceUnitInputs.length > 0 && apiKey && !SOURCE_PAGE_CHECK_DISABLED) {
    try {
      sourcePages = await verifyUnitSourcePages(sourceUnitInputs, expectedCommunity, apiKey);
    } catch (e: any) {
      warning = warning
        ? `${warning}; source-page: ${e?.message ?? e}`
        : `Source-page check failed: ${e?.message ?? e}`;
    }
  }

  // ── Provenance upgrade (chain of custody) ─────────────────────────────────
  // A unit whose photos can't all be confirmed ONLINE (Lens finds nothing for
  // an interior shot, a vision batch failed → uncertain votes, or too few
  // decisive votes for computeUnitVerdict's minimum) is NOT necessarily wrong.
  // When the gallery's ORIGIN is verified — the source page names the expected
  // community, the photos came from a committed community-gated swap, or the
  // operator pinned this exact photo set — upgrade the uncertain votes and the
  // unit verdict. canUpgradeWithProvenance blocks the upgrade whenever ANY
  // photo voted "no": provenance clears uncertainty, never masks a mismatch.
  for (const u of units) {
    const input = unitInputs.find((g) => g.label === u.label);
    const sp = sourcePages.find((s) => s.unitLabel === u.label);
    const provenance = unitProvenanceFor(input, sp?.match);
    if (!provenance) continue;
    if (!canUpgradeWithProvenance(u.photoVerdicts, provenance)) continue;
    let upgraded = 0;
    for (const p of u.photoVerdicts) {
      if (p.match !== "uncertain") continue;
      p.match = "yes";
      p.reason = `Verified by provenance — ${provenance.detail}.`;
      upgraded++;
    }
    const verdictFlipped = u.sameAsCommunity !== "yes";
    u.provenanceVerified = true;
    u.provenanceReason = provenance.detail;
    if (!verdictFlipped && upgraded === 0) continue; // already green — provenance is display-only
    u.sameAsCommunity = "yes";
    u.confidence = Math.max(u.confidence, 0.85);
    u.reason = upgraded > 0
      ? `Same community — ${provenance.detail}; ${upgraded} photo vote${upgraded === 1 ? "" : "s"} upgraded from uncertain.`
      : `Same community — ${provenance.detail}.`;
  }

  // ── Verdict synthesis ─────────────────────────────────────────────────────
  const concerns: string[] = [];
  let hasFail = false;
  let hasWarn = false;
  const fail = (msg: string) => { hasFail = true; concerns.push(msg); };
  const warn = (msg: string) => { hasWarn = true; concerns.push(msg); };

  if (!community && communityResolvedIdx >= 0) {
    fail("Could not analyze community folder photos.");
  }
  if (community) {
    const communityStatus = community.overallStatus;
    const communityHardFail = communityStatus === "mismatch"
      || (community.matchesExpected === "no" && communityStatus !== "unconfirmed" && communityStatus !== "likely");

    if (community.matchesExpected === "no" && communityHardFail) {
      fail(`Community photos do NOT match "${expectedCommunity || "expected community"}" (${community.identifiedCommunity}).`);
    } else if (community.matchesExpected === "no") {
      warn(`Community name match uncertain for "${expectedCommunity}". ${community.recommendation ?? community.matchReason}`);
    }

    if (!community.allSameCommunity || community.outliers.length > 0) {
      if (communityStatus === "mismatch" || community.outliers.some((o) => o.id !== "pre-screen")) {
        fail(`Community folder has ${community.outliers.length || "some"} photo(s) from a different place.`);
      } else if (community.outliers.length > 0) {
        warn(`Community folder: ${community.outliers.length} photo(s) flagged for review.`);
      }
    }

    if (communityStatus === "unconfirmed") {
      warn(community.recommendation ?? "Reverse image search could not confirm all community photos — manual review recommended.");
    } else if (communityStatus === "likely") {
      warn(community.recommendation ?? "Most community photos look consistent; some could not be confirmed online.");
    }
    if (community.photosTotal > community.photosChecked) {
      warn(`Community audit checked ${community.photosChecked}/${community.photosTotal} folder photos (cap ${COMMUNITY_FULL_FOLDER_CAP}).`);
    } else if (community.photosChecked > 0) {
      // full-folder audit completed
    }
    if (community.junk.length > 0) warn(`Community folder has ${community.junk.length} junk/mis-filed photo(s).`);
  }

  for (const u of units) {
    if (u.sameAsCommunity === "no") {
      fail(`${u.label}: NOT the same community — ${u.reason}`);
    }
    if (u.interiorPhotosChecked < UNIT_INTERIOR_MIN && !u.provenanceVerified) {
      // Provenance substitutes for sample size: the gallery's origin is
      // verified, so a small interior sample is not a review-worthy gap.
      warn(`${u.label}: only ${u.interiorPhotosChecked} interior-classified photos in sample (target ${UNIT_INTERIOR_MIN}+).`);
    }
    if (!u.allSameUnit || u.outliers.length > 0) warn(`${u.label} has photo(s) that may not be the same unit.`);
    if (u.junk.length > 0) warn(`${u.label} has ${u.junk.length} junk/mis-filed photo(s).`);
  }

  for (const sp of sourcePages) {
    if (sourcePageIsStrongContradiction(sp)) {
      const where = sp.identifiedCommunity || sp.identifiedLocation || "a different place";
      fail(`${sp.unitLabel}: source listing page is a DIFFERENT community (${where}) — ${sp.reason}`);
    } else if (sp.match === "no") {
      warn(`${sp.unitLabel}: source page may be a different community — ${sp.reason}`);
    }
  }

  if (bedroomCoverage) {
    const listingBedroomsPass =
      bedroomCoverage.expectedListingBedrooms != null
      && bedroomCoverage.expectedListingBedrooms > 0
      && bedroomCoverage.bedroomsFoundCombined >= bedroomCoverage.expectedListingBedrooms;
    for (const u of bedroomCoverage.units) {
      if (u.matchesListing === "no") {
        const msg = `${u.label}: bedroom photos ${u.bedroomsFound}/${u.expectedBedrooms ?? "?"} — ${u.reason}`;
        if (listingBedroomsPass) warn(msg);
        else fail(msg);
      } else if (u.bedroomsFound === 0 && u.expectedBedrooms) {
        warn(`${u.label}: no bedroom-tagged photos found (expected ${u.expectedBedrooms} bedrooms).`);
      }
    }
    if (bedroomCoverage.matchesListing === "no") {
      fail(`Listing bedroom photos: ${bedroomCoverage.bedroomsFoundCombined}/${bedroomCoverage.expectedListingBedrooms} — ${bedroomCoverage.reason}`);
    } else if (bedroomCoverage.tier === "warn") {
      warn(bedroomCoverage.reason);
      for (const u of bedroomCoverage.units) {
        if (u.tier === "warn") warn(`${u.label}: ${u.reason}`);
      }
    } else if (
      bedroomCoverage.expectedListingBedrooms != null
      && bedroomCoverage.bedroomsFoundCombined < bedroomCoverage.expectedListingBedrooms
    ) {
      warn(bedroomCoverage.reason);
    }
  }

  const crossDupes = duplicates.filter((d) => d.scope === "cross-folder");
  if (crossDupes.length > 0) warn(`${crossDupes.length} photo(s) appear in more than one folder.`);

  const allUnitsYes = units.length > 0 && units.every((u) => u.sameAsCommunity === "yes");
  const communityOk = !community || (
    community.overallStatus !== "mismatch"
    && community.allSameCommunity
    && (community.matchesExpected === "yes" || community.overallStatus === "likely" || community.overallStatus === "unconfirmed")
  );
  const allSameCommunity: "yes" | "no" = communityOk && allUnitsYes && units.length > 0 ? "yes"
    : communityOk && units.length === 0 ? (community?.overallStatus !== "mismatch" ? "yes" : "no")
    : "no";

  let unitsSameCommunity: "yes" | "no" | "n/a" = "n/a";
  if (units.length >= 2) {
    unitsSameCommunity = units.every((u) => u.sameAsCommunity === "yes") ? "yes" : "no";
    if (unitsSameCommunity === "no") {
      const bad = units.filter((u) => u.sameAsCommunity === "no").map((u) => u.label);
      fail(`Units are NOT all in the same community: ${bad.join(", ")}.`);
    }
  }

  if (allSameCommunity === "no" && !hasFail && community?.overallStatus === "unconfirmed") {
    // Unconfirmed alone is not a hard fail — surfaced as warn above.
  } else if (allSameCommunity === "no" && !hasFail) {
    warn("Photo sets could not be fully confirmed as the same community — review recommended.");
  }

  let verdict: "pass" | "warn" | "fail" = hasFail ? "fail" : hasWarn ? "warn" : "pass";
  if (!hasFail && community?.overallStatus && overallStatusToVerdict(community.overallStatus) === "warn" && verdict === "pass") {
    verdict = "warn";
  }

  const sourceRoll = summarizeSourcePages(sourcePages);
  const sourceHeadline = sourceRoll.matched > 0
    ? ` Source pages: ${sourceRoll.matched}/${sourcePages.length} confirm the community.`
    : "";
  let summary: string;
  const bedroomHeadline = bedroomCoverage?.expectedListingBedrooms
    ? ` Bedroom photos: ${bedroomCoverage.bedroomsFoundCombined}/${bedroomCoverage.expectedListingBedrooms}.`
    : bedroomCoverage && bedroomCoverage.bedroomsFoundCombined > 0
    ? ` ${bedroomCoverage.bedroomsFoundCombined} distinct bedroom(s) detected across units.`
    : "";
  if (verdict === "pass") {
    summary = units.length >= 2
      ? `Confirmed: community folder and all ${units.length} units are the same community (${expectedCommunity || community?.identifiedCommunity || "verified"}).${bedroomHeadline}${sourceHeadline}`
      : units.length === 1
      ? `Confirmed: community folder and unit photos are the same community.${bedroomHeadline}${sourceHeadline}`
      : `Confirmed: the community folder photos are ${expectedCommunity || community?.identifiedCommunity || "the expected community"}.${bedroomHeadline}${sourceHeadline}`;
  } else if (hasFail) {
    summary = bedroomCoverage?.matchesListing === "no"
      ? `Problem found — bedroom photo coverage is incomplete (${bedroomCoverage.bedroomsFoundCombined}/${bedroomCoverage.expectedListingBedrooms} listing bedrooms). Review details below.`
      : community?.overallStatus === "mismatch"
      ? "Mismatch — one or more community photos appear to be from a different place. Review details below."
      : "Problem found — one or more photo sets are NOT the same community. Review details below.";
  } else if (community?.overallStatus === "unconfirmed") {
    summary = community.recommendation ?? `Community photos unconfirmed — manual review recommended for ${expectedCommunity || "this community"}.`;
  } else if (community?.overallStatus === "likely") {
    summary = community.recommendation ?? `Likely match — most community photos appear consistent with ${expectedCommunity || "the expected community"}.`;
  } else {
    summary = `Passed core community check with minor warnings — review flagged items.${bedroomHeadline}`;
  }

  return {
    ok: !warning || verdict !== "fail",
    verdict,
    expectedCommunity,
    summary,
    concerns: Array.from(new Set(concerns)).slice(0, 15),
    allSameCommunity,
    unitsSameCommunity,
    community,
    units,
    bedroomCoverage,
    duplicates,
    sourcePages,
    model: "google_lens+claude",
    photosChecked,
    elapsedMs: Date.now() - startedAt,
    warning,
  };
}
