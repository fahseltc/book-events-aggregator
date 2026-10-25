import { readFileSync } from 'node:fs';
const o = JSON.parse(readFileSync('output/events.json', 'utf8'));
const cfg = JSON.parse(readFileSync('config/filters.json', 'utf8'));

const fields = cfg.fields && cfg.fields.length ? cfg.fields : ['title', 'description'];
function toRe(kw) {
  const core = kw.trim().split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\w*');
  const pat = cfg.wholeWord ? `(?<![\\w])${core}(?![\\w])` : core;
  return new RegExp(pat, cfg.caseSensitive ? '' : 'i');
}
const hay = (e) => fields.map((f) => e[f] || '').join('\n');

// Keywords WITHOUT 'release' and 'release party' vs WITH, to isolate the delta.
const base = cfg.keywords.filter((k) => k !== 'release' && k !== 'release party').map(toRe);
const releaseRe = toRe('release');
const exc = (cfg.exclude || []).map(toRe);

const matchedBefore = (e) => base.some((re) => re.test(hay(e)));
const excluded = (e) => exc.some((re) => re.test(hay(e)));

let newlyIncluded = [];
for (const e of o.events) {
  if (excluded(e)) continue; // exclude still wins
  const h = hay(e);
  if (!matchedBefore(e) && releaseRe.test(h)) newlyIncluded.push(e);
}
console.log(`'release' newly includes ${newlyIncluded.length} event(s) not matched by other keywords:\n`);
for (const e of newlyIncluded) {
  // show the matching context
  const m = hay(e).match(/.{0,25}release.{0,25}/i);
  console.log(`  [${e.source}] ${e.title}`);
  console.log(`      …${(m ? m[0] : '').replace(/\s+/g, ' ').trim()}…`);
}
