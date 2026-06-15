// Confirm-before-act gate for the platform AI assistant.
//
// Write/outward tools (attach buy-in, send guest message, reprice…) must NOT
// execute when the model requests them. Instead the agent stores the pending
// action here, streams a `confirm` event to the UI, and only runs it after the
// operator clicks Confirm (POST /api/assistant/confirm). This is the safety
// spine of the assistant: every irreversible / money / guest-facing action goes
// through an explicit human yes.
//
// Pending actions live in-memory (like the other in-process job stores in this
// codebase). They're short-lived and disposable: if the server restarts before
// the operator confirms, the action is simply gone and the operator re-asks —
// nothing was executed, which is the safe failure mode.

import crypto from "crypto";

export interface PendingAction {
  id: string;
  sessionId: number;
  toolName: string;
  label: string; // human verb, e.g. "Attach combo to booking"
  summary: string; // plain-English description shown on the confirm card
  input: Record<string, unknown>;
  createdAt: number;
}

const PENDING_TTL_MS = 15 * 60 * 1000;
const pending = new Map<string, PendingAction>();

function sweep(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [id, action] of Array.from(pending.entries())) {
    if (action.createdAt < cutoff) pending.delete(id);
  }
}

export function createPendingAction(opts: {
  sessionId: number;
  toolName: string;
  label: string;
  summary: string;
  input: Record<string, unknown>;
}): PendingAction {
  sweep();
  const action: PendingAction = {
    id: crypto.randomBytes(9).toString("hex"),
    sessionId: opts.sessionId,
    toolName: opts.toolName,
    label: opts.label,
    summary: opts.summary,
    input: opts.input,
    createdAt: Date.now(),
  };
  pending.set(action.id, action);
  return action;
}

/** Consume (one-shot) a pending action — removed so it can never run twice. */
export function takePendingAction(id: string, sessionId: number): PendingAction | null {
  sweep();
  const action = pending.get(id);
  if (!action) return null;
  if (action.sessionId !== sessionId) return null; // can't confirm another session's action
  pending.delete(id);
  return action;
}
