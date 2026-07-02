import assert from "node:assert";
import { parseVendorEmailFromRaw } from "../server/buy-in-email-sync";

function run(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

console.log("buy-in-email-sync tests");

const UNIT_ALIAS = "cheryl.parker.ab12cd@emailprivaccy.com";
const aliasSet = new Set([UNIT_ALIAS]);

run("matches a PM reply forwarded to a reservation unit alias", () => {
  const raw = [
    `From: Santa Maria Reservations <reply+abc@simplelogin.co>`,
    `X-SimpleLogin-Envelope-From: rentals@santamariapm.com`,
    `X-SimpleLogin-Envelope-To: ${UNIT_ALIAS}`,
    `Subject: Re: Arrival details request`,
    `Message-ID: <pm-reply-1@santamariapm.com>`,
    `Date: Wed, 01 Jul 2026 10:00:00 -1000`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Aloha, the door code is 4821 and Wi-Fi password: mahalo2026.`,
  ].join("\r\n");

  const parsed = parseVendorEmailFromRaw(raw, aliasSet);
  assert.ok(parsed, "expected a parsed vendor email");
  assert.strictEqual(parsed!.aliasEmail, UNIT_ALIAS);
  // The real PM sender (not the SimpleLogin rewritten From) is captured.
  assert.strictEqual(parsed!.fromEmail, "rentals@santamariapm.com");
  assert.strictEqual(parsed!.messageId, "pm-reply-1@santamariapm.com");
  assert.ok(parsed!.body.includes("door code is 4821"));
});

run("falls back to the To header when no SimpleLogin envelope header", () => {
  const raw = [
    `From: rentals@santamariapm.com`,
    `To: ${UNIT_ALIAS}`,
    `Subject: Arrival info`,
    `Date: Wed, 01 Jul 2026 12:00:00 -1000`,
    ``,
    `Here are the details.`,
  ].join("\r\n");

  const parsed = parseVendorEmailFromRaw(raw, aliasSet);
  assert.ok(parsed, "expected a parsed vendor email via To header");
  assert.strictEqual(parsed!.aliasEmail, UNIT_ALIAS);
  assert.strictEqual(parsed!.fromEmail, "rentals@santamariapm.com");
});

run("ignores mail addressed to an unrelated alias", () => {
  const raw = [
    `From: someone@example.com`,
    `X-SimpleLogin-Envelope-To: other.guest.zz99@emailprivaccy.com`,
    `Subject: Not ours`,
    ``,
    `Body`,
  ].join("\r\n");
  assert.strictEqual(parseVendorEmailFromRaw(raw, aliasSet), null);
});

console.log("  ✓ buy-in-email-sync");
