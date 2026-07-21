// OpenPhone webhook signature verification (2026-07-21) — pure, so the test
// suite needs no DATABASE_URL. OpenPhone signs every delivery:
//   openphone-signature: hmac;1;<timestamp>;<base64 sig>
// where sig = base64(HMAC-SHA256(base64decode(webhook.key), `${ts}.${rawBody}`)).
// rawBody must be the EXACT request bytes (server/index.ts captures req.rawBody).
import { createHmac, timingSafeEqual } from "crypto";

export function verifyOpenPhoneSignature(
  rawBody: Buffer | string | null | undefined,
  header: unknown,
  keys: string[],
): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string" || !value || rawBody == null || keys.length === 0) return false;
  const parts = value.split(";");
  if (parts.length < 4 || parts[0] !== "hmac") return false;
  const timestamp = parts[2];
  const presented = parts[3];
  if (!timestamp || !presented) return false;
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const data = `${timestamp}.${body}`;
  for (const key of keys) {
    try {
      const expected = createHmac("sha256", Buffer.from(key, "base64")).update(data).digest("base64");
      const a = Buffer.from(expected);
      const b = Buffer.from(presented);
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    } catch {
      // bad key shape — try the next
    }
  }
  return false;
}
