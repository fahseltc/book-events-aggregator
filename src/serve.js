#!/usr/bin/env node
// Minimal loopback-only static server for the local events viewer.
// Serves the project root so /web/index.html can fetch /output/*.json.
// Binds to 127.0.0.1 only (not exposed on the network).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, normalize, extname, join, sep } from 'node:path';

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

const server = createServer(async (req, res) => {
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
