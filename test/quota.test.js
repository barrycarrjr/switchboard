import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toPercent, toEpochMs, mapUsage, readAccessToken, fetchClaudeQuota, accountQuota, toExactPercent, codexWindowLabel, mapCodexRateLimits, codexQuota, providerQuota } from '../core/quota.js';

test('toPercent accepts fractions and percents, clamps, and passes null through', () => {
  assert.equal(toPercent(0.34), 34);
  assert.equal(toPercent(62), 62);
  assert.equal(toPercent(1), 100);   // 1 is treated as a full fraction
  assert.equal(toPercent(140), 100);
  assert.equal(toPercent(null), null);
  assert.equal(toPercent('nan'), null);
});

test('toEpochMs handles seconds, ms, and ISO strings', () => {
  assert.equal(toEpochMs(1766000000), 1766000000000);
  assert.equal(toEpochMs(1766000000000), 1766000000000);
  assert.equal(toEpochMs('2026-08-17T12:00:00Z'), Date.parse('2026-08-17T12:00:00Z'));
  assert.equal(toEpochMs('garbage'), null);
  assert.equal(toEpochMs(null), null);
});

test('mapUsage maps the known windows and reports extra usage in dollars from cents', () => {
  const windows = mapUsage({
    five_hour: { utilization: 0.34, resets_at: 1766000000 },
    seven_day: { utilization: 62, resets_at: '2026-08-20T09:00:00Z' },
    seven_day_opus: { utilization: 0.91 },
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

/* Codex: usage comes from the account's own session logs, not an endpoint. */

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

test('codexQuota reads the newest session log and stamps when it was sampled', () => {
  const home = codexHome([['2026', '08', '18'], ['2026', '08', '19']]);
  writeSession(home, ['2026', '08', '18'], 'rollout-2026-08-18T09-00-00-old.jsonl', [
    tokenCount({ ...LIMITS, primary: { used_percent: 1, window_minutes: 10080 } }, '2026-08-18T09:00:00.000Z'),
  ]);
  writeSession(home, ['2026', '08', '19'], 'rollout-2026-08-19T20-56-32-new.jsonl', [
    { timestamp: '2026-08-19T20:56:32.000Z', type: 'response_item', payload: { type: 'message' } },
    tokenCount(LIMITS, '2026-08-19T21:03:24.593Z'),
  ]);

  const now = Date.parse('2026-08-19T22:00:00.000Z');
  const q = codexQuota(home, now);
  assert.equal(q.error, undefined);
  assert.equal(q.source, 'session-log');
  assert.equal(q.plan, 'plus');
  assert.equal(q.sampledAt, Date.parse('2026-08-19T21:03:24.593Z'));
  assert.equal(q.stale, false);
  assert.equal(q.windows[0].usedPercent, 6);

  // The same snapshot read a week later is the same numbers, honestly labelled old.
  assert.equal(codexQuota(home, now + 3 * 24 * 60 * 60 * 1000).stale, true);
});

test('codexQuota falls back to an older log, and says so when there is none', () => {
  const home = codexHome([['2026', '08', '18'], ['2026', '08', '19']]);
  writeSession(home, ['2026', '08', '18'], 'rollout-a.jsonl', [tokenCount(LIMITS, '2026-08-18T09:00:00.000Z')]);
  // A newer session that never got a rate-limit reply (a run that failed early).
  writeSession(home, ['2026', '08', '19'], 'rollout-b.jsonl', [{ timestamp: '2026-08-19T09:00:00.000Z', type: 'session_meta' }]);
  assert.equal(codexQuota(home).sampledAt, Date.parse('2026-08-18T09:00:00.000Z'));

  assert.deepEqual(codexQuota(codexHome([])), { error: 'no-usage-data' });
  assert.deepEqual(codexQuota(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-empty-'))), { error: 'no-usage-data' });
});

test('a truncated or oversized line is skipped, never half-parsed into a number', () => {
  const home = codexHome();
  const file = path.join(home, 'sessions', '2026', '08', '19', 'rollout-c.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify(tokenCount(LIMITS, '2026-08-19T10:00:00.000Z')),
    '{"timestamp":"2026-08-19T11:00:00.000Z","payload":{"rate_limits":{"primary":{"used_perc',
  ].join('\n') + '\n');
  const q = codexQuota(home);
  assert.equal(q.sampledAt, Date.parse('2026-08-19T10:00:00.000Z'));
});

test('providerQuota routes by tool and refuses to invent one for the rest', async () => {
  const home = codexHome();
  writeSession(home, ['2026', '08', '19'], 'rollout-d.jsonl', [tokenCount(LIMITS, '2026-08-19T10:00:00.000Z')]);
  assert.equal((await providerQuota('codex', home)).source, 'session-log');
  assert.deepEqual(await providerQuota('gemini', home), { error: 'unsupported' });
  assert.deepEqual(await providerQuota('claude', fs.mkdtempSync(path.join(os.tmpdir(), 'sb-c-'))), { error: 'no-credentials' });
});
