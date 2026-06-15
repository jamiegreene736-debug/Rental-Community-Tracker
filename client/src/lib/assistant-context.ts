import { useEffect } from "react";

// Lightweight global store for "what is the operator looking at right now", read
// by the dashboard assistant dock and sent with each chat message so the agent
// acts on the current screen instead of interrogating the operator. Pages
// publish their key entity via useAssistantContext({...}); the dock merges this
// with the route + page title at send time.

export interface AssistantPageContext {
  /** Human label for the screen, e.g. "Pre-flight check (is this unit already listed?)". */
  page?: string;
  /** Free-form one-liner of what the operator is doing here. */
  description?: string;
  /** Structured facts the agent can act on (community, address, units, ids, dates…). */
  data?: Record<string, unknown>;
}

let current: AssistantPageContext | null = null;
const listeners = new Set<() => void>();

export function setAssistantContext(ctx: AssistantPageContext | null): void {
  current = ctx;
  listeners.forEach((l) => l());
}

export function getAssistantContext(): AssistantPageContext | null {
  return current;
}

export function subscribeAssistantContext(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Publish page context for the lifetime of a mounted component. Auto-clears on
 * unmount (so stale context never leaks to another page). Pass a memo-stable
 * object or guard the dependency list to avoid churn.
 */
export function useAssistantContext(ctx: AssistantPageContext | null): void {
  const key = ctx ? safeStringify(ctx) : null;
  useEffect(() => {
    setAssistantContext(ctx);
    return () => {
      // Only clear if we still own the current context.
      if (getAssistantContext() === ctx) setAssistantContext(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}
