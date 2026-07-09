const SEARCHAPI_QUOTA_RE = /used all of the searches|quota|rate.?limit|too many requests|upgrade your plan/i;
const SEARCHAPI_FALLBACK_INSTALLED = Symbol.for("rct.searchapiFallbackInstalled");
const nativeFetch = globalThis.fetch.bind(globalThis);

// KEY ROTATION (2026-07-09, operator): SEARCHAPI_API_KEY is the primary key;
// SEARCHAPI_API_KEY_2 (plus optional SEARCHAPI_API_KEY_3.._5 and the
// SEARCHAPI_API_KEY_SECONDARY alias) are rotation targets. When 2+ keys are
// configured, EVERY searchapi.io call rotates to the next key on a quota /
// rate-limit response — automatically, because installSearchApiFetchFallback()
// patches the global fetch and both it and fetchSearchApiWithFallback() read
// this list. With a single key the machinery short-circuits (keys.length <= 1)
// and behaves exactly as before. Order matters: the primary is always tried
// first; duplicate/blank values are dropped so a copy-paste can't skew rotation.
export function getSearchApiKeys(): string[] {
  const candidates = [
    process.env.SEARCHAPI_API_KEY,
    process.env.SEARCHAPI_API_KEY_2,
    process.env.SEARCHAPI_API_KEY_3,
    process.env.SEARCHAPI_API_KEY_4,
    process.env.SEARCHAPI_API_KEY_5,
    process.env.SEARCHAPI_API_KEY_SECONDARY,
  ];
  const keys: string[] = [];
  for (const candidate of candidates) {
    const key = String(candidate ?? "").trim();
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

export function getSearchApiKey(): string {
  return getSearchApiKeys()[0] ?? "";
}

export function isSearchApiQuotaError(status: number, body = ""): boolean {
  return status === 429 || SEARCHAPI_QUOTA_RE.test(body);
}

export async function fetchSearchApiWithFallback(
  params: URLSearchParams,
  init: RequestInit = {},
): Promise<Response> {
  const keys = getSearchApiKeys();
  if (keys.length === 0) throw new Error("SEARCHAPI_API_KEY not configured");

  let lastResponse: Response | null = null;
  for (let i = 0; i < keys.length; i++) {
    const nextParams = new URLSearchParams(params);
    nextParams.set("api_key", keys[i]);
    const response = await nativeFetch(`https://www.searchapi.io/api/v1/search?${nextParams.toString()}`, init);
    const quotaBody = response.ok ? "" : await response.clone().text().catch(() => "");
    if (!isSearchApiQuotaError(response.status, `${response.statusText} ${quotaBody}`) || i === keys.length - 1) {
      return response;
    }
    await response.body?.cancel().catch(() => {});
    lastResponse = response;
  }

  return lastResponse as Response;
}

function searchApiUrlFromInput(input: RequestInfo | URL): URL | null {
  try {
    if (typeof input === "string" || input instanceof URL) return new URL(input.toString());
    if (input instanceof Request) return new URL(input.url);
  } catch {
    return null;
  }
  return null;
}

function isSearchApiSearchUrl(url: URL | null): url is URL {
  if (!url) return false;
  return /(^|\.)searchapi\.io$/i.test(url.hostname) && url.pathname === "/api/v1/search";
}

function inputWithSearchApiKey(input: RequestInfo | URL, key: string): RequestInfo | URL {
  const url = searchApiUrlFromInput(input);
  if (!url) return input;
  url.searchParams.set("api_key", key);
  if (typeof input === "string") return url.toString();
  if (input instanceof URL) return url;
  if (input instanceof Request) return new Request(url.toString(), input);
  return input;
}

export function installSearchApiFetchFallback(): void {
  const globalWithFlag = globalThis as typeof globalThis & { [SEARCHAPI_FALLBACK_INSTALLED]?: boolean };
  if (globalWithFlag[SEARCHAPI_FALLBACK_INSTALLED]) return;
  globalWithFlag[SEARCHAPI_FALLBACK_INSTALLED] = true;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = searchApiUrlFromInput(input);
    if (!isSearchApiSearchUrl(url)) return nativeFetch(input, init);

    const keys = getSearchApiKeys();
    if (keys.length <= 1) return nativeFetch(input, init);

    const initialKey = url.searchParams.get("api_key")?.trim();
    const fallbackKeys = keys.filter((key) => key !== initialKey);
    const keysToTry = initialKey ? [initialKey, ...fallbackKeys] : keys;

    let lastResponse: Response | null = null;
    for (let i = 0; i < keysToTry.length; i++) {
      const response = await nativeFetch(inputWithSearchApiKey(input, keysToTry[i]), init);
      const quotaBody = response.ok ? "" : await response.clone().text().catch(() => "");
      if (!isSearchApiQuotaError(response.status, `${response.statusText} ${quotaBody}`) || i === keysToTry.length - 1) {
        return response;
      }
      await response.body?.cancel().catch(() => {});
      lastResponse = response;
      console.warn(`[searchapi] quota/rate-limit response; retrying with fallback key ${i + 2}/${keysToTry.length}`);
    }

    return lastResponse as Response;
  }) as typeof fetch;
}
