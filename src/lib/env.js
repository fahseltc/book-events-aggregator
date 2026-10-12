// Minimal dependency-free .env loader. Reads KEY=VALUE lines from a .env file
// at the project root into process.env (without overwriting existing vars).
// Secrets live only in .env (gitignored) and are referenced by name.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

let loaded = false;

/** Load .env once into process.env (idempotent). */
export function loadEnv() {
  if (loaded) return;
  loaded = true;
  const path = resolve(ROOT, '.env');
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip matching surrounding quotes.
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

/**
 * Get an optional env var (loads .env first).
 * @param {string} name
 * @returns {string | undefined}
 */
export function getEnv(name) {
  loadEnv();
  const v = process.env[name];
  return v && v.length ? v : undefined;
}
