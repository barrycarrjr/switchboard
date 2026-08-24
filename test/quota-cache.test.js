import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sharedQuotaKey, readSharedQuota, writeSharedQuota, sharedProviderQuota, quotaCacheFile, SHARED_QUOTA_TTL_MS } from '../core/quota-cache.js';

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
