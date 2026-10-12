// RSS/Atom feed extractor. Preferred over HTML scraping whenever a source
// offers a feed: it is structured, stable, and already per-event.
//
// Dependency-free parsing: feeds are simple enough that a small regex-based
// reader over <item>/<entry> elements is robust and avoids an XML dependency.

import { decodeEntities } from '../html.js';
import { parseEventDate } from '../dates.js';

/**
 * @param {string} xml
 * @param {{ sourceName?: string, sourceUrl?: string, now?: Date }} ctx
 * @returns {import('../types.js').RawEvent[]}
 */
export function extractFromRss(xml, ctx = {}) {
  if (!xml) return [];
  const items = matchAll(xml, /<item\b[\s\S]*?<\/item>/gi);
  const entries = items.length ? items : matchAll(xml, /<entry\b[\s\S]*?<\/entry>/gi);

  const events = [];
  for (const raw of entries) {
    const title = field(raw, 'title');
    if (!title) continue;

    const link = field(raw, 'link') || attr(raw, 'link', 'href') || field(raw, 'guid');
    const descRaw = field(raw, 'description') || field(raw, 'summary');
    const content = field(raw, 'content:encoded') || field(raw, 'content');
    const pub =
      field(raw, 'pubDate') ||
      field(raw, 'published') ||
      field(raw, 'updated') ||
      field(raw, 'dc:date');

    // Start time: prefer pubDate (exact, tz-aware). Fall back to parsing the
    // description's leading date line (feeds like Communico put it there).
    const start = toIsoFromPubDate(pub) || parseEventDate(descRaw || '', { now: ctx.now });

    // Description body: prefer content:encoded (no date preamble); else strip
    // the leading date line out of description.
    const description = scrubBoilerplate(
      cleanText(content) || stripLeadingDate(cleanText(descRaw)),
    );

    events.push({
      title: cleanText(title),
      description: description || undefined,
      start: start || undefined,
      end: undefined,
      location: undefined,
      url: cleanText(link) || ctx.sourceUrl,
      sourceName: ctx.sourceName,
      sourceUrl: ctx.sourceUrl,
      extractor: 'rss',
    });
  }
  return events;
}

/** True if the text looks like an RSS/Atom feed rather than an HTML page. */
export function looksLikeFeed(text) {
  if (!text) return false;
  const head = text.slice(0, 1000).toLowerCase();
  return (
    head.includes('<rss') ||
    head.includes('<feed') ||
    (head.includes('<?xml') && (head.includes('<channel') || head.includes('rss')))
  );
}

function matchAll(s, re) {
  const out = [];
  let m;
  while ((m = re.exec(s)) !== null) out.push(m[0]);
  return out;
}

// Read the text content of the first <tag>...</tag> in `xml`, honoring CDATA.
function field(xml, tag) {
  const re = new RegExp(`<${escapeTag(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeTag(tag)}>`, 'i');
  const m = xml.match(re);
  if (!m) return undefined;
  return unwrapCdata(m[1]);
}

// Read an attribute off a self-closing/void tag, e.g. Atom <link href="...">.
function attr(xml, tag, name) {
  const re = new RegExp(`<${escapeTag(tag)}\\b[^>]*\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i');
  const m = xml.match(re);
  return m ? m[1] : undefined;
}

function unwrapCdata(s) {
  const m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return (m ? m[1] : s).trim();
}

function cleanText(s) {
  if (!s) return undefined;
  const t = decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return t || undefined;
}

function toIsoFromPubDate(pub) {
  if (!pub) return null;
  const d = new Date(pub.trim());
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  // Read UTC components: feeds like Communico encode the event's local
  // wall-clock time but tag it "+0000", so the UTC fields hold the intended
  // hour/minute (converting to machine-local time would shift it incorrectly).
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}:00`;
}

// Strip common feed boilerplate: WordPress "The post ... appeared first on ..."
// trailers and leaked CSS from page-builder plugins (SiteOrigin etc.).
function scrubBoilerplate(text) {
  if (!text) return undefined;
  let t = text;
  // Leaked CSS: everything from the first "@import url(" or "#pg..." selector on.
  t = t.replace(/@import\s+url\([\s\S]*$/i, '');
  t = t.replace(/#(?:pg|pgc|pl|panel)[-\w]*\s*\{[\s\S]*$/i, '');
  // WordPress auto-appended trailer.
  t = t.replace(/\bThe post .*? appeared first on .*$/i, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t || undefined;
}

// Remove a leading "Monday, October 12 2026 1:30pm - 2:30pm" style preamble.
function stripLeadingDate(text) {
  if (!text) return undefined;
  const re =
    /^(?:[A-Za-z]+,?\s+)?[A-Za-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{0,4}\s*\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?(?:\s*[-–—]\s*\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)?\s*/i;
  const stripped = text.replace(re, '').trim();
  return stripped || text;
}

function escapeTag(t) {
  return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
