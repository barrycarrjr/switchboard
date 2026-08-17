import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Switchboard is generic by construction: no person, company, or machine specifics
// may appear in the shipped source. This is a ratchet, not a suggestion.
//
// Committed patterns are generic (credential prefixes, key headers, user-profile
// paths, literal email addresses). Add private patterns (your name, your company,
// internal hostnames) to an untracked `.forbidden-local.json` beside package.json:
//   [{ "pattern": "somename", "flags": "i" }, ...]
// That file is gitignored on purpose: the guard list itself must not leak what it guards.
const FORBIDDEN = [
  { rx: /sk-ant-/, why: 'Anthropic credential prefix' },
  { rx: /ghp_[A-Za-z0-9]{20,}/, why: 'GitHub token' },
  { rx: /github_pat_/, why: 'GitHub fine-grained token' },
  { rx: /xox[baprs]-/, why: 'Slack token' },
  { rx: /AKIA[0-9A-Z]{16}/, why: 'AWS access key' },
  { rx: /BEGIN [A-Z ]*PRIVATE KEY/, why: 'private key material' },
  { rx: /C:\\+Users\\+[a-z]/i, why: 'a real user-profile path' },
  { rx: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.(com|net|org|io)/, why: 'a literal email address' },
];

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
    if (file.endsWith(path.join('test', 'generic.test.js'))) continue;
    if (file.endsWith('.forbidden-local.json')) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const { rx, why } of patterns) {
      if (rx.test(text)) offenders.push(`${path.relative(root, file)} matches ${rx} (${why})`);
    }
  }
  assert.deepEqual(offenders, []);
});
