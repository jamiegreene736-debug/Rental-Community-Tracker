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
//   Pass A — Community folder: dHash pre-screen + batched vision audit of
//            EVERY photo in the folder (up to cap), not a one-time sample.
//   Pass B — Unit verification: one vision call PER unit (up to 12 interior
//            photos each), 3 community anchors, unanimous match required.
//   Bedroom pass — all bedroom-tagged unit photos, dHash de-dupe, vision on
//            distinct rooms.
//   Server-side rules convert votes into binary yes/no.

import fs from "fs";
import path from "path";
import { computeDhash, hammingDistance, DUPLICATE_DISTANCE } from "./photo-hashing";
import {
  UNIT_INTERIOR_MIN,
  communityNamesMatch,
  computeCommunityCohesion,
  computeUnitVerdict,
  filterUnitOutliers,
  isInteriorPhoto,
  pickInteriorPhotos,
} from "../shared/photo-community-check-logic";
import {
  clusterBedroomPhotosByHash,
  computeListingBedroomCoverage,
  computeUnitBedroomCoverage,
  isBedroomPhotoCaption,
  parseExpectedBedroomsFromLabel,
  summarizeBedroomCluster,
  type ListingBedroomCoverage,
} from "../shared/photo-bedroom-coverage-logic";
import {
  chunkArray,
  detectLikelyMixedCommunityFolder,
  mergeCommunityPhotoVerdicts,
} from "../shared/photo-community-folder-logic";

const MODEL = "claude-sonnet-4-6";

/** Max community photos to load and vision-audit per folder. */
const COMMUNITY_FULL_FOLDER_CAP = 50;
const COMMUNITY_BATCH_SIZE = 10;
/** Interior photos sent to vision per unit (each unit gets its own call). */
const UNIT_INTERIOR_TARGET = 12;
const COMMUNITY_ANCHOR_COUNT = 3;
const BEDROOM_FOLDER_CAP = 150;
const BEDROOM_VISION_MAX = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ANTHROPIC_TIMEOUT_MS = 90_000;

const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif)$/i;

export type CheckGroupInput = {
  role: "community" | "unit";
  label: string;
  folder: string;
  filenames?: string[];
  captions?: Record<string, string>;
  expectedBedrooms?: number;
};

export type PhotoCommunityCheckRequest = {
  expectedCommunity?: string;
  /** Combined listing bedroom count (e.g. 6 for two 3BR units). */
  expectedListingBedrooms?: number;
  groups: CheckGroupInput[];
};

type FlaggedPhoto = { id: string; caption?: string; reason: string };

export type PhotoVerdict = {
  id: string;
  caption?: string;
  match: "yes" | "no";
  reason: string;
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

function buildCommunityBatchInstruction(
  fingerprint: string,
  expectedCommunity: string,
  batchIndex: number,
  batchCount: number,
): string {
  return [
    `Continuing FULL community-folder audit (batch ${batchIndex + 1}/${batchCount}).`,
    `Community fingerprint from earlier batches: ${fingerprint || "(see anchor batches)"}`,
    expectedCommunity.trim() ? `Expected community on record: "${expectedCommunity.trim()}".` : "",
    "",
    "For EACH photo ID in THIS batch, decide whether it depicts the SAME resort/community as the fingerprint.",
    '  - match: "yes" if clearly the same place; "no" ONLY with positive evidence of a different place.',
    "Do NOT use uncertain — every match is yes or no.",
    "Flag junk: floorplans, maps, logos, screenshots, competitor watermarks.",
    "",
    'Respond with ONLY minified JSON: {"photoVerdicts":[{"id":"C11","match":"yes|no","reason":"short"}],"junk":[{"id":"C11","reason":"short"}]}',
  ].join("\n");
}

function ensureVerdictsForAllPhotos(
  samples: SampledPhoto[],
  verdicts: PhotoVerdict[],
): PhotoVerdict[] {
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  const out = [...verdicts];
  for (const s of samples) {
    if (!byId.has(s.id)) {
      out.push({
        id: s.id,
        caption: s.caption,
        match: "no",
        reason: "Photo was not evaluated by vision audit.",
      });
    }
  }
  return out;
}

async function auditCommunityFolderFull(
  apiKey: string,
  group: CheckGroupInput,
  samples: SampledPhoto[],
  photosTotal: number,
  expectedCommunity: string,
): Promise<{ community: CommunityGroupResult | null; warning?: string }> {
  if (samples.length === 0) return { community: null };

  const preScreen = detectLikelyMixedCommunityFolder(
    samples.map((s) => s.hash).filter(Boolean) as string[],
  );
  const batches = chunkArray(samples, COMMUNITY_BATCH_SIZE);
  let fingerprint = "";
  let identifiedName = "";
  let matchesExpected: "yes" | "no" = "no";
  let matchReason = "";
  let confidence = 0.5;
  const verdictBatches: PhotoVerdict[][] = [];
  const junkCollected: FlaggedPhoto[] = [];

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const content: any[] = [];
    for (const s of batch) {
      const cap = s.caption ? ` · caption: "${s.caption}"` : "";
      content.push({ type: "text", text: `--- COMMUNITY photo ${s.id}${cap} ---` });
      content.push({ type: "image", source: { type: "base64", media_type: s.mime, data: s.buffer.toString("base64") } });
    }
    content.push({
      type: "text",
      text: bi === 0
        ? buildCommunityPassInstruction(expectedCommunity)
        : buildCommunityBatchInstruction(fingerprint, expectedCommunity, bi, batches.length),
    });

    try {
      const { parsed } = await callVisionJson(apiKey, content);
      if (bi === 0) {
        fingerprint = String(parsed.fingerprint ?? "").trim();
        identifiedName = String(parsed.identifiedName ?? "").trim();
        matchesExpected = asYesNo(parsed.matchesExpected);
        if (expectedCommunity && identifiedName && communityNamesMatch(identifiedName, expectedCommunity)) {
          matchesExpected = "yes";
        }
        matchReason = String(parsed.matchReason ?? "").trim();
        confidence = asConfidence(parsed.confidence);
        if (!fingerprint && identifiedName) fingerprint = identifiedName;
      } else if (!fingerprint) {
        fingerprint = expectedCommunity ? `Expected: ${expectedCommunity}` : "Community place profile";
      }
      verdictBatches.push(mapPhotoVerdicts(parsed.photoVerdicts, batch));
      junkCollected.push(...asFlags(parsed.junk, batch));
    } catch (e: any) {
      return { community: null, warning: `Community audit batch ${bi + 1}/${batches.length} failed: ${e?.message ?? e}` };
    }
  }

  const mergedVerdicts = ensureVerdictsForAllPhotos(
    samples,
    mergeCommunityPhotoVerdicts(verdictBatches),
  );
  const { allSameCommunity, outliers: cohesionOutliers } = computeCommunityCohesion(mergedVerdicts);
  const preScreenOutliers: FlaggedPhoto[] = preScreen.mixed && preScreen.reason
    ? [{ id: "pre-screen", reason: preScreen.reason }]
    : [];
  const junk = junkCollected.filter(
    (j, i, arr) => arr.findIndex((x) => x.id === j.id) === i,
  );
  const outliers = [...cohesionOutliers, ...preScreenOutliers].filter(
    (o, i, arr) => arr.findIndex((x) => x.id === o.id) === i,
  );

  return {
    community: {
      role: "community",
      label: group.label,
      folder: group.folder,
      photosChecked: samples.length,
      photosTotal,
      communityFingerprint: fingerprint || identifiedName || "Community place profile",
      identifiedCommunity: identifiedName || fingerprint.slice(0, 120) || "See fingerprint",
      matchesExpected,
      matchReason,
      allSameCommunity: allSameCommunity && outliers.length === 0,
      photoVerdicts: mergedVerdicts,
      outliers,
      junk,
      confidence,
    },
  };
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

function buildCommunityPassInstruction(expectedCommunity: string): string {
  const expected = expectedCommunity.trim() || "(not provided)";
  return [
    "You are QA-reviewing the COMMUNITY photo folder for a vacation-rental listing.",
    "These photos should ALL depict the SAME resort/community (amenities, grounds, exteriors, views).",
    "",
    `Expected community name on the property record: "${expected}".`,
    "",
    "For EACH photo (by ID), decide:",
    '  - samePlace: "yes" if this photo is clearly the same resort/community as the majority; "no" ONLY with positive contradictory evidence (different resort signage, incompatible architecture/climate/view).',
    "Build a detailed visual fingerprint of the place (architecture, materials, landscaping, climate, views, building style).",
    "",
    `matchesExpected: "yes" if the photos positively depict "${expected}" OR a clearly matching sub-name/alias; "no" ONLY if positive evidence of a DIFFERENT named resort.`,
    "Do NOT use uncertain/unclear — every field is yes or no.",
    "",
    "Flag junk: floorplans, maps, logos, screenshots, competitor watermarks, person-as-subject.",
    "",
    "Respond with ONLY minified JSON:",
    '{"fingerprint":"detailed place description","identifiedName":"resort name if readable else short place-type description","matchesExpected":"yes|no","matchReason":"short","photoVerdicts":[{"id":"C1","match":"yes|no","reason":"short"}],"junk":[{"id":"C5","reason":"short"}],"confidence":0.0}',
  ].join("\n");
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
    `Return verdicts for at least ${minInterior} interior photos. Every interior photo must match for a pass.`,
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

function asConfidence(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
}

function captionFor(samples: SampledPhoto[], id: string): string | undefined {
  return samples.find((s) => s.id === id)?.caption;
}

function mapPhotoVerdicts(v: unknown, samples: SampledPhoto[]): PhotoVerdict[] {
  if (!Array.isArray(v)) return [];
  const out: PhotoVerdict[] = [];
  for (const row of v) {
    if (!row || typeof row !== "object") continue;
    const id = String((row as any).id ?? "").trim();
    if (!id) continue;
    out.push({
      id,
      caption: captionFor(samples, id),
      match: asYesNo((row as any).match ?? (row as any).samePlace),
      reason: String((row as any).reason ?? "").trim() || "flagged",
    });
  }
  return out;
}

async function verifyUnitAgainstCommunity(
  apiKey: string,
  r: ResolvedGroup,
  anchors: SampledPhoto[],
  fingerprint: string,
  expectedCommunity: string,
): Promise<UnitGroupResult> {
  const content: any[] = [];
  for (const a of anchors) {
    const cap = a.caption ? ` · caption: "${a.caption}"` : "";
    content.push({ type: "text", text: `--- ANCHOR community photo ${a.id}${cap} ---` });
    content.push({ type: "image", source: { type: "base64", media_type: a.mime, data: a.buffer.toString("base64") } });
  }
  content.push({
    type: "text",
    text: `=== UNIT: ${r.input.label} (${r.interiorSampled} interior-classified of ${r.sampled.length} photos) ===`,
  });
  for (const s of r.sampled) {
    const cap = s.caption ? ` · caption: "${s.caption}"` : "";
    const kind = s.isInterior ? "INTERIOR" : "OTHER";
    content.push({ type: "text", text: `--- ${kind} photo ${s.id}${cap} ---` });
    content.push({ type: "image", source: { type: "base64", media_type: s.mime, data: s.buffer.toString("base64") } });
  }
  content.push({
    type: "text",
    text: buildSingleUnitPassInstruction(fingerprint, expectedCommunity, r.input.label, UNIT_INTERIOR_MIN),
  });

  const { parsed } = await callVisionJson(apiKey, content);
  const rawUnit = Array.isArray(parsed.units) ? parsed.units[0] : parsed;
  const photoVerdicts = mapPhotoVerdicts(rawUnit?.photoVerdicts ?? parsed.photoVerdicts, r.sampled);
  const interiorVerdicts = photoVerdicts.length > 0
    ? photoVerdicts
    : r.sampled.map((s) => ({
        id: s.id,
        caption: s.caption,
        match: "no" as const,
        reason: "No vision verdict returned for this photo.",
      }));
  const computed = computeUnitVerdict(
    interiorVerdicts.map((p) => ({ match: p.match, reason: p.reason })),
    UNIT_INTERIOR_MIN,
  );
  const outliers = filterUnitOutliers(asFlags(rawUnit?.outliers, r.sampled));
  return {
    role: "unit",
    label: r.input.label,
    folder: r.input.folder,
    photosChecked: r.sampled.length,
    photosTotal: r.total,
    interiorPhotosChecked: r.interiorSampled,
    sameAsCommunity: computed.sameAsCommunity,
    reason: computed.reason,
    photoVerdicts: interiorVerdicts,
    allSameUnit: outliers.length === 0,
    outliers,
    junk: asFlags(rawUnit?.junk, r.sampled),
    confidence: computed.confidence,
  };
}

function asFlags(v: unknown, samples: SampledPhoto[]): FlaggedPhoto[] {
  if (!Array.isArray(v)) return [];
  const out: FlaggedPhoto[] = [];
  for (const row of v) {
    if (!row || typeof row !== "object") continue;
    const id = String((row as any).id ?? "").trim();
    const reason = String((row as any).reason ?? "").trim();
    if (!id) continue;
    out.push({ id, caption: captionFor(samples, id), reason: reason || "flagged" });
  }
  return out;
}

type BedroomPhotoSample = {
  id: string;
  filename: string;
  caption?: string;
  buffer: Buffer;
  mime: string;
  hash?: string;
};

function pickClusterRepresentative(cluster: BedroomPhotoSample[]): BedroomPhotoSample {
  const nonAlt = cluster.find((p) => !/alt view/i.test(p.caption ?? ""));
  return nonAlt ?? cluster[0];
}

function buildBedroomVisionInstruction(unitLabel: string): string {
  return [
    `You are identifying DISTINCT BEDROOMS in unit photos for "${unitLabel}".`,
    "Each photo ID is ONE representative shot of a visually distinct bedroom.",
    "Multiple angles of the SAME room were already merged — treat each ID as a separate room.",
    "",
    "For EACH photo ID, return:",
    '  - bedDescription: concise bedding summary (e.g. "Two Twin Beds", "King Bed", "Queen Bed + Bunk").',
    '  - isBedroom: "yes" if this is clearly a bedroom; "no" if mislabeled (living room, office, etc.).',
    "",
    "Respond with ONLY minified JSON:",
    '{"rooms":[{"id":"BR1","bedDescription":"Two Twin Beds","isBedroom":"yes"}]}',
  ].join("\n");
}

async function visionBedroomDescriptions(
  apiKey: string,
  unitLabel: string,
  representatives: BedroomPhotoSample[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!apiKey || representatives.length === 0) return out;
  const content: any[] = [];
  for (const s of representatives) {
    const cap = s.caption ? ` · caption: "${s.caption}"` : "";
    content.push({ type: "text", text: `--- BEDROOM representative ${s.id}${cap} ---` });
    content.push({ type: "image", source: { type: "base64", media_type: s.mime, data: s.buffer.toString("base64") } });
  }
  content.push({ type: "text", text: buildBedroomVisionInstruction(unitLabel) });
  try {
    const { parsed } = await callVisionJson(apiKey, content);
    const rows = Array.isArray(parsed.rooms) ? parsed.rooms : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const id = String((row as any).id ?? "").trim();
      if (!id) continue;
      if (asYesNo((row as any).isBedroom) === "no") continue;
      const desc = String((row as any).bedDescription ?? "").trim();
      if (desc) out.set(id, desc);
    }
  } catch {
    // caption-only fallback
  }
  return out;
}

async function loadBedroomPhotosForUnit(
  group: CheckGroupInput,
  idPrefix: string,
): Promise<BedroomPhotoSample[]> {
  const { chosen } = await resolveGroupFiles(group, BEDROOM_FOLDER_CAP, false);
  const bedroomFiles = chosen.filter((f) => isBedroomPhotoCaption(f.caption));
  const dir = publicPhotoDir(group.folder);
  const out: BedroomPhotoSample[] = [];
  let n = 0;
  for (const f of bedroomFiles) {
    n += 1;
    const abs = path.join(dir, f.filename);
    try {
      const buffer = await fs.promises.readFile(abs);
      if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) continue;
      out.push({
        id: `${idPrefix}${n}`,
        filename: f.filename,
        caption: f.caption,
        buffer,
        mime: mimeForBuffer(buffer, f.filename),
      });
    } catch {
      // skip unreadable
    }
  }
  for (const s of out) {
    try {
      s.hash = await computeDhash(s.buffer);
    } catch {
      s.hash = undefined;
    }
  }
  return out;
}

async function analyzeBedroomCoverage(
  apiKey: string,
  unitInputs: CheckGroupInput[],
  expectedListingBedrooms: number | null,
): Promise<ListingBedroomCoverage> {
  const unitResults = [];
  for (let u = 0; u < unitInputs.length; u++) {
    const g = unitInputs[u];
    const samples = await loadBedroomPhotosForUnit(g, `BR${u + 1}-`);
    const clusters = clusterBedroomPhotosByHash(samples);
    const representatives = clusters.map(pickClusterRepresentative).slice(0, BEDROOM_VISION_MAX);
    const visionDesc = await visionBedroomDescriptions(apiKey, g.label, representatives);
    const rooms = clusters.map((cluster, i) => {
      const rep = pickClusterRepresentative(cluster);
      return summarizeBedroomCluster(cluster, i, visionDesc.get(rep.id));
    });
    const expected =
      typeof g.expectedBedrooms === "number" && g.expectedBedrooms > 0
        ? g.expectedBedrooms
        : parseExpectedBedroomsFromLabel(g.label);
    unitResults.push(computeUnitBedroomCoverage(g.label, g.folder, rooms, expected));
  }
  return computeListingBedroomCoverage(unitResults, expectedListingBedrooms);
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
    const { total, chosen } = await resolveGroupFiles(g, UNIT_INTERIOR_TARGET, true);
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
      model: MODEL,
      photosChecked: 0,
      elapsedMs: Date.now() - startedAt,
      warning: "no-photos",
    };
  }

  if (!apiKey) {
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
      model: MODEL,
      photosChecked,
      elapsedMs: Date.now() - startedAt,
      warning: "ANTHROPIC_API_KEY not configured",
    };
  }

  let warning: string | undefined;
  let community: CommunityGroupResult | null = null;
  let units: UnitGroupResult[] = [];
  let fingerprint = "";

  // ── Pass A: Full community-folder audit (batched vision) ─────────────────
  if (communityResolvedIdx >= 0) {
    const r = resolved[communityResolvedIdx];
    const audit = await auditCommunityFolderFull(
      apiKey,
      r.input,
      r.sampled,
      r.total,
      expectedCommunity,
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
          photoVerdicts: [],
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
      bedroomCoverage = await analyzeBedroomCoverage(apiKey, unitInputs, expectedListingBedrooms);
    } catch (e: any) {
      warning = warning
        ? `${warning}; bedroom coverage: ${e?.message ?? e}`
        : `Bedroom coverage failed: ${e?.message ?? e}`;
    }
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
    if (community.matchesExpected === "no") {
      fail(`Community photos do NOT match "${expectedCommunity || "expected community"}" (${community.identifiedCommunity}).`);
    }
    if (!community.allSameCommunity || community.outliers.length > 0) {
      fail(`Community folder has ${community.outliers.length || "some"} photo(s) from a different place.`);
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
    if (u.interiorPhotosChecked < UNIT_INTERIOR_MIN) {
      warn(`${u.label}: only ${u.interiorPhotosChecked} interior-classified photos in sample (target ${UNIT_INTERIOR_MIN}+).`);
    }
    if (!u.allSameUnit || u.outliers.length > 0) warn(`${u.label} has photo(s) that may not be the same unit.`);
    if (u.junk.length > 0) warn(`${u.label} has ${u.junk.length} junk/mis-filed photo(s).`);
  }

  if (bedroomCoverage) {
    for (const u of bedroomCoverage.units) {
      if (u.matchesListing === "no") {
        fail(`${u.label}: bedroom photos ${u.bedroomsFound}/${u.expectedBedrooms ?? "?"} — ${u.reason}`);
      } else if (u.bedroomsFound === 0 && u.expectedBedrooms) {
        warn(`${u.label}: no bedroom-tagged photos found (expected ${u.expectedBedrooms} bedrooms).`);
      }
    }
    if (bedroomCoverage.matchesListing === "no") {
      fail(`Listing bedroom photos: ${bedroomCoverage.bedroomsFoundCombined}/${bedroomCoverage.expectedListingBedrooms} — ${bedroomCoverage.reason}`);
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
  const communityOk = !community || (community.matchesExpected === "yes" && community.allSameCommunity);
  const allSameCommunity: "yes" | "no" = communityOk && allUnitsYes && units.length > 0 ? "yes"
    : communityOk && units.length === 0 ? (community?.matchesExpected === "yes" && community.allSameCommunity ? "yes" : "no")
    : "no";

  let unitsSameCommunity: "yes" | "no" | "n/a" = "n/a";
  if (units.length >= 2) {
    unitsSameCommunity = units.every((u) => u.sameAsCommunity === "yes") ? "yes" : "no";
    if (unitsSameCommunity === "no") {
      const bad = units.filter((u) => u.sameAsCommunity === "no").map((u) => u.label);
      fail(`Units are NOT all in the same community: ${bad.join(", ")}.`);
    }
  }

  if (allSameCommunity === "no" && !hasFail) {
    fail("Photo sets do not all belong to the same community.");
  }

  const verdict: "pass" | "warn" | "fail" = hasFail ? "fail" : hasWarn ? "warn" : "pass";

  let summary: string;
  const bedroomHeadline = bedroomCoverage?.expectedListingBedrooms
    ? ` Bedroom photos: ${bedroomCoverage.bedroomsFoundCombined}/${bedroomCoverage.expectedListingBedrooms}.`
    : bedroomCoverage && bedroomCoverage.bedroomsFoundCombined > 0
    ? ` ${bedroomCoverage.bedroomsFoundCombined} distinct bedroom(s) detected across units.`
    : "";
  if (verdict === "pass") {
    summary = units.length >= 2
      ? `Confirmed: community folder and all ${units.length} units are the same community (${expectedCommunity || community?.identifiedCommunity || "verified"}).${bedroomHeadline}`
      : `Confirmed: community folder and unit photos are the same community.${bedroomHeadline}`;
  } else if (hasFail) {
    summary = bedroomCoverage?.matchesListing === "no"
      ? `Problem found — bedroom photo coverage is incomplete (${bedroomCoverage.bedroomsFoundCombined}/${bedroomCoverage.expectedListingBedrooms} listing bedrooms). Review details below.`
      : "Problem found — one or more photo sets are NOT the same community. Review details below.";
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
    model: MODEL,
    photosChecked,
    elapsedMs: Date.now() - startedAt,
    warning,
  };
}
