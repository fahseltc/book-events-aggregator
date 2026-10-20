// Minimal iCalendar (.ics / VCALENDAR) parser — enough for event feeds like
// The Events Calendar's `?ical=1` export. Handles line folding, the common
// DATE-TIME / DATE forms with optional TZID, and \-escaped text values.
//
// We keep local wall-clock time (the rest of the pipeline uses naive local
// ISO strings), so TZID is used only to recognize the format, not to convert.

import { decodeEntities } from '../html.js';

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

// "20261105T083000" / "20261105" / "20261105T153449Z" -> local naive ISO.
function icalToIso(val) {
  if (!val) return undefined;
  const m = String(val).match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi] = m;
  if (h == null) return `${y}-${mo}-${d}T00:00:00`;
  return `${y}-${mo}-${d}T${h}:${mi}:00`;
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
