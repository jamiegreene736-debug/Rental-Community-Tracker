// Fast vision screen for guest-page unit galleries.
//
// Scraped VRBO unit photos arrive as bare URLs with no captions/tags, so there
// is nothing to filter on cheaply. This module runs ONE Claude vision call per
// unit (at page-build time, not per render) to drop photos that would let a
// guest identify and look up the exact listing — primarily a legible building
// or unit number, a street address, or the property manager's logo/branding —
// plus obvious non-photos (maps, floor plans, screenshots, documents).
//
// Speed: uses Haiku and sends images BY URL (no download/encode). Callers run
// the per-unit calls in parallel. Conservative by design — when unsure it KEEPS,
// and if it would gut a gallery it no-ops so the coarse last-5 tail trim in the
// guest-page renderer still applies as a backstop.

// Sonnet, not Haiku, on purpose. Haiku was empirically inconsistent on this task
// (e.g. flagged [3,4] one run, [3,4,25] the next, and false-positived an interior
// bedroom) and missed the building-number exterior/entrance shots, so the leak
// photos survived. Sonnet returns the identifying shots reliably with no false
// positives. This is leak prevention, so reliability beats Haiku's speed.
const MODEL = "claude-sonnet-4-6";
// Bump this when the screening logic/model changes so already-built pages get
// re-screened on next render (see the lazy migration in routes.ts).
export const UNIT_PHOTO_VISION_VERSION = 2;
// Bound work so a huge gallery can't blow up latency/cost. Galleries are already
// capped at 40 upstream; this is a hard ceiling for the vision request.
const MAX_PHOTOS_TO_SCREEN = 45;
// Never let the screen leave a gallery emptier than this — if it would, treat it
// as over-flagging and no-op (the renderer's tail trim still runs).
const MIN_PHOTOS_AFTER_SCREEN = 4;

// A legible resolution is required to read a building/unit number off a sign — a
// thumbnail (e.g. VRBO's rw=297) makes the number unreadable and the screen
// misses it. VRBO/Expedia media URLs accept a resize policy, so normalize to a
// readable width for the vision request ONLY (the stored/displayed URLs are
// untouched). Non-VRBO hosts are sent as-is.
const sizeImageUrlForVision = (url: string): string =>
  /(?:vrbo|expedia|trvl-media|homeaway)\.com/i.test(url)
    ? `${url.split("?")[0]}?impolicy=resizecrop&rw=1200&ra=fit`
    : url;

export interface UnitPhotoFilterResult {
  /** URLs to keep, in original order. */
  kept: string[];
  /** How many were removed by the vision screen. */
  removedCount: number;
  /** True only when the vision screen actually ran and was applied. */
  filtered: boolean;
  warning?: string;
}

const httpUrls = (urls: Array<string | null | undefined>): string[] =>
  Array.from(new Set(
    urls.map((u) => String(u ?? "").trim()).filter((u) => /^https?:\/\//i.test(u)),
  ));

const parseRemoveIndices = (text: unknown, count: number): number[] => {
  const raw = String(text ?? "");
  // Be liberal: pull the first {...} or [...] blob and parse it.
  const objMatch = raw.match(/\{[\s\S]*\}/);
  const arrMatch = raw.match(/\[[\s\S]*\]/);
  let parsed: any = null;
  for (const candidate of [objMatch?.[0], arrMatch?.[0]]) {
    if (!candidate) continue;
    try { parsed = JSON.parse(candidate); break; } catch { /* try next */ }
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.remove) ? parsed.remove : [];
  const out = new Set<number>();
  for (const v of list) {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 0 && n < count) out.add(n);
  }
  return Array.from(out);
};

/**
 * Screen a unit's photo URLs and return the ones safe to show on the guest page.
 * Falls back to keeping everything (filtered=false) when there's no API key, the
 * call errors, or the result would gut the gallery.
 */
export async function filterNonRentalUnitPhotos(
  photoUrls: Array<string | null | undefined>,
): Promise<UnitPhotoFilterResult> {
  const urls = httpUrls(photoUrls);
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey || urls.length === 0) {
    return { kept: urls, removedCount: 0, filtered: false, warning: anthropicKey ? undefined : "ANTHROPIC_API_KEY not configured" };
  }
  const candidates = urls.slice(0, MAX_PHOTOS_TO_SCREEN);

  const content: any[] = [];
  candidates.forEach((url, i) => {
    content.push({ type: "text", text: `Photo ${i}:` });
    content.push({ type: "image", source: { type: "url", url: sizeImageUrlForVision(url) } });
  });
  content.push({
    type: "text",
    text:
      `You are screening photos for a vacation-rental listing gallery shown to a prospective guest. ` +
      `The guest must NOT be able to identify the exact property from a photo.\n\n` +
      `Return ONLY a JSON object: {"remove":[<photo numbers to remove>]}.\n\n` +
      `REMOVE a photo (list its number) if ANY of these is true:\n` +
      `- A building number, unit number, room number, or street address is legible in it (door plaques, building signs, address numbers, mailboxes).\n` +
      `- It shows a property-management or rental-company name, logo, watermark, or branding.\n` +
      `- It is a map, floor plan, site diagram, screenshot, QR code, business card, brochure, or document, or is mostly text rather than a real photo.\n\n` +
      `KEEP every genuine photo of the home itself — interior rooms, kitchen, bathrooms, the building/home exterior, lanai/patio, grounds, pool, beach, and views — as long as no identifying number, address, or company name is legible in it.\n` +
      `When you are unsure, KEEP the photo (only remove clear cases). Photo numbers are 0-based exactly as labeled above.`,
  });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 400, messages: [{ role: "user", content }] }),
    });
    const data = await response.json().catch(() => null) as any;
    if (!response.ok) throw new Error(data?.error?.message ?? `HTTP ${response.status}`);
    const removeIdx = new Set(parseRemoveIndices(data?.content?.[0]?.text, candidates.length));
    if (removeIdx.size === 0) {
      return { kept: urls, removedCount: 0, filtered: true };
    }
    // Keep screened photos not flagged + any beyond the screened window.
    const keptScreened = candidates.filter((_, i) => !removeIdx.has(i));
    const kept = [...keptScreened, ...urls.slice(candidates.length)];
    // Guard against over-flagging gutting the gallery — back off to the coarse
    // renderer trim instead of showing an almost-empty gallery.
    if (kept.length < MIN_PHOTOS_AFTER_SCREEN) {
      return { kept: urls, removedCount: 0, filtered: false, warning: "vision flagged too many; kept all" };
    }
    return { kept, removedCount: urls.length - kept.length, filtered: true };
  } catch (error: any) {
    return { kept: urls, removedCount: 0, filtered: false, warning: error?.message ?? String(error) };
  }
}
