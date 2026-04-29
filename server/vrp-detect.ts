// vrp_main fingerprint probe.
//
// PR #308: Given a candidate PM hostname (or full URL), figure out
// whether the site runs the `vrp_main` (a.k.a. "vrpjax") WordPress
// vacation-rental plugin. When it does, we can auto-add the site to
// the existing `VRP_SITES` registry — no per-PM scraper code needed,
// because every vrp_main site exposes the same sitemap + JSON
// endpoints (see server/pm-scraper-vrp.ts header for the contract).
//
// Detection works by hitting `${baseUrl}/?vrpsitemap=1` and checking
// for the canonical XML shape: `<urlset>` containing `<loc>` entries
// that match `${baseUrl}/vrp/unit/<slug>-<id>-<id>`.
//
// Auth: anonymous. The sitemap is public on every vrp_main site I've
// looked at. Failure modes:
//   - Domain doesn't resolve / TCP-rejects → not vrp_main
//   - 200 OK but body is HTML (WordPress 404 page) → not vrp_main
//   - 200 OK with valid XML but no `/vrp/unit/` paths → not vrp_main
//     (some WordPress sites have generic ?sitemap=1 routes that 200
//     with unrelated content)
//   - 200 OK with valid XML and ≥1 `/vrp/unit/` path → IS vrp_main
//
// Cost: one HTTP GET per probe, ~1-3s wall. Cached in-memory by
// hostname for 7 days because the answer doesn't change unless the
// PM rebuilds their site, which is a once-per-multi-year event.

const FINGERPRINT_TIMEOUT_MS = 8_000;
const PROBE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d

const probeCache = new Map<string, { result: VrpDetectResult; expiresAt: number }>();

export type VrpDetectResult = {
  /** Original input as supplied. */
  input: string;
  /** Normalized base URL we probed (no trailing slash). */
  baseUrl: string;
  /** Canonical hostname, lower-cased, www. stripped. */
  hostname: string;
  /** True iff the sitemap returned the vrp_main fingerprint. */
  isVrpMain: boolean;
  /** When `isVrpMain`, the count of `/vrp/unit/` paths in the sitemap. */
  unitCount?: number;
  /** When detection failed (network, parse, 404), short reason. */
  reason?: string;
  /** ms wall to probe (excluding cache hits). */
  durationMs: number;
};

function normalizeBaseUrl(input: string): { baseUrl: string; hostname: string } | null {
  let url: URL;
  try {
    // Accept hostnames or full URLs. If no protocol given, default to https.
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
  const hostname = url.hostname.replace(/^www\./i, "").toLowerCase();
  // Always probe https with the canonical (www-stripped) hostname.
  // Most vrp_main sites redirect http→https and may force www, but
  // the sitemap responds correctly either way once the WP front
  // controller routes the request.
  const baseUrl = `https://${hostname}`;
  return { baseUrl, hostname };
}

/**
 * Probe a URL or hostname for the vrp_main plugin fingerprint.
 * Idempotent + cached for 7 days per hostname.
 */
export async function detectVrpSite(input: string): Promise<VrpDetectResult> {
  const startedAt = Date.now();
  const norm = normalizeBaseUrl(input);
  if (!norm) {
    return {
      input,
      baseUrl: "",
      hostname: "",
      isVrpMain: false,
      reason: "could not parse URL/hostname",
      durationMs: 0,
    };
  }

  const cached = probeCache.get(norm.hostname);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.result, input, durationMs: 0 };
  }

  const sitemapUrl = `${norm.baseUrl}/?vrpsitemap=1`;
  let result: VrpDetectResult;
  try {
    const r = await fetch(sitemapUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        Accept: "application/xml, text/xml, */*",
      },
      signal: AbortSignal.timeout(FINGERPRINT_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!r.ok) {
      result = {
        input,
        baseUrl: norm.baseUrl,
        hostname: norm.hostname,
        isVrpMain: false,
        reason: `sitemap HTTP ${r.status}`,
        durationMs: Date.now() - startedAt,
      };
    } else {
      const body = await r.text();
      // Quick reject — vrp_main always responds with XML; HTML 404
      // pages sometimes 200 OK on misconfigured WordPress sites.
      if (!/<urlset[\s>]/i.test(body) && !/<\?xml/i.test(body)) {
        result = {
          input,
          baseUrl: norm.baseUrl,
          hostname: norm.hostname,
          isVrpMain: false,
          reason: "sitemap response was not XML",
          durationMs: Date.now() - startedAt,
        };
      } else {
        // Match the canonical /vrp/unit/<slug>-<id>-<id> pattern. The
        // pm-scraper-vrp.ts walker uses this same shape; if these
        // entries are present, the rate/availability endpoints work.
        const unitPathRe = new RegExp(`<loc>\\s*${escapeRegExp(norm.baseUrl)}/vrp/unit/[A-Za-z0-9_-]+-\\d+-\\d+\\s*</loc>`, "gi");
        const matches = body.match(unitPathRe);
        const unitCount = matches?.length ?? 0;
        if (unitCount === 0) {
          result = {
            input,
            baseUrl: norm.baseUrl,
            hostname: norm.hostname,
            isVrpMain: false,
            reason: "no /vrp/unit/ paths found in sitemap",
            durationMs: Date.now() - startedAt,
          };
        } else {
          result = {
            input,
            baseUrl: norm.baseUrl,
            hostname: norm.hostname,
            isVrpMain: true,
            unitCount,
            durationMs: Date.now() - startedAt,
          };
        }
      }
    }
  } catch (e: any) {
    result = {
      input,
      baseUrl: norm.baseUrl,
      hostname: norm.hostname,
      isVrpMain: false,
      reason: `probe error: ${e?.message ?? String(e)}`.slice(0, 200),
      durationMs: Date.now() - startedAt,
    };
  }

  probeCache.set(norm.hostname, { result, expiresAt: Date.now() + PROBE_CACHE_TTL_MS });
  return result;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Probe a list of hostnames in parallel (capped concurrency to avoid
 * thundering 20 random PMs at once).
 */
export async function detectVrpSites(
  inputs: string[],
  opts: { concurrency?: number } = {},
): Promise<VrpDetectResult[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 5);
  const results: VrpDetectResult[] = [];
  let i = 0;
  async function worker() {
    while (i < inputs.length) {
      const idx = i++;
      results[idx] = await detectVrpSite(inputs[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, worker));
  return results;
}
