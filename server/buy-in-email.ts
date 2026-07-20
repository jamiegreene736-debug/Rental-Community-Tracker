import nodemailer from "nodemailer";
import { guestInboxImapConfig } from "./guest-inbox-sync";
import { stripLinkMarkers } from "@shared/email-mime";

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
  // "[link: …]" markers (preserved hyperlinks, shared/email-mime.ts) are
  // stripped BEFORE label parsing — a trailing marker on "Door code: 1234
  // [link: …]" would bloat the end-of-line capture past the code-length guard
  // and silently DROP the code.
  return stripLinkMarkers(String(input ?? ""))
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
  /110\s+se\s+yam\s+street/i, // VRBO Austin office (old)
  /11920\s+alterra\s+(?:parkway|pkwy)/i, // Expedia / VRBO Austin HQ
  /austin,?\s*tx\s*78758/i,
  /1111\s+expedia\s+group\s+way/i, // Seattle HQ
  /seattle,?\s*wa\s*98119/i,
];

export function extractUsStateFromAddress(address: string): string | null {
  const m = String(address ?? "").match(/,\s*([A-Z]{2})\s+\d{5}\b/);
  return m?.[1]?.toUpperCase() ?? null;
}

export function expectedStateHintFromBuyIn(
  buyIn?: { propertyName?: string | null; notes?: string | null; unitLabel?: string | null } | null,
  communityState?: string | null,
): string | null {
  const fromCommunity = String(communityState ?? "").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(fromCommunity)) return fromCommunity;
  const blob = `${buyIn?.propertyName ?? ""} ${buyIn?.unitLabel ?? ""} ${buyIn?.notes ?? ""}`.toLowerCase();
  if (/\b(hawaii|kauai|oahu|maui|molokai|lanai|princeville|poipu|koloa|lihue|kapaa|waikoloa|honolulu|kailua|kihei|lahaina)\b/.test(blob)) {
    return "HI";
  }
  if (/\b(florida|naples|bonita springs|destin|miami|orlando)\b/.test(blob)) return "FL";
  if (/\b(arizona|scottsdale|phoenix|sedona)\b/.test(blob)) return "AZ";
  if (/\b(colorado|denver|breckenridge|vail)\b/.test(blob)) return "CO";
  return null;
}

export function isPlausiblePropertyAddressForBuyIn(
  address: string,
  buyIn?: { propertyName?: string | null; notes?: string | null; unitLabel?: string | null } | null,
  communityState?: string | null,
): boolean {
  if (!isUsableArrivalField("unitAddress", address)) return false;
  const expected = expectedStateHintFromBuyIn(buyIn, communityState);
  const addrState = extractUsStateFromAddress(address);
  if (expected && addrState && expected !== addrState) return false;
  return true;
}

const US_STREET_ADDRESS_RE = /\b(\d{1,6}\s+[A-Za-z0-9.\s#'/-]{3,90}(?:,\s*[A-Za-z .'-]+){0,4}(?:,\s*[A-Z]{2})?\s+\d{5}(?:-\d{4})?)\b/g;

export function pickBestPropertyAddressFromText(
  body: string,
  buyIn?: { propertyName?: string | null; notes?: string | null; unitLabel?: string | null } | null,
  communityState?: string | null,
): string {
  const cleaned = stripHtmlForEmailParse(body);
  const candidates: string[] = [];
  for (const match of cleaned.matchAll(US_STREET_ADDRESS_RE)) {
    const value = String(match[1] ?? "").trim().replace(/\s+/g, " ");
    if (value) candidates.push(value);
  }
  for (const candidate of candidates) {
    if (isPlausiblePropertyAddressForBuyIn(candidate, buyIn, communityState)) {
      return candidate.slice(0, 500);
    }
  }
  return "";
}

export function isBlocklistedPropertyAddress(address: string): boolean {
  const v = String(address ?? "").trim();
  if (!v) return false;
  return BLOCKLISTED_ADDRESS_RES.some((re) => re.test(v));
}

const MONTH_WORD = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const WEEKDAY_WORD = "(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*";
const SINGLE_DATE_RES = [
  // 07/21/2026, 7-21-26, 07.21.2026 (optionally with a trailing time)
  /^\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}(?:\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?$/i,
  // 2026-07-21 ISO
  /^\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}$/,
  // "July 21", "Jul 21, 2026", "Mon, July 21st 2026"
  new RegExp(`^(?:${WEEKDAY_WORD},?\\s+)?${MONTH_WORD}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?$`, "i"),
  // "21 July 2026"
  new RegExp(`^\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_WORD}(?:,?\\s+\\d{4})?$`, "i"),
  // bare time: "4:00 PM", "16:00", "4pm"
  /^\d{1,2}(?::\d{2})?\s*(?:am|pm)$/i,
  /^\d{1,2}:\d{2}$/,
];

function isSingleDateOrTimeToken(value: string): boolean {
  const v = String(value ?? "").trim();
  if (!v) return false;
  return SINGLE_DATE_RES.some((re) => re.test(v));
}

// True for values that are a calendar date, a time, or a date range — the exact
// shapes VRBO puts on "Check-in:" lines. A date must NEVER persist as a street
// address (buy-in 539 stored "07/21/2026" as unitAddress and the proximity
// panel geocoded it to nonsense).
export function looksLikeDateOrTimeValue(value: string): boolean {
  const v = String(value ?? "").trim();
  if (!v) return false;
  if (isSingleDateOrTimeToken(v)) return true;
  const parts = v.split(/\s*(?:-|–|—|\bto\b|\bthrough\b)\s*/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2 && parts.every(isSingleDateOrTimeToken)) return true;
  return false;
}

// Street-shape gate for unitAddress: reject date/time shapes outright, and
// require a house-number token (digits followed by a lettered word — "760 S",
// "2253 Poipu", the Hawaii hyphenated "75-6082 Alii") plus enough letters to be
// a real street. Deliberately looser than shared/community-addresses.ts
// isLikelyStreetAddress (which demands a recognized street suffix and would
// reject real streets like "... Loop" / "... Alanui").
export function looksLikeStreetAddressValue(value: string): boolean {
  const v = String(value ?? "").trim();
  if (!v) return false;
  if (looksLikeDateOrTimeValue(v)) return false;
  if (!/\b\d{1,6}(?:-\d{1,6})?\s+[A-Za-z][A-Za-z'.-]*/.test(v)) return false;
  if ((v.match(/[A-Za-z]/g) ?? []).length < 4) return false;
  return true;
}

const WIFI_PASSWORD_LABEL_RE = /\b(?:password|passcode|passphrase|pwd)\b/i;

export function stripWrappingQuotes(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/^['"'"«»`]+/, "")
    .replace(/['"'"«»`]+$/, "")
    .trim();
}

// Split a one-line "Wi-Fi: 'SpectrumSetup-C1' PASSWORD: 'littleshark860'" capture
// into name + password. Returns null when the capture carries no password label.
export function splitWifiNameAndPassword(raw: string): { name: string; password: string } | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  const m = v.match(/^(.*?)[\s,;\/]*\b(?:password|passcode|passphrase|pwd)\b\s*(?:is)?\s*[:\-]?\s*(.+)$/i);
  if (!m) return null;
  const name = stripWrappingQuotes(m[1] ?? "");
  const password = stripWrappingQuotes(m[2] ?? "");
  if (!password) return null;
  return { name, password };
}

export function isUsableArrivalField(key: string, value: string): boolean {
  const v = String(value ?? "").trim();
  if (!v) return false;
  if (looksLikeHtmlGarbage(v)) return false;
  if (key === "unitAddress") {
    if (isBlocklistedPropertyAddress(v)) return false;
    if (v.length < 8 || !/\d/.test(v)) return false;
    if (!looksLikeStreetAddressValue(v)) return false;
  }
  if (key === "wifiName" || key === "wifiPassword") {
    if (/guideline|unsubscribe|click here|view (?:in|online)|http/i.test(v)) return false;
    if (v.length > 80) return false;
  }
  // A network NAME that still carries a password label is an unsplit combined
  // capture — reject it so a corrupt stored value heals on the next reconcile.
  if (key === "wifiName" && WIFI_PASSWORD_LABEL_RE.test(v)) return false;
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

export function parseArrivalDetailsFromText(
  body: string,
  opts?: {
    buyIn?: { propertyName?: string | null; notes?: string | null; unitLabel?: string | null } | null;
    communityState?: string | null;
  },
): Record<string, string> {
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
    // Sentence form: "The pool gate code is: C7601." — tight capture so the
    // trailing prose can't bloat the value past the code-length guard.
    /(?:pool\s+|community\s+|resort\s+)?gate\s*code\s+is\s*[:\-]?\s*([A-Za-z0-9#*][A-Za-z0-9#*\-]{2,11})/i,
  ]);
  const elevatorCode = pick("accessCode", [
    /(?:elevator\s*(?:code|#|passcode)?|lift\s*code)\s*[:\-]\s*([^\n]+)/i,
  ]);
  const doorCode = pick("accessCode", [
    /(?:door\s*(?:code|#|passcode)?|unit\s*(?:code|door code)|lockbox\s*code|keypad\s*code)\s*[:\-]\s*([^\n]+)/i,
    /(?:access code|entry code)\s*[:\-]\s*([^\n]+)/i,
    // Sentence form: "The door code is 6509." — hosts write codes in prose at
    // least as often as in "Door code:" label lines (the 2026-07-20 Menehune
    // arrival email). Tight capture, never [^\n]+.
    /(?:door|entry|access|keypad|lockbox)\s*code\s+is\s*[:\-]?\s*([A-Za-z0-9#*][A-Za-z0-9#*\-]{2,11})/i,
    /(?:your\s+secure\s+code\s+is|secure\s+code)\s*[:\-]?\s*(\d{4,8})\b/i,
  ]);

  let unitAddress = pick("unitAddress", [
    /(?:property address|rental address|unit address|where you['']?ll stay|where you'll stay)\s*[:\-]\s*([^\n]+)/i,
    /(?:check-?in(?: location)?|arrival(?: location)?)\s*[:\-]\s*([^\n]+)/i,
  ]);
  if (unitAddress && !isPlausiblePropertyAddressForBuyIn(unitAddress, opts?.buyIn, opts?.communityState)) {
    unitAddress = "";
  }
  if (!unitAddress) {
    unitAddress = pickBestPropertyAddressFromText(text, opts?.buyIn, opts?.communityState);
  }

  const accessCode = doorCode || pick("accessCode", [
    /(?:access code|door code|lockbox code|entry code|keypad code)\s*[:\-]\s*([^\n]+)/i,
    /(?:your\s+secure\s+code\s+is|secure\s+code)\s*[:\-]?\s*(\d{4,8})\b/i,
  ]);
  let wifiPassword = stripWrappingQuotes(pick("wifiPassword", [
    /(?:wi-?fi\s*password|network\s*password)\s*[:\-]\s*([^\n]+)/i,
  ]));
  // Wi-Fi name: split BEFORE the usable-field check — a one-line
  // "Wi-Fi: 'Name' PASSWORD: 'secret'" capture must become two fields, never
  // one combined wifiName (isUsableArrivalField rejects unsplit captures).
  let wifiName = "";
  const wifiNamePatterns = [
    /(?:wi-?fi(?:\s*network)?(?:\s*name)?|network name|ssid)\s*[:\-]\s*([^\n]+)/i,
  ];
  for (const pattern of wifiNamePatterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const rawCapture = stripHtmlForEmailParse(match[1]).replace(/\s+/g, " ").trim();
    const split = splitWifiNameAndPassword(rawCapture);
    const nameCandidate = stripWrappingQuotes(split ? split.name : rawCapture);
    if (nameCandidate && isUsableArrivalField("wifiName", nameCandidate)) {
      wifiName = nameCandidate.slice(0, 500);
    }
    if (!wifiPassword && split?.password && isUsableArrivalField("wifiPassword", split.password)) {
      wifiPassword = split.password.slice(0, 500);
    }
    if (wifiName) break;
  }
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

// Derive the SMTP host for a mailbox from its IMAP host — the send + receive
// legs of one mailbox live on the same provider. `imap.gmail.com` → `smtp.gmail.com`,
// `imap-mail.outlook.com` → `smtp-mail.outlook.com`, `imap.fastmail.com` →
// `smtp.fastmail.com`. Returns null when the host doesn't start with an `imap`
// label (we can't safely guess), so the caller falls back / reports unconfigured.
export function smtpHostFromImapHost(imapHost: string): string | null {
  const h = String(imapHost ?? "").trim().toLowerCase();
  if (!h || !/^imap/.test(h)) return null;
  return h.replace(/^imap/, "smtp");
}

export type ResolvedSmtpConfig = {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure: boolean;
  source: "smtp-env" | "reservations-mailbox";
};

// Resolve outbound SMTP credentials. Prefer the dedicated SMTP_* env vars, but
// when they're absent fall back to the reservations-mailbox credentials the app
// already uses to READ alias mail over IMAP (guestInboxImapConfig). The same
// Gmail app password authenticates both IMAP and SMTP, so the outbound leg works
// with zero extra config whenever the inbound alias inbox is working — which is
// exactly the state a live deploy is in (SimpleLogin forwards to the mailbox and
// we poll it over IMAP). Returns null only when no password exists anywhere or
// the host can't be resolved (set SMTP_HOST explicitly for a non-`imap.*` host).
export function resolveBuyInSmtpConfig(): ResolvedSmtpConfig | null {
  const envHost = (process.env.SMTP_HOST || "").trim();
  const envUser = (process.env.SMTP_USER || "").trim();
  const envPass = process.env.SMTP_PASS || "";
  const envPortRaw = Number(process.env.SMTP_PORT || 0);
  const envPort = Number.isFinite(envPortRaw) && envPortRaw > 0 ? envPortRaw : null;
  const secureEnv = String(process.env.SMTP_SECURE || "").toLowerCase() === "true";

  // Full dedicated SMTP config present → use it verbatim (unchanged behavior).
  if (envHost && envUser && envPass) {
    const port = envPort ?? 587;
    return { host: envHost, port, user: envUser, pass: envPass, secure: secureEnv || port === 465, source: "smtp-env" };
  }

  // Fall back to the reservations-mailbox (IMAP) credentials for any missing piece.
  const imap = guestInboxImapConfig();
  const user = envUser || imap.user;
  const pass = envPass || imap.pass;
  const host = envHost || smtpHostFromImapHost(imap.host);
  if (!user || !pass || !host) return null;
  const port = envPort ?? (secureEnv ? 465 : 587);
  return { host, port, user, pass, secure: secureEnv || port === 465, source: "reservations-mailbox" };
}

export function buyInEmailSendConfigured(): boolean {
  return resolveBuyInSmtpConfig() != null;
}

export async function sendBuyInEmail(input: {
  from: string;
  to: string;
  subject: string;
  body: string;
  attachments?: BuyInEmailAttachment[];
}): Promise<{ messageId?: string }> {
  const config = resolveBuyInSmtpConfig();
  if (!config) {
    throw new Error(
      "Email sending is not configured — set SMTP_HOST/SMTP_USER/SMTP_PASS, or the reservations-mailbox IMAP credentials (RESERVATIONS_IMAP_PASSWORD / GMAIL_APP_PASSWORD) used to read the alias inbox",
    );
  }
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
  });
  const result = await transporter.sendMail({
    from: input.from,
    // Envelope MAIL FROM = the authenticated mailbox, so Gmail accepts the send
    // even when the visible From header is a send-as address (e.g. SMTP_FROM /
    // RESERVATIONS_EMAIL). When they're equal, nodemailer adds no Sender: header.
    sender: config.user,
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
