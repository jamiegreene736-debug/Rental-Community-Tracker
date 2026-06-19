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

export function stripHtmlForEmailParse(input: string): string {
  return String(input ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function looksLikeHtmlGarbage(value: string): boolean {
  const v = String(value ?? "");
  return /<\/?[a-z][^>]*>/i.test(v)
    || /&nbsp;|style\s*=|display\s*:\s*inline|text-indent\s*:/i.test(v)
    || /^\s*<\/?span/i.test(v);
}

const BLOCKLISTED_ADDRESS_RES = [
  /131\s+continental\s+drive/i,
  /newark,?\s*de\s*19702/i,
  /expedia\s+group/i,
  /110\s+se\s+yam\s+street/i, // VRBO Austin office
];

export function isBlocklistedPropertyAddress(address: string): boolean {
  const v = String(address ?? "").trim();
  if (!v) return false;
  return BLOCKLISTED_ADDRESS_RES.some((re) => re.test(v));
}

export function isUsableArrivalField(key: string, value: string): boolean {
  const v = String(value ?? "").trim();
  if (!v) return false;
  if (looksLikeHtmlGarbage(v)) return false;
  if (key === "unitAddress") {
    if (isBlocklistedPropertyAddress(v)) return false;
    if (v.length < 8 || !/\d/.test(v)) return false;
  }
  if (key === "wifiName" || key === "wifiPassword") {
    if (/guideline|unsubscribe|click here|view (?:in|online)|http/i.test(v)) return false;
    if (v.length > 80) return false;
  }
  if (key === "accessCode") {
    if (/never share|secure code|verification/i.test(v) && v.length > 24) return false;
    const code = v.replace(/[^\dA-Za-z#-]/g, "");
    if (!code || code.length > 20) return false;
  }
  if (key === "parkingInfo" && v.length > 500) return false;
  return true;
}

function sanitizePickedValue(key: string, raw: string): string {
  const cleaned = stripHtmlForEmailParse(raw).replace(/\s+/g, " ").trim();
  if (!cleaned || !isUsableArrivalField(key, cleaned)) return "";
  return cleaned.slice(0, key === "arrivalNotes" ? 2000 : 500);
}

export function parseArrivalDetailsFromText(body: string): Record<string, string> {
  const text = stripHtmlForEmailParse(body);
  const pick = (key: string, patterns: RegExp[]): string => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) {
        const value = sanitizePickedValue(key, match[1]);
        if (value) return value;
      }
    }
    return "";
  };

  const gateCode = pick("accessCode", [
    /(?:gate\s*(?:code|#|passcode)?|community\s*gate|resort\s*gate)\s*[:\-]\s*([^\n]+)/i,
  ]);
  const elevatorCode = pick("accessCode", [
    /(?:elevator\s*(?:code|#|passcode)?|lift\s*code)\s*[:\-]\s*([^\n]+)/i,
  ]);
  const doorCode = pick("accessCode", [
    /(?:door\s*(?:code|#|passcode)?|unit\s*(?:code|door code)|lockbox\s*code|keypad\s*code)\s*[:\-]\s*([^\n]+)/i,
    /(?:access code|entry code)\s*[:\-]\s*([^\n]+)/i,
    /(?:your\s+secure\s+code\s+is|secure\s+code)\s*[:\-]?\s*(\d{4,8})\b/i,
  ]);

  let unitAddress = pick("unitAddress", [
    /(?:property address|rental address|unit address|where you['']?ll stay|where you'll stay)\s*[:\-]\s*([^\n]+)/i,
    /(?:check-?in(?: location)?|arrival(?: location)?)\s*[:\-]\s*([^\n]+)/i,
  ]);
  if (!unitAddress) {
    const streetMatch = text.match(
      /\b(\d{1,6}\s+[A-Za-z0-9.\s#'/-]{3,90}(?:,\s*[A-Za-z .'-]+){0,4}(?:,\s*[A-Z]{2})?\s+\d{5}(?:-\d{4})?)\b/,
    );
    if (streetMatch?.[1]) {
      unitAddress = sanitizePickedValue("unitAddress", streetMatch[1]);
    }
  }

  const accessCode = doorCode || pick("accessCode", [
    /(?:access code|door code|lockbox code|entry code|keypad code)\s*[:\-]\s*([^\n]+)/i,
    /(?:your\s+secure\s+code\s+is|secure\s+code)\s*[:\-]?\s*(\d{4,8})\b/i,
  ]);
  const wifiName = pick("wifiName", [
    /(?:wi-?fi(?:\s*network)?(?:\s*name)?|network name|ssid)\s*[:\-]\s*([^\n]+)/i,
  ]);
  const wifiPassword = pick("wifiPassword", [
    /(?:wi-?fi\s*password|network\s*password)\s*[:\-]\s*([^\n]+)/i,
  ]);
  const parkingInfo = pick("parkingInfo", [
    /(?:parking|parking info|parking instructions|assigned parking)\s*[:\-]\s*([\s\S]{0,500})(?:\n\s*\n|$)/i,
  ]);

  const noteLines: string[] = [];
  if (gateCode && gateCode !== accessCode) noteLines.push(`Gate code: ${gateCode}`);
  if (elevatorCode) noteLines.push(`Elevator code: ${elevatorCode}`);
  const checkInTime = pick("arrivalNotes", [/(?:check-?in time|arrival time|check-?in begins)\s*[:\-]\s*([^\n]+)/i]);
  if (checkInTime) noteLines.push(`Check-in: ${checkInTime}`);
  const arrivalBlock = pick("arrivalNotes", [
    /(?:arrival details|arrival instructions|check-?in instructions|getting (?:there|in)|access instructions)\s*[:\-]\s*([\s\S]{0,1000})(?:\n\s*\n|$)/i,
  ]);
  if (arrivalBlock) noteLines.push(arrivalBlock);

  return {
    unitAddress,
    accessCode,
    wifiName,
    wifiPassword,
    parkingInfo,
    arrivalNotes: noteLines.join("\n").slice(0, 2000),
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
