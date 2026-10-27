// Tagging for filtered events. Runs after keyword filtering, so it only sees
// events that already passed. Each event gets:
//   - source tags from its source (config.sources, e.g. "library", "bookstore",
//     "eventbrite")
//   - host tags for listing platforms (config.hosts): when the source is tagged
//     with config.hosts.appliesToSourceKind, the first host rule whose phrase
//     appears in config.hosts.field adds its tags (e.g. "bookstore" for a
//     Tattered Cover event listed on Eventbrite)
//   - content tags from config.tags, matched with the same engine as filters
//     (wildcards, wholeWord) against the configured fields.

import { compileFilter, matchEvent } from './filter.js';

/**
 * @param {object} config  parsed config/tags.json
 */
export function compileTags(config) {
  const base = {
    fields: config.fields,
    caseSensitive: Boolean(config.caseSensitive),
    wholeWord: config.wholeWord !== false,
  };
  const rules = (config.tags || []).map((t) => ({
    name: t.name,
    compiled: compileFilter({ ...base, keywords: t.match }),
  }));

  // Host rules use plain substring matching on one field (venue names are
  // often multi-word and not whole words).
  const hosts = config.hosts || {};
  const hostRules = (hosts.rules || []).map((r) => ({
    tags: r.tags,
    compiled: compileFilter({
      fields: [hosts.field || 'location'],
      caseSensitive: false,
      wholeWord: false,
      keywords: r.match,
    }),
  }));

  return {
    sources: config.sources || {},
    rules,
    hostKind: hosts.appliesToSourceKind || null,
    hostRules,
  };
}

/**
 * Tags for one event, sorted and de-duplicated.
 * @param {object} event
 * @param {ReturnType<typeof compileTags>} compiled
 * @returns {string[]}
 */
export function tagsFor(event, compiled) {
  const sourceTags = compiled.sources[event.source] || [];
  const tags = new Set(sourceTags);

  if (compiled.hostKind && sourceTags.includes(compiled.hostKind)) {
    const host = compiled.hostRules.find((r) => matchEvent(event, r.compiled).matched.length);
    if (host) host.tags.forEach((t) => tags.add(t));
  }

  for (const rule of compiled.rules) {
    if (matchEvent(event, rule.compiled).matched.length) tags.add(rule.name);
  }
  return [...tags].sort();
}

/**
 * Return copies of the events with a `tags` array added.
 * @param {object[]} events
 * @param {object} config  parsed config/tags.json
 */
export function tagEvents(events, config) {
  const compiled = compileTags(config);
  return events.map((e) => ({ ...e, tags: tagsFor(e, compiled) }));
}

/**
 * Count how many events carry each tag, most common first.
 * @param {{tags?: string[]}[]} events
 * @returns {Record<string, number>}
 */
export function tagCounts(events) {
  const counts = {};
  for (const e of events) {
    for (const t of e.tags || []) counts[t] = (counts[t] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

/**
 * Every kind tag the config can produce: source kinds plus host kinds.
 * @param {object} config
 * @returns {string[]}
 */
export function tagKinds(config) {
  const fromSources = Object.values(config.sources || {}).flat();
  const fromHosts = ((config.hosts && config.hosts.rules) || []).flatMap((r) => r.tags);
  return [...new Set([...fromSources, ...fromHosts])].sort();
}

/**
 * Sources that appear in the events but have no entry in config.sources.
 * @param {{source?: string}[]} events
 * @param {object} config
 * @returns {string[]}
 */
export function unmappedSources(events, config) {
  const known = new Set(Object.keys(config.sources || {}));
  return [...new Set(events.map((e) => e.source).filter((s) => s && !known.has(s)))].sort();
}
