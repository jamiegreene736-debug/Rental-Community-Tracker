// Pure helper: read HomeToGo's own reported offer total out of a /searchdetails JSON body.
// Lives in its own module (no Playwright/daemon deps) so tests can lock the field list
// against the REAL captured payload shape — the worker's first cut probed speculative
// field names (totalResults/nbHits/...) that DON'T exist on HomeToGo and always returned 0,
// silently degrading the completeness guard to plateau-only. See tests/hometogo-feed-total.test.mjs
// and the captured fixtures under tests/fixtures/.
//
// The real shape (verified against live captures, e.g. Poipu): the scoped OFFER total lives at
//   searchSummary.totalCountRaw = 1503   (numeric)
//   searchSummary.totalCount    = "1,503" (comma string)
//   searchSummary.totalCountLabel/seoHeading = "1,503 offers"
// Our harvest dedupes offers by id ~1:1, so this offer total is the apples-to-apples
// reconciliation target. Deliberately NOT searchSummary.locationCountRaw (a larger location
// metric, 1781) nor the top-level totalRaw (2936, a broader pool count) — both over-count and
// would manufacture false "incomplete" flags.
export function htgPickFeedTotal(j) {
  if (!j || typeof j !== "object") return 0;
  const ss = j.searchSummary && typeof j.searchSummary === "object" ? j.searchSummary : {};
  const toNum = (c) => {
    if (c == null) return 0;
    const n = Number(String(c).replace(/,/g, "").trim());
    return Number.isFinite(n) ? Math.round(n) : 0;
  };
  let best = 0;
  for (const c of [ss.totalCountRaw, ss.totalCount, ss.totalCountLabel]) {
    const n = toNum(c);
    if (n > best) best = n;
  }
  // Sanity: a search's offer total is realistically < 1,000,000; ignore anything absurd.
  return best > 0 && best < 1_000_000 ? best : 0;
}
