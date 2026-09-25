import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../test-support/tempdir.js';
import { validRepoSlug, checkAppUpdate, downloadUpdate } from '../core/updatecheck.js';

const release = (tag, withAsset = true) => ({
  ok: true,
  status: 200,
  json: async () => ({
    tag_name: tag,
    assets: withAsset ? [{ name: `Switchboard-Setup-${tag.slice(1)}.exe`, browser_download_url: `https://example.invalid/dl/Switchboard-Setup-${tag.slice(1)}.exe` }] : [],
  }),
});

test('validRepoSlug accepts owner/name and rejects everything else', () => {
  assert.equal(validRepoSlug('owner/name'), true);
  assert.equal(validRepoSlug('owner/na.me-x_1'), true);
  assert.equal(validRepoSlug('owner'), false);
  assert.equal(validRepoSlug('owner/name/extra'), false);
  assert.equal(validRepoSlug('owner/name; rm'), false);
  assert.equal(validRepoSlug(null), false);
});

test('public repos: newer release reports available with the asset url', async () => {
  const r = await checkAppUpdate({ repo: 'o/r', currentVersion: '0.5.0', fetchImpl: async () => release('v0.6.0') });
  assert.equal(r.available, true);
  assert.equal(r.tag, 'v0.6.0');
  assert.match(r.assetUrl, /Switchboard-Setup-0\.6\.0\.exe$/);
});

test('public repos: same version reports not available', async () => {
  const r = await checkAppUpdate({ repo: 'o/r', currentVersion: '0.6.0', fetchImpl: async () => release('v0.6.0') });
  assert.equal(r.available, false);
});

test('a 404 falls back to gh (private repo path)', async () => {
  const r = await checkAppUpdate({
    repo: 'o/r',
    currentVersion: '0.5.0',
    fetchImpl: async () => ({ ok: false, status: 404 }),
    execFn: async () => ({ stdout: 'v0.7.0\n' }),
  });
  assert.deepEqual({ available: r.available, tag: r.tag }, { available: true, tag: 'v0.7.0' });
});

test('missing gh is reported as no-gh, never guessed around', async () => {
  const r = await checkAppUpdate({
    repo: 'o/r',
    currentVersion: '0.5.0',
    fetchImpl: async () => ({ ok: false, status: 404 }),
    execFn: async () => { const e = new Error("'gh' is not recognized"); throw e; },
  });
  assert.equal(r.error, 'no-gh');
});

// GitHub allows 60 requests an hour without signing in, per network address, shared with
// everything else on that network. On 2026-09-25 the check ran into that limit and gave up
// with "Update check failed" while a signed-in gh sat unused.
const refusal = (status, headers) => ({
  ok: false,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => ({ message: 'API rate limit exceeded' }),
});
const OUT_OF_REQUESTS = refusal(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790373536' });
const ghMissing = async () => { throw new Error("'gh' is not recognized as an internal or external command"); };

test('a rate-limited check asks the signed-in gh instead of giving up', async () => {
  const asked = [];
  const r = await checkAppUpdate({
    repo: 'o/r',
    currentVersion: '0.5.0',
    fetchImpl: async () => OUT_OF_REQUESTS,
    execFn: async (file, args) => { asked.push([file, ...args].join(' ')); return { stdout: 'v0.7.0\n' }; },
  });
  assert.deepEqual({ available: r.available, tag: r.tag }, { available: true, tag: 'v0.7.0' });
  assert.deepEqual(asked, ['gh api repos/o/r/releases/latest --jq .tag_name']);
});

test('with no gh to ask, a rate limit is reported as one, with the time it lifts', async () => {
  const r = await checkAppUpdate({ repo: 'o/r', currentVersion: '0.5.0', fetchImpl: async () => OUT_OF_REQUESTS, execFn: ghMissing });
  assert.deepEqual(r, { error: 'rate-limited', resetAt: 1790373536000, ghError: 'no-gh' });
});

test('a Retry-After refusal lifts that many seconds from now', async () => {
  const r = await checkAppUpdate({
    repo: 'o/r',
    currentVersion: '0.5.0',
    now: 1_000_000,
    fetchImpl: async () => refusal(429, { 'retry-after': '120' }),
    execFn: async () => { const e = new Error('gh: To get started with GitHub CLI, please run: gh auth login'); throw e; },
  });
  assert.deepEqual(r, { error: 'rate-limited', resetAt: 1_120_000, ghError: 'no-auth' });
});

test('a refusal that is not a rate limit still tries gh, and is never called a private repository', async () => {
  const outage = async () => refusal(503, {});
  const recovered = await checkAppUpdate({ repo: 'o/r', currentVersion: '0.5.0', fetchImpl: outage, execFn: async () => ({ stdout: 'v0.7.0\n' }) });
  assert.equal(recovered.tag, 'v0.7.0');
  assert.deepEqual(await checkAppUpdate({ repo: 'o/r', currentVersion: '0.5.0', fetchImpl: outage, execFn: ghMissing }), { error: 'api' });
  // A 403 with requests still left is some other refusal, not the rate limit.
  const forbidden = async () => refusal(403, { 'x-ratelimit-remaining': '41' });
  assert.deepEqual(await checkAppUpdate({ repo: 'o/r', currentVersion: '0.5.0', fetchImpl: forbidden, execFn: ghMissing }), { error: 'api' });
});

test('no repo configured is its own named error', async () => {
  assert.deepEqual(await checkAppUpdate({ repo: null, currentVersion: '1.0.0' }), { error: 'no-repo' });
});

test('downloadUpdate writes the public asset into the target dir', async () => {
  const dir = tempDir('sb-u-');
  const bytes = Buffer.from('MZ fake installer');
  const file = await downloadUpdate({
    repo: 'o/r',
    tag: 'v0.6.0',
    assetUrl: 'https://example.invalid/dl/Switchboard-Setup-0.6.0.exe',
    dir,
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => bytes }),
  });
  assert.equal(path.basename(file), 'Switchboard-Setup-0.6.0.exe');
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('downloadUpdate streams with progress when the response has a body reader', async () => {
  const dir = tempDir('sb-u2-');
  const parts = [Buffer.from('MZ part one '), Buffer.from('part two')];
  const total = parts[0].length + parts[1].length;
  let i = 0;
  const seen = [];
  const file = await downloadUpdate({
    repo: 'o/r',
    tag: 'v0.6.0',
    assetUrl: 'https://example.invalid/dl/Switchboard-Setup-0.6.0.exe',
    dir,
    onProgress: (received, t) => seen.push([received, t]),
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => String(total) },
      body: { getReader: () => ({ read: async () => (i < parts.length ? { done: false, value: parts[i++] } : { done: true }) }) },
    }),
  });
  assert.equal(fs.readFileSync(file).toString(), 'MZ part one part two');
  assert.deepEqual(seen, [[parts[0].length, total], [total, total]]);
});
