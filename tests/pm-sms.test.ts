// PM text thread — locks the 2026-07-20 operator ask: "add another place for
// me to text back and forth with the management company" in the unit buy-in
// section beside the email history.
//
// Design guarded here:
//   - NO new tables/engine: sends go through the EXISTING sendQuoSms (the
//     guest-SMS sender) and the thread is quo_sms_messages filtered on the PM
//     phone's last 10 digits (getQuoSmsMessagesByPhoneLast10).
//   - Phone extraction from buy_ins.managementContact ("(808) 879-6284 ·
//     info@aliiresorts.com" — the shape "Confirm mgmt contact" saves) must be
//     conservative: embedded digit runs (reservation numbers) never match — a
//     wrong number texted to a stranger is worse than an empty input.
//   - The send route backfills a hand-typed phone into managementContact ONLY
//     when it has no phone yet (never clobbers).
//   - The UI is honest about config: unconfigured Quo and a missing inbound
//     webhook (PM replies can't mirror) each render an explicit note.
import { readFileSync } from "node:fs";
import {
  extractPhoneForSms,
  formatPmSmsPhone,
  managementContactNeedsPhone,
  pmSmsPhoneKey,
  pmSmsSenderLabel,
} from "../shared/pm-sms";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("extractPhoneForSms");

check("mgmt-contact shape '(808) 879-6284 · info@aliiresorts.com'",
  extractPhoneForSms("(808) 879-6284 · info@aliiresorts.com") === "+18088796284");
check("+1 prefixed", extractPhoneForSms("+1 866-284-2544") === "+18662842544");
check("dotted", extractPhoneForSms("call 808.879.6284 anytime") === "+18088796284");
check("bare 10 digits", extractPhoneForSms("8088796284") === "+18088796284");
check("11 digits with leading 1", extractPhoneForSms("18088796284") === "+18088796284");
check("embedded in a longer digit run (reservation #) never matches",
  extractPhoneForSms("Reservation # 2206691234567") === "");
check("confirmation code digits never match",
  extractPhoneForSms("BC-Nn9X48ogL ref 123456789012345") === "");
check("email-only contact yields empty", extractPhoneForSms("info@aliiresorts.com") === "");
check("null/empty yield empty", extractPhoneForSms(null) === "" && extractPhoneForSms("") === "");
check("first phone wins when two are present",
  extractPhoneForSms("(866) 284-2544 or (808) 879-6284") === "+18662842544");

console.log("pmSmsPhoneKey / formatPmSmsPhone / labels");

check("phone key = last 10 digits", pmSmsPhoneKey("+18088796284") === "8088796284");
check("short input yields empty key", pmSmsPhoneKey("879-6284") === "");
check("display format", formatPmSmsPhone("+18088796284") === "(808) 879-6284");
check("sender label carries the company", pmSmsSenderLabel("Ali'i Resorts LLC") === "PM · Ali'i Resorts LLC");
check("sender label fallback", pmSmsSenderLabel(null) === "PM contact");
check("needsPhone true for email-only contact", managementContactNeedsPhone("info@aliiresorts.com"));
check("needsPhone false once a phone is present", !managementContactNeedsPhone("(808) 879-6284 · info@aliiresorts.com"));

console.log("wiring source guards");

const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
const storage = readFileSync(new URL("../server/storage.ts", import.meta.url), "utf8");
const bookings = readFileSync(new URL("../client/src/pages/bookings.tsx", import.meta.url), "utf8");

const getRoute = routes.slice(routes.indexOf(`app.get("/api/buy-ins/:id/pm-sms"`), routes.indexOf(`app.post("/api/buy-ins/:id/pm-sms"`));
const postRoute = routes.slice(routes.indexOf(`app.post("/api/buy-ins/:id/pm-sms"`), routes.indexOf("// Reporting pull for the actually-paid rates"));

check("GET route exists and defaults the phone from managementContact",
  getRoute.includes("extractPhoneForSms(buyIn.managementContact)"));
check("GET reports Quo config + inbound-webhook status honestly",
  getRoute.includes("getQuoSmsConfigStatus()") && getRoute.includes("QUO_WEBHOOK_SECRET"));
check("POST sends through the EXISTING sendQuoSms engine (no parallel sender)",
  postRoute.includes("await sendQuoSms({") && postRoute.includes("conversationId: null"));
check("POST stamps the PM sender label so PM texts are distinguishable from guest SMS",
  postRoute.includes("pmSmsSenderLabel(buyIn.managementCompany)"));
check("POST backfills the phone only when managementContact has none",
  postRoute.includes("managementContactNeedsPhone(buyIn.managementContact)"));
check("storage thread query matches on last-10 digits of guest_phone",
  storage.includes("getQuoSmsMessagesByPhoneLast10") &&
  storage.includes("right(regexp_replace(") &&
  storage.includes("quoSmsMessages.guestPhone"));
// Repointed 2026-07-20 (per-unit "SMS/Text History" split): the panel now
// threads the unit's display label into the section header.
check("panel mounts the PM text thread beside the email history",
  bookings.includes("<PmSmsThread buyIn={buyIn} unitDisplayLabel={unitDisplayLabel} />"));
check("thread phone input prefills from the saved management contact",
  bookings.includes("extractPhoneForSms(buyIn.managementContact ?? \"\")"));
check("send button goes through the pm-sms POST",
  bookings.includes("`/api/buy-ins/${buyIn.id}/pm-sms`"));
check("UI renders the unconfigured-SMS and no-inbound-webhook notes",
  bookings.includes("SMS is not configured on the server") &&
  bookings.includes("QUO_WEBHOOK_SECRET"));
check("SMS bodies render through the linkifier (URLs clickable)",
  /function PmSmsThread[\s\S]{0,8000}<EmailBodyWithLinks body={m\.body} \/>/.test(bookings));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
