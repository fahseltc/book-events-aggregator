#!/usr/bin/env node
// Syntax-check every .js and .mjs file under src/, test/, and scripts/.
// Replaces the hand-maintained list of `node --check` calls in package.json, so
// new modules and tests are covered automatically.
//
// Usage: npm run check

import { readdirSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['src', 'test', 'scripts'];
const EXTS = ['.js', '.mjs'];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (EXTS.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

const files = DIRS.filter((d) => existsSync(join(ROOT, d)))
  .flatMap((d) => walk(join(ROOT, d)))
  .sort();

const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) failures.push({ file, stderr: result.stderr || result.stdout });
}

if (failures.length) {
  for (const f of failures) {
    process.stderr.write(`\nSYNTAX ERROR: ${relative(ROOT, f.file)}\n${f.stderr}`);
  }
  process.stderr.write(`\n${failures.length} of ${files.length} file(s) failed the syntax check.\n`);
  process.exit(1);
}

process.stdout.write(`Syntax OK: ${files.length} file(s) checked.\n`);
