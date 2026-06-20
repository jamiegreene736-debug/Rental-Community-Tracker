import { isBookingChannel } from "./receipt-message";

export function guestyModuleTypeLooksOta(type: string): boolean {
  const t = String(type ?? "").toLowerCase();
  return t.includes("booking") || t.includes("airbnb") || t.includes("homeaway") || t.includes("vrbo");
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
  if (/vrbo|homeaway|expedia/.test(sourceText)) return "homeaway";
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

export function bodiesLikelyMatch(sentBody: string, postBody: string): boolean {
  const a = sentBody.trim().toLowerCase();
  const b = postBody.trim().toLowerCase();
  if (!a || !b) return false;
  const head = a.slice(0, Math.min(80, a.length));
  const tail = a.slice(Math.max(0, a.length - 80));
  return b.includes(head.slice(0, 40)) || b.includes(tail) || a.includes(b.slice(0, 40));
}

export function verifyOtaHostPostDelivered(
  posts: unknown[],
  sentBody: string,
  requireOtaModule: boolean,
): { verified: boolean; deliveryModuleType?: string; reason?: string } {
  if (!Array.isArray(posts) || posts.length === 0) {
    return { verified: false, reason: "No conversation posts returned after send" };
  }
  const sorted = [...posts]
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .sort((a, b) => postTimestamp(b) - postTimestamp(a));

  for (const post of sorted.slice(0, 8)) {
    if (!isHostConversationPost(post)) continue;
    const body = postBodyText(post as { body?: unknown; text?: unknown; message?: unknown });
    if (!bodiesLikelyMatch(sentBody, body)) continue;

    const modType = String((post.module as Record<string, unknown> | undefined)?.type ?? "").toLowerCase();
    if (requireOtaModule && !guestyModuleTypeLooksOta(modType)) {
      return {
        verified: false,
        deliveryModuleType: modType || "unknown",
        reason: `Guesty saved the message on ${modType || "unknown"} instead of the OTA guest channel`,
      };
    }
    return { verified: true, deliveryModuleType: modType || undefined };
  }

  return { verified: false, reason: "No matching host post found on the conversation after send" };
}
