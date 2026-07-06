import assert from "node:assert";
import {
  extractReadableFromStoredMimeBody,
  formatEmailBodyForDisplay,
  formatEmailTimestampForDisplay,
  looksClumpedEmailBody,
  reflowClumpedEmailBody,
} from "../shared/email-body-format";
import { extractBodyFromRawEmail } from "../server/guest-inbox-sync";

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

console.log("email-body-format tests");

// ── looksClumpedEmailBody ────────────────────────────────────────────────────

run("short bodies are never clumped", () => {
  assert.strictEqual(looksClumpedEmailBody("Aloha, the door code is 4821."), false);
});

run("long single-line body IS clumped", () => {
  const body = "Reservation Summary Guest's Name: Thien Tran ".repeat(30);
  assert.strictEqual(looksClumpedEmailBody(body), true);
});

run("long body with real paragraph structure is NOT clumped", () => {
  const body = Array.from({ length: 40 }, (_, i) => `Line ${i} of the confirmation email with details.`).join("\n");
  assert.strictEqual(looksClumpedEmailBody(body), false);
});

// ── reflowClumpedEmailBody ───────────────────────────────────────────────────

const WAIKIKI_CLUMP =
  "Print and take with you to Hawaii Aloha Thien Tran Thank you for your reservation. " +
  "Reservation Summary Guest's Name: Thien Tran Guest's Phone: 8084606509 " +
  "Arrival Date: 3 p.m. Tuesday, July 07, 2026 Departure Date: 11 a.m. Sunday, July 12, 2026 " +
  "Location: 1777 Ala Moana Blvd, Honolulu, Oahu, Hawaii, United States, 96815 Building: Ilikai Unit Number: 1834 " +
  "Condo Door Code: 6969 WiFi Network Name: SSID network name located on modem. " +
  "WiFi Password: Password located on modem. Owner's Name: Eri Yoshitama " +
  "The rate is $27 to $33 dollars, plus tip, which $3-$5 is routine. " +
  "Read our FAQ page at www.WaikikiBeachRentals.com/faq.jsp for late check out options. " +
  "Parking: Valet Parking is $45 per day.";

run("breaks before Label: field headings", () => {
  const out = reflowClumpedEmailBody(WAIKIKI_CLUMP);
  for (const label of [
    "Guest's Name:",
    "Guest's Phone:",
    "Arrival Date:",
    "Departure Date:",
    "Location:",
    "Condo Door Code:",
    "WiFi Network Name:",
    "WiFi Password:",
    "Owner's Name:",
    "Parking:",
  ]) {
    assert.ok(out.includes(`\n${label} `), `expected line break before "${label}"`);
  }
  // Known trade-off: a capitalized value tail with no possessive/digit cue
  // rides along on the label's line ("Building: Ilikai" + "Unit Number:").
  assert.ok(out.includes("\nIlikai Unit Number: 1834"), "expected Unit Number on its own line (with the Ilikai tail)");
});

run("possessive cue keeps a preceding name off the label line", () => {
  const out = reflowClumpedEmailBody(WAIKIKI_CLUMP);
  assert.ok(out.includes("Thien Tran\nGuest's Phone: 8084606509"), `expected the guest name to stay on its own line, got: ${JSON.stringify(out.slice(0, 400))}`);
});

run("does not break inside URLs, times, or plain prose", () => {
  const out = reflowClumpedEmailBody(
    "Check-in is at 3:00 pm. See https://example.com/faq for details. the following applies: bring ID. " +
    "Taxi rate is $27 to $33 dollars, plus tip.",
  );
  assert.strictEqual(out.includes("\n"), false, `unexpected break in: ${JSON.stringify(out)}`);
});

// ── formatEmailBodyForDisplay ────────────────────────────────────────────────

run("clumped body gets reflowed for display", () => {
  const out = formatEmailBodyForDisplay(WAIKIKI_CLUMP + " ".repeat(1) + WAIKIKI_CLUMP);
  assert.ok(out.includes("\nGuest's Name: Thien Tran"));
});

run("body with real newlines passes through untouched (blank runs capped)", () => {
  const body = "Aloha,\n\n\n\nThe door code is 4821.\nMahalo!";
  assert.strictEqual(formatEmailBodyForDisplay(body), "Aloha,\n\nThe door code is 4821.\nMahalo!");
});

run("null/empty-safe", () => {
  assert.strictEqual(formatEmailBodyForDisplay(""), "");
  assert.strictEqual(formatEmailBodyForDisplay(undefined as unknown as string), "");
});

// ── extractReadableFromStoredMimeBody (raw-MIME rows healed at display) ──────
// Rows imported before nested-multipart parsing (2026-07-06) can hold a raw
// MIME fragment: inner boundary + part headers + HTML (live incident: the
// Generali policy email on the Thien Tran alias inbox).

const STORED_MIME_FRAGMENT = [
  "------=_Part_1_1270391341.1783316108108",
  "Content-Type: text/plain; charset=us-ascii",
  "Content-Transfer-Encoding: 7bit",
  "",
  "<html>",
  "  <head>",
  '    <meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1" />',
  "    <title>Generali Travel Protection Plan</title>",
  "  </head>",
  "  <body style=\"font-family:'Arial Narrow'; font-size:10pt\">",
  "    <p><span>Insured:</span><span>&#xa0;</span><span>Thien Tran</span></p>",
  "    <p><span>Address: </span><span>131 Continental Drive</span><br /><span>Newark</span><br /><span>DE 19702</span></p>",
  "  </body>",
  "</html>",
  "------=_Part_1_1270391341.1783316108108",
  "Content-Type: text/html; charset=us-ascii",
  "Content-Transfer-Encoding: 7bit",
  "",
  "<html><body><p>Insured: Thien Tran</p></body></html>",
  "------=_Part_1_1270391341.1783316108108--",
].join("\n");

run("stored raw-MIME fragment is healed to readable text", () => {
  const out = formatEmailBodyForDisplay(STORED_MIME_FRAGMENT);
  assert.ok(!out.includes("_Part_1_"), `boundary must not render: ${JSON.stringify(out.slice(0, 200))}`);
  assert.ok(!/content-transfer-encoding/i.test(out), "part headers must not render");
  assert.ok(!out.includes("<html"), "raw HTML tags must not render");
  assert.ok(!out.includes("Travel Protection Plan"), "head/title content stripped");
  assert.match(out, /Insured:\s*Thien Tran/, "readable content survives");
  assert.match(out, /131 Continental Drive/, "address content survives");
});

run("healer returns null for normal bodies (never rewrites real prose)", () => {
  assert.strictEqual(extractReadableFromStoredMimeBody("Aloha,\n\nThe door code is 4821."), null);
  assert.strictEqual(
    extractReadableFromStoredMimeBody("-- \nJohn Carpenter\nReservationist"),
    null,
    "signature dashes are not a boundary",
  );
  assert.strictEqual(
    extractReadableFromStoredMimeBody("--------------------\nContent-Type: discussed below\nAll dashes divider"),
    null,
    "dashes-only divider is not a boundary",
  );
});

// ── formatEmailTimestampForDisplay ───────────────────────────────────────────

run("formats a valid ISO stamp, null on garbage", () => {
  const out = formatEmailTimestampForDisplay("2026-07-05T20:15:00Z");
  assert.ok(out && out.includes("2026"), `expected a formatted date, got ${out}`);
  assert.strictEqual(formatEmailTimestampForDisplay("not-a-date"), null);
  assert.strictEqual(formatEmailTimestampForDisplay(null), null);
});

// ── stripHtml (via extractBodyFromRawEmail) preserves line structure ─────────

run("HTML email body keeps paragraph/br/table-row line breaks", () => {
  const raw = [
    "From: info@waikikibeachrentals.com",
    "To: thien.tran.4c015c@emailprivaccy.com",
    "Subject: Waikiki Condo Booking Info",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<html><head><title>ignore me</title><style>p{color:red}</style></head><body>" +
      "<p>Aloha Thien Tran,</p><p>Thank you for your reservation.</p>" +
      "<table><tr><td>Arrival Date:</td><td>July 07, 2026</td></tr>" +
      "<tr><td>Departure Date:</td><td>July 12, 2026</td></tr></table>" +
      "Door code<br>6969</body></html>",
  ].join("\r\n");

  const body = extractBodyFromRawEmail(raw);
  assert.ok(!body.includes("ignore me"), "head/title content must be stripped");
  assert.ok(!body.includes("color:red"), "style content must be stripped");
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  assert.ok(lines.includes("Aloha Thien Tran,"), `expected greeting on its own line, got: ${JSON.stringify(lines)}`);
  assert.ok(lines.includes("Thank you for your reservation."), "expected second paragraph on its own line");
  assert.ok(lines.some((l) => l.startsWith("Arrival Date:")), "expected table row on its own line");
  assert.ok(lines.some((l) => l.startsWith("Departure Date:")), "expected second table row on its own line");
  assert.ok(lines.includes("Door code"), "expected <br> to break the line");
  assert.ok(lines.includes("6969"), "expected content after <br> on its own line");
});

run("plain-text email body is unchanged", () => {
  const raw = [
    "From: pm@example.com",
    "To: guest@emailprivaccy.com",
    "Subject: Arrival info",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Aloha,",
    "",
    "The door code is 4821.",
  ].join("\r\n");
  const body = extractBodyFromRawEmail(raw);
  // Plain-text parts keep their raw CRLF line endings (pre-existing behavior);
  // the display formatter normalizes them.
  assert.strictEqual(formatEmailBodyForDisplay(body), "Aloha,\n\nThe door code is 4821.");
});

console.log("email-body-format: all tests passed");
