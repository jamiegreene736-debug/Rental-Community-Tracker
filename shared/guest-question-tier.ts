// Guest-question TIER classification for the inbox auto-reply engine
// (2026-07-10 operator ask: "basic tier 1 questions like 'Is there an ocean
// view' ... answered automatically by the AI ... if it is a tier 2 question,
// don't have that be automated but show me in the UI").
//
// Tier 1 = a SUPER BASIC factual question about the property itself — the
// kind the AI may answer automatically (in Hawaii style, signed John
// Carpenter, grounded via Claude web search). Tier 2 = everything else —
// NEVER auto-answered; the UI shows the operator it's on him.
//
// DESIGN (load-bearing):
// - This classifier is deliberately CONSERVATIVE. A false tier-2 costs
//   nothing (the operator answers, which is today's behavior); a false
//   tier-1 is only a CANDIDATE — the server still runs the full 3-layer
//   safety stack (RISK_KEYWORDS first, Claude flag_for_human, output regex
//   filter) and DOWNGRADES to tier 2 on any hold, so the heuristic never
//   auto-sends on its own.
// - Pure + browser-safe (no imports) so the inbox UI and the server share
//   the exact same definition, and it stays unit-testable.

export type GuestQuestionTier = 1 | 2;

export interface GuestQuestionTierResult {
  tier: GuestQuestionTier;
  /** Operator-facing one-liner explaining the classification. */
  reason: string;
  /** Matched tier-1 topic labels (empty for tier 2). */
  topics: string[];
}

// A tier-1 message must be short — long messages are multi-part or carry
// context the heuristic can't vet.
export const MAX_TIER1_MESSAGE_CHARS = 420;

// ── Tier-1 topics: simple property FACTS ─────────────────────────────────────
// Only facts answerable from listing data / community research belong here.
// Deliberately EXCLUDED: elevator/stairs (accessibility), crib/high chair
// (equipment provision = commitment), anything money/dates/policy shaped.
const TIER1_TOPICS: ReadonlyArray<{ key: string; label: string; pattern: RegExp }> = [
  {
    key: "view",
    label: "view",
    pattern: /\b(?:ocean|sea|water|beach|sunset|mountain|garden)[-\s]?(?:view|views|facing)\b|\bviews?\s+of\s+the\s+(?:ocean|sea|water|beach|mountains?|garden)\b|\bocean[-\s]?front\b|\boceanfront\b|\bbeachfront\b|\bwhat(?:'s| is) the view\b/i,
  },
  {
    key: "parking",
    label: "parking",
    pattern: /\bparking\b|\bpark\s+(?:a|the|our|my|your)?\s*cars?\b|\bgarage\b/i,
  },
  {
    key: "pool",
    label: "pool / hot tub",
    pattern: /\bpools?\b|\bhot\s?tubs?\b|\bjacuzzi\b/i,
  },
  {
    key: "ac",
    label: "air conditioning",
    pattern: /\bair[-\s]?con(?:ditioning|ditioner|ditioned)?\b|\ba\/c\b|\bAC\b|\bceiling fans?\b/,
  },
  {
    key: "wifi",
    label: "wifi / internet",
    pattern: /\bwi[-\s]?fi\b|\binternet\b/i,
  },
  {
    key: "laundry",
    label: "washer / dryer",
    pattern: /\bwashers?\b|\bdryers?\b|\blaundry\b|\bwashing machines?\b/i,
  },
  {
    key: "kitchen",
    label: "kitchen",
    pattern: /\bkitchen(?:ette)?s?\b|\bmicrowaves?\b|\bfridges?\b|\brefrigerators?\b|\bcoffee\s?(?:maker|machine|pot)\b|\bdishwashers?\b|\bovens?\b|\bstoves?\b|\bblenders?\b|\btoasters?\b/i,
  },
  {
    key: "bbq",
    label: "BBQ / grill",
    pattern: /\bbbq\b|\bbarbecues?\b|\bgrill(?:s|ing)?\b/i,
  },
  {
    key: "lanai",
    label: "lanai / balcony",
    pattern: /\blanais?\b|\bbalcon(?:y|ies)\b|\bpatios?\b|\bterraces?\b/i,
  },
  {
    key: "beach-distance",
    label: "beach distance",
    pattern: /\b(?:walk|walking|far|close|distance|near|nearby|steps)\b[^.?!]{0,40}\bbeach\b|\bbeach\b[^.?!]{0,40}\b(?:walk|walking|far|close|distance|near|nearby|access)\b/i,
  },
  {
    key: "checkin-time",
    label: "check-in/out time",
    pattern: /\bwhat time\b[^.?!]{0,40}\bcheck[-\s]?(?:in|out)\b|\bcheck[-\s]?(?:in|out)\b[^.?!]{0,40}\btimes?\b/i,
  },
  {
    key: "bedding",
    label: "bedrooms / beds",
    pattern: /\bbed\s?rooms?\b|\bbath\s?rooms?\b|\bsleeps?\b|\bbeds?\b|\bking\b|\bqueen\b|\btwins?\b|\bsofa\s?bed\b|\bsleeper\b|\bbunk\b/i,
  },
  {
    key: "tv",
    label: "TV / streaming",
    pattern: /\btvs?\b|\btelevisions?\b|\bcable\b|\bnetflix\b|\bstreaming\b|\bsmart tv\b/i,
  },
  {
    key: "resort-amenities",
    label: "resort amenities",
    pattern: /\bgym\b|\bfitness\b|\btennis\b|\bpickleball\b|\bplaygrounds?\b/i,
  },
  {
    key: "linens",
    label: "towels / supplies",
    pattern: /\btowels?\b|\blinens?\b|\bsheets\b|\bhair\s?dryers?\b|\btoiletries\b|\bshampoo\b|\bbeach\s+(?:towels?|chairs?|gear|toys|umbrellas?)\b|\bboogie boards?\b/i,
  },
];

// ── Tier-2 forcing signals ───────────────────────────────────────────────────
// ANY hit forces tier 2 even when a tier-1 topic also matched ("is there an
// ocean view and can we check in early?" → tier 2). This list deliberately
// overlaps the server's RISK_KEYWORDS (which run FIRST server-side) so the
// shared classifier is safe standalone — e.g. for the UI or tests.
const TIER2_SIGNALS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "pricing / money", pattern: /\bprices?\b|\bpricing\b|\bcosts?\b|\brates?\b|\bfees?\b|\bcharges?d?\b|\bdeposit\b|\bpay(?:ment|ing)?\b|\$\s?\d|\bdiscounts?\b|\bcheaper\b|\bquote\b|\bfree\b|\bincluded\b|\bcomplimentary\b/i },
  { label: "refund / cancellation", pattern: /\brefunds?\b|\bcancel(?:s|led|lation|ling)?\b|\bchargeback\b/i },
  { label: "availability / booking", pattern: /\bavailab(?:le|ility)\b|\bvacanc(?:y|ies)\b|\bis it open\b|\bstill open\b|\bcalendar\b/i },
  { label: "booking request", pattern: /\b(?:can|could|may|how do|how can|want|like)\b[^.?!]{0,40}\b(?:book|reserve|hold)\b|\bbook (?:it|the|this|a)\b/i },
  { label: "date / stay change", pattern: /\bchange\b[^.?!]{0,30}\b(?:dates?|reservation|booking)\b|\bextend(?:ing)?\b|\bextra nights?\b|\badd (?:a |another )?nights?\b|\bstay longer\b|\bswitch (?:units?|dates?)\b/i },
  { label: "early / late check-in/out", pattern: /\b(?:early|earlier|late|later)\b[^.?!]{0,30}\bcheck[-\s]?(?:in|out)\b|\bcheck[-\s]?(?:in|out)\b[^.?!]{0,30}\b(?:early|earlier|late|later)\b|\bearly arrival\b|\blate departure\b/i },
  { label: "policy exception", pattern: /\bpets?\b|\bdogs?\b|\bcats?\b|\bpupp(?:y|ies)\b|\bsmok(?:e|ing)\b|\bvap(?:e|ing)\b|\bpart(?:y|ies)\b|\bevents?\b|\bwedding\b|\bextra guests?\b|\bmore people\b|\bvisitors?\b/i },
  { label: "entry / codes", pattern: /\b(?:door|gate|access|entry|lockbox|wifi)\s?codes?\b|\block\s?box\b|\bkeys?\b|\bkeyless\b|\bhow (?:do|can) (?:we|i) (?:get|check) in\b|\bcheck[-\s]?in instructions\b/i },
  { label: "problem / complaint", pattern: /\bbroken\b|\bnot working\b|\bdoesn'?t work\b|\bdon'?t work\b|\bdirty\b|\bissues?\b|\bproblems?\b|\bcomplain(?:t|ts|ing)?\b|\bleak(?:s|ing)?\b|\bsmell(?:s|y)?\b|\bdisappoint/i },
  { label: "accessibility", pattern: /\bwheelchairs?\b|\baccessib\w*\b|\bada\b|\belevators?\b|\bstairs?\b|\bground floor\b|\bbottom floor\b|\bmobility\b|\bdisab\w*\b|\bhandicap\w*\b|\bwalkers?\b|\bcanes?\b/i },
  { label: "urgent", pattern: /\burgent(?:ly)?\b|\basap\b|\bemergenc(?:y|ies)\b|\bimmediately\b|\bright away\b|\bright now\b/i },
  { label: "wants a human", pattern: /\bcall me\b|\bphone (?:me|call|number)\b|\bspeak (?:to|with)\b|\btalk to (?:someone|a person|a human|the manager|you)\b/i },
  { label: "service request", pattern: /\bpick (?:us|me|them) up\b|\bshuttle\b|\bairport transfer\b|\btaxi\b|\bdeliver(?:y|ed)?\b|\b(?:can|could|would|will) you (?!tell me|let me know|confirm|clarify)\w/i },
];

// A tier-1 message must actually READ like a question.
const QUESTION_SHAPE =
  /\?|^(?:is|are|was|were|does|do|did|has|have|what|when|how|where|which|who|any)\b|\b(?:i'?m|i am|just|we(?:'re| are)?)\s+(?:wondering|curious)\b|\bwondering\b|\bcurious\b/i;

/**
 * Classify a guest message as tier 1 (super basic property-fact question —
 * eligible for the automatic Hawaii-style AI answer) or tier 2 (everything
 * else — the operator answers; the AI never auto-sends).
 */
export function classifyGuestQuestionTier(message: string): GuestQuestionTierResult {
  const text = (message ?? "").trim();
  if (!text) {
    return { tier: 2, reason: "Empty message", topics: [] };
  }
  if (text.length > MAX_TIER1_MESSAGE_CHARS) {
    return { tier: 2, reason: "Long / multi-part message — needs your read", topics: [] };
  }

  const tier2Hits = TIER2_SIGNALS.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
  if (tier2Hits.length > 0) {
    return {
      tier: 2,
      reason: `Not a basic question (${tier2Hits.slice(0, 3).join(", ")})`,
      topics: [],
    };
  }

  const topics = TIER1_TOPICS.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
  if (topics.length === 0) {
    return { tier: 2, reason: "No basic property-fact topic recognized", topics: [] };
  }

  if (!QUESTION_SHAPE.test(text)) {
    return { tier: 2, reason: "Mentions a basic topic but isn't a question", topics: [] };
  }

  return {
    tier: 1,
    reason: `Basic property question (${topics.slice(0, 4).join(", ")})`,
    topics,
  };
}

// ── UI badge derivation ──────────────────────────────────────────────────────
// One pure mapping from an auto_reply_log row to the inbox badge, so the
// conversation list, thread header, and any future surface can't drift.

export type AutoReplyTierBadgeKind =
  | "tier1-answered" // tier 1, the AI auto-sent the reply
  | "tier1-sending"  // tier 1, queued — sends when the review window elapses
  | "tier1-manual"   // tier 1, a human sent the (AI-drafted) reply
  | "tier1-held"     // tier 1 but not sent (tier-1 auto-answer toggled off)
  | "tier2-held"     // tier 2, awaiting the operator — NO automatic response
  | "tier2-handled"; // tier 2, already replied/dismissed

export interface AutoReplyTierBadge {
  kind: AutoReplyTierBadgeKind;
  tier: GuestQuestionTier;
  label: string;
  /** Longer hover text; includes the stored tier reason when present. */
  title: string;
}

export function autoReplyTierBadge(log: {
  tier?: number | null;
  tierReason?: string | null;
  status?: string | null;
  replySent?: boolean | null;
  autoSent?: boolean | null;
}): AutoReplyTierBadge | null {
  const tier = log.tier === 1 ? 1 : log.tier === 2 ? 2 : null;
  if (tier == null) return null; // legacy rows (pre-tier) render nothing
  const reason = (log.tierReason ?? "").trim();
  const withReason = (base: string) => (reason ? `${base} — ${reason}` : base);

  if (tier === 1) {
    if (log.replySent && log.autoSent) {
      return { kind: "tier1-answered", tier, label: "Tier 1 · AI answered", title: withReason("Basic question — the AI replied automatically") };
    }
    if (log.replySent) {
      return { kind: "tier1-manual", tier, label: "Tier 1 · answered", title: withReason("Basic question — answered from the AI draft") };
    }
    if (log.status === "queued") {
      return { kind: "tier1-sending", tier, label: "Tier 1 · AI answering…", title: withReason("Basic question — the AI reply sends shortly unless you intervene") };
    }
    if (log.status === "dismissed") return null;
    return { kind: "tier1-held", tier, label: "Tier 1 · held", title: withReason("Basic question, but tier-1 auto-answer is off — reply yourself") };
  }

  if (log.replySent || log.status === "dismissed") {
    return { kind: "tier2-handled", tier, label: "Tier 2 · handled", title: withReason("Tier 2 — no automatic AI response; already handled") };
  }
  return { kind: "tier2-held", tier, label: "Tier 2 · no auto-reply", title: withReason("Tier 2 — the AI will NOT answer this automatically; it needs you") };
}
