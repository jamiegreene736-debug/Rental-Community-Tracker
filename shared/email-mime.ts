// Pure MIME-message text extraction, shared by TWO consumers:
//
// 1. Server ingest — server/guest-inbox-sync.ts `extractBodyFromRawEmail`
//    (and via it server/buy-in-email-sync.ts) parses raw IMAP mail into the
//    readable body stored in guest_inbox_messages / buy_in_emails.
// 2. Client display healing — shared/email-body-format.ts unwraps rows that
//    were STORED as raw MIME fragments (boundary lines + part headers) before
//    nested-multipart parsing existed, so old rows render readable without a
//    re-import.
//
// Because consumer 2 runs in the browser, nothing here may hard-require Node
// globals: Buffer usage is typeof-guarded with an atob/TextDecoder fallback.

export type MimeTextCandidate = { kind: "plain" | "html"; text: string };

const MIME_MAX_DEPTH = 6;
const BODY_CHAR_CAP = 500_000;

export function parseEmailHeaders(raw: string): Record<string, string> {
  const headerBlock = raw.split(/\r?\n\r?\n/)[0] ?? "";
  const headers: Record<string, string> = {};
  let currentName = "";
  for (const line of headerBlock.split(/\r?\n/)) {
    if (/^\s/.test(line) && currentName) {
      headers[currentName] += ` ${line.trim()}`;
      continue;
    }
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    currentName = match[1].trim().toLowerCase();
    headers[currentName] = match[2].trim();
  }
  return headers;
}

function bytesToUtf8(bytes: number[]): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("utf8");
  return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

function base64ToUtf8(b64: string): string {
  const cleaned = b64.replace(/\s+/g, "");
  if (typeof Buffer !== "undefined") return Buffer.from(cleaned, "base64").toString("utf8");
  const bin = atob(cleaned);
  const bytes: number[] = new Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytesToUtf8(bytes);
}

export function decodeQuotedPrintable(input: string): string {
  // Drop soft line breaks, then decode RUNS of =XX hex escapes as raw bytes and
  // UTF-8-decode them together — so multi-byte sequences (=C3=A9 -> é) render
  // correctly instead of as Latin-1 mojibake (CafÃ©).
  return input
    .replace(/=\r?\n/g, "")
    .replace(/(?:=[0-9A-Fa-f]{2})+/g, (seq) => {
      const bytes = seq.split("=").filter(Boolean).map((h) => parseInt(h, 16));
      return bytesToUtf8(bytes);
    });
}

// Decode a MIME part body by its own Content-Transfer-Encoding. VRBO/forwarded
// host emails are frequently base64-encoded; without this the body was stored as
// raw base64 garbage ("SGVsbG8...") and arrival-detail extraction silently failed.
export function decodeByTransferEncoding(body: string, contentTransferEncoding?: string): string {
  const enc = String(contentTransferEncoding ?? "").trim().toLowerCase();
  if (enc === "base64") {
    try {
      return base64ToUtf8(body);
    } catch {
      return body;
    }
  }
  if (enc === "quoted-printable") return decodeQuotedPrintable(body);
  // 7bit / 8bit / binary / none — but quoted-printable markers can appear even
  // without a declared CTE, so run the (idempotent on plain text) QP decoder.
  return decodeQuotedPrintable(body);
}

function codePointToChar(codePoint: number): string {
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}

// HTML → text that PRESERVES the email's line structure. Block-level tags and
// <br> become newlines (an operator reading a long PM confirmation in the alias
// email history needs the paragraphs the sender wrote); only horizontal
// whitespace is collapsed. The old version collapsed ALL whitespace to single
// spaces, which stored long HTML emails as one unreadable clump —
// shared/email-body-format.ts reflows those legacy rows at display time.
export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:br|hr)[^>]*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr|table|h[1-6]|li|ul|ol|blockquote|pre|section|article|header|footer)>/gi, "\n")
    .replace(/<(?:p|div|tr|h[1-6]|li|blockquote)(?:\s[^>]*)?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/gi, "'")
    // Numeric character references (&#xa0; &#8217; …) — Aspose/Word-generated
    // policy emails are full of them.
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex: string) => codePointToChar(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/g, (_, dec: string) => codePointToChar(parseInt(dec, 10)))
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Some senders declare a part text/plain but ship a full HTML document inside
// it (e.g. Aspose-generated Generali policy emails). Only whole-document
// markers count — a plain-text email that merely mentions a tag stays plain.
function looksLikeHtmlContent(text: string): boolean {
  return /<!doctype\s+html|<html[\s>]|<body[\s>]/i.test(text.slice(0, 1000));
}

// Split a multipart body into its parts. Segment 0 (the preamble before the
// first delimiter) is dropped; the closing "--boundary--" terminator ends the
// walk (everything after it is epilogue).
function splitMimeParts(body: string, boundary: string): string[] {
  const segments = body.split(`--${boundary}`);
  const parts: string[] = [];
  for (const segment of segments.slice(1)) {
    if (segment.startsWith("--")) break;
    parts.push(segment.replace(/^[ \t]*\r?\n/, ""));
  }
  return parts;
}

/**
 * Walk a raw MIME message (or a single part) and collect every renderable
 * text part, RECURSING into nested multiparts. The previous parser regex-tested
 * whole top-level parts for "content-type: text/plain", so a nested
 * multipart/alternative part matched via its INNER part's header text and the
 * stored body kept the inner boundary + headers as literal garbage — the exact
 * bug this walk replaces.
 */
export function collectMimeTextCandidates(
  raw: string,
  depth = 0,
  out: MimeTextCandidate[] = [],
): MimeTextCandidate[] {
  const headers = parseEmailHeaders(raw);
  const contentType = headers["content-type"] || "text/plain";
  const splitAt = raw.search(/\r?\n\r?\n/);
  const body = splitAt >= 0 ? raw.slice(splitAt).replace(/^\r?\n\r?\n/, "") : "";

  if (/multipart\//i.test(contentType) && depth < MIME_MAX_DEPTH) {
    const boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/i);
    if (boundaryMatch) {
      for (const part of splitMimeParts(body, boundaryMatch[1])) {
        collectMimeTextCandidates(part, depth + 1, out);
      }
      return out;
    }
  }

  // Attachments — even text/plain ones like an attached .txt — are not the
  // message body.
  if (/attachment/i.test(headers["content-disposition"] ?? "")) return out;

  const isPlainType = /text\/plain/i.test(contentType);
  const isHtmlType = /text\/html/i.test(contentType);
  if (!isPlainType && !isHtmlType) return out;

  const decoded = decodeByTransferEncoding(body.trim(), headers["content-transfer-encoding"]);
  if (!decoded.trim()) return out;
  out.push({ kind: isHtmlType || looksLikeHtmlContent(decoded) ? "html" : "plain", text: decoded });
  return out;
}

/**
 * The readable body of a raw MIME email: the first genuinely-plain text part,
 * else the first HTML part stripped to text, else "".
 */
export function extractReadableTextFromMimeEmail(raw: string): string {
  const candidates = collectMimeTextCandidates(raw);
  const plain = candidates.find((c) => c.kind === "plain");
  if (plain) return plain.text.slice(0, BODY_CHAR_CAP);
  const html = candidates.find((c) => c.kind === "html");
  if (html) return stripHtml(html.text).slice(0, BODY_CHAR_CAP);
  return "";
}
