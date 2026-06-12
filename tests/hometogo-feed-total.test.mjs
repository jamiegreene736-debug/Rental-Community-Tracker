// Locks htgPickFeedTotal's field list against HomeToGo's ACTUAL /searchdetails schema.
// The worker's first cut probed speculative names (totalResults/nbHits/count/...) that do
// NOT exist on HomeToGo, so it always returned 0 and the completeness guard silently degraded
// to plateau-only. These fixtures are trimmed from REAL captured bodies (Poipu) — if HomeToGo
// renames the field or someone reverts to speculative names, this test goes red.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { htgPickFeedTotal } from "../daemon/vrbo-sidecar/htg-feed-total.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(here, "fixtures", f), "utf8"));

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("hometogo-feed-total: htgPickFeedTotal vs the real /searchdetails schema");

// THE regression lock: the real body reports 1,503 offers under searchSummary.
{
  const body = load("htg-searchdetails-with-summary.json");
  check("real Poipu body → 1503 (searchSummary.totalCountRaw), NOT 0", htgPickFeedTotal(body) === 1503, htgPickFeedTotal(body));
  // confirm it ignores the broader totalRaw=2936 (which would over-count and false-flag)
  check("does NOT pick top-level totalRaw=2936", htgPickFeedTotal(body) !== body.totalRaw, body.totalRaw);
  // confirm it ignores locationCountRaw=1781 (a larger location metric)
  check("does NOT pick searchSummary.locationCountRaw=1781", htgPickFeedTotal(body) !== body.searchSummary.locationCountRaw, body.searchSummary.locationCountRaw);
}

// Comma-string handling: totalCount is "1,503"; Number("1,503") is NaN, so the strip matters.
check("comma string {searchSummary:{totalCount:'1,503'}} → 1503", htgPickFeedTotal({ searchSummary: { totalCount: "1,503" } }) === 1503);
check("numeric {searchSummary:{totalCountRaw:1503}} → 1503", htgPickFeedTotal({ searchSummary: { totalCountRaw: 1503 } }) === 1503);
check("label '1,503 offers' is digit-only-stripped → 1503", htgPickFeedTotal({ searchSummary: { totalCountLabel: "1,503" } }) === 1503);

// No total exposed → 0 (guard then falls back to plateau-detection).
check("no searchSummary → 0", htgPickFeedTotal(load("htg-searchdetails-no-total.json")) === 0);
check("null → 0", htgPickFeedTotal(null) === 0);
check("{} → 0", htgPickFeedTotal({}) === 0);
check("garbage searchSummary → 0", htgPickFeedTotal({ searchSummary: { totalCountRaw: "n/a" } }) === 0);
// the OLD speculative names must NOT be read (they aren't HomeToGo's shape)
check("speculative {totalResults:99} (not HTG's shape) → 0", htgPickFeedTotal({ totalResults: 99 }) === 0);
check("absurd value ignored ({searchSummary:{totalCountRaw:5_000_000}}) → 0", htgPickFeedTotal({ searchSummary: { totalCountRaw: 5_000_000 } }) === 0);

console.log(`\nhometogo-feed-total: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
