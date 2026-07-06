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

// ── NESTED multipart (multipart/mixed → multipart/alternative) --------------
// The old parser regex-tested whole TOP-LEVEL parts for "content-type:
// text/plain", so the alternative wrapper matched via its inner part's header
// text and the stored body kept the INNER boundary + part headers as literal
// garbage (live incident: the Generali policy email on the Thien Tran alias).
// The Generali email also declares its part text/plain while shipping a full
// HTML document — that must be detected and stripped.
const generaliRaw = [
  "From: 0101019f@us-west-2.amazonses.com",
  "X-SimpleLogin-Envelope-To: thien.tran.4c015c@emailprivaccy.com",
  "Subject: Generali Policy #26186Z8458 for Thien Tran",
  "Message-ID: <gen-1@ses>",
  'Content-Type: multipart/mixed; boundary="----=_Part_0_99.11"',
  "",
  "------=_Part_0_99.11",
  'Content-Type: multipart/alternative; boundary="----=_Part_1_1270391341.1783316108108"',
  "",
  "------=_Part_1_1270391341.1783316108108",
  "Content-Type: text/plain; charset=us-ascii",
  "Content-Transfer-Encoding: 7bit",
  "",
  "<html><head><title>Generali Travel Protection Plan</title></head>",
  '<body><p>Insured:&#xa0;Thien Tran</p><p>Plan Number: 26186Z8458</p></body></html>',
  "------=_Part_1_1270391341.1783316108108",
  "Content-Type: text/html; charset=us-ascii",
  "Content-Transfer-Encoding: 7bit",
  "",
  "<html><body><p>Insured: Thien Tran</p></body></html>",
  "------=_Part_1_1270391341.1783316108108--",
  "",
  "------=_Part_0_99.11--",
  "",
].join("\r\n");

const generaliBody = extractBodyFromRawEmail(generaliRaw);
assert.ok(!generaliBody.includes("_Part_1_"), `nested boundary must not leak into the body: ${JSON.stringify(generaliBody.slice(0, 200))}`);
assert.ok(!/content-transfer-encoding/i.test(generaliBody), "part headers must not leak into the body");
assert.ok(!generaliBody.includes("<html"), "mislabeled text/plain HTML must be stripped to text");
assert.ok(!generaliBody.includes("Travel Protection Plan"), "head/title content must be stripped");
assert.match(generaliBody, /Insured:\s*Thien Tran/, "readable content survives (numeric entity decoded)");
assert.match(generaliBody, /Plan Number: 26186Z8458/, "policy number survives");

// A genuinely-plain part nested one level down is still preferred over HTML.
const nestedPlain = [
  "Subject: nested",
  'Content-Type: multipart/mixed; boundary="outer"',
  "",
  "--outer",
  'Content-Type: multipart/alternative; boundary="inner"',
  "",
  "--inner",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Aloha! Door code 4821.",
  "--inner",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<html><body><p>Aloha! Door code 4821.</p></body></html>",
  "--inner--",
  "--outer--",
  "",
].join("\r\n");
assert.equal(
  extractBodyFromRawEmail(nestedPlain).trim(),
  "Aloha! Door code 4821.",
  "nested text/plain part is found and preferred",
);

// An ATTACHED text file is not the message body.
const attachmentOnlyPlain = [
  "Subject: att",
  'Content-Type: multipart/mixed; boundary="bnd"',
  "",
  "--bnd",
  "Content-Type: text/plain; charset=utf-8",
  'Content-Disposition: attachment; filename="terms.txt"',
  "",
  "Long attached terms text.",
  "--bnd",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>See attached terms.</p>",
  "--bnd--",
  "",
].join("\r\n");
assert.match(extractBodyFromRawEmail(attachmentOnlyPlain), /See attached terms\./, "attachment part skipped, HTML body used");

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
