// Locks the 2026-07-20 HOST FRICTION feature (operator: "some hosts are super
// chill and send me the arrival instructions. Other hosts... need a photo ID
// verification, contract signed, etc. — research online as we are looking for
// the buy in if we can know if they are tough"):
//   1. The Cowork find prompt's HOST FRICTION rule + ALWAYS-included
//      " · Host friction: ..." notes segment.
//   2. The pure notes parser / email classifier / ledger rebuild in
//      shared/host-friction.ts.
//   3. The per-unit badge (ledger evidence BEATS the find-time notes grade).
//   4. Source guards on the wiring: routes endpoints, the bookings.tsx badge +
//      ledger query, and the scan's REUSE of the arrival-extraction corpus
//      helpers (aliasCandidatesForBuyIn + extractionMessagesFromSources +
//      extractionEmailsFromMessages — never raw stored bodies).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOST_FRICTION_LEDGER_KEY,
  buildHostFrictionLedger,
  frictionSignalsFromEmailText,
  gradeFromSignalCounts,
  hostFrictionFromNotes,
  ledgerEntryForCompany,
  normalizeManagementCompanyKey,
  parseHostFrictionLedger,
  serializeHostFrictionLedger,
  unitHostFrictionBadge,
  type HostFrictionLedger,
} from "../shared/host-friction";
import { buildCoworkBuyInPrompt, buildCoworkBulkBuyInPrompt } from "../shared/cowork-buyin-prompt";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`, detail ?? "");
  }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

// ── notes segment parser ─────────────────────────────────────────────────────
console.log("host-friction: notes segment parser");
{
  const notes =
    "Manually recorded buy-in for Unit A. Found via Cowork web search — Poipu Kai — Poipu Kai Resort 3BR. · Booking mode: instant book · Host friction: high — rental agreement + photo ID required per house rules";
  const parsed = hostFrictionFromNotes(notes);
  check("parses grade from the full Cowork notes shape", parsed?.grade === "high");
  check("parses the reason and stops before any following segment",
    parsed?.reason === "rental agreement + photo ID required per house rules");
}
check("grade is case-insensitive", hostFrictionFromNotes("… · Host friction: LOW — nothing required")?.grade === "low");
check("hyphen separator accepted", hostFrictionFromNotes("Host friction: medium - professional PM host")?.reason === "professional PM host");
check("reason optional", hostFrictionFromNotes("Host friction: medium")?.grade === "medium" && hostFrictionFromNotes("Host friction: medium")?.reason === null);
check("reason never leaks past the next · segment",
  hostFrictionFromNotes("Host friction: low — individual owner · Booking mode: instant book")?.reason === "individual owner");
check("plain notes never false-positive (no 'Host friction:' label)",
  hostFrictionFromNotes("high season rates, low floor unit, contract pending") === null);
check("null/empty notes → null", hostFrictionFromNotes(null) === null && hostFrictionFromNotes("") === null);
check("unknown grade word rejected", hostFrictionFromNotes("Host friction: extreme — bad") === null);

// ── email classifier ─────────────────────────────────────────────────────────
console.log("host-friction: email signal classifier");
{
  const sigs = frictionSignalsFromEmailText(
    "Action required for your reservation",
    "Aloha! Before check-in, please sign the rental agreement via DocuSign.\nWe also need a copy of your driver's license for our records.",
  );
  const kinds = new Set(sigs.map((s) => s.kind));
  check("contract + ID demands both detected", kinds.has("contract") && kinds.has("id_verification"));
  const contract = sigs.find((s) => s.kind === "contract");
  check("quote is the verbatim matching line", !!contract && /rental agreement/i.test(contract.quote));
}
check("guest registration form detected",
  frictionSignalsFromEmailText("Welcome", "Please complete our guest registration form before arrival.").some((s) => s.kind === "guest_form"));
check("pre-check-in form detected",
  frictionSignalsFromEmailText(null, "Complete the pre-check-in form here").some((s) => s.kind === "guest_form"));
check("screening service (Autohost) counts as ID verification",
  frictionSignalsFromEmailText("Verify your stay", "Your reservation requires screening via Autohost.").some((s) => s.kind === "id_verification"));
check("door code email = arrival_instructions (the chill signal)",
  frictionSignalsFromEmailText("Your Arrival Instructions", "The door code is 6509. Parking is stall 12.")
    .some((s) => s.kind === "arrival_instructions"));
check("check-in instructions phrase detected",
  frictionSignalsFromEmailText("Check-in instructions for Unit 8", "See below").some((s) => s.kind === "arrival_instructions"));
check("one signal per kind even when a demand repeats", (() => {
  const sigs = frictionSignalsFromEmailText(null, "Sign the rental agreement.\nThe rental agreement must be signed.");
  return sigs.filter((s) => s.kind === "contract").length === 1;
})());
check("a plain thanks-for-booking email carries no signals",
  frictionSignalsFromEmailText("Booking confirmed", "Thanks for booking! We look forward to hosting you.").length === 0);
check("'sign' without agreement/contract nearby never matches (marketing footers safe)",
  frictionSignalsFromEmailText(null, "Sign up for our newsletter to get deals.").length === 0);
check("'signature amenities' marketing copy never matches",
  frictionSignalsFromEmailText(null, "Enjoy our signature amenities and services.").length === 0);

// ── company key normalization ────────────────────────────────────────────────
console.log("host-friction: management-company key");
check("suffix + punctuation folded", normalizeManagementCompanyKey("Alii Resorts, LLC") === "alii resorts"
  && normalizeManagementCompanyKey("alii   resorts") === "alii resorts");
check("OTA/channel names are not PM keys", normalizeManagementCompanyKey("VRBO") === "" && normalizeManagementCompanyKey("Booking.com") === "");
check("junk placeholders rejected", normalizeManagementCompanyKey("unknown") === "" && normalizeManagementCompanyKey("n/a") === "" && normalizeManagementCompanyKey("") === "");
check("short residue rejected", normalizeManagementCompanyKey("AB") === "");

// ── grade + ledger rebuild ───────────────────────────────────────────────────
console.log("host-friction: grade + ledger rebuild");
check("contract AND id → high", gradeFromSignalCounts({ contract: 1, id_verification: 1, guest_form: 0, arrival_instructions: 0 }) === "high");
check("one demand → medium", gradeFromSignalCounts({ contract: 0, id_verification: 0, guest_form: 1, arrival_instructions: 2 }) === "medium");
check("arrival instructions only → low", gradeFromSignalCounts({ contract: 0, id_verification: 0, guest_form: 0, arrival_instructions: 1 }) === "low");
check("no signals → null (absence of evidence is not chill)",
  gradeFromSignalCounts({ contract: 0, id_verification: 0, guest_form: 0, arrival_instructions: 0 }) === null);

const now = new Date("2026-07-20T12:00:00Z");
const ledger = buildHostFrictionLedger(
  [
    { company: "Alii Resorts LLC", buyInId: 1, signals: [{ kind: "contract", quote: "please sign the rental agreement" }] },
    { company: "alii resorts", buyInId: 2, signals: [{ kind: "id_verification", quote: "copy of your driver's license" }] },
    // duplicate buyInId must not double-count
    { company: "Alii Resorts", buyInId: 2, signals: [{ kind: "id_verification", quote: "dup" }] },
    { company: "Kauai Beach Rentals", buyInId: 3, signals: [{ kind: "arrival_instructions", quote: "the door code is 6509" }] },
    { company: "VRBO", buyInId: 4, signals: [{ kind: "contract", quote: "junk" }] },
    { company: "Quiet PM", buyInId: 5, signals: [] },
  ],
  now,
);
check("company variants fold onto one normalized key", ledger.entries.filter((e) => e.key === "alii resorts").length === 1);
{
  const alii = ledger.entries.find((e) => e.key === "alii resorts")!;
  check("contract on one buy-in + ID on another → HIGH (the PM does both)", alii.grade === "high");
  check("per-buy-in dedupe: buyInId 2 counted once", alii.buyInIds.length === 2 && alii.counts.id_verification === 1);
  check("demand quotes lead the examples", /rental agreement|driver/.test(alii.examples[0] ?? ""));
}
check("arrival-instructions-only company → LOW", ledger.entries.find((e) => e.key === "kauai beach rentals")?.grade === "low");
check("OTA-keyed observation never earns an entry", !ledger.entries.some((e) => /vrbo/.test(e.key)));
check("zero-signal company stays out of the ledger", !ledger.entries.some((e) => e.key === "quiet pm"));
check("scannedAt stamped from the rebuild time", ledger.scannedAt === now.toISOString());

// round trip
const roundTripped = parseHostFrictionLedger(serializeHostFrictionLedger(ledger));
check("serialize → parse round-trips entries + scannedAt",
  roundTripped.entries.length === ledger.entries.length && roundTripped.scannedAt === ledger.scannedAt);
check("parse tolerates junk", parseHostFrictionLedger("not json").entries.length === 0
  && parseHostFrictionLedger('{"entries":[{"key":"x","grade":"nope"}]}').entries.length === 0);
check("ledgerEntryForCompany matches through normalization",
  ledgerEntryForCompany(roundTripped, "ALII RESORTS, LLC")?.grade === "high"
  && ledgerEntryForCompany(roundTripped, "Someone Else") === null);
check("store key is versioned", HOST_FRICTION_LEDGER_KEY === "host_friction_ledger.v1");

// ── badge derivation ─────────────────────────────────────────────────────────
console.log("host-friction: badge");
{
  const notesLow = "… · Host friction: low — individual owner, no requirements";
  const badge = unitHostFrictionBadge({ notes: notesLow, managementCompany: "Alii Resorts" }, roundTripped);
  check("LEDGER BEATS NOTES: our real history overrides the listing-research grade",
    badge?.source === "ledger" && badge?.grade === "high" && badge?.tone === "amber");
  check("ledger title carries the evidence + company", !!badge && /past buy-in/.test(badge.title) && /Alii Resorts/.test(badge.title));
}
{
  const badge = unitHostFrictionBadge({ notes: "… · Host friction: low — no requirements visible", managementCompany: "Unknown PM Co" }, roundTripped);
  check("notes fallback when the company has no ledger entry",
    badge?.source === "notes" && badge?.grade === "low" && badge?.label === "✓ Chill host" && badge?.tone === "emerald");
}
check("medium label reads as verification-likely",
  unitHostFrictionBadge({ notes: "Host friction: medium — professional PM" }, null)?.label === "⚠ Verification likely");
check("high label reads as contract+ID",
  unitHostFrictionBadge({ notes: "Host friction: high — agreement and ID" }, null)?.label === "⚠ Contract + ID host");
check("no evidence at all → no badge (never an unfounded chill claim)",
  unitHostFrictionBadge({ notes: "Manually recorded buy-in", managementCompany: null }, roundTripped) === null
  && unitHostFrictionBadge(null, roundTripped) === null);

// ── prompt wiring ────────────────────────────────────────────────────────────
console.log("host-friction: Cowork prompt wiring");
const promptInput = {
  reservationId: "res-1",
  guestName: "Test Guest",
  propertyId: 4,
  propertyName: "Poipu Kai Resort - 6BR Condos",
  community: "Poipu Kai",
  checkIn: "2026-08-01",
  checkOut: "2026-08-08",
  units: [
    { unitId: "u-a", unitLabel: "Unit A", bedrooms: 3 },
    { unitId: "u-b", unitLabel: "Unit B", bedrooms: 3 },
  ],
  baseUrl: "https://app.example.com",
};
const prompt = buildCoworkBuyInPrompt(promptInput);
check("find prompt carries the HOST FRICTION rule", /HOST FRICTION — grade how demanding/.test(prompt));
check("rule names the three grades with the VRBO agreement disclosure",
  /You'll be asked to sign a rental agreement/.test(prompt) && /- low —/.test(prompt) && /- high —/.test(prompt));
check("friction preference is subordinate (never relaxes rules 1–5)",
  /LOWER-friction one —\nthis never overrides the channel or booking-mode preferences and never\nrelaxes rules 1–5/.test(prompt.replace(/\r/g, "")));
check("notes template carries the ALWAYS-included friction segment",
  prompt.includes("· Host friction: <low | medium | high> — <short reason"));
check("notes parenthetical says the segment is always included",
  /The "Host friction:" segment is ALWAYS\s+included/.test(prompt));
check("report asks for the friction grade per pick", /HOST FRICTION grade \(low \/ medium \/ high\)/.test(prompt));
check("the template segment round-trips through the parser", (() => {
  // Simulate an agent filling the template exactly as instructed.
  const filled = "Manually recorded buy-in for Unit A. Found via Cowork web search — Poipu Kai — Title. · Booking mode: instant book · Host friction: medium — professional PM host, agreement per house rules";
  return hostFrictionFromNotes(filled)?.grade === "medium";
})());
check("1-element bulk prompt stays byte-identical to the single prompt",
  buildCoworkBulkBuyInPrompt([promptInput]) === prompt);
check("bulk consolidated report asks for the friction grade",
  /host-friction grade/.test(buildCoworkBulkBuyInPrompt([promptInput, { ...promptInput, reservationId: "res-2" }])));

// ── source guards on the wiring ──────────────────────────────────────────────
console.log("host-friction: source guards");
{
  const routesSrc = read("server/routes.ts");
  check("routes: GET /api/host-friction-ledger served", routesSrc.includes('app.get("/api/host-friction-ledger"'));
  check("routes: POST /api/host-friction-ledger/scan served", routesSrc.includes('app.post("/api/host-friction-ledger/scan"'));
  check("routes: GET lazily refreshes via ensureHostFrictionLedgerFresh", /ensureHostFrictionLedgerFresh\(ledger\)/.test(routesSrc));
}
{
  const scanSrc = read("server/host-friction-ledger.ts");
  check("scan REUSES the arrival-extraction corpus (aliasCandidatesForBuyIn)", /aliasCandidatesForBuyIn\(/.test(scanSrc));
  check("scan merges both mailboxes via extractionMessagesFromSources", /extractionMessagesFromSources\(/.test(scanSrc));
  check("scan classifies healed inbound text via extractionEmailsFromMessages (never raw bodies)",
    /extractionEmailsFromMessages\(/.test(scanSrc));
  check("scan rebuilds the ledger wholesale (buildHostFrictionLedger)", /buildHostFrictionLedger\(/.test(scanSrc));
}
{
  const bookingsSrc = read("client/src/pages/bookings.tsx");
  check("bookings.tsx renders the per-unit friction badge", /unitHostFrictionBadge\(slot\.buyIn, hostFrictionLedger\)/.test(bookingsSrc));
  check("bookings.tsx fetches the ledger", bookingsSrc.includes('queryKey: ["/api/host-friction-ledger"]'));
  check("badge has a stable testid", bookingsSrc.includes("badge-unit-host-friction-"));
}

console.log(`\nhost-friction: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
