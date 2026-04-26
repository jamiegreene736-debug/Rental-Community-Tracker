import { useState, useRef, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft, MessageSquare, Calendar, Zap, Send, Sparkles, Plus, Pencil,
  Trash2, CheckCircle, XCircle, RefreshCw, Clock, User, Building2, AlertCircle,
  ToggleRight, Bot, Flag, X, ShieldAlert, MessageCircle, DollarSign,
} from "lucide-react";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import type { MessageTemplate } from "@shared/schema";
import { getUnitBuilderByPropertyId } from "@/data/unit-builder-data";
import { getGuestyAmenities, getAmenityLabel } from "@/data/guesty-amenities";
import { fallbackWalkForResort } from "@shared/walking-distance";

// ─── AI draft property-context builder ────────────────────────────────────────
// Given a Guesty listingId, look up the matching NexStay property via the
// backing map and build a rich text block the AI can use to answer
// specific guest questions (per-unit bedroom counts, distance between
// units, parking, pool, etc.) instead of hand-waving. Also flags whether
// the property is in Hawaii so the server can pick the right tone
// variant. Returns null when we can't resolve the listing — the server
// falls back to a generic prompt in that case.
async function buildPropertyContextForDraft(
  listingId: string,
): Promise<{ text: string; isHawaii: boolean } | null> {
  if (!listingId) return null;
  try {
    const r = await apiRequest("GET", "/api/guesty-property-map");
    const maps = await r.json() as Array<{ propertyId: number; guestyListingId: string }>;
    const row = maps.find(m => m.guestyListingId === listingId);
    if (!row) return null;
    const prop = getUnitBuilderByPropertyId(row.propertyId);
    if (!prop) return null;

    const unitLines = prop.units.map((u, i) => {
      const label = `Unit ${String.fromCharCode(65 + i)}`;
      // Include both shortDescription AND longDescription per unit so the
      // AI can answer specific bedding/layout questions ("what beds in
      // each room?", "any king bed?", "is there a sleeper sofa?"). Earlier
      // version only sent shortDescription, which had bedding embedded in
      // a single line — Claude often skipped over it. longDescription
      // spells out the layout sentence-by-sentence (king master / queen
      // second / twin third) so the AI can quote it back accurately.
      const longTrimmed = u.longDescription.length > 600
        ? u.longDescription.slice(0, 600) + "…"
        : u.longDescription;
      return `- ${label} (${u.unitNumber}): ${u.bedrooms}BR / ${u.bathrooms}BA · ~${u.sqft} sqft · sleeps ${u.maxGuests}.\n    Layout: ${longTrimmed}`;
    }).join("\n");

    // Per-resort walking-distance fallback (same helper the Builder
    // uses before its live /api/tools/walk-between result arrives).
    const walk = prop.units.length >= 2 ? fallbackWalkForResort(prop.complexName) : null;

    // Amenity strings tied to questions the AI is most likely to need
    // to answer: parking, pool, AC, pets, kitchen, accessibility.
    const amenityKeys = getGuestyAmenities(row.propertyId);
    const amenityLabels = amenityKeys.map(getAmenityLabel);
    const parkingAmenities = amenityLabels.filter(a => /parking|garage|carport/i.test(a));
    const otherHighlights = amenityLabels.filter(a => /pool|hot tub|beach|ac|air conditioning|pet|wifi|laundry|kitchen|bbq|grill/i.test(a));

    const parts: string[] = [];
    parts.push(`PROPERTY: ${prop.propertyName} at ${prop.complexName}`);
    parts.push(`Address: ${prop.address}`);
    if (prop.propertyType) {
      // propertyType is load-bearing for accessibility questions —
      // a Townhouse is multi-story, a Condominium is single-floor.
      // Surfaces "downstairs unit" / "stairs?" / "ground floor"
      // questions accurately instead of having the AI guess.
      parts.push(`Property type: ${prop.propertyType}${prop.propertyType === "Townhouse" ? " (multi-story attached units, has internal stairs)" : prop.propertyType === "Condominium" ? " (single-floor unit)" : ""}`);
    }
    parts.push(`Total: ${prop.units.reduce((s, u) => s + u.bedrooms, 0)} bedrooms across ${prop.units.length} unit${prop.units.length === 1 ? "" : "s"}, sleeps ${prop.units.reduce((s, u) => s + u.maxGuests, 0)}.`);
    parts.push(`\nUNITS:\n${unitLines}`);
    if (walk) parts.push(`\nDISTANCE BETWEEN UNITS: ${walk.description} (approx ${walk.minutes}-min walk)`);
    if (parkingAmenities.length > 0) parts.push(`\nPARKING: ${parkingAmenities.join(", ")}`);
    if (otherHighlights.length > 0) parts.push(`\nKEY AMENITIES: ${otherHighlights.slice(0, 12).join(", ")}`);
    // Per-complex floor-plan / accessibility note. Only set on
    // properties where there's meaningful variation propertyType
    // alone doesn't capture (Pili Mai mixes Moana single-level and
    // Mahina multi-level plans). When present, surface it as its
    // own section so the AI can quote it back accurately for
    // accessibility / seniors / "downstair units?" asks.
    if (prop.accessibilityNote) {
      parts.push(`\nFLOOR PLAN / ACCESSIBILITY: ${prop.accessibilityNote}`);
    }
    parts.push(`\nDESCRIPTION: ${prop.combinedDescription.slice(0, 600)}${prop.combinedDescription.length > 600 ? "…" : ""}`);

    // Hawaii detection by state code / name in the address string.
    // Every current listing is HI; this check keeps the Hawaiian tone
    // from bleeding onto future mainland additions.
    const isHawaii = /\b(HI|Hawaii|Hawai['ʻ]?i)\b/i.test(prop.address);

    return { text: parts.join("\n"), isHawaii };
  } catch {
    return null;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface GuestyConversation {
  _id: string;
  guestId?: string;
  guestName?: string;
  listingId?: string;
  listingNickname?: string;
  reservationId?: string;
  lastMessageAt?: string;
  unread?: boolean;
  posts?: GuestyPost[];
  lastPost?: GuestyPost;
  status?: string;
  module?: GuestyModule;      // channel the conversation is on
  integration?: { platform?: string };
}

type GuestyModule = { type?: string; [k: string]: unknown };

interface GuestyPost {
  _id: string;
  body?: string;
  text?: string;
  sentAt?: string;
  postedAt?: string;
  authorType?: string;
  authorRole?: string;
  module?: GuestyModule;
}

interface GuestyReservation {
  _id: string;
  status: string;
  guestName?: string;
  listingNickname?: string;
  checkIn?: string;
  checkInDateLocalized?: string;
  checkOut?: string;
  checkOutDateLocalized?: string;
  money?: { totalPaid?: number; totalPrice?: number; currency?: string };
  integration?: { platform?: string };
  source?: string;
  confirmationCode?: string;
  nightsCount?: number;
}

const TRIGGER_OPTIONS = [
  { value: "booking_confirmed",    label: "When booking is confirmed" },
  { value: "days_before_checkin",  label: "X days before check-in" },
  { value: "day_of_checkin",       label: "Day of check-in" },
  { value: "days_before_checkout", label: "X days before check-out" },
  { value: "days_after_checkout",  label: "X days after check-out" },
];

const MERGE_TAGS = [
  "{guest_name}", "{property_name}", "{check_in_date}", "{check_out_date}",
  "{confirmation_code}", "{num_nights}",
];

const DEFAULT_TEMPLATES: Omit<MessageTemplate, "id" | "createdAt">[] = [
  {
    name: "Booking Confirmed",
    trigger: "booking_confirmed",
    daysOffset: 0,
    isActive: true,
    body: `Aloha {guest_name}! 🌺

We're so excited to host you at {property_name}! Your reservation is confirmed for {check_in_date} through {check_out_date} ({num_nights} nights).

We'll send check-in details 3 days before your arrival. In the meantime, please don't hesitate to reach out with any questions — we're always happy to help.

Can't wait to welcome you to Hawaii!
The NexStay Team`,
  },
  {
    name: "Pre-Arrival (3 days before)",
    trigger: "days_before_checkin",
    daysOffset: 3,
    isActive: true,
    body: `Aloha {guest_name}!

Your stay at {property_name} is just 3 days away — so exciting! Here's everything you need for a smooth arrival:

📍 Address: [INSERT ADDRESS]
🔑 Check-in: [INSERT CHECK-IN TIME & ACCESS INSTRUCTIONS]
🅿️ Parking: [INSERT PARKING DETAILS]
📶 WiFi: [INSERT WIFI DETAILS]

Your confirmation code is {confirmation_code}. If anything comes up before you arrive, we're just a message away.

See you soon!
The NexStay Team`,
  },
  {
    name: "Check-out Reminder",
    trigger: "days_before_checkout",
    daysOffset: 1,
    isActive: true,
    body: `Aloha {guest_name}!

We hope you're having an amazing time! Just a friendly reminder that check-out is tomorrow.

⏰ Check-out time: 10:00 AM
🗝️ Please leave the key/lockbox as you found it and feel free to leave used towels in the bathroom.

We'd love to know how your stay has been — feel free to share any feedback!

Mahalo for choosing NexStay. 🤙
The NexStay Team`,
  },
  {
    name: "Post-Stay Review Request",
    trigger: "days_after_checkout",
    daysOffset: 2,
    isActive: true,
    body: `Aloha {guest_name}!

It was such a pleasure having you at {property_name}! We hope you had an unforgettable time in Hawaii.

If you have a moment, we'd really appreciate a review — it means the world to small hosts like us and helps future guests find a great place to stay.

We hope to see you again on your next Hawaii adventure! 🌊
Mahalo nui loa,
The NexStay Team`,
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function triggerLabel(trigger: string, daysOffset: number): string {
  switch (trigger) {
    case "booking_confirmed": return "On booking confirmation";
    case "days_before_checkin": return daysOffset === 0 ? "Day of check-in" : `${daysOffset} day${daysOffset > 1 ? "s" : ""} before check-in`;
    case "day_of_checkin": return "Day of check-in";
    case "days_before_checkout": return `${daysOffset} day${daysOffset > 1 ? "s" : ""} before check-out`;
    case "days_after_checkout": return `${daysOffset} day${daysOffset > 1 ? "s" : ""} after check-out`;
    default: return trigger;
  }
}

function formatDate(d?: string) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function platformBadge(res: GuestyReservation) {
  const src = (res.integration?.platform ?? res.source ?? "").toLowerCase();
  return channelBadge(src);
}

// Small inline channel pill used in message timestamps and reservation cards.
// Accepts any of the raw Guesty channel strings (airbnb, airbnb2, homeaway, vrbo,
// booking, booking.com, email, sms, whatsapp, direct, manual).
function channelBadge(raw: string) {
  const src = (raw || "").toLowerCase();
  if (src.includes("airbnb")) return <span className="inline-block px-1.5 py-[1px] rounded text-[9px] font-medium bg-[#FF5A5F] text-white">Airbnb</span>;
  if (src.includes("vrbo") || src.includes("homeaway")) return <span className="inline-block px-1.5 py-[1px] rounded text-[9px] font-medium bg-blue-600 text-white">VRBO</span>;
  if (src.includes("booking")) return <span className="inline-block px-1.5 py-[1px] rounded text-[9px] font-medium bg-blue-800 text-white">Booking</span>;
  if (src.includes("email")) return <span className="inline-block px-1.5 py-[1px] rounded text-[9px] font-medium bg-slate-600 text-white">Email</span>;
  if (src.includes("sms")) return <span className="inline-block px-1.5 py-[1px] rounded text-[9px] font-medium bg-emerald-600 text-white">SMS</span>;
  if (src.includes("whatsapp")) return <span className="inline-block px-1.5 py-[1px] rounded text-[9px] font-medium bg-green-600 text-white">WhatsApp</span>;
  if (!src) return null;
  return <span className="inline-block px-1.5 py-[1px] rounded text-[9px] font-medium bg-slate-400 text-white">{src}</span>;
}

// ─── Response-shape normalizer ─────────────────────────────────────────────────
// Guesty's Open API wraps list responses inconsistently depending on endpoint:
//   bare:      [...]
//   legacy:    { results: [...] }
//   envelope:  { status, data: [...] }
//   envelope:  { status, data: { conversations: [...] } }   ← communications
//   envelope:  { status, data: { results: [...] } }         ← reservations
// unwrapList finds the first array by walking the object shallowly, trying the
// hint names at each depth before falling back to any array-valued field.
// Always returns an array — never throws or returns undefined.
function unwrapList<T>(raw: unknown, hints: string[] = []): T[] {
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number): T[] | null => {
    if (Array.isArray(node)) return node as T[];
    if (!node || typeof node !== "object" || depth > 3) return null;
    if (seen.has(node)) return null;
    seen.add(node);
    const obj = node as Record<string, unknown>;
    // Try hinted keys first at this depth
    for (const hint of hints) {
      if (Array.isArray(obj[hint])) return obj[hint] as T[];
    }
    // Then recurse into any object-valued child
    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") {
        const found = visit(v, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(raw, 0) ?? [];
}

// Normalize a conversation object across Guesty API versions.
// v1 puts guest/listing/last-message data at the top level.
// v2 (inbox-v2) nests it under `meta`: meta.guest, meta.listing, meta.lastMessage, etc.
// We flatten both shapes into a consistent view for rendering.
function normalizeConversation(c: any): GuestyConversation & {
  displayGuestName: string;
  displayListingName: string;
  displayPreview: string;
  displayTimestamp: string | undefined;
  isUnread: boolean;
  reservationId?: string;
  // Indicators surfaced on the list row beside the guest name. Each
  // flag means "host action is pending" for a different reason.
  // Computed from the conversation/reservation stub the list endpoint
  // already returns — no extra queries.
  needsReply: boolean;       // unread incoming message awaits a host response
  needsPreapprove: boolean;  // Airbnb inquiry not yet pre-approved (host has 24h)
  phase?: "inquiry" | "request" | "booked" | "cancelled" | "other";
} {
  const meta = c?.meta ?? {};
  const guest = c?.guest ?? meta.guest ?? {};
  // Inbox-v2 nests reservation as an array under meta.reservations;
  // listing info is nested inside the reservation itself.
  const firstReservation =
    Array.isArray(meta.reservations) && meta.reservations.length > 0
      ? meta.reservations[0]
      : (c?.reservation ?? meta.reservation ?? null);
  const listing =
    c?.listing ??
    meta.listing ??
    firstReservation?.listing ??
    firstReservation?.listingObj ??
    {};
  const lastMsg = c?.lastPost ?? meta.lastMessage ?? meta.lastPost ?? {};
  const mod = c?.module ?? meta.module ?? meta.lastMessage?.module ?? undefined;

  const guestName =
    c?.guestName ??
    guest.fullName ??
    guest.name ??
    [guest.firstName, guest.lastName].filter(Boolean).join(" ") ??
    "Guest";

  const listingName =
    c?.listingNickname ??
    listing.nickname ??
    listing.title ??
    listing.name ??
    firstReservation?.listingNickname ??
    firstReservation?.listingTitle ??
    "—";

  const preview =
    lastMsg.body ??
    lastMsg.text ??
    lastMsg.message ??
    meta.lastMessagePreview ??
    "";

  // v2 list endpoint doesn't return a last-message timestamp, so fall back to
  // the conversation's createdAt so rows at least show some date.
  const timestamp =
    c?.lastMessageAt ??
    meta.lastMessageAt ??
    lastMsg.createdAt ??
    c?.createdAt ??
    undefined;

  const unread =
    (typeof c?.unreadCount === "number" && c.unreadCount > 0) ||
    c?.unread === true ||
    meta.unreadCount > 0 ||
    c?.state === "NEW" ||
    c?.state === "UNREAD" ||
    c?.state === "UNANSWERED";

  const reservationId =
    c?.reservationId ??
    firstReservation?._id ??
    firstReservation?.id ??
    undefined;

  // Reservation phase for the quick-scan badge in the list row.
  const resStatus = String(firstReservation?.status ?? "").toLowerCase();
  let phase: "inquiry" | "request" | "booked" | "cancelled" | "other" = "other";
  if (resStatus.includes("cancel")) phase = "cancelled";
  else if (resStatus.includes("inquiry")) phase = "inquiry";
  else if (resStatus === "request" || resStatus === "pending" || resStatus === "awaitingpayment") phase = "request";
  else if (["reserved", "confirmed", "accepted", "checked_in", "checkedin", "completed"].includes(resStatus)) phase = "booked";

  // Channel detection — used by needsPreapprove. Pre-approval is an
  // Airbnb-only concept (VRBO/Booking.com handle inquiries differently)
  // so the indicator is gated to airbnb conversations.
  const channelRaw =
    (mod && (mod as any).type) ??
    c?.integration?.platform ??
    firstReservation?.integration?.platform ??
    "";
  const isAirbnb = String(channelRaw).toLowerCase().includes("airbnb");

  // Pre-approval indicator: an Airbnb inquiry that hasn't been
  // pre-approved yet. Once the host pre-approves, Guesty flips
  // status away from "inquiry" (or sets preApproveState=true on the
  // reservation), so checking phase + the explicit flag covers both
  // shapes that can come back on the list endpoint stub.
  const preApprovedFlag =
    firstReservation?.preApproveState === true ||
    firstReservation?.preApproved === true ||
    String(firstReservation?.preApprovalStatus ?? "").toLowerCase() === "preapproved";
  const needsPreapprove = isAirbnb && phase === "inquiry" && !preApprovedFlag;

  // Surface check-in / check-out / guest count at the top level so the
  // AI Draft call can pass them down — otherwise the AI ends every
  // reply with "what dates are you thinking?" even on inquiries that
  // already have dates attached. Inquiries always carry checkIn /
  // checkOut on the Guesty reservation; guestsCount is what the guest
  // entered into Airbnb's date picker (sometimes missing on direct
  // bookings, in which case we leave it null and the prompt guides
  // the AI to read it from the message body).
  const conversationCheckIn =
    firstReservation?.checkInDateLocalized ??
    firstReservation?.checkIn ??
    null;
  const conversationCheckOut =
    firstReservation?.checkOutDateLocalized ??
    firstReservation?.checkOut ??
    null;
  const conversationGuests =
    firstReservation?.guestsCount ??
    firstReservation?.numberOfGuests ??
    null;

  return {
    ...c,
    guestName,
    listingId: c?.listingId ?? listing?._id ?? firstReservation?.listingId,
    listingNickname: listingName,
    reservationId,
    lastMessageAt: timestamp,
    lastPost: lastMsg,
    module: mod,
    displayGuestName: guestName || "Guest",
    displayListingName: listingName || "—",
    displayPreview: typeof preview === "string" ? preview : "",
    displayTimestamp: timestamp,
    isUnread: !!unread,
    needsReply: !!unread,
    needsPreapprove,
    phase,
    conversationCheckIn,
    conversationCheckOut,
    conversationGuests,
  };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TemplateEditor({
  template,
  onSave,
  onClose,
}: {
  template: Partial<MessageTemplate> | null;
  onSave: (data: Omit<MessageTemplate, "id" | "createdAt">) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [trigger, setTrigger] = useState(template?.trigger ?? "booking_confirmed");
  const [daysOffset, setDaysOffset] = useState(template?.daysOffset ?? 0);
  const [body, setBody] = useState(template?.body ?? "");
  const [isActive, setIsActive] = useState(template?.isActive ?? true);
  const needsDays = trigger === "days_before_checkin" || trigger === "days_before_checkout" || trigger === "days_after_checkout";

  const insertTag = (tag: string) => setBody(b => b + tag);

  return (
    <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{template?.id ? "Edit Template" : "New Template"}</DialogTitle>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div>
          <Label>Template Name</Label>
          <Input
            data-testid="input-template-name"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Check-in Instructions"
            className="mt-1"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Send When</Label>
            <Select value={trigger} onValueChange={setTrigger}>
              <SelectTrigger className="mt-1" data-testid="select-template-trigger">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRIGGER_OPTIONS.map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {needsDays && (
            <div>
              <Label>Days</Label>
              <Input
                data-testid="input-template-days"
                type="number"
                min={0}
                max={30}
                value={daysOffset}
                onChange={e => setDaysOffset(parseInt(e.target.value) || 0)}
                className="mt-1"
              />
            </div>
          )}
        </div>
        <div>
          <Label>Message Body</Label>
          <div className="flex flex-wrap gap-1 mt-1 mb-1">
            {MERGE_TAGS.map(tag => (
              <button
                key={tag}
                onClick={() => insertTag(tag)}
                className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded hover:bg-primary hover:text-primary-foreground transition-colors"
                data-testid={`button-merge-tag-${tag}`}
              >
                {tag}
              </button>
            ))}
          </div>
          <Textarea
            data-testid="textarea-template-body"
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={12}
            className="font-mono text-sm"
            placeholder="Write your message here. Click tags above to insert merge fields."
          />
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="template-active"
            checked={isActive}
            onCheckedChange={setIsActive}
            data-testid="switch-template-active"
          />
          <Label htmlFor="template-active">Active (will be sent automatically)</Label>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} data-testid="button-template-cancel">Cancel</Button>
        <Button
          onClick={() => onSave({ name, trigger, daysOffset, body, isActive })}
          disabled={!name || !body}
          data-testid="button-template-save"
        >
          Save Template
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function InboxPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [draftLoading, setDraftLoading] = useState(false);
  const [templateDialog, setTemplateDialog] = useState<{ open: boolean; template: Partial<MessageTemplate> | null }>({ open: false, template: null });
  // Property filter for the conversation list — narrows the visible
  // conversations to a single listing nickname. Defaults to "all" so
  // nothing is hidden until the user picks a property.
  const [propertyFilter, setPropertyFilter] = useState<string>("all");
  // Special-offer dialog state. Only one offer in flight at a time
  // — there's only ever one selected conversation. The dialog opens
  // pre-filled with the current quoted rate so the host just types
  // the new total they're willing to take.
  const [specialOfferDialog, setSpecialOfferDialog] = useState<{
    open: boolean;
    reservationId: string | null;
    currentTotal: number;
  }>({ open: false, reservationId: null, currentTotal: 0 });
  const [specialOfferPrice, setSpecialOfferPrice] = useState<string>("");
  const [specialOfferMessage, setSpecialOfferMessage] = useState<string>("");
  const threadRef = useRef<HTMLDivElement>(null);

  // ── Conversations ──
  // Guesty Open API mounts conversations under /communication/ — see
  // https://open-api-docs.guesty.com/reference/get_communication-conversations
  const { data: convData, isLoading: convLoading, error: convError } = useQuery<any>({
    queryKey: ["/api/guesty-proxy/communication/conversations"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/guesty-proxy/communication/conversations?limit=30");
      if (!r.ok) throw new Error(`Guesty returned HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 60_000,
  });
  // Guesty's Open API wraps list responses as:
  //   { status: 200, data: { count, countUnread, conversations: [...], cursor, ... } }
  // Older/other endpoints may return:
  //   { results: [...] } or { data: [...] } or a bare array.
  // unwrapList() finds the array by checking known list field names at every depth.
  const conversations: GuestyConversation[] = unwrapList<GuestyConversation>(convData, [
    "conversations", "results", "data",
  ]);

  // Unique listing names for the property filter dropdown. Sourced from
  // the conversations themselves (no extra fetch) so the dropdown only
  // ever lists properties the operator currently has conversations
  // for — no empty options.
  const listingOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const name = normalizeConversation(c).displayListingName;
      if (name && name !== "—") set.add(name);
    }
    return Array.from(set).sort();
  }, [conversations]);

  // Apply the property filter. "all" passes everything through.
  const filteredConversations = useMemo(() => {
    if (propertyFilter === "all") return conversations;
    return conversations.filter((c) => normalizeConversation(c).displayListingName === propertyFilter);
  }, [conversations, propertyFilter]);

  const selectedConvRaw = conversations.find(c => c._id === selectedConvId) ?? null;
  const selectedConv = selectedConvRaw ? normalizeConversation(selectedConvRaw) : null;

  // Conversation metadata (assignee, priority, integration, etc.)
  const { data: threadData, isLoading: threadLoading } = useQuery<any>({
    queryKey: ["/api/guesty-proxy/communication/conversations", selectedConvId],
    enabled: !!selectedConvId,
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/guesty-proxy/communication/conversations/${selectedConvId}`);
      if (!r.ok) throw new Error(`Guesty returned HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 30_000,
  });

  // Inbox-v2: posts live at a SEPARATE endpoint, not inside the conversation
  // document. Fetch them independently so the thread actually populates.
  const { data: postsData, isLoading: postsLoading } = useQuery<any>({
    queryKey: ["/api/guesty-proxy/communication/conversations", selectedConvId, "posts"],
    enabled: !!selectedConvId,
    queryFn: async () => {
      const r = await apiRequest(
        "GET",
        `/api/guesty-proxy/communication/conversations/${selectedConvId}/posts?limit=100`,
      );
      if (!r.ok) throw new Error(`Guesty returned HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const posts: GuestyPost[] = (() => {
    // postsData from the /posts endpoint is the authoritative source.
    const fromPosts = unwrapList<GuestyPost>(postsData, ["posts", "results", "messages"]);
    if (fromPosts.length > 0) return fromPosts;
    // Fallback: some older responses stored posts inline on the conversation.
    const fromThread = unwrapList<GuestyPost>(threadData, ["posts", "messages"]);
    if (fromThread.length > 0) return fromThread;
    return selectedConv?.posts ?? [];
  })();

  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [posts.length]);

  // Full reservation details (money breakdown, pre-approval status, etc.)
  // The conversation endpoint only gives us a minimal reservation stub.
  const reservationId = (selectedConv as any)?.meta?.reservations?.[0]?._id;
  const { data: reservationFull } = useQuery<any>({
    queryKey: ["/api/guesty-proxy/reservations", reservationId],
    enabled: !!reservationId,
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/guesty-proxy/reservations/${reservationId}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 60_000,
  });

  const sendMessage = useMutation({
    // /posts adds a message to the thread but doesn't deliver it to the guest —
    // /send-message does both. Guesty requires a `module` describing the channel.
    mutationFn: async () => {
      if (!selectedConv) throw new Error("No conversation selected");
      const lastPostModule = [...(posts ?? [])].reverse().find(p => p.module)?.module;
      const rawMod: GuestyModule = selectedConv.module ?? lastPostModule ?? { type: "email" };

      // Guesty's /send-message validator rejects extra keys on the
      // `module` object with a 400 — specifically `templateValues`,
      // `templateVariableNames`, and `externalId`, which show up on
      // the module of any post that was itself sent via a Guesty
      // template or external channel link. Reading `selectedConv.module`
      // or `lastPostModule` carries those fields forward, and the
      // send blows up with `"module.templateValues" is not allowed`.
      //
      // Whitelist only what /send-message accepts. Everything else is
      // metadata from Guesty's read shape that the write shape doesn't
      // tolerate.
      const mod: GuestyModule = {};
      const allowedKeys = ["type", "channelId", "platform", "integrationId"] as const;
      for (const k of allowedKeys) {
        if (rawMod[k] !== undefined) (mod as any)[k] = rawMod[k];
      }
      if (!mod.type) mod.type = "email";

      const r = await apiRequest(
        "POST",
        `/api/guesty-proxy/communication/conversations/${selectedConvId}/send-message`,
        { body: replyText, module: mod },
      );
      if (!r.ok) {
        const errBody = await r.json().catch(() => ({}));
        throw new Error(errBody.error ?? errBody.message ?? `Guesty returned HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      setReplyText("");
      qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/communication/conversations", selectedConvId] });
      qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/communication/conversations", selectedConvId, "posts"] });
      qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/communication/conversations"] });
      toast({ title: "Message sent!" });
    },
    onError: (e: any) => toast({ title: "Failed to send", description: e.message, variant: "destructive" }),
  });

  const generateDraft = async () => {
    if (!selectedConv) return;
    setDraftLoading(true);
    // Find the guest's MOST RECENT message. Sort posts ascending by
    // timestamp first — Guesty's /posts endpoint returns newest-
    // first, so a naive `[...posts].reverse()` gave us oldest-first
    // and `.find()` then returned the guest's *first* message
    // (Jamie's bug report: AI Draft answered the original inquiry
    // instead of the latest follow-up about discount/payment).
    // Mirror the rendering's isHost detection (line ~1079) so a host
    // post tagged with `direction: "outbound"` or `senderType: "host"`
    // — but no `authorType`/`authorRole` — is correctly excluded.
    const sortedAsc = [...posts].sort((a: any, b: any) => {
      const ta = new Date(a.sentAt ?? a.postedAt ?? a.createdAt ?? 0).getTime();
      const tb = new Date(b.sentAt ?? b.postedAt ?? b.createdAt ?? 0).getTime();
      return ta - tb;
    });
    const lastGuestPost = [...sortedAsc].reverse().find((p: any) => {
      const isHost =
        p.authorType === "host" ||
        p.authorRole === "host" ||
        p.senderType === "host" ||
        p.direction === "outbound" ||
        p.direction === "out" ||
        p.isIncoming === false;
      return !isHost;
    });
    // Build property-specific context so the AI can answer "how many
    // bedrooms per unit?" / "how far apart are the units?" / "is
    // parking free?" with facts instead of hand-waves. Non-blocking:
    // if the listing isn't mapped to one of our properties we fall
    // through with propertyContext=null and the server uses its
    // generic prompt.
    const ctx = selectedConv.listingId
      ? await buildPropertyContextForDraft(selectedConv.listingId)
      : null;
    // Channel name (airbnb / vrbo / booking / direct / email / …) so
    // the server can give a channel-correct answer when the guest
    // asks about payment timing — e.g. "Airbnb sets the payment
    // schedule" rather than a generic disclaimer.
    const channel =
      selectedConv.module?.type ??
      (selectedConv as any).integration?.platform ??
      "";
    try {
      const r = await apiRequest("POST", "/api/inbox/ai-draft", {
        guestMessage: lastGuestPost?.body ?? lastGuestPost?.text ?? "",
        guestName: selectedConv.guestName,
        propertyName: selectedConv.listingNickname,
        propertyContext: ctx?.text ?? null,
        // Gates the Hawaiian-tone variant of the system prompt on the
        // server — Aloha openings / "mahalo" / "'ohana" / etc. — so
        // only Hawaii listings get that flavor. Non-HI properties
        // stay on the standard friendly+professional voice.
        isHawaii: ctx?.isHawaii ?? false,
        channel,
        // The reservation already carries dates and guest count for
        // inquiries / requests / bookings. Send them through so the
        // AI doesn't end every reply with "what dates are you thinking
        // and how many guests?" when the answers are already attached
        // to the conversation.
        checkIn: (selectedConv as any).conversationCheckIn ?? null,
        checkOut: (selectedConv as any).conversationCheckOut ?? null,
        guestsCount: (selectedConv as any).conversationGuests ?? null,
      });
      const data = await r.json();
      if (data.draft) setReplyText(data.draft);
      else toast({ title: "AI draft unavailable", description: data.error, variant: "destructive" });
    } catch (e: any) {
      toast({ title: "Draft failed", description: e.message, variant: "destructive" });
    } finally {
      setDraftLoading(false);
    }
  };

  // ── Reservations ──
  const { data: pendingData, isLoading: pendingLoading } = useQuery<any>({
    queryKey: ["/api/guesty-proxy/reservations/pending"],
    queryFn: () =>
      apiRequest("GET", "/api/guesty-proxy/reservations?limit=50")
        .then(r => r.json())
        .then(d => {
          const rows = unwrapList<any>(d, ["reservations", "results", "data"]);
          return {
            results: rows.filter((r: any) =>
              r.status === "inquiry" || r.status === "awaitingPayment" || r.status === "pending"
            ),
          };
        })
        .catch(() => ({ results: [] })),
    refetchInterval: 60_000,
  });
  const pendingRes: GuestyReservation[] = unwrapList<GuestyReservation>(pendingData, [
    "reservations", "results", "data",
  ]);

  const { data: upcomingData } = useQuery<any>({
    queryKey: ["/api/guesty-proxy/reservations/upcoming"],
    queryFn: () => {
      const today = new Date().toISOString().split("T")[0];
      return apiRequest("GET", `/api/guesty-proxy/reservations?limit=50&sort=checkIn`)
        .then(r => r.json())
        .then(d => {
          const rows = unwrapList<any>(d, ["reservations", "results", "data"]);
          return {
            results: rows.filter((r: any) => {
              const checkIn = r.checkInDateLocalized ?? r.checkIn ?? "";
              return (r.status === "confirmed" || r.status === "checked_in") && checkIn >= today;
            }),
          };
        })
        .catch(() => ({ results: [] }));
    },
    refetchInterval: 120_000,
  });
  const upcomingRes: GuestyReservation[] = unwrapList<GuestyReservation>(upcomingData, [
    "reservations", "results", "data",
  ]);

  const { data: autoApproveStatus, isLoading: autoLoading } = useQuery<any>({
    queryKey: ["/api/inbox/auto-approve/status"],
    refetchInterval: 30_000,
  });

  const toggleAutoApprove = useMutation({
    mutationFn: (enabled: boolean) =>
      apiRequest("POST", "/api/inbox/auto-approve/toggle", { enabled }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/inbox/auto-approve/status"] }),
  });

  const runAutoApprove = useMutation({
    mutationFn: () => apiRequest("POST", "/api/inbox/auto-approve/run").then(r => r.json()),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["/api/inbox/auto-approve/status"] });
      qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/reservations/pending"] });
      toast({ title: data.message ?? "Auto-approve complete" });
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  // ── Auto-Reply Agent ──
  const { data: autoReplyStatus } = useQuery<any>({
    queryKey: ["/api/inbox/auto-reply/status"],
    refetchInterval: 30_000,
  });

  const { data: autoReplyLogs = [], isLoading: logsLoading } = useQuery<any[]>({
    queryKey: ["/api/inbox/auto-reply/logs"],
    refetchInterval: 60_000,
  });

  const toggleAutoReply = useMutation({
    mutationFn: (enabled: boolean) =>
      apiRequest("POST", "/api/inbox/auto-reply/toggle", { enabled }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/inbox/auto-reply/status"] }),
  });

  const runAutoReply = useMutation({
    mutationFn: () => apiRequest("POST", "/api/inbox/auto-reply/run").then(r => r.json()),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["/api/inbox/auto-reply/status"] });
      qc.invalidateQueries({ queryKey: ["/api/inbox/auto-reply/logs"] });
      toast({ title: data.message ?? "Auto-reply complete" });
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const sendDraftReply = useMutation({
    mutationFn: (id: number) =>
      apiRequest("POST", `/api/inbox/auto-reply/logs/${id}/send`).then(r => r.json()),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["/api/inbox/auto-reply/logs"] });
      if (data.ok) toast({ title: "Reply sent to guest" });
      else toast({ title: "Send failed", description: data.error, variant: "destructive" });
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const dismissDraft = useMutation({
    mutationFn: (id: number) =>
      apiRequest("POST", `/api/inbox/auto-reply/logs/${id}/dismiss`).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/inbox/auto-reply/logs"] });
      toast({ title: "Dismissed" });
    },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const approveReservation = useMutation({
    mutationFn: (id: string) =>
      apiRequest("PUT", `/api/guesty-proxy/reservations/${id}/confirm`, {}).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/reservations/pending"] });
      toast({ title: "Reservation approved!" });
    },
    onError: (e: any) => toast({ title: "Failed to approve", description: e.message, variant: "destructive" }),
  });

  // Pre-approve an Airbnb inquiry directly from the inbox. Hits our server
  // wrapper that PUTs the reservation with preApproveState:true (with fallback
  // candidate endpoints). On success we:
  //   1. Optimistically patch the react-query cache so the banner flips green
  //      immediately, without waiting for the GET round-trip
  //   2. Invalidate the reservation + conversation queries so the authoritative
  //      server state is refetched in the background
  const preapproveAirbnb = useMutation({
    mutationFn: async (reservationId: string) => {
      const r = await apiRequest("POST", `/api/inbox/reservations/${reservationId}/airbnb/preapprove`, {});
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error ?? err.message ?? `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: (_data, reservationId) => {
      // Optimistically flip preApproveState=true on the cached reservation
      qc.setQueryData(["/api/guesty-proxy/reservations", reservationId], (old: any) => {
        if (!old) return old;
        // Response shape is {status, data: {...reservation}}; patch inside data
        const patched = { ...old };
        if (patched.data) patched.data = { ...patched.data, preApproveState: true };
        else patched.preApproveState = true;
        return patched;
      });
      // Refetch authoritative state in the background
      qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/reservations", reservationId] });
      qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/communication/conversations"] });
      // Use the ACTUAL selected conversation's guest name — the toast
      // previously hardcoded "Kim" (leftover from a test conversation),
      // which made the operator think the wrong guest had been
      // pre-approved. Falls back to "Guest" if the name isn't available.
      const who = selectedConv?.guestName || "Guest";
      toast({
        title: "Pre-approved on Airbnb",
        description: `${who} can now book without further host action.`,
      });
    },
    onError: (e: any) => toast({ title: "Pre-approval failed", description: e.message, variant: "destructive" }),
  });

  // Send an Airbnb Special Offer — overrides the listing rate for
  // this specific inquiry. Same `callGuestyAirbnbAction` candidate-
  // walker on the server as pre-approve / decline (PR #99 verifies
  // every candidate, so a 200 that didn't actually create the offer
  // bubbles up as failure). Body is `{ price, message?,
  // expirationDays? }` per the existing endpoint.
  const sendSpecialOffer = useMutation({
    mutationFn: async (vars: { reservationId: string; price: number; message?: string }) => {
      const r = await apiRequest("POST", `/api/inbox/reservations/${vars.reservationId}/airbnb/special-offer`, {
        price: vars.price,
        ...(vars.message ? { message: vars.message } : {}),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error ?? err.message ?? `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/reservations"] });
      qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/communication/conversations"] });
      setSpecialOfferDialog({ open: false, reservationId: null, currentTotal: 0 });
      setSpecialOfferPrice("");
      setSpecialOfferMessage("");
      toast({
        title: "Special offer sent on Airbnb",
        description: "The guest will see your custom price next time they open the conversation.",
      });
    },
    onError: (e: any) => toast({ title: "Special offer failed", description: e.message, variant: "destructive" }),
  });

  // Decline an Airbnb inquiry.
  const declineAirbnb = useMutation({
    mutationFn: async ({ reservationId, reason }: { reservationId: string; reason?: string }) => {
      const r = await apiRequest("POST", `/api/inbox/reservations/${reservationId}/airbnb/decline`, { reason });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error ?? err.message ?? `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/reservations"] });
      qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/communication/conversations"] });
      toast({ title: "Inquiry declined" });
    },
    onError: (e: any) => toast({ title: "Decline failed", description: e.message, variant: "destructive" }),
  });

  const declineReservation = useMutation({
    mutationFn: (id: string) =>
      apiRequest("PUT", `/api/guesty-proxy/reservations/${id}`, { status: "declined" }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/reservations/pending"] });
      toast({ title: "Reservation declined" });
    },
    onError: (e: any) => toast({ title: "Failed to decline", description: e.message, variant: "destructive" }),
  });

  // ── Templates ──
  const { data: templates = [], isLoading: templatesLoading } = useQuery<MessageTemplate[]>({
    queryKey: ["/api/inbox/templates"],
  });

  const createTemplate = useMutation({
    mutationFn: (data: Omit<MessageTemplate, "id" | "createdAt">) =>
      apiRequest("POST", "/api/inbox/templates", data).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/inbox/templates"] }); setTemplateDialog({ open: false, template: null }); toast({ title: "Template saved!" }); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const updateTemplate = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<MessageTemplate> }) =>
      apiRequest("PUT", `/api/inbox/templates/${id}`, data).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/inbox/templates"] }); setTemplateDialog({ open: false, template: null }); toast({ title: "Template updated!" }); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const deleteTemplate = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/inbox/templates/${id}`).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/inbox/templates"] }); toast({ title: "Template deleted" }); },
    onError: (e: any) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const toggleTemplate = (t: MessageTemplate) =>
    updateTemplate.mutate({ id: t.id, data: { isActive: !t.isActive } });

  const saveTemplate = (data: Omit<MessageTemplate, "id" | "createdAt">) => {
    if (templateDialog.template?.id) {
      updateTemplate.mutate({ id: templateDialog.template.id, data });
    } else {
      createTemplate.mutate(data);
    }
  };

  const addDefaultTemplates = () => {
    DEFAULT_TEMPLATES.forEach(t => createTemplate.mutate(t));
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b bg-card px-6 py-4 flex items-center gap-4">
        <Link href="/">
          <Button variant="ghost" size="sm" className="gap-1" data-testid="button-back-home">
            <ArrowLeft className="h-4 w-4" /> Dashboard
          </Button>
        </Link>
        <div className="h-5 w-px bg-border" />
        <div>
          <h1 className="font-semibold text-lg leading-tight">Guest Inbox</h1>
          <p className="text-xs text-muted-foreground">Messages · Reservations · Auto-Messages</p>
        </div>
        {pendingRes.length > 0 && (
          <Badge className="ml-auto bg-amber-500 text-white" data-testid="badge-pending-count">
            {pendingRes.length} pending request{pendingRes.length > 1 ? "s" : ""}
          </Badge>
        )}
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6">
        <Tabs defaultValue="messages">
          <TabsList className="mb-6" data-testid="tabs-inbox">
            <TabsTrigger value="messages" data-testid="tab-messages">
              <MessageSquare className="h-4 w-4 mr-1.5" /> Messages
            </TabsTrigger>
            <TabsTrigger value="reservations" data-testid="tab-reservations">
              <Calendar className="h-4 w-4 mr-1.5" /> Reservations
              {pendingRes.length > 0 && (
                <span className="ml-1.5 rounded-full bg-amber-500 text-white text-[10px] w-4 h-4 flex items-center justify-center">
                  {pendingRes.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="auto-messages" data-testid="tab-auto-messages">
              <Zap className="h-4 w-4 mr-1.5" /> Auto-Messages
            </TabsTrigger>
            <TabsTrigger value="auto-reply" data-testid="tab-auto-reply">
              <Bot className="h-4 w-4 mr-1.5" /> Auto-Reply
              {autoReplyLogs.filter((l: any) => l.status === "flagged" || (l.status === "drafted" && !l.replySent)).length > 0 && (
                <span className="ml-1.5 rounded-full bg-amber-500 text-white text-[10px] w-4 h-4 flex items-center justify-center">
                  {autoReplyLogs.filter((l: any) => l.status === "flagged" || (l.status === "drafted" && !l.replySent)).length}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          {/* ── MESSAGES TAB ── */}
          <TabsContent value="messages">
            <div className="grid grid-cols-[280px_1fr_300px] gap-4 h-[calc(100vh-220px)] min-h-[600px]">
              {/* Conversation List */}
              <div className="border rounded-lg bg-card overflow-y-auto">
                <div className="px-4 py-3 border-b flex items-center justify-between gap-2">
                  <span className="text-sm font-medium shrink-0">Conversations</span>
                  {convLoading && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />}
                </div>
                {/* Property filter — only visible when there's something to
                    filter (>1 distinct listing). Hidden when there's a single
                    property in the inbox so the dropdown isn't dead UI. */}
                {listingOptions.length > 1 && (
                  <div className="px-3 py-2 border-b">
                    <Select value={propertyFilter} onValueChange={setPropertyFilter}>
                      <SelectTrigger
                        className="h-8 text-xs"
                        data-testid="select-conversation-property-filter"
                      >
                        <SelectValue placeholder="All properties" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All properties</SelectItem>
                        {listingOptions.map((p) => (
                          <SelectItem key={p} value={p}>{p}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {convError && !convLoading && (
                  <div className="p-6 text-center text-sm text-destructive">
                    <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    Couldn't load conversations
                    <div className="mt-1 text-xs font-mono opacity-70">{(convError as Error).message}</div>
                  </div>
                )}
                {!convError && conversations.length === 0 && !convLoading && (
                  <div className="p-6 text-center text-sm text-muted-foreground">
                    <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    No conversations yet
                  </div>
                )}
                {!convError && conversations.length > 0 && filteredConversations.length === 0 && (
                  <div className="p-6 text-center text-sm text-muted-foreground">
                    No conversations for that property.{" "}
                    <button
                      className="underline text-primary"
                      onClick={() => setPropertyFilter("all")}
                      data-testid="button-clear-conversation-filter"
                    >
                      Clear filter
                    </button>
                  </div>
                )}
                <TooltipProvider>
                {filteredConversations.map(rawC => {
                  const c = normalizeConversation(rawC);
                  const active = c._id === selectedConvId;
                  return (
                    <button
                      key={c._id}
                      data-testid={`conversation-item-${c._id}`}
                      onClick={() => setSelectedConvId(c._id)}
                      className={`w-full text-left px-4 py-3 border-b hover:bg-muted/50 transition-colors ${active ? "bg-primary/5 border-l-2 border-l-primary" : ""}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                            <User className="h-3.5 w-3.5 text-primary" />
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <p className="font-medium text-sm truncate">{c.displayGuestName}</p>
                              {/* Pending-action icons. Each one means a
                                  different host action is outstanding —
                                  reply needed (unread incoming) and/or
                                  pre-approval owed on an Airbnb inquiry. */}
                              {c.needsReply && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span data-testid={`indicator-needs-reply-${c._id}`}>
                                      <MessageCircle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent side="right">Reply needed</TooltipContent>
                                </Tooltip>
                              )}
                              {c.needsPreapprove && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span data-testid={`indicator-needs-preapprove-${c._id}`}>
                                      <ShieldAlert className="h-3.5 w-3.5 text-red-600 shrink-0" />
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent side="right">Pre-approval needed (Airbnb)</TooltipContent>
                                </Tooltip>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground truncate">{c.displayListingName}</p>
                            {c.phase && c.phase !== "other" && (
                              <span
                                className={`inline-block mt-1 px-1.5 py-[1px] rounded text-[9px] font-medium ${
                                  c.phase === "inquiry"   ? "bg-amber-100 text-amber-800" :
                                  c.phase === "request"   ? "bg-blue-100 text-blue-800" :
                                  c.phase === "booked"    ? "bg-green-100 text-green-800" :
                                  c.phase === "cancelled" ? "bg-gray-200 text-gray-600" : ""
                                }`}
                              >
                                {c.phase === "inquiry" ? "INQUIRY"
                                  : c.phase === "request" ? "REQUEST"
                                  : c.phase === "booked" ? "BOOKED"
                                  : "CANCELLED"}
                              </span>
                            )}
                          </div>
                        </div>
                        {c.isUnread && <div className="w-2 h-2 rounded-full bg-primary shrink-0 mt-1" />}
                      </div>
                      {c.displayPreview && (
                        <p className="text-xs text-muted-foreground mt-1.5 line-clamp-2 ml-9">{c.displayPreview}</p>
                      )}
                      {c.displayTimestamp && (
                        <p className="text-[10px] text-muted-foreground mt-1 ml-9">
                          {new Date(c.displayTimestamp).toLocaleDateString()}
                        </p>
                      )}
                    </button>
                  );
                })}
                </TooltipProvider>
              </div>

              {/* Thread + Reply */}
              <div className="border rounded-lg bg-card flex flex-col">
                {!selectedConvId ? (
                  <div className="flex-1 flex items-center justify-center text-muted-foreground">
                    <div className="text-center">
                      <MessageSquare className="h-12 w-12 mx-auto mb-3 opacity-20" />
                      <p className="text-sm">Select a conversation to read and reply</p>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Thread header */}
                    <div className="px-5 py-3 border-b flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{selectedConv?.displayGuestName ?? "Guest"}</p>
                        <p className="text-xs text-muted-foreground truncate">{selectedConv?.displayListingName ?? "—"}</p>
                      </div>
                      {(() => {
                        const res = (selectedConv as any)?.meta?.reservations?.[0];
                        if (!res) return null;
                        return (
                          <div className="text-right text-xs text-muted-foreground shrink-0">
                            <div className="font-mono">{res.confirmationCode ?? ""}</div>
                            {res.checkIn && res.checkOut && (
                              <div>
                                {new Date(res.checkIn).toLocaleDateString([], { month: "short", day: "numeric" })}
                                {" → "}
                                {new Date(res.checkOut).toLocaleDateString([], { month: "short", day: "numeric" })}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>

                    {/* Messages — sorted oldest → newest, each with channel badge + full timestamp */}
                    <div ref={threadRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
                      {(threadLoading || postsLoading) && posts.length === 0 && (
                        <div className="text-center text-xs text-muted-foreground py-4">Loading messages…</div>
                      )}
                      {[...posts]
                        .sort((a: any, b: any) => {
                          const ta = new Date(a.sentAt ?? a.postedAt ?? a.createdAt ?? 0).getTime();
                          const tb = new Date(b.sentAt ?? b.postedAt ?? b.createdAt ?? 0).getTime();
                          return ta - tb; // ascending: oldest at top, newest at bottom
                        })
                        .map((p: any) => {
                          const bodyText = p.body ?? p.text ?? p.message ?? "";
                          const when = p.sentAt ?? p.postedAt ?? p.createdAt ?? "";
                          const isHost =
                            p.authorType === "host" ||
                            p.authorRole === "host" ||
                            p.senderType === "host" ||
                            p.direction === "outbound" ||
                            p.direction === "out" ||
                            p.isIncoming === false;
                          const channel = p.module?.type ?? p.type ?? p.integration?.platform ?? "";
                          return (
                            <div key={p._id} className={`flex flex-col ${isHost ? "items-end" : "items-start"}`}>
                              <div
                                className={`max-w-[78%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                                  isHost
                                    ? "bg-primary text-primary-foreground rounded-br-sm"
                                    : "bg-muted text-foreground rounded-bl-sm"
                                }`}
                                data-testid={`message-${p._id}`}
                              >
                                {bodyText}
                              </div>
                              {/* Timestamp + channel row, mirrors Guesty's portal */}
                              <div className="flex items-center gap-1.5 mt-1 text-[10px] text-muted-foreground px-1">
                                <span>{isHost ? "You" : (selectedConv?.displayGuestName ?? "Guest")}</span>
                                <span>·</span>
                                <span>{when ? new Date(when).toLocaleString([], { month: "2-digit", day: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit" }) : ""}</span>
                                {channel && (
                                  <>
                                    <span>·</span>
                                    {channelBadge(channel)}
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      {/* Thread debug: only shown when both queries settled and still no posts */}
                      {!threadLoading && !postsLoading && posts.length === 0 && (threadData || postsData) && (
                        <details className="text-[11px] font-mono bg-amber-50 border border-amber-200 rounded p-2" open>
                          <summary className="cursor-pointer font-semibold text-amber-800">🐞 No posts parsed — debug</summary>
                          <div className="mt-1 space-y-1 text-amber-900">
                            <div><b>postsData top-level keys:</b> {postsData ? `[${Object.keys(postsData as object).join(", ")}]` : "null"}</div>
                            {postsData && (postsData as any).data && typeof (postsData as any).data === "object" && (
                              <>
                                <div><b>postsData.data type:</b> {Array.isArray((postsData as any).data) ? `Array(${(postsData as any).data.length})` : typeof (postsData as any).data}</div>
                                {!Array.isArray((postsData as any).data) && (
                                  <div><b>postsData.data keys:</b> [{Object.keys((postsData as any).data).join(", ")}]</div>
                                )}
                              </>
                            )}
                            <details>
                              <summary className="cursor-pointer text-amber-700">Raw postsData (truncated)</summary>
                              <pre className="mt-1 p-2 bg-white rounded border overflow-auto max-h-60 text-[10px] whitespace-pre-wrap">
                                {JSON.stringify(postsData, null, 2)?.slice(0, 2500) ?? "null"}
                              </pre>
                            </details>
                          </div>
                        </details>
                      )}
                    </div>

                    {/* Reply compose. 10 rows by default fits a typical
                        AI-drafted 4-7 sentence reply without scrolling
                        for the signature; `resize-y` lets the operator
                        drag taller for long custom messages without
                        letting them drag horizontally (which would break
                        the column layout). */}
                    <div className="border-t px-4 py-3 space-y-2">
                      <Textarea
                        data-testid="textarea-reply"
                        placeholder="Write a reply…"
                        value={replyText}
                        onChange={e => setReplyText(e.target.value)}
                        rows={10}
                        className="resize-y min-h-[180px]"
                        onKeyDown={e => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && replyText.trim()) {
                            sendMessage.mutate();
                          }
                        }}
                      />
                      <div className="flex items-center gap-2 justify-end">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={generateDraft}
                          disabled={draftLoading}
                          data-testid="button-ai-draft"
                        >
                          <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                          {draftLoading ? "Drafting…" : "AI Draft"}
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => sendMessage.mutate()}
                          disabled={!replyText.trim() || sendMessage.isPending}
                          data-testid="button-send-reply"
                        >
                          <Send className="h-3.5 w-3.5 mr-1.5" />
                          Send
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Reservation detail panel (right column) */}
              <div className="border rounded-lg bg-card overflow-y-auto">
                {!selectedConv ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">
                    <Calendar className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    Select a conversation to see reservation details
                  </div>
                ) : (() => {
                  const meta = (selectedConv as any)?.meta ?? {};
                  const resStub = meta.reservations?.[0] ?? null;
                  // Full reservation has money breakdown; stub has just dates/status.
                  // unwrap Guesty's {status, data} wrapper
                  const resFull = reservationFull?.data ?? reservationFull ?? null;
                  const res = resFull ?? resStub;
                  const integration = meta.integration ?? {};
                  const guest = meta.guest ?? {};
                  const listing = res?.listing ?? resStub?.listing ?? {};
                  const channelRaw = integration.platform ?? res?.source ?? "";
                  const nights = res?.checkIn && res?.checkOut
                    ? Math.max(1, Math.round((new Date(res.checkOut).getTime() - new Date(res.checkIn).getTime()) / 86_400_000))
                    : null;

                  // ── Booking-status classification ──
                  // Airbnb statuses we might see:
                  //   inquiry         — guest asked a question, no booking request
                  //   request         — guest sent booking request, awaits host accept
                  //   accepted/reserved/confirmed — booked
                  //   canceled
                  // `preApproved` / `preApprovalStatus` on the reservation indicates
                  // the host has pre-approved on Airbnb.
                  const statusRaw = String(res?.status ?? "").toLowerCase();
                  const isAirbnb = channelRaw.toLowerCase().includes("airbnb");
                  // Guesty's actual field is `preApproveState` (boolean). Older
                  // accounts/docs also reference preApproved / preApprovalStatus,
                  // so we check all three.
                  const preApproved =
                    res?.preApproveState === true ||
                    res?.preApproved === true ||
                    String(res?.preApprovalStatus ?? "").toLowerCase() === "preapproved" ||
                    statusRaw.includes("preapproved") ||
                    statusRaw === "accepted";
                  const isInquiry = statusRaw === "inquiry" || statusRaw.includes("inquiry");
                  const isBookingRequest = statusRaw === "request" || statusRaw === "pending" || statusRaw === "awaitingpayment";
                  const isBooked = ["reserved", "confirmed", "accepted", "checked_in", "checkedin", "completed"].includes(statusRaw);
                  const isCancelled = statusRaw.includes("cancel");

                  let phase: "inquiry" | "request" | "booked" | "cancelled" | "other" = "other";
                  if (isCancelled) phase = "cancelled";
                  else if (isInquiry) phase = "inquiry";
                  else if (isBookingRequest) phase = "request";
                  else if (isBooked) phase = "booked";

                  // ── Money extraction (only meaningful when booked) ──
                  // Guesty reservation.money field names vary across API versions.
                  const m = res?.money ?? {};
                  const asNum = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? Number(v) || 0 : 0);
                  const guestGross   = asNum(m.fareAccommodation) + asNum(m.fareCleaning) + asNum(m.guestServiceFee) + asNum(m.totalTaxes) || asNum(m.totalPaid) || asNum(m.fare?.guestPrice);
                  const accommodation = asNum(m.fareAccommodation) || asNum(m.fare?.accommodationFare);
                  const cleaning     = asNum(m.fareCleaning);
                  const hostFee      = asNum(m.hostServiceFee);
                  const netPayout    = asNum(m.netIncome) || asNum(m.hostPayout) || Math.max(0, accommodation + cleaning - hostFee);
                  const hasMoney     = guestGross > 0 || netPayout > 0;

                  return (
                    <div className="p-4 space-y-4 text-sm">
                      {/* Booking phase banner */}
                      <div
                        className={`rounded-lg p-3 border ${
                          phase === "inquiry"
                            ? "bg-amber-50 border-amber-200"
                            : phase === "request"
                              ? "bg-blue-50 border-blue-200"
                              : phase === "booked"
                                ? "bg-green-50 border-green-200"
                                : phase === "cancelled"
                                  ? "bg-gray-100 border-gray-200"
                                  : "bg-muted border-border"
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-0.5">
                          {phase === "inquiry" && (
                            <>
                              <Badge className="bg-amber-500 text-white text-[10px]">Inquiry</Badge>
                              <span className="text-xs font-medium text-amber-900">Guest is asking a question</span>
                            </>
                          )}
                          {phase === "request" && (
                            <>
                              <Badge className="bg-blue-600 text-white text-[10px]">Booking request</Badge>
                              <span className="text-xs font-medium text-blue-900">Awaiting your response</span>
                            </>
                          )}
                          {phase === "booked" && (
                            <>
                              <Badge className="bg-green-600 text-white text-[10px]">Booked · {res?.status}</Badge>
                              {channelBadge(channelRaw)}
                            </>
                          )}
                          {phase === "cancelled" && <Badge variant="secondary" className="text-[10px]">Cancelled</Badge>}
                          {phase === "other" && <Badge variant="outline" className="text-[10px]">{res?.status ?? "Unknown"}</Badge>}
                        </div>

                        {/* Airbnb pre-approval — live action from the inbox */}
                        {isAirbnb && (phase === "inquiry" || phase === "request") && (
                          <div className="mt-2 text-[11px] leading-snug">
                            {preApproved ? (
                              <div className="flex items-start gap-2 p-2 rounded-md bg-green-100 border border-green-300">
                                <CheckCircle className="h-4 w-4 text-green-700 shrink-0 mt-0.5" />
                                <div>
                                  <div className="text-green-900 font-semibold text-xs">Pre-approved on Airbnb</div>
                                  <div className="text-green-800 text-[11px] mt-0.5">
                                    {guest.fullName ?? "Guest"} can book these dates without further host action.
                                    The amount they'll see is the listed rate.
                                  </div>
                                </div>
                              </div>
                            ) : (
                              <div className="text-amber-900 space-y-2">
                                <div>
                                  <span className="font-medium">Not yet pre-approved.</span>{" "}
                                  Airbnb inquiries should be pre-approved within 24h.
                                </div>
                                {res?._id && (
                                  <div className="flex flex-wrap gap-2">
                                    <Button
                                      size="sm"
                                      className="h-7 px-2.5 text-[11px] bg-green-600 hover:bg-green-700 text-white"
                                      onClick={() => preapproveAirbnb.mutate(res._id)}
                                      disabled={preapproveAirbnb.isPending}
                                      data-testid="button-preapprove-airbnb"
                                    >
                                      {preapproveAirbnb.isPending ? (
                                        <>
                                          <RefreshCw className="h-3 w-3 mr-1 animate-spin" /> Pre-approving…
                                        </>
                                      ) : (
                                        <>
                                          <CheckCircle className="h-3 w-3 mr-1" /> Pre-approve on Airbnb
                                        </>
                                      )}
                                    </Button>
                                    {/* Airbnb only allows API-driven decline
                                        for booking REQUESTS, not inquiries —
                                        Guesty returns "Reservation status is
                                        inquiry - can't decline" on the
                                        inquiry path. Inquiries auto-expire
                                        after 24h if you don't respond, so
                                        the right "no thanks" action on an
                                        inquiry is to either send a Special
                                        Offer at a number that works, send a
                                        polite reply, or just let it lapse.
                                        We hide the Decline button on
                                        inquiries to avoid the user clicking
                                        into a 502 from Guesty's API. */}
                                    {phase === "request" && (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-7 px-2.5 text-[11px]"
                                        onClick={() => {
                                          if (confirm(`Decline this Airbnb booking request from ${guest.fullName ?? "this guest"}? This action cannot be undone.`)) {
                                            declineAirbnb.mutate({ reservationId: res._id });
                                          }
                                        }}
                                        disabled={declineAirbnb.isPending}
                                        data-testid="button-decline-airbnb"
                                      >
                                        <XCircle className="h-3 w-3 mr-1" /> Decline
                                      </Button>
                                    )}
                                    <a
                                      href={`https://app.guesty.com/reservations/${res._id}`}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-primary hover:underline text-[11px] self-center"
                                    >
                                      Open in Guesty ↗
                                    </a>
                                  </div>
                                )}
                                {/* Inquiry-specific footnote — Airbnb's
                                    decline action is request-only, so we
                                    explain what to do with an inquiry the
                                    operator doesn't want to take instead
                                    of leaving a no-op Decline button. */}
                                {phase === "inquiry" && (
                                  <div className="text-[10px] text-amber-800/80 italic mt-1">
                                    Airbnb inquiries can't be declined — they auto-expire after 24h. To pass, send a Special Offer at a workable price or just let the inquiry lapse.
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Guest */}
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Guest</div>
                        <div className="mt-0.5 font-medium">{guest.fullName ?? selectedConv.displayGuestName}</div>
                        {guest.phone && <div className="text-xs text-muted-foreground">{guest.phone}</div>}
                        {guest.isReturning && <Badge variant="secondary" className="text-[10px] mt-1">Returning guest</Badge>}
                      </div>

                      {/* Listing */}
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Listing</div>
                        <div className="mt-0.5 flex gap-2">
                          {listing.picture?.thumbnail && (
                            <img src={listing.picture.thumbnail} alt="" className="h-12 w-12 rounded object-cover border" />
                          )}
                          <div className="min-w-0">
                            <div className="font-medium text-xs leading-tight">{listing.title ?? listing.nickname ?? "—"}</div>
                            {listing.address?.full && (
                              <div className="text-[11px] text-muted-foreground leading-tight mt-0.5">{listing.address.full}</div>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Dates */}
                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Check-in</div>
                          <div className="mt-0.5 font-medium text-xs">
                            {res?.checkIn ? new Date(res.checkIn).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : "—"}
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Check-out</div>
                          <div className="mt-0.5 font-medium text-xs">
                            {res?.checkOut ? new Date(res.checkOut).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : "—"}
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Nights</div>
                          <div className="mt-0.5 font-medium text-xs">{nights ?? "—"}</div>
                        </div>
                      </div>

                      {/* Quoted rate — what the GUEST sees on Airbnb for
                          this stay. Shown for inquiries and booking
                          requests (the cases where the host might
                          haggle); the booked-phase Financials block
                          below already covers the same numbers when
                          they're settled. Pull from the same `money`
                          shape used by Financials so the math stays
                          consistent. Hidden when guestGross is 0
                          (Guesty hasn't quoted yet). */}
                      {(phase === "inquiry" || phase === "request") && guestGross > 0 && (
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1 flex items-center justify-between">
                            <span>Quoted rate</span>
                            <span className="text-muted-foreground/70 font-normal normal-case tracking-normal">what guest sees</span>
                          </div>
                          <div className="border rounded-lg divide-y text-xs">
                            <div className="flex justify-between px-2.5 py-1.5">
                              <span className="text-muted-foreground">Total</span>
                              <span className="font-semibold">${guestGross.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                            </div>
                            {nights && nights > 0 && (
                              <div className="flex justify-between px-2.5 py-1.5">
                                <span className="text-muted-foreground">Per night</span>
                                <span>${Math.round(guestGross / nights).toLocaleString()}</span>
                              </div>
                            )}
                          </div>
                          {isAirbnb && res?._id && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 mt-2 px-2.5 text-[11px] w-full"
                              onClick={() => {
                                setSpecialOfferDialog({ open: true, reservationId: res._id, currentTotal: guestGross });
                                setSpecialOfferPrice(String(Math.round(guestGross)));
                                setSpecialOfferMessage("");
                              }}
                              data-testid="button-special-offer-airbnb"
                            >
                              <DollarSign className="h-3 w-3 mr-1" /> Send Special Offer
                            </Button>
                          )}
                        </div>
                      )}

                      {/* Financials — only for booked reservations */}
                      {phase === "booked" && (
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">
                            Financials
                          </div>
                          {hasMoney ? (
                            <div className="border rounded-lg divide-y text-xs">
                              {guestGross > 0 && (
                                <div className="flex justify-between px-2.5 py-1.5">
                                  <span className="text-muted-foreground">Guest paid (gross)</span>
                                  <span className="font-medium">${guestGross.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                                </div>
                              )}
                              {accommodation > 0 && (
                                <div className="flex justify-between px-2.5 py-1.5">
                                  <span className="text-muted-foreground pl-2">Accommodation</span>
                                  <span>${accommodation.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                                </div>
                              )}
                              {cleaning > 0 && (
                                <div className="flex justify-between px-2.5 py-1.5">
                                  <span className="text-muted-foreground pl-2">Cleaning</span>
                                  <span>${cleaning.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                                </div>
                              )}
                              {hostFee > 0 && (
                                <div className="flex justify-between px-2.5 py-1.5 text-red-700">
                                  <span>− {channelRaw.includes("airbnb") ? "Airbnb" : "Channel"} host fee</span>
                                  <span>−${hostFee.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                                </div>
                              )}
                              <div className="flex justify-between px-2.5 py-2 bg-green-50 dark:bg-green-950/20 font-semibold">
                                <span className="text-green-800">Net to your bank</span>
                                <span className="text-green-800">${netPayout.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                              </div>
                              {nights && netPayout > 0 && (
                                <div className="flex justify-between px-2.5 py-1.5 text-[11px] text-muted-foreground">
                                  <span>Per night (net)</span>
                                  <span>${Math.round(netPayout / nights).toLocaleString()}</span>
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="text-xs text-muted-foreground italic">Loading money details…</div>
                          )}
                        </div>
                      )}

                      {/* Confirmation code + Guesty deep link */}
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Confirmation</div>
                        <div className="mt-0.5 font-mono text-xs">{res?.confirmationCode ?? "—"}</div>
                        {res?._id && (
                          <a
                            href={`https://app.guesty.com/reservations/${res._id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[11px] text-primary hover:underline mt-1 inline-block"
                          >
                            Open in Guesty ↗
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          </TabsContent>

          {/* ── RESERVATIONS TAB ── */}
          <TabsContent value="reservations" className="space-y-6">
            {/* Auto-approve banner */}
            <Card>
              <CardContent className="py-4">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div className="flex items-center gap-3">
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center ${autoApproveStatus?.enabled ? "bg-green-100 text-green-700" : "bg-muted text-muted-foreground"}`}>
                      <Zap className="h-4 w-4" />
                    </div>
                    <div>
                      <p className="font-medium text-sm">Auto-Approve Airbnb Requests</p>
                      <p className="text-xs text-muted-foreground">
                        {autoApproveStatus?.enabled
                          ? `Active · Checks every 15 min${autoApproveStatus?.lastRunAt ? ` · Last run: ${new Date(autoApproveStatus.lastRunAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}`
                          : "Paused — new Airbnb requests will not be auto-confirmed"}
                      </p>
                      {autoApproveStatus?.lastRunResult?.message && (
                        <p className="text-xs text-muted-foreground mt-0.5 italic">{autoApproveStatus.lastRunResult.message}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Switch
                      id="auto-approve-toggle"
                      checked={autoApproveStatus?.enabled ?? true}
                      onCheckedChange={v => toggleAutoApprove.mutate(v)}
                      disabled={autoLoading}
                      data-testid="switch-auto-approve"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => runAutoApprove.mutate()}
                      disabled={runAutoApprove.isPending}
                      data-testid="button-run-auto-approve"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${runAutoApprove.isPending ? "animate-spin" : ""}`} />
                      Run Now
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Pending requests */}
            <div>
              <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-amber-500" />
                Pending Requests
                {pendingRes.length > 0 && <Badge className="bg-amber-500 text-white">{pendingRes.length}</Badge>}
              </h2>
              {pendingLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
              {!pendingLoading && pendingRes.length === 0 && (
                <div className="border rounded-lg p-6 text-center text-sm text-muted-foreground bg-card">
                  <CheckCircle className="h-8 w-8 mx-auto mb-2 text-green-500 opacity-60" />
                  No pending requests — you're all caught up!
                </div>
              )}
              <div className="space-y-3">
                {pendingRes.map(r => (
                  <Card key={r._id} data-testid={`reservation-pending-${r._id}`}>
                    <CardContent className="py-4">
                      <div className="flex items-center justify-between gap-4 flex-wrap">
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-2">
                            <p className="font-medium">{r.guestName ?? "Guest"}</p>
                            {platformBadge(r)}
                          </div>
                          <p className="text-sm text-muted-foreground">{r.listingNickname ?? "—"}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatDate(r.checkInDateLocalized ?? r.checkIn)} → {formatDate(r.checkOutDateLocalized ?? r.checkOut)}
                            {r.nightsCount ? ` · ${r.nightsCount} nights` : ""}
                          </p>
                          {r.confirmationCode && (
                            <p className="text-xs font-mono text-muted-foreground">#{r.confirmationCode}</p>
                          )}
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-red-600 border-red-200 hover:bg-red-50"
                            onClick={() => declineReservation.mutate(r._id)}
                            disabled={declineReservation.isPending}
                            data-testid={`button-decline-${r._id}`}
                          >
                            <XCircle className="h-3.5 w-3.5 mr-1" /> Decline
                          </Button>
                          <Button
                            size="sm"
                            className="bg-green-600 hover:bg-green-700 text-white"
                            onClick={() => approveReservation.mutate(r._id)}
                            disabled={approveReservation.isPending}
                            data-testid={`button-approve-${r._id}`}
                          >
                            <CheckCircle className="h-3.5 w-3.5 mr-1" /> Approve
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>

            {/* Upcoming confirmed */}
            <div>
              <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <Clock className="h-4 w-4 text-blue-500" />
                Upcoming Confirmed Reservations
              </h2>
              {upcomingRes.length === 0 && (
                <div className="border rounded-lg p-6 text-center text-sm text-muted-foreground bg-card">
                  No upcoming reservations found
                </div>
              )}
              <div className="space-y-2">
                {upcomingRes.map(r => (
                  <Card key={r._id} data-testid={`reservation-upcoming-${r._id}`}>
                    <CardContent className="py-3">
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                            <User className="h-3.5 w-3.5 text-blue-600" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-medium text-sm">{r.guestName ?? "Guest"}</p>
                              {platformBadge(r)}
                            </div>
                            <p className="text-xs text-muted-foreground">{r.listingNickname ?? "—"}</p>
                          </div>
                        </div>
                        <div className="text-right text-xs text-muted-foreground">
                          <p>{formatDate(r.checkInDateLocalized ?? r.checkIn)} → {formatDate(r.checkOutDateLocalized ?? r.checkOut)}</p>
                          {r.nightsCount && <p>{r.nightsCount} nights</p>}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          </TabsContent>

          {/* ── AUTO-MESSAGES TAB ── */}
          <TabsContent value="auto-messages" className="space-y-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-semibold">Automated Message Templates</h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Templates are sent automatically based on reservation events. Use merge tags like <code className="text-xs bg-muted px-1 rounded">{"{guest_name}"}</code> for personalization.
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                {templates.length === 0 && !templatesLoading && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={addDefaultTemplates}
                    data-testid="button-add-defaults"
                  >
                    <Zap className="h-3.5 w-3.5 mr-1.5" /> Load Defaults
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={() => setTemplateDialog({ open: true, template: {} })}
                  data-testid="button-new-template"
                >
                  <Plus className="h-3.5 w-3.5 mr-1.5" /> New Template
                </Button>
              </div>
            </div>

            {/* Merge tag reference */}
            <Card className="bg-muted/30">
              <CardContent className="py-3">
                <p className="text-xs font-medium mb-1.5">Available Merge Tags:</p>
                <div className="flex flex-wrap gap-1.5">
                  {MERGE_TAGS.map(tag => (
                    <code key={tag} className="text-[11px] bg-background border px-1.5 py-0.5 rounded font-mono">{tag}</code>
                  ))}
                </div>
              </CardContent>
            </Card>

            {templatesLoading && <p className="text-sm text-muted-foreground">Loading templates…</p>}

            {!templatesLoading && templates.length === 0 && (
              <div className="border rounded-lg p-8 text-center bg-card">
                <Zap className="h-10 w-10 mx-auto mb-3 opacity-20" />
                <p className="font-medium mb-1">No templates yet</p>
                <p className="text-sm text-muted-foreground mb-4">
                  Load the default templates to get started, or create your own.
                </p>
                <Button onClick={addDefaultTemplates} data-testid="button-load-defaults-empty">
                  <Zap className="h-4 w-4 mr-1.5" /> Load Default Templates
                </Button>
              </div>
            )}

            <div className="space-y-3">
              {templates.map(t => (
                <Card key={t.id} data-testid={`template-card-${t.id}`} className={!t.isActive ? "opacity-60" : ""}>
                  <CardContent className="py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-3 min-w-0">
                        <Switch
                          checked={t.isActive}
                          onCheckedChange={() => toggleTemplate(t)}
                          data-testid={`switch-template-${t.id}`}
                        />
                        <div className="min-w-0">
                          <p className="font-medium text-sm">{t.name}</p>
                          <Badge variant="outline" className="text-[10px] mt-0.5">
                            <Clock className="h-2.5 w-2.5 mr-1" />
                            {triggerLabel(t.trigger, t.daysOffset)}
                          </Badge>
                          <p className="text-xs text-muted-foreground mt-2 line-clamp-2 whitespace-pre-wrap">
                            {t.body}
                          </p>
                        </div>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => setTemplateDialog({ open: true, template: t })}
                          data-testid={`button-edit-template-${t.id}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-red-500 hover:text-red-600"
                          onClick={() => deleteTemplate.mutate(t.id)}
                          data-testid={`button-delete-template-${t.id}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          {/* ── AUTO-REPLY TAB ── */}
          <TabsContent value="auto-reply" className="space-y-6">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Bot className="h-5 w-5" /> AI Auto-Reply Agent
                    </CardTitle>
                    <CardDescription className="mt-1">
                      Polls Guesty every 5 minutes. Uses Claude with listing/reservation tools to draft and send replies automatically. Risky messages (refund, cancel, damage, medical, legal) are drafted for human review instead of auto-sent.
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="auto-reply-toggle"
                      checked={!!autoReplyStatus?.enabled}
                      onCheckedChange={(v) => toggleAutoReply.mutate(v)}
                      data-testid="switch-auto-reply"
                    />
                    <Label htmlFor="auto-reply-toggle" className="text-sm cursor-pointer">
                      {autoReplyStatus?.enabled ? "Enabled" : "Disabled"}
                    </Label>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => runAutoReply.mutate()}
                    disabled={runAutoReply.isPending}
                    data-testid="button-run-auto-reply"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${runAutoReply.isPending ? "animate-spin" : ""}`} />
                    Run Now
                  </Button>
                  {autoReplyStatus?.lastRunAt && (
                    <span className="text-xs text-muted-foreground">
                      Last run: {new Date(autoReplyStatus.lastRunAt).toLocaleString()}
                      {autoReplyStatus.lastRunResult?.message && ` — ${autoReplyStatus.lastRunResult.message}`}
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>

            <div>
              <h3 className="font-semibold mb-3">Recent Activity</h3>
              {logsLoading && <p className="text-sm text-muted-foreground">Loading logs…</p>}
              {!logsLoading && autoReplyLogs.length === 0 && (
                <div className="border rounded-lg p-8 text-center bg-card">
                  <Bot className="h-10 w-10 mx-auto mb-3 opacity-20" />
                  <p className="font-medium mb-1">No activity yet</p>
                  <p className="text-sm text-muted-foreground">
                    The agent will log every reply attempt here. Click "Run Now" to trigger a poll.
                  </p>
                </div>
              )}
              <div className="space-y-3">
                {autoReplyLogs.map((log: any) => (
                  <Card key={log.id} data-testid={`auto-reply-log-${log.id}`}>
                    <CardContent className="py-4">
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm">{log.guestName ?? "Guest"}</span>
                            {log.channel && (
                              <Badge variant="outline" className="text-[10px]">{log.channel}</Badge>
                            )}
                            {log.status === "sent" && (
                              <Badge className="bg-green-600 text-white text-[10px]">
                                <CheckCircle className="h-2.5 w-2.5 mr-1" /> Sent
                              </Badge>
                            )}
                            {log.status === "drafted" && (
                              <Badge className="bg-blue-600 text-white text-[10px]">
                                <Pencil className="h-2.5 w-2.5 mr-1" /> Drafted
                              </Badge>
                            )}
                            {log.status === "flagged" && (
                              <Badge className="bg-amber-500 text-white text-[10px]">
                                <Flag className="h-2.5 w-2.5 mr-1" /> Flagged
                              </Badge>
                            )}
                            {log.status === "dismissed" && (
                              <Badge variant="secondary" className="text-[10px]">Dismissed</Badge>
                            )}
                            {log.status === "error" && (
                              <Badge variant="destructive" className="text-[10px]">
                                <AlertCircle className="h-2.5 w-2.5 mr-1" /> Error
                              </Badge>
                            )}
                          </div>
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            {log.createdAt ? new Date(log.createdAt).toLocaleString() : ""}
                            {log.listingId && ` · listing ${log.listingId}`}
                          </p>
                        </div>
                      </div>

                      <div className="space-y-2 text-sm">
                        <div>
                          <p className="text-[11px] font-medium text-muted-foreground mb-0.5">GUEST SAID</p>
                          <p className="bg-muted/40 rounded px-3 py-2 whitespace-pre-wrap text-[13px]">{log.guestMessage}</p>
                        </div>

                        {log.replyDraft && (
                          <div>
                            <p className="text-[11px] font-medium text-muted-foreground mb-0.5">
                              {log.replySent ? "REPLY SENT" : "DRAFT"}
                            </p>
                            <p className="bg-primary/5 border border-primary/20 rounded px-3 py-2 whitespace-pre-wrap text-[13px]">{log.replyDraft}</p>
                          </div>
                        )}

                        {log.flagReason && (
                          <p className="text-xs text-amber-700 dark:text-amber-400">
                            <Flag className="h-3 w-3 inline mr-1" /> {log.flagReason}
                          </p>
                        )}
                        {log.errorMessage && (
                          <p className="text-xs text-red-600 dark:text-red-400">
                            <AlertCircle className="h-3 w-3 inline mr-1" /> {log.errorMessage}
                          </p>
                        )}
                      </div>

                      {!log.replySent && log.replyDraft && log.status !== "dismissed" && (
                        <div className="flex gap-2 mt-3 pt-3 border-t">
                          <Button
                            size="sm"
                            onClick={() => sendDraftReply.mutate(log.id)}
                            disabled={sendDraftReply.isPending}
                            data-testid={`button-send-draft-${log.id}`}
                          >
                            <Send className="h-3.5 w-3.5 mr-1.5" /> Send Reply
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => dismissDraft.mutate(log.id)}
                            disabled={dismissDraft.isPending}
                            data-testid={`button-dismiss-draft-${log.id}`}
                          >
                            <X className="h-3.5 w-3.5 mr-1.5" /> Dismiss
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* Template editor dialog */}
      <Dialog open={templateDialog.open} onOpenChange={open => !open && setTemplateDialog({ open: false, template: null })}>
        <TemplateEditor
          template={templateDialog.template}
          onSave={saveTemplate}
          onClose={() => setTemplateDialog({ open: false, template: null })}
        />
      </Dialog>

      {/* Special-offer dialog. Pre-populated with the current Airbnb-
          quoted total so the host just types the new total they're
          willing to take. Fires the same `callGuestyAirbnbAction`
          server path as pre-approve / decline (which now verifies
          every candidate per PR #99). */}
      <Dialog
        open={specialOfferDialog.open}
        onOpenChange={(open) => {
          if (!open) {
            setSpecialOfferDialog({ open: false, reservationId: null, currentTotal: 0 });
            setSpecialOfferPrice("");
            setSpecialOfferMessage("");
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Send Special Offer on Airbnb</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div>
              <Label htmlFor="special-offer-price">New total guest price (USD)</Label>
              <Input
                id="special-offer-price"
                type="number"
                min={1}
                step={1}
                value={specialOfferPrice}
                onChange={(e) => setSpecialOfferPrice(e.target.value)}
                placeholder="7000"
                data-testid="input-special-offer-price"
              />
              {specialOfferDialog.currentTotal > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  Currently quoted to guest: ${specialOfferDialog.currentTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}.
                  This is the total before Airbnb's guest service fee — Airbnb adds their fee on top of whatever you set here.
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="special-offer-message">Message to guest (optional)</Label>
              <Textarea
                id="special-offer-message"
                value={specialOfferMessage}
                onChange={(e) => setSpecialOfferMessage(e.target.value)}
                rows={3}
                placeholder="A short note explaining the offer (optional)."
                data-testid="textarea-special-offer-message"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setSpecialOfferDialog({ open: false, reservationId: null, currentTotal: 0 });
                setSpecialOfferPrice("");
                setSpecialOfferMessage("");
              }}
              data-testid="button-special-offer-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                const price = parseFloat(specialOfferPrice);
                if (!Number.isFinite(price) || price <= 0) {
                  toast({ title: "Enter a valid price greater than 0", variant: "destructive" });
                  return;
                }
                if (!specialOfferDialog.reservationId) return;
                sendSpecialOffer.mutate({
                  reservationId: specialOfferDialog.reservationId,
                  price,
                  message: specialOfferMessage.trim() || undefined,
                });
              }}
              disabled={sendSpecialOffer.isPending || !specialOfferPrice}
              data-testid="button-special-offer-send"
            >
              {sendSpecialOffer.isPending ? (
                <>
                  <RefreshCw className="h-3 w-3 mr-1 animate-spin" /> Sending…
                </>
              ) : (
                <>
                  <Send className="h-3 w-3 mr-1" /> Send Special Offer
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
