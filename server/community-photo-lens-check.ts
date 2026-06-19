// Google Lens reverse-image verification for community-folder photos.

import fs from "fs";
import path from "path";
import { fetchSearchApiWithFallback, getSearchApiKey } from "./searchapi";
import { isStrongLensMatch } from "./photo-match-guardrails";
import { describeSearchApiHttpError } from "./photo-listing-scanner";
import {
  judgeCommunityPhotoFromLens,
  type LensEvidenceRow,
} from "../shared/community-photo-lens-logic";
import { communityNamesMatch } from "../shared/photo-community-check-logic";
import { communityAddressRuleForName } from "../shared/community-addresses";
import type { CommunityGroupResult, PhotoVerdict } from "./photo-community-check";

const LENS_TIMEOUT_MS = 45_000;
const LENS_DELAY_MS = 500;

const PUBLIC_HOST = (() => {
  if (process.env.PUBLIC_PHOTO_BASE_URL) return process.env.PUBLIC_PHOTO_BASE_URL.replace(/\/+$/, "");
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return "";
})();

export type CommunityLensSample = {
  id: string;
  folder: string;
  filename: string;
  caption?: string;
};

type LensCallResult =
  | { ok: true; rows: LensEvidenceRow[]; extraTexts: string[] }
  | { ok: false; error: string };

function publicPhotoUrl(folder: string, filename: string): string | null {
  if (!PUBLIC_HOST) return null;
  const safeFolder = folder.replace(/[^a-zA-Z0-9_-]+/g, "-");
  const safeFile = filename.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return `${PUBLIC_HOST}/photos/${safeFolder}/${encodeURIComponent(safeFile)}`;
}

function rowsFromLensPayload(data: any): { rows: LensEvidenceRow[]; extraTexts: string[] } {
  const rowsFrom = (source: string, list: any[] | undefined): LensEvidenceRow[] =>
    Array.isArray(list)
      ? list.map((row, idx) => ({
          title: row?.title ?? row?.name ?? row?.source?.title ?? "",
          snippet: row?.snippet ?? row?.description ?? row?.source?.snippet ?? "",
          link: row?.link ?? row?.url ?? row?.source_url ?? row?.source?.link ?? "",
          source,
          position: Number(row?.position ?? idx + 1),
        }))
      : [];

  const rows: LensEvidenceRow[] = [
    ...rowsFrom("visual", data?.visual_matches),
    ...rowsFrom("page", data?.pages_with_matching_images),
    ...rowsFrom("image", data?.image_results),
    ...rowsFrom("organic", data?.organic_results),
  ];

  if (data?.knowledge_graph) {
    const kg = data.knowledge_graph;
    rows.unshift({
      title: kg?.title ?? kg?.name ?? "",
      snippet: kg?.description ?? kg?.snippet ?? "",
      link: kg?.link ?? kg?.website ?? "",
      source: "knowledge_graph",
      position: 0,
    });
  }

  const extraTexts: string[] = [];
  const ai = data?.ai_overview;
  if (ai) {
    if (typeof ai.text === "string") extraTexts.push(ai.text);
    if (typeof ai.markdown === "string") extraTexts.push(ai.markdown);
    if (Array.isArray(ai.snippets)) {
      for (const s of ai.snippets) {
        if (typeof s?.text === "string") extraTexts.push(s.text);
        else if (typeof s === "string") extraTexts.push(s);
      }
    }
  }

  return { rows, extraTexts };
}

async function callGoogleLens(imageUrl: string, apiKey: string): Promise<LensCallResult> {
  if (!apiKey) {
    return { ok: false, error: "SEARCHAPI_API_KEY not configured" };
  }
  try {
    const params = new URLSearchParams({ engine: "google_lens", url: imageUrl });
    const resp = await fetchSearchApiWithFallback(params, {
      signal: AbortSignal.timeout(LENS_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, error: describeSearchApiHttpError(resp.status, body) };
    }
    const data = await resp.json();
    const { rows, extraTexts } = rowsFromLensPayload(data);
    const strong = rows.filter((row, idx) =>
      isStrongLensMatch(
        { title: row.title, link: row.link, snippet: row.snippet },
        row.source ?? "visual",
        row.position ?? idx + 1,
      ),
    );
    return { ok: true, rows: strong.length > 0 ? strong : rows.slice(0, 15), extraTexts };
  } catch (e: any) {
    const msg = e?.name === "AbortError"
      ? `Google Lens timed out after ${Math.round(LENS_TIMEOUT_MS / 1000)}s`
      : e?.message ?? String(e);
    return { ok: false, error: msg };
  }
}

export async function auditCommunityFolderViaLens(
  samples: CommunityLensSample[],
  photosTotal: number,
  expectedCommunity: string,
  groupMeta: { label: string; folder: string },
  options: { apiKey?: string; onProgress?: (checked: number, total: number) => void } = {},
): Promise<{ community: CommunityGroupResult | null; warning?: string }> {
  const apiKey = options.apiKey ?? getSearchApiKey();
  if (!apiKey) {
    return { community: null, warning: "SEARCHAPI_API_KEY not configured" };
  }

  const rule = communityAddressRuleForName(expectedCommunity);
  const city = rule?.city ?? "";

  const photoVerdicts: PhotoVerdict[] = [];
  const junk: CommunityGroupResult["junk"] = [];
  let lensFailures = 0;
  let checked = 0;

  for (const sample of samples) {
    const imageUrl = await lensImageUrlForFile(sample.folder, sample.filename);
    if (!imageUrl) {
      photoVerdicts.push({
        id: sample.id,
        folder: sample.folder,
        filename: sample.filename,
        caption: sample.caption,
        match: "no",
        reason: "Could not build a public photo URL for reverse image search.",
      });
      lensFailures++;
      continue;
    }

    const lens = await callGoogleLens(imageUrl, apiKey);
    checked++;
    options.onProgress?.(checked, samples.length);

    if (!lens.ok) {
      lensFailures++;
      photoVerdicts.push({
        id: sample.id,
        folder: sample.folder,
        filename: sample.filename,
        caption: sample.caption,
        match: "no",
        reason: lens.error,
      });
      if (checked < samples.length && LENS_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, LENS_DELAY_MS));
      }
      continue;
    }

    const verdict = judgeCommunityPhotoFromLens(expectedCommunity, lens.rows, lens.extraTexts, city);
    photoVerdicts.push({
      id: sample.id,
      folder: sample.folder,
      filename: sample.filename,
      caption: sample.caption,
      match: verdict.match,
      reason: verdict.reason,
      lensIdentifiedCommunity: verdict.identifiedCommunity,
    });

    if (checked < samples.length && LENS_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, LENS_DELAY_MS));
    }
  }

  const yesVerdicts = photoVerdicts.filter((v) => v.match === "yes");
  const noVerdicts = photoVerdicts.filter((v) => v.match === "no");
  const identifiedFromYes = yesVerdicts.find((v) => v.lensIdentifiedCommunity)?.lensIdentifiedCommunity;
  const identifiedFromNo = noVerdicts.find((v) => v.lensIdentifiedCommunity)?.lensIdentifiedCommunity;
  const identifiedCommunity = identifiedFromYes || identifiedFromNo || expectedCommunity;
  const matchesExpected: "yes" | "no" =
    noVerdicts.length === 0 && communityNamesMatch(identifiedCommunity, expectedCommunity)
      ? "yes"
      : noVerdicts.length === 0 && yesVerdicts.length > 0
      ? "yes"
      : "no";

  const outliers = noVerdicts.map((v) => ({
    id: v.id,
    caption: v.caption,
    reason: v.reason,
  }));

  let warning: string | undefined;
  if (lensFailures > 0) {
    warning = `${lensFailures} photo(s) could not be verified via Google Lens.`;
  }

  return {
    community: {
      role: "community",
      label: groupMeta.label,
      folder: groupMeta.folder,
      photosChecked: photoVerdicts.length,
      photosTotal,
      communityFingerprint: `Google Lens verification for ${expectedCommunity}`,
      identifiedCommunity,
      matchesExpected,
      matchReason:
        noVerdicts.length > 0
          ? `${noVerdicts.length} community photo(s) failed reverse image search.`
          : `All ${photoVerdicts.length} community photos confirmed via reverse image search.`,
      allSameCommunity: noVerdicts.length === 0,
      photoVerdicts,
      outliers,
      junk,
      confidence: noVerdicts.length === 0 ? 0.95 : 0.85,
      verificationMethod: "google_lens",
    },
    warning,
  };
}

/** Upload local bytes to ImgBB when public /photos URLs are unreachable (dev only). */
export async function uploadPhotoForLens(buffer: Buffer, filename: string): Promise<string | null> {
  const imgbbKey = process.env.IMGBB_API_KEY;
  if (!imgbbKey) return null;
  try {
    const resp = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `image=${encodeURIComponent(buffer.toString("base64"))}`,
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    return data?.data?.url ?? null;
  } catch {
    return null;
  }
}

export function publicPhotoDir(folder: string): string {
  const safe = folder.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return path.resolve(process.cwd(), "client/public/photos", safe);
}

export async function lensImageUrlForFile(
  folder: string,
  filename: string,
): Promise<string | null> {
  if (PUBLIC_HOST) {
    const direct = publicPhotoUrl(folder, filename);
    if (direct) return direct;
  }
  try {
    const abs = path.join(publicPhotoDir(folder), filename);
    const buffer = await fs.promises.readFile(abs);
    return uploadPhotoForLens(buffer, filename);
  } catch {
    return null;
  }
}
