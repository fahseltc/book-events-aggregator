// BookManager provider. Stores on the BookManager platform (e.g. The Bookies)
// render events client-side from a JSON API:
//   POST https://api.bookmanager.com/customer/event/v2/list
// The API requires a session_id/uuid that the site's own JS establishes, so we
// drive it through a headless page context (which already holds a valid
// session) rather than reverse-engineering the auth handshake. We capture the
// session fields from the page's first API call, then re-issue the call with a
// large limit and paginate.

import { decodeEntities, htmlToText } from '../html.js';

const API = 'https://api.bookmanager.com/customer/event/v2/list';

/**
 * @param {string} pageUrl  the store's events page (e.g. https://thebookies.com/events)
 * @param {{ sourceName?: string, now?: Date, timeoutMs?: number, pageLimit?: number }} ctx
 * @returns {Promise<import('../types.js').RawEvent[]>}
 */
export async function extractFromBookManager(pageUrl, ctx = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error(
      `BookManager sources need Playwright. Install it with:\n` +
      `  npm install playwright && npx playwright install chromium`,
    );
  }

  const timeoutMs = ctx.timeoutMs ?? 45000;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();

    // Capture the session fields from the page's own event/list request.
    const fields = await captureSessionFields(page, pageUrl, timeoutMs);
    if (!fields || !fields.session_id || !fields.store_id) {
      throw new Error('Could not capture BookManager session (site may have changed).');
    }

    const startDate = toYyyymmdd(ctx.now || new Date());
    const rows = await fetchAllRows(page, fields, startDate, ctx.pageLimit ?? 200);

    return rows.map((row) => rowToRawEvent(row, pageUrl, ctx));
  } finally {
    await browser.close();
  }
}

// Load the page and read the uuid/session_id/store_id out of the first
// multipart POST the page makes to the event list endpoint.
async function captureSessionFields(page, pageUrl, timeoutMs) {
  let fields = null;
  page.on('request', (req) => {
    if (fields || !req.url().includes('event/v2/list')) return;
    const pd = req.postData() || '';
    fields = {
      uuid: multipartField(pd, 'uuid'),
      session_id: multipartField(pd, 'session_id'),
      store_id: multipartField(pd, 'store_id'),
    };
  });
  await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: timeoutMs });
  return fields;
}

// Re-issue the API call from inside the page (so the request carries the same
// session/origin), paginating by offset until a short page is returned.
async function fetchAllRows(page, fields, startDate, pageLimit) {
  const all = [];
  for (let offset = 0; ; offset += pageLimit) {
    const batch = await page.evaluate(
      async ({ api, fields, startDate, offset, pageLimit }) => {
        const fd = new FormData();
        fd.set('uuid', fields.uuid || '');
        fd.set('session_id', fields.session_id || '');
        fd.set('store_id', fields.store_id || '');
        fd.set('log_url', '/events');
        fd.set('start_date', startDate);
        fd.set('offset', String(offset));
        fd.set('limit', String(pageLimit));
        const res = await fetch(api, { method: 'POST', body: fd });
        const json = await res.json();
        return Array.isArray(json.rows) ? json.rows : [];
      },
      { api: API, fields, startDate, offset, pageLimit },
    );
    all.push(...batch);
    if (batch.length < pageLimit) break; // last page
    if (all.length > 2000) break; // safety cap
  }
  return all;
}

function rowToRawEvent(row, pageUrl, ctx) {
  const start = combineDateTime(row.date, row.start_time);
  const end = row.end_date || row.end_time
    ? combineDateTime(row.end_date || row.date, row.end_time)
    : undefined;
  // Per-event page is the events URL plus the row id, e.g.
  // https://thebookies.com/events/621720261013
  const eventUrl = row.id != null ? `${pageUrl.replace(/\/$/, '')}/${row.id}` : pageUrl;

  return {
    title: clean(row.title),
    description: clean(htmlToText(row.description || '')) || clean(htmlToText(row.summary || '')),
    start,
    end,
    location: clean(row.location_text) || undefined,
    url: eventUrl,
    sourceName: ctx.sourceName,
    sourceUrl: pageUrl,
    extractor: 'bookmanager',
  };
}

// "20261012" + "10:00:00" -> "2026-10-12T10:00:00"
function combineDateTime(yyyymmdd, hms) {
  if (!yyyymmdd || !/^\d{8}$/.test(String(yyyymmdd))) return undefined;
  const s = String(yyyymmdd);
  const date = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const time = /^\d{2}:\d{2}(:\d{2})?$/.test(hms || '') ? hms.slice(0, 5) : '00:00';
  return `${date}T${time}:00`;
}

function toYyyymmdd(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

// Read a field value out of a multipart/form-data body string.
function multipartField(body, name) {
  const re = new RegExp(`name="${name}"\\r?\\n\\r?\\n([^\\r\\n]*)`);
  const m = body.match(re);
  return m ? m[1] : null;
}

function clean(v) {
  if (v == null) return undefined;
  const t = decodeEntities(String(v)).replace(/\s+/g, ' ').trim();
  return t || undefined;
}
