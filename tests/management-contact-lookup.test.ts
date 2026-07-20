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

// ── 2026-07-20 live failure: honest quotes from a real VRBO confirmation ─────
// The email interleaves zero-width non-joiners, en-dashes, and curly quotes,
// and the company line ("Contact Alii Resorts …") sits two lines away from the
// phone number ("Send Message" between). A model quoting honestly normalizes
// punctuation and joins the two contact lines — both used to fail the strict
// contiguous byte-collapse and 422 the button.
const vrboEmail: ManagementContactEmail = {
  subject: "Your reservation has been confirmed",
  fromEmail: "bounce-cxj3bs7rbd4eto6i4jyjwbawi4.120046@bounce.eg.vrbo.com",
  receivedAt: "2026-07-20T03:17:42.000Z",
  text: [
    "Get ready for your trip, Jacelyn! Here’s your booking info and other important details.",
    "‌ ‌ ‌ ‌ ‌ ‌ ‌ ‌",
    "Hosted by Menehune Shores #623 – Top-Floor Penthouse with Stunning Ocean Views's rental company",
    "Here to help",
    "Message the host",
    "Contact Alii‌ Resorts for info related to payments, modifying your reservation, check-in procedures or activities in the area.",
    "Send Message",
    "+18088796284",
    "24/7 Support",
  ].join("\n"),
};
const vrboEmails = [vrboEmail];
const aliiBase = parseManagementContactJson({
  found: true,
  companyName: "Alii Resorts",
  phone: "+18088796284",
  sourceKind: "email",
  emailIndex: 0,
  quote: "Contact Alii Resorts for info related to payments, modifying your reservation, check-in procedures or activities in the area.",
  confidence: 0.9,
  note: "Named as the host contact in the VRBO confirmation",
})!;

// Zero-width chars inside the email must not defeat an honest quote.
v = validateManagementContact(aliiBase, vrboEmails);
assert.equal(v.ok, true, "ZWNJ inside the email text cannot reject an honest quote");

// Non-contiguous multi-line quote (company line + phone line, "Send Message"
// between them in the email) — each line is verbatim, so it verifies.
v = validateManagementContact(
  { ...aliiBase, quote: "Contact Alii Resorts for info related to payments, modifying your reservation, check-in procedures or activities in the area.\n+18088796284" },
  vrboEmails,
);
assert.equal(v.ok, true, "multi-line quote with non-adjacent verbatim lines verifies");

// Punctuation normalization: the model quotes the en-dash line with an ASCII
// hyphen and straight apostrophe — still an honest quote.
v = validateManagementContact(
  { ...aliiBase, quote: "Hosted by Menehune Shores #623 - Top-Floor Penthouse with Stunning Ocean Views's rental company" },
  vrboEmails,
);
assert.equal(v.ok, true, "dash/apostrophe-normalized quote of a unicode line verifies");

// The honesty gate is intact: an invented phone still fails digit-for-digit …
v = validateManagementContact({ ...aliiBase, phone: "+18085550000" }, vrboEmails);
assert.equal(v.ok, false, "invented phone still rejected");
// … an invented quote still fails …
v = validateManagementContact(
  { ...aliiBase, quote: "Call the Alii Resorts concierge desk 24 hours a day for immediate arrival assistance" },
  vrboEmails,
);
assert.equal(v.ok, false, "fabricated quote still rejected");
// … and a quote whose digits are invented fails even with matching words.
v = validateManagementContact(
  { ...aliiBase, quote: "Contact Alii Resorts for info related to payments, modifying your reservation, check-in procedures or activities in the area. Call 5551234567" },
  vrboEmails,
);
assert.equal(v.ok, false, "quote with an invented digit run still rejected");
console.log("  ✓ live VRBO shape: honest quotes verify; hallucinations still rejected");

// ── web-found EMAIL ADDRESS alongside an email-cited contact (2026-07-20) ────
// The confirmation email names Alii Resorts + phone but no email address; the
// operator SENDS the arrival-details request by email, so the model web-hunts
// the address. Acceptable only with its own http(s) page + the confidence floor.
const aliiWithWebEmail = { ...aliiBase, email: "info@aliiresorts.com", emailSourceUrl: "https://aliiresorts.com/contact" };
v = validateManagementContact(aliiWithWebEmail, vrboEmails);
assert.equal(v.ok, true, "web-found email accepted when it cites its own page and clears the floor");

v = validateManagementContact({ ...aliiBase, email: "info@aliiresorts.com" }, vrboEmails);
assert.equal(v.ok, false, "email absent from the cited email AND no web source page → rejected");
assert.match((v as any).reason, /no web source page/, "reason names the missing web citation");

v = validateManagementContact({ ...aliiWithWebEmail, emailSourceUrl: "aliiresorts.com/contact" }, vrboEmails);
assert.equal(v.ok, false, "non-http emailSourceUrl does not count as a citation");

v = validateManagementContact({ ...aliiWithWebEmail, confidence: MANAGEMENT_CONTACT_WEB_CONFIDENCE_FLOOR - 0.1 }, vrboEmails);
assert.equal(v.ok, false, "web-found email below the confidence floor → rejected");

// Prompt drives the hunt: email is the stated priority + the emailSourceUrl field exists.
assert.ok(/An EMAIL ADDRESS is the priority/.test(prompt), "prompt states the email-address priority");
assert.ok(prompt.includes('"emailSourceUrl"'), "prompt output schema carries emailSourceUrl");
assert.ok(/WEB-SEARCH for that company's email address/.test(prompt), "prompt mandates the web hunt when the emails have no address");

// Provenance carries the email's own source page.
const webEmailRecord = buildManagementContactSourceRecord({
  contact: aliiWithWebEmail,
  emails: vrboEmails,
  searchCount: 3,
  model: "m",
  now: new Date("2026-07-20T16:00:00.000Z"),
});
assert.equal(webEmailRecord.emailSourceUrl, "https://aliiresorts.com/contact", "record carries the email's web source page");
console.log("  ✓ web-found email address: cited + floored, never free-floating");

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
