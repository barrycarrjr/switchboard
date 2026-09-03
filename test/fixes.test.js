import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripCustomBaseUrls, applyFix, REMOVABLE_USER_ENV_VARS } from '../core/fixes.js';

test('stripCustomBaseUrls comments out custom endpoints and keeps vendor ones', () => {
  const toml = [
    'model = "gpt-5"',
    'base_url = "http://127.0.0.1:9999/v1"',
    'base_url = "https://api.openai.com/v1"',
  ].join('\n');
  const { changed, out } = stripCustomBaseUrls(toml);
  assert.equal(changed, true);
  const lines = out.split('\n');
  assert.match(lines[1], /^# removed by Switchboard: base_url/);
  assert.equal(lines[2], 'base_url = "https://api.openai.com/v1"');
});

test('stripCustomBaseUrls reports no change when nothing matches', () => {
  const { changed } = stripCustomBaseUrls('model = "gpt-5"\n');
  assert.equal(changed, false);
});

test('applyFix codex-remove-baseurl writes a backup then the transformed file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-f-'));
  const file = path.join(home, 'config.toml');
  fs.writeFileSync(file, 'base_url = "http://127.0.0.1:9999/v1"\n');
  const r = applyFix('codex-remove-baseurl', { home });
  assert.equal(r.ok, true);
  assert.match(fs.readFileSync(file, 'utf8'), /^# removed by Switchboard:/);
  const backups = fs.readdirSync(home).filter((f) => f.startsWith('config.toml.bak-'));
  assert.equal(backups.length, 1);
  assert.match(fs.readFileSync(path.join(home, backups[0]), 'utf8'), /^base_url/);
});

test('applyFix remove-user-env only accepts the allowlisted variables', () => {
  assert.throws(() => applyFix('remove-user-env', { name: 'PATH' }));
  assert.throws(() => applyFix('remove-user-env', { name: 'ANTHROPIC_API_KEY; rm x' }));
});

test('provider-routing overrides offered by Health are actually removable', () => {
  assert.equal(REMOVABLE_USER_ENV_VARS.includes('CLAUDE_CODE_USE_BEDROCK'), true);
  let removed = null;
  const result = applyFix(
    'remove-user-env',
    { name: 'CLAUDE_CODE_USE_BEDROCK' },
    { deleteEnv: (name) => { removed = name; } },
  );
  assert.equal(result.ok, true);
  assert.equal(removed, 'CLAUDE_CODE_USE_BEDROCK');
});

test('applyFix rejects unknown actions', () => {
  assert.throws(() => applyFix('format-disk', {}));
});

test('unregister-account removes the registration and leaves the folder alone', () => {
  // Both halves injected: nothing here may touch the registry of whoever runs the suite.
  const stored = { accounts: [
    { id: 'qwen-default', provider: 'qwen', label: 'Default', home: 'C:\home\.qwen' },
    { id: 'claude-default', provider: 'claude', label: 'Main', home: 'C:\home\.claude' },
  ] };
  let written = null;

  const result = applyFix('unregister-account', { id: 'qwen-default' }, {
    readRegistry: () => stored,
    writeRegistry: (reg) => { written = reg; },
  });

  assert.equal(result.ok, true);
  assert.match(result.did, /untouched/);
  assert.ok(written, 'the change is saved');
  assert.deepEqual(written.accounts.map((a) => a.id), ['claude-default']);
});

test('unregister-account says so rather than failing when the account is already gone', () => {
  let written = null;
  const result = applyFix('unregister-account', { id: 'gone' }, {
    readRegistry: () => ({ accounts: [] }),
    writeRegistry: (reg) => { written = reg; },
  });

  assert.equal(result.ok, true);
  assert.match(result.did, /no longer registered/);
  assert.equal(written, null, 'nothing to change means nothing is written');
});
