// Pure helpers for the "Alternative Unit" relocation message + guest page.
//
// Why: the replacement is not always a DIFFERENT community. A 4BR booking made
// of 2x2BR condos is sometimes re-filled with a 2BR + 1BR pair in the SAME
// community (or even the same building) — the honest story there is "same
// community, one less bedroom", not "comparable community a short drive away".
// These helpers classify that scenario from the operator/Cowork community
// verdicts stamped on the attached buy-ins (buy_ins.communityVerdict) and build
// the bedroom-focused message lines. Kept pure so
// tests/relocation-scenario.test.ts can lock the wording and the consensus
// rules. All output is plain ASCII so it survives sanitizeForBookingChannel.

export type CommunityVerdictConsensus = "same_building" | "same_community" | null;

const normalizeVerdict = (value: unknown): string => String(value ?? "").trim().toLowerCase();

/**
 * Consensus across ALL attached buy-ins' community verdicts. Every attached
 * unit must carry a positive verdict — one missing/unknown/"different" verdict
 * means we cannot honestly tell the guest "same community", so null.
 * All same_building → "same_building"; otherwise (mix of the two positives) →
 * "same_community".
 */
export function sameCommunityConsensusFromVerdicts(
  verdicts: Array<string | null | undefined>,
): CommunityVerdictConsensus {
  if (verdicts.length === 0) return null;
  const cleaned = verdicts.map(normalizeVerdict);
  if (cleaned.some((v) => v !== "same_building" && v !== "same_community")) return null;
  return cleaned.every((v) => v === "same_building") ? "same_building" : "same_community";
}

/** True when any attached buy-in was explicitly verified as a DIFFERENT
 * community — used to veto a name-equality "same community" inference. */
export function anyDifferentCommunityVerdict(verdicts: Array<string | null | undefined>): boolean {
  return verdicts.some((v) => normalizeVerdict(v) === "different");
}

/**
 * Actual bedroom count parsed from a listing title ("Poipu Sands 1BR/1BA
 * Oceanview"). The slot's configured bedroom count is what the guest BOOKED,
 * not necessarily what got attached — when a smaller unit fills a slot the
 * title is the honest source. Deliberately does NOT match "beds" ("2 beds" is
 * bed furniture, not bedrooms). Null when nothing parseable (caller falls back
 * to the slot config, preserving the old behavior).
 */
export function bedroomsFromListingTitleText(title: string | null | undefined): number | null {
  const m = String(title ?? "").match(/(\d{1,2})[\s-]*(?:bedrooms?|bdrms?|br|bd|bed)\b/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 && n < 20 ? n : null;
}

/**
 * Community/area labels sometimes arrive as a raw Guesty LISTING TITLE
 * ("Ilikai - 4BR Condos - Sleeps 12") because ad-hoc listings have no
 * configured community and the client's slot fallback hands the title through.
 * Drop the size/sleeps marketing segments so the guest-facing copy reads
 * "Ilikai" and same-community matching can work. Non-cruft segments are kept
 * verbatim (legit dash-joined resort names survive).
 */
export function stripListingTitleCruftFromCommunityLabel(label: unknown): string {
  const raw = String(label ?? "").trim();
  if (!raw) return "";
  const CRUFT = [
    /\b\d+\s*(?:br|bd|bdrm|bedroom)s?\b/i,
    /\b\d+\s*(?:ba|bath|bathroom)s?\b/i,
    /\bsleeps?\s*\d+\b/i,
    /^\s*condos?\s*$/i,
    /^\s*villas?\s*$/i,
    /^\s*units?\s*\d*\s*$/i,
  ];
  const kept = raw
    .split(/\s+[-–—|·]\s+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && !CRUFT.some((re) => re.test(segment)));
  return (kept.length > 0 ? kept.join(" - ") : raw).trim();
}

const GENERIC_COMMUNITY_TOKENS = new Set([
  "resort", "resorts", "condo", "condos", "condominium", "condominiums",
  "villa", "villas", "suite", "suites", "hotel", "the", "at",
]);

const communityTokenSet = (value: unknown): Set<string> => {
  const tokens = stripListingTitleCruftFromCommunityLabel(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !GENERIC_COMMUNITY_TOKENS.has(t));
  return new Set(tokens);
};

/**
 * True when two community labels name the same place once generic words
 * (resort/condos/hotel/…) and listing-title cruft are removed — e.g.
 * "Ilikai - 4BR Condos - Sleeps 12" vs "Ilikai resort". Requires EXACT
 * distinctive-token equality (never subset containment), so a bare market/
 * city label ("Princeville") can NOT match a resort that merely contains it
 * ("Princeville Kamalii").
 */
export function sameCommunityLabelMatch(a: unknown, b: unknown): boolean {
  const ta = communityTokenSet(a);
  const tb = communityTokenSet(b);
  if (ta.size === 0 || tb.size === 0 || ta.size !== tb.size) return false;
  return Array.from(ta).every((t) => tb.has(t));
}

/**
 * Deterministic SAME-BUILDING signal from the attached units' saved street
 * addresses: strip the unit designator ("#1834", "Apt 4B", "Unit 12") and the
 * city tail, and require every unit to resolve to the SAME numbered street
 * root ("1777 Ala Moana Blvd #1834" + "1777 Ala Moana Blvd" → same building).
 * Needs >= 2 real numbered addresses; any missing/unparseable address → false
 * (never claim a building match we can't prove).
 */
export function sameBuildingFromAddresses(addresses: Array<string | null | undefined>): boolean {
  if (addresses.length < 2) return false;
  const roots = addresses.map((value) => {
    const beforeComma = String(value ?? "").trim().split(",")[0] ?? "";
    const root = beforeComma
      .toLowerCase()
      .replace(/#\s*\S+/g, " ")
      .replace(/\b(?:apt|apartment|unit|suite|ste|no)\.?\s*\S+/g, " ")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return /^\d+\s+\S/.test(root) ? root : "";
  });
  return roots.every((root) => root.length > 0 && root === roots[0]);
}

export type RelocationScenarioKind =
  | "different-community"
  | "same-community"
  | "same-community-fewer-bedrooms";

export function classifyRelocationScenario(input: {
  sameCommunity: boolean;
  originalBedrooms?: number | null;
  newBedrooms?: number | null;
}): { kind: RelocationScenarioKind; bedroomsDropped: number } {
  if (!input.sameCommunity) return { kind: "different-community", bedroomsDropped: 0 };
  const orig = Number(input.originalBedrooms);
  const next = Number(input.newBedrooms);
  const dropped =
    Number.isFinite(orig) && orig > 0 && Number.isFinite(next) && next > 0 && next < orig
      ? Math.round(orig - next)
      : 0;
  return {
    kind: dropped > 0 ? "same-community-fewer-bedrooms" : "same-community",
    bedroomsDropped: dropped,
  };
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const numberWord = (n: number): string => NUMBER_WORDS[n] ?? String(n);

export type SameCommunityRelocationLines = {
  arrangeLine: string;
  bedroomLine: string;
  pitchLine: string;
};

/**
 * The three guest-facing sentences for the same-community scenario. The
 * message focus is the BEDROOM COUNT change (when there is one), never a
 * community change: "still in the same community/building, one less bedroom,
 * the two units sleep X so your party of N fits comfortably".
 *
 * The "will fit your party comfortably" claim is only made when totalSleeps
 * actually covers partySize — never promise a fit we cannot back up.
 */
export function buildSameCommunityRelocationLines(input: {
  placeLabel?: string | null;
  sameBuilding?: boolean;
  originalBedrooms?: number | null;
  newBedrooms?: number | null;
  totalSleeps?: number | null;
  partySize?: number | null;
  unitCount?: number | null;
}): SameCommunityRelocationLines {
  const unitCount = Number(input.unitCount) > 0 ? Math.round(Number(input.unitCount)) : 1;
  const bc = input.sameBuilding === true ? "building" : "community";
  const place = String(input.placeLabel ?? "").trim();
  const setup =
    unitCount === 1
      ? "a replacement unit"
      : unitCount === 2
        ? "two replacement units"
        : `${numberWord(unitCount)} replacement units`;
  const arrangeLine =
    `I am very sorry, but we have had an unexpected issue with the unit you originally booked and it is no longer available for your dates. ` +
    `To make sure your trip is not disrupted, I have arranged ${setup} for you${place ? ` at ${place}` : ""} - in the same ${bc} you originally booked, so nothing changes about the location you chose.`;

  const scenario = classifyRelocationScenario({
    sameCommunity: true,
    originalBedrooms: input.originalBedrooms,
    newBedrooms: input.newBedrooms,
  });
  const orig = Number(input.originalBedrooms);
  const next = Number(input.newBedrooms);
  const sleeps = Number(input.totalSleeps);
  const party = Number(input.partySize);
  const haveSleeps = Number.isFinite(sleeps) && sleeps > 0;
  const haveParty = Number.isFinite(party) && party > 0;
  const fitClause =
    haveSleeps && haveParty && sleeps >= party
      ? `, so your party of ${Math.round(party)} will fit comfortably`
      : "";
  const sleepsSentence = haveSleeps
    ? ` The ${unitCount === 1 ? "unit sleeps" : unitCount === 2 ? "two units together sleep" : "units together sleep"} up to ${Math.round(sleeps)} guests${fitClause}.`
    : "";
  const unitsLead =
    unitCount === 1 ? "The unit is" : unitCount === 2 ? "Both units are" : "All of the units are";
  let bedroomLine: string;
  if (scenario.kind === "same-community-fewer-bedrooms") {
    const dropPhrase =
      scenario.bedroomsDropped === 1
        ? "just one less bedroom"
        : `${numberWord(scenario.bedroomsDropped)} fewer bedrooms`;
    bedroomLine =
      `${unitsLead} still in the same ${bc} - the only change is the bedroom count: ` +
      `${Math.round(next)} bedrooms in total instead of ${Math.round(orig)}, ${dropPhrase} than your original booking.${sleepsSentence}`;
  } else {
    const bedsClause = Number.isFinite(next) && next > 0 ? ` with ${Math.round(next)} bedrooms in total` : "";
    bedroomLine = `${unitsLead} in the same ${bc} as your original booking${bedsClause}.${sleepsSentence}`;
  }
  const pitchLine =
    unitCount === 1
      ? "Honestly, it is a really nice, well-kept place and I think you and your group will really enjoy the stay."
      : "Honestly, these are really nice, well-kept places and I think you and your group will really enjoy the stay.";
  return { arrangeLine, bedroomLine, pitchLine };
}
