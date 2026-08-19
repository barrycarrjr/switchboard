import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runChecks, claudeLoginState } from '../core/doctor.js';

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

// It is the login's own expiry that drives the level, not the access token's. The access
// token is hours long by design, so treating it as the signal warned on every account
// permanently. Each account below carries a realistic short-lived access token to prove it
// is ignored.
test('claude account login expiry drives the level, not the access token', async () => {
  const now = Date.parse('2026-08-17T00:00:00Z');
  const accessSoon = now + 8 * 3600 * 1000; // every real account looks like this
  const mk = (refreshTokenExpiresAt, tag) => {
    const home = tmpHome();
    fs.writeFileSync(
      path.join(home, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 't', expiresAt: accessSoon, refreshTokenExpiresAt } }),
    );
    return { id: tag, provider: 'claude', label: 'T', home };
  };
  const accounts = [
    mk(now + 200 * 24 * 3600 * 1000, 'far'),  // login healthy -> ok
    mk(now + 27 * 24 * 3600 * 1000, 'month'), // a month out is still fine -> ok
    mk(now + 3 * 24 * 3600 * 1000, 'soon'),   // login nearly out -> warn
    mk(now - 1000, 'gone'),                   // login expired -> warn
  ];
  const checks = await runChecks({ accounts, env: envNone, fetchImpl: noFetch, now });
  const levels = accounts.map((a) => checks.find((c) => c.id === `cred-${a.id}`).level);
  assert.deepEqual(levels, ['ok', 'ok', 'warn', 'warn']);
  assert.match(checks.find((c) => c.id === 'cred-gone').detail, /Sign in again/);
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

// ---- Which expiry stamp the login check reads ----
//
// `expiresAt` is the access token: hours long by design and refreshed silently.
// `refreshTokenExpiresAt` is the login. Reading the first warned on every account
// permanently and could never go green, because an access token is always hours away.

test('a login is healthy even when its access token is hours from lapsing', () => {
  const now = Date.now();
  const s = claudeLoginState({
    expiresAt: now + 8 * 60 * 60 * 1000,
    refreshTokenExpiresAt: now + 27 * 24 * 60 * 60 * 1000,
  }, now);
  assert.equal(s.level, 'ok', 'a short-lived access token is not a problem');
  assert.match(s.detail, /valid until/);
});

test('an already-lapsed access token is still not a warning', () => {
  const now = Date.now();
  const s = claudeLoginState({
    expiresAt: now - 60 * 60 * 1000,
    refreshTokenExpiresAt: now + 20 * 24 * 60 * 60 * 1000,
  }, now);
  assert.equal(s.level, 'ok', 'it refreshes itself on next use');
});

test('the login itself running out is the thing worth warning about', () => {
  const now = Date.now();
  const soon = claudeLoginState({ refreshTokenExpiresAt: now + 3 * 24 * 60 * 60 * 1000 }, now);
  assert.equal(soon.level, 'warn');
  assert.match(soon.detail, /Sign in again before then/);

  const gone = claudeLoginState({ refreshTokenExpiresAt: now - 24 * 60 * 60 * 1000 }, now);
  assert.equal(gone.level, 'warn');
  assert.match(gone.detail, /Login expired/);
});

test('a login comfortably in date reports ok, not a warning', () => {
  const now = Date.now();
  for (const days of [8, 27, 90, 365]) {
    const s = claudeLoginState({ refreshTokenExpiresAt: now + days * 24 * 60 * 60 * 1000 }, now);
    assert.equal(s.level, 'ok', `${days} days out should be ok`);
  }
});

test('an older credential file with no refresh stamp is not warned about', () => {
  const now = Date.now();
  assert.equal(claudeLoginState({ expiresAt: now + 60 * 60 * 1000 }, now).level, 'ok');
  assert.equal(claudeLoginState({ expiresAt: now - 60 * 60 * 1000 }, now).level, 'ok');
  assert.equal(claudeLoginState({}, now).level, 'ok');
  assert.equal(claudeLoginState(undefined, now).level, 'ok');
});

// The old wording rounded 0.33 days up and said "1 days".
test('a sub-day figure is worded in hours, never as "1 days"', () => {
  const now = Date.now();
  const s = claudeLoginState({ refreshTokenExpiresAt: now + 8 * 60 * 60 * 1000 }, now);
  assert.match(s.detail, /about 8 hours/);
  assert.ok(!/1 days/.test(s.detail));
});

test('epoch seconds and epoch milliseconds are both understood', () => {
  const now = Date.now();
  const inTwentyDays = now + 20 * 24 * 60 * 60 * 1000;
  const asMs = claudeLoginState({ refreshTokenExpiresAt: inTwentyDays }, now);
  const asSeconds = claudeLoginState({ refreshTokenExpiresAt: Math.floor(inTwentyDays / 1000) }, now);
  assert.equal(asMs.level, 'ok');
  assert.equal(asSeconds.level, 'ok', 'seconds must not read as 1970');
});
