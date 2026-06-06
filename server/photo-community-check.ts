// Photo Community Check — operator-initiated QA for the photos tab.
//
// A combo listing is built by stitching a COMMUNITY photo set (shared resort
// amenities, grounds, building exteriors, views) together with one or more
// UNIT photo sets (interiors of specific units). Every set MUST be from the
// SAME resort/community, or the published listing shows a guest amenity photos
// from one resort and unit photos from another. This module is the check that
// catches that class of mistake before the operator pushes to Guesty.
//
// What it answers (the operator's literal questions):
//   1. What community do the community-folder photos depict, and do they match
//      the expected community name on the property record?
//   2. Are ALL the community photos of that one community (no outlier from a
//      different resort)?
//   3. For each unit (Unit A / Unit B / …): what community is it in, and is it
//      the SAME community as the community photos?
//
// Extras we add on top (the "anything else" the operator asked for):
//   - Mis-filed / junk photo flags (floorplan, map, logo, screenshot, a photo
//     whose subject is a person, visible competitor watermark/branding).
//   - Cross-folder duplicate detection via perceptual hash — the same image
//     filed into two folders (a community photo accidentally dropped into a
//     unit folder, or a Unit-A photo reused in Unit B) is a strong "mixed up"
//     signal and is deterministic, so we compute it server-side rather than
//     asking the vision model.
//   - An overall pass / warn / fail verdict + a plain-English summary.
//
// Engine: a SINGLE Claude vision call with every sampled photo inlined and
// delimited by text markers, so the model can make the cross-folder
// "same community?" judgment holistically (it sees community + all units at
// once). Reading happens straight off the Railway photo volume
// (client/public/photos/<folder>) the same way photo-listing-scanner does.
//
// Cost/latency: ~1 vision call over up to ~24 images on Sonnet ≈ $0.10 and
// 20-40s wall-clock. This is a deliberate, operator-clicked action, not a
// background sweep, so the spend is acceptable per click.

import fs from "fs";
import path from "path";
import { computeDhash, hammingDistance, DUPLICATE_DISTANCE } from "./photo-hashing";

// Sonnet (not Haiku) on purpose: this is a reasoning-heavy visual comparison
// across folders + world knowledge of named resorts, not the short
// noun-phrase classification photo-labeler.ts does. Haiku over-flags here.
const MODEL = "claude-sonnet-4-6";

// Per-folder sample caps. Community gets a bigger budget because catching an
// outlier amenity photo from a different resort is the whole point and more
// coverage = better recall. Total is hard-capped so a 5-unit property can't
// blow the image budget / latency.
const COMMUNITY_SAMPLE_CAP = 10;
const UNIT_SAMPLE_CAP = 6;
const TOTAL_IMAGE_CAP = 24;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Anthropic per-image base64 limit.
const ANTHROPIC_TIMEOUT_MS = 90_000;

const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif)$/i;

export type CheckGroupInput = {
  role: "community" | "unit";
  // Operator-facing label as shown in the photos tab, e.g.
  // "Community — Regency at Poipu Kai" or "Unit A (3BR)".
  label: string;
  folder: string;
  // The curated/visible filenames the operator will actually push. When empty
  // we fall back to listing the folder on disk.
  filenames?: string[];
  // Optional per-file captions (auto-labels) for readable outlier reporting.
  captions?: Record<string, string>;
};

export type PhotoCommunityCheckRequest = {
  expectedCommunity?: string;
  groups: CheckGroupInput[];
};

type FlaggedPhoto = { id: string; caption?: string; reason: string };

export type CommunityGroupResult = {
  role: "community";
  label: string;
  folder: string;
  photosChecked: number;
  photosTotal: number;
  identifiedCommunity: string;
  matchesExpected: "yes" | "no" | "uncertain";
  matchReason: string;
  allSameCommunity: boolean;
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
  identifiedCommunity: string;
  sameAsCommunity: "yes" | "no" | "uncertain";
  reason: string;
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
  allSameCommunity: "yes" | "no" | "uncertain";
  community: CommunityGroupResult | null;
  units: UnitGroupResult[];
  duplicates: DuplicateFinding[];
  model: string;
  photosChecked: number;
  elapsedMs: number;
  warning?: string;
};

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

// Spread `cap` sample indices evenly across `n` items so an outlier in the
// middle/end of a big folder still gets seen (vs. just taking the first N).
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
  id: string;        // stable display id, e.g. "C1" or "U1-3"
  groupIdx: number;  // index into the resolved groups array
  folder: string;
  filename: string;
  caption?: string;
  buffer: Buffer;
  mime: string;
  hash?: string;
};

type ResolvedGroup = {
  input: CheckGroupInput;
  total: number;        // total curated photos requested for this folder
  sampled: SampledPhoto[];
};

// Pick the disk files for a group: intersect the operator's curated filenames
// with what's actually on the volume (dedupe, sanitize against traversal),
// then even-sample down to the cap.
async function resolveGroupFiles(
  group: CheckGroupInput,
  cap: number,
): Promise<{ total: number; chosen: Array<{ filename: string; caption?: string }> }> {
  const dir = publicPhotoDir(group.folder);
  let diskFiles: string[] = [];
  try {
    diskFiles = (await fs.promises.readdir(dir)).filter((f) => IMAGE_EXT.test(f));
  } catch {
    return { total: 0, chosen: [] };
  }
  const diskSet = new Set(diskFiles);

  // Curated filenames, sanitized to a bare basename and intersected with disk.
  const requested = Array.isArray(group.filenames) && group.filenames.length > 0
    ? group.filenames.map((f) => path.basename(String(f))).filter((f) => IMAGE_EXT.test(f) && diskSet.has(f))
    : diskFiles.slice().sort();

  // Dedupe while preserving order.
  const ordered = Array.from(new Set(requested));
  const total = ordered.length;
  const idxs = evenSampleIndices(total, cap);
  const chosen = idxs.map((i) => ({
    filename: ordered[i],
    caption: group.captions?.[ordered[i]],
  }));
  return { total, chosen };
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
      });
    } catch {
      // Unreadable file — skip, never fail the whole check.
    }
  }
  return out;
}

// ── Cross/within-folder duplicate detection (deterministic) ─────────────────

async function detectDuplicates(samples: SampledPhoto[]): Promise<DuplicateFinding[]> {
  // Best-effort: compute a perceptual hash per sample, swallow per-image
  // errors. Bounded O(n²) over ≤ TOTAL_IMAGE_CAP samples.
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
  // Cross-folder dupes first — they're the "mixed up" signal that matters most.
  findings.sort((x, y) => (x.scope === y.scope ? 0 : x.scope === "cross-folder" ? -1 : 1));
  return findings;
}

// ── Vision prompt ───────────────────────────────────────────────────────────

function buildInstruction(expectedCommunity: string, unitLabels: string[]): string {
  const expected = expectedCommunity.trim() || "(not provided)";
  return [
    "You are a meticulous QA reviewer for a vacation-rental listing builder.",
    "An operator builds ONE listing by combining a COMMUNITY photo set (shared resort amenities, grounds, pools, building exteriors, beach access, views) with one or more UNIT photo sets (interiors and private lanais/balconies of specific units).",
    "ALL of these photo sets are supposed to be from the SAME resort/community. Your job is to catch any photo SET — or any individual photo — that is from a DIFFERENT community, or that is junk.",
    "",
    `The property record says the expected community is: "${expected}".`,
    "",
    "The photos are provided below. Each is preceded by a text marker giving its GROUP, a stable ID (e.g. C1, U1-3), and its current caption. Reference photos by that ID.",
    "",
    "Judge carefully and avoid false alarms:",
    "- UNIT photos are interiors; COMMUNITY photos are outdoor amenities. They naturally look different. Do NOT call a unit a different community just because it's an interior.",
    "- Base any cross-community 'no' on a POSITIVE contradiction: a different named resort visible on signage/towels/keycards, a clearly different region or climate (e.g. tropical vs. alpine), an incompatible building type (oceanfront high-rise vs. low-rise garden condo) or view (ocean vs. cityscape) that cannot be the same resort, or a distinctly different architectural style/era/materials.",
    "- Generic photos that COULD be the expected community but lack proof are 'uncertain', NOT 'no'.",
    "- For matchesExpected: 'yes' = positive evidence it IS the expected community; 'no' = positive evidence it is a DIFFERENT community; 'uncertain' = plausible but unproven.",
    "",
    "For the COMMUNITY set: identify what resort/community/region the photos depict (read signage, architecture, landscape, landmarks; if you cannot name it, describe the place type and use 'unclear'); decide matchesExpected; decide whether ALL community photos are the same community and list any outlier IDs; flag junk.",
    `For EACH UNIT set (in order: ${unitLabels.map((l, i) => `unit ${i + 1} = "${l}"`).join(", ") || "none"}): say what community/region it appears to be in; decide sameAsCommunity (is it the SAME community as the community photos?) using finishes, window/lanai views, balcony railings, landscaping visible outside, building style; decide whether all photos are the same unit and list outliers; flag junk.`,
    "Junk = floorplans, maps, logos/branding tiles, screenshots, images whose main subject is a person's face, or any visible COMPETITOR watermark/branding (Airbnb/Vrbo/Booking/another property manager).",
    "",
    "Respond with ONLY a single minified JSON object — no prose, no code fences — matching this shape exactly:",
    '{"community":{"identified":"string","matchesExpected":"yes|no|uncertain","matchReason":"short string","allSameCommunity":true,"outliers":[{"id":"C3","reason":"string"}],"junk":[{"id":"C5","reason":"string"}],"confidence":0.0},"units":[{"group":"echo the unit label","identified":"string","sameAsCommunity":"yes|no|uncertain","reason":"short string","allSameUnit":true,"outliers":[{"id":"U1-2","reason":"string"}],"junk":[],"confidence":0.0}],"overall":{"allSameCommunity":"yes|no|uncertain","summary":"1-3 sentence operator-facing summary","concerns":["short string"]}}',
    "Return units in the SAME ORDER the unit groups were presented. If there is no community set, set community to null and judge whether the unit sets are mutually the same community.",
  ].join("\n");
}

type VisionJson = {
  community?: {
    identified?: unknown;
    matchesExpected?: unknown;
    matchReason?: unknown;
    allSameCommunity?: unknown;
    outliers?: unknown;
    junk?: unknown;
    confidence?: unknown;
  } | null;
  units?: Array<{
    group?: unknown;
    identified?: unknown;
    sameAsCommunity?: unknown;
    reason?: unknown;
    allSameUnit?: unknown;
    outliers?: unknown;
    junk?: unknown;
    confidence?: unknown;
  }>;
  overall?: { allSameCommunity?: unknown; summary?: unknown; concerns?: unknown };
};

function asTriState(v: unknown): "yes" | "no" | "uncertain" {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "yes" || s === "true") return "yes";
  if (s === "no" || s === "false") return "no";
  return "uncertain";
}

function asConfidence(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
}

function captionFor(samples: SampledPhoto[], id: string): string | undefined {
  return samples.find((s) => s.id === id)?.caption;
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

  // Resolve community group(s) and unit groups. There should be exactly one
  // community folder, but we tolerate zero or many.
  const communityInputs = rawGroups.filter((g) => g?.role === "community" && g?.folder);
  const unitInputs = rawGroups.filter((g) => g?.role === "unit" && g?.folder);

  // Build the resolved/sampled set under the global image budget: community
  // first, then units round-robin so no single unit starves the others.
  const resolved: ResolvedGroup[] = [];
  let budget = TOTAL_IMAGE_CAP;

  // Community (collapse multiple community entries that share a folder — the
  // builder interleaves community photos so the same folder can appear twice).
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
    const { total, chosen } = await resolveGroupFiles(g, cap);
    const sampled = await loadSample(resolved.length, g.folder, "C", chosen);
    budget -= sampled.length;
    communityResolvedIdx = resolved.length;
    resolved.push({ input: g, total, sampled });
    break; // only the first community folder is the canonical one
  }

  // Units — give each a fair share of the remaining budget.
  const unitResolvedIdxs: number[] = [];
  for (let u = 0; u < unitInputs.length; u++) {
    const remainingUnits = unitInputs.length - u;
    const fairShare = Math.max(1, Math.floor(budget / remainingUnits));
    const cap = Math.min(UNIT_SAMPLE_CAP, fairShare, budget);
    if (cap <= 0) break;
    const g = unitInputs[u];
    const idPrefix = `U${u + 1}-`;
    const { total, chosen } = await resolveGroupFiles(g, cap);
    const sampled = await loadSample(resolved.length, g.folder, idPrefix, chosen);
    budget -= sampled.length;
    unitResolvedIdxs.push(resolved.length);
    resolved.push({ input: g, total, sampled });
  }

  const allSamples = resolved.flatMap((r) => r.sampled);
  const photosChecked = allSamples.length;

  // Duplicate detection is deterministic and independent of the vision call —
  // run it regardless (even if the API key is missing).
  const duplicates = await detectDuplicates(allSamples);

  // Nothing readable on disk → bail with a clear message rather than calling
  // the model on an empty payload.
  if (photosChecked === 0) {
    return {
      ok: false,
      verdict: "warn",
      expectedCommunity,
      summary: "No readable photos were found on disk for the selected folders. Re-scrape or re-attach photos, then run the check again.",
      concerns: ["No photos available to check."],
      allSameCommunity: "uncertain",
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
      verdict: "warn",
      expectedCommunity,
      summary: "Photo community check needs ANTHROPIC_API_KEY to analyze the photos. Duplicate detection still ran.",
      concerns: ["ANTHROPIC_API_KEY not configured."],
      allSameCommunity: "uncertain",
      community: null,
      units: [],
      duplicates,
      model: MODEL,
      photosChecked,
      elapsedMs: Date.now() - startedAt,
      warning: "ANTHROPIC_API_KEY not configured",
    };
  }

  // Build the multimodal content: marker text + image per sample, then the
  // instruction block last.
  const content: any[] = [];
  for (const r of resolved) {
    for (const s of r.sampled) {
      const cap = s.caption ? ` · caption: "${s.caption}"` : "";
      content.push({ type: "text", text: `--- GROUP: ${r.input.label} · photo ${s.id}${cap} ---` });
      content.push({ type: "image", source: { type: "base64", media_type: s.mime, data: s.buffer.toString("base64") } });
    }
  }
  const unitLabels = unitResolvedIdxs.map((i) => resolved[i].input.label);
  content.push({ type: "text", text: buildInstruction(expectedCommunity, unitLabels) });

  let parsed: VisionJson | null = null;
  let warning: string | undefined;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
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
    parsed = JSON.parse(match[0]) as VisionJson;
  } catch (e: any) {
    warning = e?.message ?? String(e);
  }

  if (!parsed) {
    return {
      ok: false,
      verdict: "warn",
      expectedCommunity,
      summary: `Could not analyze the photos: ${warning ?? "unknown error"}. Duplicate detection still ran — review any duplicates below and try again.`,
      concerns: [warning ? `Vision error: ${warning}` : "Vision analysis failed."],
      allSameCommunity: "uncertain",
      community: null,
      units: [],
      duplicates,
      model: MODEL,
      photosChecked,
      elapsedMs: Date.now() - startedAt,
      warning,
    };
  }

  // Map the vision JSON onto our typed result.
  let community: CommunityGroupResult | null = null;
  if (communityResolvedIdx >= 0 && parsed.community) {
    const r = resolved[communityResolvedIdx];
    const c = parsed.community;
    community = {
      role: "community",
      label: r.input.label,
      folder: r.input.folder,
      photosChecked: r.sampled.length,
      photosTotal: r.total,
      identifiedCommunity: String(c.identified ?? "").trim() || "unclear",
      matchesExpected: asTriState(c.matchesExpected),
      matchReason: String(c.matchReason ?? "").trim(),
      allSameCommunity: c.allSameCommunity !== false,
      outliers: asFlags(c.outliers, r.sampled),
      junk: asFlags(c.junk, r.sampled),
      confidence: asConfidence(c.confidence),
    };
  } else if (communityResolvedIdx >= 0) {
    // We had a community folder but the model returned null for it.
    const r = resolved[communityResolvedIdx];
    community = {
      role: "community",
      label: r.input.label,
      folder: r.input.folder,
      photosChecked: r.sampled.length,
      photosTotal: r.total,
      identifiedCommunity: "unclear",
      matchesExpected: "uncertain",
      matchReason: "Model did not return a community assessment.",
      allSameCommunity: true,
      outliers: [],
      junk: [],
      confidence: 0.3,
    };
  }

  const visionUnits = Array.isArray(parsed.units) ? parsed.units : [];
  const units: UnitGroupResult[] = unitResolvedIdxs.map((resolvedIdx, i) => {
    const r = resolved[resolvedIdx];
    const u = visionUnits[i] ?? {};
    return {
      role: "unit",
      label: r.input.label,
      folder: r.input.folder,
      photosChecked: r.sampled.length,
      photosTotal: r.total,
      identifiedCommunity: String(u.identified ?? "").trim() || "unclear",
      sameAsCommunity: asTriState(u.sameAsCommunity),
      reason: String(u.reason ?? "").trim(),
      allSameUnit: u.allSameUnit !== false,
      outliers: asFlags(u.outliers, r.sampled),
      junk: asFlags(u.junk, r.sampled),
      confidence: asConfidence(u.confidence),
    };
  });

  const overallSame = asTriState(parsed.overall?.allSameCommunity);
  const modelConcerns = Array.isArray(parsed.overall?.concerns)
    ? (parsed.overall!.concerns as unknown[]).map((c) => String(c).trim()).filter(Boolean)
    : [];

  // ── Verdict synthesis (deterministic, never trusts the model's vibe) ──────
  // Accumulate into booleans rather than mutating a `verdict` literal through
  // closures — TS would otherwise narrow `verdict` to "pass" and flag the later
  // comparisons as impossible.
  const concerns: string[] = [...modelConcerns];
  let hasFail = false;
  let hasWarn = false;
  const fail = (msg: string) => { hasFail = true; concerns.push(msg); };
  const warn = (msg: string) => { hasWarn = true; concerns.push(msg); };

  if (community) {
    if (community.matchesExpected === "no") fail(`Community photos appear to be a DIFFERENT community than "${expectedCommunity || "expected"}" (identified: ${community.identifiedCommunity}).`);
    else if (community.matchesExpected === "uncertain") warn(`Could not positively confirm the community photos are "${expectedCommunity || "the expected community"}".`);
    if (!community.allSameCommunity || community.outliers.length > 0) warn(`Community folder has ${community.outliers.length || "some"} photo(s) that may be from a different place.`);
    if (community.junk.length > 0) warn(`Community folder has ${community.junk.length} junk/mis-filed photo(s).`);
  }
  for (const u of units) {
    if (u.sameAsCommunity === "no") fail(`${u.label} appears to be a DIFFERENT community than the community photos (identified: ${u.identifiedCommunity}).`);
    else if (u.sameAsCommunity === "uncertain") warn(`Could not confirm ${u.label} is the same community as the community photos.`);
    if (!u.allSameUnit || u.outliers.length > 0) warn(`${u.label} has photo(s) that may not be the same unit.`);
    if (u.junk.length > 0) warn(`${u.label} has ${u.junk.length} junk/mis-filed photo(s).`);
  }
  const crossDupes = duplicates.filter((d) => d.scope === "cross-folder");
  if (crossDupes.length > 0) warn(`${crossDupes.length} photo(s) appear in more than one folder — a photo may be filed under the wrong unit/community.`);
  if (overallSame === "no" && !hasFail) fail("The photo sets do not all appear to be from the same community.");

  const verdict: "pass" | "warn" | "fail" = hasFail ? "fail" : hasWarn ? "warn" : "pass";
  const summary = String(parsed.overall?.summary ?? "").trim()
    || (verdict === "pass"
      ? "All photo sets appear to be from the same community."
      : "Review the flagged items below before pushing these photos.");

  return {
    ok: true,
    verdict,
    expectedCommunity,
    summary,
    concerns: Array.from(new Set(concerns)).slice(0, 12),
    allSameCommunity: overallSame,
    community,
    units,
    duplicates,
    model: MODEL,
    photosChecked,
    elapsedMs: Date.now() - startedAt,
    warning,
  };
}
