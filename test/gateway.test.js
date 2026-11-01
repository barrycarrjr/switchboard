import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../test-support/tempdir.js';
import { createGatewayKey } from '../core/gateway-keys.js';
import { createGatewayServer, parseWslDistroList, provisionLocalAndWslClient } from '../core/gateway.js';

const SETUP_PREFIX = ['sk', 'ant', 'oat01'].join('-') + '-';

function makeFixture() {
  const dir = tempDir('sb-gw-');
  const homeA = path.join(dir, 'claude-a');
  const homeB = path.join(dir, 'claude-b');
  const homeCodex = path.join(dir, 'codex-1');
  fs.mkdirSync(homeA, { recursive: true });
  fs.mkdirSync(homeB, { recursive: true });
  fs.mkdirSync(homeCodex, { recursive: true });

  // Signed-in Claude Account A
  fs.writeFileSync(path.join(homeA, '.credentials.json'), JSON.stringify({
    claudeAiOauth: {
      accessToken: 'folder-access-a',
      refreshToken: 'folder-refresh-a',
      expiresAt: Date.now() + 3600_000,
      refreshTokenExpiresAt: Date.now() + 30 * 86400_000,
    },
  }));
  fs.writeFileSync(path.join(homeA, '.claude.json'), JSON.stringify({
    oauthAccount: { organizationUuid: 'org-uuid-a', accountUuid: 'acc-uuid-a' },
  }));

  // Signed-in Claude Account B
  fs.writeFileSync(path.join(homeB, '.credentials.json'), JSON.stringify({
    claudeAiOauth: {
      accessToken: 'folder-access-b',
      refreshToken: 'folder-refresh-b',
      expiresAt: Date.now() + 3600_000,
      refreshTokenExpiresAt: Date.now() + 30 * 86400_000,
    },
  }));
  fs.writeFileSync(path.join(homeB, '.claude.json'), JSON.stringify({
    oauthAccount: { organizationUuid: 'org-uuid-b', accountUuid: 'acc-uuid-b' },
  }));

  // Signed-in Codex Account
  fs.writeFileSync(path.join(homeCodex, 'auth.json'), JSON.stringify({
    tokens: { access_token: 'codex-oauth-token', refresh_token: 'codex-refresh-secret', account_id: 'chatgpt-acc-1' },
  }));

  const registry = {
    accounts: [
      { id: 'claude-a', provider: 'claude', label: 'Max Account A', home: homeA, color: '#2563eb' },
      { id: 'claude-b', provider: 'claude', label: 'Max Account B', home: homeB, color: '#10a37f' },
      { id: 'codex-main', provider: 'codex', label: 'Codex Team', home: homeCodex, color: '#7c3aed' },
    ],
  };

  const now = 1762000000000;
  const tokenA = SETUP_PREFIX + 'testtokenA1234567890';
  const tokenB = SETUP_PREFIX + 'testtokenB0987654321';

  let settings = {
    quotaWatch: 'off',
    gateway: { enabled: true, port: 0, scope: 'localhost-wsl' },
    gatewayKeys: {},
    lanes: [
      { id: 'lane-claude-1', harness: 'claude', provider: 'anthropic', accountId: 'claude-a', billing: 'subscription' },
      { id: 'lane-claude-2', harness: 'claude', provider: 'anthropic', accountId: 'claude-b', billing: 'subscription' },
      { id: 'lane-codex-1', harness: 'codex', provider: 'openai', accountId: 'codex-main', billing: 'subscription' },
    ],
    laneTokens: {
      'lane-claude-1': {
        token: tokenA,
        accountId: 'claude-a',
        mintedAt: now - 1000,
        organizationUuid: 'org-uuid-a',
        accountUuid: 'acc-uuid-a',
      },
      'lane-claude-2': {
        token: tokenB,
        accountId: 'claude-b',
        mintedAt: now - 1000,
        organizationUuid: 'org-uuid-b',
        accountUuid: 'acc-uuid-b',
      },
    },
    cooldowns: {},
    spendPolicies: {},
  };

  const keyCreated = createGatewayKey(settings, { label: 'Ubuntu Worker', scope: 'localhost-wsl', now });
  settings = keyCreated.settings;

  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      limits: [
        { kind: 'session', percent: 28, resets_at: Math.floor((now + 3600_000) / 1000) },
        { kind: 'weekly_all', percent: 36, resets_at: Math.floor((now + 86400_000) / 1000) },
      ],
    }),
  });

  return {
    dir,
    now,
    tokenA,
    tokenB,
    clientSecret: keyCreated.secret,
    getSettings: () => settings,
    setSettings: (next) => { settings = next; },
    getRegistry: () => registry,
    mockFetch,
  };
}

test('broker serves /v1/info, /v1/lease, and /v1/lease/report with lane failover and never logs tokens', async () => {
  const fx = makeFixture();
  const broker = createGatewayServer({
    getSettings: fx.getSettings,
    setSettings: fx.setSettings,
    getRegistry: fx.getRegistry,
    fetchImpl: fx.mockFetch,
    nowFn: () => fx.now,
  });

  const started = await broker.start({ port: 0, scope: 'localhost' });
  const baseUrl = `http://127.0.0.1:${started.port}`;

  try {
    // 1. /v1/info without key returns 401
    const unauthInfo = await fetch(`${baseUrl}/v1/info`);
    assert.equal(unauthInfo.status, 401);

    // 2. Browser Origin header is rejected with 403 even with valid key
    const browserReq = await fetch(`${baseUrl}/v1/info`, {
      headers: { authorization: `Bearer ${fx.clientSecret}`, origin: 'http://evil.example' },
    });
    assert.equal(browserReq.status, 403);

    // 3. /v1/info with valid key returns 200 and contract 1
    const infoRes = await fetch(`${baseUrl}/v1/info`, {
      headers: { authorization: `Bearer ${fx.clientSecret}` },
    });
    assert.equal(infoRes.status, 200);
    const infoBody = await infoRes.json();
    assert.equal(infoBody.ok, true);
    assert.equal(infoBody.contract, 1);
    assert.ok(infoBody.addresses.localhost.includes(String(started.port)));

    // 4. POST /v1/lease returns lane-claude-1 setup-token, headroom, and candidatesRemaining
    const lease1Res = await fetch(`${baseUrl}/v1/lease`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fx.clientSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ provider: 'claude', harness: 'claude' }),
    });
    assert.equal(lease1Res.status, 200);
    const lease1 = await lease1Res.json();
    assert.equal(lease1.ok, true);
    assert.equal(lease1.contract, 1);
    assert.equal(lease1.laneId, 'lane-claude-1');
    assert.equal(lease1.accountId, 'claude-a');
    assert.equal(lease1.binary, 'claude');
    assert.equal(lease1.env.CLAUDE_CODE_OAUTH_TOKEN, fx.tokenA);
    assert.equal(lease1.candidatesRemaining, 1);
    assert.equal(typeof lease1.headroom.session, 'number');
    assert.equal(typeof lease1.headroom.weekly, 'number');

    // 5. POST /v1/lease/report with outcome 'error' does NOT cool down lane-claude-1
    const errReportRes = await fetch(`${baseUrl}/v1/lease/report`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fx.clientSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        leaseId: lease1.leaseId,
        laneId: 'lane-claude-1',
        outcome: 'error',
        exitCode: 3,
      }),
    });
    assert.equal(errReportRes.status, 200);
    assert.equal(fx.getSettings().cooldowns['lane-claude-1'], undefined);

    // 6. POST /v1/lease/report with outcome 'rate-limited' and resetsAt cools down lane-claude-1
    const futureResetSec = Math.floor((fx.now + 7200_000) / 1000);
    const rlReportRes = await fetch(`${baseUrl}/v1/lease/report`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fx.clientSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        leaseId: lease1.leaseId,
        laneId: 'lane-claude-1',
        outcome: 'rate-limited',
        rateLimitType: 'seven_day',
        resetsAt: futureResetSec,
        exitCode: 1,
      }),
    });
    assert.equal(rlReportRes.status, 200);
    assert.equal(fx.getSettings().cooldowns['lane-claude-1'], futureResetSec * 1000);

    // 7. Next POST /v1/lease automatically fails over to lane-claude-2
    const lease2Res = await fetch(`${baseUrl}/v1/lease`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fx.clientSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ provider: 'claude', harness: 'claude' }),
    });
    assert.equal(lease2Res.status, 200);
    const lease2 = await lease2Res.json();
    assert.equal(lease2.laneId, 'lane-claude-2');
    assert.equal(lease2.env.CLAUDE_CODE_OAUTH_TOKEN, fx.tokenB);
    assert.equal(lease2.candidatesRemaining, 0);

    // 8. Reporting auth-failed on lane-claude-2 marks its token dead, and next lease returns 503
    const authFailRes = await fetch(`${baseUrl}/v1/lease/report`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fx.clientSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        leaseId: lease2.leaseId,
        laneId: 'lane-claude-2',
        outcome: 'auth-failed',
      }),
    });
    assert.equal(authFailRes.status, 200);
    assert.equal(fx.getSettings().laneTokens['lane-claude-2'].dead, true);

    const lease3Res = await fetch(`${baseUrl}/v1/lease`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fx.clientSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ provider: 'claude', harness: 'claude' }),
    });
    assert.equal(lease3Res.status, 503);
    const lease3 = await lease3Res.json();
    assert.equal(lease3.ok, false);
    assert.equal(typeof lease3.retryAfterSeconds, 'number');

    // 9. Codex subscription lease returns identity and codexHomeName without copying auth.json tokens
    const codexLeaseRes = await fetch(`${baseUrl}/v1/lease`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fx.clientSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ provider: 'codex' }),
    });
    assert.equal(codexLeaseRes.status, 200);
    const codexLease = await codexLeaseRes.json();
    assert.equal(codexLease.laneId, 'lane-codex-1');
    assert.equal(codexLease.binary, 'codex');
    assert.equal(codexLease.codexHomeName, 'codex-1');
    assert.deepEqual(codexLease.env, {});
    assert.ok(!JSON.stringify(codexLease).includes('codex-refresh-secret'));

    // 10. Event log never contains setup tokens or client secrets
    const eventsText = JSON.stringify(broker.events());
    assert.ok(!eventsText.includes(fx.tokenA));
    assert.ok(!eventsText.includes(fx.tokenB));
    assert.ok(!eventsText.includes(fx.clientSecret));
  } finally {
    await broker.stop();
  }
});

test('broker serves read-only T3 Hub /v0/management/* endpoints from local cache without leaking tokens', async () => {
  const fx = makeFixture();
  const broker = createGatewayServer({
    getSettings: fx.getSettings,
    setSettings: fx.setSettings,
    getRegistry: fx.getRegistry,
    fetchImpl: fx.mockFetch,
    nowFn: () => fx.now,
  });

  const started = await broker.start({ port: 0, scope: 'localhost' });
  const baseUrl = `http://127.0.0.1:${started.port}`;

  try {
    // 1. GET /v0/management/auth-files lists Claude and Codex accounts without secrets
    const filesRes = await fetch(`${baseUrl}/v0/management/auth-files`, {
      headers: { authorization: `Bearer ${fx.clientSecret}` },
    });
    assert.equal(filesRes.status, 200);
    const filesBody = await filesRes.json();
    assert.equal(Array.isArray(filesBody.files), true);
    assert.equal(filesBody.files.length, 3);
    assert.equal(filesBody.files[0].id, 'claude-a');
    assert.equal(filesBody.files[0].auth_index, 'claude-a');
    assert.equal(filesBody.files[0].provider, 'claude');
    assert.equal(filesBody.files[0].disabled, false);
    assert.ok(!JSON.stringify(filesBody).includes(fx.tokenA));
    assert.ok(!JSON.stringify(filesBody).includes('codex-refresh-secret'));

    // 2. POST /v0/management/api-call returns Claude usage in T3 Hub schema
    const claudeUsageRes = await fetch(`${baseUrl}/v0/management/api-call`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fx.clientSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        auth_index: 'claude-a',
        method: 'GET',
        url: 'https://api.anthropic.com/api/oauth/usage',
        header: {},
      }),
    });
    assert.equal(claudeUsageRes.status, 200);
    const claudeApiPayload = await claudeUsageRes.json();
    assert.equal(claudeApiPayload.status_code, 200);
    const claudeParsed = JSON.parse(claudeApiPayload.body);
    assert.equal(claudeParsed.five_hour.utilization, 28);
    assert.equal(claudeParsed.seven_day.utilization, 36);

    // 3. POST /v0/management/api-call returns Codex usage and credits in T3 Hub schema
    const codexUsageRes = await fetch(`${baseUrl}/v0/management/api-call`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fx.clientSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        auth_index: 'codex-main',
        method: 'GET',
        url: 'https://chatgpt.com/backend-api/wham/usage',
        header: {},
      }),
    });
    assert.equal(codexUsageRes.status, 200);
    const codexApiPayload = await codexUsageRes.json();
    assert.equal(codexApiPayload.status_code, 200);
    const codexParsed = JSON.parse(codexApiPayload.body);
    assert.equal(typeof codexParsed.plan_type, 'string');
    assert.ok('rate_limit' in codexParsed);

    const creditsRes = await fetch(`${baseUrl}/v0/management/api-call`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fx.clientSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        auth_index: 'codex-main',
        method: 'GET',
        url: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
        header: {},
      }),
    });
    assert.equal(creditsRes.status, 200);
    const creditsPayload = await creditsRes.json();
    assert.deepEqual(JSON.parse(creditsPayload.body), { credits: [] });

    // 4. POST /v0/management/reset-quota clears cooldown on matching account lanes
    fx.setSettings({
      ...fx.getSettings(),
      cooldowns: { 'lane-claude-1': fx.now + 60_000 },
    });
    const resetRes = await fetch(`${baseUrl}/v0/management/reset-quota`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fx.clientSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ auth_index: 'claude-a' }),
    });
    assert.equal(resetRes.status, 200);
    const resetBody = await resetRes.json();
    assert.equal(resetBody.ok, true);
    assert.equal(resetBody.cleared, 1);
    assert.equal(fx.getSettings().cooldowns['lane-claude-1'], undefined);
  } finally {
    await broker.stop();
  }
});

test('provisionLocalAndWslClient writes local client-key and pipes key + wrapper to WSL distros without exposing secrets on argv', async () => {
  const dir = tempDir('sb-gw-');
  const fakeScript = path.join(dir, 'switchboard-lease');
  fs.writeFileSync(fakeScript, '#!/usr/bin/env bash\necho ok\n', 'utf8');

  const utf16List = Buffer.from('Ubuntu\r\ndocker-desktop\r\nDebian\r\n', 'utf16le');
  assert.deepEqual(parseWslDistroList(utf16List), ['Ubuntu', 'Debian']);

  const calls = [];
  const fakeSpawn = (file, args) => {
    const stdinChunks = [];
    const handlers = {};
    const stdoutHandlers = [];
    const child = {
      stdin: {
        write: (c) => stdinChunks.push(Buffer.from(c)),
        end: () => {
          const stdinText = Buffer.concat(stdinChunks).toString('utf8');
          calls.push({ file, args, stdinText });
          setImmediate(() => {
            if (args.includes('--list')) {
              for (const fn of stdoutHandlers) fn(utf16List);
            } else if (args.join(' ').includes('printf')) {
              for (const fn of stdoutHandlers) fn(Buffer.from('/home/testuser/.local/bin/switchboard-lease', 'utf8'));
            }
            handlers.close?.(0);
          });
        },
      },
      stdout: { on: (ev, fn) => { if (ev === 'data') stdoutHandlers.push(fn); } },
      stderr: { on: () => {} },
      on: (ev, fn) => { handlers[ev] = fn; },
      kill: () => {},
    };
    return child;
  };

  const secret = 'sb-key-0123456789abcdef0123456789abcdef01234567';
  const res = await provisionLocalAndWslClient({
    token: secret,
    leaseScriptPath: fakeScript,
    homeDir: dir,
    platform: 'win32',
    spawnImpl: fakeSpawn,
  });

  assert.equal(res.ok, true);
  assert.deepEqual(res.wslDistros, ['Ubuntu', 'Debian']);
  assert.equal(res.wslBinaryPath, '/home/testuser/.local/bin/switchboard-lease');
  assert.equal(fs.readFileSync(res.localKeyPath, 'utf8'), secret + '\n');

  // Verify the secret never appeared in any spawned command arguments
  for (const call of calls) {
    assert.ok(!call.args.join(' ').includes(secret));
  }
});
