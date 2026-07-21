// Agent-portal "Shared bookings" section. The operator shares reservations
// one by one from the bookings page ("Show in agent portal"); the agent sees,
// per shared reservation, the attached units + the back-and-forth email
// thread with the property-management company, and can reply from the unit's
// alias. Since 2026-07-21 (operator: "show the agent everything as I see it,
// including the financials") the card also carries the money picture: guest
// total/paid, our payout, per-unit cost + extracted paid rate, notes, and the
// derived margin. The SHARE GATE is unchanged — unshared reservations 403.
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { ChevronDown, ChevronRight, Loader2, Mail, Send } from "lucide-react";
import { formatEmailBodyForDisplay, formatEmailTimestampForDisplay } from "@shared/email-body-format";
import type { AgentBookingFinancials, AgentSafeBuyIn } from "@shared/agent-buyin-view";
import type { AgentOpsRowView } from "@shared/agent-ops-view";
import { MessageSquare, ShieldCheck } from "lucide-react";

type AgentSharedBooking = {
  reservationId: string;
  sharedAt: string | null;
  guestName: string;
  checkIn: string | null;
  checkOut: string | null;
  status: string;
  listingName: string;
  confirmationCode: string;
  units: AgentSafeBuyIn[];
  financials?: AgentBookingFinancials | null;
  ops?: AgentOpsRowView | null;
};

type AgentBuyInEmail = {
  id: number;
  buyInId: number | null;
  direction: string;
  fromEmail: string | null;
  toEmail: string | null;
  subject: string | null;
  body: string | null;
  sentAt: string | null;
  status: string | null;
};

type AgentVendorContact = {
  id: number;
  buyInId: number;
  vendorName: string | null;
  vendorEmail: string;
};

type AgentCommunicationsResponse = {
  buyIns: AgentSafeBuyIn[];
  contacts: AgentVendorContact[];
  emails: AgentBuyInEmail[];
};

function firstEmailIn(text: string): string {
  const match = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(text);
  return match ? match[0] : "";
}

function formatMoney(value: number | null | undefined, currency?: string | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  const prefix = !currency || currency === "USD" ? "$" : `${currency} `;
  return `${prefix}${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function BookingFinancialsStrip({ financials }: { financials?: AgentBookingFinancials | null }) {
  if (!financials) return null;
  const bits: Array<{ label: string; value: string; tone?: string }> = [];
  const guestTotal = formatMoney(financials.guestTotal, financials.currency);
  const guestPaid = formatMoney(financials.guestPaid, financials.currency);
  const payout = formatMoney(financials.hostPayout, financials.currency);
  const costs = formatMoney(financials.unitCostTotal, financials.currency);
  const profit = formatMoney(financials.profit, financials.currency);
  if (guestTotal) bits.push({ label: "Guest total", value: guestTotal });
  if (guestPaid) bits.push({ label: "Guest paid", value: guestPaid });
  if (payout) bits.push({ label: "Payout", value: payout });
  if (costs) bits.push({ label: "Unit costs", value: costs });
  if (profit) {
    bits.push({
      label: "Margin",
      value: profit,
      tone: (financials.profit ?? 0) >= 0
        ? "text-emerald-700 dark:text-emerald-400"
        : "text-red-600 dark:text-red-400",
    });
  }
  if (bits.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]" data-testid="agent-booking-financials">
      {bits.map((bit) => (
        <span key={bit.label} className="text-muted-foreground">
          {bit.label}: <span className={`font-medium ${bit.tone ?? "text-foreground"}`}>{bit.value}</span>
        </span>
      ))}
    </div>
  );
}

function formatDueDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

// The ops-table columns, exactly as the operator's reservations table labels
// them (Payout / Paid to date / Payment next due / Buy-in cost / Profit).
function OpsStyleSummary({ booking }: { booking: AgentSharedBooking }) {
  const ops = booking.ops;
  if (!ops) return <BookingFinancialsStrip financials={booking.financials} />;
  const payout = formatMoney(ops.payout);
  const paidToDate = formatMoney(ops.paidToDate);
  const buyIn = formatMoney(ops.buyInCost);
  const profit = formatMoney(ops.profit);
  const nextDue = formatDueDate(ops.nextPaymentDueIso);
  const cell = "min-w-[110px]";
  const label = "text-[10px] uppercase tracking-wider text-muted-foreground";
  return (
    <div className="mt-2 flex flex-wrap items-start gap-x-6 gap-y-2" data-testid="agent-ops-summary">
      <div className={cell}>
        <div className={label}>Payout</div>
        <div className="text-sm font-semibold">{payout ?? "—"}</div>
        {ops.paidInFull && (
          <div className="text-[10px] font-medium text-emerald-700 dark:text-emerald-400">✓ Paid in full</div>
        )}
      </div>
      <div className={cell}>
        <div className={label}>Paid to date</div>
        <div className="text-sm font-semibold">{paidToDate ?? "—"}</div>
        <div className="text-[10px] text-muted-foreground">paid to date</div>
      </div>
      <div className={cell}>
        <div className={label}>Payment next due</div>
        <div className="text-sm font-semibold">{nextDue ?? (ops.paidInFull ? "Paid in full" : "—")}</div>
      </div>
      <div className={cell}>
        <div className={label}>Buy-in</div>
        <div className="text-sm font-semibold">{buyIn ?? "—"}</div>
        <div className="text-[10px] text-muted-foreground">buy-in cost</div>
      </div>
      <div className={cell}>
        <div className={label}>Profit</div>
        <div
          className={`text-sm font-semibold ${(ops.profit ?? 0) >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
          data-testid="agent-ops-profit"
        >
          {profit ?? "—"}
        </div>
        <div className="text-[10px] text-muted-foreground">profit</div>
      </div>
      <Badge className="mt-1 bg-emerald-600 text-white" data-testid="agent-ops-units-badge">
        ✓ {booking.units.length} unit{booking.units.length === 1 ? "" : "s"} attached
      </Badge>
    </div>
  );
}

// Same sky policy card the operator sees on the expanded ops row.
function AgentCancellationPolicyCard({ ops }: { ops?: AgentOpsRowView | null }) {
  const policy = ops?.cancellationPolicy;
  if (!policy) return null;
  return (
    <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-950" data-testid="agent-cancellation-policy">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-sky-700" />
          <div className="min-w-0">
            <p className="font-semibold">Cancellation policy</p>
            <p className="break-words">{policy.label}</p>
            <p className="mt-1 break-words text-[11px] leading-relaxed text-sky-900">
              <span className="font-semibold">Policy summary:</span> {policy.summary}
            </p>
            <dl className="mt-2 grid gap-1 text-[11px] leading-relaxed sm:grid-cols-[150px_1fr]">
              <dt className="font-semibold text-sky-900">Free until penalty:</dt>
              <dd className="break-words">{policy.freeCancellationUntil}</dd>
              <dt className="font-semibold text-sky-900">Penalty:</dt>
              <dd className="break-words">{policy.penalty}</dd>
            </dl>
          </div>
        </div>
        {policy.assumed && (
          <Badge variant="outline" className="w-fit border-sky-300 bg-white/70 text-[10px] text-sky-900">
            Assumed from Guesty
          </Badge>
        )}
      </div>
      {policy.source && <p className="mt-1 pl-6 text-[11px] text-sky-800">{policy.source}</p>}
    </div>
  );
}

function formatStay(value: string | null): string {
  if (!value) return "TBD";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function AgentUnitCommunications({
  reservationId,
  unit,
  contacts,
  emails,
}: {
  reservationId: string;
  unit: AgentSafeBuyIn;
  contacts: AgentVendorContact[];
  emails: AgentBuyInEmail[];
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const contact = contacts.find((row) => row.buyInId === unit.id) ?? null;
  const unitEmails = emails.filter((row) => row.buyInId === unit.id);
  const [showReply, setShowReply] = useState(false);
  const [vendorEmail, setVendorEmail] = useState(
    () => contact?.vendorEmail ?? firstEmailIn(unit.managementContact ?? ""),
  );
  const newestSubject = unitEmails[0]?.subject ?? "";
  const [subject, setSubject] = useState(() =>
    newestSubject
      ? newestSubject.toLowerCase().startsWith("re:")
        ? newestSubject
        : `Re: ${newestSubject}`
      : `Arrival details for ${unit.unitLabel || "our booked unit"}`,
  );
  const [body, setBody] = useState("");

  const send = useMutation({
    mutationFn: async () => {
      const to = vendorEmail.trim();
      if (!to) throw new Error("Add the property manager's email address first.");
      if (!subject.trim() || !body.trim()) throw new Error("Subject and message are both required.");
      const r = await apiRequest("POST", `/api/buy-ins/${unit.id}/vendor-email`, {
        reservationId,
        vendorEmail: to,
        vendorName: unit.managementCompany ?? contact?.vendorName ?? null,
        subject: subject.trim(),
        body: body.trim(),
      });
      if (!r.ok) {
        const errBody = await r.json().catch(() => ({}));
        throw new Error(errBody.message ?? errBody.error ?? `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      setBody("");
      setShowReply(false);
      queryClient.invalidateQueries({ queryKey: ["/api/bookings", reservationId, "buy-in-communications"] });
      toast({ title: "Email sent", description: "Your message is on its way to the property manager." });
    },
    onError: (e: any) => toast({ title: "Email not sent", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="rounded-md border bg-background p-3" data-testid={`agent-unit-comms-${unit.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{unit.unitLabel || "Assigned unit"}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {unit.unitAddress || "Address pending"}
            {unit.managementCompany ? ` · PM: ${unit.managementCompany}` : ""}
          </div>
          {unit.managementContact && (
            <div className="mt-0.5 break-words text-[11px] text-muted-foreground">Contact: {unit.managementContact}</div>
          )}
          {(unit.costPaid != null || unit.paidRate != null) && (
            <div className="mt-0.5 text-[11px]" data-testid={`agent-unit-financials-${unit.id}`}>
              {unit.costPaid != null && (
                <span className="font-medium">Cost paid {formatMoney(Number(unit.costPaid)) ?? unit.costPaid}</span>
              )}
              {unit.paidRate != null && (
                <span className="text-muted-foreground">
                  {unit.costPaid != null ? " · " : ""}charged {formatMoney(Number(unit.paidRate)) ?? unit.paidRate} per the PM receipt
                </span>
              )}
              {unit.bookingConfirmation && (
                <span className="text-muted-foreground"> · conf {unit.bookingConfirmation}</span>
              )}
            </div>
          )}
          {unit.notes && (
            <div className="mt-0.5 max-w-2xl break-words text-[11px] text-muted-foreground" title={unit.notes}>
              Notes: {unit.notes.length > 220 ? `${unit.notes.slice(0, 220)}…` : unit.notes}
            </div>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={() => setShowReply((v) => !v)} data-testid={`button-agent-reply-${unit.id}`}>
          <Mail className="mr-1 h-3.5 w-3.5" />
          {showReply ? "Close reply" : "Email the PM"}
        </Button>
      </div>

      {showReply && (
        <div className="mt-3 space-y-2 rounded-md border bg-muted/20 p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <Label className="text-xs" htmlFor={`agent-vendor-email-${unit.id}`}>Property manager email</Label>
              <Input
                id={`agent-vendor-email-${unit.id}`}
                value={vendorEmail}
                onChange={(e) => setVendorEmail(e.target.value)}
                placeholder="reservations@example.com"
                data-testid={`input-agent-vendor-email-${unit.id}`}
              />
            </div>
            <div>
              <Label className="text-xs" htmlFor={`agent-subject-${unit.id}`}>Subject</Label>
              <Input
                id={`agent-subject-${unit.id}`}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                data-testid={`input-agent-subject-${unit.id}`}
              />
            </div>
          </div>
          <div>
            <Label className="text-xs" htmlFor={`agent-body-${unit.id}`}>Message</Label>
            <Textarea
              id={`agent-body-${unit.id}`}
              rows={6}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Aloha, following up on the arrival details for our upcoming stay…"
              data-testid={`input-agent-body-${unit.id}`}
            />
          </div>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => send.mutate()} disabled={send.isPending} data-testid={`button-agent-send-${unit.id}`}>
              {send.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1 h-3.5 w-3.5" />}
              Send
            </Button>
          </div>
        </div>
      )}

      <div className="mt-3 space-y-2">
        {unitEmails.length === 0 && (
          <div className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
            No emails with the property manager yet.
          </div>
        )}
        {unitEmails.map((email) => (
          <div key={email.id} className="rounded-md border bg-muted/10 p-2" data-testid={`agent-email-${email.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 text-xs font-medium">{email.subject || "(no subject)"}</div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Badge variant="outline" className="text-[10px]">
                  {String(email.direction) === "inbound" ? "From PM" : "Sent"}
                </Badge>
                <span className="text-[10px] text-muted-foreground">
                  {formatEmailTimestampForDisplay(email.sentAt) ?? ""}
                </span>
              </div>
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground">
              {email.fromEmail} → {email.toEmail}
            </div>
            <div className="mt-1.5 whitespace-pre-wrap break-words text-xs leading-relaxed">
              {formatEmailBodyForDisplay(String(email.body ?? ""))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AgentSharedBookingCard({ booking }: { booking: AgentSharedBooking }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery<AgentCommunicationsResponse>({
    queryKey: ["/api/bookings", booking.reservationId, "buy-in-communications"],
    queryFn: () =>
      apiRequest("GET", `/api/bookings/${booking.reservationId}/buy-in-communications`).then((r) => r.json()),
    enabled: open,
    refetchInterval: open ? 60_000 : false,
  });

  const units = useMemo(() => {
    const fromComms = data?.buyIns ?? [];
    return fromComms.length > 0 ? fromComms : booking.units;
  }, [data?.buyIns, booking.units]);

  return (
    <div className="rounded-md border bg-muted/20" data-testid={`agent-shared-booking-${booking.reservationId}`}>
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 p-3 text-left"
        onClick={() => setOpen((v) => !v)}
        data-testid={`button-agent-shared-toggle-${booking.reservationId}`}
      >
        <div className="min-w-0">
          <div className="text-sm font-semibold">{booking.guestName || "Guest"}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {formatStay(booking.checkIn)} → {formatStay(booking.checkOut)}
            {booking.ops?.nights ? ` · ${booking.ops.nights} night${booking.ops.nights === 1 ? "" : "s"}` : ""}
            {booking.ops?.channelLabel ? ` · ` : ""}
            {booking.ops?.channelLabel && (
              <Badge variant="outline" className="align-middle text-[10px]">{booking.ops.channelLabel}</Badge>
            )}
            {" · "}{booking.listingName || "Listing"}
          </div>
          {booking.ops?.partyLabel && (
            <div className="mt-0.5 text-xs text-muted-foreground" data-testid="agent-ops-party">
              👥 {booking.ops.partyLabel}
            </div>
          )}
          <div className="mt-0.5 text-[11px] text-muted-foreground">{booking.confirmationCode}</div>
          <OpsStyleSummary booking={booking} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="outline" className="text-[10px]">
            {booking.units.length} unit{booking.units.length === 1 ? "" : "s"}
          </Badge>
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>
      </button>
      {open && (
        <div className="space-y-3 border-t p-3">
          <div className="flex flex-wrap items-center gap-2">
            <AgentCancellationPolicyCard ops={booking.ops} />
          </div>
          <a
            href={`/inbox?reservationId=${encodeURIComponent(booking.reservationId)}`}
            className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
            data-testid={`link-agent-guest-inbox-${booking.reservationId}`}
          >
            <MessageSquare className="h-3.5 w-3.5" /> Guest Inbox
          </a>
          {isLoading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading the property-management email thread…
            </div>
          )}
          {!isLoading && units.length === 0 && (
            <div className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
              No units are attached to this booking yet.
            </div>
          )}
          {units.map((unit) => (
            <AgentUnitCommunications
              key={unit.id}
              reservationId={booking.reservationId}
              unit={unit}
              contacts={data?.contacts ?? []}
              emails={data?.emails ?? []}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function AgentSharedBookings() {
  const { data, isLoading } = useQuery<{ bookings: AgentSharedBooking[] }>({
    queryKey: ["/api/agent/shared-bookings"],
    queryFn: () => apiRequest("GET", "/api/agent/shared-bookings").then((r) => r.json()),
    staleTime: 30_000,
    refetchInterval: 2 * 60_000,
  });
  const bookings = data?.bookings ?? [];

  return (
    <Card className="mb-5 p-4" data-testid="panel-agent-shared-bookings">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Shared bookings · PM communications</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Bookings the operator shared with you. Read and reply to the property-management email thread for each unit.
          </p>
        </div>
        {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>
      <div className="mt-3 space-y-2">
        {!isLoading && bookings.length === 0 && (
          <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground" data-testid="text-agent-no-shared-bookings">
            Nothing shared yet — the operator can share a booking with you from the bookings page.
          </div>
        )}
        {bookings.map((booking) => (
          <AgentSharedBookingCard key={booking.reservationId} booking={booking} />
        ))}
      </div>
    </Card>
  );
}
