import { useState, useRef, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
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
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel,
  ContextMenuSeparator, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useToast } from "@/hooks/use-toast";
import {
  aliasAttachmentHref,
  filesToAliasEmailAttachments,
  formatAttachmentSize,
  parseAliasEmailAttachments,
  type AliasEmailAttachment,
} from "@/lib/emailAttachments";
import {
  ArrowLeft, MessageSquare, Calendar, Zap, Send, Sparkles, Plus, Pencil,
  Trash2, CheckCircle, XCircle, RefreshCw, Clock, User, Building2, AlertCircle,
  ToggleRight, X, ShieldAlert, MessageCircle, DollarSign,
  FileText, Mail, ShieldCheck, Paperclip, PhoneCall, PhoneMissed, Voicemail,
  Search, Loader2, ExternalLink, Copy, Link2, MailOpen, Reply,
} from "lucide-react";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import type { MessageTemplate } from "@shared/schema";
import { autoReplyTierBadge, type AutoReplyTierBadge } from "@shared/guest-question-tier";
import { GuestIssuesPanel, GuestIssuesTab } from "@/components/GuestIssuesPanel";
import { getUnitBuilderByPropertyId } from "@/data/unit-builder-data";
import { getGuestyAmenities, getAmenityLabel } from "@/data/guesty-amenities";
import { fallbackWalkForResort } from "@shared/walking-distance";
import { resolveIslandRegion } from "@shared/area-identity";
import { AGENT_COMPOSE_SEED, AGENT_REPLY_SIGNOFF } from "@shared/agent-identity";
import { buildArrivalDetailsGuestMessage, looksLikeArrivalDetailsMessage, type ArrivalUnitDetail } from "@shared/arrival-details-message";
import { bodyWithoutAttachmentUrls, collectPostAttachments, type PostAttachment } from "@shared/guesty-post-attachments";
import { vendorVisibleEmailAddresses, replySubjectForBuyInEmail, replyRecipientForBuyInEmail } from "@shared/buy-in-email-display";
import { guestPartyFromReservation, formatGuestParty } from "@shared/guest-party";
import { formatEmailBodyForDisplay, formatEmailTimestampForDisplay } from "@shared/email-body-format";
import { usePortalSession } from "@/lib/auth";
import { useAssistantContext } from "@/lib/assistant-context";
import { setInboxUnreadCount } from "@/lib/inboxUnreadStore";
import {
  INBOX_READ_OVERRIDE_STORAGE_KEY,
  parseStoredInboxReadOverrides,
  type InboxReadOverride as SharedInboxReadOverride,
} from "@shared/inbox-unread-count";

type InboxBuyInRecord = ArrivalUnitDetail & {
  propertyName?: string;
  checkIn?: string;
  checkOut?: string;
  managementCompany?: string;
  managementContact?: string;
};

type InboxVendorContactRecord = {
  id: number;
  buyInId: number;
  vendorName?: string | null;
  vendorEmail: string;
  reverseAliasEmail?: string | null;
};

type InboxBuyInCommunications = {
  alias: { aliasEmail: string; mailboxEmail: string; status?: string | null; expiresAt?: string | null } | null;
  // Per-unit guest aliases (one per buy-in); back-compat `alias` is the reservation-level fallback.
  aliases?: Array<{ buyInId?: number | null; aliasEmail: string }>;
  buyIns: InboxBuyInRecord[];
  contacts: InboxVendorContactRecord[];
  emails: Array<{
    id: number;
    buyInId: number;
    direction: "outbound" | "inbound" | string;
    fromEmail: string;
    toEmail: string;
    subject: string;
    body: string;
    attachmentsJson?: string | null;
    status?: string | null;
    sentAt?: string | null;
  }>;
};

type InboxRentalAgreement = {
  agreement: {
    id: number;
    token: string;
    status: string;
    signingUrl?: string;
    signedName?: string | null;
    signedAt?: string | null;
  } | null;
};

type QuoCallEvent = {
  id: number;
  providerCallId: string;
  conversationId?: string | null;
  reservationId?: string | null;
  guestName?: string | null;
  guestPhone: string;
  fromNumber: string;
  toNumber: string;
  direction: "inbound" | "outbound" | string;
  status?: string | null;
  disposition: "answered" | "missed" | "voicemail" | "unknown" | string;
  durationSeconds?: number | null;
  matchStrategy?: string | null;
  matchConfidence?: string | null;
  voicemailRecordingUrl?: string | null;
  voicemailTranscript?: string | null;
  voicemailDurationSeconds?: number | null;
  callStartedAt?: string | null;
  callCompletedAt?: string | null;
  acknowledgedAt?: string | null;
  createdAt?: string | null;
};

type GuestInboxInternalNote = {
  id: number;
  conversationId: string;
  reservationId?: string | null;
  guestName?: string | null;
  guestPhone?: string | null;
  note: string;
  source: string;
  createdBy: string;
  createdAt: string;
};

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
    // AREA anchor for local-area / recommendation answers (see the EXPERT LOCAL
    // KNOWLEDGE guardrails in the system prompt). Island/region is resolved
    // deterministically from the address so the AI never gives a wrong-island answer.
    const island = resolveIslandRegion(prop.address);
    if (island) parts.push(`AREA: ${prop.complexName} — ${island}`);
    if (prop.propertyType) {
      // propertyType is load-bearing for accessibility questions —
      // a Townhouse is multi-story, while a Condominium is usually
      // single-level INSIDE the condo. Do not let the AI conflate
      // that with ground-floor / bottom-floor building access.
      parts.push(`Property type: ${prop.propertyType}${prop.propertyType === "Townhouse" ? " (multi-story attached units, has internal stairs)" : prop.propertyType === "Condominium" ? " (single-level inside the condo; this does NOT mean ground-floor or bottom-floor access)" : ""}`);
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
    // Surrounding-area facts so the AI can ground local-area answers (beaches,
    // dining, getting around) instead of inventing them. Previously omitted —
    // the auto-reply tool already exposed these, so this closes that gap.
    if (prop.neighborhood) parts.push(`\nNEIGHBORHOOD: ${prop.neighborhood}`);
    if (prop.transit) parts.push(`\nGETTING AROUND: ${prop.transit}`);
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
  conversationChannel?: string;
}

type GuestyModule = { type?: string; [k: string]: unknown };

interface GuestyPost {
  _id: string;
  body?: string;
  text?: string;
  message?: string;
  sentAt?: string;
  postedAt?: string;
  createdAt?: string;
  authorType?: string;
  authorRole?: string;
  sentBy?: string;
  direction?: string;
  isIncoming?: boolean;
  module?: GuestyModule;
  // Guest photo/file attachments (VRBO/Airbnb/Booking messages can carry
  // these). Shapes vary by channel — parsed by collectPostAttachments.
  attachments?: unknown;
  media?: unknown;
  images?: unknown;
  files?: unknown;
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
  cancellationPolicy?: string | null;
  cancellationPolicySummary?: string | null;
  cancellationPolicyFreeCancellationUntil?: string | null;
  cancellationPolicyPenalty?: string | null;
  cancellationPolicyDetailsAvailable?: boolean;
  cancellationPolicySource?: string | null;
  cancellationPolicyAssumed?: boolean;
  listing?: Record<string, unknown>;
  nightsCount?: number;
  createdAt?: string;
  confirmedAt?: string;
}

const TRIGGER_OPTIONS = [
  { value: "booking_confirmed",    label: "When booking is confirmed" },
  { value: "days_after_booking",   label: "X days after booking" },
  { value: "days_before_checkin",  label: "X days before check-in" },
  { value: "day_of_checkin",       label: "Day of check-in" },
  { value: "days_before_checkout", label: "X days before check-out" },
  { value: "days_after_checkout",  label: "X days after check-out" },
];

const MERGE_TAGS = [
  // {greeting}     → "Aloha [name]," for Hawaii stays, "Hi [name]," for mainland.
  // {signoff}      → "Mahalo," / "Thanks," + the sender + brand block (full messages).
  // {signoff_sms}  → "Mahalo, John" / "Thanks, John" (one line, for SMS).
  // These carry the region-aware voice so a single template reads correctly for
  // both a Hawaii and a Florida property.
  "{greeting}", "{signoff}", "{signoff_sms}",
  "{guest_name}", "{property_name}", "{check_in_date}", "{check_out_date}",
  "{confirmation_code}", "{num_nights}",
];

const GUESTY_VARIABLE_PATTERN = /\{\{[^}]+\}\}/;
const SMS_PLACEHOLDER_PATTERN = /\[(?:PASTE|ADD) [^\]]+\]/i;

const TEMPLATE_CHANNEL_OPTIONS = [
  { value: "guesty", label: "Guesty / OTA / email" },
  { value: "sms", label: "Text message" },
];

function templateChannelLabel(channel?: string): string {
  return channel === "sms" ? "Text message" : "Guesty / OTA / email";
}

function templateChannelBadgeVariant(channel?: string): "default" | "secondary" | "outline" {
  return channel === "sms" ? "secondary" : "outline";
}

function extractUrlsFromText(value: string): string[] {
  return Array.from(value.matchAll(/https?:\/\/[^\s<>"')]+/gi)).map((match) =>
    match[0].replace(/[.,;:!?]+$/, ""),
  );
}

function findRelevantThreadUrl(posts: GuestyPost[], kind: "prearrival" | "payment"): string {
  const urlRows = posts
    .map((p) => cleanMessageBody(p.body ?? p.text ?? (p as any).message ?? ""))
    .flatMap((body) => extractUrlsFromText(body).map((url) => ({ body: body.toLowerCase(), url })));
  const preferred = urlRows.find(({ body, url }) => {
    const urlLower = url.toLowerCase();
    if (kind === "prearrival") {
      return /guest-app|check[- ]?in|pre[- ]?arrival|rental agreement|agreement/.test(body) ||
        /guest-app|guesty/.test(urlLower);
    }
    return /invoice|payment|balance|card/.test(body) || /invoice|payment|checkout|pay/.test(urlLower);
  });
  return preferred?.url ?? urlRows[0]?.url ?? "";
}

// Static seed templates for the Auto-Messages tab. The {greeting} and {signoff}
// merge tags carry the region-aware voice: {greeting} renders as "Aloha [name],"
// for Hawaii stays and "Hi [name]," for mainland (e.g. Florida) stays, and
// {signoff} renders the matching "Mahalo," / "Thanks," + sender + brand block.
// SMS templates close with "{signoff_sms}" (one line, first name only). Keeping
// the voice in merge tags means one template reads correctly for both islands
// and the mainland — the same fill-at-send pattern as {guest_name}.
const DEFAULT_TEMPLATES: Omit<MessageTemplate, "id" | "createdAt">[] = [
  {
    name: "Booking Confirmation / Next Steps",
    deliveryChannel: "guesty",
    trigger: "booking_confirmed",
    daysOffset: 0,
    isActive: true,
    body: `{greeting}

Wonderful news — your reservation at {property_name} for {check_in_date} through {check_out_date} ({num_nights} nights) is confirmed, and we are so glad to have you with us.

Confirmation code: {confirmation_code}

Your stay is set up as two units that are only minutes apart, and we will share a few more details about that setup in a follow-up note.

We will send your detailed arrival and access information 14 days before check-in. If any questions come up before then, just reply here — we are happy to help.

{signoff}`,
  },
  {
    name: "Unit Setup Confirmation",
    deliveryChannel: "guesty",
    trigger: "days_after_booking",
    daysOffset: 1,
    isActive: true,
    body: `{greeting}

I wanted to share a quick note about your upcoming stay at {property_name} so everything feels clear before you arrive.

Your reservation is set up as two nearby units that are only minutes from each other. The listing photos are representative of the resort/community and unit style. Your assigned units will match the bedroom count and overall property standard, though exact interiors, furnishings, views, and layouts can vary slightly by unit.

Your arrival details will arrive about 14 days before check-in. Until then, please feel free to message me with any questions at all.

{signoff}`,
  },
  {
    name: "Internal Rental Agreement Request",
    deliveryChannel: "guesty",
    trigger: "days_after_booking",
    daysOffset: 0,
    isActive: false,
    body: `{greeting}

As we get your stay at {property_name} ready, please have the primary guest review and sign our secure rental agreement.

You can complete it here:
[agreement link]

This confirms the booking details, house rules, authorized guest, signed rental agreement, and two-separate-units acknowledgment before arrival. For your security, please do not send credit card details in this message thread.

Once that is done, you are all set, and we will send your final arrival/access details 14 days before check-in.

{signoff}`,
  },
  {
    name: "Guesty Invoice / Payment Method Request",
    deliveryChannel: "guesty",
    trigger: "days_after_booking",
    daysOffset: 0,
    isActive: true,
    body: `{greeting}

When you have a moment, please use the secure Guesty invoice link below to add your payment method or complete any remaining balance for your stay at {property_name}.

{{guest_invoice}}

For your security, please do not send credit card details in this message thread.

{signoff}`,
  },
  {
    name: "SMS: Rental Agreement",
    deliveryChannel: "sms",
    trigger: "days_after_booking",
    daysOffset: 0,
    isActive: false,
    body: `{greeting} please review and sign the secure rental agreement for {property_name}: [agreement link]

This covers the rental agreement, two-unit acknowledgment, and arrival requirements. Please do not text card details. {signoff_sms}`,
  },
  {
    name: "SMS: Reminder to Sign Rental Agreement",
    deliveryChannel: "sms",
    trigger: "days_after_booking",
    daysOffset: 1,
    isActive: false,
    body: `{greeting} just a friendly reminder to sign the secure rental agreement for {property_name}: [agreement link]

Once that is complete, you are all set for the next step. {signoff_sms}`,
  },
  {
    name: "SMS: Secure Payment Link",
    deliveryChannel: "sms",
    trigger: "days_after_booking",
    daysOffset: 0,
    isActive: false,
    body: `{greeting} I sent the secure Guesty payment request for {property_name} in the booking thread/email. Please use that secure link to add your payment method or complete any remaining balance.

Please do not text card details. {signoff_sms}`,
  },
  {
    name: "14-Day Arrival Details",
    deliveryChannel: "guesty",
    trigger: "days_before_checkin",
    daysOffset: 14,
    isActive: true,
    body: `{greeting}

Your stay at {property_name} is coming up, so I wanted to send your arrival details.

Check-in date: {check_in_date}
Confirmation code: {confirmation_code}

Address / access code / parking / Wi-Fi:
[INSERT UNIT DETAILS]

Please reply here if anything looks unclear before arrival — we are glad to help.

{signoff}`,
  },
  {
    name: "Parking + Travel Reminder",
    deliveryChannel: "guesty",
    trigger: "days_before_checkin",
    daysOffset: 3,
    isActive: true,
    body: `{greeting}

Your stay at {property_name} is just a few days away — we cannot wait to host you. A few quick reminders before travel day:

- Please review your arrival/access details before you leave.
- Bring any parking or gate information with you.
- For restaurants, beaches, groceries, and local activities, reservations can be helpful during busy weeks.

If you would like recommendations near the property, just reply here — I am always happy to share favorites.

{signoff}`,
  },
  {
    name: "SMS: Arrival Details Reminder",
    deliveryChannel: "sms",
    trigger: "days_before_checkin",
    daysOffset: 14,
    isActive: true,
    body: `{greeting} your arrival details for {property_name} have been sent in the booking thread/email. Please review them before travel day and reply here if anything looks unclear. {signoff_sms}`,
  },
  {
    name: "SMS: Day-Of Arrival Help",
    deliveryChannel: "sms",
    trigger: "day_of_checkin",
    daysOffset: 0,
    isActive: true,
    body: `{greeting} I hope your travel day is going smoothly. Your arrival details were sent in the booking thread/email. Reply here if you need any help with access or parking. {signoff_sms}`,
  },
  {
    name: "Day-Before Final Check-In",
    deliveryChannel: "guesty",
    trigger: "days_before_checkin",
    daysOffset: 1,
    isActive: true,
    body: `{greeting}

Your check-in for {property_name} is tomorrow, and we are looking forward to welcoming you. Please keep your arrival details handy, including the address, access code, parking information, and Wi-Fi details.

Confirmation code: {confirmation_code}

Safe travels, and please reply here if anything comes up.

{signoff}`,
  },
  {
    name: "Post-Stay Thank You / Review Request",
    deliveryChannel: "guesty",
    trigger: "days_after_checkout",
    daysOffset: 2,
    isActive: true,
    body: `{greeting}

Thank you so much for staying at {property_name}. It was a pleasure to host you, and I hope you had a wonderful trip.

If you have a moment, we would truly appreciate a review. It helps future guests feel confident booking and means the world to us.

We would love to welcome you back anytime.

{signoff}`,
  },
  {
    name: "SMS: Post-Stay Review Request",
    deliveryChannel: "sms",
    trigger: "days_after_checkout",
    daysOffset: 2,
    isActive: true,
    body: `{greeting} thank you so much for staying at {property_name}. If you have a moment, we would truly appreciate a review. We would love to host you again anytime. {signoff_sms}`,
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function triggerLabel(trigger: string, daysOffset: number): string {
  switch (trigger) {
    case "booking_confirmed": return "On booking confirmation";
    case "days_after_booking": return `${daysOffset} day${daysOffset > 1 ? "s" : ""} after booking`;
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

function aliasExpirationSummary(expiresAt?: string | null) {
  if (!expiresAt) return { date: "Not set", relative: "expiration not saved yet", expired: false };
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return { date: "Not set", relative: "expiration not saved yet", expired: false };
  const days = Math.ceil((date.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (days < 0) return { date: formatDate(expiresAt), relative: "expired", expired: true };
  if (days === 0) return { date: formatDate(expiresAt), relative: "expires today", expired: false };
  return { date: formatDate(expiresAt), relative: `${days} day${days === 1 ? "" : "s"} left`, expired: false };
}

function extractEmailForInput(value: string): string {
  const match = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0] ?? "";
}

function buildDefaultVendorEmailDraft(unit: InboxBuyInRecord, guestName?: string) {
  return {
    subject: `Arrival details request for ${unit.unitLabel || unit.propertyName || "unit"}`,
    body: [
      "Aloha,",
      "",
      `We booked ${unit.propertyName || "this property"}${unit.unitLabel ? ` - ${unit.unitLabel}` : ""} for ${guestName || "our guest"} from ${formatDate(unit.checkIn)} to ${formatDate(unit.checkOut)}.`,
      "Can you please send the arrival details, property address, access code, Wi-Fi, parking instructions, and any check-in notes when available?",
      "",
      "Mahalo,",
      "John Carpenter",
    ].join("\n"),
  };
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
  if (src.includes("expedia")) return <span className="inline-block px-1.5 py-[1px] rounded text-[9px] font-medium bg-yellow-500 text-black">Expedia</span>;
  if (src.includes("google")) return <span className="inline-block px-1.5 py-[1px] rounded text-[9px] font-medium bg-sky-500 text-white">Google</span>;
  if (src.includes("marriott") || src.includes("homesandvillas") || src.includes("hvmi")) return <span className="inline-block px-1.5 py-[1px] rounded text-[9px] font-medium bg-rose-900 text-white">Marriott</span>;
  if (src.includes("hopper")) return <span className="inline-block px-1.5 py-[1px] rounded text-[9px] font-medium bg-purple-600 text-white">Hopper</span>;
  if (src.includes("despegar")) return <span className="inline-block px-1.5 py-[1px] rounded text-[9px] font-medium bg-amber-600 text-white">Despegar</span>;
  if (src.includes("agoda")) return <span className="inline-block px-1.5 py-[1px] rounded text-[9px] font-medium bg-red-700 text-white">Agoda</span>;
  if (src.includes("email")) return <span className="inline-block px-1.5 py-[1px] rounded text-[9px] font-medium bg-slate-600 text-white">Email</span>;
  if (src.includes("sms")) return <span className="inline-block px-1.5 py-[1px] rounded text-[9px] font-medium bg-emerald-600 text-white">SMS</span>;
  if (src.includes("whatsapp")) return <span className="inline-block px-1.5 py-[1px] rounded text-[9px] font-medium bg-green-600 text-white">WhatsApp</span>;
  if (!src) return null;
  return <span className="inline-block px-1.5 py-[1px] rounded text-[9px] font-medium bg-slate-400 text-white">{src}</span>;
}

function readableCancellationPolicy(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/^Cancellation policy:\s*/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  const labels: Record<string, string> = {
    firm: "Firm cancellation policy",
    strict: "Strict cancellation policy",
    flexible: "Flexible cancellation policy",
    moderate: "Moderate cancellation policy",
    relaxed: "Relaxed cancellation policy",
    "non refundable": "Non-refundable cancellation policy",
    nonrefundable: "Non-refundable cancellation policy",
  };
  return labels[cleaned.toLowerCase()] ?? cleaned;
}

function findCancellationPolicyValue(value: unknown, depth = 0): string | null {
  if (!value || depth > 5 || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCancellationPolicyValue(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const obj = value as Record<string, unknown>;
  for (const key of ["cancellationPolicyText", "cancellationPolicyDescription", "cancellationPolicyName", "cancellationPolicy", "cancelationPolicy", "cancellation_policy", "policy"]) {
    const direct = readableCancellationPolicy(obj[key]);
    if (direct) return direct;
  }
  for (const [key, nested] of Object.entries(obj)) {
    if (/cancell?ation|cancel|ratePlan|terms|policy/i.test(key)) {
      const direct = readableCancellationPolicy(nested);
      if (direct) return direct;
      const found = findCancellationPolicyValue(nested, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function reservationChannelKind(value: any): "airbnb" | "booking" | "vrbo" | "manual" | "other" {
  const raw = [
    value?.integration?.platform,
    value?.integration?.provider,
    value?.source,
    value?.channel,
  ].filter(Boolean).join(" ").toLowerCase();
  if (raw.includes("airbnb")) return "airbnb";
  if (raw.includes("booking")) return "booking";
  if (raw.includes("vrbo") || raw.includes("homeaway")) return "vrbo";
  if (raw.includes("manual") || raw.includes("direct")) return "manual";
  return "other";
}

function cancellationPolicyBriefSummary(label: string, kind: ReturnType<typeof reservationChannelKind>): string {
  const lower = label.toLowerCase();
  if (kind === "booking") {
    return "Guest is under the Booking.com rate-plan cancellation terms configured in Guesty/Booking.com for this listing.";
  }
  if (kind === "vrbo") {
    return "Guest is under the cancellation, refund, no-show, and date-change terms configured in Guesty and pushed to VRBO/Homeaway for this listing.";
  }
  if (lower.includes("non-refundable") || lower.includes("non refundable") || lower.includes("no refund")) {
    return "Guest booked a non-refundable policy; treat the stay as no-refund unless Guesty/channel rules or an approved exception say otherwise.";
  }
  if (lower.includes("flexible")) {
    return "Guest booked the flexible cancellation policy; refund eligibility follows the flexible window configured in Guesty/channel rules.";
  }
  if (lower.includes("moderate")) {
    return "Guest booked the moderate cancellation policy; refund eligibility follows the moderate window configured in Guesty/channel rules.";
  }
  if (lower.includes("firm")) {
    return "Guest booked the firm cancellation policy; refund eligibility follows the firm window configured in Guesty/channel rules.";
  }
  if (lower.includes("strict")) {
    return "Guest booked the strict cancellation policy; refunds are limited to the strict terms configured in Guesty/channel rules.";
  }
  if (lower.includes("relaxed")) {
    return "Guest booked the relaxed cancellation policy; refund eligibility follows the relaxed window configured in Guesty/channel rules.";
  }
  return "Guest is under the cancellation, refund, no-show, and date-change terms attached to this booking in Guesty.";
}

function cancellationPolicyTerms(label: string, kind: ReturnType<typeof reservationChannelKind>) {
  const lower = label.toLowerCase();
  if (kind === "booking") {
    return {
      freeCancellationUntil: "Not exposed by Guesty for this Booking.com rate plan",
      penalty: "Check the Booking.com rate-plan/extranet terms; Guesty only returned the booking/rate-plan reference, not the penalty schedule.",
      detailsAvailable: false,
    };
  }
  if (kind === "vrbo") {
    if (lower.includes("relaxed")) {
      return { freeCancellationUntil: "14+ days before check-in", penalty: "7-14 days before check-in: 50% refund. Less than 7 days before check-in: no refund.", detailsAvailable: true };
    }
    if (lower.includes("moderate")) {
      return { freeCancellationUntil: "30+ days before check-in", penalty: "14-30 days before check-in: 50% refund. Less than 14 days before check-in: no refund.", detailsAvailable: true };
    }
    if (lower.includes("firm")) {
      return { freeCancellationUntil: "60+ days before check-in", penalty: "30-60 days before check-in: 50% refund. Less than 30 days before check-in: no refund.", detailsAvailable: true };
    }
    if (lower.includes("strict")) {
      return { freeCancellationUntil: "60+ days before check-in", penalty: "Less than 60 days before check-in: no refund.", detailsAvailable: true };
    }
  }
  if (lower.includes("non-refundable") || lower.includes("non refundable") || lower.includes("no refund")) {
    return { freeCancellationUntil: "No free-cancellation window", penalty: "Reservation is non-refundable once booked unless the channel/Guesty exception rules apply.", detailsAvailable: true };
  }
  if (lower.includes("flexible")) {
    return { freeCancellationUntil: "1 day / 24 hours before check-in", penalty: "After that cutoff, Guesty/channel cancellation fees apply; for Airbnb Flexible, the first night is generally not refunded after the cutoff.", detailsAvailable: true };
  }
  if (lower.includes("moderate")) {
    return { freeCancellationUntil: "5 days before check-in on Airbnb; 7 days before arrival for Guesty direct/manual policies", penalty: "After that cutoff, Guesty/channel cancellation fees apply; for Airbnb Moderate, the host is generally paid nights stayed, one extra night, and 50% of remaining nights.", detailsAvailable: true };
  }
  if (lower.includes("firm")) {
    return { freeCancellationUntil: "14-30 days before check-in, depending on channel policy", penalty: "After that cutoff, Guesty/channel cancellation fees apply; Airbnb Firm usually becomes 50% refundable until 7 days before check-in, then non-refundable.", detailsAvailable: true };
  }
  if (lower.includes("strict")) {
    return { freeCancellationUntil: "14-60 days before check-in, depending on channel policy", penalty: "After that cutoff, Guesty/channel cancellation fees apply; strict policies generally become non-refundable closer to check-in.", detailsAvailable: true };
  }
  if (lower.includes("relaxed")) {
    return { freeCancellationUntil: "14+ days before check-in", penalty: "7-14 days before check-in: 50% refund. Less than 7 days before check-in: no refund.", detailsAvailable: true };
  }
  return { freeCancellationUntil: "Configured in Guesty, but the exact cutoff was not exposed", penalty: "Use the Guesty/channel reservation policy details for the cancellation fee or no-show penalty.", detailsAvailable: false };
}

function cancellationPolicySummaryForReservation(value: any): { label: string; summary: string; freeCancellationUntil: string; penalty: string; detailsAvailable: boolean; source?: string | null; assumed: boolean } | null {
  if (!value) return null;
  const kind = reservationChannelKind(value);
  if (value.cancellationPolicy) {
    const label = readableCancellationPolicy(value.cancellationPolicy) ?? String(value.cancellationPolicy);
    const terms = cancellationPolicyTerms(label, kind);
    return {
      label,
      summary: value.cancellationPolicySummary ?? cancellationPolicyBriefSummary(label, kind),
      freeCancellationUntil: value.cancellationPolicyFreeCancellationUntil ?? terms.freeCancellationUntil,
      penalty: value.cancellationPolicyPenalty ?? terms.penalty,
      detailsAvailable: value.cancellationPolicyDetailsAvailable ?? terms.detailsAvailable,
      source: value.cancellationPolicySource,
      assumed: value.cancellationPolicyAssumed === true,
    };
  }

  const directPolicy = findCancellationPolicyValue(value);
  if (directPolicy) {
    return {
      label: directPolicy,
      summary: cancellationPolicyBriefSummary(directPolicy, kind),
      ...cancellationPolicyTerms(directPolicy, kind),
      source: "Guesty reservation policy",
      assumed: false,
    };
  }

  const listingPolicy = findCancellationPolicyValue(value.listing);
  if (listingPolicy) {
    return {
      label: listingPolicy,
      summary: cancellationPolicyBriefSummary(listingPolicy, kind),
      ...cancellationPolicyTerms(listingPolicy, kind),
      source: "Assumed from the Guesty listing/channel policy",
      assumed: true,
    };
  }

  if (kind === "booking") {
    const label = "Booking.com cancellation policy configured in Guesty";
    return {
      label,
      summary: cancellationPolicyBriefSummary(label, kind),
      ...cancellationPolicyTerms(label, kind),
      source: "Assumed from the policy Guesty pushed to Booking.com",
      assumed: true,
    };
  }
  if (kind === "vrbo") {
    const label = "VRBO cancellation policy configured in Guesty";
    return {
      label,
      summary: cancellationPolicyBriefSummary(label, kind),
      ...cancellationPolicyTerms(label, kind),
      source: "Assumed from the policy Guesty pushed to VRBO",
      assumed: true,
    };
  }

  return null;
}

// ─── Inbound message cleanup ───────────────────────────────────────────────────
// Some Guesty channel integrations forward inbound emails as a full HTML
// document (`<!DOCTYPE html><html>...</html>`). The inbox renders message
// bodies as plain text, so without scrubbing the markup leaks through to
// the operator (and the conversation-list preview) as raw tags. We don't
// want to render unsanitised HTML — that's a clean XSS path — so this
// converts to readable plain text instead: strip head/style/script blocks
// entirely, turn block-level closers and `<br>` into newlines, drop the
// remaining tags, decode common entities, collapse whitespace. Only fires
// when the body actually looks like HTML, so plain-text replies that
// happen to contain a stray `<` or `>` survive untouched.
function cleanMessageBody(raw: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  const looksHtml =
    /^<!DOCTYPE/i.test(trimmed) ||
    /<\/?(html|body|head|p|br|div)\b/i.test(raw);
  if (!looksHtml) return raw;
  let s = raw;
  s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, "");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<!DOCTYPE[^>]*>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

// Parse the quo_sms_messages.media_urls column (JSON [{url, type?}]) back into
// attachment objects for the thread. Fail-soft: bad/missing JSON renders as a
// text-only SMS bubble rather than breaking the thread.
function parseQuoSmsMedia(raw: unknown): Array<{ url: string; type?: string }> {
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

// One attachment inside a message bubble: images render inline (click opens the
// full-size original in a new tab); anything else (or an image URL that fails
// to load, e.g. an expired signed URL) falls back to a download link.
function PostAttachmentView({ attachment }: { attachment: PostAttachment }) {
  const [imageFailed, setImageFailed] = useState(false);
  if (attachment.isImage && !imageFailed) {
    return (
      <a href={attachment.url} target="_blank" rel="noreferrer" className="block">
        <img
          src={attachment.url}
          alt={attachment.name ?? "Photo from message"}
          loading="lazy"
          className="max-h-56 max-w-full rounded-md border border-black/10 object-cover"
          onError={() => setImageFailed(true)}
        />
      </a>
    );
  }
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded border border-black/10 bg-background/70 px-2 py-1 text-xs text-foreground underline"
    >
      📎 {attachment.name ?? (attachment.isImage ? "View photo" : "View attachment")}
    </a>
  );
}

function isHostPost(p: any): boolean {
  return (
    p.authorType === "host" ||
    p.authorRole === "host" ||
    p.senderType === "host" ||
    p.sentBy === "host" ||
    p.direction === "outbound" ||
    p.direction === "out" ||
    p.direction === "outgoing" ||
    p.isIncoming === false
  );
}

function postSearchText(p: any): string {
  const module = p?.module ?? {};
  const integration = p?.integration ?? {};
  return [
    p?.body,
    p?.text,
    p?.message,
    p?.subject,
    p?.authorName,
    p?.senderName,
    p?.senderType,
    p?.sentBy,
    p?.source,
    p?.provider,
    p?.channel,
    p?.conversationChannel,
    module.type,
    module.provider,
    module.source,
    module.name,
    integration.platform,
  ].filter(Boolean).join(" ").toLowerCase();
}

function isAirbnbCustomerServicePost(p: any): boolean {
  const haystack = postSearchText(p);
  return /airbnb/.test(haystack) &&
    /(customer\s*service|customer_service|support|community\s*support|resolution\s*center|case\s*manager|ambassador|specialist)/.test(haystack);
}

function isGuestySystemPost(p: any): boolean {
  if (isAirbnbCustomerServicePost(p)) return false;
  if (p.sentBy === "log") return true;
  const moduleType = String(p.module?.type ?? p.type ?? "").toLowerCase();
  if (["log", "system", "internal", "note"].includes(moduleType)) return true;
  const body = String(p.body ?? p.text ?? p.message ?? "").trim().toLowerCase();
  return body === "new guest inquiry" ||
    body === "new inquiry" ||
    body === "new reservation request" ||
    body.startsWith("new guest reservation");
}

function isSignedHostTemplateBody(body: string): boolean {
  return /john carpenter/i.test(body) && /(magical island rentals|vacationrentalexpertz|nexstay)/i.test(body);
}

function normalizeGuestyManualMessageBody(body: string): string {
  return body;
}

// ─── Outbound message templates ────────────────────────────────────────────────
// Guest-facing messages sent from the inbox are signed by the operator's
// brand. Sender + brand live in one place so future templates pick up the
// same identity. Property nicknames, totals, etc. are still merged from
// Guesty data per-message.
const OUTBOUND_SENDER_NAME = "John Carpenter";
const OUTBOUND_BRAND_NAME = "VacationRentalExpertz";
const AIRBNB_PREAPPROVAL_STORAGE_KEY = "nexstay_airbnb_preapproved_reservation_ids";

function readStoredAirbnbPreapprovals(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(AIRBNB_PREAPPROVAL_STORAGE_KEY);
    const ids = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id.length > 0) : []);
  } catch {
    return new Set();
  }
}

function writeStoredAirbnbPreapprovals(ids: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AIRBNB_PREAPPROVAL_STORAGE_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    // localStorage can fail in private windows; the live Guesty state still refetches.
  }
}

// ── Manual "Mark as read / unread" overrides for the conversation list ────────
// Guesty's Open API for this tenant exposes no reliable "mark conversation
// read" endpoint, so the operator's right-click Mark-as-read/unread is a
// CLIENT-SIDE override layered over Guesty's live read state — the same idea as
// `locallyRepliedAtByConversation` (reply-sent suppression), but DURABLE: it's
// persisted to localStorage so a deliberate mark survives a refresh and keeps
// the header unread count honest. Each entry stamps the moment it was set; a
// "read" override is auto-dropped once a NEWER guest message arrives (so a fresh
// reply still re-surfaces the thread), while an "unread" override sticks until
// the operator marks it read or sends a reply.
// Key + parser live in @shared/inbox-unread-count so AppHeader's independent
// unread derivation reads the SAME overrides with the SAME validation — the
// two must stay in lockstep or the header badge drifts from the inbox count.
type InboxReadOverride = SharedInboxReadOverride;

function readStoredInboxReadOverrides(): Record<string, InboxReadOverride> {
  if (typeof window === "undefined") return {};
  try {
    return parseStoredInboxReadOverrides(window.localStorage.getItem(INBOX_READ_OVERRIDE_STORAGE_KEY));
  } catch {
    return {};
  }
}

function writeStoredInboxReadOverrides(overrides: Record<string, InboxReadOverride>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(INBOX_READ_OVERRIDE_STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // localStorage can fail in private windows; the override just won't persist.
  }
}

const formatMoney = (n: number): string =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const formatLongDate = (isoYmd: string): string => {
  // `new Date("2026-04-28")` parses as UTC midnight, which renders as
  // April 27 in negative timezone offsets. Build the date in local time
  // so the receipt's "today" matches the operator's wall clock.
  const [y, m, d] = isoYmd.split("-").map(Number);
  if (!y || !m || !d) return isoYmd;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: "long", day: "numeric", year: "numeric",
  });
};

const isVrboOrBookingChannel = (channelRaw?: string): boolean => {
  const channel = String(channelRaw ?? "").toLowerCase();
  return channel.includes("vrbo") || channel.includes("homeaway") || channel.includes("booking");
};

const addDaysToIsoYmd = (iso?: string, days = 0): string | null => {
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return null;
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
};

const inferResortNameForWalk = (propertyName?: string): string | undefined => {
  const label = String(propertyName ?? "");
  const resorts = [
    "Regency at Poipu Kai",
    "Pili Mai",
    "Pili Mai at Poipu",
    "Kaha Lani Resort",
    "Lae Nani Resort",
    "Mauna Kai Princeville",
    "Kaiulani of Princeville",
    "Keauhou Estates",
    "Kiahuna Plantation",
    "Southern Dunes",
    "Windsor Hills",
  ];
  return resorts.find((name) => label.toLowerCase().includes(name.toLowerCase()));
};

const representativeUnitSetupLine = (propertyName?: string): string => {
  const walk = fallbackWalkForResort(inferResortNameForWalk(propertyName));
  return `Your reservation is set up as two separate units. ${walk.description} The units shown are examples of the setup; your assigned units will be very similar quality and will always match the same bedroom counts.`;
};

const addDays = (date: Date, days: number): Date => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const parseStayDate = (iso?: string): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

const formatShortDate = (date: Date | null, fallback: string): string =>
  date ? date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : fallback;

// Renders a payment-receipt body. `pastPayments` lists every prior
// payment on the booking (date + amount); today's charge is supplied
// separately as `paymentAmount` / `paymentDateIso` so it can be flagged
// "(today's payment)" inline. Total paid is derived by summing all
// payments — there's no separate aggregate field to keep in sync.
function buildReceiptBody(args: {
  guestFirstName: string;
  propertyName: string;
  checkInIso?: string;
  paymentAmount: number;
  paymentDateIso: string;
  bookingTotal: number;
  pastPayments: Array<{ date: string; amount: number }>;
  // When a durable /receipt/:token page has been generated, its URL is woven
  // into the message (own line — load-bearing for Booking.com link delivery).
  receiptUrl?: string;
}): string {
  const past = args.pastPayments
    .filter((p) => p.amount > 0)
    .map((p) => ({ date: p.date, amount: p.amount, isToday: false }));
  const todayRow = args.paymentAmount > 0
    ? [{ date: args.paymentDateIso, amount: args.paymentAmount, isToday: true }]
    : [];
  const allPayments = [...past, ...todayRow];
  const totalPaid = allPayments.reduce((sum, p) => sum + p.amount, 0);
  const balance = Math.max(0, args.bookingTotal - totalPaid);
  const stayLabel = args.propertyName ? ` for your stay at ${args.propertyName}` : "";
  const checkInLine = args.checkInIso
    ? ` (check-in ${formatLongDate(args.checkInIso.slice(0, 10))})`
    : "";

  const lines: string[] = [
    `Hi ${args.guestFirstName || "there"},`,
    ``,
    `This is ${OUTBOUND_SENDER_NAME} with ${OUTBOUND_BRAND_NAME} confirming we just processed a payment of ${formatMoney(args.paymentAmount)} on ${formatLongDate(args.paymentDateIso)} on the card we have on file${stayLabel}${checkInLine}.`,
    ``,
    `Booking total: ${formatMoney(args.bookingTotal)}`,
  ];

  if (allPayments.length > 1) {
    lines.push(``);
    lines.push(`Payment history:`);
    for (const p of allPayments) {
      const dateLabel = p.date ? formatLongDate(p.date.slice(0, 10)) : "Date —";
      const tag = p.isToday ? " (today's payment)" : "";
      lines.push(`  • ${dateLabel}: ${formatMoney(p.amount)}${tag}`);
    }
  }

  lines.push(``);
  lines.push(`Total paid to date: ${formatMoney(totalPaid)}`);
  lines.push(`Remaining balance:  ${formatMoney(balance)}`);
  lines.push(``);
  if (args.receiptUrl && args.receiptUrl.trim()) {
    lines.push(`You can view your full itemized receipt here:`);
    lines.push(args.receiptUrl.trim());
    lines.push(``);
  }
  lines.push(`If you have any questions about this charge or your reservation, just reply to this message — happy to help.`);
  lines.push(``);
  lines.push(`Thanks,`);
  lines.push(OUTBOUND_SENDER_NAME);
  lines.push(OUTBOUND_BRAND_NAME);

  return lines.join("\n");
}

// Weave a generated receipt-page link into a message the operator has already
// hand-edited (so we don't clobber their copy). No-op if the link is already
// present. Inserts the link block just above the "Thanks," sign-off when found,
// otherwise appends it.
function withReceiptLink(body: string, url: string): string {
  const link = String(url ?? "").trim();
  if (!link || !body || body.includes(link)) return body;
  const block = `You can view your full itemized receipt here:\n${link}`;
  const idx = body.indexOf("\nThanks,");
  const next = idx >= 0
    ? `${body.slice(0, idx)}\n\n${block}\n${body.slice(idx)}`
    : `${body}\n\n${block}`;
  return next.replace(/\n{3,}/g, "\n\n");
}

// ─── Region-aware greeting + sign-off ───────────────────────────────────────────
// Hawaii stays open with "Aloha [name]," and close with "Mahalo," — the warm
// island voice the operator's booking-confirmation scheduler already uses
// (server/booking-confirmations.ts) and that the AI drafter gates on the same
// isHawaii flag. Mainland stays (e.g. the Florida markets in
// resolveIslandRegion) use a normal "Hi [name]," / "Thanks," so the Hawaiian
// flavor never bleeds onto a property where it would read as off. Region is the
// isHawaii flag from buildPropertyContextForDraft, resolved deterministically
// from the listing address. Centralized here so every template (full + SMS)
// picks up the same voice.
function guestGreeting(firstName: string, isHawaii: boolean): string {
  const name = String(firstName ?? "").trim();
  const opener = isHawaii ? "Aloha" : "Hi";
  return name ? `${opener} ${name},` : `${opener} there,`;
}

// Multi-line sign-off for full (Guesty / OTA / email) messages.
function guestSignoffLines(isHawaii: boolean): string[] {
  return [isHawaii ? "Mahalo," : "Thanks,", OUTBOUND_SENDER_NAME, OUTBOUND_BRAND_NAME];
}

// One-line sign-off for SMS — first name only, no brand block.
function guestSmsSignoff(isHawaii: boolean): string {
  return `${isHawaii ? "Mahalo" : "Thanks"}, ${OUTBOUND_SENDER_NAME.split(" ")[0]}`;
}

function buildBookingConfirmationBody(args: {
  guestFirstName: string;
  propertyName: string;
  checkInIso?: string;
  checkOutIso?: string;
  confirmationCode?: string;
  numNights?: number | null;
  bookingTotal?: number;
  totalPaid?: number;
  channelRaw?: string;
  isHawaii?: boolean;
}): string {
  const total = args.bookingTotal ?? 0;
  const paid = args.totalPaid ?? 0;
  const balance = Math.max(0, total - paid);
  const balanceDueIso = addDaysToIsoYmd(args.checkInIso, -120);
  const shouldMentionBalanceDue = isVrboOrBookingChannel(args.channelRaw) && balance > 0 && !!balanceDueIso;
  const isHawaii = args.isHawaii ?? true;
  const lines: string[] = [
    guestGreeting(args.guestFirstName, isHawaii),
    ``,
    `Wonderful news — your reservation${args.propertyName ? ` at ${args.propertyName}` : ""} is confirmed, and we are so glad to have you with us.`,
  ];
  if (args.checkInIso || args.checkOutIso) {
    lines.push(``);
    if (args.checkInIso) lines.push(`Check-in: ${formatLongDate(args.checkInIso.slice(0, 10))}`);
    if (args.checkOutIso) lines.push(`Check-out: ${formatLongDate(args.checkOutIso.slice(0, 10))}`);
    if (args.numNights) lines.push(`Nights: ${args.numNights}`);
  }
  if (args.confirmationCode) lines.push(`Confirmation code: ${args.confirmationCode}`);
  if (total > 0 || paid > 0) {
    lines.push(``);
    if (total > 0) lines.push(`Booking total: ${formatMoney(total)}`);
    if (paid > 0) lines.push(`Paid to date: ${formatMoney(paid)}`);
    if (shouldMentionBalanceDue) {
      lines.push(`Remaining balance: ${formatMoney(balance)}, due 120 days prior to arrival on ${formatLongDate(balanceDueIso)}.`);
    }
  }
  lines.push(``);
  lines.push(representativeUnitSetupLine(args.propertyName));
  lines.push(``);
  lines.push(`We will send your detailed arrival information 14 days before check-in — addresses, access details, parking, Wi-Fi, and everything else you will need to settle right in. In the meantime, if any questions come up, just reply here and I am happy to help.`);
  lines.push(``);
  lines.push(...guestSignoffLines(isHawaii));
  return lines.join("\n");
}

function buildRepresentativeUnitsFollowUpBody(args: {
  guestFirstName: string;
  propertyName: string;
  checkInIso?: string;
  isHawaii?: boolean;
}): string {
  const isHawaii = args.isHawaii ?? true;
  const lines: string[] = [
    guestGreeting(args.guestFirstName, isHawaii),
    ``,
    `I wanted to share a quick note about your upcoming stay${args.propertyName ? ` at ${args.propertyName}` : ""} so everything feels clear before you arrive.`,
  ];
  if (args.checkInIso) lines.push(`Check-in date: ${formatLongDate(args.checkInIso.slice(0, 10))}`);
  lines.push(``);
  lines.push(`Your reservation is set up as two nearby units that are only minutes apart. The listing photos are representative of the resort/community and unit style. Your assigned units will match the bedroom count and overall property standard, though exact interiors, furnishings, views, and layouts can vary slightly by unit.`);
  lines.push(``);
  lines.push(`Your arrival details will arrive about 14 days before check-in. Until then, please feel free to message me with any questions at all — I am glad to help.`);
  lines.push(``);
  lines.push(...guestSignoffLines(isHawaii));
  return lines.join("\n");
}

function buildAgreementRequestBody(args: {
  guestFirstName: string;
  propertyName: string;
  agreementUrl: string;
  checkInIso?: string;
  confirmationCode?: string;
  isHawaii?: boolean;
}): string {
  const isHawaii = args.isHawaii ?? true;
  const lines: string[] = [
    guestGreeting(args.guestFirstName, isHawaii),
    ``,
    `As we get your stay${args.propertyName ? ` at ${args.propertyName}` : ""} ready, please have the primary guest review and sign our secure rental agreement.`,
  ];
  if (args.checkInIso) lines.push(`Check-in date: ${formatLongDate(args.checkInIso.slice(0, 10))}`);
  if (args.confirmationCode) lines.push(`Confirmation code: ${args.confirmationCode}`);
  lines.push(``);
  lines.push(`You can complete it here:`);
  lines.push(args.agreementUrl);
  lines.push(``);
  lines.push(`This confirms the booking details, house rules, authorized guest, signed rental agreement, and the two-separate-units acknowledgment before arrival. For your security, please do not send credit card details in this message thread.`);
  lines.push(``);
  lines.push(`Once that is done, you are all set, and we will send your final arrival/access details 14 days before check-in.`);
  lines.push(``);
  lines.push(...guestSignoffLines(isHawaii));
  return lines.join("\n");
}

function buildAgreementRequestSmsBody(args: {
  guestFirstName: string;
  propertyName: string;
  checkInIso?: string;
  checkOutIso?: string;
  agreementUrl: string;
  isHawaii?: boolean;
}): string {
  const isHawaii = args.isHawaii ?? true;
  const propertyLabel = smsAgreementPropertyLabel(args.propertyName);
  return [
    `${guestGreeting(args.guestFirstName, isHawaii)} please review and sign the secure rental agreement for: ${propertyLabel}`,
    args.checkInIso ? `Arriving: ${formatLongDate(args.checkInIso.slice(0, 10))}` : "",
    args.checkOutIso ? `Departing: ${formatLongDate(args.checkOutIso.slice(0, 10))}` : "",
    args.agreementUrl,
    ``,
    `This confirms your reservation details, the two-unit acknowledgment, and arrival requirements. ${guestSmsSignoff(isHawaii)}`,
  ].filter(Boolean).join("\n");
}

function smsAgreementPropertyLabel(propertyName: string): string {
  const raw = String(propertyName || "your stay").trim();
  return raw
    .replace(/\s*-\s*Sleeps\s+\d+\s*$/i, "")
    .replace(/\b(\d+)\s*BR\b/gi, "$1 Bedroom")
    .replace(/\bTownhomes\b/gi, "Townhouse")
    .replace(/\s*-\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildGuestyInvoicePaymentBody(args: {
  guestFirstName: string;
  propertyName: string;
  checkInIso?: string;
  confirmationCode?: string;
  isHawaii?: boolean;
}): string {
  const isHawaii = args.isHawaii ?? true;
  const lines: string[] = [
    guestGreeting(args.guestFirstName, isHawaii),
    ``,
    `When you have a moment, please use the secure Guesty invoice link below to add your payment method or complete any remaining balance${args.propertyName ? ` for your stay at ${args.propertyName}` : ""}.`,
  ];
  if (args.checkInIso) lines.push(`Check-in date: ${formatLongDate(args.checkInIso.slice(0, 10))}`);
  if (args.confirmationCode) lines.push(`Confirmation code: ${args.confirmationCode}`);
  lines.push(``);
  lines.push(`{{guest_invoice}}`);
  lines.push(``);
  lines.push(`For your security, please do not send credit card details in this message thread.`);
  lines.push(``);
  lines.push(...guestSignoffLines(isHawaii));
  return lines.join("\n");
}

function buildGuestyInvoicePaymentSmsBody(args: {
  guestFirstName: string;
  propertyName: string;
  paymentUrl?: string;
  isHawaii?: boolean;
}): string {
  const isHawaii = args.isHawaii ?? true;
  const link = args.paymentUrl?.trim() || "[PASTE SECURE GUESTY PAYMENT LINK]";
  return [
    `${guestGreeting(args.guestFirstName, isHawaii)} please use this secure Guesty link to add your payment method or complete any remaining balance${args.propertyName ? ` for ${args.propertyName}` : ""}:`,
    link,
    ``,
    `Please do not text card details. ${guestSmsSignoff(isHawaii)}`,
  ].join("\n");
}

function buildArrivalDetailsSmsBody(args: {
  guestFirstName: string;
  propertyName: string;
  isHawaii?: boolean;
}): string {
  const isHawaii = args.isHawaii ?? true;
  return `${guestGreeting(args.guestFirstName, isHawaii)} your arrival details${args.propertyName ? ` for ${args.propertyName}` : ""} have been sent in the booking thread/email. Please review them before travel day and reply here if anything looks unclear. ${guestSmsSignoff(isHawaii)}`;
}

function buildLocalTipsBody(args: {
  guestFirstName: string;
  propertyName: string;
  units: ArrivalUnitDetail[];
  isHawaii?: boolean;
}): string {
  const isHawaii = args.isHawaii ?? true;
  const parking = args.units.map((u) => u.parkingInfo).filter(Boolean).join("\n");
  // Hawaii guests get the island-flavored activity prompts (luaus, boat tours);
  // mainland guests get a neutral version so the tips read right for the market.
  const activityLine = isHawaii
    ? `- For restaurants, activities, luaus, boat tours, and popular beach parking, reservations can be helpful during busy weeks.`
    : `- For restaurants, activities, and popular attractions, reservations can be helpful during busy weeks.`;
  const lines: string[] = [
    guestGreeting(args.guestFirstName, isHawaii),
    ``,
    `Your stay${args.propertyName ? ` at ${args.propertyName}` : ""} is just a few days away — we cannot wait to host you. A few quick reminders before travel day:`,
    ``,
    `- Please review your arrival/access details before you leave.`,
    `- If you are renting a car, keep the parking details handy.${parking ? `\n\nParking notes:\n${parking}` : ""}`,
    activityLine,
    `- Grocery stops are usually easiest before heading fully into resort areas.`,
    ``,
    `If you would like specific restaurant or local-area ideas near the property, just reply here — I am always happy to share favorites.`,
    ``,
    ...guestSignoffLines(isHawaii),
  ];
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildLocalTipsSmsBody(args: {
  guestFirstName: string;
  propertyName: string;
  isHawaii?: boolean;
}): string {
  const isHawaii = args.isHawaii ?? true;
  return `${guestGreeting(args.guestFirstName, isHawaii)} quick travel reminder${args.propertyName ? ` for ${args.propertyName}` : ""}: please keep your arrival/access and parking details handy before you leave. Reply here if you need anything at all. ${guestSmsSignoff(isHawaii)}`;
}

function buildDayBeforeBody(args: {
  guestFirstName: string;
  propertyName: string;
  checkInIso?: string;
  units: ArrivalUnitDetail[];
  isHawaii?: boolean;
}): string {
  const isHawaii = args.isHawaii ?? true;
  const lines: string[] = [
    guestGreeting(args.guestFirstName, isHawaii),
    ``,
    `Your check-in${args.propertyName ? ` for ${args.propertyName}` : ""} is tomorrow, and we are looking forward to welcoming you. Please keep your arrival details handy, including the address, access code, parking information, and Wi-Fi details.`,
  ];
  if (args.checkInIso) lines.push(`Check-in date: ${formatLongDate(args.checkInIso.slice(0, 10))}`);
  if (args.units.length > 0) {
    lines.push(``);
    args.units.forEach((unit, index) => {
      lines.push(`${args.units.length > 1 ? `Unit ${index + 1}` : "Unit"}: ${unit.unitLabel}`);
      if (unit.unitAddress) lines.push(`Address: ${unit.unitAddress}`);
      if (unit.accessCode) lines.push(`Access code: ${unit.accessCode}`);
      if (unit.parkingInfo) lines.push(`Parking: ${unit.parkingInfo}`);
      lines.push(``);
    });
  }
  lines.push(`Safe travels, and please reply here if anything comes up — we are here to help.`);
  lines.push(``);
  lines.push(...guestSignoffLines(isHawaii));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildDayBeforeSmsBody(args: {
  guestFirstName: string;
  propertyName: string;
  isHawaii?: boolean;
}): string {
  const isHawaii = args.isHawaii ?? true;
  return `${guestGreeting(args.guestFirstName, isHawaii)} check-in${args.propertyName ? ` for ${args.propertyName}` : ""} is tomorrow. Please keep your arrival details handy, and reply here if anything comes up. Safe travels! ${guestSmsSignoff(isHawaii)}`;
}

function buildPostStayBody(args: {
  guestFirstName: string;
  propertyName: string;
  isHawaii?: boolean;
}): string {
  const isHawaii = args.isHawaii ?? true;
  // Hawaii voice gets the deeper island touches here ("Mahalo nui loa",
  // "A hui hou") — the farewell message is the natural home for them. Keep
  // "appreciate a review" verbatim in both voices: the guest-stay timeline's
  // post-stay sent-detection keys on it. ASCII only (Booking.com).
  const bigThanks = isHawaii ? "Mahalo nui loa" : "Thank you so much";
  const comeBack = isHawaii
    ? `A hui hou - until we meet again! We would love to welcome you and your 'ohana back anytime.`
    : `We would love to welcome you back anytime.`;
  return [
    guestGreeting(args.guestFirstName, isHawaii),
    ``,
    `${bigThanks} for staying${args.propertyName ? ` at ${args.propertyName}` : ""}. It was a pleasure to host you, and I hope you had a wonderful trip.`,
    ``,
    `If you have a moment, we would truly appreciate a review. It helps future guests feel confident booking and means the world to us.`,
    ``,
    comeBack,
    ``,
    ...guestSignoffLines(isHawaii),
  ].join("\n");
}

function buildPostStaySmsBody(args: {
  guestFirstName: string;
  propertyName: string;
  isHawaii?: boolean;
}): string {
  const isHawaii = args.isHawaii ?? true;
  const smsThanks = isHawaii ? "mahalo nui loa" : "thank you so much";
  const smsBack = isHawaii ? "A hui hou - we would love to host you again anytime." : "We would love to host you again anytime.";
  return `${guestGreeting(args.guestFirstName, isHawaii)} ${smsThanks} for staying${args.propertyName ? ` at ${args.propertyName}` : ""}. If you have a moment, we would truly appreciate a review. ${smsBack} ${guestSmsSignoff(isHawaii)}`;
}

function buildUnitSetupSmsBody(args: {
  guestFirstName: string;
  propertyName: string;
  isHawaii?: boolean;
}): string {
  const isHawaii = args.isHawaii ?? true;
  return `${guestGreeting(args.guestFirstName, isHawaii)} quick note${args.propertyName ? ` for ${args.propertyName}` : ""}: this stay is set up as nearby units, and your final arrival details will come before check-in. Reply here with any questions. ${guestSmsSignoff(isHawaii)}`;
}

// ID verification: asks the guest to reply with a selfie holding their
// driver's license before arrival details are released. Guests reply with the
// photo in this same thread — OTA photo attachments already render via
// collectPostAttachments, and SMS/MMS photo replies land here through the Quo
// webhook (media_urls) and render the same way.
function buildIdVerificationBody(args: {
  guestFirstName: string;
  propertyName: string;
  checkInIso?: string;
  confirmationCode?: string;
  isHawaii?: boolean;
}): string {
  const isHawaii = args.isHawaii ?? true;
  const lines: string[] = [
    guestGreeting(args.guestFirstName, isHawaii),
    ``,
    `As part of our standard security verification${args.propertyName ? ` for your stay at ${args.propertyName}` : ""}, could you please reply to this message with a photo of the primary guest's driver's license (or other government-issued ID) and a selfie of the primary guest holding that ID?`,
  ];
  if (args.checkInIso) lines.push(`Check-in date: ${formatLongDate(args.checkInIso.slice(0, 10))}`);
  if (args.confirmationCode) lines.push(`Confirmation code: ${args.confirmationCode}`);
  lines.push(``);
  lines.push(`We need this quick verification before we can release your arrival details (unit address, access codes, and parking). Your photos are used only to confirm the reservation and are never shared.`);
  lines.push(``);
  lines.push(...guestSignoffLines(isHawaii));
  return lines.join("\n");
}

function buildIdVerificationSmsBody(args: {
  guestFirstName: string;
  propertyName: string;
  isHawaii?: boolean;
}): string {
  const isHawaii = args.isHawaii ?? true;
  return [
    `${guestGreeting(args.guestFirstName, isHawaii)} quick security step${args.propertyName ? ` for ${args.propertyName}` : ""}: please reply to this text with a photo of the primary guest's driver's license and a selfie holding it.`,
    ``,
    `We need this to verify the reservation and release your arrival details. Your photos stay private and are only used for verification. ${guestSmsSignoff(isHawaii)}`,
  ].join("\n");
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

// Guesty's /posts endpoint started rejecting the `fields` query param with a
// 400 VALIDATION_ERROR (`"fields" is not allowed`, observed 2026-07-05), which
// used to blank every inbox thread ("No posts parsed"). Latched per page load
// after the first rejection so the 30s refetches skip the doomed variant.
let postsFieldsParamRejected = false;

function normalizePhone(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+") && digits.length >= 10) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits ? `+${digits}` : "";
}

function formatPhone(value: unknown): string {
  const normalized = normalizePhone(value);
  const digits = normalized.replace(/\D/g, "");
  const last10 = digits.slice(-10);
  if (last10.length !== 10) return normalized || "Unknown phone";
  return `(${last10.slice(0, 3)}) ${last10.slice(3, 6)}-${last10.slice(6)}`;
}

function formatDuration(seconds?: number | null): string {
  const n = Math.max(0, Math.round(Number(seconds ?? 0)));
  if (!n) return "0:00";
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function normalizeDeepLinkText(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findPhoneInObject(node: unknown, depth = 0): string {
  if (!node || depth > 5) return "";
  if (typeof node === "string" || typeof node === "number") {
    const phone = normalizePhone(node);
    return phone.replace(/\D/g, "").length >= 10 ? phone : "";
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findPhoneInObject(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (/phone|mobile|cell|tel|number/i.test(key) || typeof value === "object") {
        const found = findPhoneInObject(value, depth + 1);
        if (found) return found;
      }
    }
  }
  return "";
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
  displayGuestPhone: string;
  displayGuestEmail: string;
  displayConfirmationCode: string;
  isUnread: boolean;
  reservationId?: string;
  // Indicators surfaced on the list row beside the guest name. Each
  // flag means "host action is pending" for a different reason.
  // Computed from the conversation/reservation stub the list endpoint
  // already returns — no extra queries.
  needsReply: boolean;       // latest guest message awaits a host response
  lastMessageFromGuest: boolean; // durable reply-owed signal; survives simply opening/reading
  needsPreapprove: boolean;  // Airbnb inquiry not yet pre-approved (host has 24h)
  phase?: "inquiry" | "request" | "booked" | "cancelled" | "other";
  conversationChannel?: string;
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
  // Inbox-v2 stores the last-message preview at `state.lastMessage`
  // ({ body, date }) — NOT at `lastPost` / `meta.lastMessage`. Both of
  // those are null on every current Guesty conversation we've checked
  // (e.g. Michelle 69ea7b4608e5bc000f8e89ef on 2026-05-04). Without
  // this fallback the list row preview was empty and `displayTimestamp`
  // dropped to `createdAt`, so threads with brand-new activity looked
  // dormant — the operator missed Michelle's May-3 follow-up entirely
  // and only spotted it in Guesty's own UI. NOTE FOR CODEX: do NOT
  // remove the legacy `lastPost` / `meta.lastMessage` paths; cached
  // older fixtures still hit them.
  const stateObj = (c?.state && typeof c.state === "object") ? c.state as any : null;
  const stateLastMsg = stateObj?.lastMessage ?? null;
  const lastMsg = c?.lastPost ?? meta.lastMessage ?? meta.lastPost ?? stateLastMsg ?? {};
  const mod = c?.module ?? meta.module ?? meta.lastMessage?.module ?? undefined;

  const guestName =
    c?.guestName ??
    guest.fullName ??
    guest.name ??
    [guest.firstName, guest.lastName].filter(Boolean).join(" ") ??
    "Guest";
  const guestPhone = normalizePhone(
    guest.phone ??
    guest.phoneNumber ??
    guest.mobile ??
    guest.mobilePhone ??
    firstReservation?.guest?.phone ??
    firstReservation?.guest?.phoneNumber ??
    findPhoneInObject({ guest, firstReservation }),
  );

  // Searchable guest email + reservation confirmation code. These power
  // the conversation-list search box (search by name / email / phone /
  // confirmation). Pulled from the same nested shapes Guesty returns on
  // the list endpoint stub — empty string when absent so the search
  // haystack join stays clean.
  const guestEmail = String(
    c?.guestEmail ??
    guest.email ??
    guest.emailAddress ??
    firstReservation?.guest?.email ??
    "",
  ).trim();
  const confirmationCode = String(
    c?.confirmationCode ??
    firstReservation?.confirmationCode ??
    firstReservation?.confirmation?.code ??
    "",
  ).trim();

  const listingName =
    c?.listingNickname ??
    listing.nickname ??
    listing.title ??
    listing.name ??
    firstReservation?.listingNickname ??
    firstReservation?.listingTitle ??
    "—";

  const preview = cleanMessageBody(
    lastMsg.body ??
      lastMsg.text ??
      lastMsg.message ??
      meta.lastMessagePreview ??
      "",
  );

  // v2 list endpoint doesn't populate `lastMessageAt` — Guesty moved
  // the timestamp to `state.lastMessage.date`. Fall through to that
  // before resorting to `createdAt` (which is the THREAD creation date,
  // not the latest activity, so it would freeze list ordering on
  // long-running conversations). NOTE FOR CODEX: stateLastMsg.date is
  // the source of truth for "most recent activity"; the field was
  // missing from this list before 2026-05-04 (Michelle inbox bug).
  const timestamp =
    c?.lastMessageAt ??
    meta.lastMessageAt ??
    lastMsg.createdAt ??
    stateLastMsg?.date ??
    c?.createdAt ??
    undefined;

  // Two related but distinct signals:
  //
  //   isUnread: Guesty still considers the latest guest post unread.
  //   needsReply: the last real message came from the guest, so the
  //               thread remains action-needed even if opening the
  //               thread marked it read.
  //
  // Jamie cares most about "not responded to yet" at a glance. That
  // means the row indicator and filter use last-from-guest, not only
  // readByNonUser. It clears only after a host/you message becomes the
  // latest post, so the status sticks until an actual reply happens.
  const legacyLastFromGuest =
    c?.state === "NEW" ||
    c?.state === "UNREAD" ||
    c?.state === "UNANSWERED";
  const lastMsgLooksSignedHostReply = isSignedHostTemplateBody(preview);
  const lastMsgLooksGuestAuthored =
    !!preview &&
    !!lastMsg &&
    typeof lastMsg === "object" &&
    Object.keys(lastMsg).length > 0 &&
    !isHostPost(lastMsg) &&
    !lastMsgLooksSignedHostReply;
  const explicitLastFromGuest =
    typeof stateObj?.isLastPostFromGuest === "boolean"
      ? stateObj.isLastPostFromGuest
      : null;
  const lastMessageFromGuest =
    explicitLastFromGuest !== null
      ? explicitLastFromGuest
      : legacyLastFromGuest || lastMsgLooksGuestAuthored;
  const unreadSignal =
    (typeof c?.unreadCount === "number" && c.unreadCount > 0) ||
    c?.unread === true ||
    meta.unreadCount > 0 ||
    legacyLastFromGuest ||
    stateObj?.readByNonUser === false;
  const unread = unreadSignal && lastMessageFromGuest;

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
    c?.integration?.platform ??
    firstReservation?.integration?.platform ??
    firstReservation?.source ??
    c?.source ??
    (mod && (mod as any).type) ??
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
    String(firstReservation?.preApprovalStatus ?? "").toLowerCase() === "preapproved" ||
    resStatus.includes("preapproved") ||
    resStatus === "accepted";
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
    displayGuestPhone: guestPhone,
    displayGuestEmail: guestEmail,
    displayConfirmationCode: confirmationCode,
    isUnread: !!unread,
    needsReply: !!lastMessageFromGuest,
    lastMessageFromGuest: !!lastMessageFromGuest,
    needsPreapprove,
    phase,
    conversationChannel: String(channelRaw || ""),
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
  const [deliveryChannel, setDeliveryChannel] = useState(template?.deliveryChannel ?? "guesty");
  const [trigger, setTrigger] = useState(template?.trigger ?? "booking_confirmed");
  const [daysOffset, setDaysOffset] = useState(template?.daysOffset ?? 0);
  const [body, setBody] = useState(template?.body ?? "");
  const [isActive, setIsActive] = useState(template?.isActive ?? true);
  const needsDays = trigger === "days_after_booking" || trigger === "days_before_checkin" || trigger === "days_before_checkout" || trigger === "days_after_checkout";

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
        <div>
          <Label>Delivery Channel</Label>
          <Select value={deliveryChannel} onValueChange={setDeliveryChannel}>
            <SelectTrigger className="mt-1" data-testid="select-template-channel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TEMPLATE_CHANNEL_OPTIONS.map(o => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground mt-1">
            Text templates should stay short and link-focused. Guesty/email templates are the formal guest record.
          </p>
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
          onClick={() => onSave({ name, deliveryChannel, trigger, daysOffset, body, isActive })}
          disabled={!name || !body}
          data-testid="button-template-save"
        >
          Save Template
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

interface InboxAlternativePage {
  token: string;
  url: string;
  channel: string | null;
  guestName: string | null;
  checkIn: string | null;
  checkOut: string | null;
  createdAt: string | null;
  messageSentAt: string | null;
  messageChannel: string | null;
  opened: boolean;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  openCount: number;
  expiresAt: string | null;
  unitCount: number;
  unitTitles: string[];
}

// Surfaces the alternative-unit guest page (`/alternatives/:token`) for the
// selected reservation so the operator can copy the URL straight into a text to
// the guest — instead of digging the truncated "[url:...]" out of the sent
// message bubble. Renders nothing when the reservation has no alternative page
// (which is most of them), so it's safe to mount for every conversation.
function InboxAlternativePagePanel({ reservationId }: { reservationId: string }) {
  const { toast } = useToast();
  const { data } = useQuery<{ page: InboxAlternativePage | null }>({
    queryKey: ["/api/booking-alternatives/for-reservation", reservationId],
    enabled: !!reservationId,
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/booking-alternatives/for-reservation/${encodeURIComponent(reservationId)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 30_000,
  });
  const page = data?.page ?? null;
  if (!page) return null;

  const copyUrl = async () => {
    try {
      // Throw (not silently no-op) when the Clipboard API is unavailable —
      // `navigator.clipboard?.writeText` would short-circuit to undefined and
      // `await undefined` resolves, falsely reporting success. Falling into the
      // catch shows the honest "copy failed" prompt to use the field instead.
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(page.url);
      toast({ title: "Alternative page link copied", description: "Paste it into a text or message to the guest." });
    } catch {
      toast({ title: "Copy failed", description: "Select the link in the field and copy it manually.", variant: "destructive" });
    }
  };

  return (
    <div data-testid="panel-inbox-alternative-page">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1 flex items-center gap-1.5">
        <Link2 className="h-3 w-3" /> Alternative unit page
      </div>
      <div className="rounded-lg border bg-muted/30 p-2.5 space-y-2">
        <div className="text-[11px] text-muted-foreground">
          Guest page for {page.unitCount} unit{page.unitCount === 1 ? "" : "s"}
          {page.unitTitles.length > 0 ? ` · ${page.unitTitles.join(", ")}` : ""}
        </div>
        <div className="flex items-center gap-1.5">
          <input
            readOnly
            aria-label="Alternative unit guest page URL"
            value={page.url}
            onFocus={(e) => e.currentTarget.select()}
            className="flex-1 min-w-0 h-7 px-2 text-[11px] font-mono border rounded bg-background"
            data-testid="input-inbox-alternative-url"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px] shrink-0"
            onClick={copyUrl}
            data-testid="button-copy-inbox-alternative-url"
          >
            <Copy className="h-3 w-3 mr-1" /> Copy link
          </Button>
        </div>
        <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
          <a
            href={`${page.url}?preview=1`}
            target="_blank"
            rel="noreferrer"
            className="underline inline-flex items-center gap-1"
          >
            <ExternalLink className="h-3 w-3" /> Open preview
          </a>
          <span className="text-right">
            {page.messageSentAt
              ? `Sent ${formatDate(page.messageSentAt)}${page.opened ? ` · opened${page.openCount ? ` ${page.openCount}×` : ""} ✓` : " · not opened yet"}`
              : "Not sent to guest yet"}
          </span>
        </div>
      </div>
    </div>
  );
}

function InboxBuyInPanel({
  reservationId,
  guestName,
  data,
}: {
  reservationId: string;
  guestName?: string;
  data?: InboxBuyInCommunications;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [composeId, setComposeId] = useState<number | null>(null);
  const [emailDrafts, setEmailDrafts] = useState<Record<number, { subject: string; body: string }>>({});
  const [emailAttachments, setEmailAttachments] = useState<Record<number, AliasEmailAttachment[]>>({});

  const saveDetails = useMutation({
    mutationFn: ({ id, values }: { id: number; values: Record<string, string> }) =>
      apiRequest("PATCH", `/api/buy-ins/${id}`, values).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/bookings", reservationId, "buy-in-communications"] });
      qc.invalidateQueries({ queryKey: ["/api/bookings", reservationId, "arrival-details"] });
      setEditingId(null);
      toast({ title: "Buy-in details saved" });
    },
    onError: (err: any) => toast({ title: "Save failed", description: err?.message ?? "Could not save buy-in details", variant: "destructive" }),
  });

  const sendVendorEmail = useMutation({
    mutationFn: ({ unit, contact }: { unit: InboxBuyInRecord; contact?: InboxVendorContactRecord }) => {
      const draft = emailDrafts[unit.id] ?? buildDefaultVendorEmailDraft(unit, guestName);
      const vendorEmail = contact?.vendorEmail ?? extractEmailForInput(unit.managementContact ?? "");
      return apiRequest("POST", `/api/buy-ins/${unit.id}/vendor-email`, {
        reservationId,
        guestName: guestName ?? "",
        vendorName: contact?.vendorName ?? unit.managementCompany ?? "",
        vendorEmail,
        subject: draft.subject,
        body: draft.body,
        attachments: emailAttachments[unit.id] ?? [],
      }).then((r) => r.json());
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/bookings", reservationId, "buy-in-communications"] });
      setEmailAttachments((prev) => composeId ? { ...prev, [composeId]: [] } : prev);
      setComposeId(null);
      toast({ title: "PM email sent", description: "The message is saved in this guest's buy-in email history." });
    },
    onError: (err: any) => toast({ title: "Email failed", description: err?.message ?? "Could not send PM email", variant: "destructive" }),
  });

  // ── Inline reply to a specific email in the Alias email history ─────────────
  // Freeform body + "Re: …" subject, sent to the vendor's real address via the
  // same reverse-alias send path. One reply composer open across all units.
  const [replyingEmailId, setReplyingEmailId] = useState<number | null>(null);
  const [replySubjectValue, setReplySubjectValue] = useState("");
  const [replyBody, setReplyBody] = useState("");
  const [replyAttachments, setReplyAttachments] = useState<AliasEmailAttachment[]>([]);
  const closeReply = () => {
    setReplyingEmailId(null);
    setReplySubjectValue("");
    setReplyBody("");
    setReplyAttachments([]);
  };
  const startReply = (email: { id: number; subject: string }) => {
    setReplyingEmailId(email.id);
    setReplySubjectValue(replySubjectForBuyInEmail(email.subject));
    setReplyBody("");
    setReplyAttachments([]);
  };
  const addReplyAttachments = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      const next = await filesToAliasEmailAttachments(files);
      setReplyAttachments((prev) => [...prev, ...next]);
    } catch (err: any) {
      toast({ title: "Attachment skipped", description: err?.message ?? "Could not read attachment", variant: "destructive" });
    }
  };
  const replyVendorEmail = useMutation({
    // Takes the whole `unit` (like sendVendorEmail) so the buy-in id flows through a
    // template literal — InboxBuyInRecord.id is typed number|undefined.
    mutationFn: (vars: { unit: InboxBuyInRecord; emailId: number; toEmail: string; vendorName: string; subject: string; body: string; attachments: AliasEmailAttachment[] }) =>
      apiRequest("POST", `/api/buy-ins/${vars.unit.id}/vendor-email`, {
        reservationId,
        guestName: guestName ?? "",
        vendorName: vars.vendorName,
        vendorEmail: vars.toEmail,
        subject: vars.subject,
        body: vars.body,
        attachments: vars.attachments,
      }).then((r) => r.json()),
    onSuccess: (result: { delivery?: string }, vars) => {
      qc.invalidateQueries({ queryKey: ["/api/bookings", reservationId, "buy-in-communications"] });
      // Only close if THIS email's composer is still the open one — defensive so an
      // in-flight reply resolving can't wipe a composer opened on a different email.
      if (replyingEmailId === vars.emailId) closeReply();
      toast({
        title: "Reply sent",
        description: result?.delivery === "direct"
          ? "Sent directly to the PM/vendor. Replies come to the reservations mailbox."
          : "Sent from the guest alias — the PM's reply routes back through the portal.",
      });
    },
    onError: (err: any) => toast({ title: "Reply failed", description: err?.message ?? "Could not send reply", variant: "destructive" }),
  });

  const units = data?.buyIns ?? [];
  if (units.length === 0 && !data?.alias) return null;

  const startEdit = (unit: InboxBuyInRecord) => {
    setEditingId(unit.id);
    setForm({
      managementCompany: unit.managementCompany ?? "",
      managementContact: unit.managementContact ?? "",
      unitAddress: unit.unitAddress ?? "",
      accessCode: unit.accessCode ?? "",
      wifiName: unit.wifiName ?? "",
      wifiPassword: unit.wifiPassword ?? "",
      parkingInfo: unit.parkingInfo ?? "",
      arrivalNotes: unit.arrivalNotes ?? "",
    });
  };
  const set = (key: string, value: string) => setForm((prev) => ({ ...prev, [key]: value }));
  const updateEmailDraft = (unit: InboxBuyInRecord, key: "subject" | "body", value: string) => {
    setEmailDrafts((prev) => ({
      ...prev,
      [unit.id]: {
        ...(prev[unit.id] ?? buildDefaultVendorEmailDraft(unit, guestName)),
        [key]: value,
      },
    }));
  };
  const startCompose = (unit: InboxBuyInRecord) => {
    setComposeId(unit.id);
    setEmailDrafts((prev) => ({
      ...prev,
      [unit.id]: prev[unit.id] ?? buildDefaultVendorEmailDraft(unit, guestName),
    }));
  };
  const addEmailAttachments = async (unitId: number, files: FileList | null) => {
    if (!files?.length) return;
    try {
      const next = await filesToAliasEmailAttachments(files);
      setEmailAttachments((prev) => ({ ...prev, [unitId]: [...(prev[unitId] ?? []), ...next] }));
    } catch (err: any) {
      toast({ title: "Attachment skipped", description: err?.message ?? "Could not read attachment", variant: "destructive" });
    }
  };

  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">
        Buy-in
      </div>
      <div className="border rounded-lg divide-y text-xs">
        {data?.alias && (
          <div className="px-2.5 py-2">
            <div className="flex flex-wrap items-center gap-1.5 font-medium">
              <Mail className="h-3.5 w-3.5" />
              <span className="truncate">{data.alias.aliasEmail}</span>
              {(() => {
                const expiry = aliasExpirationSummary(data.alias.expiresAt);
                return (
                  <Badge variant={expiry.expired ? "destructive" : "secondary"} className="text-[10px]">
                    {expiry.expired ? "Expired" : `Expires ${expiry.date}`}
                  </Badge>
                );
              })()}
            </div>
            {(() => {
              const expiry = aliasExpirationSummary(data.alias.expiresAt);
              return (
                <div className="text-[11px] text-muted-foreground">
                  Forwards to {data.alias.mailboxEmail} until {expiry.date} ({expiry.relative}). Saved messages and attachments are retained after expiration.
                </div>
              );
            })()}
          </div>
        )}
        {units.map((unit) => {
          const contact = data?.contacts?.find((row) => row.buyInId === unit.id);
          const emails = (data?.emails ?? []).filter((row) => row.buyInId === unit.id);
          // This unit's own guest alias (reverse alias belongs to it); fall back to
          // the reservation-level alias for legacy single-alias rows.
          const unitAliasEmail = data?.aliases?.find((row) => row.buyInId === unit.id)?.aliasEmail ?? data?.alias?.aliasEmail ?? null;
          const editing = editingId === unit.id;
          const composing = composeId === unit.id;
          const draft = emailDrafts[unit.id] ?? buildDefaultVendorEmailDraft(unit, guestName);
          const vendorEmail = contact?.vendorEmail ?? extractEmailForInput(unit.managementContact ?? "");
          return (
            <div key={unit.id} className="px-2.5 py-2 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium truncate">{unit.unitLabel || unit.propertyName}</div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {unit.managementCompany || "PM not saved"} · {contact?.vendorEmail || unit.managementContact || "No vendor email"}
                  </div>
                  {contact?.reverseAliasEmail && (
                    <div className="text-[10px] text-muted-foreground font-mono truncate">{contact.reverseAliasEmail}</div>
                  )}
                </div>
                <Button size="sm" variant="outline" className="h-7" onClick={() => editing ? setEditingId(null) : startEdit(unit)}>
                  {editing ? "Close" : "Edit"}
                </Button>
              </div>
              {editing && (
                <div className="space-y-1.5">
                  <Input className="h-8 text-xs" value={form.managementCompany ?? ""} onChange={(e) => set("managementCompany", e.target.value)} placeholder="Management company" />
                  <Input className="h-8 text-xs" value={form.managementContact ?? ""} onChange={(e) => set("managementContact", e.target.value)} placeholder="PM email / phone" />
                  <Input className="h-8 text-xs" value={form.unitAddress ?? ""} onChange={(e) => set("unitAddress", e.target.value)} placeholder="Unit address" />
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input className="h-8 text-xs" value={form.accessCode ?? ""} onChange={(e) => set("accessCode", e.target.value)} placeholder="Access code" />
                    <Input className="h-8 text-xs" value={form.parkingInfo ?? ""} onChange={(e) => set("parkingInfo", e.target.value)} placeholder="Parking" />
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Input className="h-8 text-xs" value={form.wifiName ?? ""} onChange={(e) => set("wifiName", e.target.value)} placeholder="Wi-Fi name" />
                    <Input className="h-8 text-xs" value={form.wifiPassword ?? ""} onChange={(e) => set("wifiPassword", e.target.value)} placeholder="Wi-Fi password" />
                  </div>
                  <Textarea rows={3} className="text-xs" value={form.arrivalNotes ?? ""} onChange={(e) => set("arrivalNotes", e.target.value)} placeholder="Arrival notes" />
                  <Button size="sm" className="w-full" disabled={saveDetails.isPending} onClick={() => saveDetails.mutate({ id: unit.id, values: form })}>
                    {saveDetails.isPending ? "Saving..." : "Save buy-in details"}
                  </Button>
                </div>
              )}
              <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                <div>
                  <span className="text-muted-foreground">Address:</span> {unit.unitAddress || "Not saved"}
                </div>
                <div>
                  <span className="text-muted-foreground">Access:</span> {unit.accessCode || "Not saved"}
                </div>
                <div>
                  <span className="text-muted-foreground">Wi-Fi:</span> {unit.wifiName || "Not saved"}
                </div>
                <div>
                  <span className="text-muted-foreground">Parking:</span> {unit.parkingInfo || "Not saved"}
                </div>
              </div>
              <details className="rounded-md border bg-background/60 p-2" open={emails.length > 0}>
                <summary className="cursor-pointer text-[11px] font-medium">
                  Alias email history ({emails.length})
                </summary>
                <div className="mt-2 space-y-2">
                  {emails.length === 0 && (
                    <div className="text-[11px] text-muted-foreground">
                      No PM/vendor emails saved for this unit yet.
                    </div>
                  )}
                  {emails.map((email) => (
                    <div key={email.id} className="rounded border bg-muted/20 p-2">
                      {(() => {
                        const attachments = parseAliasEmailAttachments(email.attachmentsJson);
                        // What the PM actually saw: reverse-alias sends show the guest
                        // alias as sender (SimpleLogin masks the reservations mailbox).
                        // Resolve THIS email's vendor by matching its recipient to the
                        // reverse alias (a buy-in can have >1 vendor contact).
                        const emailContact = data?.contacts?.find(
                          (c) => c.reverseAliasEmail && c.reverseAliasEmail.toLowerCase() === (email.toEmail ?? "").trim().toLowerCase(),
                        ) ?? contact;
                        const emailCtx = {
                          aliasEmail: unitAliasEmail,
                          vendorEmail: emailContact?.vendorEmail,
                          reverseAliasEmail: emailContact?.reverseAliasEmail,
                        };
                        const seen = vendorVisibleEmailAddresses(email, emailCtx);
                        const replyTo = replyRecipientForBuyInEmail(email, emailCtx);
                        const isReplying = replyingEmailId === email.id;
                        return (
                          <>
                            <div className="flex items-start justify-between gap-2">
                              <span className="text-xs font-semibold leading-snug">{email.subject}</span>
                              <div className="flex shrink-0 items-center gap-1.5">
                                <Badge variant={email.direction === "inbound" ? "secondary" : "outline"} className="text-[10px]">
                                  {email.direction}
                                </Badge>
                                {replyTo && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 gap-1 px-1.5 text-[10px]"
                                    onClick={() => isReplying ? closeReply() : startReply(email)}
                                    disabled={replyVendorEmail.isPending}
                                    title={isReplying ? "Cancel reply" : `Reply to ${replyTo}`}
                                  >
                                    <Reply className="h-3 w-3" />
                                    {isReplying ? "Cancel" : "Reply"}
                                  </Button>
                                )}
                              </div>
                            </div>
                            <div className="mt-1.5 space-y-0.5 border-b pb-2 text-[10px] text-muted-foreground">
                              <div className="truncate">
                                <span className="font-medium">From:</span> {seen.from}
                              </div>
                              <div className="truncate">
                                <span className="font-medium">To:</span> {seen.to}
                              </div>
                              {seen.mailboxFrom && (
                                <div className="text-[9px] italic opacity-80">
                                  What the PM sees — masked by SimpleLogin. Routed via {seen.mailboxFrom} → {email.toEmail}.
                                </div>
                              )}
                              <div>
                                {formatEmailTimestampForDisplay(email.sentAt) ?? "—"} · {email.status ?? "saved"}
                              </div>
                            </div>
                            <div className="mt-2 whitespace-pre-wrap text-xs leading-relaxed">
                              {formatEmailBodyForDisplay(email.body)}
                            </div>
                            {attachments.length > 0 && (
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {attachments.map((attachment, index) => {
                                  const href = aliasAttachmentHref(attachment);
                                  const label = `${attachment.filename}${formatAttachmentSize(attachment.size) ? ` · ${formatAttachmentSize(attachment.size)}` : ""}`;
                                  return href ? (
                                    <a
                                      key={`${attachment.filename}-${index}`}
                                      href={href}
                                      download={attachment.filename}
                                      target={attachment.url ? "_blank" : undefined}
                                      rel={attachment.url ? "noreferrer" : undefined}
                                      className="inline-flex max-w-full items-center gap-1 rounded border bg-background px-1.5 py-0.5 text-[10px] text-primary hover:underline"
                                    >
                                      <Paperclip className="h-3 w-3 shrink-0" />
                                      <span className="truncate">{label}</span>
                                    </a>
                                  ) : (
                                    <span
                                      key={`${attachment.filename}-${index}`}
                                      className="inline-flex max-w-full items-center gap-1 rounded border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground"
                                    >
                                      <Paperclip className="h-3 w-3 shrink-0" />
                                      <span className="truncate">{label}</span>
                                    </span>
                                  );
                                })}
                              </div>
                            )}
                            {isReplying && replyTo && (
                              <div className="mt-2.5 space-y-1.5 rounded-md border bg-background/70 p-2">
                                <div className="text-[10px] text-muted-foreground">
                                  Reply to <span className="font-mono">{replyTo}</span>
                                  {unitAliasEmail
                                    ? <> · sent from the guest alias <span className="font-mono">{unitAliasEmail}</span></>
                                    : <> · sent directly to the PM/vendor</>}
                                </div>
                                <Input
                                  className="h-8 text-xs"
                                  value={replySubjectValue}
                                  onChange={(e) => setReplySubjectValue(e.target.value)}
                                  placeholder="Subject"
                                  aria-label="Reply subject"
                                />
                                <Textarea
                                  rows={5}
                                  className="text-xs"
                                  value={replyBody}
                                  onChange={(e) => setReplyBody(e.target.value)}
                                  placeholder="Type your reply…"
                                  aria-label="Reply message"
                                  autoFocus
                                />
                                <div className="rounded-md border bg-background/60 p-2">
                                  <Label htmlFor={`inbox-reply-attachments-${email.id}`} className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium">
                                    <Paperclip className="h-3 w-3" />
                                    Attachments
                                  </Label>
                                  <Input
                                    id={`inbox-reply-attachments-${email.id}`}
                                    type="file"
                                    multiple
                                    className="h-8 text-xs"
                                    onChange={(event) => {
                                      void addReplyAttachments(event.currentTarget.files);
                                      event.currentTarget.value = "";
                                    }}
                                  />
                                  {replyAttachments.length > 0 && (
                                    <div className="mt-2 flex flex-wrap gap-1.5">
                                      {replyAttachments.map((attachment, index) => (
                                        <Badge key={`${attachment.filename}-${index}`} variant="secondary" className="gap-1 text-[10px]">
                                          <Paperclip className="h-3 w-3" />
                                          <span className="max-w-[180px] truncate">{attachment.filename}</span>
                                          {formatAttachmentSize(attachment.size) && <span>{formatAttachmentSize(attachment.size)}</span>}
                                          <button
                                            type="button"
                                            className="ml-0.5 rounded-sm hover:bg-background/70"
                                            onClick={() => setReplyAttachments((prev) => prev.filter((_, i) => i !== index))}
                                            aria-label={`Remove ${attachment.filename}`}
                                          >
                                            <X className="h-3 w-3" />
                                          </button>
                                        </Badge>
                                      ))}
                                    </div>
                                  )}
                                </div>
                                <div className="flex items-center justify-end gap-2">
                                  <Button size="sm" variant="ghost" className="h-8" onClick={closeReply} disabled={replyVendorEmail.isPending}>
                                    Cancel
                                  </Button>
                                  <Button
                                    size="sm"
                                    className="h-8"
                                    onClick={() => replyVendorEmail.mutate({
                                      unit,
                                      emailId: email.id,
                                      toEmail: replyTo,
                                      vendorName: emailContact?.vendorName ?? unit.managementCompany ?? "",
                                      subject: replySubjectValue.trim() || replySubjectForBuyInEmail(email.subject),
                                      body: replyBody,
                                      attachments: replyAttachments,
                                    })}
                                    disabled={replyVendorEmail.isPending || !replyBody.trim()}
                                  >
                                    {replyVendorEmail.isPending ? "Sending…" : "Send reply"}
                                  </Button>
                                </div>
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  ))}
                </div>
              </details>
              <div className="space-y-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 w-full justify-start text-[11px]"
                  onClick={() => composing ? setComposeId(null) : startCompose(unit)}
                  disabled={!vendorEmail}
                  title={vendorEmail ? `Send via alias to ${vendorEmail}` : "Save a PM/vendor email first"}
                >
                  <Mail className="h-3 w-3 mr-1.5" />
                  {composing ? "Close PM email composer" : "Write PM/vendor email"}
                </Button>
                {composing && (
                  <div className="space-y-1.5 rounded-md border bg-background/60 p-2">
                    <Input
                      className="h-8 text-xs"
                      value={draft.subject}
                      onChange={(e) => updateEmailDraft(unit, "subject", e.target.value)}
                      placeholder="Subject"
                    />
                    <Textarea
                      rows={5}
                      className="text-xs"
                      value={draft.body}
                      onChange={(e) => updateEmailDraft(unit, "body", e.target.value)}
                      placeholder="Message to PM/vendor"
                    />
                    <div className="rounded-md border bg-background/60 p-2">
                      <Label className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium">
                        <Paperclip className="h-3 w-3" />
                        Attachments
                      </Label>
                      <Input
                        type="file"
                        multiple
                        className="h-8 text-xs"
                        onChange={(event) => {
                          void addEmailAttachments(unit.id, event.currentTarget.files);
                          event.currentTarget.value = "";
                        }}
                      />
                      {(emailAttachments[unit.id] ?? []).length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {(emailAttachments[unit.id] ?? []).map((attachment, index) => (
                            <Badge key={`${attachment.filename}-${index}`} variant="secondary" className="gap-1 text-[10px]">
                              <Paperclip className="h-3 w-3" />
                              <span className="max-w-[160px] truncate">{attachment.filename}</span>
                              {formatAttachmentSize(attachment.size) && <span>{formatAttachmentSize(attachment.size)}</span>}
                              <button
                                type="button"
                                className="ml-0.5 rounded-sm hover:bg-background/70"
                                onClick={() => setEmailAttachments((prev) => ({
                                  ...prev,
                                  [unit.id]: (prev[unit.id] ?? []).filter((_, i) => i !== index),
                                }))}
                                aria-label={`Remove ${attachment.filename}`}
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                    <Button
                      size="sm"
                      className="w-full"
                      disabled={sendVendorEmail.isPending || !vendorEmail || !draft.subject.trim() || !draft.body.trim()}
                      onClick={() => sendVendorEmail.mutate({ unit, contact })}
                    >
                      {sendVendorEmail.isPending ? "Sending..." : `Send to ${vendorEmail}`}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Live buy-in search results (read-only) ─────────────────────────────────────
// Renders the serialized auto-fill job status (AutoFillJobStatus) from a DRY-RUN
// run started by POST /api/inbox/buy-in-search. This is the SAME search the
// Operations "Auto-fill cheapest" runs (sidecar + cheapest same-community combos),
// but attaches nothing — so this panel is purely informational. `attached` holds
// the would-be cheapest combo; `comboOptions` the other walkable combos; and the
// per-city ladder / summary explain what was found. NO attach buttons by design.
function InboxBuyInSearchResults({ status }: { status: any }) {
  const money = (n: any) =>
    typeof n === "number" && Number.isFinite(n) ? `$${Math.round(n).toLocaleString()}` : "—";
  const running = !status?.done;
  const attached: any[] = Array.isArray(status?.attached) ? status.attached : [];
  const comboOptions: any[] = Array.isArray(status?.comboOptions) ? status.comboOptions : [];
  // Alternatives = surfaced walkable combos that were NOT the chosen cheapest.
  const alternatives = comboOptions.filter((o) => o && Array.isArray(o.picks) && o.picks.length > 0);
  const cityEconomics: any[] = Array.isArray(status?.cityEconomics) ? status.cityEconomics : [];
  const skipped: any[] = Array.isArray(status?.skipped) ? status.skipped : [];
  const progress = Math.max(0, Math.min(100, Number(status?.progress) || 0));

  const PickRow = ({ label, sub, price, url }: { label: string; sub?: string; price: any; url?: string }) => (
    <div className="flex justify-between items-start gap-2 px-2.5 py-1.5">
      <span className="text-muted-foreground min-w-0">
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" className="hover:underline inline-flex items-center gap-1 break-words">
            {label}
            <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
          </a>
        ) : (
          label
        )}
        {sub ? <span className="block text-[10px] text-muted-foreground/70 truncate">{sub}</span> : null}
      </span>
      <span className="whitespace-nowrap">{money(price)}</span>
    </div>
  );

  return (
    <div className="space-y-2">
      {/* Live status line */}
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        {running ? <Loader2 className="h-3 w-3 animate-spin shrink-0" /> : <CheckCircle className="h-3 w-3 text-green-600 shrink-0" />}
        <span className="truncate">{status?.message || (running ? "Searching…" : "Search complete")}</span>
      </div>
      {running && (
        <div className="h-1 w-full rounded bg-muted overflow-hidden">
          <div className="h-full bg-blue-500 transition-all" style={{ width: `${progress}%` }} />
        </div>
      )}

      {/* Cheapest combo found (the would-be attach) */}
      {attached.length > 0 && (
        <div className="border rounded-lg divide-y text-xs">
          <div className="px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-green-800 bg-green-50 dark:bg-green-950/20 font-medium">
            Cheapest option found
          </div>
          {attached.map((a, i) => (
            <PickRow
              key={i}
              label={`${a.unitLabel} · ${a.bedrooms}BR · ${a.sourceLabel}`}
              sub={a.title}
              price={a.totalPrice}
              url={a.url}
            />
          ))}
          {typeof status?.totalCost === "number" && (
            <div className="flex justify-between px-2.5 py-2 bg-green-50 dark:bg-green-950/20 font-semibold">
              <span className="text-green-900">Total buy-in cost</span>
              <span className="text-green-900">{money(status.totalCost)}</span>
            </div>
          )}
        </div>
      )}

      {/* Other walkable combos surfaced from the same / nearby pools */}
      {alternatives.length > 0 && (
        <div className="border rounded-lg divide-y text-xs">
          <div className="px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
            Other options found ({alternatives.length})
          </div>
          {alternatives.slice(0, 6).map((o, i) => (
            <div key={i} className="px-2.5 py-1.5">
              <div className="flex justify-between items-center gap-2">
                <span className="font-medium truncate">{o.label || "Combo"}</span>
                <span className="whitespace-nowrap">{money(o.totalCost)}</span>
              </div>
              <div className="mt-0.5 space-y-0.5">
                {(o.picks as any[]).map((p, j) => (
                  <div key={j} className="flex justify-between items-center gap-2 text-[11px] text-muted-foreground">
                    {p.url ? (
                      <a href={p.url} target="_blank" rel="noreferrer" className="hover:underline inline-flex items-center gap-1 min-w-0 truncate">
                        {p.bedrooms}BR · {p.sourceLabel || p.source}
                        <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
                      </a>
                    ) : (
                      <span className="min-w-0 truncate">{p.bedrooms}BR · {p.sourceLabel || p.source}</span>
                    )}
                    <span className="whitespace-nowrap">{money(p.totalPrice)}</span>
                  </div>
                ))}
              </div>
              {o.isLoss && typeof o.lossProfit === "number" && (
                <div className="mt-0.5 text-[10px] text-red-700">Would lose {money(Math.abs(o.lossProfit))} at the quoted rate</div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Per-city ladder — what each searched city/area offered */}
      {cityEconomics.length > 0 && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Cities searched ({cityEconomics.length})
          </summary>
          <div className="mt-1 border rounded-lg divide-y">
            {cityEconomics.map((c, i) => (
              <div key={i} className="px-2.5 py-1.5">
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground truncate">{c.label}</span>
                  <span className="whitespace-nowrap">{money(c.comboCost)}</span>
                </div>
                {c.reason ? <div className="text-[10px] text-muted-foreground/70 mt-0.5">{c.reason}</div> : null}
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Done with nothing surfaced — explain */}
      {!running && attached.length === 0 && alternatives.length === 0 && (
        <div className="text-[11px] text-muted-foreground italic px-2 py-1.5 border rounded-lg">
          {status?.message || "No buy-in combinations were found for these dates."}
          {skipped.length > 0 && (
            <ul className="mt-1 list-disc pl-4 not-italic">
              {skipped.slice(0, 4).map((s, i) => (
                <li key={i}>{s.reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function InboxPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [location] = useLocation();
  const { data: session } = usePortalSession();
  const isAgent = session?.role === "agent";
  const isAdmin = session?.role === "admin";
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  // Controlled so the Guest Issues tab's "Open conversation" can jump to Messages.
  const [activeTab, setActiveTab] = useState<string>("messages");
  const [replyText, setReplyText] = useState("");
  // Christal (agent) writes every guest message signed "Mahalo, Christal": her
  // compose box is pre-seeded with the sign-off (she types above it). Seed when
  // she opens a conversation with an empty box; the send handlers re-seed after
  // each send. Admin/operator boxes are untouched (start empty). The functional
  // updater reads the latest text, so switching conversations never clobbers a
  // draft in progress — it only fills an empty box.
  useEffect(() => {
    if (!isAgent || !selectedConvId) return;
    setReplyText((prev) => (prev.trim() ? prev : AGENT_COMPOSE_SEED));
  }, [isAgent, selectedConvId]);
  // True when the agent's box holds ONLY the seeded sign-off (no message yet) —
  // used to keep Send disabled so a signature-only reply can't be sent by mistake.
  const replyIsOnlySignoff = isAgent && replyText.trim() === AGENT_REPLY_SIGNOFF;
  const replyRef = useRef<HTMLTextAreaElement>(null);
  // After a send the box re-seeds while the textarea may still hold focus (a
  // Cmd/Ctrl+Enter send never blurs it, so onFocus won't re-fire) — drop the
  // caret above the sign-off imperatively once the seeded value has committed,
  // so her next message is typed above "Mahalo, Christal".
  const caretToTopPendingRef = useRef(false);
  useEffect(() => {
    if (!caretToTopPendingRef.current) return;
    caretToTopPendingRef.current = false;
    const el = replyRef.current;
    if (el && el.value === AGENT_COMPOSE_SEED) el.setSelectionRange(0, 0);
  }, [replyText]);
  const [draftLoading, setDraftLoading] = useState(false);
  const [templateDialog, setTemplateDialog] = useState<{ open: boolean; template: Partial<MessageTemplate> | null }>({ open: false, template: null });
  const [templatePreview, setTemplatePreview] = useState<{ open: boolean; title: string; body: string; channel: "guesty" | "sms" }>({ open: false, title: "", body: "", channel: "guesty" });
  const [airbnbPreapprovedIds, setAirbnbPreapprovedIds] = useState<Set<string>>(() => readStoredAirbnbPreapprovals());
  const [guestPhoneInput, setGuestPhoneInput] = useState("");
  const [callbackCall, setCallbackCall] = useState<QuoCallEvent | null>(null);
  const [callbackSummary, setCallbackSummary] = useState("");
  // Property filter for the conversation list — narrows the visible
  // conversations to a single listing nickname. Defaults to "all" so
  // nothing is hidden until the user picks a property.
  const [propertyFilter, setPropertyFilter] = useState<string>("all");
  // Reply-status filter for the conversation list. "unread" here means
  // "guest is waiting on us" rather than merely "thread was opened" —
  // see normalizeConversation.needsReply.
  const [replyStatusFilter, setReplyStatusFilter] = useState<"all" | "unread" | "read">("all");
  // Free-text search across the whole conversation list — guest name,
  // email, phone (digits-insensitive), listing, last-message preview, and
  // reservation confirmation code. Lets the operator jump straight to a
  // guest's thread without scrolling. Applied in `filteredConversations`.
  const [searchQuery, setSearchQuery] = useState("");
  // Guesty's conversation list can lag for a short period after
  // /send-message succeeds. Hide the reply-needed marker locally as
  // soon as our send completes; if the guest replies again with a newer
  // last-message timestamp, the marker comes back.
  const [locallyRepliedAtByConversation, setLocallyRepliedAtByConversation] = useState<Record<string, number>>({});
  // Manual right-click "Mark as read / unread" overrides — see
  // readStoredInboxReadOverrides. Persisted so the operator's choice (and the
  // header unread count it drives) survives a page refresh.
  const [inboxReadOverrides, setInboxReadOverrides] = useState<Record<string, InboxReadOverride>>(
    () => readStoredInboxReadOverrides(),
  );
  useEffect(() => {
    writeStoredInboxReadOverrides(inboxReadOverrides);
  }, [inboxReadOverrides]);
  // Receipt template state. Pre-populated from Guesty's money fields
  // when the dialog opens; every value is editable so the operator can
  // correct stale Guesty data on the spot. The body regenerates from
  // these inputs until the operator types into the textarea — at that
  // point we stop overwriting their edits (`receiptBodyTouched`).
  const [receiptDialog, setReceiptDialog] = useState<{
    open: boolean;
    reservationId: string | null;
    propertyName: string;
    guestFirstName: string;
    guestFullName?: string;
    checkInIso?: string;
    checkOutIso?: string;
    confirmationCode?: string;
    channel?: string;
    conversationId?: string;
  }>({ open: false, reservationId: null, propertyName: "", guestFirstName: "" });
  const [receiptPaymentAmount, setReceiptPaymentAmount] = useState<string>("");
  const [receiptPaymentDate, setReceiptPaymentDate] = useState<string>("");
  const [receiptTotalPrice, setReceiptTotalPrice] = useState<string>("");
  // Editable list of prior payments shown to the guest as a per-line
  // breakdown ("Jan 5, 2026: $4,200 · Feb 28, 2026: $4,000 · today: $200").
  // Pre-populated from Guesty's payment records when the dialog opens;
  // operator can edit, add, or remove rows on the fly.
  const [receiptPastPayments, setReceiptPastPayments] = useState<
    Array<{ id: string; date: string; amount: string }>
  >([]);
  const [receiptPaymentsLoading, setReceiptPaymentsLoading] = useState<boolean>(false);
  const [receiptBody, setReceiptBody] = useState<string>("");
  const [receiptBodyTouched, setReceiptBodyTouched] = useState<boolean>(false);
  // The durable /receipt/:token payment-details page URL once generated on the
  // fly for this dialog (empty until the operator clicks "Generate page link").
  const [receiptPageUrl, setReceiptPageUrl] = useState<string>("");
  const [receiptPageError, setReceiptPageError] = useState<string>("");
  const threadRef = useRef<HTMLDivElement>(null);
  const deepLinkNoticeRef = useRef<string | null>(null);

  const inboxDeepLink = useMemo(() => {
    const search = typeof window !== "undefined"
      ? window.location.search
      : (location.includes("?") ? `?${location.split("?")[1]}` : "");
    const params = new URLSearchParams(search);
    return {
      conversationId: params.get("conversationId") || params.get("conversation") || null,
      reservationId: params.get("reservationId") || params.get("reservation") || null,
      guest: params.get("guest") || null,
      confirmation: params.get("confirmation") || null,
    };
  }, [location]);

  const previewTemplateBody = (title: string, body: string, channel: "guesty" | "sms" = "guesty") => {
    setTemplatePreview({ open: true, title, body, channel });
  };

  const rememberAirbnbPreapproval = (reservationId: string) => {
    setAirbnbPreapprovedIds((prev) => {
      const next = new Set(prev);
      next.add(reservationId);
      writeStoredAirbnbPreapprovals(next);
      return next;
    });
  };

  const forgetAirbnbPreapproval = (reservationId: string) => {
    setAirbnbPreapprovedIds((prev) => {
      const next = new Set(prev);
      next.delete(reservationId);
      writeStoredAirbnbPreapprovals(next);
      return next;
    });
  };

  // ── Conversations ──
  // Guesty Open API mounts conversations under /communication/ — see
  // https://open-api-docs.guesty.com/reference/get_communication-conversations
  const { data: convData, isLoading: convLoading, error: convError } = useQuery<any>({
    queryKey: ["/api/guesty-proxy/communication/conversations"],
    queryFn: async () => {
      // CRITICAL: the trailing `&fields=` IS LOAD-BEARING — do not delete.
      // Guesty's /communication/conversations list endpoint returns a
      // STRIPPED state object by default (`{read, status}` only). Passing
      // `fields=` (even empty) flips it to "return the full document",
      // which expands `state` to include `state.lastMessage.{body, date}`,
      // `state.readByNonUser`, `state.isLastPostFromGuest`, plus
      // `updatedAt`, `lastMessageFrom`, etc. Without it, every conversation
      // row falls back to the THREAD creation date for its timestamp and
      // never shows an unread dot — which is exactly how Michelle's Kaha
      // Lani thread (69ea7b4608e5bc000f8e89ef) stayed pinned at Apr 23
      // even after her May 3 follow-up. NOTE FOR CODEX: this is a Guesty
      // API quirk, not a typo. The previous PR added the client-side
      // unwrapping logic but missed that the data wasn't being requested
      // in the first place — adding `fields=` is what actually makes the
      // unwrapping useful. Verified 2026-05-04 against production: omit
      // it and `state.lastMessage` is missing on every list row.
      // &sort=-lastMessageAt mirrors the server auto-reply scheduler so Guesty
      // returns the freshest-by-activity conversations in the first page (the
      // client still re-sorts by state.lastMessage.date below).
      const r = await apiRequest("GET", "/api/guesty-proxy/communication/conversations?limit=100&sort=-lastMessageAt&fields=");
      if (!r.ok) throw new Error(`Guesty returned HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 60_000,
    // The global queryClient defaults are refetchOnWindowFocus:false +
    // staleTime:Infinity and the poll PAUSES while the tab is hidden — so without
    // these per-query overrides the inbox can look frozen for up to a full
    // interval after the operator tabs back. Keep them ON for the inbox so a
    // returning operator sees new guest messages immediately.
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: true,
    staleTime: 0,
  });
  // Guesty's Open API wraps list responses as:
  //   { status: 200, data: { count, countUnread, conversations: [...], cursor, ... } }
  // Older/other endpoints may return:
  //   { results: [...] } or { data: [...] } or a bare array.
  // unwrapList() finds the array by checking known list field names at every depth.
  const conversations: GuestyConversation[] = unwrapList<GuestyConversation>(convData, [
    "conversations", "results", "data",
  ]);

  const { data: missedCallData } = useQuery<{ calls: QuoCallEvent[]; count: number }>({
    queryKey: ["/api/inbox/calls/unacknowledged"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/inbox/calls/unacknowledged?limit=100");
      if (!r.ok) throw new Error(`Missed calls returned HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
  const missedCalls = missedCallData?.calls ?? [];
  const missedCallCount = missedCallData?.count ?? missedCalls.length;
  const missedCallsByConversation = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const call of missedCalls) {
      if (!call.conversationId) continue;
      counts[call.conversationId] = (counts[call.conversationId] ?? 0) + 1;
    }
    return counts;
  }, [missedCalls]);

  // ── Guest-question tiers (2026-07-10) ──
  // Latest auto-reply log per conversation → "Tier 1 · AI answered" (green) /
  // "Tier 2 · no auto-reply" (amber) badges on the list rows + thread header.
  // The endpoint is a cheap single DB read (no Guesty calls), safe to poll.
  const { data: tierRows } = useQuery<Array<{
    conversationId: string;
    logId: number;
    tier: number | null;
    tierReason: string | null;
    status: string;
    replySent: boolean;
    autoSent: boolean;
    createdAt: string;
  }>>({
    queryKey: ["/api/inbox/auto-reply/tiers"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/inbox/auto-reply/tiers");
      if (!r.ok) throw new Error(`Tier map returned HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
  const tierBadgeByConversation = useMemo(() => {
    const map: Record<string, AutoReplyTierBadge> = {};
    for (const row of tierRows ?? []) {
      const badge = autoReplyTierBadge(row);
      if (badge) map[row.conversationId] = badge;
    }
    return map;
  }, [tierRows]);

  // Tier-1 auto-answer master switch (admin-only surface; the server default
  // is ON). Reads the auto-reply engine status for the current value.
  const { data: autoReplyEngineStatus } = useQuery<{ tier1AutoEnabled?: boolean }>({
    queryKey: ["/api/inbox/auto-reply/status"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/inbox/auto-reply/status");
      if (!r.ok) throw new Error(`Auto-reply status returned HTTP ${r.status}`);
      return r.json();
    },
    enabled: isAdmin,
    refetchInterval: 60_000,
  });
  const tier1ToggleMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const r = await apiRequest("POST", "/api/inbox/auto-reply/tier1/toggle", { enabled });
      if (!r.ok) throw new Error(`Toggle returned HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: (data) => {
      qc.setQueryData(["/api/inbox/auto-reply/status"], data);
      toast({
        title: data?.tier1AutoEnabled ? "Tier-1 auto-answer ON" : "Tier-1 auto-answer OFF",
        description: data?.tier1AutoEnabled
          ? "Basic tier-1 questions get an automatic AI reply."
          : "Nothing auto-sends — every reply waits for you.",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Couldn't update tier-1 auto-answer", description: err.message, variant: "destructive" });
    },
  });

  const markConversationReplied = (conversationId: string | null) => {
    if (!conversationId) return;
    setLocallyRepliedAtByConversation((prev) => ({
      ...prev,
      [conversationId]: Date.now(),
    }));
    // A sent reply means the thread is handled — drop any manual override so a
    // stale "Mark as unread" can't keep the thread (and the header count) lit.
    setInboxReadOverrides((prev) => {
      if (!prev[conversationId]) return prev;
      const next = { ...prev };
      delete next[conversationId];
      return next;
    });
  };

  // Right-click "Mark as read / unread" from the conversation list. A pure
  // client-side override (Guesty has no read-toggle API on this tenant) that
  // feeds applyLocalReplyOverride below and therefore the row indicators + the
  // header unread count.
  const markConversationReadState = (conversationId: string | null, state: "read" | "unread") => {
    if (!conversationId) return;
    setInboxReadOverrides((prev) => ({ ...prev, [conversationId]: { state, at: Date.now() } }));
    toast({ title: state === "read" ? "Marked as read" : "Marked as unread" });
  };

  const applyLocalReplyOverride = (raw: GuestyConversation) => {
    const normalized = normalizeConversation(raw);
    const locallyPreapproved =
      !!normalized.reservationId && airbnbPreapprovedIds.has(normalized.reservationId);
    const localReplyAt = locallyRepliedAtByConversation[normalized._id];
    const preapprovalPatched = locallyPreapproved
      ? { ...normalized, needsPreapprove: false }
      : normalized;
    // Manual right-click "Mark as read / unread" wins over Guesty's live read
    // state — unless a NEWER guest message has arrived since the mark, in which
    // case a "read" mark is stale (the thread should re-surface) and an
    // "unread" mark is moot (live state already shows it unread).
    const override = inboxReadOverrides[normalized._id];
    if (override) {
      const overrideActivityAt = normalized.displayTimestamp
        ? new Date(normalized.displayTimestamp).getTime()
        : 0;
      const supersededByNewActivity =
        Number.isFinite(overrideActivityAt) && overrideActivityAt > override.at;
      if (!supersededByNewActivity) {
        return override.state === "unread"
          ? { ...preapprovalPatched, isUnread: true, needsReply: true, lastMessageFromGuest: true }
          : { ...preapprovalPatched, isUnread: false, needsReply: false, lastMessageFromGuest: false };
      }
    }
    if (!localReplyAt) return preapprovalPatched;
    const lastActivityAt = normalized.displayTimestamp
      ? new Date(normalized.displayTimestamp).getTime()
      : 0;
    if (Number.isFinite(lastActivityAt) && lastActivityAt > localReplyAt) return preapprovalPatched;
    return {
      ...preapprovalPatched,
      isUnread: false,
      needsReply: false,
      lastMessageFromGuest: false,
    };
  };

  // Unique listing names for the property filter dropdown. Sourced from
  // the conversations themselves (no extra fetch) so the dropdown only
  // ever lists properties the operator currently has conversations
  // for — no empty options.
  const listingOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const name = applyLocalReplyOverride(c).displayListingName;
      if (name && name !== "—") set.add(name);
    }
    return Array.from(set).sort();
  }, [conversations, locallyRepliedAtByConversation]);

  // Apply the property filter. "all" passes everything through.
  // Then sort by latest activity (newest first) using the same timestamp
  // resolution as `normalizeConversation` — Guesty's default list
  // ordering is by conversation creation date, which freezes a stale
  // thread (e.g. Michelle's inquiry created Apr 23) at the position
  // it had on creation even after she sends new messages on May 3.
  // The list endpoint doesn't accept `&sort=-state.lastMessage.date`,
  // so we sort client-side after normalizing. NOTE FOR CODEX: this
  // is intentionally not a `useMemo` over `normalizeConversation`
  // because that helper isn't memoized — re-walking 30 conversations
  // per render is cheap (sub-ms) and avoids a stale-memo trap.
  const filteredConversations = useMemo(() => {
    // Free-text query, lower-cased once. The digits-only form lets a
    // phone search ("808555..." or "5551234") match the formatted/E.164
    // phone regardless of punctuation. A query of <3 digits is treated as
    // text-only so typing a name like "Bo" doesn't spuriously phone-match.
    const q = searchQuery.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, "");
    const propertyMatched = propertyFilter === "all"
      ? conversations
      : conversations.filter((c) => applyLocalReplyOverride(c).displayListingName === propertyFilter);
    const matched = propertyMatched.filter((c) => {
      const n = applyLocalReplyOverride(c);
      if (replyStatusFilter !== "all") {
        const needsReply = n.needsReply;
        if (replyStatusFilter === "unread" ? !needsReply : needsReply) return false;
      }
      if (q) {
        const haystack = [
          n.displayGuestName,
          n.displayGuestEmail,
          n.displayListingName,
          n.displayPreview,
          n.displayConfirmationCode,
        ].filter(Boolean).join("  ").toLowerCase();
        const phoneDigits = (n.displayGuestPhone || "").replace(/\D/g, "");
        const textMatch = haystack.includes(q);
        const phoneMatch = qDigits.length >= 3 && phoneDigits.length > 0 && phoneDigits.includes(qDigits);
        if (!textMatch && !phoneMatch) return false;
      }
      return true;
    });
    const ts = (c: any): number => {
      const v = applyLocalReplyOverride(c).displayTimestamp;
      const t = v ? new Date(v).getTime() : NaN;
      return Number.isFinite(t) ? t : 0;
    };
    return [...matched].sort((a, b) => ts(b) - ts(a));
  }, [conversations, propertyFilter, replyStatusFilter, searchQuery, locallyRepliedAtByConversation, inboxReadOverrides, airbnbPreapprovedIds]);

  // Count of conversations still awaiting the host across the WHOLE inbox
  // (deliberately ignores the property/search/status filters so the header
  // badge is a true global signal). Drives the header "N unread" badge + the
  // Messages tab counter, and updates live as the operator marks rows
  // read/unread via the right-click menu.
  const unreadConversationCount = useMemo(
    () => conversations.reduce(
      (n, raw) => n + (applyLocalReplyOverride(raw).needsReply ? 1 : 0),
      0,
    ),
    [conversations, locallyRepliedAtByConversation, inboxReadOverrides, airbnbPreapprovedIds],
  );

  // Publish the override-aware unread count to the shared store so the global
  // AppHeader "Inbox" badge updates the moment the operator marks a row
  // read/unread — the header lives in a separate component and can't read this
  // page's state directly. See client/src/lib/inboxUnreadStore.ts.
  useEffect(() => {
    setInboxUnreadCount(unreadConversationCount);
  }, [unreadConversationCount]);

  useEffect(() => {
    const deepLinkKey = [
      inboxDeepLink.conversationId,
      inboxDeepLink.reservationId,
      inboxDeepLink.guest,
      inboxDeepLink.confirmation,
    ].filter(Boolean).join("|");
    if (!deepLinkKey || convLoading) return;

    const guestTarget = normalizeDeepLinkText(inboxDeepLink.guest);
    const confirmationTarget = normalizeDeepLinkText(inboxDeepLink.confirmation);
    const matchesConfirmation = (c: GuestyConversation) => {
      if (!confirmationTarget) return false;
      const meta = (c as any)?.meta ?? {};
      const firstReservation =
        Array.isArray(meta.reservations) && meta.reservations.length > 0
          ? meta.reservations[0]
          : ((c as any)?.reservation ?? meta.reservation ?? null);
      const code = normalizeDeepLinkText(
        (c as any)?.confirmationCode ??
        firstReservation?.confirmationCode ??
        firstReservation?.confirmation?.code,
      );
      return code === confirmationTarget;
    };
    const matchesGuest = (c: GuestyConversation) => {
      if (!guestTarget) return false;
      const guestName = normalizeDeepLinkText(applyLocalReplyOverride(c).displayGuestName);
      return guestName === guestTarget || guestName.includes(guestTarget) || guestTarget.includes(guestName);
    };

    const match =
      (inboxDeepLink.conversationId
        ? conversations.find((c) => c._id === inboxDeepLink.conversationId)
        : undefined) ??
      (inboxDeepLink.reservationId
        ? conversations.find((c) => applyLocalReplyOverride(c).reservationId === inboxDeepLink.reservationId)
        : undefined) ??
      conversations.find(matchesConfirmation) ??
      conversations.find(matchesGuest);

    if (match) {
      const normalized = applyLocalReplyOverride(match);
      setPropertyFilter("all");
      setReplyStatusFilter("all");
      if (selectedConvId !== normalized._id) {
        setSelectedConvId(normalized._id);
      }
      deepLinkNoticeRef.current = deepLinkKey;
      return;
    }

    if (conversations.length > 0 && deepLinkNoticeRef.current !== deepLinkKey) {
      deepLinkNoticeRef.current = deepLinkKey;
      toast({
        title: "Conversation not found",
        description: "Inbox loaded, but this reservation was not in the current Guesty conversation list.",
      });
    }
  }, [inboxDeepLink, conversations, convLoading, selectedConvId, locallyRepliedAtByConversation, toast]);

  const selectedConvRaw = conversations.find(c => c._id === selectedConvId) ?? null;
  const selectedConv = selectedConvRaw ? applyLocalReplyOverride(selectedConvRaw) : null;

  // Publish the open conversation to the dashboard assistant ("Magical") so a
  // request like "draft a reply to this guest" acts on the thread on screen.
  useAssistantContext({
    page: "Guest inbox",
    description: selectedConv
      ? "Operator is viewing a guest conversation thread."
      : "Operator is in the guest inbox.",
    data: selectedConv
      ? {
          conversationId: selectedConvId,
          guestName: (selectedConv as any).guestName ?? null,
          reservationId: (selectedConv as any).reservationId ?? null,
          listingId: (selectedConv as any).listingId ?? null,
        }
      : undefined,
  });

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
      // NOTE FOR CODEX: the empty `&fields=` mirrors the conversation-LIST
      // query (2026-05-04 note), where it is load-bearing for un-stripped
      // documents. As of 2026-07-05 Guesty's /posts endpoint REJECTS the param
      // outright (400 VALIDATION_ERROR `"fields" is not allowed`) while the
      // no-fields response still carries `attachments`, so we fall back — and
      // remember the rejection so every 30s refetch doesn't burn a doomed
      // request. apiRequest THROWS on non-2xx (see the apirequest-throws
      // memory / PR #896), so the fallback must catch, not check `r.ok`.
      const base = `/api/guesty-proxy/communication/conversations/${selectedConvId}/posts?limit=100`;
      if (!postsFieldsParamRejected) {
        try {
          const r = await apiRequest("GET", `${base}&fields=`);
          return await r.json();
        } catch (err) {
          // Only latch on a 4xx (Guesty rejected the param); transient 5xx /
          // network failures should keep trying the richer variant later.
          if (/^4\d\d:/.test(String((err as Error)?.message ?? ""))) {
            postsFieldsParamRejected = true;
          }
        }
      }
      const r = await apiRequest("GET", base);
      return r.json();
    },
    refetchInterval: 30_000,
    // Keep the open thread fresh when the operator tabs away and back (see the
    // conversation-list query note) so a new guest reply appears immediately.
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: true,
    staleTime: 0,
  });

  const { data: smsData, isLoading: smsLoading } = useQuery<any>({
    queryKey: ["/api/inbox/sms/conversations", selectedConvId, "messages"],
    enabled: !!selectedConvId,
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/inbox/sms/conversations/${selectedConvId}/messages`);
      if (!r.ok) throw new Error(`SMS returned HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 15_000,
  });

  const { data: callData, isLoading: callsLoading } = useQuery<{ calls: QuoCallEvent[] }>({
    queryKey: ["/api/inbox/calls/conversations", selectedConvId],
    enabled: !!selectedConvId,
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/inbox/calls/conversations/${selectedConvId}`);
      if (!r.ok) throw new Error(`Calls returned HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const { data: internalNotesData } = useQuery<{ notes: GuestInboxInternalNote[] }>({
    queryKey: ["/api/inbox/internal-notes", selectedConvId],
    enabled: !!selectedConvId,
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/inbox/internal-notes/${selectedConvId}?limit=20`);
      if (!r.ok) throw new Error(`Internal notes returned HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const { data: smsStatus } = useQuery<any>({
    queryKey: ["/api/inbox/sms/status"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/inbox/sms/status");
      if (!r.ok) throw new Error(`SMS status returned HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 30_000,
  });

  const { data: phoneData } = useQuery<any>({
    queryKey: ["/api/inbox/sms/conversations", selectedConvId, "phone"],
    enabled: !!selectedConvId,
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/inbox/sms/conversations/${selectedConvId}/phone`);
      if (!r.ok) throw new Error(`Phone override returned HTTP ${r.status}`);
      return r.json();
    },
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

  const smsPosts: GuestyPost[] = unwrapList<any>(smsData, ["messages"]).map((m: any) => ({
    _id: `quo-sms-${m.providerMessageId ?? m.id}`,
    body: m.body,
    sentAt: m.sentAt ?? m.createdAt,
    sentBy: m.direction === "outbound" ? "host" : "guest",
    direction: m.direction === "outbound" ? "outbound" : "inbound",
    // MMS photos the guest texted back (e.g. the ID-verification selfie).
    // `media_urls` holds JSON [{url, type?}] — putting it on `media` lets the
    // thread's collectPostAttachments render them like any OTA photo message.
    media: parseQuoSmsMedia(m.mediaUrls),
    module: { type: "sms", provider: "quo" },
  }));

  const callEvents = callData?.calls ?? [];
  const internalNotes = internalNotesData?.notes ?? [];
  const callPosts: GuestyPost[] = callEvents.map((call) => {
    const when = call.callCompletedAt ?? call.callStartedAt ?? call.createdAt ?? "";
    const kind = call.disposition === "voicemail"
      ? "Voicemail"
      : call.disposition === "missed"
        ? "Missed call"
        : call.direction === "outbound"
          ? "Outgoing call"
          : "Incoming call";
    const details = [
      `${kind} ${call.direction === "outbound" ? "to" : "from"} ${formatPhone(call.guestPhone)}`,
      call.durationSeconds ? `Call duration ${formatDuration(call.durationSeconds)}` : "",
      call.voicemailDurationSeconds ? `Voicemail duration ${formatDuration(call.voicemailDurationSeconds)}` : "",
      call.matchStrategy ? `Matched by ${call.matchStrategy.replace(/-/g, " ")}` : "",
    ].filter(Boolean);
    return {
      _id: `quo-call-${call.id}`,
      body: details.join("\n"),
      sentAt: when,
      sentBy: call.direction === "outbound" ? "host" : "guest",
      direction: call.direction === "outbound" ? "outbound" : "inbound",
      module: { type: "call", provider: "quo", callEvent: call },
    };
  });

  const threadPosts = [...posts, ...smsPosts, ...callPosts];
  const savedGuestPhone = normalizePhone(phoneData?.override?.phone);
  const effectiveGuestPhone = savedGuestPhone || selectedConv?.displayGuestPhone || "";
  const detectedPreArrivalFormUrl = findRelevantThreadUrl(threadPosts, "prearrival");
  const detectedPaymentUrl = findRelevantThreadUrl(threadPosts, "payment");
  const savedPreArrivalFormUrl = String(phoneData?.override?.preArrivalFormUrl ?? "");
  const savedPaymentUrl = String(phoneData?.override?.paymentUrl ?? "");
  const effectivePreArrivalFormUrl = savedPreArrivalFormUrl || detectedPreArrivalFormUrl;
  const effectivePaymentUrl = savedPaymentUrl || detectedPaymentUrl;
  const hasUnresolvedGuestyVariable = GUESTY_VARIABLE_PATTERN.test(replyText);
  const hasSmsPlaceholder = SMS_PLACEHOLDER_PATTERN.test(replyText);
  const smsConfigured = smsStatus?.configured !== false;
  const smsDisabledReason = !smsConfigured
    ? (smsStatus?.message ?? "SMS is not configured yet in Railway")
    : hasUnresolvedGuestyVariable
      ? "Guesty variables like {{guest_invoice}} only expand when sent through Guesty. Use Send in Guesty or remove the placeholder before texting."
    : hasSmsPlaceholder
      ? "Paste the real secure Guesty link before texting this draft."
    : !effectiveGuestPhone
      ? "No guest phone number found on this thread"
      : undefined;

  useEffect(() => {
    setGuestPhoneInput(effectiveGuestPhone);
  }, [selectedConvId, effectiveGuestPhone]);

  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [threadPosts.length]);

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

  useEffect(() => {
    const res = reservationFull?.data ?? reservationFull ?? null;
    const id = res?._id ?? reservationId;
    if (!id) return;
    const statusRaw = String(res?.status ?? "").toLowerCase();
    const preApproved =
      res?.preApproveState === true ||
      res?.preApproved === true ||
      String(res?.preApprovalStatus ?? "").toLowerCase() === "preapproved" ||
      statusRaw.includes("preapproved") ||
      statusRaw === "accepted";
    if (preApproved && !airbnbPreapprovedIds.has(id)) {
      rememberAirbnbPreapproval(id);
    }
  }, [reservationFull, reservationId, airbnbPreapprovedIds]);

  const { data: arrivalDetails, isLoading: arrivalDetailsLoading } = useQuery<{ units: ArrivalUnitDetail[] }>({
    queryKey: ["/api/bookings", reservationId, "arrival-details"],
    enabled: !!reservationId,
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/bookings/${reservationId}/arrival-details`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 60_000,
  });

  const { data: buyInComms } = useQuery<InboxBuyInCommunications>({
    queryKey: ["/api/bookings", reservationId, "buy-in-communications"],
    enabled: !!reservationId,
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/bookings/${reservationId}/buy-in-communications`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 60_000,
  });

  const { data: rentalAgreement, refetch: refetchRentalAgreement } = useQuery<InboxRentalAgreement>({
    queryKey: ["/api/bookings", reservationId, "rental-agreement"],
    enabled: !!reservationId,
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/bookings/${reservationId}/rental-agreement`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 30_000,
  });

  // ── Inquiry-time buy-in estimate ──
  // Reuses `nexstay_cleaning_fee` localStorage key from buy-in-tracker.tsx
  // so the operator's preferred cleaning-fee assumption is shared between
  // both surfaces. Default $250/unit matches buy-in-tracker. NOTE FOR
  // CODEX: don't fork to a different storage key — we want one source of
  // truth so changing it on either page propagates everywhere.
  const [estimateCleaningFee, setEstimateCleaningFee] = useState<number>(() => {
    try { return parseInt(localStorage.getItem("nexstay_cleaning_fee") || "250", 10) || 250; } catch { return 250; }
  });
  useEffect(() => {
    try { localStorage.setItem("nexstay_cleaning_fee", String(estimateCleaningFee)); } catch { /* localStorage may be unavailable in private mode */ }
  }, [estimateCleaningFee]);

  // The estimate endpoint needs (listingId, checkIn, checkOut). Pull them
  // straight from the selected conversation's reservation stub — Guesty
  // populates these on every inquiry. Gated to inquiries only at the
  // render layer; this query stays enabled for any phase as long as we
  // have the inputs, so opening a booked thread doesn't refetch on
  // every state change.
  const estimateListingId =
    (selectedConv as any)?.listingId ??
    (selectedConv as any)?.meta?.reservations?.[0]?.listingId ??
    (selectedConv as any)?.meta?.reservations?.[0]?.listing?._id ??
    null;
  const estimateCheckIn =
    (selectedConv as any)?.meta?.reservations?.[0]?.checkInDateLocalized ??
    (selectedConv as any)?.meta?.reservations?.[0]?.checkIn ??
    null;
  const estimateCheckOut =
    (selectedConv as any)?.meta?.reservations?.[0]?.checkOutDateLocalized ??
    (selectedConv as any)?.meta?.reservations?.[0]?.checkOut ??
    null;
  const { data: buyInEstimate, isLoading: buyInEstimateLoading } = useQuery<any>({
    queryKey: ["/api/inbox/buy-in-estimate", estimateListingId, estimateCheckIn, estimateCheckOut, estimateCleaningFee],
    enabled: isAdmin && !!estimateListingId && !!estimateCheckIn && !!estimateCheckOut,
    queryFn: async () => {
      const params = new URLSearchParams({
        listingId: String(estimateListingId),
        checkIn: String(estimateCheckIn),
        checkOut: String(estimateCheckOut),
        cleaningFeePerUnit: String(estimateCleaningFee),
      });
      const r = await apiRequest("GET", `/api/inbox/buy-in-estimate?${params.toString()}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 60_000,
  });

  // ── Live buy-in search ("Do buy-in search" button on an inquiry) ──
  // Fires the EXACT same search the Operations "Auto-fill cheapest" runs (the
  // server escalation ladder + local Chrome sidecar + cheapest same-community
  // combos) in DRY-RUN mode — it attaches NOTHING, it just surfaces results. We
  // start the job server-side (POST /api/inbox/buy-in-search) then poll the normal
  // auto-fill status endpoint. Jobs are tracked PER CONVERSATION so switching
  // threads keeps each inquiry's in-flight / last search; the search keeps running
  // server-side even if the operator navigates away (same deploy-survival design as
  // the bookings page). Search can take 1–several minutes (the sidecar walk +
  // nearby-city expansion).
  const [buyInSearchJobByConv, setBuyInSearchJobByConv] = useState<Record<string, string>>({});
  const activeBuyInJobId = selectedConvId ? buyInSearchJobByConv[selectedConvId] ?? null : null;

  const startBuyInSearch = useMutation({
    mutationFn: async (vars: { convId: string; listingId: string; checkIn: string; checkOut: string }) => {
      const r = await apiRequest("POST", "/api/inbox/buy-in-search", {
        listingId: vars.listingId, checkIn: vars.checkIn, checkOut: vars.checkOut,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data?.ok === false) throw new Error(data?.error || data?.reason || `HTTP ${r.status}`);
      return { ...data, convId: vars.convId } as { jobId: string; convId: string };
    },
    onSuccess: (data) => {
      if (data?.jobId && data?.convId) {
        setBuyInSearchJobByConv((prev) => ({ ...prev, [data.convId]: data.jobId }));
      }
    },
    onError: (e: any) =>
      toast({ title: "Buy-in search didn't start", description: String(e?.message ?? e), variant: "destructive" }),
  });

  const { data: buyInSearchStatus } = useQuery<any>({
    queryKey: ["/api/operations/auto-fill", activeBuyInJobId],
    enabled: isAdmin && !!activeBuyInJobId,
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/operations/auto-fill/${activeBuyInJobId}`);
      if (!r.ok) {
        // 404 = job evicted (server restart / 2h TTL). Surface as a terminal,
        // re-runnable state rather than spinning forever.
        if (r.status === 404) return { jobId: activeBuyInJobId, done: true, status: "failed", message: "Search ended (server restarted) — run it again.", attached: [], comboOptions: [], cityEconomics: [], skipped: [] };
        throw new Error(`HTTP ${r.status}`);
      }
      return r.json();
    },
    // Poll while the job is running; stop once it's terminal.
    refetchInterval: (query) => {
      const d: any = query.state.data;
      return d && d.done ? false : 2500;
    },
  });
  const buyInSearchRunning = startBuyInSearch.isPending || (!!buyInSearchStatus && !buyInSearchStatus.done);

  const draftArrivalDetails = async ({
    title = "14-day arrival details",
    channel = "guesty",
    guestFirstName,
    propertyName,
    checkInIso,
  }: {
    title?: string;
    channel?: "guesty" | "sms";
    guestFirstName: string;
    propertyName: string;
    checkInIso?: string;
  }) => {
    // Aloha/Mahalo for Hawaii listings, Hi/Thanks for mainland — resolved from
    // the conversation's mapped property (defaults to Hawaii when unmapped).
    const regionCtx = selectedConv?.listingId
      ? await buildPropertyContextForDraft(selectedConv.listingId)
      : null;
    const isHawaii = regionCtx?.isHawaii ?? true;
    const body = channel === "sms"
      ? buildArrivalDetailsSmsBody({ guestFirstName, propertyName, isHawaii })
      : buildArrivalDetailsGuestMessage({
        guestFirstName,
        propertyName,
        checkInIso,
        units: arrivalDetails?.units ?? [],
        isHawaii,
      });
    previewTemplateBody(title, body, channel);
  };

  const ensureRentalAgreementLink = async (args: {
    channelRaw: string;
    guestName: string;
    guestEmail?: string | null;
    guestPhone?: string | null;
    propertyName: string;
    checkInIso?: string;
    checkOutIso?: string;
    confirmationCode?: string;
    numNights?: number | null;
    bookingTotal?: number;
    cancellationPolicy?: string | null;
  }): Promise<string> => {
    if (!reservationId) throw new Error("No reservation found for this agreement");
    const channel = String(args.channelRaw ?? "");
    if (!/vrbo|homeaway|booking/i.test(channel)) {
      throw new Error("Internal rental agreements are only for VRBO/HomeAway and Booking.com bookings.");
    }
    if (rentalAgreement?.agreement?.signingUrl) return rentalAgreement.agreement.signingUrl;
    const response = await apiRequest("POST", `/api/bookings/${reservationId}/rental-agreement`, {
      conversationId: selectedConvId,
      channel,
      guestName: args.guestName,
      guestEmail: args.guestEmail,
      guestPhone: args.guestPhone,
      propertyName: args.propertyName,
      checkIn: args.checkInIso?.slice(0, 10),
      checkOut: args.checkOutIso?.slice(0, 10),
      confirmationCode: args.confirmationCode,
      nights: args.numNights,
      bookingTotal: args.bookingTotal,
      cancellationPolicy: args.cancellationPolicy,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
    await refetchRentalAgreement();
    return payload.signingUrl || payload.agreement?.signingUrl || `/agreement/${payload.agreement?.token}`;
  };

  const draftStayTemplate = async ({
    title = "Template preview",
    channel = "guesty",
    kind,
    guestFirstName,
    propertyName,
    checkInIso,
    checkOutIso,
    confirmationCode,
    numNights,
    bookingTotal,
    totalPaid,
    cancellationPolicy,
    channelRaw,
    guestName,
    guestEmail,
    guestPhone,
  }: {
    title?: string;
    channel?: "guesty" | "sms";
    kind: "booking" | "agreement-request" | "guesty-invoice-payment" | "representative-follow-up" | "id-verification" | "local-tips" | "day-before" | "post-stay";
    guestFirstName: string;
    propertyName: string;
    checkInIso?: string;
    checkOutIso?: string;
    confirmationCode?: string;
    numNights?: number | null;
    bookingTotal?: number;
    totalPaid?: number;
    cancellationPolicy?: string | null;
    channelRaw?: string;
    guestName?: string;
    guestEmail?: string | null;
    guestPhone?: string | null;
  }) => {
    try {
      const units = arrivalDetails?.units ?? [];
      // Region drives the greeting/sign-off voice — Aloha/Mahalo for Hawaii
      // listings, Hi/Thanks for mainland (e.g. Florida) listings. Resolved from
      // the conversation's mapped property address (same isHawaii signal the AI
      // drafter uses). Defaults to Hawaii when the listing isn't mapped, since
      // the current portfolio is Hawaii and the operator reviews every draft in
      // the composer before sending.
      const regionCtx = selectedConv?.listingId
        ? await buildPropertyContextForDraft(selectedConv.listingId)
        : null;
      const isHawaii = regionCtx?.isHawaii ?? true;
      const agreementUrl = kind === "agreement-request"
        ? await ensureRentalAgreementLink({
          channelRaw: channelRaw ?? "",
          guestName: guestName || guestFirstName,
          guestEmail,
          guestPhone,
          propertyName,
          checkInIso,
          checkOutIso,
          confirmationCode,
          numNights,
          bookingTotal,
          cancellationPolicy,
        })
        : "";
      const body = channel === "sms" && kind === "agreement-request"
        ? buildAgreementRequestSmsBody({ guestFirstName, propertyName, checkInIso, checkOutIso, agreementUrl, isHawaii })
        : channel === "sms" && kind === "guesty-invoice-payment"
          ? buildGuestyInvoicePaymentSmsBody({ guestFirstName, propertyName, paymentUrl: effectivePaymentUrl, isHawaii })
        : channel === "sms" && kind === "representative-follow-up"
          ? buildUnitSetupSmsBody({ guestFirstName, propertyName, isHawaii })
        : channel === "sms" && kind === "id-verification"
          ? buildIdVerificationSmsBody({ guestFirstName, propertyName, isHawaii })
        : channel === "sms" && kind === "local-tips"
          ? buildLocalTipsSmsBody({ guestFirstName, propertyName, isHawaii })
        : channel === "sms" && kind === "day-before"
          ? buildDayBeforeSmsBody({ guestFirstName, propertyName, isHawaii })
        : channel === "sms" && kind === "post-stay"
          ? buildPostStaySmsBody({ guestFirstName, propertyName, isHawaii })
        : kind === "booking"
          ? buildBookingConfirmationBody({ guestFirstName, propertyName, checkInIso, checkOutIso, confirmationCode, numNights, bookingTotal, totalPaid, channelRaw, isHawaii })
        : kind === "agreement-request"
          ? buildAgreementRequestBody({ guestFirstName, propertyName, agreementUrl, checkInIso, confirmationCode, isHawaii })
        : kind === "guesty-invoice-payment"
          ? buildGuestyInvoicePaymentBody({ guestFirstName, propertyName, checkInIso, confirmationCode, isHawaii })
        : kind === "representative-follow-up"
          ? buildRepresentativeUnitsFollowUpBody({ guestFirstName, propertyName, checkInIso, isHawaii })
        : kind === "id-verification"
          ? buildIdVerificationBody({ guestFirstName, propertyName, checkInIso, confirmationCode, isHawaii })
          : kind === "local-tips"
            ? buildLocalTipsBody({ guestFirstName, propertyName, units, isHawaii })
            : kind === "day-before"
              ? buildDayBeforeBody({ guestFirstName, propertyName, checkInIso, units, isHawaii })
              : buildPostStayBody({ guestFirstName, propertyName, isHawaii });
      previewTemplateBody(title, body, channel);
    } catch (err: any) {
      toast({ title: "Could not create agreement", description: err?.message ?? "Please try again.", variant: "destructive" });
    }
  };

  // Background OTA delivery confirmation. The Send route returns FAST (`pending`)
  // instead of blocking ~30s for the channel to stamp module.externalId; this
  // polls the read-only /delivery-status probe (NEVER re-sends) to upgrade the
  // status to "delivered" once the channel confirms. Fully fail-soft — any error
  // just stops the poll; the message is already on the thread either way.
  const confirmDeliveryInBackground = async (params: {
    conversationId: string;
    body: string;
    channel: string | null;
    reservationId: string | null;
    via: string;
    // When the send happened — lets the server ignore OLDER delivered copies of
    // the same text so a repeated reply can't false-confirm.
    sentAtMs: number;
  }) => {
    const { conversationId, body, channel, reservationId, via, sentAtMs } = params;
    // ~60s — Booking.com confirms ~30s out (AGENTS.md #51), so the old ~36s window
    // could exhaust before a legitimately-slow sync confirmed.
    const MAX_ATTEMPTS = 15;
    const INTERVAL_MS = 4000;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
      try {
        const r = await apiRequest(
          "POST",
          `/api/inbox/conversations/${conversationId}/delivery-status`,
          { body, channel, reservationId, sentAtMs },
        );
        const j = await r.json().catch(() => ({} as any));
        if (r.ok && j?.verified === true) {
          qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/communication/conversations", conversationId, "posts"] });
          qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/communication/conversations"] });
          toast({ title: "Delivery confirmed", description: `${via} confirmed your message reached the guest.` });
          return;
        }
        // Explicit wrong-channel MISROUTE (verified:false AND pending:false) that
        // only surfaced after the fast return — the message was filed on a non-OTA
        // channel (e.g. email) and never reached the guest's booking channel. The
        // inline send window is short now, so this is where a late-syncing misroute
        // gets caught. Surface it loudly instead of leaving "confirming…" hanging.
        if (r.ok && j?.ok === true && j?.verified !== true && j?.pending !== true) {
          toast({
            title: "Delivery NOT confirmed",
            description: j?.deliveryReason
              || `${via} did not confirm delivery — it may have been filed on email instead. Check the channel's extranet before resending.`,
            variant: "destructive",
          });
          return;
        }
        // Still pending (or a transient miss) — keep polling.
      } catch {
        // Network hiccup / session expiry — stop quietly; the send already happened.
        return;
      }
    }
    // Loop exhausted with no verified/misroute verdict — the OTA channel is still
    // confirming (or syncing slower than our window). The message was posted
    // EXACTLY ONCE (send-once), so surface a terminal "don't resend" notice rather
    // than letting the transient "confirming…" toast silently vanish.
    toast({
      title: `Still confirming on ${via}`,
      description: `${via} hasn't confirmed delivery yet. Your message is on the thread — don't resend (that can duplicate it). If the guest doesn't reply, verify on the channel's extranet.`,
    });
  };

  const sendMessage = useMutation({
    // Routed through the server's hardened, delivery-VERIFIED send path
    // (/api/inbox/conversations/:id/send) instead of a client-direct
    // /send-message that trusts HTTP 200. The server resolves the
    // proven-delivering module from the reservation's integration.platform,
    // sends ONCE, and confirms via Guesty's module.externalId — so a Booking.com
    // reply that only ever reaches Guesty's `pending` state (never the guest's
    // portal) is no longer reported as a clean success. The route now returns as
    // soon as the POST lands (short inline verify), so the button frees in a few
    // seconds; OTA confirmation finishes in confirmDeliveryInBackground.
    mutationFn: async () => {
      if (!selectedConv || !selectedConvId) throw new Error("No conversation selected");
      const conversationId = selectedConvId;
      const sentBody = normalizeGuestyManualMessageBody(replyText);
      const channel = selectedConv.module?.type ?? null;
      const reservationId = selectedConv.reservationId ?? null;
      const sentAtMs = Date.now();
      const r = await apiRequest(
        "POST",
        `/api/inbox/conversations/${conversationId}/send`,
        { body: sentBody, reservationId, channel },
      );
      const body = await r.json().catch(() => ({} as any));
      if (!r.ok || body?.ok !== true) {
        throw new Error(body?.message || body?.error || `Guesty returned HTTP ${r.status}`);
      }
      // A genuine MISROUTE (filed on a non-OTA channel, e.g. email →
      // verified:false AND pending:false) is a hard error — it did NOT reach the
      // guest's booking channel. A true PENDING is surfaced as a notice, not
      // thrown (resending would pile up duplicate guest messages).
      if (body.verified !== true && body.pending !== true) {
        throw new Error(
          body.deliveryReason
            || "The message did not reach the guest's booking channel — it may have been saved on email instead. Verify on the channel's extranet.",
        );
      }
      return { ...(body as { ok: true; verified?: boolean; pending?: boolean; deliveredVia?: string }), conversationId, sentBody, channel, reservationId, sentAtMs };
    },
    onSuccess: (data) => {
      markConversationReplied(data.conversationId);
      // Re-seed the agent's box with her sign-off for the next message.
      setReplyText(isAgent ? AGENT_COMPOSE_SEED : "");
      caretToTopPendingRef.current = isAgent;
      qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/communication/conversations", data.conversationId] });
      qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/communication/conversations", data.conversationId, "posts"] });
      qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/communication/conversations"] });
      const via = data?.deliveredVia?.trim() || "the booking channel";
      if (data?.verified === true) {
        toast({ title: "Message sent!", description: `Delivered through ${via} and confirmed on the guest thread.` });
      } else {
        toast({
          title: `Sent through ${via} — confirming delivery`,
          description: `Your message is on the thread. ${via} usually confirms delivery within ~30s and I'll update once it does. Don't resend — that can duplicate the message.`,
        });
        // Fire-and-forget: upgrade to "Delivery confirmed" in the background so
        // the operator isn't blocked waiting on the channel's async confirmation.
        void confirmDeliveryInBackground({
          conversationId: data.conversationId,
          body: data.sentBody,
          channel: data.channel,
          reservationId: data.reservationId,
          via,
          sentAtMs: data.sentAtMs,
        });
      }
    },
    onError: (e: any) => toast({ title: "Failed to send", description: e.message, variant: "destructive" }),
  });

  const sendTextMessage = useMutation({
    mutationFn: async () => {
      if (!selectedConv || !selectedConvId) throw new Error("No conversation selected");
      const to = effectiveGuestPhone;
      if (!to) throw new Error("No guest phone number found on this Guesty thread");
      if (GUESTY_VARIABLE_PATTERN.test(replyText)) {
        throw new Error("Guesty variables like {{guest_invoice}} do not expand in Quo texts. Send this through Guesty or remove the placeholder before texting.");
      }
      if (SMS_PLACEHOLDER_PATTERN.test(replyText)) {
        throw new Error("Paste the real secure link before sending this text.");
      }
      const r = await apiRequest("POST", `/api/inbox/sms/conversations/${selectedConvId}/send`, {
        to,
        body: replyText,
        reservationId: selectedConv.reservationId ?? null,
        guestName: selectedConv.displayGuestName ?? null,
      });
      if (!r.ok) {
        const errBody = await r.json().catch(() => ({}));
        throw new Error(errBody.message ?? errBody.error ?? `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      markConversationReplied(selectedConvId);
      // Re-seed the agent's box with her sign-off for the next text.
      setReplyText(isAgent ? AGENT_COMPOSE_SEED : "");
      caretToTopPendingRef.current = isAgent;
      qc.invalidateQueries({ queryKey: ["/api/inbox/sms/conversations", selectedConvId, "messages"] });
      qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/communication/conversations"] });
      toast({ title: "Text sent via Quo" });
    },
    onError: (e: any) => toast({ title: "Text failed", description: e.message, variant: "destructive" }),
  });

  const saveGuestPhone = useMutation({
    mutationFn: async () => {
      if (!selectedConv || !selectedConvId) throw new Error("No conversation selected");
      const normalized = normalizePhone(guestPhoneInput);
      const digits = normalized.replace(/\D/g, "");
      if (digits.length < 10 || digits.length > 15) {
        throw new Error("Enter a valid phone number with area code");
      }
      const r = await apiRequest("PUT", `/api/inbox/sms/conversations/${selectedConvId}/phone`, {
        phone: normalized,
        reservationId: selectedConv.reservationId ?? null,
        guestName: selectedConv.displayGuestName ?? null,
        sourcePhone: selectedConv.displayGuestPhone ?? null,
        preArrivalFormUrl: effectivePreArrivalFormUrl || null,
        paymentUrl: effectivePaymentUrl || null,
      });
      if (!r.ok) {
        const errBody = await r.json().catch(() => ({}));
        throw new Error(errBody.message ?? errBody.error ?? `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: (data) => {
      const phone = normalizePhone(data?.override?.phone);
      setGuestPhoneInput(phone);
      qc.invalidateQueries({ queryKey: ["/api/inbox/sms/conversations", selectedConvId, "phone"] });
      toast({ title: "Guest phone saved", description: phone });
    },
    onError: (e: any) => toast({ title: "Phone not saved", description: e.message, variant: "destructive" }),
  });

  const completeCallback = useMutation({
    mutationFn: async () => {
      if (!callbackCall) throw new Error("No missed call selected");
      const said = callbackSummary.trim();
      if (said.length < 2) throw new Error("Please add what the guest said.");
      const r = await apiRequest("POST", `/api/inbox/calls/${callbackCall.id}/callback`, { said });
      if (!r.ok) {
        const errBody = await r.json().catch(() => ({}));
        throw new Error(errBody.message ?? errBody.error ?? `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      const conversationId = callbackCall?.conversationId ?? selectedConvId;
      setCallbackCall(null);
      setCallbackSummary("");
      qc.invalidateQueries({ queryKey: ["/api/inbox/calls/unacknowledged"] });
      qc.invalidateQueries({ queryKey: ["/api/inbox/calls/conversations", conversationId] });
      if (conversationId) qc.invalidateQueries({ queryKey: ["/api/inbox/internal-notes", conversationId] });
      toast({ title: "Callback saved", description: "The missed call was cleared and added to internal notes." });
    },
    onError: (e: any) => toast({ title: "Callback not saved", description: e.message, variant: "destructive" }),
  });

  const clearConversationMissedCalls = useMutation({
    mutationFn: async () => {
      if (!selectedConvId) throw new Error("No conversation selected");
      const r = await apiRequest("POST", `/api/inbox/calls/conversations/${selectedConvId}/acknowledge`, {});
      if (!r.ok) {
        const errBody = await r.json().catch(() => ({}));
        throw new Error(errBody.message ?? errBody.error ?? `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["/api/inbox/calls/unacknowledged"] });
      qc.invalidateQueries({ queryKey: ["/api/inbox/calls/conversations", selectedConvId] });
      toast({ title: "Missed calls cleared", description: `${data?.cleared ?? 0} notification${data?.cleared === 1 ? "" : "s"} cleared` });
    },
    onError: (e: any) => toast({ title: "Could not clear missed calls", description: e.message, variant: "destructive" }),
  });

  // Dismiss a SINGLE missed-call notification with the small "×". Quietly
  // acknowledges the one call (no callback note required) and refreshes the
  // unacknowledged list — when the last one clears, the header badge and the
  // whole "Missed calls need review" panel disappear because both are gated
  // on the count being > 0.
  const dismissMissedCall = useMutation({
    mutationFn: async (callId: number) => {
      const r = await apiRequest("POST", `/api/inbox/calls/${callId}/acknowledge`, {});
      if (!r.ok) {
        const errBody = await r.json().catch(() => ({}));
        throw new Error(errBody.message ?? errBody.error ?? `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/inbox/calls/unacknowledged"] });
      // Refresh any per-conversation call lists currently shown (prefix
      // match covers ["/api/inbox/calls/conversations", <id>]).
      qc.invalidateQueries({ queryKey: ["/api/inbox/calls/conversations"] });
    },
    onError: (e: any) => toast({ title: "Could not dismiss notification", description: e.message, variant: "destructive" }),
  });

  // Regenerate the receipt body whenever any input changes — but only
  // until the operator edits the textarea directly (then `receiptBodyTouched`
  // pins their version).
  useEffect(() => {
    if (!receiptDialog.open) return;
    if (receiptBodyTouched) return;
    if (!receiptPaymentDate) return;
    const pastPayments = receiptPastPayments
      .map((p) => ({ date: p.date, amount: parseFloat(p.amount) || 0 }))
      .filter((p) => p.amount > 0);
    const body = buildReceiptBody({
      guestFirstName: receiptDialog.guestFirstName,
      propertyName: receiptDialog.propertyName,
      checkInIso: receiptDialog.checkInIso,
      paymentAmount: parseFloat(receiptPaymentAmount) || 0,
      paymentDateIso: receiptPaymentDate,
      bookingTotal: parseFloat(receiptTotalPrice) || 0,
      pastPayments,
      receiptUrl: receiptPageUrl || undefined,
    });
    setReceiptBody(body);
  }, [
    receiptDialog.open,
    receiptDialog.guestFirstName,
    receiptDialog.propertyName,
    receiptDialog.checkInIso,
    receiptPaymentAmount,
    receiptPaymentDate,
    receiptTotalPrice,
    receiptPastPayments,
    receiptPageUrl,
    receiptBodyTouched,
  ]);

  const newReceiptRowId = () =>
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const resetReceiptState = () => {
    setReceiptDialog({ open: false, reservationId: null, propertyName: "", guestFirstName: "" });
    setReceiptPaymentAmount("");
    setReceiptPaymentDate("");
    setReceiptTotalPrice("");
    setReceiptPastPayments([]);
    setReceiptPaymentsLoading(false);
    setReceiptBody("");
    setReceiptBodyTouched(false);
    setReceiptPageUrl("");
    setReceiptPageError("");
  };

  // Send the receipt body through the SAME hardened, delivery-verified server
  // path as the main reply (/api/inbox/conversations/:id/send) — a receipt that
  // only reaches Guesty's `pending` state isn't reported as delivered either.
  const sendReceipt = useMutation({
    mutationFn: async () => {
      // Use the conversation/reservation/channel CAPTURED when the dialog opened
      // (not live selectedConv*) so a programmatic deep-link that switches the
      // selected conversation mid-dialog can't deliver this receipt — and its
      // page link — to the wrong guest. Mirrors generateReceiptPage.
      const convId = receiptDialog.conversationId ?? selectedConvId;
      if (!convId) throw new Error("No conversation selected");
      if (!receiptBody.trim()) throw new Error("Receipt body is empty");
      const r = await apiRequest(
        "POST",
        `/api/inbox/conversations/${convId}/send`,
        {
          body: receiptBody,
          reservationId: receiptDialog.reservationId ?? selectedConv?.reservationId ?? null,
          channel: receiptDialog.channel ?? (selectedConv as any)?.module?.type ?? null,
        },
      );
      const body = await r.json().catch(() => ({} as any));
      if (!r.ok || body?.ok !== true) {
        throw new Error(body?.message || body?.error || `Guesty returned HTTP ${r.status}`);
      }
      if (body.verified !== true && body.pending !== true) {
        throw new Error(
          body.deliveryReason
            || "The receipt did not reach the guest's booking channel — verify on the channel's extranet.",
        );
      }
      return { ...(body as { ok: true; verified?: boolean; pending?: boolean; deliveredVia?: string }), convId };
    },
    onSuccess: (data) => {
      const convId = data.convId;
      resetReceiptState();
      qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/communication/conversations", convId] });
      qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/communication/conversations", convId, "posts"] });
      qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/communication/conversations"] });
      const via = data?.deliveredVia?.trim() || "the booking channel";
      if (data?.verified === true) {
        toast({ title: "Receipt sent", description: `Delivered through ${via} and confirmed.` });
      } else {
        toast({
          title: `Receipt queued through ${via} — confirming`,
          description: `Posted to ${via}, not confirmed yet. It'll appear in the thread — don't resend.`,
          variant: "destructive",
        });
      }
    },
    onError: (e: any) => toast({ title: "Failed to send receipt", description: e.message, variant: "destructive" }),
  });

  // Mint a durable /receipt/:token PAYMENT-DETAILS PAGE on demand (the operator
  // "Generate payment details page URL" action) without sending a message. The
  // returned link is surfaced for copy/preview and folded into the receipt
  // message so a subsequent "Send receipt" delivers the page link too.
  const generateReceiptPage = useMutation({
    mutationFn: async () => {
      if (!receiptDialog.reservationId) throw new Error("No reservation selected");
      // The "new charge" amount is OPTIONAL — when the operator hasn't typed one
      // the SERVER derives the headline + paid-to-date from Guesty so the page
      // reflects what the guest has actually paid (not $0). Still send whatever
      // the dialog loaded as a fallback for when the server can't reach Guesty.
      const amt = parseFloat(receiptPaymentAmount);
      const newCharge = Number.isFinite(amt) && amt > 0 ? amt : 0;
      const pastPayments = receiptPastPayments
        .map((p) => ({ date: p.date, amount: parseFloat(p.amount) || 0 }))
        .filter((p) => p.amount > 0);
      const fullHistory = [
        ...pastPayments,
        ...(newCharge > 0 ? [{ date: receiptPaymentDate, amount: newCharge }] : []),
      ];
      const r = await apiRequest("POST", "/api/inbox/guest-receipts/generate-page", {
        reservationId: receiptDialog.reservationId,
        conversationId: receiptDialog.conversationId ?? selectedConvId ?? null,
        kind: "payment",
        guestName: receiptDialog.guestFullName ?? receiptDialog.guestFirstName ?? null,
        guestFirstName: receiptDialog.guestFirstName ?? null,
        propertyName: receiptDialog.propertyName ?? null,
        listingNickname: receiptDialog.propertyName ?? null,
        checkIn: receiptDialog.checkInIso ?? null,
        checkOut: receiptDialog.checkOutIso ?? null,
        confirmationCode: receiptDialog.confirmationCode ?? null,
        channel: receiptDialog.channel ?? (selectedConv as any)?.module?.type ?? null,
        amount: newCharge,
        transactionDate: newCharge > 0 ? (receiptPaymentDate || null) : null,
        bookingTotal: parseFloat(receiptTotalPrice) || 0,
        paymentHistory: fullHistory,
        totalPaidToDate: fullHistory.reduce((s, p) => s + p.amount, 0),
      });
      const data = await r.json().catch(() => ({} as any));
      if (!r.ok || data?.ok !== true || !data?.url) {
        throw new Error(data?.message || data?.error || `Server returned HTTP ${r.status}`);
      }
      return data as {
        ok: true; token: string; url: string; messageBody: string;
        amount?: number; bookingTotal?: number; transactionDate?: string;
        totalPaidToDate?: number; paymentHistory?: Array<{ date: string; amount: number }>;
      };
    },
    onSuccess: (data) => {
      setReceiptPageError("");
      setReceiptPageUrl(data.url);
      // Sync the dialog to the server's AUTHORITATIVE figures (derived from
      // Guesty) so the amount / booking total / previous-payments / message
      // preview all reflect what the guest actually paid — fixing the "$0 paid"
      // page when the client-side history hadn't loaded. The regenerate effect
      // (which depends on these fields + receiptPageUrl) then rebuilds the body
      // with the link folded in. If the operator already hand-edited the body,
      // don't clobber it — just weave the link into their copy.
      if (receiptBodyTouched) {
        setReceiptBody((prev) => withReceiptLink(prev, data.url));
      } else {
        if (typeof data.amount === "number" && data.amount > 0) {
          setReceiptPaymentAmount(data.amount.toFixed(2));
        }
        if (typeof data.bookingTotal === "number" && data.bookingTotal > 0) {
          setReceiptTotalPrice(data.bookingTotal.toFixed(2));
        }
        const headlineDay = String(data.transactionDate ?? "").slice(0, 10);
        if (headlineDay) setReceiptPaymentDate(headlineDay);
        if (Array.isArray(data.paymentHistory)) {
          // "Previous payments" = full history minus the headline payment.
          let removed = false;
          const past = data.paymentHistory
            .filter((p) => {
              if (!removed && String(p.date).slice(0, 10) === headlineDay && Math.abs(Number(p.amount) - Number(data.amount)) < 0.005) {
                removed = true;
                return false;
              }
              return true;
            })
            .map((p) => ({ id: newReceiptRowId(), date: String(p.date).slice(0, 10), amount: (Number(p.amount) || 0).toFixed(2) }));
          setReceiptPastPayments(past);
        }
      }
      toast({ title: "Payment details page ready", description: "Copy the link or send it to the guest." });
    },
    onError: (e: any) => {
      setReceiptPageError(e?.message ?? "Could not generate the page");
      toast({ title: "Couldn't generate page", description: e?.message, variant: "destructive" });
    },
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
    const postTime = (p: any) => {
      const t = new Date(p.sentAt ?? p.postedAt ?? p.createdAt ?? 0).getTime();
      return Number.isFinite(t) ? t : 0;
    };
    const postBody = (p: any) => cleanMessageBody(String(p?.body ?? p?.text ?? p?.message ?? "")).trim();
    const sortedAsc = [...threadPosts].sort((a: any, b: any) => postTime(a) - postTime(b));
    const conversationalPosts = sortedAsc.filter((p: any) => !isGuestySystemPost(p) && postBody(p));
    const isInitialContact = !conversationalPosts.some(isHostPost);
    const lastGuestPost = [...conversationalPosts].reverse().find((p: any) => !isHostPost(p));
    const guestMessage = postBody(lastGuestPost);
    const isWelcomeDraft = isInitialContact && !guestMessage;
    const conversationHistory = conversationalPosts
      .slice(-10)
      .map((p: any) => {
        const role = isHostPost(p) ? "Host" : "Guest";
        const timestamp = postTime(p);
        const when = timestamp
          ? new Date(timestamp).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })
          : "";
        const body = postBody(p).replace(/\s+/g, " ").slice(0, 1200);
        return `${role}${when ? ` ${when}` : ""}: ${body}`;
      })
      .join("\n");
    // Build property-specific context so the AI can answer "how many
    // bedrooms per unit?" / "how far apart are the units?" / "is
    // parking free?" with facts instead of hand-waves. Non-blocking:
    // if the listing isn't mapped to one of our properties we fall
    // through with propertyContext=null and the server uses its
    // generic prompt.
    const ctx = selectedConv.listingId
      ? await buildPropertyContextForDraft(selectedConv.listingId)
      : null;
    const selectedReservation =
      (reservationFull as any)?.data ??
      reservationFull ??
      (selectedConv as any)?.meta?.reservations?.[0] ??
      null;
    // Channel name (airbnb / vrbo / booking / direct / email / …) so
    // the server can give a channel-correct answer when the guest
    // asks about payment timing — e.g. "Airbnb sets the payment
    // schedule" rather than a generic disclaimer.
    const channel =
      selectedReservation?.integration?.platform ??
      selectedReservation?.source ??
      selectedConv.conversationChannel ??
      (selectedConv as any).integration?.platform ??
      selectedConv.module?.type ??
      "";
    const checkInForDraft =
      selectedReservation?.checkInDateLocalized ??
      selectedReservation?.checkIn ??
      (selectedConv as any).conversationCheckIn ??
      null;
    const checkOutForDraft =
      selectedReservation?.checkOutDateLocalized ??
      selectedReservation?.checkOut ??
      (selectedConv as any).conversationCheckOut ??
      null;
    const guestsForDraft =
      selectedReservation?.guestsCount ??
      selectedReservation?.numberOfGuests ??
      (selectedConv as any).conversationGuests ??
      null;
    const reservationStatusForDraft =
      selectedReservation?.status ??
      (selectedConv as any).status ??
      null;
    try {
      const r = await apiRequest("POST", "/api/inbox/ai-draft", {
        guestMessage,
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
        checkIn: checkInForDraft,
        checkOut: checkOutForDraft,
        guestsCount: guestsForDraft,
        conversationHistory,
        reservationStatus: reservationStatusForDraft,
        conversationPhase: (selectedConv as any).phase ?? null,
        isInitialContact,
        isWelcomeDraft,
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
    enabled: isAdmin,
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
    enabled: isAdmin,
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
    enabled: isAdmin,
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

  // ── Guest issues open-count (drives the "Guest Issues" tab badge) ──
  // Lightweight count of unresolved (open + ongoing) issues across all guests.
  // Shared query-key prefix ["/api/inbox/guest-issues", ...] means resolving an
  // issue anywhere invalidates + refetches this, so the tab flag clears itself.
  const { data: guestIssuesOpenData } = useQuery<{ issues: any[] }>({
    queryKey: ["/api/inbox/guest-issues", "open-count"],
    queryFn: async () =>
      (await apiRequest("GET", "/api/inbox/guest-issues?status=unresolved&limit=200")).json(),
    refetchInterval: 30_000,
  });
  // Split the unresolved count by KIND so each tab shows its own flag. A row with
  // no kind (legacy) counts as property (the DB default).
  const unresolvedIssues = guestIssuesOpenData?.issues ?? [];
  const openGuestIssueCount = unresolvedIssues.filter((i) => i?.kind !== "back_office").length;
  const openBackOfficeIssueCount = unresolvedIssues.filter((i) => i?.kind === "back_office").length;

  const approveReservation = useMutation({
    mutationFn: (id: string) =>
      apiRequest("PUT", `/api/guesty-proxy/reservations/${id}/confirm`, {}).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/guesty-proxy/reservations/pending"] });
      toast({ title: "Reservation approved!" });
    },
    onError: (e: any) => toast({ title: "Failed to approve", description: e.message, variant: "destructive" }),
  });

  // Pre-approve an Airbnb inquiry directly from the inbox. The server uses
  // Guesty's reservation-v3 pre-approve action, then we keep a tiny local
  // acknowledgement so the green state survives Guesty's read-after-write lag.
  const preapproveAirbnb = useMutation({
    mutationFn: async (reservationId: string) => {
      const r = await apiRequest("POST", `/api/inbox/reservations/${reservationId}/airbnb/preapprove`, {});
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error ?? err.message ?? `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: (data, reservationId) => {
      rememberAirbnbPreapproval(reservationId);
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
        title: data?.alreadyRequested ? "Already pre-approved on Airbnb" : "Pre-approved on Airbnb",
        description: `${who} can now book without further host action.`,
      });
    },
    onError: (e: any) => toast({ title: "Pre-approval failed", description: e.message, variant: "destructive" }),
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
    onSuccess: (_data, vars) => {
      forgetAirbnbPreapproval(vars.reservationId);
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
      <div className="border-b bg-card px-4 py-3 sm:px-6 sm:py-4 flex flex-wrap items-center gap-3 sm:gap-4">
        <Link href="/">
          <Button variant="ghost" size="sm" className="gap-1" data-testid="button-back-home">
            <ArrowLeft className="h-4 w-4" /> Dashboard
          </Button>
        </Link>
        <div className="hidden sm:block h-5 w-px bg-border" />
        <div className="min-w-0">
          <h1 className="font-semibold text-lg leading-tight">Guest Inbox</h1>
          <p className="text-xs text-muted-foreground">
            {isAgent
              ? "Messages · Guest Issues · Missed calls · Arrival details"
              : "Messages · Guest Issues · Reservations · Auto-Messages"}
          </p>
        </div>
        {(unreadConversationCount > 0 || (!isAgent && pendingRes.length > 0) || missedCallCount > 0) && (
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            {unreadConversationCount > 0 && (
              <Badge className="bg-primary text-primary-foreground" data-testid="badge-unread-count">
                {unreadConversationCount} unread
              </Badge>
            )}
            {!isAgent && pendingRes.length > 0 && (
              <Badge className="bg-amber-500 text-white" data-testid="badge-pending-count">
                {pendingRes.length} pending request{pendingRes.length > 1 ? "s" : ""}
              </Badge>
            )}
            {missedCallCount > 0 && (
              <Badge className="bg-red-600 text-white" data-testid="badge-missed-call-count">
                {missedCallCount} missed call{missedCallCount === 1 ? "" : "s"}
              </Badge>
            )}
          </div>
        )}
      </div>

      <div className="max-w-7xl mx-auto px-3 py-4 sm:px-4 sm:py-6">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-4 sm:mb-6 flex h-auto w-full max-w-full justify-start overflow-x-auto p-1 sm:w-auto" data-testid="tabs-inbox">
            <TabsTrigger value="messages" data-testid="tab-messages">
              <MessageSquare className="h-4 w-4 mr-1.5" /> Messages
              {unreadConversationCount > 0 && (
                <span
                  className="ml-1.5 rounded-full bg-primary text-primary-foreground text-[10px] min-w-4 h-4 px-1 flex items-center justify-center"
                  data-testid="badge-messages-unread"
                >
                  {unreadConversationCount}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="guest-issues" data-testid="tab-guest-issues">
              <AlertCircle className="h-4 w-4 mr-1.5" /> Guest Issues
              {openGuestIssueCount > 0 && (
                <span
                  className="ml-1.5 rounded-full bg-red-600 text-white text-[10px] min-w-4 h-4 px-1 flex items-center justify-center"
                  data-testid="badge-guest-issues-open"
                >
                  {openGuestIssueCount >= 200 ? "200+" : openGuestIssueCount}
                </span>
              )}
            </TabsTrigger>
            {/* Back-Office Issues (refunds/cancellations/billing) is OPERATOR-ONLY —
                hidden from the remote agent login. The server also withholds
                back_office rows from the agent role (defense in depth). */}
            {!isAgent && (
              <TabsTrigger value="back-office-issues" data-testid="tab-back-office-issues">
                <DollarSign className="h-4 w-4 mr-1.5" /> Back-Office Issues
                {openBackOfficeIssueCount > 0 && (
                  <span
                    className="ml-1.5 rounded-full bg-red-600 text-white text-[10px] min-w-4 h-4 px-1 flex items-center justify-center"
                    data-testid="badge-back-office-issues-open"
                  >
                    {openBackOfficeIssueCount >= 200 ? "200+" : openBackOfficeIssueCount}
                  </span>
                )}
              </TabsTrigger>
            )}
            {!isAgent && (
              <TabsTrigger value="reservations" data-testid="tab-reservations">
                <Calendar className="h-4 w-4 mr-1.5" /> Reservations
                {pendingRes.length > 0 && (
                  <span className="ml-1.5 rounded-full bg-amber-500 text-white text-[10px] w-4 h-4 flex items-center justify-center">
                    {pendingRes.length}
                  </span>
                )}
              </TabsTrigger>
            )}
            {!isAgent && (
              <TabsTrigger value="auto-messages" data-testid="tab-auto-messages">
                <Zap className="h-4 w-4 mr-1.5" /> Auto-Messages
              </TabsTrigger>
            )}
          </TabsList>

          {/* ── GUEST ISSUES TAB ──
              Cross-conversation view of every guest issue. The trigger badge shows
              the open (unresolved) count and clears as issues are resolved. Visible
              to the operator AND remote agents; new issues are logged from the
              per-conversation Guest issues panel in the message thread. */}
          <TabsContent value="guest-issues">
            <GuestIssuesTab
              kind="property"
              canDelete={isAdmin}
              onOpenConversation={(conversationId) => {
                setSelectedConvId(conversationId);
                setActiveTab("messages");
              }}
            />
          </TabsContent>

          {/* ── BACK-OFFICE ISSUES TAB ── (operator-only; hidden from agents)
              Refund requests, billing disputes, and cancellation requests — the
              money/booking-admin counterpart to Guest Issues. Same component, kind
              filtered to back_office. */}
          {!isAgent && (
            <TabsContent value="back-office-issues">
              <GuestIssuesTab
                kind="back_office"
                canDelete={isAdmin}
                onOpenConversation={(conversationId) => {
                  setSelectedConvId(conversationId);
                  setActiveTab("messages");
                }}
              />
            </TabsContent>
          )}

          {/* ── MESSAGES TAB ── */}
          <TabsContent value="messages">
            {missedCalls.length > 0 && (
              <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-red-950" data-testid="panel-missed-calls">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <PhoneMissed className="h-4 w-4" />
                      Missed calls need review
                    </div>
                    <div className="mt-1 text-xs text-red-800">
                      Call the guest back, then save what they said so the note stays with the Guest Inbox thread.
                    </div>
                  </div>
                  <div className="grid gap-2 sm:min-w-[360px]">
                    {missedCalls.slice(0, 3).map((call) => (
                      <div key={call.id} className="rounded-md border border-red-200 bg-white/80 px-3 py-2 text-xs">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="font-medium text-red-950">
                              {call.guestName || "Unknown caller"} · {formatPhone(call.guestPhone)}
                            </div>
                            <div className="mt-0.5 text-red-800">
                              {call.disposition === "voicemail" ? "Voicemail" : "Missed call"}
                              {call.callCompletedAt && ` · ${new Date(call.callCompletedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`}
                              {call.voicemailDurationSeconds && ` · ${formatDuration(call.voicemailDurationSeconds)}`}
                              {call.matchConfidence && ` · ${call.matchConfidence} confidence`}
                            </div>
                            {call.voicemailTranscript && (
                              <div className="mt-1 max-h-10 overflow-hidden text-red-900">
                                {call.voicemailTranscript}
                              </div>
                            )}
                            {call.voicemailRecordingUrl && (
                              <audio
                                controls
                                src={call.voicemailRecordingUrl}
                                className="mt-2 w-full max-w-[260px]"
                                data-testid={`audio-missed-call-voicemail-${call.id}`}
                              />
                            )}
                          </div>
                          <div className="flex shrink-0 gap-1">
                            {call.conversationId && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-[11px]"
                                onClick={() => setSelectedConvId(call.conversationId!)}
                                data-testid={`button-open-missed-call-${call.id}`}
                              >
                                Open
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-[11px]"
                              onClick={() => {
                                setCallbackCall(call);
                                setCallbackSummary("");
                              }}
                              disabled={completeCallback.isPending}
                              data-testid={`button-clear-missed-call-${call.id}`}
                            >
                              Called back
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 w-7 p-0 text-red-700 hover:bg-red-100 hover:text-red-900"
                              onClick={() => dismissMissedCall.mutate(call.id)}
                              disabled={dismissMissedCall.isPending}
                              data-testid={`button-dismiss-missed-call-${call.id}`}
                              aria-label="Dismiss missed call notification"
                              title="Dismiss notification"
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)_320px] lg:h-[calc(100vh-220px)] lg:min-h-[600px]">
              {/* Conversation List */}
              <div className="border rounded-lg bg-card max-h-[42vh] overflow-y-auto lg:max-h-none">
                <div className="px-4 py-3 border-b flex items-center justify-between gap-2">
                  <span className="text-sm font-medium shrink-0">Conversations</span>
                  <div className="flex items-center gap-2 min-w-0">
                    {/* Tier-1 auto-answer switch (admin): ON = basic tier-1
                        questions get the automatic Hawaii-style AI reply;
                        tier 2 always waits for a human. */}
                    {isAdmin && (
                      <label
                        className="flex items-center gap-1.5 text-[11px] text-muted-foreground select-none"
                        title="Tier-1 auto-answer: super-basic property questions (ocean view, parking, wifi…) get an automatic AI reply in Hawaii style, signed John Carpenter. Tier-2 messages are never auto-answered."
                      >
                        <span className="whitespace-nowrap">Tier 1 auto-answer</span>
                        <Switch
                          checked={autoReplyEngineStatus?.tier1AutoEnabled !== false}
                          disabled={tier1ToggleMutation.isPending}
                          onCheckedChange={(checked) => tier1ToggleMutation.mutate(!!checked)}
                          data-testid="switch-tier1-auto-answer"
                        />
                      </label>
                    )}
                    {convLoading && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />}
                  </div>
                </div>
                <div className="px-3 py-2 border-b space-y-2">
                  {/* Free-text search — name / email / phone / listing /
                      confirmation. Filters the whole conversation list so the
                      operator can jump straight to a guest. */}
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search name, email, phone…"
                      className="h-8 pl-7 pr-7 text-xs"
                      data-testid="input-conversation-search"
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => setSearchQuery("")}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                        aria-label="Clear search"
                        data-testid="button-clear-conversation-search"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  {/* Property filter — only visible when there's something to
                      filter (>1 distinct listing). Hidden when there's a single
                      property in the inbox so the dropdown isn't dead UI. */}
                  {listingOptions.length > 1 && (
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
                  )}
                  <Select value={replyStatusFilter} onValueChange={(value) => setReplyStatusFilter(value as "all" | "unread" | "read")}>
                    <SelectTrigger
                      className="h-8 text-xs"
                      data-testid="select-conversation-reply-status-filter"
                    >
                      <SelectValue placeholder="All reply statuses" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All reply statuses</SelectItem>
                      <SelectItem value="unread">Unread / reply needed</SelectItem>
                      <SelectItem value="read">Read / replied</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
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
                    No conversations match those filters.{" "}
                    <button
                      className="underline text-primary"
                      onClick={() => {
                        setPropertyFilter("all");
                        setReplyStatusFilter("all");
                        setSearchQuery("");
                      }}
                      data-testid="button-clear-conversation-filter"
                    >
                      Clear filters
                    </button>
                  </div>
                )}
                <TooltipProvider>
                {filteredConversations.map(rawC => {
                  const c = applyLocalReplyOverride(rawC);
                  const active = c._id === selectedConvId;
                  const conversationMissedCalls = missedCallsByConversation[c._id] ?? 0;
                  // The row signals "unread" via either the blue dot (isUnread)
                  // or the amber reply-owed marker (needsReply); the right-click
                  // menu treats both together as the row's unread state.
                  const rowIsUnread = c.isUnread || c.needsReply;
                  return (
                    <ContextMenu key={c._id}>
                      <ContextMenuTrigger asChild>
                        <button
                          data-testid={`conversation-item-${c._id}`}
                          onClick={() => setSelectedConvId(c._id)}
                          className={`w-full text-left px-4 py-3 border-b hover:bg-muted/50 transition-colors ${active ? "bg-primary/5 border-l-2 border-l-primary" : ""}`}
                        >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div
                            className={`relative w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 ${
                              c.needsReply ? "ring-2 ring-amber-300 ring-offset-1 ring-offset-background" : ""
                            }`}
                          >
                            {c.needsReply && (
                              <span
                                className="absolute -left-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-500 text-white shadow-sm"
                                data-testid={`indicator-reply-owed-avatar-${c._id}`}
                                aria-label="Unread reply needed"
                              >
                                <MessageCircle className="h-2.5 w-2.5" />
                              </span>
                            )}
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
                              {conversationMissedCalls > 0 && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span
                                      className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[9px] font-semibold leading-none text-white"
                                      data-testid={`indicator-missed-calls-${c._id}`}
                                    >
                                      {conversationMissedCalls}
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent side="right">Missed call notification</TooltipContent>
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
                            {/* Guest-question tier chip — "did the AI answer
                                this automatically?" at a glance. tier2-handled
                                is hidden here (noise once replied); the thread
                                header still shows it. */}
                            {(() => {
                              const tierBadge = tierBadgeByConversation[c._id];
                              if (!tierBadge || tierBadge.kind === "tier2-handled") return null;
                              const chipClass =
                                tierBadge.kind === "tier1-answered" ? "bg-emerald-100 text-emerald-800" :
                                tierBadge.kind === "tier1-manual"   ? "bg-emerald-50 text-emerald-700" :
                                tierBadge.kind === "tier1-sending"  ? "bg-sky-100 text-sky-800" :
                                tierBadge.kind === "tier1-held"     ? "bg-slate-100 text-slate-600" :
                                "bg-amber-100 text-amber-800";
                              return (
                                <span
                                  className={`inline-block mt-1 ml-1 px-1.5 py-[1px] rounded text-[9px] font-medium ${chipClass}`}
                                  title={tierBadge.title}
                                  data-testid={`badge-tier-${c._id}`}
                                >
                                  {tierBadge.label}
                                </span>
                              );
                            })()}
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
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-48">
                        <ContextMenuLabel className="max-w-[12rem] truncate">
                          {c.displayGuestName}
                        </ContextMenuLabel>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          disabled={!rowIsUnread}
                          onSelect={() => markConversationReadState(c._id, "read")}
                          data-testid={`context-mark-read-${c._id}`}
                        >
                          <MailOpen className="h-3.5 w-3.5 mr-2" /> Mark as read
                        </ContextMenuItem>
                        <ContextMenuItem
                          disabled={rowIsUnread}
                          onSelect={() => markConversationReadState(c._id, "unread")}
                          data-testid={`context-mark-unread-${c._id}`}
                        >
                          <Mail className="h-3.5 w-3.5 mr-2" /> Mark as unread
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                })}
                </TooltipProvider>
              </div>

              {/* Thread + Reply */}
              <div className="border rounded-lg bg-card flex min-h-[560px] flex-col lg:min-h-0">
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
                    <div className="px-4 py-3 sm:px-5 border-b flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{selectedConv?.displayGuestName ?? "Guest"}</p>
                        <p className="text-xs text-muted-foreground truncate">{selectedConv?.displayListingName ?? "—"}</p>
                        {/* Guest-question tier verdict for the latest message
                            in this thread: Tier 1 = the AI answered (or is
                            about to); Tier 2 = no automatic response, it's on
                            the operator. Hover for the classifier's reason. */}
                        {(() => {
                          const tierBadge = selectedConvId ? tierBadgeByConversation[selectedConvId] : null;
                          if (!tierBadge) return null;
                          const chipClass =
                            tierBadge.kind === "tier1-answered" ? "bg-emerald-100 text-emerald-800" :
                            tierBadge.kind === "tier1-manual"   ? "bg-emerald-50 text-emerald-700" :
                            tierBadge.kind === "tier1-sending"  ? "bg-sky-100 text-sky-800" :
                            tierBadge.kind === "tier1-held"     ? "bg-slate-100 text-slate-600" :
                            tierBadge.kind === "tier2-handled"  ? "bg-gray-100 text-gray-500" :
                            "bg-amber-100 text-amber-800";
                          return (
                            <span
                              className={`inline-block mt-1 px-1.5 py-[1px] rounded text-[10px] font-medium ${chipClass}`}
                              title={tierBadge.title}
                              data-testid={`badge-tier-thread-${selectedConvId}`}
                            >
                              {tierBadge.kind === "tier1-answered" ? "✓ Tier 1 — AI answered automatically"
                                : tierBadge.kind === "tier1-sending" ? "Tier 1 — AI reply sending shortly"
                                : tierBadge.kind === "tier1-manual" ? "Tier 1 — answered from the AI draft"
                                : tierBadge.kind === "tier1-held" ? "Tier 1 — auto-answer off, reply yourself"
                                : tierBadge.kind === "tier2-handled" ? "Tier 2 — handled (no auto-reply)"
                                : "Tier 2 — no automatic AI response, needs you"}
                            </span>
                          );
                        })()}
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
                    <div ref={threadRef} className="flex-1 overflow-y-auto px-3 py-4 sm:px-5 space-y-3">
                      {(threadLoading || postsLoading || smsLoading || callsLoading) && threadPosts.length === 0 && (
                        <div className="text-center text-xs text-muted-foreground py-4">Loading messages…</div>
                      )}
                      {[...threadPosts]
                        // Filter system log posts (e.g. "New guest inquiry"
                        // module=log) — they're metadata for Guesty's UI,
                        // not a message either side actually wrote, and
                        // rendering them as a left-aligned bubble made
                        // the thread look like the guest sent boilerplate
                        // before her real first message. Identified by
                        // `sentBy === "log"` OR `module.type === "log"`.
                        // NOTE FOR CODEX: server-side `isSystemPost` in
                        // auto-reply.ts also filters these — keep the
                        // two definitions in sync if Guesty adds a new
                        // system module type.
                        .filter((p: any) => !isGuestySystemPost(p))
                        .sort((a: any, b: any) => {
                          const ta = new Date(a.sentAt ?? a.postedAt ?? a.createdAt ?? 0).getTime();
                          const tb = new Date(b.sentAt ?? b.postedAt ?? b.createdAt ?? 0).getTime();
                          return ta - tb; // ascending: oldest at top, newest at bottom
                        })
                        .map((p: any) => {
                          const bodyText = cleanMessageBody(p.body ?? p.text ?? p.message ?? "");
                          // Photos/files the guest (or we) attached to this
                          // message. VRBO/Airbnb photo messages arrive as an
                          // `attachments` array (often with an EMPTY body) —
                          // without this they rendered as a blank bubble and
                          // the operator never saw the photo.
                          const postAttachments = collectPostAttachments(p);
                          const displayBody = postAttachments.length > 0
                            ? bodyWithoutAttachmentUrls(bodyText, postAttachments)
                            : bodyText;
                          const when = p.sentAt ?? p.postedAt ?? p.createdAt ?? "";
                          // Guesty inbox-v2 uses `sentBy: "guest" | "host"`.
                          // Older shapes used `authorType` / `direction` /
                          // `isIncoming`. Without the `sentBy` check,
                          // every post on a current Guesty thread fell
                          // through to the default "not host" branch and
                          // rendered on the left side as a guest bubble —
                          // making it impossible to tell who said what
                          // (Michelle's thread on 2026-05-04 had John's
                          // replies indistinguishable from her own
                          // messages). NOTE FOR CODEX: the `sentBy`
                          // check should win over the legacy fields if
                          // they ever conflict — Guesty stopped
                          // populating the legacy ones in inbox-v2.
                          const isHost =
                            p.sentBy === "host" ||
                            p.authorType === "host" ||
                            p.authorRole === "host" ||
                            p.senderType === "host" ||
                            p.direction === "outbound" ||
                            p.direction === "out" ||
                            p.isIncoming === false;
                          const channel = p.module?.type ?? p.type ?? p.integration?.platform ?? "";
                          const callEvent = (p.module as any)?.callEvent as QuoCallEvent | undefined;
                          const isCall = channel === "call" && callEvent;
                          const isAirbnbSupport = isAirbnbCustomerServicePost(p);
                          const senderLabel = isHost
                            ? "You"
                            : isAirbnbSupport
                              ? "Airbnb support"
                              : (selectedConv?.displayGuestName ?? "Guest");
                          return (
                            <div key={p._id} className={`flex flex-col ${isHost ? "items-end" : "items-start"}`}>
                              <div
                                className={`max-w-[92%] [overflow-wrap:anywhere] rounded-2xl px-3 py-2.5 text-sm whitespace-pre-wrap sm:max-w-[78%] sm:px-4 ${
                                  isCall
                                    ? "border border-red-200 bg-red-50 text-red-950 rounded-bl-sm"
                                    : isAirbnbSupport
                                    ? "border border-rose-200 bg-rose-50 text-rose-950 rounded-bl-sm"
                                    : isHost
                                    ? "bg-primary text-primary-foreground rounded-br-sm"
                                    : "bg-muted text-foreground rounded-bl-sm"
                                }`}
                                data-testid={`message-${p._id}`}
                              >
                                {isCall ? (
                                  <div className="space-y-2">
                                    <div className="flex items-center gap-2 font-medium">
                                      {callEvent.disposition === "voicemail" ? (
                                        <Voicemail className="h-4 w-4" />
                                      ) : callEvent.disposition === "missed" ? (
                                        <PhoneMissed className="h-4 w-4" />
                                      ) : (
                                        <PhoneCall className="h-4 w-4" />
                                      )}
                                      <span>{callEvent.disposition === "voicemail" ? "Voicemail" : callEvent.disposition === "missed" ? "Missed call" : "Call"}</span>
                                    </div>
                                    <div className="text-xs leading-relaxed">
                                      {bodyText}
                                    </div>
                                    {callEvent.voicemailRecordingUrl && (
                                      <audio
                                        controls
                                        src={callEvent.voicemailRecordingUrl}
                                        className="mt-1 w-full max-w-[320px]"
                                        data-testid={`audio-voicemail-${callEvent.id}`}
                                      />
                                    )}
                                    {callEvent.voicemailTranscript && (
                                      <div className="rounded-md border border-red-200 bg-white/80 p-2 text-xs text-red-950">
                                        {callEvent.voicemailTranscript}
                                      </div>
                                    )}
                                    {!callEvent.acknowledgedAt && (callEvent.disposition === "missed" || callEvent.disposition === "voicemail") && (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-7 px-2 text-[11px]"
                                        onClick={() => {
                                          setCallbackCall(callEvent);
                                          setCallbackSummary("");
                                        }}
                                        disabled={completeCallback.isPending}
                                        data-testid={`button-clear-thread-missed-call-${callEvent.id}`}
                                      >
                                        Called guest back
                                      </Button>
                                    )}
                                  </div>
                                ) : (
                                  <>
                                    {displayBody}
                                    {postAttachments.length > 0 && (
                                      <div className={`flex flex-wrap gap-1.5 ${displayBody ? "mt-2" : ""}`} data-testid={`attachments-${p._id}`}>
                                        {postAttachments.map((att, i) => (
                                          <PostAttachmentView key={`${p._id}-att-${i}`} attachment={att} />
                                        ))}
                                      </div>
                                    )}
                                  </>
                                )}
                              </div>
                              {/* Timestamp + channel row, mirrors Guesty's portal */}
                              <div className="flex items-center gap-1.5 mt-1 text-[10px] text-muted-foreground px-1">
                                <span>{senderLabel}</span>
                                <span>·</span>
                                <span>{when ? new Date(when).toLocaleString([], { month: "2-digit", day: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit" }) : ""}</span>
                                {channel && (
                                  <>
                                    <span>·</span>
                                    {channelBadge(channel)}
                                  </>
                                )}
                                {/* Tag auto-sent payment/refund receipts (they post as
                                    normal host messages; this is display-only and never
                                    shown to the guest). */}
                                {isHost && /confirming a (payment|refund) of \$/i.test(bodyText) && (
                                  <>
                                    <span>·</span>
                                    <span
                                      className="inline-flex items-center gap-0.5 rounded bg-sky-100 px-1 py-0.5 font-medium text-sky-700 dark:bg-sky-950/50 dark:text-sky-300"
                                      data-testid={`badge-thread-receipt-${p._id}`}
                                    >
                                      📄 {/confirming a refund of \$/i.test(bodyText) ? "Refund receipt" : "Payment receipt"}
                                    </span>
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      {/* Thread debug: only shown when both queries settled and still no posts */}
                      {!threadLoading && !postsLoading && !smsLoading && !callsLoading && threadPosts.length === 0 && (threadData || postsData || smsData || callData) && (
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
                    <div className="border-t px-3 py-3 sm:px-4 space-y-2">
                      <Textarea
                        ref={replyRef}
                        data-testid="textarea-reply"
                        placeholder="Write a reply…"
                        value={replyText}
                        onChange={e => setReplyText(e.target.value)}
                        rows={10}
                        className="resize-y min-h-[180px]"
                        onFocus={e => {
                          // Agent box seeded with only the sign-off: drop the caret at
                          // the very top so she types her message ABOVE "Mahalo, Christal".
                          if (replyIsOnlySignoff && e.target.value === AGENT_COMPOSE_SEED) {
                            e.target.setSelectionRange(0, 0);
                          }
                        }}
                        onKeyDown={e => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && replyText.trim() && !replyIsOnlySignoff) {
                            sendMessage.mutate();
                          }
                        }}
                      />
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full sm:w-auto"
                          onClick={generateDraft}
                          disabled={draftLoading}
                          data-testid="button-ai-draft"
                        >
                          <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                          {draftLoading ? "Drafting…" : "AI Draft"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full sm:w-auto"
                          onClick={() => sendTextMessage.mutate()}
                          disabled={!replyText.trim() || replyIsOnlySignoff || sendTextMessage.isPending || Boolean(smsDisabledReason)}
                          title={replyIsOnlySignoff ? "Write a message above your sign-off first" : (smsDisabledReason ?? `Send SMS to ${effectiveGuestPhone}`)}
                          data-testid="button-send-text"
                        >
                          <MessageCircle className="h-3.5 w-3.5 mr-1.5" />
                          {sendTextMessage.isPending ? "Texting…" : "Send Text"}
                        </Button>
                        <Button
                          size="sm"
                          className="w-full sm:w-auto"
                          onClick={() => sendMessage.mutate()}
                          disabled={!replyText.trim() || replyIsOnlySignoff || sendMessage.isPending || sendTextMessage.isPending}
                          data-testid="button-send-reply"
                          // The send route returns as soon as the message is
                          // posted (a short inline verify), so this clears in a
                          // few seconds; OTA delivery confirmation then finishes
                          // in the background and updates the status itself.
                          title={sendMessage.isPending ? "Posting your message…" : undefined}
                        >
                          {sendMessage.isPending
                            ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                            : <Send className="h-3.5 w-3.5 mr-1.5" />}
                          {sendMessage.isPending ? "Sending…" : "Send in Guesty"}
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Reservation detail panel (right column) */}
              <div className="border rounded-lg bg-card max-h-none overflow-y-auto lg:max-h-none">
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
                    (res?._id ? airbnbPreapprovedIds.has(res._id) : false) ||
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
                  const cancellationPolicy = cancellationPolicySummaryForReservation(res);

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
                        {!isAgent && isAirbnb && (phase === "inquiry" || phase === "request") && (
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
                                        inquiry is to send a polite reply, or
                                        just let it lapse.
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
                                    Airbnb inquiries can't be declined — they auto-expire after 24h. To pass, send a polite reply or just let the inquiry lapse.
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {cancellationPolicy && (
                        <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sky-950">
                          <div className="flex items-start gap-2">
                            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-sky-700" />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <div className="text-[10px] uppercase tracking-wider text-sky-800 font-medium">
                                  Cancellation policy
                                </div>
                                {cancellationPolicy.assumed && (
                                  <Badge variant="outline" className="border-sky-300 bg-white/70 text-[10px] text-sky-900">
                                    Assumed from Guesty
                                  </Badge>
                                )}
                              </div>
                              <div className="mt-0.5 break-words text-xs font-medium">
                                {cancellationPolicy.label}
                              </div>
                              <div className="mt-1 break-words text-[11px] leading-relaxed text-sky-900">
                                <span className="font-semibold">Policy summary:</span> {cancellationPolicy.summary}
                              </div>
                              <dl className="mt-2 grid gap-1 text-[11px] leading-relaxed">
                                <div>
                                  <dt className="font-semibold text-sky-900">Free until penalty</dt>
                                  <dd className="break-words">{cancellationPolicy.freeCancellationUntil}</dd>
                                </div>
                                <div>
                                  <dt className="font-semibold text-sky-900">Penalty</dt>
                                  <dd className="break-words">{cancellationPolicy.penalty}</dd>
                                </div>
                              </dl>
                              {cancellationPolicy.source && (
                                <div className="mt-1 text-[11px] text-sky-800">
                                  {cancellationPolicy.source}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Guest */}
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Guest</div>
                        <div className="mt-0.5 font-medium">{guest.fullName ?? selectedConv.displayGuestName}</div>
                        <div className="mt-2 space-y-1.5">
                          <Label htmlFor="guest-sms-phone" className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                            SMS phone
                          </Label>
                          <div className="flex gap-1.5">
                            <Input
                              id="guest-sms-phone"
                              value={guestPhoneInput}
                              onChange={(e) => setGuestPhoneInput(e.target.value)}
                              onBlur={() => {
                                const normalized = normalizePhone(guestPhoneInput);
                                if (normalized) setGuestPhoneInput(normalized);
                              }}
                              placeholder="+18085551234"
                              className="h-8 text-xs"
                              data-testid="input-guest-sms-phone"
                            />
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 px-2 text-[11px]"
                              onClick={() => saveGuestPhone.mutate()}
                              disabled={saveGuestPhone.isPending || !guestPhoneInput.trim()}
                              data-testid="button-save-guest-sms-phone"
                            >
                              Save
                            </Button>
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            {savedGuestPhone
                              ? `Saved override${selectedConv.displayGuestPhone && selectedConv.displayGuestPhone !== savedGuestPhone ? ` · Guesty: ${selectedConv.displayGuestPhone}` : ""}`
                              : selectedConv.displayGuestPhone
                                ? "Pulled from Guesty"
                                : "Enter a number with area code before texting"}
                          </div>
                        </div>
                        {guest.isReturning && <Badge variant="secondary" className="text-[10px] mt-1">Returning guest</Badge>}
                      </div>

                      {!isAgent && reservationId && (
                        <InboxAlternativePagePanel reservationId={reservationId} />
                      )}

                      {callEvents.length > 0 && (
                        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-950" data-testid="card-conversation-calls">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-red-800 font-medium">
                                <PhoneCall className="h-3.5 w-3.5" />
                                Quo calls
                              </div>
                              <div className="mt-1 text-xs text-red-900">
                                {callEvents.filter((c) => !c.acknowledgedAt && (c.disposition === "missed" || c.disposition === "voicemail")).length} uncleared · {callEvents.length} total
                              </div>
                            </div>
                            {callEvents.some((c) => !c.acknowledgedAt && (c.disposition === "missed" || c.disposition === "voicemail")) && (
                              <Badge className="bg-red-100 text-red-800 hover:bg-red-100">Callback needed</Badge>
                            )}
                          </div>
                          <div className="mt-2 space-y-2">
                            {callEvents.slice(0, 4).map((call) => (
                              <div key={call.id} className="rounded-md bg-white/80 p-2 text-xs">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="font-medium">
                                    {call.disposition === "voicemail" ? "Voicemail" : call.disposition === "missed" ? "Missed call" : "Call"}
                                  </span>
                                  <span className="text-[10px] text-red-700">
                                    {call.callCompletedAt ? new Date(call.callCompletedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}
                                  </span>
                                </div>
                                <div className="mt-0.5 text-red-800">
                                  {formatPhone(call.guestPhone)}
                                  {call.voicemailDurationSeconds && ` · ${formatDuration(call.voicemailDurationSeconds)}`}
                                  {call.matchStrategy && ` · ${call.matchStrategy.replace(/-/g, " ")}`}
                                </div>
                                {call.voicemailRecordingUrl && (
                                  <audio
                                    controls
                                    src={call.voicemailRecordingUrl}
                                    className="mt-2 w-full"
                                    data-testid={`audio-sidebar-voicemail-${call.id}`}
                                  />
                                )}
                                {call.voicemailTranscript && (
                                  <div className="mt-2 rounded border border-red-100 bg-white p-2 text-red-950">
                                    {call.voicemailTranscript}
                                  </div>
                                )}
                                {!call.acknowledgedAt && (call.disposition === "missed" || call.disposition === "voicemail") && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="mt-2 h-7 px-2 text-[11px]"
                                    onClick={() => {
                                      setCallbackCall(call);
                                      setCallbackSummary("");
                                    }}
                                    disabled={completeCallback.isPending}
                                    data-testid={`button-sidebar-called-back-${call.id}`}
                                  >
                                    Called guest back
                                  </Button>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {internalNotes.length > 0 && (
                        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3" data-testid="panel-internal-notes">
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              <div className="text-sm font-semibold text-amber-950">Internal notes</div>
                              <div className="mt-1 text-xs text-amber-800">
                                Callback notes saved by agents.
                              </div>
                            </div>
                            <Badge className="bg-amber-100 text-amber-900 hover:bg-amber-100">
                              {internalNotes.length}
                            </Badge>
                          </div>
                          <div className="mt-2 space-y-2">
                            {internalNotes.slice(0, 4).map((note) => (
                              <div key={note.id} className="rounded-md bg-white/80 p-2 text-xs">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="font-medium text-amber-950">{note.createdBy || "agent"}</span>
                                  <span className="text-[10px] text-amber-700">
                                    {note.createdAt ? new Date(note.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}
                                  </span>
                                </div>
                                <div className="mt-1 whitespace-pre-wrap text-amber-900">{note.note}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Guest issues — operator + remote agents track & resolve */}
                      <GuestIssuesPanel
                        conversationId={selectedConvId ?? ""}
                        reservationId={reservationId ?? null}
                        guestName={guest?.fullName ?? (selectedConv as any)?.guestName ?? null}
                        listingId={listing?._id ?? null}
                        canDelete={isAdmin}
                      />

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
                      <div className="grid grid-cols-4 gap-3">
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
                        {/* Party size the guest entered on the channel — the
                            breakdown (adults/children) shows when the channel
                            sent it; VRBO/Airbnb usually do, Booking.com
                            sometimes only sends the total. */}
                        {(() => {
                          const party = guestPartyFromReservation(res);
                          const label = formatGuestParty(party);
                          // "4 guests (2 adults, 2 children)" → sub-line "2 adults, 2 children";
                          // a total-only label has no parens → no sub-line.
                          const breakdown = label && label.includes("(")
                            ? label.slice(label.indexOf("(") + 1, label.lastIndexOf(")"))
                            : null;
                          return (
                            <div>
                              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Guests</div>
                              <div className="mt-0.5 font-medium text-xs" title={label ?? undefined} data-testid="text-inbox-guest-party">
                                {party?.total ?? "—"}
                              </div>
                              {breakdown && (
                                <div className="text-[10px] text-muted-foreground leading-tight">{breakdown}</div>
                              )}
                            </div>
                          );
                        })()}
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
                      {!isAgent && (phase === "inquiry" || phase === "request") && guestGross > 0 && (
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
                        </div>
                      )}

                      {/* Buy-in estimate — INQUIRIES ONLY.
                          Shows the operator's expected cost to acquire
                          inventory for the guest's dates: per-unit nightly
                          rate × nights + flat per-unit cleaning fee. The
                          per-night line at the bottom AMORTIZES cleaning
                          across the stay so short stays surface as
                          unprofitable (a 4-night stay with $250×2 cleaning
                          adds $125/night vs ~$71/night on a 7-night stay).
                          Compare against `guestGross / nights` above to
                          decide whether the inquiry makes sense at the
                          quoted number or should be passed.
                          NOTE FOR CODEX: this is a STATIC-table estimate
                          (BUY_IN_RATES × season multiplier), NOT a live
                          /find-buy-in call. The full live search lives
                          at /api/operations/find-buy-in and is too slow
                          (~60s) and expensive (~$0.30/call) to fire on
                          every inquiry view. The static value is within
                          ~±20% of market — plenty for the is-this-worth-
                          it decision. See the matching note on the
                          `/api/inbox/buy-in-estimate` route. */}
                      {!isAgent && phase === "inquiry" && buyInEstimate && (
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1 flex items-center justify-between">
                            <span>Buy-in estimate</span>
                            {buyInEstimate.ok && (
                              <span className="text-muted-foreground/70 font-normal normal-case tracking-normal">
                                {buyInEstimate.season?.toLowerCase()} · {buyInEstimate.nights}n
                              </span>
                            )}
                          </div>
                          {buyInEstimate.ok ? (
                            <div className="border rounded-lg divide-y text-xs">
                              {buyInEstimate.units.map((u: any, i: number) => (
                                <div key={i} className="flex justify-between px-2.5 py-1.5">
                                  <span className="text-muted-foreground">
                                    {u.label} · {u.bedrooms}BR · {buyInEstimate.nights} × ${u.nightlyRate.toLocaleString()}
                                  </span>
                                  <span>${u.lineTotal.toLocaleString()}</span>
                                </div>
                              ))}
                              <div className="flex justify-between items-center px-2.5 py-1.5 gap-2">
                                <span className="text-muted-foreground flex items-center gap-1.5 min-w-0">
                                  Cleaning · $
                                  <input
                                    type="number"
                                    min={0}
                                    max={2000}
                                    step={25}
                                    value={estimateCleaningFee}
                                    onChange={e => setEstimateCleaningFee(Math.max(0, Math.min(2000, parseInt(e.target.value) || 0)))}
                                    className="w-12 h-5 px-1 text-xs text-right border rounded bg-background"
                                    title="Cleaning fee per unit per stay (saved across pages)"
                                    data-testid="input-estimate-cleaning-fee"
                                  />
                                  /unit × {buyInEstimate.unitCount}
                                </span>
                                <span>${buyInEstimate.cleaningTotal.toLocaleString()}</span>
                              </div>
                              <div className="flex justify-between px-2.5 py-2 bg-amber-50 dark:bg-amber-950/20 font-semibold">
                                <span className="text-amber-900">Total cost</span>
                                <span className="text-amber-900">${buyInEstimate.grandTotal.toLocaleString()}</span>
                              </div>
                              <div className="flex justify-between px-2.5 py-1.5 text-[11px] text-muted-foreground">
                                <span>Per night (cleaning amortized)</span>
                                <span>${buyInEstimate.perNightAmortized.toLocaleString()}</span>
                              </div>
                              {/* Profit-vs-cost hint: only when the
                                  Quoted rate is also visible above
                                  (guestGross > 0). Operator should be
                                  able to glance both and decide. */}
                              {guestGross > 0 && (
                                <div className={`flex justify-between px-2.5 py-1.5 text-[11px] font-medium ${
                                  guestGross > buyInEstimate.grandTotal ? "text-green-700" : "text-red-700"
                                }`}>
                                  <span>{guestGross > buyInEstimate.grandTotal ? "Margin" : "Loss"} vs quoted</span>
                                  <span>
                                    {guestGross > buyInEstimate.grandTotal ? "+" : "−"}$
                                    {Math.abs(guestGross - buyInEstimate.grandTotal).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                  </span>
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="text-[11px] text-muted-foreground italic px-2 py-1.5 border rounded-lg">
                              {buyInEstimate.reason ?? "Estimate not available"}
                            </div>
                          )}
                          <div className="text-[10px] text-muted-foreground/70 mt-1">
                            Static estimate from operator-validated rate table — within ~±20% of market.
                          </div>
                        </div>
                      )}
                      {!isAgent && phase === "inquiry" && !buyInEstimate && buyInEstimateLoading && (
                        <div className="text-[11px] text-muted-foreground italic">Loading buy-in estimate…</div>
                      )}

                      {/* Live buy-in search — INQUIRIES ONLY.
                          The LIVE counterpart to the static estimate above: one
                          click runs the EXACT same search the Operations tab runs on
                          "Auto-fill cheapest" — the full escalation ladder driving
                          the local Chrome sidecar, finding the cheapest
                          same-community combos. It attaches NOTHING (dry-run); it
                          just shows the operator the real market options for the
                          guest's dates so they can decide whether to take the
                          inquiry. Runs server-side + survives leaving the tab; the
                          search can take 1–several minutes. */}
                      {!isAgent && phase === "inquiry" && selectedConvId && estimateListingId && estimateCheckIn && estimateCheckOut && (
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">
                            Live buy-in search
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            className="w-full h-8 text-xs"
                            disabled={buyInSearchRunning}
                            onClick={() => startBuyInSearch.mutate({
                              convId: selectedConvId,
                              listingId: String(estimateListingId),
                              checkIn: String(estimateCheckIn),
                              checkOut: String(estimateCheckOut),
                            })}
                            data-testid="button-inbox-buy-in-search"
                          >
                            {buyInSearchRunning ? (
                              <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Searching live market…</>
                            ) : (
                              <><Search className="h-3.5 w-3.5 mr-1.5" /> {buyInSearchStatus ? "Search again" : "Do buy-in search"}</>
                            )}
                          </Button>
                          {(buyInSearchStatus || startBuyInSearch.isPending) && (
                            <div className="mt-2">
                              <InboxBuyInSearchResults
                                status={buyInSearchStatus ?? { done: false, message: "Starting search…", progress: 4, attached: [], comboOptions: [], cityEconomics: [], skipped: [] }}
                              />
                            </div>
                          )}
                          <div className="text-[10px] text-muted-foreground/70 mt-1">
                            Same sidecar search as Operations “Auto-fill cheapest” — finds the cheapest same-community combos. Nothing is attached.
                          </div>
                        </div>
                      )}

                      {/* Financials — only for booked reservations */}
                      {!isAgent && phase === "booked" && (
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

                      {!isAgent && reservationId && (phase === "booked" || phase === "request") && (
                        <InboxBuyInPanel
                          reservationId={reservationId}
                          guestName={guest.fullName ?? selectedConv.displayGuestName ?? ""}
                          data={buyInComms}
                        />
                      )}

                      {/* Templates — manual on-demand outbound message
                          timeline for booked/request reservations. */}
                      {(phase === "booked" || phase === "request") && res?._id && (
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">
                            Templates
                          </div>
                          {(() => {
                            const fullName = guest.fullName ?? selectedConv.displayGuestName ?? "";
                            const firstName = String(fullName).trim().split(/\s+/)[0] ?? "";
                            const propertyName = listing.title ?? listing.nickname ?? "";
                            const checkInIso = res?.checkInDateLocalized ?? res?.checkIn;
                            const checkOutIso = res?.checkOutDateLocalized ?? res?.checkOut;
                            const checkInDate = parseStayDate(checkInIso);
                            const checkOutDate = parseStayDate(checkOutIso);
                            const bookingDate = parseStayDate(res?.confirmedAt ?? res?.createdAt ?? selectedConv.lastMessageAt);
                            const needsAgreement = /vrbo|homeaway|booking/i.test(channelRaw);
                            const outboundTemplateBodies = threadPosts
                              .map((p: any) => ({
                                body: cleanMessageBody(p.body ?? p.text ?? p.message ?? ""),
                                host: isHostPost(p),
                                system: isGuestySystemPost(p),
                              }))
                              .filter(({ body, host, system }: { body: string; host: boolean; system: boolean }) =>
                                body.trim().length > 0 && !system && (host || isSignedHostTemplateBody(body))
                              )
                              .map(({ body }: { body: string }) => body);
                            const wasSent = (pattern: RegExp) => outboundTemplateBodies.some((body: string) => pattern.test(body));
                            const totalPriceFromMoney = asNum(m.totalPrice) || guestGross || 0;
                            const totalPaidFromMoney = asNum(m.totalPaid);
                            const openReceiptDialog = () => {
                              const today = new Date();
                              const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
                              setReceiptDialog({
                                open: true,
                                reservationId: res._id,
                                propertyName,
                                guestFirstName: firstName,
                                guestFullName: fullName || undefined,
                                // Localized calendar date (matches the panel),
                                // NOT raw res.checkIn which slices a day off in
                                // Hawaii/negative-offset timezones.
                                checkInIso: checkInIso || undefined,
                                checkOutIso: checkOutIso || undefined,
                                confirmationCode: res?.confirmationCode || undefined,
                                channel: (selectedConv as any)?.module?.type || channelRaw || undefined,
                                conversationId: selectedConvId || undefined,
                              });
                              setReceiptTotalPrice(totalPriceFromMoney > 0 ? totalPriceFromMoney.toFixed(2) : "");
                              setReceiptPastPayments([]);
                              setReceiptPaymentsLoading(true);
                              setReceiptPaymentAmount("");
                              setReceiptPaymentDate(todayIso);
                              setReceiptBody("");
                              setReceiptBodyTouched(false);
                              setReceiptPageUrl("");
                              setReceiptPageError("");
                              apiRequest("GET", `/api/inbox/reservations/${res._id}/payments`)
                                .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
                                .then((data: any) => {
                                  const rows = (data?.payments ?? []).map((p: any) => ({
                                    id: newReceiptRowId(),
                                    date: String(p.date ?? "").slice(0, 10),
                                    amount: typeof p.amount === "number" ? p.amount.toFixed(2) : String(p.amount ?? ""),
                                  }));
                                  setReceiptPastPayments(rows);
                                })
                                .catch(() => { /* leave list empty; operator can add manually */ })
                                .finally(() => setReceiptPaymentsLoading(false));
                            };
                            const draftCommon = {
                              guestName: fullName,
                              guestFirstName: firstName,
                              guestEmail: guest.email ?? res?.guest?.email ?? null,
                              guestPhone: effectiveGuestPhone || null,
                              channelRaw,
                              propertyName,
                              checkInIso,
                              checkOutIso,
                              confirmationCode: res?.confirmationCode,
                              numNights: nights ?? res?.nightsCount ?? null,
                              bookingTotal: totalPriceFromMoney,
                              totalPaid: totalPaidFromMoney,
                              cancellationPolicy: findCancellationPolicyValue(res),
                            };
                            const timeline = [
                              {
                                title: "Booking confirmation / next steps",
                                due: null as Date | null,
                                dueLabel: "At booking",
                                sent: outboundTemplateBodies.length > 0,
                                detail: totalPriceFromMoney > 0 ? `Total ${formatMoney(totalPriceFromMoney)}` : "Confirm dates and payment",
                                testId: "button-draft-booking-confirmation",
                                onClick: () => draftStayTemplate({ title: "Booking confirmation / next steps", kind: "booking", ...draftCommon }),
                              },
                              ...(needsAgreement ? [{
                                title: "Agreement + card authorization",
                                due: bookingDate,
                                dueLabel: "After booking",
                                sent: rentalAgreement?.agreement?.status === "signed" || wasSent(/\/agreement\/|rental agreement|signed terms|complete it here|two-separate-units|two separate units acknowledgment|card authorization/i),
                                detail: rentalAgreement?.agreement?.status === "signed" ? "Signed internal agreement" : "Internal agreement · two-unit acknowledgment",
                                testId: "button-draft-agreement-request",
                                onClick: () => draftStayTemplate({ title: "Agreement + card authorization", kind: "agreement-request", ...draftCommon }),
                                smsTestId: "button-draft-sms-agreement-request",
                                smsOnClick: () => draftStayTemplate({ title: "SMS: rental agreement", channel: "sms", kind: "agreement-request", ...draftCommon }),
                              },
                              {
                                title: "Guesty invoice / payment method",
                                due: bookingDate,
                                dueLabel: "After booking",
                                sent: wasSent(/guest invoice|secure guesty invoice|payment method|remaining balance|guest_invoice|credit card details/i),
                                detail: "Guesty invoice/payment link",
                                testId: "button-draft-guesty-invoice-payment",
                                onClick: () => draftStayTemplate({ title: "Guesty invoice / payment method", kind: "guesty-invoice-payment", ...draftCommon }),
                                smsTestId: "button-draft-sms-payment-link",
                                smsOnClick: () => draftStayTemplate({ title: "SMS: secure payment link", channel: "sms", kind: "guesty-invoice-payment", ...draftCommon }),
                              }] : []),
                              {
                                title: "Unit setup confirmation",
                                due: bookingDate ? addDays(bookingDate, 1) : null,
                                dueLabel: "1 day after booking",
                                sent: wasSent(/two nearby units|representative of the resort\/community|representative of the resort|unit style|assigned units will match/i),
                                detail: "Confirms nearby units and sample photos",
                                testId: "button-draft-representative-follow-up",
                                onClick: () => draftStayTemplate({ title: "Unit setup confirmation", kind: "representative-follow-up", ...draftCommon }),
                                smsTestId: "button-draft-sms-unit-setup",
                                smsOnClick: () => draftStayTemplate({ title: "SMS: unit setup note", channel: "sms", kind: "representative-follow-up", ...draftCommon }),
                              },
                              {
                                title: "ID verification (selfie + license)",
                                due: checkInDate ? addDays(checkInDate, -16) : null,
                                dueLabel: "Before arrival details go out",
                                sent: wasSent(/driver'?s license|selfie|security verification/i),
                                detail: "Selfie with driver's license — required to release arrival details",
                                testId: "button-draft-id-verification",
                                onClick: () => draftStayTemplate({ title: "ID verification (selfie + license)", kind: "id-verification", ...draftCommon }),
                                smsTestId: "button-draft-sms-id-verification",
                                smsOnClick: () => draftStayTemplate({ title: "SMS: ID verification request", channel: "sms", kind: "id-verification", ...draftCommon }),
                              },
                              {
                                title: "14-day arrival details",
                                due: checkInDate ? addDays(checkInDate, -14) : null,
                                dueLabel: "14 days before arrival",
                                // NOT a vocabulary regex — the automated booking confirmation
                                // PROMISES "your full arrival details ... door and lockbox codes"
                                // and used to false-mark this step sent. The shared matcher keys
                                // on actual detail lines (Access code: / Unit N:) instead; the
                                // dashboard arrival-details coverage warning uses the same one.
                                sent: outboundTemplateBodies.some((body: string) => looksLikeArrivalDetailsMessage(body)),
                                detail: `${arrivalDetails?.units?.length ?? 0} attached unit${(arrivalDetails?.units?.length ?? 0) === 1 ? "" : "s"}`,
                                testId: "button-draft-arrival-details",
                                disabled: arrivalDetailsLoading,
                                onClick: () => draftArrivalDetails({ title: "14-day arrival details", guestFirstName: firstName, propertyName, checkInIso }),
                                smsTestId: "button-draft-sms-arrival-details",
                                smsOnClick: () => draftArrivalDetails({ title: "SMS: arrival details reminder", channel: "sms", guestFirstName: firstName, propertyName, checkInIso }),
                              },
                              {
                                title: "Parking + travel reminder",
                                due: checkInDate ? addDays(checkInDate, -3) : null,
                                dueLabel: "3 days before arrival",
                                sent: wasSent(/local area|restaurant|restaurants|parking notes|few days away/i),
                                detail: "Restaurants, travel day, parking",
                                testId: "button-draft-local-tips",
                                onClick: () => draftStayTemplate({ title: "Parking + travel reminder", kind: "local-tips", ...draftCommon }),
                                smsTestId: "button-draft-sms-local-tips",
                                smsOnClick: () => draftStayTemplate({ title: "SMS: parking + travel reminder", channel: "sms", kind: "local-tips", ...draftCommon }),
                              },
                              {
                                title: "Day-before final check-in reminder",
                                due: checkInDate ? addDays(checkInDate, -1) : null,
                                dueLabel: "1 day before arrival",
                                sent: wasSent(/check-in.+tomorrow|tomorrow.+check-in|safe travels/i),
                                detail: "Final access and parking reminder",
                                testId: "button-draft-day-before-checkin",
                                onClick: () => draftStayTemplate({ title: "Day-before final check-in reminder", kind: "day-before", ...draftCommon }),
                                smsTestId: "button-draft-sms-day-before",
                                smsOnClick: () => draftStayTemplate({ title: "SMS: day-before arrival nudge", channel: "sms", kind: "day-before", ...draftCommon }),
                              },
                              {
                                title: "Post-stay thank-you / review request",
                                due: checkOutDate ? addDays(checkOutDate, 2) : null,
                                dueLabel: "2 days after checkout",
                                sent: wasSent(/thank you again for staying|appreciate a review|review request/i),
                                detail: "Review and repeat guest note",
                                testId: "button-draft-post-stay-review",
                                onClick: () => draftStayTemplate({ title: "Post-stay thank-you / review request", kind: "post-stay", ...draftCommon }),
                                smsTestId: "button-draft-sms-post-stay-review",
                                smsOnClick: () => draftStayTemplate({ title: "SMS: post-stay review request", channel: "sms", kind: "post-stay", ...draftCommon }),
                              },
                            ];
                            const visibleTimeline = isAgent
                              ? timeline.filter((item) =>
                                  /arrival|parking|travel|day-before|unit setup|id verification|post-stay/i.test(item.title)
                                )
                              : timeline;
                            return (
                              <div className="space-y-1.5">
                                {visibleTimeline.map((item) => (
                                  <div key={item.title} className="border rounded-lg p-2.5 text-xs bg-muted/20">
                                    <div className="flex flex-col gap-2">
                                      <div className="min-w-0">
                                        <p className="font-medium flex items-start gap-1.5 leading-snug">
                                          {item.sent ? <CheckCircle className="h-3 w-3 text-green-600 shrink-0" /> : <Clock className="h-3 w-3 text-amber-600 shrink-0" />}
                                          <span className="break-words">{item.title}</span>
                                        </p>
                                        <p className="text-[11px] text-muted-foreground">
                                          Due {formatShortDate(item.due, item.dueLabel)}
                                          {" · "}
                                          {item.sent ? "Completed" : item.detail}
                                        </p>
                                      </div>
                                      <div className="flex items-center gap-1.5">
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          className="h-7 flex-1 px-2 text-[11px]"
                                          disabled={Boolean(item.disabled)}
                                          onClick={item.onClick}
                                          data-testid={item.testId}
                                        >
                                          <FileText className="h-3 w-3 mr-1" />
                                          Guesty
                                        </Button>
                                        {item.smsOnClick && (
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            className="h-7 flex-1 px-2 text-[11px]"
                                            disabled={Boolean(item.disabled) || Boolean(smsDisabledReason)}
                                            onClick={item.smsOnClick}
                                            title={smsDisabledReason ?? `Draft text for ${effectiveGuestPhone}`}
                                            data-testid={item.smsTestId}
                                          >
                                            <MessageCircle className="h-3 w-3 mr-1" />
                                            Text
                                          </Button>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                ))}
                                {!isAgent && (
                                  <>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-8 px-2.5 text-[11px] w-full justify-start"
                                      onClick={openReceiptDialog}
                                      data-testid="button-send-receipt"
                                    >
                                      <DollarSign className="h-3 w-3 mr-1.5" /> Open detailed payment receipt
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-8 px-2.5 text-[11px] w-full justify-start text-cyan-700 border-cyan-300 hover:bg-cyan-50 hover:text-cyan-800"
                                      onClick={openReceiptDialog}
                                      data-testid="button-generate-receipt-page"
                                    >
                                      <Link2 className="h-3 w-3 mr-1.5" /> Generate payment details page URL
                                    </Button>
                                  </>
                                )}
                              </div>
                            );
                          })()}
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
                          : "Paused — new Airbnb requests will not be auto-approved"}
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
                  Templates are sent automatically based on reservation events. Use merge tags like <code className="text-xs bg-muted px-1 rounded">{"{guest_name}"}</code> for personalization. <code className="text-xs bg-muted px-1 rounded">{"{greeting}"}</code> and <code className="text-xs bg-muted px-1 rounded">{"{signoff}"}</code> adapt to the property: <em>Aloha…/Mahalo</em> for Hawaii stays and <em>Hi…/Thanks</em> for mainland (Florida) stays.
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
                          <div className="flex flex-wrap gap-1 mt-0.5">
                            <Badge variant={templateChannelBadgeVariant(t.deliveryChannel)} className="text-[10px]">
                              {templateChannelLabel(t.deliveryChannel)}
                            </Badge>
                            <Badge variant="outline" className="text-[10px]">
                              <Clock className="h-2.5 w-2.5 mr-1" />
                              {triggerLabel(t.trigger, t.daysOffset)}
                            </Badge>
                          </div>
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

      <Dialog open={templatePreview.open} onOpenChange={(open) => setTemplatePreview((prev) => ({ ...prev, open }))}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{templatePreview.title || "Template preview"}</DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant={templateChannelBadgeVariant(templatePreview.channel)}>
              {templateChannelLabel(templatePreview.channel)}
            </Badge>
            <span>
              {templatePreview.channel === "sms"
                ? "Short draft intended for the Text button."
                : "Formal draft intended for Guesty/OTA/email messaging."}
            </span>
          </div>
          <Textarea
            value={templatePreview.body}
            readOnly
            rows={16}
            className="font-mono text-sm leading-relaxed"
            data-testid="textarea-template-preview"
          />
          {/\{\{guest_invoice\}\}/i.test(templatePreview.body) && (
            <p className="text-[11px] text-muted-foreground border rounded-md bg-muted/40 px-2.5 py-2">
              Guesty note: the invoice/payment variable requires Guesty invoice/payment processing to be configured for this reservation. If the channel does not expand the variable, send the invoice from Guesty and keep this inbox message as the audit-trail request.
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setTemplatePreview({ open: false, title: "", body: "", channel: "guesty" })}
              data-testid="button-template-preview-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                setReplyText(templatePreview.body);
                setTemplatePreview({ open: false, title: "", body: "", channel: "guesty" });
                toast({
                  title: "Draft loaded",
                  description: templatePreview.channel === "sms"
                    ? "Review in the composer, then use Send Text."
                    : "Review in the composer, then send in Guesty.",
                });
              }}
              disabled={!templatePreview.body.trim()}
              data-testid="button-template-preview-use"
            >
              <FileText className="h-3 w-3 mr-1" /> Use in Composer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!callbackCall} onOpenChange={(open) => {
        if (!open) {
          setCallbackCall(null);
          setCallbackSummary("");
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Complete guest callback</DialogTitle>
            <DialogDescription>
              Save what the guest said. This clears the missed-call notification and stores an internal note on the Guest Inbox thread.
            </DialogDescription>
          </DialogHeader>
          {callbackCall && (
            <div className="space-y-3">
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                <div className="font-medium">{callbackCall.guestName || "Unknown caller"}</div>
                <div className="text-muted-foreground">
                  {formatPhone(callbackCall.guestPhone)}
                  {callbackCall.callCompletedAt && ` · ${new Date(callbackCall.callCompletedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`}
                </div>
              </div>
              <div>
                <Label htmlFor="inbox-callback-summary">Said</Label>
                <Textarea
                  id="inbox-callback-summary"
                  className="mt-1 min-h-[110px]"
                  value={callbackSummary}
                  onChange={(event) => setCallbackSummary(event.target.value)}
                  placeholder="Example: Guest confirmed arrival time and said they found the check-in email."
                  data-testid="textarea-inbox-callback-summary"
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCallbackCall(null)} disabled={completeCallback.isPending}>
                  Cancel
                </Button>
                <Button
                  onClick={() => completeCallback.mutate()}
                  disabled={completeCallback.isPending || callbackSummary.trim().length < 2}
                  data-testid="button-inbox-save-callback"
                >
                  {completeCallback.isPending && <RefreshCw className="mr-2 h-4 w-4 animate-spin" />}
                  Save callback
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Payment-receipt dialog. Pre-populated from Guesty's reservation
          money fields — booking total + paid-to-date — and asks the
          operator for the amount/date of the payment they just took.
          The body live-renders in the textarea until the operator types
          into it (then their edits stick). Sends through the same Guesty
          /communication/conversations/:id/send-message proxy as the
          inline reply composer. */}
      <Dialog
        open={receiptDialog.open}
        onOpenChange={(open) => {
          if (!open) resetReceiptState();
        }}
      >
        <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Payment receipt &amp; details page
              {receiptDialog.guestFirstName ? ` · ${receiptDialog.guestFirstName}` : ""}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            {receiptPageUrl ? (
              <div className="rounded-lg border border-cyan-300 bg-cyan-50 p-3" data-testid="receipt-page-ready">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-cyan-800">
                  <CheckCircle className="h-3.5 w-3.5" /> Payment details page ready
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Input
                    readOnly
                    value={receiptPageUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    className="h-8 font-mono text-[11px]"
                    data-testid="input-receipt-page-url"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 shrink-0"
                    onClick={() => {
                      navigator.clipboard?.writeText(receiptPageUrl)
                        .then(() => toast({ title: "Link copied" }))
                        .catch(() => toast({ title: "Couldn't copy — select the link manually", variant: "destructive" }));
                    }}
                    data-testid="button-copy-receipt-page"
                  >
                    <Copy className="h-3 w-3 mr-1" /> Copy
                  </Button>
                  <a
                    href={`${receiptPageUrl}?preview=1`}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 inline-flex items-center gap-1 text-[11px] text-cyan-700 hover:underline"
                    data-testid="link-open-receipt-page"
                  >
                    Open <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                <p className="mt-1.5 text-[10px] text-muted-foreground">
                  The link is woven into the message below — “Send receipt” delivers it to the guest, or share the URL yourself. Opening it here (preview) is not counted as a guest view.
                </p>
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Generate a durable, printable payment-details page (and/or send it as a message). Leave the amount blank for a statement of what the guest has paid so far, or enter a new charge you just ran. The page pulls the real paid-to-date from Guesty.
              </p>
            )}
            {receiptPageError ? (
              <p className="text-[11px] text-red-600" data-testid="receipt-page-error">{receiptPageError}</p>
            ) : null}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="receipt-payment-amount">Payment amount (USD)</Label>
                <Input
                  id="receipt-payment-amount"
                  type="number"
                  min={0}
                  step="0.01"
                  value={receiptPaymentAmount}
                  onChange={(e) => setReceiptPaymentAmount(e.target.value)}
                  placeholder="200.00"
                  data-testid="input-receipt-payment-amount"
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  A new charge you just ran — or leave blank to use the latest payment on file.
                </p>
              </div>
              <div>
                <Label htmlFor="receipt-payment-date">Payment date</Label>
                <Input
                  id="receipt-payment-date"
                  type="date"
                  value={receiptPaymentDate}
                  onChange={(e) => setReceiptPaymentDate(e.target.value)}
                  data-testid="input-receipt-payment-date"
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Defaults to today.
                </p>
              </div>
            </div>
            <div>
              <Label htmlFor="receipt-total-price">Booking total (USD)</Label>
              <Input
                id="receipt-total-price"
                type="number"
                min={0}
                step="0.01"
                value={receiptTotalPrice}
                onChange={(e) => setReceiptTotalPrice(e.target.value)}
                placeholder="1500.00"
                className="max-w-xs"
                data-testid="input-receipt-total-price"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Pre-filled from Guesty.
              </p>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label>Previous payments</Label>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[11px]"
                  onClick={() =>
                    setReceiptPastPayments((rows) => [
                      ...rows,
                      { id: newReceiptRowId(), date: "", amount: "" },
                    ])
                  }
                  data-testid="button-receipt-add-payment"
                >
                  <Plus className="h-3 w-3 mr-1" /> Add payment
                </Button>
              </div>
              {receiptPaymentsLoading ? (
                <p className="text-[11px] text-muted-foreground italic">
                  Loading payment history from Guesty…
                </p>
              ) : receiptPastPayments.length === 0 ? (
                <p className="text-[11px] text-muted-foreground italic">
                  No previous payments on file. Today's charge below will be the only line item — add rows here if you took earlier payments outside Guesty.
                </p>
              ) : (
                <div className="space-y-2">
                  {receiptPastPayments.map((row) => (
                    <div key={row.id} className="flex items-center gap-2">
                      <Input
                        type="date"
                        value={row.date}
                        onChange={(e) =>
                          setReceiptPastPayments((rows) =>
                            rows.map((r) => (r.id === row.id ? { ...r, date: e.target.value } : r)),
                          )
                        }
                        className="w-44"
                        data-testid={`input-receipt-past-date-${row.id}`}
                      />
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        value={row.amount}
                        onChange={(e) =>
                          setReceiptPastPayments((rows) =>
                            rows.map((r) => (r.id === row.id ? { ...r, amount: e.target.value } : r)),
                          )
                        }
                        placeholder="amount"
                        className="flex-1"
                        data-testid={`input-receipt-past-amount-${row.id}`}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-9 w-9 p-0 shrink-0"
                        onClick={() =>
                          setReceiptPastPayments((rows) => rows.filter((r) => r.id !== row.id))
                        }
                        data-testid={`button-receipt-remove-payment-${row.id}`}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <Label htmlFor="receipt-body">Message preview</Label>
              <Textarea
                id="receipt-body"
                value={receiptBody}
                onChange={(e) => {
                  setReceiptBody(e.target.value);
                  setReceiptBodyTouched(true);
                }}
                rows={14}
                className="font-mono text-xs"
                data-testid="textarea-receipt-body"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                {receiptBodyTouched
                  ? "You've edited the message — it won't auto-update from the fields above anymore."
                  : "The message regenerates as you change the fields above. Edit the textarea to override."}
              </p>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={resetReceiptState}
              data-testid="button-receipt-cancel"
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              className="text-cyan-700 border-cyan-300 hover:bg-cyan-50 hover:text-cyan-800"
              onClick={() => generateReceiptPage.mutate()}
              disabled={generateReceiptPage.isPending}
              title="Generates a payment-details page showing the guest's real paid-to-date from Guesty. Enter an amount only to record a new charge."
              data-testid="button-generate-receipt-page-link"
            >
              {generateReceiptPage.isPending ? (
                <>
                  <RefreshCw className="h-3 w-3 mr-1 animate-spin" /> Generating…
                </>
              ) : (
                <>
                  <Link2 className="h-3 w-3 mr-1" /> {receiptPageUrl ? "Regenerate page link" : "Generate page link"}
                </>
              )}
            </Button>
            <Button
              onClick={() => {
                const amt = parseFloat(receiptPaymentAmount);
                if (!Number.isFinite(amt) || amt <= 0) {
                  toast({ title: "Enter a payment amount greater than 0", variant: "destructive" });
                  return;
                }
                if (!receiptBody.trim()) {
                  toast({ title: "Receipt message is empty", variant: "destructive" });
                  return;
                }
                sendReceipt.mutate();
              }}
              disabled={sendReceipt.isPending || !receiptPaymentAmount || !receiptBody.trim()}
              data-testid="button-receipt-send"
            >
              {sendReceipt.isPending ? (
                <>
                  <RefreshCw className="h-3 w-3 mr-1 animate-spin" /> Sending…
                </>
              ) : (
                <>
                  <Send className="h-3 w-3 mr-1" /> Send receipt
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
