// Unit tests for src/lib/tag-query.js: parameter validation, any/all tag
// matching, excluded tags, text search, limits, and tag summaries.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEventQuery,
  queryEvents,
  summarizeTags,
  QueryError,
} from '../src/lib/tag-query.js';

const events = [
  { title: 'Book Club: Dune', source: 'Aurora Public Library', description: 'Sci-fi discussion', tags: ['library', 'book-club', 'sci-fi-fantasy'] },
  { title: 'Release Party', source: 'Cherry On Top Bookshop', description: 'Midnight pickup', tags: ['bookstore', 'release'] },
  { title: 'Poetry Night', source: 'Wolverine Farm Publick House', description: 'Open readings', tags: ['venue', 'poetry', 'drinks'] },
  { title: 'Untagged event', source: 'Somewhere', description: '' },
];

const q = (s) => parseEventQuery(new URLSearchParams(s));

describe('parseEventQuery', () => {
  test('defaults: filtered set, any mode, no tags, no limit', () => {
    assert.deepEqual(q(''), { set: 'filtered', tags: [], mode: 'any', not: [], q: '', limit: null });
  });

  test('parses comma-separated tags, de-duplicated', () => {
    assert.deepEqual(q('tags=library,book-club,library').tags, ['library', 'book-club']);
  });

  test('rejects bad set, mode, or limit', () => {
    assert.throws(() => q('set=everything'), QueryError);
    assert.throws(() => q('mode=some'), QueryError);
    assert.throws(() => q('limit=0'), QueryError);
    assert.throws(() => q('limit=99999'), QueryError);
    assert.throws(() => q('limit=ten'), QueryError);
  });

  test('rejects tag names that are not lowercase slugs (guards the API input)', () => {
    assert.throws(() => q('tags=Book%20Club'), QueryError);
    assert.throws(() => q('tags=../etc'), QueryError);
    assert.throws(() => q('tags=%3Cscript%3E'), QueryError);
    assert.throws(() => q('not=a;b'), QueryError);
  });

  test('caps the number of tags', () => {
    const many = Array.from({ length: 21 }, (_, i) => `t${i}`).join(',');
    assert.throws(() => q(`tags=${many}`), QueryError);
  });

  test('a query error carries HTTP 400', () => {
    try { q('mode=x'); assert.fail('expected a throw'); } catch (err) { assert.equal(err.status, 400); }
  });
});

describe('queryEvents: tag matching', () => {
  test('any: keeps events with at least one selected tag', () => {
    const out = queryEvents(events, { tags: ['release', 'poetry'], mode: 'any' });
    assert.deepEqual(out.map((e) => e.title), ['Release Party', 'Poetry Night']);
  });

  test('all: keeps events that carry every selected tag', () => {
    const out = queryEvents(events, { tags: ['library', 'book-club'], mode: 'all' });
    assert.deepEqual(out.map((e) => e.title), ['Book Club: Dune']);
    assert.equal(queryEvents(events, { tags: ['library', 'poetry'], mode: 'all' }).length, 0);
  });

  test('not: drops events that carry any excluded tag', () => {
    const out = queryEvents(events, { not: ['drinks'] });
    assert.ok(!out.some((e) => e.title === 'Poetry Night'));
    assert.equal(out.length, 3);
  });

  test('no tags selected returns everything, including untagged events', () => {
    assert.equal(queryEvents(events, {}).length, 4);
  });

  test('untagged events never match a tag selection', () => {
    assert.equal(queryEvents(events, { tags: ['library'] }).some((e) => e.title === 'Untagged event'), false);
  });
});

describe('queryEvents: text and limit', () => {
  test('q matches title, description, or source, case-insensitively', () => {
    assert.deepEqual(queryEvents(events, { q: 'DUNE' }).map((e) => e.title), ['Book Club: Dune']);
    assert.deepEqual(queryEvents(events, { q: 'cherry' }).map((e) => e.title), ['Release Party']);
    assert.deepEqual(queryEvents(events, { q: 'midnight' }).map((e) => e.title), ['Release Party']);
  });

  test('q and tags combine', () => {
    const out = queryEvents(events, { tags: ['venue', 'bookstore'], mode: 'any', q: 'pickup' });
    assert.deepEqual(out.map((e) => e.title), ['Release Party']);
    assert.deepEqual(queryEvents(events, { tags: ['venue'], q: 'pickup' }), []);
  });

  test('limit stops after N matches', () => {
    assert.equal(queryEvents(events, { limit: 2 }).length, 2);
  });
});

describe('summarizeTags', () => {
  const tagged = [
    { tags: ['library', 'book-club'] },
    { tags: ['library', 'book-club', 'sci-fi-fantasy'] },
    { tags: ['bookstore'] },
  ];

  test('counts each tag once per event and labels kind vs topic', () => {
    const summary = summarizeTags(tagged, ['library', 'bookstore']);
    assert.deepEqual(summary, [
      { name: 'library', kind: 'kind', count: 2 },
      { name: 'bookstore', kind: 'kind', count: 1 },
      { name: 'book-club', kind: 'topic', count: 2 },
      { name: 'sci-fi-fantasy', kind: 'topic', count: 1 },
    ]);
  });

  test('kinds come first, then topics, each by count', () => {
    const summary = summarizeTags(tagged, []);
    assert.equal(summary.every((t) => t.kind === 'topic'), true);
    assert.equal(summary[0].name, 'book-club');
  });
});
