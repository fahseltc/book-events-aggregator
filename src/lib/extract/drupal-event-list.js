// Drupal "event-list" listing provider. Used by Books Are Awesome (Parker, CO)
// and Sudden Fiction Books (Denver), which run the same Drupal event-list markup.
//
// Each listing page renders one <article id="event-N" class="event-list"> per
// event, with:
//   - title + detail link:  <h3 class="event-list__title"><a href="/event/...">
//   - "Date:" item:         "Wed, 11/11/2026"
//   - "Time:" item:         "7:00pm - 8:00pm"
//   - "Place:" item:        an address block (<address> or <p class="address">)
//   - blurb:                <div class="event-list__body">
// Every field is on the listing page, so detail pages are not visited.
//
// Two ways to walk the listing, chosen by the source's `search` block:
//   - search.pages (default): a paged view at ?page=N (0-based). Stops when a page
//     has no "next" link, or when a page has no events.
//   - search.months: a monthly view at /events/YYYY/MM, starting with the current
//     month and reading this many months ahead.
//
// The sites sit behind a Cloudflare JavaScript challenge that plain HTTP requests
// cannot pass, so each page is loaded with the headless browser helper.

import { renderPages } from '../fetch.js';
import { decodeEntities } from '../html.js';

const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MONTHS = 6;
// Cloudflare clears its challenge a few seconds after DOMContentLoaded, so the
// browser needs a longer settle time than the default.
const SETTLE_MS = 8000;

const EVENT_START = /<article id="event-\d+" class="event-list">/g;

/**
 * @param {object} source  source.url is the events page. source.search.months
 *   selects the monthly walk; otherwise source.search.pages caps the ?page=N walk.
 * @param {{ timeoutMs?: number, now?: Date }} ctx
 * @returns {Promise<import('../types.js').RawEvent[]>}
 */
export async function extractFromDrupalEventList(source, ctx = {}) {
  const listUrl = new URL(source.url);
  const origin = listUrl.origin;
  const search = source.search || {};
  const monthMode = search.months != null;
  const seen = new Set();
  const out = [];

  const urls = monthMode
    ? monthUrls(origin, listUrl.pathname, search.months || DEFAULT_MONTHS, ctx.now || new Date())
    : Array.from(
      { length: Math.max(1, search.pages || DEFAULT_MAX_PAGES) },
      (_, page) => `${origin}${listUrl.pathname}?page=${page}`,
    );

  for await (const res of renderPages(urls, { timeoutMs: ctx.timeoutMs, settleMs: SETTLE_MS })) {
    const url = res.url;
    const { total, events } = parseListingPage(res.html, origin, source);

    if (total === 0) {
      // A challenge page or an error status is a blocked fetch, not an empty
      // calendar. Throw so the caller falls back to the last snapshot.
      if (res.status >= 400 || isChallengePage(res.html)) {
        throw new Error(
          `${source.name || 'Event list'} blocked at ${url} (HTTP ${res.status}, challenge page)`,
        );
      }
      // An empty page ends a paged walk. An empty month is just a quiet month.
      if (!monthMode) break;
      continue;
    }

    for (const ev of events) {
      const key = `${ev.url}|${ev.start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ev);
    }

    if (!monthMode && !/\brel="next"/.test(res.html)) break;
  }
  return out;
}

// /events/YYYY/MM for the current month and the next count-1 months.
function monthUrls(origin, pathname, count, now) {
  const base = pathname.replace(/\/+$/, '');
  const urls = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    urls.push(`${origin}${base}/${d.getFullYear()}/${mm}`);
  }
  return urls;
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

  const body = card.match(/<div class="event-list__body">([\s\S]*?)<\/div>/);

  return {
    title,
    description: body ? text(body[1]) || undefined : undefined,
    start: when.start,
    end: when.end,
    location: placeText(card),
    url: new URL(link[1], origin).href,
    sourceName: source.name,
    sourceUrl: source.url,
    extractor: 'drupal-event-list',
  };
}

// The Place block holds the venue as text, whether it is wrapped in <address>
// (Books Are Awesome) or <p class="address"> (Sudden Fiction). Read everything
// from the Place item up to the links block, minus the "Place:" label. An empty
// Place item gives undefined.
function placeText(card) {
  const m = card.match(/event-details__location--location">([\s\S]*?)(?:<div class="event-list__links">|$)/);
  if (!m) return undefined;
  return text(m[1]).replace(/^Place:\s*/i, '').replace(/\s+([,.])/g, '$1') || undefined;
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

// Only the challenge interstitial's own title counts. Cloudflare's challenge-platform
// script also runs on ordinary pages, so matching it would flag empty months.
function isChallengePage(html) {
  return /<title>\s*Just a moment/i.test(html);
}

function text(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
