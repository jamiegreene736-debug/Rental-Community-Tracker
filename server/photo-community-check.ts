// Photo Community Check — operator-initiated QA for the photos tab.
//
// Answers three concrete questions with YES or NO (never "uncertain"):
//   1. Are ALL community-folder photos the same place, and does that place
//      match the expected community on the property record?
//   2. For each unit: is it in the SAME community as the community folder?
//      (Requires 5+ interior photos per unit; each photo is voted individually.)
//   3. Are Unit A and Unit B (etc.) in the same community as each other?
//
// Methodology (two vision passes + deterministic aggregation):
//   Pass A — Community profile: sample up to 12 community photos, build a
//            visual fingerprint, per-photo same-place votes, junk/outlier flags.
//   Pass B — Unit verification: for each unit, sample 5–8 INTERIOR photos
//            (prioritized by label/category), include 2 community anchor
//            photos, vote each interior photo against the fingerprint.
//   Server-side rules convert votes into binary yes/no — the model cannot
//            leave a unit as "unclear".
//
// Extras: cross-folder duplicate detection via perceptual hash (deterministic).

import fs from "fs";
import path from "path";
import { computeDhash, hammingDistance, DUPLICATE_DISTANCE } from "./photo-hashing";
import {
  UNIT_INTERIOR_MIN,
  communityNamesMatch,
  computeCommunityCohesion,
  computeUnitVerdict,
  isInteriorPhoto,
  pickInteriorPhotos,
} from "../shared/photo-community-check-logic";

const MODEL = "claude-sonnet-4-6";

const COMMUNITY_SAMPLE_CAP = 12;
const UNIT_INTERIOR_TARGET = 8;
const COMMUNITY_ANCHOR_COUNT = 2;
const TOTAL_IMAGE_CAP = 32;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ANTHROPIC_TIMEOUT_MS = 90_000;

const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif)$/i;

export type CheckGroupInput = {
  role: "community" | "unit";
  label: string;
  folder: string;
  filenames?: string[];
  captions?: Record<string, string>;
};

export type PhotoCommunityCheckRequest = {
  expectedCommunity?: string;
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

function buildUnitPassInstruction(
  fingerprint: string,
  expectedCommunity: string,
  unitLabels: string[],
  minInterior: number,
): string {
  return [
    "You are verifying UNIT interior photos belong to the SAME community as the community folder.",
    "",
    `Community visual fingerprint: ${fingerprint}`,
    expectedCommunity.trim() ? `Expected community: "${expectedCommunity.trim()}".` : "",
    "",
    "Each unit section has INTERIOR photos (bedrooms, kitchen, living, bath, private lanai) plus reference community anchor photos labeled ANCHOR.",
    "",
    `For EACH unit interior photo (NOT anchors), vote match: "yes" or "no":`,
    "  - yes: finishes, window/lanai views, balcony railings, exterior glimpses, building style, landscaping visible outside are COMPATIBLE with the fingerprint.",
    "  - no: ONLY with POSITIVE contradiction — different resort signage/towels/keycards, incompatible climate/architecture/view that cannot be the same resort.",
    "",
    `Units (in order): ${unitLabels.join(" | ") || "none"}.`,
    `Each unit MUST have at least ${minInterior} interior photo verdicts.`,
    "Do NOT use uncertain/unclear — every match is yes or no.",
    "",
    "Also flag junk and photos that look like a different unit within the same community (outliers).",
    "",
    "Respond with ONLY minified JSON:",
    '{"units":[{"group":"unit label","photoVerdicts":[{"id":"U1-1","match":"yes|no","reason":"short"}],"allSameUnit":true,"outliers":[{"id":"U1-3","reason":"short"}],"junk":[]}]}',
    "Return units in the SAME ORDER as listed.",
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

// ── Main entry ──────────────────────────────────────────────────────────────

export async function runPhotoCommunityCheck(
  request: PhotoCommunityCheckRequest,
  apiKey: string,
  startedAt: number,
): Promise<PhotoCommunityCheckResult> {
  const expectedCommunity = String(request.expectedCommunity ?? "").trim();
  const rawGroups = Array.isArray(request.groups) ? request.groups : [];
  const communityInputs = rawGroups.filter((g) => g?.role === "community" && g?.folder);
  const unitInputs = rawGroups.filter((g) => g?.role === "unit" && g?.folder);

  const resolved: ResolvedGroup[] = [];
  let budget = TOTAL_IMAGE_CAP;

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
    const cap = Math.min(COMMUNITY_SAMPLE_CAP, budget);
    const { total, chosen } = await resolveGroupFiles(g, cap, false);
    const sampled = await loadSample(resolved.length, g.folder, "C", chosen);
    budget -= sampled.length;
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
    const remainingUnits = unitInputs.length - u;
    const fairShare = Math.max(UNIT_INTERIOR_TARGET, Math.floor(budget / remainingUnits));
    const cap = Math.min(UNIT_INTERIOR_TARGET, fairShare, budget);
    if (cap <= 0) break;
    const g = unitInputs[u];
    const { total, chosen } = await resolveGroupFiles(g, cap, true);
    const sampled = await loadSample(resolved.length, g.folder, `U${u + 1}-`, chosen);
    budget -= sampled.length;
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

  // ── Pass A: Community profile ─────────────────────────────────────────────
  if (communityResolvedIdx >= 0) {
    const r = resolved[communityResolvedIdx];
    const contentA: any[] = [];
    for (const s of r.sampled) {
      const cap = s.caption ? ` · caption: "${s.caption}"` : "";
      contentA.push({ type: "text", text: `--- COMMUNITY photo ${s.id}${cap} ---` });
      contentA.push({ type: "image", source: { type: "base64", media_type: s.mime, data: s.buffer.toString("base64") } });
    }
    contentA.push({ type: "text", text: buildCommunityPassInstruction(expectedCommunity) });

    try {
      const { parsed } = await callVisionJson(apiKey, contentA);
      fingerprint = String(parsed.fingerprint ?? "").trim();
      const identifiedName = String(parsed.identifiedName ?? "").trim();
      let matchesExpected = asYesNo(parsed.matchesExpected);
      if (expectedCommunity && identifiedName && communityNamesMatch(identifiedName, expectedCommunity)) {
        matchesExpected = "yes";
      }
      const photoVerdicts = mapPhotoVerdicts(parsed.photoVerdicts, r.sampled);
      const { allSameCommunity, outliers: cohesionOutliers } = computeCommunityCohesion(photoVerdicts);
      const modelOutliers = asFlags(parsed.outliers, r.sampled);
      const outliers = [...cohesionOutliers, ...modelOutliers].filter(
        (o, i, arr) => arr.findIndex((x) => x.id === o.id) === i,
      );

      community = {
        role: "community",
        label: r.input.label,
        folder: r.input.folder,
        photosChecked: r.sampled.length,
        photosTotal: r.total,
        communityFingerprint: fingerprint || identifiedName || "Community place profile",
        identifiedCommunity: identifiedName || fingerprint.slice(0, 120) || "See fingerprint",
        matchesExpected,
        matchReason: String(parsed.matchReason ?? "").trim(),
        allSameCommunity: allSameCommunity && outliers.length === 0,
        photoVerdicts,
        outliers,
        junk: asFlags(parsed.junk, r.sampled),
        confidence: asConfidence(parsed.confidence),
      };
    } catch (e: any) {
      warning = `Community pass failed: ${e?.message ?? e}`;
      fingerprint = expectedCommunity ? `Expected: ${expectedCommunity}` : "Community photos (analysis failed)";
    }
  }

  // ── Pass B: Unit verification ─────────────────────────────────────────────
  if (unitResolvedIdxs.length > 0) {
    const contentB: any[] = [];
    const communityGroup = communityResolvedIdx >= 0 ? resolved[communityResolvedIdx] : null;
    const anchors = communityGroup?.sampled.slice(0, COMMUNITY_ANCHOR_COUNT) ?? [];

    for (const a of anchors) {
      const cap = a.caption ? ` · caption: "${a.caption}"` : "";
      contentB.push({ type: "text", text: `--- ANCHOR community photo ${a.id}${cap} ---` });
      contentB.push({ type: "image", source: { type: "base64", media_type: a.mime, data: a.buffer.toString("base64") } });
    }

    const unitLabels: string[] = [];
    for (let i = 0; i < unitResolvedIdxs.length; i++) {
      const r = resolved[unitResolvedIdxs[i]];
      unitLabels.push(r.input.label);
      contentB.push({ type: "text", text: `=== UNIT GROUP: ${r.input.label} (${r.interiorSampled} interior-classified of ${r.sampled.length} photos) ===` });
      for (const s of r.sampled) {
        const cap = s.caption ? ` · caption: "${s.caption}"` : "";
        const kind = s.isInterior ? "INTERIOR" : "OTHER";
        contentB.push({ type: "text", text: `--- ${kind} photo ${s.id}${cap} ---` });
        contentB.push({ type: "image", source: { type: "base64", media_type: s.mime, data: s.buffer.toString("base64") } });
      }
    }

    contentB.push({
      type: "text",
      text: buildUnitPassInstruction(
        fingerprint || community?.communityFingerprint || expectedCommunity || "the community folder",
        expectedCommunity,
        unitLabels,
        UNIT_INTERIOR_MIN,
      ),
    });

    try {
      const { parsed } = await callVisionJson(apiKey, contentB);
      const visionUnits = Array.isArray(parsed.units) ? parsed.units : [];
      units = unitResolvedIdxs.map((resolvedIdx, i) => {
        const r = resolved[resolvedIdx];
        const u = visionUnits[i] ?? {};
        const photoVerdicts = mapPhotoVerdicts(u.photoVerdicts, r.sampled);
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
        return {
          role: "unit" as const,
          label: r.input.label,
          folder: r.input.folder,
          photosChecked: r.sampled.length,
          photosTotal: r.total,
          interiorPhotosChecked: r.interiorSampled,
          sameAsCommunity: computed.sameAsCommunity,
          reason: computed.reason,
          photoVerdicts: interiorVerdicts,
          allSameUnit: u.allSameUnit !== false,
          outliers: asFlags(u.outliers, r.sampled),
          junk: asFlags(u.junk, r.sampled),
          confidence: computed.confidence,
        };
      });
    } catch (e: any) {
      warning = warning ? `${warning}; unit pass: ${e?.message ?? e}` : `Unit pass failed: ${e?.message ?? e}`;
      units = unitResolvedIdxs.map((resolvedIdx) => {
        const r = resolved[resolvedIdx];
        return {
          role: "unit" as const,
          label: r.input.label,
          folder: r.input.folder,
          photosChecked: r.sampled.length,
          photosTotal: r.total,
          interiorPhotosChecked: r.interiorSampled,
          sameAsCommunity: "no" as const,
          reason: warning ?? "Unit verification failed.",
          photoVerdicts: [],
          allSameUnit: true,
          outliers: [],
          junk: [],
          confidence: 0,
        };
      });
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
  if (verdict === "pass") {
    summary = units.length >= 2
      ? `Confirmed: community folder and all ${units.length} units are the same community (${expectedCommunity || community?.identifiedCommunity || "verified"}).`
      : `Confirmed: community folder and unit photos are the same community.`;
  } else if (hasFail) {
    summary = "Problem found — one or more photo sets are NOT the same community. Review details below.";
  } else {
    summary = "Passed core community check with minor warnings — review flagged items.";
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
    duplicates,
    model: MODEL,
    photosChecked,
    elapsedMs: Date.now() - startedAt,
    warning,
  };
}
