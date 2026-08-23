import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toEpochMs, mapUsage, readAccessToken, fetchClaudeQuota, accountQuota, toExactPercent, fractionToPercent, codexWindowLabel, mapCodexRateLimits, codexSessionQuota, codexAccountQuota, codexLiveRateLimits, fetchCodexQuota, readCodexAuth, providerQuota } from '../core/quota.js';

test('toExactPercent reads every value as a percent, clamps, and passes null through', () => {
  assert.equal(toExactPercent(34), 34);
  assert.equal(toExactPercent(62), 62);
  assert.equal(toExactPercent(1), 1);      // one percent, never a full fraction
  assert.equal(toExactPercent(0.4), 0);
  assert.equal(toExactPercent(140), 100);
  assert.equal(toExactPercent(-5), 0);
  assert.equal(toExactPercent(null), null);
  assert.equal(toExactPercent('nan'), null);
});

test('fractionToPercent converts a genuine 0-1 ratio', () => {
  assert.equal(fractionToPercent(0.248), 25);
  assert.equal(fractionToPercent(1), 100);
  assert.equal(fractionToPercent(null), null);
});

test('toEpochMs handles seconds, ms, and ISO strings', () => {
  assert.equal(toEpochMs(1766000000), 1766000000000);
  assert.equal(toEpochMs(1766000000000), 1766000000000);
  assert.equal(toEpochMs('2026-08-17T12:00:00Z'), Date.parse('2026-08-17T12:00:00Z'));
  assert.equal(toEpochMs('garbage'), null);
  assert.equal(toEpochMs(null), null);
});

test('mapUsage maps the named windows and reports extra usage in dollars from cents', () => {
  const windows = mapUsage({
    five_hour: { utilization: 34, resets_at: 1766000000 },
    seven_day: { utilization: 62, resets_at: '2026-08-20T09:00:00Z' },
    seven_day_opus: { utilization: 91 },
    extra_usage: { is_enabled: true, used_credits: 1240, monthly_limit: 5000 },
  });
  const byKey = Object.fromEntries(windows.map((w) => [w.key, w]));
  assert.equal(byKey.session.usedPercent, 34);
  assert.equal(byKey.session.resetsAt, 1766000000000);
  assert.equal(byKey.week.usedPercent, 62);
  assert.equal(byKey.week_opus.usedPercent, 91);
  assert.equal(byKey.extra.valueLabel, '$12.40 / $50.00');
  assert.equal(byKey.extra.usedPercent, 25);
});

// The shape of a real 2026-08-21 reply from an account that had used 2% and 1%.
// Reading either as a 0-1 fraction reported "limit reached" for a nearly unused
// subscription, and with the quota watch on auto that switched the machine default.
test('mapUsage reads one percent as one percent, from the limits array', () => {
  const windows = mapUsage({
    five_hour: { utilization: 2.0, resets_at: '2026-08-21T18:30:00Z' },
    seven_day: { utilization: 1.0, resets_at: '2026-08-28T01:00:00Z' },
    limits: [
      { kind: 'session', percent: 2, resets_at: '2026-08-21T18:30:00Z', scope: null },
      { kind: 'weekly_all', percent: 1, resets_at: '2026-08-28T01:00:00Z', scope: null },
      { kind: 'weekly_scoped', percent: 0, resets_at: null, scope: { model: { id: null, display_name: 'Fable' } } },
    ],
    extra_usage: { is_enabled: false },
  });
  const byKey = Object.fromEntries(windows.map((w) => [w.key, w]));
  assert.equal(byKey.session.usedPercent, 2);
  assert.equal(byKey.session.resetsAt, Date.parse('2026-08-21T18:30:00Z'));
  assert.equal(byKey.week.usedPercent, 1);
  assert.equal(byKey.week.label, 'Week (all models)');
  assert.equal(byKey.week_fable.usedPercent, 0);
  assert.equal(byKey.week_fable.label, 'Week (Fable)');
  assert.equal(byKey.extra.valueLabel, 'Not enabled');
});

test('mapUsage keeps an unfamiliar limit without letting it take a known key', () => {
  const windows = mapUsage({
    limits: [
      { kind: 'weekly_all', percent: 3 },
      { kind: 'monthly_experiment', percent: 7 },
      { kind: 'weekly_all', percent: 9 },
    ],
  });
  assert.deepEqual(windows.map((w) => [w.key, w.label, w.usedPercent]), [
    ['week', 'Week (all models)', 3],
    ['monthly_experiment', 'Monthly experiment', 7],
    ['week2', 'Week (all models)', 9],
  ]);
});

test('mapUsage ignores a limit that carries no reading', () => {
  const windows = mapUsage({ limits: [{ kind: 'session', percent: null }, { kind: 'weekly_all', percent: 4 }] });
  assert.deepEqual(windows.map((w) => w.key), ['week']);
});

test('mapUsage reports disabled extra usage without inventing numbers', () => {
  const windows = mapUsage({ extra_usage: { is_enabled: false } });
  assert.equal(windows[0].valueLabel, 'Not enabled');
  assert.equal(windows[0].usedPercent, null);
});

test('mapUsage of an empty body is empty, not fabricated', () => {
  assert.deepEqual(mapUsage({}), []);
});

test('readAccessToken reads the vendor credential file and tolerates absence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-q-'));
  assert.equal(readAccessToken(dir), null);
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-123' } }));
  assert.equal(readAccessToken(dir), 'tok-123');
  fs.writeFileSync(path.join(dir, '.credentials.json'), 'not json');
  assert.equal(readAccessToken(dir), null);
});

test('fetchClaudeQuota sends the bearer token and beta header', async () => {
  let seen = null;
  const fakeFetch = async (url, init) => {
    seen = { url, init };
    return { ok: true, json: async () => ({ five_hour: { utilization: 10 } }) };
  };
  const windows = await fetchClaudeQuota('tok-abc', fakeFetch);
  assert.equal(windows[0].usedPercent, 10);
  assert.match(seen.url, /oauth\/usage/);
  assert.equal(seen.init.headers.authorization, 'Bearer tok-abc');
  assert.equal(seen.init.headers['anthropic-beta'], 'oauth-2025-04-20');
});

test('accountQuota reports unknowns instead of guessing, and names auth failures', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-q2-'));
  assert.deepEqual(await accountQuota(dir), { error: 'no-credentials' });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 't' } }));
  const failWith = (status) => async () => ({ ok: false, status, json: async () => ({}) });
  assert.deepEqual(await accountQuota(dir, failWith(500)), { error: 'unavailable' });
  assert.deepEqual(await accountQuota(dir, failWith(401)), { error: 'auth' });
  assert.deepEqual(await accountQuota(dir, failWith(403)), { error: 'auth' });
  assert.deepEqual(await accountQuota(dir, failWith(429)), { error: 'rate-limited' });
});

/* Codex: a live endpoint when the sign-in allows it, the account's own session logs when it does not. */

function codexHome(days = [['2026', '08', '19']]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-codex-'));
  for (const [y, m, d] of days) fs.mkdirSync(path.join(dir, 'sessions', y, m, d), { recursive: true });
  return dir;
}

function writeSession(home, [y, m, d], name, lines) {
  const file = path.join(home, 'sessions', y, m, d, name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

function tokenCount(limits, timestamp) {
  return { timestamp, type: 'event_msg', payload: { type: 'token_count', info: {}, rate_limits: limits } };
}

const LIMITS = {
  limit_id: 'codex',
  primary: { used_percent: 6.0, window_minutes: 10080, resets_at: 1787400916 },
  secondary: { used_percent: 41.5, window_minutes: 300, resets_at: 1787200000 },
  credits: { has_credits: false, unlimited: false, balance: '0' },
  plan_type: 'plus',
};

test('toExactPercent reads a percent as a percent: 6.0 is six, never six hundred', () => {
  assert.equal(toExactPercent(6.0), 6);
  assert.equal(toExactPercent(0.6), 1);   // rounds, never rescaled to 60
  assert.equal(toExactPercent(0), 0);
  assert.equal(toExactPercent(120), 100);
  assert.equal(toExactPercent(null), null);
});

test('codexWindowLabel names the windows the vendor actually uses', () => {
  assert.equal(codexWindowLabel(300), 'Session (5h)');
  assert.equal(codexWindowLabel(10080), 'Week');
  assert.equal(codexWindowLabel(30), 'Last 30m');
  assert.equal(codexWindowLabel(1440), 'Last 1d');
  assert.equal(codexWindowLabel(null), 'Usage');
});

test('mapCodexRateLimits keeps window keys unique and hides credits nobody has', () => {
  const windows = mapCodexRateLimits(LIMITS);
  assert.deepEqual(windows.map((w) => [w.key, w.label, w.usedPercent]), [
    ['week', 'Week', 6],
    ['session', 'Session (5h)', 42],
  ]);
  assert.equal(windows[0].resetsAt, 1787400916000);
  assert.equal(windows.some((w) => w.key === 'credits'), false);

  const withCredits = mapCodexRateLimits({ ...LIMITS, credits: { has_credits: true, unlimited: false, balance: '12.50' } });
  assert.equal(withCredits.at(-1).valueLabel, '12.50');

  // Two windows of the same size must not collide onto one key.
  const twoWeeks = mapCodexRateLimits({
    primary: { used_percent: 1, window_minutes: 10080 },
    secondary: { used_percent: 2, window_minutes: 10080 },
  });
  assert.deepEqual(twoWeeks.map((w) => w.key), ['week', 'week2']);
  assert.deepEqual(mapCodexRateLimits(null), []);
});

test('codexSessionQuota reads the newest session log and stamps when it was sampled', () => {
  const home = codexHome([['2026', '08', '18'], ['2026', '08', '19']]);
  writeSession(home, ['2026', '08', '18'], 'rollout-2026-08-18T09-00-00-old.jsonl', [
    tokenCount({ ...LIMITS, primary: { used_percent: 1, window_minutes: 10080 } }, '2026-08-18T09:00:00.000Z'),
  ]);
  writeSession(home, ['2026', '08', '19'], 'rollout-2026-08-19T20-56-32-new.jsonl', [
    { timestamp: '2026-08-19T20:56:32.000Z', type: 'response_item', payload: { type: 'message' } },
    tokenCount(LIMITS, '2026-08-19T21:03:24.593Z'),
  ]);

  const now = Date.parse('2026-08-19T22:00:00.000Z');
  const q = codexSessionQuota(home, now);
  assert.equal(q.error, undefined);
  assert.equal(q.source, 'session-log');
  assert.equal(q.plan, 'plus');
  assert.equal(q.sampledAt, Date.parse('2026-08-19T21:03:24.593Z'));
  assert.equal(q.stale, false);
  assert.equal(q.windows[0].usedPercent, 6);

  // The same snapshot read a week later is the same numbers, honestly labelled old.
  assert.equal(codexSessionQuota(home, now + 3 * 24 * 60 * 60 * 1000).stale, true);
});

test('codexSessionQuota falls back to an older log, and says so when there is none', () => {
  const home = codexHome([['2026', '08', '18'], ['2026', '08', '19']]);
  writeSession(home, ['2026', '08', '18'], 'rollout-a.jsonl', [tokenCount(LIMITS, '2026-08-18T09:00:00.000Z')]);
  // A newer session that never got a rate-limit reply (a run that failed early).
  writeSession(home, ['2026', '08', '19'], 'rollout-b.jsonl', [{ timestamp: '2026-08-19T09:00:00.000Z', type: 'session_meta' }]);
  assert.equal(codexSessionQuota(home).sampledAt, Date.parse('2026-08-18T09:00:00.000Z'));

  assert.deepEqual(codexSessionQuota(codexHome([])), { error: 'no-usage-data' });
  assert.deepEqual(codexSessionQuota(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-empty-'))), { error: 'no-usage-data' });
});

test('a truncated or oversized line is skipped, never half-parsed into a number', () => {
  const home = codexHome();
  const file = path.join(home, 'sessions', '2026', '08', '19', 'rollout-c.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify(tokenCount(LIMITS, '2026-08-19T10:00:00.000Z')),
    '{"timestamp":"2026-08-19T11:00:00.000Z","payload":{"rate_limits":{"primary":{"used_perc',
  ].join('\n') + '\n');
  const q = codexSessionQuota(home);
  assert.equal(q.sampledAt, Date.parse('2026-08-19T10:00:00.000Z'));
});

test('providerQuota routes by tool and refuses to invent one for the rest', async () => {
  const home = codexHome();
  writeSession(home, ['2026', '08', '19'], 'rollout-d.jsonl', [tokenCount(LIMITS, '2026-08-19T10:00:00.000Z')]);
  assert.equal((await providerQuota('codex', home)).source, 'session-log');
  assert.deepEqual(await providerQuota('gemini', home), { error: 'unsupported' });
  assert.deepEqual(await providerQuota('claude', fs.mkdtempSync(path.join(os.tmpdir(), 'sb-c-'))), { error: 'no-credentials' });
});

/* The live source: the same account's ChatGPT sign-in, asked directly. */

const LIVE = {
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 75, limit_window_seconds: 604800, reset_at: 1788123384 },
    secondary_window: null,
  },
  credits: { has_credits: false, unlimited: false, balance: '0' },
};

function codexHomeWithAuth(tokens) {
  const dir = codexHome([]);
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens }));
  return dir;
}

test('readCodexAuth reads the vendor credential file and tolerates absence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cx-'));
  assert.equal(readCodexAuth(dir), null);
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: 'tok-1', account_id: 'acct-9' } }));
  assert.deepEqual(readCodexAuth(dir), { token: 'tok-1', accountId: 'acct-9' });
  // An API-key sign-in has no ChatGPT subscription behind it, so there is nothing to ask.
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ tokens: { account_id: 'acct-9' } }));
  assert.equal(readCodexAuth(dir), null);
  fs.writeFileSync(path.join(dir, 'auth.json'), 'not json');
  assert.equal(readCodexAuth(dir), null);
});

test('codexLiveRateLimits states the same windows as a session log, in the log\'s units', () => {
  const limits = codexLiveRateLimits(LIVE);
  assert.equal(limits.primary.window_minutes, 10080);
  assert.equal(limits.primary.used_percent, 75);
  assert.equal(limits.primary.resets_at, 1788123384);
  assert.equal(limits.secondary, null);
  assert.equal(limits.plan_type, 'plus');

  const windows = mapCodexRateLimits(limits);
  assert.deepEqual(windows.map((w) => [w.key, w.label, w.usedPercent]), [['week', 'Week', 75]]);
  assert.equal(windows[0].resetsAt, 1788123384000);
  assert.deepEqual(codexLiveRateLimits({}), { primary: null, secondary: null, credits: null, plan_type: null });
});

test('a window whose length the vendor did not state is not filed as a week', () => {
  const windows = mapCodexRateLimits({ primary: { used_percent: 12, window_minutes: null } });
  assert.deepEqual(windows.map((w) => [w.key, w.label]), [['usage', 'Usage']]);
});

test('fetchCodexQuota sends the bearer token and the account it belongs to', async () => {
  let seen = null;
  const fakeFetch = async (url, init) => {
    seen = { url, init };
    return { ok: true, json: async () => LIVE };
  };
  const live = await fetchCodexQuota({ token: 'tok-abc', accountId: 'acct-9' }, fakeFetch);
  assert.equal(live.plan, 'plus');
  assert.equal(live.windows[0].usedPercent, 75);
  assert.match(seen.url, /wham\/usage/);
  assert.equal(seen.init.headers.authorization, 'Bearer tok-abc');
  assert.equal(seen.init.headers['chatgpt-account-id'], 'acct-9');

  // A reply we cannot read is a failure, never an empty card presented as a reading.
  await assert.rejects(fetchCodexQuota({ token: 't' }, async () => ({ ok: true, json: async () => ({}) })));
});

test('codexAccountQuota prefers the live reading over the snapshot', async () => {
  const home = codexHomeWithAuth({ access_token: 'tok-1', account_id: 'acct-9' });
  fs.mkdirSync(path.join(home, 'sessions', '2026', '08', '19'), { recursive: true });
  writeSession(home, ['2026', '08', '19'], 'rollout-live.jsonl', [tokenCount(LIMITS, '2026-08-19T10:00:00.000Z')]);

  const q = await codexAccountQuota(home, async () => ({ ok: true, json: async () => LIVE }));
  assert.equal(q.source, 'token');
  assert.equal(q.vendor, 'OpenAI');
  assert.equal(q.plan, 'plus');
  assert.equal(q.windows[0].usedPercent, 75);
  assert.equal(q.sampledAt, undefined);
});

test('a refused live reading keeps the snapshot and says why it is standing in', async () => {
  const home = codexHomeWithAuth({ access_token: 'stale-token' });
  fs.mkdirSync(path.join(home, 'sessions', '2026', '08', '19'), { recursive: true });
  writeSession(home, ['2026', '08', '19'], 'rollout-old.jsonl', [tokenCount(LIMITS, '2026-08-19T10:00:00.000Z')]);
  const failWith = (status) => async () => ({ ok: false, status, json: async () => ({}) });

  const stale = await codexAccountQuota(home, failWith(401));
  assert.equal(stale.source, 'session-log');
  assert.equal(stale.fallbackReason, 'auth');
  assert.equal(stale.windows[0].usedPercent, 6);
  assert.equal((await codexAccountQuota(home, failWith(429))).fallbackReason, 'rate-limited');
  assert.equal((await codexAccountQuota(home, failWith(500))).fallbackReason, 'unavailable');
  // Offline is the same story: the numbers on file are still the numbers on file.
  assert.equal((await codexAccountQuota(home, async () => { throw new Error('offline'); })).fallbackReason, 'unavailable');
});

test('codexAccountQuota names the failure when there is no snapshot to fall back on', async () => {
  const home = codexHomeWithAuth({ access_token: 'stale-token' });
  const failWith = (status) => async () => ({ ok: false, status, json: async () => ({}) });
  assert.deepEqual(await codexAccountQuota(home, failWith(401)), { error: 'auth' });
  assert.deepEqual(await codexAccountQuota(home, failWith(429)), { error: 'rate-limited' });
  // No sign-in at all and nothing recorded: run it once, rather than a wrong reason.
  assert.deepEqual(await codexAccountQuota(codexHome([])), { error: 'no-usage-data' });
});

test('providerQuota reads Codex live when the account can be asked', async () => {
  const home = codexHomeWithAuth({ access_token: 'tok-1' });
  const q = await providerQuota('codex', home, { fetchImpl: async () => ({ ok: true, json: async () => LIVE }) });
  assert.equal(q.source, 'token');
  assert.equal(q.vendor, 'OpenAI');
});
