import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../test-support/tempdir.js';
import {
  KEPT_FOLDER_SUFFIX,
  SKILL_MARKER,
  createSkillsWatcher,
  planSkillsSync,
  setSkillState,
  skillContent,
  syncSkills,
} from '../core/skills-sync.js';
import { listInstalledSkills, loadCustomizationsState, saveCustomizationsState } from '../core/customizations.js';

// A fake machine: a home holding the shared AI folder and whichever tool folders a test
// asks for, plus Switchboard's own files beside it. Every path a sync could reach is
// passed in, so nothing here reads the real home folder or the real app data folder.
function machine({ tools = ['.claude', '.codex'], skillsFolder = true } = {}) {
  const root = tempDir('sb-skills-');
  const home = path.join(root, 'home');
  const shared = path.join(home, '.ai');
  const skillsDir = path.join(shared, 'skills');
  fs.mkdirSync(skillsFolder ? skillsDir : shared, { recursive: true });
  for (const t of tools) fs.mkdirSync(path.join(home, t), { recursive: true });
  const appdata = path.join(root, 'appdata');
  const accountsPath = path.join(appdata, 'accounts.json');
  const cFile = path.join(appdata, 'customizations.json');
  const cDir = path.join(appdata, 'customizations');
  fs.mkdirSync(appdata, { recursive: true });
  fs.writeFileSync(accountsPath, JSON.stringify({ accounts: [] }), 'utf8');
  const skill = (name, files = { 'SKILL.md': `---\nname: ${name}\n---\n# ${name}\n` }) => {
    const dir = path.join(skillsDir, name);
    for (const [rel, text] of Object.entries(files)) {
      const p = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    }
    return dir;
  };
  const opts = (extra = {}) => ({ home, envReader: () => null, accountsPath, installedToolIds: [], sharedFolder: shared, cFile, cDir, ...extra });
  const copyIn = (tool, name) => path.join(home, tool, 'skills', name);
  return { root, home, shared, skillsDir, accountsPath, cFile, cDir, skill, opts, copyIn };
}

const read = (p) => fs.readFileSync(p, 'utf8');
const marker = (dir) => JSON.parse(read(path.join(dir, SKILL_MARKER)));

test('a shared skill reaches every tool and account folder with all its files, and an absent tool gets no folder', () => {
  const m = machine({ tools: ['.claude', '.codex', 'codex-second'] });
  // The second Codex account is only known through Switchboard's account list.
  fs.writeFileSync(m.accountsPath, JSON.stringify({ accounts: [{ id: 'codex-2', provider: 'codex', label: 'Second', home: path.join(m.home, 'codex-second') }] }), 'utf8');
  const src = m.skill('audit', { 'SKILL.md': '# Audit\n', 'scripts/run.sh': 'echo hi\n' });
  const res = syncSkills(m.opts());
  for (const tool of ['.claude', '.codex', 'codex-second']) {
    const dir = m.copyIn(tool, 'audit');
    assert.equal(read(path.join(dir, 'SKILL.md')), '# Audit\n', `${tool} has the skill`);
    assert.equal(read(path.join(dir, 'scripts', 'run.sh')), 'echo hi\n', `${tool} has the skill's other files`);
    assert.equal(marker(dir).skill, 'audit');
    assert.equal(marker(dir).hash, skillContent(src).hash);
  }
  assert.ok(res.targets.every((t) => t.action === 'create'));
  assert.equal(fs.existsSync(path.join(m.home, '.grok')), false, 'a tool that is not on the machine gets no folder');
  assert.equal(fs.existsSync(path.join(m.home, '.gemini')), false);
});

test('a second sync with nothing changed touches nothing and leaves no backups', () => {
  const m = machine();
  m.skill('audit');
  syncSkills(m.opts());
  const dir = m.copyIn('.codex', 'audit');
  const before = fs.statSync(path.join(dir, 'SKILL.md')).mtimeMs;
  const res = syncSkills(m.opts());
  assert.ok(res.targets.every((t) => t.action === 'same'), 'every copy is reported in step');
  assert.equal(fs.statSync(path.join(dir, 'SKILL.md')).mtimeMs, before);
  assert.deepEqual(fs.readdirSync(dir).sort(), [SKILL_MARKER, 'SKILL.md'].sort());
});

test('an edited source updates every copy, keeping a backup of each changed file and of a file the source dropped', () => {
  const m = machine();
  const src = m.skill('audit', { 'SKILL.md': '# One\n', 'notes.md': 'old\n' });
  syncSkills(m.opts());
  fs.writeFileSync(path.join(src, 'SKILL.md'), '# Two\n');
  fs.rmSync(path.join(src, 'notes.md'));
  const res = syncSkills(m.opts());
  assert.ok(res.targets.every((t) => t.action === 'write' && !t.keepAs));
  const dir = m.copyIn('.claude', 'audit');
  assert.equal(read(path.join(dir, 'SKILL.md')), '# Two\n');
  assert.equal(fs.existsSync(path.join(dir, 'notes.md')), false);
  const names = fs.readdirSync(dir);
  assert.ok(names.some((n) => n.startsWith('SKILL.md.bak-')), 'the old SKILL.md is backed up beside the new one');
  assert.ok(names.some((n) => n.startsWith('notes.md.bak-')), 'the dropped file is kept as a backup, not deleted');
  assert.equal(syncSkills(m.opts()).targets.every((t) => t.action === 'same'), true, 'the backups do not make the copy look out of step');
});

test('files Switchboard itself writes are never copied out of a source', () => {
  const m = machine({ tools: ['.codex'] });
  m.skill('audit', {
    'SKILL.md': '# Audit\n',
    'SKILL.md.bak-2026-01-01T00-00-00-000Z': 'old\n',
    'notes.before-switchboard-rules': 'old\n',
    [SKILL_MARKER]: '{"managedBy":"switchboard","hash":"x"}',
  });
  syncSkills(m.opts());
  assert.deepEqual(fs.readdirSync(m.copyIn('.codex', 'audit')).sort(), [SKILL_MARKER, 'SKILL.md'].sort());
});

test('a different hand-kept copy is set aside beside the skills folder before its first replacement', () => {
  const m = machine({ tools: ['.codex'] });
  m.skill('audit', { 'SKILL.md': '# Shared\n' });
  const dest = m.copyIn('.codex', 'audit');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'SKILL.md'), '# Mine\n');
  const res = syncSkills(m.opts());
  const kept = path.join(m.home, '.codex', `skills${KEPT_FOLDER_SUFFIX}`, 'audit');
  assert.equal(res.targets[0].action, 'write');
  assert.equal(res.targets[0].keepAs, kept, 'the run reports where the old copy went');
  assert.equal(read(path.join(kept, 'SKILL.md')), '# Mine\n');
  assert.equal(read(path.join(dest, 'SKILL.md')), '# Shared\n');
  // A later hand-kept copy of the same name does not overwrite the first one kept.
  fs.rmSync(dest, { recursive: true });
  fs.mkdirSync(dest);
  fs.writeFileSync(path.join(dest, 'SKILL.md'), '# Mine again\n');
  const again = syncSkills(m.opts());
  assert.equal(again.targets[0].keepAs, `${kept}-2`);
  assert.equal(read(path.join(kept, 'SKILL.md')), '# Mine\n');
});

test('a hand copy identical to the source is taken over in place rather than set aside', () => {
  const m = machine({ tools: ['.codex'] });
  m.skill('audit', { 'SKILL.md': '# Same\n' });
  const dest = m.copyIn('.codex', 'audit');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'SKILL.md'), '# Same\n');
  const res = syncSkills(m.opts());
  assert.equal(res.targets[0].action, 'adopt');
  assert.equal(fs.existsSync(path.join(m.home, '.codex', `skills${KEPT_FOLDER_SUFFIX}`)), false);
  assert.equal(marker(dest).skill, 'audit');
});

test('a copy Switchboard wrote and someone then edited is kept before it is replaced', () => {
  const m = machine({ tools: ['.codex'] });
  const src = m.skill('audit', { 'SKILL.md': '# One\n' });
  syncSkills(m.opts());
  const dest = m.copyIn('.codex', 'audit');
  fs.writeFileSync(path.join(dest, 'SKILL.md'), '# Edited in the copy\n');
  fs.writeFileSync(path.join(src, 'SKILL.md'), '# Two\n');
  const res = syncSkills(m.opts());
  assert.ok(res.targets[0].keepAs, 'the edited copy is set aside');
  assert.equal(read(path.join(res.targets[0].keepAs, 'SKILL.md')), '# Edited in the copy\n');
  assert.equal(read(path.join(dest, 'SKILL.md')), '# Two\n');
});

test('a copy whose skill left the shared folder is removed, and a folder without the marker never is', () => {
  const m = machine({ tools: ['.codex'] });
  const src = m.skill('gone');
  syncSkills(m.opts());
  const mine = m.copyIn('.codex', 'mine');
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, 'SKILL.md'), '# Mine\n');
  fs.rmSync(src, { recursive: true });
  const res = syncSkills(m.opts());
  assert.deepEqual(res.targets.map((t) => [t.skill, t.action]), [['gone', 'remove']]);
  assert.equal(fs.existsSync(m.copyIn('.codex', 'gone')), false);
  assert.equal(read(path.join(mine, 'SKILL.md')), '# Mine\n');
});

test('a skill switched off for one tool is not written there, a copy already there is removed, and other tools keep it', () => {
  const m = machine();
  m.skill('audit');
  syncSkills(m.opts());
  saveCustomizationsState({ ...loadCustomizationsState(m.cFile), disabledSkills: [{ name: 'audit', client: 'codex' }] }, m.cFile);
  const res = syncSkills(m.opts());
  assert.equal(res.targets.find((t) => t.clientId === 'codex').action, 'remove');
  assert.equal(fs.existsSync(m.copyIn('.codex', 'audit')), false);
  assert.ok(fs.existsSync(path.join(m.copyIn('.claude', 'audit'), 'SKILL.md')));
  assert.equal(syncSkills(m.opts()).targets.some((t) => t.clientId === 'codex'), false, 'nothing is written back on the next run');
});

test('switching a shared skill off and on for one tool is remembered and applied to that tool only', () => {
  const m = machine();
  m.skill('audit');
  syncSkills(m.opts());
  setSkillState('audit', 'codex', false, m.opts());
  assert.deepEqual(loadCustomizationsState(m.cFile).disabledSkills, [{ name: 'audit', client: 'codex' }]);
  assert.equal(fs.existsSync(m.copyIn('.codex', 'audit')), false);
  assert.ok(fs.existsSync(m.copyIn('.claude', 'audit')));
  assert.equal(fs.existsSync(path.join(m.cDir, 'skills', 'audit')), false, 'a shared skill is not copied into Switchboard\'s own store');
  setSkillState('audit', 'codex', true, m.opts());
  assert.deepEqual(loadCustomizationsState(m.cFile).disabledSkills, []);
  assert.equal(marker(m.copyIn('.codex', 'audit')).skill, 'audit');
});

test('without a shared folder, or without a skills folder in it, nothing is written and nothing is removed', () => {
  const m = machine({ tools: ['.codex'] });
  m.skill('audit');
  syncSkills(m.opts());
  const none = syncSkills(m.opts({ sharedFolder: null }));
  assert.match(none.off, /no shared AI folder/);
  assert.deepEqual(none.targets, []);
  fs.rmSync(m.skillsDir, { recursive: true });
  const noSkills = syncSkills(m.opts());
  assert.match(noSkills.off, /no skills folder/);
  assert.ok(fs.existsSync(path.join(m.copyIn('.codex', 'audit'), 'SKILL.md')), 'a missing source folder does not take the copies with it');
});

test('a skills folder that links to the shared one, and a skill that links to its source, are skipped', () => {
  const m = machine({ tools: ['.claude', '.codex'] });
  const src = m.skill('audit');
  fs.symlinkSync(m.skillsDir, path.join(m.home, '.claude', 'skills'), 'junction');
  fs.mkdirSync(path.join(m.home, '.codex', 'skills'));
  fs.symlinkSync(src, m.copyIn('.codex', 'audit'), 'junction');
  const res = syncSkills(m.opts());
  const claude = res.targets.find((t) => t.clientId === 'claude');
  const codex = res.targets.find((t) => t.clientId === 'codex');
  assert.equal(claude.action, 'skip');
  assert.match(claude.reason, /is the shared skills folder/);
  assert.equal(codex.action, 'skip');
  assert.match(codex.reason, /link to the shared copy/);
  assert.equal(fs.existsSync(path.join(src, SKILL_MARKER)), false, 'no marker is ever written into the source');
});

test('a skill also in Switchboard\'s own store is reported, and the shared copy is the one written', () => {
  const m = machine({ tools: ['.codex'] });
  m.skill('audit', { 'SKILL.md': '# Shared\n' });
  fs.mkdirSync(path.join(m.cDir, 'skills', 'audit'), { recursive: true });
  fs.writeFileSync(path.join(m.cDir, 'skills', 'audit', 'SKILL.md'), '# Central\n');
  const res = syncSkills(m.opts());
  assert.deepEqual(res.overridesCentral, ['audit']);
  assert.equal(read(path.join(m.copyIn('.codex', 'audit'), 'SKILL.md')), '# Shared\n');
});

test('a dry run reports what would change and writes nothing', () => {
  const m = machine({ tools: ['.codex'] });
  m.skill('audit');
  const res = syncSkills(m.opts({ dryRun: true }));
  assert.equal(res.dryRun, true);
  assert.equal(res.targets[0].action, 'create');
  assert.equal(fs.existsSync(path.join(m.home, '.codex', 'skills')), false);
});

test('a burst of changes in the shared skills folder becomes one sync', async () => {
  const listeners = [];
  const fakeWatch = (_dir, _opts, cb) => { listeners.push(cb); return { close() {} }; };
  let calls = 0;
  const w = createSkillsWatcher({ dir: 'unused', onChange: () => { calls += 1; }, debounceMs: 10, watch: fakeWatch });
  for (let i = 0; i < 5; i += 1) listeners[0]('change', 'SKILL.md');
  await new Promise((r) => setTimeout(r, 40));
  w.close();
  assert.equal(calls, 1);
});

test('the skills list shows a shared skill, marked as shared, even when no tool has it', () => {
  const m = machine({ tools: ['.codex'] });
  m.skill('audit');
  const list = listInstalledSkills({ home: m.home, envReader: () => null, accountsPath: m.accountsPath, cDir: m.cDir, installedToolIds: [], sharedSkillsDir: m.skillsDir });
  const audit = list.find((s) => s.name === 'audit');
  assert.ok(audit, 'listed');
  assert.equal(audit.shared, true);
  assert.equal(audit.sourcePath, path.join(m.skillsDir, 'audit'));
  assert.equal(audit.state.codex, 'off');
});

test('a hand copy that was taken over is set aside, not deleted, when its shared skill goes, and the marker does not go with it', () => {
  const m = machine({ tools: ['.codex'] });
  const src = m.skill('audit', { 'SKILL.md': '# Same\n' });
  const dest = m.copyIn('.codex', 'audit');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'SKILL.md'), '# Same\n');
  syncSkills(m.opts());
  assert.equal(marker(dest).takenOver, true, 'the marker says the folder was someone\'s own');
  // An update from the source keeps the record of where the folder came from.
  fs.writeFileSync(path.join(src, 'SKILL.md'), '# Updated\n');
  syncSkills(m.opts());
  assert.equal(marker(dest).takenOver, true);
  fs.rmSync(src, { recursive: true });
  const res = syncSkills(m.opts());
  const kept = path.join(m.home, '.codex', `skills${KEPT_FOLDER_SUFFIX}`, 'audit');
  assert.equal(res.targets[0].action, 'remove');
  assert.equal(res.targets[0].keepAs, kept);
  assert.equal(fs.existsSync(dest), false);
  assert.equal(read(path.join(kept, 'SKILL.md')), '# Updated\n');
  assert.equal(fs.existsSync(path.join(kept, SKILL_MARKER)), false);
});

test('a copy Switchboard made itself is still removed outright when its skill goes', () => {
  const m = machine({ tools: ['.codex'] });
  const src = m.skill('audit');
  syncSkills(m.opts());
  assert.equal(marker(m.copyIn('.codex', 'audit')).takenOver, undefined);
  fs.rmSync(src, { recursive: true });
  const res = syncSkills(m.opts());
  assert.equal(res.targets[0].keepAs, undefined);
  assert.equal(fs.existsSync(path.join(m.home, '.codex', `skills${KEPT_FOLDER_SUFFIX}`)), false);
});

test('a same-name entry that links to another folder with the same content is skipped and nothing is written through it', () => {
  const m = machine({ tools: ['.codex', '.claude'] });
  const files = { 'SKILL.md': '# Same\n' };
  m.skill('audit', files);
  const otherShared = m.skill('other', files);
  const elsewhere = path.join(m.root, 'elsewhere', 'audit');
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.writeFileSync(path.join(elsewhere, 'SKILL.md'), '# Same\n');
  fs.mkdirSync(path.join(m.home, '.codex', 'skills'));
  fs.mkdirSync(path.join(m.home, '.claude', 'skills'));
  fs.symlinkSync(elsewhere, m.copyIn('.codex', 'audit'), 'junction');
  // A link into the shared skills folder, but to a different skill.
  fs.symlinkSync(otherShared, m.copyIn('.claude', 'audit'), 'junction');
  const res = syncSkills(m.opts());
  for (const clientId of ['codex', 'claude']) {
    const t = res.targets.find((x) => x.clientId === clientId && x.skill === 'audit');
    assert.equal(t.action, 'skip', clientId);
    assert.match(t.reason, /never writes through a link/, clientId);
  }
  assert.equal(fs.existsSync(path.join(elsewhere, SKILL_MARKER)), false);
  assert.equal(fs.existsSync(path.join(otherShared, SKILL_MARKER)), false, 'nothing lands in the shared folder, so the watcher has nothing to fire on');
  assert.ok(fs.lstatSync(m.copyIn('.codex', 'audit')).isSymbolicLink(), 'the link is left where it was');
});

test('a narrowed run never removes a copy it was not asked about', () => {
  const m = machine({ tools: ['.codex'] });
  const src = m.skill('gone');
  m.skill('audit');
  syncSkills(m.opts());
  fs.rmSync(src, { recursive: true });
  const plan = planSkillsSync(m.opts({ skillNames: ['audit'], clientIds: ['codex'] }));
  assert.equal(plan.targets.some((t) => t.action === 'remove'), false);
});
