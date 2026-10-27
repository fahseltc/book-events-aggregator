// Unit tests for src/lib/filter.js: keyword/exclude matching, wildcards,
// wholeWord boundaries, case handling, field selection, and annotation.
// Run with: npm test  (Node's built-in test runner, no dependencies).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileFilter, matchEvent, filterEvents } from '../src/lib/filter.js';

const ev = (title, description = '') => ({
  title,
  description,
  start: '2026-11-01T10:00:00',
  source: 'test',
});

const keep = (config, event) => matchEvent(event, compileFilter(config)).keep;

describe('compileFilter', () => {
  test('throws when there are no keywords', () => {
    assert.throws(() => compileFilter({ keywords: [] }), /no keywords/);
    assert.throws(() => compileFilter({ keywords: ['  ', ''] }), /no keywords/);
    assert.throws(() => compileFilter({}), /no keywords/);
  });

  test('ignores blank and non-string entries in keyword and exclude lists', () => {
    const c = compileFilter({ keywords: ['book*', '  ', 42], exclude: ['', null, 'teen'] });
    assert.equal(c.matchers.length, 1);
    assert.equal(c.excluders.length, 1);
  });

  test('defaults fields to title and description when none are given', () => {
    const c = compileFilter({ keywords: ['book*'] });
    assert.deepEqual(c.fields, ['title', 'description']);
  });
});

describe('keyword matching', () => {
  test('a keyword in the title keeps the event', () => {
    assert.equal(keep({ keywords: ['poetry'] }, ev('Poetry Night')), true);
  });

  test('a keyword only in the description keeps the event (default fields)', () => {
    assert.equal(keep({ keywords: ['poetry'] }, ev('Open Mic', 'A night of poetry')), true);
  });

  test('no keyword match means the event is dropped', () => {
    assert.equal(keep({ keywords: ['poetry'] }, ev('Knitting Circle', 'Bring yarn')), false);
  });

  test('fields restricts matching to the listed fields', () => {
    const cfg = { keywords: ['poetry'], fields: ['title'] };
    assert.equal(keep(cfg, ev('Open Mic', 'A night of poetry')), false);
    assert.equal(keep(cfg, ev('Poetry Night', '')), true);
  });

  test('a null or missing description does not throw', () => {
    assert.equal(keep({ keywords: ['poetry'] }, { title: 'Poetry', description: null }), true);
    assert.equal(keep({ keywords: ['poetry'] }, { title: 'Poetry' }), true);
  });

  test('wildcard book* matches book, books, and bookstore at a word start', () => {
    const cfg = { keywords: ['book*'], wholeWord: true };
    assert.equal(keep(cfg, ev('Book club')), true);
    assert.equal(keep(cfg, ev('Books and coffee')), true);
    assert.equal(keep(cfg, ev('Bookstore visit')), true);
  });

  test('matching is case-insensitive unless caseSensitive is set', () => {
    assert.equal(keep({ keywords: ['poetry'] }, ev('POETRY')), true);
    assert.equal(keep({ keywords: ['poetry'], caseSensitive: true }, ev('POETRY')), false);
    assert.equal(keep({ keywords: ['Poetry'], caseSensitive: true }, ev('Poetry')), true);
  });

  test('regex special characters are matched literally', () => {
    const cfg = { keywords: ['book*'], exclude: ['BLDG 61'] };
    assert.equal(keep(cfg, ev('Book talk at BLDG 61')), false);
    assert.equal(keep(cfg, ev('Book talk at BLDG 6x')), true);
  });

  test('a hyphenated exclude such as "ages 2-5" matches literally', () => {
    const cfg = { keywords: ['book*'], exclude: ['ages 2-5'] };
    assert.equal(keep(cfg, ev('Book time, ages 2-5')), false);
    assert.equal(keep(cfg, ev('Book time, ages 2 to 5')), true);
  });
});

describe('exclude handling', () => {
  test('an exclude match wins over a keyword match', () => {
    const cfg = { keywords: ['book*'], exclude: ['bookmobile'] };
    assert.equal(keep(cfg, ev('Bookmobile at the park')), false);
  });

  test('an exclude in the description drops an otherwise matching event', () => {
    const cfg = { keywords: ['book*'], exclude: ['children'] };
    assert.equal(keep(cfg, ev('Book swap', 'For children only')), false);
  });

  test('matchEvent reports which excludes fired', () => {
    const r = matchEvent(ev('Book storytime', 'toddler friendly'), compileFilter({
      keywords: ['book*'],
      exclude: ['storytime', 'toddler', 'teen'],
    }));
    assert.equal(r.keep, false);
    assert.deepEqual(r.excludedBy.sort(), ['storytime', 'toddler']);
  });
});

describe('wholeWord', () => {
  test('wholeWord off: "tween" matches inside "between" (substring match)', () => {
    const cfg = { keywords: ['book*'], exclude: ['tween'], wholeWord: false };
    assert.equal(keep(cfg, ev('Book club', 'Meets between 4 and 5')), false);
  });

  test('wholeWord on: "tween" does not match inside "between"', () => {
    const cfg = { keywords: ['book*'], exclude: ['tween'], wholeWord: true };
    assert.equal(keep(cfg, ev('Book club', 'Meets between 4 and 5')), true);
  });

  test('wholeWord on: "teen" does not match inside "thirteen", but matches the word', () => {
    const cfg = { keywords: ['book*'], exclude: ['teen'], wholeWord: true };
    assert.equal(keep(cfg, ev('Book club', 'Ages thirteen and up')), true);
    assert.equal(keep(cfg, ev('Book club', 'For teen readers')), false);
  });

  test('wholeWord on: "teen" does not catch plural "teens" (needs its own entry)', () => {
    const teenOnly = { keywords: ['book*'], exclude: ['teen'], wholeWord: true };
    assert.equal(keep(teenOnly, ev('Book swap', 'For teens')), true);
    const withPlural = { keywords: ['book*'], exclude: ['teen', 'teens'], wholeWord: true };
    assert.equal(keep(withPlural, ev('Book swap', 'For teens')), false);
  });

  test('wholeWord on: book* does not match inside "cookbook"', () => {
    const cfg = { keywords: ['book*'], wholeWord: true };
    assert.equal(keep(cfg, ev('Cookbook class')), false);
  });

  test('wholeWord on: a standalone "cookbook" keyword matches "Cookbook Club"', () => {
    const cfg = { keywords: ['cookbook'], wholeWord: true };
    assert.equal(keep(cfg, ev('Cookbook Club')), true);
  });

  test('wholeWord on: "cookbook" keyword does not match the plural "Cookbooks" (documents the gap)', () => {
    const cfg = { keywords: ['cookbook'], wholeWord: true };
    assert.equal(keep(cfg, ev('Cookbooks for beginners')), false);
  });

  test('wholeWord on: author* matches "authors" and a hyphenated "co-author"', () => {
    const cfg = { keywords: ['author*'], wholeWord: true };
    assert.equal(keep(cfg, ev('Panel of authors')), true);
    assert.equal(keep(cfg, ev('Co-author talk')), true);
  });

  test('wholeWord on: author* does not match inside "coauthor"', () => {
    const cfg = { keywords: ['author*'], wholeWord: true };
    assert.equal(keep(cfg, ev('Coauthor showcase')), false);
  });

  test('wholeWord on: the plain "author" keyword does not match "authors"', () => {
    const cfg = { keywords: ['author'], wholeWord: true };
    assert.equal(keep(cfg, ev('Panel of authors')), false);
  });

  test('wholeWord on: a multi-word keyword needs word boundaries at both ends', () => {
    const cfg = { keywords: ['release party'], wholeWord: true };
    assert.equal(keep(cfg, ev('Midnight release party!')), true);
    assert.equal(keep(cfg, ev('Prerelease partyware')), false);
  });

  test('wholeWord on: a keyword next to punctuation still matches', () => {
    const cfg = { keywords: ['poetry'], wholeWord: true };
    assert.equal(keep(cfg, ev('Punk+Poetry')), true);
    assert.equal(keep(cfg, ev('Spoken-poetry, open')), true);
  });
});

describe('filterEvents', () => {
  const events = [
    ev('Book club'),
    ev('Teen book swap'),
    ev('Knitting circle', 'Bring yarn'),
    ev('Bookmobile stop'),
  ];

  test('returns only the events that pass keyword and exclude rules', () => {
    const out = filterEvents(events, { keywords: ['book*', 'swap'], exclude: ['teen', 'bookmobile'], wholeWord: true });
    assert.deepEqual(out.map((e) => e.title), ['Book club']);
  });

  test('annotate adds matchedKeywords to kept events without mutating input', () => {
    const input = [ev('Poetry and books')];
    const out = filterEvents(input, { keywords: ['poetry', 'book*'] }, { annotate: true });
    assert.deepEqual(out[0].matchedKeywords, ['poetry', 'book*']);
    assert.equal(input[0].matchedKeywords, undefined);
  });

  test('without annotate, events are returned unchanged', () => {
    const out = filterEvents([ev('Poetry')], { keywords: ['poetry'] });
    assert.equal(out[0].matchedKeywords, undefined);
  });
});

describe('shipped config', () => {
  test('config/filters.json compiles and has no empty entries', () => {
    const cfg = JSON.parse(readFileSync(new URL('../config/filters.json', import.meta.url), 'utf8'));
    assert.doesNotThrow(() => compileFilter(cfg));
    for (const k of [...cfg.keywords, ...(cfg.exclude || [])]) {
      assert.equal(typeof k, 'string');
      assert.ok(k.trim().length > 0, `empty entry in config: "${k}"`);
    }
    assert.equal(typeof cfg.wholeWord, 'boolean');
  });
});
