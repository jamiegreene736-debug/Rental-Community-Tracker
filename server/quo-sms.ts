import { storage } from "./storage";
import { guestyRequest } from "./guesty-sync";
import type { InsertQuoSmsMessage, QuoSmsMessage } from "@shared/schema";

const QUO_API_BASE = "https://api.openphone.com/v1";

export function normalizePhone(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+") && digits.length >= 10) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits ? `+${digits}` : "";
}

function phoneLast10(value: unknown): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
}

export function getQuoFromNumber(): string {
  const from = normalizePhone(process.env.QUO_FROM_NUMBER);
  if (!from) throw new Error("QUO_FROM_NUMBER is required, e.g. +18085551234");
  if (!phoneLast10(from).startsWith("808")) {
    throw new Error("QUO_FROM_NUMBER must be an 808 area-code phone number for guest SMS");
  }
  return from;
}

function collectPhoneNumbers(node: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (!node || depth > 6) return out;
  if (typeof node === "string" || typeof node === "number") {
    const normalized = normalizePhone(node);
    if (phoneLast10(normalized)) out.add(normalized);
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectPhoneNumbers(item, out, depth + 1);
    return out;
  }
  if (typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (/phone|mobile|cell|tel|number/i.test(key) || typeof value === "object") {
        collectPhoneNumbers(value, out, depth + 1);
      }
    }
  }
  return out;
}

function unwrapList<T>(raw: unknown, hints: string[] = []): T[] {
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number): T[] | null => {
    if (Array.isArray(node)) return node as T[];
    if (!node || typeof node !== "object" || depth > 4) return null;
    if (seen.has(node)) return null;
    seen.add(node);
    const obj = node as Record<string, unknown>;
    for (const hint of hints) {
      if (Array.isArray(obj[hint])) return obj[hint] as T[];
    }
    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") {
        const found = visit(value, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(raw, 0) ?? [];
}

function conversationGuestName(c: any): string | null {
  const guest = c?.guest ?? c?.meta?.guest ?? {};
  return c?.guestName ?? guest.fullName ?? guest.name ?? [guest.firstName, guest.lastName].filter(Boolean).join(" ") ?? null;
}

function conversationReservationId(c: any): string | null {
  const meta = c?.meta ?? {};
  const firstReservation = Array.isArray(meta.reservations) && meta.reservations.length > 0
    ? meta.reservations[0]
    : (c?.reservation ?? meta.reservation ?? null);
  return c?.reservationId ?? firstReservation?._id ?? firstReservation?.id ?? null;
}

export async function findGuestyConversationByPhone(phone: string): Promise<{
  conversationId: string;
  reservationId: string | null;
  guestName: string | null;
} | null> {
  const wanted = phoneLast10(phone);
  if (!wanted) return null;

  const raw = await guestyRequest("GET", "/communication/conversations?limit=100&fields=") as any;
  const conversations = unwrapList<any>(raw, ["conversations", "results", "data"]);
  for (const c of conversations) {
    const phones = collectPhoneNumbers(c);
    for (const candidate of Array.from(phones)) {
      if (phoneLast10(candidate) === wanted) {
        return {
          conversationId: c._id ?? c.id,
          reservationId: conversationReservationId(c),
          guestName: conversationGuestName(c),
        };
      }
    }
  }
  return null;
}

export async function sendQuoSms(input: {
  conversationId: string;
  reservationId?: string | null;
  guestName?: string | null;
  to: string;
  body: string;
}): Promise<QuoSmsMessage> {
  const apiKey = process.env.QUO_API_KEY;
  if (!apiKey) throw new Error("QUO_API_KEY is required to send SMS");
  const from = getQuoFromNumber();
  const to = normalizePhone(input.to);
  if (!phoneLast10(to)) throw new Error("Guest phone number is missing or invalid");
  const body = input.body.trim();
  if (!body) throw new Error("Message body is required");
  if (body.length > 1600) throw new Error("Quo SMS messages must be 1,600 characters or less");

  const payload: Record<string, unknown> = {
    content: body,
    from,
    to: [to],
  };
  if (process.env.QUO_USER_ID) payload.userId = process.env.QUO_USER_ID;

  const resp = await fetch(`${QUO_API_BASE}/messages`, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const message = data?.message ?? data?.error ?? `Quo returned HTTP ${resp.status}`;
    throw new Error(String(message));
  }

  const providerMessageId = String(data?.id ?? data?.data?.id ?? data?.messageId ?? `quo-out-${Date.now()}`);
  const row: InsertQuoSmsMessage = {
    providerMessageId,
    conversationId: input.conversationId,
    reservationId: input.reservationId ?? null,
    guestName: input.guestName ?? null,
    guestPhone: to,
    fromNumber: from,
    toNumber: to,
    direction: "outbound",
    body,
    status: String(data?.status ?? "accepted"),
    rawPayload: JSON.stringify(data),
    sentAt: new Date(),
  };
  return storage.createQuoSmsMessage(row);
}

export async function recordQuoWebhook(payload: any): Promise<{ message: QuoSmsMessage; matched: boolean }> {
  const object = payload?.data?.object ?? payload?.object ?? payload?.message ?? payload;
  const direction = String(object?.direction ?? payload?.type ?? "").toLowerCase().includes("out")
    ? "outbound"
    : "inbound";
  const from = normalizePhone(object?.from ?? object?.sender ?? object?.source);
  const toRaw = Array.isArray(object?.to) ? object.to[0] : object?.to;
  const to = normalizePhone(toRaw ?? object?.recipient ?? getQuoFromNumber());
  const guestPhone = direction === "inbound" ? from : to;
  const body = String(object?.text ?? object?.content ?? object?.body ?? "").trim();
  const providerMessageId = String(object?.id ?? payload?.id ?? `quo-webhook-${Date.now()}`);
  if (!phoneLast10(guestPhone)) throw new Error("Webhook payload did not include a valid guest phone");
  if (!body) throw new Error("Webhook payload did not include message text");

  const match = direction === "inbound" ? await findGuestyConversationByPhone(guestPhone) : null;
  const row: InsertQuoSmsMessage = {
    providerMessageId,
    conversationId: match?.conversationId ?? null,
    reservationId: match?.reservationId ?? null,
    guestName: match?.guestName ?? null,
    guestPhone,
    fromNumber: from || getQuoFromNumber(),
    toNumber: to || getQuoFromNumber(),
    direction,
    body,
    status: String(object?.status ?? payload?.type ?? "received"),
    rawPayload: JSON.stringify(payload),
    sentAt: object?.createdAt ? new Date(object.createdAt) : new Date(),
  };
  const message = await storage.createQuoSmsMessage(row);
  return { message, matched: !!match };
}
