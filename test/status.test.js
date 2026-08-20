import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectStatus, formatStatus } from '../core/status.js';

const NOW = Date.parse('2026-08-19T22:00:00.000Z');

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sb-status-${name}-`));
}

function claudeAccount(label, id) {
  const home = tmp(id);
  fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: `tok-${id}`, refreshTokenExpiresAt: NOW + 60 * 24 * 60 * 60 * 1000 },
  }));
  return { id, provider: 'claude', label, home };
}

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
      'tok-claude-primary': { five_hour: { utilization: 0.12 } },
      'tok-claude-secondary': { five_hour: { utilization: 0.99 }, seven_day: { utilization: 1 } },
    }),
    now: NOW,
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
  });
  const account = status.providers[0].accounts[0];
  assert.equal(called, false);
  assert.equal(account.quota, null);
  assert.equal(account.login.signedIn, false);
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
