// Persistence for the platform AI assistant (dashboard chat agent).
//
// Thin Drizzle helpers over `assistant_sessions` / `assistant_messages`. Every
// helper is FAIL-SOFT: if the tables don't exist yet (fresh deploy before
// `db:push` / `ensureRuntimeSchema`) or the DB hiccups, reads return empty and
// writes return null instead of throwing — the chat must never 500 the
// dashboard. See server/schema-maintenance.ts for the boot-time CREATE TABLE.

import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  assistantMessages,
  assistantSessions,
  type AssistantMessage,
  type AssistantSession,
} from "@shared/schema";

export type AssistantRole = "user" | "assistant" | "tool";

export interface AssistantMessageContent {
  text?: string;
  // Tool calls the assistant requested this turn (audit trail).
  toolCalls?: { name: string; input: unknown }[];
  // Tool results fed back into the model (truncated copies for audit).
  toolResults?: { name: string; output: unknown }[];
  // Optional error string captured for a failed turn.
  error?: string;
}

export async function createSession(opts: { title?: string; createdBy?: string }): Promise<AssistantSession | null> {
  try {
    const [row] = await db
      .insert(assistantSessions)
      .values({
        title: opts.title?.slice(0, 200) || "New chat",
        createdBy: opts.createdBy || "admin",
      })
      .returning();
    return row ?? null;
  } catch (err) {
    console.warn("[assistant] createSession failed:", (err as Error)?.message ?? err);
    return null;
  }
}

export async function touchSession(sessionId: number, title?: string): Promise<void> {
  try {
    const patch: Record<string, unknown> = { lastActiveAt: new Date() };
    if (title) patch.title = title.slice(0, 200);
    await db.update(assistantSessions).set(patch).where(eq(assistantSessions.id, sessionId));
  } catch (err) {
    console.warn("[assistant] touchSession failed:", (err as Error)?.message ?? err);
  }
}

export async function getSession(sessionId: number): Promise<AssistantSession | null> {
  try {
    const [row] = await db.select().from(assistantSessions).where(eq(assistantSessions.id, sessionId)).limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

export async function listSessions(limit = 30): Promise<AssistantSession[]> {
  try {
    return await db
      .select()
      .from(assistantSessions)
      .orderBy(desc(assistantSessions.lastActiveAt))
      .limit(limit);
  } catch {
    return [];
  }
}

export async function appendMessage(
  sessionId: number,
  role: AssistantRole,
  content: AssistantMessageContent,
): Promise<AssistantMessage | null> {
  try {
    const [row] = await db
      .insert(assistantMessages)
      .values({ sessionId, role, content: content as unknown as Record<string, unknown> })
      .returning();
    return row ?? null;
  } catch (err) {
    console.warn("[assistant] appendMessage failed:", (err as Error)?.message ?? err);
    return null;
  }
}

export async function getMessages(sessionId: number, limit = 200): Promise<AssistantMessage[]> {
  try {
    return await db
      .select()
      .from(assistantMessages)
      .where(eq(assistantMessages.sessionId, sessionId))
      .orderBy(asc(assistantMessages.createdAt))
      .limit(limit);
  } catch {
    return [];
  }
}

/**
 * Rebuild the Anthropic `messages` array from persisted history so a session
 * resumes with full context. We replay only user text + assistant text (not the
 * raw tool_use/tool_result blocks — those are audit detail, and replaying them
 * verbatim risks tool_use/tool_result id mismatches across turns).
 */
export async function buildModelHistory(sessionId: number): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const rows = await getMessages(sessionId);
  const history: { role: "user" | "assistant"; content: string }[] = [];
  for (const row of rows) {
    const content = (row.content ?? {}) as AssistantMessageContent;
    const text = (content.text ?? "").trim();
    if (!text) continue;
    if (row.role === "user") history.push({ role: "user", content: text });
    else if (row.role === "assistant") history.push({ role: "assistant", content: text });
  }
  return history;
}

// Silence unused-import lints for helpers reserved for later phases.
void and;
