// Community research helper — pulled out of routes.ts so both the single-city
// endpoint (/api/community/research) and the multi-city scanner
// (/api/community/scan-top-markets) can reuse the same Google + Claude pipeline.

import { checkCommunityType } from "@shared/community-type";

export type ResearchedCommunity = {
  name: string;
  city: string;
  state: string;
  estimatedLowRate: number | null;
  estimatedHighRate: number | null;
  unitTypes: string;
  confidenceScore: number;
  researchSummary: string;
  sourceUrl: string;
  bedroomMix?: string;
  combinedBedroomsTypical?: number;
  combinabilityScore?: number;
  fromWorldKnowledge?: boolean;
};

export async function researchCommunitiesForCity(
  city: string,
  state: string,
): Promise<ResearchedCommunity[]> {
  const searchApiKey = process.env.SEARCHAPI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!searchApiKey) throw new Error("SEARCHAPI_API_KEY not configured");

  const queries = [
    `"${city}" "${state}" (condo OR condominium) complex vacation rental 2-bedroom OR 3-bedroom airbnb vrbo individually owned -villa -"single family" -efficiency -studio -hotel`,
    `"${city}" "${state}" townhome OR townhouse cluster 3 bedroom vacation rental airbnb individually owned -villa -"single family" -studio`,
    `"${city}" "${state}" beach condo resort 2BR 3BR individually owned vacation rental -hotel -timeshare -efficiency`,
  ];

  const allResults: Array<{ title: string; link: string; snippet: string }> = [];
  for (const q of queries) {
    try {
      const resp = await fetch(
        `https://www.searchapi.io/api/v1/search?engine=google&q=${encodeURIComponent(q)}&num=8&api_key=${searchApiKey}`,
      );
      if (!resp.ok) continue;
      const data = await resp.json() as any;
      const organic = (data.organic_results || []) as Array<{ title: string; link: string; snippet: string }>;
      allResults.push(...organic);
    } catch (e: any) {
      console.warn(`[research] SearchAPI error for ${city}:`, e.message);
    }
  }

  const seen = new Set<string>();
  const unique = allResults.filter(r => {
    const key = r.title?.toLowerCase().slice(0, 60) ?? r.link;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 15);

  if (unique.length === 0) return [];

  async function spotCheckRate(communityName: string): Promise<{ low: number | null; high: number | null }> {
    try {
      const q = `${communityName} ${city} ${state} nightly rate VRBO Airbnb`;
      const resp = await fetch(
        `https://www.searchapi.io/api/v1/search?engine=google&q=${encodeURIComponent(q)}&num=5&api_key=${searchApiKey}`,
      );
      if (!resp.ok) return { low: null, high: null };
      const data = await resp.json() as any;
      const text = JSON.stringify(data).toLowerCase();
      const prices: number[] = [];
      const matches = text.match(/\$\s*(\d{3,4})\s*(?:\/night|per night|a night)/g) || [];
      for (const m of matches) {
        const n = parseInt(m.replace(/[^\d]/g, ""));
        if (n >= 100 && n <= 5000) prices.push(n);
      }
      if (prices.length === 0) return { low: null, high: null };
      return { low: Math.min(...prices), high: Math.max(...prices) };
    } catch {
      return { low: null, high: null };
    }
  }

  const results: ResearchedCommunity[] = [];

  if (anthropicKey) {
    const prompt = `You are sourcing condo/townhome resorts for Magical Island Rentals, which bundles TWO individually-owned units in the SAME complex into one large-group vacation listing.

THE BUSINESS MODEL:
  We rent unit A (e.g. 3BR) + unit B (e.g. 3BR) in the same building → list them together as one "6BR sleeps 14" villa-style product.
  So the VALUE of a community = bedrooms of (typical unit × 2). If a complex is dominated by studios/efficiencies/1BRs, combining them is pointless — 2×studio is still too small.

CONCRETE EXAMPLES of what we want:
  ✅ Santa Maria Resort (Fort Myers Beach, FL) — condo building, mostly 2BR/3BR units, individually owned, all listed on Airbnb/VRBO. Combining 2×3BR = 6BR. This is the gold standard.
  ✅ Pili Mai (Poipu Kai, HI) — townhome complex, 2BR/3BR, individually owned.
  ✅ Kaha Lani (Kauai) — beachfront condo complex, 2BR/3BR.
  ⚠️ BB&T / Bay Beach & Tennis (Bonita Springs, FL) — mostly efficiency/1BR. 2×1BR = 2BR is WEAK. combinabilityScore 20–35.
  ❌ Fort Myers Beach "villa" resorts — standalone structures, disqualified.
  ❌ Marriott / Hilton / Westin timeshares — single-owner, disqualified.
  ❌ Hotel-run condo-hotels with front desk check-in — disqualified.

STRICT QUALIFYING CRITERIA:
1. PROPERTY TYPE: Condos in multi-unit building OR townhomes with shared walls. NO villas/detached/single-family.
2. OWNERSHIP MODEL: Individually owned, not timeshare or single-owner.
3. VACATION RENTAL USAGE: Primarily nightly rentals.
4. UNIT SHARE-WALLS: Same building or contiguous townhome row.
5. SIZE: 10+ units with 2BR+ options.

SCORING:
  confidenceScore (0–100): sure this is individually-owned condo/townhome? 90+ household name, 70–89 very likely, 50–69 probably, <50 don't include.
  combinabilityScore (0–100): value of combining 2 units?
    90+: mostly 3BR → 2×3BR = 6BR (ideal)
    70–89: 2BR/3BR mix → 4BR–6BR
    50–69: mostly 2BR → 4BR combined
    30–49: mostly 1BR → 2BR combined (marginal)
    <30: mostly studios → skip

Use (1) the search results below, and (2) your own knowledge — add up to 3 well-known communities in "${city}, ${state}" that fit, marked fromWorldKnowledge:true.

SEARCH RESULTS for "${city}, ${state}":
${unique.map((r, i) => `[${i}] TITLE: ${r.title}\nURL: ${r.link}\nSNIPPET: ${r.snippet}`).join("\n\n")}

Output JSON array. Each element:
{"communityName":"...","bedroomMix":"...","combinedBedroomsTypical":N,"unitTypes":"...","confidenceScore":0-100,"combinabilityScore":0-100,"reason":"...","sourceUrl":"...","fromWorldKnowledge":false}

Include ONLY entries with confidenceScore >= 60 AND combinabilityScore >= 50. Max 10 results. Sort by (confidenceScore + combinabilityScore) descending. No markdown, no prose.`;

    try {
      const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          // Haiku 4.5 — current model, fast, structured-JSON friendly.
          // Previous ID `claude-3-5-sonnet-20241022` is a legacy alias
          // that Anthropic was returning errors for, which silently
          // emptied this endpoint's response (every market reported
          // "0 qualifying" — see /api/inbox/ai-draft for the same
          // migration). Bumped max_tokens to 4000 because the JSON
          // output for a market with multiple communities can run
          // long and the old 3000 truncated mid-array.
          model: "claude-haiku-4-5-20251001",
          max_tokens: 4000,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      const claudeData = await claudeResp.json().catch(() => null) as any;

      if (!claudeResp.ok) {
        const upstreamMsg =
          claudeData?.error?.message ??
          claudeData?.error?.type ??
          `HTTP ${claudeResp.status}`;
        console.error(`[research] Anthropic ${claudeResp.status} for ${city}, ${state}: ${upstreamMsg}`);
      } else if (claudeData?.error) {
        const upstreamMsg = claudeData.error.message ?? claudeData.error.type ?? "unknown";
        console.error(`[research] Anthropic error envelope for ${city}, ${state}: ${upstreamMsg}`);
      } else {
        const text: string = claudeData?.content?.[0]?.text ?? "";
        // Tolerate Markdown fences around the JSON — Haiku occasionally
        // wraps array output in ```json … ``` despite the "no markdown"
        // instruction. Strip the fences before regex-matching the array.
        const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "");
        const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
          console.error(`[research] Claude returned no JSON array for ${city}, ${state}. Raw text head: ${text.slice(0, 200)}`);
        } else {
          let scored: Array<any> = [];
          try {
            scored = JSON.parse(jsonMatch[0]) as Array<any>;
          } catch (parseErr: any) {
            console.error(`[research] JSON.parse failed for ${city}, ${state}: ${parseErr.message}. Head: ${jsonMatch[0].slice(0, 200)}`);
          }
          for (const s of scored.slice(0, 10)) {
            // Hard post-filter. The prompt warns against villas/SFH, but
            // Claude occasionally lets one through. Drop anything whose
            // unitTypes or reason contains a disqualifying term.
            const check = checkCommunityType(s.unitTypes, s.reason);
            if (!check.eligible) {
              console.log(`[research] dropped "${s.communityName}" (${city}, ${state}): ${check.reason}`);
              continue;
            }
            const rates = await spotCheckRate(s.communityName);
            results.push({
              name: s.communityName,
              city,
              state,
              estimatedLowRate: rates.low,
              estimatedHighRate: rates.high,
              unitTypes: s.unitTypes,
              confidenceScore: s.confidenceScore,
              researchSummary: s.reason,
              sourceUrl: s.sourceUrl || "",
              bedroomMix: s.bedroomMix,
              combinedBedroomsTypical: s.combinedBedroomsTypical,
              combinabilityScore: s.combinabilityScore,
              fromWorldKnowledge: s.fromWorldKnowledge === true,
            });
          }
        }
      }
    } catch (e: any) {
      console.error(`[research] Claude exception for ${city}, ${state}: ${e.message}`);
    }
  } else {
    // No Claude — fall back to raw results (low-confidence)
    for (const r of unique.slice(0, 8)) {
      results.push({
        name: r.title?.split(" - ")[0]?.split(" | ")[0] ?? r.title,
        city,
        state,
        estimatedLowRate: null,
        estimatedHighRate: null,
        unitTypes: "Unknown",
        confidenceScore: 50,
        researchSummary: r.snippet,
        sourceUrl: r.link,
      });
    }
  }

  results.sort((a, b) => {
    const sa = a.confidenceScore + (a.combinabilityScore ?? 50);
    const sb = b.confidenceScore + (b.combinabilityScore ?? 50);
    return sb - sa;
  });
  return results;
}

// ─── TOP MARKETS ─────────────────────────────────────────────────────────────
// Curated list of US vacation-rental hotspots known for individually-owned
// condo/townhome inventory. Used by /api/community/scan-top-markets to
// auto-discover untapped communities across all of them.
//
// Criteria for inclusion:
//   - Strong Airbnb/VRBO presence
//   - Known condo/townhome inventory (not just SFRs)
//   - Geographically diverse (coast, ski, desert, mountain)

export const TOP_MARKET_SEEDS: Array<{ city: string; state: string; tag: string }> = [
  // Gulf Coast Florida — classic condo country
  { city: "Fort Myers Beach",    state: "Florida",        tag: "Gulf Coast" },
  { city: "Destin",              state: "Florida",        tag: "Gulf Coast" },
  { city: "Panama City Beach",   state: "Florida",        tag: "Gulf Coast" },
  { city: "Santa Rosa Beach",    state: "Florida",        tag: "30A" },
  { city: "Naples",              state: "Florida",        tag: "Gulf Coast" },
  // Atlantic Florida + Southeast
  { city: "Clearwater Beach",    state: "Florida",        tag: "Gulf Coast" },
  { city: "Hilton Head",         state: "South Carolina", tag: "Atlantic" },
  { city: "Myrtle Beach",        state: "South Carolina", tag: "Atlantic" },
  // Gulf Alabama
  { city: "Gulf Shores",         state: "Alabama",        tag: "Gulf Coast" },
  { city: "Orange Beach",        state: "Alabama",        tag: "Gulf Coast" },
  // Tennessee Smokies — condo/cabin mix
  { city: "Gatlinburg",          state: "Tennessee",      tag: "Smokies" },
  { city: "Pigeon Forge",        state: "Tennessee",      tag: "Smokies" },
  // Mountain West — ski condos
  { city: "Breckenridge",        state: "Colorado",       tag: "Ski" },
  { city: "Park City",           state: "Utah",           tag: "Ski" },
  { city: "Mammoth Lakes",       state: "California",     tag: "Ski" },
  // Desert / SoCal
  { city: "Palm Springs",        state: "California",     tag: "Desert" },
  // Texas coast
  { city: "South Padre Island",  state: "Texas",          tag: "Gulf Coast" },
  { city: "Galveston",           state: "Texas",          tag: "Gulf Coast" },
  // Hawaii (your home market, for completeness)
  { city: "Kihei",               state: "Hawaii",         tag: "Hawaii" },
  { city: "Kailua-Kona",         state: "Hawaii",         tag: "Hawaii" },
];
