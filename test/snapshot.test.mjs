// Unit tests for src/lib/snapshot.js: file naming, read/write round-trip,
// missing and corrupt files, and snapshot age. Uses a temp directory.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  slugify,
  snapshotPath,
  readSnapshot,
  writeSnapshot,
  snapshotAgeDays,
  SNAPSHOT_DIR,
} from '../src/lib/snapshot.js';

describe('slugify', () => {
  test('lowercases and replaces punctuation and spaces with dashes', () => {
    assert.equal(slugify('Denver Public Library Friends'), 'denver-public-library-friends');
    assert.equal(slugify('Good Girl Cafe & Bookstore'), 'good-girl-cafe-bookstore');
    assert.equal(slugify('Broomfield Library (Compass)'), 'broomfield-library-compass');
  });

  test('strips accents and trims dashes', () => {
    assert.equal(slugify('  Café Libre!  '), 'cafe-libre');
  });

  test('falls back to "source" when nothing usable remains', () => {
    assert.equal(slugify('!!!'), 'source');
  });

  test('snapshotPath puts the file under snapshots/ with the slug as its name', () => {
    const p = snapshotPath('/root', 'Novel Strand');
    assert.ok(p.endsWith(`${SNAPSHOT_DIR}${p.includes('\\') ? '\\' : '/'}novel-strand.json`));
  });
});

describe('read and write', () => {
  let dir;
  test.beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'snap-')); });
  test.afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('round-trips events with capture metadata', async () => {
    const events = [{ title: 'Book Club', start: '2026-11-03T13:00:00', source: 'X' }];
    await writeSnapshot(dir, 'Test Source', { url: 'https://example.org', events, capturedAt: '2026-10-25T18:00:00.000Z' });
    const snap = await readSnapshot(dir, 'Test Source');
    assert.equal(snap.source, 'Test Source');
    assert.equal(snap.sourceUrl, 'https://example.org');
    assert.equal(snap.capturedAt, '2026-10-25T18:00:00.000Z');
    assert.equal(snap.count, 1);
    assert.deepEqual(snap.events, events);
  });

  test('a second write replaces the first', async () => {
    await writeSnapshot(dir, 'Test Source', { events: [{ title: 'a' }, { title: 'b' }], capturedAt: 'x' });
    await writeSnapshot(dir, 'Test Source', { events: [{ title: 'c' }], capturedAt: 'y' });
    const snap = await readSnapshot(dir, 'Test Source');
    assert.deepEqual(snap.events.map((e) => e.title), ['c']);
  });

  test('a missing snapshot reads as null', async () => {
    assert.equal(await readSnapshot(dir, 'Never Captured'), null);
  });

  test('a corrupt snapshot reads as null rather than throwing', async () => {
    await mkdir(join(dir, SNAPSHOT_DIR), { recursive: true });
    await writeFile(join(dir, SNAPSHOT_DIR, 'broken.json'), '{not json');
    assert.equal(await readSnapshot(dir, 'Broken'), null);
  });

  test('a snapshot without an events array reads as null', async () => {
    await mkdir(join(dir, SNAPSHOT_DIR), { recursive: true });
    await writeFile(join(dir, SNAPSHOT_DIR, 'odd.json'), JSON.stringify({ source: 'Odd' }));
    assert.equal(await readSnapshot(dir, 'Odd'), null);
  });
});

describe('snapshotAgeDays', () => {
  test('counts days between capture and now', () => {
    const now = new Date('2026-10-25T00:00:00Z');
    assert.equal(snapshotAgeDays('2026-10-18T00:00:00Z', now), 7);
  });

  test('an unreadable capture date is treated as infinitely old', () => {
    assert.equal(snapshotAgeDays('not a date'), Infinity);
  });
});
