// Eventbrite discovery provider (option 1: public search page scrape).
//
// Eventbrite retired their public event *search* API, so there is no official
// keyword/location search endpoint anymore. Instead we load Eventbrite's public
// search results page in a headless browser and read the `__SERVER_DATA__` JSON
// blob it embeds (same data the page renders from). No API key required.
//
// Configurable via the source's `search` object:
//   { place: "co--denver", query: "books", pages: 3 }
// which maps to https://www.eventbrite.com/d/<place>/<query>/?page=N

import { htmlToText, decodeEntities } from '../html.js';

/**
 * @param {object} source  the source config (uses source.search)
 * @param {{ now?: Date, timeoutMs?: number }} ctx
 * @returns {Promise<import('../types.js').RawEvent[]>}
 */
export async function extractFromEventbrite(source, ctx = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error(
      `Eventbrite source needs Playwright. Install it with:\n` +
      `  npm install playwright && npx playwright install chromium`,
    );
  }

  const search = source.search || {};
  const place = search.place || 'co--denver';
  const query = search.query || 'books';
  const maxPages = Math.max(1, search.pages || 3);
  // Eventbrite pages are heavy; give them room regardless of the global default.
  const timeoutMs = Math.max(ctx.timeoutMs ?? 0, 60000);

  const browser = await chromium.launch();
  const seenIds = new Set();
  const events = [];
  try {
    const page = await browser.newPage();
    for (let n = 1; n <= maxPages; n++) {
      const url = `https://www.eventbrite.com/d/${place}/${encodeURIComponent(
        query,
      )}/?page=${n}`;

      let html;
      try {
        // 'domcontentloaded' is enough — the data is in the initial HTML blob,
        // and waiting for full networkidle on Eventbrite is slow/flaky.
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        html = await page.content();
      } catch (err) {
        // Don't let one slow page sink the whole source; keep what we have.
        if (n === 1) throw err;
        break;
      }

      const data = extractServerData(html);
      const block = data?.search_data?.events;
      const results = Array.isArray(block?.results) ? block.results : [];
      for (const r of results) {
        const id = r.eventbrite_event_id || r.id || r.eid;
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        if (r.is_cancelled) continue;
        events.push(toRawEvent(r, source, ctx));
      }

      const totalPages = block?.pagination?.page_count || 1;
      if (n >= totalPages || results.length === 0) break;
    }
    return events;
  } finally {
    await browser.close();
  }
}

// Pull and parse the `window.__SERVER_DATA__ = {...};` object via brace
// counting (the blob is large and contains nested braces/strings).
function extractServerData(html) {
  const marker = html.indexOf('__SERVER_DATA__');
  if (marker === -1) return null;
  const objStart = html.indexOf('{', marker);
  if (objStart === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = objStart; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(objStart, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function toRawEvent(r, source, ctx) {
  const venue = r.primary_venue || {};
  const addr = venue.address?.localized_address_display;
  const location = r.is_online_event
    ? 'Online'
    : [clean(venue.name), clean(addr)].filter(Boolean).join(' — ') || undefined;

  return {
    title: clean(r.name),
    description: clean(r.summary) || clean(htmlToText(r.full_description || '')),
    start: toIso(r.start_date, r.start_time),
    end: toIso(r.end_date, r.end_time),
    location,
    url: clean(r.url) || source.url,
    sourceName: source.name,
    sourceUrl: source.url,
    extractor: 'eventbrite',
  };
}

// Eventbrite splits date and time: start_date "2026-10-26", start_time "19:30".
function toIso(date, time) {
  if (!date) return undefined;
  const d = String(date).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!d) return undefined;
  const t = /^\d{1,2}:\d{2}/.test(time || '') ? String(time) : '00:00';
  const [hh, mm] = t.split(':');
  return `${d[1]}-${d[2]}-${d[3]}T${hh.padStart(2, '0')}:${mm.slice(0, 2)}:00`;
}

function clean(v) {
  if (v == null) return undefined;
  const t = decodeEntities(String(v)).replace(/\s+/g, ' ').trim();
  return t || undefined;
}
