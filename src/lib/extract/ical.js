// Minimal iCalendar (.ics / VCALENDAR) parser — enough for event feeds like
// The Events Calendar's `?ical=1` export. Handles line folding, the common
// DATE-TIME / DATE forms with optional TZID, and \-escaped text values.
//
// We keep local wall-clock time (the rest of the pipeline uses naive local
// ISO strings). UTC stamps ("...Z") are converted to FEED_TZ; TZID values are
// used only to recognize the format, not to convert.

import { decodeEntities } from '../html.js';

/**
 * Fetch an iCalendar feed (webcal:// or https://) and return its events.
 * @param {object} source  uses source.url; optional source.excludeTitle (regex,
 *   case-insensitive) drops matching titles (e.g. library closures).
 * @param {{ now?: Date, timeoutMs?: number }} ctx
 * @returns {Promise<import('../types.js').RawEvent[]>}
 */
export async function extractFromIcal(source, ctx = {}) {
  const url = String(source.url).replace(/^webcal:\/\//i, 'https://');
  const timeoutMs = ctx.timeoutMs ?? 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/calendar',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/125.0 Safari/537.36',
      },
    });
    text = await res.text();
    if (!res.ok) throw new Error(`iCal feed ${res.status} for ${url}`);
  } finally {
    clearTimeout(timer);
  }
  const skip = source.excludeTitle ? new RegExp(source.excludeTitle, 'i') : null;
  const seen = new Set();
  const out = [];
  for (const raw of parseIcal(text, { sourceName: source.name, sourceUrl: source.url })) {
    if (!raw.title || !raw.start) continue;
    if (skip && skip.test(raw.title)) continue;
    const key = `${raw.start}|${raw.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

/**
 * Parse VEVENTs from iCalendar text into RawEvents.
 * @param {string} text  raw .ics content
 * @param {{ sourceName?: string, sourceUrl?: string }} ctx
 * @returns {import('../types.js').RawEvent[]}
 */
export function parseIcal(text, ctx = {}) {
  const lines = unfold(text);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (cur) events.push(toRawEvent(cur, ctx));
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const rawKey = line.slice(0, idx); // may include ;params
    const value = line.slice(idx + 1);
    const key = rawKey.split(';')[0].toUpperCase();
    // Keep the first occurrence of each key.
    if (!(key in cur)) cur[key] = value;
  }
  return events;
}

function toRawEvent(v, ctx) {
  return {
    title: clean(unescapeText(v.SUMMARY)),
    description: clean(unescapeText(v.DESCRIPTION)),
    start: icalToIso(v.DTSTART),
    end: icalToIso(v.DTEND),
    location: clean(unescapeText(v.LOCATION)),
    url: clean(v.URL) || ctx.sourceUrl,
    sourceName: ctx.sourceName,
    sourceUrl: ctx.sourceUrl,
    extractor: 'ical',
  };
}

// RFC 5545 line unfolding: a line beginning with a space/tab continues the
// previous one. Normalizes CRLF/CR/LF.
function unfold(text) {
  const raw = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

// Feed timezone for UTC ("...Z") timestamps. Gilpin's feed is America/Denver.
const FEED_TZ = 'America/Denver';

// "20261105" -> all-day midnight. "20261105T083000" -> floating local time (kept as-is).
// "20261105T153449Z" -> UTC, converted to FEED_TZ wall-clock time.
function icalToIso(val) {
  if (!val) return undefined;
  const m = String(val).match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h == null) return `${y}-${mo}-${d}T00:00:00`;
  if (!z) return `${y}-${mo}-${d}T${h}:${mi}:00`;
  const utcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  return utcMsToLocalIso(utcMs, FEED_TZ);
}

// Epoch ms -> naive ISO wall-clock time in the given IANA zone.
function utcMsToLocalIso(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const g = (k) => parts.find((p) => p.type === k)?.value;
  const hour = g('hour') === '24' ? '00' : g('hour');
  return `${g('year')}-${g('month')}-${g('day')}T${hour}:${g('minute')}:00`;
}

function unescapeText(v) {
  if (v == null) return undefined;
  return String(v)
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function clean(v) {
  if (v == null) return undefined;
  const t = decodeEntities(String(v)).replace(/\s+/g, ' ').trim();
  return t || undefined;
}
