// Query helpers for the events API: tag selection, text search, and tag summaries.
// Pure functions over already-loaded event arrays, so they can be tested without
// starting a server.
//
// Tags exist only on events that passed the keyword filter (see src/filter.js),
// so tag queries are meant for the filtered set.

export const TAG_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_TAGS = 20;
const MAX_QUERY = 200;
const MAX_LIMIT = 5000;

export class QueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QueryError';
    this.status = 400;
  }
}

/**
 * Validate and normalize query-string parameters for /api/events and /api/tags.
 * @param {URLSearchParams} sp
 * @returns {{ set: 'filtered'|'all', tags: string[], mode: 'any'|'all', not: string[], q: string, limit: number|null }}
 */
export function parseEventQuery(sp) {
  const set = sp.get('set') || 'filtered';
  if (set !== 'filtered' && set !== 'all') throw new QueryError('set must be "filtered" or "all"');

  const mode = sp.get('mode') || 'any';
  if (mode !== 'any' && mode !== 'all') throw new QueryError('mode must be "any" or "all"');

  const tags = parseTagList(sp.get('tags'), 'tags');
  const not = parseTagList(sp.get('not'), 'not');

  const q = (sp.get('q') || '').trim().slice(0, MAX_QUERY);

  let limit = null;
  if (sp.has('limit')) {
    const n = Number(sp.get('limit'));
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      throw new QueryError(`limit must be an integer from 1 to ${MAX_LIMIT}`);
    }
    limit = n;
  }

  return { set, tags, mode, not, q, limit };
}

function parseTagList(raw, label) {
  if (!raw) return [];
  const names = raw.split(',').map((t) => t.trim()).filter(Boolean);
  if (names.length > MAX_TAGS) throw new QueryError(`${label} allows at most ${MAX_TAGS} tags`);
  for (const name of names) {
    if (!TAG_NAME.test(name)) throw new QueryError(`invalid tag name in ${label}: "${name}"`);
  }
  return [...new Set(names)];
}

/**
 * Select events by tags and text.
 * - tags: "any" keeps events with at least one of the tags; "all" needs every tag.
 * - not: drops events that carry any of these tags.
 * - q: case-insensitive substring over title, description, location, and source.
 * @param {object[]} events
 * @param {{ tags?: string[], mode?: 'any'|'all', not?: string[], q?: string, limit?: number|null }} opts
 * @returns {object[]}
 */
export function queryEvents(events, opts = {}) {
  const tags = opts.tags || [];
  const not = opts.not || [];
  const mode = opts.mode || 'any';
  const q = (opts.q || '').toLowerCase();

  const out = [];
  for (const e of events) {
    const eventTags = new Set(e.tags || []);
    if (tags.length) {
      const hit = mode === 'all'
        ? tags.every((t) => eventTags.has(t))
        : tags.some((t) => eventTags.has(t));
      if (!hit) continue;
    }
    if (not.length && not.some((t) => eventTags.has(t))) continue;
    if (q) {
      const hay = [e.title, e.description, e.location, e.source]
        .filter(Boolean)
        .join('\n')
        .toLowerCase();
      if (!hay.includes(q)) continue;
    }
    out.push(e);
    if (opts.limit && out.length >= opts.limit) break;
  }
  return out;
}

/**
 * Count tags across events and label each as a "kind" (source type, such as
 * library or bookstore) or a "topic" (content tag, such as book-club).
 * @param {{tags?: string[]}[]} events
 * @param {string[]} kinds  the source-kind names from config/tags.json
 * @returns {{ name: string, kind: 'kind'|'topic', count: number }[]}
 */
export function summarizeTags(events, kinds) {
  const kindSet = new Set(kinds || []);
  const counts = new Map();
  for (const e of events) {
    for (const t of new Set(e.tags || [])) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, kind: kindSet.has(name) ? 'kind' : 'topic', count }))
    .sort((a, b) => (a.kind === b.kind ? b.count - a.count || a.name.localeCompare(b.name)
      : a.kind === 'kind' ? -1 : 1));
}
