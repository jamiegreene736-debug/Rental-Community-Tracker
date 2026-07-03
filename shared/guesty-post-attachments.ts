// Pure extraction of photo/file attachments from a Guesty inbox-v2 conversation
// post, so the Guest Inbox can actually SHOW the photos a guest sends through
// their OTA channel (VRBO/Airbnb/Booking.com). Before this existed the thread
// renderer displayed only the post's text body — a guest photo message arrived
// as a post with an `attachments` array (and/or an <img>/bare media URL inside
// the body) and rendered as an empty bubble, so the operator never saw the
// photo ("not downloading the photos", operator-reported 2026-07-03).
//
// Defensive by design: Guesty does not document a single attachment shape, so
// this accepts strings, objects with any of the common URL keys, and arrays
// under any of the common collection keys, plus URLs embedded in the body HTML/
// text. Keep this file zero-dependency (no server/client imports) — it is unit
// tested in tests/guesty-post-attachments.test.ts.

export type PostAttachment = {
  url: string;
  name?: string;
  isImage: boolean;
};

// Collection keys a post (or its metadata) may store attachments under.
const COLLECTION_KEYS = ["attachments", "media", "images", "files", "photos", "pictures"] as const;
// Nested containers worth one level of descent (Guesty nests message payloads).
const NESTED_KEYS = ["meta", "message", "post", "data"] as const;
// URL-bearing keys on an attachment object, in preference order.
const URL_KEYS = [
  "url", "href", "src", "link", "location", "downloadUrl", "download_url",
  "imageUrl", "image_url", "mediaUrl", "media_url", "thumbnailUrl", "thumbnail_url", "thumbnail",
] as const;
const NAME_KEYS = ["filename", "fileName", "name", "title", "originalName"] as const;
const TYPE_KEYS = ["contentType", "content_type", "mimeType", "mime_type", "type"] as const;

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|heic|heif|bmp|avif|tiff?)(?:[?#]|$)/i;
// Media CDNs the big OTA channels + Guesty serve guest photos from. These URLs
// often have no file extension (signed/opaque paths), so the host is the image
// signal.
const IMAGE_HOST_RE = /(?:^|\.)((?:assets|storage|cdn|files|media|images?|photos?)\.guesty(?:usercontent)?\.com|muscache\.com|media\.vrbo\.com|images\.trvl-media\.com|[a-z0-9-]+\.bstatic\.com|guestyusercontent\.com)/i;

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export function looksLikeImageUrl(url: string, contentType?: string | null): boolean {
  if (String(contentType ?? "").toLowerCase().startsWith("image/")) return true;
  const u = String(url ?? "");
  if (IMAGE_EXT_RE.test(u)) return true;
  try {
    const host = new URL(u).hostname;
    return IMAGE_HOST_RE.test(host);
  } catch {
    return false;
  }
}

function attachmentFromValue(value: unknown): PostAttachment | null {
  if (typeof value === "string") {
    const url = value.trim().replace(/[.,;:!?]+$/, "");
    if (!isHttpUrl(url)) return null;
    return { url, isImage: looksLikeImageUrl(url) };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  let url = "";
  for (const key of URL_KEYS) {
    const raw = obj[key];
    if (typeof raw === "string" && isHttpUrl(raw)) { url = raw.trim(); break; }
  }
  // One nested hop (e.g. { file: { url } }).
  if (!url) {
    for (const nestedKey of ["file", "image", "photo", "media"]) {
      const nested = obj[nestedKey];
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        for (const key of URL_KEYS) {
          const raw = (nested as Record<string, unknown>)[key];
          if (typeof raw === "string" && isHttpUrl(raw)) { url = raw.trim(); break; }
        }
      }
      if (url) break;
    }
  }
  if (!url) return null;
  let name: string | undefined;
  for (const key of NAME_KEYS) {
    const raw = obj[key];
    if (typeof raw === "string" && raw.trim()) { name = raw.trim(); break; }
  }
  let contentType: string | null = null;
  for (const key of TYPE_KEYS) {
    const raw = obj[key];
    // `type` can be a channel discriminator ("image"/"file") rather than a MIME
    // type — accept it only when it looks type-ish.
    if (typeof raw === "string" && /^(image|video|audio|application|text)\b/i.test(raw.trim())) {
      contentType = raw.trim().toLowerCase() === "image" ? "image/*" : raw.trim();
      break;
    }
  }
  return { url, name, isImage: looksLikeImageUrl(url, contentType) };
}

function collectFromCollections(node: unknown, out: PostAttachment[], depth: number): void {
  if (!node || typeof node !== "object" || depth > 2) return;
  const obj = node as Record<string, unknown>;
  for (const key of COLLECTION_KEYS) {
    const rows = obj[key];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const att = attachmentFromValue(row);
      if (att) out.push(att);
    }
  }
  for (const key of NESTED_KEYS) {
    collectFromCollections(obj[key], out, depth + 1);
  }
}

// Image URLs embedded in the post body: <img src="..."> tags (HTML bodies) plus
// bare media-looking URLs in plain text.
function collectFromBody(rawBody: string, out: PostAttachment[]): void {
  const body = String(rawBody ?? "");
  if (!body) return;
  for (const match of Array.from(body.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi))) {
    const url = match[1]?.trim();
    if (url && isHttpUrl(url)) out.push({ url, isImage: true });
  }
  for (const match of Array.from(body.matchAll(/https?:\/\/[^\s<>"')\]]+/gi))) {
    const url = match[0].replace(/[.,;:!?]+$/, "");
    if (looksLikeImageUrl(url)) out.push({ url, isImage: true });
  }
}

/**
 * All attachments on a Guesty conversation post, deduped by URL. Images first
 * (they render as inline photos; other files render as download links).
 */
export function collectPostAttachments(post: unknown): PostAttachment[] {
  const found: PostAttachment[] = [];
  collectFromCollections(post, found, 0);
  const obj = (post && typeof post === "object" ? post : {}) as Record<string, unknown>;
  const rawBody = String(obj.body ?? obj.text ?? obj.message ?? "");
  collectFromBody(rawBody, found);

  const seen = new Set<string>();
  const deduped: PostAttachment[] = [];
  for (const att of found) {
    const key = att.url;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(att);
  }
  return [...deduped.filter((a) => a.isImage), ...deduped.filter((a) => !a.isImage)];
}

/**
 * Strip attachment URLs back out of the display body so a photo message whose
 * body is JUST the media URL doesn't render the raw link above the photo.
 * Returns "" when nothing but attachment URLs (and whitespace) remains.
 */
export function bodyWithoutAttachmentUrls(body: string, attachments: PostAttachment[]): string {
  let out = String(body ?? "");
  for (const att of attachments) {
    while (out.includes(att.url)) out = out.replace(att.url, "");
  }
  out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return out;
}
