import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDesktopUsage, accountQuota, DESKTOP_STALE_MS } from '../core/quota.js';
import { loadSettings, saveSettings } from '../core/settings.js';

function profileDir(samples) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dt-'));
  fs.writeFileSync(path.join(dir, 'plan-usage-history.json'), JSON.stringify({ version: 2, samples }));
  return dir;
}

test('readDesktopUsage maps the LAST sample into windows', () => {
  const now = 2_000_000_000_000;
  const dir = profileDir([
    { t: now - 60_000, org: 'org-1', u: { fh: 12, sd: 88 } },
    { t: now - 30_000, org: 'org-1', u: { fh: 15, sd: 89, xu: 1.5 } },
  ]);
  const r = readDesktopUsage(dir, now);
  assert.equal(r.source, 'desktop');
  assert.equal(r.stale, false);
  assert.equal(r.sampledAt, now - 30_000);
  const byKey = Object.fromEntries(r.windows.map((w) => [w.key, w]));
  assert.equal(byKey.session.usedPercent, 15);
  assert.equal(byKey.week.usedPercent, 89);
  assert.equal(byKey.extra.valueLabel, '$1.50');
});

test('readDesktopUsage marks old samples stale and tolerates junk', () => {
  const now = 2_000_000_000_000;
  const stale = readDesktopUsage(profileDir([{ t: now - DESKTOP_STALE_MS - 1, org: 'o', u: { fh: 1, sd: 2 } }]), now);
  assert.equal(stale.stale, true);
  const empty = readDesktopUsage(profileDir([]), now);
  assert.equal(empty.error, 'unreadable');
  const missing = readDesktopUsage(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dt-')), now);
  assert.equal(missing.error, 'unreadable');
});

test('accountQuota falls back to the desktop source when no token is readable', async () => {
  const now = 2_000_000_000_000;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dt-home-'));
  const source = profileDir([{ t: now - 1000, org: 'o', u: { fh: 3, sd: 4 } }]);
  const withSource = await accountQuota(home, fetch, source, now);
  assert.equal(withSource.source, 'desktop');
  const withoutSource = await accountQuota(home, fetch, null, now);
  assert.equal(withoutSource.error, 'no-credentials');
});

test('settings roundtrip and defaulting', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-s-')), 'settings.json');
  const first = loadSettings(file);
  assert.equal(first.quotaWatch, 'off');
  first.quotaWatch = 'auto';
  first.usageSources['claude-default'] = 'C:/somewhere';
  saveSettings(first, file);
  const back = loadSettings(file);
  assert.equal(back.quotaWatch, 'auto');
  assert.equal(back.usageSources['claude-default'], 'C:/somewhere');
  fs.writeFileSync(file, '{"quotaWatch":"bogus"}');
  assert.equal(loadSettings(file).quotaWatch, 'off');
});

test('window bounds only restore when they look like real bounds', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-s2-')), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ windowBounds: { width: 662, height: 830, x: 100, y: 100 } }));
  assert.deepEqual(loadSettings(file).windowBounds, { width: 662, height: 830, x: 100, y: 100 });
  fs.writeFileSync(file, JSON.stringify({ windowBounds: { width: 5, height: 830 } }));
  assert.equal(loadSettings(file).windowBounds, null);
  fs.writeFileSync(file, JSON.stringify({ windowBounds: 'wat' }));
  assert.equal(loadSettings(file).windowBounds, null);
});
