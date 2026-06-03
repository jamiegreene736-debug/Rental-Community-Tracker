import { looksLikeIndividualListingTitle, looksLikeHotelNotVacationRentalResort } from "@shared/alternative-scout-resort";
import type { BuyInMarketLocation } from "@shared/buy-in-market";

export type LlmNearbyResortSuggestion = {
  community: string;
  searchTerm: string;
  propertyKind: "condo_resort" | "townhome_resort" | "villa_resort";
  driveMinutesEstimate?: number;
  excludeReason?: string;
};

function buildPrompt(
  baseCommunity: string,
  baseLocation: BuyInMarketLocation,
  maxDriveMinutes: number,
  oceanfrontOnly: boolean,
): string {
  return [
    `Base vacation rental community: ${baseCommunity} (${baseLocation.searchName}, ${baseLocation.city}, ${baseLocation.state}).`,
    `List OTHER named vacation-rental RESORTS or condo/townhome COMMUNITIES (whole properties with many rentable units),`,
    `NOT individual Airbnb listings, NOT hotels/motels, within ~${maxDriveMinutes} minutes drive.`,
    oceanfrontOnly ? "Only include oceanfront or beachfront-comparable resorts." : "",
    "Return ONLY a JSON array (no markdown). Each item:",
    `{"community":"Resort Name","searchTerm":"Airbnb search phrase","propertyKind":"condo_resort|townhome_resort|villa_resort","driveMinutesEstimate":number}.`,
    "Cap at 14 resorts. Exclude the base community and generic areas (just 'Poipu' or 'Koloa').",
  ].filter(Boolean).join(" ");
}

function parseResortJsonArray(text: string): LlmNearbyResortSuggestion[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const rows = JSON.parse(match[0]) as unknown[];
    if (!Array.isArray(rows)) return [];
    const out: LlmNearbyResortSuggestion[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const community = String((row as any).community ?? "").trim();
      const searchTerm = String((row as any).searchTerm ?? community).trim();
      const kind = String((row as any).propertyKind ?? "condo_resort").trim() as LlmNearbyResortSuggestion["propertyKind"];
      const driveMinutesEstimate = Number((row as any).driveMinutesEstimate);
      if (!community || looksLikeIndividualListingTitle(community)) continue;
      const hay = `${community} ${searchTerm} ${kind}`;
      if (looksLikeHotelNotVacationRentalResort(hay)) continue;
      if (!/\b(resort|condo|condominium|villas?|plantation|townhome|townhouse|complex|community)\b/i.test(hay)
        && kind === "condo_resort") {
        // Allow well-known Kauai/Florida names without the word resort
        if (community.split(/\s+/).length < 2) continue;
      }
      out.push({
        community,
        searchTerm: searchTerm || community,
        propertyKind: kind === "townhome_resort" || kind === "villa_resort" ? kind : "condo_resort",
        driveMinutesEstimate: Number.isFinite(driveMinutesEstimate) ? Math.round(driveMinutesEstimate) : undefined,
      });
    }
    return out.slice(0, 14);
  } catch {
    return [];
  }
}

async function callXai(prompt: string): Promise<string | null> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.XAI_MODEL || "grok-4";
  try {
    const r = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content:
              "You know US vacation markets. Reply with valid JSON only — named multi-unit condo/townhome resorts, never hotels or single listing titles.",
          },
          { role: "user", content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(55_000),
    });
    if (!r.ok) return null;
    const data = await r.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data?.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

async function callAnthropic(prompt: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1200,
        temperature: 0.1,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(55_000),
    });
    if (!r.ok) return null;
    const data = await r.json() as { content?: Array<{ type?: string; text?: string }> };
    const block = data?.content?.find((c) => c.type === "text");
    return block?.text ?? null;
  } catch {
    return null;
  }
}

export async function fetchNearbyVacationRentalResortsFromLlm(
  baseCommunity: string,
  baseLocation: BuyInMarketLocation,
  opts: { maxDriveMinutes?: number; oceanfrontOnly?: boolean } = {},
): Promise<LlmNearbyResortSuggestion[]> {
  const maxDriveMinutes = opts.maxDriveMinutes ?? 20;
  const prompt = buildPrompt(baseCommunity, baseLocation, maxDriveMinutes, !!opts.oceanfrontOnly);
  const raw = (await callXai(prompt)) ?? (await callAnthropic(prompt));
  if (!raw) return [];
  const parsed = parseResortJsonArray(raw);
  console.log(
    `[alternative-scout] LLM nearby resorts for ${baseCommunity}: ${parsed.length} (${process.env.XAI_API_KEY ? "xAI" : "Anthropic"})`,
  );
  return parsed;
}
