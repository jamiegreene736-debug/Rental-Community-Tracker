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
  extractSourcePageSignals,
  parseSourcePageVerdict,
  signalsAreEmpty,
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

async function verifyOneSourcePage(
  unit: SourcePageUnitInput,
  expectedCommunity: string,
  apiKey: string,
  fetchHtml: (url: string) => Promise<string | null>,
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
  if (!html) {
    return {
      unitLabel: unit.label,
      url,
      match: "uncertain",
      reason: "Could not load the source page (blocked, timed out, or removed).",
      unreadable: true,
    };
  }

  const signals = extractSourcePageSignals(html);
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
  const res = await callClaudeJson<Record<string, unknown>>({
    model: SOURCE_PAGE_MODEL,
    maxTokens: 400,
    prompt,
    temperature: 0,
    apiKey,
    timeoutMs: 45_000,
  });
  if (!res.ok) {
    return {
      unitLabel: unit.label,
      url,
      match: "uncertain",
      reason: `Source-page analysis unavailable (${res.error}).`,
    };
  }
  return parseSourcePageVerdict(res.data, unit.label, url, expectedCommunity);
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
): Promise<SourcePageVerdict[]> {
  const withUrls = units.filter((u) => String(u.sourceUrl ?? "").trim().length > 0);
  if (withUrls.length === 0) return [];

  const results: SourcePageVerdict[] = new Array(withUrls.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, withUrls.length) }, async () => {
    while (cursor < withUrls.length) {
      const idx = cursor++;
      try {
        results[idx] = await verifyOneSourcePage(withUrls[idx], expectedCommunity, apiKey, fetchHtml);
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
