import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";
process.env.QUO_FROM_NUMBER ||= "+18084606509";

const { extractQuoMediaUrls } = await import("../server/quo-sms");

console.log("quo sms media suite");

// ── extractQuoMediaUrls: OpenPhone documented shape ──
const openphone = extractQuoMediaUrls({
  id: "MSG123",
  direction: "incoming",
  from: "+18085550123",
  to: ["+18084606509"],
  text: "",
  media: [
    { url: "https://storage.googleapis.com/openphone/abc123.jpeg", type: "image/jpeg" },
    { url: "https://storage.googleapis.com/openphone/def456", type: "image/png" },
  ],
});
assert.equal(openphone.length, 2);
assert.equal(openphone[0].url, "https://storage.googleapis.com/openphone/abc123.jpeg");
assert.equal(openphone[0].type, "image/jpeg");
assert.equal(openphone[1].type, "image/png");
console.log("  ✓ extracts OpenPhone media objects with mime types");

// ── bare URL strings + alternate collection keys ──
const bare = extractQuoMediaUrls({
  attachments: ["https://cdn.example.com/photo.jpg", "not-a-url", 42],
});
assert.equal(bare.length, 1);
assert.equal(bare[0].url, "https://cdn.example.com/photo.jpg");
assert.equal(bare[0].type, undefined);
console.log("  ✓ accepts bare URL strings under attachments and drops junk");

// ── alternate URL keys + dedupe across collections ──
const dedup = extractQuoMediaUrls({
  media: [{ src: "https://cdn.example.com/a.png", contentType: "image/png" }],
  attachments: ["https://cdn.example.com/a.png", { href: "https://cdn.example.com/b.pdf", mimeType: "application/pdf" }],
});
assert.equal(dedup.length, 2);
assert.equal(dedup[0].url, "https://cdn.example.com/a.png");
assert.equal(dedup[0].type, "image/png");
assert.equal(dedup[1].url, "https://cdn.example.com/b.pdf");
assert.equal(dedup[1].type, "application/pdf");
console.log("  ✓ honors src/href/contentType/mimeType keys and dedupes by URL");

// ── empty / missing media ──
assert.deepEqual(extractQuoMediaUrls({ text: "hi" }), []);
assert.deepEqual(extractQuoMediaUrls(null), []);
assert.deepEqual(extractQuoMediaUrls({ media: "https://not-an-array.example.com" }), []);
console.log("  ✓ returns [] when the webhook has no media");

// ── SOURCE ASSERTIONS: the wiring this suite guards ──
// recordQuoWebhook must accept a photo-only MMS (no text) and persist media —
// otherwise the guest's ID-verification selfie reply is silently dropped.
const quoSmsSource = readFileSync(new URL("../server/quo-sms.ts", import.meta.url), "utf8");
assert.match(
  quoSmsSource,
  /if \(!body && media\.length === 0\) throw/,
  "recordQuoWebhook must only reject when BOTH text and media are missing",
);
assert.match(
  quoSmsSource,
  /mediaUrls: media\.length > 0 \? JSON\.stringify\(media\) : null/,
  "recordQuoWebhook must persist extracted media on the quo_sms_messages row",
);
console.log("  ✓ recordQuoWebhook accepts photo-only MMS and persists media_urls");

const schemaSource = readFileSync(new URL("../shared/schema.ts", import.meta.url), "utf8");
assert.match(schemaSource, /mediaUrls: text\("media_urls"\)/, "quo_sms_messages schema must include media_urls");
const maintenanceSource = readFileSync(new URL("../server/schema-maintenance.ts", import.meta.url), "utf8");
assert.match(
  maintenanceSource,
  /ALTER TABLE quo_sms_messages ADD COLUMN IF NOT EXISTS media_urls text/,
  "existing deploys must gain the media_urls column via schema maintenance",
);
console.log("  ✓ media_urls column exists in schema + boot maintenance");

// The inbox thread must surface MMS media through the shared attachment
// renderer, and the ID-verification template must exist on both channels.
const inboxSource = readFileSync(new URL("../client/src/pages/inbox.tsx", import.meta.url), "utf8");
assert.match(inboxSource, /media: parseQuoSmsMedia\(m\.mediaUrls\)/, "SMS thread posts must carry parsed MMS media");
assert.match(inboxSource, /function buildIdVerificationBody/, "Guesty-channel ID-verification template builder missing");
assert.match(inboxSource, /function buildIdVerificationSmsBody/, "SMS ID-verification template builder missing");
assert.match(inboxSource, /button-draft-id-verification/, "ID-verification Guesty button missing from templates strip");
assert.match(inboxSource, /button-draft-sms-id-verification/, "ID-verification Text button missing from templates strip");
assert.match(
  inboxSource,
  /release your arrival details/,
  "template copy must tie the ID request to releasing arrival details",
);
console.log("  ✓ inbox renders MMS media and exposes the ID-verification template on Guesty + Text");

console.log("quo sms media suite passed");
