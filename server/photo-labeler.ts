// Claude-vision photo captioner. Takes a local image file (from
// `client/public/photos/<folder>/<filename>`) and returns a short, accurate
// caption + category. Different prompts for community-amenity photos vs
// per-unit interior photos so the captions read naturally in both sections
// of the photo tab.
//
// Keeps calls bounded: max_tokens: 60, one image per call, no streaming.
// Expect ~1-3 seconds per photo wall-clock; cost ~$0.003 per image at
// Sonnet rates. Used by POST /api/admin/relabel-all-photos and (auto)
// by the community-photos/save path after new photos land on disk.

import fs from "fs";
import path from "path";

// Haiku 4.5 is plenty for short noun-phrase classification (room type +
// one feature) at ~5x lower cost than Sonnet — about $0.0005/photo vs
// $0.003/photo. The earlier Sonnet choice was over-spec for the task.
const MODEL = "claude-haiku-4-5-20251001";

export type PhotoKind = "community" | "unit";

export type PhotoLabelResult = {
  label: string;
  category: string;
  model: string;
};

function mimeTypeForExt(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

function promptFor(kind: PhotoKind): string {
  if (kind === "community") {
    // Community = resort amenities, grounds, building exteriors, beach
    // access. We want a short, accurate label (2-4 words) and a category
    // from a fixed vocabulary so the UI can group consistently.
    return [
      "This is a photo from a vacation rental resort (amenities, grounds, or exterior).",
      "Generate a short caption describing what the photo ACTUALLY SHOWS.",
      "",
      "Requirements:",
      "- 2-4 words, Title Case (e.g. \"Oceanfront Pool\", \"Beach Path\", \"Tennis Court\").",
      "- Describe the dominant subject. If the photo shows a rocky shoreline, DO NOT label it \"Tennis Court\" even if tennis is an amenity.",
      "- If ambiguous, prefer generic over specific (\"Resort Grounds\" over \"Infinity Pool\").",
      "",
      "Also pick one category from this exact list:",
      "Pool & Spa | Beach Access | Grounds & Landscaping | Building Exterior | Common Areas | Dining | Activities | Views",
      "",
      "Respond with ONLY a single line of minified JSON — no code fences, no prose:",
      "{\"label\":\"Oceanfront Pool\",\"category\":\"Pool & Spa\"}",
    ].join("\n");
  }
  // Unit = interior rooms + private outdoor space (lanai, balcony).
  return [
    "This is a photo from a vacation rental unit (interior or private outdoor space).",
    "Generate a short caption describing what the photo ACTUALLY SHOWS.",
    "",
    "Requirements:",
    "- 2-5 words, Title Case (e.g. \"Master Bedroom\", \"Living Room with Ocean View\", \"Updated Kitchen\", \"Primary Bathroom\", \"Lanai with Ocean View\").",
    "- Lead with the room type. Add one concrete distinguishing feature only when clearly visible (\"Kitchen with Island\", not \"Modern Kitchen\").",
    "- If you see a bed, it's a bedroom (not a \"sleeping area\"). If you see a toilet or shower, it's a bathroom.",
    "",
    "Also pick one category from this exact list:",
    "Living Areas | Bedrooms | Kitchen | Bathrooms | Dining | Outdoor & Lanai | Views | Building Exterior | Other",
    "",
    "Respond with ONLY a single line of minified JSON — no code fences, no prose:",
    "{\"label\":\"Master Bedroom\",\"category\":\"Bedrooms\"}",
  ].join("\n");
}

export async function labelPhoto(
  absolutePath: string,
  kind: PhotoKind,
  apiKey: string,
): Promise<PhotoLabelResult | null> {
  if (!apiKey) return null;
  if (!fs.existsSync(absolutePath)) return null;

  const buffer = await fs.promises.readFile(absolutePath);
  // Cap at 5MB — Claude's API has a 5MB per-image limit for base64.
  if (buffer.length > 5 * 1024 * 1024) return null;
  const mimeType = mimeTypeForExt(absolutePath);
  const base64 = buffer.toString("base64");
  const prompt = promptFor(kind);

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
        max_tokens: 100,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.warn(`[photo-labeler] ${path.basename(absolutePath)}: HTTP ${resp.status} ${body.slice(0, 200)}`);
      return null;
    }
    const data = await resp.json() as any;
    const text: string = data?.content?.[0]?.text ?? "";
    // Some replies wrap JSON in code fences despite the instruction — strip them.
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { label?: unknown; category?: unknown };
      const label = typeof parsed.label === "string" ? parsed.label.trim() : "";
      const category = typeof parsed.category === "string" ? parsed.category.trim() : "";
      if (!label) return null;
      return { label, category: category || "Other", model: MODEL };
    } catch {
      return null;
    }
  } catch (e: any) {
    console.warn(`[photo-labeler] ${path.basename(absolutePath)}: ${e?.message ?? e}`);
    return null;
  }
}

// Helper: infer the photo kind from its folder name. Community photo
// folders are prefixed with `community-` in our convention.
export function inferKindFromFolder(folder: string): PhotoKind {
  return folder.startsWith("community-") ? "community" : "unit";
}

// Helper: enumerate image files in a folder, sorted by filename (which
// is how the photo tab orders them). Filters out non-image files and the
// optional `_source.json` sidecar the scraper writes.
export async function listPhotoFiles(folderAbsPath: string): Promise<string[]> {
  if (!fs.existsSync(folderAbsPath)) return [];
  const entries = await fs.promises.readdir(folderAbsPath);
  return entries
    .filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f))
    .sort();
}
