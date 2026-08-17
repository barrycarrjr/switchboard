import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

test('no repo configured is its own named error', async () => {
  assert.deepEqual(await checkAppUpdate({ repo: null, currentVersion: '1.0.0' }), { error: 'no-repo' });
});

test('downloadUpdate writes the public asset into the target dir', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-u-'));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-u2-'));
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
