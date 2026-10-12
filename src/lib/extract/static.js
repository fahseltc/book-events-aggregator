// Static provider: hand-maintained events from a config file. For annual
// festivals/conventions that aren't on any index site and change rarely. No
// network — the config IS the data. Events still flow through normalize (so
// they get upcoming-filtered, deduped, and sorted with everything else).

import { readFile } from 'node:fs/promises';

/**
 * @param {string} configPath  absolute path to the static-events config JSON
 * @param {{ sourceName?: string }} [ctx]
 * @returns {Promise<import('../types.js').RawEvent[]>}
 */
export async function extractStaticEvents(configPath, ctx = {}) {
  let config;
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read static events config at ${configPath}: ${err.message}`);
  }
  const list = Array.isArray(config.events) ? config.events : [];
  return list
    .filter((e) => e && e.enabled !== false && e.title && e.start)
    .map((e) => ({
      title: str(e.title),
      description: str(e.description),
      start: str(e.start),
      end: str(e.end),
      location: str(e.location),
      url: str(e.url),
      sourceName: str(e.source) || ctx.sourceName || 'Static',
      sourceUrl: str(e.url),
      extractor: 'static',
    }));
}

function str(v) {
  if (v == null) return undefined;
  const t = String(v).trim();
  return t || undefined;
}
