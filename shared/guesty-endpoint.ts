const GUESTY_API_ROOT = "https://open-api.guesty.com/v1";
const MAX_GUESTY_ENDPOINT_LENGTH = 8_192;

function encodeGuestyEndpointComponent(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error("Guesty endpoint contains malformed percent encoding.");
  }
  if (
    decoded === "."
    || decoded === ".."
    || decoded.includes("/")
    || decoded.includes("\\")
    || decoded.includes("%")
  ) {
    throw new Error("Guesty endpoint path traversal is not allowed.");
  }
  return encodeURIComponent(decoded);
}

/**
 * Build a Guesty Open API URL while keeping every caller-controlled component
 * out of the origin and escaping every individual path/query value. Callers
 * may choose an API path, but cannot inject a host, credentials, fragment, or
 * traversal segment.
 */
export function buildGuestyApiUrl(endpoint: unknown): string {
  if (typeof endpoint !== "string") throw new Error("Guesty endpoint must be a string.");
  if (
    endpoint.length === 0
    || endpoint.length > MAX_GUESTY_ENDPOINT_LENGTH
    || !endpoint.startsWith("/")
    || endpoint.startsWith("//")
    || endpoint.includes("\\")
    || endpoint.includes("#")
  ) {
    throw new Error("Guesty endpoint must be a safe relative API path.");
  }

  const question = endpoint.indexOf("?");
  const rawPath = question === -1 ? endpoint : endpoint.slice(0, question);
  const rawQuery = question === -1 ? "" : endpoint.slice(question + 1);
  const safePath = rawPath
    .split("/")
    .map((segment, index) => index === 0 ? "" : encodeGuestyEndpointComponent(segment))
    .join("/");

  const safeQueryParts: string[] = [];
  for (const [key, value] of new URLSearchParams(rawQuery)) {
    safeQueryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  const safeQuery = safeQueryParts.join("&");
  return `${GUESTY_API_ROOT}${safePath}${safeQuery ? `?${safeQuery}` : ""}`;
}
