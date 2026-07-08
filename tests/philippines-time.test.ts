// Network-free unit tests for shared/philippines-time.ts — the header
// Philippines clock's formatting. Fixed UTC instants → expected PHT (UTC+8)
// wall-clock output, plus an Intl↔offset-fallback agreement sweep (PHT has no
// DST, so the two paths must never disagree).
import {
  philippinesClockParts,
  philippinesClockPartsFromUtcOffset,
  PHILIPPINES_TIME_ZONE,
} from "../shared/philippines-time";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("philippines-time: fixed instants (Intl path)");

// 2026-07-07 00:30Z → 2026-07-07 08:30 PHT (Manila is +8, so it's already
// Tuesday morning there while UTC has only just ticked past midnight).
const tueMorning = philippinesClockParts(new Date("2026-07-07T00:30:00Z"));
check("morning time", tueMorning.time === "8:30 AM", tueMorning);
check("morning weekday", tueMorning.weekday === "Tuesday", tueMorning);
check("morning weekdayShort", tueMorning.weekdayShort === "Tue", tueMorning);
check("morning date", tueMorning.date === "Jul 7", tueMorning);
check("morning fullDate", tueMorning.fullDate === "Tuesday, July 7, 2026", tueMorning);
check("tz label is PHT", tueMorning.tzLabel === "PHT");

// Midnight in Manila: 2026-07-06 16:00Z → 2026-07-07 00:00 PHT.
const midnight = philippinesClockParts(new Date("2026-07-06T16:00:00Z"));
check("midnight is 12:00 AM", midnight.time === "12:00 AM", midnight);
check("midnight weekday Tuesday", midnight.weekday === "Tuesday", midnight);

// Noon in Manila: 04:00Z → 12:00 PM PHT.
const noon = philippinesClockParts(new Date("2026-07-07T04:00:00Z"));
check("noon is 12:00 PM", noon.time === "12:00 PM", noon);

// Minute zero-padding + no leading-zero hour.
const padded = philippinesClockParts(new Date("2026-07-07T01:05:00Z"));
check("9:05 AM zero-padded minutes", padded.time === "9:05 AM", padded);

// Year boundary (roll-forward): 2025-12-31 16:30Z → Jan 1 2026, 12:30 AM PHT —
// Manila crosses into the new year while UTC is still in the old one.
const nyd = philippinesClockParts(new Date("2025-12-31T16:30:00Z"));
check("year roll-forward time", nyd.time === "12:30 AM", nyd);
check("year roll-forward date", nyd.date === "Jan 1", nyd);
check("year roll-forward fullDate is 2026", nyd.fullDate === "Thursday, January 1, 2026", nyd);

console.log("philippines-time: offset fallback path");

// The fallback must produce the identical shape for the same instants —
// the Philippines is fixed UTC+8 with no DST, so Intl and offset math cannot
// drift.
const sweep = [
  "2026-07-07T00:30:00Z",
  "2026-07-06T16:00:00Z",
  "2026-07-06T15:59:00Z",
  "2026-07-07T04:00:00Z",
  "2025-12-31T16:30:00Z",
  "2026-02-28T11:11:00Z",
  "2028-02-29T23:45:00Z", // leap day
  "2026-12-25T09:00:00Z",
];
for (const iso of sweep) {
  const a = philippinesClockParts(new Date(iso));
  const b = philippinesClockPartsFromUtcOffset(new Date(iso));
  check(`Intl matches offset fallback @ ${iso}`, JSON.stringify(a) === JSON.stringify(b), { a, b });
}

check("time zone constant is the IANA id", PHILIPPINES_TIME_ZONE === "Asia/Manila");

console.log(`\nphilippines-time: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
