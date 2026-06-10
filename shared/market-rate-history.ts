// Annotate a freshly-scanned `monthlyRates` map with the PRIOR scan's value per
// month, so the pricing table can show a "was $X" scan-over-scan reference in
// each rate cell.
//
// `property_market_rates.monthlyRates` is jsonb and `upsertPropertyMarketRate`
// DELETEs + re-INSERTs the row on every scan, so the prior monthlyRates is lost
// unless we copy it forward first. Storing the previous value INSIDE the jsonb
// needs no migration and travels with the row through the read/sanitize/client
// pipeline automatically.
//
// Pure + dependency-free so it can be unit-tested without a database.

export type MonthlyRateLike = {
  medianNightly?: number | null;
  previousMedianNightly?: number;
  previousRefreshedAt?: string;
  [key: string]: unknown;
};

/**
 * For each month in `next`, set `previousMedianNightly` (+ when that prior scan
 * ran, `previousRefreshedAt`) from the matching month in `prior`. Mutates and
 * returns `next`.
 *
 * Load-bearing details:
 * - The previous value is the prior row's CURRENT `medianNightly`, never its
 *   own `previousMedianNightly` — so "previous" always means the immediately
 *   prior scan, with NO chaining of previous-of-previous.
 * - A month with no usable prior value is left clean (any stale previous fields
 *   are stripped) so a cell never shows a "was" that didn't come from a scan.
 */
export function annotatePreviousMonthlyRates(
  next: Record<string, MonthlyRateLike> | null | undefined,
  prior: Record<string, MonthlyRateLike> | null | undefined,
  priorRefreshedAt?: string | null,
): Record<string, MonthlyRateLike> | null | undefined {
  if (!next || typeof next !== "object" || Array.isArray(next)) return next;
  const priorMap = prior && typeof prior === "object" && !Array.isArray(prior) ? prior : {};
  const refreshedAt = typeof priorRefreshedAt === "string" && priorRefreshedAt ? priorRefreshedAt : undefined;
  for (const payload of Object.values(next)) {
    if (!payload || typeof payload !== "object") continue;
    delete payload.previousMedianNightly;
    delete payload.previousRefreshedAt;
  }
  for (const [yearMonth, payload] of Object.entries(next)) {
    if (!payload || typeof payload !== "object") continue;
    const priorMedian = Number(priorMap[yearMonth]?.medianNightly);
    if (!Number.isFinite(priorMedian) || priorMedian <= 0) continue;
    payload.previousMedianNightly = Math.round(priorMedian);
    if (refreshedAt) payload.previousRefreshedAt = refreshedAt;
  }
  return next;
}
