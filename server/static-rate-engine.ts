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
  BUY_IN_RATES,
  getCommunityRegion,
  type SeasonType,
  type RegionType,
} from "../shared/pricing-rates";
import {
  staticSeasonalBasis,
  defaultStaticAnchors,
  sanitizeAnchors,
  mergeLockedAnchors,
  expandAnchorsToMonthlyRates,
  seasonColumnsFromAnchors,
  confirmResearchCommunity,
  allInSeasonalBasis,
  allInNightlyFromComponents,
  reconcileChannelAllIn,
  clampedSeasonsAgainst,
  computeSeasonWindows,
  normalizeChannelKey,
  CLEANING_FEE_ESTIMATE,
  SERVICE_FEE_PCT_DEFAULT,
  LODGING_TAX_PCT,
  ALL_IN_REFERENCE_NIGHTS,
  STATIC_RATE_SEASONS,
  type SeasonAnchors,
  type StaticRateAnchors,
  type StaticRateLocks,
  type StaticRateBedroomPlan,
  type StaticRatePlan,
  type CommunityConfirmation,
  type ChannelEvidence,
  type ChannelKey,
  type SeasonReconciliation,
  type SeasonWindow,
} from "../shared/static-rate-logic";
import { callClaudeWebSearchJson } from "./claude-json";

export const STATIC_RATE_MODEL = process.env.STATIC_RATE_MODEL || "claude-sonnet-4-6";

// Research budget. Bumped for the multi-channel (PM/VRBO/Booking/Airbnb/resort)
// × 3-season × multi-bedroom sweep. Env-tunable to dial credit cost down.
const STATIC_RATE_MAX_SEARCHES = Number(process.env.STATIC_RATE_MAX_SEARCHES) || 12;
// Headroom for the multi-bedroom × multi-channel evidence JSON. The prompt also
// soft-caps evidence volume; together they keep the response under the cap so it
// doesn't truncate mid-JSON (which would discard every anchor → fail-soft).
const STATIC_RATE_MAX_TOKENS = Number(process.env.STATIC_RATE_MAX_TOKENS) || 12000;

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

// One raw per-channel research data point as REPORTED by Claude (observed
// fields only — the server computes the all-in nightly + applies tax).
type ClaudeEvidenceRaw = {
  season?: string;
  year?: number;
  channel?: string;
  sourceUrl?: string;
  stayNights?: number;
  rentNightly?: number;
  cleaningPerStay?: number | null;
  serviceFeePct?: number | null;
  feesObserved?: boolean;
};

type ClaudeBedroomResult = {
  bedrooms: number;
  // Claude's own all-in estimate per season/year — a BACKSTOP used only when no
  // credible channel evidence exists for that (season, year).
  year1?: Partial<SeasonAnchors>;
  year2?: Partial<SeasonAnchors>;
  confidence?: number;
  reasoning?: string;
  metricsUsed?: string[];
  // The real per-channel observations the server reconciles into anchors.
  evidence?: ClaudeEvidenceRaw[];
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
  windows: SeasonWindow[];
}): string {
  const lines: string[] = [];
  const win = (season: SeasonType, year: 1 | 2) => args.windows.find((w) => w.season === season && w.year === year);
  const winStr = (season: SeasonType, year: 1 | 2) => {
    const w = win(season, year);
    return w ? `${w.checkIn} → ${w.checkOut}` : "(a representative 7-night week)";
  };

  lines.push(`You are a vacation-rental acquisition analyst. RESEARCH the real market and report the BUY-IN COST: what we would actually PAY to secure ONE comparable rental unit for a guest's stay (NOT the guest-facing resale price — a markup is applied downstream).`);
  lines.push(``);
  lines.push(`We re-rent these units, so the buy-in cost is the ALL-IN total a guest pays at checkout: nightly rent + the flat cleaning fee + the channel service fee + lodging/occupancy taxes. We will compute the all-in math and taxes ourselves — YOU only need to FIND and REPORT the observed components (rent, cleaning, service %) per channel. Do NOT compute taxes.`);
  lines.push(``);
  lines.push(`USE THE web_search TOOL extensively. For EACH bedroom size, gather as much real pricing data as you can across these channels, in PRIORITY order (cheapest acquisition path first — we book the cheapest credible one):`);
  lines.push(`  1. Property-manager / resort-direct booking sites (usually 10–20% cheaper — no guest service fee). Search: "<resort> <N> bedroom rental rates", "<resort> property management vacation rental <N> bedroom".`);
  lines.push(`  2. VRBO. Search: site:vrbo.com "<resort>" <N> bedroom  /  "<resort>" VRBO <N> bedroom nightly`);
  lines.push(`  3. Booking.com. Search: site:booking.com "<resort>"  /  "<resort>" Booking.com <N> bedroom. (Card prices are teaser/partial — treat as a floor, not all-in.)`);
  lines.push(`  4. Airbnb. Search: "<resort>" Airbnb <N> bedroom. (Headline under-prices, then adds ~14% service — treat as a floor signal.)`);
  lines.push(`  5. The resort's own website.`);
  lines.push(``);
  lines.push(`FIRST, CONFIRM THE RESORT: verify via web search that this resort/community is a real vacation-rental property located in the stated city/state. Report its canonical name + real city/state. Only set community.confirmed=true if your research confirms it.`);
  lines.push(``);
  lines.push(`Resort / community to research: ${args.searchLabel}`);
  lines.push(`(internal community key: ${args.community})`);
  lines.push(`Property: ${args.propertyName} — ${args.unitCount} unit(s) behind this listing.`);
  lines.push(`Bedroom sizes to price: ${args.perBedroom.map((m) => `${m.bedrooms}BR`).join(", ")}`);
  lines.push(``);
  lines.push(`7-NIGHT SAMPLE WINDOWS — price a 7-night stay for each season/year using THESE dates (so the flat cleaning fee amortizes the way a real week-long booking would). If a channel enforces a longer minimum stay, sample at that minimum and report that stayNights:`);
  lines.push(`  LOW season (off/shoulder):  Year 1 ${winStr("LOW", 1)};  Year 2 ${winStr("LOW", 2)}`);
  lines.push(`  HIGH season (peak/summer):  Year 1 ${winStr("HIGH", 1)};  Year 2 ${winStr("HIGH", 2)}`);
  lines.push(`  HOLIDAY (Christmas/New Year):Year 1 ${winStr("HOLIDAY", 1)};  Year 2 ${winStr("HOLIDAY", 2)}`);
  lines.push(`OTAs rarely quote 13–24 months out: for Year 2 windows you usually won't find live rates — estimate Year 2 as Year 1 + modest inflation (roughly +0% to +8%) and say so.`);
  lines.push(``);
  lines.push(`For EVERY channel where you find a real dated listing at this resort for the right bedroom size, add an entry to "evidence" reporting the OBSERVED numbers only:`);
  lines.push(`  - rentNightly: the displayed nightly rent (before cleaning/service/tax).`);
  lines.push(`  - cleaningPerStay: the flat cleaning fee shown, or null if not shown.`);
  lines.push(`  - serviceFeePct: the service-fee %, or null if not shown (we default it per channel).`);
  lines.push(`  - stayNights: the stay length you priced (7 unless a longer minimum forced more).`);
  lines.push(`  - feesObserved: true ONLY if you actually saw BOTH the cleaning fee and the service fee on the page (not inferred).`);
  lines.push(`  - sourceUrl + channel ("pm" | "vrbo" | "booking" | "airbnb" | "resort").`);
  lines.push(`NEVER report a teaser "from $X" headline as if it were the real all-in. If you can only see a bare nightly, report it with cleaningPerStay null and feesObserved false — we'll gross it up. If a channel genuinely charges NO separate cleaning fee, report cleaningPerStay: 0 (not null).`);
  lines.push(`Keep the evidence focused: report the cheapest credible channel(s) per season — you don't need every duplicate hit. Aim for roughly the 8–10 most decision-relevant data points total so the response isn't truncated.`);
  lines.push(``);
  lines.push(`Sanity references (the operator's BARE-RENT priors — taxes/cleaning/service are NOT included, so the real all-in should be roughly 1.2×–1.5× these; weigh against what you research, don't copy):`);
  if (args.trailing) {
    lines.push(`- This property's trailing ${args.trailing.windowDays}-day realized revenue: $${Math.round(args.trailing.revenue).toLocaleString()} across ${args.trailing.bookings} booking(s).`);
  }
  for (const m of args.perBedroom) {
    const live = m.lastLive && (m.lastLive.low || m.lastLive.high || m.lastLive.holiday)
      ? ` Last observed medians LOW/HIGH/HOLIDAY: ${m.lastLive.low ?? "n/a"}/${m.lastLive.high ?? "n/a"}/${m.lastLive.holiday ?? "n/a"}.`
      : "";
    lines.push(`- ${m.bedrooms}BR operator bare-rent reference LOW/HIGH/HOLIDAY: ${m.staticBasis.LOW}/${m.staticBasis.HIGH}/${m.staticBasis.HOLIDAY}.${live}`);
  }
  lines.push(``);
  lines.push(`Also give, per bedroom, your own ALL-IN estimate per tier (year1/year2) as a backstop when you couldn't find channel evidence. Keep LOW < HIGH < HOLIDAY within each year.`);
  lines.push(``);
  lines.push(`Respond with ONLY a JSON object (no prose outside it) of this exact shape:`);
  lines.push(`{`);
  lines.push(`  "summary": "<one sentence: what you researched and the headline finding>",`);
  lines.push(`  "community": { "confirmed": <true|false>, "verifiedResort": "<canonical name>", "verifiedCity": "<city>", "verifiedState": "<state>", "note": "<how you confirmed it>" },`);
  lines.push(`  "bedrooms": [`);
  lines.push(`    {`);
  lines.push(`      "bedrooms": <int>,`);
  lines.push(`      "year1": {"LOW": <int>, "HIGH": <int>, "HOLIDAY": <int>},`);
  lines.push(`      "year2": {"LOW": <int>, "HIGH": <int>, "HOLIDAY": <int>},`);
  lines.push(`      "confidence": <0-100 int>,`);
  lines.push(`      "reasoning": "<what you found, the channels + rates it came from>",`);
  lines.push(`      "metricsUsed": ["web-search", "<source/site>", ...],`);
  lines.push(`      "evidence": [`);
  lines.push(`        {"season": "LOW|HIGH|HOLIDAY", "year": 1, "channel": "pm|vrbo|booking|airbnb|resort", "sourceUrl": "<url>", "stayNights": 7, "rentNightly": <int>, "cleaningPerStay": <int|null>, "serviceFeePct": <number|null>, "feesObserved": <true|false>}`);
  lines.push(`      ]`);
  lines.push(`    }`);
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
  windows: SeasonWindow[];
}): Promise<{ summary: string; searchCount: number; byBedroom: Map<number, ClaudeBedroomResult>; community: ClaudeCommunityVerdict | null } | null> {
  const prompt = buildResearchPrompt(args);
  const res = await callClaudeWebSearchJson<{ summary?: string; community?: ClaudeCommunityVerdict; bedrooms?: ClaudeBedroomResult[] }>({
    model: STATIC_RATE_MODEL,
    maxTokens: STATIC_RATE_MAX_TOKENS,
    system: "You are a precise vacation-rental acquisition analyst. You research real channel prices with web search, then return only valid JSON — no prose outside the JSON object. Report only OBSERVED rent/cleaning/service per channel; never compute taxes.",
    prompt,
    maxSearches: STATIC_RATE_MAX_SEARCHES,
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

function normSeason(raw: unknown): SeasonType | null {
  const s = String(raw ?? "").toUpperCase();
  if (/HOLIDAY|CHRISTMAS|NEW.?YEAR|XMAS/.test(s)) return "HOLIDAY";
  if (/HIGH|PEAK|SUMMER/.test(s)) return "HIGH";
  if (/LOW|OFF|SHOULDER/.test(s)) return "LOW";
  return null;
}

// Accept a service-fee % as either a fraction (0.10) or a whole number (10).
function normalizePct(v: number): number {
  return v > 1 ? v / 100 : v;
}

type ResolvedBedroom = {
  anchors: StaticRateAnchors;
  confidence: number;
  reasoning: string;
  metricsUsed: string[];
  usedClaude: boolean;
  allInBasis: SeasonAnchors;
  evidence: ChannelEvidence[];
  reconciliation: SeasonReconciliation[];
  clampedSeasons: string[];
  cleaningPerNight: number;
};

// Resolve final ALL-IN anchors for one bedroom: compute the all-in nightly per
// channel from Claude's observed evidence (server-applied taxes/fees), reconcile
// channels into ONE anchor per (season, year), clamp against the all-in basis,
// then re-apply operator locks against the prior anchors. Falls back to Claude's
// own all-in estimate per season (then the all-in basis) when no credible channel
// evidence exists; falls all the way back to the all-in static basis with no Claude.
function resolveBedroomAnchors(
  metric: BedroomMetrics,
  community: string,
  claude: ClaudeBedroomResult | undefined,
): ResolvedBedroom {
  const region: RegionType = BUY_IN_RATES[community]?.region ?? getCommunityRegion(community);
  const allInBasis = allInSeasonalBasis(community, metric.bedrooms);
  const cleaningPerNight = Math.round(CLEANING_FEE_ESTIMATE[region] / ALL_IN_REFERENCE_NIGHTS);
  const rentBasis = metric.staticBasis; // rent-only seasonal basis (teaser detection reference)

  // 1. Server-compute the all-in nightly for each channel data point Claude reported.
  const evidence: ChannelEvidence[] = [];
  const rawEvidence = Array.isArray(claude?.evidence) ? claude!.evidence! : [];
  for (const e of rawEvidence) {
    const rentNightly = num(e.rentNightly);
    const season = normSeason(e.season);
    if (rentNightly == null || !season) continue;
    const channel = normalizeChannelKey(e.channel);
    const year: 1 | 2 = Number(e.year) === 2 ? 2 : 1;
    const nights = Number.isFinite(Number(e.stayNights)) && Number(e.stayNights) > 0 ? Math.round(Number(e.stayNights)) : ALL_IN_REFERENCE_NIGHTS;
    // Distinguish ABSENT (null/undefined → estimate it) from an observed $0 (a
    // PM/resort-direct listing with no separate cleaning fee — keep the 0, don't
    // overwrite with the regional estimate, which would inflate the cheapest channel).
    const cleaningObs = e.cleaningPerStay == null || !Number.isFinite(Number(e.cleaningPerStay)) || Number(e.cleaningPerStay) < 0
      ? null
      : Number(e.cleaningPerStay);
    const servicePctObs = e.serviceFeePct != null && Number.isFinite(Number(e.serviceFeePct)) && Number(e.serviceFeePct) >= 0
      ? normalizePct(Number(e.serviceFeePct))
      : null;
    const feesObserved = e.feesObserved === true && cleaningObs != null;
    const cleaning = cleaningObs ?? CLEANING_FEE_ESTIMATE[region];
    const servicePct = servicePctObs ?? SERVICE_FEE_PCT_DEFAULT[channel] ?? SERVICE_FEE_PCT_DEFAULT.other;
    const allIn = allInNightlyFromComponents({ rentNightly, nights, cleaningPerStay: cleaning, serviceFeePct: servicePct, region });
    evidence.push({
      season,
      year,
      channel,
      sourceUrl: typeof e.sourceUrl === "string" ? e.sourceUrl.slice(0, 300) : undefined,
      stayNights: nights,
      rentNightly,
      cleaningPerStay: cleaningObs,
      serviceFeePct: servicePctObs,
      feesObserved,
      allInNightly: allIn,
      feeBasis: feesObserved ? "all-in-observed" : "grossed-up",
    });
  }

  // 2. Reconcile evidence → ONE anchor per (season, year); else Claude estimate; else basis.
  const reconciliation: SeasonReconciliation[] = [];
  const claudeYear = (year: 1 | 2): Partial<SeasonAnchors> | undefined => (year === 1 ? claude?.year1 : claude?.year2);
  const resolveYear = (year: 1 | 2, y1?: SeasonAnchors): SeasonAnchors => {
    const out = { LOW: 0, HIGH: 0, HOLIDAY: 0 } as SeasonAnchors;
    for (const season of STATIC_RATE_SEASONS) {
      const rows = evidence.filter((x) => x.season === season && x.year === year);
      let value: number | null = null;
      if (rows.length) {
        const r = reconcileChannelAllIn(
          rows.map((x) => ({ channel: x.channel, rentNightly: x.rentNightly, allInNightly: x.allInNightly, feesObserved: x.feesObserved })),
          rentBasis[season],
        );
        reconciliation.push({ season, year, chosen: r.chosen ?? 0, channel: r.channel, rule: r.rule, spread: r.spread, dropped: r.dropped });
        if (r.chosen != null && r.chosen > 0) value = r.chosen;
      }
      if (value == null) {
        const est = num(claudeYear(year)?.[season]);
        if (est != null) value = est;
        else if (year === 2 && y1) value = Math.round(y1[season] * 1.04);
        else value = allInBasis[season];
      }
      out[season] = value;
    }
    return out;
  };

  let anchors: StaticRateAnchors;
  let clampedSeasons: string[] = [];
  let usedClaude = false;
  let agreeingSeasons = 0;
  if (claude && (claude.year1 || claude.year2 || evidence.length > 0)) {
    usedClaude = true;
    const rawYear1 = resolveYear(1);
    const rawYear2 = resolveYear(2, rawYear1);
    // Capture clamping BEFORE sanitize re-orders/bands the values.
    clampedSeasons = [
      ...clampedSeasonsAgainst(rawYear1, allInBasis, "Y1"),
      ...clampedSeasonsAgainst(rawYear2, allInBasis, "Y2"),
    ];
    anchors = sanitizeAnchors({ year1: rawYear1, year2: rawYear2 }, allInBasis);
    agreeingSeasons = reconciliation.filter(
      (r) => r.spread.n >= 2 && r.spread.min > 0 && (r.spread.max - r.spread.min) / r.spread.min <= 0.15,
    ).length;
  } else {
    anchors = defaultStaticAnchors(community, metric.bedrooms); // all-in fallback
  }

  // 3. Confidence + reasoning + sources.
  const taxLabel = `${Math.round(LODGING_TAX_PCT[region] * 100)}%`;
  let confidence: number;
  let reasoning: string;
  let metricsUsed: string[];
  if (usedClaude) {
    const claudeConf = Math.max(0, Math.min(100, Math.round(Number(claude?.confidence) || 60)));
    if (evidence.length === 0) confidence = Math.min(claudeConf, 60);
    else if (agreeingSeasons >= 1) confidence = Math.min(90, Math.max(claudeConf, 80));
    else confidence = Math.min(78, Math.max(claudeConf, 60));
    const channels = Array.from(new Set(evidence.map((x) => x.channel)));
    reasoning = [
      (claude?.reasoning || "").slice(0, 460),
      evidence.length
        ? `All-in = rent + cleaning + service + ${taxLabel} tax, amortized over ${ALL_IN_REFERENCE_NIGHTS} nights; reconciled from ${evidence.length} channel data point(s) (${channels.join(", ") || "n/a"}).`
        : `No live channel rates found — used Claude's all-in estimate clamped to the operator basis.`,
    ].filter(Boolean).join(" ").slice(0, 600);
    metricsUsed = Array.from(new Set([
      ...(Array.isArray(claude?.metricsUsed) ? claude!.metricsUsed!.map(String) : []),
      ...channels.map((c) => `channel:${c}`),
    ])).slice(0, 12);
  } else {
    confidence = 40;
    reasoning = `Claude web research unavailable — used the operator buy-in table grossed up to an all-in basis (rent + est. cleaning + service + ${taxLabel} ${region} tax, ${ALL_IN_REFERENCE_NIGHTS}-night amortized).`;
    metricsUsed = ["operator-buy-in-table", "all-in-grossed-up"];
  }

  // Operator lock overrides win over any regeneration.
  anchors = mergeLockedAnchors(anchors, metric.locks, metric.priorAnchors ?? undefined);
  return {
    anchors,
    confidence,
    reasoning,
    metricsUsed,
    usedClaude,
    allInBasis,
    evidence: evidence.slice(0, 12),
    reconciliation,
    clampedSeasons,
    cleaningPerNight,
  };
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
  allInBasis?: SeasonAnchors;
  evidence?: ChannelEvidence[];
  reconciliation?: SeasonReconciliation[];
  clampedSeasons?: string[];
  cleaningPerNight?: number;
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
    allInBasis: args.allInBasis,
    evidence: args.evidence,
    reconciliation: args.reconciliation,
    clampedSeasons: args.clampedSeasons && args.clampedSeasons.length ? args.clampedSeasons : undefined,
    cleaningPerNight: args.cleaningPerNight,
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
    // Real comp count = number of channel data points reconciled (mirrors the
    // prior provenance work where sampleCount drives the confidence pill).
    sampleCount: args.evidence?.length ?? args.metricsUsed.length,
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
  const region: RegionType = BUY_IN_RATES[args.community]?.region ?? getCommunityRegion(args.community);
  // Deterministic 7-night sampling windows handed to Claude so the research is
  // reproducible (HIGH=mid-July, LOW=mid-Sept, HOLIDAY=Dec 26–Jan 2; Y2 = +1yr).
  const windows = computeSeasonWindows(asOf, region);
  const claude = await researchAnchorsWithClaude({
    propertyName: args.propertyName,
    community: args.community,
    searchLabel,
    unitCount: args.unitCount,
    perBedroom,
    trailing,
    windows,
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
      allInBasis: resolved.allInBasis,
      evidence: resolved.evidence,
      reconciliation: resolved.reconciliation,
      clampedSeasons: resolved.clampedSeasons,
      cleaningPerNight: resolved.cleaningPerNight,
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
  // Operator edits are clamped against the ALL-IN basis (same reference the
  // generator uses), so a legit all-in edit isn't compressed toward rent-only.
  const allInBasis = allInSeasonalBasis(args.community, args.bedrooms);
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
  const sanitized = sanitizeAnchors(nextAnchors, allInBasis);

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
    // Preserve the all-in provenance from the last generation (an edit doesn't
    // re-research, so the channel evidence + basis still describe the rate).
    allInBasis: priorBedroom?.allInBasis ?? allInBasis,
    evidence: priorBedroom?.evidence,
    reconciliation: priorBedroom?.reconciliation,
    clampedSeasons: priorBedroom?.clampedSeasons,
    cleaningPerNight: priorBedroom?.cleaningPerNight,
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
