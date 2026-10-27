#!/usr/bin/env node
// Minimal loopback-only static server for the local events viewer.
// Serves the project root so /web/index.html can fetch /output/*.json.
// Binds to 127.0.0.1 only (not exposed on the network).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, normalize, extname, join, sep } from 'node:path';
import {
  parseEventQuery,
  queryEvents,
  summarizeTags,
  QueryError,
} from './lib/tag-query.js';
import { tagKinds } from './lib/tags.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Headers sent with every response. The viewer uses inline <script>/<style>
// blocks, so 'unsafe-inline' is allowed for those; everything else is locked to
// the same origin, and the page cannot be framed.
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

// ---- JSON API -------------------------------------------------------------
// GET /api/events?set=filtered|all&tags=a,b&mode=any|all&not=c&q=text&limit=N
// GET /api/tags?set=filtered|all
// Tags exist only on filtered events (set=filtered); set=all returns untagged events.

async function readJsonFile(relPath) {
  return JSON.parse(await readFile(join(ROOT, relPath), 'utf8'));
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(JSON.stringify(body));
}

async function loadEventSet(set) {
  const rel = set === 'all' ? 'output/events.json' : 'output/events-filtered.json';
  const payload = await readJsonFile(rel);
  return Array.isArray(payload) ? payload : payload.events || [];
}

async function loadTagKinds() {
  try {
    return tagKinds(await readJsonFile('config/tags.json'));
  } catch {
    return [];
  }
}

async function handleApi(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', ...SECURITY_HEADERS }).end('Method Not Allowed');
    return;
  }

  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const route = url.pathname;
  try {
    const query = parseEventQuery(url.searchParams);

    if (route === '/api/events') {
      const all = await loadEventSet(query.set);
      const events = queryEvents(all, query);
      const out = query.limit ? events.slice(0, query.limit) : events;
      sendJson(res, 200, {
        set: query.set,
        total: all.length,
        count: events.length,
        tags: query.tags,
        mode: query.mode,
        not: query.not,
        q: query.q,
        events: out,
      });
      return;
    }

    if (route === '/api/tags') {
      const all = await loadEventSet(query.set);
      sendJson(res, 200, {
        set: query.set,
        total: all.length,
        tags: summarizeTags(all, await loadTagKinds()),
      });
      return;
    }

    sendJson(res, 404, { error: `unknown API route: ${route}` });
  } catch (err) {
    if (err instanceof QueryError) {
      sendJson(res, err.status, { error: err.message });
    } else if (err.code === 'ENOENT') {
      sendJson(res, 404, { error: 'events not generated yet; run "npm run pipeline" first' });
    } else {
      sendJson(res, 500, { error: 'server error' });
    }
  }
}

const server = createServer(async (req, res) => {
  if ((req.url || '').split('?')[0].startsWith('/api/')) {
    await handleApi(req, res);
    return;
  }
  try {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/') urlPath = '/web/index.html';

    // Resolve safely, then restrict to the directories we intend to expose
    // (the viewer and the generated output) — never the whole project.
    const filePath = normalize(join(ROOT, urlPath));
    const ALLOWED = [resolve(ROOT, 'web'), resolve(ROOT, 'output')];
    if (!ALLOWED.some((base) => filePath === base || filePath.startsWith(base + sep))) {
      res.writeHead(403, SECURITY_HEADERS).end('Forbidden');
      return;
    }

    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
    });
    res.end(body);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      res.writeHead(404, SECURITY_HEADERS).end('Not found');
    } else {
      res.writeHead(500, SECURITY_HEADERS).end('Server error');
    }
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`Events viewer running at http://${HOST}:${PORT}/\n`);
  process.stdout.write(`(serving ${ROOT}; press Ctrl+C to stop)\n`);
});
