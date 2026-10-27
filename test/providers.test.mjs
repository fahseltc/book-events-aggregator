// Filter behavior over static mock events from several providers. Each entry in
// fixtures/mock-events.json states whether the event should be kept and, when
// relevant, which keywords it should match. Add provider groups there as the
// per-provider tests grow.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileFilter, matchEvent } from '../src/lib/filter.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/mock-events.json', import.meta.url), 'utf8'));
const compiled = compileFilter(fixture.config);

const byProvider = fixture.events.reduce((acc, e) => {
  (acc[e.provider] ||= []).push(e);
  return acc;
}, {});

for (const [provider, events] of Object.entries(byProvider)) {
  describe(`mock events: ${provider}`, () => {
    for (const e of events) {
      test(`${e.title} -> ${e.expectKept ? 'kept' : 'dropped'}`, () => {
        const result = matchEvent(e, compiled);
        assert.equal(
          result.keep,
          e.expectKept,
          `${e.note || ''} (matched: [${result.matched.join(', ')}], excludedBy: [${result.excludedBy.join(', ')}])`,
        );
        for (const kw of e.expectKeywords || []) {
          assert.ok(result.matched.includes(kw), `expected keyword "${kw}", got [${result.matched.join(', ')}]`);
        }
      });
    }
  });
}
