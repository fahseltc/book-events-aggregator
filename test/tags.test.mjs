// Unit tests for src/lib/tags.js: source kind tags, content tags via the filter
// matching engine, wildcards, whole-word boundaries, de-duplication, counts, and
// unmapped-source reporting. Uses a small inline config and mock events.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileTags, tagsFor, tagEvents, tagCounts, tagKinds, unmappedSources } from '../src/lib/tags.js';

const config = {
  fields: ['title', 'description'],
  caseSensitive: false,
  wholeWord: true,
  sources: {
    'Aurora Public Library': ['library'],
    'Novel Strand': ['bookstore'],
  },
  tags: [
    { name: 'book-club', match: ['book club', 'book group'] },
    { name: 'author', match: ['author*'] },
    { name: 'release', match: ['release party', 'book launch'] },
    { name: 'games', match: ['game*'] },
    { name: 'writing', match: ['writ*'] },
  ],
};
const compiled = compileTags(config);
const ev = (source, title, description = '') => ({ source, title, description });

describe('source tags', () => {
  test('a mapped source gets its kind tags', () => {
    assert.deepEqual(tagsFor(ev('Aurora Public Library', 'Story walk'), compiled), ['library']);
  });

  test('an unmapped source gets no source tag', () => {
    assert.deepEqual(tagsFor(ev('Some Unknown Venue', 'Story walk'), compiled), []);
  });
});

describe('content tags', () => {
  test('matches the title or the description', () => {
    assert.ok(tagsFor(ev('X', 'Book Club: Dune'), compiled).includes('book-club'));
    assert.ok(tagsFor(ev('X', 'Monthly meeting', 'Our book group reads fantasy'), compiled).includes('book-club'));
  });

  test('wildcard author* matches authors and authored', () => {
    assert.ok(tagsFor(ev('X', 'Panel of authors'), compiled).includes('author'));
    assert.ok(tagsFor(ev('X', 'Meet the author'), compiled).includes('author'));
  });

  test('wholeWord stops a wildcard from matching inside a longer word', () => {
    // game* checks only the left boundary: "Aerogame" has "o" before "game", so no match.
    assert.ok(!tagsFor(ev('X', 'Aerogame expo'), compiled).includes('games'));
    assert.ok(tagsFor(ev('X', 'Video game night'), compiled).includes('games'));
    // Documents the wildcard's left-only boundary: "Gamekeeper" starts a word with "game".
    assert.ok(tagsFor(ev('X', 'Gamekeeper talk'), compiled).includes('games'));
  });

  test('an event can carry several content tags, sorted and unique', () => {
    const tags = tagsFor(ev('Novel Strand', 'Book club writing game', 'book group'), compiled);
    assert.deepEqual(tags, ['book-club', 'bookstore', 'games', 'writing']);
  });

  test('a release event is tagged release', () => {
    assert.ok(tagsFor(ev('X', 'Midnight release party'), compiled).includes('release'));
    assert.ok(tagsFor(ev('X', 'Book Launch with the author'), compiled).includes('release'));
  });

  test('no matching rule means no content tags', () => {
    assert.deepEqual(tagsFor(ev('X', 'Knitting circle', 'Bring yarn'), compiled), []);
  });
});

describe('tagEvents and tagCounts', () => {
  test('tagEvents copies events and adds a tags array without mutating the input', () => {
    const input = [ev('Aurora Public Library', 'Book group')];
    const out = tagEvents(input, config);
    assert.deepEqual(out[0].tags, ['book-club', 'library']);
    assert.equal(input[0].tags, undefined);
  });

  test('tagCounts counts each tag once per event, most common first', () => {
    const events = [
      { tags: ['library', 'book-club'] },
      { tags: ['library'] },
      { tags: ['bookstore'] },
    ];
    const counts = tagCounts(events);
    assert.deepEqual(counts, { library: 2, 'book-club': 1, bookstore: 1 });
    assert.equal(Object.keys(counts)[0], 'library');
  });
});

describe('unmappedSources', () => {
  test('lists sources that have no entry in config.sources', () => {
    const events = [
      { source: 'Aurora Public Library' },
      { source: 'Mystery Venue' },
      { source: 'Mystery Venue' },
    ];
    assert.deepEqual(unmappedSources(events, config), ['Mystery Venue']);
  });
});

describe('shipped config/tags.json', () => {
  test('every content rule compiles and has at least one pattern', async () => {
    const { readFileSync } = await import('node:fs');
    const shipped = JSON.parse(readFileSync(new URL('../config/tags.json', import.meta.url), 'utf8'));
    assert.doesNotThrow(() => compileTags(shipped));
    for (const rule of shipped.tags) {
      assert.ok(rule.name && rule.match.length > 0, `rule "${rule.name}" has no patterns`);
    }
  });
});

describe('host tags for listing platforms', () => {
  const hostConfig = {
    fields: ['title', 'description'],
    caseSensitive: false,
    wholeWord: true,
    sources: {
      'Eventbrite (Denver books)': ['eventbrite'],
      'Aurora Public Library': ['library'],
    },
    hosts: {
      appliesToSourceKind: 'eventbrite',
      field: 'location',
      rules: [
        { match: ['Tattered Cover', 'Novel Strand'], tags: ['bookstore'] },
        { match: ['Brewing'], tags: ['venue'] },
      ],
    },
    tags: [],
  };
  const hc = compileTags(hostConfig);
  const eb = (location) => ({ source: 'Eventbrite (Denver books)', title: 'Book Club', location });

  test('an Eventbrite event takes the host kind from its location', () => {
    assert.deepEqual(tagsFor(eb('Tattered Cover Colfax — 2526 East Colfax'), hc), ['bookstore', 'eventbrite']);
  });

  test('the first matching host rule wins (Novel Strand Brewing is a bookstore, not a venue)', () => {
    assert.deepEqual(tagsFor(eb('Novel Strand Brewing Company — 305 1st ave'), hc), ['bookstore', 'eventbrite']);
  });

  test('an Eventbrite event with an unknown location keeps only the source tag', () => {
    assert.deepEqual(tagsFor(eb('2632 Blake Street, Denver'), hc), ['eventbrite']);
  });

  test('host rules do not apply to sources of another kind', () => {
    const lib = { source: 'Aurora Public Library', title: 'Story time', location: 'Tattered Cover Colfax' };
    assert.deepEqual(tagsFor(lib, hc), ['library']);
  });

  test('tagKinds includes the host kinds as well as source kinds', () => {
    const kinds = tagKinds(hostConfig);
    assert.ok(kinds.includes('bookstore'));
    assert.ok(kinds.includes('venue'));
    assert.ok(kinds.includes('library'));
  });

  test('the shipped config no longer uses the old "platform" kind', () => {
    const shipped = JSON.parse(readFileSync(new URL('../config/tags.json', import.meta.url), 'utf8'));
    assert.ok(!tagKinds(shipped).includes('platform'));
    assert.deepEqual(shipped.sources['Eventbrite (Denver books)'], ['eventbrite']);
  });
});
