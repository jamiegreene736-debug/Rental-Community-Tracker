// The platform AI assistant agent loop.
//
// A Claude tool_use loop modeled on server/auto-reply.ts (`draftReplyWithClaude`)
// but generalized into a multi-tool orchestrator and wired to stream progress
// over SSE. Each turn: the model either calls tools (we run them over loopback
// and feed results back) or returns a final answer. Progress (thinking, each
// tool call/result, the final text) is streamed to the client as it happens.
//
// Phase 0 is read-only (see server/assistant/tools.ts). The model is told it
// cannot yet take actions; write tools + a confirm-before-act gate land later.

import { anthropicToolDefs, runAssistantTool, ASSISTANT_TOOLS_BY_NAME } from "./tools";
import { appendMessage, touchSession, buildModelHistory, type AssistantMessageContent } from "./store";
import { createPendingAction, takePendingAction } from "./confirm";
import { cacheSystem, cacheTools } from "./prompt-cache";

// Orchestrator model: the hardest part is mapping fuzzy operator asks to the
// right tool chain and interpreting the economics, so use the most capable
// model. (Cheaper Haiku routing can be layered in later.)
const MODEL = process.env.ASSISTANT_MODEL || "claude-opus-4-8";
const MAX_TURNS = 8;
const TOOL_RESULT_CAP = 12_000; // chars of tool JSON fed back per result

// Prompt caching: see server/assistant/prompt-cache.ts. These thin wrappers feed
// the live system prompt + tool defs through the pure cache helpers.
function cachedSystem(): unknown {
  return cacheSystem(systemPrompt());
}
function cachedTools(): unknown[] {
  return cacheTools(anthropicToolDefs() as Record<string, unknown>[]);
}

export type SseSend = (event: Record<string, unknown>) => void;

function systemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You are "Magical", the AI operations assistant embedded in the Magical Island Rentals management platform. You sit in a chat box on the operator's dashboard and help Jamie (the operator) run a portfolio of vacation rentals in Hawaii and Florida.

Today's date is ${today}.

YOUR JOB
- Answer questions about the business and operations by calling the available tools to fetch REAL data. Never invent numbers, dates, guest names, or dollar figures — if you don't have a tool that can answer, say so plainly.
- Be concise and skimmable. Use short markdown: bold key numbers, bullet lists, small tables. Always format money as $ with thousands separators and show dates clearly.
- When a tool returns an object with "_error": true, tell the operator what failed in one plain sentence (don't dump the raw error) and suggest a next step.
- Chain tools when needed. To work on a specific booking: list_bookings → get its listingId + dates → get_buy_in_estimate (this returns the internal propertyId + per-unit bedrooms) → then find_buy_in (single unit) or scan_city_vrbo (combo/multi-unit property). Don't ask the operator for an id you can look up yourself.
- find_buy_in and scan_city_vrbo are LIVE and SLOW (they drive the operator's browser sidecar and can take tens of seconds). Run them only when the operator actually wants a fresh search, tell them it's running, and if results are thin, surface the diagnostics/coverage rather than pretending it's empty.
- If a request is genuinely ambiguous (e.g. "the Poipu booking" when several match), ask ONE short clarifying question rather than guessing.

CURRENT CAPABILITIES (read-only)
- Operations data: dashboard metrics (revenue, cancellations, channel status, minimum stays), the account-wide bookings list, operations reports.
- Buy-ins & combinations: a fast static buy-in profitability estimate (get_buy_in_estimate), a LIVE single-unit buy-in search (find_buy_in), and a LIVE city-wide combo finder (scan_city_vrbo) that surfaces the cheapest same-community combination + alternatives ("find a better combination / a new location").
- Pricing: stored market nightly rates by property/bedroom/month (get_market_rates).
- Photos & listings: find candidate photos for a community (find_photos — "find photos for X"), check photo-change/competitor alerts (get_photo_alerts), and read the per-folder photo↔OTA match dashboard (get_photo_listing_status). Found photos are CANDIDATES the operator reviews — you don't apply them.
- Guest inbox: list recent conversations (list_guest_conversations), read a thread (get_guest_thread), and draft a reply (draft_guest_reply — does NOT send). Always draft and show the reply first.
- ACTIONS (confirm-before-act) — these NEVER run until the operator clicks Confirm; describe what you'll do and ask them to confirm, never claim it's done first:
  • start_auto_fill — search + ATTACH the cheapest profitable buy-in combo to a booking (then check_auto_fill to watch). Pass expectedRevenue (from list_bookings) so the $100 profit gate stays on.
  • send_guest_message — send a reply to a guest in a conversation (routes to their booking channel). Draft with draft_guest_reply first.
  • send_payment_receipt — send a payment/refund receipt to a guest for a reservation.
- Still NOT available (coming later): changing pricing, relocation-page creation. If asked, offer the relevant read-only info.

Keep answers grounded in tool output. When you state a figure, it should have come from a tool this turn or earlier in the conversation.`;
}

interface TurnResult {
  text: string | null;
  toolCalls: { name: string; input: unknown }[];
  toolResults: { name: string; output: unknown }[];
  error: string | null;
}

/**
 * Run one operator turn: stream progress over SSE, persist the user message and
 * the assistant's final message (with tool audit), and return the result.
 */
export async function runAssistantTurn(opts: {
  sessionId: number;
  userMessage: string;
  history: { role: "user" | "assistant"; content: string }[];
  send: SseSend;
}): Promise<TurnResult> {
  const { sessionId, userMessage, history, send } = opts;
  const key = process.env.ANTHROPIC_API_KEY;

  const toolCalls: { name: string; input: unknown }[] = [];
  const toolResults: { name: string; output: unknown }[] = [];

  if (!key) {
    const error = "ANTHROPIC_API_KEY is not configured on the server.";
    send({ type: "error", message: error });
    return { text: null, toolCalls, toolResults, error };
  }

  // Persist the operator message immediately (durable scrollback).
  await appendMessage(sessionId, "user", { text: userMessage });

  const messages: any[] = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userMessage },
  ];
  const tools = cachedTools();
  const system = cachedSystem();

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    send({ type: "status", text: turn === 0 ? "Thinking…" : "Working…" });

    let data: any;
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 2048,
          system,
          tools,
          messages,
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        const error = `Claude API ${resp.status}: ${errText.slice(0, 200)}`;
        send({ type: "error", message: "The assistant model call failed. Please try again." });
        await appendMessage(sessionId, "assistant", { error, toolCalls, toolResults });
        return { text: null, toolCalls, toolResults, error };
      }
      data = await resp.json();
    } catch (err) {
      const error = `Claude API request failed: ${(err as Error)?.message ?? err}`;
      send({ type: "error", message: "Could not reach the assistant model. Please try again." });
      await appendMessage(sessionId, "assistant", { error, toolCalls, toolResults });
      return { text: null, toolCalls, toolResults, error };
    }

    const content: any[] = data?.content ?? [];
    const stopReason: string = data?.stop_reason ?? "";
    messages.push({ role: "assistant", content });

    if (stopReason === "tool_use") {
      const resultBlocks: any[] = [];
      for (const block of content) {
        if (block.type !== "tool_use") continue;
        const tool = ASSISTANT_TOOLS_BY_NAME.get(block.name);
        const input = (block.input ?? {}) as Record<string, unknown>;
        toolCalls.push({ name: block.name, input });

        // CONFIRM-BEFORE-ACT: a write/outward tool is NEVER executed inside the
        // loop. We stage it as a pending action, stream a confirm card to the
        // UI, and hand the model a tool_result telling it the action is awaiting
        // the operator's click — so it describes (not claims) the action. The
        // real execution happens later in POST /api/assistant/confirm.
        if (tool && tool.kind === "write") {
          const label = tool.confirmLabel?.(input) ?? toolLabel(block.name);
          const summary = tool.confirmSummary?.(input) ?? `Run ${block.name}.`;
          const pending = createPendingAction({
            sessionId,
            toolName: block.name,
            label,
            summary,
            input,
          });
          send({ type: "confirm", confirmId: pending.id, name: block.name, label, summary, input });
          toolResults.push({ name: block.name, output: { _awaitingConfirmation: true, label } });
          resultBlocks.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify({
              status: "AWAITING_OPERATOR_CONFIRMATION",
              note: "This action was NOT executed. A confirm card was shown to the operator. Briefly tell them what will happen and that they must click Confirm. Do not say it is done.",
              label,
            }),
          });
          continue;
        }

        send({ type: "tool_call", name: block.name, label: toolLabel(block.name), input });
        const output = await runAssistantTool(block.name, input);
        const ok = !(output && typeof output === "object" && (output as any)._error);
        toolResults.push({ name: block.name, output: truncateForAudit(output) });
        send({ type: "tool_result", name: block.name, ok });

        resultBlocks.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(output ?? null).slice(0, TOOL_RESULT_CAP),
        });
      }
      messages.push({ role: "user", content: resultBlocks });
      continue;
    }

    // Final answer.
    const text = content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!text) {
      const error = "The assistant returned an empty response.";
      send({ type: "error", message: error });
      await appendMessage(sessionId, "assistant", { error, toolCalls, toolResults });
      return { text: null, toolCalls, toolResults, error };
    }

    send({ type: "text", text });
    await appendMessage(sessionId, "assistant", { text, toolCalls, toolResults } as AssistantMessageContent);
    await touchSession(sessionId, history.length === 0 ? deriveTitle(userMessage) : undefined);
    send({ type: "done" });
    return { text, toolCalls, toolResults, error: null };
  }

  const error = "The assistant reached its step limit before finishing. Try a more specific question.";
  send({ type: "error", message: error });
  await appendMessage(sessionId, "assistant", { error, toolCalls, toolResults });
  return { text: null, toolCalls, toolResults, error };
}

/**
 * Execute (or cancel) a previously-staged write action after the operator clicks
 * Confirm/Cancel, then stream a short summary of the outcome. Runs the tool over
 * loopback exactly like a read tool — the only difference is the explicit human
 * gate that got us here.
 */
export async function runConfirmedAction(opts: {
  sessionId: number;
  confirmId: string;
  decision: "confirm" | "cancel";
  send: SseSend;
}): Promise<void> {
  const { sessionId, confirmId, decision, send } = opts;
  const action = takePendingAction(confirmId, sessionId);

  if (!action) {
    send({ type: "error", message: "That action expired or was already handled. Please ask again." });
    send({ type: "done" });
    return;
  }

  if (decision === "cancel") {
    await appendMessage(sessionId, "user", { text: `✕ Cancelled: ${action.label}` });
    const text = `Okay — I didn't run "${action.label}". Nothing was changed.`;
    send({ type: "text", text });
    await appendMessage(sessionId, "assistant", { text });
    await touchSession(sessionId);
    send({ type: "done" });
    return;
  }

  // Confirmed → execute the write tool for real.
  await appendMessage(sessionId, "user", { text: `✓ Confirmed: ${action.label}` });
  send({ type: "tool_call", name: action.toolName, label: action.label, input: action.input });
  const output = await runAssistantTool(action.toolName, action.input);
  const ok = !(output && typeof output === "object" && (output as any)._error);
  send({ type: "tool_result", name: action.toolName, ok });
  await appendMessage(sessionId, "tool", {
    toolResults: [{ name: action.toolName, output: truncateForAudit(output) }],
  });

  // Let the model summarize the outcome for the operator.
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    const text = ok ? `Done — "${action.label}" completed.` : `"${action.label}" failed. Please check and retry.`;
    send({ type: "text", text });
    await appendMessage(sessionId, "assistant", { text });
    send({ type: "done" });
    return;
  }

  const history = await buildModelHistory(sessionId);
  const followupPrompt =
    `The operator just CONFIRMED and the action "${action.label}" (tool ${action.toolName}) was executed. ` +
    `Tool result JSON:\n${JSON.stringify(output ?? null).slice(0, TOOL_RESULT_CAP)}\n\n` +
    `Write a short, plain confirmation of the OUTCOME for the operator (what happened / what to check next). ` +
    `If the result indicates an error, say so honestly and suggest a next step. Do not call any tools.`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: cachedSystem(),
        messages: [...history.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: followupPrompt }],
      }),
    });
    const data: any = await resp.json();
    const text = (data?.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
    const final = text || (ok ? `Done — "${action.label}" completed.` : `"${action.label}" did not complete.`);
    send({ type: "text", text: final });
    await appendMessage(sessionId, "assistant", { text: final });
  } catch {
    const text = ok ? `Done — "${action.label}" completed.` : `"${action.label}" failed.`;
    send({ type: "text", text });
    await appendMessage(sessionId, "assistant", { text });
  }
  await touchSession(sessionId);
  send({ type: "done" });
}

function toolLabel(name: string): string {
  switch (name) {
    case "get_dashboard":
      return "Reading dashboard";
    case "list_bookings":
      return "Looking up bookings";
    case "get_reports":
      return "Pulling reports";
    case "get_buy_in_estimate":
      return "Estimating buy-in";
    case "find_buy_in":
      return "Searching buy-ins (live)";
    case "scan_city_vrbo":
      return "Scanning city for combos (live)";
    case "get_market_rates":
      return "Reading market rates";
    case "find_photos":
      return "Finding photos";
    case "get_photo_alerts":
      return "Checking photo alerts";
    case "get_photo_listing_status":
      return "Reading photo status";
    case "list_guest_conversations":
      return "Reading guest inbox";
    case "get_guest_thread":
      return "Reading guest thread";
    case "draft_guest_reply":
      return "Drafting reply";
    case "send_guest_message":
      return "Sending guest message";
    case "send_payment_receipt":
      return "Sending receipt";
    default:
      return name;
  }
}

function truncateForAudit(output: unknown): unknown {
  try {
    const json = JSON.stringify(output);
    if (json.length <= 4000) return output;
    return { _truncated: true, preview: json.slice(0, 4000) };
  } catch {
    return { _unserializable: true };
  }
}

function deriveTitle(firstMessage: string): string {
  const t = firstMessage.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t || "New chat";
}
