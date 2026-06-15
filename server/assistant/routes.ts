// HTTP surface for the platform AI assistant. Registered from
// server/routes.ts via registerAssistantRoutes(app), inside requireAuth.
//
//   POST /api/assistant/chat            -> SSE stream of one operator turn
//   GET  /api/assistant/sessions        -> recent chat sessions
//   GET  /api/assistant/sessions/:id    -> a session + its full message history
//
// The chat endpoint streams Server-Sent-Events over a POST response (the client
// reads the body stream with fetch — EventSource is GET-only). Event shapes are
// documented in server/assistant/agent.ts (status / tool_call / tool_result /
// text / done / error). Everything is feature-flagged off unless
// PLATFORM_ASSISTANT_ENABLED is set, so it ships dark until the operator opts in.

import type { Express, Request, Response } from "express";
import { runAssistantTurn, runConfirmedAction } from "./agent";
import { buildModelHistory, createSession, getMessages, getSession, listSessions } from "./store";
import { loopbackRequestHeaders as loopbackHeaders } from "../auth";

// Open an SSE stream on a POST response (EventSource is GET-only, so the client
// reads the body with fetch). Returns a `send` writer + a closed-flag getter.
function openSse(req: Request, res: Response): { send: (e: Record<string, unknown>) => void; isClosed: () => boolean } {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  let closed = false;
  req.on("close", () => {
    closed = true;
  });
  return {
    send: (event) => {
      if (!closed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    isClosed: () => closed,
  };
}

export function assistantEnabled(): boolean {
  // Default ON (operator asked to enable it without adding a Railway var). Two
  // ways to turn it OFF: PLATFORM_ASSISTANT_DISABLED=1, or the legacy explicit
  // PLATFORM_ASSISTANT_ENABLED=0/false. The dock still only renders for the
  // admin role, and chat requires ANTHROPIC_API_KEY (status reports `hasKey`).
  const disabled =
    process.env.PLATFORM_ASSISTANT_DISABLED === "1" ||
    process.env.PLATFORM_ASSISTANT_DISABLED === "true" ||
    process.env.PLATFORM_ASSISTANT_ENABLED === "0" ||
    process.env.PLATFORM_ASSISTANT_ENABLED === "false";
  return !disabled;
}

export function registerAssistantRoutes(app: Express): void {
  // Lightweight capability probe for the client (shows/hides the dock).
  app.get("/api/assistant/status", (_req, res) => {
    res.json({ enabled: assistantEnabled(), hasKey: !!process.env.ANTHROPIC_API_KEY });
  });

  app.get("/api/assistant/sessions", async (_req, res) => {
    if (!assistantEnabled()) return res.status(404).json({ error: "Assistant is disabled." });
    res.json({ sessions: await listSessions() });
  });

  // Proactive nudges: starter suggestion chips shown in the empty dock. A few
  // are dynamic (real attention signals from fast local sources); the rest are
  // static helpers. Always fail-soft + fast — a slow signal is simply omitted.
  app.get("/api/assistant/nudges", async (_req, res) => {
    if (!assistantEnabled()) return res.status(404).json({ error: "Assistant is disabled." });
    const suggestions: { label: string; prompt: string; badge?: number }[] = [];

    // Dynamic: unacknowledged photo alerts (local DB, but fetched over loopback
    // with a tight timeout so the dock never hangs on open).
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 2500);
      const r = await fetch(`http://127.0.0.1:${process.env.PORT || "5000"}/api/photo-listing-alerts?unacknowledged=1`, {
        headers: loopbackHeaders(),
        signal: controller.signal,
      });
      clearTimeout(t);
      if (r.ok) {
        const data = (await r.json()) as { alerts?: unknown[] };
        const n = Array.isArray(data?.alerts) ? data.alerts.length : 0;
        if (n > 0) {
          suggestions.push({
            label: `Review ${n} photo alert${n > 1 ? "s" : ""}`,
            prompt: "Show me the unacknowledged photo alerts and what changed.",
            badge: n,
          });
        }
      }
    } catch {
      /* omit on error/timeout */
    }

    suggestions.push(
      { label: "Revenue last 30 days", prompt: "What's my revenue over the last 30 days?" },
      { label: "Find a better combination", prompt: "Find a better combination for an upcoming booking that still needs units." },
      { label: "New guest messages", prompt: "Any new guest messages? Summarize what each guest is asking." },
      { label: "Find photos", prompt: "Find photos for one of my communities." },
    );

    res.json({ suggestions });
  });

  app.get("/api/assistant/sessions/:id", async (req, res) => {
    if (!assistantEnabled()) return res.status(404).json({ error: "Assistant is disabled." });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid session id." });
    const session = await getSession(id);
    if (!session) return res.status(404).json({ error: "Session not found." });
    res.json({ session, messages: await getMessages(id) });
  });

  app.post("/api/assistant/chat", async (req: Request, res: Response) => {
    if (!assistantEnabled()) return res.status(404).json({ error: "Assistant is disabled." });

    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message) return res.status(400).json({ error: "message is required." });

    const username = (res.locals.portalSession?.username as string) || "admin";

    let sessionId = Number(req.body?.sessionId);
    let history: { role: "user" | "assistant"; content: string }[] = [];
    if (Number.isFinite(sessionId) && sessionId > 0) {
      const existing = await getSession(sessionId);
      if (!existing) return res.status(404).json({ error: "Session not found." });
      history = await buildModelHistory(sessionId);
    } else {
      const created = await createSession({ createdBy: username });
      if (!created) return res.status(500).json({ error: "Could not start a chat session (database unavailable)." });
      sessionId = created.id;
    }

    const { send, isClosed } = openSse(req, res);
    send({ type: "session", sessionId });

    try {
      await runAssistantTurn({ sessionId, userMessage: message, history, send });
    } catch (err) {
      console.error("[assistant] turn failed:", (err as Error)?.message ?? err);
      send({ type: "error", message: "The assistant hit an unexpected error." });
    } finally {
      if (!isClosed()) res.end();
    }
  });

  // Confirm (or cancel) a staged write action. SSE-streamed because confirming
  // executes the action and then streams the model's outcome summary.
  app.post("/api/assistant/confirm", async (req: Request, res: Response) => {
    if (!assistantEnabled()) return res.status(404).json({ error: "Assistant is disabled." });

    const sessionId = Number(req.body?.sessionId);
    const confirmId = typeof req.body?.confirmId === "string" ? req.body.confirmId : "";
    const decision = req.body?.decision === "cancel" ? "cancel" : "confirm";
    if (!Number.isFinite(sessionId) || sessionId <= 0 || !confirmId) {
      return res.status(400).json({ error: "sessionId and confirmId are required." });
    }
    const session = await getSession(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found." });

    const { send, isClosed } = openSse(req, res);
    send({ type: "session", sessionId });
    try {
      await runConfirmedAction({ sessionId, confirmId, decision, send });
    } catch (err) {
      console.error("[assistant] confirm failed:", (err as Error)?.message ?? err);
      send({ type: "error", message: "The action hit an unexpected error." });
    } finally {
      if (!isClosed()) res.end();
    }
  });
}
