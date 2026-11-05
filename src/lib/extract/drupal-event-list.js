// Drupal "event-list" listing provider (Books Are Awesome, Parker CO).
//
// The events page is a Drupal View paged with ?page=N (0-based). It renders one
// <article id="event-N" class="event-list"> per event, with:
//   - title + detail link:  <h3 class="event-list__title"><a href="/event/...">
//   - "Date:" item:         "Wed, 11/11/2026"
//   - "Time:" item:         "7:00pm - 8:00pm"
//   - "Place:" item:        <address>venue and street address</address>
//   - blurb:                <div class="event-list__body">
// Every field is on the listing page, so detail pages are not visited.
//
// The site sits behind a Cloudflare JavaScript challenge that plain HTTP
// requests cannot pass, so each page is loaded with the headless browser helper.
// Paging stops when a page has no "next" link, or when a page has no events.

import { renderHtml } from '../fetch.js';
import { decodeEntities } from '../html.js';

const DEFAULT_MAX_PAGES = 10;
// Cloudflare clears its challenge a few seconds after DOMContentLoaded, so the
// browser needs a longer settle time than the default.
const SETTLE_MS = 8000;

const EVENT_START = /<article id="event-\d+" class="event-list">/g;

/**
 * @param {object} source  source.url is the events page; source.search.pages caps
 *   how many ?page=N pages are read (default 10).
 * @param {{ timeoutMs?: number }} ctx
 * @returns {Promise<import('../types.js').RawEvent[]>}
 */
export async function extractFromDrupalEventList(source, ctx = {}) {
  const listUrl = new URL(source.url);
  const origin = listUrl.origin;
  const maxPages = Math.max(1, (source.search && source.search.pages) || DEFAULT_MAX_PAGES);
  const seen = new Set();
  const out = [];

  for (let page = 0; page < maxPages; page++) {
    const url = `${origin}${listUrl.pathname}?page=${page}`;
    const res = await renderHtml(url, { timeoutMs: ctx.timeoutMs, settleMs: SETTLE_MS });
    const { total, events } = parseListingPage(res.html, origin, source);

    if (total === 0) {
      // A challenge page or an error status is a blocked fetch, not an empty
      // calendar. Throw so the caller falls back to the last snapshot.
      if (res.status >= 400 || isChallengePage(res.html)) {
        throw new Error(
          `Books Are Awesome listing blocked on page ${page} (HTTP ${res.status}, challenge page)`,
        );
      }
      break;
    }

    for (const ev of events) {
      const key = `${ev.url}|${ev.start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ev);
    }

    if (!/\brel="next"/.test(res.html)) break;
  }
  return out;
}

// Split the page into one slice per event article. Each slice runs from its
// <article> start to the next event (or the pager nav). Nested <article> tags
// inside the Place block mean we cannot match up to the first </article>.
function parseListingPage(html, origin, source) {
  const starts = [...html.matchAll(EVENT_START)].map((m) => m.index);
  const pagerAt = html.indexOf('<nav class="pager"');
  const events = [];
  for (let i = 0; i < starts.length; i++) {
    let end = starts[i + 1] ?? html.length;
    if (pagerAt > starts[i] && pagerAt < end) end = pagerAt;
    const ev = toRawEvent(html.slice(starts[i], end), origin, source);
    if (ev) events.push(ev);
  }
  return { total: starts.length, events };
}

function toRawEvent(card, origin, source) {
  const link = card.match(/<h3 class="event-list__title">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
  if (!link) return null;
  const title = text(link[2]);
  if (!title) return null;
  if (/^cancel/i.test(title)) return null; // "Cancelled ...": not happening

  const when = parseWhen(detailValue(card, 'Date'), detailValue(card, 'Time'));
  if (!when) return null;

  const address = card.match(/<address>([\s\S]*?)<\/address>/);
  const body = card.match(/<div class="event-list__body">([\s\S]*?)<\/div>/);

  return {
    title,
    description: body ? text(body[1]) || undefined : undefined,
    start: when.start,
    end: when.end,
    location: address ? text(address[1]) || undefined : undefined,
    url: new URL(link[1], origin).href,
    sourceName: source.name,
    sourceUrl: source.url,
    extractor: 'drupal-event-list',
  };
}

// The value next to a "Label:" span, e.g. <span ...>Date: </span> Wed, 11/11/2026 </div>.
function detailValue(card, label) {
  const re = new RegExp(
    `event-list__details--label">\\s*${label}:\\s*</span>\\s*([^<]*?)\\s*</div>`,
  );
  const m = card.match(re);
  return m ? text(m[1]) : undefined;
}

// "Wed, 11/11/2026" + "7:00pm - 8:00pm". No time gives a midnight start, which
// normalize treats as a date with an unknown time.
function parseWhen(dateText, timeText) {
  const d = dateText && dateText.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!d) return null;
  const month = +d[1];
  const day = +d[2];
  const year = +d[3];

  const times = [...(timeText || '').matchAll(/(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/gi)];
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

function iso(y, mo, d, h, mi) {
  const p = (n) => String(n).padStart(2, '0');
  return `${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:00`;
}

function isChallengePage(html) {
  return /Just a moment\.\.\./i.test(html) || /challenge-platform/i.test(html);
}

function text(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
