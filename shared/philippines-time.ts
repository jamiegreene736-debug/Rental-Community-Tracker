// Pure Philippine local-time formatting for the header clock (client),
// mirroring shared/hawaii-time.ts. Philippine Standard Time is fixed UTC+8
// year-round (the Philippines has not observed DST since 1990), which is why
// the no-Intl fallback below can be a plain offset shift and still be correct.

export const PHILIPPINES_TIME_ZONE = "Asia/Manila";
export const PHILIPPINES_UTC_OFFSET_HOURS = 8;

export interface PhilippinesClockParts {
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
  /** Always "PHT" — the Philippines has no DST so the label never flips. */
  tzLabel: "PHT";
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
 * +8h and read UTC fields. Correct for the Philippines precisely because PHT
 * is a fixed offset with no DST transitions.
 */
export function philippinesClockPartsFromUtcOffset(now: Date): PhilippinesClockParts {
  const shifted = new Date(now.getTime() + PHILIPPINES_UTC_OFFSET_HOURS * 60 * 60 * 1000);
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
    tzLabel: "PHT",
  };
}

type PhilippinesFormatters = {
  time: Intl.DateTimeFormat;
  weekdayShort: Intl.DateTimeFormat;
  date: Intl.DateTimeFormat;
  full: Intl.DateTimeFormat;
};

let cachedFormatters: PhilippinesFormatters | null | undefined;

function getFormatters(): PhilippinesFormatters | null {
  if (cachedFormatters !== undefined) return cachedFormatters;
  try {
    cachedFormatters = {
      time: new Intl.DateTimeFormat("en-US", {
        timeZone: PHILIPPINES_TIME_ZONE,
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }),
      weekdayShort: new Intl.DateTimeFormat("en-US", {
        timeZone: PHILIPPINES_TIME_ZONE,
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
      date: new Intl.DateTimeFormat("en-US", {
        timeZone: PHILIPPINES_TIME_ZONE,
        month: "short",
        day: "numeric",
      }),
      full: new Intl.DateTimeFormat("en-US", {
        timeZone: PHILIPPINES_TIME_ZONE,
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

/** Formatted Philippine wall-clock parts for an instant (defaults to now). */
export function philippinesClockParts(now: Date = new Date()): PhilippinesClockParts {
  const formatters = getFormatters();
  if (!formatters) return philippinesClockPartsFromUtcOffset(now);
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
    tzLabel: "PHT",
  };
}
