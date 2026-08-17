import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toPercent, toEpochMs, mapUsage, readAccessToken, fetchClaudeQuota, accountQuota } from '../core/quota.js';

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
