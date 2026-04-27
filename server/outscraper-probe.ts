// One-off Outscraper service discovery probe.
//
// The first three slugs we tried for the Vrbo scraper (/vrbo-search,
// /vrbo-properties — both via Grok review) returned HTTP 404. Auth
// works (404 vs 401 confirms the key), but we don't know the real
// service slug. Rather than burn another iteration of guesses, this
// endpoint fans out to ~10 likely Outscraper Vrbo paths in parallel
// and reports each path's HTTP status + first 300 chars of the body.
//
// Whichever returns 200 (or 4xx with a useful "did you mean X" hint)
// reveals the canonical slug. Operator can then set
// `OUTSCRAPER_VRBO_ENDPOINT` env var to that path and the existing
// Outscraper integration starts working.
//
// Cost: ~10 cheap GETs against Outscraper. No actor runs (these are
// metadata 404s, not full scrapes). Safe to call repeatedly.

const PROBE_BASE = "https://api.app.outscraper.com";
const CANDIDATE_PATHS = [
  // Specific Vrbo service variants we've seen mentioned across vendors
  "/vrbo-search",
  "/vrbo-properties",
  "/vrbo-listings",
  "/vrbo",
  "/vrbo-scraper",
  "/vrbo-property-listings",
  "/vacation-rentals",
  "/vacation-rentals-search",
  // Per Outscraper convention, services often share a base path
  "/vrbo-com",
  // Their generic universal endpoint sometimes works too
  "/services/vrbo",
];

export type OutscraperProbeResult = {
  path: string;
  fullUrl: string;
  httpStatus: number;
  bodyPreview: string;
};

export async function probeOutscraperVrbo(): Promise<{
  apiKey: "set" | "unset";
  results: OutscraperProbeResult[];
}> {
  const apiKey = process.env.OUTSCRAPER_API_KEY;
  if (!apiKey) {
    return { apiKey: "unset", results: [] };
  }

  // Use a minimal test query — same params for all paths so the
  // result delta is purely path differences.
  const testQuery = new URLSearchParams({
    query: "Koloa, HI",
    async: "false",
    limit: "1",
  });

  const results = await Promise.all(
    CANDIDATE_PATHS.map(async (path): Promise<OutscraperProbeResult> => {
      const fullUrl = `${PROBE_BASE}${path}?${testQuery.toString()}`;
      try {
        const r = await fetch(fullUrl, {
          method: "GET",
          headers: {
            "Authorization": `secret_${apiKey}`,
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(15_000),
        });
        const bodyText = await r.text().catch(() => "");
        return {
          path,
          fullUrl,
          httpStatus: r.status,
          bodyPreview: bodyText.slice(0, 300),
        };
      } catch (e: any) {
        return {
          path,
          fullUrl,
          httpStatus: 0,
          bodyPreview: `error: ${e?.message ?? e}`,
        };
      }
    }),
  );

  return { apiKey: "set", results };
}
