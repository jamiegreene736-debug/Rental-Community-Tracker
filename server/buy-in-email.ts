import nodemailer from "nodemailer";

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
  });
  return { messageId: result.messageId };
}
