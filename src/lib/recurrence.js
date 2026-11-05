// Recurring-event expansion for the static provider. Turns a rule such as
// "2nd Wednesday" into concrete dated occurrences inside a look-ahead window.
// Pure local-time date math with no dependencies.

const DEFAULT_MONTHS_AHEAD = 6;
const MAX_MONTHS_AHEAD = 24;

const ORDINALS = {
  '1st': 1, first: 1,
  '2nd': 2, second: 2,
  '3rd': 3, third: 3,
  '4th': 4, fourth: 4,
  '5th': 5, fifth: 5,
};

const WEEKDAYS = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

/**
 * Parse a rule like "2nd Wednesday", "every fourth tuesday", or
 * "3rd Wednesday of the month" into { n, weekday } (weekday 0 = Sunday).
 * @param {string} text
 */
export function parseWhen(text) {
  const m = String(text || '')
    .trim()
    .toLowerCase()
    .match(/^(?:every\s+)?([a-z0-9]+)\s+([a-z]+)(?:\s+of\s+(?:the|each)\s+month)?$/);
  const n = m && ORDINALS[m[1]];
  const weekday = m && WEEKDAYS[m[2]];
  if (!n || weekday === undefined) {
    throw new Error(`unrecognized "when" rule "${text}" (expected something like "2nd Wednesday")`);
  }
  return { n, weekday };
}

/**
 * Parse "HH:MM" (24-hour local time) into { hour, minute }.
 * @param {string} text
 */
export function parseTime24(text) {
  const m = String(text).match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) throw new Error(`invalid "time" "${text}" (expected 24-hour HH:MM, e.g. "19:00")`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/**
 * The date of the nth given weekday in a month, or null when that month has
 * no nth such weekday (e.g. a 5th Tuesday).
 * @param {number} year
 * @param {number} monthIndex  0-based; may exceed 11 (rolls into next year)
 * @param {number} n           1..5
 * @param {number} weekday     0 (Sunday) .. 6 (Saturday)
 * @returns {Date | null}
 */
export function nthWeekdayOfMonth(year, monthIndex, n, weekday) {
  const first = new Date(year, monthIndex, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  const date = new Date(year, monthIndex, day);
  // Days past the end of the month overflow into the next month; reject those.
  return date.getMonth() === first.getMonth() ? date : null;
}

/**
 * Expand a recurring entry into local start/end ISO strings for every
 * occurrence from today through `monthsAhead` months out.
 *
 * Accepted fields: when (required), time ("HH:MM"), durationMinutes,
 * monthsAhead (default 6), exceptions (["YYYY-MM-DD", ...] dates to skip).
 * Without `time`, starts are date-only (normalize treats them as midnight).
 *
 * @param {object} entry
 * @param {Date} [now]
 * @returns {{ start: string, end: string | null }[]}
 */
export function expandRecurring(entry, now = new Date()) {
  const { n, weekday } = parseWhen(entry.when);
  const time = entry.time == null ? null : parseTime24(entry.time);

  const monthsAhead = entry.monthsAhead ?? DEFAULT_MONTHS_AHEAD;
  if (!Number.isInteger(monthsAhead) || monthsAhead < 1 || monthsAhead > MAX_MONTHS_AHEAD) {
    throw new Error(`"monthsAhead" must be an integer from 1 to ${MAX_MONTHS_AHEAD}`);
  }

  const skip = new Set(entry.exceptions || []);
  const duration = entry.durationMinutes ?? null;
  if (duration != null && (!Number.isInteger(duration) || duration <= 0)) {
    throw new Error(`"durationMinutes" must be a positive integer`);
  }

  return occurrenceDates(n, weekday, now, monthsAhead)
    .filter((d) => !skip.has(ymd(d)))
    .map((d) => {
      if (!time) return { start: ymd(d), end: null };
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), time.hour, time.minute);
      const end = duration
        ? new Date(start.getTime() + duration * 60000)
        : null;
      return { start: isoLocal(start), end: end ? isoLocal(end) : null };
    });
}

// Occurrence dates in [today, today + monthsAhead months], oldest first.
function occurrenceDates(n, weekday, now, monthsAhead) {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const until = new Date(now.getFullYear(), now.getMonth() + monthsAhead, now.getDate(), 23, 59, 59);
  const out = [];
  for (let i = 0; i <= monthsAhead; i++) {
    const d = nthWeekdayOfMonth(now.getFullYear(), now.getMonth() + i, n, weekday);
    if (d && d >= from && d <= until) out.push(d);
  }
  return out;
}

function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isoLocal(d) {
  return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}
