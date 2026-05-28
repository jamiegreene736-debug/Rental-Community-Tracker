export type OtaProvider = "airbnb" | "vrbo" | "booking";

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "near",
  "with",
  "resort",
  "resorts",
  "community",
  "complex",
  "estate",
  "estates",
  "villa",
  "villas",
]);

export function normalizeResortSearchTerm(raw: string | null | undefined): string {
  return String(raw ?? "")
    .replace(/\s*\(.*?\)\s*$/g, "")
    .replace(/\s*,?\s*(resorts?|community|complex|estates?|villas?)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function searchVariationTokens(raw: string | null | undefined): string[] {
  return normalizeResortSearchTerm(raw)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

export function matchesSearchVariationTokens(
  value: string | null | undefined,
  requiredTokens: string[],
): boolean {
  const tokens = Array.from(new Set(requiredTokens.map((token) => token.toLowerCase().trim()).filter(Boolean)));
  if (tokens.length === 0) return true;
  const haystack = String(value ?? "").toLowerCase();
  if (tokens.length <= 2) return tokens.every((token) => haystack.includes(token));
  return tokens.filter((token) => haystack.includes(token)).length >= 2;
}

export function searchVariationKey(input: {
  community?: string | null;
  city?: string | null;
  state?: string | null;
}): string {
  return [input.community, input.city, input.state]
    .map((part) => String(part ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim())
    .filter(Boolean)
    .join("|");
}

export function generateSearchVariations(
  raw: string | null | undefined,
  requiredTokens: string[] = [],
): string[] {
  const base = normalizeResortSearchTerm(raw);
  const tokens = requiredTokens.length ? requiredTokens : searchVariationTokens(base);
  const out = new Map<string, string>();
  const add = (value: string | null | undefined) => {
    const clean = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!clean) return;
    if (!matchesSearchVariationTokens(clean, tokens)) return;
    out.set(clean.toLowerCase(), clean);
  };

  add(base);
  add(raw);
  if (base && !/\b(resort|community|complex)\b/i.test(base)) {
    add(`${base} Resort`);
  }
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    add(parts.join(" "));
    add(parts.slice(0, 2).join(" "));
  }

  return Array.from(out.values()).slice(0, 12);
}
