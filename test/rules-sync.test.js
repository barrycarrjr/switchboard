import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../test-support/tempdir.js';
import {
  createRulesWatcher,
  composeRules,
  loadRulesSources,
  planRulesSync,
  saveRulesSources,
  syncRules,
} from '../core/rules-sync.js';

// A fake machine: a home folder holding the rule sources and whichever tool
// folders a test asks for, plus Switchboard's own files beside it.
function machine({ tools = [] } = {}) {
  const root = tempDir('sb-rules-');
  const home = path.join(root, 'home');
  const sourceDir = path.join(home, 'rules-source');
  fs.mkdirSync(sourceDir, { recursive: true });
  for (const t of tools) fs.mkdirSync(path.join(home, t), { recursive: true });
  const accountsPath = path.join(root, 'appdata', 'accounts.json');
  const cFile = path.join(root, 'appdata', 'customizations.json');
  fs.mkdirSync(path.dirname(accountsPath), { recursive: true });
  fs.writeFileSync(accountsPath, JSON.stringify({ accounts: [] }), 'utf8');
  const source = (name, text) => {
    const p = path.join(sourceDir, name);
    fs.writeFileSync(p, text, 'utf8');
    return p;
  };
  const opts = (extra = {}) => ({ home, envReader: () => null, accountsPath, installedToolIds: [], ...extra });
  return { root, home, sourceDir, accountsPath, cFile, source, opts };
}

const read = (p) => fs.readFileSync(p, 'utf8');
const backupsOf = (file) => fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith(`${path.basename(file)}.bak-`));

test('the sources are joined in the order given, under a header that names them and says not to edit the copy', () => {
  const m = machine();
  const second = m.source('b-second.md', '# Second\r\nline two\r\n');
  const first = m.source('z-first.md', '\uFEFF# First\n');
  const text = composeRules([first, second], { home: m.home });
  assert.ok(text.indexOf('# First') < text.indexOf('# Second'), 'list order wins over file-name order');
  assert.match(text, /Edit those files, not this one/);
  assert.match(text, /- ~\/rules-source\/z-first\.md/);
  assert.ok(!text.includes('\r'), 'line endings are normalised to LF');
  assert.ok(!text.includes('\uFEFF'), 'a byte-order mark inside a source does not leak into the middle of the file');
});

test('a missing source stops the sync before any file is written', () => {
  const m = machine({ tools: ['.codex'] });
  const good = m.source('global.md', '# Rules\n');
  const gone = path.join(m.sourceDir, 'gone.md');
  assert.throws(() => syncRules(m.opts({ sources: [good, gone] })), /cannot read rule source: .*gone\.md/);
  assert.equal(fs.existsSync(path.join(m.home, '.codex', 'AGENTS.md')), false);
});

test('every account folder of every tool present gets the same file, and absent tools get no folder', () => {
  const second = 'codex-second';
  const m = machine({ tools: ['.codex', second, '.gemini'] });
  // The second Codex account's folder is only known through Switchboard's account list.
  fs.writeFileSync(m.accountsPath, JSON.stringify({ accounts: [{ id: 'codex-2', provider: 'codex', label: 'Second', home: path.join(m.home, second) }] }), 'utf8');
  const src = m.source('global.md', '# Shared rules\n');
  const res = syncRules(m.opts({ sources: [src] }));
  const codexA = path.join(m.home, '.codex', 'AGENTS.md');
  const codexB = path.join(m.home, second, 'AGENTS.md');
  const gemini = path.join(m.home, '.gemini', 'GEMINI.md');
  for (const f of [codexA, codexB, gemini]) assert.match(read(f), /# Shared rules/, `${f} was written`);
  assert.equal(read(codexA), read(codexB));
  assert.equal(res.targets.filter((t) => t.file === gemini).length, 1, 'Gemini and Antigravity share one file, written once');
  assert.equal(fs.existsSync(path.join(m.home, '.grok')), false, 'a tool that is not on the machine gets no folder');
});

test('a file already matching the sources is left alone, so a frequent sync leaves no backups behind', () => {
  const m = machine({ tools: ['.codex'] });
  const src = m.source('global.md', '# Rules\n');
  syncRules(m.opts({ sources: [src] }));
  const again = syncRules(m.opts({ sources: [src] }));
  const file = path.join(m.home, '.codex', 'AGENTS.md');
  assert.equal(again.targets.find((t) => t.file === file).action, 'same');
  assert.deepEqual(backupsOf(file), []);
});

test('an out-of-date file is backed up beside itself before it is replaced', () => {
  const m = machine({ tools: ['.codex'] });
  const file = path.join(m.home, '.codex', 'AGENTS.md');
  fs.writeFileSync(file, '# Old hand-kept copy\n', 'utf8');
  const src = m.source('global.md', '# New rules\n');
  const res = syncRules(m.opts({ sources: [src] }));
  assert.equal(res.targets.find((t) => t.file === file).action, 'write');
  assert.match(read(file), /# New rules/);
  const [backup] = backupsOf(file);
  assert.ok(backup, 'a backup exists');
  assert.equal(read(path.join(path.dirname(file), backup)), '# Old hand-kept copy\n');
});

test('a Claude account whose rules folder already holds the sources is skipped, so no rule loads twice', () => {
  const m = machine({ tools: ['.claude', '.claude-two'] });
  fs.writeFileSync(m.accountsPath, JSON.stringify({ accounts: [{ id: 'c2', provider: 'claude', label: 'Two', home: path.join(m.home, '.claude-two') }] }), 'utf8');
  const src = m.source('global.md', '# Rules\n');
  // The first account links its rules folder to the source folder; the second does not.
  fs.symlinkSync(m.sourceDir, path.join(m.home, '.claude', 'rules'), 'junction');
  const res = syncRules(m.opts({ sources: [src] }));
  const linked = res.targets.find((t) => t.home === path.join(m.home, '.claude'));
  const plain = res.targets.find((t) => t.home === path.join(m.home, '.claude-two'));
  assert.equal(linked.action, 'skip');
  assert.equal(fs.existsSync(path.join(m.home, '.claude', 'CLAUDE.md')), false);
  assert.equal(plain.action, 'create');
  assert.match(read(path.join(m.home, '.claude-two', 'CLAUDE.md')), /# Rules/);
});

test('a dry run reports what would change and writes nothing', () => {
  const m = machine({ tools: ['.codex'] });
  const src = m.source('global.md', '# Rules\n');
  const res = syncRules(m.opts({ sources: [src], dryRun: true }));
  assert.equal(res.targets[0].action, 'create');
  assert.equal(fs.existsSync(path.join(m.home, '.codex', 'AGENTS.md')), false);
});

test('no saved sources means the feature is off and nothing is planned', () => {
  const m = machine({ tools: ['.codex'] });
  const plan = planRulesSync(m.opts({ sources: [] }));
  assert.equal(plan.text, null);
  assert.deepEqual(plan.targets, []);
});

test('the saved list keeps its order, drops repeats, and refuses a path that is not a file', () => {
  const m = machine();
  const a = m.source('a.md', 'a');
  const b = m.source('b.md', 'b');
  assert.deepEqual(saveRulesSources([b, a, b], m.cFile), [b, a]);
  assert.deepEqual(loadRulesSources(m.cFile), [b, a]);
  assert.throws(() => saveRulesSources([a, path.join(m.sourceDir, 'typo.md')], m.cFile), /not a file: .*typo\.md/);
  assert.deepEqual(loadRulesSources(m.cFile), [b, a], 'a refused save leaves the old list in place');
  assert.throws(() => saveRulesSources([m.sourceDir], m.cFile), /not a file/);
});

test('one save to a source becomes one sync, and changes to other files in the folder are ignored', async () => {
  const m = machine();
  const src = m.source('global.md', 'a');
  const handlers = [];
  const fakeWatch = (dir, cb) => { handlers.push({ dir, cb }); return { close() {} }; };
  let calls = 0;
  const w = createRulesWatcher({ sources: [src], onChange: () => { calls += 1; }, debounceMs: 20, watch: fakeWatch });
  assert.equal(handlers.length, 1);
  assert.equal(handlers[0].dir, m.sourceDir, 'the folder is watched, so a save that replaces the file is still seen');
  handlers[0].cb('change', 'notes.txt');
  handlers[0].cb('rename', 'GLOBAL.md');
  handlers[0].cb('change', 'global.md');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls, 1);
  w.close();
});

test('under a byte budget files are kept in order until one does not fit, and that one and every later one are named to read', () => {
  const m = machine();
  const a = m.source('a.md', `# A\n${'a'.repeat(300)}`);
  const big = m.source('big.md', `# Big\n${'b'.repeat(5000)}`);
  const c = m.source('c.md', `# C\n${'c'.repeat(300)}`);
  const text = composeRules([a, big, c], { home: m.home, budget: 2000 });
  assert.ok(Buffer.byteLength(text, 'utf8') <= 2000, 'the result fits the budget');
  assert.ok(text.includes('# A'), 'the file before the one that did not fit is kept');
  assert.ok(!text.includes('# C\n'), 'a later small file is not pulled ahead of the big one, so the reading order holds');
  assert.ok(!text.includes('bbbb'), 'the file that does not fit is not copied in, not even partly');
  assert.match(text, /Rule files to read as well[\s\S]*- `~\/rules-source\/big\.md`\n- `~\/rules-source\/c\.md`/);
  assert.equal(composeRules([a, c], { home: m.home, budget: 2000 }), composeRules([a, c], { home: m.home }), 'text that fits is unchanged');
});

test('Antigravity gets the shortened file and Codex the whole one, and a file two tools share takes the smaller budget', () => {
  const m = machine({ tools: ['.codex', '.gemini'] });
  const src = m.source('global.md', `# Rules\n${'r'.repeat(30000)}`);
  const small = m.source('small.md', '# Small\n');
  syncRules(m.opts({ sources: [small, src] }));
  const codex = read(path.join(m.home, '.codex', 'AGENTS.md'));
  const gemini = read(path.join(m.home, '.gemini', 'GEMINI.md'));
  assert.ok(codex.includes('r'.repeat(30000)));
  assert.ok(!gemini.includes('r'.repeat(30000)));
  assert.match(gemini, /# Small/);
  assert.match(gemini, /- `~\/rules-source\/global\.md`/);
  const again = syncRules(m.opts({ sources: [small, src] }));
  assert.ok(again.targets.every((t) => t.action === 'same'), 'the shortened file counts as in step on the next run');
});
test('a source that is also a file the sync writes is refused, so the sync cannot feed on its own output', () => {
  const m = machine({ tools: ['.codex'] });
  const codexFile = path.join(m.home, '.codex', 'AGENTS.md');
  fs.writeFileSync(codexFile, '# Rules kept in Codex\n', 'utf8');
  const other = m.source('global.md', '# Global\n');
  assert.throws(() => syncRules(m.opts({ sources: [other, codexFile] })), /a rule source is also a file this sync writes: .*AGENTS\.md/);
  assert.equal(read(codexFile), '# Rules kept in Codex\n', 'the file was not touched');
});

test('a Claude rules folder holding a link to each source, or a copy with the same text, also counts as reading them', () => {
  const m = machine({ tools: ['.claude', '.claude-two'] });
  fs.writeFileSync(m.accountsPath, JSON.stringify({ accounts: [{ id: 'c2', provider: 'claude', label: 'Two', home: path.join(m.home, '.claude-two') }] }), 'utf8');
  const src = m.source('global.md', '# Rules\r\n');
  const copyDir = path.join(m.home, '.claude', 'rules');
  fs.mkdirSync(copyDir);
  fs.writeFileSync(path.join(copyDir, 'global.md'), '# Rules\n', 'utf8');
  const res = syncRules(m.opts({ sources: [src] }));
  assert.equal(res.targets.find((t) => t.home === path.join(m.home, '.claude')).action, 'skip', 'a same-text copy is enough');
  // Change the copy and the account is no longer covered.
  fs.writeFileSync(path.join(copyDir, 'global.md'), '# Older rules\n', 'utf8');
  assert.equal(syncRules(m.opts({ sources: [src], dryRun: true })).targets.find((t) => t.home === path.join(m.home, '.claude')).action, 'create');
});

test('a skipped Claude account that still has an earlier generated CLAUDE.md is told to delete it', () => {
  const m = machine({ tools: ['.claude'] });
  const src = m.source('global.md', '# Rules\n');
  syncRules(m.opts({ sources: [src] }));
  assert.match(read(path.join(m.home, '.claude', 'CLAUDE.md')), /Generated by Switchboard/);
  fs.symlinkSync(m.sourceDir, path.join(m.home, '.claude', 'rules'), 'junction');
  const t = syncRules(m.opts({ sources: [src] })).targets[0];
  assert.equal(t.action, 'skip');
  assert.match(t.reason, /older generated copy .* delete it/);
});

test('a hand-kept file is copied aside once before its first replacement, and that copy outlives the pruned backups', () => {
  const m = machine({ tools: ['.codex'] });
  const file = path.join(m.home, '.codex', 'AGENTS.md');
  fs.writeFileSync(file, '# Only copy of my rules\n', 'utf8');
  const src = m.source('global.md', 'v0');
  for (let i = 1; i <= 5; i += 1) {
    fs.writeFileSync(src, `v${i}`, 'utf8');
    syncRules(m.opts({ sources: [src] }));
  }
  assert.equal(read(`${file}.before-switchboard-rules`), '# Only copy of my rules\n');
  assert.ok(backupsOf(file).length <= 3, 'the ordinary backups are still pruned');
});

test('a source typed with a leading ~ is found under the home folder', () => {
  const m = machine();
  m.source('global.md', 'x');
  assert.deepEqual(saveRulesSources(['~/rules-source/global.md'], m.cFile, { home: m.home }), [path.join(m.sourceDir, 'global.md')]);
});

test('setting sources refuses to save over a settings file that will not parse', () => {
  const m = machine();
  const a = m.source('a.md', 'a');
  fs.writeFileSync(m.cFile, '{ "installedPlugins": [ broken', 'utf8');
  assert.throws(() => saveRulesSources([a], m.cFile), /will not parse/);
  assert.equal(read(m.cFile), '{ "installedPlugins": [ broken', 'the unreadable file is left exactly as it was');
});