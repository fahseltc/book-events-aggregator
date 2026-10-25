// Compass (Broomfield Library) provider — Drupal "library_calendar" event list.
//
// https://compass.broomfield.org/events/list is server-rendered HTML with one
// <article class="event-card"> per event, paged with ?page=N (0-based). There is
// no feed or JSON API, so we parse the cards:
//   - title + detail link:  <h2><a href="/event/<slug>">Title</a></h2>
//   - start:  the link's aria-label ("... on Sunday, October 25, 2026 @ 1:00pm - Venue")
//             with a fallback to the date block ("Sunday, October 25, 2026 at 1:00pm - 3:00pm")
//   - end:    the date block's second time, or the end date of an "All Day 10/4 - 11/1" range
//   - location, program type and age group (used as description text)
// Cancelled and closed entries are skipped.

import { decodeEntities } from '../html.js';

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const CARD_RE = /<article[^>]*class="[^"]*event-card[^"]*"[\s\S]*?<\/article>/g;

/**
 * @param {object} source  source.url is the events list page; source.search.pages
 *   caps how many ?page=N pages to read (default 6). Stops early on an empty page.
 * @param {{ now?: Date, timeoutMs?: number }} ctx
 * @returns {Promise<import('../types.js').RawEvent[]>}
 */
export async function extractFromCompass(source, ctx = {}) {
  const listUrl = new URL(source.url);
  const origin = listUrl.origin;
  const maxPages = Math.max(1, (source.search && source.search.pages) || 6);
  const timeoutMs = ctx.timeoutMs ?? 20000;
  const seen = new Set();
  const out = [];

  for (let page = 0; page < maxPages; page++) {
    const url = `${origin}${listUrl.pathname}?page=${page}`;
    const html = await getText(url, timeoutMs);
    const cards = html.match(CARD_RE) || [];
    if (cards.length === 0) break;
    for (const card of cards) {
      const ev = toRawEvent(card, origin, source);
      if (!ev) continue;
      const key = `${ev.url}|${ev.start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ev);
    }
  }
  return out;
}

async function getText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/125.0 Safari/537.36',
      },
    });
    if (!res.ok) throw new Error(`Compass ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function toRawEvent(card, origin, source) {
  const link = card.match(/<h2>\s*<a([^>]*)>([\s\S]*?)<\/a>/);
  if (!link) return null;
  const attrs = link[1];
  const href = (attrs.match(/href="([^"]+)"/) || [])[1];
  const aria = decodeEntities((attrs.match(/aria-label="([^"]*)"/) || [])[1] || '');
  const title = text(link[2]);
  if (!href || !title) return null;
  if (/^(cancel|closed)/i.test(title)) return null; // "Cancelled!", "CLOSED": not happening

  const dateBlock = text((card.match(/lc-list-event-date">([\s\S]*?)<\/div>\s*<\/div>/) || [])[1] || '');
  const location = text((card.match(/lc-list-event-location">([\s\S]*?)<\/div>/) || [])[1] || '');
  const program = text((card.match(/lc-list-event-program-type-label">Program Type:<\/div>([\s\S]*?)<\/div>/) || [])[1] || '');

  const when = parseWhen(aria, dateBlock);
  if (!when.start) return null;

  // Program only. The age-group list ("Teens, Tweens, Adults, Everyone") is
  // deliberately left out: it names every audience an event is open to, so
  // exclude words like "teen"/"tween" would drop all-ages events.
  const description = program ? `Program: ${program}` : undefined;

  return {
    title,
    description,
    start: when.start,
    end: when.end,
    location: location || undefined,
    url: new URL(href, origin).href,
    sourceName: source.name,
    sourceUrl: source.url,
    extractor: 'compass',
  };
}

// Start from the aria-label ("Sunday, October 25, 2026 @ 1:00pm - Venue"), else
// the date block ("Sunday, October 25, 2026 at 1:00pm - 3:00pm" or "All Day 10/4 - 11/1").
function parseWhen(aria, dateBlock) {
  const allDay = /^All Day\b/i.test(dateBlock);

  // "All Day 10/4 - 11/1": a numeric multi-day range.
  const numRange = dateBlock.match(/(\d{1,2})\/(\d{1,2})\s*[-–—]\s*(\d{1,2})\/(\d{1,2})/);
  if (allDay && numRange) {
    const year = yearFrom(aria) || new Date().getFullYear();
    return {
      start: iso(year, +numRange[1], +numRange[2], 0, 0),
      end: iso(year, +numRange[3], +numRange[4], 0, 0),
    };
  }

  // Date: prefer the aria-label (it always has the full "Weekday, Month D, YYYY"),
  // else the date block. Times: prefer the date block, which carries the range
  // ("1:00pm - 3:00pm"); the aria-label only has the start time.
  const longDate = /([A-Za-z]+),?\s+([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/;
  const dateSrc = aria && longDate.test(aria) ? aria : dateBlock;
  const d = dateSrc.match(longDate) || dateBlock.match(longDate);
  if (!d || !MONTHS[d[2].toLowerCase()]) return {};
  const month = MONTHS[d[2].toLowerCase()];
  const day = +d[3];
  const year = +d[4];

  const timeSrc = /\d{1,2}(?::\d{2})?\s*[ap]\.?m/i.test(dateBlock) ? dateBlock : aria;
  const dm = timeSrc.match(longDate);
  const after = dm ? timeSrc.slice(dm.index + dm[0].length) : timeSrc;
  const times = [...after.matchAll(/(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/gi)];
  if (times.length === 0) return { start: iso(year, month, day, 0, 0) };

  const start = toHM(times[0]);
  const end = times[1] ? toHM(times[1]) : null;
  return {
    start: iso(year, month, day, start.h, start.m),
    end: end ? iso(year, month, day, end.h, end.m) : undefined,
  };
}

function toHM(m) {
  let h = +m[1] % 12;
  if (m[3].toLowerCase() === 'p') h += 12;
  return { h, m: m[2] ? +m[2] : 0 };
}

function yearFrom(s) {
  const m = (s || '').match(/(\d{4})/);
  return m ? +m[1] : null;
}

function iso(y, mo, d, h, mi) {
  const p = (n) => String(n).padStart(2, '0');
  return `${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:00`;
}

function text(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
