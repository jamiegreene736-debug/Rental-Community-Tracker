// Server side of the AI "final say" photo adjudication (2026-07-12 operator
// directive: "I don't want to make judgment calls. I'll leave that to Claude
// AI to determine."). Pure decisions live in
// shared/photo-judgment-adjudication.ts; this module owns the two impure
// pieces:
//   • ONE batched downscaled-image vision call (the photo-dedupe pattern) that
//     forces a definitive keep/remove (or dupe-ownership) verdict per item;
//   • the fingerprint-scoped decision store in app_settings
//     (`photo_judgment_decisions.v1`, promise-tail + fail-soft — the
//     photo-folder-verification pin pattern).
//
// The store is what makes a KEEP durable: the next sweep (and the stage-3
// consensus rail) treats a fingerprint-valid keep as a covered finding instead
// of re-asking the operator — and any photo add/hide/replace silently
// invalidates it, so a stale blessing can never carry onto photos Claude has
// not seen.

import fs from "fs";
import path from "path";
import sharp from "sharp";
import { storage } from "./storage";
import {
  PHOTO_JUDGMENT_DECISIONS_SETTING_KEY,
  buildPhotoJudgmentPrompt,
  buildRemovalRefutePrompt,
  coveredJudgmentKeys,
  parsePhotoJudgmentDecisions,
  parsePhotoJudgmentVerdicts,
  parseRemovalRefuteVerdicts,
  serializePhotoJudgmentDecisions,
  photoJudgmentKey,
  type PhotoJudgmentCandidate,
  type PhotoJudgmentDecision,
  type PhotoJudgmentKind,
  type PhotoJudgmentVerdict,
  type RemovalRefuteVerdict,
} from "../shared/photo-judgment-adjudication";
import { photoFolderFingerprint } from "../shared/photo-folder-verification";
import type { CommunityConsensusCoverage } from "../shared/unit-audit-sweep-logic";
import { listPublishedFilenames } from "./builder-photo-groups";
import { computeDhash, hammingDistance } from "./photo-hashing";

const MODEL = process.env.AUDIT_JUDGMENT_MODEL || "claude-sonnet-4-6";
const ANTHROPIC_TIMEOUT_MS = 150_000;
const VISION_IMAGE_WIDTH = 640;

/** Kill switch: AUDIT_AI_JUDGMENT=0 restores the "needs your eyes" behavior. */
export function photoJudgmentEnabled(): boolean {
  return String(process.env.AUDIT_AI_JUDGMENT ?? "").trim() !== "0";
}

// ── Decision store ───────────────────────────────────────────────────────────

let storeTail: Promise<void> = Promise.resolve();

export async function loadPhotoJudgmentDecisions(): Promise<Record<string, PhotoJudgmentDecision>> {
  try {
    const raw = await storage.getSetting(PHOTO_JUDGMENT_DECISIONS_SETTING_KEY);
    return parsePhotoJudgmentDecisions(raw ?? null);
  } catch {
    return Object.create(null);
  }
}

export function recordPhotoJudgmentDecisions(rows: PhotoJudgmentDecision[]): Promise<void> {
  storeTail = storeTail.then(async () => {
    try {
      const raw = await storage.getSetting(PHOTO_JUDGMENT_DECISIONS_SETTING_KEY);
      const map = parsePhotoJudgmentDecisions(raw ?? null);
      for (const row of rows) {
        map[photoJudgmentKey(row.folder, row.filename, row.kind)] = row;
      }
      await storage.setSetting(
        PHOTO_JUDGMENT_DECISIONS_SETTING_KEY,
        serializePhotoJudgmentDecisions(map),
      );
    } catch {
      // Fail-soft: a decision that fails to persist just re-adjudicates next
      // sweep — the store is a spend-saver, never a blocker.
    }
  });
  return storeTail;
}

/**
 * Fingerprints of each folder's CURRENT published set — same
 * listPublishedFilenames source as the operator pin, so the two stores can
 * never disagree about what "the folder changed" means.
 */
export async function judgmentFingerprintsForFolders(
  folders: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const folder of Array.from(new Set(folders.filter(Boolean)))) {
    try {
      out[folder] = photoFolderFingerprint(await listPublishedFilenames(folder));
    } catch {
      // Missing folder → no fingerprint → stored decisions there never apply.
    }
  }
  return out;
}

/**
 * The consensus-rail coverage for a set of folders: fingerprint-valid KEEP
 * decisions become covered junk keys / covered dupe sides. Returns undefined
 * when adjudication is disabled so callers pass nothing through.
 */
export async function coveredJudgmentKeysForFolders(
  folders: string[],
): Promise<CommunityConsensusCoverage | undefined> {
  if (!photoJudgmentEnabled()) return undefined;
  try {
    const decisions = await loadPhotoJudgmentDecisions();
    if (Object.keys(decisions).length === 0) return undefined;
    const fingerprints = await judgmentFingerprintsForFolders(folders);
    const { coveredPhotoKeys, coveredDupeSides } = coveredJudgmentKeys(decisions, fingerprints);
    if (coveredPhotoKeys.size === 0 && coveredDupeSides.size === 0) return undefined;
    return { coveredPhotoKeys, coveredDupeSides };
  } catch {
    return undefined;
  }
}

// ── Vision call ─────────────────────────────────────────────────────────────

function publicPhotoDir(folder: string): string {
  const safe = folder.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return path.resolve(process.cwd(), "client/public/photos", safe);
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

async function readPhoto(folder: string, filename: string): Promise<Buffer | null> {
  try {
    return await fs.promises.readFile(path.join(publicPhotoDir(folder), path.basename(filename)));
  } catch {
    return null;
  }
}

/** Kill switch for the removal double-check ONLY (hash proof is always on). */
export function photoJudgmentDoubleCheckEnabled(): boolean {
  return String(process.env.AUDIT_JUDGMENT_DOUBLE_CHECK ?? "").trim() !== "0";
}

/**
 * DETERMINISTIC duplicate proof at hide time: recompute both sides' dHash
 * from the bytes ON DISK and return the hamming distance — never trust the
 * check result's stored distance (the Ilikai stale-hash incident fabricated
 * phantom duplicate pairs from June rows). Returns null when either file
 * can't be read/hashed — the caller treats null as UNPROVEN and never hides.
 */
export async function verifyDupePairOnDisk(
  a: { folder: string; filename: string },
  b: { folder: string; filename: string },
): Promise<number | null> {
  try {
    const [bufA, bufB] = await Promise.all([readPhoto(a.folder, a.filename), readPhoto(b.folder, b.filename)]);
    if (!bufA || !bufB) return null;
    const [hashA, hashB] = await Promise.all([computeDhash(bufA), computeDhash(bufB)]);
    return hammingDistance(hashA, hashB);
  } catch {
    return null;
  }
}

export type RemovalRefuteOutcome =
  | { ok: true; verdicts: RemovalRefuteVerdict[] }
  | { ok: false; error: string };

/**
 * The adversarial SECOND opinion over photos slated for removal — a fresh
 * vision call framed to REFUTE each removal (default keep). Only removals it
 * confirms may act; ok:false means the caller WITHHOLDS every removal.
 */
export async function runRemovalRefuteVision(
  expectedCommunity: string,
  items: Array<{ folder: string; filename: string; kind: PhotoJudgmentKind; reason: string }>,
): Promise<RemovalRefuteOutcome> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: "no ANTHROPIC_API_KEY" };
  try {
    const content: any[] = [];
    for (let i = 0; i < items.length; i++) {
      const buf = await readPhoto(items[i].folder, items[i].filename);
      if (!buf) return { ok: false, error: `photo ${items[i].folder}/${items[i].filename} unreadable for the second review` };
      content.push({ type: "text", text: `--- photo ${i + 1} (${items[i].folder}/${items[i].filename}) ---` });
      const enc = await downscaleForVision(buf);
      content.push({ type: "image", source: { type: "base64", media_type: enc.mime, data: enc.data } });
    }
    content.push({ type: "text", text: buildRemovalRefutePrompt({ expectedCommunity, items }) });

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
    const data = (await resp.json().catch(() => null)) as any;
    if (!resp.ok) return { ok: false, error: String(data?.error?.message ?? `HTTP ${resp.status}`) };
    const text: string = data?.content?.[0]?.text ?? "";
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return { ok: false, error: "second-review response was not JSON" };
    const verdicts = parseRemovalRefuteVerdicts(JSON.parse(match[0]), items.length);
    if (!verdicts) return { ok: false, error: "second-review response failed strict validation" };
    return { ok: true, verdicts };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export type PhotoJudgmentVisionOutcome =
  | { ok: true; verdicts: PhotoJudgmentVerdict[]; judged: PhotoJudgmentCandidate[] }
  | { ok: false; error: string };

/**
 * One batched vision call over the pending candidates. Items whose image files
 * are missing on disk are dropped BEFORE the call (nothing to judge — the
 * finding is stale). A malformed/failed response returns ok:false and the
 * caller keeps the pre-existing "needs your eyes" behavior — an unusable
 * answer must never act (the audit honesty rule).
 */
export async function runPhotoJudgmentVision(
  expectedCommunity: string,
  candidates: PhotoJudgmentCandidate[],
): Promise<PhotoJudgmentVisionOutcome> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: "no ANTHROPIC_API_KEY" };

  // Load buffers first so the numbered prompt only lists judgeable items.
  const judged: PhotoJudgmentCandidate[] = [];
  const images: Array<Array<{ tag: string; buffer: Buffer }>> = [];
  for (const c of candidates) {
    const primary = await readPhoto(c.folder, c.filename);
    if (!primary) continue;
    if (c.kind === "cross-dupe" && c.pairFolder && c.pairFilename) {
      const pair = await readPhoto(c.pairFolder, c.pairFilename);
      if (!pair) continue;
      judged.push(c);
      images.push([
        { tag: `item ${judged.length} side A (${c.folder}/${c.filename})`, buffer: primary },
        { tag: `item ${judged.length} side B (${c.pairFolder}/${c.pairFilename})`, buffer: pair },
      ]);
    } else {
      judged.push(c);
      images.push([{ tag: `item ${judged.length} (${c.folder}/${c.filename})`, buffer: primary }]);
    }
  }
  if (judged.length === 0) return { ok: true, verdicts: [], judged: [] };

  try {
    const content: any[] = [];
    for (const group of images) {
      for (const img of group) {
        content.push({ type: "text", text: `--- ${img.tag} ---` });
        const enc = await downscaleForVision(img.buffer);
        content.push({ type: "image", source: { type: "base64", media_type: enc.mime, data: enc.data } });
      }
    }
    content.push({ type: "text", text: buildPhotoJudgmentPrompt({ expectedCommunity, items: judged }) });

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        messages: [{ role: "user", content }],
      }),
      signal: AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS),
    });
    const data = (await resp.json().catch(() => null)) as any;
    if (!resp.ok) return { ok: false, error: String(data?.error?.message ?? `HTTP ${resp.status}`) };
    const text: string = data?.content?.[0]?.text ?? "";
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return { ok: false, error: "vision response was not JSON" };
    const verdicts = parsePhotoJudgmentVerdicts(JSON.parse(match[0]), judged);
    if (!verdicts) return { ok: false, error: "vision response failed strict validation (every item needs one definitive decision)" };
    return { ok: true, verdicts, judged };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
