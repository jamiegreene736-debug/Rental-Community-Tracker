// vrp_main fingerprint probe.
//
// PR #308: Given a candidate PM hostname (or full URL), figure out
// whether the site runs the `vrp_main` (a.k.a. "vrpjax") WordPress
// vacation-rental plugin. When it does, we can auto-add the site to
// the existing `VRP_SITES` registry — no per-PM scraper code needed,
// because every vrp_main site exposes the same sitemap + JSON
// endpoints (see server/pm-scraper-vrp.ts header for the contract).
//
// Detection has two paths:
//
//   1. Canonical sitemap probe — `${baseUrl}/?vrpsitemap=1` returns
//      XML with `<loc>` entries matching the
//      `${baseUrl}/vrp/unit/<slug>-<id>-<id>` shape. This is the
//      preferred path because the sitemap also enumerates every unit
//      on the site, which `pm-scraper-vrp.ts` then walks.
//
//   2. HTML-fingerprint fallback (PR #330) — when the sitemap probe
//      returns non-XML or 4xx, fall back to fetching the homepage and
//      looking for the `vrp_main` plugin's tell-tale markers
//      (`vrpjax` JS reference, `wp-content/plugins/vrp_main/` script
//      src, or hrefs into `/vrp/unit/...`). Some PMs (e.g.
//      gathervacations.com) run a customised vrp_main fork that 200s
//      the sitemap path with HTML or has its rate-quote AJAX
//      stripped, so the canonical path mis-classifies them. The
//      fallback flags them as `vrp_main` so the operator sees them in
//      the discovery report, but sets `customized: true` to signal
//      that a one-line VRP_SITES config probably will NOT yield live
//      rates and a bespoke scraper is needed.
//
// Auth: anonymous. The sitemap and homepages are public on every
// vrp_main site I've looked at.
//
// Cost: one HTTP GET per probe in the happy path, two when the
// fallback fires (~1-3s wall each). Cached in-memory by hostname for
// 7 days because the answer doesn't change unless the PM rebuilds
// their site, which is a once-per-multi-year event.

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
  /** True iff the sitemap or the HTML-fallback returned the vrp_main fingerprint. */
  isVrpMain: boolean;
  /** When `isVrpMain`, the count of `/vrp/unit/` paths discovered. */
  unitCount?: number;
  /**
   * Which path matched. `"sitemap"` is the canonical XML route; the
   * rate-quote AJAX (`?vrpjax=1&act=getUnitRates&unitId=N`) is
   * reliably present and a one-line VRP_SITES config will work.
   * `"html-fallback"` means the plugin markers were detected on the
   * homepage but the sitemap was non-XML — a customized fork; rates
   * may need a bespoke scraper. `undefined` when not vrp_main.
   */
  detectionPath?: "sitemap" | "html-fallback";
  /**
   * Set when `detectionPath === "html-fallback"`. Hints to the
   * operator that the standard `?vrpjax=1&act=getUnitRates` endpoint
   * may not be available; check before adding to VRP_SITES.
   */
  customized?: boolean;
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
      // Try the HTML fallback before giving up — some hosts 403 the
      // sitemap path entirely (Cloudflare bot rules) but still serve
      // the homepage with vrp_main markers.
      const fb = await tryHtmlFallback(norm, startedAt, `sitemap HTTP ${r.status}`);
      result = fb;
    } else {
      const body = await r.text();
      // Quick reject — canonical vrp_main always responds with XML;
      // HTML 404 pages or customised forks (e.g. gathervacations.com)
      // 200 OK with HTML, so try the HTML fallback before giving up.
      if (!/<urlset[\s>]/i.test(body) && !/<\?xml/i.test(body)) {
        const fb = await tryHtmlFallback(norm, startedAt, "sitemap response was not XML");
        result = fb;
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
            detectionPath: "sitemap",
            unitCount,
            durationMs: Date.now() - startedAt,
          };
        }
      }
    }
  } catch (e: any) {
    // Network/timeout errors on the sitemap path don't justify a
    // homepage fallback — the host is unreachable.
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
 * HTML-fingerprint fallback. Fetch the homepage and look for the
 * vrp_main plugin's tell-tale markers:
 *   - `wp-content/plugins/vrp_main/` script src or asset URL
 *   - `vrpjax` JS reference (the plugin's AJAX namespace)
 *   - hrefs to `/vrp/unit/...` paths (the plugin's listing routes)
 *
 * Returns `isVrpMain: true, detectionPath: "html-fallback",
 * customized: true` when at least one strong marker plus at least
 * one `/vrp/unit/` href is present. The `customized` flag warns the
 * operator that this PM may have stripped or renamed the standard
 * rate-quote AJAX (gathervacations.com is the canonical example —
 * the plugin loads but `?vrpjax=1&act=getUnitRates&unitId=N` returns
 * 0 bytes; rates are rendered server-side into the unit page HTML).
 */
async function tryHtmlFallback(
  norm: { baseUrl: string; hostname: string },
  startedAt: number,
  primaryReason: string,
): Promise<VrpDetectResult> {
  try {
    const r = await fetch(norm.baseUrl + "/", {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        Accept: "text/html, */*",
      },
      signal: AbortSignal.timeout(FINGERPRINT_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!r.ok) {
      return {
        input: norm.baseUrl,
        baseUrl: norm.baseUrl,
        hostname: norm.hostname,
        isVrpMain: false,
        reason: `${primaryReason}; homepage HTTP ${r.status}`,
        durationMs: Date.now() - startedAt,
      };
    }
    const html = await r.text();
    const hasPluginAsset = /wp-content\/plugins\/vrp[_-]?main\b/i.test(html);
    const hasVrpjax = /\bvrpjax\b/i.test(html);
    const unitHrefRe = /\/vrp\/unit\/[A-Za-z0-9_-]+\/?/gi;
    const unitHrefMatches = html.match(unitHrefRe);
    const distinctUnitPaths = new Set(unitHrefMatches?.map((s) => s.replace(/\/+$/, "")) ?? []);
    // Strong marker: plugin asset OR vrpjax reference. /vrp/unit/
    // hrefs alone aren't enough — a generic blog could link to a
    // /vrp/unit/ URL on a different vrp_main site.
    const strongMarker = hasPluginAsset || hasVrpjax;
    if (strongMarker && distinctUnitPaths.size > 0) {
      return {
        input: norm.baseUrl,
        baseUrl: norm.baseUrl,
        hostname: norm.hostname,
        isVrpMain: true,
        detectionPath: "html-fallback",
        customized: true,
        unitCount: distinctUnitPaths.size,
        reason: primaryReason, // keep the why-we-fell-back hint
        durationMs: Date.now() - startedAt,
      };
    }
    return {
      input: norm.baseUrl,
      baseUrl: norm.baseUrl,
      hostname: norm.hostname,
      isVrpMain: false,
      reason: `${primaryReason}; no vrp_main markers in homepage`,
      durationMs: Date.now() - startedAt,
    };
  } catch (e: any) {
    return {
      input: norm.baseUrl,
      baseUrl: norm.baseUrl,
      hostname: norm.hostname,
      isVrpMain: false,
      reason: `${primaryReason}; homepage probe error: ${e?.message ?? String(e)}`.slice(0, 200),
      durationMs: Date.now() - startedAt,
    };
  }
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
