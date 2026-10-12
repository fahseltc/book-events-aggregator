// Discover per-event detail links from an index page. Generic strategy:
//   1. Segment the page into event "cards" (html.extractCards). Each card's
//      first href is a strong signal: that's the event's detail page.
//   2. If card segmentation yields nothing useful, fall back to scanning all
//      anchors whose href or text looks event-like.
// Returns absolute URLs plus any summary text the index already shows, so the
// detail stage can merge/augment rather than start from scratch.

import { extractCards, decodeEntities } from './html.js';

const EVENTY_HREF =
  /\/(?:event|events|e|calendar|programs?|classes|workshops?|tickets)\b|eventbrite\.|\/e\//i;

/**
 * @param {string} html
 * @param {string} baseUrl  the index page URL (for resolving relative hrefs)
 * @returns {{ url: string, summaryText: string }[]}
 */
export function discoverEventLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();

  const push = (href, summaryText) => {
    const abs = toAbsolute(href, baseUrl);
    if (!abs) return;
    if (isNonEventLink(abs, baseUrl)) return;
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push({ url: abs, summaryText: (summaryText || '').trim() });
  };

  // 1) Card-based discovery (preferred: one link per event card).
  const cards = extractCards(html);
  const cardsWithHref = cards.filter((c) => c.href);
  if (cardsWithHref.length >= 2) {
    for (const c of cardsWithHref) push(c.href, c.text);
    if (out.length >= 2) return out;
  }

  // 2) Fallback: all anchors with event-like href or text.
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchor.exec(html)) !== null) {
    const hrefMatch = m[1].match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const href = decodeEntities(hrefMatch[1]);
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (EVENTY_HREF.test(href) || /\b(event|rsvp|tickets?|register)\b/i.test(text)) {
      push(href, text);
    }
  }
  return out;
}

function toAbsolute(href, baseUrl) {
  if (!href) return null;
  const h = href.trim();
  if (!h || h.startsWith('#') || /^(?:mailto|tel|javascript):/i.test(h)) return null;
  try {
    return new URL(h, baseUrl).href;
  } catch {
    return null;
  }
}

// Filter out nav/boilerplate links that clearly aren't a single event.
function isNonEventLink(abs, baseUrl) {
  let u;
  try {
    u = new URL(abs);
  } catch {
    return true;
  }
  const path = u.pathname.toLowerCase();
  if (path === '/' || path === '') return true;
  if (/\.(?:css|js|png|jpe?g|gif|svg|webp|ico|pdf|zip|rss|xml)$/i.test(path)) return true;
  if (/\/(?:about|contact|privacy|terms|login|account|cart|search|faq|blog|gift)\b/i.test(path)) {
    return true;
  }
  // The index page itself (and bare section roots) aren't individual events.
  try {
    if (new URL(baseUrl).href.replace(/\/$/, '') === abs.replace(/\/$/, '')) return true;
  } catch {
    /* ignore */
  }
  return false;
}
