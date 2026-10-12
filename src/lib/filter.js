// Keyword filtering over the generated events list. An event is kept when ANY
// configured keyword matches ANY of the scanned fields (OR semantics).

const DEFAULT_FIELDS = ['title', 'description'];

/**
 * @typedef {Object} FilterConfig
 * @property {string[]} keywords
 * @property {string[]} [fields]
 * @property {boolean} [caseSensitive]
 * @property {boolean} [wholeWord]
 */

/**
 * Build matcher functions once from the config.
 * @param {FilterConfig} config
 */
export function compileFilter(config) {
  const keywords = (config.keywords || []).filter((k) => typeof k === 'string' && k.trim());
  if (keywords.length === 0) {
    throw new Error('Filter config has no keywords.');
  }
  const fields = Array.isArray(config.fields) && config.fields.length
    ? config.fields
    : DEFAULT_FIELDS;
  const flags = config.caseSensitive ? 'g' : 'gi';
  const matchers = keywords.map((kw) => {
    const escaped = escapeRe(kw.trim());
    const pattern = config.wholeWord ? `(?<![\\w])${escaped}(?![\\w])` : escaped;
    return { keyword: kw.trim(), re: new RegExp(pattern, flags) };
  });
  return { fields, matchers };
}

/**
 * Does an event match the compiled filter? Returns the matched keywords.
 * @param {object} event
 * @param {{ fields: string[], matchers: {keyword:string, re:RegExp}[] }} compiled
 * @returns {string[]} matched keywords (empty if no match)
 */
export function matchEvent(event, compiled) {
  const haystack = compiled.fields
    .map((f) => (event && event[f] != null ? String(event[f]) : ''))
    .join('\n');
  const hits = [];
  for (const m of compiled.matchers) {
    m.re.lastIndex = 0;
    if (m.re.test(haystack)) hits.push(m.keyword);
  }
  return hits;
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
    const hits = matchEvent(ev, compiled);
    if (hits.length) out.push(opts.annotate ? { ...ev, matchedKeywords: hits } : ev);
  }
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
