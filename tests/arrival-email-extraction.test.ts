import assert from "node:assert/strict";
import {
  hasGuestPortalHint,
  summarizeArrivalExtraction,
  valueVerbatimInText,
  verifyExtractedField,
  type ArrivalExtractionRecord,
} from "../shared/arrival-email-verification";
import {
  aliasCandidatesForBuyIn,
  buildArrivalExtractionPrompt,
  extractionEmailsFromMessages,
  extractionMessagesFromSources,
  extractArrivalDetailsWithClaude,
  extractArrivalDetailsWithRegex,
} from "../server/arrival-email-extract";
import {
  ARRIVAL_SMS_HARD_LIMIT,
  ARRIVAL_SMS_TARGET_LIMIT,
  buildArrivalDetailsSmsMessage,
} from "../shared/arrival-details-message";
import type { GuestInboxMessage } from "../shared/schema";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

// ── 2026-07-20 Menehune incident: door code lived in buy_in_emails ───────────
// The arrival-instructions email was delivered to the unit-scoped alias
// (jacelyn.tsu.ae9958.a@) and ingested into buy_in_emails; the buy-in's
// travelerEmail was the legacy base alias, so the old extraction (guest inbox
// only, travelerEmail only) saw ZERO emails and the door code never surfaced.

const menehuneBody = [
  "Aloha Jacelyn,",
  "Thank you for booking a stay with us at Menehune Shores unit 106 located at 760 South Kihei Road, Kihei, HI 96753.",
  "Check in is at 4 pm and check out is at 11 am.",
  "The door has a digital keypad. The keypad is located above the deadbolt keyhole.",
  "The door code is 6509. Please save this code as it will be your way to get in and out of the unit.",
  "Your wifi information is listed below:",
  "WIFI NETWORK: 'SpectrumSetup-C1' PASSWORD: 'littleshark860'",
  "The pool gate code is: C7601 and the restroom code is: 7601.",
].join("\n\n");

// aliasCandidatesForBuyIn: travelerEmail + the unit-scoped alias row.
const menehuneAliasRows = [
  { buyInId: 539, aliasEmail: "jacelyn.tsu.ae9958.a@emailprivaccy.com" },
  { buyInId: 540, aliasEmail: "jacelyn.tsu.410862@emailprivaccy.com" },
];
assert.deepEqual(
  aliasCandidatesForBuyIn({ id: 539, travelerEmail: "jacelyn.tsu@emailprivaccy.com" } as any, menehuneAliasRows as any, 2).sort(),
  ["jacelyn.tsu.ae9958.a@emailprivaccy.com", "jacelyn.tsu@emailprivaccy.com"],
  "unit gets travelerEmail AND its buyInId-scoped alias (the live divergence)",
);
assert.deepEqual(
  aliasCandidatesForBuyIn({ id: 540, travelerEmail: "jacelyn.tsu.410862@emailprivaccy.com" } as any, menehuneAliasRows as any, 2),
  ["jacelyn.tsu.410862@emailprivaccy.com"],
  "sibling's alias never bleeds into another unit",
);
assert.deepEqual(
  aliasCandidatesForBuyIn(
    { id: 7, travelerEmail: null } as any,
    [{ buyInId: null, aliasEmail: "solo.guest@emailprivaccy.com" }] as any,
    1,
  ),
  ["solo.guest@emailprivaccy.com"],
  "reservation-level alias attributable only when a single unit is attached",
);
assert.deepEqual(
  aliasCandidatesForBuyIn(
    { id: 7, travelerEmail: null } as any,
    [{ buyInId: null, aliasEmail: "solo.guest@emailprivaccy.com" }] as any,
    2,
  ),
  [],
  "reservation-level alias excluded with siblings (attribution-exact rule)",
);

// extractionMessagesFromSources: PM rows merged in, dupes read once.
const menehunePmEmail = {
  id: 43,
  direction: "inbound",
  fromEmail: "0101019f@us-west-2.amazonses.com",
  toEmail: "jacelyn.tsu.ae9958.a@emailprivaccy.com",
  subject: "Your Menehune 106 Arrival Instructions",
  body: menehuneBody,
  providerMessageId: "<ses-abc-123@amazonses.com>",
  sentAt: new Date("2026-07-20T02:38:35Z"),
};
const vrboConfirmMsg = msg({
  id: 52,
  subject: "Your reservation has been confirmed",
  fromEmail: "bounce@bounce.eg.vrbo.com",
  body: "Your reservation has been confirmed.",
  providerMessageId: "<vrbo-1@vrbo.com>",
  receivedAt: new Date("2026-07-20T02:04:45Z"),
} as any);
const dupOfPmMsg = msg({
  id: 53,
  subject: "Your Menehune 106 Arrival Instructions",
  fromEmail: "0101019f@us-west-2.amazonses.com",
  body: menehuneBody,
  providerMessageId: "<ses-abc-123@amazonses.com>",
  receivedAt: new Date("2026-07-20T02:38:40Z"),
} as any);

const mergedSources = extractionMessagesFromSources([vrboConfirmMsg, dupOfPmMsg], [menehunePmEmail] as any);
assert.equal(mergedSources.length, 2, "email captured by both ingesters is read once");
assert.equal(
  mergedSources.some((m) => String(m.subject).includes("Arrival Instructions")),
  true,
  "buy_in_emails-only arrival email reaches the extraction corpus",
);
const mergedExtractionEmails = extractionEmailsFromMessages(mergedSources);
assert.equal(mergedExtractionEmails[0].subject, "Your Menehune 106 Arrival Instructions", "PM arrival email newest-first");
assert.match(mergedExtractionEmails[0].text, /door code is 6509/i, "door code text reaches the prompt corpus");

// Claude e2e over the merged corpus finds the sentence-form door code.
const menehuneBuyIn = { propertyName: "Menehune Shores", unitLabel: "Unit A", notes: null, propertyId: 46 };
const menehuneCall = (async () => ({
  ok: true as const,
  raw: "",
  data: {
    fields: {
      accessCode: { value: "6509", quote: "The door code is 6509.", emailIndex: 1 },
    },
    noteLines: [
      { value: "Pool gate code: C7601", quote: "The pool gate code is: C7601", emailIndex: 1 },
      { value: "Restroom code: 7601", quote: "the restroom code is: 7601.", emailIndex: 1 },
      { value: "Check-in: 4 pm", quote: "Check in is at 4 pm", emailIndex: 1 },
    ],
  },
})) as any;
const menehuneRecord = await extractArrivalDetailsWithClaude(mergedSources, menehuneBuyIn, "HI", menehuneCall);
assert.equal(menehuneRecord!.fields.accessCode?.value, "6509", "sentence-form door code extracted + verified");
assert.match(menehuneRecord!.fields.arrivalNotes?.value ?? "", /Pool gate code: C7601/, "pool gate code note kept");
assert.match(menehuneRecord!.fields.arrivalNotes?.value ?? "", /Restroom code: 7601/, "restroom code note kept");

// Regex fallback also catches the sentence forms now.
const menehuneRegex = await extractArrivalDetailsWithRegex(
  mergedSources,
  { ...menehuneBuyIn, id: 539 } as any,
  "HI",
);
assert.equal(menehuneRegex!.fields.accessCode?.value, "6509", "regex catches 'The door code is 6509.'");
assert.match(menehuneRegex!.fields.arrivalNotes?.value ?? "", /Gate code: C7601/, "regex catches 'pool gate code is: C7601'");

// ── stored raw-MIME bodies are healed before extraction ──────────────────────
const mimeStoredBody = [
  "------=_Part_1_170.1751818261234",
  'Content-Type: text/plain; charset="UTF-8"',
  "Content-Transfer-Encoding: 7bit",
  "",
  "The door code is 6509.",
  "------=_Part_1_170.1751818261234--",
].join("\r\n");
const healedEmails = extractionEmailsFromMessages([msg({ body: mimeStoredBody })]);
assert.match(healedEmails[0].text, /door code is 6509/i, "MIME fragment body decoded for extraction");
assert.doesNotMatch(healedEmails[0].text, /Content-Type/i, "MIME part headers stripped from extraction text");

// ── source guards: the refresh path must keep reading the merged thread ──────
const extractSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "server", "arrival-email-extract.ts"),
  "utf8",
);
assert.match(extractSrc, /syncBuyInVendorEmailsForReservation/, "refresh pulls PM mail into buy_in_emails first");
assert.match(extractSrc, /aliasCandidatesForBuyIn\(buyIn, aliasRows, attached\.length\)/, "refresh reads every unit alias");
assert.match(extractSrc, /extractionMessagesFromSources\(guestMessages, unitPmEmails\)/, "refresh merges buy_in_emails into the corpus");
assert.match(extractSrc, /extractReadableFromStoredMimeBody/, "extraction heals stored MIME bodies");

// ── date-shaped values can never persist as unitAddress (buy-in 539 class) ────
{
  const {
    parseArrivalDetailsFromText,
    looksLikeDateOrTimeValue,
    looksLikeStreetAddressValue,
    splitWifiNameAndPassword,
    isUsableArrivalField,
    isPlausiblePropertyAddressForBuyIn,
  } = await import("../server/buy-in-email");

  for (const date of [
    "07/21/2026",
    "7/21/26",
    "2026-07-21",
    "07/21/2026 - 07/28/2026",
    "Mon, July 21, 2026",
    "July 21",
    "21 July 2026",
    "4:00 PM",
    "16:00",
  ]) {
    assert.ok(looksLikeDateOrTimeValue(date), `date/time shape detected: ${date}`);
    assert.ok(!looksLikeStreetAddressValue(date), `date is not a street: ${date}`);
    assert.ok(!isUsableArrivalField("unitAddress", date), `date rejected as unitAddress: ${date}`);
    assert.ok(
      !isPlausiblePropertyAddressForBuyIn(date, null, "HI"),
      `date rejected by plausibility gate: ${date}`,
    );
  }
  for (const addr of [
    "760 S Kihei Rd Unit 106, Kihei, HI 96753",
    "2253 Poipu Rd, Unit B, Koloa, HI 96756",
    "75-6082 Alii Dr, Kailua-Kona, HI 96740", // Hawaii hyphenated house number
    "3830 Edward Rd 13C, Princeville, HI 96722",
    "123 May St, Naples, FL 34102", // month-word street name is not a date
  ]) {
    assert.ok(!looksLikeDateOrTimeValue(addr), `real address is not a date: ${addr}`);
    assert.ok(looksLikeStreetAddressValue(addr), `real address accepted: ${addr}`);
    assert.ok(isUsableArrivalField("unitAddress", addr), `real address usable: ${addr}`);
  }
  // Non-street junk with digits also rejected.
  assert.ok(!isUsableArrivalField("unitAddress", "Confirmation #HA-1234567"), "confirmation code rejected");

  // The exact buy-in 539 failure: a "Check-in:" line must not become the address.
  const parsed539 = parseArrivalDetailsFromText(
    ["Check-in: 07/21/2026", "Wi-Fi: 'SpectrumSetup-C1' PASSWORD: 'littleshark860'", "Door code: 4821"].join("\n"),
  );
  assert.equal(parsed539.unitAddress, "", "check-in date never persists as unitAddress");
  assert.equal(parsed539.wifiName, "SpectrumSetup-C1", "quoted wifi name split + unquoted");
  assert.equal(parsed539.wifiPassword, "littleshark860", "embedded PASSWORD: split into wifiPassword");
  assert.equal(parsed539.accessCode, "4821");

  // Wi-Fi split helper + combined-capture rejection.
  assert.deepEqual(
    splitWifiNameAndPassword("'SpectrumSetup-C1' PASSWORD: 'littleshark860'"),
    { name: "SpectrumSetup-C1", password: "littleshark860" },
  );
  assert.equal(splitWifiNameAndPassword("GuestNetwork"), null, "no password label → no split");
  assert.ok(
    !isUsableArrivalField("wifiName", "'SpectrumSetup-C1' PASSWORD: 'littleshark860'"),
    "unsplit combined wifi capture rejected as a name (heals corrupt stored rows)",
  );

  // Separate-line wifi still parses exactly as before.
  const parsedWifiLines = parseArrivalDetailsFromText(
    ["Wi-Fi name: GuestNetwork", "Wi-Fi password: stay2026"].join("\n"),
  );
  assert.equal(parsedWifiLines.wifiName, "GuestNetwork");
  assert.equal(parsedWifiLines.wifiPassword, "stay2026");
}

// ── reconcile clears a corrupt stored date-address (merge path) ───────────────
{
  const { mergeArrivalDetailsIntoBuyIn } = await import("../server/guest-inbox-arrival");
  const healed = mergeArrivalDetailsIntoBuyIn(
    {
      unitAddress: "07/21/2026",
      accessCode: "",
      wifiName: "'SpectrumSetup-C1' PASSWORD: 'littleshark860'",
      wifiPassword: "",
      parkingInfo: "",
      arrivalNotes: "",
    } as any,
    { unitAddress: "", accessCode: "", wifiName: "", wifiPassword: "", parkingInfo: "", arrivalNotes: "" },
    null,
    "HI",
  );
  assert.equal(healed.unitAddress, "", "corrupt date-address cleared on reconcile");
  assert.equal(healed.wifiName, "", "corrupt combined wifi name cleared on reconcile");

  const replaced = mergeArrivalDetailsIntoBuyIn(
    { unitAddress: "07/21/2026", accessCode: "", wifiName: "", wifiPassword: "", parkingInfo: "", arrivalNotes: "" } as any,
    { unitAddress: "760 S Kihei Rd Unit 106, Kihei, HI 96753", accessCode: "", wifiName: "", wifiPassword: "", parkingInfo: "", arrivalNotes: "" },
    null,
    "HI",
  );
  assert.equal(
    replaced.unitAddress,
    "760 S Kihei Rd Unit 106, Kihei, HI 96753",
    "corrupt date-address replaced by the real street when a later email carries it",
  );
}

// ── SMS builder: compact, capped, sheds detail gracefully ────────────────────
{
  const baseUnit = {
    unitLabel: "Menehune Shores 2BR",
    unitAddress: "760 S Kihei Rd Unit 106, Kihei, HI 96753",
    accessCode: "3438*",
    wifiName: "SpectrumSetup-C1",
    wifiPassword: "littleshark860",
    parkingInfo: "Up to 2 vehicles in the marked stalls.",
    arrivalNotes: "Lobby code: 1025\nPool code: 5747",
  };
  const sms = buildArrivalDetailsSmsMessage({
    guestFirstName: "Jacelyn",
    propertyName: "Menehune Shores",
    checkInIso: "2026-07-21",
    units: [baseUnit],
    isHawaii: true,
  });
  assert.ok(sms.startsWith("Aloha Jacelyn"), "Hawaii greeting");
  assert.ok(sms.includes("Access code: 3438*"), "code present");
  assert.ok(sms.includes("SpectrumSetup-C1 / littleshark860"), "wifi present");
  assert.ok(sms.includes("Mahalo, John Carpenter"), "sign-off present");
  assert.ok(sms.length <= ARRIVAL_SMS_TARGET_LIMIT, `compact SMS under target (${sms.length})`);
  assert.ok(!/[‘’“”—]/.test(sms), "ASCII only");

  // Oversized notes shed before codes ever would.
  const bloated = { ...baseUnit, arrivalNotes: "N".repeat(2000) };
  const shed = buildArrivalDetailsSmsMessage({
    guestFirstName: "Jacelyn",
    propertyName: "Menehune Shores",
    checkInIso: "2026-07-21",
    units: [bloated, { ...bloated, unitLabel: "Unit B" }],
    isHawaii: true,
  });
  assert.ok(shed.length <= ARRIVAL_SMS_HARD_LIMIT, "never exceeds the Quo hard limit");
  assert.ok(shed.includes("Access code: 3438*"), "codes survive shedding");
  assert.ok(!shed.includes("NNNNN"), "oversized notes were shed");

  const zeroUnit = buildArrivalDetailsSmsMessage({
    guestFirstName: "Sam",
    propertyName: "",
    units: [],
    isHawaii: false,
  });
  assert.ok(zeroUnit.includes("still confirming"), "zero-unit SMS stays honest");
  assert.ok(zeroUnit.startsWith("Hi Sam"), "mainland greeting");
}

console.log("arrival-email-extraction tests passed");
