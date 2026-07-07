// Network-free unit tests for shared/hawaii-time.ts — the header Hawaii
// clock's formatting. Fixed UTC instants → expected HST (UTC-10) wall-clock
// output, plus an Intl↔offset-fallback agreement sweep (HST has no DST, so
// the two paths must never disagree).
import {
  hawaiiClockParts,
  hawaiiClockPartsFromUtcOffset,
  HAWAII_TIME_ZONE,
} from "../shared/hawaii-time";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("hawaii-time: fixed instants (Intl path)");

// 2026-07-07 00:30Z → 2026-07-06 14:30 HST (Monday afternoon in Hawaii
// while it's already Tuesday in UTC — the day rollback is the whole point).
const monAfternoon = hawaiiClockParts(new Date("2026-07-07T00:30:00Z"));
check("afternoon time", monAfternoon.time === "2:30 PM", monAfternoon);
check("afternoon weekday", monAfternoon.weekday === "Monday", monAfternoon);
check("afternoon weekdayShort", monAfternoon.weekdayShort === "Mon", monAfternoon);
check("afternoon date", monAfternoon.date === "Jul 6", monAfternoon);
check("afternoon fullDate", monAfternoon.fullDate === "Monday, July 6, 2026", monAfternoon);
check("tz label is HST", monAfternoon.tzLabel === "HST");

// Midnight in Hawaii: 10:00Z → 12:00 AM HST same UTC day.
const midnight = hawaiiClockParts(new Date("2026-07-07T10:00:00Z"));
check("midnight is 12:00 AM", midnight.time === "12:00 AM", midnight);
check("midnight weekday Tuesday", midnight.weekday === "Tuesday", midnight);

// Noon in Hawaii: 22:00Z → 12:00 PM HST.
const noon = hawaiiClockParts(new Date("2026-07-07T22:00:00Z"));
check("noon is 12:00 PM", noon.time === "12:00 PM", noon);

// Minute zero-padding + no leading-zero hour.
const padded = hawaiiClockParts(new Date("2026-07-07T19:05:00Z"));
check("9:05 AM zero-padded minutes", padded.time === "9:05 AM", padded);

// Year boundary: 2026-01-01 05:00Z → Dec 31 2025, 7:00 PM HST.
const nye = hawaiiClockParts(new Date("2026-01-01T05:00:00Z"));
check("year rollback time", nye.time === "7:00 PM", nye);
check("year rollback date", nye.date === "Dec 31", nye);
check("year rollback fullDate keeps 2025", nye.fullDate === "Wednesday, December 31, 2025", nye);

console.log("hawaii-time: offset fallback path");

// The fallback must produce the identical shape for the same instants —
// Hawaii is fixed UTC-10 with no DST, so Intl and offset math cannot drift.
const sweep = [
  "2026-07-07T00:30:00Z",
  "2026-07-07T10:00:00Z",
  "2026-07-07T09:59:00Z",
  "2026-07-07T22:00:00Z",
  "2026-01-01T05:00:00Z",
  "2026-02-28T11:11:00Z",
  "2028-02-29T23:45:00Z", // leap day
  "2026-12-25T09:00:00Z",
];
for (const iso of sweep) {
  const a = hawaiiClockParts(new Date(iso));
  const b = hawaiiClockPartsFromUtcOffset(new Date(iso));
  check(`Intl matches offset fallback @ ${iso}`, JSON.stringify(a) === JSON.stringify(b), { a, b });
}

check("time zone constant is the IANA id", HAWAII_TIME_ZONE === "Pacific/Honolulu");

console.log(`\nhawaii-time: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
