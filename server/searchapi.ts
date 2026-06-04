const SEARCHAPI_QUOTA_RE = /used all of the searches|quota|rate.?limit|too many requests|upgrade your plan/i;

export function getSearchApiKeys(): string[] {
  const keys = [
    process.env.SEARCHAPI_API_KEY,
    process.env.SEARCHAPI_API_KEY_2,
    process.env.SEARCHAPI_API_KEY_SECONDARY,
  ]
    .map((key) => String(key ?? "").trim())
    .filter(Boolean);
  return Array.from(new Set(keys));
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
    const response = await fetch(`https://www.searchapi.io/api/v1/search?${nextParams.toString()}`, init);
    if (!isSearchApiQuotaError(response.status, response.statusText) || i === keys.length - 1) {
      return response;
    }
    await response.body?.cancel().catch(() => {});
    lastResponse = response;
  }

  return lastResponse as Response;
}
