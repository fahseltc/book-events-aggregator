// Heuristic extractor: for pages without JSON-LD. Scans visible text blocks,
// finds those that contain a recognizable date, and treats each as an event
// candidate. Intentionally conservative: better to miss than to invent events.

import { extractCards } from '../html.js';
import { parseEventDate } from '../dates.js';

// A date-ish signal in a block (weekday/month name or numeric date).
const DATE_SIGNAL =
  /\b(?:mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b\d{1,2}\/\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b/i;
const TIME_SIGNAL = /\b\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?\b|\b\d{1,2}:\d{2}\b/i;

/**
 * @param {string} html
 * @param {{ sourceName?: string, sourceUrl?: string, now?: Date }} ctx
 * @returns {import('../types.js').RawEvent[]}
 */
export function extractHeuristic(html, ctx = {}) {
  const cards = extractCards(html);
  const events = [];
  const seen = new Set();

  for (const card of cards) {
    const block = card.text;
    if (block.length < 8 || block.length > 1200) continue;
    if (!DATE_SIGNAL.test(block)) continue;

    const iso = parseEventDate(block, { now: ctx.now });
    if (!iso) continue;

    const { title, description } = splitTitleDescription(block);
    if (!title) continue;

    const key = `${iso}|${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const url = card.href ? absolute(card.href, ctx.sourceUrl) : ctx.sourceUrl;
    events.push({
      title,
      description,
      start: iso,
      end: undefined,
      location: guessLocation(block),
      url,
      sourceName: ctx.sourceName,
      sourceUrl: ctx.sourceUrl,
      extractor: 'heuristic',
    });
  }
  return events;
}

function absolute(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return base;
  }
}

// Pull a plausible title + description out of a flat text block by removing the
// leading date/time preamble and taking the first sentence-ish span as title.
function splitTitleDescription(block) {
  let rest = block;

  // Strip a leading "Wed, Oct 14 · 5:00 PM" style preamble.
  const preamble = rest.match(
    /^(?:[A-Za-z]{3,9},?\s+)?[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?\s*[·\-–—]?\s*(?:\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)?/i,
  );
  if (preamble && preamble[0].length >= 5) {
    rest = rest.slice(preamble[0].length).trim();
  }

  // Drop common call-to-action tails.
  rest = rest.replace(/\b(GET TICKETS|BUY TICKETS|RSVP|LEARN MORE|READ MORE)\b.*$/i, '').trim();
  rest = rest.replace(/[·|•]\s*$/, '').trim();

  if (!rest) return { title: undefined, description: undefined };

  // Title = up to first strong boundary; description = remainder.
  const boundary = rest.search(/(?<=[.!?])\s|\s[·|•]\s|\s{2,}/);
  if (boundary > 0 && boundary < 120) {
    return {
      title: rest.slice(0, boundary).trim(),
      description: rest.slice(boundary).trim() || undefined,
    };
  }
  // Fall back: first ~90 chars as title.
  if (rest.length > 90) {
    return { title: rest.slice(0, 90).trim() + '…', description: rest };
  }
  return { title: rest, description: undefined };
}

function guessLocation(block) {
  // Street-address-ish: "1700 N Humboldt St".
  const m = block.match(/\b\d{2,5}\s+[A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*){0,4}\s+(?:St|Street|Ave|Avenue|Blvd|Rd|Road|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place)\b\.?/,
  );
  return m ? m[0].trim() : undefined;
}
