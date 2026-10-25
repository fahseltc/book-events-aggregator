// Luma (lu.ma / luma.com) provider — a bookshop's full calendar of upcoming
// events.
//
// A Luma page is a Next.js shell that loads events client-side from a public
// JSON API (no auth). The richest, most COMPLETE source for a host is their
// calendar object:
//   GET https://api.luma.com/calendar/get?api_id=<cal-…>
// whose `upcoming.entries[]` holds every upcoming event on the calendar with
// full details (name, start/end, full address, slug URL) — unlike the lean
// map-pins or the user-scoped events-hosting endpoints.
//
// Config can supply `calendar_api_id` directly (preferred, one request). If only
// a user `handle` / the /user/<handle> URL is given, we resolve it: handle ->
// user api_id -> that user's events-hosting -> the calendar_api_id on an event.

import { htmlToText, decodeEntities } from '../html.js';

const API = 'https://api.luma.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

/**
 * @param {object} source  source.search may provide `calendar_api_id` (best),
 *   or a `handle` / the /user/<handle> URL to resolve it. `max` caps events.
 * @param {{ now?: Date, timeoutMs?: number }} ctx
 * @returns {Promise<import('../types.js').RawEvent[]>}
 */
export async function extractFromLuma(source, ctx = {}) {
  const timeoutMs = ctx.timeoutMs ?? 20000;
  const max = Math.max(1, (source.search && source.search.max) || 100);

  const calId = (source.search && source.search.calendar_api_id) ||
    (await resolveCalendarId(source, timeoutMs));
  if (!calId) throw new Error(`Could not determine Luma calendar_api_id for ${source.url}`);

  const data = await getJson(`${API}/calendar/get?api_id=${encodeURIComponent(calId)}`, timeoutMs);
  const entries = Array.isArray(data?.upcoming?.entries) ? data.upcoming.entries : [];
  return entries.slice(0, max).map((e) => toRawEvent(e, source));
}

// handle -> user api_id -> events-hosting -> calendar_api_id
async function resolveCalendarId(source, timeoutMs) {
  const handle = (source.search && source.search.handle) ||
    ((source.url || '').match(/luma\.com\/user\/([a-z0-9_-]+)/i) || [])[1];
  if (!handle) return null;
  const profile = await getJson(`${API}/user/profile?username=${encodeURIComponent(handle)}`, timeoutMs);
  const uid = profile?.user?.api_id || profile?.api_id;
  if (!uid) return null;
  const eh = await getJson(
    `${API}/user/profile/events-hosting?user_api_id=${uid}&period=future&pagination_limit=5`,
    timeoutMs,
  );
  for (const entry of eh?.entries || []) {
    const cal = entry?.event?.calendar_api_id;
    if (cal) return cal;
  }
  return null;
}

async function getJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': UA } });
    const text = await res.text();
    if (!res.ok) throw new Error(`Luma API ${res.status} for ${url}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function toRawEvent(entry, source) {
  const ev = entry.event || {};
  const tz = ev.timezone || 'America/Denver';
  return {
    title: clean(ev.name),
    description: clean(htmlToText(ev.description || '')),
    start: toLocalIso(ev.start_at, tz),
    end: toLocalIso(ev.end_at, tz),
    location: locationText(ev.geo_address_info, ev.location_type),
    url: ev.url ? `https://luma.com/${ev.url}` : source.url,
    sourceName: source.name,
    sourceUrl: source.url,
    extractor: 'luma',
  };
}

function locationText(geo, locationType) {
  if (locationType === 'online' || locationType === 'virtual') return 'Online';
  if (!geo || typeof geo !== 'object') return undefined;
  const full = clean(geo.full_address);
  if (full) return full;
  const parts = [clean(geo.address), clean(geo.city_state)];
  return [...new Set(parts.filter(Boolean))].join(', ') || undefined;
}

// Luma gives UTC ISO (start_at) + an IANA timezone. Convert to local wall-clock.
function toLocalIso(utc, tz) {
  if (!utc) return undefined;
  const d = new Date(utc);
  if (Number.isNaN(d.getTime())) return undefined;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'America/Denver',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const g = (k) => parts.find((p) => p.type === k)?.value;
    let hour = g('hour');
    if (hour === '24') hour = '00';
    return `${g('year')}-${g('month')}-${g('day')}T${hour}:${g('minute')}:00`;
  } catch {
    return utc.slice(0, 19);
  }
}

function clean(v) {
  if (v == null) return undefined;
  const t = decodeEntities(String(v)).replace(/\s+/g, ' ').trim();
  return t || undefined;
}
