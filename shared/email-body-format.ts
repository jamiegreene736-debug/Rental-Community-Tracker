// Display-time formatting for stored alias-email bodies (buy_in_emails /
// guest_inbox_messages). Two jobs:
//
// 1. Bodies stored BEFORE 2026-07-05 came through a stripHtml() that collapsed
//    every newline into a single space, so long HTML confirmations (e.g. the
//    WaikikiBeachRentals booking-info email) render as one unreadable clump.
//    Those rows are immutable history — we can't re-parse the original HTML —
//    so reflowClumpedEmailBody() heuristically restores line structure by
//    breaking before "Label:" phrases ("Guest's Name:", "WiFi Password:", …).
//
// 2. Bodies stored BEFORE nested-multipart parsing (2026-07-06) can be a raw
//    MIME fragment — a boundary line + part headers + (often) raw HTML — when
//    the email nested multipart/alternative inside multipart/mixed (e.g. the
//    Generali policy email). Those rows are healed at display time by
//    extractReadableFromStoredMimeBody(), which reuses the shared MIME walk.
//
// 3. Bodies stored after the stripHtml fix keep their real newlines and pass
//    through untouched (aside from trimming runaway blank-line runs).
//
// Pure (browser-safe, no Node-only globals) so both client render sites and
// tests can import it.

import { extractReadableTextFromMimeEmail } from "./email-mime";

/** True when a body was stored with its line structure collapsed away. */
export function looksClumpedEmailBody(body: string): boolean {
  const text = String(body ?? "");
  if (text.length < 240) return false;
  const newlines = (text.match(/\n/g) ?? []).length;
  // A real multi-paragraph email of this length has far more than one line
  // break per ~800 chars; a flattened one has zero (or a stray one or two).
  return newlines <= Math.floor(text.length / 800);
}

// Small lowercase words allowed INSIDE a label phrase ("Checking In and Door
// Code Instructions:") but never as its first word.
const LABEL_CONNECTORS = new Set(["and", "of", "the", "to", "for", "in", "out", "a", "at", "&"]);
const LABEL_MAX_WORDS = 7;

/**
 * Heuristically restore line breaks in a body whose newlines were collapsed.
 *
 * A "label" is a run of capitalized words (small connectors allowed inside)
 * that ends at a ":" followed by a space — the field headings PM confirmation
 * emails are built from ("Arrival Date:", "WiFi Password:"). For each such
 * colon we walk BACKWARD collecting label words (stopping at digits,
 * punctuation, or lowercase prose, so "options. Parking:" breaks cleanly) and
 * insert a newline before the label. When a possessive appears mid-run
 * ("Thien Tran Guest's Phone:") the label starts at the possessive, so a
 * preceding name/value isn't dragged onto the label's line. URLs (no space
 * after ":"), times ("3:30"), and lowercase prose colons never match.
 * Capitalized value tails without such a cue ("Ilikai Unit Number:") do ride
 * along — an accepted trade-off of not having the original HTML.
 */
export function reflowClumpedEmailBody(body: string): string {
  const text = String(body ?? "");
  const breakAt: number[] = [];

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ":") continue;
    if (text[i + 1] !== " " || !text[i + 2] || text[i + 2] === " ") continue;
    // End of the label phrase (tolerate one space before the colon: "Times :").
    let end = i;
    if (text[end - 1] === " ") end -= 1;

    const windowStart = Math.max(0, end - 200);
    const words = text.slice(windowStart, end).split(" ");
    const collected: string[] = [];
    for (let k = words.length - 1; k >= 0 && collected.length < LABEL_MAX_WORDS; k--) {
      const w = words[k];
      if (/^[A-Z][A-Za-z'’-]*$/.test(w)) {
        collected.unshift(w);
        continue;
      }
      if (collected.length > 0 && LABEL_CONNECTORS.has(w)) {
        collected.unshift(w);
        continue;
      }
      break;
    }
    while (collected.length > 0 && LABEL_CONNECTORS.has(collected[0])) collected.shift();
    if (collected.length === 0) continue;

    // A mid-run possessive marks where the label really starts.
    const possessiveIdx = collected.findIndex((w) => /['’]s$/i.test(w));
    const labelWords = possessiveIdx > 0 ? collected.slice(possessiveIdx) : collected;

    const startIdx = end - labelWords.join(" ").length;
    if (startIdx <= 0 || text[startIdx - 1] !== " ") continue; // start of body / mid-word
    breakAt.push(startIdx);
  }

  if (breakAt.length === 0) return text;
  let out = text;
  for (const idx of Array.from(new Set(breakAt)).sort((a, b) => b - a)) {
    // Replace the space before the label with a newline.
    out = `${out.slice(0, idx - 1)}\n${out.slice(idx)}`;
  }
  return out;
}

/**
 * Heal a body that was STORED as a raw MIME fragment (nested-multipart emails
 * imported before 2026-07-06): first non-blank line is a boundary delimiter
 * ("------=_Part_1_…") and a Content-Type part header follows. Wraps the
 * fragment in a synthetic multipart header and reuses the shared MIME walk, so
 * part headers/boundaries are dropped and mislabeled-HTML content is stripped
 * to text. Returns null when the body is not such a fragment (the normal case)
 * or nothing readable could be extracted. Display only — never re-stored.
 */
export function extractReadableFromStoredMimeBody(body: string): string | null {
  const text = String(body ?? "").trimStart();
  const firstLine = (text.split(/\r?\n/, 1)[0] ?? "").trim();
  // A boundary delimiter is "--" + a non-trivial token; signature dashes
  // ("-- ") and dashes-only divider lines don't qualify.
  if (!/^--\S{2,}$/.test(firstLine) || !/[A-Za-z0-9]/.test(firstLine)) return null;
  if (!/^content-type:/im.test(text.slice(0, 4000))) return null;
  const boundary = firstLine.slice(2);
  const synthetic = `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${text}`;
  const extracted = extractReadableTextFromMimeEmail(synthetic).trim();
  return extracted || null;
}

/**
 * What the alias-email history panels render inside their whitespace-pre-wrap
 * body block. Never used for storage, parsing, or dedup — display only.
 */
export function formatEmailBodyForDisplay(body: string): string {
  const text = String(body ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return text;
  const healed = extractReadableFromStoredMimeBody(text) ?? text;
  const flowed = looksClumpedEmailBody(healed) ? reflowClumpedEmailBody(healed) : healed;
  return flowed.replace(/\n{3,}/g, "\n\n").trim();
}

/** "Jul 7, 2026, 3:15 PM"-style stamp for the email header block; null-safe. */
export function formatEmailTimestampForDisplay(sentAt: string | Date | null | undefined): string | null {
  if (!sentAt) return null;
  const date = sentAt instanceof Date ? sentAt : new Date(sentAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
