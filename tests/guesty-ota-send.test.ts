import assert from "node:assert/strict";
import {
  buildOtaSendModuleAttempts,
  mergeOtaModuleFromReservation,
  otaModuleTypeFromReservation,
  verifyOtaHostPostDelivered,
} from "../shared/guesty-ota-send";

console.log("guesty-ota-send tests");

assert.equal(
  otaModuleTypeFromReservation({ integration: { platform: "bookingCom2" }, source: "Booking.com" }, "booking"),
  "bookingCom2",
  "integration.platform bookingCom2 must win over coarse booking hint",
);

assert.equal(
  otaModuleTypeFromReservation({ integration: { platform: "bookingCom" }, source: "Booking.com" }, "booking"),
  "bookingCom",
);

assert.equal(
  mergeOtaModuleFromReservation({ type: "bookingCom2", channelId: "abc" }, { integration: { platform: "bookingCom2" } }, "booking").type,
  "bookingCom2",
  "must not downgrade post-derived bookingCom2 to bookingCom",
);

const bookingAttempts = buildOtaSendModuleAttempts(
  { type: "bookingCom", channelId: "ch-1" },
  { integration: { platform: "bookingCom2" } },
  "booking",
);
assert.equal(bookingAttempts[0]?.type, "bookingCom2", "first send attempt should use integration.platform type-only");
assert.ok(
  bookingAttempts.some((a) => a.type === "bookingCom2" && a.channelId === undefined),
  "should include type-only bookingCom2 attempt",
);
assert.ok(
  bookingAttempts.some((a) => a.type === "bookingCom" && a.channelId === "ch-1"),
  "should still try conversation-derived module with channelId",
);
assert.ok(
  !bookingAttempts.some((a) => "platform" in a || "integrationId" in a),
  "send attempts must not include forbidden Guesty module keys",
);

const verified = verifyOtaHostPostDelivered(
  [
    {
      sentBy: "host",
      body: "Hi Cecilio,\n\nYour stay at Alii Kai is coming up.",
      module: { type: "bookingCom2" },
      sentAt: "2026-06-20T16:00:00.000Z",
    },
  ],
  "Hi Cecilio,\n\nYour stay at Alii Kai is coming up.\n\nAccess code: 1234",
  true,
);
assert.equal(verified.verified, true);
assert.equal(verified.deliveryModuleType, "bookingcom2");

const emailOnly = verifyOtaHostPostDelivered(
  [
    {
      sentBy: "host",
      body: "Hi Cecilio,\n\nYour stay at Alii Kai is coming up.",
      module: { type: "email" },
      sentAt: "2026-06-20T16:00:00.000Z",
    },
  ],
  "Hi Cecilio,\n\nYour stay at Alii Kai is coming up.",
  true,
);
assert.equal(emailOnly.verified, false);
assert.match(String(emailOnly.reason), /OTA guest channel/i);

console.log("  ✓ guesty OTA send module resolution + post-send verification");
