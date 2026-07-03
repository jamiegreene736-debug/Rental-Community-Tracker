import assert from "node:assert/strict";
import {
  buildOtaSendModuleAttempts,
  classifyExistingSend,
  deliveryOutcome,
  guestyChannelLabel,
  guestyModuleTypeLooksOta,
  mergeOtaModuleFromReservation,
  otaChannelRequested,
  otaModuleTypeFromReservation,
  postDeliveryState,
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

// ── Delivery-state classification ──────────────────────────────────────────
// A bare outbound post (status pending, no externalId) is NOT delivered; only a
// channel-stamped externalId or a completed/sent status counts.
assert.equal(postDeliveryState({ module: { type: "bookingCom" }, status: "pending" }), "pending");
assert.equal(postDeliveryState({ module: { type: "bookingCom" } }), "pending");
assert.equal(postDeliveryState({ module: { type: "bookingCom", externalId: "abc-123" }, status: "pending" }), "delivered");
assert.equal(postDeliveryState({ module: { type: "bookingCom" }, status: "completed" }), "delivered");
assert.equal(postDeliveryState({ module: { type: "bookingCom" }, status: "failed" }), "failed");

// A delivered OTA host post (externalId present) verifies. The synced copy is
// whitespace-reformatted by the channel (live: 1793 vs our 1801 chars) — the
// strict matcher must tolerate that while still confirming the SAME message.
const SENT_HI = "Hi Cecilio,\n\nYour stay at Alii Kai is coming up.\n\nAccess code: 1234";
const verified = verifyOtaHostPostDelivered(
  [
    {
      sentBy: "host",
      body: "Hi Cecilio, Your stay at Alii Kai is coming up. Access code: 1234",
      module: { type: "bookingCom2", externalId: "53157650-6cb2-11f1" },
      sentAt: "2026-06-20T16:00:00.000Z",
    },
  ],
  SENT_HI,
  true,
);
assert.equal(verified.verified, true);
assert.equal(verified.deliveryModuleType, "bookingcom2");

// A still-pending OTA host post (no externalId) is NOT verified — it reports
// pending so the caller can surface "queued, don't resend" instead of a false
// success. This is the core fix (stuck Booking.com arrival messages, 2026-06-20).
const SENT_AD = "Aloha Cecilio,\n\nPlease see the below access details.\n\nAccess code: 1234";
const pendingOnly = verifyOtaHostPostDelivered(
  [
    {
      sentBy: "host",
      from: { type: "user", fullName: "Magical-island-rentals-v2" },
      body: SENT_AD,
      module: { type: "bookingCom" },
      status: "pending",
      createdAt: "2026-06-20T14:13:48.648Z",
    },
  ],
  SENT_AD,
  true,
);
assert.equal(pendingOnly.verified, false);
assert.equal(pendingOnly.pending, true);

// When BOTH a pending outbound copy and a delivered synced copy exist, the
// delivered one wins (this is exactly the live shape: from=user pending +
// from=null externalId).
const pendingPlusDelivered = verifyOtaHostPostDelivered(
  [
    {
      sentBy: "host",
      body: SENT_AD,
      module: { type: "bookingCom", externalId: "53157650-6cb2-11f1" },
      createdAt: "2026-06-20T14:14:17.000Z",
    },
    {
      sentBy: "host",
      body: SENT_AD,
      module: { type: "bookingCom" },
      status: "pending",
      createdAt: "2026-06-20T14:13:48.648Z",
    },
  ],
  SENT_AD,
  true,
);
assert.equal(pendingPlusDelivered.verified, true);

// REGRESSION (review finding): an EDITED resend (corrected access code) must NOT
// be falsely "confirmed" by a STALE delivered copy of the OLD message. The
// greeting + signature are byte-identical (lenient head/tail match would pass),
// so only the strict body matcher prevents a false green showing the wrong code.
const correctedSent = "Aloha Guest,\n\nYour door access code is 5678.\n\nMahalo,\nJohn Carpenter";
const staleVsCorrected = verifyOtaHostPostDelivered(
  [
    {
      sentBy: "host",
      body: correctedSent, // newest: corrected copy, still pending (no externalId)
      module: { type: "bookingCom" },
      status: "pending",
      createdAt: "2026-06-20T15:10:00.000Z",
    },
    {
      sentBy: "host",
      body: "Aloha Guest,\n\nYour door access code is 1234.\n\nMahalo,\nJohn Carpenter", // STALE original, delivered
      module: { type: "bookingCom", externalId: "old-delivered-1" },
      createdAt: "2026-06-20T15:00:00.000Z",
    },
  ],
  correctedSent,
  true,
);
assert.equal(staleVsCorrected.verified, false, "edited resend must not verify against a stale delivered copy");
assert.equal(staleVsCorrected.pending, true, "the corrected copy is still pending");

// Wrong-channel (email) misroute is a HARD non-delivery, not "pending".
const emailOnly = verifyOtaHostPostDelivered(
  [
    {
      sentBy: "host",
      body: "Hi Cecilio, Your stay at Alii Kai is coming up. Access code: 1234",
      module: { type: "email", externalId: "email-1" },
      status: "completed",
      sentAt: "2026-06-20T16:00:00.000Z",
    },
  ],
  SENT_HI,
  true,
);
assert.equal(emailOnly.verified, false);
assert.equal(emailOnly.pending, false, "email misroute must NOT be reported as pending");
assert.match(String(emailOnly.reason), /OTA guest channel/i);

// REGRESSION (inbox review): posts exist but NONE match our body (Guesty sync lag
// or a channel body re-wrap) is UNCONFIRMED, not a wrong-channel misroute — it
// must report pending (queued, don't resend), never a hard "saved on email" error.
const noMatch = verifyOtaHostPostDelivered(
  [
    { sentBy: "guest", body: "Totally unrelated guest question", module: { type: "bookingCom" }, createdAt: "2026-06-20T17:00:00.000Z" },
    { sentBy: "host", body: "Some earlier unrelated host reply", module: { type: "bookingCom", externalId: "x" }, createdAt: "2026-06-20T16:59:00.000Z" },
  ],
  "Hi Cecilio, your arrival details are below. Access code 4242.",
  true,
);
assert.equal(noMatch.verified, false);
assert.equal(noMatch.pending, true, "no body-matching post = unconfirmed/pending, not a hard misroute");

// ── deliveryOutcome: the contract the BACKGROUND senders (auto-reply auto-send,
// booking confirmations, guest receipts) act on. This is what keeps a stuck
// `pending` post from being recorded as a clean delivery, and a hard misroute
// from being recorded as "sent" at all.
assert.equal(deliveryOutcome({ verified: true }), "delivered");
assert.equal(deliveryOutcome({ verified: true, pending: true }), "delivered", "verified wins even if a pending flag is set");
assert.equal(deliveryOutcome({ verified: false, pending: true }), "unconfirmed", "posted to OTA but not confirmed = unconfirmed (record terminally, don't claim delivery)");
assert.equal(deliveryOutcome({ verified: false, pending: false }), "misroute", "pending:false is the explicit hard-misroute signal");
// SAFETY: an ambiguous verdict (verified false, pending unset) must NOT be a
// hard misroute — a misroute suppresses the sent record / flags the thread, so
// we only do it on an EXPLICIT pending:false.
assert.equal(deliveryOutcome({ verified: false }), "unconfirmed", "missing pending must not be treated as a misroute");
assert.equal(deliveryOutcome({}), "unconfirmed");
assert.equal(deliveryOutcome(null), "unconfirmed", "null result is conservatively unconfirmed, never a misroute");

// ── Channel coverage: every OTA channel a guest can book on must be recognized
// as OTA so its outbound reply is delivery-VERIFIED (externalId), not falsely
// reported "sent" on a bare POST 200. The big three plus the additional OTAs
// Guesty can relay; direct channels stay non-OTA (their accepted POST IS the send).
for (const t of [
  "airbnb", "airbnb2",
  "homeaway", "homeaway2", "vrbo",
  "bookingCom", "bookingCom2",
  "expedia", "googleVacationRentals", "google",
  "marriott", "homesAndVillas", "hvmi",
  "hopper", "despegar", "tripadvisor", "holidu", "agoda",
]) {
  assert.equal(guestyModuleTypeLooksOta(t), true, `${t} must be treated as an OTA (delivery-verified)`);
  assert.equal(otaChannelRequested({ type: t }), true, `${t} must require OTA delivery confirmation`);
}
for (const t of ["email", "sms", "whatsapp", "manual", "direct", "log", "note", "", "system"]) {
  assert.equal(guestyModuleTypeLooksOta(t), false, `${t} must NOT be treated as an OTA`);
}

// ── Expedia must resolve to its OWN channel, never be folded into homeaway/VRBO
// (the old source-text fallback misrouted an Expedia reply onto the VRBO module).
assert.equal(
  otaModuleTypeFromReservation({ integration: { platform: "expedia" }, source: "Expedia" }, null),
  "expedia",
  "Expedia integration.platform must win as its own channel",
);
assert.equal(
  otaModuleTypeFromReservation({ integration: null, source: "Expedia" }, null),
  "expedia",
  "Expedia source must resolve to expedia, NOT homeaway",
);
assert.notEqual(
  otaModuleTypeFromReservation({ integration: null, source: "Expedia" }, null),
  "homeaway",
  "Expedia must never misroute to the VRBO/homeaway module",
);

// ── Airbnb / VRBO outbound resolution + labels (previously untested live channels)
assert.equal(otaModuleTypeFromReservation({ integration: { platform: "airbnb2" } }, "airbnb"), "airbnb2");
assert.equal(otaModuleTypeFromReservation({ integration: null, source: "Airbnb" }, null), "airbnb2");
assert.equal(otaModuleTypeFromReservation({ integration: { platform: "homeaway2" } }, "vrbo"), "homeaway2");
assert.equal(otaModuleTypeFromReservation({ integration: null, source: "Vrbo" }, null), "homeaway");
assert.equal(guestyChannelLabel({ type: "airbnb2" }), "Airbnb");
assert.equal(guestyChannelLabel({ type: "homeaway2" }), "VRBO");
assert.equal(guestyChannelLabel({ type: "bookingCom2" }), "Booking.com");
assert.equal(guestyChannelLabel({ type: "expedia" }), "Expedia");
assert.equal(guestyChannelLabel({ type: "email" }), "email");

// ── VRBO / Airbnb module-generation fallback variants (2026-07-03) ──────────
// VRBO has homeaway/homeaway2 module generations just like Booking.com's
// bookingCom/bookingCom2. The live integration.platform LEADS; the sibling
// variant is a fallback only if Guesty rejects the POST (send-once semantics).
const vrboAttempts = buildOtaSendModuleAttempts(
  { type: "homeaway", channelId: "ch-9" },
  { integration: { platform: "homeaway2" } },
  "vrbo",
);
assert.equal(vrboAttempts[0]?.type, "homeaway2", "VRBO lead attempt = integration.platform");
assert.ok(vrboAttempts.some((a) => a.type === "homeaway" && a.channelId === undefined), "VRBO fallback variant homeaway present");
const vrboLegacyAttempts = buildOtaSendModuleAttempts(
  { type: "homeaway" },
  { integration: { platform: "homeaway" } },
  "vrbo",
);
assert.equal(vrboLegacyAttempts[0]?.type, "homeaway");
assert.ok(vrboLegacyAttempts.some((a) => a.type === "homeaway2"), "legacy homeaway platform still gets homeaway2 fallback");
const airbnbAttempts = buildOtaSendModuleAttempts(
  { type: "airbnb2" },
  { integration: { platform: "airbnb2" } },
  "airbnb",
);
assert.ok(airbnbAttempts.some((a) => a.type === "airbnb"), "Airbnb gets the sibling airbnb variant as fallback");
assert.ok(
  !buildOtaSendModuleAttempts({ type: "bookingCom" }, { integration: { platform: "bookingCom2" } }, "booking")
    .some((a) => String(a.type).toLowerCase().includes("homeaway") || String(a.type).toLowerCase().includes("airbnb")),
  "Booking.com sends must not pick up VRBO/Airbnb variants",
);

// ── classifyExistingSend: pre-send idempotency + the repeated-short-reply fix ─
const NOW = new Date("2026-07-03T20:00:00.000Z").getTime();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const REPLY = "Thank you!";

// Delivered copy from LAST WEEK must NOT swallow a new identical send when a
// delivered window is set (the interactive inbox path).
const oldDelivered = [{
  sentBy: "host",
  body: REPLY,
  module: { type: "homeaway2", externalId: "old-1" },
  sentAt: iso(7 * 24 * 60 * 60 * 1000),
}];
assert.equal(
  classifyExistingSend(oldDelivered, REPLY, true, { nowMs: NOW, deliveredWindowMs: 600_000 }),
  null,
  "week-old delivered duplicate must NOT block a new interactive send",
);
// …but the unlimited default (background senders) still treats it as terminal.
assert.deepEqual(
  classifyExistingSend(oldDelivered, REPLY, true, { nowMs: NOW }),
  { state: "delivered", deliveryModuleType: "homeaway2" },
  "background senders keep unlimited delivered dedup",
);
// A delivered copy INSIDE the window is an idempotent success (double-click).
assert.equal(
  classifyExistingSend(
    [{ sentBy: "host", body: REPLY, module: { type: "homeaway2", externalId: "new-1" }, sentAt: iso(30_000) }],
    REPLY, true, { nowMs: NOW, deliveredWindowMs: 600_000 },
  )?.state,
  "delivered",
  "recent delivered duplicate is still an idempotent success",
);
// A recent identical PENDING copy → resume polling, don't resend.
assert.equal(
  classifyExistingSend(
    [{ sentBy: "host", body: REPLY, module: { type: "homeaway2" }, status: "pending", sentAt: iso(60_000) }],
    REPLY, true, { nowMs: NOW, pendingWindowMs: 240_000, deliveredWindowMs: 600_000 },
  )?.state,
  "pending",
);
// A STALE pending copy (outside the resume window) does not block the send.
assert.equal(
  classifyExistingSend(
    [{ sentBy: "host", body: REPLY, module: { type: "homeaway2" }, status: "pending", sentAt: iso(60 * 60 * 1000) }],
    REPLY, true, { nowMs: NOW, pendingWindowMs: 240_000, deliveredWindowMs: 600_000 },
  ),
  null,
);
// Guest posts and different bodies never match.
assert.equal(
  classifyExistingSend(
    [{ sentBy: "guest", body: REPLY, module: { type: "homeaway2", externalId: "g" }, sentAt: iso(30_000) }],
    REPLY, true, { nowMs: NOW, deliveredWindowMs: 600_000 },
  ),
  null,
);

// ── verifyOtaHostPostDelivered sinceMs: an OLD delivered copy of the same body
// must not false-verify a NEW send whose own copy is still pending.
const repeatedBodyPosts = [
  { sentBy: "host", body: REPLY, module: { type: "homeaway2" }, status: "pending", sentAt: iso(10_000) }, // this send
  { sentBy: "host", body: REPLY, module: { type: "homeaway2", externalId: "old-1" }, sentAt: iso(7 * 24 * 60 * 60 * 1000) }, // last week
];
const anchored = verifyOtaHostPostDelivered(repeatedBodyPosts, REPLY, true, { sinceMs: NOW - 120_000 });
assert.equal(anchored.verified, false, "old delivered copy must not verify the new send");
assert.equal(anchored.pending, true, "the new copy is honestly still pending");
const unanchored = verifyOtaHostPostDelivered(repeatedBodyPosts, REPLY, true);
assert.equal(unanchored.verified, true, "without an anchor the legacy behavior is unchanged");
// A timestamp-less delivered post survives the sinceMs filter (unknown age must
// never hide a real confirmation).
assert.equal(
  verifyOtaHostPostDelivered(
    [{ sentBy: "host", body: REPLY, module: { type: "homeaway2", externalId: "x" } }],
    REPLY, true, { sinceMs: NOW - 120_000 },
  ).verified,
  true,
);

console.log("  ✓ guesty OTA send module resolution + delivery-confirmed verification");
