/**
 * Live Guesty OTA send verification (opt-in).
 *
 * Run:
 *   GUESTY_E2E_RESERVATION_ID=<guesty-reservation-id> npx tsx tests/guesty-ota-send-live.test.ts
 *
 * Requires GUESTY_CLIENT_ID + GUESTY_CLIENT_SECRET (same as the app).
 * Sends a short test message through the same path as Message AD, then verifies
 * the host post landed on an OTA module (not email).
 */
import assert from "node:assert/strict";
import {
  findGuestyConversationForReservation,
  sendGuestyConversationMessage,
} from "../server/guesty-ota-messaging";

const reservationId = String(process.env.GUESTY_E2E_RESERVATION_ID ?? "").trim();
if (!reservationId) {
  console.log("guesty-ota-send-live: skipped (set GUESTY_E2E_RESERVATION_ID to run live Guesty send verification)");
  process.exit(0);
}

const marker = `E2E OTA send probe ${new Date().toISOString()}`;
const body = [
  "Hi there,",
  "",
  "This is an automated delivery probe from VacationRentalExpertz operations tooling.",
  marker,
  "",
  "Please ignore — no action needed.",
  "",
  "Thanks,",
  "John Carpenter",
].join("\n");

console.log(`guesty-ota-send-live: reservation ${reservationId}`);

const conversation = await findGuestyConversationForReservation(reservationId, "booking");
assert.ok(conversation?.id, "expected Guesty conversation for reservation");

console.log("  conversation:", conversation!.id);
console.log("  resolved module:", JSON.stringify(conversation!.module));
console.log("  integration.platform:", (conversation!.reservation as any)?.integration?.platform ?? "(none)");

const result = await sendGuestyConversationMessage({
  conversationId: conversation!.id,
  body,
  module: conversation!.module,
  reservation: conversation!.reservation,
  channelHint: "booking",
  logPrefix: "guesty-ota-send-live",
});

assert.equal(result.verified, true, "live send must verify an OTA host post");
assert.ok(
  String(result.deliveryModuleType ?? "").includes("booking"),
  `expected Booking.com module on host post, got ${result.deliveryModuleType}`,
);

console.log("  ✓ live Guesty OTA send verified:", result.deliveredVia, result.deliveryModuleType);
