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
  const consumed = new Set(); // block indices absorbed as a prior event's details

  for (let i = 0; i < cards.length; i++) {
    if (consumed.has(i)) continue;
    const card = cards[i];
    const block = card.text;
    if (block.length < 8 || block.length > 1200) continue;
    if (!DATE_SIGNAL.test(block)) continue;

    const iso = parseEventDate(block, { now: ctx.now });
    if (!iso) continue;

    // Look-ahead merge: when the date-bearing block has no time of its own,
    // the time/location/description often live in the following block(s)
    // (common on blog-style event pages: a "MM/DD: Title" heading followed by
    // a "Weekday, 7-9 p.m. <venue>" line and a description paragraph). Gather
    // trailing blocks that DON'T start their own event until the next dated
    // block, and use them to enrich this one.
    const follow = [];
    if (!TIME_SIGNAL.test(block)) {
      for (let j = i + 1; j < cards.length && follow.length < 3; j++) {
        const next = cards[j].text;
        if (!next || next.length > 1200) break;
        // Stop only if the next block begins a DIFFERENT event (its own date on
        // a different day). A block repeating this event's date (e.g. a detail
        // line "Sunday 10/25, 5:30-6:30 p.m.") is part of this event, not a new
        // one, so we keep absorbing it.
        if (DATE_SIGNAL.test(next)) {
          const nextIso = parseEventDate(next, { now: ctx.now });
          if (nextIso && nextIso.slice(0, 10) !== iso.slice(0, 10)) break;
        }
        follow.push(next);
        consumed.add(j); // don't also emit this block as its own event
      }
    }
    const combined = [block, ...follow].join(' \u0001 '); // marker between blocks

    const { title, description } = splitTitleDescription(block, follow);
    if (!title) continue;

    // A better start time: re-parse over the combined text so a time in a
    // following block is picked up (block alone was date-only -> midnight).
    const startWithTime = parseEventDate(stripSentinel(combined), { now: ctx.now }) || iso;

    const key = `${startWithTime.slice(0, 10)}|${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const url = card.href ? absolute(card.href, ctx.sourceUrl) : ctx.sourceUrl;
    events.push({
      title,
      description,
      start: startWithTime,
      end: undefined,
      location: guessLocation(stripSentinel(combined)),
      url,
      sourceName: ctx.sourceName,
      sourceUrl: ctx.sourceUrl,
      extractor: 'heuristic',
    });
  }
  return events;
}

function stripSentinel(s) {
  return s.replace(/\u0001/g, ' ').replace(/\s+/g, ' ').trim();
}

function absolute(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return base;
  }
}

// Pull a plausible title + description out of the heading block, removing the
// leading date/time preamble. When follow-on blocks were merged in, they become
// the description (cleaner than slicing the heading mid-sentence).
function splitTitleDescription(block, follow = []) {
  let rest = block;

  // Strip a leading date preamble in either form:
  //   "Wed, Oct 14 · 5:00 PM"   (weekday/month-name)
  //   "10/14:"  "10/14 -"       (numeric MM/DD, as used by blog-style pages)
  const monthName = rest.match(
    /^(?:[A-Za-z]{3,9},?\s+)?[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?\s*[·\-–—]?\s*(?:\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)?/i,
  );
  const numeric = rest.match(/^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s*[:·\-–—]?\s*/);
  if (numeric) {
    rest = rest.slice(numeric[0].length).trim();
  } else if (monthName && monthName[0].length >= 5) {
    rest = rest.slice(monthName[0].length).trim();
  }

  // Drop common call-to-action tails.
  rest = rest.replace(/\b(GET TICKETS|BUY TICKETS|RSVP|LEARN MORE|READ MORE)\b.*$/i, '').trim();
  rest = rest.replace(/[·|•]\s*$/, '').trim();

  if (!rest) return { title: undefined, description: undefined };

  // If we merged follow-on blocks, prefer the heading as the title and the
  // follow-on text as the description (don't chop the heading mid-sentence).
  if (follow.length) {
    const desc = follow.join(' ').replace(/\s+/g, ' ').trim();
    return { title: rest, description: desc || undefined };
  }

  // Otherwise (single self-contained block): title = first sentence-ish span.
  const boundary = rest.search(/(?<=[.!?])\s|\s[·|•]\s|\s{2,}/);
  if (boundary > 0 && boundary < 120) {
    return {
      title: rest.slice(0, boundary).trim(),
      description: rest.slice(boundary).trim() || undefined,
    };
  }
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
