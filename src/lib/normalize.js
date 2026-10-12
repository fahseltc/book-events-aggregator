// Normalize raw extractor output into clean, upcoming-only, deduped events.

import { parseEventDate, isUpcoming } from './dates.js';

/**
 * @param {import('./types.js').RawEvent[]} rawEvents
 * @param {{ now?: Date, includePast?: boolean }} [opts]
 * @returns {import('./types.js').Event[]}
 */
export function normalizeEvents(rawEvents, opts = {}) {
  const now = opts.now || new Date();
  const out = [];

  for (const raw of rawEvents) {
    const title = clean(raw.title);
    if (!title) continue;

    const start = toIso(raw.start, now);
    if (!start) continue; // an event with no usable date isn't useful

    if (!opts.includePast && !isUpcoming(start, now)) continue;

    out.push({
      title,
      description: clean(raw.description) || null,
      start,
      end: toIso(raw.end, now),
      location: clean(raw.location) || null,
      url: clean(raw.url) || clean(raw.sourceUrl) || '',
      source: clean(raw.sourceName) || hostOf(raw.sourceUrl) || 'unknown',
      extractor: raw.extractor,
    });
  }

  return dedupe(out).sort((a, b) => a.start.localeCompare(b.start));
}

// Accept already-ISO values, otherwise parse freeform.
function toIso(value, now) {
  if (!value) return null;
  // Already looks ISO?
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(value)) {
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    if (m) {
      const [, y, mo, d, h, mi] = m;
      return `${y}-${mo}-${d}T${h || '00'}:${mi || '00'}:00`;
    }
  }
  return parseEventDate(value, { now });
}

// Deduplicate in two passes:
//   1. Exact: identical normalized title on the same calendar day (fast path,
//      also collapses same-source repeats).
//   2. Fuzzy: same/overlapping day with start times close together AND highly
//      similar titles — catches the SAME event listed by DIFFERENT sources
//      (e.g. a venue site + Eventbrite), where titles and times vary slightly.
// When two records collide we keep the richer one (see score()).
const FUZZY_TIME_WINDOW_MIN = 180; // starts within 3h are candidates
const TITLE_SIMILARITY = 0.6; // Jaccard token overlap threshold

function dedupe(events) {
  // Pass 1: exact key.
  const byExact = new Map();
  for (const ev of events) {
    const key = `${ev.start.slice(0, 10)}|${normalizeTitle(ev.title)}`;
    const existing = byExact.get(key);
    if (!existing || score(ev) > score(existing)) byExact.set(key, ev);
  }
  let kept = [...byExact.values()];

  // Pass 2: fuzzy merge across remaining records.
  kept.sort((a, b) => a.start.localeCompare(b.start));
  const merged = [];
  for (const ev of kept) {
    const dupIndex = merged.findIndex((m) => isSameEvent(m, ev));
    if (dupIndex === -1) {
      merged.push(ev);
    } else if (score(ev) > score(merged[dupIndex])) {
      // Keep the richer of the two duplicates.
      merged[dupIndex] = ev;
    }
  }
  return merged;
}

// Two normalized events are "the same" when their starts are within the time
// window and their titles are similar enough.
function isSameEvent(a, b) {
  const da = new Date(a.start).getTime();
  const db = new Date(b.start).getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) return false;
  const minutesApart = Math.abs(da - db) / 60000;
  if (minutesApart > FUZZY_TIME_WINDOW_MIN) return false;
  return titleSimilarity(a.title, b.title) >= TITLE_SIMILARITY;
}

// Jaccard similarity over significant title tokens. Also treats one title being
// contained in the other as a strong match (handles "Author Talk" vs
// "Author Talk at Tattered Cover Aspen Grove").
function titleSimilarity(t1, t2) {
  const a = tokenSet(t1);
  const b = tokenSet(t2);
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const tok of a) if (b.has(tok)) inter++;
  const union = a.size + b.size - inter;
  const jaccard = inter / union;
  const containment = inter / Math.min(a.size, b.size);
  return Math.max(jaccard, containment >= 0.9 ? containment : 0);
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'with', 'at', 'of', 'for', 'to', 'in', 'on', 'live',
  'event', 'presents', 'presented', 'by',
]);

function tokenSet(title) {
  const set = new Set();
  for (const tok of normalizeTitle(title).split(' ')) {
    if (tok.length >= 3 && !STOPWORDS.has(tok)) set.add(tok);
  }
  return set;
}

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function score(ev) {
  let s = 0;
  // Prefer structured providers over loose heuristics.
  if (ev.extractor === 'jsonld' || ev.extractor === 'rss' || ev.extractor === 'tribe') s += 10;
  if (ev.extractor === 'bookmanager' || ev.extractor === 'eventbrite') s += 8;
  if (ev.description) s += 2;
  if (ev.location) s += 2;
  if (ev.end) s += 1;
  if (ev.url && !/\/events\/?$/.test(ev.url)) s += 1; // specific event URL
  return s;
}

function clean(v) {
  if (v == null) return undefined;
  const t = String(v).replace(/\s+/g, ' ').trim();
  return t || undefined;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}
