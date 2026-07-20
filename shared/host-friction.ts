// HOST FRICTION — how demanding is a buy-in host? (operator spec 2026-07-20:
// "some hosts are super chill and send me the arrival instructions. Other
// hosts... need a photo ID verification, contract signed, etc. — research
// online as we are looking for the buy in if we can know if they are tough").
//
// Two independent evidence sources, one badge:
//   1. LISTING RESEARCH (pre-booking) — the Cowork find prompt grades each
//      pick from its public listing (house-rules rental-agreement disclosure,
//      ID/verification rules, professional-PM vs individual host, review
//      complaints) and records the grade as a " · Host friction: ..." notes
//      segment on the created buy-in. Parsed here by hostFrictionFromNotes.
//   2. THE FRICTION LEDGER (ground truth) — what each management company
//      ACTUALLY demanded of us in past buy-ins, classified from the alias
//      inboxes (contract/e-sign requests, ID-verification demands, guest
//      registration forms vs plain arrival instructions), keyed by normalized
//      management-company name in app_settings `host_friction_ledger.v1`.
//      The ledger is a DERIVED CACHE of the stored emails: the scan rebuilds
//      it wholesale (buildHostFrictionLedger), so re-scans are trivially
//      idempotent and a mis-classification heals on the next scan.
//
// PRECEDENCE (load-bearing): a ledger grade for the buy-in's management
// company BEATS the notes grade — our real experience with that PM outranks
// what their listing discloses (many tough hosts only spring the contract by
// email after booking).
//
// NOTES-FORMAT SAFETY (load-bearing, same rule as the booking-mode segment):
// the notes segment is " · "-joined AFTER the listing title —
// titleFromBuyInNoteText's capture stops at "·", so appended segments never
// leak into the parsed title. Never move it before the title.
//
// Pure + zero-dep so every piece is unit-testable (tests/host-friction.test.ts).

export type HostFrictionGrade = "low" | "medium" | "high";

export const HOST_FRICTION_LEDGER_KEY = "host_friction_ledger.v1";

// ─────────────────────────────────────────────────────────────────────────────
// Notes segment — written by the Cowork find prompt, parsed for the badge.
// Shape: " · Host friction: <low|medium|high> — <short reason>"
// ─────────────────────────────────────────────────────────────────────────────

// Tolerant on purpose: grade case-insensitive, reason separated by an em/en
// dash, hyphen, or colon, reason optional (an agent that drops it still gets
// a badge). Anchored on the literal "Host friction:" label so ordinary notes
// text ("high season", "low floor") can never false-positive.
const HOST_FRICTION_NOTES_RE = /host friction:\s*(low|medium|high)\b\s*(?:[—–:-]\s*([^·]*))?/i;

export interface HostFrictionFromNotes {
  grade: HostFrictionGrade;
  reason: string | null;
}

export function hostFrictionFromNotes(notes: string | null | undefined): HostFrictionFromNotes | null {
  const m = String(notes ?? "").match(HOST_FRICTION_NOTES_RE);
  if (!m) return null;
  const grade = m[1].toLowerCase() as HostFrictionGrade;
  const reason = (m[2] ?? "").trim().replace(/\s+/g, " ").slice(0, 200) || null;
  return { grade, reason };
}

// ─────────────────────────────────────────────────────────────────────────────
// Email classification — what did this host's emails actually demand?
// ─────────────────────────────────────────────────────────────────────────────

export type HostFrictionSignalKind =
  | "contract" // signed rental agreement / e-sign request
  | "id_verification" // photo/government ID, identity-verification service
  | "guest_form" // guest registration / pre-check-in form
  | "arrival_instructions"; // door codes / check-in instructions (the chill signal)

export interface HostFrictionEmailSignal {
  kind: HostFrictionSignalKind;
  /** The matching line, verbatim (trimmed, capped) — evidence, never a paraphrase. */
  quote: string;
}

// Line-anchored so the quote is real evidence. Deliberately conservative:
// each pattern names the demand explicitly ("rental agreement", "photo ID",
// "registration form") — generic words like "sign" or "verify" alone never
// match, so a marketing footer can't brand a chill host as tough.
const SIGNAL_PATTERNS: Array<{ kind: HostFrictionSignalKind; re: RegExp }> = [
  { kind: "contract", re: /\b(?:rental|lease|guest|vacation[- ]rental)\s+(?:agreement|contract)\b/i },
  { kind: "contract", re: /\bsign(?:ed|ing)?\b[^.\n]{0,40}\b(?:agreement|contract)\b/i },
  { kind: "contract", re: /\b(?:docusign|hello\s?sign|dropbox sign|signnow|adobe sign)\b/i },
  { kind: "id_verification", re: /\b(?:government|photo|picture)[- ](?:issued\s+)?i\.?d\b/i },
  { kind: "id_verification", re: /\bcopy of (?:your |the )?(?:driver'?s? licen[cs]e|passport|photo id)\b/i },
  { kind: "id_verification", re: /\b(?:identity|id) verification\b/i },
  { kind: "id_verification", re: /\bverify (?:your|the guest'?s?) identity\b/i },
  // Guest-screening services PMs outsource verification to.
  { kind: "id_verification", re: /\b(?:autohost|superhog|know your guest|chekin)\b/i },
  { kind: "guest_form", re: /\b(?:guest|check[- ]?in|pre[- ]?(?:arrival|check[- ]?in)|registration)\s+form\b/i },
  { kind: "guest_form", re: /\bguest registration\b/i },
  { kind: "guest_form", re: /\brental application\b/i },
  { kind: "arrival_instructions", re: /\b(?:door|gate|entry|access|lock\s?box|keypad)\s+code\b/i },
  { kind: "arrival_instructions", re: /\b(?:arrival|check[- ]?in) instructions\b/i },
  { kind: "arrival_instructions", re: /\block\s?box\b/i },
];

/**
 * Classify ONE inbound email's subject+text into friction signals. Returns at
 * most one signal per kind (the first matching line wins as the quote). The
 * caller supplies readable text (MIME-healed, HTML-stripped) — reuse the
 * arrival-extraction corpus, never raw stored bodies.
 */
export function frictionSignalsFromEmailText(
  subject: string | null | undefined,
  text: string | null | undefined,
): HostFrictionEmailSignal[] {
  const lines = `${String(subject ?? "")}\n${String(text ?? "")}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const found = new Map<HostFrictionSignalKind, string>();
  for (const line of lines) {
    for (const { kind, re } of SIGNAL_PATTERNS) {
      if (found.has(kind)) continue;
      if (re.test(line)) found.set(kind, line.replace(/\s+/g, " ").slice(0, 160));
    }
    if (found.size === SIGNAL_PATTERNS.length) break;
  }
  return Array.from(found.entries()).map(([kind, quote]) => ({ kind, quote }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Management-company key normalization
// ─────────────────────────────────────────────────────────────────────────────

// Names that are not a property manager: OTAs/channels and placeholder junk.
// A ledger keyed on "vrbo" would fold unrelated hosts into one entry.
const NON_PM_KEYS = new Set([
  "vrbo",
  "airbnb",
  "booking",
  "booking com",
  "bookingcom",
  "expedia",
  "homeaway",
  "unknown",
  "none",
  "n a",
  "na",
  "tbd",
  "host",
  "owner",
  "private owner",
]);

/** Normalize a management-company name to a stable ledger key ("" = unusable). */
export function normalizeManagementCompanyKey(name: string | null | undefined): string {
  const key = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:llc|inc|co|ltd|corp|corporation|company)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (key.length < 3) return "";
  if (NON_PM_KEYS.has(key)) return "";
  return key;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger store shapes + rebuild
// ─────────────────────────────────────────────────────────────────────────────

export interface HostFrictionSignalCounts {
  /** Number of BUY-INS (not raw emails) where each signal appeared. */
  contract: number;
  id_verification: number;
  guest_form: number;
  arrival_instructions: number;
}

export interface HostFrictionLedgerEntry {
  /** normalizeManagementCompanyKey output — the lookup key. */
  key: string;
  /** Display name as first observed (original casing). */
  company: string;
  grade: HostFrictionGrade;
  counts: HostFrictionSignalCounts;
  /** Distinct buy-ins that contributed evidence (capped). */
  buyInIds: number[];
  /** A few verbatim evidence lines, demand quotes first (capped). */
  examples: string[];
  updatedAt: string;
}

export interface HostFrictionLedger {
  entries: HostFrictionLedgerEntry[];
  /** When the last full rebuild ran (ISO) — drives lazy re-scan freshness. */
  scannedAt: string | null;
}

const MAX_LEDGER_ENTRIES = 300;
const MAX_BUYIN_IDS_PER_ENTRY = 20;
const MAX_EXAMPLES_PER_ENTRY = 3;

export function parseHostFrictionLedger(raw: string | null | undefined): HostFrictionLedger {
  const empty: HostFrictionLedger = { entries: [], scannedAt: null };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return empty;
    const entries: HostFrictionLedgerEntry[] = [];
    for (const e of Array.isArray(parsed.entries) ? parsed.entries : []) {
      const key = typeof e?.key === "string" ? e.key : "";
      const grade = e?.grade === "low" || e?.grade === "medium" || e?.grade === "high" ? e.grade : null;
      if (!key || !grade) continue;
      entries.push({
        key,
        company: typeof e.company === "string" && e.company ? e.company : key,
        grade,
        counts: {
          contract: Number(e?.counts?.contract) || 0,
          id_verification: Number(e?.counts?.id_verification) || 0,
          guest_form: Number(e?.counts?.guest_form) || 0,
          arrival_instructions: Number(e?.counts?.arrival_instructions) || 0,
        },
        buyInIds: (Array.isArray(e.buyInIds) ? e.buyInIds : [])
          .filter((id: unknown) => Number.isInteger(id))
          .slice(0, MAX_BUYIN_IDS_PER_ENTRY),
        examples: (Array.isArray(e.examples) ? e.examples : [])
          .filter((x: unknown) => typeof x === "string" && x)
          .slice(0, MAX_EXAMPLES_PER_ENTRY),
        updatedAt: typeof e.updatedAt === "string" ? e.updatedAt : new Date(0).toISOString(),
      });
    }
    return {
      entries: entries.slice(0, MAX_LEDGER_ENTRIES),
      scannedAt: typeof parsed.scannedAt === "string" ? parsed.scannedAt : null,
    };
  } catch {
    return empty;
  }
}

export function serializeHostFrictionLedger(ledger: HostFrictionLedger): string {
  const entries = [...ledger.entries]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_LEDGER_ENTRIES);
  return JSON.stringify({ entries, scannedAt: ledger.scannedAt ?? null });
}

/**
 * Aggregate grade from per-buy-in signal counts. Deliberately asymmetric:
 * ONE observed demand marks the company (they did it once, they'll do it
 * again), while "low" requires positive chill evidence (arrival instructions
 * with zero demands). No signals at all → null: absence of email evidence is
 * NOT evidence of a chill host — no ledger entry is written.
 */
export function gradeFromSignalCounts(counts: HostFrictionSignalCounts): HostFrictionGrade | null {
  const demands = counts.contract + counts.id_verification + counts.guest_form;
  if (counts.contract > 0 && counts.id_verification > 0) return "high";
  if (demands > 0) return "medium";
  if (counts.arrival_instructions > 0) return "low";
  return null;
}

export interface HostFrictionObservation {
  company: string;
  buyInId: number;
  /** Union of signal kinds seen across THIS buy-in's inbound emails. */
  signals: HostFrictionEmailSignal[];
}

/**
 * Rebuild the whole ledger from scratch out of per-buy-in observations. A
 * company only earns an entry when its aggregate grade is decidable (see
 * gradeFromSignalCounts) — companies with zero classified signals stay out.
 */
export function buildHostFrictionLedger(observations: HostFrictionObservation[], now: Date): HostFrictionLedger {
  const byKey = new Map<
    string,
    { company: string; counts: HostFrictionSignalCounts; buyInIds: Set<number>; demandQuotes: string[]; chillQuotes: string[] }
  >();
  for (const obs of observations) {
    const key = normalizeManagementCompanyKey(obs.company);
    if (!key || !Number.isInteger(obs.buyInId)) continue;
    let agg = byKey.get(key);
    if (!agg) {
      agg = {
        company: String(obs.company).trim(),
        counts: { contract: 0, id_verification: 0, guest_form: 0, arrival_instructions: 0 },
        buyInIds: new Set(),
        demandQuotes: [],
        chillQuotes: [],
      };
      byKey.set(key, agg);
    }
    if (agg.buyInIds.has(obs.buyInId)) continue; // one contribution per buy-in
    agg.buyInIds.add(obs.buyInId);
    const kinds = new Set(obs.signals.map((s) => s.kind));
    for (const kind of Array.from(kinds)) agg.counts[kind] += 1;
    for (const s of obs.signals) {
      const bucket = s.kind === "arrival_instructions" ? agg.chillQuotes : agg.demandQuotes;
      if (bucket.length < MAX_EXAMPLES_PER_ENTRY) bucket.push(s.quote);
    }
  }

  const entries: HostFrictionLedgerEntry[] = [];
  for (const [key, agg] of Array.from(byKey.entries())) {
    const grade = gradeFromSignalCounts(agg.counts);
    if (!grade) continue;
    entries.push({
      key,
      company: agg.company,
      grade,
      counts: agg.counts,
      buyInIds: Array.from(agg.buyInIds).slice(0, MAX_BUYIN_IDS_PER_ENTRY),
      // Demand evidence first — that's what the operator needs to see.
      examples: [...agg.demandQuotes, ...agg.chillQuotes].slice(0, MAX_EXAMPLES_PER_ENTRY),
      updatedAt: now.toISOString(),
    });
  }
  return { entries: entries.slice(0, MAX_LEDGER_ENTRIES), scannedAt: now.toISOString() };
}

export function ledgerEntryForCompany(
  ledger: HostFrictionLedger | null | undefined,
  company: string | null | undefined,
): HostFrictionLedgerEntry | null {
  const key = normalizeManagementCompanyKey(company);
  if (!key || !ledger) return null;
  return ledger.entries.find((e) => e.key === key) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Badge — one derivation per attached unit slot card
// ─────────────────────────────────────────────────────────────────────────────

export interface UnitHostFrictionBadge {
  grade: HostFrictionGrade;
  /** Short badge text, e.g. "✓ Chill host". */
  label: string;
  /** emerald = chill, amber = expect paperwork. */
  tone: "emerald" | "amber";
  /** Hover text: evidence + where the grade came from. */
  title: string;
  source: "ledger" | "notes";
}

function labelForGrade(grade: HostFrictionGrade): { label: string; tone: "emerald" | "amber" } {
  if (grade === "low") return { label: "✓ Chill host", tone: "emerald" };
  if (grade === "medium") return { label: "⚠ Verification likely", tone: "amber" };
  return { label: "⚠ Contract + ID host", tone: "amber" };
}

function describeCounts(counts: HostFrictionSignalCounts): string {
  const parts: string[] = [];
  if (counts.contract > 0) parts.push(`contract/e-sign (${counts.contract})`);
  if (counts.id_verification > 0) parts.push(`ID verification (${counts.id_verification})`);
  if (counts.guest_form > 0) parts.push(`guest forms (${counts.guest_form})`);
  if (counts.arrival_instructions > 0) parts.push(`arrival instructions (${counts.arrival_instructions})`);
  return parts.join(", ");
}

/**
 * Derive the friction badge for one attached buy-in. The FRICTION LEDGER
 * (our real history with the buy-in's management company) wins over the
 * find-time listing-research grade in the notes; neither → null (no badge —
 * never render an unfounded "chill" claim).
 */
export function unitHostFrictionBadge(
  buyIn: { notes?: string | null; managementCompany?: string | null } | null | undefined,
  ledger?: HostFrictionLedger | null,
): UnitHostFrictionBadge | null {
  if (!buyIn) return null;

  const entry = ledgerEntryForCompany(ledger, buyIn.managementCompany);
  if (entry) {
    const { label, tone } = labelForGrade(entry.grade);
    const n = entry.buyInIds.length;
    const evidence = describeCounts(entry.counts);
    const example = entry.examples[0] ? ` — e.g. "${entry.examples[0]}"` : "";
    return {
      grade: entry.grade,
      label,
      tone,
      title: `Host friction ${entry.grade.toUpperCase()} — known from ${n} past buy-in${n === 1 ? "" : "s"} with ${entry.company}: ${evidence || "email history"}${example}`,
      source: "ledger",
    };
  }

  const fromNotes = hostFrictionFromNotes(buyIn.notes);
  if (fromNotes) {
    const { label, tone } = labelForGrade(fromNotes.grade);
    return {
      grade: fromNotes.grade,
      label,
      tone,
      title: `Host friction ${fromNotes.grade.toUpperCase()} — from listing research at find time${fromNotes.reason ? `: ${fromNotes.reason}` : ""}`,
      source: "notes",
    };
  }

  return null;
}
