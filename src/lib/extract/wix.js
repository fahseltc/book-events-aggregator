// Wix Events provider (e.g. Little Blue Pigeon Books).
//
// Wix's "Events" calendar widget renders only the currently-displayed month in
// the page HTML, so scraping the page misses future months. Instead we use the
// widget's own API:
//   GET <site>/_api/wix-one-events-server/web/calendar-events/viewer?referenceDate=<ISO>&…
// which returns a month's events as structured JSON. The call needs the site's
// viewer `authorization` token and the widget `compId`, both of which we lift
// from a single headless page load. We then query a span of future months so
// the result isn't limited to whatever the calendar happens to show today.

import { htmlToText, decodeEntities } from '../html.js';

/**
 * @param {object} source  uses source.url (the events page). Optional
 *   source.search.months controls how many months ahead to fetch (default 6).
 * @param {{ now?: Date, timeoutMs?: number }} ctx
 * @returns {Promise<import('../types.js').RawEvent[]>}
 */
export async function extractFromWix(source, ctx = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error(
      `Wix source needs Playwright. Install it with:\n` +
      `  npm install playwright && npx playwright install chromium`,
    );
  }

  const now = ctx.now || new Date();
  const months = Math.max(1, (source.search && source.search.months) || 6);
  const timeoutMs = Math.max(ctx.timeoutMs ?? 0, 45000);
  const origin = new URL(source.url).origin;
  const api = `${origin}/_api/wix-one-events-server/web/calendar-events/viewer`;

  const browser = await chromium.launch();
  const byId = new Map(); // dedupe multi-day events that appear in several months
  try {
    const ctxP = await browser.newContext();
    const page = await ctxP.newPage();

    // Lift the viewer auth token (shared by all Wix _api calls) and the events
    // widget compId from a single page load.
    let auth = null;
    let compId = null;
    page.on('request', (req) => {
      const h = req.headers();
      if (!auth && h.authorization && /\/_api\//.test(req.url())) auth = h.authorization;
      const m = req.url().match(/calendar-events\/viewer\?.*?compId=([^&]+)/);
      if (m && !compId) compId = decodeURIComponent(m[1]);
    });
    await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(4000);
    if (!compId) {
      compId = await page.evaluate(() => {
        const m = document.documentElement.outerHTML.match(/compId=(TPASection_[a-z0-9]+)/i) ||
          document.documentElement.outerHTML.match(/"(TPASection_[a-z0-9]+)"/i);
        return m ? m[1] : null;
      });
    }
    if (!auth || !compId) {
      throw new Error('Could not obtain Wix viewer token / compId (site may have changed).');
    }

    for (let i = 0; i < months; i++) {
      const ref = monthStartIso(now, i);
      const qs = new URLSearchParams({
        referenceDate: ref,
        filter: '0',
        byEventId: 'false',
        paidPlans: 'false',
        locale: 'en',
        showcase: 'false',
        filterType: '2',
        sortOrder: '0',
        multiDayExperimentEnabled: 'true',
        expandBounds: 'true',
        fetchBadges: 'true',
        draft: 'false',
        compId,
        tz: 'America/Denver',
      });
      let json;
      try {
        const res = await ctxP.request.get(`${api}?${qs}`, {
          headers: { authorization: auth, accept: 'application/json' },
        });
        if (!res.ok()) continue;
        json = JSON.parse(await res.text());
      } catch {
        continue; // skip a month that fails; keep what we have
      }
      for (const ev of json.events || []) {
        const id = ev.id || ev.slug;
        if (id && byId.has(id)) continue;
        if (id) byId.set(id, toRawEvent(ev, origin, source, ctx));
        else byId.set(Symbol(), toRawEvent(ev, origin, source, ctx));
      }
    }
    return [...byId.values()];
  } finally {
    await browser.close();
  }
}

function toRawEvent(ev, origin, source, ctx) {
  const sched = ev.scheduling?.config || {};
  const location = locationText(ev.location);
  const url = ev.slug ? `${origin}/event-details/${ev.slug}` : source.url;
  return {
    title: clean(ev.title),
    description: clean(htmlToText(ev.about || ev.description || '')),
    start: toLocalIso(sched.startDate, sched.timeZoneId),
    end: toLocalIso(sched.endDate, sched.timeZoneId),
    location,
    url,
    sourceName: source.name,
    sourceUrl: source.url,
    extractor: 'wix',
  };
}

function locationText(loc) {
  if (!loc || typeof loc !== 'object') return undefined;
  // `address` is a plain formatted string; `name` is the venue label.
  const addr = typeof loc.address === 'string'
    ? loc.address
    : loc.fullAddress?.formattedAddress;
  const parts = [clean(loc.name), clean(addr)];
  // Avoid "Name — Name" when the venue name is also the address.
  const uniq = [...new Set(parts.filter(Boolean))];
  return uniq.join(' — ') || undefined;
}

// Wix gives UTC ISO (e.g. "2026-10-24T16:00:00.000Z") plus a timeZoneId. Convert
// to the event's local wall-clock, which is what the rest of the pipeline uses.
function toLocalIso(utc, timeZoneId) {
  if (!utc) return undefined;
  const d = new Date(utc);
  if (Number.isNaN(d.getTime())) return undefined;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZoneId || 'America/Denver',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const g = (t) => parts.find((p) => p.type === t)?.value;
    let hour = g('hour');
    if (hour === '24') hour = '00';
    return `${g('year')}-${g('month')}-${g('day')}T${hour}:${g('minute')}:00`;
  } catch {
    return utc.slice(0, 19);
  }
}

// First day of the month that is `offset` months after `now`, as a UTC ISO
// string (the calendar API buckets by month around this reference date).
function monthStartIso(now, offset) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1, 6, 0, 0));
  return d.toISOString();
}

function clean(v) {
  if (v == null) return undefined;
  const t = decodeEntities(String(v)).replace(/\s+/g, ' ').trim();
  return t || undefined;
}
