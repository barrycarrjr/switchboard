import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../test-support/tempdir.js';
import { collectStatus, formatStatus } from '../core/status.js';
import { quotaCacheFile } from '../core/quota-cache.js';

const NOW = Date.parse('2026-08-19T22:00:00.000Z');

function tmp(name) {
  return tempDir(`sb-status-${name}-`);
}

// collectStatus shares what it reads in the usage cache the tray and the CLI use. These
// tests once wrote their invented accounts into a machine's real copy of that file, so
// each hands collectStatus a scratch one of its own.
function scratchCache() {
  return path.join(tmp('cache'), 'quota-cache.json');
}

function claudeAccount(label, id) {
  const home = tmp(id);
  fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: `tok-${id}`, refreshTokenExpiresAt: NOW + 60 * 24 * 60 * 60 * 1000 },
  }));
  return { id, provider: 'claude', label, home };
}


const NO_SINGLE_SIGN_IN = {
  presenceFn: async () => [],
  antigravityFn: async () => null,
  installedFn: async () => [],
};

function usageFetch(byToken) {
  return async (_url, init) => {
    const token = init.headers.authorization.replace('Bearer ', '');
    return { ok: true, json: async () => byToken[token] };
  };
}

test('collectStatus reports every provider, marks the active account, and attaches usage', async () => {
  const main = claudeAccount('Primary', 'claude-primary');
  const spare = claudeAccount('Secondary', 'claude-secondary');
  const registry = { accounts: [main, spare] };
  const status = await collectStatus({
    registry,
    envReader: (name) => (name === 'CLAUDE_CONFIG_DIR' ? spare.home : null),
    fetchImpl: usageFetch({
      // utilization is a percentage: 12 means twelve percent. See core/quota.js.
      'tok-claude-primary': { five_hour: { utilization: 12 } },
      'tok-claude-secondary': { five_hour: { utilization: 99 }, seven_day: { utilization: 100 } },
    }),
    now: NOW,
    quotaCacheFile: scratchCache(),
    ...NO_SINGLE_SIGN_IN,
  });

  const claude = status.providers.find((p) => p.id === 'claude');
  assert.equal(claude.envValue, spare.home);
  assert.equal(claude.activeAccountId, 'claude-secondary');
  assert.deepEqual(claude.accounts.map((a) => a.active), [false, true]);
  assert.equal(claude.accounts[0].quota.windows[0].usedPercent, 12);
  assert.equal(claude.accounts[0].login.signedIn, true);

  // Every registered tool appears, whether or not it has accounts or usage.
  assert.deepEqual(status.providers.map((p) => p.id), ['claude', 'codex', 'gemini', 'qwen']);
  const gemini = status.providers.find((p) => p.id === 'gemini');
  assert.equal(gemini.hasQuota, false);
  assert.match(gemini.quotaNote, /no usage endpoint/i);
});

test('an account that is not signed in is never asked for usage', async () => {
  const home = tmp('cold');
  let called = false;
  const status = await collectStatus({
    registry: { accounts: [{ id: 'claude-cold', provider: 'claude', label: 'Cold', home }] },
    envReader: () => null,
    fetchImpl: async () => { called = true; return { ok: true, json: async () => ({}) }; },
    now: NOW,
    quotaCacheFile: scratchCache(),
    ...NO_SINGLE_SIGN_IN,
  });
  const account = status.providers[0].accounts[0];
  assert.equal(called, false);
  assert.equal(account.quota, null);
  assert.equal(account.login.signedIn, false);
});

test('collectStatus shares its readings in the cache file it is given, never the app\'s own', async () => {
  const account = claudeAccount('Primary', 'claude-cache-check');
  const file = scratchCache();
  await collectStatus({
    registry: { accounts: [account] },
    envReader: () => null,
    fetchImpl: usageFetch({ 'tok-claude-cache-check': { five_hour: { utilization: 5 } } }),
    now: NOW,
    quotaCacheFile: file,
    ...NO_SINGLE_SIGN_IN,
  });
  const shared = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(shared['claude-cache-check'].result.windows[0].usedPercent, 5, 'the reading landed in the scratch file');
  let appOwn = {};
  try { appOwn = JSON.parse(fs.readFileSync(quotaCacheFile(), 'utf8')); } catch { /* no file at all is the best answer */ }
  assert.equal(appOwn['claude-cache-check'], undefined, 'and not in the file the app itself reads');
});

test('formatStatus shows the numbers, the source, and when it was true', () => {
  const text = formatStatus({
    generatedAt: NOW,
    providers: [
      {
        id: 'claude', name: 'Claude Code', envVar: 'CLAUDE_CONFIG_DIR', envValue: 'X:\\home\\.claude',
        activeHome: 'X:\\home\\.claude', activeHomeExists: true, activeAccountId: 'a1', hasQuota: true, quotaNote: null,
        accounts: [{
          id: 'a1', label: 'Primary', home: 'X:\\home\\.claude', active: true,
          login: { signedIn: true, level: 'ok', detail: 'Signed in' },
          quota: { source: 'token', windows: [{ key: 'week', label: 'Week', usedPercent: 94, resetsAt: NOW + 3600_000 }] },
        }],
      },
      {
        id: 'codex', name: 'Codex', envVar: 'CODEX_HOME', envValue: null,
        activeHome: 'X:\\home\\.codex', activeHomeExists: true, activeAccountId: 'c1', hasQuota: true, quotaNote: null,
        accounts: [{
          id: 'c1', label: 'Default', home: 'X:\\home\\.codex', active: true,
          login: { signedIn: true, level: 'ok', detail: 'Signed in' },
          quota: { source: 'session-log', plan: 'plus', sampledAt: NOW - 2 * 3600_000, stale: false, windows: [{ key: 'week', label: 'Week', usedPercent: 6, resetsAt: null }] },
        }],
      },
      {
        id: 'qwen', name: 'Qwen Code', envVar: 'QWEN_HOME', envValue: null,
        activeHome: 'X:\\home\\.qwen', activeHomeExists: false, activeAccountId: null, hasQuota: false,
        quotaNote: 'Qwen publishes no usage endpoint.', accounts: [],
      },
    ],
  });

  assert.match(text, /CLAUDE_CONFIG_DIR=X:\\home\\\.claude/);
  assert.match(text, /CODEX_HOME=\(unset\)/);
  assert.match(text, /\* Primary/);
  assert.match(text, /Week {14}\[#{19}\.\] {2}94%/);          // a bar a person can read at a glance
  assert.match(text, /from this account's last session, 2 hours ago/);
  assert.match(text, /plan: plus/);
  assert.match(text, /not set up on this machine \(no X:\\home\\\.qwen\)/);
});

test('formatStatus says when a last known reading was taken, and that the newer check failed', () => {
  const text = formatStatus({
    generatedAt: NOW,
    providers: [{
      id: 'claude', name: 'Claude Code', envVar: 'CLAUDE_CONFIG_DIR', envValue: 'X:\\home\\.claude',
      activeHome: 'X:\\home\\.claude', activeHomeExists: true, activeAccountId: 'a1', hasQuota: true, quotaNote: null,
      accounts: [{
        id: 'a1', label: 'Primary', home: 'X:\\home\\.claude', active: true,
        login: { signedIn: true, level: 'ok', detail: 'Signed in' },
        quota: {
          source: 'token', cached: true, observedAt: NOW - 12 * 60_000, refreshError: 'rate-limited',
          windows: [{ key: 'week', label: 'Week', usedPercent: 0, resetsAt: NOW + 3600_000 }],
        },
      }],
    }],
  });
  assert.match(text, /last checked 12 min ago, a newer check was rate-limited/);
});

test('formatStatus names an unreadable window instead of printing a zero', () => {
  const provider = (error) => ({
    generatedAt: NOW,
    providers: [{
      id: 'claude', name: 'Claude Code', envVar: 'CLAUDE_CONFIG_DIR', envValue: null,
      activeHome: 'X:\\other', activeHomeExists: true, activeAccountId: null, hasQuota: true, quotaNote: null,
      accounts: [{
        id: 'a1', label: 'Primary', home: 'X:\\home\\.claude', active: false,
        login: { signedIn: true, level: 'ok', detail: 'Signed in' },
        quota: { error },
      }],
    }],
  });
  assert.match(formatStatus(provider('auth')), /needs a refresh/);
  assert.match(formatStatus(provider('no-usage-data')), /No usage recorded yet|no usage recorded yet/);
  assert.match(formatStatus(provider('anything-new')), /usage unavailable right now/);
  // An active folder nobody registered is the thing most worth saying out loud.
  assert.match(formatStatus(provider('auth')), /the active folder is not registered: X:\\other/);
});


test('collectStatus includes single-sign-in providers and Antigravity live usage', async () => {
  const status = await collectStatus({
    registry: { accounts: [] },
    envReader: () => null,
    now: NOW,
    quotaCacheFile: scratchCache(),
    antigravityFn: async () => ({
      cliInstalled: true,
      appInstalled: true,
      signedIn: true,
      who: 'testuser',
      plan: 'Pro',
    }),
    antigravityQuotaFn: async () => ({
      windows: [
        { key: 'gemini-weekly', label: 'Gemini (Week)', usedPercent: 15, resetsAt: NOW + 86400_000 },
      ],
      source: 'cli',
      vendor: 'Google Antigravity',
      plan: 'Pro',
    }),
    presenceFn: async () => [
      { id: 'copilot', name: 'Copilot CLI', signedIn: true, who: 'testuser', note: 'Signs in with GitHub' },
      { id: 'junie', name: 'Junie', signedIn: true, who: null, note: 'Runs on JetBrains AI credits' },
    ],
    installedFn: async () => [],
  });

  const ag = status.providers.find((p) => p.id === 'antigravity');
  assert.ok(ag);
  assert.equal(ag.accounts[0].login.signedIn, true);
  assert.equal(ag.accounts[0].quota.windows[0].usedPercent, 15);
  assert.equal(ag.accounts[0].quota.plan, 'Pro');

  const copilot = status.providers.find((p) => p.id === 'copilot');
  assert.ok(copilot);
  assert.equal(copilot.accounts[0].label, 'Copilot CLI (testuser)');
  assert.equal(copilot.accounts[0].login.signedIn, true);

  const junie = status.providers.find((p) => p.id === 'junie');
  assert.ok(junie);
  assert.equal(junie.accounts[0].login.signedIn, true);

  assert.equal(status.alsoSignedIn.length, 3);
  assert.equal(status.alsoSignedIn[0].name, 'Antigravity');
  assert.equal(status.alsoSignedIn[0].quota.windows[0].usedPercent, 15);
});

test('formatStatus formats single-sign-in providers cleanly', () => {
  const text = formatStatus({
    generatedAt: NOW,
    providers: [
      {
        id: 'antigravity', name: 'Antigravity', envVar: null, envValue: null,
        activeHome: 'X:\\\\home\\\\.gemini', activeHomeExists: true, activeAccountId: 'antigravity',
        hasQuota: true, quotaNote: null, singleSignIn: true,
        accounts: [{
          id: 'antigravity', label: 'Antigravity (testuser, Pro)', home: 'X:\\\\home\\\\.gemini', active: true,
          login: { signedIn: true, level: 'ok', detail: 'Signed in (Pro)' },
          quota: {
            source: 'cli', plan: 'Pro', windows: [
              { key: 'gemini-weekly', label: 'Gemini (Week)', usedPercent: 15, resetsAt: NOW + 3600_000 },
            ],
          },
        }],
      },
    ],
  });

  assert.match(text, /^Antigravity$/m);
  assert.match(text, /\* Antigravity \(testuser, Pro\)/);
  assert.match(text, /Signed in \(Pro\)/);
  assert.match(text, /Gemini \(Week\)/);
  assert.match(text, /15%/);
});
