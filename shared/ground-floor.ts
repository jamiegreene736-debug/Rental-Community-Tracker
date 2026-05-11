export type GroundFloorScope = "none" | "one" | "both" | "unknown";

export type GroundFloorRequirement = {
  requested: boolean;
  scope: GroundFloorScope;
  requiredUnits: number;
  confidence: "none" | "low" | "medium" | "high";
  evidence: string[];
  summary: string;
};

export type GroundFloorStatus = "confirmed" | "not_confirmed" | "conflict" | "unknown";

export type GroundFloorInference = {
  status: GroundFloorStatus;
  confidence: "low" | "medium" | "high";
  evidence: string | null;
};

const GROUND_FLOOR_RE = /\b(ground[-\s]?floor|bottom[-\s]?floor|first[-\s]?floor|main[-\s]?floor|downstairs|lower[-\s]?level|street[-\s]?level|walk[-\s]?out|step[-\s]?free|no\s+steps?|no\s+stairs?|stair[-\s]?free|single[-\s]?level|one[-\s]?(?:floor|level)|wheelchair|walker|cane|mobility|accessible|accessibility|elderly|senior|grand(?:parent|ma|pa|mother|father)|bad\s+knee|bad\s+hip|knee\s+surgery|hip\s+surgery)\b/i;
const FLOOR_ONLY_RE = /\b(ground[-\s]?floor|bottom[-\s]?floor|first[-\s]?floor|main[-\s]?floor|downstairs|lower[-\s]?level|street[-\s]?level|walk[-\s]?out|step[-\s]?free|no\s+steps?|no\s+stairs?|stair[-\s]?free)\b/i;
const BOTH_UNITS_RE = /\b(both|all|each|every|two|2)\s+(?:of\s+the\s+)?(?:units?|condos?|townhomes?|townhouses?|villas?|homes?|properties|places)\b|\b(?:units?|condos?|townhomes?|townhouses?|villas?|homes?|properties|places)\s+(?:both|all|each|every)\b|\b(?:everyone|entire group|whole group|all of us)\b/i;
const ONE_UNIT_RE = /\b(?:one|1|single|at least one|just one|only one)\s+(?:of\s+the\s+)?(?:units?|condos?|townhomes?|townhouses?|villas?|homes?|properties|places)\b|\b(?:my|our)\s+(?:mom|mother|dad|father|parent|parents|grandma|grandmother|grandpa|grandfather|grandparents|elderly|senior|guest|friend)\b/i;
const NEGATED_RE = /\b(?:do(?:es)?\s+not|don't|doesn't|not|no)\s+(?:need|require|have to have|care about|matter).{0,50}\b(ground[-\s]?floor|bottom[-\s]?floor|first[-\s]?floor|downstairs|stairs?)\b/i;

const CONFIRMED_LISTING_RE = /\b(ground[-\s]?floor|bottom[-\s]?floor|first[-\s]?floor|main[-\s]?floor|downstairs|lower[-\s]?level|street[-\s]?level|walk[-\s]?out|step[-\s]?free|no\s+steps?|no\s+stairs?|stair[-\s]?free|single[-\s]?level)\b/i;
const CONFLICT_LISTING_RE = /\b(second|third|fourth|upper|upstairs|top)\s+(?:floor|level)\b|\bwalk[-\s]?up\b|\b(?:must|need(?:s)?|requires?)\s+(?:to\s+)?(?:climb|use)\s+stairs?\b|\bstairs?\s+(?:required|to\s+enter|to\s+access)\b|\bno\s+elevator\b/i;
const WEAK_LISTING_RE = /\b(elevator|accessible|wheelchair|mobility|ada|single[-\s]?level|one[-\s]?level)\b/i;

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function evidenceSnippet(text: string, match: RegExpMatchArray | null): string | null {
  if (!match || match.index == null) return null;
  const start = Math.max(0, match.index - 70);
  const end = Math.min(text.length, match.index + match[0].length + 90);
  return text.slice(start, end).trim();
}

export function analyzeGroundFloorRequirement(
  messages: Array<string | null | undefined>,
  totalUnits = 2,
): GroundFloorRequirement {
  const evidence: string[] = [];
  let sawGroundFloor = false;
  let sawFloorSpecific = false;
  let sawBoth = false;
  let sawOne = false;

  for (const rawMessage of messages) {
    const text = normalizeText(rawMessage);
    if (!text || NEGATED_RE.test(text)) continue;
    const groundMatch = text.match(GROUND_FLOOR_RE);
    if (!groundMatch) continue;
    sawGroundFloor = true;
    sawFloorSpecific ||= FLOOR_ONLY_RE.test(text);
    sawBoth ||= BOTH_UNITS_RE.test(text);
    sawOne ||= ONE_UNIT_RE.test(text);
    const snippet = evidenceSnippet(text, groundMatch);
    if (snippet) evidence.push(snippet);
  }

  if (!sawGroundFloor) {
    return {
      requested: false,
      scope: "none",
      requiredUnits: 0,
      confidence: "none",
      evidence: [],
      summary: "No ground-floor request found in guest messages.",
    };
  }

  const cappedTotal = Math.max(1, totalUnits);
  const scope: GroundFloorScope = sawBoth ? "both" : sawOne || sawFloorSpecific ? "one" : "unknown";
  const requiredUnits = scope === "both" ? cappedTotal : 1;
  const confidence = sawBoth || sawFloorSpecific ? "high" : sawOne ? "medium" : "low";
  const summary = scope === "both"
    ? `Guest requested ground-floor access for both units.`
    : scope === "one"
      ? `Guest requested ground-floor access for at least one unit.`
      : `Guest mentioned accessibility/ground-floor needs; assume at least one ground-floor unit until clarified.`;

  return {
    requested: true,
    scope,
    requiredUnits,
    confidence,
    evidence: evidence.slice(0, 4),
    summary,
  };
}

export function inferGroundFloorFromText(parts: Array<unknown>): GroundFloorInference {
  const text = normalizeText(parts.filter((p) => p != null).join(" "));
  if (!text) return { status: "unknown", confidence: "low", evidence: null };
  const conflict = text.match(CONFLICT_LISTING_RE);
  if (conflict) {
    return {
      status: "conflict",
      confidence: "high",
      evidence: evidenceSnippet(text, conflict),
    };
  }
  const confirmed = text.match(CONFIRMED_LISTING_RE);
  if (confirmed) {
    return {
      status: "confirmed",
      confidence: FLOOR_ONLY_RE.test(confirmed[0]) ? "high" : "medium",
      evidence: evidenceSnippet(text, confirmed),
    };
  }
  const weak = text.match(WEAK_LISTING_RE);
  if (weak) {
    return {
      status: "unknown",
      confidence: "low",
      evidence: evidenceSnippet(text, weak),
    };
  }
  return { status: "not_confirmed", confidence: "low", evidence: null };
}
