#!/usr/bin/env node
// book-events-aggregator — two-stage crawler.
//   Stage 1 (index): fetch each configured URL, discover per-event detail links,
//                     and extract any events already inlined on the index.
//   Stage 2 (detail): visit each discovered event page and extract rich data
//                     (JSON-LD preferred). Detail data is merged over the index
//                     summary. Finally normalize -> upcoming-only -> JSON.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { loadSource, fetchHtml } from './lib/fetch.js';
import { discoverEventLinks } from './lib/links.js';
import { extractEvents } from './lib/extract/index.js';
import { extractFromBookManager } from './lib/extract/bookmanager.js';
import { extractFromTribe } from './lib/extract/tribe.js';
import { extractFromEventbrite } from './lib/extract/eventbrite.js';
import { extractStaticEvents } from './lib/extract/static.js';
import { normalizeEvents } from './lib/normalize.js';
import { loadEnv } from './lib/env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    config: 'config/sources.json',
    out: 'output/events.json',
    concurrency: 4,
    delayMs: 250,
    maxDetails: 100,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.config = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--include-past') args.includePast = true;
    else if (a === '--no-details') args.noDetails = true;
    else if (a === '--save-raw') args.saveRaw = true;
    else if (a === '--pretty') args.pretty = true;
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]) || 4;
    else if (a === '--delay') args.delayMs = Number(argv[++i]) || 0;
    else if (a === '--max-details') args.maxDetails = Number(argv[++i]) || 100;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const HELP = `book-events-aggregator — crawl event index pages into a JSON list.

Usage: node src/index.js [options]

Options:
  --config <path>     Sources config (default: config/sources.json)
  --out <path>        Output JSON path (default: output/events.json)
  --no-details        Skip stage 2; use only what the index pages show
  --max-details <n>   Cap detail-page visits per source (default: 100)
  --concurrency <n>   Parallel detail fetches (default: 4)
  --delay <ms>        Delay between detail fetches per worker (default: 250)
  --include-past      Keep past events (default: upcoming only)
  --save-raw          Save fetched index HTML under .raw/ for debugging
  --pretty            Pretty-print output JSON
  -h, --help          Show this help
`;

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  loadEnv(); // make .env secrets available to providers

  const configPath = resolve(ROOT, args.config);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const defaults = config.defaults || {};
  const sources = (config.sources || []).filter((s) => s.enabled !== false);

  const now = new Date();
  const allRaw = [];
  const report = [];

  for (const src of sources) {
    const source = {
      name: src.name,
      url: src.url,
      type: src.type ?? 'auto',
      render: src.render ?? defaults.render ?? false,
      timeoutMs: src.timeoutMs ?? defaults.timeoutMs ?? 20000,
      details: src.details,
      search: src.search,
      file: src.file,
    };
    const line = { source: source.name || source.url, url: source.url };
    try {
      const raw = await crawlSource(source, args, now, line);
      allRaw.push(...raw);
    } catch (err) {
      line.error = err.message;
    }
    report.push(line);
    logSourceLine(line);
  }

  const events = normalizeEvents(allRaw, { now, includePast: args.includePast });

  const outPath = resolve(ROOT, args.out);
  await mkdir(dirname(outPath), { recursive: true });
  const payload = {
    generatedAt: now.toISOString(),
    count: events.length,
    sources: report,
    events,
  };
  await writeFile(outPath, JSON.stringify(payload, null, args.pretty ? 2 : 0) + '\n');

  process.stdout.write(
    `\nWrote ${events.length} upcoming event(s) from ${sources.length} source(s) to ${args.out}\n`,
  );
}

/**
 * Crawl one source: index -> discover links -> visit details -> merge.
 * @returns {Promise<import('./lib/types.js').RawEvent[]>}
 */
async function crawlSource(source, args, now, line) {
  // Provider sources: platform-specific API extraction.
  if (source.type === 'bookmanager') {
    const events = await extractFromBookManager(source.url, {
      sourceName: source.name,
      now,
      timeoutMs: source.timeoutMs,
    });
    line.status = 200;
    line.indexEvents = events.length;
    line.indexVia = 'bookmanager';
    line.links = 0;
    return events;
  }
  if (source.type === 'tribe') {
    const events = await extractFromTribe(source.url, {
      sourceName: source.name,
      now,
      timeoutMs: source.timeoutMs,
    });
    line.status = 200;
    line.indexEvents = events.length;
    line.indexVia = 'tribe';
    line.links = 0;
    return events;
  }
  if (source.type === 'eventbrite') {
    const events = await extractFromEventbrite(source, { now, timeoutMs: source.timeoutMs });
    line.status = 200;
    line.indexEvents = events.length;
    line.indexVia = 'eventbrite';
    line.links = 0;
    return events;
  }
  if (source.type === 'static') {
    const path = resolve(ROOT, source.file || source.url || 'config/static-events.json');
    const events = await extractStaticEvents(path, { sourceName: source.name });
    line.status = 200;
    line.indexEvents = events.length;
    line.indexVia = 'static';
    line.links = 0;
    return events;
  }

  const { html, status } = await loadSource(source);
  line.status = status;
  if (args.saveRaw) await saveRaw(source, html);

  const ctx = { sourceName: source.name, sourceUrl: source.url, now, type: source.type };

  // Stage 1: events inlined on the index (if any) + detail-link discovery.
  const indexResult = extractEvents(html, ctx);
  const indexEvents = indexResult.events;
  line.indexEvents = indexEvents.length;
  line.indexVia = indexResult.via;

  // RSS/feed sources are already complete per-event records — no detail stage.
  if (indexResult.via === 'rss') {
    line.links = 0;
    return indexEvents;
  }

  // A source can opt out of the detail stage (details: false) when its index
  // page already lists complete events and its links point elsewhere.
  if (source.details === false) {
    line.links = 0;
    return indexEvents;
  }

  const links = discoverEventLinks(html, source.url);
  line.links = links.length;

  if (args.noDetails || links.length === 0) {
    // No second stage: index events are all we have.
    return indexEvents;
  }

  // Stage 2: fetch each detail page and extract rich event data.
  const capped = links.slice(0, args.maxDetails);
  const detailEvents = await mapWithConcurrency(
    capped,
    args.concurrency,
    async (link) => {
      try {
        const res = await fetchHtml(link.url, { timeoutMs: source.timeoutMs });
        const detCtx = { sourceName: source.name, sourceUrl: link.url, now };
        const { events } = extractEvents(res.html, detCtx);
        if (events.length === 0) {
          // Detail page gave nothing parseable; keep the index summary link.
          return [summaryToRaw(link, source)];
        }
        // Point each detail event at its own page.
        return events.map((e) => ({ ...e, url: e.url || link.url }));
      } catch {
        return [summaryToRaw(link, source)];
      }
    },
    args.delayMs,
  );

  line.detailEvents = detailEvents.flat().length;

  // Merge: prefer detail-page events; fall back to index events when a source
  // inlines everything and has no useful detail pages.
  const merged = detailEvents.flat();
  return merged.length ? merged : indexEvents;
}

// Turn an index-discovered link + its summary text into a minimal raw event,
// so we never silently drop an event whose detail page failed to parse.
function summaryToRaw(link, source) {
  return {
    title: link.summaryText || undefined,
    description: undefined,
    start: link.summaryText, // normalize() will try to parse a date out of it
    end: undefined,
    location: undefined,
    url: link.url,
    sourceName: source.name,
    sourceUrl: source.url,
    extractor: 'heuristic',
  };
}

async function mapWithConcurrency(items, concurrency, worker, delayMs) {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
      if (delayMs) await sleep(delayMs);
    }
  };
  const pool = Array.from({ length: Math.max(1, concurrency) }, run);
  await Promise.all(pool);
  return results;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function saveRaw(source, html) {
  const dir = resolve(ROOT, '.raw');
  await mkdir(dir, { recursive: true });
  const safe = (source.name || source.url).replace(/[^a-z0-9]+/gi, '_').slice(0, 60);
  await writeFile(join(dir, `${safe}.html`), html);
}

function logSourceLine(line) {
  if (line.error) {
    process.stdout.write(`  ✗ ${line.source}: ${line.error}\n`);
    return;
  }
  const detail =
    line.detailEvents != null ? ` details:${line.detailEvents}` : ' (no detail stage)';
  process.stdout.write(
    `  ✓ ${line.source}: index:${line.indexEvents}(${line.indexVia}) ` +
    `links:${line.links}${detail} (HTTP ${line.status})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
