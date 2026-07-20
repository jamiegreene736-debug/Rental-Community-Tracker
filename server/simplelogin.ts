import { createHash } from "node:crypto";

type SimpleLoginSuffix = {
  suffix: string;
  signed_suffix: string;
  is_custom?: boolean;
};

type SimpleLoginMailbox = {
  id: number;
  email: string;
  default?: boolean;
  verified?: boolean;
};

const SIMPLELOGIN_BASE_URL = process.env.SIMPLELOGIN_BASE_URL || "https://app.simplelogin.io";
export const SIMPLELOGIN_MAILBOX_EMAIL = process.env.SIMPLELOGIN_MAILBOX_EMAIL || "reservations@magicalislandvacations.com";

function simpleLoginApiKey(): string {
  const key = process.env.SIMPLELOGIN_API_KEY || process.env.SIMPLELOGIN_API_CODE || "";
  if (!key) throw new Error("SIMPLELOGIN_API_KEY is not configured");
  return key;
}

async function simpleLoginRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${SIMPLELOGIN_BASE_URL}${path}`, {
    method,
    headers: {
      "Authentication": simpleLoginApiKey(),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || `SimpleLogin ${method} ${path} failed (${response.status})`);
  }
  return payload as T;
}

/** "Jacelyn Tsu" -> "jacelyn.tsu" (first two name tokens, slugged). */
export function aliasGuestNameBase(guestName: string | null | undefined): string {
  const parts = String(guestName || "guest")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : parts[0] || "guest";
}

export function aliasPrefixForGuest(guestName: string | null | undefined, reservationId: string): string {
  const base = aliasGuestNameBase(guestName);
  const safeReservation = reservationId.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(-6);
  return `${base}.${safeReservation || Date.now().toString(36)}`.replace(/^\.+|\.+$/g, "");
}

// Per-unit numeric tail: a deterministic 6-digit number derived from
// (reservationId, unit token), so two units on one reservation get COMPLETELY
// different trailing numbers (operator 2026-07-20: aliases must stay
// `first.last.<numbers>` \u2014 no "unit.b." words \u2014 but the numbers must differ
// visibly, not by one trailing character). Deterministic so a retried mint
// walks the same candidates; cross-reservation uniqueness comes from hashing
// the full reservation id (rare collisions fall through the buyInId/entropy
// candidates when SimpleLogin says "already exists").
export function aliasUnitNumericTail(reservationId: string, unitKey: string): string {
  const digest = createHash("sha1").update(`${reservationId}|${unitKey}`).digest("hex");
  return String(parseInt(digest.slice(0, 12), 16) % 1_000_000).padStart(6, "0");
}

// Short slug for a unit label: "Unit B" -> "b", "Unit 812" -> "812". Empty when
// the label carries no distinguishing token.
export function aliasUnitToken(unitLabel: string | null | undefined): string {
  return String(unitLabel ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\bunit\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, ".");
}

// Ordered alias prefixes to try for a reservation(+unit) alias. The base prefix
// is guest+reservation; two units on ONE reservation would collide on it, so a
// unit-scoped alias appends the unit token. Later entries only matter when
// SimpleLogin says an earlier one "already exists" (e.g. a prior attempt minted
// the alias but the DB insert failed): buyInId is a guaranteed-unique
// disambiguator, and the entropy tail is the last resort that always succeeds.
export function aliasPrefixCandidates(input: {
  guestName?: string | null;
  reservationId: string;
  unitLabel?: string | null;
  buyInId?: number | null;
  entropy?: string;
}): string[] {
  const unitToken = aliasUnitToken(input.unitLabel);
  // Unit-scoped aliases are `first.last.<6-digit tail>` where the tail derives
  // from (reservation, unit) — two units on one reservation get COMPLETELY
  // different trailing numbers (jacelyn.tsu.417382@ vs jacelyn.tsu.902165@).
  // Operator 2026-07-20 (supersedes the same-day "unit.b." lead-in, which read
  // "super weird"): keep the clean firstname.lastname shape and just make the
  // NUMBERS at the end differ — the original `<res6>.a`/`<res6>.b` tails
  // differed by one trailing character and read as the same alias.
  // Reservation-level aliases (no unit token) keep the historical guest+res6
  // base.
  const base = unitToken
    ? `${aliasGuestNameBase(input.guestName)}.${aliasUnitNumericTail(input.reservationId, unitToken)}`
    : aliasPrefixForGuest(input.guestName, input.reservationId);
  const candidates = [base];
  if (typeof input.buyInId === "number" && Number.isFinite(input.buyInId)) {
    candidates.push(`${base}.b${input.buyInId}`);
  }
  candidates.push(`${base}.${(input.entropy || Date.now().toString(36)).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(-6)}`);
  return Array.from(new Set(candidates));
}

// SimpleLogin rejects a duplicate prefix with e.g. "alias x@y already exists".
export function isSimpleLoginAliasExistsError(err: unknown): boolean {
  return /already|in use|exist|duplicate|taken/i.test(String((err as any)?.message ?? err ?? ""));
}

export function extractEmailAddress(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  const angle = raw.match(/<([^>]+)>/);
  return (angle?.[1] ?? raw).trim();
}

export function extractSimpleLoginAliasEmail(payload: any): string {
  return String(
    payload?.email
    ?? payload?.alias
    ?? payload?.alias_email
    ?? payload?.data?.email
    ?? payload?.data?.alias
    ?? payload?.data?.alias_email
    ?? "",
  ).trim();
}

export function extractSimpleLoginAliasId(payload: any): number | null {
  const raw = payload?.id
    ?? payload?.alias_id
    ?? payload?.aliasId
    ?? payload?.data?.id
    ?? payload?.data?.alias_id
    ?? payload?.data?.aliasId;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function extractSimpleLoginContactId(payload: any): number | null {
  const raw = payload?.id
    ?? payload?.contact_id
    ?? payload?.contactId
    ?? payload?.contact?.id
    ?? payload?.data?.id
    ?? payload?.data?.contact_id
    ?? payload?.data?.contactId;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function extractSimpleLoginReverseAlias(payload: any): string {
  return String(
    payload?.reverse_alias
    ?? payload?.reverseAlias
    ?? payload?.reverse_alias_address
    ?? payload?.email
    ?? payload?.contact?.reverse_alias
    ?? payload?.contact?.reverseAlias
    ?? payload?.data?.reverse_alias
    ?? payload?.data?.reverseAlias
    ?? payload?.data?.email
    ?? "",
  ).trim();
}

export async function getSimpleLoginStatus(): Promise<{
  configured: boolean;
  mailboxEmail: string;
  user?: { email?: string; is_premium?: boolean };
  mailboxes?: SimpleLoginMailbox[];
}> {
  if (!process.env.SIMPLELOGIN_API_KEY && !process.env.SIMPLELOGIN_API_CODE) {
    return { configured: false, mailboxEmail: SIMPLELOGIN_MAILBOX_EMAIL };
  }
  const [user, mailboxPayload] = await Promise.all([
    simpleLoginRequest<any>("GET", "/api/user_info"),
    simpleLoginRequest<{ mailboxes: SimpleLoginMailbox[] }>("GET", "/api/v2/mailboxes"),
  ]);
  return {
    configured: true,
    mailboxEmail: SIMPLELOGIN_MAILBOX_EMAIL,
    user,
    mailboxes: mailboxPayload.mailboxes ?? [],
  };
}

export async function createSimpleLoginAlias(input: {
  prefix: string;
  guestName?: string | null;
  note?: string;
  // Force the alias onto a SPECIFIC custom domain (e.g. "emailprivaccy.com") so
  // the address is exactly <prefix>@<domain>. Throws if that domain isn't a
  // verified custom domain in the SimpleLogin account. Falls back to the env
  // preference / first custom suffix when omitted (other callers' behavior).
  domain?: string | null;
}): Promise<any> {
  const options = await simpleLoginRequest<{ suffixes: SimpleLoginSuffix[] }>(
    "GET",
    "/api/v5/alias/options?hostname=nexstay.operations",
  );
  const suffixes = options.suffixes ?? [];
  const wantDomain = (input.domain || process.env.SIMPLELOGIN_ALIAS_SUFFIX || process.env.SIMPLELOGIN_ALIAS_DOMAIN || "")
    .trim().toLowerCase().replace(/^@/, "");
  let suffix: SimpleLoginSuffix | undefined;
  if (wantDomain) {
    // Prefer the bare "@domain" suffix (so we get prefix@domain, not
    // prefix.word@domain), then any suffix on that domain.
    suffix = suffixes.find((s) => s.suffix.toLowerCase() === `@${wantDomain}`)
      ?? suffixes.find((s) => s.suffix.toLowerCase().includes(wantDomain));
    if (!suffix && input.domain) {
      throw new Error(`SimpleLogin has no alias suffix for "${input.domain}". Add + verify that custom domain in SimpleLogin first.`);
    }
  }
  suffix = suffix
    ?? suffixes.find((s) => s.is_custom)
    ?? suffixes[0];
  if (!suffix) throw new Error("SimpleLogin returned no alias suffixes");

  const mailboxPayload = await simpleLoginRequest<{ mailboxes: SimpleLoginMailbox[] }>("GET", "/api/v2/mailboxes");
  const mailbox = (mailboxPayload.mailboxes ?? []).find((m) => m.email.toLowerCase() === SIMPLELOGIN_MAILBOX_EMAIL.toLowerCase())
    ?? (mailboxPayload.mailboxes ?? []).find((m) => m.default && m.verified !== false)
    ?? mailboxPayload.mailboxes?.[0];
  if (!mailbox) throw new Error(`No SimpleLogin mailbox found for ${SIMPLELOGIN_MAILBOX_EMAIL}`);
  if (mailbox.email.toLowerCase() !== SIMPLELOGIN_MAILBOX_EMAIL.toLowerCase()) {
    throw new Error(`SimpleLogin mailbox ${SIMPLELOGIN_MAILBOX_EMAIL} was not found. Add and verify it in SimpleLogin first.`);
  }

  return simpleLoginRequest<any>("POST", "/api/v3/alias/custom/new?hostname=nexstay.operations", {
    alias_prefix: input.prefix,
    signed_suffix: suffix.signed_suffix,
    mailbox_ids: [mailbox.id],
    note: input.note ?? null,
    name: input.guestName ?? null,
  });
}

export async function createSimpleLoginContact(aliasId: number, vendorEmail: string, vendorName?: string | null): Promise<any> {
  const contact = vendorName?.trim()
    ? `${vendorName.trim()} <${vendorEmail.trim()}>`
    : vendorEmail.trim();
  return simpleLoginRequest<any>("POST", `/api/aliases/${aliasId}/contacts`, { contact });
}
