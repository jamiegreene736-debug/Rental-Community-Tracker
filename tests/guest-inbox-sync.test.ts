import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  extractBodyFromRawEmail,
  parseGuestInboxEmailFromRaw,
  isGuestBookingAliasEmail,
  resolveGuestAliasEmail,
} from "../server/guest-inbox-sync";

console.log("guest-inbox-sync tests");

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── base64 MIME bodies must be DECODED, not stored as raw base64 garbage -----
// (VRBO/forwarded host emails are frequently base64-encoded; the previous parser
// only ran quoted-printable, so the stored body was "SGVsbG8..." and arrival-detail
// extraction silently failed.)
const plain = "Hello from the host! Your door code is 4242 and wifi is OceanView.";
const b64 = Buffer.from(plain, "utf8").toString("base64");

const multipartBase64 = [
  "Subject: Your booking",
  'Content-Type: multipart/alternative; boundary="bnd1"',
  "",
  "--bnd1",
  'Content-Type: text/plain; charset="utf-8"',
  "Content-Transfer-Encoding: base64",
  "",
  b64,
  "--bnd1--",
  "",
].join("\r\n");

assert.equal(
  extractBodyFromRawEmail(multipartBase64).trim(),
  plain,
  "multipart base64 text/plain part must decode to readable text",
);

// Single-part base64 (top-level CTE).
const singlePartBase64 = [
  "Subject: Hi",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: base64",
  "",
  b64,
  "",
].join("\r\n");
assert.equal(extractBodyFromRawEmail(singlePartBase64).trim(), plain, "single-part base64 must decode");

// Quoted-printable still works (no regression).
const qp = [
  "Subject: Hi",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Caf=C3=A9 by the beach",
  "",
].join("\r\n");
assert.equal(extractBodyFromRawEmail(qp).trim(), "Café by the beach", "quoted-printable still decodes");

// base64 HTML part is decoded AND stripped to text.
const htmlB64 = Buffer.from("<html><body><p>Check-in is <b>3pm</b></p></body></html>", "utf8").toString("base64");
const multipartHtmlOnly = [
  "Subject: x",
  'Content-Type: multipart/alternative; boundary="b2"',
  "",
  "--b2",
  "Content-Type: text/html; charset=utf-8",
  "Content-Transfer-Encoding: base64",
  "",
  htmlB64,
  "--b2--",
  "",
].join("\r\n");
assert.match(extractBodyFromRawEmail(multipartHtmlOnly), /Check-in is\s+3pm/, "base64 html decodes + strips tags");

// ── End-to-end parse: envelope alias + decoded body ------------------------
const fullRaw = [
  "X-SimpleLogin-Envelope-To: jane.doe.abc123@emailprivaccy.com",
  "From: VRBO Host <host@messages.vrbo.com>",
  "Subject: Welcome!",
  "Message-ID: <abc@vrbo>",
  'Content-Type: multipart/alternative; boundary="bnd1"',
  "",
  "--bnd1",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: base64",
  "",
  b64,
  "--bnd1--",
  "",
].join("\r\n");
const parsed = parseGuestInboxEmailFromRaw(fullRaw);
assert.ok(parsed, "raw email parses");
assert.equal(parsed!.aliasEmail, "jane.doe.abc123@emailprivaccy.com", "alias from envelope header");
assert.equal(parsed!.body.trim(), plain, "parsed body is decoded, not base64");
assert.equal(parsed!.messageId, "abc@vrbo", "message-id stripped of angle brackets");

// ── domain allowlist (NOT a typo bug): both spellings accepted -------------
assert.equal(isGuestBookingAliasEmail("a.b@emailprivaccy.com"), true, "real minting domain (double-c)");
assert.equal(isGuestBookingAliasEmail("a.b@emailprivacy.com"), true, "defensive alternate (single-c)");
assert.equal(isGuestBookingAliasEmail("a.b@gmail.com"), false, "non-alias domain rejected");

// resolveGuestAliasEmail prefers the envelope header over the visible To.
assert.equal(
  resolveGuestAliasEmail(
    { "x-simplelogin-envelope-to": "guest.x@emailprivaccy.com", "to": "reservations@magicalislandvacations.com" },
    "reservations@magicalislandvacations.com",
  ),
  "guest.x@emailprivaccy.com",
  "envelope-To wins over the visible reservations mailbox",
);

// ── Regression guard: the per-alias IMAP search must use the OBJECT header
// shape imapflow expects, NOT the broken two-element array (which compiled to
// HEADER 0 / HEADER 1 and matched nothing, forcing a 300-message full scan).
const srcPath = join(__dirname, "..", "server", "guest-inbox-sync.ts");
const src = readFileSync(srcPath, "utf8");
assert.match(
  src,
  /header:\s*\{\s*"X-SimpleLogin-Envelope-To":\s*alias\s*\}/,
  "IMAP search must pass header as an object { 'X-SimpleLogin-Envelope-To': alias }",
);
assert.doesNotMatch(
  src,
  /header:\s*\[\s*"X-SimpleLogin-Envelope-To"/,
  "the broken array-shaped header criteria must not return",
);

console.log("  ✓ guest-inbox-sync");
