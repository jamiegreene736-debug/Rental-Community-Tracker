// Photo Community Check — operator-initiated QA for the photos tab.
//
// A combo listing is built by stitching a COMMUNITY photo set (shared resort
// amenities, grounds, building exteriors, views) together with one or more
// UNIT photo sets (interiors of specific units). Every set MUST be from the
// SAME resort/community, or the published listing shows guest amenity photos
// from one resort and unit photos from another. This module is the check that
// catches that class of mistake before the operator pushes to Guesty.
//
// What it answers (the operator's literal questions):
//   1. What community do the community-folder photos depict, and do they match
//      the expected community name on the property record?
//   2. Are ALL the community photos of that one community (no outlier from a
//      different resort)? — checked EXHAUSTIVELY, every single photo.
//   3. For each unit (Unit A / Unit B / …): what community is it in, and is it
//      the SAME community as the community photos?
//
// Engine: TWO-PHASE so the community side can be verified exhaustively without
// drowning a single vision call in 40 images (which degrades per-photo
// judgment):
//   • Phase A — Anchor + Units (one call): identify the canonical community
//     from a small even-spread REFERENCE sample of the community folder, and
//     judge each UNIT (~5 photos each) against that reference. This is the
//     cross-folder holistic judgment — the model sees the community reference
//     and every unit at once.
//   • Phase B — Exhaustive community (batched, concurrent calls): verify EVERY
//     community photo, in batches, each batch grounded by a few TRUSTED
//     reference anchors + the Phase-A identity. Per-photo verdict
//     same/different/junk. Every community photo gets a verdict; any photo a
//     batch could not analyze is surfaced as "unchecked", NEVER silently passed
//     (the operator asked to be 100% sure every community photo belongs).
//
// The two phases are INDEPENDENT — if the unit-comparison call fails, the
// exhaustive community check still runs, and vice-versa.
//
// Extras we add on top (the "anything else" the operator asked for):
//   - Mis-filed / junk photo flags (floorplan, map, logo, screenshot, a photo
//     whose subject is a person, visible competitor watermark/branding).
//   - Cross-folder duplicate detection via perceptual hash — the same image
//     filed into two folders (a community photo accidentally dropped into a
//     unit folder, or a Unit-A photo reused in Unit B) is a strong "mixed up"
//     signal and is deterministic, so we compute it server-side over the FULL
//     community set + the unit samples rather than asking the vision model.
//   - An overall pass / warn / fail verdict + a plain-English summary.
//
// Reading happens straight off the Railway photo volume
// (client/public/photos/<folder>) the same way photo-listing-scanner does.
//
// Cost/latency: a 30-photo community + 2 units ≈ 1 (Phase A) + ~4 (Phase B
// batches) Sonnet vision calls ≈ $0.20-0.40 and 30-90s wall-clock. This is a
// deliberate, operator-clicked action, not a background sweep, so the spend is
// acceptable per click.

import fs from "fs";
import path from "path";
import { computeDhash, hammingDistance, DUPLICATE_DISTANCE } from "./photo-hashing";

// Sonnet (not Haiku) on purpose: this is a reasoning-heavy visual comparison
// across folders + world knowledge of named resorts, not the short
// noun-phrase classification photo-labeler.ts does. Haiku over-flags here.
const MODEL = "claude-sonnet-4-6";

// Reference sample used to (a) establish the community identity in Phase A and
// (b) anchor each Phase-B batch visually. Kept small — these are the photos the
// model trusts as "this IS the community", so a handful of clean, varied shots
// is better than a big set that might itself contain an outlier.
const COMMUNITY_ANCHOR_CAP = 6;
// Anchors actually included in each Phase-B batch (a couple is enough to ground
// "same place"; more just inflates token cost on every batch).
const MAX_ANCHOR_IMAGES = 3;
// Community photos per exhaustive verification call. Small enough that the model
// can carefully judge each candidate against the anchors.
const COMMUNITY_BATCH_SIZE = 9;
// Safety ceiling on a pathological community folder. We never expect this many
// (real folders run 16-30); above it we even-sample down to the ceiling and
// surface that not every photo was checked rather than firing dozens of calls.
const COMMUNITY_HARD_MAX = 150;
// Per the operator: "regular checks maybe like 5 photos of each unit" to
// confirm each unit is in the same community as the community folder.
const UNIT_SAMPLE_CAP = 5;
// Phase-B batches run concurrently, bounded so we don't open dozens of sockets
// to the Anthropic API at once on a big folder.
const BATCH_CONCURRENCY = 3;
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
  photosChecked: number;   // how many community photos got a successful verdict
  photosTotal: number;     // total community photos on disk (curated)
  identifiedCommunity: string;
  matchesExpected: "yes" | "no";
  matchReason: string;
  allSameCommunity: boolean;
  outliers: FlaggedPhoto[];
  junk: FlaggedPhoto[];
  unchecked: FlaggedPhoto[]; // photos a batch could not analyze (vision error)
  confidence: number;
};

export type UnitGroupResult = {
  role: "unit";
  label: string;
  folder: string;
  photosChecked: number;
  photosTotal: number;
  identifiedCommunity: string;
  sameAsCommunity: "yes" | "no";
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

// Spread `cap` sample indices evenly across `n` items so a sampled outlier in
// the middle/end of a big folder still gets seen (vs. just taking the first N).
export function evenSampleIndices(n: number, cap: number): number[] {
  if (n <= 0) return [];
  if (cap <= 0) return [];
  if (n <= cap) return Array.from({ length: n }, (_, i) => i);
  if (cap === 1) return [0];
  const out = new Set<number>();
  for (let i = 0; i < cap; i++) {
    out.add(Math.min(n - 1, Math.round((i * (n - 1)) / (cap - 1))));
  }
  return Array.from(out).sort((a, b) => a - b);
}

// Split an array into fixed-size chunks. Pure — unit-tested.
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return items.length ? [items.slice()] : [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Bounded-concurrency map: run `fn` over `items`, at most `limit` in flight.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

type SampledPhoto = {
  id: string;        // stable display id, e.g. "C1" or "U1-3"
  folder: string;
  filename: string;
  caption?: string;
  buffer: Buffer;
  mime: string;
  hash?: string;
};

// Pick the disk files for a group: intersect the operator's curated filenames
// with what's actually on the volume (dedupe, sanitize against traversal).
async function resolveGroupFiles(
  group: CheckGroupInput,
): Promise<Array<{ filename: string; caption?: string }>> {
  const dir = publicPhotoDir(group.folder);
  let diskFiles: string[] = [];
  try {
    diskFiles = (await fs.promises.readdir(dir)).filter((f) => IMAGE_EXT.test(f));
  } catch {
    return [];
  }
  const diskSet = new Set(diskFiles);

  // Curated filenames, sanitized to a bare basename and intersected with disk.
  const requested = Array.isArray(group.filenames) && group.filenames.length > 0
    ? group.filenames.map((f) => path.basename(String(f))).filter((f) => IMAGE_EXT.test(f) && diskSet.has(f))
    : diskFiles.slice().sort();

  // Dedupe while preserving order.
  const ordered = Array.from(new Set(requested));
  return ordered.map((filename) => ({ filename, caption: group.captions?.[filename] }));
}

async function loadSamples(
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
  // errors. Bounded O(n²) over the loaded sample set.
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

// ── Vision call ─────────────────────────────────────────────────────────────

async function callVisionJson(content: any[], maxTokens: number, apiKey: string): Promise<any> {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
    signal: AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS),
  });
  const data = (await resp.json().catch(() => null)) as any;
  if (!resp.ok) throw new Error(data?.error?.message ?? `HTTP ${resp.status}`);
  const text: string = data?.content?.[0]?.text ?? "";
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("vision response was not JSON");
  return JSON.parse(match[0]);
}

function imageBlock(s: SampledPhoto): any {
  return { type: "image", source: { type: "base64", media_type: s.mime, data: s.buffer.toString("base64") } };
}

function markerFor(label: string, id: string, caption?: string): any {
  const cap = caption ? ` · caption: "${caption}"` : "";
  return { type: "text", text: `--- GROUP: ${label} · photo ${id}${cap} ---` };
}

// ── Phase A: identity + units ─────────────────────────────────────────────--

function buildPhaseAInstruction(expectedCommunity: string, unitLabels: string[]): string {
  const expected = expectedCommunity.trim() || "(not provided)";
  return [
    "You are a meticulous QA reviewer for a vacation-rental listing builder.",
    "An operator builds ONE listing by combining a COMMUNITY photo set (shared resort amenities, grounds, pools, building exteriors, beach access, views) with one or more UNIT photo sets (interiors and private lanais/balconies of specific units). ALL of these sets are supposed to be from the SAME resort/community.",
    "",
    `The property record says the expected community is: "${expected}".`,
    "",
    "You are given a small REFERENCE sample of the COMMUNITY photos (IDs starting \"C\") and a sample of each UNIT (IDs like \"U1-3\"). Each photo is preceded by a text marker with its GROUP, ID, and caption. Reference photos by that ID.",
    "",
    "Do TWO things:",
    "1. Identify the community: from the COMMUNITY reference photos, name the resort/community/region (read signage, architecture, landscape, landmarks; if you cannot name the exact resort, describe the place type and use 'unclear'). Decide matchesExpected as a strict yes/no. Note (anchorFlags) any COMMUNITY reference photo that looks like it is NOT this community or is junk, so it is not used as an anchor later.",
    `2. For EACH UNIT (in order: ${unitLabels.map((l, i) => `unit ${i + 1} = "${l}"`).join(", ") || "none"}): say what community/region it appears to be in and decide sameAsCommunity (is it the SAME community as the COMMUNITY reference photos?). Decide whether all of that unit's photos are the same unit; list outliers; flag junk.`,
    "",
    "This is a BINARY decision tool. matchesExpected and sameAsCommunity MUST be exactly \"yes\" or \"no\" — NEVER \"uncertain\"/\"maybe\". (Only the free-text 'identified' field may say 'unclear'.)",
    "- Default to \"yes\" (same community). Answer \"no\" ONLY on a POSITIVE contradiction: a different named resort on signage/towels/keycards, a clearly different region or climate (tropical vs alpine), an incompatible building type (oceanfront high-rise vs low-rise garden condo) or view (ocean vs cityscape) that cannot be the same resort, or a distinctly different architectural style/era/materials.",
    "- UNIT photos are interiors; COMMUNITY photos are outdoor amenities. They naturally look different — that difference ALONE is NEVER grounds for \"no\".",
    "Junk = floorplans, maps, logos/branding tiles, screenshots, images whose main subject is a person's face, or any visible COMPETITOR watermark/branding (Airbnb/Vrbo/Booking/another property manager).",
    "",
    "Respond with ONLY a single minified JSON object — no prose, no code fences — matching this shape exactly:",
    '{"community":{"identified":"string","matchesExpected":"yes|no","matchReason":"short string","anchorFlags":[{"id":"C3","reason":"string"}],"confidence":0.0},"units":[{"group":"echo the unit label","identified":"string","sameAsCommunity":"yes|no","reason":"short string","allSameUnit":true,"outliers":[{"id":"U1-2","reason":"string"}],"junk":[],"confidence":0.0}],"summary":"1-2 sentence operator-facing summary"}',
    "Return units in the SAME ORDER the unit groups were presented.",
  ].join("\n");
}

// ── Phase B: exhaustive per-photo community verification ────────────────────--

function buildPhaseBInstruction(expectedCommunity: string, identity: string): string {
  const expected = expectedCommunity.trim() || "(not provided)";
  return [
    "You are a meticulous QA reviewer for a vacation-rental listing builder.",
    `The REFERENCE photos below (IDs starting "REF") are CONFIRMED photos of the community/resort the listing is for. Expected community name: "${expected}". Identity established from the reference: ${identity || "(see the reference photos)"}.`,
    "The CANDIDATE photos (IDs starting \"C\") are all from the community folder. For EACH candidate, decide whether it is a photo of the SAME resort/community as the REFERENCE photos.",
    "",
    "Per-photo BINARY decision — verdict is exactly one of \"same\", \"different\", or \"junk\":",
    "- Default to \"same\". Answer \"different\" ONLY on a POSITIVE contradiction with the reference: a different named resort on signage/towels/keycards, a clearly different region or climate, an incompatible building type or view that cannot be the same resort, or distinctly different architecture/era/materials than the reference.",
    "- Community photos are outdoor amenities/grounds/views/exteriors/lobbies and they VARY a lot (a pool, a beach, a garden, a lobby, a sunset can all be the same resort). Variety or a hard-to-place generic shot is NEVER \"different\" on its own — only a positive contradiction is.",
    "- \"junk\" = floorplans, maps, logos/branding tiles, screenshots, images whose main subject is a person's face, or any visible COMPETITOR watermark/branding (Airbnb/Vrbo/Booking/another property manager).",
    "",
    "Respond with ONLY a single minified JSON object — no prose, no code fences:",
    '{"photos":[{"id":"C7","verdict":"same|different|junk","reason":"short string"}]}',
    "Include EVERY candidate id exactly once. Do NOT include the REF reference photos in the output.",
  ].join("\n");
}

// ── Small typed coercion helpers ────────────────────────────────────────────

function asYesNo(v: unknown): "yes" | "no" {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "no" || s === "false" || s === "different") return "no";
  return "yes";
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

export type CommunityPhotoVerdict = "same" | "different" | "junk";

// Fold the per-photo Phase-B verdicts (across all batches) over the FULL
// community sample set. Every photo that did not receive a successful verdict
// is "unchecked" — surfaced, never silently treated as same. Pure + tested.
export function summarizeCommunityVerdicts(
  samples: SampledPhoto[],
  verdicts: Map<string, { verdict: CommunityPhotoVerdict; reason: string }>,
): { checked: number; allSameCommunity: boolean; outliers: FlaggedPhoto[]; junk: FlaggedPhoto[]; unchecked: FlaggedPhoto[] } {
  const outliers: FlaggedPhoto[] = [];
  const junk: FlaggedPhoto[] = [];
  const unchecked: FlaggedPhoto[] = [];
  let checked = 0;
  for (const s of samples) {
    const v = verdicts.get(s.id);
    if (!v) {
      unchecked.push({ id: s.id, caption: s.caption, reason: "could not be analyzed (vision error) — re-run to verify" });
      continue;
    }
    checked += 1;
    if (v.verdict === "different") outliers.push({ id: s.id, caption: s.caption, reason: v.reason || "appears to be a different community" });
    else if (v.verdict === "junk") junk.push({ id: s.id, caption: s.caption, reason: v.reason || "junk / mis-filed" });
  }
  return { checked, allSameCommunity: outliers.length === 0, outliers, junk, unchecked };
}

// Deterministic verdict synthesis — never trusts the model's "vibe", only the
// structured signals. Pure + tested.
export function synthesizeVerdict(input: {
  expectedCommunity: string;
  community: CommunityGroupResult | null;
  units: UnitGroupResult[];
  crossDupeCount: number;
  modelConcerns: string[];
  unitCompareFailed: boolean;
}): { verdict: "pass" | "warn" | "fail"; concerns: string[]; allSameCommunity: "yes" | "no" | "uncertain" } {
  const { expectedCommunity, community, units, crossDupeCount, modelConcerns, unitCompareFailed } = input;
  const concerns: string[] = [...modelConcerns];
  let hasFail = false;
  let hasWarn = false;
  const fail = (msg: string) => { hasFail = true; concerns.push(msg); };
  const warn = (msg: string) => { hasWarn = true; concerns.push(msg); };

  if (community) {
    if (community.matchesExpected === "no") {
      fail(`Community photos appear to be a DIFFERENT community than "${expectedCommunity || "expected"}" (identified: ${community.identifiedCommunity}).`);
    }
    if (community.outliers.length > 0) {
      warn(`${community.outliers.length} community photo(s) look like they may be from a DIFFERENT place — review them before pushing.`);
    }
    if (community.junk.length > 0) {
      warn(`${community.junk.length} community photo(s) look like junk / mis-filed (floorplan, map, logo, screenshot, person, or competitor branding).`);
    }
    if (community.unchecked.length > 0) {
      warn(`${community.unchecked.length} community photo(s) could NOT be analyzed (vision error) — not every photo was verified, re-run to be sure.`);
    }
  }
  for (const u of units) {
    if (u.sameAsCommunity === "no") {
      fail(`${u.label} appears to be a DIFFERENT community than the community photos (identified: ${u.identifiedCommunity}).`);
    }
    if (!u.allSameUnit || u.outliers.length > 0) warn(`${u.label} has photo(s) that may not be the same unit.`);
    if (u.junk.length > 0) warn(`${u.label} has ${u.junk.length} junk/mis-filed photo(s).`);
  }
  if (crossDupeCount > 0) warn(`${crossDupeCount} photo(s) appear in more than one folder — a photo may be filed under the wrong unit/community.`);
  if (unitCompareFailed && units.length > 0) warn("Unit comparison could not run (vision error) — the units were not compared to the community photos; re-run to verify.");

  // The same-community roll-up: "no" on any positive contradiction; "yes" only
  // when there are at least two sets to compare and none contradicted; else
  // "uncertain" (a single set has nothing to compare against).
  const anyDifferent = (community?.matchesExpected === "no") || units.some((u) => u.sameAsCommunity === "no");
  const comparableSets = (community ? 1 : 0) + units.length;
  const allSameCommunity: "yes" | "no" | "uncertain" = anyDifferent ? "no" : comparableSets >= 2 ? "yes" : "uncertain";

  const verdict: "pass" | "warn" | "fail" = hasFail ? "fail" : hasWarn ? "warn" : "pass";
  return { verdict, concerns: Array.from(new Set(concerns)).slice(0, 12), allSameCommunity };
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

  // ── Resolve community: merge ALL community-role groups into one logical set
  // and load EVERY photo (the operator wants every community photo checked).
  // Representative label/folder = the first community group.
  const communityLabel = communityInputs[0]?.label ?? communityInputs[0]?.folder ?? "Community";
  const communityFolder = communityInputs[0]?.folder ?? "";
  const communityFiles: Array<{ folder: string; filename: string; caption?: string }> = [];
  const seenCommunity = new Set<string>();
  for (const g of communityInputs) {
    const files = await resolveGroupFiles(g);
    for (const f of files) {
      const key = `${g.folder}/${f.filename}`;
      if (seenCommunity.has(key)) continue;
      seenCommunity.add(key);
      communityFiles.push({ folder: g.folder, filename: f.filename, caption: f.caption });
    }
  }

  // Safety ceiling: if a folder is pathologically large, even-sample down so we
  // don't fire dozens of calls — and remember that not all were checked.
  let communityCapped = false;
  let communityFilesToCheck = communityFiles;
  if (communityFiles.length > COMMUNITY_HARD_MAX) {
    communityCapped = true;
    const idxs = evenSampleIndices(communityFiles.length, COMMUNITY_HARD_MAX);
    communityFilesToCheck = idxs.map((i) => communityFiles[i]);
  }

  // Load community buffers (one C-numbered sample per file, across folders).
  const communitySamples: SampledPhoto[] = [];
  {
    let n = 0;
    for (const f of communityFilesToCheck) {
      n += 1;
      const dir = publicPhotoDir(f.folder);
      try {
        const buffer = await fs.promises.readFile(path.join(dir, f.filename));
        if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) continue;
        communitySamples.push({
          id: `C${n}`,
          folder: f.folder,
          filename: f.filename,
          caption: f.caption,
          buffer,
          mime: mimeForBuffer(buffer, f.filename),
        });
      } catch {
        // Unreadable — skip.
      }
    }
  }

  // Load unit samples (~UNIT_SAMPLE_CAP each, even-spread).
  const unitSamplesByUnit: SampledPhoto[][] = [];
  const unitLabels: string[] = [];
  for (let u = 0; u < unitInputs.length; u++) {
    const g = unitInputs[u];
    const files = await resolveGroupFiles(g);
    const idxs = evenSampleIndices(files.length, UNIT_SAMPLE_CAP);
    const chosen = idxs.map((i) => files[i]);
    const samples = await loadSamples(g.folder, `U${u + 1}-`, chosen);
    unitSamplesByUnit.push(samples);
    unitLabels.push(g.label || g.folder);
  }

  const communityTotal = communityFiles.length;
  const allSamples = [...communitySamples, ...unitSamplesByUnit.flat()];

  // Duplicate detection is deterministic and independent of the vision call —
  // run it regardless (even if the API key is missing). Runs over the FULL
  // community set + the unit samples.
  const duplicates = await detectDuplicates(allSamples);

  // Nothing readable on disk → bail with a clear message.
  if (allSamples.length === 0) {
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
      photosChecked: allSamples.length,
      elapsedMs: Date.now() - startedAt,
      warning: "ANTHROPIC_API_KEY not configured",
    };
  }

  const warnings: string[] = [];
  if (communityCapped) {
    warnings.push(`Community folder has ${communityTotal} photos; checked an even-spread ${communitySamples.length} (over the ${COMMUNITY_HARD_MAX} per-run ceiling).`);
  }

  // ── Phase A: identity + units (one call) ──────────────────────────────────
  const anchorIdxs = evenSampleIndices(communitySamples.length, COMMUNITY_ANCHOR_CAP);
  const anchorSamples = anchorIdxs.map((i) => communitySamples[i]);

  let identity = "";
  let identifiedCommunity = "";
  let matchesExpected: "yes" | "no" = "yes";
  let matchReason = "";
  let communityConfidence = 0.5;
  const phaseAFlagIds = new Set<string>();
  let phaseAUnits: any[] = [];
  let phaseASummary = "";
  let unitCompareFailed = false;
  let phaseAError: string | undefined;

  {
    const content: any[] = [];
    for (const s of anchorSamples) {
      content.push(markerFor(communityLabel, s.id, s.caption));
      content.push(imageBlock(s));
    }
    for (let u = 0; u < unitSamplesByUnit.length; u++) {
      for (const s of unitSamplesByUnit[u]) {
        content.push(markerFor(unitLabels[u], s.id, s.caption));
        content.push(imageBlock(s));
      }
    }
    content.push({ type: "text", text: buildPhaseAInstruction(expectedCommunity, unitLabels) });

    try {
      const parsed = await callVisionJson(content, 1500, apiKey);
      const c = parsed?.community ?? {};
      identifiedCommunity = String(c.identified ?? "").trim() || "unclear";
      identity = identifiedCommunity !== "unclear" ? identifiedCommunity : "";
      matchesExpected = asYesNo(c.matchesExpected);
      matchReason = String(c.matchReason ?? "").trim();
      communityConfidence = asConfidence(c.confidence);
      for (const f of asFlags(c.anchorFlags, anchorSamples)) phaseAFlagIds.add(f.id);
      phaseAUnits = Array.isArray(parsed?.units) ? parsed.units : [];
      phaseASummary = String(parsed?.summary ?? "").trim();
    } catch (e: any) {
      phaseAError = e?.message ?? String(e);
      unitCompareFailed = true;
    }
  }

  // ── Phase B: exhaustive per-photo community verification (batched) ─────────
  const trustedAnchors = anchorSamples.filter((s) => !phaseAFlagIds.has(s.id)).slice(0, MAX_ANCHOR_IMAGES);
  const verdicts = new Map<string, { verdict: CommunityPhotoVerdict; reason: string }>();
  let phaseBErrors = 0;

  if (communitySamples.length > 0) {
    const batches = chunk(communitySamples, COMMUNITY_BATCH_SIZE);
    await mapWithConcurrency(batches, BATCH_CONCURRENCY, async (batch) => {
      const content: any[] = [];
      // Reference anchors first (relabel to REF# so the model never confuses
      // them with the candidates it must classify).
      trustedAnchors.forEach((s, i) => {
        content.push(markerFor("REFERENCE (confirmed community)", `REF${i + 1}`, s.caption));
        content.push(imageBlock(s));
      });
      for (const s of batch) {
        content.push(markerFor("CANDIDATE community photo", s.id, s.caption));
        content.push(imageBlock(s));
      }
      content.push({ type: "text", text: buildPhaseBInstruction(expectedCommunity, identity) });
      try {
        const parsed = await callVisionJson(content, 1500, apiKey);
        const rows = Array.isArray(parsed?.photos) ? parsed.photos : [];
        for (const row of rows) {
          if (!row || typeof row !== "object") continue;
          const id = String((row as any).id ?? "").trim();
          if (!id) continue;
          const raw = String((row as any).verdict ?? "").trim().toLowerCase();
          const verdict: CommunityPhotoVerdict = raw === "different" || raw === "no" ? "different" : raw === "junk" ? "junk" : "same";
          verdicts.set(id, { verdict, reason: String((row as any).reason ?? "").trim() });
        }
      } catch (e: any) {
        phaseBErrors += 1;
      }
    });
  }

  // ── Assemble community result ──────────────────────────────────────────────
  let community: CommunityGroupResult | null = null;
  if (communitySamples.length > 0) {
    const fold = summarizeCommunityVerdicts(communitySamples, verdicts);
    community = {
      role: "community",
      label: communityLabel,
      folder: communityFolder,
      photosChecked: fold.checked,
      photosTotal: communityTotal,
      identifiedCommunity: identifiedCommunity || "unclear",
      matchesExpected,
      matchReason: matchReason || (phaseAError ? "Identity call failed; judged from reference photos only." : ""),
      allSameCommunity: fold.allSameCommunity,
      outliers: fold.outliers,
      junk: fold.junk,
      unchecked: fold.unchecked,
      confidence: communityConfidence,
    };
    if (phaseBErrors > 0) {
      warnings.push(`${phaseBErrors} community batch(es) failed to analyze — ${fold.unchecked.length} photo(s) unchecked.`);
    }
  }

  // ── Assemble unit results ──────────────────────────────────────────────────
  const units: UnitGroupResult[] = unitSamplesByUnit.map((samples, i) => {
    const u = phaseAUnits[i] ?? {};
    return {
      role: "unit",
      label: unitLabels[i],
      folder: unitInputs[i]?.folder ?? "",
      photosChecked: samples.length,
      photosTotal: samples.length, // we sample ~UNIT_SAMPLE_CAP and check exactly those
      identifiedCommunity: String(u.identified ?? "").trim() || "unclear",
      // If Phase A failed there is no contradiction evidence → binary default
      // "yes" (same), but we surface unitCompareFailed so the operator knows the
      // units were NOT actually compared.
      sameAsCommunity: phaseAError ? "yes" : asYesNo(u.sameAsCommunity),
      reason: String(u.reason ?? "").trim() || (phaseAError ? "not analyzed (vision error)" : ""),
      allSameUnit: u.allSameUnit !== false,
      outliers: asFlags(u.outliers, samples),
      junk: asFlags(u.junk, samples),
      confidence: phaseAError ? 0.3 : asConfidence(u.confidence),
    };
  });

  // ── Verdict synthesis ──────────────────────────────────────────────────────
  const crossDupes = duplicates.filter((d) => d.scope === "cross-folder");
  const { verdict, concerns, allSameCommunity } = synthesizeVerdict({
    expectedCommunity,
    community,
    units,
    crossDupeCount: crossDupes.length,
    modelConcerns: [],
    unitCompareFailed,
  });

  // Operator-facing summary: prefer a deterministic, specific line; fall back to
  // the model's Phase-A summary, then a generic.
  const summaryParts: string[] = [];
  if (community) {
    const cleanCount = community.photosChecked - community.outliers.length - community.junk.length;
    summaryParts.push(
      `Community folder identified as "${community.identifiedCommunity}"${community.matchesExpected === "yes" ? " (matches expected)" : " — DOES NOT match expected"}; checked ${community.photosChecked}/${community.photosTotal} photos, ${cleanCount} look right` +
      `${community.outliers.length ? `, ${community.outliers.length} possibly different` : ""}${community.junk.length ? `, ${community.junk.length} junk` : ""}${community.unchecked.length ? `, ${community.unchecked.length} unchecked` : ""}.`,
    );
  }
  if (units.length > 0 && !unitCompareFailed) {
    const same = units.filter((u) => u.sameAsCommunity === "yes").length;
    summaryParts.push(`${same}/${units.length} unit(s) match the community.`);
  }
  const summary = summaryParts.join(" ") || phaseASummary || (verdict === "pass" ? "All photo sets appear to be from the same community." : "Review the flagged items below before pushing these photos.");

  const warning = [phaseAError ? `identity/units: ${phaseAError}` : "", ...warnings].filter(Boolean).join(" · ") || undefined;

  return {
    ok: true,
    verdict,
    expectedCommunity,
    summary,
    concerns,
    allSameCommunity,
    community,
    units,
    duplicates,
    model: MODEL,
    photosChecked: allSamples.length,
    elapsedMs: Date.now() - startedAt,
    warning,
  };
}
