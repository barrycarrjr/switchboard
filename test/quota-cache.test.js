import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sharedQuotaKey, readSharedQuota, writeSharedQuota, sharedProviderQuota, lastSharedQuota, quotaCacheFile, SHARED_QUOTA_TTL_MS } from '../core/quota-cache.js';

const LIVE = { windows: [{ key: 'week', label: 'Week (all models)', usedPercent: 12, resetsAt: null }], source: 'token', vendor: 'Anthropic' };

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-qc-')), 'quota-cache.json');
}

test('readSharedQuota serves only a fresh reading filed under the same key', () => {
  const file = tempFile();
  const now = 1_000_000;
  writeSharedQuota('a1', 'k1', LIVE, now, file);

  const hit = readSharedQuota('a1', 'k1', now + 1_000, file);
  assert.equal(hit.cached, true);
  assert.equal(hit.observedAt, now);
  assert.equal(hit.windows[0].usedPercent, 12);

  assert.equal(readSharedQuota('a1', 'other-key', now + 1_000, file), null);
  assert.equal(readSharedQuota('missing', 'k1', now + 1_000, file), null);
  assert.equal(readSharedQuota('a1', 'k1', now + SHARED_QUOTA_TTL_MS + 1, file), null);
  // A future-dated reading (clock moved backwards) has an unknowable age.
  assert.equal(readSharedQuota('a1', 'k1', now - 1, file), null);
  assert.equal(readSharedQuota('a1', 'k1', now, path.join(path.dirname(file), 'absent.json')), null);
});

test('writeSharedQuota shares only successful live readings', () => {
  const file = tempFile();
  writeSharedQuota('a1', 'k1', { error: 'rate-limited' }, 1_000, file);
  assert.equal(fs.existsSync(file), false);
  // A fallback reading is a file on disk already; caching it would stack staleness.
  writeSharedQuota('a1', 'k1', { ...LIVE, source: 'desktop' }, 1_000, file);
  assert.equal(fs.existsSync(file), false);

  writeSharedQuota('a1', 'k1', LIVE, 1_000, file);
  writeSharedQuota('a2', 'k2', LIVE, 2_000, file);
  const all = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(all).sort(), ['a1', 'a2']);

  // A torn file starts over instead of throwing.
  fs.writeFileSync(file, '{torn');
  writeSharedQuota('a3', 'k3', LIVE, 3_000, file);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), ['a3']);
});

test('sharedQuotaKey changes when the credential file changes, so re-auth invalidates', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-qk-'));
  const missing = sharedQuotaKey('claude', home);
  assert.match(missing, /:missing$/);

  fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'one' } }));
  const first = sharedQuotaKey('claude', home);
  fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a-longer-token' } }));
  const second = sharedQuotaKey('claude', home);
  assert.notEqual(first, missing);
  assert.notEqual(first, second);
});

test('sharedProviderQuota fetches live once, then serves the shared reading', async () => {
  // dataDir() reads APPDATA at call time, so point the shared file at a temp dir.
  const prevAppData = process.env.APPDATA;
  process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-appdata-'));
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-qp-'));
    const future = Date.now() + 60 * 60 * 1000;
    fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 't', expiresAt: future } }));
    const account = { id: 'acct-1', provider: 'claude', home };
    let calls = 0;
    const spyFetch = async () => { calls += 1; return { ok: true, json: async () => ({ five_hour: { utilization: 7 } }) }; };

    const first = await sharedProviderQuota(account, { fetchImpl: spyFetch });
    assert.equal(first.source, 'token');
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(quotaCacheFile()), true);

    const second = await sharedProviderQuota(account, { fetchImpl: spyFetch });
    assert.equal(second.cached, true);
    assert.equal(second.source, 'token');
    assert.equal(calls, 1);

    // A changed credential file (re-auth) must invalidate the shared reading.
    fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'renewed-token', expiresAt: future } }));
    const third = await sharedProviderQuota(account, { fetchImpl: spyFetch });
    assert.equal(third.cached, undefined);
    assert.equal(calls, 2);
  } finally {
    process.env.APPDATA = prevAppData;
  }
});

// Deliberately not key-checked: the key embeds the credential file's mtime, and the
// CLI rewrites that on every token refresh, which is the same account on the same
// schedule. What must not be carried across a re-login is enforced on the account
// identity inside inheritResetTimes, not here.
test('lastSharedQuota answers at any age, and past a credential rewrite', () => {
  const file = tempFile();
  writeSharedQuota('a1', 'k1', LIVE, 1_000, file);
  // Far past the TTL: readSharedQuota refuses, the turnover-inheritance read does not.
  assert.equal(readSharedQuota('a1', 'k1', 1_000 + SHARED_QUOTA_TTL_MS + 1, file), null);
  assert.equal(lastSharedQuota('a1', file).windows[0].usedPercent, 12);
  assert.equal(lastSharedQuota('missing', file), null);
  assert.equal(lastSharedQuota('a1', path.join(path.dirname(file), 'absent.json')), null);
  writeSharedQuota('a2', 'k2', { error: 'rate-limited' }, 1_000, file);
  assert.equal(lastSharedQuota('a2', file), null, 'a failure is not a reading to inherit from');
});

// The flap this closes: mid spend-down, one rate-limited tick swaps the account's
// reading to the Desktop fallback, whose windows never carry turnover times. Without
// inheritance the watch could no longer prove the week was about to turn over, lane
// order reclaimed the default, and the next token-shaped reading sent it back, once
// per cooldown for as long as the endpoint stayed flaky.
test('a rate-limited tick cannot make a known week turnover vanish', async () => {
  const prevAppData = process.env.APPDATA;
  process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-appdata3-'));
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-qp3-'));
    const now = Date.now();
    const weekReset = now + 6 * 60 * 60 * 1000;
    fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 't', expiresAt: now + 60 * 60 * 1000 } }));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'org-1', accountUuid: 'acct' } }));
    const desktopDir = path.join(process.env.APPDATA, 'Claude');
    fs.mkdirSync(desktopDir, { recursive: true });
    fs.writeFileSync(path.join(desktopDir, 'plan-usage-history.json'), JSON.stringify({
      samples: [{ t: now - 60_000, org: 'org-1', u: { fh: 12, sd: 67 } }],
    }));
    const account = { id: 'acct-3', provider: 'claude', home };

    const good = async () => ({ ok: true, json: async () => ({
      five_hour: { utilization: 12, resets_at: now + 2 * 60 * 60 * 1000 },
      seven_day: { utilization: 67, resets_at: weekReset },
    }) });
    const seeded = await sharedProviderQuota(account, { fetchImpl: good, now });
    assert.equal(seeded.source, 'token');
    assert.equal(seeded.windows.find((w) => w.key === 'week').resetsAt, weekReset);

    // Well past the TTL (the write stamps its own clock, so leave a margin), the
    // endpoint rate-limits and the Desktop fallback answers instead.
    const later = now + SHARED_QUOTA_TTL_MS + 60_000;
    const limited = async () => ({ ok: false, status: 429, json: async () => ({}) });
    const fallback = await sharedProviderQuota(account, { fetchImpl: limited, now: later });
    assert.equal(fallback.source, 'desktop');
    assert.equal(fallback.fallbackReason, 'rate-limited');
    assert.equal(fallback.windows.find((w) => w.key === 'week').resetsAt, weekReset, 'the still-future turnover is inherited');
    assert.equal(fallback.windows.find((w) => w.key === 'week').usedPercent, 67, 'percentages stay the fallback\'s own');
  } finally {
    process.env.APPDATA = prevAppData;
  }
});

test('sharedProviderQuota does not share a failed reading, so the next caller retries', async () => {
  const prevAppData = process.env.APPDATA;
  process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-appdata2-'));
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-qp2-'));
    const future = Date.now() + 60 * 60 * 1000;
    fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 't', expiresAt: future } }));
    const account = { id: 'acct-2', provider: 'claude', home };
    let calls = 0;
    const failing = async () => { calls += 1; return { ok: false, status: 500, json: async () => ({}) }; };

    assert.equal((await sharedProviderQuota(account, { fetchImpl: failing })).error, 'unavailable');
    assert.equal((await sharedProviderQuota(account, { fetchImpl: failing })).error, 'unavailable');
    assert.equal(calls, 2);
  } finally {
    process.env.APPDATA = prevAppData;
  }
});
