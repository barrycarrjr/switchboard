import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../test-support/tempdir.js';
import { loadSettings, saveSettings } from '../core/settings.js';
import {
  DEFAULT_SHARED_AI_FOLDER,
  activeSharedFolder,
  isPlainFolderName,
  listSharedSubfolders,
  normalizeBackupFolders,
  sharedFolderPath,
  sharedFolderProblem,
  sharedFolderState,
  toSettingPath,
  withBackupFolders,
  withSharedFolder,
} from '../core/shared-folder.js';
import { loadRulesSources, saveRulesSources, syncRules } from '../core/rules-sync.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// A fake machine: a home folder, Switchboard's data beside it, and nothing else.
function machine() {
  const base = tempDir('sb-shared-');
  const home = path.join(base, 'home');
  const appdata = path.join(base, 'appdata');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(appdata, 'Switchboard'), { recursive: true });
  const settingsPath = path.join(appdata, 'Switchboard', 'settings.json');
  const cFile = path.join(appdata, 'Switchboard', 'customizations.json');
  const accountsPath = path.join(appdata, 'Switchboard', 'accounts.json');
  fs.writeFileSync(accountsPath, JSON.stringify({ accounts: [] }), 'utf8');
  const file = (rel, text = 'x') => {
    const p = path.join(home, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, 'utf8');
    return p;
  };
  return { base, home, appdata, settingsPath, cFile, accountsPath, file };
}

test('a fresh install points at ~/.ai, stored with the tilde so no user name is ever saved', () => {
  const m = machine();
  const settings = loadSettings(m.settingsPath);
  assert.equal(settings.sharedAiFolder, DEFAULT_SHARED_AI_FOLDER);
  assert.equal(settings.sharedAiFolder, '~/.ai');
  assert.deepEqual(settings.sharedAiBackupFolders, ['rules', 'skills']);
  assert.equal(sharedFolderPath(settings, { home: m.home }), path.join(m.home, '.ai'));
});

test('a folder that does not exist is treated as absent and is never created', () => {
  const m = machine();
  const settings = loadSettings(m.settingsPath);
  const state = sharedFolderState(settings, { home: m.home });
  assert.equal(state.exists, false);
  assert.deepEqual(state.subfolders, []);
  assert.equal(activeSharedFolder(settings, { home: m.home }), null);
  assert.equal(fs.existsSync(path.join(m.home, '.ai')), false, 'reading the state made no folder');
});

test('an empty setting switches the folder off', () => {
  const m = machine();
  const off = withSharedFolder(loadSettings(m.settingsPath), '', { home: m.home });
  assert.equal(off.sharedAiFolder, '');
  assert.equal(sharedFolderPath(off, { home: m.home }), null);
  saveSettings(off, m.settingsPath);
  assert.equal(loadSettings(m.settingsPath).sharedAiFolder, '', 'off survives a save and a reload');
});

test('a folder chosen under the home folder is stored as ~/..., and one elsewhere as given', () => {
  const m = machine();
  assert.equal(toSettingPath(path.join(m.home, 'shared', 'ai'), m.home), '~/shared/ai');
  assert.equal(toSettingPath('~\\x\\', m.home), '~/x');
  const elsewhere = path.join(m.base, 'other');
  assert.equal(toSettingPath(elsewhere, m.home), elsewhere);
  m.file('notafolder.txt');
  assert.throws(() => withSharedFolder({}, path.join(m.home, 'notafolder.txt'), { home: m.home }), /not a folder/);
});

test('the ticks offered are the folders that exist inside the shared folder, each marked', () => {
  const m = machine();
  m.file('.ai/rules/a.md');
  m.file('.ai/scripts/x.ps1');
  m.file('.ai/loose.txt');
  const state = sharedFolderState(loadSettings(m.settingsPath), { home: m.home });
  assert.equal(state.exists, true);
  assert.deepEqual(state.subfolders, [{ name: 'rules', ticked: true }, { name: 'scripts', ticked: false }]);
  assert.deepEqual(state.backupFolders, ['rules', 'skills'], 'skills stays ticked for when it appears');
});

test('a backup folder is a plain name: separators and .. are refused', () => {
  for (const bad of ['a/b', 'a\\b', '..', '../up', 'x..y', 'C:', '']) {
    assert.equal(isPlainFolderName(bad), false, bad);
    assert.throws(() => normalizeBackupFolders([bad]), /not a plain folder name/, bad);
  }
  assert.deepEqual(normalizeBackupFolders(['rules', 'Rules', 'scripts']), ['rules', 'scripts']);
  assert.deepEqual(withBackupFolders({}, ['scripts']).sharedAiBackupFolders, ['scripts']);
});

test('the shared folder must sit inside the home folder: home itself, a folder outside it and a network share are refused', () => {
  const m = machine();
  const refused = [
    ['~', /home folder itself/],
    [m.home, /home folder itself/],
    [`${m.home}${path.sep}`, /home folder itself/],
    [path.join(m.base, 'other'), /outside your home folder/],
    [path.join(m.home, '..', 'other'), /outside your home folder/],
    ['\\\\server\\share\\ai', /network/],
    ['//server/share/ai', /network/],
  ];
  for (const [value, why] of refused) {
    assert.match(String(sharedFolderProblem(value, { home: m.home })), why, value);
    assert.throws(() => withSharedFolder({}, value, { home: m.home }), why, value);
  }
  assert.equal(sharedFolderProblem('~/.ai', { home: m.home }), null);
  assert.equal(sharedFolderProblem(path.join(m.home, 'shared', 'ai'), { home: m.home }), null);
  assert.equal(sharedFolderProblem('', { home: m.home }), null, 'off is always allowed');
  assert.equal(withSharedFolder({}, '~/.ai', { home: m.home }).sharedAiFolder, '~/.ai');
});

test('a folder under home that is a link to somewhere outside it is refused, even before the folder exists', () => {
  const m = machine();
  const outside = path.join(m.base, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(m.home, 'linked'), 'junction');
  assert.match(String(sharedFolderProblem('~/linked', { home: m.home })), /outside your home folder/);
  assert.match(String(sharedFolderProblem('~/linked/not-yet', { home: m.home })), /outside your home folder/);
});

test('a stored folder that is not allowed is treated as absent, and the state says why', () => {
  const m = machine();
  m.file('.ssh/id_key', 'secret');
  const settings = { sharedAiFolder: '~' };
  assert.equal(activeSharedFolder(settings, { home: m.home }), null);
  const state = sharedFolderState(settings, { home: m.home });
  assert.equal(state.exists, false);
  assert.deepEqual(state.subfolders, []);
  assert.match(state.problem, /home folder itself/);
  assert.equal(sharedFolderState({ sharedAiFolder: '~/.ai' }, { home: m.home }).problem, null);
});

test('a hidden folder name can never be ticked, and is not offered as a tick', () => {
  const m = machine();
  for (const bad of ['.ssh', '.aws', '.claude', '.git']) {
    assert.throws(() => normalizeBackupFolders([bad]), /hidden folder/, bad);
  }
  m.file('.ai/rules/a.md');
  m.file('.ai/.git/HEAD');
  assert.deepEqual(listSharedSubfolders(path.join(m.home, '.ai')), ['rules']);
});

test('ticks edited by hand into something unsafe read back as the default', () => {
  const m = machine();
  fs.writeFileSync(m.settingsPath, JSON.stringify({ sharedAiBackupFolders: ['../../evil'], sharedAiFolder: 7 }), 'utf8');
  const s = loadSettings(m.settingsPath);
  assert.deepEqual(s.sharedAiBackupFolders, ['rules', 'skills']);
  assert.equal(s.sharedAiFolder, '~/.ai');
});

test('with the shared folder present, a new rule file outside it is refused by name', () => {
  const m = machine();
  const inside = m.file('.ai/rules/global.md');
  const outside = m.file('elsewhere/other.md');
  const shared = path.join(m.home, '.ai');
  assert.deepEqual(saveRulesSources([inside], m.cFile, { home: m.home, sharedFolder: shared }), [inside]);
  assert.throws(
    () => saveRulesSources([inside, outside], m.cFile, { home: m.home, sharedFolder: shared }),
    /outside the shared AI folder .*other\.md/,
  );
  assert.deepEqual(loadRulesSources(m.cFile), [inside], 'the refused save changed nothing');
});

test('a rule file saved before the folder was set keeps working through a reorder or a removal', () => {
  const m = machine();
  const inside = m.file('.ai/rules/global.md');
  const old = m.file('elsewhere/old.md');
  saveRulesSources([old], m.cFile, { home: m.home, sharedFolder: null });
  const shared = path.join(m.home, '.ai');
  assert.deepEqual(saveRulesSources([inside, old], m.cFile, { home: m.home, sharedFolder: shared }), [inside, old]);
  assert.deepEqual(saveRulesSources([old, inside], m.cFile, { home: m.home, sharedFolder: shared }), [old, inside]);
});

test('while the shared folder does not exist, rule files can live anywhere', () => {
  const m = machine();
  const anywhere = m.file('elsewhere/other.md');
  assert.deepEqual(saveRulesSources([anywhere], m.cFile, { home: m.home, sharedFolder: activeSharedFolder({}, { home: m.home }) }), [anywhere]);
});

test('a rules sync names the sources that sit outside the shared folder', () => {
  const m = machine();
  const inside = m.file('.ai/rules/global.md', '# In\n');
  const old = m.file('elsewhere/old.md', '# Old\n');
  const res = syncRules({
    sources: [inside, old], dryRun: true, home: m.home, envReader: () => null,
    accountsPath: m.accountsPath, installedToolIds: [], sharedFolder: path.join(m.home, '.ai'),
  });
  assert.deepEqual(res.outsideSharedFolder, [old]);
});

// The command line is run for real, with its home folder and data folder pointed at
// the fake machine, so nothing it does can reach this computer's own.
function cli(m, ...args) {
  const env = { ...process.env, APPDATA: m.appdata, USERPROFILE: m.home, HOME: m.home };
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'cli.js'), ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('switchboard settings shows, sets and clears the shared folder, and stores what the page stores', () => {
  const m = machine();
  let r = cli(m, 'settings');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Shared AI folder: .*\.ai/);
  assert.match(r.out, /does not exist yet/);
  m.file('.ai/rules/a.md');
  r = cli(m, 'settings', 'shared-folder', path.join(m.home, '.ai'));
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(fs.readFileSync(m.settingsPath, 'utf8')).sharedAiFolder, '~/.ai');
  assert.match(r.out, /\[x\] rules/);
  r = cli(m, 'settings', 'shared-folder', '--clear');
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(fs.readFileSync(m.settingsPath, 'utf8')).sharedAiFolder, '');
  assert.match(r.out, /Shared AI folder: off/);
});

test('switchboard settings backup-folders stores plain names and refuses a path', () => {
  const m = machine();
  let r = cli(m, 'settings', 'backup-folders', 'rules', 'scripts');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(fs.readFileSync(m.settingsPath, 'utf8')).sharedAiBackupFolders, ['rules', 'scripts']);
  r = cli(m, 'settings', 'backup-folders', '../up');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /not a plain folder name/);
  r = cli(m, 'help');
  assert.match(r.out, /settings \[shared-folder/);
});

test('switchboard settings refuses a shared folder outside home or a hidden tick, and changes nothing', () => {
  const m = machine();
  let r = cli(m, 'settings', 'shared-folder', '~');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /home folder itself/);
  r = cli(m, 'settings', 'shared-folder', '\\\\server\\share');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /network/);
  r = cli(m, 'settings', 'backup-folders', '.ssh');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /hidden folder/);
  assert.equal(fs.existsSync(m.settingsPath), false, 'nothing was saved');
});
