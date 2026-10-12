// Dependency-free date parsing for freeform event text.
// Returns ISO 8601 strings (local-naive, no forced timezone) when possible.

const MONTHS = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/**
 * Parse a time-of-day like "5:00 PM", "5 PM", "17:00" into {hour, minute}.
 * @param {string} text
 * @returns {{ hour: number, minute: number } | null}
 */
export function parseTime(text) {
  if (!text) return null;
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3] ? m[3].replace(/\./g, '').toLowerCase() : null;
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  // If no am/pm and no 24h signal, we can't be fully sure, but accept as-is.
  return { hour, minute };
}

/**
 * Parse a freeform date (optionally with time) into an ISO string.
 * Chooses the year that keeps the date in the near future when the source
 * omits a year (common on event calendars).
 * @param {string} text
 * @param {{ now?: Date }} [opts]
 * @returns {string | null} ISO 8601 (no timezone) or null
 */
export function parseEventDate(text, opts = {}) {
  if (!text) return null;
  const now = opts.now || new Date();

  // 1) Already-ISO or Date-parseable with explicit year.
  const explicit = text.match(/\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (explicit) {
    const [, y, mo, d, h, mi] = explicit;
    return toIso(+y, +mo - 1, +d, h ? +h : 0, mi ? +mi : 0);
  }

  // 2) "Mon, Oct 14 · 5:00 PM" / "October 14, 2025 7:00 PM" / "Oct 14".
  const md = text.match(
    /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/,
  );
  if (md) {
    const mon = MONTHS[md[1].toLowerCase()];
    if (mon !== undefined) {
      const day = parseInt(md[2], 10);
      let year = md[3] ? parseInt(md[3], 10) : inferYear(mon, day, now);
      const time = parseTime(text.slice(md.index + md[0].length)) ||
        parseTime(text);
      return toIso(year, mon, day, time ? time.hour : 0, time ? time.minute : 0);
    }
  }

  // 3) Numeric "10/14/2025" or "10/14".
  const num = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (num) {
    const mon = parseInt(num[1], 10) - 1;
    const day = parseInt(num[2], 10);
    let year = num[3]
      ? normalizeYear(parseInt(num[3], 10))
      : inferYear(mon, day, now);
    if (mon >= 0 && mon <= 11 && day >= 1 && day <= 31) {
      const time = parseTime(text);
      return toIso(year, mon, day, time ? time.hour : 0, time ? time.minute : 0);
    }
  }

  return null;
}

function inferYear(month, day, now) {
  const y = now.getFullYear();
  const candidate = new Date(y, month, day, 23, 59, 59);
  // If the date already passed by more than a day this year, assume next year.
  if (candidate.getTime() < now.getTime() - 24 * 3600 * 1000) return y + 1;
  return y;
}

function normalizeYear(y) {
  if (y < 100) return 2000 + y;
  return y;
}

function toIso(y, mo, d, h, mi) {
  const dt = new Date(y, mo, d, h, mi, 0);
  if (Number.isNaN(dt.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(
    dt.getHours(),
  )}:${pad(dt.getMinutes())}:00`;
}

/**
 * Is the given ISO date string in the future (or today)?
 * @param {string} iso
 * @param {Date} [now]
 */
export function isUpcoming(iso, now = new Date()) {
  if (!iso) return false;
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return false;
  // Keep events from the start of today onward.
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return dt.getTime() >= startOfToday.getTime();
}
