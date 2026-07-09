// AI Draft Approval queue — polls Guesty inbox for new/unanswered guest
// messages, gathers context (listing, reservation, amenities) via Claude
// tool-use, and saves John Carpenter reply drafts for human approval. Every
// attempt is persisted to autoReplyLog.

import { guestyRequest } from "./guesty-sync";
import { findGuestyConversationById, sendGuestyConversationMessage, deliveryOutcome } from "./guesty-ota-messaging";
import { isBookingChannel, sanitizeForBookingChannel } from "@shared/receipt-message";
import { isIncomingPost, isSystemPost, isHostPost, pickPostToReplyTo, postTimestampMs } from "@shared/guesty-post-classify";
import { storage } from "./storage";
import { getUnitBuilderByPropertyId } from "../client/src/data/unit-builder-data";
import { occupancyForBedrooms } from "../shared/occupancy";
import { fallbackWalkForResort } from "../shared/walking-distance";
import { resolveIslandRegion } from "../shared/area-identity";
import { addGuestPersonalTouch, addInitialContactCloser, humanizeReply, trimProximityOnlyReply } from "./humanize-reply";
import type { AutoReplyLog, InsertAutoReplyLog } from "@shared/schema";

type AutoReplyStatus = "sent" | "queued" | "drafted" | "flagged" | "dismissed" | "error";

let _enabled = true;
let _isRunning = false;
let _lastRunAt: Date | null = null;
let _lastRunResult: { processed: number; sent: number; drafted: number; flagged: number; queued: number; errors: number; message: string } | null = null;

// ── Auto-send (Part B) ─────────────────────────────────────────────────────
// Whether clean drafts (status "drafted") get auto-sent. ORTHOGONAL to _enabled
// (which controls whether drafts are GENERATED at all). Persisted in app_settings
// so a Railway restart can't silently flip it on/off. A clean draft is QUEUED with
// a sendAfter deadline (the review window) and a separate send pass
// (runAutoSendQueue) sends it only if it's still uncontested at that point.
//
// AUTO-SEND DISABLED BY DEFAULT (2026-06-09, operator: "disable the automatic
// reply feature"). Auto-SEND is OFF: nothing goes out to a guest automatically.
// Draft GENERATION is unchanged (`_enabled`, orthogonal) — the AI still drafts a
// reply for every incoming guest message; with auto-send off those land as
// status "drafted" and surface in the inbox attention banner, where the operator
// edits + Saves (teaching the AI from the edit) or Sends. The one-time
// SETTING_DISABLE_ROLLOUT flag below forces auto-send OFF at boot regardless of
// the stale persisted "true" left by the 2026-06-08 full-auto rollout, while
// still letting a later operator ON toggle stick. (The historical
// SETTING_FULLAUTO_ROLLOUT block remains but is superseded — the disable rollout
// runs first and returns.) See AGENTS.md "Auto-reply is DRAFTS-ONLY".
const SETTING_AUTOSEND_ENABLED = "auto_send.master_enabled";
const SETTING_REVIEW_WINDOW = "auto_send.review_window_seconds";
const SETTING_HOLD_RECOMMENDATIONS = "auto_send.hold_recommendations";
const SETTING_FULLAUTO_ROLLOUT = "auto_send.full_auto_rollout_v1";
const SETTING_DISABLE_ROLLOUT = "auto_send.disabled_rollout_v2";
let _autoSendEnabled = false;      // DRAFTS-ONLY: nothing auto-sends; every reply waits for the operator
let _reviewWindowSeconds = 90;
let _holdRecommendations = false;  // moot while auto-send is off (only gates which clean drafts would queue)
let _autoSendConfigLoaded = false;
let _isAutoSendRunning = false;
let _lastAutoSendAt: Date | null = null;
let _lastAutoSendResult: { due: number; sent: number; intercepted: number; skipped: number; errors: number; message: string } | null = null;

export function getAutoReplyStatus() {
  return {
    enabled: _enabled,
    running: _isRunning,
    lastRunAt: _lastRunAt,
    lastRunResult: _lastRunResult,
    autoSendEnabled: _autoSendEnabled,
    reviewWindowSeconds: _reviewWindowSeconds,
    holdRecommendations: _holdRecommendations,
    lastAutoSendAt: _lastAutoSendAt,
    lastAutoSendResult: _lastAutoSendResult,
  };
}

export function setAutoReplyEnabled(enabled: boolean) {
  _enabled = enabled;
  console.log(`[auto-reply] ${enabled ? "Enabled" : "Disabled"}`);
}

export async function loadAutoSendConfig(): Promise<void> {
  try {
    // One-time DISABLE rollout (2026-06-09, operator: "disable the automatic
    // reply feature"). If the flag is unset this is the first boot after the
    // disable change: FORCE auto-send OFF — overriding the stale persisted "true"
    // left by the earlier full-auto rollout — persist it (so a later operator ON
    // toggle sticks), revert any drafts queued for auto-send back to the manual
    // review queue so they surface in the attention banner, preserve the window /
    // hold settings, then stamp the flag so we only force once. Draft generation
    // is untouched — the AI keeps drafting for human review + teaching.
    const disableRollout = await storage.getSetting(SETTING_DISABLE_ROLLOUT);
    if (disableRollout == null) {
      _autoSendEnabled = false;
      await storage.setSetting(SETTING_AUTOSEND_ENABLED, "false");
      try {
        const queued = (await storage.getAutoReplyLogs(300)).filter((l) => l.status === "queued" && !l.replySent);
        for (const l of queued) await storage.updateAutoReplyLog(l.id, { status: "drafted", sendAfter: null });
        if (queued.length) console.log(`[auto-reply] disable rollout: reverted ${queued.length} queued draft(s) to manual review`);
      } catch (e) {
        console.warn(`[auto-reply] disable rollout: could not revert queued drafts: ${(e as Error).message}`);
      }
      const [window, hold] = await Promise.all([
        storage.getSetting(SETTING_REVIEW_WINDOW),
        storage.getSetting(SETTING_HOLD_RECOMMENDATIONS),
      ]);
      if (window != null) {
        const n = Number(window);
        if (Number.isFinite(n) && n >= 0) _reviewWindowSeconds = Math.min(Math.round(n), 3600);
      }
      if (hold != null) _holdRecommendations = hold !== "false";
      await storage.setSetting(SETTING_DISABLE_ROLLOUT, "1");
      // Also stamp the (now-superseded) enable-rollout flag so it can NEVER force
      // auto-send back ON — critical on a FRESH DB, where it would otherwise be
      // unstamped and fire on the next boot after this block returns.
      await storage.setSetting(SETTING_FULLAUTO_ROLLOUT, "1");
      _autoSendConfigLoaded = true;
      console.log("[auto-reply] auto-send DISABLED by one-time rollout (drafts still generated for manual review + teaching)");
      return;
    }

    // One-time full-automation rollout (2026-06-08, superseded by the disable
    // rollout above — kept for history; only ever reached if disabled_rollout_v2
    // is stamped while full_auto_rollout_v1 is somehow unset, which doesn't happen
    // on a fresh DB because the disable rollout runs first and returns).
    const rollout = await storage.getSetting(SETTING_FULLAUTO_ROLLOUT);
    if (rollout == null) {
      _autoSendEnabled = true;
      _holdRecommendations = false;
      await storage.setSetting(SETTING_AUTOSEND_ENABLED, "true");
      await storage.setSetting(SETTING_HOLD_RECOMMENDATIONS, "false");
      const existingWindow = await storage.getSetting(SETTING_REVIEW_WINDOW);
      if (existingWindow == null) {
        await storage.setSetting(SETTING_REVIEW_WINDOW, String(_reviewWindowSeconds));
      } else {
        const n = Number(existingWindow);
        if (Number.isFinite(n) && n >= 0) _reviewWindowSeconds = Math.min(Math.round(n), 3600);
      }
      await storage.setSetting(SETTING_FULLAUTO_ROLLOUT, "1");
      _autoSendConfigLoaded = true;
      console.log(`[auto-reply] FULL-AUTO rollout applied: auto-send ON, holdRecommendations OFF, window=${_reviewWindowSeconds}s`);
      return;
    }

    const [enabled, window, hold] = await Promise.all([
      storage.getSetting(SETTING_AUTOSEND_ENABLED),
      storage.getSetting(SETTING_REVIEW_WINDOW),
      storage.getSetting(SETTING_HOLD_RECOMMENDATIONS),
    ]);
    if (enabled != null) _autoSendEnabled = enabled === "true";
    if (window != null) {
      const n = Number(window);
      if (Number.isFinite(n) && n >= 0) _reviewWindowSeconds = Math.min(Math.round(n), 3600);
    }
    if (hold != null) _holdRecommendations = hold !== "false";
    _autoSendConfigLoaded = true;
    console.log(`[auto-reply] auto-send config: enabled=${_autoSendEnabled} window=${_reviewWindowSeconds}s holdRecommendations=${_holdRecommendations}`);
  } catch (err) {
    // Fail safe: if the settings table isn't ready yet, keep the in-memory
    // full-auto defaults (ON). A storage outage also stalls draft generation /
    // the send queue, so nothing actually sends until storage recovers.
    console.warn(`[auto-reply] could not load auto-send config (using full-auto defaults): ${(err as Error).message}`);
  }
}

export function getAutoSendConfig() {
  return { autoSendEnabled: _autoSendEnabled, reviewWindowSeconds: _reviewWindowSeconds, holdRecommendations: _holdRecommendations };
}

export async function setAutoSendConfig(cfg: { enabled?: boolean; reviewWindowSeconds?: number; holdRecommendations?: boolean }): Promise<void> {
  if (typeof cfg.enabled === "boolean") {
    _autoSendEnabled = cfg.enabled;
    await storage.setSetting(SETTING_AUTOSEND_ENABLED, cfg.enabled ? "true" : "false");
    // Kill switch: when turned OFF, revert any still-queued drafts back to the
    // human approval queue so they show as normal pending drafts, not pending sends.
    if (!cfg.enabled) {
      try {
        const queued = (await storage.getAutoReplyLogs(300)).filter((l) => l.status === "queued" && !l.replySent);
        for (const l of queued) await storage.updateAutoReplyLog(l.id, { status: "drafted", sendAfter: null });
        if (queued.length) console.log(`[auto-reply] auto-send disabled — reverted ${queued.length} queued draft(s) to manual review`);
      } catch (e) {
        console.warn(`[auto-reply] failed to revert queued drafts on disable: ${(e as Error).message}`);
      }
    }
    console.log(`[auto-reply] auto-send ${cfg.enabled ? "ENABLED" : "DISABLED"}`);
  }
  if (typeof cfg.reviewWindowSeconds === "number" && Number.isFinite(cfg.reviewWindowSeconds) && cfg.reviewWindowSeconds >= 0) {
    _reviewWindowSeconds = Math.min(Math.round(cfg.reviewWindowSeconds), 3600);
    await storage.setSetting(SETTING_REVIEW_WINDOW, String(_reviewWindowSeconds));
  }
  if (typeof cfg.holdRecommendations === "boolean") {
    _holdRecommendations = cfg.holdRecommendations;
    await storage.setSetting(SETTING_HOLD_RECOMMENDATIONS, cfg.holdRecommendations ? "true" : "false");
  }
  _autoSendConfigLoaded = true;
}

// Heuristic: does the guest message look like an area/recommendation ask? Used by
// the `holdRecommendations` training-wheel to keep world-knowledge area answers in
// the human queue (they're the least verifiable, riskiest-to-auto-send category).
function looksLikeAreaQuestion(text: string): boolean {
  return /\b(restaurant|restaurants|eat|eating|dining|dinner|lunch|breakfast|food|beach|beaches|snorkel|surf|hike|hiking|things to do|activities|activity|attraction|recommend|recommendation|nearby|near (?:by|here|us)|around here|get(?:ting)? around|rental car|grocery|groceries|shopping|luau|tour|tours|sightseeing|what to do|where (?:to|should)|weather)\b/i.test(text);
}

// --- Safety classifier (input side) ---------------------------------------
//
// First line of defense for AI Draft Approval: if the guest's message contains
// any of these terms, we ALWAYS draft for human review instead of
// auto-sending. The cost of a missed auto-send (host clicks Send a few
// minutes later) is much smaller than the cost of an auto-send that
// commits us to something we can't deliver — refunds, pet exceptions,
// schedule changes, etc.
//
// Keywords are grouped by category so it's easy to reason about what's
// being filtered and add new ones without duplicating. "When in doubt,
// add it." Any false-positive just means a draft instead of a send.
const RISK_KEYWORDS = [
  // Money / billing — anything that touches the wallet drafts.
  "refund", "cancel", "cancellation", "chargeback", "dispute",
  "deposit", "security deposit", "credit", "comp", "compensation",
  "discount", "lower price", "cheaper", "negotiate",
  // Property condition / damage / cleanliness complaints.
  "damage", "damaged", "broken", "leak", "leaking", "flood", "mold",
  "complaint", "complain", "unsafe", "unsanitary", "dirty", "filthy",
  "bug", "roach", "rat", "mouse", "bed bug", "bedbug", "cockroach",
  "mice", "ants", "termite",
  // Health / safety / medical / emergency.
  "injury", "injured", "hurt", "medical", "hospital", "allergic",
  "allergy", "asthma", "emergency", "police", "fire", "ambulance",
  "911", "sick", "covid", "covid-19", "quarantine",
  // Legal / disputes / fair-housing.
  "lawyer", "legal", "attorney", "sue", "lawsuit", "subpoena",
  "warrant", "discrimination", "racist", "racism", "harass",
  "harassment", "ada", "disability", "accommodation",
  "wheelchair", "handicap", "handicapped", "mobility", "walker",
  "cane", "ground floor", "bottom floor", "stairs", "service animal",
  // Press / media / influencer (rare but high-stakes — always human).
  "press", "journalist", "reporter", "media", "interview",
  "review " /* trailing space avoids "previewed", "reviewing context" */,
  "rating", "yelp", "tripadvisor",
  // Policy exceptions — these are ALL human-decided per listing.
  "pet", "pets", "dog", "cat", "puppy", "service dog", "esa",
  "smoke", "smoking", "vape", "vaping", "marijuana", "weed", "cannabis",
  "party", "wedding", "event", "gathering", "loud music",
  "extra guest", "additional guest", "more people",
  "extend", "extension", "extra night", "stay longer",
  "early check-in", "early checkin", "late check-out", "late checkout",
  "late check out", "early arrival", "late departure",
  // Operational issues that need real-world action, not a chat reply.
  "lockout", "locked out", "can't get in", "cannot access",
  "no power", "no water", "no wifi", "no internet",
  "broken ac", "broken a/c", "ac not working", "heat not working",
  "noise", "neighbor", "construction",
  // Insurance / liability / waiver.
  "insurance", "claim", "liability", "waiver", "indemnify",
  // Weather / disaster (active conditions = host attention).
  "hurricane", "tsunami", "evacuation", "flood warning", "wildfire",
  // Explicit urgency — a guest who says it's urgent gets a human, fast. These
  // also drive the "URGENT" highlight in the inbox attention banner. Anything
  // genuinely time-critical (lockout / no power / leak / medical) is already
  // covered by the operational + health buckets above; these catch the cases
  // where the guest signals urgency without naming the specific problem.
  "urgent", "urgently", "asap", "a.s.a.p", "as soon as possible", "right away",
  "right now", "immediately", "help me", "stuck", "stranded",
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordPattern(keyword: string): RegExp {
  const source = keyword.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  return new RegExp(`(?<![a-z0-9])${source}(?![a-z0-9])`, "i");
}

const RISK_KEYWORD_PATTERNS = RISK_KEYWORDS.map((keyword) => ({
  keyword: keyword.trim(),
  pattern: keywordPattern(keyword),
}));

function classifyMessage(text: string): { risky: boolean; matched: string[] } {
  const matched = RISK_KEYWORD_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ keyword }) => keyword);
  return { risky: matched.length > 0, matched };
}

// --- Safety classifier (output side) --------------------------------------
//
// Second line of defense: even when the GUEST'S message looks clean,
// scan the AI's draft before it enters the approval queue. If the model commits
// to something it shouldn't (refund language, schedule change, pet exception,
// etc.) we flag it so the host sees why it needs extra care. Patterns are
// intentionally permissive — false positives just add a warning.
const OUTPUT_RISK_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bI'?ll (?:refund|comp|credit)\b/i, reason: "promised refund/comp/credit" },
  { pattern: /\bwe (?:can|will|'?ll) (?:refund|comp|credit)\b/i, reason: "promised refund/comp/credit" },
  { pattern: /\b(?:full|partial|complimentary)\s+refund\b/i, reason: "mentions refund" },
  { pattern: /\b(?:waive|waiving|waived)\b/i, reason: "promised to waive a fee/policy" },
  { pattern: /\bI?'?ll (?:upgrade|move you|relocate you)\b/i, reason: "promised upgrade/relocation" },
  { pattern: /\b(?:free|no charge|on us|on the house)\b/i, reason: "promised something free" },
  { pattern: /\bwe (?:allow|accept|welcome)\s+(?:pets?|dogs?|cats?)\b/i, reason: "confirmed pet exception" },
  { pattern: /\b(?:pets?|dogs?|cats?)\s+(?:are|is)\s+(?:allowed|welcome|fine|ok|okay)\b/i, reason: "confirmed pet exception" },
  { pattern: /\b(?:smoking|vaping)\s+(?:is|will be|would be)\s+(?:allowed|fine|ok|okay)\b/i, reason: "confirmed smoking exception" },
  { pattern: /\bearly check[- ]?in (?:is|will be) (?:fine|ok|okay|available)\b/i, reason: "confirmed early check-in" },
  { pattern: /\blate check[- ]?out (?:is|will be) (?:fine|ok|okay|available)\b/i, reason: "confirmed late check-out" },
  { pattern: /\bextend(?:ed|ing)?\s+your stay\b/i, reason: "discussed stay extension" },
  { pattern: /\b(?:lockbox|access)\s+code\s+(?:is|will be)\b/i, reason: "shared access code in chat" },
  { pattern: /\b\d{4,6}\b.*\b(?:lockbox|door code|gate code|access code)\b/i, reason: "shared access code in chat" },
  // --- Local-knowledge anti-hallucination backstop --------------------------
  // World-knowledge area answers must never assert a verifiable specific about
  // an outside business/attraction (a phone number, current hours, or a price).
  // If a draft slips one through, hold it for human review rather than send it.
  { pattern: /\b\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/, reason: "draft contains a phone number" },
  { pattern: /\b(?:open|opens|closes|closed)\s+(?:now|today|until|at)\b/i, reason: "draft claims current hours / open status" },
  { pattern: /\b(?:24\/7|24-7|24 hours a day|open 24)\b/i, reason: "draft claims 24-hour hours" },
  { pattern: /\b(?:open|closes?)\b[^.]{0,25}\b\d{1,2}\s*(?:am|pm|a\.m\.|p\.m\.)\b/i, reason: "draft claims specific business hours" },
  { pattern: /\b(?:admission|entry|ticket|tour|meal|dinner|lunch|breakfast|entree|cover charge)\b[^.]{0,40}\$\s?\d/i, reason: "draft quotes an external business price" },
  { pattern: /\$\s?\d[\d,]*(?:\.\d{2})?[^.]{0,40}\b(?:admission|entry|ticket|tour|per person|each|meal|dinner|lunch)\b/i, reason: "draft quotes an external business price" },
];

function classifyOutput(text: string): { risky: boolean; reason: string | null } {
  for (const { pattern, reason } of OUTPUT_RISK_PATTERNS) {
    if (pattern.test(text)) return { risky: true, reason };
  }
  return { risky: false, reason: null };
}

async function getAutoReplyStyleGuidance(): Promise<string> {
  try {
    const examples = await storage.getRecentAutoReplyStyleExamples(6);
    const guidance = examples
      .map((example) => example.analysis?.trim())
      .filter(Boolean)
      .slice(0, 6);
    if (guidance.length === 0) return "";
    return `\n\nOPERATOR STYLE COACHING FROM PRIOR EDITS:
${guidance.map((item, index) => `${index + 1}. ${item}`).join("\n")}`;
  } catch (err) {
    console.warn("[auto-reply] style guidance unavailable:", (err as Error).message);
    return "";
  }
}

function localEditAnalysis(originalDraft: string | null | undefined, editedDraft: string): string {
  const original = (originalDraft ?? "").trim();
  const edited = editedDraft.trim();
  if (!original) return "Operator wrote the draft manually. Match this direct, guest-ready phrasing for similar messages.";
  if (edited.length < original.length * 0.75) return "Operator shortened the AI draft. Prefer tighter replies that answer directly without extra caveats.";
  if (edited.length > original.length * 1.25) return "Operator added detail. Include the concrete context the guest needs instead of staying too generic.";
  return "Operator adjusted wording. Prefer the edited draft's more natural host phrasing, concise structure, and specific answer-first tone.";
}

async function analyzeDraftEdit(params: {
  guestMessage: string;
  originalDraft?: string | null;
  editedDraft: string;
}): Promise<string> {
  const fallback = localEditAnalysis(params.originalDraft, params.editedDraft);
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return fallback;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 180,
        system: "You extract reusable writing guidance from a hospitality operator's edit. Return one concise coaching note for future drafts. Do not include private guest facts unless needed as a generic pattern.",
        messages: [{
          role: "user",
          content: `Guest message:\n${params.guestMessage}\n\nOriginal AI draft:\n${params.originalDraft ?? ""}\n\nOperator edited draft:\n${params.editedDraft}\n\nWrite one reusable instruction for future AI drafts.`,
        }],
      }),
    });
    if (!resp.ok) return fallback;
    const data = await resp.json() as any;
    const text = (data?.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
    return text || fallback;
  } catch (err) {
    console.warn("[auto-reply] edit analysis failed:", (err as Error).message);
    return fallback;
  }
}

// --- Guesty helpers -------------------------------------------------------

interface GuestyPost {
  _id?: string;
  body?: string;
  text?: string;
  message?: string;
  createdAt?: string;
  module?: { type?: string };
  conversationType?: string;
  isIncoming?: boolean;
  direction?: string;
  authorType?: string;
  // Inbox-v2 authoritative origin marker — see isIncomingPost / isHostPost
  // for the priority order. NOTE FOR CODEX: legacy fields above are kept
  // for older fixtures; do NOT remove them.
  sentBy?: "guest" | "host" | "log" | string;
}

interface GuestyConversation {
  _id: string;
  guest?: { fullName?: string; firstName?: string };
  listingId?: string;
  reservationId?: string;
  lastMessageAt?: string;
  lastMessageReceivedAt?: string;
  // Older shape Guesty used to return — null on the current shape,
  // kept for type compatibility with cached/older responses.
  unreadCount?: number | null;
  // Current shape: state is an object with `read` and `status`.
  // `read: false` means the conversation hasn't been viewed by the
  // host yet. `status: "OPEN"` means active (vs CLOSED/ARCHIVED).
  // The string-form ("NEW"/"UNREAD") is the legacy shape — we keep
  // both in the type so older fixtures still typecheck.
  state?: string | { read?: boolean; status?: string };
  module?: { type?: string };
  integration?: { platform?: string };
  meta?: { reservations?: any[]; guest?: { fullName?: string; firstName?: string } };
  posts?: GuestyPost[];
}

// Guesty's communication endpoints wrap list responses inconsistently:
//   bare:      [...]
//   legacy:    { results: [...] }
//   envelope:  { status, data: [...] }
//   envelope:  { status, data: { conversations: [...], cursor, count, ... } }   ← current
// Earlier code returned `data.data` directly when present, which was an
// OBJECT for the current envelope shape — `.filter(...)` on that object
// threw a TypeError that the top-level catch swallowed as "errors: 1"
// with `processed: 0`. Walk the shape until we find an array.
function unwrapConversations(raw: any): GuestyConversation[] {
  if (Array.isArray(raw)) return raw as GuestyConversation[];
  if (!raw || typeof raw !== "object") return [];
  // Try named fields at depth 0
  for (const k of ["conversations", "results", "data"] as const) {
    const v = (raw as any)[k];
    if (Array.isArray(v)) return v as GuestyConversation[];
  }
  // Recurse one level — current Guesty shape buries the array at data.conversations
  for (const k of ["data", "results", "result"] as const) {
    const v = (raw as any)[k];
    if (v && typeof v === "object") {
      const inner = unwrapConversations(v);
      if (inner.length > 0) return inner;
    }
  }
  return [];
}

function unwrapPosts(raw: any): GuestyPost[] {
  if (Array.isArray(raw)) return raw as GuestyPost[];
  if (!raw || typeof raw !== "object") return [];
  for (const k of ["posts", "messages", "results", "data"] as const) {
    const v = (raw as any)[k];
    if (Array.isArray(v)) return v as GuestyPost[];
  }
  for (const k of ["data", "result"] as const) {
    const v = (raw as any)[k];
    if (v && typeof v === "object") {
      const inner = unwrapPosts(v);
      if (inner.length > 0) return inner;
    }
  }
  return [];
}

// Pull conversations that COULD have a guest message awaiting our
// response. The narrower "is it unread" question used to be:
//
//   results.filter((c) => (c.unreadCount ?? 0) > 0)
//
// Guesty's current API shape returns `unreadCount: null` and tracks
// read state via `state.read: false` / `state.status: "OPEN"`. Worse,
// the read flag flips to true the moment the operator opens the
// thread in the Guesty UI — even if they didn't reply — so a
// pure "unread" filter would miss conversations where the host
// looked at the inquiry, walked away, and we should still
// auto-respond. The cleanest contract: pull every OPEN conversation
// here, then `pickPostToReplyTo` (per-thread) decides whether the
// guest's latest message is actually awaiting a host reply.
async function fetchOpenConversations(limit = 100): Promise<GuestyConversation[]> {
  // CRITICAL: trailing `&fields=` IS LOAD-BEARING — see the matching note in
  // client/src/pages/inbox.tsx. Without it Guesty returns a stripped state
  // (`{read, status}` only) and we lose `state.lastMessage`,
  // `state.readByNonUser`, `state.isLastPostFromGuest`. The OPEN/NEW filter
  // below still works on the stripped shape, but the rich state is needed
  // to keep behavior aligned with the inbox UI and to surface an accurate
  // sort order for any downstream consumers.
  // NOTE FOR CODEX: Guesty's /conversations returns the full document only
  // when `fields=` is present. Don't strip it as a redundant query param.
  //
  // PAGINATION (load-bearing, updated 2026-07-09): Guesty's /communication/conversations
  // now REJECTS the `skip` param — `400: "skip" is not allowed` — which silently broke
  // this fetch entirely (every tick threw, and auto-reply skipped every guest message,
  // the exact 2026-05-04-class outage). Its cursor is also unreliable on this endpoint.
  // But it HONORS a large `limit` and returns the whole inbox in ONE request, so we fetch
  // once at a generous ceiling instead of skip-paging. `sort=-lastMessageAt` (recency,
  // with the creation-date fallback the note below describes) still orders the result.
  // Tunable via AUTO_REPLY_CONV_SCAN_MAX. If the inbox ever exceeds it, the OLDEST
  // conversations beyond the ceiling are not fetched (they're the least likely to hold a
  // guest message still awaiting a first reply).
  const FETCH_LIMIT = Math.max(limit || 100, Number(process.env.AUTO_REPLY_CONV_SCAN_MAX) || 500);
  const data = await guestyRequest(
    "GET",
    `/communication/conversations?limit=${FETCH_LIMIT}&sort=-lastMessageAt&fields=`
  );
  const all = unwrapConversations(data);
  return all.filter((c) => {
    const status =
      (typeof c.state === "object" && c.state?.status) ||
      (typeof c.state === "string" ? c.state : null);
    if (!status) return true; // unknown shape — be permissive
    const s = String(status).toUpperCase();
    return s === "OPEN" || s === "NEW" || s === "UNREAD" || s === "UNANSWERED";
  });
}

async function fetchConversationThread(id: string): Promise<GuestyConversation | null> {
  try {
    const data = await guestyRequest("GET", `/communication/conversations/${id}`) as any;
    // Single-conversation responses are wrapped as { status, data: {...conv} }
    // — the bare `data` is the conversation object, not a list.
    return data?.data ?? data ?? null;
  } catch (err) {
    console.error(`[auto-reply] Failed to fetch thread ${id}:`, (err as Error).message);
    return null;
  }
}

async function fetchConversationPosts(id: string): Promise<GuestyPost[]> {
  try {
    const data = await guestyRequest("GET", `/communication/conversations/${id}/posts?limit=100`) as any;
    return unwrapPosts(data);
  } catch (err) {
    console.error(`[auto-reply] Failed to fetch posts for ${id}:`, (err as Error).message);
    return [];
  }
}

// Host/guest/system post classification + reply-trigger selection (isIncomingPost,
// isSystemPost, isHostPost, pickPostToReplyTo, postTimestampMs) now live in the
// pure, unit-tested shared/guesty-post-classify module (imported above). It was
// extracted verbatim so the 2026-05-04 inbox-v2 `sentBy` outage surface — where
// these returned null for every thread and auto-reply silently skipped real guest
// messages for ~2 weeks — is locked by tests/guesty-post-classify.test.ts.

function logCreatedAtMs(log: Pick<AutoReplyLog, "createdAt">): number {
  const value = log.createdAt instanceof Date ? log.createdAt.getTime() : new Date(log.createdAt).getTime();
  return Number.isFinite(value) ? value : 0;
}

function isPendingApprovalLog(log: Pick<AutoReplyLog, "status" | "replySent">): boolean {
  return !log.replySent && (log.status === "drafted" || log.status === "flagged" || log.status === "error");
}

function hasManualHostReplyAfterTrigger(log: AutoReplyLog, posts: GuestyPost[]): boolean {
  const conversational = posts.filter((p) => !isSystemPost(p));
  const triggerPost = conversational.find((p) => p._id === log.triggerPostId);
  const triggerTime = triggerPost ? postTimestampMs(triggerPost) : logCreatedAtMs(log);
  if (triggerTime <= 0) return false;
  return conversational.some((p) => isHostPost(p) && postTimestampMs(p) > triggerTime);
}

// A system "status changed to canceled / declined / expired" log in the thread
// (at or after the draft's trigger) means the reservation is dead — the pending
// draft is moot and should be cleared from the approval queue/badge.
function reservationCanceledInThread(log: AutoReplyLog, posts: GuestyPost[]): boolean {
  const triggerPost = posts.find((p) => p._id === log.triggerPostId);
  const triggerTime = triggerPost ? postTimestampMs(triggerPost) : logCreatedAtMs(log);
  return posts.some((p) =>
    isSystemPost(p) &&
    /\b(cancell?ed|cancell?ation|declined|expired)\b/i.test(String(p.body ?? p.text ?? (p as any).message ?? "")) &&
    postTimestampMs(p) >= triggerTime,
  );
}

async function dismissHandledDraftsForConversation(
  conversationId: string,
  posts: GuestyPost[],
  logs?: AutoReplyLog[],
): Promise<number> {
  const candidates = (logs ?? await storage.getAutoReplyLogs(200))
    .filter((log) => log.conversationId === conversationId && isPendingApprovalLog(log));
  if (candidates.length === 0) return 0;
  // Newest pending draft is the live one for this thread; any OLDER pending
  // draft for the same conversation is superseded (the thread moved on) and
  // would otherwise double-count one thread in the badge + approval queue.
  candidates.sort((a, b) => logCreatedAtMs(b) - logCreatedAtMs(a));
  let dismissed = 0;
  for (let i = 0; i < candidates.length; i++) {
    const log = candidates[i];
    const superseded = i > 0;
    const hostReplied = posts.length > 0 && hasManualHostReplyAfterTrigger(log, posts);
    const canceled = posts.length > 0 && reservationCanceledInThread(log, posts);
    if (!superseded && !hostReplied && !canceled) continue;
    await storage.updateAutoReplyLog(log.id, {
      status: "dismissed",
      errorMessage: null,
    });
    dismissed++;
  }
  return dismissed;
}

export async function dismissHandledAutoReplyDrafts(limit = 200): Promise<number> {
  const logs = (await storage.getAutoReplyLogs(limit)).filter(isPendingApprovalLog);
  const byConversation = new Map<string, AutoReplyLog[]>();
  for (const log of logs) {
    const list = byConversation.get(log.conversationId) ?? [];
    list.push(log);
    byConversation.set(log.conversationId, list);
  }

  let dismissed = 0;
  for (const [conversationId, conversationLogs] of Array.from(byConversation.entries())) {
    // Fetch posts for host-reply / cancellation signals; even on an empty/failed
    // fetch we still run the per-conversation pass so superseded duplicates are
    // de-duped (that check needs no posts).
    const posts = await fetchConversationPosts(conversationId).catch(() => [] as GuestyPost[]);
    dismissed += await dismissHandledDraftsForConversation(conversationId, posts, conversationLogs);
  }
  if (dismissed > 0) {
    console.log(`[auto-reply] Dismissed ${dismissed} stale approval draft(s) (host replied, superseded, or reservation canceled)`);
  }
  return dismissed;
}

// Delivery-verified send for the AUTO-SEND engine (runAutoSendQueue) AND the
// manual attention-banner Send (sendDraftedReply). Routes through the same
// hardened path as Message AD / the inbox compose box: resolve the
// proven-delivering OTA module from the reservation's integration.platform,
// ASCII-sanitize for Booking.com, send ONCE, and confirm the channel actually
// accepted it via module.externalId. A bare Guesty `pending` post is NOT proof
// the guest received it — see AGENTS.md #51 and the
// guesty-bookingcom-delivery-externalid memory. Returns the verdict so the caller
// never marks a thread "replied" on a hard misroute.
async function deliverGuestyReply(args: {
  conversationId: string;
  body: string;
  channel?: string | null;
  reservationId?: string | null;
  // Interactive callers (the banner Send) can pass a shorter window so the
  // operator isn't blocked the full ~38s; background callers omit it and keep
  // the full window. The POST still happens exactly once either way.
  verifyDeadlineMs?: number;
}): Promise<{ verified: boolean; pending: boolean; deliveredVia: string; deliveryModuleType?: string; reason?: string }> {
  const conversation = await findGuestyConversationById(
    args.conversationId,
    args.reservationId ?? null,
    args.channel ?? null,
  );
  // If the conversation can't be resolved (Guesty hiccup), fall back to a bare
  // channel module so a clean draft still attempts delivery.
  const module = conversation?.module ?? { type: args.channel || "email" };
  // Booking.com only delivers ASCII-plain text (straight quotes, hyphens, no
  // smart punctuation / rich text) — mirror the inbox send + relocation/receipt
  // paths so an auto-send / banner-send reply isn't mangled or dropped. Match by
  // the channel hint OR the resolved module type so it fires even when the hint
  // is absent.
  let body = args.body;
  const moduleType = String(module.type ?? "").toLowerCase();
  if (isBookingChannel(args.channel) || moduleType.includes("booking")) {
    body = sanitizeForBookingChannel(body);
  }
  const result = await sendGuestyConversationMessage({
    conversationId: conversation?.id ?? args.conversationId,
    body,
    module,
    reservation: conversation?.reservation ?? null,
    channelHint: args.channel ?? null,
    logPrefix: "auto-reply-send",
    verifyDeadlineMs: args.verifyDeadlineMs,
  });
  return {
    verified: result.verified,
    pending: result.pending === true,
    deliveredVia: result.deliveredVia,
    deliveryModuleType: result.deliveryModuleType,
    reason: result.reason,
  };
}

// --- Context gathering (Claude tool-use) ---------------------------------

const TOOLS = [
  {
    name: "get_listing_details",
    description: "Fetch property/listing details (title, bedrooms, amenities, address, check-in instructions) from Guesty for the given listingId. Returns aggregate totals — for per-unit bedding plans / layout / property type, ALSO call get_local_property_facts.",
    input_schema: {
      type: "object",
      properties: { listingId: { type: "string", description: "Guesty listing _id" } },
      required: ["listingId"],
    },
  },
  {
    name: "get_local_property_facts",
    description: "Fetch the rich per-unit layout for this listing — bed types in each bedroom, square footage, sleeps count, full layout description, property type (Townhouse / Condominium / etc., load-bearing for accessibility / stairs questions), and walking distance between units. ALSO returns the property's area identity (island, town, neighborhood, transit) — use this to anchor ANY local-area / recommendations / beaches / dining / getting-around answer to the correct island and town. Call this whenever the guest asks about beds, bedding, room layouts, distance between units, accessibility, ground-floor sleeping, stairs, 'how does it sleep', OR anything about the surrounding area, things to do, beaches, restaurants, getting around, or the weather.",
    input_schema: {
      type: "object",
      properties: { listingId: { type: "string", description: "Guesty listing _id" } },
      required: ["listingId"],
    },
  },
  {
    name: "get_reservation",
    description: "Fetch reservation details (dates, guests, status, channel) from Guesty for the given reservationId.",
    input_schema: {
      type: "object",
      properties: { reservationId: { type: "string" } },
      required: ["reservationId"],
    },
  },
  {
    name: "flag_for_human",
    description: "Flag this message for human review instead of auto-sending. Use if the message is ambiguous, contains a complaint, or requests something outside of normal hospitality (refunds, cancellations, damages, medical issues, legal threats).",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
] as const;

async function runTool(name: string, input: any): Promise<unknown> {
  if (name === "get_listing_details") {
    const id = input?.listingId;
    if (!id) return { error: "listingId required" };
    try {
      const listing = await guestyRequest("GET", `/listings/${id}?fields=title%20nickname%20address%20bedrooms%20bathrooms%20accommodates%20amenities%20defaultCheckInTime%20defaultCheckOutTime%20publicDescription`);
      return listing;
    } catch (err) {
      return { error: (err as Error).message };
    }
  }
  if (name === "get_local_property_facts") {
    const id = input?.listingId;
    if (!id) return { error: "listingId required" };
    try {
      const map = await storage.getGuestyPropertyMap();
      const row = map.find((m) => m.guestyListingId === id);
      if (!row) return { error: "No local property mapped to this Guesty listing", guestyListingId: id };
      const prop = getUnitBuilderByPropertyId(row.propertyId);
      if (!prop) return { error: "Local propertyId not found in unit-builder-data", propertyId: row.propertyId };
      const walk = prop.units.length >= 2 ? fallbackWalkForResort(prop.complexName) : null;
      return {
        propertyName: prop.propertyName,
        complexName: prop.complexName,
        address: prop.address,
        propertyType: prop.propertyType ?? "Condominium",
        propertyTypeNote: prop.propertyType === "Townhouse"
          ? "Multi-story attached units WITH internal stairs — relevant for accessibility / ground-floor / mobility questions."
          : prop.propertyType === "Condominium"
            ? "Single-level inside the condo with no internal stairs. This does NOT confirm ground-floor or bottom-floor access; building-level access may involve stairs or elevator depending on assigned unit/building."
            : null,
        // Per-complex floor-plan / accessibility note. Only set on
        // properties where there's meaningful variation propertyType
        // alone doesn't capture (e.g. Pili Mai). When set, this is
        // the AUTHORITATIVE source — it overrides the generic
        // propertyTypeNote above for accessibility questions.
        accessibilityNote: prop.accessibilityNote ?? null,
        totalBedrooms: prop.units.reduce((s, u) => s + u.bedrooms, 0),
        // Listing-level capacity follows the single headline occupancy rule
        // keyed on total bedrooms (same number the title/summary/dashboard
        // show), NOT the sum of per-unit maxGuests — so the guest-reply LLM
        // quotes the advertised "sleeps N", not a higher raw bed total. (The
        // per-unit `maxGuests` below stays the real per-unit bed count.)
        totalSleeps: occupancyForBedrooms(prop.units.reduce((s, u) => s + u.bedrooms, 0)),
        units: prop.units.map((u, i) => ({
          label: `Unit ${String.fromCharCode(65 + i)}`,
          unitNumber: u.unitNumber,
          bedrooms: u.bedrooms,
          bathrooms: u.bathrooms,
          sqft: u.sqft,
          maxGuests: u.maxGuests,
          shortDescription: u.shortDescription,
          longDescription: u.longDescription.length > 700
            ? u.longDescription.slice(0, 700) + "…"
            : u.longDescription,
        })),
        distanceBetweenUnits: walk ? `${walk.description} (~${walk.minutes}-min walk)` : null,
        neighborhood: prop.neighborhood ?? null,
        transit: prop.transit ?? null,
        // Area identity for anchoring local-area / recommendation answers to the
        // correct island/region (see EXPERT LOCAL KNOWLEDGE in the system prompt).
        // `town` is parsed from the address (street, town, ST zip).
        island: resolveIslandRegion(prop.address),
        town: (() => {
          const segs = String(prop.address ?? "").split(",").map((s) => s.trim()).filter(Boolean);
          return segs.length >= 2 ? segs[segs.length - 2].replace(/\s+[A-Z]{2}\s+\d{5}.*$/, "").trim() : (segs[0] ?? null);
        })(),
        areaIdentity: [prop.complexName, resolveIslandRegion(prop.address)].filter(Boolean).join(", "),
      };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }
  if (name === "get_reservation") {
    const id = input?.reservationId;
    if (!id) return { error: "reservationId required" };
    try {
      const r = await guestyRequest("GET", `/reservations/${id}?fields=_id%20status%20checkIn%20checkOut%20guestsCount%20source%20integration%20money%20guest`);
      return r;
    } catch (err) {
      return { error: (err as Error).message };
    }
  }
  if (name === "flag_for_human") {
    return { acknowledged: true, reason: input?.reason ?? "" };
  }
  return { error: `Unknown tool: ${name}` };
}

const SYSTEM_PROMPT = `You are John Carpenter, a Reservationist at VacationRentalExpertz, a premium vacation rental management company in Hawaii.

Your job: read a guest's incoming message and write a decisive, warm, concise reply in the voice of an expert host who knows this property inside and out and wants the guest to book with confidence.

AUTO-SEND MODE — READ THIS FIRST:
Your clean, in-scope replies are SENT TO THE GUEST AUTOMATICALLY. No human reviews them first. A human ONLY sees the messages you flag. That changes the bar:
- If you are NOT fully confident the reply is correct and complete from the facts you actually fetched, call flag_for_human (reason: the exact thing you are unsure about) instead of sending a guess. A message a human answers a few minutes later is far better than an auto-sent wrong answer. When you are even slightly unsure, flag — do not send.
- If the guest's situation is urgent or time-critical — locked out, no power/water/AC, a leak or flood, anyone hurt or unwell, an emergency, or an arrival/access problem happening right now — call flag_for_human immediately. Do not try to resolve an emergency yourself.
- Everything in the WHEN TO FLAG list below still flags. Flagging is the safe default; sending is only for messages you can answer correctly, completely, and within scope.

RULES:

INFORMATION GATHERING
- Always use the tools available to fetch listing details or reservation details BEFORE answering questions about the property, dates, or amenities. Never guess facts.
- For per-unit bedding plans, layouts, bed types (King / Queen / Twin / sleeper sofa), bathroom counts per unit, square footage, distance between units, property type (Townhouse vs Condominium — relevant for stairs/accessibility), and ground-floor questions, ALWAYS call get_local_property_facts. The Guesty listing alone (get_listing_details) only has aggregate totals — it does NOT have per-unit bedding.
- When a guest asks multiple specific questions in one message (e.g. bedding + distance + accessibility + check-in time), call get_local_property_facts and answer EVERY one of them. Do not flag for human just because the message is long — flag only when something falls outside the data we fetched OR the FLAG categories below.
- If a question about THE PROPERTY ITSELF (beds, layout, bathrooms, amenities, square footage, policies, dates, prices) cannot be answered confidently from the fetched context, call flag_for_human with a reason and stop. "Confidently" means that specific PROPERTY fact is in the data we fetched — not a guess. (Questions about the surrounding AREA — beaches, dining, activities, getting around, weather — are different: you may answer those from your own local knowledge under the EXPERT LOCAL KNOWLEDGE guardrails below.)

DO NOT ASK FOR FACTS THE GUEST OR THE BOOKING ALREADY SUPPLIED:
- Inquiries / requests / bookings carry the dates and guest count on the reservation. Call get_reservation to read them — never ask the guest "what dates are you thinking?" or "how many guests?" when the reservation already answers it.
- Read the guest's message carefully and count what they told you. "2 families of 6 and 2 seniors" = 14 guests; you don't need to ask the total. "We arrive Friday and leave Tuesday" = 4 nights; don't re-ask.
- If you DO need a clarifying detail (exact arrival time, a specific accessibility requirement, a dietary thing) ask for that one specific thing — don't blanket re-ask the dates and guest count along with it.

WHEN TO FLAG FOR HUMAN (call flag_for_human tool, do NOT write a reply):
- Money: refund, discount, comp, credit, deposit, chargeback, dispute. Anything touching the guest's wallet.
- Schedule changes: early check-in, late check-out, extension, extra night, date swap, cancellation.
- Policy exceptions: pets/animals, smoking/vaping, parties/events/weddings, extra/additional guests beyond the listed cap.
- Property condition / damage / complaints: damage, broken, leak, mold, pests, "dirty", "unsanitary", anything implying a defect or bad experience.
- Health / safety / emergency / legal: medical issues, allergies, injury, "emergency", police/fire/911, lawyers, lawsuits, accessibility (ADA, wheelchair, service animal).
- Press / media: journalist, reporter, interview requests.
- Reviews & ratings: any post-stay message about a review, rating, or feedback.
- Operational issues: lockouts, no power/water/wifi, broken AC, neighbor complaints, weather emergencies.
- Anything you'd send to a manager if you were on shift.

WHAT YOU MAY NEVER COMMIT TO IN A REPLY (even if the guest asks nicely):
- Refunds, discounts, upgrades, free nights, comps, credits — flag for human instead.
- Pet, smoking, party, or extra-guest exceptions — flag for human instead.
- Specific early check-in or late check-out times — listing has the standard times, anything else is a human decision.
- Stay extensions or date changes — flag for human.
- Sharing access codes (lockbox, gate, door) in chat — those go through Guesty's automated arrival flow.
- Quoting prices for new dates or upgrades — flag.
- Apologizing for or explaining external conditions (weather, traffic, airport delays) — flag.
- Statements about other businesses, competitors, or other listings.
- Anything that costs money, changes the booking, or grants an exception.

WHAT YOU MAY ANSWER ON YOUR OWN
- Already-confirmed facts about the property pulled via tools (bedrooms, bathrooms, amenities, location, parking, AC, WiFi presence, pool, BBQ, etc.).
- Area orientation and recommendations for THIS property's specific community, town, and island — beaches, dining, activities/things to do, getting around, seasonal/weather — as a knowledgeable local host, under the EXPERT LOCAL KNOWLEDGE guardrails below.
- Travel logistics (airport proximity, getting around, parking) — quote the fetched neighborhood/transit facts when they cover it, otherwise give hedged general guidance under those same guardrails.
- Reassurance and warm acknowledgment of the question.

EXPERT LOCAL KNOWLEDGE (area orientation — beaches, dining, activities, getting around, weather):
You are a longtime local host. You MAY answer general "what's the area like / what should we do / where should we eat / how do we get around / what's the weather like" questions from your own knowledge of the SPECIFIC place this property is in. This is the ONE place you may go beyond the fetched facts — but ONLY for area orientation, and ONLY under these guardrails:
- ANCHOR every area answer to this property's exact community, town, and island. First call get_local_property_facts and read island, town/address, neighborhood, and transit. Speak only to THAT island and town — never another island, never a generic "Hawaii". If you can't tie an answer to this specific area, say you can only speak to this area and offer what you do know here.
- Prefer the fetched neighborhood / transit facts over your own memory whenever they cover the question — quote those.
- NEVER state exact prices, exact hours, "open now / today / this week", phone numbers, or a business's street address. You do not have current data for any of those.
- NEVER give a precise distance or drive time you can't be sure of. Hedge: "a short drive", "about 10-15 minutes", "a local favorite", "worth a look".
- For anything time-sensitive — hours, seasonal closures, reservations, surf/ocean/weather conditions, tour availability — tell the guest to check the current details directly before relying on it.
- When you're not certain a specific place exists or is still operating, describe the TYPE of thing ("there are a few well-regarded poke spots in town") rather than naming a business you're unsure about.
- This is orientation and suggestion only. Never commit us to anything ("we'll arrange", "we'll book it", "we can get you a discount"). It never overrides the FLAG categories above — a complaint about a local business, or a medical/transport emergency, still flags.

EXPERT JUDGMENT (what separates a real reservationist from a chatbot):
- Read the question behind the question. Infer trip type and who's traveling from what they wrote — family with young kids, a couple's getaway, a reunion, a multi-generational group — and answer the real concern, not just the literal words. "How far apart are the units?" usually means "can we stay together easily?" — so answer the distance AND whether it's easy to move between them. A long stay with kids who asks about the kitchen is really asking "can we cook and eat as a family here?"
- Be decisive and confident. You know this property; state the facts plainly: "The master has a King, the second bedroom has two Queens." Don't soften facts you have with "typically", "usually", "appears to", or "should be". Hedge ONLY where honesty requires it — when the specific unit is assigned later, or a detail isn't in the facts you fetched.
- Set expectations honestly so the guest books without surprises. If the units can't be side-by-side, say so up front before they picture being next door. If a detail depends on which unit is assigned, say plainly what's confirmed now versus what the operator finalizes later — don't promise the assignment. Honest expectations build more trust than an over-promise, and prevent check-in disappointment.
- Offer at MOST ONE genuinely relevant anticipatory detail tied to the guest's stated need — one useful thing they'll need but didn't ask. Beach trip → beach gear if it's in the facts. Long stay → in-unit laundry if present. Family with kids → the relevant bedding for that unit. This is NOT listing amenities; it's one thing that saves them a follow-up question. Skip it entirely if nothing in the facts fits their need.
- Calibrate warmth to the guest's tone. A brisk, all-business inquiry gets a warm but efficient answer; a guest who shares a personal reason (anniversary, milestone, a gift for family) gets ONE specific, genuine line tied to what they told you — never generic praise, never a filler closer.

VOICE (sound like an expert host who just read the message, not a chatbot):
- Lead with the answer. No warm-up phrases like "I hope this finds you well", "I'd be happy to help", "What a great question!". Guests want their answer.
- Use contractions: we're, you'll, that's, here's, don't.
- Vary sentence length. Short sentences for emphasis; longer ones with a comma or two when there's flow.
- Skip restating what the guest asked.
- Avoid AI-stock phrases: "absolutely!", "certainly!", "kindly", "rest assured", "please be advised", "in regards to", "going forward", "at your earliest convenience".
- Avoid internal operations language in guest replies: "flag this with our team", "request this with our team", "when we confirm your reservation", "we'll escalate internally". If a next step is truly needed, say it plainly as "I can add a note to the reservation."
- For "are the units next to each other / adjacent / side-by-side?" questions, answer yes/no in the first sentence. Then give the exact distance from the facts. If that is the only question, keep the body to 2-3 sentences. Don't list unit bedroom counts, kitchens, pool, hot tub, or generic resort amenities unless the guest also asked about those details.
- When the guest shares a personal reason for the trip, add at most one genuine-sounding human line. Keep it simple and specific.
- One small Hawaiian flourish is fine ("'ohana", a quick "Aloha [Name]," opener) — at most one or two per reply, never forced. If the guest already said "family", usually keep saying "family" instead of swapping in Hawaiian vocabulary.
- Don't end with a sales-y closer ("Looking forward to hosting you!"). The signature closes the message. Confidence and a clear answer carry the close, not a parting line.

Examples (same content — chatbot vs. expert):
  CHATBOT: "Thank you so much for your message! I'd be delighted to help. Regarding parking, I can confirm that yes, parking is available for both units at no additional cost."
  EXPERT:  "Yes — parking is included for both units, right next to the building."

  CHATBOT: "What a wonderful question! Our two units are situated approximately 3 minutes by foot from each other within the resort grounds."
  EXPERT:  "The two units are about a 3-minute walk apart, easy to move between."

  CHATBOT: "The two units are about a 3-minute walk apart within Pili Mai, so they're close but not directly adjacent. If proximity is important for your group, let me know and I can flag this with our team to see if we can request units in the same building cluster when we confirm your reservation. What a thoughtful Christmas gift for the family."
  EXPERT:  "They won't be directly next door to each other, but the two units are about a 3-minute walk apart within Pili Mai, easy to move between. That sounds like a really sweet Christmas gift for your family."

  CHATBOT: "Yes, we'd love to have you! There are many amenities available for your stay. Feel free to reach out with any other questions."
  EXPERT:  "Both units have in-unit washers and dryers, so laundry won't be a hassle on a three-week stay."

FORMATTING
- Plain text only. No Markdown — no asterisks, no underscores, no bullet markers at line starts, no headings.
- Length: 2-4 sentences for one or two simple questions. 6-9 sentences when the guest asks multiple specific things (bedding + distance + accessibility + dates) — answer EACH question they wrote, in order; don't compress 4 questions into a 4-sentence reply that punts on half of them.
- Quote concrete details (bed types, bathroom counts, exact distances, property type) from the fetched facts — don't paraphrase as "comfortable beds" or "a short walk" if the data spells it out.
- POLITE BUT TO THE POINT. No conversational fluff. Specifically:
  - One-line greeting ("Aloha [Name],") — do NOT add "Thanks for reaching out!", "We're excited to host you", "We're thrilled to have you", or any opener that delays the answer.
  - Do NOT restate the booking dates or guest count. The guest sent the inquiry; they know their own dates and party.
  - Do NOT add filler ("plenty of space", "perfect for your group", "a great fit", "spacious", "beautiful").
  - Do NOT use transitions like "Here's what you're working with:", "Let me break this down:", "Here's the rundown:". Just answer.
  - Do NOT use internal process wording like "flag this with our team", "request this with our team", "escalate internally", or "when we confirm your reservation." The guest should hear the answer, not the back-office workflow.
  - Do NOT end with "If you have any specific questions…", "Is there anything else…", "Feel free to reach out", "Don't hesitate to ask", "Looking forward to hosting you". Stop after the last answer.
- No subject line, no email headers.
- Sign off EXACTLY as three lines, on their own, after a blank line:
  Mahalo,
  John Carpenter
  VacationRentalExpertz
- Never mention that units are "combined" or that this is a portfolio listing. Refer to the listing as a single property with multiple units.
- Never share guest personal information or internal operational notes.

When you have everything you need and the message is in scope, write ONLY the reply body (ending with the sign-off block above) as your final response — no preamble, no explanation. When in doubt, flag for human.`;

// Canonical sign-off appended to every auto-reply.
const SIGNOFF = "Mahalo,\nJohn Carpenter\nVacationRentalExpertz";

/**
 * Guarantees every reply ends with the fixed sign-off. If the model already
 * included it (exact or case-variant), leave it alone. Otherwise append it.
 * Also strips common alternative sign-offs the model sometimes writes.
 */
function ensureSignoff(text: string): string {
  let body = text.trim();

  // Strip any generic sign-offs the model may have added by habit.
  const stripPatterns = [
    /\n\s*(best|warm regards|regards|thanks|sincerely|cheers|aloha|mahalo)[,!.]?\s*\n?\s*(the\s+\w+\s+team|nex\s*stay[^\n]*|magical\s+island[^\n]*|vacation\s*rental\s*expertz[^\n]*)?\s*$/i,
    /\n\s*the\s+\w+\s+team\s*$/i,
  ];
  for (const re of stripPatterns) body = body.replace(re, "").trim();

  // If the canonical sign-off is already present (case-insensitive), leave it.
  // Match name → brand SEPARATOR-TOLERANTLY: any run of up to ~60 chars between
  // them so a one-line "John Carpenter, VacationRentalExpertz", a comma/extra
  // whitespace, or an intervening "Reservationist" / old-brand line does NOT slip
  // past and cause a SECOND sign-off block to be appended. Both the exact name and
  // the exact brand within 60 chars of each other effectively only occur in a
  // sign-off, so this won't false-match unrelated prose.
  const hasSignoff = /john\s+carpenter\b[\s\S]{0,60}?vacation\s*rental\s*expertz/i.test(body);
  if (hasSignoff) return body;

  return `${body}\n\n${SIGNOFF}`;
}

interface DraftResult {
  draft: string | null;
  flagReason: string | null;
  toolsUsed: { name: string; input: unknown }[];
  error: string | null;
}

async function draftReplyWithClaude(params: {
  guestMessage: string;
  guestName?: string;
  listingId?: string;
  reservationId?: string;
  channel?: string;
  isInitialContact?: boolean;
  forceDraftForReview?: boolean;
}): Promise<DraftResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return { draft: null, flagReason: null, toolsUsed: [], error: "ANTHROPIC_API_KEY not set" };
  }

  // Detect accessibility / floor-plan / mobility concerns. Same rule
  // and pattern as the manual AI Draft endpoint — promote these from
  // "should address" to "MUST address" since the system prompt's
  // softer guidance gets ignored when the question is buried in a
  // multi-part guest message.
  const ACCESSIBILITY_CUES = /\b(downstair|down\s*stair|ground\s*floor|first\s*floor|main\s*floor|stairs?\b|stair[-\s]?free|elevator|wheelchair|mobility|accessib|senior|elderly|grand(?:parent|ma|pa|mother|father)|cane|walker|knee|hip|surgery|disabilit|step[-\s]?free|single[-\s]?level|one[-\s]?(?:floor|level))\b/i;
  const PROXIMITY_CUES = /\b(next to each other|next door|adjacent|side[-\s]?by[-\s]?side|close together|near each other|close to each other|same building|same cluster|together|how far|walk apart|distance between)\b/i;
  const NON_PROXIMITY_DETAIL_CUES = /\b(bed(?:room)?s?|bath(?:room)?s?|sleeps?|kitchen|pool|hot tub|amenit(?:y|ies)|parking|stairs?|floor|level|elevator|wheelchair|mobility|senior|elderly|check[-\s]?in|check[-\s]?out|discount|refund|price|rate|pet|wifi|wi[-\s]?fi|air conditioning|ac\b)\b/i;
  const proximityOnlyRaised =
    PROXIMITY_CUES.test(params.guestMessage) &&
    !NON_PROXIMITY_DETAIL_CUES.test(params.guestMessage.replace(PROXIMITY_CUES, " "));
  const accessibilityMandate = ACCESSIBILITY_CUES.test(params.guestMessage)
    ? `\n\nACCESSIBILITY / FLOOR-PLAN ASK DETECTED — MANDATORY:
The guest raised an accessibility, ground-floor, stairs, mobility, or seniors concern. You MUST address it explicitly. Call get_local_property_facts and use this priority:

1. If the response has an \`accessibilityNote\` field set, paraphrase it accurately. That note is AUTHORITATIVE — it captures complex-specific variation (e.g. mix of single-level and multi-level units) the propertyType alone doesn't.

   COMMITMENT — when the accessibilityNote says we WILL accommodate by assigning a specific unit type (single-level / ground-floor / Moana plan / etc.), state the commitment FIRMLY: "We'll ensure the unit needed for accessibility is [unit-type the note names]" — NOT softer hedges like "we'll prioritize", "we'll try", "we'll request if available", "after you book", "once your booking is confirmed", or "we'll do our best." The operator already authorized the commitment in the note — pass it through as a firm guarantee. Never ask the guest to book first before we solve the accessibility need.

   TRANSITION TONE — open the accessibility paragraph with a warm, conversational acknowledgment, NOT a clinical or commanding one. If the note authorizes a guarantee, a "here's the good news" framing is fine. If the note says the assigned unit must be confirmed first, be honest and calm: "The condos are single-level inside, but I don't want to promise ground-floor access until we confirm the assigned units."

2. Otherwise fall back to propertyType:
   - Townhouse → tell the guest the units are multi-story townhomes with internal stairs. If you don't know which floor the masters are on, say so honestly ("we'd confirm the assigned unit's floor plan before booking") — never guess.
   - Condominium → say the condo itself is single-level with no internal stairs, but that does NOT confirm ground-floor / bottom-floor access. If the guest needs bottom-floor or step-free access, say the assigned unit/building access must be confirmed before booking.
   - Other / unknown → say "we'd confirm the specific unit's floor plan before booking."

Do not skip this question. Do not roll it into a generic "let me know if you have questions" closer.`
    : "";

  const styleGuidance = await getAutoReplyStyleGuidance();
  const userPrompt = `Guest name: ${params.guestName ?? "Guest"}
Channel: ${params.channel ?? "unknown"}
${params.listingId ? `Listing ID: ${params.listingId}` : ""}
${params.reservationId ? `Reservation ID: ${params.reservationId}` : ""}

Guest message:
"""
${params.guestMessage}
"""
${accessibilityMandate}
${styleGuidance}

Use tools to gather any needed context, then reply. Return only the guest-facing reply text.
${params.forceDraftForReview
    ? "If the message is risky, ambiguous, urgent, out of scope, or you are not fully confident the answer is correct and complete, call flag_for_human with the reason — the message will then WAIT for a human and will NOT be auto-sent. After flagging, still write the safest useful conservative guest-facing draft (no refunds, discounts, exceptions, policy changes, access codes, or facts not in the fetched context) so the human has a starting point, unless no guest-facing response is possible."
    : "If unsafe or ambiguous, call flag_for_human and stop."}`;

  const messages: any[] = [{ role: "user", content: userPrompt }];
  const toolsUsed: { name: string; input: unknown }[] = [];
  let toolFlagReason: string | null = null;
  const MAX_TURNS = 5;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        // Haiku 4.5 — current model with reliable tool-use. Same swap
        // as PR #97 (AI Draft) and PR #98 (community research): the
        // legacy `claude-3-5-sonnet-20241022` alias was returning
        // errors, which is why every auto-reply tick before this fix
        // came back as `error` status — none ever auto-sent. Haiku
        // 4.5 handles the 3-tool flow (get_listing_details,
        // get_reservation, flag_for_human) inside the 5-turn cap.
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return { draft: null, flagReason: null, toolsUsed, error: `Claude API ${resp.status}: ${errText.slice(0, 200)}` };
    }

    const data = await resp.json() as any;
    const content: any[] = data?.content ?? [];
    const stopReason: string = data?.stop_reason ?? "";

    // Append assistant message
    messages.push({ role: "assistant", content });

    if (stopReason === "tool_use") {
      const toolResults: any[] = [];
      for (const block of content) {
        if (block.type === "tool_use") {
          toolsUsed.push({ name: block.name, input: block.input });
          if (block.name === "flag_for_human") {
            const reason = (block.input as any)?.reason ?? "flagged by assistant";
            if (!params.forceDraftForReview) {
              return { draft: null, flagReason: reason, toolsUsed, error: null };
            }
            toolFlagReason = reason;
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify({
                acknowledged: true,
                reason,
                instruction: "This draft will require human approval. Write a safe guest-facing draft now. Do not promise refunds, discounts, exceptions, policy changes, access codes, or facts not present in the fetched context.",
              }),
            });
            continue;
          }
          const result = await runTool(block.name, block.input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result).slice(0, 8000),
          });
        }
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // Final response — extract text
    const text = content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (!text) {
      return { draft: null, flagReason: null, toolsUsed, error: "Claude returned empty response" };
    }
    // Humanize the model's text — strip em-dashes, "I'm thrilled to
    // help" warm-ups, "Is there anything specific before you book?"
    // closers, etc. — BEFORE attaching the sign-off so the signature
    // doesn't get touched. ensureSignoff then guarantees the fixed
    // Mahalo / John Carpenter / VacationRentalExpertz block.
    const baseHumanized = humanizeReply(text);
    const trimmedHumanized = proximityOnlyRaised ? trimProximityOnlyReply(baseHumanized) : baseHumanized;
    const withPersonalTouch = addGuestPersonalTouch(trimmedHumanized, params.guestMessage);
    const withInitialCloser = addInitialContactCloser(withPersonalTouch, !!params.isInitialContact);
    const finalDraft = ensureSignoff(withInitialCloser);
    return { draft: finalDraft, flagReason: toolFlagReason, toolsUsed, error: null };
  }

  return { draft: null, flagReason: null, toolsUsed, error: "Exceeded max tool-use turns" };
}

export async function generateAutoReplyDraft(params: {
  guestMessage: string;
  guestName?: string;
  listingId?: string;
  reservationId?: string;
  channel?: string;
  isInitialContact?: boolean;
}): Promise<DraftResult> {
  return draftReplyWithClaude(params);
}

// --- Main loop ------------------------------------------------------------

export async function runAutoReply(): Promise<NonNullable<typeof _lastRunResult>> {
  if (!_enabled) {
    const r = { processed: 0, sent: 0, drafted: 0, flagged: 0, queued: 0, errors: 0, message: "AI draft scheduling is paused" };
    _lastRunAt = new Date();
    _lastRunResult = r;
    return r;
  }
  if (_isRunning) {
    return _lastRunResult ?? { processed: 0, sent: 0, drafted: 0, flagged: 0, queued: 0, errors: 0, message: "AI draft scheduler is already running" };
  }

  _isRunning = true;
  console.log("[auto-reply] Polling Guesty inbox for open conversations awaiting a host reply...");
  let processed = 0, sent = 0, drafted = 0, flagged = 0, queued = 0, errors = 0;

  try {
    const open = await fetchOpenConversations(100);
    console.log(`[auto-reply] Found ${open.length} open conversation(s)`);

    for (const conv of open) {
      try {
        const thread = await fetchConversationThread(conv._id);
        // Inbox-v2 stores posts on a separate endpoint. Inline posts are only
        // a legacy fallback; the /posts endpoint is authoritative and is also
        // what the inbox UI uses.
        const fetchedPosts = await fetchConversationPosts(conv._id);
        const posts = fetchedPosts.length > 0 ? fetchedPosts : (thread?.posts ?? conv.posts ?? []);
        const latest = pickPostToReplyTo(posts);
        if (!latest || !latest._id) {
          await dismissHandledDraftsForConversation(conv._id, posts);
          continue;
        }
        const conversationalPosts = posts.filter((p) => !isSystemPost(p));
        const isInitialContact = !conversationalPosts.some(isHostPost);

        // Dedupe — skip if we've already logged this post
        const existing = await storage.getAutoReplyLogByTriggerPostId(latest._id);
        if (existing) continue;

        const guestMessage = latest.body ?? latest.text ?? latest.message ?? "";
        if (!guestMessage.trim()) continue;

        processed++;

        // Inbox-v2 conversation shape nests the guest + reservation
        // info under `meta`. Top-level `listingId` / `reservationId`
        // were on older shapes — accept either to stay forward-
        // compatible with whatever Guesty hands back.
        const meta: any = (conv as any).meta ?? {};
        const guestObj = (conv as any).guest ?? meta.guest ?? {};
        const firstReservation =
          Array.isArray(meta.reservations) && meta.reservations.length > 0
            ? meta.reservations[0]
            : (conv as any).reservation ?? null;

        const guestName = guestObj.fullName ?? guestObj.firstName ?? null;
        const listingId =
          (conv as any).listingId ??
          firstReservation?.listingId ??
          firstReservation?.listing?._id ??
          null;
        const reservationId =
          (conv as any).reservationId ??
          firstReservation?._id ??
          firstReservation?.id ??
          null;
        const moduleField = (latest as any).module ?? (conv as any).module ?? meta.lastMessage?.module ?? { type: "email" };
        const channel = moduleField?.type ?? null;

        // Pre-filter: known risky keywords → highlighted draft path.
        const safety = classifyMessage(guestMessage);

        let status: AutoReplyStatus;
        let replyDraft: string | null = null;
        let flagReason: string | null = null;
        let errorMessage: string | null = null;
        let replySent = false;
        let sendAfter: Date | null = null;
        let toolsUsedJson: string | null = null;

        if (safety.risky) {
          // Still generate a draft for the human to review, but highlight it.
          const result = await draftReplyWithClaude({
            guestMessage, guestName: guestName ?? undefined,
            listingId: listingId ?? undefined, reservationId: reservationId ?? undefined,
            channel: channel ?? undefined,
            isInitialContact,
            forceDraftForReview: true,
          });
          replyDraft = result.draft;
          toolsUsedJson = JSON.stringify(result.toolsUsed);
          status = "flagged";
          flagReason = `Risky keywords: ${safety.matched.join(", ")}`;
          errorMessage = result.error;
          flagged++;
        } else {
          const result = await draftReplyWithClaude({
            guestMessage, guestName: guestName ?? undefined,
            listingId: listingId ?? undefined, reservationId: reservationId ?? undefined,
            channel: channel ?? undefined,
            isInitialContact,
            // FULL-AUTO: even on the clean path, force a conservative draft so a
            // model self-flag (uncertain / out-of-scope) still leaves the operator
            // a one-click reviewable draft in the inbox attention banner. A flag
            // still sets status "flagged" → held, never auto-sent (see below).
            forceDraftForReview: true,
          });
          replyDraft = result.draft;
          toolsUsedJson = JSON.stringify(result.toolsUsed);

          if (result.error) {
            status = "error";
            errorMessage = result.error;
            errors++;
          } else if (result.flagReason) {
            status = "flagged";
            flagReason = result.flagReason;
            flagged++;
          } else if (result.draft) {
            // Output-side safety filter — second line of defense even when the
            // input passed the keyword classifier and Claude didn't self-flag.
            // Looks for risky commitments in the generated reply (refund
            // language, schedule confirms, policy exceptions, leaked access
            // codes) and highlights those drafts for the approval queue.
            const outputSafety = classifyOutput(result.draft);
            if (outputSafety.risky) {
              status = "flagged";
              flagReason = `Output filter: ${outputSafety.reason}`;
              flagged++;
              console.warn(`[auto-reply] output blocked for conversation ${conv._id}: ${outputSafety.reason}`);
            } else {
              // Clean draft. Auto-send (Part B): when the master toggle is ON,
              // QUEUE it with a review-window deadline instead of holding for
              // approval — UNLESS a hard exclusion applies. The send pass
              // (runAutoSendQueue) sends due queued rows that are still
              // uncontested. When the toggle is OFF this is identical to before.
              const isAreaAsk = looksLikeAreaQuestion(guestMessage);
              const canAutoSend =
                _autoSendEnabled &&
                !!listingId &&                             // unmapped/blind → never auto-send
                !(_holdRecommendations && isAreaAsk);      // training wheels: hold area answers
              if (canAutoSend) {
                status = "queued";
                sendAfter = new Date(Date.now() + _reviewWindowSeconds * 1000);
                queued++;
              } else {
                status = "drafted";
                drafted++;
              }
            }
          } else {
            status = "error";
            errorMessage = "No draft produced";
            errors++;
          }
        }

        const logEntry: InsertAutoReplyLog = {
          conversationId: conv._id,
          triggerPostId: latest._id,
          guestName: guestName ?? null,
          listingId: listingId ?? null,
          listingNickname: null,
          reservationId: reservationId ?? null,
          channel: channel ?? null,
          guestMessage,
          replyDraft,
          replySent,
          status,
          flagReason,
          errorMessage,
          toolsUsed: toolsUsedJson,
          autoSent: false,
          sendAfter,
        };
        await storage.createAutoReplyLog(logEntry);
      } catch (err) {
        errors++;
        console.error(`[auto-reply] Error processing conversation ${conv._id}:`, (err as Error).message);
      }
    }
  } catch (err) {
    errors++;
    console.error("[auto-reply] Top-level error:", (err as Error).message);
  }

  _lastRunAt = new Date();
  _lastRunResult = {
    processed, sent, drafted, flagged, queued, errors,
    message: `Processed ${processed} — drafted ${drafted}, queued ${queued}, flagged ${flagged}, errors ${errors}`,
  };
  console.log(`[auto-reply] ${_lastRunResult.message}`);
  _isRunning = false;
  return _lastRunResult;
}

export async function redoDraftedReply(logId: number): Promise<{ ok: boolean; error?: string; status?: AutoReplyStatus }> {
  const log = await storage.getAutoReplyLog(logId);
  if (!log) return { ok: false, error: "Log not found" };
  if (!log.guestMessage?.trim()) return { ok: false, error: "No guest message to draft from" };
  if (log.replySent) return { ok: false, error: "Reply already sent" };

  const result = await draftReplyWithClaude({
    guestMessage: log.guestMessage,
    guestName: log.guestName ?? undefined,
    listingId: log.listingId ?? undefined,
    reservationId: log.reservationId ?? undefined,
    channel: log.channel ?? undefined,
    forceDraftForReview: true,
  });

  const inputSafety = classifyMessage(log.guestMessage);
  const outputSafety = result.draft ? classifyOutput(result.draft) : { risky: false, reason: null };
  let status: AutoReplyStatus = "drafted";
  let flagReason: string | null = null;
  let errorMessage: string | null = null;

  if (result.error) {
    status = "error";
    errorMessage = result.error;
  } else if (inputSafety.risky) {
    status = "flagged";
    flagReason = `Risky keywords: ${inputSafety.matched.join(", ")}`;
  } else if (result.flagReason) {
    status = "flagged";
    flagReason = result.flagReason;
  } else if (outputSafety.risky) {
    status = "flagged";
    flagReason = `Output filter: ${outputSafety.reason}`;
  } else if (!result.draft) {
    status = "error";
    errorMessage = "No draft produced";
  }

  await storage.updateAutoReplyLog(logId, {
    replyDraft: result.draft,
    replySent: false,
    status,
    flagReason,
    errorMessage,
    toolsUsed: JSON.stringify(result.toolsUsed),
  });

  return { ok: status !== "error", error: errorMessage ?? undefined, status };
}

export async function saveDraftedReply(logId: number, replyDraft: string): Promise<{ ok: boolean; error?: string }> {
  const log = await storage.getAutoReplyLog(logId);
  if (!log) return { ok: false, error: "Log not found" };
  if (log.replySent) return { ok: false, error: "Reply already sent" };
  const draft = replyDraft.trim();
  if (!draft) return { ok: false, error: "Draft cannot be blank" };

  // Editing a queued (about-to-auto-send) draft cancels the pending send and
  // returns it to the human queue. An error draft also reverts to drafted.
  const revertToDrafted = log.status === "error" || log.status === "queued";
  await storage.updateAutoReplyLog(logId, {
    replyDraft: draft,
    replySent: false,
    status: revertToDrafted ? "drafted" : log.status,
    errorMessage: null,
    ...(log.status === "queued" ? { sendAfter: null } : {}),
  });
  return { ok: true };
}

export async function analyzeAndSaveDraftedReply(logId: number, replyDraft: string): Promise<{ ok: boolean; error?: string; analysis?: string }> {
  const log = await storage.getAutoReplyLog(logId);
  if (!log) return { ok: false, error: "Log not found" };
  if (log.replySent) return { ok: false, error: "Reply already sent" };
  const draft = replyDraft.trim();
  if (!draft) return { ok: false, error: "Draft cannot be blank" };

  const analysis = await analyzeDraftEdit({
    guestMessage: log.guestMessage,
    originalDraft: log.replyDraft,
    editedDraft: draft,
  });

  await storage.updateAutoReplyLog(logId, {
    replyDraft: draft,
    replySent: false,
    status: (log.status === "error" || log.status === "queued") ? "drafted" : log.status,
    errorMessage: null,
    ...(log.status === "queued" ? { sendAfter: null } : {}),
  });
  await storage.createAutoReplyStyleExample({
    autoReplyLogId: logId,
    guestMessage: log.guestMessage,
    originalDraft: log.replyDraft ?? null,
    editedDraft: draft,
    analysis,
    listingId: log.listingId ?? null,
    channel: log.channel ?? null,
  });

  return { ok: true, analysis };
}

export async function sendDraftedReply(logId: number, replyDraft?: string): Promise<{ ok: boolean; error?: string }> {
  const log = await storage.getAutoReplyLog(logId);
  if (!log) return { ok: false, error: "Log not found" };
  if (log.replySent) return { ok: false, error: "Reply already sent" };
  const draft = (replyDraft ?? log.replyDraft ?? "").trim();
  if (!draft) return { ok: false, error: "No draft to send" };

  try {
    // Route the manual attention-banner Send through the SAME delivery-verified
    // path the auto-send engine uses (deliverGuestyReply -> sendGuestyConversationMessage):
    // resolve the proven OTA module, ASCII-sanitize Booking.com, send ONCE, and
    // confirm the channel actually accepted it via module.externalId. The old bare
    // sendReply() reported a false "sent" on a stuck-pending OTA post and skipped
    // Booking.com sanitization (AGENTS.md #51 — the false-success class).
    const delivery = await deliverGuestyReply({
      conversationId: log.conversationId,
      body: draft,
      channel: log.channel,
      reservationId: log.reservationId,
    });
    if (deliveryOutcome(delivery) === "misroute") {
      // HARD MISROUTE: Guesty filed our reply off the guest's OTA channel (e.g. on
      // email) so the guest never received it on the channel they booked with. Do
      // NOT mark the thread replied — flag it for the operator and surface the
      // error instead of a false "sent".
      await storage.updateAutoReplyLog(logId, {
        replyDraft: draft,
        status: "flagged",
        flagReason: `Reply not delivered: ${delivery.reason ?? `landed off the ${delivery.deliveredVia} guest channel`}`,
      });
      return {
        ok: false,
        error: `Not delivered on the guest's channel — ${delivery.reason ?? `filed off ${delivery.deliveredVia}`}. Verify on the channel before resending.`,
      };
    }
    // Delivered (externalId confirmed) OR posted-but-unconfirmed ("pending"): the
    // message was posted EXACTLY ONCE, so mark it sent so a re-click can't post a
    // duplicate. `pending` is logged as unconfirmed rather than a clean delivery.
    await storage.updateAutoReplyLog(logId, { replyDraft: draft, replySent: true, status: "sent", errorMessage: null });
    if (!delivery.verified) {
      console.warn(`[auto-reply] banner-send POSTED draft ${logId} but ${delivery.deliveredVia} delivery unconfirmed — not resending: ${delivery.reason ?? ""}`);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function dismissReply(logId: number): Promise<{ ok: boolean; error?: string }> {
  const log = await storage.getAutoReplyLog(logId);
  if (!log) return { ok: false, error: "Log not found" };
  await storage.updateAutoReplyLog(logId, { status: "dismissed", sendAfter: null });
  return { ok: true };
}

// Auto-send pass (Part B). Sends "queued" drafts whose review window has elapsed,
// re-validating each immediately before send so the operator (or a guest's own
// host reply) always wins. No-op when auto-send is OFF.
export async function runAutoSendQueue(): Promise<{ due: number; sent: number; intercepted: number; skipped: number; errors: number; message: string }> {
  if (!_autoSendEnabled) {
    _lastAutoSendResult = { due: 0, sent: 0, intercepted: 0, skipped: 0, errors: 0, message: "auto-send off" };
    return _lastAutoSendResult;
  }
  if (_isAutoSendRunning) {
    return _lastAutoSendResult ?? { due: 0, sent: 0, intercepted: 0, skipped: 0, errors: 0, message: "already running" };
  }
  _isAutoSendRunning = true;
  let due = 0, sent = 0, intercepted = 0, skipped = 0, errors = 0;
  try {
    const candidates = await storage.getDueQueuedAutoReplyLogs(new Date(), 100);
    due = candidates.length;
    const byConversation = new Map<string, AutoReplyLog[]>();
    for (const log of candidates) {
      const list = byConversation.get(log.conversationId) ?? [];
      list.push(log);
      byConversation.set(log.conversationId, list);
    }
    for (const [conversationId, logs] of Array.from(byConversation.entries())) {
      if (!_autoSendEnabled) { skipped += logs.length; continue; } // kill switch mid-pass
      let posts: GuestyPost[] = [];
      try { posts = await fetchConversationPosts(conversationId); } catch { posts = []; }
      for (const queuedLog of logs) {
        try {
          // Re-fetch: the operator may have edited / declined / sent it, or a
          // kill-switch may have already reverted it.
          const fresh = await storage.getAutoReplyLog(queuedLog.id);
          if (!fresh || fresh.replySent || fresh.status !== "queued") { intercepted++; continue; }
          const draft = (fresh.replyDraft ?? "").trim();
          if (!draft) { await storage.updateAutoReplyLog(fresh.id, { status: "drafted", sendAfter: null }); skipped++; continue; }
          // A human already replied after the trigger → don't send.
          if (posts.length > 0 && hasManualHostReplyAfterTrigger(fresh, posts)) {
            await storage.updateAutoReplyLog(fresh.id, { status: "dismissed", sendAfter: null });
            intercepted++;
            continue;
          }
          // Final output re-scan (catches an edited-but-still-queued draft).
          const outputSafety = classifyOutput(draft);
          if (outputSafety.risky) {
            await storage.updateAutoReplyLog(fresh.id, { status: "flagged", flagReason: `Output filter: ${outputSafety.reason}`, sendAfter: null });
            intercepted++;
            continue;
          }
          const delivery = await deliverGuestyReply({
            conversationId: fresh.conversationId,
            body: draft,
            channel: fresh.channel,
            reservationId: fresh.reservationId,
          });
          if (deliveryOutcome(delivery) === "misroute") {
            // HARD MISROUTE: Guesty filed our reply off the guest's OTA channel
            // (e.g. on email) so the guest never received it on the channel they
            // booked with. Do NOT mark the thread replied — flag it for the
            // operator instead of silently claiming a delivery.
            await storage.updateAutoReplyLog(fresh.id, {
              replyDraft: draft,
              status: "flagged",
              flagReason: `Auto-send not delivered: ${delivery.reason ?? `landed off the ${delivery.deliveredVia} guest channel`}`,
              sendAfter: null,
            });
            intercepted++;
            console.warn(`[auto-reply] auto-send MISROUTE for draft ${fresh.id} (conversation ${fresh.conversationId}): ${delivery.reason ?? ""}`);
            continue;
          }
          // Delivered (externalId confirmed) OR posted-but-unconfirmed
          // ("pending"): the message was posted EXACTLY ONCE, so mark it sent so
          // the queue never re-posts a duplicate. `pending` is logged as
          // unconfirmed rather than silently treated as a clean delivery.
          await storage.updateAutoReplyLog(fresh.id, { replyDraft: draft, replySent: true, status: "sent", autoSent: true, errorMessage: null, sendAfter: null });
          sent++;
          if (delivery.verified) {
            console.log(`[auto-reply] AUTO-SENT draft ${fresh.id} (conversation ${fresh.conversationId}, delivered via ${delivery.deliveredVia})`);
          } else {
            console.warn(`[auto-reply] AUTO-SENT draft ${fresh.id} POSTED but ${delivery.deliveredVia} delivery unconfirmed — not resending: ${delivery.reason ?? ""}`);
          }
        } catch (err) {
          errors++;
          await storage.updateAutoReplyLog(queuedLog.id, { status: "flagged", flagReason: `Auto-send failed: ${(err as Error).message}`, sendAfter: null }).catch(() => {});
          console.error(`[auto-reply] auto-send error for log ${queuedLog.id}: ${(err as Error).message}`);
        }
      }
    }
  } catch (err) {
    errors++;
    console.error(`[auto-reply] runAutoSendQueue top-level error: ${(err as Error).message}`);
  }
  _lastAutoSendAt = new Date();
  _lastAutoSendResult = {
    due, sent, intercepted, skipped, errors,
    message: `Auto-send: ${sent} sent, ${intercepted} intercepted, ${skipped} skipped, ${errors} errors (of ${due} due)`,
  };
  if (sent > 0 || intercepted > 0 || errors > 0) console.log(`[auto-reply] ${_lastAutoSendResult.message}`);
  _isAutoSendRunning = false;
  return _lastAutoSendResult;
}

export function startAutoReplyScheduler() {
  // Load the persisted auto-send config before anything sends (defaults keep it
  // OFF until this resolves, so a cold boot never auto-sends unexpectedly).
  loadAutoSendConfig().catch(() => {});

  // Run immediately on boot so the current unread/open Guesty backlog gets
  // drafts after deploy, then keep polling for new arrivals.
  runAutoReply().catch(() => {});

  // Separate send pass (honors the review window with ~20s granularity).
  setInterval(() => {
    runAutoSendQueue().catch(() => {});
  }, 20 * 1000);

  const INTERVAL_MS = 30 * 1000; // near-real-time polling without webhooks
  setInterval(() => {
    runAutoReply().catch(() => {});
  }, INTERVAL_MS);

  console.log("[auto-reply] AI draft scheduler started (every 30 seconds)");
}
