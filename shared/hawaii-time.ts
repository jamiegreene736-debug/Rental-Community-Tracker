// Pure Hawaii local-time formatting for the header clock (client) and any
// future server-side "guest local time" rendering. Hawaii Standard Time is
// fixed UTC-10 year-round (Hawaii has never observed DST), which is why the
// no-Intl fallback below can be a plain offset shift and still be correct.

export const HAWAII_TIME_ZONE = "Pacific/Honolulu";
export const HAWAII_UTC_OFFSET_HOURS = -10;

export interface HawaiiClockParts {
  /** "2:47 PM" — 12-hour, no leading zero, no seconds. */
  time: string;
  /** "Tue" */
  weekdayShort: string;
  /** "Tuesday" */
  weekday: string;
  /** "Jul 7" */
  date: string;
  /** "Tuesday, July 7, 2026" — for tooltips/aria labels. */
  fullDate: string;
  /** Always "HST" — Hawaii has no DST so the label never flips. */
  tzLabel: "HST";
}

const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

// Some ICU builds format "2:47 PM" with a narrow no-break space (U+202F)
// before the meridiem; normalize so display + tests are byte-stable.
const normalizeSpaces = (value: string) => value.replace(/[\u202f\u00a0]/g, " ").trim();

/**
 * Offset-math fallback (also the cross-check in tests): shift the instant by
 * -10h and read UTC fields. Correct for Hawaii precisely because HST is a
 * fixed offset with no DST transitions.
 */
export function hawaiiClockPartsFromUtcOffset(now: Date): HawaiiClockParts {
  const shifted = new Date(now.getTime() + HAWAII_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  const weekday = WEEKDAYS_LONG[shifted.getUTCDay()];
  const month = MONTHS_LONG[shifted.getUTCMonth()];
  const day = shifted.getUTCDate();
  const hours24 = shifted.getUTCHours();
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const minutes = String(shifted.getUTCMinutes()).padStart(2, "0");
  const meridiem = hours24 < 12 ? "AM" : "PM";
  return {
    time: `${hours12}:${minutes} ${meridiem}`,
    weekdayShort: weekday.slice(0, 3),
    weekday,
    date: `${month.slice(0, 3)} ${day}`,
    fullDate: `${weekday}, ${month} ${day}, ${shifted.getUTCFullYear()}`,
    tzLabel: "HST",
  };
}

type HawaiiFormatters = {
  time: Intl.DateTimeFormat;
  weekdayShort: Intl.DateTimeFormat;
  date: Intl.DateTimeFormat;
  full: Intl.DateTimeFormat;
};

let cachedFormatters: HawaiiFormatters | null | undefined;

function getFormatters(): HawaiiFormatters | null {
  if (cachedFormatters !== undefined) return cachedFormatters;
  try {
    cachedFormatters = {
      time: new Intl.DateTimeFormat("en-US", {
        timeZone: HAWAII_TIME_ZONE,
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }),
      weekdayShort: new Intl.DateTimeFormat("en-US", {
        timeZone: HAWAII_TIME_ZONE,
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
      date: new Intl.DateTimeFormat("en-US", {
        timeZone: HAWAII_TIME_ZONE,
        month: "short",
        day: "numeric",
      }),
      full: new Intl.DateTimeFormat("en-US", {
        timeZone: HAWAII_TIME_ZONE,
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      }),
    };
    // Probe once — an environment with Intl but without IANA tz data throws
    // on format, not on construction.
    cachedFormatters.time.format(new Date(0));
  } catch {
    cachedFormatters = null;
  }
  return cachedFormatters;
}

/** Formatted Hawaii wall-clock parts for an instant (defaults to now). */
export function hawaiiClockParts(now: Date = new Date()): HawaiiClockParts {
  const formatters = getFormatters();
  if (!formatters) return hawaiiClockPartsFromUtcOffset(now);
  const weekdayAndDate = normalizeSpaces(formatters.weekdayShort.format(now)); // "Tue, Jul 7"
  const weekdayShort = weekdayAndDate.split(",")[0]?.trim() || weekdayAndDate;
  const fullDate = normalizeSpaces(formatters.full.format(now));
  const weekday = fullDate.split(",")[0]?.trim() || weekdayShort;
  return {
    time: normalizeSpaces(formatters.time.format(now)),
    weekdayShort,
    weekday,
    date: normalizeSpaces(formatters.date.format(now)),
    fullDate,
    tzLabel: "HST",
  };
}
