// Refund-attention dismissals (2026-07-22 operator: "dismiss these messages
// individually and they won't show up again in the future") — pure store
// matrix + source guards on the route, the revenue-panel filter, and the
// dashboard Dismiss button.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RECEIPT_ATTENTION_DISMISSALS_CAP,
  RECEIPT_ATTENTION_DISMISSALS_KEY,
  addReceiptAttentionDismissal,
  dismissedReceiptTokenSet,
  parseReceiptAttentionDismissals,
  serializeReceiptAttentionDismissals,
} from "../shared/receipt-attention-dismissals";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(__dirname, "..", rel), "utf8");

console.log("receipt-attention-dismissals suite");

// ── pure store ──
{
  const empty = parseReceiptAttentionDismissals(null);
  assert.equal(empty.dismissed.length, 0);
  assert.equal(parseReceiptAttentionDismissals("not json").dismissed.length, 0);
  assert.equal(parseReceiptAttentionDismissals('{"version":2,"dismissed":[]}').dismissed.length, 0);

  const one = addReceiptAttentionDismissal(empty, "tok-a", "2026-07-22T00:00:00Z");
  assert.equal(one.dismissed.length, 1);
  // idempotent — a double-click can't duplicate
  assert.equal(addReceiptAttentionDismissal(one, "tok-a", "2026-07-22T01:00:00Z").dismissed.length, 1);
  // blank tokens never persist
  assert.equal(addReceiptAttentionDismissal(one, "  ", "2026-07-22T01:00:00Z").dismissed.length, 1);

  const roundTrip = parseReceiptAttentionDismissals(serializeReceiptAttentionDismissals(one));
  assert.ok(dismissedReceiptTokenSet(roundTrip).has("tok-a"));
  assert.ok(!dismissedReceiptTokenSet(roundTrip).has("tok-b"), "other tokens stay visible");

  // cap keeps the NEWEST entries
  let big = empty;
  for (let i = 0; i < RECEIPT_ATTENTION_DISMISSALS_CAP + 20; i++) {
    big = addReceiptAttentionDismissal(big, `tok-${i}`, "2026-07-22T00:00:00Z");
  }
  const capped = parseReceiptAttentionDismissals(serializeReceiptAttentionDismissals(big));
  assert.equal(capped.dismissed.length, RECEIPT_ATTENTION_DISMISSALS_CAP);
  assert.ok(dismissedReceiptTokenSet(capped).has(`tok-${RECEIPT_ATTENTION_DISMISSALS_CAP + 19}`), "newest survive the cap");
  assert.equal(RECEIPT_ATTENTION_DISMISSALS_KEY, "receipt_attention_dismissals.v1");
  console.log("  ✓ pure store: parse/serialize/idempotent add/cap/token set");
}

// ── source guards ──
{
  const routes = read("server/routes.ts");
  assert.ok(
    routes.includes('app.post("/api/inbox/guest-receipts/:token/dismiss-attention"'),
    "dismiss route missing",
  );
  // The revenue panel must EXCLUDE dismissed tokens — keyed by token so a new
  // failed refund receipt (new row/token) still raises.
  assert.ok(
    /\(channelIssue \|\| smsIssue\) && !dismissedTokens\.has\(row\.token\)/.test(routes),
    "revenue handler must filter dismissed tokens",
  );
  const home = read("client/src/pages/home.tsx");
  assert.ok(home.includes("button-dismiss-refund-"), "dashboard row must offer Dismiss");
  assert.ok(home.includes("dismiss-attention"), "Dismiss must call the dismiss route");
  assert.ok(/window\.confirm\([\s\S]{0,400}Nothing will be resent/.test(home), "Dismiss must confirm — it silences a money alert");
  console.log("  ✓ source guards: route + revenue filter + confirmed Dismiss button");
}

console.log("receipt-attention-dismissals suite passed");
