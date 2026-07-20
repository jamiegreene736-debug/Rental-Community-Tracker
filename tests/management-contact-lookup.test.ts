import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MANAGEMENT_CONTACT_WEB_CONFIDENCE_FLOOR,
  buildManagementContactPrompt,
  buildManagementContactSourceRecord,
  formatContactPhone,
  formatManagementContactValue,
  isPlausibleEmailAddress,
  isPlausiblePhone,
  parseManagementContactJson,
  phoneDigits,
  validateManagementContact,
  type ManagementContactEmail,
} from "../shared/management-contact-logic";

console.log("management-contact-lookup suite");

const emails: ManagementContactEmail[] = [
  {
    subject: "Your booking is confirmed — Menehune Shores 106",
    fromEmail: "reservations@alohacondos.example.com",
    receivedAt: "2026-07-19T20:00:00.000Z",
    text: [
      "Aloha! Your reservation at Menehune Shores 106 is confirmed.",
      "Your stay is managed locally by Aloha Condos Maui.",
      "Front desk / arrival questions: (808) 555-0142 or arrivals@alohacondos.example.com",
      "Arrival instructions will follow closer to check-in.",
    ].join("\n"),
  },
  {
    subject: "Receipt",
    fromEmail: "billing@vrbo.com",
    receivedAt: "2026-07-19T19:00:00.000Z",
    text: "Amount paid $702.50. Thank you for booking.",
  },
];

// ── prompt ──
const prompt = buildManagementContactPrompt({
  propertyName: "Menehune Shores",
  unitLabel: "Unit A (2BR)",
  unitAddress: "760 S Kihei Rd Unit 106, Kihei, HI 96753",
  listingUrl: "https://www.vrbo.com/1234567",
  communityLabel: null,
  checkIn: "2026-08-01",
  checkOut: "2026-08-08",
  emails,
});
assert.ok(prompt.includes("Menehune Shores"));
assert.ok(prompt.includes("https://www.vrbo.com/1234567"));
assert.ok(prompt.includes("--- EMAIL 0 ---"));
assert.ok(prompt.includes("(808) 555-0142"));
assert.ok(/NEVER invent or approximate/.test(prompt));
assert.ok(/LOCAL\/on-site/.test(prompt));
assert.ok(/never a national OTA support line/i.test(prompt));
// No emails yet → prompt says so instead of an empty block.
assert.ok(
  buildManagementContactPrompt({ propertyName: "X", emails: [] }).includes("(none received yet)"),
);
console.log("  ✓ prompt carries context, emails, and the never-invent rules");

// ── parse ──
const parsed = parseManagementContactJson({
  found: true,
  companyName: "Aloha Condos Maui",
  phone: "(808) 555-0142",
  email: "arrivals@alohacondos.example.com",
  sourceKind: "email",
  emailIndex: 0,
  quote: "Front desk / arrival questions: (808) 555-0142 or arrivals@alohacondos.example.com",
  confidence: 0.95,
  note: "Named in the confirmation email",
});
assert.ok(parsed && parsed.found && parsed.sourceKind === "email" && parsed.emailIndex === 0);
assert.equal(parseManagementContactJson(null), null);
assert.equal(parseManagementContactJson("nope" as any), null);
const parsedWeird = parseManagementContactJson({ found: true, sourceKind: "carrier-pigeon", confidence: 7 })!;
assert.equal(parsedWeird.sourceKind, "web"); // unknown kind defaults to web (strictest gate)
assert.equal(parsedWeird.confidence, 1); // clamped
assert.equal(parseManagementContactJson({ found: true, emailIndex: -2 })!.emailIndex, null);
console.log("  ✓ parse normalizes kinds/confidence and rejects junk shapes");

// ── phone/email plausibility + formatting ──
assert.equal(phoneDigits("(808) 555-0142"), "8085550142");
assert.equal(isPlausiblePhone("(808) 555-0142"), true);
assert.equal(isPlausiblePhone("555"), false);
assert.equal(isPlausiblePhone("12345678901234567"), false);
assert.equal(isPlausibleEmailAddress("arrivals@alohacondos.example.com"), true);
assert.equal(isPlausibleEmailAddress("not-an-email"), false);
assert.equal(formatContactPhone("8085550142"), "(808) 555-0142");
assert.equal(formatContactPhone("18085550142"), "(808) 555-0142");
assert.equal(formatContactPhone("+61 2 5550 1234"), "+61 2 5550 1234"); // non-US left as written
assert.equal(
  formatManagementContactValue({ phone: "808-555-0142", email: "arrivals@alohacondos.example.com" }),
  "(808) 555-0142 · arrivals@alohacondos.example.com",
);
assert.equal(formatManagementContactValue({ phone: "", email: "a@b.co" }), "a@b.co");
console.log("  ✓ phone/email plausibility + display formatting");

// ── validation: email-sourced ──
assert.equal(validateManagementContact(parsed, emails).ok, true);

// A hallucinated phone (digits not in the cited email) is REJECTED even with a
// real-looking quote — the load-bearing honesty gate.
const hallucinatedPhone = { ...parsed!, phone: "(808) 555-9999" };
let v = validateManagementContact(hallucinatedPhone, emails);
assert.equal(v.ok, false);
assert.match((v as any).reason, /not present in the cited email/);

// A quote that isn't verbatim-present is rejected.
v = validateManagementContact({ ...parsed!, quote: "Call our front desk anytime at (808) 555-0142" }, emails);
assert.equal(v.ok, false);

// Email address not present in the cited email is rejected.
v = validateManagementContact({ ...parsed!, email: "desk@elsewhere.example.com" }, emails);
assert.equal(v.ok, false);

// Bad emailIndex is rejected.
v = validateManagementContact({ ...parsed!, emailIndex: 7 }, emails);
assert.equal(v.ok, false);
console.log("  ✓ email-sourced contacts verify verbatim (hallucinations rejected)");

// ── validation: web-sourced ──
const webContact = parseManagementContactJson({
  found: true,
  companyName: "Menehune Shores Front Desk",
  phone: "(808) 555-0177",
  sourceKind: "web",
  sourceUrl: "https://menehuneshores.example.com/contact",
  confidence: 0.85,
  note: "Official resort site contact page",
})!;
assert.equal(validateManagementContact(webContact, emails).ok, true);
v = validateManagementContact({ ...webContact, sourceUrl: "" }, emails);
assert.equal(v.ok, false); // no URL → rejected
v = validateManagementContact({ ...webContact, confidence: MANAGEMENT_CONTACT_WEB_CONFIDENCE_FLOOR - 0.1 }, emails);
assert.equal(v.ok, false); // below floor → rejected
console.log("  ✓ web-sourced contacts need a source URL + confidence floor");

// ── validation: general honesty rules ──
v = validateManagementContact(parseManagementContactJson({ found: false, note: "checked 3 sites, none list a local manager" }), emails);
assert.equal(v.ok, false);
assert.match((v as any).reason, /checked 3 sites/); // honest not-found passes the reason through
v = validateManagementContact({ ...webContact, companyName: "" }, emails);
assert.equal(v.ok, false);
v = validateManagementContact({ ...webContact, phone: "", email: "" }, emails);
assert.equal(v.ok, false); // neither phone nor email
v = validateManagementContact({ ...webContact, companyName: "VRBO Customer Support" }, emails);
assert.equal(v.ok, false); // OTA support line is never the answer
v = validateManagementContact({ ...webContact, phone: "12" }, emails);
assert.equal(v.ok, false); // implausible phone present → reject outright, don't silently drop
assert.equal(validateManagementContact(null, emails).ok, false);
console.log("  ✓ honesty rules: not-found passthrough, OTA support ban, implausible values");

// ── provenance record ──
const record = buildManagementContactSourceRecord({
  contact: parsed!,
  emails,
  searchCount: 2,
  model: "claude-sonnet-4-6",
  now: new Date("2026-07-20T12:00:00.000Z"),
});
assert.equal(record.companyName, "Aloha Condos Maui");
assert.equal(record.emailSubject, "Your booking is confirmed — Menehune Shores 106");
assert.equal(record.emailDate, "2026-07-19T20:00:00.000Z");
assert.equal(record.confirmedAt, "2026-07-20T12:00:00.000Z");
assert.equal(record.searchCount, 2);
const webRecord = buildManagementContactSourceRecord({
  contact: webContact,
  emails,
  searchCount: 4,
  model: "m",
  now: new Date(),
});
assert.equal(webRecord.emailSubject, null); // web source cites a URL, not an email
assert.equal(webRecord.sourceUrl, "https://menehuneshores.example.com/contact");
console.log("  ✓ provenance record carries the cited email / URL evidence");

// ── SOURCE GUARDS: wiring (2026-07-20) ───────────────────────────────────────
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engineSrc = readFileSync(path.join(repoRoot, "server", "management-contact-lookup.ts"), "utf8");
const routesSrc = readFileSync(path.join(repoRoot, "server", "routes.ts"), "utf8");
const schemaSrc = readFileSync(path.join(repoRoot, "shared", "schema.ts"), "utf8");
const maintSrc = readFileSync(path.join(repoRoot, "server", "schema-maintenance.ts"), "utf8");
const bookingsSrc = readFileSync(path.join(repoRoot, "client", "src", "pages", "bookings.tsx"), "utf8");

// Engine: honest no-key failure, kill switch, web-search call, and the shared
// validation gate between Claude's answer and the DB write.
assert.ok(engineSrc.includes("MANAGEMENT_CONTACT_DISABLED_ENV"), "engine must honor the kill switch");
assert.ok(engineSrc.includes("ANTHROPIC_API_KEY is not configured"), "engine must fail honestly with no key (no regex guessing)");
assert.ok(engineSrc.includes("callClaudeWebSearchJson"), "engine must use the web-search Claude helper");
assert.ok(engineSrc.includes("validateManagementContact"), "engine must run the shared honesty gate before persisting");
assert.ok(engineSrc.includes("managementContactSource: record"), "engine must persist the provenance record");
// Route exists and 422s a rejected lookup (never a fake success).
assert.ok(routesSrc.includes('app.post("/api/buy-ins/:id/management-contact-lookup"'), "route must exist");
assert.ok(/management-contact-lookup[\s\S]{0,900}status\(422\)/.test(routesSrc), "route must 422 a rejected lookup");
// Schema column declared in BOTH schema.ts and the boot ALTER.
assert.ok(schemaSrc.includes('managementContactSource: jsonb("management_contact_source")'), "schema.ts must declare the provenance column");
assert.ok(maintSrc.includes("ADD COLUMN IF NOT EXISTS management_contact_source jsonb"), "schema-maintenance must boot-heal the provenance column");
// UI: the button mounts on the attached-unit toolbar AND inside the arrival
// dialog (where onApplied mirrors the saved values into the form).
assert.ok(bookingsSrc.includes("function ConfirmManagementContactButton"), "bookings.tsx must define the button component");
assert.ok((bookingsSrc.match(/<ConfirmManagementContactButton/g) ?? []).length >= 2, "button must mount on the toolbar AND in the arrival dialog");
assert.ok(bookingsSrc.includes('set("managementCompany", applied.managementCompany)'), "dialog mount must mirror the saved values into the form");
assert.ok(bookingsSrc.includes('"On-site management"'), "arrival summary must render the On-site management row");
assert.ok(/buyInHasArrivalDetails[\s\S]{0,900}managementContact/.test(bookingsSrc), "summary must render when the mgmt contact is the only arrival info");
console.log("  ✓ source guards: engine honesty + route + schema + UI wiring");

console.log("management-contact-lookup suite passed");
