// AI "final say" adjudication for the Unit Audit Sweep's residual photo
// JUDGMENT CALLS (2026-07-12 operator directive: "I don't want to make
// judgment calls. I'll leave that to Claude AI to determine.").
//
// After every existing rail has run (auto-fix ladder, community-folder
// cleanup, consensus re-checks), three finding classes still used to land on
// the operator as "needs your eyes":
//   • junk flags (floorplan/map/logo/screenshot suspicions) — no auto remedy
//     in unit folders;
//   • unit↔unit cross-folder duplicates — "which unit owns the photo" was an
//     explicit judgment call (Load-Bearing Unit Audit Sweep #12);
//   • yellow/uncertain photo votes — auto-resolved by consensus ONLY when
//     nothing else blocks it, and junk/dupes block it.
// This module selects those candidates, builds a FORCED-CHOICE vision prompt
// (keep or remove — "uncertain" is not an accepted answer), parses the
// verdicts strictly, and applies conservative guards to the removal plan.
//
// POSTURE (load-bearing — don't widen):
//   • Positive "no" votes are NEVER adjudication candidates. A red vote is a
//     decided mismatch with a concrete remedy (the fix ladder / community
//     cleanup); letting a second vision look overturn it would be upgrading a
//     "no" — forbidden by Load-Bearing #16.
//   • Removals are the EXISTING photo_labels.hidden soft-delete (files never
//     unlinked, ↺ Undo real) and floor-guarded per folder.
//   • A cross-dupe decision may hide at most ONE side of the pair.
//   • Decisions persist fingerprint-scoped (photoFolderFingerprint — the
//     operator-pin posture): any photo add/hide/replace silently un-applies
//     stored decisions for that folder, so a stale blessing can never carry
//     onto photos Claude has not seen.
//   • KEEP decisions feed the consensus rail as "covered" findings — the
//     final greening still goes through rail B's independent re-checks; a
//     positive contradiction in ANY pass still wins.

import { photoFolderFingerprint } from "./photo-folder-verification";
import { NEAR_DUPLICATE_DISTANCE } from "./photo-dedupe-logic";

export const PHOTO_JUDGMENT_DECISIONS_SETTING_KEY = "photo_judgment_decisions.v1";
/** Newest decisions kept on write; stale folders age out instead of growing forever. */
export const PHOTO_JUDGMENT_DECISIONS_CAP = 800;
/** Cap on items sent to one adjudication vision call (request-size bound). */
export const PHOTO_JUDGMENT_MAX_ITEMS_DEFAULT = 24;
/** Cross-dupe pairs are the image-heaviest item kind (2 sides + anchors). */
export const PHOTO_JUDGMENT_MAX_DUPE_PAIRS = 6;
/**
 * A REMOVE decision below this confidence downgrades to keep. The choice is
 * forced, so low confidence means "I had to pick one" — destructive action
 * (even soft-delete) needs a decisive judgment.
 */
export const PHOTO_JUDGMENT_MIN_REMOVE_CONFIDENCE = 0.6;

export type PhotoJudgmentKind = "uncertain-vote" | "junk" | "cross-dupe";

export type PhotoJudgmentCandidate = {
  kind: PhotoJudgmentKind;
  folder: string;
  filename: string;
  /** Group heading the photo came from, e.g. "Community folder" / "Unit A (3BR)". */
  groupLabel: string;
  /** The finding's own words (vote reason / junk reason / dupe description). */
  context: string;
  /** cross-dupe only: the other side of the pair. */
  pairFolder?: string;
  pairFilename?: string;
  /** cross-dupe only: the other side's group heading. */
  pairGroupLabel?: string;
  /** cross-dupe only: the check engine's dHash distance for the pair. */
  pairDistance?: number;
};

export type PhotoJudgmentDecisionValue = "keep" | "remove" | "keep-a" | "keep-b" | "keep-both";

export type PhotoJudgmentVerdict = {
  index: number;
  decision: PhotoJudgmentDecisionValue;
  confidence: number;
  reason: string;
};

export type PhotoJudgmentDecision = {
  folder: string;
  filename: string;
  kind: PhotoJudgmentKind;
  decision: "keep" | "remove";
  reason: string;
  decidedAt: string;
  /** photoFolderFingerprint of the folder's published set when decided. */
  fingerprint: string;
};

// Same prototype-pollution defense as the other app_settings stores.
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function photoJudgmentKey(folder: string, filename: string, kind: PhotoJudgmentKind): string {
  return `${folder}/${filename}|${kind}`;
}

/** Order-insensitive key for a cross-folder duplicate pair. */
export function dupePairKey(
  a: { folder: string; filename: string },
  b: { folder: string; filename: string },
): string {
  const ka = `${a.folder}/${a.filename}`;
  const kb = `${b.folder}/${b.filename}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

// ── Candidate collection ─────────────────────────────────────────────────────

type VoteLike = {
  id: string;
  folder?: string;
  filename?: string;
  match: "yes" | "no" | "uncertain";
  reason?: string;
};

type GroupLike = {
  label?: string;
  folder: string;
  photoVerdicts?: VoteLike[];
  junk?: Array<{ id: string; reason?: string }>;
};

/** Structural view of PhotoCommunityCheckResult — only what adjudication reads. */
export type JudgmentCheckResultLike = {
  community?: (GroupLike & { label?: string }) | null;
  units?: GroupLike[];
  duplicates?: Array<{
    scope: string;
    a: { folder: string; filename: string };
    b: { folder: string; filename: string };
    distance?: number;
  }>;
};

/**
 * Select the residual judgment-call findings Claude may adjudicate. Red "no"
 * votes are deliberately NOT collected (see the module posture). Community-side
 * cross-dupes are excluded — the community-folder cleanup ladder already owns
 * them (the community copy hides, zero loss).
 */
export function collectPhotoJudgmentCandidates(
  result: JudgmentCheckResultLike,
  opts: { communityFolder?: string; maxItems?: number; maxDupePairs?: number } = {},
): PhotoJudgmentCandidate[] {
  const maxItems = Math.max(1, opts.maxItems ?? PHOTO_JUDGMENT_MAX_ITEMS_DEFAULT);
  const maxDupePairs = Math.max(0, opts.maxDupePairs ?? PHOTO_JUDGMENT_MAX_DUPE_PAIRS);
  const out: PhotoJudgmentCandidate[] = [];
  const seen = new Set<string>();
  const push = (c: PhotoJudgmentCandidate) => {
    const k = photoJudgmentKey(c.folder, c.filename, c.kind);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(c);
  };

  const groups: Array<GroupLike & { heading: string }> = [];
  if (result.community) {
    groups.push({ ...result.community, heading: result.community.label || "Community folder" });
  }
  for (const u of result.units ?? []) {
    groups.push({ ...u, heading: u.label || u.folder });
  }
  const headingByFolder = new Map(groups.map((g) => [g.folder, g.heading]));

  // Cross-dupes first (structural findings beat per-photo suspicions when the
  // item cap truncates). One candidate per PAIR — the prompt asks which side
  // keeps the photo.
  let dupePairs = 0;
  for (const d of result.duplicates ?? []) {
    if (d.scope !== "cross-folder") continue;
    const communityFolder = opts.communityFolder;
    if (communityFolder && (d.a.folder === communityFolder || d.b.folder === communityFolder)) continue;
    if (dupePairs >= maxDupePairs) continue;
    dupePairs += 1;
    push({
      kind: "cross-dupe",
      folder: d.a.folder,
      filename: d.a.filename,
      groupLabel: headingByFolder.get(d.a.folder) ?? d.a.folder,
      context: `the same photo also appears as ${d.b.folder}/${d.b.filename}`,
      pairFolder: d.b.folder,
      pairFilename: d.b.filename,
      pairGroupLabel: headingByFolder.get(d.b.folder) ?? d.b.folder,
      pairDistance: Number.isFinite(d.distance as number) ? (d.distance as number) : undefined,
    });
  }

  for (const g of groups) {
    const byId = new Map((g.photoVerdicts ?? []).filter((v) => v.folder && v.filename).map((v) => [v.id, v]));
    for (const j of g.junk ?? []) {
      const v = byId.get(j.id);
      if (!v?.folder || !v.filename) continue;
      push({
        kind: "junk",
        folder: v.folder,
        filename: v.filename,
        groupLabel: g.heading,
        context: `flagged as junk/mis-filed: ${j.reason ?? "no reason given"}`,
      });
    }
  }
  for (const g of groups) {
    for (const v of g.photoVerdicts ?? []) {
      if (v.match !== "uncertain" || !v.folder || !v.filename) continue;
      push({
        kind: "uncertain-vote",
        folder: v.folder,
        filename: v.filename,
        groupLabel: g.heading,
        context: `could not be confirmed: ${v.reason ?? "no reason given"}`,
      });
    }
  }
  return out.slice(0, maxItems);
}

// ── Stored-decision filtering ────────────────────────────────────────────────

/**
 * Split candidates into ones Claude already decided (KEEP, with the folder's
 * fingerprint unchanged since) and ones that still need a fresh look. Only
 * KEEP decisions short-circuit: a stored REMOVE whose photo is visible again
 * means the operator un-hid it — an explicit override, so we re-ask.
 * Cross-dupe pairs short-circuit only when BOTH sides hold applicable keeps.
 */
export function filterAdjudicatedCandidates(
  candidates: PhotoJudgmentCandidate[],
  decisions: Record<string, PhotoJudgmentDecision>,
  fingerprintByFolder: Record<string, string>,
): { pending: PhotoJudgmentCandidate[]; priorKeeps: Array<{ candidate: PhotoJudgmentCandidate; decision: PhotoJudgmentDecision }> } {
  const pending: PhotoJudgmentCandidate[] = [];
  const priorKeeps: Array<{ candidate: PhotoJudgmentCandidate; decision: PhotoJudgmentDecision }> = [];
  const applicableKeep = (folder: string, filename: string, kind: PhotoJudgmentKind): PhotoJudgmentDecision | null => {
    const row = decisions[photoJudgmentKey(folder, filename, kind)];
    if (!row || row.decision !== "keep") return null;
    const current = fingerprintByFolder[folder];
    return current && row.fingerprint === current ? row : null;
  };
  for (const c of candidates) {
    if (c.kind === "cross-dupe" && c.pairFolder && c.pairFilename) {
      const a = applicableKeep(c.folder, c.filename, c.kind);
      const b = applicableKeep(c.pairFolder, c.pairFilename, c.kind);
      if (a && b) priorKeeps.push({ candidate: c, decision: a });
      else pending.push(c);
      continue;
    }
    const kept = applicableKeep(c.folder, c.filename, c.kind);
    if (kept) priorKeeps.push({ candidate: c, decision: kept });
    else pending.push(c);
  }
  return { pending, priorKeeps };
}

// ── Prompt + strict parse ────────────────────────────────────────────────────

export function buildPhotoJudgmentPrompt(input: {
  expectedCommunity: string;
  items: PhotoJudgmentCandidate[];
}): string {
  const lines: string[] = [];
  lines.push(
    `You are the final decision-maker for a vacation-rental photo audit of "${input.expectedCommunity}".`,
    `Earlier automated checks flagged the photos below but could not decide. YOU decide now — the human operator has delegated these judgment calls to you.`,
    `"uncertain" is NOT an accepted answer: every item gets a definitive decision with your honest confidence (0-1).`,
    ``,
    `Decision rules by item kind:`,
    `- uncertain-vote: KEEP unless the photo more likely does NOT belong to this property/community (wrong climate, incompatible architecture, another resort's signage/branding) or is unusable for a guest-facing listing. A generic interior that merely can't be confirmed online BELONGS — keep it.`,
    `- junk: REMOVE if it is a floorplan, map, logo, screenshot, document, watermark card, or person-focused shot — anything that is not a real photo of the property. KEEP if it is a genuine property photo.`,
    `- cross-dupe: the same photo appears in two different unit galleries. Decide which gallery should keep it — "keep-a" (first side keeps, second side hides) or "keep-b" (second side keeps). Use continuity with each gallery's other photos (bedding, finishes, view). Answer "keep-both" ONLY if the two images are genuinely different photos of different rooms.`,
    ``,
    `Items:`,
  );
  input.items.forEach((c, i) => {
    const idx = i + 1;
    if (c.kind === "cross-dupe") {
      lines.push(
        `${idx}. [cross-dupe] side A = ${c.groupLabel} (${c.folder}/${c.filename}); side B = ${c.pairGroupLabel ?? c.pairFolder} (${c.pairFolder}/${c.pairFilename}). ${c.context}`,
      );
    } else {
      lines.push(`${idx}. [${c.kind}] ${c.groupLabel} — ${c.folder}/${c.filename}. ${c.context}`);
    }
  });
  lines.push(
    ``,
    `Reply with ONLY this JSON (one entry per item, decisions: keep|remove for uncertain-vote/junk, keep-a|keep-b|keep-both for cross-dupe):`,
    `{"decisions":[{"index":1,"decision":"keep","confidence":0.9,"reason":"short"}]}`,
  );
  return lines.join("\n");
}

/**
 * Strict parse: every item must be answered exactly once with a decision valid
 * for its kind. Anything malformed returns null — the caller falls back to the
 * pre-existing "needs your eyes" behavior (an unusable answer must never act).
 */
export function parsePhotoJudgmentVerdicts(
  raw: unknown,
  items: PhotoJudgmentCandidate[],
): PhotoJudgmentVerdict[] | null {
  const rows = (raw as any)?.decisions;
  if (!Array.isArray(rows)) return null;
  const byIndex = new Map<number, PhotoJudgmentVerdict>();
  for (const r of rows) {
    const index = Number(r?.index);
    if (!Number.isInteger(index) || index < 1 || index > items.length) return null;
    if (byIndex.has(index)) return null;
    const decision = String(r?.decision ?? "").trim().toLowerCase() as PhotoJudgmentDecisionValue;
    const kind = items[index - 1].kind;
    const valid = kind === "cross-dupe"
      ? decision === "keep-a" || decision === "keep-b" || decision === "keep-both"
      : decision === "keep" || decision === "remove";
    if (!valid) return null;
    const confRaw = Number(r?.confidence);
    const confidence = Number.isFinite(confRaw) ? Math.min(1, Math.max(0, confRaw)) : 0.5;
    byIndex.set(index, {
      index,
      decision,
      confidence,
      reason: String(r?.reason ?? "").trim() || "no reason given",
    });
  }
  if (byIndex.size !== items.length) return null;
  return items.map((_, i) => byIndex.get(i + 1)!);
}

// ── Action plan (guards) ─────────────────────────────────────────────────────

export type PhotoJudgmentAction = {
  folder: string;
  filename: string;
  kind: PhotoJudgmentKind;
  action: "keep" | "hide";
  reason: string;
};

/**
 * Turn verdicts into a guarded action plan:
 *  - low-confidence removals downgrade to keep (forced choice ≠ decisive);
 *  - a cross-dupe hides at most ONE side (never both);
 *  - per-folder floor: never hide below `floor` visible photos; when the floor
 *    truncates, no-loss cross-dupe hides rank first, then junk, then
 *    uncertain-vote hides (the communityPhotoFixSelections ranking).
 * `keep` entries are DEFINITIVE keeps (safe to persist as covered findings);
 * `floorBlocked` entries are decided removals the floor kept visible — they
 * stay UNRESOLVED and must never be persisted as keeps (that would green the
 * audit over a photo Claude decided should go).
 */
export function photoJudgmentActionPlan(
  items: PhotoJudgmentCandidate[],
  verdicts: PhotoJudgmentVerdict[],
  visibleCountByFolder: Record<string, number>,
  opts: { floor?: number; minRemoveConfidence?: number } = {},
): {
  hide: PhotoJudgmentAction[];
  keep: PhotoJudgmentAction[];
  floorBlocked: PhotoJudgmentAction[];
  lowConfidenceKept: number;
} {
  const floor = opts.floor ?? 3;
  const minConf = opts.minRemoveConfidence ?? PHOTO_JUDGMENT_MIN_REMOVE_CONFIDENCE;
  const keep: PhotoJudgmentAction[] = [];
  const wantHide: Array<PhotoJudgmentAction & { rank: number }> = [];
  let lowConfidenceKept = 0;

  for (let i = 0; i < items.length; i++) {
    const c = items[i];
    const v = verdicts[i];
    if (!v) continue;
    if (c.kind === "cross-dupe" && c.pairFolder && c.pairFilename) {
      if (v.decision === "keep-both") {
        keep.push({ folder: c.folder, filename: c.filename, kind: c.kind, action: "keep", reason: v.reason });
        keep.push({ folder: c.pairFolder, filename: c.pairFilename, kind: c.kind, action: "keep", reason: v.reason });
        continue;
      }
      const loser = v.decision === "keep-a"
        ? { folder: c.pairFolder, filename: c.pairFilename }
        : { folder: c.folder, filename: c.filename };
      const winner = v.decision === "keep-a"
        ? { folder: c.folder, filename: c.filename }
        : { folder: c.pairFolder, filename: c.pairFilename };
      keep.push({ ...winner, kind: c.kind, action: "keep", reason: v.reason });
      if (v.confidence < minConf) {
        lowConfidenceKept += 1;
        keep.push({ ...loser, kind: c.kind, action: "keep", reason: `low-confidence ownership call (${v.confidence.toFixed(2)}) — both copies kept` });
      } else {
        wantHide.push({ ...loser, kind: c.kind, action: "hide", reason: `duplicate — ${v.reason}`, rank: 0 });
      }
      continue;
    }
    if (v.decision === "remove" && v.confidence >= minConf) {
      wantHide.push({
        folder: c.folder,
        filename: c.filename,
        kind: c.kind,
        action: "hide",
        reason: v.reason,
        rank: c.kind === "junk" ? 1 : 2,
      });
    } else {
      if (v.decision === "remove") lowConfidenceKept += 1;
      keep.push({
        folder: c.folder,
        filename: c.filename,
        kind: c.kind,
        action: "keep",
        reason: v.decision === "remove" ? `low-confidence removal (${v.confidence.toFixed(2)}) — kept` : v.reason,
      });
    }
  }

  // Floor guard per folder, no-loss hides first.
  wantHide.sort((a, b) => a.rank - b.rank);
  const hide: PhotoJudgmentAction[] = [];
  const floorBlocked: PhotoJudgmentAction[] = [];
  const remaining: Record<string, number> = { ...visibleCountByFolder };
  for (const h of wantHide) {
    const left = remaining[h.folder];
    if (typeof left === "number" && left - 1 < floor) {
      floorBlocked.push({ folder: h.folder, filename: h.filename, kind: h.kind, action: "keep", reason: `decided remove, kept by the ${floor}-photo folder floor — ${h.reason}` });
      continue;
    }
    if (typeof left === "number") remaining[h.folder] = left - 1;
    hide.push({ folder: h.folder, filename: h.filename, kind: h.kind, action: "hide", reason: h.reason });
  }
  return { hide, keep, floorBlocked, lowConfidenceKept };
}

// ── Removal verification (2026-07-12 operator follow-up: "make sure the
// photos we're deleting are genuine like duplicates or similar content") ─────
// NO AI-judgment hide happens on a single opinion:
//   • cross-dupe hides need DETERMINISTIC proof — a fresh dHash distance
//     recomputed from the two files' bytes ON DISK at hide time, ≤ the
//     dedupe engine's near-duplicate threshold. The check result's stored
//     distance is not trusted (the Ilikai stale-hash incident fabricated 13
//     phantom duplicate pairs); a recompute that disagrees VETOES the hide
//     and keeps both sides.
//   • junk / doesn't-belong hides need a SECOND independent vision review
//     framed adversarially ("try to REFUTE this removal; default keep") —
//     only removals the refuter confirms proceed; a refuted removal becomes
//     a definitive keep. If the second review can't run, removals are
//     WITHHELD (never act on one opinion), and the stage stays retryable.

/** Max fresh-recompute dHash distance for a hide to count as a genuine duplicate. */
export const PHOTO_JUDGMENT_DUPE_HASH_MAX_DISTANCE = NEAR_DUPLICATE_DISTANCE;

/** True when a freshly recomputed pair distance proves a genuine duplicate. */
export function verifiedDupeHideDistance(distance: number | null | undefined): boolean {
  return typeof distance === "number" && Number.isFinite(distance) && distance >= 0 &&
    distance <= PHOTO_JUDGMENT_DUPE_HASH_MAX_DISTANCE;
}

export function buildRemovalRefutePrompt(input: {
  expectedCommunity: string;
  items: Array<{ folder: string; filename: string; kind: PhotoJudgmentKind; reason: string }>;
}): string {
  const lines: string[] = [];
  lines.push(
    `You are an independent SECOND reviewer for a vacation-rental photo audit of "${input.expectedCommunity}".`,
    `A first review decided each photo below should be REMOVED from the listing gallery, for the stated reason.`,
    `Your job is to try to REFUTE each removal. Removing a genuine photo hurts the listing, so when in ANY doubt answer "keep".`,
    `Answer "remove" ONLY if you independently agree the photo is junk/mis-filed or does not belong to this property.`,
    ``,
    `Photos slated for removal:`,
  );
  input.items.forEach((it, i) => {
    lines.push(`${i + 1}. [${it.kind}] ${it.folder}/${it.filename} — first review's reason: ${it.reason}`);
  });
  lines.push(
    ``,
    `Reply with ONLY this JSON (one entry per photo, verdict "remove" or "keep"):`,
    `{"reviews":[{"index":1,"verdict":"keep","reason":"short"}]}`,
  );
  return lines.join("\n");
}

export type RemovalRefuteVerdict = { index: number; verdict: "remove" | "keep"; reason: string };

/**
 * Strict parse of the refute pass: every slated removal must be reviewed
 * exactly once with a remove/keep verdict. Malformed → null, and the caller
 * WITHHOLDS the removals (an unusable second opinion never acts).
 */
export function parseRemovalRefuteVerdicts(raw: unknown, count: number): RemovalRefuteVerdict[] | null {
  const rows = (raw as any)?.reviews;
  if (!Array.isArray(rows)) return null;
  const byIndex = new Map<number, RemovalRefuteVerdict>();
  for (const r of rows) {
    const index = Number(r?.index);
    if (!Number.isInteger(index) || index < 1 || index > count) return null;
    if (byIndex.has(index)) return null;
    const verdict = String(r?.verdict ?? "").trim().toLowerCase();
    if (verdict !== "remove" && verdict !== "keep") return null;
    byIndex.set(index, { index, verdict, reason: String(r?.reason ?? "").trim() || "no reason given" });
  }
  if (byIndex.size !== count) return null;
  return Array.from({ length: count }, (_, i) => byIndex.get(i + 1)!);
}

// ── Decision store (parse / serialize / update) ──────────────────────────────

export function parsePhotoJudgmentDecisions(
  raw: string | null | undefined,
): Record<string, PhotoJudgmentDecision> {
  const out: Record<string, PhotoJudgmentDecision> = Object.create(null);
  if (!raw) return out;
  try {
    const doc: unknown = JSON.parse(raw);
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return out;
    for (const key of Object.keys(doc as Record<string, unknown>)) {
      if (UNSAFE_KEYS.has(key)) continue;
      const row = (doc as Record<string, unknown>)[key] as any;
      if (!row || typeof row !== "object") continue;
      const folder = String(row.folder ?? "").trim();
      const filename = String(row.filename ?? "").trim();
      const kind = String(row.kind ?? "").trim() as PhotoJudgmentKind;
      const decision = String(row.decision ?? "").trim() as "keep" | "remove";
      const fingerprint = String(row.fingerprint ?? "").trim();
      const decidedAt = String(row.decidedAt ?? "").trim();
      if (!folder || !filename || !fingerprint || !decidedAt) continue;
      if (kind !== "uncertain-vote" && kind !== "junk" && kind !== "cross-dupe") continue;
      if (decision !== "keep" && decision !== "remove") continue;
      out[key] = { folder, filename, kind, decision, fingerprint, decidedAt, reason: String(row.reason ?? "").trim() };
    }
  } catch {
    // Fail-soft: an unreadable store reads as "no prior decisions".
  }
  return out;
}

export function serializePhotoJudgmentDecisions(
  map: Record<string, PhotoJudgmentDecision>,
): string {
  const keys = Object.keys(map)
    .filter((k) => !UNSAFE_KEYS.has(k) && map[k])
    .sort((a, b) => (map[a].decidedAt < map[b].decidedAt ? 1 : map[a].decidedAt > map[b].decidedAt ? -1 : 0))
    .slice(0, PHOTO_JUDGMENT_DECISIONS_CAP);
  const out: Record<string, PhotoJudgmentDecision> = {};
  for (const k of keys) out[k] = map[k];
  return JSON.stringify(out);
}

/**
 * The consensus-rail coverage sets derived from applicable KEEP decisions:
 * photo keys (`folder/filename`) whose JUNK finding Claude adjudicated keep,
 * and dupe-pair sides Claude settled as keep-both. KIND-STRICT on purpose —
 * an uncertain-vote keep answers "does it belong here", not "is it junk", so
 * it never covers a junk flag on the same file (uncertain votes don't block
 * the consensus rail anyway). Fingerprint-scoped like everything else here.
 */
export function coveredJudgmentKeys(
  decisions: Record<string, PhotoJudgmentDecision>,
  fingerprintByFolder: Record<string, string>,
): { coveredPhotoKeys: Set<string>; coveredDupeSides: Set<string> } {
  const coveredPhotoKeys = new Set<string>();
  const coveredDupeSides = new Set<string>();
  for (const key of Object.keys(decisions)) {
    const d = decisions[key];
    if (d.decision !== "keep") continue;
    const current = fingerprintByFolder[d.folder];
    if (!current || d.fingerprint !== current) continue;
    if (d.kind === "cross-dupe") coveredDupeSides.add(`${d.folder}/${d.filename}`);
    else if (d.kind === "junk") coveredPhotoKeys.add(`${d.folder}/${d.filename}`);
  }
  return { coveredPhotoKeys, coveredDupeSides };
}

/** Fingerprints for every folder in the map, computed from visible filename lists. */
export function fingerprintFolders(
  filenamesByFolder: Record<string, string[]>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const folder of Object.keys(filenamesByFolder)) {
    out[folder] = photoFolderFingerprint(filenamesByFolder[folder]);
  }
  return out;
}
