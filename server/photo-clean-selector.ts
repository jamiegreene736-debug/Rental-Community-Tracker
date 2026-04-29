// Smart "clean photo" selector for the channel-photo-independence flow.
//
// Given a folder (e.g. "unit-621") and a target channel (e.g.
// "airbnb"), returns the subset of photos in that folder which are
// SAFE to push to the target channel — i.e. visually distinct from
// every photo currently active on that channel. Optionally also
// requires distinctness from photos active on the operator's other
// channels (`strictCrossChannelClean: true`), which prevents the
// new Airbnb set from being literally the same photos that are on
// the operator's own VRBO listing (a back-channel theft vector).
//
// The "currently active" set comes from photo_labels.channel_usage,
// updated by the push flows. The exclusion set is supplemented with
// `previousBadHashes` from photo_sync (the hashes of photos that
// triggered the original isolation) so we never re-publish the
// stolen photos to the same channel that flagged them.
//
// Hamming distance ≤ DUPLICATE_DISTANCE counts as a match (handles
// thieves cropping/recompressing).

import { storage } from "./storage";
import { hammingDistance, DUPLICATE_DISTANCE } from "./photo-hashing";
import type { PhotoLabel } from "@shared/schema";

export type Channel = "airbnb" | "vrbo" | "booking";
export const CHANNELS: Channel[] = ["airbnb", "vrbo", "booking"];

export type ChannelUsageState = {
  active: boolean;
  lastPushedAt: string | null;
};
export type ChannelUsage = Partial<Record<Channel, ChannelUsageState>>;

// Parse photo_labels.channel_usage (JSON-encoded). Returns an empty
// usage map for null/malformed input rather than throwing — callers
// treat unknown as "not active anywhere yet".
export function parseChannelUsage(raw: string | null | undefined): ChannelUsage {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as ChannelUsage;
  } catch { /* fall through */ }
  return {};
}

// Build the next channel_usage JSON for a photo when we're recording
// a successful push to `channel`. Preserves usage for OTHER channels.
export function bumpChannelUsage(
  current: string | null | undefined,
  channel: Channel,
  active: boolean,
  pushedAt: Date = new Date(),
): string {
  const usage = parseChannelUsage(current);
  usage[channel] = { active, lastPushedAt: pushedAt.toISOString() };
  return JSON.stringify(usage);
}

export type CleanSelectorOptions = {
  // When true, exclude photos that are active on ANY other channel
  // too (not just the target). Matches the spec's "strict clean
  // mode" — prevents re-using the operator's own VRBO photos for
  // their isolated Airbnb set.
  strictCrossChannelClean?: boolean;
  // Cap the result. Useful for matching a destination listing's
  // photo cap (Airbnb 100, Vrbo 50, Booking 40).
  maxResults?: number;
  // Override hash duplicate tolerance. Default is the project-wide
  // DUPLICATE_DISTANCE so the selector and scanner agree on what
  // "duplicate" means.
  tolerance?: number;
  // Extra hashes to exclude. Typically photoSync.previousBadHashes
  // (the photos that triggered the original isolation) so we never
  // re-publish them to the same channel.
  extraExcludedHashes?: string[];
};

export type CleanSelectorResult = {
  selected: PhotoLabel[];     // safe to push, in original sort order
  rejected: Array<{ row: PhotoLabel; reason: "no-hash" | "active-on-target" | "active-cross-channel" | "matches-bad-hash" }>;
  totalCandidates: number;
};

// Main entry point. Reads photo_labels for the folder, filters
// hidden rows, then partitions into selected vs rejected based on
// channel_usage + extraExcludedHashes.
export async function selectCleanPhotosForChannel(
  folder: string,
  targetChannel: Channel,
  opts: CleanSelectorOptions = {},
): Promise<CleanSelectorResult> {
  const tolerance = opts.tolerance ?? DUPLICATE_DISTANCE;
  const labels = await storage.getPhotoLabelsByFolder(folder);
  const visible = labels.filter((l) => !l.hidden);
  const result: CleanSelectorResult = { selected: [], rejected: [], totalCandidates: visible.length };

  // Build the exclusion hash set: every hash currently active on the
  // target channel, plus the explicit extra hashes (e.g. previous
  // bad hashes from the original isolation event).
  const excludedHashes = new Set<string>();
  for (const row of visible) {
    if (!row.perceptualHash) continue;
    const usage = parseChannelUsage(row.channelUsage);
    const target = usage[targetChannel];
    if (target?.active) excludedHashes.add(row.perceptualHash);
  }
  for (const h of opts.extraExcludedHashes ?? []) {
    if (h) excludedHashes.add(h);
  }

  // In strict mode, also exclude hashes active on other channels.
  // We don't ADD them to excludedHashes directly because we want to
  // distinguish the rejection reason in the result.
  const otherChannelActiveHashes = new Set<string>();
  if (opts.strictCrossChannelClean) {
    for (const row of visible) {
      if (!row.perceptualHash) continue;
      const usage = parseChannelUsage(row.channelUsage);
      for (const ch of CHANNELS) {
        if (ch === targetChannel) continue;
        if (usage[ch]?.active) {
          otherChannelActiveHashes.add(row.perceptualHash);
          break;
        }
      }
    }
  }

  for (const row of visible) {
    if (!row.perceptualHash) {
      result.rejected.push({ row, reason: "no-hash" });
      continue;
    }
    // Hash-vs-set checks use hamming distance so visually-identical
    // photos with different exact hashes (recompression noise) still
    // collide. O(n × m) — fine for portfolios up to a few thousand
    // photos per folder.
    const hashesMatch = (set: Set<string>): boolean => {
      const arr = Array.from(set);
      for (const h of arr) {
        if (hammingDistance(row.perceptualHash!, h) <= tolerance) return true;
      }
      return false;
    };
    if (hashesMatch(excludedHashes)) {
      result.rejected.push({
        row,
        reason: opts.extraExcludedHashes && opts.extraExcludedHashes.length > 0 && hashesMatch(new Set(opts.extraExcludedHashes))
          ? "matches-bad-hash"
          : "active-on-target",
      });
      continue;
    }
    if (opts.strictCrossChannelClean && hashesMatch(otherChannelActiveHashes)) {
      result.rejected.push({ row, reason: "active-cross-channel" });
      continue;
    }
    result.selected.push(row);
    if (opts.maxResults && result.selected.length >= opts.maxResults) break;
  }

  return result;
}
