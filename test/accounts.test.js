import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, saveRegistry, addAccount, removeAccount, renameAccount, detectDefaults, detectCandidates, activeAccount, activeHome, setActive, normalizeHome, strayAccounts, envValueForHome, homeFromEnvValue, PROVIDERS } from '../core/accounts.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-'));
}

test('registry roundtrip through a file', () => {
  const dir = tmp();
  const file = path.join(dir, 'accounts.json');
  const reg = loadRegistry(file);
  assert.deepEqual(reg.accounts, []);
  addAccount(reg, { provider: 'claude', label: 'Work', home: path.join(dir, 'home-a') });
  saveRegistry(reg, file);
  const back = loadRegistry(file);
  assert.equal(back.accounts.length, 1);
  assert.equal(back.accounts[0].label, 'Work');
  assert.equal(back.accounts[0].provider, 'claude');
});

test('saveRegistry writes atomically: no temp files left, content lands whole', () => {
  const dir = tmp();
  const file = path.join(dir, 'accounts.json');
  const reg = { accounts: [] };
  addAccount(reg, { provider: 'claude', label: 'A', home: path.join(dir, 'a') });
  saveRegistry(reg, file);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), []);
  assert.equal(loadRegistry(file).accounts.length, 1);
});

test('a corrupt registry file loads as empty, never throws', () => {
  const dir = tmp();
  const file = path.join(dir, 'accounts.json');
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(loadRegistry(file).accounts, []);
});

test('duplicate homes per provider are rejected; ids stay unique', () => {
  const dir = tmp();
  const reg = { accounts: [] };
  const home = path.join(dir, 'h1');
  addAccount(reg, { provider: 'claude', label: 'One', home });
  assert.throws(() => addAccount(reg, { provider: 'claude', label: 'Other', home: home + path.sep }));
  const b = addAccount(reg, { provider: 'claude', label: 'One', home: path.join(dir, 'h2') });
  assert.notEqual(b.id, reg.accounts[0].id);
});

test('unknown provider is rejected', () => {
  assert.throws(() => addAccount({ accounts: [] }, { provider: 'nope', label: 'x', home: 'y' }));
});

test('renameAccount changes the label, keeps the id, and rejects empty names', () => {
  const dir = tmp();
  const reg = { accounts: [] };
  const a = addAccount(reg, { provider: 'claude', label: 'Default', home: path.join(dir, 'h') });
  const renamed = renameAccount(reg, a.id, '  Personal (Max)  ');
  assert.equal(renamed.label, 'Personal (Max)');
  assert.equal(renamed.id, a.id);
  assert.throws(() => renameAccount(reg, a.id, '   '));
  assert.throws(() => renameAccount(reg, 'nope', 'x'));
});

test('removeAccount removes exactly the target', () => {
  const dir = tmp();
  const reg = { accounts: [] };
  const a = addAccount(reg, { provider: 'claude', label: 'A', home: path.join(dir, 'a') });
  addAccount(reg, { provider: 'claude', label: 'B', home: path.join(dir, 'b') });
  removeAccount(reg, a.id);
  assert.equal(reg.accounts.length, 1);
  assert.equal(reg.accounts[0].label, 'B');
  assert.throws(() => removeAccount(reg, a.id));
});

test('activeAccount resolves the env-var home, case-insensitively, and falls back to default home', () => {
  const dir = tmp();
  const reg = { accounts: [] };
  const home = path.join(dir, 'ClaudeHome');
  const a = addAccount(reg, { provider: 'claude', label: 'Main', home });
  const viaEnv = activeAccount(reg, 'claude', () => home.toUpperCase());
  assert.equal(viaEnv?.id, a.id);
  const def = addAccount(reg, { provider: 'claude', label: 'Default', home: PROVIDERS.claude.defaultHome() });
  const viaDefault = activeAccount(reg, 'claude', () => null);
  assert.equal(viaDefault?.id, def.id);
});

test('setActive writes the provider env var with the account home', () => {
  const dir = tmp();
  const reg = { accounts: [] };
  const home = path.join(dir, 'h');
  const a = addAccount(reg, { provider: 'codex', label: 'P', home });
  const writes = [];
  setActive(reg, a.id, (name, value) => writes.push([name, value]));
  assert.deepEqual(writes, [['CODEX_HOME', path.resolve(home)]]);
});

test('detectCandidates offers signed-in sibling folders and nothing else', () => {
  const homeDir = tmp();
  // Looks like a second Claude account: has the credential file.
  fs.mkdirSync(path.join(homeDir, '.claude-second'));
  fs.writeFileSync(path.join(homeDir, '.claude-second', '.credentials.json'), '{}');
  // A dot-claude folder WITHOUT credentials (state, caches, unrelated tools): not offered.
  fs.mkdirSync(path.join(homeDir, '.claude-scratch'));
  // A second Codex home with its credential file: offered.
  fs.mkdirSync(path.join(homeDir, '.codex-alt'));
  fs.writeFileSync(path.join(homeDir, '.codex-alt', 'auth.json'), '{}');
  // Unrelated folder: ignored.
  fs.mkdirSync(path.join(homeDir, 'projects'));

  const found = detectCandidates({ accounts: [] }, homeDir);
  const byHome = Object.fromEntries(found.map((f) => [path.basename(f.home), f]));
  assert.equal(found.length, 2);
  assert.equal(byHome['.claude-second'].provider, 'claude');
  assert.equal(byHome['.claude-second'].label, 'second');
  assert.equal(byHome['.codex-alt'].provider, 'codex');

  // Registering one removes it from the next scan.
  const reg = { accounts: [] };
  addAccount(reg, byHome['.claude-second']);
  const again = detectCandidates(reg, homeDir);
  assert.equal(again.length, 1);
  assert.equal(path.basename(again[0].home), '.codex-alt');
});

test('detectDefaults skips homes that are already registered', () => {
  const reg = { accounts: [] };
  for (const p of Object.values(PROVIDERS)) {
    if (fs.existsSync(p.defaultHome())) addAccount(reg, { provider: p.id, label: 'Default', home: p.defaultHome() });
  }
  assert.deepEqual(detectDefaults(reg), []);
});

/* Tools whose variable names the folder ABOVE the config folder (Gemini CLI). */

test('a parent-shaped variable resolves through the vendor folder in both directions', () => {
  const dir = tmp();
  const parent = path.join(dir, 'work');
  const home = path.join(parent, '.gemini');
  const reg = { accounts: [] };
  const a = addAccount(reg, { provider: 'gemini', label: 'Work', home });

  // Reading: the variable names the parent, the config folder is inside it.
  assert.equal(activeHome('gemini', () => parent), home);
  assert.equal(activeAccount(reg, 'gemini', () => parent)?.id, a.id);
  // Unset falls back to the vendor default, not to the parent.
  assert.equal(activeHome('gemini', () => null), PROVIDERS.gemini.defaultHome());

  // Writing: the variable gets the parent, never the config folder itself.
  const writes = [];
  setActive(reg, a.id, (name, value) => writes.push([name, value]));
  assert.deepEqual(writes, [['GEMINI_CLI_HOME', parent]]);
});

test('a parent-shaped account folder must carry the vendor name, or it would never activate', () => {
  const dir = tmp();
  assert.throws(
    () => addAccount({ accounts: [] }, { provider: 'gemini', label: 'Work', home: path.join(dir, 'gemini-work') }),
    /must be named \.gemini/,
  );
  // normalizeHome is what makes a picked folder usable, so the person never meets that error.
  assert.equal(normalizeHome('gemini', path.join(dir, 'work')), path.join(dir, 'work', '.gemini'));
  assert.equal(normalizeHome('gemini', path.join(dir, 'work', '.gemini')), path.join(dir, 'work', '.gemini'));
  // A home-shaped tool takes the folder exactly as given.
  assert.equal(normalizeHome('claude', path.join(dir, 'anything')), path.join(dir, 'anything'));
});

test('candidates are looked for where each shape can actually keep them', () => {
  const homeDir = tmp();
  // Gemini: a second account lives one level down, because GEMINI_CLI_HOME names a home.
  fs.mkdirSync(path.join(homeDir, 'work', '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, 'work', '.gemini', 'oauth_creds.json'), '{}');
  // A sibling dot-folder can never be selected for Gemini, so it is not offered.
  fs.mkdirSync(path.join(homeDir, '.gemini-work'));
  fs.writeFileSync(path.join(homeDir, '.gemini-work', 'oauth_creds.json'), '{}');
  // Qwen names the folder itself, so a sibling IS a real account.
  fs.mkdirSync(path.join(homeDir, '.qwen-alt'));
  fs.writeFileSync(path.join(homeDir, '.qwen-alt', 'oauth_creds.json'), '{}');

  const found = detectCandidates({ accounts: [] }, homeDir);
  assert.deepEqual(
    found.map((f) => [f.provider, f.home]).sort(),
    [['gemini', path.join(homeDir, 'work', '.gemini')], ['qwen', path.join(homeDir, '.qwen-alt')]].sort(),
  );
});

test('every provider declares a shape that its own helpers agree on', () => {
  for (const def of Object.values(PROVIDERS)) {
    assert.ok(['home', 'parent'].includes(def.envShape), `${def.id} has no shape`);
    const home = def.defaultHome();
    assert.equal(path.basename(home), def.dirName);
    assert.equal(homeFromEnvValue(def, envValueForHome(def, home)), home);
  }
});

test('a vendor folder another product also writes to is not claimed on sight', () => {
  const homeDir = tmp();
  // Antigravity creates ~/.gemini without ever signing Gemini CLI in.
  fs.mkdirSync(path.join(homeDir, '.gemini', 'antigravity'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.codex'));
  assert.deepEqual(detectDefaults({ accounts: [] }, homeDir).map((f) => f.provider), ['codex']);

  fs.writeFileSync(path.join(homeDir, '.gemini', 'oauth_creds.json'), '{}');
  assert.deepEqual(detectDefaults({ accounts: [] }, homeDir).map((f) => f.provider).sort(), ['codex', 'gemini']);
});

test('detectDefaults registers nothing for a tool this machine does not have', () => {
  // Installing a tool created the folder, Switchboard registered it, and uninstalling
  // left the account behind holding a section and a tray row open.
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-defaults-'));
  try {
    fs.mkdirSync(path.join(homeDir, '.codex'));
    fs.mkdirSync(path.join(homeDir, '.qwen'));

    const all = detectDefaults({ accounts: [] }, homeDir).map((f) => f.provider).sort();
    assert.deepEqual(all, ['codex', 'qwen'], 'without the check, both folders register');

    const only = detectDefaults({ accounts: [] }, homeDir, { isInstalled: (id) => id === 'codex' });
    assert.deepEqual(only.map((f) => f.provider), ['codex']);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('strayAccounts names registrations whose tool has gone, and nothing else', () => {
  const reg = { accounts: [
    { id: 'claude-default', provider: 'claude' },
    { id: 'qwen-default', provider: 'qwen' },
  ] };

  assert.deepEqual(strayAccounts(reg, (id) => id === 'claude').map((a) => a.id), ['qwen-default']);
  assert.deepEqual(strayAccounts(reg, () => true), []);
  // No way to tell what is installed means no claim either way.
  assert.deepEqual(strayAccounts(reg, null), []);
});
