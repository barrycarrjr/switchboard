import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../test-support/tempdir.js';
import { CONFIG_SIZE_LIMIT, buildBackupConfig, configSummary, createSwitchboardConfig, parseSwitchboardConfig } from '../core/config.js';
import {
  MAX_SKIPPED,
  collectFilesSection,
  describeSkipped,
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
  const r = restoreFilesSection(files, { sharedRoot: m.shared, skillsRoot: m.skillsRoot, home: m.home, now });
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
  const elsewhere = path.join(m.home, 'moved', 'ai');
  const r = restoreFilesSection(files, { sharedRoot: elsewhere, skillsRoot: m.skillsRoot, home: m.home });
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
  const r = restoreFilesSection(files, { sharedRoot: m.shared, skillsRoot: m.skillsRoot, home: m.home });
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
  const files = normalizeFilesSection({ backupFolders: ['rules'], shared: [{ path: 'rules/planted.md', text: 'evil' }] });
  const r = restoreFilesSection(files, { sharedRoot: m.shared, skillsRoot: m.skillsRoot, home: m.home });
  assert.equal(r.skipped[0].reason, 'a link would take it outside its folder');
  assert.equal(fs.existsSync(path.join(outside, 'planted.md')), false);
});

test('an unsafe tick or a rule path that climbs out is dropped and reported', () => {
  const m = machine();
  const files = normalizeFilesSection({ backupFolders: ['rules', '../up'], rulesSources: ['../../x.md'] });
  const r = restoreFilesSection(files, { sharedRoot: m.shared, skillsRoot: m.skillsRoot, home: m.home });
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
  assert.match(current, /buildBackupConfig\(/, 'currentConfig, which the export and saveRecoveryConfig both use, is built by core');
  assert.match(current, /collectFiles: \(\) => collectFilesSection\(/, 'and it collects the files');
  assert.match(main, /function saveRecoveryConfig[\s\S]*?writeJsonAtomic\(backupPath, built\.config\)/);
  assert.match(main, /size > CONFIG_SIZE_LIMIT/, 'the import refuses by the same limit an export is held to');
  const handler = main.slice(main.indexOf("ipcMain.handle('sb:configImport'"));
  assert.ok(handler.indexOf("saveRecoveryConfig('before-import')") < handler.indexOf('restoreFilesSection('), 'the recovery copy is written before any file is restored');
});

// --- Refusing a crafted backup ---

test('a backup naming the home folder as its shared folder is refused as the destination, and the default is offered instead', () => {
  const m = machine();
  const files = normalizeFilesSection({
    sharedFolder: '~',
    backupFolders: ['.claude', 'rules'],
    shared: [{ path: '.claude/settings.json', text: '{"hooks":{}}' }],
  });
  const plan = planFilesImport(files, { home: m.home });
  assert.equal(plan.refused.folder, '~');
  assert.match(plan.refused.reason, /home folder itself/);
  assert.equal(plan.suggested, path.join(m.home, '.ai'));
  for (const bad of ['\\\\server\\share\\ai', path.join(m.base, 'outside')]) {
    const p = planFilesImport(normalizeFilesSection({ sharedFolder: bad, shared: [{ path: 'rules/a.md', text: 'a' }] }), { home: m.home });
    assert.ok(p.refused, bad);
    assert.equal(p.suggested, path.join(m.home, '.ai'), bad);
  }
});

test('a restore into the home folder itself, or a network share, writes nothing and says why', () => {
  const m = machine();
  const files = normalizeFilesSection({
    sharedFolder: '~',
    backupFolders: ['.claude', 'AppData'],
    rulesSources: ['.claude/CLAUDE.md'],
    shared: [
      { path: '.claude/settings.json', text: '{"hooks":{}}' },
      { path: 'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/run.cmd', text: 'evil' },
    ],
  });
  for (const sharedRoot of [m.home, '\\\\server\\share\\ai']) {
    const r = restoreFilesSection(files, { sharedRoot, skillsRoot: m.skillsRoot, home: m.home });
    assert.deepEqual(r.created, [], String(sharedRoot));
    assert.equal(r.skipped.filter((s) => s.root === 'shared').length, 2);
    assert.ok(r.skipped.filter((s) => s.root === 'shared').every((s) => /cannot be the shared AI folder/.test(s.reason)));
    assert.deepEqual(r.rulesSources, []);
  }
  assert.equal(fs.existsSync(path.join(m.home, '.claude')), false);
  assert.equal(fs.existsSync(path.join(m.home, 'AppData')), false);
});

test('only files inside a ticked, visible folder of the backup are restored, and hidden ticks are refused', () => {
  const m = machine();
  const files = normalizeFilesSection({
    sharedFolder: '~/.ai',
    backupFolders: ['rules', '.ssh', '.aws'],
    shared: [
      { path: 'rules/a.md', text: 'a' },
      { path: '.ssh/authorized_keys', text: 'key' },
      { path: 'scripts/run.ps1', text: 'not ticked' },
      { path: 'loose.md', text: 'not in any folder' },
    ],
  });
  const r = restoreFilesSection(files, { sharedRoot: m.shared, skillsRoot: m.skillsRoot, home: m.home });
  assert.deepEqual(r.created, [path.join(m.shared, 'rules', 'a.md')]);
  assert.deepEqual(r.backupFolders, ['rules']);
  const why = Object.fromEntries(r.skipped.map((s) => [`${s.root}:${s.path}`, s.reason]));
  assert.match(why['ticks:.ssh'], /hidden folder/);
  assert.match(why['ticks:.aws'], /hidden folder/);
  assert.match(why['shared:.ssh/authorized_keys'], /not in one of the folders/);
  assert.match(why['shared:scripts/run.ps1'], /not in one of the folders/);
  assert.match(why['shared:loose.md'], /not in one of the folders/);
  assert.equal(fs.existsSync(path.join(m.shared, '.ssh')), false);
  assert.equal(fs.existsSync(path.join(m.shared, 'scripts')), false);
});

test('the import names the destination folder even when the backup holds no files, and off when the backup was off', () => {
  const m = machine();
  const plan = planFilesImport(normalizeFilesSection({ sharedFolder: '~/elsewhere' }), { home: m.home });
  assert.equal(plan.needsFolder, false);
  assert.equal(plan.suggested, path.join(m.home, 'elsewhere'));
  assert.equal(plan.refused, null);
  assert.equal(planFilesImport(normalizeFilesSection({ sharedFolder: '' }), { home: m.home }).suggested, null);
});

test('the import dialog always shows where the shared folder goes, and stores only the confirmed and checked folder', () => {
  const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
  const handler = main.slice(main.indexOf("ipcMain.handle('sb:configImport'"), main.indexOf("ipcMain.handle('sb:configImport'") + 9000);
  const confirm = handler.indexOf('dialog.showMessageBox(');
  assert.ok(handler.indexOf('Shared AI folder on this machine:') < confirm, 'the destination is in the confirmation');
  assert.doesNotMatch(handler, /if \(filesPlan\.needsFolder\) detail \+= `\\nShared AI folder/, 'not only when files need it');
  assert.doesNotMatch(handler, /imported\.files\.sharedFolder/, 'the backup\'s own setting is never stored unchecked');
  assert.match(handler, /sharedFolderProblem\(sharedRoot\)/, 'a folder chosen in the dialog is checked too');
  assert.ok(handler.indexOf('sharedFolderProblem(sharedRoot)') < handler.indexOf("saveRecoveryConfig('before-import')"), 'and checked before anything is written');
});

// --- Keeping an export importable ---

test('once the budget is spent the walk stops, so a huge folder adds one note rather than one per file', () => {
  const m = machine();
  for (let i = 0; i < 400; i += 1) m.put(m.shared, `rules/f${String(i).padStart(4, '0')}.md`, 'x'.repeat(100));
  const files = m.collect({ totalLimit: 1000 });
  assert.ok(files.shared.length > 0 && files.shared.length < 10);
  assert.equal(files.skipped.length, 1);
  assert.match(files.skipped[0].reason, /everything after it/);
});

test('the left-out list is bounded, the rest are counted, and the export still imports', () => {
  const m = machine();
  for (let i = 0; i < MAX_SKIPPED + 50; i += 1) m.put(m.shared, `rules/b${String(i).padStart(4, '0')}.png`, Buffer.from([0x89, 0x00]));
  const files = m.collect();
  assert.equal(files.skipped.length, MAX_SKIPPED);
  assert.equal(files.skippedMore, 50);
  assert.equal(filesSummary(files).skipped, MAX_SKIPPED + 50);
  assert.match(describeSkipped(files.skipped, 15, files.skippedMore).at(-1), new RegExp(`and ${MAX_SKIPPED + 50 - 15} more`));
  const parsed = parseSwitchboardConfig(JSON.stringify(configWith(files)));
  assert.equal(parsed.files.skippedMore, 50);
});

test('node_modules, .git, __pycache__ and .venv are left out whole, with one note each', () => {
  const m = machine();
  m.put(m.shared, 'rules/a.md', 'a');
  m.put(m.shared, 'rules/node_modules/pkg/index.md', 'b');
  m.put(m.shared, 'rules/.git/HEAD', 'ref');
  m.put(m.shared, 'rules/tool/__pycache__/x.md', 'c');
  m.put(m.shared, 'rules/.venv/lib/y.md', 'd');
  m.put(m.skillsRoot, 'tidy/node_modules/z.md', 'e');
  const files = m.collect();
  assert.deepEqual(paths(files.shared), ['rules/a.md']);
  assert.deepEqual(files.skills, []);
  assert.deepEqual(files.skipped.map((s) => s.path).sort(), ['rules/.git', 'rules/.venv', 'rules/node_modules', 'rules/tool/__pycache__', 'tidy/node_modules']);
  assert.ok(files.skipped.every((s) => /left out whole/.test(s.reason)));
});

test('Switchboard\'s own skills are read first, so a full shared folder cannot crowd them out', () => {
  const m = machine();
  m.put(m.shared, 'rules/big.md', 'r'.repeat(900));
  m.put(m.skillsRoot, 'tidy/SKILL.md', '# Tidy\n');
  const files = m.collect({ totalLimit: 1000 });
  assert.deepEqual(paths(files.skills), ['tidy/SKILL.md']);
  assert.deepEqual(files.shared, []);
});

test('the budget counts a file as it will be written into the export, escapes included', () => {
  const m = machine();
  m.put(m.shared, 'rules/quotes.md', '"'.repeat(400));
  const files = m.collect({ totalLimit: 700 });
  assert.deepEqual(files.shared, [], '400 bytes on disk become over 800 in the export');
});

test('a backup that would be too large to import is written without its files and says so, as is one whose files cannot be gathered', () => {
  const m = machine();
  m.put(m.shared, 'rules/global.md', 'g'.repeat(5000));
  const base = {
    registry: { accounts: [] },
    settings: { quotaWatch: 'off', usageSources: {}, customApps: [], appOrder: [], updateRepo: null },
    mcp: { servers: [] },
    now: new Date('2026-11-03T12:00:00.000Z'),
  };
  const fits = buildBackupConfig({ ...base, collectFiles: () => m.collect() });
  assert.equal(fits.filesLeftOut, null);
  assert.equal(fits.config.files.shared.length, 1);
  assert.equal(fits.text, `${JSON.stringify(fits.config, null, 2)}\n`);
  const tooBig = buildBackupConfig({ ...base, collectFiles: () => m.collect(), sizeLimit: 2000 });
  assert.equal('files' in tooBig.config, false);
  assert.match(tooBig.filesLeftOut, /too large to import/);
  const broken = buildBackupConfig({ ...base, collectFiles: () => { throw new Error('disk gone'); } });
  assert.equal('files' in broken.config, false);
  assert.match(broken.filesLeftOut, /disk gone/);
  assert.ok(Buffer.byteLength(fits.text) <= CONFIG_SIZE_LIMIT);
});
