// Keyword filtering over the generated events list. An event is kept when it
// matches ANY `keywords` entry (whitelist, OR semantics) AND matches NONE of
// the `exclude` entries (blacklist, which overrides the whitelist).

const DEFAULT_FIELDS = ['title', 'description'];

/**
 * @typedef {Object} FilterConfig
 * @property {string[]} keywords          include if any of these match
 * @property {string[]} [exclude]         reject if any of these match (wins over keywords)
 * @property {string[]} [fields]
 * @property {boolean} [caseSensitive]
 * @property {boolean} [wholeWord]
 */

/**
 * Build matcher functions once from the config.
 * @param {FilterConfig} config
 */
export function compileFilter(config) {
  const keywords = cleanList(config.keywords);
  if (keywords.length === 0) {
    throw new Error('Filter config has no keywords.');
  }
  const exclude = cleanList(config.exclude);
  const fields = Array.isArray(config.fields) && config.fields.length
    ? config.fields
    : DEFAULT_FIELDS;

  const build = (list) => list.map((kw) => ({ keyword: kw, re: toRegex(kw, config) }));
  return { fields, matchers: build(keywords), excluders: build(exclude) };
}

function toRegex(kw, config) {
  const flags = config.caseSensitive ? 'g' : 'gi';
  const escaped = escapeRe(kw);
  const pattern = config.wholeWord ? `(?<![\\w])${escaped}(?![\\w])` : escaped;
  return new RegExp(pattern, flags);
}

/**
 * Classify an event against the compiled filter.
 * @param {object} event
 * @param {{ fields: string[], matchers: {keyword:string, re:RegExp}[], excluders: {keyword:string, re:RegExp}[] }} compiled
 * @returns {{ keep: boolean, matched: string[], excludedBy: string[] }}
 */
export function matchEvent(event, compiled) {
  const haystack = compiled.fields
    .map((f) => (event && event[f] != null ? String(event[f]) : ''))
    .join('\n');

  const matched = hits(compiled.matchers, haystack);
  const excludedBy = hits(compiled.excluders, haystack);
  // Keep only if it matched a keyword AND nothing in the blacklist matched.
  return { keep: matched.length > 0 && excludedBy.length === 0, matched, excludedBy };
}

function hits(list, haystack) {
  const out = [];
  for (const m of list) {
    m.re.lastIndex = 0;
    if (m.re.test(haystack)) out.push(m.keyword);
  }
  return out;
}

/**
 * Filter an events array, optionally annotating each kept event with the
 * keywords it matched.
 * @param {object[]} events
 * @param {FilterConfig} config
 * @param {{ annotate?: boolean }} [opts]
 * @returns {object[]}
 */
export function filterEvents(events, config, opts = {}) {
  const compiled = compileFilter(config);
  const out = [];
  for (const ev of events) {
    const { keep, matched } = matchEvent(ev, compiled);
    if (keep) out.push(opts.annotate ? { ...ev, matchedKeywords: matched } : ev);
  }
  return out;
}

function cleanList(list) {
  return (Array.isArray(list) ? list : [])
    .filter((k) => typeof k === 'string' && k.trim())
    .map((k) => k.trim());
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
