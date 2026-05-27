import { storage } from "./storage";
import type { InsertQuoCallEvent, InsertQuoSmsMessage, QuoCallEvent, QuoSmsMessage } from "@shared/schema";

const QUO_API_BASE = "https://api.openphone.com/v1";
const DEFAULT_CALL_BACKFILL_HOURS = 48;
const CALL_BACKFILL_COOLDOWN_MS = 5 * 60 * 1000;

let callBackfillInFlight: Promise<QuoCallBackfillResult> | null = null;
let lastCallBackfillAt = 0;

export type QuoCallBackfillResult = {
  ok: true;
  hours: number;
  since: string;
  conversationsScanned: number;
  callsScanned: number;
  missedCallsImported: number;
  skippedCalls: number;
  errors: string[];
  cached?: boolean;
};

export function normalizePhone(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+") && digits.length >= 10) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits ? `+${digits}` : "";
}

export function phoneLast10(value: unknown): string {
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

export function getQuoSmsConfigStatus(): { configured: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!process.env.QUO_API_KEY) missing.push("QUO_API_KEY");
  try {
    getQuoFromNumber();
  } catch {
    missing.push("QUO_FROM_NUMBER");
  }
  return { configured: missing.length === 0, missing };
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

async function callQuo(path: string, params: URLSearchParams): Promise<any> {
  const apiKey = process.env.QUO_API_KEY;
  if (!apiKey) throw new Error("QUO_API_KEY is required for Quo call sync");
  const url = `${QUO_API_BASE}${path}?${params.toString()}`;
  const resp = await fetch(url, { headers: { Authorization: apiKey } });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const message = data?.message ?? data?.error ?? `Quo returned HTTP ${resp.status}`;
    throw new Error(String(message));
  }
  return data;
}

async function listQuoPages(path: string, params: URLSearchParams, maxPages = 10): Promise<any[]> {
  const rows: any[] = [];
  let pageToken = "";
  for (let page = 0; page < maxPages; page++) {
    const pageParams = new URLSearchParams(params);
    if (pageToken) pageParams.set("pageToken", pageToken);
    const data = await callQuo(path, pageParams);
    rows.push(...unwrapList<any>(data, ["data", "results"]));
    pageToken = String(data?.nextPageToken ?? "").trim();
    if (!pageToken) break;
  }
  return rows;
}

async function callGuesty(method: string, path: string): Promise<unknown> {
  const { guestyRequest } = await import("./guesty-sync");
  return guestyRequest(method, path);
}

function firstName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .split(/\s+/)[0]
    ?.replace(/[^a-z]/gi, "")
    .toLowerCase() ?? "";
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

  const raw = await callGuesty("GET", "/communication/conversations?limit=100&fields=") as any;
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

export async function findGuestyConversationByPhoneOrName(input: {
  phone?: string | null;
  callerName?: string | null;
}): Promise<{
  conversationId: string;
  reservationId: string | null;
  guestName: string | null;
  matchStrategy: "saved-phone" | "guesty-phone" | "first-name-unique";
  matchConfidence: "high" | "medium";
} | null> {
  const normalizedPhone = normalizePhone(input.phone);
  if (phoneLast10(normalizedPhone)) {
    const override = await storage.getGuestPhoneOverrideByPhone(normalizedPhone);
    if (override) {
      return {
        conversationId: override.conversationId,
        reservationId: override.reservationId ?? null,
        guestName: override.guestName ?? null,
        matchStrategy: "saved-phone",
        matchConfidence: "high",
      };
    }

    const phoneMatch = await findGuestyConversationByPhone(normalizedPhone);
    if (phoneMatch) {
      return {
        ...phoneMatch,
        matchStrategy: "guesty-phone",
        matchConfidence: "high",
      };
    }
  }

  const wantedFirstName = firstName(input.callerName);
  if (!wantedFirstName || wantedFirstName.length < 2) return null;

  const raw = await callGuesty("GET", "/communication/conversations?limit=100&fields=") as any;
  const conversations = unwrapList<any>(raw, ["conversations", "results", "data"]);
  const matches = conversations.filter((c) => firstName(conversationGuestName(c)) === wantedFirstName);
  if (matches.length !== 1) return null;
  const c = matches[0];
  return {
    conversationId: c._id ?? c.id,
    reservationId: conversationReservationId(c),
    guestName: conversationGuestName(c),
    matchStrategy: "first-name-unique",
    matchConfidence: "medium",
  };
}

function parseDate(value: unknown): Date | null {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

function extractCallerName(object: any, payload: any): string | null {
  const contact = object?.contact ?? object?.participant ?? object?.participants?.[0] ?? payload?.contact;
  const name = object?.callerName ?? object?.name ?? contact?.name ?? contact?.fullName ?? [contact?.firstName, contact?.lastName].filter(Boolean).join(" ");
  const clean = String(name ?? "").trim();
  return clean || null;
}

function normalizeQuoParticipant(value: unknown): string {
  if (Array.isArray(value)) return normalizePhone(value[0]);
  return normalizePhone(value);
}

export function parseQuoCallWebhook(payload: any): {
  providerCallId: string;
  direction: "inbound" | "outbound";
  fromNumber: string;
  toNumber: string;
  guestPhone: string;
  status: string;
  disposition: "answered" | "missed" | "voicemail" | "unknown";
  durationSeconds: number | null;
  callerName: string | null;
  callStartedAt: Date | null;
  callCompletedAt: Date | null;
} {
  const object = payload?.data?.object ?? payload?.object ?? payload?.call ?? payload;
  const eventType = String(payload?.type ?? payload?.event ?? object?.eventType ?? "").toLowerCase();
  const rawDirection = String(object?.direction ?? object?.type ?? eventType).toLowerCase();
  const direction: "inbound" | "outbound" = rawDirection.includes("out") ? "outbound" : "inbound";
  const participants = Array.isArray(object?.participants) ? object.participants : [];
  const fromNumber = normalizePhone(object?.from ?? object?.caller ?? object?.source ?? (direction === "inbound" ? participants[0] : getQuoFromNumber()));
  const toNumber = normalizePhone(object?.to ?? object?.recipient ?? object?.callee ?? (direction === "outbound" ? participants[0] : getQuoFromNumber()));
  const guestPhone = direction === "inbound"
    ? normalizePhone(fromNumber || normalizeQuoParticipant(participants))
    : normalizePhone(toNumber || normalizeQuoParticipant(participants));
  const providerCallId = String(object?.id ?? object?.callId ?? payload?.id ?? `quo-call-${Date.now()}`);
  const status = String(object?.status ?? eventType ?? "completed");
  const durationRaw = object?.duration ?? object?.durationSeconds ?? object?.callDuration;
  const durationSeconds = Number.isFinite(Number(durationRaw)) ? Math.max(0, Math.round(Number(durationRaw))) : null;
  const hasVoicemail =
    Boolean(object?.voicemail ?? object?.voicemailId ?? object?.voicemailUrl ?? object?.voicemailRecordingUrl) ||
    /voicemail/.test(`${eventType} ${status}`.toLowerCase());
  const answered = Boolean(object?.answeredAt ?? object?.answeredBy) || durationSeconds !== null && durationSeconds > 0;
  const missed =
    direction === "inbound" &&
    !answered &&
    (/miss|no[-_ ]?answer|unanswered|completed/.test(`${eventType} ${status}`.toLowerCase()) || object?.answeredAt === null);
  const disposition = hasVoicemail ? "voicemail" : missed ? "missed" : answered ? "answered" : "unknown";
  return {
    providerCallId,
    direction,
    fromNumber: fromNumber || getQuoFromNumber(),
    toNumber: toNumber || getQuoFromNumber(),
    guestPhone,
    status,
    disposition,
    durationSeconds,
    callerName: extractCallerName(object, payload),
    callStartedAt: parseDate(object?.startedAt ?? object?.createdAt ?? payload?.createdAt),
    callCompletedAt: parseDate(object?.completedAt ?? object?.endedAt ?? object?.updatedAt ?? payload?.createdAt),
  };
}

async function getQuoVoicemailForCall(callId: string): Promise<{
  id?: string | null;
  status?: string | null;
  recordingUrl?: string | null;
  transcript?: string | null;
  duration?: number | null;
} | null> {
  const apiKey = process.env.QUO_API_KEY;
  if (!apiKey || !callId || !callId.startsWith("AC")) return null;
  const resp = await fetch(`${QUO_API_BASE}/call-voicemails/${encodeURIComponent(callId)}`, {
    headers: { Authorization: apiKey },
  });
  if (resp.status === 404) return null;
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) return null;
  return data?.data ?? null;
}

export async function recordQuoCallWebhook(payload: any): Promise<{ call: QuoCallEvent; matched: boolean }> {
  const parsed = parseQuoCallWebhook(payload);
  if (!phoneLast10(parsed.guestPhone)) throw new Error("Webhook payload did not include a valid caller phone");

  const match = await findGuestyConversationByPhoneOrName({
    phone: parsed.guestPhone,
    callerName: parsed.callerName,
  });
  const voicemail = parsed.disposition === "voicemail" || /call\.completed|recording/.test(String(payload?.type ?? payload?.event ?? "").toLowerCase())
    ? await getQuoVoicemailForCall(parsed.providerCallId)
    : null;
  const voicemailRecordingUrl =
    voicemail?.recordingUrl ??
    payload?.data?.object?.voicemailRecordingUrl ??
    payload?.object?.voicemailRecordingUrl ??
    payload?.recordingUrl ??
    null;
  const voicemailTranscript =
    voicemail?.transcript ??
    payload?.data?.object?.voicemailTranscript ??
    payload?.object?.voicemailTranscript ??
    payload?.transcript ??
    null;
  const disposition = voicemailRecordingUrl || voicemailTranscript ? "voicemail" : parsed.disposition;

  const row: InsertQuoCallEvent = {
    providerCallId: parsed.providerCallId,
    conversationId: match?.conversationId ?? null,
    reservationId: match?.reservationId ?? null,
    guestName: match?.guestName ?? parsed.callerName,
    guestPhone: parsed.guestPhone,
    fromNumber: parsed.fromNumber,
    toNumber: parsed.toNumber,
    direction: parsed.direction,
    status: parsed.status,
    disposition,
    durationSeconds: parsed.durationSeconds,
    matchStrategy: match?.matchStrategy ?? null,
    matchConfidence: match?.matchConfidence ?? null,
    voicemailId: voicemail?.id ?? null,
    voicemailStatus: voicemail?.status ?? (voicemailRecordingUrl ? "completed" : null),
    voicemailRecordingUrl,
    voicemailTranscript,
    voicemailDurationSeconds: Number.isFinite(Number(voicemail?.duration)) ? Number(voicemail?.duration) : null,
    rawPayload: JSON.stringify(payload),
    callStartedAt: parsed.callStartedAt,
    callCompletedAt: parsed.callCompletedAt ?? new Date(),
    acknowledgedAt: disposition === "answered" ? new Date() : null,
  };
  const call = await storage.upsertQuoCallEvent(row);
  return { call, matched: !!match };
}

function quoCallPayloadFromApiCall(call: any, conversation: any): any {
  const participant = normalizePhone(Array.isArray(conversation?.participants) ? conversation.participants[0] : call?.participants?.[0]);
  const rawDirection = String(call?.direction ?? call?.type ?? "").toLowerCase();
  const direction = rawDirection.includes("out") ? "outbound" : "inbound";
  const from = normalizePhone(call?.from ?? call?.caller ?? (direction === "inbound" ? participant : getQuoFromNumber()));
  const to = normalizePhone(call?.to ?? call?.recipient ?? (direction === "outbound" ? participant : getQuoFromNumber()));
  return {
    type: "call.backfill",
    data: {
      object: {
        ...call,
        direction,
        from,
        to,
        callerName: call?.callerName ?? call?.name ?? conversation?.name ?? null,
      },
    },
    createdAt: call?.createdAt ?? call?.completedAt ?? conversation?.lastActivityAt,
  };
}

function shouldImportBackfilledCall(payload: any): boolean {
  try {
    const parsed = parseQuoCallWebhook(payload);
    return parsed.direction === "inbound" && (parsed.disposition === "missed" || parsed.disposition === "voicemail");
  } catch {
    return false;
  }
}

export async function backfillQuoMissedCalls(options: { hours?: number; force?: boolean } = {}): Promise<QuoCallBackfillResult> {
  const hours = Math.min(168, Math.max(1, Math.round(Number(options.hours ?? DEFAULT_CALL_BACKFILL_HOURS) || DEFAULT_CALL_BACKFILL_HOURS)));
  const now = Date.now();
  if (!options.force && now - lastCallBackfillAt < CALL_BACKFILL_COOLDOWN_MS) {
    return {
      ok: true,
      hours,
      since: new Date(now - hours * 60 * 60 * 1000).toISOString(),
      conversationsScanned: 0,
      callsScanned: 0,
      missedCallsImported: 0,
      skippedCalls: 0,
      errors: [],
      cached: true,
    };
  }
  if (callBackfillInFlight) return callBackfillInFlight;

  callBackfillInFlight = (async () => {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const fromNumber = getQuoFromNumber();
    const conversationParams = new URLSearchParams({
      updatedAfter: since,
      maxResults: "100",
    });
    conversationParams.append("phoneNumbers", fromNumber);

    const conversations = await listQuoPages("/conversations", conversationParams, 5);
    const errors: string[] = [];
    let callsScanned = 0;
    let missedCallsImported = 0;
    let skippedCalls = 0;

    for (const conversation of conversations) {
      const phoneNumberId = String(conversation?.phoneNumberId ?? "").trim();
      const participant = normalizePhone(Array.isArray(conversation?.participants) ? conversation.participants[0] : "");
      if (!phoneNumberId || !phoneLast10(participant)) {
        skippedCalls++;
        continue;
      }

      const callParams = new URLSearchParams({
        phoneNumberId,
        createdAfter: since,
        maxResults: "100",
      });
      callParams.append("participants", participant);

      try {
        const calls = await listQuoPages("/calls", callParams, 5);
        for (const call of calls) {
          callsScanned++;
          const payload = quoCallPayloadFromApiCall(call, conversation);
          if (!shouldImportBackfilledCall(payload)) {
            skippedCalls++;
            continue;
          }
          await recordQuoCallWebhook(payload);
          missedCallsImported++;
        }
      } catch (err: any) {
        errors.push(`${participant}: ${err?.message ?? err}`);
      }
    }

    lastCallBackfillAt = Date.now();
    return {
      ok: true,
      hours,
      since,
      conversationsScanned: conversations.length,
      callsScanned,
      missedCallsImported,
      skippedCalls,
      errors,
    };
  })();

  try {
    return await callBackfillInFlight;
  } finally {
    callBackfillInFlight = null;
  }
}

export async function sendQuoSms(input: {
  conversationId: string;
  reservationId?: string | null;
  guestName?: string | null;
  to: string;
  body: string;
}): Promise<QuoSmsMessage> {
  const apiKey = process.env.QUO_API_KEY;
  if (!apiKey) throw new Error("SMS is not configured yet. Add QUO_API_KEY in Railway before sending texts.");
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
