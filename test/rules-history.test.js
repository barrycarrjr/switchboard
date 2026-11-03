import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../test-support/tempdir.js';
import { syncRules } from '../core/rules-sync.js';
import {
  HISTORY_KEPT,
  listRuleVersions,
  readRuleVersion,
  recordRuleVersion,
  restoreRuleVersion,
} from '../core/rules-history.js';

// A fake machine with one Codex folder to sync into, and a history folder of its own,
// so nothing here reaches the real app data folder or the real home.
function machine() {
  const root = tempDir('sb-history-');
  const home = path.join(root, 'home');
  const dir = path.join(root, 'appdata', 'rules-history');
  fs.mkdirSync(path.join(home, '.ai', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const accountsPath = path.join(root, 'appdata', 'accounts.json');
  fs.mkdirSync(path.dirname(accountsPath), { recursive: true });
  fs.writeFileSync(accountsPath, JSON.stringify({ accounts: [] }), 'utf8');
  const src = path.join(home, '.ai', 'rules', 'global.md');
  fs.writeFileSync(src, '# v1\n', 'utf8');
  const sync = (extra = {}) => syncRules({
    sources: [src], home, envReader: () => null, accountsPath, installedToolIds: [],
    historyDir: dir, sharedFolder: null, ...extra,
  });
  return { root, home, dir, src, sync };
}

const at = (n) => new Date(Date.UTC(2026, 10, 3, 12, 0, n));

test('the first sync keeps a copy of each source, so there is something to go back to before any change', () => {
  const m = machine();
  const res = m.sync();
  assert.equal(res.history.length, 1);
  const list = listRuleVersions(m.src, { dir: m.dir, home: m.home });
  assert.equal(list.length, 1);
  assert.equal(readRuleVersion(m.src, list[0].version, { dir: m.dir, home: m.home }), '# v1\n');
  assert.equal(list[0].size, 5);
});

test('a sync with no change to the text keeps no new copy, and a change keeps exactly one', () => {
  const m = machine();
  m.sync();
  m.sync();
  assert.equal(listRuleVersions(m.src, { dir: m.dir }).length, 1);
  fs.writeFileSync(m.src, '# v2\n', 'utf8');
  m.sync();
  const list = listRuleVersions(m.src, { dir: m.dir });
  assert.equal(list.length, 2);
  assert.equal(readRuleVersion(m.src, 1, { dir: m.dir }), '# v2\n', 'version 1 is the newest');
});

test('a dry run, which is what opening the tab or switchboard rules status does, keeps nothing', () => {
  const m = machine();
  m.sync({ dryRun: true });
  assert.equal(listRuleVersions(m.src, { dir: m.dir }).length, 0);
});

test('a sync that refuses because another source is missing still keeps the readable ones', () => {
  const m = machine();
  const gone = path.join(m.home, '.ai', 'rules', 'gone.md');
  assert.throws(() => m.sync({ sources: [m.src, gone] }), /cannot read rule source/);
  assert.equal(listRuleVersions(m.src, { dir: m.dir }).length, 1);
});

test('only the newest twenty copies of a file are kept', () => {
  const m = machine();
  for (let i = 0; i < HISTORY_KEPT + 5; i += 1) {
    fs.writeFileSync(m.src, `# v${i}\n`, 'utf8');
    recordRuleVersion(m.src, { dir: m.dir, now: at(i) });
  }
  const list = listRuleVersions(m.src, { dir: m.dir });
  assert.equal(list.length, HISTORY_KEPT);
  assert.equal(readRuleVersion(m.src, 1, { dir: m.dir }), `# v${HISTORY_KEPT + 4}\n`);
  assert.equal(readRuleVersion(m.src, HISTORY_KEPT, { dir: m.dir }), '# v5\n', 'the oldest five were pruned');
});

test('two saves in the same millisecond, or after the clock steps back, still sort newest first', () => {
  const m = machine();
  recordRuleVersion(m.src, { dir: m.dir, now: at(10) });
  fs.writeFileSync(m.src, '# v2\n', 'utf8');
  recordRuleVersion(m.src, { dir: m.dir, now: at(10) });
  fs.writeFileSync(m.src, '# v3\n', 'utf8');
  recordRuleVersion(m.src, { dir: m.dir, now: at(5) });
  const texts = listRuleVersions(m.src, { dir: m.dir }).map((v) => readRuleVersion(m.src, v.version, { dir: m.dir }));
  assert.deepEqual(texts, ['# v3\n', '# v2\n', '# v1\n']);
});

test('two rule files with the same name in different folders keep separate histories', () => {
  const m = machine();
  const other = path.join(m.home, 'elsewhere', 'global.md');
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(other, '# other\n', 'utf8');
  recordRuleVersion(m.src, { dir: m.dir });
  recordRuleVersion(other, { dir: m.dir });
  assert.equal(readRuleVersion(other, 1, { dir: m.dir }), '# other\n');
  assert.equal(readRuleVersion(m.src, 1, { dir: m.dir }), '# v1\n');
});

test('a restore writes the old text back and keeps the text it replaced, so the restore can be undone', () => {
  const m = machine();
  recordRuleVersion(m.src, { dir: m.dir, now: at(1) });
  const first = listRuleVersions(m.src, { dir: m.dir })[0].version;
  fs.writeFileSync(m.src, '# a bad edit\n', 'utf8');
  restoreRuleVersion(m.src, first, { dir: m.dir, now: at(2) });
  assert.equal(fs.readFileSync(m.src, 'utf8'), '# v1\n');
  assert.equal(readRuleVersion(m.src, 1, { dir: m.dir }), '# a bad edit\n', 'the replaced text is the newest copy');
  restoreRuleVersion(m.src, 1, { dir: m.dir, now: at(3) });
  assert.equal(fs.readFileSync(m.src, 'utf8'), '# a bad edit\n', 'undoing the restore puts the edit back');
  assert.equal(fs.readdirSync(path.dirname(m.src)).filter((f) => f.includes('.tmp-')).length, 0, 'no temporary file is left beside it');
});

test('a source typed with ~ finds the same history', () => {
  const m = machine();
  recordRuleVersion(m.src, { dir: m.dir });
  assert.equal(listRuleVersions('~/.ai/rules/global.md', { dir: m.dir, home: m.home }).length, 1);
});

test('asking for a version that was never saved is refused, saying how to list them', () => {
  const m = machine();
  recordRuleVersion(m.src, { dir: m.dir });
  assert.throws(() => restoreRuleVersion(m.src, '2001-01-01T00-00-00-000Z', { dir: m.dir }), /no saved version .*switchboard rules history/);
  assert.throws(() => restoreRuleVersion(m.src, '../../x', { dir: m.dir }), /no saved version/);
  assert.equal(fs.readFileSync(m.src, 'utf8'), '# v1\n', 'the file was not touched');
});

test('the restored text reaches every tool on the next sync', () => {
  const m = machine();
  m.sync();
  fs.writeFileSync(m.src, '# broken\n', 'utf8');
  m.sync();
  restoreRuleVersion(m.src, 2, { dir: m.dir });
  m.sync();
  assert.match(fs.readFileSync(path.join(m.home, '.codex', 'AGENTS.md'), 'utf8'), /# v1/);
});

// Only the listing is run through the real command line: `rules restore` ends with a
// real sync, which reads this machine's own tool settings to find where to write.
test('switchboard rules history lists the saved copies of a file kept in the app data folder', () => {
  const m = machine();
  const appdata = path.join(m.root, 'appdata');
  const dir = path.join(appdata, 'Switchboard', 'rules-history');
  recordRuleVersion(m.src, { dir, now: at(1) });
  fs.writeFileSync(m.src, '# v2 is longer\n', 'utf8');
  recordRuleVersion(m.src, { dir, now: at(2) });
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.js');
  const env = { ...process.env, APPDATA: appdata, USERPROFILE: m.home, HOME: m.home };
  const r = spawnSync(process.execPath, [cli, 'rules', 'history', '~/.ai/rules/global.md', '--json'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const list = JSON.parse(r.stdout);
  assert.deepEqual(list.map((v) => v.size), [15, 5], 'newest first, with sizes');
});