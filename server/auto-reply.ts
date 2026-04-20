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

// --- Safety classifier ----------------------------------------------------
// Any message containing these keywords is NEVER auto-sent — only drafted.
const RISK_KEYWORDS = [
  "refund", "cancel", "cancellation", "chargeback", "dispute",
  "damage", "damaged", "broken", "leak", "flood", "mold",
  "injury", "injured", "hurt", "medical", "hospital", "allergic",
  "emergency", "police", "fire", "ambulance", "911",
  "lawyer", "legal", "attorney", "sue", "lawsuit",
  "complaint", "complain", "unsafe", "unsanitary", "dirty",
  "bug", "roach", "rat", "mouse", "bed bug", "bedbug",
  "discrimination", "racist", "harassment",
  "deposit", "security deposit",
];

function classifyMessage(text: string): { risky: boolean; matched: string[] } {
  const lower = text.toLowerCase();
  const matched = RISK_KEYWORDS.filter((kw) => lower.includes(kw));
  return { risky: matched.length > 0, matched };
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

async function fetchUnreadConversations(limit = 30): Promise<GuestyConversation[]> {
  const data = await guestyRequest(
    "GET",
    `/communication/conversations?limit=${limit}&sort=-lastMessageAt`
  ) as any;
  const results: GuestyConversation[] = data?.results ?? data?.data ?? [];
  return results.filter((c) => (c.unreadCount ?? 0) > 0);
}

async function fetchConversationThread(id: string): Promise<GuestyConversation | null> {
  try {
    const data = await guestyRequest("GET", `/communication/conversations/${id}`) as any;
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

const SYSTEM_PROMPT = `You are the Guest Messaging Assistant for NexStay, a premium vacation rental management company in Hawaii.

Your job: read a guest's incoming message and write a warm, concise, professional reply in the tone of a hospitality host.

RULES:
- Always use the tools available to fetch listing details or reservation details BEFORE answering questions about the property, dates, or amenities. Never guess facts.
- If the guest's question cannot be answered confidently from the fetched context, or if the message contains a complaint, damage claim, refund request, medical/legal/safety issue, or anything ambiguous — call the flag_for_human tool with a reason and stop.
- Never mention that units are combined. Refer to the property as a single home.
- Keep replies to 2-4 sentences. Be warm but efficient.
- Sign off as "The NexStay Team".
- Do NOT include a subject line, greeting block, or email headers.
- Do NOT promise refunds, discounts, upgrades, or anything that costs money.
- Do NOT share guest personal information, credit card info, or internal operational notes.

When you have everything you need, write ONLY the reply body as your final response — no preamble, no explanation.`;

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
        model: "claude-3-5-sonnet-20241022",
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
    return { draft: text, flagReason: null, toolsUsed, error: null };
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
