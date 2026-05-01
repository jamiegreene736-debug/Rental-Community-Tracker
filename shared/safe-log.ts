type SanitizeOptions = {
  maxLength?: number;
  maxDepth?: number;
  maxArrayLength?: number;
};

const DEFAULT_MAX_LENGTH = 12_000;
const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_ARRAY_LENGTH = 20;

const SENSITIVE_KEY =
  /^(api[_-]?key|apikey|key|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|pass|authorization|cookie|set-cookie|session|credential|private[_-]?key|jwt|bearer)$/i;

const URL_RE = /\bhttps?:\/\/[^\s"'<>`]+/gi;
const QUERY_SECRET_RE =
  /([?&](?:api[_-]?key|apikey|key|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|authorization|session)=)[^&\s"'<>`]+/gi;
const KEY_VALUE_SECRET_RE =
  /(["']?(?:api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|authorization|cookie|set-cookie|session|credential|private[_-]?key|jwt|bearer)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^,\s}\])]+)/gi;
const AUTH_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g;
const LOCAL_USER_PATH_RE = /\/Users\/[^/\s]+/g;
const LONG_VALUE_RE = /\b(?=[A-Za-z0-9._~+/=-]{32,}\b)(?=[A-Za-z0-9._~+/=-]*[A-Za-z])(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]+\b/g;

function trimTrailingUrlPunctuation(raw: string): { core: string; trailing: string } {
  const match = raw.match(/[)\].,;:!?]+$/);
  if (!match) return { core: raw, trailing: "" };
  return {
    core: raw.slice(0, -match[0].length),
    trailing: match[0],
  };
}

function shortUrlLabel(rawUrl: string): string {
  const { core, trailing } = trimTrailingUrlPunctuation(rawUrl);
  try {
    const url = new URL(core);
    const host = url.hostname.replace(/^www\./, "");
    const parts = url.pathname.split("/").filter(Boolean);
    const path = parts.length === 0 ? "" : `/${parts[0]}${parts.length > 1 ? "/..." : ""}`;
    return `[url:${host}${path}]${trailing}`;
  } catch {
    return `[url:redacted]${trailing}`;
  }
}

export function safeUrlHost(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return null;
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function sanitizeForChatText(input: unknown, opts: SanitizeOptions = {}): string {
  const maxLength = opts.maxLength ?? DEFAULT_MAX_LENGTH;
  let text = input instanceof Error
    ? `${input.name}: ${input.message}${input.stack ? `\n${input.stack}` : ""}`
    : String(input ?? "");

  text = text
    .replace(URL_RE, shortUrlLabel)
    .replace(QUERY_SECRET_RE, "$1[REDACTED]")
    .replace(KEY_VALUE_SECRET_RE, "$1[REDACTED]")
    .replace(AUTH_RE, "$1 [REDACTED]")
    .replace(EMAIL_RE, "[email redacted]")
    .replace(PHONE_RE, "[phone redacted]")
    .replace(LOCAL_USER_PATH_RE, "/Users/[user]")
    .replace(LONG_VALUE_RE, "[long value redacted]")
    .replace(/\[REDACTED\]\]+/g, "[REDACTED]");

  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n[truncated ${text.length - maxLength} chars]`;
}

export function sanitizeForChatValue(
  value: unknown,
  opts: SanitizeOptions = {},
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxArrayLength = opts.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH;

  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeForChatText(value, opts);
  if (typeof value === "undefined") return undefined;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeForChatText(value.message, opts),
      stack: value.stack ? sanitizeForChatText(value.stack, opts) : undefined,
    };
  }

  if (depth >= maxDepth) return "[max depth reached]";
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    const items = value
      .slice(0, maxArrayLength)
      .map((item) => sanitizeForChatValue(item, opts, depth + 1, seen));
    if (value.length > maxArrayLength) items.push(`[${value.length - maxArrayLength} more omitted]`);
    return items;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    out[key] = sanitizeForChatValue(child, opts, depth + 1, seen);
  }
  return out;
}

export function buildSafeErrorLog(
  error: unknown,
  context: Record<string, unknown> = {},
): string {
  const payload = {
    kind: "safe-debug-log",
    generatedAt: new Date().toISOString(),
    context,
    error: sanitizeForChatValue(error),
  };
  return JSON.stringify(sanitizeForChatValue(payload), null, 2);
}

type BuyInCandidateLogShape = {
  source?: string;
  sourceLabel?: string;
  url?: string;
  link?: string;
  bookingLink?: string;
  nightlyPrice?: number;
  totalPrice?: number;
  bedrooms?: number;
  price?: {
    extracted_total_price?: number;
    extracted_price_per_qualifier?: number;
    price_per_qualifier?: string;
  } | null;
  images?: unknown[];
  image?: unknown;
};

type SearchBucketLogShape = {
  count?: number;
  totalResults?: number;
  properties?: BuyInCandidateLogShape[];
  error?: string;
};

function summarizeCandidate(candidate: BuyInCandidateLogShape): Record<string, unknown> {
  const rawUrl = candidate.url ?? candidate.bookingLink ?? candidate.link;
  const totalPrice = candidate.totalPrice ?? candidate.price?.extracted_total_price ?? 0;
  const nightlyPrice = candidate.nightlyPrice ?? candidate.price?.extracted_price_per_qualifier ?? 0;

  return sanitizeForChatValue({
    source: candidate.source,
    sourceLabel: candidate.sourceLabel,
    urlHost: safeUrlHost(rawUrl),
    bedrooms: candidate.bedrooms,
    totalPrice,
    nightlyPrice,
    hasImage: Boolean(candidate.image) || Boolean(candidate.images?.length),
  }) as Record<string, unknown>;
}

function summarizeBuckets(buckets: Record<string, SearchBucketLogShape> | undefined): Record<string, unknown> {
  if (!buckets) return {};
  return Object.fromEntries(Object.entries(buckets).map(([key, bucket]) => [
    key,
    sanitizeForChatValue({
      requestedCount: bucket.count,
      totalResults: bucket.totalResults,
      returnedProperties: bucket.properties?.length ?? 0,
      error: bucket.error,
      sample: (bucket.properties ?? []).slice(0, 3).map(summarizeCandidate),
    }),
  ]));
}

export function buildBuyInSearchDebugLog(input: {
  status: "success" | "error";
  request: Record<string, unknown>;
  response?: {
    community?: string;
    resortName?: string | null;
    listingTitle?: string | null;
    bedrooms?: number;
    nights?: number;
    sources?: Record<string, BuyInCandidateLogShape[]>;
    cheapest?: BuyInCandidateLogShape[];
    totalPricedResults?: number;
    debug?: Record<string, unknown>;
  } | null;
  error?: unknown;
}): string {
  const sources = input.response?.sources ?? {};
  const payload = {
    kind: "safe-buy-in-search-log",
    generatedAt: new Date().toISOString(),
    status: input.status,
    route: "/api/operations/find-buy-in",
    request: input.request,
    response: input.response ? {
      community: input.response.community,
      resortName: input.response.resortName,
      listingTitle: input.response.listingTitle,
      bedrooms: input.response.bedrooms,
      nights: input.response.nights,
      sourceCounts: Object.fromEntries(
        Object.entries(sources).map(([source, items]) => [source, items.length]),
      ),
      cheapest: (input.response.cheapest ?? []).map(summarizeCandidate),
      totalPricedResults: input.response.totalPricedResults,
      debug: input.response.debug,
    } : undefined,
    error: input.error ? sanitizeForChatValue(input.error) : undefined,
    redaction: "Raw URLs, query strings, tokens, cookies, emails, phones, and long credential-like values are redacted.",
  };

  return JSON.stringify(sanitizeForChatValue(payload), null, 2);
}

export function buildBuyInTrackerSearchDebugLog(input: {
  status: "success" | "error";
  request: Record<string, unknown>;
  airbnb?: {
    community?: string;
    searchLocation?: string;
    checkIn?: string;
    checkOut?: string;
    unitsNeeded?: unknown[];
    searches?: Record<string, SearchBucketLogShape>;
  } | null;
  other?: {
    community?: string;
    checkIn?: string;
    checkOut?: string;
    unitsNeeded?: unknown[];
    vrbo?: Record<string, SearchBucketLogShape>;
    suiteParadise?: Record<string, SearchBucketLogShape>;
  } | null;
  selectedCounts?: Record<string, number>;
  error?: unknown;
}): string {
  const payload = {
    kind: "safe-buy-in-tracker-search-log",
    generatedAt: new Date().toISOString(),
    status: input.status,
    routes: ["/api/airbnb/search", "/api/vrbo/search"],
    request: input.request,
    airbnb: input.airbnb ? {
      community: input.airbnb.community,
      searchLocation: input.airbnb.searchLocation,
      checkIn: input.airbnb.checkIn,
      checkOut: input.airbnb.checkOut,
      unitsNeeded: input.airbnb.unitsNeeded,
      searches: summarizeBuckets(input.airbnb.searches),
    } : undefined,
    other: input.other ? {
      community: input.other.community,
      checkIn: input.other.checkIn,
      checkOut: input.other.checkOut,
      unitsNeeded: input.other.unitsNeeded,
      vrbo: summarizeBuckets(input.other.vrbo),
      suiteParadise: summarizeBuckets(input.other.suiteParadise),
    } : undefined,
    selectedCounts: input.selectedCounts,
    error: input.error ? sanitizeForChatValue(input.error) : undefined,
    redaction: "Raw URLs, query strings, tokens, cookies, emails, phones, and long credential-like values are redacted.",
  };

  return JSON.stringify(sanitizeForChatValue(payload), null, 2);
}
