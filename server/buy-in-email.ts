import nodemailer from "nodemailer";

export type BuyInEmailAttachment = {
  filename: string;
  contentType?: string | null;
  size?: number | null;
  contentBase64?: string | null;
  url?: string | null;
};

const MAX_ATTACHMENT_TOTAL_BYTES = 7 * 1024 * 1024;

function normalizeBase64(value: string): string {
  const comma = value.indexOf(",");
  if (value.startsWith("data:") && comma >= 0) return value.slice(comma + 1);
  return value.replace(/\s+/g, "");
}

function normalizeAttachmentInput(raw: unknown): unknown[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return normalizeAttachmentInput(parsed);
    } catch {
      return [];
    }
  }
  if (typeof raw === "object") return [raw];
  return [];
}

export function normalizeBuyInEmailAttachments(raw: unknown): BuyInEmailAttachment[] {
  const input = normalizeAttachmentInput(raw);
  let totalBytes = 0;
  const normalized: BuyInEmailAttachment[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const filename = String(record.filename ?? record.name ?? "attachment").trim().slice(0, 180);
    if (!filename) continue;
    const contentType = String(record.contentType ?? record.type ?? "application/octet-stream").trim().slice(0, 120);
    const rawContent = typeof record.contentBase64 === "string"
      ? record.contentBase64
      : typeof record.content === "string"
        ? record.content
        : typeof record.data === "string"
          ? record.data
          : "";
    const contentBase64 = rawContent ? normalizeBase64(rawContent) : null;
    const url = typeof record.url === "string" ? record.url.slice(0, 1_000) : null;
    const size = Number(record.size) || (contentBase64 ? Math.ceil((contentBase64.length * 3) / 4) : null);
    if (size) totalBytes += size;
    if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
      throw new Error("Alias email attachments must be 7 MB total or less");
    }
    normalized.push({
      filename,
      contentType,
      size,
      contentBase64,
      url,
    });
  }
  return normalized;
}

export function parseArrivalDetailsFromText(body: string): Record<string, string> {
  const text = body.replace(/\r/g, "");
  const pick = (patterns: RegExp[]): string => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) return match[1].trim().replace(/\s+/g, " ").slice(0, 500);
    }
    return "";
  };
  return {
    unitAddress: pick([/(?:address|unit address|property address)\s*[:\-]\s*([^\n]+)/i]),
    accessCode: pick([/(?:access code|door code|lockbox code|entry code|keypad code)\s*[:\-]\s*([^\n]+)/i]),
    wifiName: pick([/(?:wi-?fi(?: name)?|network|ssid)\s*[:\-]\s*([^\n]+)/i]),
    wifiPassword: pick([/(?:wi-?fi password|password)\s*[:\-]\s*([^\n]+)/i]),
    parkingInfo: pick([/(?:parking|parking info|parking instructions)\s*[:\-]\s*([\s\S]{0,500})(?:\n\s*\n|$)/i]),
    arrivalNotes: pick([/(?:arrival details|arrival instructions|check-?in instructions)\s*[:\-]\s*([\s\S]{0,1000})(?:\n\s*\n|$)/i]),
  };
}

export async function sendBuyInEmail(input: {
  from: string;
  to: string;
  subject: string;
  body: string;
  attachments?: BuyInEmailAttachment[];
}): Promise<{ messageId?: string }> {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    throw new Error("SMTP_HOST, SMTP_USER, and SMTP_PASS are required to send buy-in emails");
  }
  const transporter = nodemailer.createTransport({
    host,
    port: Number.isFinite(port) ? port : 587,
    secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || port === 465,
    auth: { user, pass },
  });
  const result = await transporter.sendMail({
    from: input.from,
    to: input.to,
    subject: input.subject,
    text: input.body,
    attachments: (input.attachments ?? [])
      .filter((attachment) => attachment.contentBase64)
      .map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType || undefined,
        content: Buffer.from(attachment.contentBase64 || "", "base64"),
      })),
  });
  return { messageId: result.messageId };
}
