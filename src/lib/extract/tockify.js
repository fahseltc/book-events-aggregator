// Tockify calendar provider (e.g. Novel Strand).
//
// Tockify widgets load events from a public JSON API:
//   GET https://tockify.com/api/ngevent?calname=<cal>&view=agenda&max=N&startms=<epochMs>
// The "agenda" view returns the next N upcoming events (not a fixed month), so
// we avoid any calendar-window limitation. No auth required. Plain HTTP.

import { htmlToText, decodeEntities } from '../html.js';

/**
 * @param {object} source  uses source.search.calname (the Tockify calendar id);
 *   falls back to parsing it from a tockify URL. source.search.max caps events
 *   (default 100).
 * @param {{ now?: Date, timeoutMs?: number }} ctx
 * @returns {Promise<import('../types.js').RawEvent[]>}
 */
export async function extractFromTockify(source, ctx = {}) {
  const calname = tockifyCalname(source);
  if (!calname) throw new Error(`Could not determine Tockify calname for ${source.url}`);

  const now = ctx.now || new Date();
  const max = Math.max(1, (source.search && source.search.max) || 100);
  const timeoutMs = ctx.timeoutMs ?? 20000;

  const qs = new URLSearchParams({
    calname,
    view: 'agenda',
    max: String(max),
    'start-inclusive': 'true',
    longForm: 'false',
    showAll: 'false',
    startms: String(now.getTime()),
  });
  const url = `https://tockify.com/api/ngevent?${qs}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let json;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/125.0 Safari/537.36',
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Tockify API ${res.status} for ${calname}`);
    json = JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }

  const events = Array.isArray(json.events) ? json.events : [];
  const out = [];
  const seen = new Set();
  for (const ev of events) {
    const raw = toRawEvent(ev, source, ctx);
    if (!raw.title || !raw.start) continue;
    const key = `${raw.start}|${raw.title.toLowerCase()}`;
    if (seen.has(key)) continue; // collapse repeat occurrences at the same time
    seen.add(key);
    out.push(raw);
  }
  return out;
}

function toRawEvent(ev, source, ctx) {
  const when = ev.when || {};
  const content = ev.content || {};
  const uid = ev.eid?.uid;
  const url = uid
    ? `https://tockify.com/${tockifyCalname(source)}/detail/${uid}/${when.start?.millis || ''}`
    : source.url;
  return {
    title: clean(content.summary?.text),
    description: clean(htmlToText(content.description?.text || '')),
    start: toLocalIso(when.start, when.allDay),
    end: toLocalIso(when.end, when.allDay),
    location: locationText(content.location),
    url,
    sourceName: source.name,
    sourceUrl: source.url,
    extractor: 'tockify',
  };
}

function locationText(loc) {
  if (!loc || typeof loc !== 'object') return undefined;
  const addr = [loc.c_street, loc.c_locality, loc.c_region, loc.c_postcode]
    .map(clean)
    .filter(Boolean)
    .join(', ');
  // `name` is often the street address too; dedupe.
  const name = clean(loc.name);
  const parts = [...new Set([name, addr].filter(Boolean))];
  return parts.join(' — ') || undefined;
}

// Tockify gives epoch millis + tzid. Convert to the event's local wall-clock
// (what the rest of the pipeline uses). All-day events become midnight local.
function toLocalIso(t, allDay) {
  if (!t || typeof t.millis !== 'number') return undefined;
  const d = new Date(t.millis);
  if (Number.isNaN(d.getTime())) return undefined;
  const tz = t.tzid || 'America/Denver';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const g = (k) => parts.find((p) => p.type === k)?.value;
    let hour = g('hour');
    if (hour === '24') hour = '00';
    const date = `${g('year')}-${g('month')}-${g('day')}`;
    return allDay ? `${date}T00:00:00` : `${date}T${hour}:${g('minute')}:00`;
  } catch {
    return new Date(t.millis).toISOString().slice(0, 19);
  }
}

// Derive the Tockify calendar name from config.search.calname or a tockify URL.
function tockifyCalname(source) {
  if (source.search && source.search.calname) return source.search.calname;
  const m = (source.url || '').match(/tockify\.com\/([a-z0-9_-]+)/i);
  return m ? m[1] : null;
}

function clean(v) {
  if (v == null) return undefined;
  const t = decodeEntities(String(v)).replace(/\s+/g, ' ').trim();
  return t || undefined;
}
