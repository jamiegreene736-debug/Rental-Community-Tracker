// Inbox "Texts" tab — third-party SMS to the Quo number that matched no Guesty
// conversation (operator ask 2026-07-20: a Canary Technologies email/text link
// must be visible so it can be forwarded to the guest; unmatched inbound rows
// were stored in quo_sms_messages but rendered NOWHERE).
//
// Two-pane layout: per-number thread list (left) + chat bubbles with clickable
// links and a reply composer (right). Read state is client-side localStorage
// (no schema change) via shared/unmatched-texts.ts.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { splitEmailBodyIntoSegments } from "@shared/email-body-format";
import {
  UNMATCHED_TEXTS_SEEN_KEY,
  parseUnmatchedSeenMap,
  unmatchedThreadIsUnread,
  type UnmatchedTextThread,
} from "@shared/unmatched-texts";
import { CalendarClock, ExternalLink, Link2, Loader2, MessageSquareText, Send, Smartphone } from "lucide-react";

type ThreadsResponse = { threads: UnmatchedTextThread[] };

function parseMediaUrls(raw: unknown): Array<{ url: string; type?: string }> {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item: any) => (typeof item === "string" ? { url: item } : item))
      .filter((item: any) => item && typeof item.url === "string" && /^https?:\/\//i.test(item.url));
  } catch {
    return [];
  }
}

function formatSmsTime(sentAt: string | Date | null | undefined): string {
  if (!sentAt) return "";
  const date = sentAt instanceof Date ? sentAt : new Date(sentAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** SMS body with every URL rendered as a clickable link (Canary links etc.). */
function SmsBodyWithLinks({ body }: { body: string }) {
  const segments = useMemo(() => splitEmailBodyIntoSegments(body), [body]);
  return (
    <span className="whitespace-pre-wrap break-words">
      {segments.map((seg, i) =>
        seg.kind === "link" ? (
          <a
            key={i}
            href={seg.href}
            target="_blank"
            rel="noreferrer"
            className="underline font-medium break-all inline-flex items-center gap-0.5"
            data-testid="link-unmatched-text-url"
          >
            {seg.value}
            <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
        ) : (
          <span key={i}>{seg.value}</span>
        ),
      )}
    </span>
  );
}

export function UnmatchedTextsTab({
  canLinkBooking,
  onSeenChanged,
}: {
  canLinkBooking: boolean;
  onSeenChanged?: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkReservationId, setLinkReservationId] = useState("");
  const [seenVersion, setSeenVersion] = useState(0);

  const { data, isLoading } = useQuery<ThreadsResponse>({
    queryKey: ["/api/inbox/unmatched-texts"],
    queryFn: async () => (await apiRequest("GET", "/api/inbox/unmatched-texts")).json(),
    refetchInterval: 60_000,
  });
  const threads = data?.threads ?? [];

  const seenMap = useMemo(
    () => parseUnmatchedSeenMap(typeof localStorage === "undefined" ? null : localStorage.getItem(UNMATCHED_TEXTS_SEEN_KEY)),
    // seenVersion re-reads after we stamp a thread seen.
    [seenVersion, threads],
  );

  const selected = threads.find((t) => t.phoneKey === selectedKey) ?? threads[0] ?? null;

  // Stamp the open thread seen whenever its newest inbound moves (or on first
  // open) so the tab badge clears itself as the operator reads.
  useEffect(() => {
    if (!selected?.newestInboundAt) return;
    const current = parseUnmatchedSeenMap(localStorage.getItem(UNMATCHED_TEXTS_SEEN_KEY));
    if (current[selected.phoneKey] === selected.newestInboundAt) return;
    current[selected.phoneKey] = selected.newestInboundAt;
    try {
      localStorage.setItem(UNMATCHED_TEXTS_SEEN_KEY, JSON.stringify(current));
    } catch {
      /* private mode — badge just stays; not worth breaking the tab */
    }
    setSeenVersion((v) => v + 1);
    onSeenChanged?.();
  }, [selected?.phoneKey, selected?.newestInboundAt, onSeenChanged]);

  // Reset the composer + link panel when switching threads.
  useEffect(() => {
    setReply("");
    setLinkOpen(false);
    setLinkReservationId("");
  }, [selected?.phoneKey]);

  const sendReply = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("No thread selected");
      const r = await apiRequest("POST", "/api/inbox/unmatched-texts/reply", {
        phone: selected.phoneKey,
        body: reply,
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.message ?? err.error ?? `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      setReply("");
      qc.invalidateQueries({ queryKey: ["/api/inbox/unmatched-texts"] });
      toast({ title: "Text sent" });
    },
    onError: (e: any) => toast({ title: "Failed to send text", description: e.message, variant: "destructive" }),
  });

  // Lazy booking list for "Link to booking" — only fetched when the panel
  // opens (the guesty-all endpoint is heavy).
  const bookingsQuery = useQuery<{ reservations?: any[] }>({
    queryKey: ["/api/bookings/guesty-all", { includePast: false, includeCanceled: false }],
    queryFn: async () => (await apiRequest("GET", "/api/bookings/guesty-all?includePast=false")).json(),
    enabled: canLinkBooking && linkOpen,
    staleTime: 120_000,
  });

  const linkBooking = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("No thread selected");
      const r = await apiRequest("POST", "/api/inbox/unmatched-texts/link", {
        phone: selected.phoneKey,
        reservationId: linkReservationId || null,
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.message ?? err.error ?? `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: (result: any) => {
      setLinkOpen(false);
      qc.invalidateQueries({ queryKey: ["/api/inbox/unmatched-texts"] });
      toast({
        title: linkReservationId ? "Thread linked to booking" : "Booking link cleared",
        description: `${result?.updated ?? 0} message${result?.updated === 1 ? "" : "s"} updated.`,
      });
    },
    onError: (e: any) => toast({ title: "Failed to link", description: e.message, variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-10 justify-center" data-testid="unmatched-texts-loading">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading texts…
      </div>
    );
  }

  if (threads.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-10 text-center" data-testid="unmatched-texts-empty">
        <Smartphone className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
        <div className="font-medium">No unmatched texts</div>
        <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
          Texts sent to your number from senders that don't match a guest conversation — verification links
          (e.g. Canary), unknown PMs, delivery notices — will show up here.
        </p>
      </div>
    );
  }

  const reservationOptions = (bookingsQuery.data?.reservations ?? []).map((r: any) => {
    const id = String(r?._id ?? r?.id ?? "");
    const guest = r?.guest?.fullName || r?.guest?.firstName || "Guest";
    const dates = [r?.checkInDateLocalized ?? r?.checkIn?.slice?.(0, 10), r?.checkOutDateLocalized ?? r?.checkOut?.slice?.(0, 10)]
      .filter(Boolean)
      .join(" → ");
    return { id, label: `${guest}${dates ? ` · ${dates}` : ""}` };
  }).filter((o: { id: string }) => o.id);

  return (
    <div className="grid gap-4 md:grid-cols-[290px,1fr]" data-testid="unmatched-texts-tab">
      {/* Thread list */}
      <div className="rounded-lg border bg-card overflow-hidden self-start">
        <div className="px-3 py-2.5 border-b bg-muted/40 flex items-center gap-2">
          <MessageSquareText className="h-4 w-4 text-sky-600" />
          <span className="text-sm font-semibold">Unmatched senders</span>
          <span className="ml-auto text-xs text-muted-foreground">{threads.length}</span>
        </div>
        <div className="max-h-[520px] overflow-y-auto divide-y">
          {threads.map((t) => {
            const last = t.messages[t.messages.length - 1];
            const unread = unmatchedThreadIsUnread(t, seenMap) && t.phoneKey !== selected?.phoneKey;
            const active = t.phoneKey === selected?.phoneKey;
            return (
              <button
                key={t.phoneKey}
                type="button"
                onClick={() => setSelectedKey(t.phoneKey)}
                className={`w-full text-left px-3 py-2.5 transition-colors hover:bg-muted/60 ${active ? "bg-sky-50 dark:bg-sky-950/30" : ""}`}
                data-testid={`row-unmatched-thread-${t.phoneKey}`}
              >
                <div className="flex items-center gap-2">
                  {unread && <span className="h-2 w-2 rounded-full bg-sky-500 shrink-0" data-testid="dot-unmatched-unread" />}
                  <span className={`text-sm truncate ${unread ? "font-semibold" : "font-medium"}`}>
                    {t.label || t.displayNumber}
                  </span>
                  <span className="ml-auto text-[10px] text-muted-foreground shrink-0">{formatSmsTime(t.newestAt)}</span>
                </div>
                {t.label && <div className="text-[11px] text-muted-foreground">{t.displayNumber}</div>}
                <div className="text-xs text-muted-foreground truncate mt-0.5">
                  {last?.direction === "outbound" ? "You: " : ""}
                  {(last?.body || "").slice(0, 90) || (parseMediaUrls(last?.mediaUrls).length ? "📎 Media" : "")}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Conversation pane */}
      {selected && (
        <div className="rounded-lg border bg-card flex flex-col min-h-[420px]">
          <div className="px-4 py-3 border-b flex flex-wrap items-center gap-2">
            <div>
              <div className="font-semibold text-sm">{selected.label || selected.displayNumber}</div>
              <div className="text-xs text-muted-foreground">
                {selected.displayNumber}
                {selected.reservationId && (
                  <span className="ml-2 inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                    <Link2 className="h-3 w-3" /> linked to booking {selected.reservationId.slice(-6)}
                  </span>
                )}
              </div>
            </div>
            {canLinkBooking && (
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                onClick={() => setLinkOpen((v) => !v)}
                data-testid="button-unmatched-link-booking"
              >
                <CalendarClock className="h-4 w-4 mr-1.5" />
                {selected.reservationId ? "Re-link booking" : "Link to booking"}
              </Button>
            )}
          </div>

          {canLinkBooking && linkOpen && (
            <div className="px-4 py-3 border-b bg-muted/30 space-y-2" data-testid="panel-unmatched-link-booking">
              <div className="text-xs text-muted-foreground">
                Attribute this number's texts to a reservation (shows on the thread; clears with the empty choice).
              </div>
              {bookingsQuery.isLoading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> Loading bookings…
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="h-9 rounded-md border bg-background px-2 text-sm min-w-[240px]"
                    value={linkReservationId}
                    onChange={(e) => setLinkReservationId(e.target.value)}
                    data-testid="select-unmatched-link-reservation"
                  >
                    <option value="">— no booking (clear link) —</option>
                    {reservationOptions.map((o: { id: string; label: string }) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <Button size="sm" onClick={() => linkBooking.mutate()} disabled={linkBooking.isPending}>
                    {linkBooking.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
                  </Button>
                </div>
              )}
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 max-h-[440px]" data-testid="unmatched-thread-messages">
            {selected.messages.map((m) => {
              const media = parseMediaUrls(m.mediaUrls);
              const outbound = m.direction === "outbound";
              return (
                <div key={m.id} className={`flex ${outbound ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm shadow-sm ${
                      outbound
                        ? "bg-sky-600 text-white rounded-br-sm"
                        : "bg-muted text-foreground rounded-bl-sm"
                    }`}
                    data-testid={`bubble-unmatched-sms-${m.id}`}
                  >
                    {m.body && <SmsBodyWithLinks body={m.body} />}
                    {media.map((att, i) => (
                      <a
                        key={i}
                        href={att.url}
                        target="_blank"
                        rel="noreferrer"
                        className="block mt-1.5 underline text-xs break-all"
                      >
                        📎 {att.type?.startsWith("image") ? "Photo" : "Attachment"} {i + 1}
                      </a>
                    ))}
                    <div className={`text-[10px] mt-1 ${outbound ? "text-sky-100/90" : "text-muted-foreground"}`}>
                      {formatSmsTime(m.sentAt)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="border-t px-4 py-3">
            <div className="flex items-end gap-2">
              <Textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder={`Text ${selected.label || selected.displayNumber}…`}
                className="min-h-[44px] max-h-40 resize-y text-sm"
                data-testid="input-unmatched-reply"
              />
              <Button
                onClick={() => sendReply.mutate()}
                disabled={sendReply.isPending || !reply.trim()}
                data-testid="button-unmatched-reply-send"
              >
                {sendReply.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
            <div className="text-[11px] text-muted-foreground mt-1.5">
              Sends from your Quo number. To pass a verification link to a guest, open the link above or copy it
              into the guest's booking-channel thread.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
