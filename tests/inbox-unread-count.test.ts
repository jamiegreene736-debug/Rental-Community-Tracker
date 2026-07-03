import assert from "node:assert";
import {
  conversationAwaitsReply,
  conversationLastActivityMs,
  countUnreadConversations,
  extractConversationList,
  parseStoredInboxReadOverrides,
} from "../shared/inbox-unread-count";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("inbox-unread-count: header unread-badge helpers");

// ── extractConversationList ──────────────────────────────────────────────────
check("Guesty wrapped shape { data: { conversations } }",
  extractConversationList({ status: 200, data: { count: 2, conversations: [{ _id: "a" }, { _id: "b" }] } }).length === 2);
check("legacy { results } shape", extractConversationList({ results: [{ _id: "a" }] }).length === 1);
check("bare array passes through", extractConversationList([{ _id: "a" }]).length === 1);
check("junk → empty list", extractConversationList("nope").length === 0 && extractConversationList(null).length === 0);

// ── parseStoredInboxReadOverrides ────────────────────────────────────────────
{
  const parsed = parseStoredInboxReadOverrides(JSON.stringify({
    good: { state: "unread", at: 123 },
    alsoGood: { state: "read", at: 456 },
    badState: { state: "starred", at: 1 },
    badAt: { state: "read", at: "yesterday" },
  }));
  check("valid override entries kept, malformed dropped",
    Object.keys(parsed).length === 2 && parsed.good.state === "unread" && parsed.alsoGood.at === 456);
}
check("null / corrupt raw → empty overrides",
  Object.keys(parseStoredInboxReadOverrides(null)).length === 0 &&
  Object.keys(parseStoredInboxReadOverrides("{oops")).length === 0);

// ── conversationAwaitsReply ──────────────────────────────────────────────────
check("explicit state.isLastPostFromGuest=true → awaits reply",
  conversationAwaitsReply({ state: { isLastPostFromGuest: true, readByNonUser: false } }) === true);
check("explicit state.isLastPostFromGuest=false wins even with legacy-looking extras",
  conversationAwaitsReply({ state: { isLastPostFromGuest: false, readByNonUser: false } }) === false);
check("legacy string state UNANSWERED → awaits reply", conversationAwaitsReply({ state: "UNANSWERED" }) === true);
check("no signals → not counted (conservative)", conversationAwaitsReply({ state: {} }) === false);

// ── conversationLastActivityMs ───────────────────────────────────────────────
check("state.lastMessage.date preferred over createdAt",
  conversationLastActivityMs({
    createdAt: "2026-04-23T00:00:00Z",
    state: { lastMessage: { date: "2026-05-03T12:00:00Z" } },
  }) === Date.parse("2026-05-03T12:00:00Z"));
check("falls back to updatedAt/createdAt",
  conversationLastActivityMs({ createdAt: "2026-04-23T00:00:00Z" }) === Date.parse("2026-04-23T00:00:00Z"));
check("nothing parseable → 0", conversationLastActivityMs({}) === 0);

// ── countUnreadConversations ─────────────────────────────────────────────────
const t0 = Date.parse("2026-07-01T00:00:00Z");
const guestMsg = (id: string, dateIso: string, fromGuest = true) => ({
  _id: id,
  state: { isLastPostFromGuest: fromGuest, lastMessage: { date: dateIso } },
});

check("live count: guest-last conversations counted, host-last not",
  countUnreadConversations([
    guestMsg("a", "2026-07-01T01:00:00Z", true),
    guestMsg("b", "2026-07-01T02:00:00Z", false),
    guestMsg("c", "2026-07-01T03:00:00Z", true),
  ], {}) === 2);

check("'read' override hides a guest-last thread (mark newer than activity)",
  countUnreadConversations(
    [guestMsg("a", "2026-07-01T01:00:00Z", true)],
    { a: { state: "read", at: t0 + 2 * 3600_000 } },
  ) === 0);

check("'read' override superseded by a NEWER guest message → counts again",
  countUnreadConversations(
    [guestMsg("a", "2026-07-01T05:00:00Z", true)],
    { a: { state: "read", at: t0 + 2 * 3600_000 } },
  ) === 1);

check("'unread' override lights a host-last thread",
  countUnreadConversations(
    [guestMsg("a", "2026-07-01T01:00:00Z", false)],
    { a: { state: "unread", at: t0 + 2 * 3600_000 } },
  ) === 1);

check("override for an unrelated id is ignored",
  countUnreadConversations(
    [guestMsg("a", "2026-07-01T01:00:00Z", true)],
    { zzz: { state: "read", at: t0 + 9 * 3600_000 } },
  ) === 1);

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0);
