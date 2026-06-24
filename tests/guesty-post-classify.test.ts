import assert from "node:assert/strict";
import {
  isIncomingPost,
  isSystemPost,
  isHostPost,
  pickPostToReplyTo,
  postTimestampMs,
} from "../shared/guesty-post-classify";

console.log("guesty-post-classify tests");

// --- inbox-v2 `sentBy` shape (the 2026-05-04 outage surface) ---------------
assert.equal(isIncomingPost({ sentBy: "guest" }), true, "sentBy:guest is incoming");
assert.equal(isHostPost({ sentBy: "host" }), true, "sentBy:host is host");
assert.equal(isSystemPost({ sentBy: "log" }), true, "sentBy:log is system");
assert.equal(isIncomingPost({ sentBy: "host" }), false, "host is not incoming");
assert.equal(isHostPost({ sentBy: "guest" }), false, "guest is not host");

// --- legacy fallbacks (older fixtures / non-Guesty sources) ----------------
assert.equal(isIncomingPost({ isIncoming: true }), true, "legacy isIncoming");
assert.equal(isIncomingPost({ direction: "inbound" }), true, "legacy direction inbound");
assert.equal(isIncomingPost({ authorType: "Guest" }), true, "legacy authorType guest");
assert.equal(isHostPost({ direction: "outbound" }), true, "legacy direction outbound");
assert.equal(isHostPost({ authorRole: "HOST" }), true, "legacy authorRole host");

// --- system post body patterns + module.type ------------------------------
assert.equal(isSystemPost({ body: "New guest inquiry" }), true, "system body pattern");
assert.equal(isSystemPost({ module: { type: "log" } }), true, "system module.type log");
assert.equal(isSystemPost({ sentBy: "guest", body: "Hi, is parking free?" }), false, "real guest msg is not system");

// --- pickPostToReplyTo across channels (channel-agnostic) ------------------
// Guest-only thread -> reply to the guest's latest message.
assert.deepEqual(
  pickPostToReplyTo([
    { _id: "log1", sentBy: "log", body: "New guest inquiry", createdAt: "2026-06-20T10:00:00Z" },
    { _id: "g1", sentBy: "guest", body: "Hello", createdAt: "2026-06-20T10:01:00Z" },
  ])?._id,
  "g1",
  "guest-only thread returns the guest post (system log filtered)",
);

// Host already replied AFTER the guest -> already handled, return null.
assert.equal(
  pickPostToReplyTo([
    { _id: "g1", sentBy: "guest", body: "Hello", createdAt: "2026-06-20T10:01:00Z" },
    { _id: "h1", sentBy: "host", body: "Aloha!", createdAt: "2026-06-20T10:05:00Z" },
  ]),
  null,
  "host replied after guest -> no re-trigger",
);

// Guest followed up AFTER the host -> reply to the new guest message.
assert.equal(
  pickPostToReplyTo([
    { _id: "g1", sentBy: "guest", body: "Hello", createdAt: "2026-06-20T10:01:00Z" },
    { _id: "h1", sentBy: "host", body: "Aloha!", createdAt: "2026-06-20T10:05:00Z" },
    { _id: "g2", sentBy: "guest", body: "One more thing", createdAt: "2026-06-20T10:09:00Z" },
  ])?._id,
  "g2",
  "guest follow-up after host reply -> trigger on the new guest post",
);

// Host-initiated thread (no incoming) -> null.
assert.equal(
  pickPostToReplyTo([{ _id: "h1", sentBy: "host", body: "Checking in", createdAt: "2026-06-20T10:00:00Z" }]),
  null,
  "host-initiated thread -> null",
);

assert.equal(pickPostToReplyTo([]), null, "empty thread -> null");
assert.equal(pickPostToReplyTo(undefined), null, "undefined thread -> null");

// --- postTimestampMs falls back across field names safely ------------------
assert.ok(postTimestampMs({ sentAt: "2026-06-20T10:00:00Z" }) > 0, "sentAt parsed");
assert.equal(postTimestampMs({}), 0, "no timestamp -> 0 (stable sort)");

console.log("  ✓ guesty-post-classify");
