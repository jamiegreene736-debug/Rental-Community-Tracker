// Server glue for the same-unit cross-portal photo hunt (the preflight
// "Find new photos" button). Pure decisions live in
// shared/same-unit-photo-hunt.ts; this file owns the impure legs:
//   - Google SERP via SearchAPI (key rotation inherited from server/searchapi.ts)
//   - loading the current folder's dHashes (photo_labels + compute-on-miss)
//   - hashing a candidate's REMOTE gallery (bounded fetch + computeDhash)
//   - the hunt loop itself, with the gallery SCRAPE injected by the caller so
//     the tiered scraper (Apify → ScrapingBee → sidecar) is reused via the
//     existing loopback route instead of re-implemented here.
//
// Env knobs:
//   SAME_UNIT_PHOTO_HUNT_DISABLED=1     → callers fall back to the legacy
//                                         different-listing discovery.
//   SAME_UNIT_PHOTO_HUNT_MAX_CANDIDATES → galleries scraped per hunt (default 4)
//   SAME_UNIT_PHOTO_HUNT_MIN_NEW        → new-photo bar (default 3)

import fs from "fs";
import path from "path";
import { storage } from "./storage";
import { computeDhash } from "./photo-hashing";
import { fetchSearchApiWithFallback } from "./searchapi";
import { MIN_INDEPENDENT_UNIT_PHOTOS } from "./unit-photo-resolver";
import {
  evaluateGalleryNovelty,
  filterSameUnitSerpRows,
  sameUnitCandidateVerdict,
  sameUnitHuntExhaustionProven,
  sameUnitHuntIdentity,
  sameUnitHuntQueries,
  sameUnitHuntSearchComplete,
  summarizeSameUnitHuntFailure,
  canonicalKeysForExclusion,
  SAME_UNIT_HUNT_MAX_CANDIDATES_DEFAULT,
  SAME_UNIT_HUNT_MIN_NEW_PHOTOS_DEFAULT,
  type SameUnitCheckedCandidate,
  type SameUnitHuntOutcome,
  type SameUnitSerpRow,
} from "@shared/same-unit-photo-hunt";

const IMAGE_EXT = /\.(?:jpe?g|png|webp)$/i;
const MAX_LOCAL_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REMOTE_IMAGE_BYTES = 20 * 1024 * 1024;
const REMOTE_HASH_TIMEOUT_MS = 12_000;
const REMOTE_HASH_CONCURRENCY = 4;
/** Cap the photos hashed per candidate gallery — 30 mirrors PHOTO_AUDIT_MAX_PHOTOS. */
const REMOTE_HASH_CAP = 30;
const MAX_FOLDER_HASHES = 120;

export function sameUnitPhotoHuntEnabled(): boolean {
  return process.env.SAME_UNIT_PHOTO_HUNT_DISABLED !== "1";
}

export function sameUnitHuntMaxCandidates(): number {
  const n = Number(process.env.SAME_UNIT_PHOTO_HUNT_MAX_CANDIDATES);
  return Number.isFinite(n) && n >= 1 && n <= 10 ? Math.floor(n) : SAME_UNIT_HUNT_MAX_CANDIDATES_DEFAULT;
}

export function sameUnitHuntMinNewPhotos(): number {
  const n = Number(process.env.SAME_UNIT_PHOTO_HUNT_MIN_NEW);
  return Number.isFinite(n) && n >= 1 && n <= 20 ? Math.floor(n) : SAME_UNIT_HUNT_MIN_NEW_PHOTOS_DEFAULT;
}

function publicPhotoDir(folder: string): string {
  const safe = folder.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return path.resolve(process.cwd(), "client/public/photos", safe);
}

/**
 * Server-side anchor fallback: the client resolves the source URL via a GET
 * whose failures it swallows (returns null), so a transient transport blip at
 * click time would otherwise turn into a false-permanent "no saved source
 * listing" failure WITH the replace-unit recommendation. The folder's
 * _source.json is the durable single-writer record — read it directly.
 */
export async function readFolderSourceUrl(folder: string): Promise<string | null> {
  try {
    const raw = await fs.promises.readFile(path.join(publicPhotoDir(folder), "_source.json"), "utf8");
    const doc = JSON.parse(raw) as { sourceListing?: { url?: unknown } };
    const url = doc?.sourceListing?.url;
    return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
  } catch {
    return null;
  }
}

/**
 * Every dHash for the folder's CURRENT photos: photo_labels rows (hidden ones
 * included — a photo the operator hid is still a photo we've already seen, so
 * a candidate carrying it must count as duplicate, not new), compute-on-miss
 * from disk with best-effort backfill, plus unlabeled on-disk files hashed
 * directly so novelty is judged against the WHOLE gallery.
 */
export async function loadFolderPhotoHashes(folder: string): Promise<string[]> {
  const dir = publicPhotoDir(folder);
  const stat = await fs.promises.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) return [];
  const diskFiles = (await fs.promises.readdir(dir).catch(() => [] as string[]))
    .filter((f) => IMAGE_EXT.test(f))
    .sort()
    .slice(0, MAX_FOLDER_HASHES);
  const rows = await storage.getPhotoLabelsByFolder(folder).catch(() => []);
  const rowByFile = new Map(rows.map((row) => [row.filename, row]));
  const hashes: string[] = [];
  for (const filename of diskFiles) {
    const row = rowByFile.get(filename);
    let hash: string | null = row?.perceptualHash ?? null;
    if (!hash) {
      try {
        const buffer = await fs.promises.readFile(path.join(dir, filename));
        if (buffer.length > 0 && buffer.length <= MAX_LOCAL_IMAGE_BYTES) {
          hash = await computeDhash(buffer);
          if (row) await storage.updatePhotoLabelHash(folder, filename, hash).catch(() => {});
        }
      } catch {
        hash = null;
      }
    }
    if (hash) hashes.push(hash);
  }
  return hashes;
}

/** Fetch remote photo URLs (bounded) and dHash each; null = could not hash. */
export async function hashRemotePhotoUrls(
  urls: readonly string[],
  opts: { cap?: number; timeoutMs?: number; concurrency?: number } = {},
): Promise<(string | null)[]> {
  const cap = opts.cap ?? REMOTE_HASH_CAP;
  const timeoutMs = opts.timeoutMs ?? REMOTE_HASH_TIMEOUT_MS;
  const concurrency = Math.max(1, opts.concurrency ?? REMOTE_HASH_CONCURRENCY);
  const bounded = urls.slice(0, cap);
  const results: (string | null)[] = new Array(bounded.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < bounded.length) {
      const index = next;
      next += 1;
      const url = bounded[index];
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!resp.ok) continue;
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length === 0 || buf.length > MAX_REMOTE_IMAGE_BYTES) continue;
        results[index] = await computeDhash(buf);
      } catch {
        // null stays — unverified, never counted as new OR duplicate.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, bounded.length) }, worker));
  return results;
}

export interface SameUnitSerpSearchResult {
  rows: SameUnitSerpRow[];
  attempted: number;
  responded: number;
}

/** Run each hunt query through SearchAPI google SERP; failures per-query are soft. */
export async function searchSameUnitListingRows(queries: readonly string[]): Promise<SameUnitSerpSearchResult> {
  const rows: SameUnitSerpRow[] = [];
  let attempted = 0;
  let responded = 0;
  for (const query of queries) {
    attempted += 1;
    try {
      const params = new URLSearchParams({ engine: "google", q: query, num: "10" });
      const resp = await fetchSearchApiWithFallback(params, { signal: AbortSignal.timeout(20_000) });
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => {});
        continue;
      }
      const data = await resp.json().catch(() => null) as { organic_results?: unknown } | null;
      const organic = Array.isArray(data?.organic_results) ? data!.organic_results as Array<Record<string, unknown>> : [];
      responded += 1;
      for (const hit of organic) {
        rows.push({
          link: typeof hit?.link === "string" ? hit.link : null,
          title: typeof hit?.title === "string" ? hit.title : null,
          snippet: typeof hit?.snippet === "string" ? hit.snippet : null,
        });
      }
    } catch (e: any) {
      console.error(`[same-unit-hunt] SERP query failed (${query}): ${e?.message ?? e}`);
    }
  }
  return { rows, attempted, responded };
}

export interface SameUnitHuntGallery {
  photos: Array<{ url: string }>;
  sourceUrl: string | null;
  proofRejected: boolean;
  facts?: Record<string, unknown> | null;
  resolverProof?: Record<string, unknown> | null;
  diagnostic?: Record<string, unknown> | null;
}

export interface SameUnitHuntInput {
  /** The unit's saved source listing URL — the identity anchor. */
  currentSourceUrl: string | null | undefined;
  /** The unit's ACTIVE photo folder (novelty is judged against its photos). */
  currentFolder: string | null | undefined;
  /** Community street address — widens the SERP queries with unit-claim variants. */
  communityStreetAddress?: string | null;
  communityName: string;
  bedrooms: number;
  /** Exact listing URLs that may never be re-picked (current + sibling sources). */
  excludeUrls: readonly string[];
  /** Scrape one candidate URL's gallery (callers inject the loopback tiered scraper). */
  scrapeGallery: (url: string) => Promise<SameUnitHuntGallery | null>;
  progress?: (message: string, progressPct: number) => void;
}

export interface SameUnitHuntAccepted {
  outcome: "accepted";
  sourceUrl: string;
  portal: string;
  photos: Array<{ url: string }>;
  newPhotoCount: number;
  totalHashed: number;
  resolverProof: Record<string, unknown> | null;
  diagnostic: Record<string, unknown> | null;
  checked: SameUnitCheckedCandidate[];
}

export interface SameUnitHuntFailed {
  outcome: Exclude<SameUnitHuntOutcome, "accepted">;
  /** Only true when the hunt genuinely exhausted the search space. */
  recommendReplaceUnit: boolean;
  message: string;
  checked: SameUnitCheckedCandidate[];
}

export type SameUnitHuntResult = SameUnitHuntAccepted | SameUnitHuntFailed;

/**
 * The hunt: identity → SERP → same-unit filter → scrape+hash each candidate
 * (first ACCEPT wins — candidates are already identity-matched, and each
 * scrape can cost minutes). No gallery union ever happens: exactly one
 * candidate's gallery is returned for the caller to persist wholesale through
 * the existing single-writer paths.
 */
export async function runSameUnitPhotoHunt(input: SameUnitHuntInput): Promise<SameUnitHuntResult> {
  const progress = input.progress ?? (() => {});
  const minNewPhotos = sameUnitHuntMinNewPhotos();
  const failure = (
    outcome: Exclude<SameUnitHuntOutcome, "accepted">,
    checked: SameUnitCheckedCandidate[],
    recommendReplaceUnit: boolean,
    extras: { anchor?: "missing" | "unparseable"; searchIncomplete?: boolean } = {},
  ): SameUnitHuntFailed => ({
    outcome,
    recommendReplaceUnit,
    checked,
    message: summarizeSameUnitHuntFailure({
      outcome,
      bedrooms: input.bedrooms,
      communityName: input.communityName,
      checked,
      minNewPhotos,
      ...extras,
    }),
  });

  const folder = String(input.currentFolder ?? "").trim();
  // Server-side anchor fallback: the client's source-URL GET fails soft, so a
  // transport blip must not become a false-permanent "no saved source" +
  // replace recommendation. The folder's _source.json is authoritative.
  let anchorUrl = String(input.currentSourceUrl ?? "").trim();
  if (!anchorUrl && folder) anchorUrl = (await readFolderSourceUrl(folder)) ?? "";
  if (!anchorUrl) {
    // Permanent state (no anchor will appear without operator action) — the
    // honest advice IS "replace the unit or paste a URL", so the flag is set.
    return failure("no-anchor", [], true, { anchor: "missing" });
  }
  const identity = sameUnitHuntIdentity({ sourceUrl: anchorUrl });
  if (!identity) {
    // A source exists but its URL carries no parseable street identity —
    // also permanent, but the message must not claim "no saved source".
    return failure("no-anchor", [], true, { anchor: "unparseable" });
  }

  progress("Searching Zillow, Realtor, Redfin & Homes.com for this exact unit", 18);
  const queries = sameUnitHuntQueries(identity, input.communityStreetAddress);
  if (queries.length === 0) {
    // Defensive: identity requires a parsed address, which always yields
    // queries — but an empty sweep must never masquerade as "searched and
    // found nothing" OR as a retry-forever transient.
    return failure("no-anchor", [], true, { anchor: "unparseable" });
  }
  const serp = await searchSameUnitListingRows(queries);
  if (serp.responded === 0) {
    // Transient infra (quota blackout / no key) — NEVER push the operator
    // toward a destructive unit replacement off a failed search.
    return failure("search-unavailable", [], false);
  }
  const searchIncomplete = !sameUnitHuntSearchComplete(serp);

  const excludeKeys = canonicalKeysForExclusion([
    anchorUrl,
    ...(input.currentSourceUrl ? [input.currentSourceUrl] : []),
    ...input.excludeUrls,
  ]);
  const filtered = filterSameUnitSerpRows(serp.rows, identity, excludeKeys);
  if (filtered.candidates.length === 0) {
    // "No different photos exist" may only be asserted off a COMPLETE sweep;
    // a partial SERP outage keeps the replace recommendation off.
    return failure("no-candidates", [], !searchIncomplete, { searchIncomplete });
  }

  progress("Reading the current gallery's photo fingerprints", 30);
  const existingHashes = folder ? await loadFolderPhotoHashes(folder) : [];

  const maxCandidates = sameUnitHuntMaxCandidates();
  const candidates = filtered.candidates.slice(0, maxCandidates);
  const checked: SameUnitCheckedCandidate[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const base = 34 + Math.round((i / candidates.length) * 44);
    progress(`Checking this unit's listing on ${candidate.portal} (${i + 1}/${candidates.length})`, base);
    let gallery: SameUnitHuntGallery | null = null;
    try {
      gallery = await input.scrapeGallery(candidate.url);
    } catch (e: any) {
      console.error(`[same-unit-hunt] scrape failed ${candidate.url}: ${e?.message ?? e}`);
    }
    if (!gallery || gallery.photos.length === 0) {
      checked.push({ url: candidate.url, portal: candidate.portal, verdict: gallery ? "no-photos" : "scrape-failed" });
      continue;
    }
    if (gallery.proofRejected || gallery.photos.length < MIN_INDEPENDENT_UNIT_PHOTOS) {
      checked.push({
        url: candidate.url,
        portal: candidate.portal,
        verdict: "too-thin",
        totalCount: gallery.photos.length,
      });
      continue;
    }
    progress(`Comparing ${candidate.portal} photos against the current gallery (${i + 1}/${candidates.length})`, base + 6);
    const candidateHashes = await hashRemotePhotoUrls(gallery.photos.map((p) => p.url));
    const novelty = evaluateGalleryNovelty(existingHashes, candidateHashes);
    const verdict = sameUnitCandidateVerdict(novelty, {
      minPhotos: MIN_INDEPENDENT_UNIT_PHOTOS,
      minNewPhotos,
    });
    checked.push({
      url: candidate.url,
      portal: candidate.portal,
      verdict,
      newCount: novelty.newCount,
      totalCount: gallery.photos.length,
    });
    if (verdict === "accept") {
      return {
        outcome: "accepted",
        sourceUrl: gallery.sourceUrl || candidate.url,
        portal: candidate.portal,
        photos: gallery.photos,
        newPhotoCount: novelty.newCount,
        totalHashed: novelty.hashed,
        resolverProof: gallery.resolverProof ?? null,
        diagnostic: gallery.diagnostic ?? null,
        checked,
      };
    }
  }
  // Exhaustion is only PROVEN when the sweep completed AND every candidate
  // got a substantive verdict (duplicate-set / too-thin). Candidates that
  // died on scrape infra or unverifiable hashing prove nothing — the flag
  // stays off so a bot-wall/outage day can't push a destructive unit swap.
  const proven = !searchIncomplete && sameUnitHuntExhaustionProven(checked);
  return failure("exhausted", checked, proven, { searchIncomplete });
}
