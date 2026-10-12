// BiblioCommons events provider (e.g. Arapahoe Libraries).
// BiblioCommons libraries expose a clean JSON API that is far better than their
// RSS feed (whose items carry no dates):
//   https://gateway.bibliocommons.com/v2/libraries/<slug>/events?page=N
// Response: { events: { items:[id...], pagination:{pages} },
//             entities: { events:{ id: { definition:{start,end,title,...} } },
//                         locations:{ id:{name} } } }
// Plain HTTP JSON (no browser). Paginated.

import { htmlToText, decodeEntities } from '../html.js';

/**
 * @param {object} source  uses source.url to derive the library slug
 * @param {{ now?: Date, timeoutMs?: number, maxPages?: number }} ctx
 * @returns {Promise<import('../types.js').RawEvent[]>}
 */
export async function extractFromBiblioCommons(source, ctx = {}) {
  const slug = librarySlug(source);
  if (!slug) throw new Error(`Could not determine BiblioCommons library slug from ${source.url}`);

  const base = `https://gateway.bibliocommons.com/v2/libraries/${slug}/events`;
  const publicBase = `https://${slug}.bibliocommons.com/events`;
  const maxPages = Math.max(1, (source.search && source.search.pages) || ctx.maxPages || 10);
  const timeoutMs = ctx.timeoutMs ?? 20000;

  const events = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await getJson(`${base}?page=${page}`, timeoutMs);
    const defs = data?.entities?.events || {};
    const locations = data?.entities?.locations || {};
    const items = data?.events?.items || [];
    for (const id of items) {
      const node = defs[id];
      if (!node || !node.definition) continue;
      events.push(toRawEvent(id, node.definition, locations, publicBase, source));
    }
    const pages = data?.events?.pagination?.pages || 1;
    if (page >= pages || items.length === 0) break;
  }
  return events;
}

async function getJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`BiblioCommons API ${res.status} for ${url}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function toRawEvent(id, def, locations, publicBase, source) {
  if (def.isCancelled) return { title: undefined, start: undefined, extractor: 'bibliocommons' };
  const locId = def.branchLocationId || def.nonBranchLocationId;
  const location = locId && locations[locId] ? clean(locations[locId].name) : undefined;
  return {
    title: clean(def.title),
    description: clean(htmlToText(def.description || '')),
    start: toIso(def.start),
    end: toIso(def.end),
    location,
    url: `${publicBase}/${id}`,
    sourceName: source.name,
    sourceUrl: source.url,
    extractor: 'bibliocommons',
  };
}

// Derive the library slug: prefer <slug>.bibliocommons.com, else the
// /libraries/<slug>/ path from a gateway URL.
function librarySlug(source) {
  const u = source.url || '';
  let m = u.match(/https?:\/\/([a-z0-9-]+)\.bibliocommons\.com/i);
  if (m) return m[1];
  m = u.match(/\/libraries\/([a-z0-9-]+)\//i);
  if (m) return m[1];
  if (source.search && source.search.slug) return source.search.slug;
  return null;
}

// BiblioCommons starts are local wall-clock "2026-10-24T09:30" (no seconds/tz).
function toIso(s) {
  if (!s) return undefined;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi] = m;
  return `${y}-${mo}-${d}T${h || '00'}:${mi || '00'}:00`;
}

function clean(v) {
  if (v == null) return undefined;
  const t = decodeEntities(String(v)).replace(/\s+/g, ' ').trim();
  return t || undefined;
}
