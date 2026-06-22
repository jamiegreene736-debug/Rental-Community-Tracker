// Re-pull community photos — operator-initiated, full-pipeline community photo
// refresh kicked off from the Pre-Flight Check.
//
// Pipeline (one background job per click):
//   1. RESEARCH   — Claude API researches the community: a short visual
//                   description, the most useful image-search queries, and the
//                   authoritative source URLs (official resort / PM sites) where
//                   real community photos live.
//   2. FINDING    — turns that research into candidate photo URLs: the existing
//                   /api/community-photos/search (authoritative scrape + amenity
//                   queries + scoring) PLUS the Claude-derived google_images
//                   queries and Claude source-URL scrapes, deduped + capped.
//   3. SCRAPING   — downloads the candidates into the community folder via the
//                   existing /api/community-photos/save (clears, downloads,
//                   auto-labels).
//   4. VERIFYING  — double-checks EVERY saved photo belongs to the community
//                   with verifyCommunityPhotos (Google Lens reverse-image search
//                   + Claude vision per photo) and DELETES any photo that comes
//                   back a positive mismatch (different resort). Same-area
//                   sibling cross-matches are deliberately NOT deleted — the Lens
//                   logic already downgrades those to inconclusive (see
//                   community-photo-lens-logic.ts / AGENTS.md #45).
//
// State lives in-process (mirrors preflight-background-jobs.ts): the client
// starts a job, then polls. Photos are written to client/public/photos/<folder>
// exactly like the Community Photo Finder.

import fs from "fs";
import path from "path";
import { loopbackRequestHeaders } from "./auth";
import { getSearchApiKey, fetchSearchApiWithFallback } from "./searchapi";
import {
  verifyCommunityPhotos,
  type CommunityPhotoSample,
} from "./community-photo-verify";
import { communityAddressRuleForName } from "../shared/community-addresses";
import { resolveCuratedCommunityDescription } from "./community-descriptions";
import {
  confirmCommunityLocation,
  type LocationConfirmation,
} from "../shared/photo-location-confirmation";

type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type CommunityPhotoRepullJob = {
  id: string;
  status: JobStatus;
  phase: "queued" | "research" | "finding" | "scraping" | "verifying" | "completed" | "failed";
  message: string;
  progress: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  communityName: string;
  communityFolder: string;
  /** Short visual description Claude produced for the community (operator-visible). */
  researchSummary: string | null;
  candidatesFound: number | null;
  savedCount: number | null;
  removedCount: number | null;
  verifiedCount: number | null;
  /** "verified" | "likely" | "unconfirmed" | "mismatch" from verifyCommunityPhotos. */
  verdict: string | null;
  /** Photos that were deleted because they were a different community. */
  removed: Array<{ filename?: string; reason: string }>;
  /** Confirms the community's state/city (and flags a Bay-Watch-style mis-location). */
  locationConfirmation: LocationConfirmation | null;
  error: string | null;
};

const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_CANDIDATE_URLS = 40;
const RESEARCH_MODEL = "claude-sonnet-4-6";
const RESEARCH_TIMEOUT_MS = 45_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Cap on community photos sent through the Lens+vision verifier (cost guard). */
const VERIFY_CAP = 30;

const jobs = new Map<string, CommunityPhotoRepullJob>();
const activeJobIds = new Set<string>();

const loopbackBaseUrl = () => `http://127.0.0.1:${process.env.PORT || "5000"}`;

function newJobId(): string {
  return `cpr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function touch(job: CommunityPhotoRepullJob, patch: Partial<CommunityPhotoRepullJob> = {}): void {
  Object.assign(job, patch, { updatedAt: Date.now() });
  jobs.set(job.id, job);
}

function cleanupStaleJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if ((job.finishedAt ?? job.createdAt) < cutoff) jobs.delete(id);
  }
}
setInterval(cleanupStaleJobs, 30 * 60 * 1000).unref?.();

export function getCommunityPhotoRepullJob(jobId: string): CommunityPhotoRepullJob | null {
  return jobs.get(jobId) ?? null;
}

// ── Disk helpers ──────────────────────────────────────────────────────────────

const PHOTOS_BASE_DIR = path.resolve(process.cwd(), "client/public/photos");

// Anchored allowlists used as validating GUARDS (not String.replace, which
// CodeQL does not treat as a path-injection sanitizer). A value is only used to
// build a path after it passes one of these tests, so untrusted input can never
// reach the filesystem with traversal or unexpected characters.
const SAFE_FOLDER_RE = /^community-[a-zA-Z0-9_-]+$/;
const SAFE_FILENAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:jpe?g|png|webp|gif)$/i;

function publicPhotoDir(folder: string): string {
  // `path.basename` strips any directory component; the anchored regex guard
  // then confines the value to a community-* slug before it is joined onto the
  // fixed photos base directory.
  const safe = path.basename(folder);
  if (!SAFE_FOLDER_RE.test(safe)) {
    throw new Error("Invalid community photo folder");
  }
  return path.join(PHOTOS_BASE_DIR, safe);
}

/**
 * Resolve a single photo file inside a community folder, sanitizing BOTH the
 * folder and the filename so untrusted input can never escape the folder.
 * Returns null when the filename is not a plain image basename. Used by every
 * filesystem read/delete sink in this module.
 */
function safePhotoFilePath(folder: string, filename: string): string | null {
  const base = path.basename(filename);
  if (!SAFE_FILENAME_RE.test(base)) return null;
  return path.join(publicPhotoDir(folder), base);
}

function mimeForBuffer(buffer: Buffer, filename: string): string {
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

// ── Claude research ─────────────────────────────────────────────────────────

export type CommunityPhotoResearch = {
  description: string;
  imageQueries: string[];
  sourceUrls: string[];
  /** US state where Claude is confident the community physically sits (full name), or "". */
  confirmedState: string;
  /** City where Claude is confident the community sits, or "". */
  confirmedCity: string;
};

function defaultImageQueries(communityName: string): string[] {
  return [
    `"${communityName}" pool`,
    `"${communityName}" building exterior`,
    `"${communityName}" amenities`,
    `"${communityName}" clubhouse`,
    `"${communityName}" resort grounds`,
  ];
}

/**
 * Ask Claude to research the community: a short visual fingerprint plus the
 * best image-search queries and authoritative source URLs to scrape. Fail-soft:
 * returns the default amenity queries (and any curated description) when no
 * ANTHROPIC_API_KEY is set or the call fails.
 */
export async function researchCommunityForPhotos(
  communityName: string,
  city: string,
  anthropicApiKey: string,
): Promise<CommunityPhotoResearch> {
  const curated = resolveCuratedCommunityDescription(communityName) ?? "";
  const fallback: CommunityPhotoResearch = {
    description: curated,
    imageQueries: defaultImageQueries(communityName),
    sourceUrls: [],
    confirmedState: "",
    confirmedCity: "",
  };
  if (!anthropicApiKey) return fallback;

  const where = city ? ` in ${city}` : "";
  const prompt = [
    `You are helping gather real photographs of the vacation-rental resort/condo community "${communityName}"${where}.`,
    "We will use your answer to drive Google Images searches and to scrape official sites for COMMUNITY/AMENITY photos (pool, grounds, building exteriors, clubhouse, aerial) — NOT individual unit interiors.",
    "",
    "Return ONLY minified JSON with this exact shape:",
    '{"description":"2-3 sentence visual fingerprint (architecture, setting, distinctive amenities) used to recognize this exact community","imageQueries":["up to 6 google-images queries, each quoting the resort name and targeting a specific amenity/area"],"sourceUrls":["up to 4 https URLs of the official resort site or property-management pages most likely to host real community photos"],"state":"the US STATE (full name) where this community is physically located, ONLY if you are confident; else empty string","city":"the city/town where it is located, ONLY if confident; else empty string"}',
    "",
    "Rules: queries must be specific enough to avoid other resorts that share the same town. Only include sourceUrls you are confident are the correct resort. If unsure of a URL, omit it (do not guess). For state/city: this confirms WHERE the community actually is so we can catch a resort filed under the wrong state — a famous name can exist in multiple states (e.g. a 'Bay Watch' resort is in Myrtle Beach, South Carolina, not Florida), so only return a state you are sure of and leave it empty when unsure.",
  ].join("\n");

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: RESEARCH_MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(RESEARCH_TIMEOUT_MS),
    });
    if (!resp.ok) return fallback;
    const data = (await resp.json()) as any;
    const text: string = data?.content?.[0]?.text ?? "";
    const match = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim().match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    const parsed = JSON.parse(match[0]) as Partial<CommunityPhotoResearch>;
    const imageQueries = Array.isArray(parsed.imageQueries)
      ? parsed.imageQueries.map((q) => String(q ?? "").trim()).filter(Boolean).slice(0, 6)
      : [];
    const sourceUrls = Array.isArray(parsed.sourceUrls)
      ? parsed.sourceUrls.map((u) => String(u ?? "").trim()).filter((u) => /^https?:\/\//i.test(u)).slice(0, 4)
      : [];
    return {
      description: String(parsed.description ?? "").trim() || curated,
      // Always keep the proven amenity queries as a backstop, Claude's first.
      imageQueries: Array.from(new Set([...imageQueries, ...defaultImageQueries(communityName)])),
      sourceUrls,
      confirmedState: String((parsed as any).state ?? "").trim(),
      confirmedCity: String((parsed as any).city ?? "").trim(),
    };
  } catch {
    return fallback;
  }
}

// ── Candidate discovery ───────────────────────────────────────────────────────

const INTERIOR_KEYWORDS = [
  "bedroom", "kitchen", "bathroom", "bath", "living room", "dining room",
  "interior", "couch", "sofa", "bed ", "master", "loft", "hallway",
  "floor plan", "floorplan", "map", "square feet",
];
const LOW_TRUST_SOURCES = ["airbnb.com", "vrbo.com", "booking.com", "homeaway.com"];
const GENERIC_GEO_WORDS = new Set([
  "poipu", "koloa", "kauai", "princeville", "kapaa", "lihue", "kalaheo",
  "hanalei", "wailua", "maui", "oahu", "hawaii", "hawaiian", "island",
  "islands", "kihei", "wailea", "kapolei", "kona", "kohala", "waikoloa",
  "keauhou", "lahaina", "kaanapali", "honolulu", "kailua",
  "resort", "resorts", "beach", "beachfront", "beachside", "oceanfront",
  "ocean", "village", "plantation", "estates", "shores", "condos", "condo",
  "vacation", "rentals", "rental",
]);

function distinctiveNameWords(communityName: string): string[] {
  const words = communityName.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const distinctive = words.filter((w) => !GENERIC_GEO_WORDS.has(w));
  return distinctive.length > 0 ? distinctive : words;
}

/** Lightweight validation mirroring /api/community-photos/search scoreAndValidate. */
function validImage(img: any, requiredWords: string[]): string | null {
  const url: string = img?.original?.link;
  if (!url) return null;
  const lower = url.toLowerCase();
  if (lower.endsWith(".svg") || lower.endsWith(".gif")) return null;
  const w = img?.original?.width || 0;
  const h = img?.original?.height || 0;
  if (w > 0 && h > 0 && (w < 300 || h < 200)) return null;
  const title = (img?.title || "").toLowerCase();
  if (INTERIOR_KEYWORDS.some((kw) => title.includes(kw))) return null;
  const sourceLink = (img?.source?.link || "").toLowerCase();
  if (LOW_TRUST_SOURCES.some((s) => sourceLink.includes(s) || lower.includes(s))) return null;
  const ctx = `${title} ${sourceLink} ${(img?.source?.name || "").toLowerCase()} ${lower}`;
  if (!requiredWords.some((word) => ctx.includes(word))) return null;
  return url;
}

async function googleImagesUrls(query: string, requiredWords: string[]): Promise<string[]> {
  try {
    const params = new URLSearchParams({
      engine: "google_images",
      q: query,
      num: "30",
      safe: "active",
    });
    const resp = await fetchSearchApiWithFallback(params);
    if (!resp.ok) return [];
    const data = (await resp.json()) as any;
    const out: string[] = [];
    for (const img of (data?.images ?? []) as any[]) {
      const url = validImage(img, requiredWords);
      if (url) out.push(url);
    }
    return out;
  } catch {
    return [];
  }
}

/** Loopback to the existing search endpoint (handles authoritative scrape + scoring). */
async function loopbackSearchUrls(communityName: string, sourceUrl?: string): Promise<string[]> {
  try {
    const params = new URLSearchParams({ communityName });
    if (sourceUrl) params.set("sourceUrl", sourceUrl);
    const resp = await fetch(`${loopbackBaseUrl()}/api/community-photos/search?${params.toString()}`, {
      headers: loopbackRequestHeaders(),
      signal: AbortSignal.timeout(90_000),
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as any;
    return ((data?.results ?? []) as any[]).map((r) => r?.url).filter((u: unknown): u is string => typeof u === "string");
  } catch {
    return [];
  }
}

async function discoverCandidateUrls(
  communityName: string,
  research: CommunityPhotoResearch,
): Promise<string[]> {
  const requiredWords = distinctiveNameWords(communityName);
  const seen = new Set<string>();
  const ordered: string[] = [];
  const add = (urls: string[]) => {
    for (const u of urls) {
      if (!u || seen.has(u)) continue;
      seen.add(u);
      ordered.push(u);
    }
  };

  // 1. Authoritative scrape + default amenity queries (existing, well-scored).
  add(await loopbackSearchUrls(communityName));

  // 2. Claude source-URL scrapes (limit a couple to keep latency bounded).
  for (const src of research.sourceUrls.slice(0, 2)) {
    add(await loopbackSearchUrls(communityName, src));
  }

  // 3. Claude-derived image queries.
  if (getSearchApiKey()) {
    const results = await Promise.all(
      research.imageQueries.slice(0, 6).map((q) => googleImagesUrls(q, requiredWords)),
    );
    for (const r of results) add(r);
  }

  return ordered.slice(0, MAX_CANDIDATE_URLS);
}

// ── Save + verify ─────────────────────────────────────────────────────────────

async function saveToFolder(communityFolder: string, imageUrls: string[]): Promise<string[]> {
  const resp = await fetch(`${loopbackBaseUrl()}/api/community-photos/save`, {
    method: "POST",
    headers: loopbackRequestHeaders(),
    body: JSON.stringify({ communityFolder, imageUrls }),
    signal: AbortSignal.timeout(180_000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error || `Save failed (HTTP ${resp.status})`);
  return Array.isArray(data?.saved) ? (data.saved as string[]) : [];
}

async function loadFolderSamples(folder: string, filenames: string[]): Promise<CommunityPhotoSample[]> {
  const out: CommunityPhotoSample[] = [];
  let n = 0;
  for (const filename of filenames) {
    const abs = safePhotoFilePath(folder, filename);
    if (!abs) continue;
    const base = path.basename(filename);
    n += 1;
    try {
      const buffer = await fs.promises.readFile(abs);
      if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) continue;
      out.push({
        id: `C${n}`,
        folder,
        filename: base,
        buffer,
        mime: mimeForBuffer(buffer, base),
      });
    } catch {
      // skip unreadable
    }
  }
  return out;
}

// ── Job runner ────────────────────────────────────────────────────────────────

export type StartCommunityPhotoRepullInput = {
  communityName: string;
  communityFolder: string;
  city?: string;
  /** Expected US state (from the property/draft record) to confirm against. */
  state?: string;
};

export function startCommunityPhotoRepullJob(input: StartCommunityPhotoRepullInput): CommunityPhotoRepullJob {
  const id = newJobId();
  const job: CommunityPhotoRepullJob = {
    id,
    status: "queued",
    phase: "queued",
    message: "Queued",
    progress: 3,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    communityName: input.communityName,
    communityFolder: input.communityFolder,
    researchSummary: null,
    candidatesFound: null,
    savedCount: null,
    removedCount: null,
    verifiedCount: null,
    verdict: null,
    removed: [],
    locationConfirmation: null,
    error: null,
  };
  jobs.set(id, job);
  void runCommunityPhotoRepullJob(job, input);
  return job;
}

async function runCommunityPhotoRepullJob(
  job: CommunityPhotoRepullJob,
  input: StartCommunityPhotoRepullInput,
): Promise<void> {
  if (activeJobIds.has(job.id)) return;
  activeJobIds.add(job.id);

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? "";
  const searchApiKey = getSearchApiKey();
  const rule = communityAddressRuleForName(input.communityName);
  const city = input.city?.trim() || rule?.city || "";
  const expectedState = input.state?.trim() || rule?.state || "";

  try {
    if (!searchApiKey) {
      throw new Error("SEARCHAPI_API_KEY is required to find and verify community photos.");
    }

    // 1. RESEARCH
    touch(job, {
      status: "running",
      phase: "research",
      message: `Researching ${input.communityName} with Claude…`,
      progress: 12,
      startedAt: job.startedAt ?? Date.now(),
    });
    const research = await researchCommunityForPhotos(input.communityName, city, anthropicApiKey);
    // Confirm WHAT STATE the community is in: the curated location guard
    // (Bay-Watch-style known mis-locations) layered with the state Claude just
    // confirmed. Surfaced to the operator alongside the re-pulled photos.
    const locationConfirmation = confirmCommunityLocation({
      communityName: input.communityName,
      expectedCity: city || null,
      // Curated mailing-city vs marketed-town equivalences so Claude returning
      // "Poipu" against the mailing city "Koloa" isn't read as a city conflict.
      expectedCityAliases: [rule?.city, ...(rule?.cityAliases ?? [])],
      expectedState: expectedState || null,
      observedState: research.confirmedState || null,
      observedCity: research.confirmedCity || null,
    });
    touch(job, { researchSummary: research.description || null, locationConfirmation });
    if (locationConfirmation.status === "mismatch") {
      console.warn(`[community-photo-repull] location mismatch for "${input.communityName}": ${locationConfirmation.note}`);
    }

    // 2. FINDING
    touch(job, {
      phase: "finding",
      message: "Finding correct community photo URLs…",
      progress: 32,
    });
    const candidates = await discoverCandidateUrls(input.communityName, research);
    touch(job, { candidatesFound: candidates.length });
    if (candidates.length === 0) {
      throw new Error(`No community photos found for "${input.communityName}". The resort may not be well indexed; try the Community Photo Finder to add a source URL.`);
    }

    // 3. SCRAPING
    touch(job, {
      phase: "scraping",
      message: `Scraping ${candidates.length} candidate photo${candidates.length === 1 ? "" : "s"}…`,
      progress: 52,
    });
    const saved = await saveToFolder(input.communityFolder, candidates);
    touch(job, { savedCount: saved.length });
    if (saved.length === 0) {
      throw new Error("Found candidates but none could be downloaded. Try again.");
    }

    // 4. VERIFYING — Google Lens + Claude vision on every saved photo.
    touch(job, {
      phase: "verifying",
      message: `Double-checking ${Math.min(saved.length, VERIFY_CAP)} photo${saved.length === 1 ? "" : "s"} with AI vision + reverse image search…`,
      progress: 70,
    });
    const sampleFiles = saved.slice(0, VERIFY_CAP);
    const samples = await loadFolderSamples(input.communityFolder, sampleFiles);
    let removed: Array<{ filename?: string; reason: string }> = [];
    let verdict: string | null = null;
    let verifiedCount = 0;

    if (samples.length > 0) {
      const audit = await verifyCommunityPhotos(
        samples,
        saved.length,
        input.communityName,
        { label: input.communityName, folder: input.communityFolder },
        { searchApiKey, anthropicApiKey },
      );
      const community = audit.community;
      if (community) {
        verdict = community.overallStatus ?? null;
        verifiedCount = community.photoVerdicts.filter((p) => p.match === "yes").length;
        // Delete ONLY photos with a positive mismatch verdict (different
        // community). Same-area sibling cross-matches are already downgraded to
        // inconclusive by the Lens logic, so they stay. Uncertain stays too.
        const mismatches = community.photoVerdicts.filter((p) => p.match === "no");
        for (const m of mismatches) {
          if (!m.filename) continue;
          const abs = safePhotoFilePath(input.communityFolder, m.filename);
          if (!abs) continue;
          try {
            await fs.promises.unlink(abs);
            removed.push({ filename: path.basename(m.filename), reason: m.reason || "Identified as a different community." });
          } catch {
            // already gone / unreadable — ignore
          }
        }
      }
    }

    touch(job, {
      status: "completed",
      phase: "completed",
      progress: 100,
      finishedAt: Date.now(),
      removedCount: removed.length,
      verifiedCount,
      verdict,
      removed,
      message:
        `Saved ${saved.length} photo${saved.length === 1 ? "" : "s"}` +
        (removed.length > 0 ? `, removed ${removed.length} that didn't match` : "") +
        (verifiedCount > 0 ? ` · ${verifiedCount} confirmed for ${input.communityName}.` : ".") +
        (locationConfirmation.status === "mismatch" ? ` ⚠️ ${locationConfirmation.note}` : ""),
      error: null,
    });
  } catch (e: any) {
    touch(job, {
      status: "failed",
      phase: "failed",
      progress: 100,
      finishedAt: Date.now(),
      message: e?.message || "Re-pull failed",
      error: e?.message || "Re-pull failed",
    });
  } finally {
    activeJobIds.delete(job.id);
  }
}
