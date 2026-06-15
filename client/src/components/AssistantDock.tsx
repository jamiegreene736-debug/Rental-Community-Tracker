import { useEffect, useRef, useState } from "react";
import { MessageCircle, X, Send, Loader2, Sparkles, Check, Wrench, ShieldAlert, History, Plus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { usePortalSession } from "@/lib/auth";
import { getAssistantContext } from "@/lib/assistant-context";

// Build the page-context payload sent with each message: the current route +
// page title (always) merged with whatever the active page published. This is
// what lets Magical act on the screen the operator is looking at.
function collectPageContext(): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};
  if (typeof window !== "undefined") {
    ctx.route = window.location.pathname + window.location.search;
    if (document?.title) ctx.title = document.title;
  }
  const published = getAssistantContext();
  if (published?.page) ctx.page = published.page;
  if (published?.description) ctx.description = published.description;
  if (published?.data && Object.keys(published.data).length > 0) ctx.data = published.data;
  return ctx;
}

// Floating dashboard chat agent ("Magical"). Talks to POST /api/assistant/chat,
// which streams Server-Sent-Events over the POST response body (status / tool
// activity / final text). Ships dark unless /api/assistant/status reports
// enabled (PLATFORM_ASSISTANT_ENABLED) — see server/assistant/routes.ts.

interface ToolChip {
  name: string;
  label: string;
  done: boolean;
  ok: boolean;
}

interface ConfirmCard {
  confirmId: string;
  label: string;
  summary: string;
}

interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools: ToolChip[];
  status?: string;
  error?: string;
  streaming?: boolean;
  confirm?: ConfirmCard;
  confirmDecision?: "confirm" | "cancel";
}

const uid = () => Math.random().toString(36).slice(2);

// Shown if the nudges endpoint hasn't loaded yet.
const FALLBACK_SUGGESTIONS: { label: string; prompt: string; badge?: number }[] = [
  { label: "Revenue last 30 days", prompt: "What's my revenue over the last 30 days?" },
  { label: "Find a better combination", prompt: "Find a better combination for an upcoming booking that still needs units." },
  { label: "Find photos", prompt: "Find photos for one of my communities." },
  { label: "New guest messages", prompt: "Any new guest messages? Summarize what each guest is asking." },
];

export default function AssistantDock() {
  const { data: session } = usePortalSession();
  const { data: status } = useQuery<{ enabled: boolean; hasKey: boolean }>({
    queryKey: ["/api/assistant/status"],
    staleTime: 5 * 60 * 1000,
  });

  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const sessionIdRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Starter suggestion chips for the empty dock (proactive nudges).
  const { data: nudges } = useQuery<{ suggestions: { label: string; prompt: string; badge?: number }[] }>({
    queryKey: ["/api/assistant/nudges"],
    enabled: open && session?.role === "admin" && !!status?.enabled,
    staleTime: 60 * 1000,
  });
  // Past chat sessions (loaded when the history panel opens).
  const { data: sessionList } = useQuery<{ sessions: { id: number; title: string; lastActiveAt: string }[] }>({
    queryKey: ["/api/assistant/sessions"],
    enabled: historyOpen && session?.role === "admin" && !!status?.enabled,
    staleTime: 10 * 1000,
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, open]);

  // Only show for the admin operator, and only when the server enabled it.
  if (session?.role !== "admin" || !status?.enabled) return null;

  const patchAssistant = (id: string, patch: (m: ChatMsg) => ChatMsg) =>
    setMessages((prev) => prev.map((m) => (m.id === id ? patch(m) : m)));

  // Stream an SSE POST response into the given assistant message bubble.
  async function streamInto(url: string, body: Record<string, unknown>, botId: string) {
    setBusy(true);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!resp.ok || !resp.body) {
        const msg = resp.status === 401 ? "Your session expired — please reload." : `Request failed (${resp.status}).`;
        patchAssistant(botId, (m) => ({ ...m, status: undefined, error: msg, streaming: false }));
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          let evt: any;
          try {
            evt = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          handleEvent(botId, evt);
        }
      }
    } catch {
      patchAssistant(botId, (m) => ({ ...m, status: undefined, error: "Connection interrupted.", streaming: false }));
    } finally {
      setBusy(false);
      patchAssistant(botId, (m) => ({ ...m, streaming: false, status: undefined }));
    }
  }

  async function send(explicit?: string) {
    const text = (explicit ?? input).trim();
    if (!text || busy) return;
    setInput("");
    const userMsg: ChatMsg = { id: uid(), role: "user", text, tools: [] };
    const botId = uid();
    const botMsg: ChatMsg = { id: botId, role: "assistant", text: "", tools: [], status: "Thinking…", streaming: true };
    setMessages((prev) => [...prev, userMsg, botMsg]);
    await streamInto(
      "/api/assistant/chat",
      { sessionId: sessionIdRef.current ?? undefined, message: text, context: collectPageContext() },
      botId,
    );
  }

  function newChat() {
    if (busy) return;
    sessionIdRef.current = null;
    setMessages([]);
    setHistoryOpen(false);
    setInput("");
  }

  async function loadSession(id: number) {
    if (busy) return;
    setHistoryOpen(false);
    try {
      const resp = await fetch(`/api/assistant/sessions/${id}`, { credentials: "include" });
      if (!resp.ok) return;
      const data = (await resp.json()) as { messages?: { role: string; content: any }[] };
      const loaded: ChatMsg[] = [];
      for (const m of data.messages ?? []) {
        const c = m.content ?? {};
        const text = typeof c.text === "string" ? c.text : "";
        if (m.role === "user") {
          loaded.push({ id: uid(), role: "user", text, tools: [] });
        } else if (m.role === "assistant") {
          const tools: ToolChip[] = Array.isArray(c.toolCalls)
            ? c.toolCalls.map((t: any) => ({ name: t.name, label: t.name, done: true, ok: true }))
            : [];
          loaded.push({ id: uid(), role: "assistant", text, tools, error: c.error });
        }
        // "tool" role rows are execution audit — not rendered as bubbles.
      }
      sessionIdRef.current = id;
      setMessages(loaded);
    } catch {
      /* ignore */
    }
  }

  async function respondToConfirm(srcMsgId: string, card: ConfirmCard, decision: "confirm" | "cancel") {
    if (busy) return;
    patchAssistant(srcMsgId, (m) => ({ ...m, confirmDecision: decision }));
    const botId = uid();
    const botMsg: ChatMsg = {
      id: botId,
      role: "assistant",
      text: "",
      tools: [],
      status: decision === "confirm" ? "Running…" : undefined,
      streaming: true,
    };
    setMessages((prev) => [...prev, botMsg]);
    await streamInto(
      "/api/assistant/confirm",
      { sessionId: sessionIdRef.current ?? undefined, confirmId: card.confirmId, decision },
      botId,
    );
  }

  function handleEvent(botId: string, evt: any) {
    switch (evt?.type) {
      case "session":
        if (typeof evt.sessionId === "number") sessionIdRef.current = evt.sessionId;
        break;
      case "status":
        patchAssistant(botId, (m) => ({ ...m, status: evt.text }));
        break;
      case "tool_call":
        patchAssistant(botId, (m) => ({
          ...m,
          status: evt.label || "Working…",
          tools: [...m.tools, { name: evt.name, label: evt.label || evt.name, done: false, ok: true }],
        }));
        break;
      case "tool_result":
        patchAssistant(botId, (m) => {
          const tools = [...m.tools];
          for (let i = tools.length - 1; i >= 0; i--) {
            if (tools[i].name === evt.name && !tools[i].done) {
              tools[i] = { ...tools[i], done: true, ok: !!evt.ok };
              break;
            }
          }
          return { ...m, tools };
        });
        break;
      case "confirm":
        patchAssistant(botId, (m) => ({
          ...m,
          status: undefined,
          confirm: { confirmId: evt.confirmId, label: evt.label || "this action", summary: evt.summary || "" },
        }));
        break;
      case "text":
        patchAssistant(botId, (m) => ({ ...m, text: evt.text, status: undefined }));
        break;
      case "error":
        patchAssistant(botId, (m) => ({ ...m, error: evt.message, status: undefined, streaming: false }));
        break;
      case "done":
        patchAssistant(botId, (m) => ({ ...m, status: undefined, streaming: false }));
        break;
    }
  }

  return (
    <>
      {/* Launcher */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="fixed bottom-5 right-5 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-indigo-600 text-white shadow-lg transition hover:bg-indigo-700"
        aria-label="Open assistant"
      >
        {open ? <X className="h-6 w-6" /> : <MessageCircle className="h-6 w-6" />}
      </button>

      {open && (
        <div className="fixed bottom-24 right-5 z-50 flex h-[34rem] max-h-[80vh] w-[24rem] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
          {/* Header */}
          <div className="flex items-center gap-2 border-b border-slate-200 bg-indigo-600 px-4 py-3 text-white">
            <Sparkles className="h-5 w-5" />
            <div className="flex-1">
              <div className="text-sm font-semibold leading-tight">Magical</div>
              <div className="text-xs text-indigo-200">Ask about bookings, revenue & buy-ins</div>
            </div>
            <button type="button" onClick={() => setHistoryOpen((v) => !v)} aria-label="Chat history" title="Chat history">
              <History className="h-5 w-5" />
            </button>
            <button type="button" onClick={newChat} aria-label="New chat" title="New chat">
              <Plus className="h-5 w-5" />
            </button>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* History panel */}
          {historyOpen && (
            <div className="border-b border-slate-200 bg-white px-3 py-2">
              <div className="mb-1 text-xs font-semibold text-slate-500">Recent chats</div>
              <div className="max-h-44 space-y-0.5 overflow-y-auto">
                {(sessionList?.sessions ?? []).length === 0 && (
                  <div className="px-1 py-2 text-xs text-slate-400">No past chats yet.</div>
                )}
                {(sessionList?.sessions ?? []).map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => void loadSession(s.id)}
                    className="block w-full truncate rounded px-2 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100"
                    title={s.title}
                  >
                    {s.title}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto bg-slate-50 px-3 py-4">
            {messages.length === 0 && (
              <div className="mt-6 px-3 text-center text-sm text-slate-500">
                <p className="mb-3 font-medium text-slate-700">Hi Jamie — what can I look up?</p>
                <div className="flex flex-col gap-1.5">
                  {(nudges?.suggestions ?? FALLBACK_SUGGESTIONS).map((s, i) => (
                    <button
                      key={i}
                      type="button"
                      disabled={busy}
                      onClick={() => void send(s.prompt)}
                      className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-xs text-slate-700 transition hover:border-indigo-300 hover:bg-indigo-50 disabled:opacity-50"
                    >
                      <span>{s.label}</span>
                      {typeof s.badge === "number" && s.badge > 0 && (
                        <span className="shrink-0 rounded-full bg-amber-500 px-1.5 text-[10px] font-bold text-white">{s.badge}</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <MessageBubble key={m.id} msg={m} busy={busy} onConfirm={respondToConfirm} />
            ))}
          </div>

          {/* Composer */}
          <div className="border-t border-slate-200 bg-white p-2">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={1}
                placeholder="Ask anything…"
                className="max-h-28 flex-1 resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={busy || !input.trim()}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white transition hover:bg-indigo-700 disabled:opacity-40"
                aria-label="Send"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function MessageBubble({
  msg,
  busy,
  onConfirm,
}: {
  msg: ChatMsg;
  busy: boolean;
  onConfirm: (msgId: string, card: ConfirmCard, decision: "confirm" | "cancel") => void;
}) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-indigo-600 px-3 py-2 text-sm text-white">
          {msg.text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] space-y-2">
        {msg.tools.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {msg.tools.map((t, i) => (
              <span
                key={i}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]",
                  t.done ? (t.ok ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700") : "bg-slate-200 text-slate-600",
                )}
              >
                {t.done ? <Check className="h-3 w-3" /> : <Loader2 className="h-3 w-3 animate-spin" />}
                {t.label}
              </span>
            ))}
          </div>
        )}
        {msg.status && (
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <Loader2 className="h-3 w-3 animate-spin" />
            {msg.status}
          </div>
        )}
        {msg.text && (
          <div className="rounded-2xl rounded-bl-sm bg-white px-3 py-2 text-sm text-slate-800 shadow-sm">
            <RichText text={msg.text} />
          </div>
        )}
        {msg.confirm && (
          <div className="rounded-2xl rounded-bl-sm border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm">
            <div className="mb-1 flex items-center gap-1.5 font-semibold text-amber-800">
              <ShieldAlert className="h-4 w-4" />
              Confirm: {msg.confirm.label}
            </div>
            <p className="mb-2 text-amber-900">{msg.confirm.summary}</p>
            {msg.confirmDecision ? (
              <div className="text-xs font-medium text-amber-700">
                {msg.confirmDecision === "confirm" ? "✓ Confirmed" : "✕ Cancelled"}
              </div>
            ) : (
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onConfirm(msg.id, msg.confirm!, "confirm")}
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-40"
                >
                  Confirm
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onConfirm(msg.id, msg.confirm!, "cancel")}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}
        {msg.error && (
          <div className="flex items-start gap-1.5 rounded-2xl rounded-bl-sm bg-rose-50 px-3 py-2 text-sm text-rose-700">
            <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{msg.error}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// Minimal, dependency-free markdown-ish renderer: paragraphs, bullet lines, and
// **bold** spans. Good enough for the assistant's short answers; swap for a real
// markdown lib later if needed.
function RichText({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="space-y-1">
      {lines.map((line, i) => {
        const trimmed = line.trim();
        const bullet = /^[-*•]\s+/.test(trimmed);
        const body = bullet ? trimmed.replace(/^[-*•]\s+/, "") : line;
        return (
          <p key={i} className={cn(bullet && "pl-3", trimmed === "" && "h-2")}>
            {bullet && <span className="mr-1 text-slate-400">•</span>}
            {renderBold(body)}
          </p>
        );
      })}
    </div>
  );
}

function renderBold(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**") ? (
      <strong key={i}>{p.slice(2, -2)}</strong>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}
