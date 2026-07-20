// PM text-message thread (operator ask 2026-07-20: "add another place for me
// to text back and forth with the management company" in the unit buy-in
// section, beside the email history).
//
// Pure helpers shared by the routes (server) and the buy-in panel (client).
// The thread itself is the EXISTING quo_sms_messages mirror table — outbound
// via sendQuoSms (the same engine that texts guests), inbound via the Quo
// webhook — filtered to the PM's phone number. No new tables.

/**
 * First phone-shaped token in a managementContact-style string ("(808)
 * 879-6284 · info@aliiresorts.com" → "+18088796284"). US 10-digit shapes with
 * optional +1/1 prefix; a digit run embedded in something longer (reservation
 * numbers, confirmation codes) never matches. Returns "" when nothing
 * plausible is found — a wrong number texted to a stranger is worse than an
 * empty input.
 */
export function extractPhoneForSms(value: string | null | undefined): string {
  const text = String(value ?? "");
  const re = /(?:\+?1[\s.\-]?)?(?:\(\d{3}\)|\d{3})[\s.\-]?\d{3}[\s.\-]?\d{4}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    // Boundary check without lookbehind: the char before/after must not be a
    // digit (embedded-run guard).
    if (start > 0 && /\d/.test(text[start - 1]!)) continue;
    if (end < text.length && /\d/.test(text[end]!)) continue;
    const digits = match[0].replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  }
  return "";
}

/** Last 10 digits — the thread key quo_sms_messages rows are matched on. */
export function pmSmsPhoneKey(value: string | null | undefined): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
}

/**
 * The guestName label stamped on outbound PM texts so they're distinguishable
 * from guest SMS anywhere quo_sms_messages rows surface.
 */
export function pmSmsSenderLabel(companyName: string | null | undefined): string {
  const name = String(companyName ?? "").trim();
  return name ? `PM · ${name}` : "PM contact";
}

/**
 * True when a managementContact value has no phone yet — the send route then
 * backfills the texted number into it (never clobbers an existing phone).
 */
export function managementContactNeedsPhone(value: string | null | undefined): boolean {
  return extractPhoneForSms(value) === "";
}

/** "+18088796284" → "(808) 879-6284" for display / managementContact backfill. */
export function formatPmSmsPhone(value: string | null | undefined): string {
  const key = pmSmsPhoneKey(value);
  if (!key) return String(value ?? "").trim();
  return `(${key.slice(0, 3)}) ${key.slice(3, 6)}-${key.slice(6)}`;
}
