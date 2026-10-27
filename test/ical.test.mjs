// Unit tests for the iCalendar parser (src/lib/extract/ical.js): UTC conversion
// to America/Denver (DST-aware), all-day dates, floating times, and line
// unfolding/unescaping. Uses static sample text, no network.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcal } from '../src/lib/extract/ical.js';

const ics = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'DTSTART:20261027T170000Z',
  'DTEND:20261027T200000Z',
  'SUMMARY:Staff Appreciation Lunch\\, LIBRARY CLOSED',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20261012',
  'DTEND;VALUE=DATE:20261013',
  'SUMMARY:CLOSED: October 12th',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART:20261201T170000Z',
  'DTEND:20261201T180000Z',
  'SUMMARY:Winter Story Time',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART:20261027T180000',
  'SUMMARY:Floating local time',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART:20261104T160000Z',
  'SUMMARY:Book Club: The Ri',
  ' ver',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const events = parseIcal(ics, { sourceName: 'Test Library', sourceUrl: 'https://example.org/feed' });
const byTitle = (t) => events.find((e) => e.title === t);

describe('parseIcal: time handling', () => {
  test('parses every VEVENT', () => {
    assert.equal(events.length, 5);
  });

  test('UTC during daylight time converts with MDT (-6h)', () => {
    const e = byTitle('Staff Appreciation Lunch, LIBRARY CLOSED');
    assert.equal(e.start, '2026-10-27T11:00:00');
    assert.equal(e.end, '2026-10-27T14:00:00');
  });

  test('UTC during standard time converts with MST (-7h)', () => {
    const e = byTitle('Winter Story Time');
    assert.equal(e.start, '2026-12-01T10:00:00');
    assert.equal(e.end, '2026-12-01T11:00:00');
  });

  test('all-day VALUE=DATE becomes midnight, with the end on the next day', () => {
    const e = byTitle('CLOSED: October 12th');
    assert.equal(e.start, '2026-10-12T00:00:00');
    assert.equal(e.end, '2026-10-13T00:00:00');
  });

  test('floating local time (no Z) is kept as written', () => {
    const e = byTitle('Floating local time');
    assert.equal(e.start, '2026-10-27T18:00:00');
  });
});

describe('parseIcal: text handling', () => {
  test('unescapes \\, in SUMMARY', () => {
    assert.ok(byTitle('Staff Appreciation Lunch, LIBRARY CLOSED'));
  });

  test('joins folded lines (a leading space continues the previous line)', () => {
    assert.ok(byTitle('Book Club: The River'));
  });

  test('carries source name and URL through to each event', () => {
    const e = events[0];
    assert.equal(e.sourceName, 'Test Library');
    assert.equal(e.sourceUrl, 'https://example.org/feed');
    assert.equal(e.extractor, 'ical');
  });
});

describe('parseIcal: edge cases', () => {
  test('ignores VEVENTs with no usable DTSTART', () => {
    const text = 'BEGIN:VEVENT\r\nSUMMARY:No date\r\nEND:VEVENT';
    const out = parseIcal(text, {});
    assert.equal(out.length, 1);
    assert.equal(out[0].start, undefined);
  });

  test('empty input returns no events', () => {
    assert.deepEqual(parseIcal('', {}), []);
  });
});
