import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../test-support/tempdir.js';
import {
  readCopilotToken,
  parseCopilotUsage,
  fetchCopilotQuota,
  copilotAccountQuota,
  providerQuota,
} from '../core/quota.js';

test('readCopilotToken extracts token from env or custom home hosts.json', () => {
  const dir = tempDir('sb-copilot-');
  const hostsFile = path.join(dir, 'hosts.json');
  fs.writeFileSync(
    hostsFile,
    JSON.stringify({ 'github.com': { user: 'testuser', oauth_token: 'copilot-mock-token-1' } }),
    'utf8'
  );

  // From custom home
  const tokenFromHome = readCopilotToken(dir, {});
  assert.equal(tokenFromHome, 'copilot-mock-token-1');

  // From environment variable (takes precedence)
  const tokenFromEnv = readCopilotToken(dir, { COPILOT_TOKEN: 'copilot-env-token-2' });
  assert.equal(tokenFromEnv, 'copilot-env-token-2');

  // When neither is present
  const emptyDir = tempDir('sb-copilot-');
  assert.equal(readCopilotToken(emptyDir, {}), null);
});

test('parseCopilotUsage converts quota snapshots and reset date to windows', () => {
  const raw = {
    copilot_plan: 'individual',
    quota_reset_date: '2026-11-01T00:00:00Z',
    quota_snapshots: {
      premium_interactions: {
        percent_remaining: 85.0,
        unlimited: false,
      },
      chat: {
        percent_remaining: 90.0,
        unlimited: false,
      },
    },
  };

  const parsed = parseCopilotUsage(raw);
  assert.equal(parsed.vendor, 'GitHub');
  assert.equal(parsed.plan, 'Copilot Individual');
  assert.equal(parsed.source, 'token');
  assert.equal(parsed.windows.length, 2);

  const premium = parsed.windows.find((w) => w.key === 'session');
  assert.ok(premium);
  assert.equal(premium.label, 'Premium (monthly)');
  assert.equal(premium.usedPercent, 15);
  assert.equal(premium.resetsAt, Date.parse('2026-11-01T00:00:00Z'));

  const chat = parsed.windows.find((w) => w.key === 'week');
  assert.ok(chat);
  assert.equal(chat.label, 'Chat (monthly)');
  assert.equal(chat.usedPercent, 10);
});

test('fetchCopilotQuota sends standard editor headers and parses response', async () => {
  let capturedHeaders = null;
  const mockFetch = async (url, options) => {
    capturedHeaders = options.headers;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        copilot_plan: 'pro',
        quota_reset_date: '2026-12-01T00:00:00Z',
        quota_snapshots: {
          premium_interactions: { percent_remaining: 70.0 },
        },
      }),
    };
  };

  const res = await fetchCopilotQuota('test-mock-token', mockFetch);
  assert.equal(capturedHeaders['authorization'], 'token test-mock-token');
  assert.equal(capturedHeaders['editor-version'], 'vscode/1.96.2');
  assert.equal(capturedHeaders['x-github-api-version'], '2025-04-01');
  assert.equal(res.plan, 'Copilot Pro');
  assert.equal(res.windows[0].usedPercent, 30);
});

test('copilotAccountQuota handles auth errors, rate limits, and missing token', async () => {
  const dir = tempDir('sb-copilot-');
  const hostsFile = path.join(dir, 'hosts.json');
  fs.writeFileSync(
    hostsFile,
    JSON.stringify({ 'github.com': { oauth_token: 'copilot-test-token' } }),
    'utf8'
  );

  // Missing credentials
  const noAuthDir = tempDir('sb-copilot-');
  const noAuth = await copilotAccountQuota(noAuthDir, async () => {}, Date.now(), {});
  assert.deepEqual(noAuth, { error: 'no-credentials' });

  // 401 Unauthorized
  const authErr = await copilotAccountQuota(
    dir,
    async () => ({ ok: false, status: 401 }),
    Date.now(),
    {}
  );
  assert.deepEqual(authErr, { error: 'auth' });

  // 429 Rate limited
  const rateErr = await copilotAccountQuota(
    dir,
    async () => ({ ok: false, status: 429 }),
    Date.now(),
    {}
  );
  assert.deepEqual(rateErr, { error: 'rate-limited' });

  // Successful quota via providerQuota router
  const goodQuota = await providerQuota('copilot', dir, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        copilot_plan: 'business',
        quota_reset_date: '2026-11-01T00:00:00Z',
        quota_snapshots: {
          premium_interactions: { percent_remaining: 95.0 },
        },
      }),
    }),
  });
  assert.equal(goodQuota.plan, 'Copilot Business');
  assert.equal(goodQuota.windows[0].usedPercent, 5);
});
