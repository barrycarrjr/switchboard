import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../test-support/tempdir.js';
import { configSummary, createSwitchboardConfig, parseSwitchboardConfig } from '../core/config.js';
import {
  collectFilesSection,
  filesSummary,
  normalizeFilesSection,
  planFilesImport,
  restoreFilesSection,
  safeTarget,
} from '../core/shared-backup.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// A fake machine: a home folder with a shared AI folder in it, and Switchboard's own
// skills folder beside it. Nothing here touches the real home or app data.
function machine() {
  const base = tempDir('sb-backup-');
  const home = path.join(base, 'home');
  const shared = path.join(home, '.ai');
  const skillsRoot = path.join(base, 'appdata', 'Switchboard', 'customizations', 'skills');
  fs.mkdirSync(shared, { recursive: true });
  fs.mkdirSync(skillsRoot, { recursive: true });
  const put = (dir, rel, content) => {
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  };
  const settings = { sharedAiFolder: '~/.ai', sharedAiBackupFolders: ['rules', 'skills'] };
  const collect = (extra = {}) => collectFilesSection({ settings, home, skillsRoot, ...extra });
  return { base, home, shared, skillsRoot, put, settings, collect };
}

const paths = (list) => list.map((e) => e.path);

test('an export carries every file in each ticked folder, by path relative to the shared folder', () => {
  const m = machine();
  m.put(m.shared, 'rules/global.md', '# Global\n');
  m.put(m.shared, 'rules/deep/more.md', '# More\n');
  m.put(m.shared, 'skills/one/SKILL.md', '# One\n');
  m.put(m.shared, 'scripts/run.ps1', 'not ticked');
  const files = m.collect();
  assert.deepEqual(paths(files.shared), ['rules/deep/more.md', 'rules/global.md', 'skills/one/SKILL.md']);
  assert.equal(files.shared[1].text, '# Global\n');
  assert.equal(files.sharedFolder, '~/.ai');
  assert.deepEqual(files.backupFolders, ['rules', 'skills']);
});

test('Switchboard\'s own skills travel relative to its skills folder', () => {
  const m = machine();
  m.put(m.skillsRoot, 'tidy/SKILL.md', '# Tidy\n');
  assert.deepEqual(m.collect().skills, [{ path: 'tidy/SKILL.md', text: '# Tidy\n' }]);
});

test('the rule file list is stored relative to the shared folder, and a file outside it is listed as left out', () => {
  const m = machine();
  const inside = m.put(m.shared, 'rules/global.md', 'x');
  const outside = m.put(m.home, 'elsewhere/old.md', 'y');
  const files = m.collect({ rulesSources: [inside, outside] });
  assert.deepEqual(files.rulesSources, ['rules/global.md']);
  assert.deepEqual(files.skipped, [{ root: 'rules', path: outside, reason: 'a rule file outside the shared AI folder' }]);
});

test('binary, oversized and non-UTF-8 files are left out with their reason, and the total stops at its cap', () => {
  const m = machine();
  m.put(m.shared, 'rules/a-ok.md', 'a'.repeat(600));
  m.put(m.shared, 'rules/b-image.png', Buffer.from([0x89, 0x50, 0x00, 0x47]));
  m.put(m.shared, 'rules/c-big.md', 'b'.repeat(1024 * 1024 + 1));
  m.put(m.shared, 'rules/d-latin1.md', Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  m.put(m.shared, 'rules/e-late.md', 'c'.repeat(600));
  const files = m.collect({ totalLimit: 1000 });
  assert.deepEqual(paths(files.shared), ['rules/a-ok.md']);
  const why = Object.fromEntries(files.skipped.map((s) => [s.path, s.reason]));
  assert.equal(why['rules/b-image.png'], 'not a text file');
  assert.equal(why['rules/c-big.md'], 'over 1 MB');
  assert.equal(why['rules/d-latin1.md'], 'not UTF-8 text');
  assert.match(why['rules/e-late.md'], /15 MB/);
});

test('backup copies Switchboard writes itself are not carried', () => {
  const m = machine();
  m.put(m.shared, 'rules/global.md', 'x');
  m.put(m.shared, 'rules/global.md.bak-2026-11-03T10-00-00-000Z', 'old');
  m.put(m.shared, 'rules/global.md.before-switchboard-rules', 'old');
  m.put(m.shared, 'rules/global.md.before-import-2026-11-03T10-00-00-000Z', 'old');
  const files = m.collect();
  assert.deepEqual(paths(files.shared), ['rules/global.md']);
  assert.deepEqual(files.skipped, []);
});

test('a link inside a ticked folder that leads out of the shared folder is not followed', () => {
  const m = machine();
  const secret = m.put(m.base, 'outside/private.md', 'not for the backup');
  m.put(m.shared, 'rules/global.md', 'x');
  fs.symlinkSync(path.dirname(secret), path.join(m.shared, 'rules', 'linked'), 'junction');
  const files = m.collect();
  assert.deepEqual(paths(files.shared), ['rules/global.md']);
  assert.ok(!JSON.stringify(files).includes('not for the backup'));
  assert.deepEqual(files.skipped, [{ root: 'shared', path: 'rules/linked', reason: 'a link to somewhere outside the folder' }]);
});

test('with no shared folder on disk, nothing from it is carried and it is not created', () => {
  const m = machine();
  fs.rmSync(m.shared, { recursive: true });
  const files = m.collect();
  assert.deepEqual(files.shared, []);
  assert.equal(fs.existsSync(m.shared), false);
});

function configWith(files) {
  return createSwitchboardConfig({
    registry: { accounts: [] },
    settings: { quotaWatch: 'off', usageSources: {}, customApps: [], appOrder: [], updateRepo: null },
    mcp: { servers: [] },
    files,
    now: new Date('2026-11-03T12:00:00.000Z'),
  });
}

test('the files section survives a JSON round trip, and the summary counts folders, files and bytes', () => {
  const m = machine();
  m.put(m.shared, 'rules/global.md', '# Global\n');
  m.put(m.skillsRoot, 'tidy/SKILL.md', '# Tidy\n');
  const config = configWith(m.collect());
  const parsed = parseSwitchboardConfig(JSON.stringify(config));
  assert.deepEqual(parsed.files, config.files);
  assert.deepEqual(configSummary(parsed).files, { folders: 3, files: 2, bytes: 16, skipped: 0 });
});

test('a backup made before the files section existed imports exactly as before', () => {
  const old = configWith(null);
  assert.equal('files' in old, false);
  const parsed = parseSwitchboardConfig(JSON.stringify(old));
  assert.equal('files' in parsed, false);
  assert.deepEqual(configSummary(parsed), { accounts: 0, customApps: 0, mcpServers: 0 });
});

test('a top-level key this version does not know is ignored rather than refused', () => {
  const later = { ...configWith(null), somethingNew: { from: 'a later version' } };
  const parsed = parseSwitchboardConfig(JSON.stringify(later));
  assert.equal('somethingNew' in parsed, false);
});

test('a files section of the wrong shape refuses the import before anything is written', () => {
  const config = { ...configWith(null), files: { sharedFolder: '~/.ai', shared: [{ path: 'a.md', text: 7 }] } };
  assert.throws(() => parseSwitchboardConfig(JSON.stringify(config)), /files\.shared\[0\]\.text/);
  assert.throws(() => normalizeFilesSection([]), /files must be an object/);
});

test('a restore leaves the same text alone, copies different text aside before replacing it, and creates what is missing', () => {
  const m = machine();
  const same = m.put(m.shared, 'rules/same.md', 'same');
  const changed = m.put(m.shared, 'rules/changed.md', 'mine');
  const files = normalizeFilesSection({
    sharedFolder: '~/.ai',
    backupFolders: ['rules'],
    rulesSources: ['rules/same.md', 'rules/new/added.md'],
    shared: [
      { path: 'rules/same.md', text: 'same' },
      { path: 'rules/changed.md', text: 'theirs' },
      { path: 'rules/new/added.md', text: 'new' },
    ],
    skills: [{ path: 'tidy/SKILL.md', text: '# Tidy\n' }],
  });
  const now = new Date('2026-11-03T12:00:00.000Z');
  const r = restoreFilesSection(files, { sharedRoot: m.shared, skillsRoot: m.skillsRoot, now });
  assert.deepEqual(r.same, [same]);
  assert.deepEqual(r.replaced, [changed]);
  assert.equal(fs.readFileSync(changed, 'utf8'), 'theirs');
  assert.equal(fs.readFileSync(`${changed}.before-import-2026-11-03T12-00-00-000Z`, 'utf8'), 'mine');
  assert.equal(fs.readFileSync(path.join(m.shared, 'rules', 'new', 'added.md'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(m.skillsRoot, 'tidy', 'SKILL.md'), 'utf8'), '# Tidy\n');
  assert.deepEqual(r.rulesSources, [same, path.join(m.shared, 'rules', 'new', 'added.md')]);
  assert.deepEqual(r.backupFolders, ['rules']);
  assert.deepEqual(r.skipped, []);
});

test('a restore can put the shared folder somewhere else, and the rule list follows it there', () => {
  const m = machine();
  const files = m.collect();
  files.shared = [{ path: 'rules/global.md', text: '# G\n' }];
  files.rulesSources = ['rules/global.md'];
  const elsewhere = path.join(m.base, 'moved', 'ai');
  const r = restoreFilesSection(files, { sharedRoot: elsewhere, skillsRoot: m.skillsRoot });
  assert.deepEqual(r.rulesSources, [path.join(elsewhere, 'rules', 'global.md')]);
  assert.equal(fs.readFileSync(r.rulesSources[0], 'utf8'), '# G\n');
});

test('an entry whose path is absolute, climbs out with .., or names a drive or a share is skipped and reported, never written', () => {
  const m = machine();
  const target = path.join(m.base, 'escaped.md');
  const bad = [
    target,
    '../escaped.md',
    'rules/../../escaped.md',
    'C:\\escaped.md',
    'C:escaped.md',
    '\\\\server\\share\\escaped.md',
    '/escaped.md',
    'rules//x.md',
    'rules/x.md:stream',
    '',
  ];
  const files = normalizeFilesSection({ shared: bad.map((p) => ({ path: p, text: 'evil' })), skills: [{ path: '../../escaped.md', text: 'evil' }] });
  const r = restoreFilesSection(files, { sharedRoot: m.shared, skillsRoot: m.skillsRoot });
  assert.equal(r.skipped.length, bad.length + 1);
  assert.ok(r.skipped.every((s) => /outside its folder/.test(s.reason)));
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(r.created, []);
  for (const p of bad) assert.equal(safeTarget(m.shared, p), null, p);
});

test('an entry that a link inside the folder would carry outside it is skipped and reported', () => {
  const m = machine();
  const outside = path.join(m.base, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(m.shared, 'rules'), 'junction');
  const files = normalizeFilesSection({ shared: [{ path: 'rules/planted.md', text: 'evil' }] });
  const r = restoreFilesSection(files, { sharedRoot: m.shared, skillsRoot: m.skillsRoot });
  assert.equal(r.skipped[0].reason, 'a link would take it outside its folder');
  assert.equal(fs.existsSync(path.join(outside, 'planted.md')), false);
});

test('an unsafe tick or a rule path that climbs out is dropped and reported', () => {
  const m = machine();
  const files = normalizeFilesSection({ backupFolders: ['rules', '../up'], rulesSources: ['../../x.md'] });
  const r = restoreFilesSection(files, { sharedRoot: m.shared, skillsRoot: m.skillsRoot });
  assert.deepEqual(r.backupFolders, ['rules']);
  assert.deepEqual(r.rulesSources, []);
  assert.equal(r.skipped.length, 2);
});

test('the import suggests the backup\'s own folder, resolved for this machine\'s home', () => {
  const m = machine();
  const plan = planFilesImport(normalizeFilesSection({ sharedFolder: '~/.ai', shared: [{ path: 'rules/a.md', text: 'a' }] }), { home: m.home });
  assert.equal(plan.needsFolder, true);
  assert.equal(plan.suggested, path.join(m.home, '.ai'));
  assert.equal(plan.summary.files, 1);
  const offButFull = planFilesImport(normalizeFilesSection({ sharedFolder: '', shared: [{ path: 'a.md', text: 'a' }] }), { home: m.home });
  assert.equal(offButFull.suggested, path.join(m.home, '.ai'), 'files with nowhere to go are given the default folder');
  assert.equal(planFilesImport(normalizeFilesSection({ sharedFolder: '', skills: [{ path: 'a.md', text: 'a' }] }), { home: m.home }).needsFolder, false);
  assert.deepEqual(filesSummary(null), { folders: 0, files: 0, bytes: 0, skipped: 0 });
});

test('the export, both recovery copies and the import all carry the files section, and the import has room for it', () => {
  const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
  const current = main.slice(main.indexOf('function currentConfig()'), main.indexOf('// Claude\'s own status command'));
  assert.match(current, /files: collectFilesSection\(/, 'currentConfig, which the export and saveRecoveryConfig both use, collects the files');
  assert.match(main, /function saveRecoveryConfig[\s\S]*?writeJsonAtomic\(backupPath, currentConfig\(\)\)/);
  assert.match(main, /size > 20 \* 1024 \* 1024/);
  const handler = main.slice(main.indexOf("ipcMain.handle('sb:configImport'"));
  assert.ok(handler.indexOf("saveRecoveryConfig('before-import')") < handler.indexOf('restoreFilesSection('), 'the recovery copy is written before any file is restored');
});
