// Squarespace Events calendar (e.g. Fiction Beer, Denver).
//
// The events page embeds a calendar block (`sqs-block-calendar`) whose JSON
// names a collectionId. The calendar loads one month at a time from
//   GET <site>/api/open/GetItemsByMonth?month=MM-YYYY&collectionId=<id>
// which returns a JSON array of events with epoch-millisecond start/end times.
// That endpoint needs no session or crumb, so this is plain HTTP with no browser.

import { fetchHtml } from '../fetch.js';
import { decodeEntities, htmlToText } from '../html.js';

const TIME_ZONE = 'America/Denver';
const DEFAULT_MONTHS = 6;

/**
 * @param {object} source  uses source.url (the events page). Optional:
 *   source.search.months (default 6) and source.search.collectionId (skips
 *   discovery). source.locationName is attached to each event, since the
 *   calendar's own location field is empty on these sites.
 * @param {{ now?: Date, timeoutMs?: number }} ctx
 * @returns {Promise<import('../types.js').RawEvent[]>}
 */
export async function extractFromSquarespaceEvents(source, ctx = {}) {
  const now = ctx.now || new Date();
  const months = Math.max(1, (source.search && source.search.months) || DEFAULT_MONTHS);
  const origin = new URL(source.url).origin;

  let collectionId = source.search && source.search.collectionId;
  if (!collectionId) {
    const page = await fetchHtml(source.url, { timeoutMs: ctx.timeoutMs });
    collectionId = findCollectionId(page.html);
    if (!collectionId) {
      throw new Error('No Squarespace calendar collectionId on the events page (site may have changed).');
    }
  }

  const byUrl = new Map(); // a multi-day event can show up in more than one month
  for (let i = 0; i < months; i++) {
    const items = await fetchMonth(origin, collectionId, monthParam(now, i), ctx.timeoutMs);
    for (const item of items) {
      const raw = toRawEvent(item, origin, source);
      if (raw && !byUrl.has(raw.url)) byUrl.set(raw.url, raw);
    }
  }
  return [...byUrl.values()];
}

// Prefer the id inside the calendar block; fall back to the first id on the page.
function findCollectionId(html) {
  const re = /collectionId(?:&quot;|")\s*:\s*(?:&quot;|")([0-9a-f]{24})/i;
  const at = html.indexOf('sqs-block-calendar');
  const scoped = at >= 0 ? html.slice(at, at + 2000).match(re) : null;
  const m = scoped || html.match(re);
  return m ? m[1] : null;
}

// Throws on HTTP or JSON failure. index.js then falls back to the last snapshot,
// which is safer than publishing a partial month as if it were complete.
async function fetchMonth(origin, collectionId, month, timeoutMs) {
  const qs = new URLSearchParams({ month, collectionId });
  const res = await fetchHtml(`${origin}/api/open/GetItemsByMonth?${qs}`, {
    timeoutMs,
  });
  if (res.status !== 200) {
    throw new Error(`Squarespace events month ${month} returned HTTP ${res.status}`);
  }
  let json;
  try {
    json = JSON.parse(res.html);
  } catch {
    throw new Error(`Squarespace events month ${month} did not return JSON`);
  }
  return Array.isArray(json) ? json : [];
}

function toRawEvent(item, origin, source) {
  const title = clean(item.title);
  const when = item.structuredContent || {};
  const start = toLocalIso(when.startDate);
  if (!title || !start || !item.fullUrl) return null;
  return {
    title,
    description: clean(htmlToText(item.excerpt || '')),
    start,
    end: toLocalIso(when.endDate),
    location: clean(source.locationName),
    url: `${origin}${item.fullUrl}`,
    sourceName: source.name,
    sourceUrl: source.url,
    extractor: 'squarespace',
  };
}

// Epoch milliseconds -> local wall-clock ISO in the venue's time zone (the rest
// of the pipeline expects local time without an offset).
function toLocalIso(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const g = (t) => parts.find((p) => p.type === t)?.value;
  const hour = g('hour') === '24' ? '00' : g('hour');
  return `${g('year')}-${g('month')}-${g('day')}T${hour}:${g('minute')}:00`;
}

// "MM-YYYY" for the month `offset` months after `now`, in the venue's time zone.
function monthParam(now, offset) {
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
}

function clean(v) {
  if (v == null) return undefined;
  const t = decodeEntities(String(v)).replace(/\s+/g, ' ').trim();
  return t || undefined;
}
