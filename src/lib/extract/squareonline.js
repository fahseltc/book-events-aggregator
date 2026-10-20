// Square Online (editmysite / Weebly-successor) events provider.
//
// Square Online event pages are a JS-rendered shell (<div id="app">) whose data
// lives in a `window.__BOOTSTRAP_STATE__` JSON blob. Events are authored as a
// "repeatables" content block in the page builder; each repeatable stores its
// title and body as Quill rich-text ops (arrays of { insert } fragments). The
// date is embedded in the body text in a "Month Day | time" form
// (e.g. "October 7th | 6pm"), which parseEventDate understands.
//
// We render the page once, read the bootstrap state, reconstruct each
// repeatable's title + text from its Quill ops, and parse an event out of it.
// Repeatables without a parseable date (e.g. standing notices) are skipped.

import { parseEventDate } from '../dates.js';
import { decodeEntities } from '../html.js';

/**
 * @param {object} source  uses source.url (the events page)
 * @param {{ now?: Date, timeoutMs?: number }} ctx
 * @returns {Promise<import('../types.js').RawEvent[]>}
 */
export async function extractFromSquareOnline(source, ctx = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error(
      `Square Online source needs Playwright. Install it with:\n` +
      `  npm install playwright && npx playwright install chromium`,
    );
  }

  const now = ctx.now || new Date();
  const timeoutMs = Math.max(ctx.timeoutMs ?? 0, 45000);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    // The bootstrap state is inlined at load; a brief settle covers slow hydration.
    await page.waitForTimeout(2500);
    const stateJson = await page.evaluate(() => {
      try {
        return window.__BOOTSTRAP_STATE__ ? JSON.stringify(window.__BOOTSTRAP_STATE__) : null;
      } catch {
        return null;
      }
    });
    if (!stateJson) {
      throw new Error('No __BOOTSTRAP_STATE__ found (not a Square Online page, or markup changed).');
    }

    const state = JSON.parse(stateJson);
    const repeatables = collectRepeatables(state);
    const out = [];
    for (const rep of repeatables) {
      const title = clean(quillText(rep.title));
      const body = clean(quillText(rep.text));
      if (!title && !body) continue;
      // The date is embedded in the body text; require one so we don't emit
      // non-event notices.
      const start = parseEventDate(body || '', { now });
      if (!start) continue;
      out.push({
        title: title || body.slice(0, 80),
        description: body || undefined,
        start,
        end: undefined,
        location: source.locationName || undefined,
        url: source.url,
        sourceName: source.name,
        sourceUrl: source.url,
        extractor: 'squareonline',
      });
    }
    return out;
  } finally {
    await browser.close();
  }
}

// Walk the page content tree and gather every "repeatables" array (the page
// builder's repeating blocks). Defensive: tolerate shape changes by searching
// rather than hard-coding the full path.
function collectRepeatables(state) {
  const found = [];
  const seen = new Set();
  (function walk(node, depth) {
    if (!node || typeof node !== 'object' || depth > 40) return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    for (const [key, val] of Object.entries(node)) {
      if (key === 'repeatables' && Array.isArray(val)) {
        for (const r of val) if (r && typeof r === 'object') found.push(r);
      }
      walk(val, depth + 1);
    }
  })(state, 0);
  return found;
}

// Reconstruct plain text from a Quill delta ({ content: { quill: { ops: [...] }}}).
function quillText(node) {
  const ops = node?.content?.quill?.ops;
  if (!Array.isArray(ops)) return '';
  return ops.map((o) => (typeof o.insert === 'string' ? o.insert : '')).join('');
}

function clean(v) {
  if (v == null) return undefined;
  const t = decodeEntities(String(v)).replace(/\s+/g, ' ').trim();
  return t || undefined;
}
