import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Switchboard is generic by construction: no person, company, or machine specifics
// may appear in the shipped source. This is a ratchet, not a suggestion.
//
// The committed patterns live in `scripts/forbidden-patterns.js` so that this ratchet and
// any generator writing third-party text into the tree check the same list rather than two
// copies that drift. Add private patterns (your name, your company, internal hostnames) to
// an untracked `.forbidden-local.json` beside package.json:
//   [{ "pattern": "somename", "flags": "i" }, ...]
// That file is gitignored on purpose: the guard list itself must not leak what it guards.
import { FORBIDDEN } from '../scripts/forbidden-patterns.js';

function loadLocalPatterns() {
  try {
    const raw = fs.readFileSync(path.join(root, '.forbidden-local.json'), 'utf8');
    return JSON.parse(raw).map((e) => ({ rx: new RegExp(e.pattern, e.flags ?? ''), why: 'local forbidden pattern' }));
  } catch {
    return [];
  }
}

function* sourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', 'build', 'assets'].includes(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(p);
    else if (/\.(js|cjs|mjs|html|json|md)$/.test(entry.name)) yield p;
  }
}

test('no personal, company, or machine-specific strings in the source tree', () => {
  const patterns = [...FORBIDDEN, ...loadLocalPatterns()];
  const offenders = [];
  for (const file of sourceFiles(root)) {
    // The guard list necessarily spells out what it forbids, so it cannot check itself.
    if (file.endsWith(path.join('scripts', 'forbidden-patterns.js'))) continue;
    if (file.endsWith('.forbidden-local.json')) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const { rx, why } of patterns) {
      if (rx.test(text)) offenders.push(`${path.relative(root, file)} matches ${rx} (${why})`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('all javascript files and html scripts in src, core, and bin pass syntax parsing', () => {
  const failures = [];
  for (const dir of ['src', 'core', 'bin']) {
    for (const file of sourceFiles(path.join(root, dir))) {
      if (/\.(js|cjs|mjs)$/.test(file)) {
        try {
          execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
        } catch (err) {
          failures.push(`${path.relative(root, file)}: ${err.stderr?.toString() || err.message}`);
        }
      } else if (file.endsWith('.html')) {
        const html = fs.readFileSync(file, 'utf8');
        const matches = html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi);
        for (const match of matches) {
          try {
            new Function(match[1]);
          } catch (err) {
            failures.push(`${path.relative(root, file)} script: ${err.message}`);
          }
        }
      }
    }
  }
  assert.deepEqual(failures, []);
});
