// WordPress "The Events Calendar" (Tribe) REST API provider.
// Endpoint: <site>/wp-json/tribe/events/v1/events
// Returns structured events with start/end, venue, and per-event URL — richer
// and cleaner than the plugin's RSS feed. Plain HTTP (no browser needed), but
// some hosts gate the API behind a WAF, so we send browser-like headers.

import { htmlToText, decodeEntities } from '../html.js';

/**
 * @param {string} siteUrl  the events page or site root (e.g. https://host/events/)
 * @param {{ sourceName?: string, now?: Date, timeoutMs?: number, perPage?: number }} ctx
 * @returns {Promise<import('../types.js').RawEvent[]>}
 */
export async function extractFromTribe(siteUrl, ctx = {}) {
  const origin = new URL(siteUrl).origin;
  const endpoint = `${origin}/wp-json/tribe/events/v1/events`;
  const perPage = ctx.perPage ?? 50;
  const start = toYmd(ctx.now || new Date());

  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: siteUrl,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  };

  const events = [];
  let page = 1;
  for (;;) {
    const url = `${endpoint}?per_page=${perPage}&start_date=${start}&page=${page}`;
    const json = await getJson(url, headers, ctx.timeoutMs ?? 20000);
    const batch = Array.isArray(json.events) ? json.events : [];
    for (const e of batch) events.push(toRawEvent(e, siteUrl, ctx));

    const totalPages = Number(json.total_pages) || 1;
    if (page >= totalPages || batch.length === 0 || page > 50) break;
    page += 1;
  }
  return events;
}

async function getJson(url, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Tribe API ${res.status} for ${url}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Tribe API returned non-JSON (status ${res.status})`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function toRawEvent(e, siteUrl, ctx) {
  return {
    title: clean(e.title),
    description: clean(htmlToText(e.description || '')),
    start: toIso(e.start_date, e.all_day),
    end: toIso(e.end_date, e.all_day),
    location: venueToText(e.venue),
    url: clean(e.url) || siteUrl,
    sourceName: ctx.sourceName,
    sourceUrl: siteUrl,
    extractor: 'tribe',
  };
}

// Venue object carries a name plus postal fields (and a junk HTML description
// we deliberately ignore).
function venueToText(venue) {
  if (!venue || typeof venue !== 'object') return undefined;
  const name = clean(venue.venue);
  const addr = [venue.address, venue.city, venue.stateprovince || venue.province, venue.zip]
    .map(clean)
    .filter(Boolean)
    .join(', ');
  const parts = [name, addr].filter(Boolean);
  return parts.length ? parts.join(' — ') : undefined;
}

// "2026-11-05 08:30:00" -> "2026-11-05T08:30:00" (already local wall-clock).
function toIso(s, allDay) {
  if (!s) return undefined;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi] = m;
  if (allDay || h == null) return `${y}-${mo}-${d}T00:00:00`;
  return `${y}-${mo}-${d}T${h}:${mi}:00`;
}

function toYmd(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function clean(v) {
  if (v == null) return undefined;
  const t = decodeEntities(String(v)).replace(/\s+/g, ' ').trim();
  return t || undefined;
}
