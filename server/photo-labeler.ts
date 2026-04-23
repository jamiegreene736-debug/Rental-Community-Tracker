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

// Sniff the actual format from the file's magic bytes. Some photos in the
// portfolio have the wrong extension (e.g. .jpg files that are really PNG)
// and Anthropic's vision API rejects when the declared media_type doesn't
// match. Falls back to the extension-based guess when no signature matches.
function detectImageMime(buffer: Buffer, filename: string): string {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buffer.length >= 6 && buffer.slice(0, 6).toString("ascii").startsWith("GIF87") || buffer.slice(0, 6).toString("ascii").startsWith("GIF89")) return "image/gif";
  return mimeTypeForExt(filename);
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
    "- 2-5 words, Title Case.",
    "- Lead with the room type. Add one concrete distinguishing feature when clearly visible.",
    "- **For Bedrooms**: identify the bed type in the label so downstream tooling can distinguish rooms.",
    "  Examples: \"King Bedroom\" (one king bed), \"Queen Bedroom\" (one queen bed), \"Twin Bedroom\" (two twin beds), \"Two Queens Bedroom\" (two queen beds), \"Bunk Bed Bedroom\". Do NOT label every bedroom \"Master Bedroom\" — that's post-processed.",
    "- **For Bathrooms**: note the distinguishing feature. Examples: \"Bathroom with Shower\", \"Bathroom with Tub\", \"Bathroom with Jetted Tub\", \"Half Bath\", \"Double Vanity Bathroom\".",
    "- For other rooms: \"Living Room with Ocean View\", \"Updated Kitchen\", \"Lanai with Ocean View\", etc.",
    "",
    "STRICT CATEGORY RULES — follow these exactly, do not infer rooms that aren't visible:",
    "- \"Reject\": **IMPORTANT** — use this category for photos that should NOT appear in a vacation rental listing:",
    "    • Portraits or headshots of people (real estate agents, hosts, property managers)",
    "    • Logos, watermarks, text-only images, floor plans, maps",
    "    • Generic stock photos (city skylines, food, unrelated scenery)",
    "    • Heavily branded marketing photos with overlaid text",
    "  If the photo shows a PERSON'S FACE as the primary subject, pick Reject. No exceptions.",
    "- \"Bedrooms\": ONLY if you can see an actual BED with a mattress, headboard, or bedding. A loveseat, couch, chaise, or day-bed alone is NOT a bedroom.",
    "- \"Bathrooms\": ONLY if you can see a toilet, shower, bathtub, or bathroom sink/vanity. A kitchen sink is NOT a bathroom.",
    "- \"Outdoor & Lanai\": covered/uncovered patios, balconies, decks, lanais — any space where you can see the outdoor environment (plants, trees, railings, open sky). Wicker outdoor furniture, ceiling fans over open-air spaces, and covered porches ALL belong here, NOT in Bedrooms.",
    "- \"Living Areas\": indoor living rooms, family rooms, great rooms with sofas and TVs, enclosed by indoor walls.",
    "- \"Kitchen\": cabinets, stove, fridge, prep space clearly visible.",
    "- \"Dining\": dining table as the main subject in an indoor setting.",
    "- \"Views\": aerial shots, property overviews, landscape-dominant exteriors without a specific room as subject.",
    "- \"Building Exterior\": photo of the outside of a building — facade, entrance, street view.",
    "- \"Other\": anything that genuinely doesn't fit the above.",
    "",
    "When in doubt between Bedrooms and Outdoor & Lanai: if you cannot identify a real bed, it is NOT a Bedroom.",
    "",
    "Also pick one category from this exact list:",
    "Reject | Living Areas | Bedrooms | Kitchen | Bathrooms | Dining | Outdoor & Lanai | Views | Building Exterior | Other",
    "",
    "Respond with ONLY a single line of minified JSON — no code fences, no prose:",
    "{\"label\":\"Master Bedroom\",\"category\":\"Bedrooms\"}",
  ].join("\n");
}

// One attempt at the vision call. Returns null on any failure (HTTP error,
// network timeout, unparseable response). Caller decides whether to retry.
async function labelPhotoOnce(
  filenameForLog: string,
  mimeType: string,
  base64: string,
  prompt: string,
  apiKey: string,
): Promise<PhotoLabelResult | null> {
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
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.warn(`[photo-labeler] ${filenameForLog}: HTTP ${resp.status} ${body.slice(0, 200)}`);
      return null;
    }
    const data = await resp.json() as any;
    const text: string = data?.content?.[0]?.text ?? "";
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as { label?: unknown; category?: unknown };
    const label = typeof parsed.label === "string" ? parsed.label.trim() : "";
    const category = typeof parsed.category === "string" ? parsed.category.trim() : "";
    if (!label) return null;
    return { label, category: category || "Other", model: MODEL };
  } catch (e: any) {
    console.warn(`[photo-labeler] ${filenameForLog}: ${e?.message ?? e}`);
    return null;
  }
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
  const mimeType = detectImageMime(buffer, absolutePath);
  const base64 = buffer.toString("base64");
  const prompt = promptFor(kind);
  const logName = path.basename(absolutePath);

  // One retry covers transient failures: network blips, 429s, an
  // occasional malformed JSON response. Without this, a single dropped
  // call leaves the photo with no label and it surfaces in the UI as
  // generic "Photo" — a real bed ends up uncategorized.
  const first = await labelPhotoOnce(logName, mimeType, base64, prompt, apiKey);
  if (first) return first;
  await new Promise((r) => setTimeout(r, 500));
  return labelPhotoOnce(logName, mimeType, base64, prompt, apiKey);
}

// Helper: infer the photo kind from its folder name. Community photo
// folders are prefixed with `community-` in our convention.
export function inferKindFromFolder(folder: string): PhotoKind {
  return folder.startsWith("community-") ? "community" : "unit";
}

// Classify a photo straight from its URL, without writing to disk. Used
// by the replacement-finder to sample candidate listings cheaply.
export async function labelPhotoFromUrl(
  url: string,
  kind: PhotoKind,
  apiKey: string,
): Promise<PhotoLabelResult | null> {
  if (!apiKey || !url) return null;
  try {
    const imgResp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; VacationRentalBot/1.0)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!imgResp.ok) return null;
    const buffer = Buffer.from(await imgResp.arrayBuffer());
    if (buffer.length < 5000 || buffer.length > 5 * 1024 * 1024) return null;
    const mimeType = detectImageMime(buffer, url.split("?")[0]);
    const base64 = buffer.toString("base64");
    const prompt = promptFor(kind);

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
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    const text: string = data?.content?.[0]?.text ?? "";
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as { label?: unknown; category?: unknown };
    const label = typeof parsed.label === "string" ? parsed.label.trim() : "";
    const category = typeof parsed.category === "string" ? parsed.category.trim() : "";
    if (!label) return null;
    return { label, category: category || "Other", model: MODEL };
  } catch {
    return null;
  }
}

// Decide whether a Zillow listing's photo set actually contains interior
// private-space photography (bedrooms or bathrooms), using 8 stratified
// samples — or all photos if the set is sparse. Accepts bathrooms as
// positive evidence because bathroom shots almost always accompany
// bedroom shots (sellers photograph them together), which cuts false
// negatives for single-bedroom listings where the one bedroom photo
// might fall between our sample positions.
//
// Returns:
//   "pass"      — at least one sample is a bedroom or bathroom
//   "reject"    — confident no interior private spaces in this listing
//   "unknown"   — no ANTHROPIC_API_KEY, can't determine; caller should default to pass
export async function probeInteriorCoverage(
  photoUrls: string[],
  apiKey: string,
): Promise<{ verdict: "pass" | "reject" | "unknown"; categories: string[] }> {
  if (!apiKey) return { verdict: "unknown", categories: [] };
  if (photoUrls.length === 0) return { verdict: "reject", categories: [] };

  // Sparse listing → label all of them. Rich listing → 8 stratified samples.
  const indices = photoUrls.length <= 15
    ? photoUrls.map((_, i) => i)
    : Array.from({ length: 8 }, (_, i) => Math.floor((photoUrls.length * i) / 8));

  const sampleUrls = Array.from(new Set(indices.map((i) => photoUrls[i])));
  const results = await Promise.all(sampleUrls.map((u) => labelPhotoFromUrl(u, "unit", apiKey)));
  const categories = results.map((r) => r?.category ?? "").filter((c) => c);
  const hasInterior = categories.some((c) => c === "Bedrooms" || c === "Bathrooms");
  return { verdict: hasInterior ? "pass" : "reject", categories };
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
