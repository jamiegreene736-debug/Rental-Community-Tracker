// ─────────────────────────────────────────────────────────────────────────────
// Conservative LLM community classifier for the city-wide VRBO buy-in matcher.
//
// WHY: the deterministic matcher (shared/city-vrbo-combo.ts) clusters listings
// by curated dictionary + fuzzy + heuristic + photo/geo signals. It deliberately
// prefers a FALSE-NEGATIVE over a wrong pairing, so listings with GENERIC titles
// ("Ocean view 3BR"), unknown complexes, or odd misspellings can stay unpaired.
// This module is the recovery layer: ONE cheap Claude text pass over the priced
// pool that names each listing's specific complex/resort using world knowledge —
// robust to misspellings, abbreviations, and generic titles in ways regex can't.
//
// SAFETY (this output AUTO-attaches buy-ins → a wrong "same community" grouping
// sends a guest to two distant units, so precision is paramount):
//   - It only runs as a NO-PAIR recovery step (never overrides a deterministic
//     pair), gated behind ANTHROPIC_API_KEY + CITY_VRBO_LLM_COMMUNITY.
//   - The prompt is EXTREMELY conservative (positive identification only; "near
//     X" != "in X"; generic/ambiguous → null) — modeled on photo-community-check.
//   - We only apply confidence:"high" labels, and reject bare place / generic
//     labels here.
//   - MUTUAL VALIDATION: a label only ever forms a pair when >=2 listings share
//     it — which the matcher's "bucket needs >= bedroomPlan.length listings" gate
//     enforces for free (a singleton LLM label can never pair). So we don't even
//     need to special-case singletons here; the matcher gate is the guard.
//   - It populates `listing.complexName`; the matcher resolves that through the
//     same dictionary (so an LLM "poipu kie" still normalizes to poipu kai) or
//     keeps it as a specific complex key.
// ─────────────────────────────────────────────────────────────────────────────

import type { CityVrboListing } from "@shared/city-vrbo-combo";

const MODEL = process.env.CITY_VRBO_LLM_MODEL || "claude-sonnet-4-6";
const ANTHROPIC_TIMEOUT_MS = 30_000;
const MAX_LISTINGS = 120;

// Labels that must never become a community on their own (bare town/region or
// generic property type). Mirrors the matcher's PLACE/STRUCTURAL stopwords.
const PLACE_OR_GENERIC = new Set([
  "poipu", "kapaa", "kauai", "hawaii", "hi", "koloa", "princeville", "lihue",
  "wailua", "hanalei", "kalaheo", "lawai", "kilauea", "anahola", "kekaha", "waimea", "island",
  "condo", "condos", "villa", "villas", "resort", "resorts", "hotel", "spa",
  "beachfront", "oceanfront", "oceanview", "beach", "rental", "rentals", "home",
  "house", "apartment", "studio", "suite", "cottage", "vacation", "getaway", "retreat",
]);

type LlmLabel = { idx: number; community: string | null; confidence: "high" | "medium" | "low" };

function buildPrompt(targetCommunity: string, rows: Array<{ idx: number; title: string; snippet: string; host: string; town: string }>): string {
  const target = targetCommunity.trim();
  return `You are a conservative VRBO listing analyzer for a vacation-rental community matcher.

Your job: read VRBO listing metadata (title, snippet, host/property-manager, town) and identify the SPECIFIC named resort/complex each listing belongs to. Be EXTREMELY conservative — wrong answers send guests to distant units that are NOT the intended community.

RULES (non-negotiable):
1. POSITIVE IDENTIFICATION ONLY. Name a complex only if the metadata explicitly identifies it: a direct mention ("Poipu Kai Resort", "Regency at Poipu"), a clear misspelling/variant of a named complex, or a host/PM uniquely tied to one named complex. Any doubt → null.
2. REJECT LOCATIONAL LANGUAGE. "near/close to/short walk to/minutes from X", "X area", "in the X region" mean NEARBY, not IN that complex → null.
3. REJECT GENERIC/BOILERPLATE. "Poipu condo", "Ocean view 3BR", "Beachfront rental", bare place + property-type → null.
4. AMBIGUOUS = NULL, NOT A GUESS. Plausible-but-unproven is never a yes.
5. NEVER output a bare town/region ("poipu", "kauai") or a generic type ("condo", "resort") as the community. Only specific complex names.
${target ? `6. TARGET-COMMUNITY MISSPELLINGS. The booking's community is "${target}". Recognize and NORMALIZE clear misspellings/variants of it to its lowercase name (e.g. for "Poipu Kai": "Poipu Kie", "Poipu Kia", "Poepu Kai", "Regency at Poipu" → "${target.toLowerCase()}").` : ""}

OUTPUT: respond with ONLY a JSON array (no prose, no markdown), one object per input listing:
[{"idx": 0, "community": "poipu kai", "confidence": "high"}, {"idx": 1, "community": null, "confidence": "low"}]
- community: normalized lowercase specific complex name, or null. Never a bare place/type word.
- confidence: "high" (explicit name, zero doubt) | "medium" (strong signal, minor ambiguity) | "low" (vague/contradictory).

LISTINGS:
${JSON.stringify(rows)}`;
}

/**
 * Classify the pool's communities and MUTATE listing.complexName for the
 * high-confidence, specific labels (only where complexName is currently unset, so
 * it never overrides detail-page enrichment). Returns the number of listings
 * labeled. Best-effort: any failure (no key, non-JSON, timeout) returns 0 and the
 * pool is unchanged.
 */
export async function classifyCityListingCommunities(
  listings: CityVrboListing[],
  opts: { targetCommunity?: string | null } = {},
): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return 0;
  const targets = listings.slice(0, MAX_LISTINGS);
  if (targets.length === 0) return 0;

  const rows = targets.map((l, idx) => ({
    idx,
    title: String(l.title ?? "").slice(0, 140),
    snippet: String(l.snippet ?? "").slice(0, 160),
    host: String(l.propertyManager ?? "").slice(0, 60),
    town: String(l.locationText ?? "").slice(0, 60),
  }));
  const prompt = buildPrompt(String(opts.targetCommunity ?? ""), rows);

  let labels: LlmLabel[] = [];
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 4000, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS),
    });
    const data = await resp.json().catch(() => null) as any;
    if (!resp.ok) throw new Error(data?.error?.message ?? `HTTP ${resp.status}`);
    const text: string = data?.content?.[0]?.text ?? "";
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("LLM response was not a JSON array");
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) throw new Error("LLM response was not an array");
    labels = parsed as LlmLabel[];
  } catch (e: any) {
    console.error("[city-vrbo-llm] community classify failed:", e?.message ?? e);
    return 0;
  }

  const norm = (s: unknown): string => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  let labeled = 0;
  for (const row of labels) {
    if (!row || typeof row.idx !== "number") continue;
    if (row.confidence !== "high") continue; // confidence gate (Safety Rule 1)
    const t = targets[row.idx];
    if (!t || t.complexName) continue; // never override enrichment-set names
    const community = norm(row.community);
    if (!community) continue;
    const toks = community.split(" ").filter(Boolean);
    // Reject bare place / generic labels, and too-short single-word labels.
    if (toks.every((tok) => PLACE_OR_GENERIC.has(tok))) continue;
    if (toks.length === 1 && (toks[0].length < 6 || PLACE_OR_GENERIC.has(toks[0]))) continue;
    t.complexName = community;
    labeled += 1;
  }
  if (labeled > 0) {
    const byCommunity = new Map<string, number>();
    for (const t of targets) if (t.complexName) byCommunity.set(t.complexName, (byCommunity.get(t.complexName) ?? 0) + 1);
    const pairable = Array.from(byCommunity.entries()).filter(([, n]) => n >= 2).map(([c, n]) => `${c}=${n}`);
    console.log(
      `[city-vrbo-llm] labeled ${labeled}/${targets.length} listings via ${MODEL}; ` +
      `pairable communities (>=2): ${pairable.length ? pairable.join(" ") : "none"}`,
    );
  }
  return labeled;
}
