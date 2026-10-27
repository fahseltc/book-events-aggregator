#!/usr/bin/env node
// Produce a filtered view of a generated events JSON file, keeping only events
// whose text matches keywords from a config file. Runs independently of the
// crawl, so you can re-filter instantly without re-crawling.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { filterEvents } from './lib/filter.js';
import { tagEvents, tagCounts, tagKinds, unmappedSources } from './lib/tags.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    in: 'output/events.json',
    out: 'output/events-filtered.json',
    config: 'config/filters.json',
    tags: 'config/tags.json',
    annotate: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in') args.in = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--tags') args.tags = argv[++i];
    else if (a === '--no-tags') args.tags = null;
    else if (a === '--no-annotate') args.annotate = false;
    else if (a === '--pretty') args.pretty = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const HELP = `book-events filter — keep only events matching configured keywords.

Usage: node src/filter.js [options]

Options:
  --in <path>       Input events JSON (default: output/events.json)
  --out <path>      Filtered output path (default: output/events-filtered.json)
  --config <path>   Filter config (default: config/filters.json)
  --tags <path>     Tag config applied to kept events (default: config/tags.json)
  --no-tags         Skip tagging
  --no-annotate     Don't add a matchedKeywords field to each kept event
  --pretty          Pretty-print the output JSON
  -h, --help        Show this help
`;

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const inPath = resolve(ROOT, args.in);
  const configPath = resolve(ROOT, args.config);

  const [payloadRaw, config] = await Promise.all([
    readFile(inPath, 'utf8').then(JSON.parse),
    readFile(configPath, 'utf8').then(JSON.parse),
  ]);

  const events = Array.isArray(payloadRaw) ? payloadRaw : payloadRaw.events || [];
  const filtered = filterEvents(events, config, { annotate: args.annotate });

  // Tagging runs last, on the already-filtered events only.
  let kept = filtered;
  let tagInfo = null;
  if (args.tags) {
    const tagConfig = JSON.parse(await readFile(resolve(ROOT, args.tags), 'utf8'));
    kept = tagEvents(filtered, tagConfig);
    tagInfo = {
      tagCounts: tagCounts(kept),
      tagKinds: tagKinds(tagConfig),
      unmappedSources: unmappedSources(kept, tagConfig),
    };
  }

  const outPath = resolve(ROOT, args.out);
  await mkdir(dirname(outPath), { recursive: true });

  // Preserve the wrapper shape when the input had one.
  const payload = Array.isArray(payloadRaw)
    ? kept
    : {
      ...payloadRaw,
      count: kept.length,
      filteredFrom: events.length,
      filterKeywords: config.keywords,
      filterExclude: config.exclude || [],
      filterWholeWord: config.wholeWord !== false,
      ...(tagInfo ? { tagCounts: tagInfo.tagCounts, tagKinds: tagInfo.tagKinds } : {}),
      events: kept,
    };
  if (tagInfo && tagInfo.unmappedSources.length) {
    process.stdout.write(
      `Sources without a kind in config/tags.json: ${tagInfo.unmappedSources.join('; ')}\n`,
    );
  }
  await writeFile(outPath, JSON.stringify(payload, null, args.pretty ? 2 : 0) + '\n');

  const exclude = config.exclude || [];
  const excludeMsg = exclude.length ? ` excluding [${exclude.join(', ')}]` : '';
  process.stdout.write(
    `Kept ${kept.length} of ${events.length} event(s) matching ` +
    `[${(config.keywords || []).join(', ')}]${excludeMsg} -> ${args.out}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
