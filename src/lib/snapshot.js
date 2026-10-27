// Source snapshots: a committed copy of a source's raw events, used when that
// source can't be reached live (blocked from CI runners, down, rate-limited).
//
// Snapshots are captured on a machine that can reach the source, with
//   npm run snapshot -- --source "<source name>"   (repeat --source for more)
//   npm run snapshot -- --all                      (every enabled source)
// and committed under snapshots/. A normal crawl that fails for one of those
// sources then reads the snapshot instead, before normalizing and filtering.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export const SNAPSHOT_DIR = 'snapshots';
export const STALE_DAYS = 14;

/**
 * File-safe name for a source, e.g. "Denver Public Library Friends" ->
 * "denver-public-library-friends".
 * @param {string} name
 */
export function slugify(name) {
  const slug = String(name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'source';
}

/** Absolute path to a source's snapshot file under the project root. */
export function snapshotPath(root, name) {
  return join(root, SNAPSHOT_DIR, `${slugify(name)}.json`);
}

/**
 * @returns {Promise<{source: string, sourceUrl?: string, capturedAt: string, count: number, events: object[]} | null>}
 */
export async function readSnapshot(root, name) {
  try {
    const json = JSON.parse(await readFile(snapshotPath(root, name), 'utf8'));
    if (!json || !Array.isArray(json.events)) return null;
    return json;
  } catch {
    return null; // no snapshot yet, or unreadable: treat as absent
  }
}

/**
 * Write (replace) a source's snapshot.
 * @param {string} root
 * @param {string} name
 * @param {{ url?: string, events: object[], capturedAt: string }} data
 * @returns {Promise<string>} the path written
 */
export async function writeSnapshot(root, name, { url, events, capturedAt }) {
  const path = snapshotPath(root, name);
  await mkdir(dirname(path), { recursive: true });
  const payload = {
    source: name,
    sourceUrl: url,
    capturedAt,
    count: events.length,
    events,
  };
  await writeFile(path, JSON.stringify(payload, null, 2) + '\n');
  return path;
}

/**
 * Whole days since a snapshot was captured (Infinity if the date is unreadable).
 * @param {string} capturedAt  ISO timestamp
 * @param {Date} [now]
 */
export function snapshotAgeDays(capturedAt, now = new Date()) {
  const t = Date.parse(capturedAt);
  if (Number.isNaN(t)) return Infinity;
  return (now.getTime() - t) / 86_400_000;
}
