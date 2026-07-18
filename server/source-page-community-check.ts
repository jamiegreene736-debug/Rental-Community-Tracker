// Source-page community verification — the second, independent leg of the
// "Check photo community" flow. For each unit that carries a source listing URL
// (the Zillow / Redfin / Realtor / VRBO / Airbnb / Guesty page its photos were
// scraped from), fetch the page, extract its readable location signals, and ask
// Claude whether the listing sits in the expected community/area.
//
// Fully FAIL-SOFT: a missing URL, a failed/blocked fetch, an empty JS-only page,
// or a missing ANTHROPIC key all resolve to "uncertain" (never a throw, never a
// false "no"). Only a page that POSITIVELY names a different community/city yields
// a "no" — matching the load-bearing posture of the photo leg and the combo gate.

import {
  buildSourcePageCommunityPrompt,
  extractLastJsonObject,
  extractSourcePageSignals,
  looksLikeBotWallPage,
  parseSourcePageVerdict,
  signalsAreEmpty,
  signalsFromListingJson,
  type SourcePageSignals,
  type SourcePageVerdict,
} from "../shared/source-page-community-logic";
import { callClaudeJson } from "./claude-json";

const SOURCE_PAGE_MODEL = process.env.SOURCE_PAGE_COMMUNITY_MODEL || "claude-sonnet-4-6";
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_BYTES = 900_000;
const FETCH_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
/** Cap concurrent page fetches so a big combo never floods the network. */
const MAX_CONCURRENCY = 3;

export type SourcePageUnitInput = {
  label: string;
  sourceUrl?: string | null;
};

/** Bounded, fail-open page fetch. Returns null on any error / non-text / empty. */
export async function fetchSourcePageHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": FETCH_UA, "accept-language": "en-US,en;q=0.9" },
    });
    if (!resp.ok) return null;
    const ct = (resp.headers.get("content-type") ?? "").toLowerCase();
    if (ct && !/text|html|json|xml/.test(ct)) return null;
    const body = await resp.text();
    if (!body) return null;
    return body.length > FETCH_MAX_BYTES ? body.slice(0, FETCH_MAX_BYTES) : body;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Apify rescue tier. Zillow (and increasingly Redfin/Realtor) 403-bot-wall every
// plain HTTP fetch — from Railway's datacenter IP it is guaranteed, and even a
// residential curl gets PerimeterX'd (verified live 2026-07-18: HTTP 403 on a
// direct fetch with a browser UA). So the direct fetch above mostly worked only
// for PM sites, and every Zillow-sourced unit rendered "Page unreadable".
//
// The rescue reuses the SAME Apify detail actors the photo pipeline already
// pays for (~$0.005-0.01/result) and builds the location signals from their
// structured JSON — which carries the full street/city/state, i.e. BETTER
// signals than scraped HTML. Deliberately NOT the local Chrome sidecar
// (operator directive 2026-07-18): this is a text/address check, not a photo
// gallery harvest — no reason to burn the sidecar wallet or depend on the
// operator's Mac being awake.
//
// Fail-soft: no token / unsupported host / actor failure all return null and
// the verdict stays the honest "unreadable" it is today. Kill switch
// SOURCE_PAGE_APIFY_RESCUE=0.
// ---------------------------------------------------------------------------

const APIFY_RESCUE_TIMEOUT_MS = Number(process.env.SOURCE_PAGE_APIFY_TIMEOUT_MS || 150_000);

/** Actor for a source host, or null when the host has no Apify detail scraper. */
function apifyActorForSourceHost(host: string): string | null {
  const h = host.toLowerCase().replace(/^www\./, "");
  const is = (domain: string) => h === domain || h.endsWith(`.${domain}`);
  if (is("zillow.com")) return (process.env.APIFY_ZILLOW_ACTOR || "maxcopell~zillow-detail-scraper").replace("/", "~");
  if (is("redfin.com")) return (process.env.APIFY_REDFIN_ACTOR || "kawsar~redfin-details-scraper").replace("/", "~");
  if (is("realtor.com")) return (process.env.APIFY_REALTOR_ACTOR || "dz_omar~realtor-scraper").replace("/", "~");
  return null;
}

// Per-URL result cache. The audit sweep's community-consensus rail re-runs the
// full check up to 3×, and the photo-fix seam re-checks after fixes — without a
// cache every pass would re-spend an Apify run per unit. Successful signals are
// stable (the listing's address doesn't change), so a long TTL is safe;
// failures retry sooner.
const APIFY_SIGNALS_TTL_OK_MS = 12 * 60 * 60 * 1000;
const APIFY_SIGNALS_TTL_FAIL_MS = 10 * 60 * 1000;
const APIFY_SIGNALS_CACHE_CAP = 300;
const apifySignalsCache = new Map<string, { at: number; signals: SourcePageSignals | null }>();

/**
 * Fetch a source page's location signals via the host's Apify detail actor.
 * Returns null on any failure (no token, unsupported host, actor error, empty
 * result). Exported for the rescue-injection seam + smoke testing.
 */
export async function fetchSourcePageSignalsViaApify(url: string): Promise<SourcePageSignals | null> {
  if (process.env.SOURCE_PAGE_APIFY_RESCUE === "0") return null;
  const token = process.env.APIFY_API_TOKEN;
  if (!token) return null;
  let host = "";
  try { host = new URL(url).hostname; } catch { return null; }
  const actor = apifyActorForSourceHost(host);
  if (!actor) return null;

  const cached = apifySignalsCache.get(url);
  if (cached) {
    const ttl = cached.signals ? APIFY_SIGNALS_TTL_OK_MS : APIFY_SIGNALS_TTL_FAIL_MS;
    if (Date.now() - cached.at < ttl) return cached.signals;
    apifySignalsCache.delete(url);
  }

  let signals: SourcePageSignals | null = null;
  try {
    const api = `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
    const r = await fetch(api, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `startUrls` is the standard Apify pattern; `urls` covers the epctex-style
      // Realtor variant. Actors ignore unknown fields, so sending both is safe.
      body: JSON.stringify({ startUrls: [{ url }], urls: [url], maxItems: 1 }),
      signal: AbortSignal.timeout(APIFY_RESCUE_TIMEOUT_MS),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.warn(`[source-page:apify] HTTP ${r.status} for ${url}: ${body.slice(0, 200)}`);
    } else {
      const items: unknown = await r.json().catch(() => null);
      const item = Array.isArray(items) ? items[0] : null;
      if (item && typeof item === "object") {
        const extracted = signalsFromListingJson(item);
        if (!signalsAreEmpty(extracted)) {
          signals = extracted;
          console.log(`[source-page:apify] ${url} → ${extracted.addressHints.length} address hints via ${actor}`);
        } else {
          console.warn(`[source-page:apify] ${url} → item had no usable location fields`);
        }
      } else {
        console.warn(`[source-page:apify] empty dataset for ${url}`);
      }
    }
  } catch (e: any) {
    console.warn(`[source-page:apify] ${url}: ${e?.message ?? e}`);
  }

  if (apifySignalsCache.size >= APIFY_SIGNALS_CACHE_CAP) {
    const oldest = apifySignalsCache.keys().next().value;
    if (oldest !== undefined) apifySignalsCache.delete(oldest);
  }
  apifySignalsCache.set(url, { at: Date.now(), signals });
  return signals;
}

async function verifyOneSourcePage(
  unit: SourcePageUnitInput,
  expectedCommunity: string,
  apiKey: string,
  fetchHtml: (url: string) => Promise<string | null>,
  fetchRescueSignals: (url: string) => Promise<SourcePageSignals | null>,
): Promise<SourcePageVerdict> {
  const url = String(unit.sourceUrl ?? "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return {
      unitLabel: unit.label,
      url,
      match: "uncertain",
      reason: "No source listing URL recorded for this unit.",
      unreadable: true,
    };
  }

  // Guesty's own property pages are behind auth and carry no public location text —
  // fetching returns a login shell. Flag as unreadable rather than burning a Claude
  // call and reporting a misleading "uncertain".
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { host = ""; }
  if (host === "guesty.com" || host.endsWith(".guesty.com")) {
    return {
      unitLabel: unit.label,
      url,
      match: "uncertain",
      reason: "Source is a Guesty page (login-gated) — no public location text to verify.",
      unreadable: true,
    };
  }

  const html = await fetchHtml(url);
  // A bot-wall page (Zillow serves PerimeterX walls with HTTP 200 from some
  // edges) must not be treated as the listing — its "Access denied" title would
  // read as non-empty signals and burn a Claude call on junk.
  const directBlocked = !html || looksLikeBotWallPage(html);
  let signals: SourcePageSignals | null = directBlocked ? null : extractSourcePageSignals(html!);
  let readViaApify = false;

  // Direct fetch blocked or content-free → Apify rescue (structured listing
  // JSON from the host's detail actor). Fail-soft: null keeps the honest
  // "unreadable" verdict below.
  if (!signals || signalsAreEmpty(signals)) {
    const rescued = await fetchRescueSignals(url);
    if (rescued && !signalsAreEmpty(rescued)) {
      signals = rescued;
      readViaApify = true;
    }
  }

  if (!signals) {
    return {
      unitLabel: unit.label,
      url,
      match: "uncertain",
      reason: "Could not load the source page (blocked, timed out, or removed).",
      unreadable: true,
    };
  }
  if (signalsAreEmpty(signals)) {
    return {
      unitLabel: unit.label,
      url,
      match: "uncertain",
      reason: "Source page had no readable location text (JavaScript-only or blocked).",
      unreadable: true,
    };
  }

  const prompt = buildSourcePageCommunityPrompt(expectedCommunity, unit.label, signals);
  // maxTokens 600 (was 400): headroom for the model's occasional emit-JSON →
  // reconsider-aloud → emit-corrected-JSON pattern (seen live on the Wavecrest
  // Unit A smoke). That pattern also breaks parseJsonLoose's first-brace-to-
  // last-brace fallback, so a parse failure first SALVAGES the LAST balanced
  // JSON object from the raw text (the model's final answer), then retries
  // once. Real key/HTTP errors are NOT retried (they would fail identically).
  const callOnce = () =>
    callClaudeJson<Record<string, unknown>>({
      model: SOURCE_PAGE_MODEL,
      maxTokens: 600,
      prompt,
      temperature: 0,
      apiKey,
      timeoutMs: 45_000,
    });
  let res = await callOnce();
  if (!res.ok && /parse JSON/i.test(res.error)) {
    const salvaged = res.raw ? extractLastJsonObject(res.raw) : null;
    if (salvaged) {
      res = { ok: true, data: salvaged, raw: res.raw! };
    } else {
      res = await callOnce();
      if (!res.ok && /parse JSON/i.test(res.error) && res.raw) {
        const retrySalvaged = extractLastJsonObject(res.raw);
        if (retrySalvaged) res = { ok: true, data: retrySalvaged, raw: res.raw };
      }
    }
  }
  if (!res.ok) {
    return {
      unitLabel: unit.label,
      url,
      match: "uncertain",
      reason: `Source-page analysis unavailable (${res.error}).`,
    };
  }
  const verdict = parseSourcePageVerdict(res.data, unit.label, url, expectedCommunity);
  if (readViaApify) {
    // Honesty note for the report UI: the page itself blocked us; the listing
    // data came from the Apify scraper instead.
    verdict.reason = `${verdict.reason} (page read via Apify scraper)`.trim();
  }
  return verdict;
}

/**
 * Verify each unit's source page against the expected community. Runs bounded-
 * concurrency; every leg is fail-soft so a partial failure never breaks the check.
 * `fetchHtml` is injectable for tests.
 */
export async function verifyUnitSourcePages(
  units: SourcePageUnitInput[],
  expectedCommunity: string,
  apiKey: string,
  fetchHtml: (url: string) => Promise<string | null> = fetchSourcePageHtml,
  fetchRescueSignals: (url: string) => Promise<SourcePageSignals | null> = fetchSourcePageSignalsViaApify,
): Promise<SourcePageVerdict[]> {
  const withUrls = units.filter((u) => String(u.sourceUrl ?? "").trim().length > 0);
  if (withUrls.length === 0) return [];

  const results: SourcePageVerdict[] = new Array(withUrls.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, withUrls.length) }, async () => {
    while (cursor < withUrls.length) {
      const idx = cursor++;
      try {
        results[idx] = await verifyOneSourcePage(withUrls[idx], expectedCommunity, apiKey, fetchHtml, fetchRescueSignals);
      } catch (e: any) {
        results[idx] = {
          unitLabel: withUrls[idx].label,
          url: String(withUrls[idx].sourceUrl ?? ""),
          match: "uncertain",
          reason: `Source-page check errored (${e?.message ?? e}).`,
          unreadable: true,
        };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
