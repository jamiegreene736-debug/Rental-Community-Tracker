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
import { appendMessage, touchSession, type AssistantMessageContent } from "./store";

// Orchestrator model: the hardest part is mapping fuzzy operator asks to the
// right tool chain and interpreting the economics, so use the most capable
// model. (Cheaper Haiku routing can be layered in later.)
const MODEL = process.env.ASSISTANT_MODEL || "claude-opus-4-8";
const MAX_TURNS = 8;
const TOOL_RESULT_CAP = 12_000; // chars of tool JSON fed back per result

export type SseSend = (event: Record<string, unknown>) => void;

function systemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You are "Magical", the AI operations assistant embedded in the Magical Island Rentals management platform. You sit in a chat box on the operator's dashboard and help Jamie (the operator) run a portfolio of vacation rentals in Hawaii and Florida.

Today's date is ${today}.

YOUR JOB
- Answer questions about the business and operations by calling the available tools to fetch REAL data. Never invent numbers, dates, guest names, or dollar figures — if you don't have a tool that can answer, say so plainly.
- Be concise and skimmable. Use short markdown: bold key numbers, bullet lists, small tables. Always format money as $ with thousands separators and show dates clearly.
- When a tool returns an object with "_error": true, tell the operator what failed in one plain sentence (don't dump the raw error) and suggest a next step.
- Chain tools when needed: e.g. use list_bookings to find a listingId + dates, then get_buy_in_estimate. Don't ask the operator for an id you can look up yourself.
- If a request is genuinely ambiguous (e.g. "the Poipu booking" when several match), ask ONE short clarifying question rather than guessing.

CURRENT CAPABILITIES (Phase 0 — read-only)
- You can READ: dashboard metrics (revenue, cancellations, channel status, minimum stays), the account-wide bookings list, operations reports, and fast buy-in profitability estimates.
- You CANNOT yet take actions — attaching buy-ins, running live VRBO/buy-in searches, finding photos, sending guest messages, or changing pricing are coming in later phases. If asked to do one of those, say it's coming soon, and offer to gather and summarize whatever read-only information is relevant right now.

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
  const tools = anthropicToolDefs();

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
          system: systemPrompt(),
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
        toolCalls.push({ name: block.name, input: block.input });
        send({ type: "tool_call", name: block.name, label: toolLabel(block.name), input: block.input });

        const output = await runAssistantTool(block.name, (block.input ?? {}) as Record<string, unknown>);
        const ok = !(output && typeof output === "object" && (output as any)._error);
        toolResults.push({ name: block.name, output: truncateForAudit(output) });
        send({ type: "tool_result", name: block.name, ok });
        void tool; // reserved: confirm-gate on tool.kind === "write" in later phase

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
