import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runChecks,
  claudeLoginState,
  accountLoginState,
  parseClaudeAuthStatus,
  claudeAuthStatusLaunch,
  verifiedAccountLoginState,
} from '../core/doctor.js';

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
  assert.match(c.detail, /claude auth login --claudeai/);
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

// ---- Login state on the Accounts page ----
//
// The card offers "Sign in / re-authenticate" whatever the state, so without this the link
// reads the same whether the login is good for a month or ran out yesterday.

test('an account with no credential file reads as not signed in', () => {
  const s = accountLoginState({ provider: 'claude', home: tmpHome() });
  assert.equal(s.signedIn, false);
  assert.equal(s.level, 'warn');
  assert.match(s.detail, /Not signed in/);
});

test('a healthy claude account carries its login date, not its access token', () => {
  const now = Date.now();
  const home = tmpHome();
  fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({
    claudeAiOauth: {
      accessToken: 't',
      expiresAt: now + 6 * 3600 * 1000,
      refreshTokenExpiresAt: now + 27 * 24 * 3600 * 1000,
    },
  }));
  const s = accountLoginState({ provider: 'claude', home }, now);
  assert.equal(s.signedIn, true);
  assert.equal(s.level, 'ok');
  assert.match(s.detail, /valid until/);
});

test('an expired claude login says so on the account card', () => {
  const now = Date.now();
  const home = tmpHome();
  fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { refreshToken: 'r', refreshTokenExpiresAt: now - 24 * 3600 * 1000 },
  }));
  const s = accountLoginState({ provider: 'claude', home }, now);
  assert.equal(s.level, 'warn');
  assert.match(s.detail, /Sign in again/);
});

// Codex writes no stamp for the login behind its short-lived tokens. Inventing a date from
// the token it does have would repeat the bug this all came from.
test('codex reports being signed in and claims no expiry it cannot know', () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {} }));
  const s = accountLoginState({ provider: 'codex', home });
  assert.equal(s.signedIn, true);
  assert.equal(s.level, 'ok');
  assert.equal(s.detail, 'Signed in');
});

test('an unreadable credential file is never claimed as a verified sign-in', () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, '.credentials.json'), '{not json');
  const s = accountLoginState({ provider: 'claude', home });
  assert.notEqual(s.signedIn, true);
  assert.notEqual(s.level, 'ok');
});

test('a secure-storage tombstone is not mistaken for a working Claude login', () => {
  const now = Date.now();
  const home = tmpHome();
  fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({
    claudeAiOauth: {
      accessToken: '',
      refreshToken: '',
      expiresAt: 0,
      // This metadata can survive after the usable credential has moved or vanished.
      refreshTokenExpiresAt: now + 60 * 24 * 60 * 60 * 1000,
    },
  }));
  const s = accountLoginState({ provider: 'claude', home }, now);
  assert.notEqual(s.signedIn, true);
  assert.notEqual(s.level, 'ok');
  assert.doesNotMatch(s.detail, /valid until/i);
});

test('parseClaudeAuthStatus allowlists the vendor status and account identity fields', () => {
  const signedIn = parseClaudeAuthStatus(JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'private@example.test',
    orgId: 'org-work',
    orgName: 'Private Organization',
    subscriptionType: 'max',
    accessToken: 'must-never-leave-the-command-parser',
  }));
  assert.equal(signedIn.loggedIn, true);
  assert.equal(signedIn.organizationUuid, 'org-work');
  assert.equal(signedIn.email, 'private@example.test');
  assert.equal(signedIn.plan, 'max');
  assert.equal(JSON.stringify(signedIn).includes('must-never-leave'), false, 'unexpected credential fields are dropped');

  const signedOut = parseClaudeAuthStatus('{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}');
  assert.equal(signedOut.loggedIn, false);
  assert.equal(signedOut.authMethod, 'none');

  assert.equal(parseClaudeAuthStatus('not json'), null);
  assert.equal(parseClaudeAuthStatus('{}'), null);
});

test('the vendor auth probe launches an absolute native executable without a shell', async () => {
  const home = tmpHome();
  const executable = 'C:\\Program Files\\Claude Code\\claude.exe';
  let invocation;
  await verifiedAccountLoginState({ provider: 'claude', home }, {
    executable,
    runImpl: async (file, args, options) => {
      invocation = { file, args, options };
      return { stdout: '{"loggedIn":false}' };
    },
  });

  assert.equal(invocation.file, executable);
  assert.deepEqual(invocation.args, ['auth', 'status', '--json']);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.windowsVerbatimArguments, undefined);
});

test('the vendor auth probe runs cmd and bat npm shims through a constrained cmd.exe command', async () => {
  const home = tmpHome();
  for (const extension of ['cmd', 'BAT']) {
    const executable = `C:\\Program Files (x86)\\Claude & Co\\claude.${extension}`;
    let invocation;
    await verifiedAccountLoginState({ provider: 'claude', home }, {
      executable,
      runImpl: async (file, args, options) => {
        invocation = { file, args, options };
        return { stdout: '{"loggedIn":false}' };
      },
    });

    assert.equal(invocation.file, 'cmd.exe');
    assert.deepEqual(invocation.args, [
      '/d',
      '/s',
      '/v:off',
      '/c',
      `""${executable}" auth status --json"`,
    ]);
    assert.equal(invocation.options.shell, false);
    assert.equal(invocation.options.windowsVerbatimArguments, true);
    assert.equal(invocation.options.env.CLAUDE_CONFIG_DIR, home);
  }
});

test('a batch-shim path that cmd could expand is rejected before launch', () => {
  assert.throws(
    () => claudeAuthStatusLaunch('C:\\Users\\%USERNAME%\\claude.cmd'),
    /unsafe/i,
  );
});

test('the vendor auth probe overrides a plausible but unusable credential tombstone', async () => {
  const now = Date.now();
  const home = tmpHome();
  fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: '', refreshToken: '', refreshTokenExpiresAt: now + 60 * 24 * 60 * 60 * 1000 },
  }));
  let invocation;
  const runImpl = async (file, args, options) => {
    invocation = { file, args, options };
    const error = new Error('Command failed with exit code 1');
    error.code = 1;
    // `claude auth status` deliberately exits nonzero when logged out, but its JSON is
    // still the authoritative result and must not be discarded with the rejection.
    error.stdout = '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}';
    throw error;
  };
  const s = await verifiedAccountLoginState({ provider: 'claude', home }, { runImpl, now });
  assert.equal(s.signedIn, false);
  assert.match(s.detail, /not signed in/i);
  assert.match(String(invocation.file), /claude/i);
  assert.deepEqual(invocation.args, ['auth', 'status', '--json']);
  assert.equal(invocation.options.env.CLAUDE_CONFIG_DIR, home);
  assert.equal(invocation.options.windowsHide, true);
});

test('the vendor auth probe recognizes a system-store login even without a token file', async () => {
  const home = tmpHome();
  const s = await verifiedAccountLoginState({ provider: 'claude', home }, {
    runImpl: async () => ({
      stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', orgId: 'org-secure' }),
    }),
  });
  assert.equal(s.signedIn, true);
  assert.equal(s.level, 'ok');
  assert.equal(s.organizationUuid, 'org-secure');
});

test('API-key auth is not misreported as a Claude subscription login', async () => {
  const home = tmpHome();
  const s = await verifiedAccountLoginState({ provider: 'claude', home }, {
    runImpl: async () => ({
      stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }),
    }),
  });
  assert.equal(s.signedIn, false);
  assert.equal(s.level, 'warn');
  assert.match(s.detail, /API-key authentication/i);
  assert.equal(s.verified, true);
});

test('a verified subscription login preserves an approaching refresh-expiry warning', async () => {
  const now = 2_000_000_000_000;
  const home = tmpHome();
  fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({
    claudeAiOauth: {
      accessToken: 'readable',
      refreshToken: 'refreshable',
      refreshTokenExpiresAt: now + 2 * 24 * 60 * 60 * 1000,
    },
  }));
  const s = await verifiedAccountLoginState({ provider: 'claude', home }, {
    now,
    runImpl: async () => ({ stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}' }),
  });
  assert.equal(s.signedIn, true);
  assert.equal(s.level, 'warn');
  assert.match(s.detail, /expires/i);
});

test('a failed vendor probe is unknown rather than a false negative for secure storage', async () => {
  const home = tmpHome();
  const s = await verifiedAccountLoginState({ provider: 'claude', home }, {
    runImpl: async () => { throw new Error('unavailable'); },
  });
  assert.equal(s.signedIn, null);
  assert.equal(s.level, 'info');
  assert.equal(s.verified, false);
});

test('an unavailable vendor probe falls back without upgrading unknown metadata to signed in', async () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, '.credentials.json'), '{not json');
  const s = await verifiedAccountLoginState({ provider: 'claude', home }, {
    runImpl: async () => { throw new Error('claude is unavailable'); },
  });
  assert.notEqual(s.signedIn, true);
  assert.notEqual(s.level, 'ok');
});

test('Health uses an authoritative supplied login state instead of contradicting Accounts', async () => {
  const account = { id: 'claude-secure', provider: 'claude', label: 'Secure', home: tmpHome() };
  const checks = await runChecks({
    accounts: [account],
    loginStates: { [account.id]: { signedIn: true, level: 'ok', detail: 'Signed in', verified: true } },
    env: envNone,
    fetchImpl: noFetch,
  });
  const credential = checks.find((check) => check.id === `cred-${account.id}`);
  assert.equal(credential.level, 'ok');
  assert.match(credential.title, /signed in/i);
});

test('Health names provider-routing overrides that bypass account folders', async () => {
  const env = {
    user: (name) => (name === 'CLAUDE_CODE_USE_BEDROCK' ? '1' : null),
    machine: () => null,
  };
  const checks = await runChecks({ env, fetchImpl: noFetch });
  const override = checks.find((check) => check.id === 'routing-override-CLAUDE_CODE_USE_BEDROCK');
  assert.equal(override.level, 'warn');
  assert.match(override.detail, /ignore the account folder/i);
  assert.equal(override.fix.args.name, 'CLAUDE_CODE_USE_BEDROCK');
});

test('an unknown provider is reported rather than assumed fine', () => {
  const s = accountLoginState({ provider: 'nope', home: tmpHome() });
  assert.equal(s.signedIn, false);
  assert.equal(s.level, 'warn');
});
