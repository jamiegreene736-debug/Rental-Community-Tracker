// Unmatched-texts ("Texts" tab) tests — pure grouping/unread logic plus source
// guards on the server routes, storage filter, auth allowlist, and the inbox
// tab wiring. A text from a third-party number (e.g. a Canary Technologies
// verification link) matches no Guesty conversation and previously rendered
// NOWHERE; this suite locks the surfaces that fixed that.

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  countUnreadUnmatchedThreads,
  groupUnmatchedTexts,
  parseUnmatchedSeenMap,
  unmatchedThreadIsUnread,
  UNMATCHED_TEXTS_SEEN_KEY,
} from "../shared/unmatched-texts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

function msg(over: Partial<Record<string, any>> = {}) {
  return {
    id: 1,
    direction: "inbound",
    body: "hello",
    guestPhone: "+18085551234",
    sentAt: "2026-07-20T10:00:00.000Z",
    ...over,
  } as any;
}

console.log("groupUnmatchedTexts");
{
  const threads = groupUnmatchedTexts([
    msg({ id: 1, body: "Verify here: https://verify.canary.example/abc", sentAt: "2026-07-20T10:00:00Z" }),
    msg({ id: 2, direction: "outbound", body: "got it", guestPhone: "8085551234", sentAt: "2026-07-20T11:00:00Z" }),
    msg({ id: 3, guestPhone: "+18087742284", body: "aloha", sentAt: "2026-07-19T09:00:00Z", guestName: "PM · Alii" }),
  ]);
  check("groups by last-10 phone key across formats", threads.length === 2);
  const canary = threads.find((t) => t.phoneKey === "8085551234")!;
  check("thread messages are chat-ordered (oldest first)", canary.messages[0]!.id === 1 && canary.messages[1]!.id === 2);
  check("newest thread sorts first", threads[0]!.phoneKey === "8085551234");
  check("displayNumber formats", canary.displayNumber === "(808) 555-1234");
  check("newestInboundAt tracks the inbound row only", canary.newestInboundAt === "2026-07-20T10:00:00.000Z");
  check("label comes from any stamped guestName", threads[1]!.label === "PM · Alii");
}
{
  const threads = groupUnmatchedTexts([
    msg({ id: 1, direction: "outbound", body: "receipt text" }),
    msg({ id: 2, direction: "outbound", body: "second", sentAt: "2026-07-20T11:00:00Z" }),
  ]);
  check("outbound-only threads are dropped (receipt texts have a home already)", threads.length === 0);
}
{
  const threads = groupUnmatchedTexts([
    msg({ id: 1, guestPhone: "12" }),
    msg({ id: 2, guestPhone: "" }),
  ]);
  check("rows with no plausible phone are skipped, never crash", threads.length === 0);
}
{
  const threads = groupUnmatchedTexts([
    msg({ id: 1, reservationId: "res-123" }),
    msg({ id: 2, sentAt: "2026-07-20T12:00:00Z" }),
  ]);
  check("reservationId surfaces from any linked row", threads[0]!.reservationId === "res-123");
}

console.log("unread accounting");
{
  const threads = groupUnmatchedTexts([
    msg({ id: 1, sentAt: "2026-07-20T10:00:00Z" }),
    msg({ id: 2, guestPhone: "+18087742284", sentAt: "2026-07-18T10:00:00Z" }),
  ]);
  check("all unread with empty seen map", countUnreadUnmatchedThreads(threads, {}) === 2);
  const seen = { "8085551234": "2026-07-20T10:00:00.000Z" };
  check("seen-at-newest clears the thread", countUnreadUnmatchedThreads(threads, seen) === 1);
  check("stale seen stamp keeps unread", unmatchedThreadIsUnread(threads[0]!, { "8085551234": "2026-07-19T00:00:00.000Z" }));
  check("parse tolerates junk", Object.keys(parseUnmatchedSeenMap("not json")).length === 0);
  check("parse keeps string entries only", parseUnmatchedSeenMap('{"a":"2026-01-01","b":5}')["a"] === "2026-01-01" && !("b" in parseUnmatchedSeenMap('{"a":"2026-01-01","b":5}')));
  check("seen key is stable", UNMATCHED_TEXTS_SEEN_KEY === "nexstay_unmatched_texts_seen_v1");
}

console.log("source guards — server");
{
  const routes = read("server/routes.ts");
  check("GET /api/inbox/unmatched-texts route exists", routes.includes('app.get("/api/inbox/unmatched-texts"'));
  check("reply route exists", routes.includes('app.post("/api/inbox/unmatched-texts/reply"'));
  check("link route exists", routes.includes('app.post("/api/inbox/unmatched-texts/link"'));
  check("list route groups via the shared module", /groupUnmatchedTexts\(rows/.test(routes));
  // The reply must stay conversation-less so it remains part of the unmatched
  // thread — stamping a fake conversationId would strand it invisibly.
  const replyBlock = routes.split('app.post("/api/inbox/unmatched-texts/reply"')[1]?.slice(0, 1600) ?? "";
  check("reply sends with conversationId null", /conversationId:\s*null/.test(replyBlock));

  const storage = read("server/storage.ts");
  check("storage filters to conversation-less rows (NULL or '')", /getUnmatchedQuoSmsMessages[\s\S]{0,400}IS NULL OR \$\{quoSmsMessages\.conversationId\} = ''/.test(storage));
  check("link stamp is scoped to conversation-less rows only", /stampUnmatchedQuoSmsReservation[\s\S]{0,700}IS NULL OR \$\{quoSmsMessages\.conversationId\} = ''/.test(storage));

  const auth = read("server/auth.ts");
  check("agent allowlist: GET unmatched-texts", auth.includes('path === "/api/inbox/unmatched-texts") return true'));
  check("agent allowlist: POST reply", auth.includes('path === "/api/inbox/unmatched-texts/reply") return true'));
  check("agent allowlist: link-to-booking deliberately NOT listed", !auth.includes('"/api/inbox/unmatched-texts/link"'));
}

console.log("source guards — client");
{
  const inbox = read("client/src/pages/inbox.tsx");
  check("Texts tab trigger renders", inbox.includes('data-testid="tab-texts"'));
  check("Texts tab content mounts the component", inbox.includes("<UnmatchedTextsTab"));
  check("badge derives from shared unread counter", inbox.includes("countUnreadUnmatchedThreads("));
  // Both roles see the tab: the trigger must NOT sit inside a {!isAgent && (...)
  // gate (Canary links often need forwarding by the agent team).
  const triggerIdx = inbox.indexOf('data-testid="tab-texts"');
  const before = inbox.slice(Math.max(0, triggerIdx - 700), triggerIdx);
  check("Texts tab is not agent-gated", !/\{!isAgent && \($/m.test(before.split("TabsTrigger").pop() ?? "") && !before.includes("{!isAgent && (\n              <TabsTrigger value=\"texts\""));

  const tab = read("client/src/components/unmatched-texts-tab.tsx");
  check("component fetches the list endpoint", tab.includes('"/api/inbox/unmatched-texts"'));
  check("reply posts to the reply endpoint", tab.includes('"/api/inbox/unmatched-texts/reply"'));
  check("URLs render clickable via the shared segment splitter", tab.includes("splitEmailBodyIntoSegments"));
  check("link bubbles open in a new tab", tab.includes('target="_blank"'));
  check("thread read-stamp persists to the shared localStorage key", tab.includes("UNMATCHED_TEXTS_SEEN_KEY"));
}

if (failures > 0) {
  console.error(`\n${failures} unmatched-texts test(s) failed`);
  process.exit(1);
}
console.log("\nAll unmatched-texts tests passed");
