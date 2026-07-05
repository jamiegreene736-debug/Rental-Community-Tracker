import assert from "node:assert/strict";
import {
  hasGuestPortalHint,
  summarizeArrivalExtraction,
  valueVerbatimInText,
  verifyExtractedField,
  type ArrivalExtractionRecord,
} from "../shared/arrival-email-verification";
import {
  buildArrivalExtractionPrompt,
  extractionEmailsFromMessages,
  extractArrivalDetailsWithClaude,
  extractArrivalDetailsWithRegex,
} from "../server/arrival-email-extract";
import type { GuestInboxMessage } from "../shared/schema";

console.log("arrival-email-extraction tests");

// ── verbatim verification: codes ─────────────────────────────────────────────
assert.equal(
  valueVerbatimInText("accessCode", "3438*", "DOOR CODE: 3438 *"),
  true,
  "code matches whitespace/punct-insensitively",
);
assert.equal(
  valueVerbatimInText("accessCode", "6969", "Condo Door Code: 6969"),
  true,
  "plain digit code matches",
);
assert.equal(
  valueVerbatimInText("accessCode", "1234", "Condo Door Code: 6969"),
  false,
  "a code the host never wrote is rejected",
);

// ── verbatim verification: texty fields ───────────────────────────────────────
const santaMariaText = [
  "Unit Address: 7327 Estero Blvd Unit 104 Fort Myers Beach, FL 33931 US",
  "LOBBY CODE: 1025",
  "POOL CODE: 5747",
  "DOOR CODE: 3438*",
  "WiFi Information: WIFI Network ID: QuantumFiber3402",
  "WIFI Password: afb3aa7744cefa",
  "Parking Information: Santa Maria 104 is permitted to have up to a maximum of 2 vehicles.",
].join("\n");

assert.equal(
  valueVerbatimInText("unitAddress", "7327 Estero Blvd Unit 104 Fort Myers Beach, FL 33931", santaMariaText),
  true,
  "address matches with collapsed whitespace",
);
assert.equal(
  valueVerbatimInText("wifiPassword", "afb3aa7744cefa", santaMariaText),
  true,
  "wifi password verbatim",
);
assert.equal(
  valueVerbatimInText("parkingInfo", "permitted to have up to a maximum of 3 vehicles", santaMariaText),
  false,
  "paraphrase with an invented number is rejected (digit runs must be present)",
);

// ── verifyExtractedField: quote + value discipline ───────────────────────────
assert.deepEqual(
  verifyExtractedField("accessCode", { value: "3438*", quote: "DOOR CODE: 3438*" }, santaMariaText),
  { value: "3438*", quote: "DOOR CODE: 3438*" },
  "good candidate passes with quote",
);
assert.equal(
  verifyExtractedField("accessCode", { value: "3438*", quote: "MAIN CODE: 9999" }, santaMariaText),
  null,
  "quote that does not exist in the email is rejected",
);
assert.equal(
  verifyExtractedField("arrivalNotes", { value: "Lobby code: 9999", quote: "LOBBY CODE: 1025" }, santaMariaText),
  null,
  "note whose digits are not in its own quote is rejected (real quote + invented number)",
);
assert.deepEqual(
  verifyExtractedField("arrivalNotes", { value: "Lobby code: 1025", quote: "LOBBY CODE: 1025" }, santaMariaText),
  { value: "Lobby code: 1025", quote: "LOBBY CODE: 1025" },
  "reformatted note line passes when digits come from the quote",
);
assert.equal(
  verifyExtractedField("wifiName", { value: "QuantumFiber3402", quote: "" }, santaMariaText),
  null,
  "missing quote is rejected — every field must carry evidence",
);

// ── portal hint ───────────────────────────────────────────────────────────────
assert.equal(
  hasGuestPortalHint("please visit our Guest Portal: https://vrp.trackhs.com/guest/#!/login/"),
  true,
  "trackhs guest portal detected",
);
assert.equal(
  hasGuestPortalHint("Your door code will appear in the guest portal four (4) days prior"),
  true,
  "portal-deferred door code detected",
);
assert.equal(hasGuestPortalHint("Aloha, your code is 1234"), false, "no portal hint on plain email");

// ── message → extraction email conversion ────────────────────────────────────
function msg(overrides: Partial<GuestInboxMessage>): GuestInboxMessage {
  return {
    id: 1,
    aliasEmail: "thien.tran.4c015c@emailprivaccy.com",
    guestName: "Thien Tran",
    buyInId: 7,
    reservationId: "res1",
    direction: "inbound",
    fromEmail: "info@waikikibeachrentals.com",
    toEmail: "thien.tran.4c015c@emailprivaccy.com",
    subject: "Waikiki Condo Booking Info",
    body: "Aloha",
    attachmentsJson: null,
    providerMessageId: null,
    rawPayload: null,
    receivedAt: new Date("2026-07-05T15:21:24Z"),
    createdAt: new Date("2026-07-05T15:21:24Z"),
    ...overrides,
  } as GuestInboxMessage;
}

const waikikiBody = [
  "Aloha Thien Tran",
  "Location: 1777 Ala Moana Blvd, Honolulu, Oahu, Hawaii, United States, 96815",
  "Building: Ilikai",
  "Unit Number: 1834",
  "Condo Door Code: 6969",
  "WiFi Network Name: SSID network name located on modem.",
  "Arrival Date: 3 p.m. Tuesday, July 07, 2026",
  "Parking: Valet Parking is $45 per day.",
].join("\n");

const orderedEmails = extractionEmailsFromMessages([
  msg({ id: 1, subject: "Old promo", receivedAt: new Date("2026-06-01T00:00:00Z") }),
  msg({ id: 2, subject: "Waikiki Condo Booking Info", body: waikikiBody, receivedAt: new Date("2026-07-05T15:21:24Z") }),
  msg({ id: 3, subject: "Outbound reply", direction: "outbound", receivedAt: new Date("2026-07-06T00:00:00Z") }),
]);
assert.equal(orderedEmails.length, 2, "outbound messages excluded from extraction corpus");
assert.equal(orderedEmails[0].subject, "Waikiki Condo Booking Info", "newest inbound email first");

// ── prompt shape ──────────────────────────────────────────────────────────────
const prompt = buildArrivalExtractionPrompt(orderedEmails, {
  propertyName: "Ilikai Waikiki 1BR",
  unitLabel: "Unit A",
  notes: null,
  propertyId: 12,
});
assert.match(prompt, /\[EMAIL 1\]/, "prompt labels emails by index");
assert.match(prompt, /verbatim/i, "prompt demands verbatim copying");
assert.match(prompt, /NEVER guess/i, "prompt forbids guessing");
assert.match(prompt, /login code, NOT a door code/i, "prompt excludes OTA secure-code emails");

// ── Claude path with a fake caller: verification gates the output ────────────
const hawaiiBuyIn = { propertyName: "Ilikai Waikiki", unitLabel: "Unit A", notes: null, propertyId: 12 };

const fakeCall = (async (_opts: any) => ({
  ok: true as const,
  raw: "",
  data: {
    fields: {
      accessCode: { value: "6969", quote: "Condo Door Code: 6969", emailIndex: 1 },
      // Hallucinated: never appears in any email → must be dropped.
      wifiPassword: { value: "hunter2", quote: "WiFi Password: hunter2", emailIndex: 1 },
      // Wrong state for a HI community → address plausibility gate drops it.
      unitAddress: { value: "7327 Estero Blvd, Fort Myers Beach, FL 33931", quote: "7327 Estero Blvd", emailIndex: 1 },
      parkingInfo: { value: "Valet Parking is $45 per day.", quote: "Parking: Valet Parking is $45 per day.", emailIndex: 1 },
    },
    noteLines: [
      { value: "Unit number: 1834", quote: "Unit Number: 1834", emailIndex: 1 },
      { value: "Check-in: 3 p.m. Tuesday, July 07, 2026", quote: "Arrival Date: 3 p.m. Tuesday, July 07, 2026", emailIndex: 1 },
      { value: "Gate code: 4444", quote: "Unit Number: 1834", emailIndex: 1 }, // invented digits
    ],
    conflicts: ["accessCode"],
  },
})) as any;

const claudeRecord = await extractArrivalDetailsWithClaude(
  [msg({ body: waikikiBody })],
  hawaiiBuyIn,
  "HI",
  fakeCall,
);
assert.ok(claudeRecord, "claude record produced");
assert.equal(claudeRecord!.method, "claude");
assert.equal(claudeRecord!.fields.accessCode?.value, "6969", "verified door code kept");
assert.equal(claudeRecord!.fields.accessCode?.verified, true, "door code marked verified");
assert.equal(claudeRecord!.fields.accessCode?.sourceSubject, "Waikiki Condo Booking Info", "provenance subject stamped");
assert.equal(claudeRecord!.fields.wifiPassword, undefined, "hallucinated wifi password dropped");
assert.equal(claudeRecord!.fields.unitAddress, undefined, "wrong-state address dropped by plausibility gate");
assert.equal(claudeRecord!.fields.parkingInfo?.value, "Valet Parking is $45 per day.", "parking kept");
assert.match(claudeRecord!.fields.arrivalNotes?.value ?? "", /Unit number: 1834/, "verified note line kept");
assert.match(claudeRecord!.fields.arrivalNotes?.value ?? "", /Check-in: 3 p\.m\./, "check-in time note kept");
assert.doesNotMatch(claudeRecord!.fields.arrivalNotes?.value ?? "", /4444/, "note with invented digits dropped");
assert.deepEqual(claudeRecord!.conflicts, ["accessCode"], "conflicts passed through for the UI warning");

// A failing Claude call yields null (caller falls back to regex).
const failingCall = (async () => ({ ok: false as const, error: "boom" })) as any;
assert.equal(
  await extractArrivalDetailsWithClaude([msg({ body: waikikiBody })], hawaiiBuyIn, "HI", failingCall),
  null,
  "claude failure returns null for regex fallback",
);

// Bad emailIndex citations are dropped, not crashed on.
const badIndexCall = (async () => ({
  ok: true as const,
  raw: "",
  data: { fields: { accessCode: { value: "6969", quote: "Condo Door Code: 6969", emailIndex: 99 } }, noteLines: [] },
})) as any;
assert.equal(
  await extractArrivalDetailsWithClaude([msg({ body: waikikiBody })], hawaiiBuyIn, "HI", badIndexCall),
  null,
  "citation to a nonexistent email cannot verify",
);

// ── regex fallback keeps working without an API key ──────────────────────────
const regexRecord = await extractArrivalDetailsWithRegex(
  [msg({ body: waikikiBody })],
  { ...hawaiiBuyIn, id: 1 } as any,
  "HI",
);
assert.ok(regexRecord, "regex record produced");
assert.equal(regexRecord!.method, "regex");
assert.equal(regexRecord!.fields.accessCode?.value, "6969", "regex still finds the door code");
assert.equal(regexRecord!.fields.accessCode?.sourceSubject, "Waikiki Condo Booking Info", "regex provenance stamped");

// ── summary helper ────────────────────────────────────────────────────────────
const summaryRecord: ArrivalExtractionRecord = {
  method: "claude",
  extractedAt: "2026-07-05T00:00:00Z",
  messageCount: 2,
  fields: { accessCode: { value: "6969", verified: true } },
};
assert.match(summarizeArrivalExtraction(summaryRecord), /accessCode from email \(verified\)/, "summary names fields");
assert.equal(summarizeArrivalExtraction(null), "", "null record summarizes to empty");

console.log("arrival-email-extraction tests passed");
