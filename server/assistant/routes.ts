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
  return process.env.PLATFORM_ASSISTANT_ENABLED === "1" || process.env.PLATFORM_ASSISTANT_ENABLED === "true";
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
