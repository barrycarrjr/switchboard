import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runChecks } from '../core/doctor.js';

const noFetch = async () => { throw new Error('offline'); };
const envNone = { user: () => null, machine: () => null };

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-d-'));
}

test('a stray API key is a hard failure naming the scope, with a user-scope fix', async () => {
  const env = { user: (n) => (n === 'ANTHROPIC_API_KEY' ? 'sk-x' : null), machine: () => null };
  const checks = await runChecks({ env, fetchImpl: noFetch });
  const c = checks.find((x) => x.id === 'billing-override-ANTHROPIC_API_KEY');
  assert.equal(c.level, 'bad');
  assert.match(c.detail, /user scope/);
  assert.equal(c.fix.args.name, 'ANTHROPIC_API_KEY');
});

test('no API keys reads as ok', async () => {
  const checks = await runChecks({ env: envNone, fetchImpl: noFetch });
  assert.equal(checks.find((x) => x.id === 'billing-override').level, 'ok');
});

test('a persistent oauth token warns, and offers a user-scope removal fix', async () => {
  const env = { user: (n) => (n === 'CLAUDE_CODE_OAUTH_TOKEN' ? 'oat' : null), machine: () => null };
  const checks = await runChecks({ env, fetchImpl: noFetch });
  const c = checks.find((x) => x.id === 'token-pin');
  assert.equal(c.level, 'warn');
  assert.match(c.detail, /outranks/);
  assert.equal(c.fix.action, 'remove-user-env');
  assert.equal(c.fix.args.name, 'CLAUDE_CODE_OAUTH_TOKEN');
  assert.ok(c.fix.confirm.length > 20);
});

test('a machine-scope-only token gets no one-click fix (needs an admin terminal)', async () => {
  const env = { user: () => null, machine: (n) => (n === 'CLAUDE_CODE_OAUTH_TOKEN' ? 'oat' : null) };
  const checks = await runChecks({ env, fetchImpl: noFetch });
  const c = checks.find((x) => x.id === 'token-pin');
  assert.equal(c.fix, undefined);
  assert.match(c.detail, /admin terminal/);
});

test('claude account credential expiry drives the level', async () => {
  const now = Date.parse('2026-08-17T00:00:00Z');
  const mk = (expiresAt) => {
    const home = tmpHome();
    fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 't', expiresAt } }));
    return { id: 'x' + expiresAt, provider: 'claude', label: 'T', home };
  };
  const accounts = [
    mk(now + 200 * 24 * 3600 * 1000), // far future -> ok
    mk(now + 5 * 24 * 3600 * 1000),   // soon -> warn
    mk(now - 1000),                   // past -> warn (refreshes on next use)
  ];
  const checks = await runChecks({ accounts, env: envNone, fetchImpl: noFetch, now });
  const levels = accounts.map((a) => checks.find((c) => c.id === `cred-${a.id}`).level);
  assert.deepEqual(levels, ['ok', 'warn', 'warn']);
  assert.match(checks.find((c) => c.id === `cred-${accounts[2].id}`).detail, /refreshes/);
});

test('a missing credential file reads as not signed in, with the login hint', async () => {
  const account = { id: 'nc', provider: 'claude', label: 'New', home: tmpHome() };
  const checks = await runChecks({ accounts: [account], env: envNone, fetchImpl: noFetch });
  const c = checks.find((x) => x.id === 'cred-nc');
  assert.equal(c.level, 'warn');
  assert.match(c.detail, /setup-token/);
});

test('a codex custom base_url is flagged; the vendor default is not', async () => {
  const custom = tmpHome();
  fs.writeFileSync(path.join(custom, 'config.toml'), 'base_url = "http://127.0.0.1:9999/v1"\n');
  const stock = tmpHome();
  fs.writeFileSync(path.join(stock, 'config.toml'), 'base_url = "https://api.openai.com/v1"\n');
  const checks = await runChecks({
    accounts: [
      { id: 'c1', provider: 'codex', label: 'Custom', home: custom },
      { id: 'c2', provider: 'codex', label: 'Stock', home: stock },
    ],
    env: envNone,
    fetchImpl: noFetch,
  });
  assert.ok(checks.find((x) => x.id === 'codex-baseurl-c1'));
  assert.equal(checks.find((x) => x.id === 'codex-baseurl-c2'), undefined);
});

test('unreachable ollama is informational, not an error', async () => {
  const checks = await runChecks({ env: envNone, fetchImpl: noFetch });
  assert.equal(checks.find((x) => x.id === 'ollama').level, 'info');
});
