// Per-page event extraction: JSON-LD first (exact, preferred), heuristic
// fallback only when JSON-LD yields nothing. Used for both index pages (to
// pull any inline events) and detail pages (the richer per-event source).

import { extractFromJsonLd } from './jsonld.js';
import { extractHeuristic } from './heuristic.js';
import { extractFromRss, looksLikeFeed } from './rss.js';

/**
 * Extract events from a document, auto-detecting RSS/Atom vs HTML.
 * Preference order: RSS feed > JSON-LD > heuristic.
 * @param {string} text
 * @param {{ sourceName?: string, sourceUrl?: string, now?: Date }} ctx
 * @returns {{ events: import('../types.js').RawEvent[], via: string }}
 */
export function extractEvents(text, ctx = {}) {
  if (ctx.type === 'rss' || (ctx.type !== 'html' && looksLikeFeed(text))) {
    const rss = extractFromRss(text, ctx);
    return { events: rss, via: rss.length ? 'rss' : 'none' };
  }

  const jsonld = extractFromJsonLd(text, ctx);
  if (jsonld.length > 0) return { events: jsonld, via: 'jsonld' };

  const heuristic = extractHeuristic(text, ctx);
  return { events: heuristic, via: heuristic.length ? 'heuristic' : 'none' };
}
