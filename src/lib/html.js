// Minimal, dependency-free HTML helpers. Not a full parser — just enough to
// pull out <script> blocks, strip tags to visible text, and decode entities.

/**
 * Extract the raw contents of all <script type="application/ld+json"> blocks.
 * @param {string} html
 * @returns {string[]} array of raw JSON strings (not yet parsed)
 */
export function extractJsonLdBlocks(html) {
  const blocks = [];
  const re =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (raw) blocks.push(raw);
  }
  return blocks;
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  rsquo: '\u2019',
  lsquo: '\u2018',
  rdquo: '\u201d',
  ldquo: '\u201c',
  middot: '\u00b7',
};

/**
 * Decode a subset of HTML entities (named + numeric).
 * @param {string} text
 */
export function decodeEntities(text) {
  if (!text) return text;
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key)
        ? NAMED_ENTITIES[key]
        : whole;
    });
}

function safeFromCodePoint(cp) {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

/**
 * Strip scripts/styles and tags, returning collapsed visible text.
 * @param {string} html
 */
export function htmlToText(html) {
  if (!html) return '';
  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const text = withoutScripts.replace(/<[^>]+>/g, ' ');
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

// Class/role tokens that commonly wrap a single event "card" on event pages.
const CARD_HINT =
  /\b(?:event|card|calendar|listing|agenda|program|session|occurrence|post)\b/i;

/**
 * Split HTML into coarse "blocks" of visible text, grouped by likely event
 * containers. Strategy:
 *   1. Prefer segmenting on repeated "card"-like containers (class/id hints),
 *      so a whole event (date + title + description) stays in one block.
 *   2. Fall back to block-level tag boundaries when no cards are found.
 * @param {string} html
 * @returns {string[]}
 */
export function htmlToBlocks(html) {
  return extractCards(html)
    .map((c) => c.text)
    .filter(Boolean);
}

const CLEAN_RE = [
  /<script\b[^>]*>[\s\S]*?<\/script>/gi,
  /<style\b[^>]*>[\s\S]*?<\/style>/gi,
  /<!--[\s\S]*?-->/g,
];

function stripNoise(html) {
  let out = html;
  for (const re of CLEAN_RE) out = out.replace(re, ' ');
  return out;
}

/**
 * Segment a page into event "cards". Rather than matching close tags (fragile
 * with real-world HTML), we find every opening tag whose class/id looks like a
 * single event card, then take the slice of markup from that card's start up to
 * the next card's start. The slice's first href (if any) is the card's link.
 *
 * Falls back to block-level splitting when fewer than two cards are detected.
 * @param {string} html
 * @returns {{ text: string, href: string | null }[]}
 */
export function extractCards(html) {
  if (!html) return [];
  const clean = stripNoise(html);

  // Find the dominant repeated "card" CSS class, then segment on it. Using a
  // single class (not any card-ish token) avoids splitting on nested children
  // like `event-card-body`/`event-card-date`, which would fragment each card.
  const cardClass = findDominantCardClass(clean);
  if (cardClass) {
    const starts = [];
    // Match the class as a whole, space-delimited token (not a \b-substring,
    // which would also match children like `event-card-body`).
    const re = new RegExp(
      `<([a-z]+)\\b[^>]*\\b(?:class|id)\\s*=\\s*["']([^"']*)["'][^>]*>`,
      'gi',
    );
    let mm;
    while ((mm = re.exec(clean)) !== null) {
      const tokens = mm[2].split(/\s+/);
      if (tokens.includes(cardClass)) starts.push(mm.index);
    }

    if (starts.length >= 2) {
      const cards = [];
      for (let i = 0; i < starts.length; i++) {
        const slice = clean.slice(starts[i], starts[i + 1] ?? clean.length);
        const text = sliceToText(slice);
        if (text) cards.push({ text, href: firstHref(slice) });
      }
      return cards;
    }
  }

  // Fallback: block-level text splitting (no reliable href per block).
  const marked = clean.replace(
    /<\/(?:p|div|li|section|article|tr|h[1-6]|header|footer)>/gi,
    '\u0001',
  );
  return marked
    .replace(/<[^>]+>/g, ' ')
    .split('\u0001')
    .map((b) => decodeEntities(b).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((text) => ({ text, href: null }));
}

// Identify the CSS class that most likely marks one event card. We tally every
// class token that looks event/card-ish, ignoring obvious multi-card wrappers,
// then choose the one that repeats the most (ties broken toward the shortest,
// most-generic name, which tends to be the outer card rather than a child like
// `event-card-body`).
function findDominantCardClass(html) {
  const WRAPPER = /^(?:.*-)?(?:grid|list|wrapper|container|row|collection|results)$/i;
  const CARDISH = /card|event|listing|occurrence|agenda|calendar|tribe-events|eventlist/i;
  const counts = new Map();
  const tag = /<[a-z]+\b[^>]*\b(?:class|id)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = tag.exec(html)) !== null) {
    for (const cls of m[1].split(/\s+/)) {
      if (!cls || !CARDISH.test(cls) || WRAPPER.test(cls)) continue;
      counts.set(cls, (counts.get(cls) || 0) + 1);
    }
  }
  let best = null;
  for (const [cls, n] of counts) {
    if (n < 2) continue; // a real card repeats
    if (
      !best ||
      n > best.n ||
      (n === best.n && cls.length < best.cls.length)
    ) {
      best = { cls, n };
    }
  }
  return best ? best.cls : null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sliceToText(slice) {
  return decodeEntities(slice.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function firstHref(slice) {
  const m = slice.match(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i);
  return m ? decodeEntities(m[1]) : null;
}
