import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../test-support/tempdir.js';
import { createGatewayKey } from '../core/gateway-keys.js';
import { applyLeaseReport, createGatewayServer, parseWslDistroList, provisionLocalAndWslClient, parseWrapperInstallOutput, wrapperInstallScript, syncWslLeaseWrapper, createSettingsWatcher } from '../core/gateway.js';
import { writeSharedQuota } from '../core/quota-cache.js';
import { loadSettings, saveSettings } from '../core/settings.js';

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

// ---- A cooldown the meter has overtaken ----
//
// A limit report holds a lane until the reset time the vendor stated. Seen 2026-11-24: an
// account refused two days earlier had been handed its whole week back by the vendor, its
// reading said 0% used, and the broker went on answering "no healthy lane" for it with
// two days of the hold still to run, so T3 Code showed its provider as broken. A reading
// taken after the report may end the hold now, when it shows the limit that was hit has
// room again (cooldownEnd in core/lanes.js). The report is what makes that possible: it
// has to keep the moment it arrived.

test('a limit report with a stated reset records when the hold began, and no other hold does', () => {
  const settings = {
    lanes: [{ id: 'lane-1', harness: 'claude', provider: 'anthropic', accountId: 'a1', billing: 'subscription' }],
    cooldowns: {},
    laneTokens: {},
  };
  // A real clock time: a reset small enough to be a count of seconds is read as one.
  const now = 1762000000000;
  const reset = now + 3_600_000;

  const limited = applyLeaseReport(settings, { laneId: 'lane-1', outcome: 'rate-limited', resetsAt: reset }, now);
  assert.equal(limited.settings.cooldowns['lane-1'], reset);
  assert.equal(limited.settings.cooldownSince['lane-1'], now);
  assert.equal(applyLeaseReport(settings, { laneId: 'lane-1', outcome: 'exhausted', resetsAt: reset }, now).settings.cooldownSince['lane-1'], now);

  // With no reset stated there is nothing to match a meter against: the hold is the short
  // failover one, and the time of an earlier limit is not left behind to vouch for it.
  const later = now + 10;
  for (const report of [
    { laneId: 'lane-1', outcome: 'rate-limited' },
    { laneId: 'lane-1', outcome: 'rate-limited', resetsAt: now - 1 },
    { laneId: 'lane-1', outcome: 'auth-failed' },
  ]) {
    const held = applyLeaseReport(limited.settings, report, later);
    assert.equal(held.action, 'cooldown', JSON.stringify(report));
    assert.ok(held.settings.cooldowns['lane-1'] > later && held.settings.cooldowns['lane-1'] < reset, JSON.stringify(report));
    assert.equal(held.settings.cooldownSince['lane-1'], undefined, JSON.stringify(report));
  }

  // A run that went fine, or merely crashed, changes nothing at all.
  assert.equal(applyLeaseReport(limited.settings, { laneId: 'lane-1', outcome: 'ok' }, later).settings, limited.settings);
  assert.equal(applyLeaseReport(limited.settings, { laneId: 'lane-1', outcome: 'error' }, later).settings, limited.settings);
});

test('the time a limit report held a lane is kept across a save, and settings from before it load with none', () => {
  const file = path.join(tempDir('sb-gw-'), 'settings.json');
  assert.deepEqual(loadSettings(file).cooldownSince, {}, 'nothing saved yet');

  fs.writeFileSync(file, JSON.stringify({ lanes: [], cooldowns: { 'lane-1': 2_000 } }));
  const older = loadSettings(file);
  assert.deepEqual(older.cooldowns, { 'lane-1': 2_000 });
  assert.deepEqual(older.cooldownSince, {}, 'a hold an older version wrote has no start, so it runs its course');

  saveSettings({ ...older, cooldownSince: { 'lane-1': 1_000 } }, file);
  assert.deepEqual(loadSettings(file).cooldownSince, { 'lane-1': 1_000 });

  for (const broken of [null, 'yes', [1]]) {
    fs.writeFileSync(file, JSON.stringify({ cooldownSince: broken }));
    assert.deepEqual(loadSettings(file).cooldownSince, {}, `${JSON.stringify(broken)} is not a map of lanes`);
  }
});

test('the broker lends a lane again once a reading taken after its cooldown shows the limit lifted', async () => {
  // The broker takes each account's usage from the shared cache under dataDir(), so that
  // is pointed at a folder of this test's own and every reading below is put there by hand.
  const prevAppData = process.env.APPDATA;
  process.env.APPDATA = tempDir('sb-gw-');
  const fx = makeFixture();
  let clock = fx.now;
  const broker = createGatewayServer({
    getSettings: fx.getSettings,
    setSettings: fx.setSettings,
    getRegistry: fx.getRegistry,
    fetchImpl: fx.mockFetch,
    nowFn: () => clock,
  });
  const started = await broker.start({ port: 0, scope: 'localhost' });
  const baseUrl = `http://127.0.0.1:${started.port}`;
  const post = (route, body) => fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${fx.clientSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const leaseA = () => post('/v1/lease', { provider: 'claude', harness: 'claude', account: 'claude-a' });

  // The week both meters belong to, as the vendor states it: to the second in a refusal,
  // to the millisecond in a usage reading.
  const weekResetSec = Math.floor((fx.now + 4 * 86400_000) / 1000);
  const reading = (week, opus, takenAt) => writeSharedQuota('claude-a', 'k', {
    windows: [
      { key: 'week', label: 'Week (all models)', usedPercent: week, resetsAt: weekResetSec * 1000 - 211 },
      { key: 'week_opus', label: 'Week (Opus)', usedPercent: opus, resetsAt: weekResetSec * 1000 },
    ],
    source: 'token',
    vendor: 'Anthropic',
    organizationUuid: 'org-uuid-a',
  }, takenAt);

  try {
    // 1. The week as a whole has room, so the lane is lent, and the run is refused on the
    //    per-model meter, which is not one that keeps an account out of the running.
    reading(88, 99, clock - 60_000);
    const first = await leaseA();
    assert.equal(first.status, 200);
    const lease = await first.json();
    assert.equal(lease.laneId, 'lane-claude-1');

    const report = await post('/v1/lease/report', {
      leaseId: lease.leaseId,
      laneId: 'lane-claude-1',
      outcome: 'rate-limited',
      rateLimitType: 'seven_day_opus',
      resetsAt: weekResetSec,
      exitCode: 1,
    });
    assert.equal(report.status, 200);
    assert.equal(fx.getSettings().cooldowns['lane-claude-1'], weekResetSec * 1000);
    assert.equal(fx.getSettings().cooldownSince['lane-claude-1'], fx.now, 'the report keeps the moment it arrived');

    // 2. The reading on hand was taken before the refusal, and says nothing about after it.
    clock = fx.now + 1_000;
    const held = await leaseA();
    assert.equal(held.status, 503);
    const heldBody = await held.json();
    assert.equal(heldBody.reason, 'no-healthy-lane');
    assert.equal(heldBody.resetsAt, new Date(weekResetSec * 1000).toISOString());

    // 3. A reading taken after it shows the meter that refused the run still full.
    clock = fx.now + 6 * 60_000;
    reading(89, 100, clock - 60_000);
    assert.equal((await leaseA()).status, 503, 'the limit is still in force');

    // 4. Two days on the vendor has given the week back. The reset time has not moved.
    clock = fx.now + 2 * 86400_000;
    reading(0, 0, clock - 60_000);
    const again = await leaseA();
    assert.equal(again.status, 200, 'two days short of the reset time it was held until');
    const lent = await again.json();
    assert.equal(lent.laneId, 'lane-claude-1');
    assert.equal(lent.env.CLAUDE_CODE_OAUTH_TOKEN, fx.tokenA);
    assert.equal(lent.headroom.weekly, 100);
    assert.equal(fx.getSettings().cooldowns['lane-claude-1'], weekResetSec * 1000, 'judging the hold lifted rewrites nothing');

    // 5. The hold is only set aside while the meter says so. If that meter fills up again,
    //    the lane is held again with no new report needed.
    clock += 3_600_000;
    reading(40, 100, clock - 60_000);
    assert.equal((await leaseA()).status, 503, 'the same limit, back in force');

    // 6. Clearing the cooldown by hand takes the time it was placed with it.
    const reset = await post('/v0/management/reset-quota', { auth_index: 'claude-a' });
    assert.equal((await reset.json()).cleared, 1);
    assert.equal(fx.getSettings().cooldowns['lane-claude-1'], undefined);
    assert.equal(fx.getSettings().cooldownSince['lane-claude-1'], undefined);
    assert.equal((await leaseA()).status, 200, 'and the lane is judged on its meters alone');
  } finally {
    await broker.stop();
    process.env.APPDATA = prevAppData;
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
            } else if (args.join(' ').includes('switchboard-lease')) {
              for (const fn of stdoutHandlers) fn(Buffer.from('installed /home/testuser/.local/bin/switchboard-lease', 'utf8'));
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
  assert.deepEqual(res.distros, [
    { name: 'Ubuntu', key: 'written', wrapper: 'installed', path: '/home/testuser/.local/bin/switchboard-lease', target: null },
    { name: 'Debian', key: 'written', wrapper: 'installed', path: '/home/testuser/.local/bin/switchboard-lease', target: null },
  ]);
  // --exec: wsl.exe hands the script to bash as given. After `--` the distro's shell
  // reads the quotes and `$` a second time and a quoted script dies on them.
  for (const call of calls.filter((c) => c.args[0] === '-d')) {
    assert.equal(call.args[2], '--exec');
    assert.ok(!call.args.includes('--'));
  }

  // Verify the secret never appeared in any spawned command arguments
  for (const call of calls) {
    assert.ok(!call.args.join(' ').includes(secret));
  }
});

// The fake wsl.exe for the wrapper tests: answers the distro list, accepts the key file,
// and answers the wrapper script per distro with what the real script prints.
function fakeWslSpawn({ distros, wrapperAnswers, calls }) {
  const list = Buffer.from(distros.join('\r\n') + '\r\n', 'utf16le');
  return (file, args) => {
    const stdinChunks = [];
    const handlers = {};
    const stdoutHandlers = [];
    return {
      stdin: {
        write: (c) => stdinChunks.push(Buffer.from(c)),
        end: () => {
          const stdinText = Buffer.concat(stdinChunks).toString('utf8');
          calls.push({ file, args, stdinText });
          setImmediate(() => {
            if (args.includes('--list')) {
              for (const fn of stdoutHandlers) fn(list);
              handlers.close?.(0);
              return;
            }
            const distro = args[1];
            const script = args[args.length - 1];
            if (script.includes('switchboard-lease')) {
              const answer = wrapperAnswers[distro] ?? { out: '', code: 1 };
              for (const fn of stdoutHandlers) fn(Buffer.from(answer.out, 'utf8'));
              handlers.close?.(answer.code ?? 0);
              return;
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
  };
}

test('parseWrapperInstallOutput reads the one line the install script prints', () => {
  assert.deepEqual(parseWrapperInstallOutput('installed /home/u/.local/bin/switchboard-lease'), { wrapper: 'installed', path: '/home/u/.local/bin/switchboard-lease', target: null });
  assert.deepEqual(parseWrapperInstallOutput('symlink /home/u/.local/bin/switchboard-lease -> /mnt/c/src/switchboard/bin/switchboard-lease'), { wrapper: 'symlink-kept', path: '/home/u/.local/bin/switchboard-lease', target: '/mnt/c/src/switchboard/bin/switchboard-lease' });
  assert.equal(parseWrapperInstallOutput('unchanged /x').wrapper, 'unchanged');
  assert.equal(parseWrapperInstallOutput('updated /x').wrapper, 'updated');
  assert.equal(parseWrapperInstallOutput('replaced /x').wrapper, 'replaced');
  assert.equal(parseWrapperInstallOutput('installed /x', 1).wrapper, 'failed', 'a non-zero exit is a failure whatever was printed');
  assert.equal(parseWrapperInstallOutput('bash: mktemp: not found').wrapper, 'failed');
  assert.equal(parseWrapperInstallOutput('').wrapper, 'failed');
});

test('the wrapper install script keeps a symlink unless told to replace it, and never writes through it', () => {
  const keep = wrapperInstallScript(false);
  const replace = wrapperInstallScript(true);
  assert.match(keep, /if \[ -L "\$p" \]; then/);
  assert.match(keep, /if \[ "0" = 1 \]; then rm -f "\$p"/, 'the replace branch is off');
  assert.match(replace, /if \[ "1" = 1 \]; then rm -f "\$p"/, 'the replace branch is on');
  assert.match(keep, /cmp -s "\$tmp" "\$p"/, 'a matching copy is left alone');
  assert.match(keep, /cat > "\$tmp"/, 'the wrapper goes to a temp file first, never straight through the path');
  assert.ok(!keep.includes('cat > "$p"'));
});

test('provisionLocalAndWslClient reports each distro, keeps a symlinked wrapper and replaces it only on request', async () => {
  const dir = tempDir('sb-gw-');
  const fakeScript = path.join(dir, 'switchboard-lease');
  fs.writeFileSync(fakeScript, '#!/usr/bin/env bash\necho ok\n', 'utf8');
  const secret = 'sb-key-0123456789abcdef0123456789abcdef01234567';
  const calls = [];
  const spawnImpl = fakeWslSpawn({
    distros: ['Ubuntu', 'docker-desktop', 'Debian', 'Alpine'],
    wrapperAnswers: {
      Ubuntu: { out: 'symlink /home/u/.local/bin/switchboard-lease -> /mnt/c/src/switchboard/bin/switchboard-lease', code: 0 },
      Debian: { out: 'unchanged /home/d/.local/bin/switchboard-lease', code: 0 },
      Alpine: { out: 'bash: mktemp: not found', code: 127 },
    },
    calls,
  });

  const res = await provisionLocalAndWslClient({ token: secret, leaseScriptPath: fakeScript, homeDir: dir, platform: 'win32', spawnImpl });
  assert.deepEqual(res.distros, [
    { name: 'Ubuntu', key: 'written', wrapper: 'symlink-kept', path: '/home/u/.local/bin/switchboard-lease', target: '/mnt/c/src/switchboard/bin/switchboard-lease' },
    { name: 'Debian', key: 'written', wrapper: 'unchanged', path: '/home/d/.local/bin/switchboard-lease', target: null },
    { name: 'Alpine', key: 'written', wrapper: 'failed', path: null, target: null },
  ]);
  assert.deepEqual(res.wslDistros, ['Ubuntu', 'Debian', 'Alpine'], 'the key file reached every distro');
  assert.equal(res.wslBinaryPath, '/home/u/.local/bin/switchboard-lease');
  const wrapperCalls = calls.filter((c) => c.args[0] === '-d' && c.args[c.args.length - 1].includes('switchboard-lease'));
  assert.equal(wrapperCalls.length, 3);
  for (const c of wrapperCalls) {
    assert.equal(c.args[2], '--exec');
    assert.match(c.args[c.args.length - 1], /if \[ "0" = 1 \]/, 'symlinks are kept by default');
    assert.equal(c.stdinText, '#!/usr/bin/env bash\necho ok\n', 'the wrapper rides on stdin');
  }
  for (const c of calls) assert.ok(!c.args.join(' ').includes(secret), 'the key never rides on a command line');

  calls.length = 0;
  const replaced = await provisionLocalAndWslClient({ token: secret, leaseScriptPath: fakeScript, homeDir: dir, platform: 'win32', spawnImpl, replaceSymlink: true });
  assert.ok(calls.filter((c) => c.args[0] === '-d').some((c) => /if \[ "1" = 1 \]/.test(c.args[c.args.length - 1])), 'the replace flag reaches the script');
  assert.equal(replaced.ok, true);

  // No wrapper file: the key still goes out, and the wrapper is reported as not provided.
  const noScript = await provisionLocalAndWslClient({ token: secret, leaseScriptPath: path.join(dir, 'missing'), homeDir: dir, platform: 'win32', spawnImpl: fakeWslSpawn({ distros: ['Ubuntu'], wrapperAnswers: {}, calls: [] }) });
  assert.deepEqual(noScript.distros, [{ name: 'Ubuntu', key: 'written', wrapper: 'not-provided', path: null, target: null }]);
  assert.equal(noScript.wslBinaryPath, '~/.local/bin/switchboard-lease');
});

test('syncWslLeaseWrapper refreshes the wrapper in every distro without a key, and does nothing off Windows or without the file', async () => {
  const dir = tempDir('sb-gw-');
  const fakeScript = path.join(dir, 'switchboard-lease');
  fs.writeFileSync(fakeScript, '#!/usr/bin/env bash\necho v2\n', 'utf8');
  const calls = [];
  const spawnImpl = fakeWslSpawn({
    distros: ['Ubuntu', 'Debian'],
    wrapperAnswers: { Ubuntu: { out: 'updated /home/u/.local/bin/switchboard-lease' }, Debian: { out: 'symlink /home/d/.local/bin/switchboard-lease -> /home/d/src/switchboard/bin/switchboard-lease' } },
    calls,
  });
  const res = await syncWslLeaseWrapper({ leaseScriptPath: fakeScript, platform: 'win32', spawnImpl });
  assert.deepEqual(res.distros.map((d) => [d.name, d.wrapper]), [['Ubuntu', 'updated'], ['Debian', 'symlink-kept']]);
  assert.ok(!calls.some((c) => c.args[c.args.length - 1].includes('client-key')), 'no key file is touched');
  assert.deepEqual(await syncWslLeaseWrapper({ leaseScriptPath: fakeScript, platform: 'linux', spawnImpl }), { distros: [] });
  assert.deepEqual(await syncWslLeaseWrapper({ leaseScriptPath: path.join(dir, 'missing'), platform: 'win32', spawnImpl }), { distros: [] });
});

test('createSettingsWatcher watches the folder, answers only for the settings file, and collapses a burst into one call', () => {
  let listener = null;
  let watched = null;
  let closed = 0;
  const timers = [];
  const watchImpl = (dir, opts, fn) => { watched = { dir, opts }; listener = fn; return { close: () => { closed += 1; }, on: () => {} }; };
  const setTimer = (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; };
  const clearTimer = (t) => { t.cleared = true; };
  let changes = 0;
  const w = createSettingsWatcher({ file: path.join('X:', 'data', 'settings.json'), onChange: () => { changes += 1; }, watchImpl, debounceMs: 250, setTimer, clearTimer });
  assert.equal(w.active, true);
  assert.equal(watched.dir, path.join('X:', 'data'));
  assert.equal(watched.opts.persistent, false, 'the watcher must not keep a process alive by itself');

  listener('change', 'other.json');
  assert.equal(timers.length, 0, 'another file in the folder is not a settings change');
  listener('rename', 'settings.json.tmp');
  assert.equal(timers.length, 0);
  listener('rename', 'settings.json');
  listener('change', 'settings.json');
  listener('change', null);
  assert.equal(timers.length, 3);
  assert.equal(timers.filter((t) => !t.cleared).length, 1, 'each event in a burst replaces the pending timer');
  assert.equal(timers[2].ms, 250);
  timers[2].fn();
  assert.equal(changes, 1);
  w.close();
  assert.equal(closed, 1);

  const broken = createSettingsWatcher({ file: 'X:/data/settings.json', onChange: () => {}, watchImpl: () => { throw new Error('EPERM'); } });
  assert.equal(broken.active, false, 'a folder that cannot be watched leaves the old behavior, not a crash');
  broken.close();
});

test('the CLI registers the tray to start with Windows under the app id Electron uses, and provision-client is wired as designed', () => {
  const cli = fs.readFileSync(new URL('../bin/cli.js', import.meta.url), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const m = /const LOGIN_ITEM_NAME = '([^']+)';/.exec(cli);
  assert.ok(m, 'cli.js names the Run entry');
  assert.equal(m[1], pkg.build.appId);
  assert.match(cli, /if \(sub === 'provision-client'\)/);
  assert.match(cli, /chooseProvisionKey\(enabled\.settings, \{ label, scope: enabled\.scope \}\)/, 'the key takes the gateway scope');
  assert.match(cli, /leaseScriptPath: path\.join\(here, 'switchboard-lease'\)/, 'the wrapper is read beside cli.js, inside app.asar when packaged');
  assert.doesNotMatch(cli, /say\([^\n]*chosen\.secret/, 'the secret is never printed');
  assert.doesNotMatch(cli, /out\([^\n]*chosen\.secret/, 'the secret is never printed');
});
