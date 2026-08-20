import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readClaudeAccountIdentity,
  readDesktopUsage,
  accountQuota,
  providerQuota,
  DESKTOP_STALE_MS,
} from '../core/quota.js';
import { verifiedAccountLoginState } from '../core/doctor.js';
import { loadSettings, saveSettings } from '../core/settings.js';

function profileDir(samples) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dt-'));
  fs.writeFileSync(path.join(dir, 'plan-usage-history.json'), JSON.stringify({ version: 2, samples }));
  return dir;
}

function claudeHome(identity = null, oauth = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dt-home-'));
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));
  if (identity) {
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
      oauthAccount: {
        accountUuid: identity.accountUuid,
        organizationUuid: identity.organizationUuid,
        emailAddress: 'private@example.test',
      },
    }));
  }
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

test('Claude account identity is read from .claude.json without carrying personal fields', () => {
  const home = claudeHome({ accountUuid: 'acct-1', organizationUuid: 'org-1' });
  const identity = readClaudeAccountIdentity(home);
  assert.deepEqual(identity, { accountUuid: 'acct-1', organizationUuid: 'org-1' });
  assert.equal(JSON.stringify(identity).includes('private@example.test'), false);

  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dt-no-id-'));
  assert.equal(readClaudeAccountIdentity(missing), null);
  fs.writeFileSync(path.join(missing, '.claude.json'), '{not json');
  assert.equal(readClaudeAccountIdentity(missing), null);
});

test('Desktop usage selects the newest sample for the requested organization, not the last row', () => {
  const now = 2_000_000_000_000;
  const dir = profileDir([
    // The newest matching sample appears first to prove array order is not trusted.
    { t: now - 2_000, org: 'org-primary', u: { fh: 4, sd: 100 } },
    { t: now - 1_000, org: 'org-secondary', u: { fh: 90, sd: 91 } },
    { t: now - 8_000, org: 'org-primary', u: { fh: 2, sd: 80 } },
  ]);
  const primary = readDesktopUsage(dir, now, 'org-primary');
  assert.equal(primary.source, 'desktop');
  assert.equal(primary.sampledAt, now - 2_000);
  assert.deepEqual(primary.windows.slice(0, 2).map((w) => w.usedPercent), [4, 100]);

  const secondary = readDesktopUsage(dir, now, 'org-secondary');
  assert.equal(secondary.sampledAt, now - 1_000);
  assert.deepEqual(secondary.windows.slice(0, 2).map((w) => w.usedPercent), [90, 91]);
});

test('Desktop percentages are already 0-100 and one percent never becomes 100 percent', () => {
  const now = 2_000_000_000_000;
  const r = readDesktopUsage(profileDir([
    { t: now, org: 'org-1', u: { fh: 1, sd: 0.5 } },
  ]), now, 'org-1');
  assert.deepEqual(r.windows.slice(0, 2).map((w) => w.usedPercent), [1, 1]);
});

test('Desktop rows with no recognizable percentage are not treated as readings', () => {
  const now = 2_000_000_000_000;
  const r = readDesktopUsage(profileDir([
    { t: now, org: 'org-1', u: { something_new: 42 } },
  ]), now, 'org-1');
  assert.equal(r.error, 'unreadable');
  assert.equal(r.windows, undefined);
});

test('Desktop usage never borrows a different account and computes staleness from the matching sample', () => {
  const now = 2_000_000_000_000;
  const dir = profileDir([
    { t: now - DESKTOP_STALE_MS - 1, org: 'org-primary', u: { fh: 5, sd: 97 } },
    { t: now - 1_000, org: 'org-secondary', u: { fh: 0, sd: 100 } },
  ]);
  const primary = readDesktopUsage(dir, now, 'org-primary');
  assert.equal(primary.stale, true);
  assert.equal(primary.windows.find((w) => w.key === 'week').usedPercent, 97);

  const missing = readDesktopUsage(dir, now, 'org-never-seen');
  assert.ok(missing.error);
  assert.equal(missing.windows, undefined);

  const atBoundary = readDesktopUsage(profileDir([
    { t: now - DESKTOP_STALE_MS, org: 'org-primary', u: { fh: 0, sd: 0, xu: 0 } },
  ]), now, 'org-primary');
  assert.equal(atBoundary.stale, false);
  assert.equal(atBoundary.windows.find((w) => w.key === 'extra').valueLabel, '$0.00');
});

test('accountQuota falls back to the desktop source when no token is readable', async () => {
  const now = 2_000_000_000_000;
  const home = claudeHome(
    { accountUuid: 'acct-o', organizationUuid: 'org-o' },
    { accessToken: '', refreshToken: '', refreshTokenExpiresAt: now + 60_000 },
  );
  const source = profileDir([{ t: now - 1000, org: 'o', u: { fh: 3, sd: 4 } }]);
  // The configured profile contains another account. It must not be used merely because
  // it is the only readable usage file on the machine.
  const wrongSource = await accountQuota(home, fetch, source, now);
  assert.ok(wrongSource.error);

  const matchingSource = profileDir([{ t: now - 1000, org: 'org-o', u: { fh: 3, sd: 100 } }]);
  let fetched = false;
  const withSource = await accountQuota(home, async () => { fetched = true; throw new Error('must not fetch'); }, matchingSource, now);
  assert.equal(withSource.source, 'desktop');
  assert.equal(withSource.windows.find((w) => w.key === 'week').usedPercent, 100);
  assert.equal(fetched, false, 'an empty credential tombstone never causes an API request');
  const unrelatedDefault = profileDir([{ t: now - 500, org: 'org-someone-else', u: { fh: 99, sd: 99 } }]);
  const withoutSource = await accountQuota(home, fetch, null, now, unrelatedDefault);
  assert.equal(withoutSource.error, 'no-credentials');
});

test('providerQuota automatically uses the default Desktop profile only for the same account', async () => {
  const now = 2_000_000_000_000;
  const home = claudeHome(
    { accountUuid: 'acct-primary', organizationUuid: 'org-primary' },
    { accessToken: '', refreshToken: '', refreshTokenExpiresAt: now + 60_000 },
  );
  const desktopProfile = profileDir([
    { t: now - 2_000, org: 'org-primary', u: { fh: 0, sd: 100 } },
    { t: now - 1_000, org: 'org-secondary', u: { fh: 2, sd: 3 } },
  ]);
  let fetched = false;
  const q = await providerQuota('claude', home, {
    fetchImpl: async () => { fetched = true; throw new Error('must not fetch'); },
    desktopProfile,
    now,
  });
  assert.equal(q.source, 'desktop');
  assert.equal(q.sampledAt, now - 2_000);
  assert.equal(q.windows.find((w) => w.key === 'week').usedPercent, 100);
  assert.equal(fetched, false);

  const otherHome = claudeHome(
    { accountUuid: 'acct-never', organizationUuid: 'org-never' },
    { accessToken: '', refreshToken: '' },
  );
  const other = await providerQuota('claude', otherHome, { desktopProfile, now });
  assert.ok(other.error, 'an account absent from Desktop history stays unknown');
  assert.equal(other.windows, undefined);
});

test('the newest matching Desktop source wins and ambiguous organization fallback can be disabled', async () => {
  const now = 2_000_000_000_000;
  const home = claudeHome(
    { accountUuid: 'acct-primary', organizationUuid: 'org-primary' },
    { accessToken: '', refreshToken: '' },
  );
  const configured = profileDir([
    { t: now - 30_000, org: 'org-primary', u: { fh: 80, sd: 90 } },
  ]);
  const defaultProfile = profileDir([
    { t: now - 1_000, org: 'org-primary', u: { fh: 2, sd: 3 } },
  ]);

  const newest = await accountQuota(home, fetch, configured, now, defaultProfile);
  assert.equal(newest.sampledAt, now - 1_000);
  assert.deepEqual(newest.windows.slice(0, 2).map((w) => w.usedPercent), [2, 3]);

  const ambiguous = await providerQuota('claude', home, {
    usageSource: configured,
    desktopProfile: defaultProfile,
    allowDesktopFallback: false,
    now,
  });
  assert.equal(ambiguous.error, 'no-credentials');
  assert.equal(ambiguous.windows, undefined);
});

test('a logged-out Claude Code account can still show its independently matched Desktop quota', async () => {
  const now = 2_000_000_000_000;
  const home = claudeHome(
    { accountUuid: 'acct-primary', organizationUuid: 'org-primary' },
    { accessToken: '', refreshToken: '', refreshTokenExpiresAt: now + 60_000 },
  );
  const desktopProfile = profileDir([
    { t: now - 1_000, org: 'org-primary', u: { fh: 0, sd: 100 } },
  ]);
  const loggedOut = new Error('exit 1');
  loggedOut.stdout = '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}';
  const login = await verifiedAccountLoginState({ provider: 'claude', home }, {
    runImpl: async () => { throw loggedOut; },
    now,
  });
  const quota = await providerQuota('claude', home, { desktopProfile, now });

  assert.equal(login.signedIn, false, 'Claude Code login is one fact');
  assert.equal(quota.source, 'desktop', 'Desktop usage is a separate fact');
  assert.equal(quota.windows.find((w) => w.key === 'week').usedPercent, 100);
});

test('an unusable token falls back to identity-matched Desktop data', async () => {
  const now = 2_000_000_000_000;
  const home = claudeHome(
    { accountUuid: 'acct-auth', organizationUuid: 'org-auth' },
    { accessToken: 'expired-token', refreshToken: 'refresh-token' },
  );
  const source = profileDir([{ t: now - 1000, org: 'org-auth', u: { fh: 0, sd: 100 } }]);
  const fail401 = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const q = await accountQuota(home, fail401, source, now);
  assert.equal(q.source, 'desktop');
  assert.equal(q.windows.find((w) => w.key === 'week').usedPercent, 100);
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
