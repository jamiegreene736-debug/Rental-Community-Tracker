import { isBookingChannel } from "./receipt-message";

// OTA channel module/integration types Guesty exposes that require async,
// externalId-confirmed delivery — a bare Guesty POST 200 is NOT proof the guest
// received it (AGENTS.md #51). The big three (Airbnb / VRBO-HomeAway /
// Booking.com) are the operator's live channels; the rest are other OTAs Guesty
// can relay onto the SAME conversation API. Any module type matching one of these
// tokens is delivery-verified on outbound instead of silently trusting the bare
// 200 (the false-green this list previously left open for EVERY non-big-3 OTA).
// email / sms / whatsapp / manual / direct are deliberately ABSENT — they have no
// async OTA portal to confirm against, so their accepted POST IS the delivery.
const OTA_CHANNEL_TOKENS = [
  "booking",          // bookingCom, bookingCom2
  "airbnb",           // airbnb, airbnb2
  "homeaway", "vrbo", // VRBO / HomeAway (homeaway, homeaway2)
  "expedia",
  "google",           // Google Vacation Rentals
  "marriott", "homesandvillas", "homes_and_villas", "hvmi", // Marriott Homes & Villas
  "hopper",
  "despegar",
  "tripadvisor", "holidu",
  "agoda",
];

export function guestyModuleTypeLooksOta(type: string): boolean {
  const t = String(type ?? "").toLowerCase();
  return OTA_CHANNEL_TOKENS.some((token) => t.includes(token));
}

export function parseGuestyConversationModule(mod: unknown): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  if (mod && typeof mod === "object") {
    for (const key of ["type", "channelId"] as const) {
      const val = (mod as Record<string, unknown>)[key];
      if (val !== undefined && val !== null && val !== "") clean[key] = val;
    }
  }
  if (!clean.type) clean.type = "email";
  return clean;
}

/** Guesty POST /send-message accepts only `type` (+ optional `channelId`). */
export function guestySendMessageModule(mod: Record<string, unknown>): Record<string, unknown> {
  const parsed = parseGuestyConversationModule(mod);
  const out: Record<string, unknown> = { type: parsed.type ?? "email" };
  if (parsed.channelId !== undefined) out.channelId = parsed.channelId;
  return out;
}

export function guestyChannelLabel(module: Record<string, unknown>): string {
  const t = String(module.type ?? "email").toLowerCase();
  if (t.includes("booking")) return "Booking.com";
  if (t.includes("airbnb")) return "Airbnb";
  if (t.includes("homeaway") || t.includes("vrbo")) return "VRBO";
  if (t.includes("expedia")) return "Expedia";
  if (t.includes("google")) return "Google";
  if (t.includes("marriott") || t.includes("homesandvillas") || t.includes("homes_and_villas") || t.includes("hvmi")) return "Marriott Homes & Villas";
  if (t.includes("hopper")) return "Hopper";
  if (t.includes("despegar")) return "Despegar";
  if (t.includes("agoda")) return "Agoda";
  if (t === "email") return "email";
  return String(module.type ?? "unknown");
}

/** Prefer reservation.integration.platform (e.g. bookingCom2) over coarse UI hints. */
export function otaModuleTypeFromReservation(
  reservation: { integration?: { platform?: string | null } | null; source?: string | null } | null | undefined,
  channelHint?: string | null,
): string | null {
  const platform = String(reservation?.integration?.platform ?? "").trim();
  if (platform && guestyModuleTypeLooksOta(platform.toLowerCase())) return platform;
  if (platform && platform.toLowerCase() !== "email") return platform;

  const hint = String(channelHint ?? "").toLowerCase();
  if (hint.includes("booking")) return "bookingCom";
  if (hint.includes("airbnb")) return "airbnb2";
  if (hint.includes("vrbo") || hint.includes("homeaway")) return "homeaway";

  const sourceText = String(reservation?.source ?? "").toLowerCase();
  if (/booking\.?com/.test(sourceText)) return "bookingCom";
  if (/airbnb/.test(sourceText)) return "airbnb2";
  if (/vrbo|homeaway/.test(sourceText)) return "homeaway";
  // Expedia is its OWN channel — do NOT fold it into homeaway (that misrouted an
  // Expedia reply onto the VRBO module). Return its own platform; if Guesty
  // rejects the send type, the attempt ladder falls back to the conversation-
  // derived module (send-once advances only on a POST rejection).
  if (/expedia/.test(sourceText)) return "expedia";
  return null;
}

export function mergeOtaModuleFromReservation(
  module: Record<string, unknown>,
  reservation: { integration?: { platform?: string | null } | null; source?: string | null } | null | undefined,
  channelHint?: string | null,
): Record<string, unknown> {
  const currentType = String(module.type ?? "").toLowerCase();
  if (guestyModuleTypeLooksOta(currentType) && currentType !== "email") {
    return parseGuestyConversationModule(module);
  }
  const otaType = otaModuleTypeFromReservation(reservation, channelHint);
  if (!otaType) return parseGuestyConversationModule(module);
  return parseGuestyConversationModule({ ...module, type: otaType });
}

export function otaChannelRequested(module: Record<string, unknown>, channelHint?: string | null): boolean {
  if (guestyModuleTypeLooksOta(String(module.type ?? ""))) return true;
  const hint = String(channelHint ?? "").toLowerCase();
  return /airbnb|booking|vrbo|homeaway/.test(hint);
}

export function bookingSendTypeVariants(
  reservation: { integration?: { platform?: string | null } | null; source?: string | null } | null | undefined,
  channelHint?: string | null,
): string[] {
  const out: string[] = [];
  const add = (t: string) => {
    const key = t.trim();
    if (key && !out.includes(key)) out.push(key);
  };
  const platform = otaModuleTypeFromReservation(reservation, null);
  if (platform) add(platform);
  if (isBookingChannel(channelHint) || isBookingChannel(platform)) {
    for (const t of ["bookingCom2", "bookingCom", "booking_com"]) add(t);
  }
  return out;
}

export function buildOtaSendModuleAttempts(
  resolvedModule: Record<string, unknown>,
  reservation: { integration?: { platform?: string | null } | null; source?: string | null } | null | undefined,
  channelHint?: string | null,
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const attempts: Record<string, unknown>[] = [];
  const addRaw = (mod: Record<string, unknown>) => {
    const sendMod = guestySendMessageModule(mod);
    const key = JSON.stringify(sendMod);
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push(sendMod);
  };

  // Proven auto-receipt path: integration.platform type-only first (preserves bookingCom2).
  for (const type of bookingSendTypeVariants(reservation, channelHint)) {
    addRaw({ type });
  }

  // Conversation/post-derived module (may include channelId).
  addRaw(resolvedModule);

  const resolvedType = String(resolvedModule.type ?? "").trim();
  if (resolvedType && guestyModuleTypeLooksOta(resolvedType)) {
    addRaw({ type: resolvedType });
  }

  return attempts;
}

export function postBodyText(post: { body?: unknown; text?: unknown; message?: unknown } | null | undefined): string {
  return String(post?.body ?? post?.text ?? post?.message ?? "").trim();
}

export function postTimestamp(post: Record<string, unknown>): number {
  const raw = post.sentAt ?? post.postedAt ?? post.createdAt;
  const t = new Date(String(raw ?? 0)).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function isHostConversationPost(post: Record<string, unknown>): boolean {
  return post?.authorType === "host"
    || post?.authorRole === "host"
    || post?.senderType === "host"
    || post?.sentBy === "host"
    || post?.direction === "outbound"
    || post?.direction === "out"
    || post?.direction === "outgoing"
    || post?.isIncoming === false;
}

// STRICT, edit-SENSITIVE body equality — used to confirm that a delivered post
// is THIS exact message, not a stale earlier copy. The arrival greeting +
// signature are byte-identical across edits, so a lenient head/tail match would
// treat a corrected resend (e.g. a fixed access code) as "already delivered"
// against the OLD copy and show a false green confirm with the wrong details.
// Collapse whitespace (tolerates the channel trimming blank lines — the live
// synced copy was 1793 vs our 1801 chars) but stay sensitive to any real content
// change.
export function bodiesAreDuplicate(a: string, b: string): boolean {
  const norm = (s: string) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  // Tolerate the channel dropping a trailing footer/signature only (>=95% prefix).
  return long.startsWith(short) && short.length / long.length >= 0.95;
}

/**
 * Real OTA delivery signal. Guesty's POST /send-message creates a LOCAL outbound
 * post IMMEDIATELY with `status:"pending"` and no `module.externalId` — that is
 * NOT proof the OTA (Booking.com/Airbnb/VRBO) accepted it. The message only
 * reaches the guest's portal once Guesty stamps the channel's message id
 * (`module.externalId`) and/or flips the post to a delivered status
 * (`completed`/`sent`/`delivered`). A post that stays `pending` with no
 * externalId is queued, never delivered. (Verified live 2026-06-20: 4 stuck
 * `pending` Booking.com arrival messages with no externalId vs. older
 * `completed`+externalId ones — see AGENTS.md.)
 */
export function postDeliveryState(post: Record<string, unknown>): "delivered" | "pending" | "failed" {
  const mod = (post.module as Record<string, unknown> | undefined) ?? {};
  const externalId = mod.externalId;
  const status = String(post.status ?? post.deliveryStatus ?? "").toLowerCase();
  if (status === "failed" || status === "error" || status === "rejected" || status === "bounced") return "failed";
  if (externalId !== undefined && externalId !== null && externalId !== "") return "delivered";
  if (["completed", "sent", "delivered", "success", "ok"].includes(status)) return "delivered";
  return "pending";
}

/**
 * Collapse a `sendGuestyConversationMessage` result into the single action a
 * BACKGROUND sender (auto-reply auto-send, booking confirmations, guest
 * receipts) should take:
 *
 *   - `delivered`   → the channel confirmed delivery (module.externalId /
 *                     completed). Record it as sent.
 *   - `misroute`    → a HARD non-delivery: Guesty filed our message off the
 *                     guest's OTA channel (e.g. on email), so the guest never
 *                     got it on the channel they booked with. Do NOT record it
 *                     as sent. (`pending === false` is the explicit misroute
 *                     signal from verifyOtaHostPostDelivered.)
 *   - `unconfirmed` → posted to the OTA channel but not confirmed within the
 *                     verify window. The message WAS posted exactly once, so the
 *                     caller must record it terminally to avoid a duplicate
 *                     re-send on the next tick — but never as a clean delivery.
 *
 * Note `pending` is only a misroute when EXPLICITLY false. A missing/undefined
 * `pending` (verified false, pending not set) is treated as `unconfirmed`, never
 * a hard misroute — we never suppress a record or flag a thread on an ambiguous
 * verdict.
 */
export function deliveryOutcome(
  result: { verified?: boolean; pending?: boolean } | null | undefined,
): "delivered" | "unconfirmed" | "misroute" {
  if (result?.verified) return "delivered";
  if (result?.pending === false) return "misroute";
  return "unconfirmed";
}

export function verifyOtaHostPostDelivered(
  posts: unknown[],
  sentBody: string,
  requireOtaModule: boolean,
): { verified: boolean; deliveryModuleType?: string; reason?: string; pending?: boolean } {
  if (!Array.isArray(posts) || posts.length === 0) {
    return { verified: false, reason: "No conversation posts returned after send" };
  }
  const sorted = [...posts]
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .sort((a, b) => postTimestamp(b) - postTimestamp(a));

  // Scan the newest matching host posts. Only a post that STRICTLY matches the
  // body we just sent counts (bodiesAreDuplicate) — a delivered copy of an
  // earlier/edited message must NOT verify this send. A delivered OTA copy wins
  // outright; a wrong-channel (e.g. email) copy or a still-pending OTA copy are
  // remembered and only reported if NO delivered copy is found — so we never call
  // a stuck `pending` post "delivered".
  let sawWrongChannel: string | null = null;
  let sawPendingOta = false;
  for (const post of sorted.slice(0, 20)) {
    if (!isHostConversationPost(post)) continue;
    const body = postBodyText(post as { body?: unknown; text?: unknown; message?: unknown });
    if (!bodiesAreDuplicate(sentBody, body)) continue;

    const modType = String((post.module as Record<string, unknown> | undefined)?.type ?? "").toLowerCase();
    if (requireOtaModule && !guestyModuleTypeLooksOta(modType)) {
      if (!sawWrongChannel) sawWrongChannel = modType || "unknown";
      continue;
    }
    const state = postDeliveryState(post);
    if (state === "delivered") {
      return { verified: true, deliveryModuleType: modType || undefined };
    }
    if (state === "pending") sawPendingOta = true;
    // `failed` → keep scanning; a later retry copy may have delivered.
  }

  // A genuine in-flight OTA copy takes precedence over a wrong-channel copy: if
  // an identical body is BOTH pending on the OTA channel AND present on email
  // (e.g. a prior identical email send), our current OTA send is still in flight
  // — keep waiting rather than falsely declaring a hard misroute.
  if (sawPendingOta) {
    return {
      verified: false,
      pending: true,
      reason: "Message is queued on the OTA channel but the channel has not confirmed delivery yet",
    };
  }
  if (sawWrongChannel) {
    // Filed on the wrong (non-OTA) channel — a hard non-delivery, NOT "pending".
    // pending:false is explicit so the caller's `pending === true` stays false.
    return {
      verified: false,
      pending: false,
      deliveryModuleType: sawWrongChannel,
      reason: `Guesty saved the message on ${sawWrongChannel} instead of the OTA guest channel, so it was NOT delivered to the guest's booking channel`,
    };
  }
  // The POST succeeded but no body-matching host post surfaced in the window —
  // most likely sync lag, or the channel re-wrapped the body past the strict
  // matcher. This is UNCONFIRMED, not a wrong-channel misroute: report `pending`
  // (queued — don't resend) rather than a hard "saved on email" failure.
  return { verified: false, pending: true, reason: "Message was posted but delivery is not confirmed yet" };
}
