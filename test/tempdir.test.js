// The two halves of the temp-dir discipline: a directory that removes itself when
// its process ends, and a sweep that collects what a killed process left behind.
//
// Worth testing rather than trusting, because the failure mode is invisible: a
// leak here costs nothing at all until %TEMP% holds hundreds of thousands of
// entries and every program on the machine gets slower at using it. That is what
// happened, 43,513 `sb-*` directories over 23 days (found 2026-09-09).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir, removeTempDirs, __testing } from '../test-support/tempdir.js';
import { sweepTempDirs, PREFIXES } from '../test-support/sweep-temp.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('tempDir makes a real directory and records it for removal', () => {
  const dir = tempDir('sb-test-');
  try {
    assert.equal(fs.existsSync(dir), true, 'the directory exists');
    assert.equal(__testing.created.has(dir), true, 'and it is registered for cleanup');
  } finally {
    removeTempDirs();
  }
});

test('removeTempDirs deletes the tree, contents and all, and forgets it', () => {
  const dir = tempDir('sb-test-');
  fs.mkdirSync(path.join(dir, 'projects', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects', 'demo', 'a.jsonl'), 'x', 'utf8');
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}', 'utf8');

  removeTempDirs();

  assert.equal(fs.existsSync(dir), false, 'a non-empty fixture tree still goes');
  assert.equal(__testing.created.size, 0, 'and nothing is left registered');
});

test('removeTempDirs survives a directory that is already gone', () => {
  const dir = tempDir('sb-test-');
  fs.rmSync(dir, { recursive: true, force: true });
  // Removing what a test already removed itself must not throw: this runs on
  // 'exit', where a throw would turn a green suite red for no reason.
  assert.doesNotThrow(() => removeTempDirs());
});

test('every prefix the tests create is one the sweep knows to collect', () => {
  // The sweep only removes names it recognises, so a new fixture prefix that
  // nobody adds to PREFIXES leaks forever with nothing to show for it. That is
  // exactly how the original pile grew. Read the sources rather than trust the
  // list, so adding a fixture with a new prefix fails here instead of silently.
  const found = new Set();
  for (const name of fs.readdirSync(here)) {
    if (!name.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(here, name), 'utf8');
    // A backtick prefix is a template, so only the part before ${ is literal.
    for (const m of src.matchAll(/tempDir\(\s*['"`]([^'"`$]*)/g)) found.add(m[1]);
    // A raw mkdtempSync is a leak in the making, but if one comes back its
    // prefix must at least be sweepable.
    for (const m of src.matchAll(/mkdtempSync\([^)]*?['"`]([^'"`$]*)/g)) found.add(m[1]);
  }

  assert.ok(found.size > 5, 'the scan actually read the test sources');
  const unswept = [...found].filter((prefix) => !PREFIXES.some((known) => prefix.startsWith(known)));
  assert.deepEqual(unswept, [], 'add these prefixes to PREFIXES in test-support/sweep-temp.js');
});

test('the sweep removes an old directory of ours and leaves a fresh one alone', () => {
  const root = tempDir('sb-test-sweep-');
  try {
    const old = path.join(root, 'sb-qc-aaaaaa');
    const fresh = path.join(root, 'sb-qc-bbbbbb');
    fs.mkdirSync(old);
    fs.mkdirSync(fresh);
    fs.writeFileSync(path.join(old, 'quota-cache.json'), '{}', 'utf8');
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    fs.utimesSync(old, twoDaysAgo, twoDaysAgo);

    const result = sweepTempDirs({ dir: root, maxAgeMs: 86_400_000 });

    assert.equal(fs.existsSync(old), false, 'the stale one is collected');
    assert.equal(fs.existsSync(fresh), true, 'a directory from a run happening now is not');
    assert.equal(result.removed, 1);
  } finally {
    removeTempDirs();
  }
});

test('the sweep never touches a name that is not one of ours', () => {
  const root = tempDir('sb-test-sweep-');
  try {
    const sibling = path.join(root, 'bridge-jobs-something');
    const stranger = path.join(root, 'npm-cache-x');
    fs.mkdirSync(sibling);
    fs.mkdirSync(stranger);
    const old = new Date(Date.now() - 30 * 86_400_000);
    fs.utimesSync(sibling, old, old);
    fs.utimesSync(stranger, old, old);

    const result = sweepTempDirs({ dir: root, maxAgeMs: 1 });

    assert.equal(fs.existsSync(sibling), true, 'another project own dirs are left alone');
    assert.equal(fs.existsSync(stranger), true, 'and so is everything else in a shared %TEMP%');
    assert.equal(result.scanned, 0, 'they are never even considered');
  } finally {
    removeTempDirs();
  }
});

test('the sweep stops at its budget rather than becoming the slow part of a test run', () => {
  const root = tempDir('sb-test-sweep-');
  try {
    const old = new Date(Date.now() - 2 * 86_400_000);
    for (let i = 0; i < 20; i += 1) {
      const dir = path.join(root, `sb-d-${i}`);
      fs.mkdirSync(dir);
      fs.utimesSync(dir, old, old);
    }
    // A zero budget is over before the first entry, so it reports timing out and
    // removes nothing rather than running to completion regardless.
    const result = sweepTempDirs({ dir: root, maxAgeMs: 1, budgetMs: 0 });
    assert.equal(result.timedOut, true, 'it says it stopped early');
    assert.equal(result.removed, 0);
  } finally {
    removeTempDirs();
  }
});

test('sweeping a directory that does not exist is not an error', () => {
  const result = sweepTempDirs({ dir: path.join(tempDir('sb-test-'), 'nope') });
  assert.deepEqual(result, { scanned: 0, removed: 0, failed: 0, timedOut: false });
  removeTempDirs();
});
