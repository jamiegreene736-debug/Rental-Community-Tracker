// Claude-generated STATIC seasonal rate engine.
//
// Replaces the live Airbnb SearchAPI P40 random-7-night sampler
// (server/hybrid-pricing.ts) as the source of per-(property, bedroom) buy-in
// cost basis. For each bedroom size it asks Claude for ONE rate per season tier
// (LOW / HIGH / HOLIDAY) per YEAR, grounded in a bundle of metrics (operator
// buy-in table, the last live SearchAPI medians on file, trailing booking
// revenue, region season multipliers). Those 6 anchors are clamped, merged with
// any operator locks, then expanded across the rolling next-24-months calendar
// into the SAME property_market_rates.monthlyRates shape the Guesty push reads —
// so the markup (targetMarginForProperty) + push + scheduler + queue are all
// unchanged. Only the rate SOURCE changes.
//
// The whole thing is fail-soft: with no ANTHROPIC_API_KEY (or on any Claude
// error) it falls back to the operator's static seasonal basis, so the calendar
// still gets a complete, sane 24-month plan and the Guesty push never breaks.

import {
  type SeasonType,
} from "../shared/pricing-rates";
import {
  staticSeasonalBasis,
  defaultStaticAnchors,
  sanitizeAnchors,
  mergeLockedAnchors,
  expandAnchorsToMonthlyRates,
  seasonColumnsFromAnchors,
  confirmResearchCommunity,
  STATIC_RATE_SEASONS,
  type SeasonAnchors,
  type StaticRateAnchors,
  type StaticRateLocks,
  type StaticRateBedroomPlan,
  type StaticRatePlan,
  type CommunityConfirmation,
} from "../shared/static-rate-logic";
import { callClaudeWebSearchJson } from "./claude-json";

export const STATIC_RATE_MODEL = process.env.STATIC_RATE_MODEL || "claude-sonnet-4-6";

// Same trigger union the hybrid engine uses (kept loose to avoid a server-type
// import cycle).
export type StaticTriggerType = string;

// Mirror of HybridMonthScannedEvent (server/hybrid-pricing.ts) so the existing
// bulk-pricing queue progress handler keeps working when we emit per-bedroom
// progress ticks.
export type StaticProgressEvent = {
  propertyId: number;
  bedrooms: number;
  monthOffset: number;
  horizonMonths: number;
  yearMonth: string;
  checkIn: string;
  checkOut: string;
  medianNightly: number;
  sampleCount: number;
  confidence?: { score: number; level: "green" | "yellow" | "red"; sampleCount: number };
  pricingRecipe?: StaticPricingRecipe;
};

export type StaticPricingRecipe = {
  community: string;
  searchName: string;
  source: "claude-static";
  // Kept null so the queue's "P40" label can be swapped for a static label.
  percentileBasis: null;
  unitCount: number;
  searchedBedrooms: number[];
  resortConfident: boolean;
  bedroomSplitInferred: boolean;
  model: string;
  metricsUsed: string[];
  communityConfirmation?: CommunityConfirmation;
};

type BedroomMetrics = {
  bedrooms: number;
  staticBasis: SeasonAnchors;
  lastLive: { low: number | null; high: number | null; holiday: number | null; source: string | null; refreshedAt: string | null } | null;
  priorAnchors: StaticRateAnchors | null;
  locks: StaticRateLocks | undefined;
};

type GenerateArgs = {
  propertyId: number;
  propertyName: string;
  community: string;
  bedroomCounts: number[];
  unitCount: number;
  triggerType: StaticTriggerType;
  notes?: string;
  resortConfident?: boolean;
  bedroomSplitInferred?: boolean;
  // A human-readable, searchable location label for the web research, e.g.
  // "Poipu Kai Resort, Koloa, Kauai, HI". Falls back to the community key.
  searchLabel?: string;
  // The listing's known location + whether the community is a curated market,
  // used to CONFIRM the research target matches this listing's community.
  expectedCity?: string;
  expectedState?: string;
  curated?: boolean;
  asOf?: Date;
  onMonthScanned?: (event: StaticProgressEvent) => void | Promise<void>;
  shouldCancel?: () => boolean | Promise<boolean>;
};

const cancelledError = () => Object.assign(new Error("Cancelled by operator"), { cancelled: true });

function confidenceLevel(score: number): "green" | "yellow" | "red" {
  if (score >= 80) return "green";
  if (score >= 55) return "yellow";
  return "red";
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Build the per-bedroom metric bundle from the operator table, the existing
// (possibly airbnb-sourced) market-rate row, and the property's trailing
// revenue. Pure data assembly; no Claude.
async function gatherMetrics(args: {
  propertyId: number;
  community: string;
  bedroomCounts: number[];
}): Promise<{ perBedroom: BedroomMetrics[]; trailing: { revenue: number; bookings: number; windowDays: number } | null }> {
  const { storage } = await import("./storage");
  const existing = await storage.getPropertyMarketRates(args.propertyId).catch(() => []);
  const byBR = new Map<number, (typeof existing)[number]>();
  for (const row of existing) byBR.set(row.bedrooms, row);

  let trailing: { revenue: number; bookings: number; windowDays: number } | null = null;
  try {
    const all = await storage.getPropertyTrailingRevenue();
    const mine = all.find((r) => r.propertyId === args.propertyId);
    if (mine) {
      trailing = {
        revenue: num(mine.revenue) ?? 0,
        bookings: Number(mine.bookings ?? 0),
        windowDays: Number(mine.windowDays ?? 365),
      };
    }
  } catch {
    trailing = null;
  }

  const perBedroom: BedroomMetrics[] = args.bedroomCounts.map((bedrooms) => {
    const row = byBR.get(bedrooms);
    const priorPlan = (row?.staticPlan as StaticRatePlan | null | undefined) ?? null;
    const priorBedroom = priorPlan?.bedrooms?.find((b) => b.bedrooms === bedrooms) ?? null;
    return {
      bedrooms,
      staticBasis: staticSeasonalBasis(args.community, bedrooms),
      lastLive: row
        ? {
            low: num(row.medianNightly),
            high: num(row.medianNightlyHigh),
            holiday: num(row.medianNightlyHoliday),
            source: row.source ?? null,
            refreshedAt: row.refreshedAt ? new Date(row.refreshedAt).toISOString() : null,
          }
        : null,
      priorAnchors: priorBedroom?.anchors ?? null,
      locks: priorBedroom?.locks,
    };
  });

  return { perBedroom, trailing };
}

type ClaudeBedroomResult = {
  bedrooms: number;
  year1?: Partial<SeasonAnchors>;
  year2?: Partial<SeasonAnchors>;
  confidence?: number;
  reasoning?: string;
  metricsUsed?: string[];
};

// Claude's own confirmation that the resort/community is real and at the expected
// place — a genuine research-backed identity check (not just a string match).
type ClaudeCommunityVerdict = {
  confirmed?: boolean;
  verifiedResort?: string;
  verifiedCity?: string;
  verifiedState?: string;
  note?: string;
};

function buildResearchPrompt(args: {
  propertyName: string;
  community: string;
  searchLabel: string;
  unitCount: number;
  perBedroom: BedroomMetrics[];
  trailing: { revenue: number; bookings: number; windowDays: number } | null;
}): string {
  const lines: string[] = [];
  lines.push(`You are a vacation-rental revenue analyst. RESEARCH the real market and set BUY-IN COST BASIS rates: the nightly dollar amount we'd expect to PAY to secure ONE comparable rental unit (not the guest-facing price — a markup is applied downstream).`);
  lines.push(``);
  lines.push(`USE THE web_search TOOL. Search Google and vacation-rental sites (Airbnb, VRBO, Booking.com, the resort's own site) for ACTUAL current nightly rates at this specific resort/community for each bedroom size, in each season. Run multiple searches (e.g. "<resort> <N> bedroom nightly rate", "<resort> vacation rental winter holiday rates", "<resort> off-season rates"). Base your numbers on what you actually find, not on a formula.`);
  lines.push(``);
  lines.push(`FIRST, CONFIRM THE RESORT: use web search to verify that this resort/community is a real vacation-rental property and that it is located in the stated city/state. Report what you confirmed (its canonical name + real city/state). Only set community.confirmed=true if your research confirms the resort exists at that location.`);
  lines.push(``);
  lines.push(`Resort / community to research: ${args.searchLabel}`);
  lines.push(`(internal community key: ${args.community})`);
  lines.push(`Property: ${args.propertyName} — ${args.unitCount} unit(s) behind this listing.`);
  lines.push(`Bedroom sizes to price: ${args.perBedroom.map((m) => `${m.bedrooms}BR`).join(", ")}`);
  lines.push(``);
  lines.push(`Season tiers (price all three): LOW = off/shoulder season; HIGH = peak/summer; HOLIDAY = Christmas/New Year & major-holiday weeks.`);
  lines.push(`For EACH bedroom size, give ONE nightly buy-in rate per tier for YEAR 1 (next 12 months) and YEAR 2 (months 13-24, modest inflation, roughly +0% to +8%).`);
  lines.push(``);
  lines.push(`Sanity references (DO NOT just copy these — they are priors to weigh against what you research):`);
  if (args.trailing) {
    lines.push(`- This property's trailing ${args.trailing.windowDays}-day realized revenue: $${Math.round(args.trailing.revenue).toLocaleString()} across ${args.trailing.bookings} booking(s).`);
  }
  for (const m of args.perBedroom) {
    const live = m.lastLive && (m.lastLive.low || m.lastLive.high || m.lastLive.holiday)
      ? ` Last observed medians LOW/HIGH/HOLIDAY: ${m.lastLive.low ?? "n/a"}/${m.lastLive.high ?? "n/a"}/${m.lastLive.holiday ?? "n/a"}.`
      : "";
    lines.push(`- ${m.bedrooms}BR operator estimate LOW/HIGH/HOLIDAY: ${m.staticBasis.LOW}/${m.staticBasis.HIGH}/${m.staticBasis.HOLIDAY}.${live}`);
  }
  lines.push(``);
  lines.push(`Keep LOW < HIGH < HOLIDAY within each year. After researching, respond with ONLY a JSON object (no prose outside it) of this exact shape:`);
  lines.push(`{`);
  lines.push(`  "summary": "<one sentence: what you researched and the headline finding>",`);
  lines.push(`  "community": { "confirmed": <true|false>, "verifiedResort": "<canonical resort/community name you confirmed>", "verifiedCity": "<city>", "verifiedState": "<state>", "note": "<how you confirmed it>" },`);
  lines.push(`  "bedrooms": [`);
  lines.push(`    { "bedrooms": <int>, "year1": {"LOW": <int>, "HIGH": <int>, "HOLIDAY": <int>}, "year2": {"LOW": <int>, "HIGH": <int>, "HOLIDAY": <int>}, "confidence": <0-100 int>, "reasoning": "<what you found and the sources/rates it came from>", "metricsUsed": ["web-search", "<source/site>", ...] }`);
  lines.push(`  ]`);
  lines.push(`}`);
  return lines.join("\n");
}

// Research the full set of bedroom anchors via Claude + web search. Returns null
// on any failure so the caller can fall back to the static basis.
async function researchAnchorsWithClaude(args: {
  propertyName: string;
  community: string;
  searchLabel: string;
  unitCount: number;
  perBedroom: BedroomMetrics[];
  trailing: { revenue: number; bookings: number; windowDays: number } | null;
}): Promise<{ summary: string; searchCount: number; byBedroom: Map<number, ClaudeBedroomResult>; community: ClaudeCommunityVerdict | null } | null> {
  const prompt = buildResearchPrompt(args);
  const res = await callClaudeWebSearchJson<{ summary?: string; community?: ClaudeCommunityVerdict; bedrooms?: ClaudeBedroomResult[] }>({
    model: STATIC_RATE_MODEL,
    maxTokens: 4000,
    system: "You are a precise vacation-rental pricing analyst. You research with web search, then return only valid JSON — no prose outside the JSON object.",
    prompt,
    maxSearches: 6,
    maxRounds: 5,
    timeoutMs: 150_000,
  });
  if (!res.ok || !res.data || !Array.isArray(res.data.bedrooms)) {
    if (!res.ok) console.warn("[static-rate] Claude web research failed:", res.error);
    return null;
  }
  const byBedroom = new Map<number, ClaudeBedroomResult>();
  for (const b of res.data.bedrooms) {
    if (b && Number.isFinite(b.bedrooms)) byBedroom.set(Number(b.bedrooms), b);
  }
  return {
    summary: typeof res.data.summary === "string" ? res.data.summary : "",
    searchCount: res.searchCount ?? 0,
    byBedroom,
    community: res.data.community && typeof res.data.community === "object" ? res.data.community : null,
  };
}

// Resolve final anchors for one bedroom: start from Claude (clamped) or the
// static fallback, then re-apply operator locks against the prior anchors.
function resolveBedroomAnchors(
  metric: BedroomMetrics,
  community: string,
  claude: ClaudeBedroomResult | undefined,
): { anchors: StaticRateAnchors; confidence: number; reasoning: string; metricsUsed: string[]; usedClaude: boolean } {
  const fallback = defaultStaticAnchors(community, metric.bedrooms);
  let anchors: StaticRateAnchors;
  let confidence: number;
  let reasoning: string;
  let metricsUsed: string[];
  let usedClaude = false;
  if (claude && (claude.year1 || claude.year2)) {
    anchors = sanitizeAnchors(
      { year1: claude.year1 as SeasonAnchors, year2: claude.year2 as SeasonAnchors },
      metric.staticBasis,
    );
    confidence = Math.max(0, Math.min(100, Math.round(Number(claude.confidence) || 60)));
    reasoning = (claude.reasoning || "").slice(0, 600);
    metricsUsed = Array.isArray(claude.metricsUsed) ? claude.metricsUsed.slice(0, 8).map(String) : [];
    usedClaude = true;
  } else {
    anchors = fallback;
    confidence = 40;
    reasoning = "Claude unavailable — used operator buy-in table × season multipliers.";
    metricsUsed = ["operator-buy-in-table"];
  }
  // Operator lock overrides win over any regeneration.
  anchors = mergeLockedAnchors(anchors, metric.locks, metric.priorAnchors ?? undefined);
  return { anchors, confidence, reasoning, metricsUsed, usedClaude };
}

// Persist one bedroom's plan into property_market_rates in the canonical shape.
async function persistBedroom(args: {
  propertyId: number;
  propertyName: string;
  community: string;
  bedrooms: number;
  anchors: StaticRateAnchors;
  staticBasis: SeasonAnchors;
  locks: StaticRateLocks | undefined;
  confidence: number;
  reasoning: string;
  metricsUsed: string[];
  summary: string;
  communityConfirmation?: CommunityConfirmation;
  triggerType: StaticTriggerType;
  notes?: string;
  asOf: Date;
  usedClaude: boolean;
}): Promise<{ row: any; log: any; bedroomPlan: StaticRateBedroomPlan }> {
  const { storage } = await import("./storage");
  const monthlyRates = expandAnchorsToMonthlyRates(args.anchors, args.community, args.asOf, 24);
  const monthlyValues = Object.values(monthlyRates).map((m) => m.medianNightly);
  const cols = seasonColumnsFromAnchors(args.anchors);
  const lowNightly = monthlyValues.length ? Math.min(...monthlyValues) : cols.low;
  const highNightly = monthlyValues.length ? Math.max(...monthlyValues) : cols.holiday;

  const bedroomPlan: StaticRateBedroomPlan = {
    bedrooms: args.bedrooms,
    anchors: args.anchors,
    locks: args.locks ?? {},
    staticBasis: args.staticBasis,
    confidence: args.confidence,
    reasoning: args.reasoning,
    metricsUsed: args.metricsUsed,
  };
  const staticPlan: StaticRatePlan = {
    generatedAt: args.asOf.toISOString(),
    model: STATIC_RATE_MODEL,
    source: args.usedClaude ? "claude-static" : "static-fallback",
    summary: args.summary,
    communityConfirmation: args.communityConfirmation,
    bedrooms: [bedroomPlan],
  };

  const previous = (await storage.getPropertyMarketRates(args.propertyId).catch(() => []))
    .find((r) => r.bedrooms === args.bedrooms);

  const row = await storage.upsertPropertyMarketRate({
    propertyId: args.propertyId,
    bedrooms: args.bedrooms,
    medianNightly: String(cols.low),
    medianNightlyHigh: String(cols.high),
    medianNightlyHoliday: String(cols.holiday),
    monthlyRates: monthlyRates as any,
    lowNightly: String(lowNightly),
    highNightly: String(highNightly),
    sampleCount: args.metricsUsed.length,
    source: "claude-static",
    staticPlan: staticPlan as any,
  });

  const log = await storage.createPricingUpdateLog({
    propertyId: args.propertyId,
    propertyName: args.propertyName,
    bedrooms: args.bedrooms,
    triggerType: args.triggerType,
    oldRate: previous?.medianNightly ?? null,
    newRate: String(cols.low),
    status: "ok",
    notes: [
      args.notes || "Claude static seasonal rates (one rate per LOW/HIGH/HOLIDAY per year, rolling 24 months).",
      `Anchors year1 LOW/HIGH/HOLIDAY: ${args.anchors.year1.LOW}/${args.anchors.year1.HIGH}/${args.anchors.year1.HOLIDAY}; year2: ${args.anchors.year2.LOW}/${args.anchors.year2.HIGH}/${args.anchors.year2.HOLIDAY}.`,
      `Confidence ${args.confidence}% (${args.usedClaude ? STATIC_RATE_MODEL : "static fallback"}). ${args.reasoning}`,
    ].join(" "),
    layersJson: [{ type: "static-rate-plan", staticPlan }],
    calendarJson: monthlyRates as any,
  });

  return { row, log, bedroomPlan };
}

// Main entry point. Mirrors refreshHybridPricingForTarget's return shape so the
// existing route/queue call sites can swap in cleanly.
export async function generateStaticRatesForTarget(
  args: GenerateArgs,
): Promise<{ propertyId: number; rows: any[]; logs: any[]; blackouts: any[] }> {
  const asOf = args.asOf ?? new Date();
  const bedroomCounts = Array.from(new Set(args.bedroomCounts))
    .filter((b) => Number.isFinite(b) && b > 0)
    .sort((a, b) => a - b);
  if (bedroomCounts.length === 0) {
    throw new Error("No bedroom counts to price for static rate generation.");
  }
  if (await args.shouldCancel?.()) throw cancelledError();

  const { perBedroom, trailing } = await gatherMetrics({
    propertyId: args.propertyId,
    community: args.community,
    bedroomCounts,
  });

  if (await args.shouldCancel?.()) throw cancelledError();
  const searchLabel = args.searchLabel?.trim() || args.community;
  const claude = await researchAnchorsWithClaude({
    propertyName: args.propertyName,
    community: args.community,
    searchLabel,
    unitCount: args.unitCount,
    perBedroom,
    trailing,
  });
  const summary = claude
    ? `${claude.summary || `Researched ${searchLabel}.`} (${claude.searchCount} web search${claude.searchCount === 1 ? "" : "es"})`
    : `Static seasonal rates for ${args.community} (web research unavailable — operator table fallback).`;

  // Double-check the research target matches this listing's community + location,
  // backed by Claude's own web verification of the resort when available.
  const verdict = claude?.community ?? null;
  const communityConfirmation = confirmResearchCommunity({
    community: args.community,
    searchLabel,
    expectedCity: args.expectedCity,
    expectedState: args.expectedState,
    curated: args.curated,
    claudeConfirmed: verdict?.confirmed === true,
    verifiedResort: typeof verdict?.verifiedResort === "string" ? verdict.verifiedResort : undefined,
    verifiedCity: typeof verdict?.verifiedCity === "string" ? verdict.verifiedCity : undefined,
    verifiedState: typeof verdict?.verifiedState === "string" ? verdict.verifiedState : undefined,
  });

  const rows: any[] = [];
  const logs: any[] = [];
  for (let i = 0; i < perBedroom.length; i += 1) {
    if (await args.shouldCancel?.()) throw cancelledError();
    const metric = perBedroom[i];
    const resolved = resolveBedroomAnchors(metric, args.community, claude?.byBedroom.get(metric.bedrooms));
    const recipe: StaticPricingRecipe = {
      community: args.community,
      searchName: searchLabel,
      source: "claude-static",
      percentileBasis: null,
      unitCount: args.unitCount,
      searchedBedrooms: bedroomCounts,
      // The community confirmation (name + location, backed by Claude's web
      // verification) is now the authoritative resort-match signal — so the
      // legacy "resort confident" flag agrees with the confirmation banner
      // instead of flagging every non-curated draft.
      resortConfident: communityConfirmation.confirmed,
      bedroomSplitInferred: args.bedroomSplitInferred ?? false,
      model: resolved.usedClaude ? STATIC_RATE_MODEL : "static-fallback",
      metricsUsed: resolved.metricsUsed,
      communityConfirmation,
    };
    const { row, log } = await persistBedroom({
      propertyId: args.propertyId,
      propertyName: args.propertyName,
      community: args.community,
      bedrooms: metric.bedrooms,
      anchors: resolved.anchors,
      staticBasis: metric.staticBasis,
      locks: metric.locks,
      confidence: resolved.confidence,
      reasoning: resolved.reasoning,
      metricsUsed: resolved.metricsUsed,
      summary,
      communityConfirmation,
      triggerType: args.triggerType,
      notes: args.notes,
      asOf,
      usedClaude: resolved.usedClaude,
    });
    rows.push(row);
    logs.push(log);

    const firstMonth = Object.keys(expandAnchorsToMonthlyRates(resolved.anchors, args.community, asOf, 1))[0] ?? "";
    await args.onMonthScanned?.({
      propertyId: args.propertyId,
      bedrooms: metric.bedrooms,
      monthOffset: i,
      horizonMonths: perBedroom.length,
      yearMonth: firstMonth,
      checkIn: "",
      checkOut: "",
      medianNightly: resolved.anchors.year1.LOW,
      sampleCount: resolved.metricsUsed.length,
      confidence: { score: resolved.confidence, level: confidenceLevel(resolved.confidence), sampleCount: resolved.metricsUsed.length },
      pricingRecipe: recipe,
    });
  }

  return { propertyId: args.propertyId, rows, logs, blackouts: [] };
}

// Edit/lock then re-expand: used by POST /api/property/:id/static-rate/override.
// Applies a single (year, season) value + lock flag onto an existing static-plan
// row, re-expands the 24-month calendar, and persists in place. Returns the
// updated per-bedroom plan or null if no static-plan row exists for that bedroom.
export async function applyStaticRateOverride(args: {
  propertyId: number;
  bedrooms: number;
  community: string;
  year: "year1" | "year2";
  season: SeasonType;
  value?: number | null;
  locked?: boolean;
  asOf?: Date;
}): Promise<{ row: any; bedroomPlan: StaticRateBedroomPlan } | null> {
  const { storage } = await import("./storage");
  const asOf = args.asOf ?? new Date();
  const existing = (await storage.getPropertyMarketRates(args.propertyId)).find((r) => r.bedrooms === args.bedrooms);
  if (!existing) return null;
  const plan = (existing.staticPlan as StaticRatePlan | null) ?? null;
  const staticBasis = staticSeasonalBasis(args.community, args.bedrooms);
  const priorBedroom = plan?.bedrooms?.find((b) => b.bedrooms === args.bedrooms);
  const baseAnchors: StaticRateAnchors = priorBedroom?.anchors
    ?? defaultStaticAnchors(args.community, args.bedrooms);

  // Apply the value edit (clamped via sanitizeAnchors below).
  const nextAnchors: StaticRateAnchors = {
    year1: { ...baseAnchors.year1 },
    year2: { ...baseAnchors.year2 },
  };
  if (args.value != null && Number.isFinite(args.value) && args.value > 0) {
    nextAnchors[args.year][args.season] = Math.round(args.value);
  }
  const sanitized = sanitizeAnchors(nextAnchors, staticBasis);

  // Update lock flags.
  const locks: StaticRateLocks = {
    year1: { ...(priorBedroom?.locks?.year1 ?? {}) },
    year2: { ...(priorBedroom?.locks?.year2 ?? {}) },
  };
  if (args.locked != null) {
    (locks[args.year] as Record<string, boolean>)[args.season] = args.locked;
  }

  const monthlyRates = expandAnchorsToMonthlyRates(sanitized, args.community, asOf, 24);
  const cols = seasonColumnsFromAnchors(sanitized);

  const bedroomPlan: StaticRateBedroomPlan = {
    bedrooms: args.bedrooms,
    anchors: sanitized,
    locks,
    staticBasis,
    confidence: priorBedroom?.confidence ?? 50,
    reasoning: priorBedroom?.reasoning
      ? `${priorBedroom.reasoning} (operator-edited ${args.year} ${args.season})`
      : `Operator-edited ${args.year} ${args.season}.`,
    metricsUsed: priorBedroom?.metricsUsed ?? ["operator-edit"],
  };
  const nextPlan: StaticRatePlan = {
    generatedAt: plan?.generatedAt ?? asOf.toISOString(),
    model: plan?.model ?? STATIC_RATE_MODEL,
    source: "claude-static",
    summary: plan?.summary ?? "",
    communityConfirmation: plan?.communityConfirmation,
    bedrooms: [bedroomPlan],
  };

  const row = await storage.updatePropertyMarketRateStatic(args.propertyId, args.bedrooms, {
    medianNightly: String(cols.low),
    medianNightlyHigh: String(cols.high),
    medianNightlyHoliday: String(cols.holiday),
    monthlyRates: monthlyRates as any,
    staticPlan: nextPlan as any,
    source: "claude-static",
  });
  return { row, bedroomPlan };
}
