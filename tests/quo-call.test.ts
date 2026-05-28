import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";
process.env.QUO_FROM_NUMBER ||= "+18084606509";

const { parseQuoCallWebhook, phoneLast10 } = await import("../server/quo-sms");

console.log("quo call suite");

const missed = parseQuoCallWebhook({
  type: "call.completed",
  data: {
    object: {
      id: "ACmissed123",
      direction: "incoming",
      from: "+18085550123",
      to: "+18084606509",
      status: "completed",
      answeredAt: null,
      createdAt: "2026-05-27T01:00:00Z",
      completedAt: "2026-05-27T01:01:00Z",
    },
  },
});

assert.equal(missed.providerCallId, "ACmissed123");
assert.equal(missed.direction, "inbound");
assert.equal(missed.disposition, "missed");
assert.equal(phoneLast10(missed.guestPhone), "8085550123");
console.log("  ✓ parses inbound missed calls from the 808 Quo number");

const voicemail = parseQuoCallWebhook({
  type: "call.completed",
  object: {
    id: "ACvoice123",
    direction: "inbound",
    from: "+14155550199",
    to: "+18084606509",
    status: "voicemail",
    voicemailId: "VM123",
    duration: 42,
  },
});

assert.equal(voicemail.disposition, "voicemail");
assert.equal(voicemail.durationSeconds, 42);
assert.equal(phoneLast10(voicemail.guestPhone), "4155550199");
console.log("  ✓ detects voicemail call events");

const backfilled = parseQuoCallWebhook({
  type: "call.backfill",
  data: {
    object: {
      id: "ACbackfill123",
      direction: "incoming",
      participants: ["+18085550177"],
      status: "completed",
      answeredAt: null,
      createdAt: "2026-05-26T23:00:00Z",
      completedAt: "2026-05-26T23:01:00Z",
    },
  },
});

assert.equal(backfilled.disposition, "missed");
assert.equal(backfilled.fromNumber, "+18085550177");
assert.equal(backfilled.toNumber, "+18084606509");
console.log("  ✓ parses backfilled Quo call-list records");

console.log("quo call suite passed");
