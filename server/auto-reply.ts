// Auto-Reply Agent — polls Guesty inbox for new unread guest messages,
// runs a safety classifier, gathers context (listing, reservation, amenities)
// via Claude tool-use, and auto-sends a reply when safe. Risky messages are
// saved as a draft for human review. Every attempt is persisted to autoReplyLog.

import { guestyRequest } from "./guesty-sync";
import { storage } from "./storage";
import type { InsertAutoReplyLog } from "@shared/schema";

type AutoReplyStatus = "sent" | "drafted" | "flagged" | "dismissed" | "error";

let _enabled = true;
let _lastRunAt: Date | null = null;
let _lastRunResult: { processed: number; sent: number; drafted: number; flagged: number; errors: number; message: string } | null = null;

export function getAutoReplyStatus() {
  return { enabled: _enabled, lastRunAt: _lastRunAt, lastRunResult: _lastRunResult };
}

export function setAutoReplyEnabled(enabled: boolean) {
  _enabled = enabled;
  console.log(`[auto-reply] ${enabled ? "Enabled" : "Disabled"}`);
}

// --- Safety classifier (input side) ---------------------------------------
//
// First line of defense for auto-reply: if the guest's message contains
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
  "wheelchair", "service animal",
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
];

function classifyMessage(text: string): { risky: boolean; matched: string[] } {
  const lower = text.toLowerCase();
  const matched = RISK_KEYWORDS.filter((kw) => lower.includes(kw));
  return { risky: matched.length > 0, matched };
}

// --- Safety classifier (output side) --------------------------------------
//
// Second line of defense: even when the GUEST'S message looks clean,
// scan the AI's draft before sending. If the model commits to
// something it shouldn't (refund language, schedule change, pet
// exception, etc.) we downgrade to "drafted" so the host eyeballs it
// before it goes out. Patterns are intentionally permissive — false
// positives just delay a send by one click.
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
];

function classifyOutput(text: string): { risky: boolean; reason: string | null } {
  for (const { pattern, reason } of OUTPUT_RISK_PATTERNS) {
    if (pattern.test(text)) return { risky: true, reason };
  }
  return { risky: false, reason: null };
}

// --- Guesty helpers -------------------------------------------------------

interface GuestyPost {
  _id?: string;
  body?: string;
  message?: string;
  createdAt?: string;
  module?: { type?: string };
  conversationType?: string;
  isIncoming?: boolean;
  direction?: string;
  authorType?: string;
}

interface GuestyConversation {
  _id: string;
  guest?: { fullName?: string; firstName?: string };
  listingId?: string;
  reservationId?: string;
  lastMessageAt?: string;
  lastMessageReceivedAt?: string;
  unreadCount?: number;
  module?: { type?: string };
  integration?: { platform?: string };
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

async function fetchUnreadConversations(limit = 30): Promise<GuestyConversation[]> {
  const data = await guestyRequest(
    "GET",
    `/communication/conversations?limit=${limit}&sort=-lastMessageAt`
  );
  const results = unwrapConversations(data);
  return results.filter((c) => (c.unreadCount ?? 0) > 0);
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

function pickLatestIncomingPost(posts: GuestyPost[] | undefined): GuestyPost | null {
  if (!posts || posts.length === 0) return null;
  const incoming = posts.filter((p) => {
    if (p.isIncoming === true) return true;
    if (p.direction === "incoming") return true;
    if (p.authorType && p.authorType.toLowerCase() === "guest") return true;
    return false;
  });
  if (incoming.length === 0) return null;
  // Most recent
  incoming.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return incoming[0];
}

async function sendReply(conversationId: string, body: string, moduleField: { type?: string } | undefined) {
  const mod = moduleField && moduleField.type ? moduleField : { type: "email" };
  await guestyRequest("POST", `/communication/conversations/${conversationId}/send-message`, {
    body,
    module: mod,
  });
}

// --- Context gathering (Claude tool-use) ---------------------------------

const TOOLS = [
  {
    name: "get_listing_details",
    description: "Fetch property/listing details (title, bedrooms, amenities, address, check-in instructions) from Guesty for the given listingId.",
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

const SYSTEM_PROMPT = `You are John Carpenter, a Reservationist at Magical Island Rentals, a premium vacation rental management company in Hawaii.

Your job: read a guest's incoming message and write a warm, concise, professional reply in the tone of a hospitality host. Replies you generate are AUTO-SENT to the guest unless you explicitly flag for human review — so the bar for "I'm sure" is high.

RULES:

INFORMATION GATHERING
- Always use the tools available to fetch listing details or reservation details BEFORE answering questions about the property, dates, or amenities. Never guess facts.
- If the guest's question cannot be answered confidently from the fetched context, call flag_for_human with a reason and stop. "Confidently" means the fact is in the data we fetched — not vibes or generic Hawaii knowledge.

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
- General "what's it like nearby" questions when the listing description covers it.
- Travel logistics (driving distance, airport proximity) when the listing description includes it.
- Reassurance and warm acknowledgment of the question.

VOICE (sound like a real host who just read the message, not a chatbot):
- Lead with the answer. No warm-up phrases like "I hope this finds you well", "I'd be happy to help", "What a great question!". Guests want their answer.
- Use contractions: we're, you'll, that's, here's, don't.
- Vary sentence length. Short sentences for emphasis; longer ones with a comma or two when there's flow.
- Skip restating what the guest asked.
- Avoid AI-stock phrases: "absolutely!", "certainly!", "kindly", "rest assured", "please be advised", "in regards to", "going forward", "at your earliest convenience".
- One small Hawaiian flourish is fine ("'ohana", a quick "Aloha [Name]," opener) — at most one or two per reply, never forced.
- Don't end with a sales-y closer ("Looking forward to hosting you!"). The signature closes the message.

Examples (same content, different voice):
  ROBOTIC: "Thank you so much for your message! I'd be delighted to help. Regarding parking, I can confirm that yes, parking is available for both units at no additional cost."
  HUMAN:   "Yes — parking is included for both units, right next to the building."

  ROBOTIC: "What a wonderful question! Our two units are situated approximately 3 minutes by foot from each other within the resort grounds."
  HUMAN:   "The two units are about a 3-minute walk apart, easy to move between."

FORMATTING
- Plain text only. No Markdown — no asterisks, no underscores, no bullet markers at line starts, no headings.
- Keep replies to 2-4 sentences. Longer is OK only if the guest asked multiple specific questions that each need a direct answer.
- No subject line, no email headers.
- Sign off EXACTLY as three lines, on their own, after a blank line:
  John Carpenter
  Reservationist
  Magical Island Rentals
- Never mention that units are "combined" or that this is a portfolio listing. Refer to the listing as a single property with multiple units.
- Never share guest personal information or internal operational notes.

When you have everything you need and the message is in scope, write ONLY the reply body (ending with the sign-off block above) as your final response — no preamble, no explanation. When in doubt, flag for human.`;

// Canonical sign-off appended to every auto-reply.
const SIGNOFF = "John Carpenter\nReservationist\nMagical Island Rentals";

/**
 * Guarantees every reply ends with the fixed sign-off. If the model already
 * included it (exact or case-variant), leave it alone. Otherwise append it.
 * Also strips common alternative sign-offs the model sometimes writes.
 */
function ensureSignoff(text: string): string {
  let body = text.trim();

  // Strip any generic sign-offs the model may have added by habit.
  const stripPatterns = [
    /\n\s*(best|warm regards|regards|thanks|sincerely|cheers|aloha|mahalo)[,!.]?\s*\n?\s*(the\s+\w+\s+team|nex\s*stay[^\n]*|magical\s+island[^\n]*)?\s*$/i,
    /\n\s*the\s+\w+\s+team\s*$/i,
  ];
  for (const re of stripPatterns) body = body.replace(re, "").trim();

  // If the canonical sign-off is already present (case-insensitive, any whitespace), leave it.
  const hasSignoff = /john\s+carpenter\s*[\r\n]+\s*reservationist\s*[\r\n]+\s*magical\s+island\s+rentals/i.test(body);
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
}): Promise<DraftResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return { draft: null, flagReason: null, toolsUsed: [], error: "ANTHROPIC_API_KEY not set" };
  }

  const userPrompt = `Guest name: ${params.guestName ?? "Guest"}
Channel: ${params.channel ?? "unknown"}
${params.listingId ? `Listing ID: ${params.listingId}` : ""}
${params.reservationId ? `Reservation ID: ${params.reservationId}` : ""}

Guest message:
"""
${params.guestMessage}
"""

Use tools to gather any needed context, then reply. If unsafe or ambiguous, call flag_for_human and stop.`;

  const messages: any[] = [{ role: "user", content: userPrompt }];
  const toolsUsed: { name: string; input: unknown }[] = [];
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
            return { draft: null, flagReason: reason, toolsUsed, error: null };
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
    // Safety net: ensure the fixed sign-off is present. If the model forgot it,
    // append the canonical block so every reply is signed consistently.
    const finalDraft = ensureSignoff(text);
    return { draft: finalDraft, flagReason: null, toolsUsed, error: null };
  }

  return { draft: null, flagReason: null, toolsUsed, error: "Exceeded max tool-use turns" };
}

// --- Main loop ------------------------------------------------------------

export async function runAutoReply(): Promise<NonNullable<typeof _lastRunResult>> {
  if (!_enabled) {
    const r = { processed: 0, sent: 0, drafted: 0, flagged: 0, errors: 0, message: "Auto-reply is disabled" };
    _lastRunAt = new Date();
    _lastRunResult = r;
    return r;
  }

  console.log("[auto-reply] Polling Guesty inbox for unread conversations...");
  let processed = 0, sent = 0, drafted = 0, flagged = 0, errors = 0;

  try {
    const unread = await fetchUnreadConversations(30);
    console.log(`[auto-reply] Found ${unread.length} unread conversation(s)`);

    for (const conv of unread) {
      try {
        const thread = await fetchConversationThread(conv._id);
        const posts = thread?.posts ?? conv.posts ?? [];
        const latest = pickLatestIncomingPost(posts);
        if (!latest || !latest._id) continue;

        // Dedupe — skip if we've already logged this post
        const existing = await storage.getAutoReplyLogByTriggerPostId(latest._id);
        if (existing) continue;

        const guestMessage = latest.body ?? latest.message ?? "";
        if (!guestMessage.trim()) continue;

        processed++;

        const guestName = conv.guest?.fullName ?? conv.guest?.firstName ?? null;
        const listingId = conv.listingId ?? null;
        const reservationId = conv.reservationId ?? null;
        const moduleField = latest.module ?? conv.module ?? { type: "email" };
        const channel = moduleField?.type ?? null;

        // Pre-filter: known risky keywords → draft-only path (no Claude send)
        const safety = classifyMessage(guestMessage);

        let status: AutoReplyStatus;
        let replyDraft: string | null = null;
        let flagReason: string | null = null;
        let errorMessage: string | null = null;
        let replySent = false;
        let toolsUsedJson: string | null = null;

        if (safety.risky) {
          // Still generate a draft for the human to review, but do NOT send
          const result = await draftReplyWithClaude({
            guestMessage, guestName: guestName ?? undefined,
            listingId: listingId ?? undefined, reservationId: reservationId ?? undefined,
            channel: channel ?? undefined,
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
            // Output-side safety filter — second line of defense even
            // when the input passed the keyword classifier and Claude
            // didn't self-flag. Looks for risky commitments in the
            // generated reply (refund language, schedule confirms,
            // policy exceptions, leaked access codes) and downgrades
            // to "drafted" so the host eyeballs it before it goes out.
            const outputSafety = classifyOutput(result.draft);
            if (outputSafety.risky) {
              status = "flagged";
              flagReason = `Output filter: ${outputSafety.reason}`;
              flagged++;
              console.warn(`[auto-reply] output blocked for conversation ${conv._id}: ${outputSafety.reason}`);
            } else {
              try {
                await sendReply(conv._id, result.draft, moduleField);
                status = "sent";
                replySent = true;
                sent++;
              } catch (sendErr) {
                status = "drafted";
                errorMessage = `send failed: ${(sendErr as Error).message}`;
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
    processed, sent, drafted, flagged, errors,
    message: `Processed ${processed} — sent ${sent}, drafted ${drafted}, flagged ${flagged}, errors ${errors}`,
  };
  console.log(`[auto-reply] ${_lastRunResult.message}`);
  return _lastRunResult;
}

export async function sendDraftedReply(logId: number): Promise<{ ok: boolean; error?: string }> {
  const log = await storage.getAutoReplyLog(logId);
  if (!log) return { ok: false, error: "Log not found" };
  if (log.replySent) return { ok: false, error: "Reply already sent" };
  if (!log.replyDraft) return { ok: false, error: "No draft to send" };

  try {
    await sendReply(log.conversationId, log.replyDraft, log.channel ? { type: log.channel } : undefined);
    await storage.updateAutoReplyLog(logId, { replySent: true, status: "sent" });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function dismissReply(logId: number): Promise<{ ok: boolean; error?: string }> {
  const log = await storage.getAutoReplyLog(logId);
  if (!log) return { ok: false, error: "Log not found" };
  await storage.updateAutoReplyLog(logId, { status: "dismissed" });
  return { ok: true };
}

export function startAutoReplyScheduler() {
  // First run delayed slightly so server can finish booting
  setTimeout(() => { runAutoReply().catch(() => {}); }, 30_000);

  const INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
  setInterval(() => {
    runAutoReply().catch(() => {});
  }, INTERVAL_MS);

  console.log("[auto-reply] Scheduler started (every 5 minutes)");
}
