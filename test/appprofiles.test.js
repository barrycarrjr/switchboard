import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  APP_PROFILES,
  appProfileDef,
  chooseOpenProfile,
  describeProfiles,
  discoverProfileDirs,
  looksLikeProfile,
  profileFolderProblem,
  profileLaunchArgs,
} from '../core/appprofiles.js';
import { APPS, launchApp, packageFamilyFromAppId, resolvePackagedExe } from '../core/apps.js';
import { readDesktopOrganization } from '../core/quota.js';

/** A machine with a standard Claude Desktop profile and some folders around it. */
function makeMachine() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-profiles-'));
  const homeDir = path.join(root, 'home');
  const appData = path.join(root, 'appdata');
  const make = (dir, marker) => {
    fs.mkdirSync(dir, { recursive: true });
    if (marker) fs.writeFileSync(path.join(dir, marker), '{}');
    return dir;
  };
  const dirs = {
    standard: make(path.join(appData, 'Claude'), 'Local State'),
    backup: make(path.join(appData, 'Claude.RESET-BACKUP-20240101-1200'), 'Local State'),
    dotFolder: make(path.join(homeDir, '.claude-desktop-work'), 'Local State'),
    neverRun: make(path.join(homeDir, '.claude-desktop-empty'), null),
    cliHome: make(path.join(homeDir, '.claude'), 'Local State'),
  };
  return { root, homeDir, env: { APPDATA: appData }, dirs };
}

test('the standard profile comes first, and only folders the app has run in join it', () => {
  const { homeDir, env, dirs } = makeMachine();
  const found = discoverProfileDirs('claude-desktop', { homeDir, env });

  assert.equal(found[0], dirs.standard, 'the folder the plain Launch button opens leads');
  assert.ok(found.includes(dirs.dotFolder));
  assert.ok(!found.includes(dirs.neverRun), 'a folder with the right name but no data is not a profile');
  assert.ok(!found.includes(dirs.cliHome), "the CLI's own config folder is a different thing");
  assert.ok(!found.includes(dirs.backup), "the app's own backup of the standard profile is not an account");
  assert.equal(found.length, 2, 'nothing else is guessed at');
});

test('a folder added by hand is offered as given, and never twice', () => {
  const { homeDir, env, dirs } = makeMachine();
  const elsewhere = path.join(homeDir, 'somewhere-else');
  fs.mkdirSync(elsewhere);
  const found = discoverProfileDirs('claude-desktop', { homeDir, env, extra: [elsewhere, dirs.standard, dirs.dotFolder] });

  assert.ok(found.includes(elsewhere), 'asking for a folder is the person saying what it is');
  assert.equal(found.filter((d) => d === dirs.standard).length, 1);
  assert.equal(found.filter((d) => d === dirs.dotFolder).length, 1);
});

test('an app with one login per machine offers nothing to choose between', () => {
  assert.equal(appProfileDef('antigravity'), null);
  assert.deepEqual(discoverProfileDirs('antigravity', { homeDir: os.homedir() }), []);
  assert.throws(() => profileLaunchArgs('antigravity', 'C:\\anywhere'), /cannot be opened on a chosen account/);
});

test('a profile is named after the account it is signed in as, never guessed at', () => {
  const accounts = [
    { id: 'claude-default', label: 'Main Account', organizationUuid: 'org-one' },
    { id: 'claude-account-2', label: 'Secondary', organizationUuid: 'org-two' },
  ];
  const orgs = { 'C:\\standard': 'org-one', 'C:\\second': 'org-two', 'C:\\stranger': 'org-nobody' };
  const described = describeProfiles(['C:\\standard', 'C:\\second', 'C:\\stranger', 'C:\\fresh'], {
    accounts,
    organizationOf: (dir) => orgs[dir] ?? null,
    defaultDir: 'C:\\standard',
  });

  assert.deepEqual(described.map((p) => p.label), ['Main Account', 'Secondary', 'stranger', 'fresh']);
  assert.deepEqual(described.map((p) => p.accountId), ['claude-default', 'claude-account-2', null, null]);
  assert.deepEqual(described.map((p) => p.isDefault), [true, false, false, false]);
});

test('an account with no organization on record never matches a profile that has none either', () => {
  const described = describeProfiles(['C:\\one'], {
    accounts: [{ id: 'claude-default', label: 'Main Account', organizationUuid: null }],
    organizationOf: () => null,
    defaultDir: 'C:\\other',
  });
  assert.equal(described[0].accountId, null, 'two unknowns are not a match');
  assert.equal(described[0].label, 'one');
});

test('the button opens the account that is the machine default, and falls back honestly', () => {
  const profiles = [
    { dir: 'C:\\standard', accountId: 'claude-default', isDefault: true },
    { dir: 'C:\\second', accountId: 'claude-account-2', isDefault: false },
  ];
  assert.equal(chooseOpenProfile(profiles, 'claude-account-2').dir, 'C:\\second');
  assert.equal(chooseOpenProfile(profiles, 'claude-default').dir, 'C:\\standard');
  assert.equal(chooseOpenProfile(profiles, 'claude-somewhere-else').dir, 'C:\\standard', 'no match opens the standard profile');
  assert.equal(chooseOpenProfile([{ dir: 'C:\\only', isDefault: false }], null).dir, 'C:\\only');
  assert.equal(chooseOpenProfile([], 'claude-default'), null);
});

test('the folder is passed as one argument, so a folder name can never be re-read as a command', () => {
  const args = profileLaunchArgs('claude-desktop', 'C:\\Jo\'s profiles\\claude & co');
  assert.deepEqual(args, ['--user-data-dir=C:\\Jo\'s profiles\\claude & co']);
});

test('only an empty folder or a profile of the same app is safe to hand an app', () => {
  const { homeDir, dirs } = makeMachine();
  const empty = path.join(homeDir, 'empty');
  fs.mkdirSync(empty);
  const occupied = path.join(homeDir, 'my-documents');
  fs.mkdirSync(occupied);
  fs.writeFileSync(path.join(occupied, 'invoice.pdf'), 'x');

  assert.equal(profileFolderProblem(empty), null);
  assert.equal(profileFolderProblem(dirs.standard), null, 'an existing profile is exactly what we want');
  assert.match(profileFolderProblem(occupied), /already holds something else/);
  assert.match(profileFolderProblem(path.join(homeDir, 'not-there')), /cannot be read/);
});

test('looksLikeProfile wants evidence the app has actually run there', () => {
  const { dirs } = makeMachine();
  assert.equal(looksLikeProfile(dirs.standard), true);
  assert.equal(looksLikeProfile(dirs.backup), true, 'it looks like one; being offered as an account is a separate question');
  assert.equal(looksLikeProfile(dirs.neverRun), false);
});

test('a profile reports the account of its newest usage sample, or nothing at all', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-org-'));
  const write = (name, body) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'plan-usage-history.json'), body);
    return dir;
  };
  const mixed = write('mixed', JSON.stringify({
    samples: [
      { t: 200, org: 'org-newer', u: { fh: 4 } },
      { t: 100, org: 'org-older', u: { fh: 9 } },
      { t: 300, u: { fh: 1 } },
    ],
  }));
  assert.equal(readDesktopOrganization(mixed), 'org-newer', 'a sample with no account cannot outrank one with an account');
  assert.equal(readDesktopOrganization(write('empty', JSON.stringify({ samples: [] }))), null);
  assert.equal(readDesktopOrganization(write('junk', 'not json')), null);
  assert.equal(readDesktopOrganization(path.join(root, 'missing')), null);
});

test('a Windows app id yields a package family only when it really is a packaged app', () => {
  assert.equal(packageFamilyFromAppId('Claude_pzs8sxrjxfjjc!Claude'), 'Claude_pzs8sxrjxfjjc');
  assert.equal(packageFamilyFromAppId('OpenAI.Codex_2p2nqsd0c76g0!App'), 'OpenAI.Codex_2p2nqsd0c76g0');
  assert.equal(packageFamilyFromAppId('com.t3tools.t3code'), null, 'a classic install is not a package');
  assert.equal(packageFamilyFromAppId('D:\\Programs\\Air\\Air.exe'), null);
  assert.equal(packageFamilyFromAppId(''), null);
  assert.equal(packageFamilyFromAppId('what ever_x!App'), null, 'a name outside the allowed characters is refused');
});

test('the program file is only reported when it is genuinely there', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pkg-'));
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'Claude.exe'), 'binary');
  const query = async () => root;

  assert.equal(await resolvePackagedExe('Claude_abc123!Claude', 'app/Claude.exe', { query }), path.join(root, 'app', 'Claude.exe'));
  assert.equal(await resolvePackagedExe('Claude_abc123!Claude', 'app/Missing.exe', { query }), null);
  assert.equal(await resolvePackagedExe('com.classic.install', 'app/Claude.exe', { query }), null);
  assert.equal(await resolvePackagedExe('Claude_abc123!Claude', null, { query }), null);
  assert.equal(await resolvePackagedExe('Claude_abc123!Claude', 'app/Claude.exe', { query: async () => null }), null);
});

test('an app that can only be activated by id refuses arguments rather than dropping them', () => {
  assert.throws(
    () => launchApp({ appId: 'Claude_pzs8sxrjxfjjc!Claude', args: ['--user-data-dir=C:\\second'] }),
    /program file/,
    'silently opening the standard account would be the worst outcome',
  );
});

test('every app that can be opened on an account can also be found on disk', () => {
  for (const [appId, def] of Object.entries(APP_PROFILES)) {
    const app = APPS.find((a) => a.id === appId);
    assert.ok(app, `${appId} is a known app`);
    assert.ok(app.packagedExe || app.exePaths, `${appId} has a program file to run with arguments`);
    assert.ok(typeof def.flag === 'function' && def.flag('C:\\x').includes('C:\\x'), `${appId} names the folder on the command line`);
    assert.ok(def.provider, `${appId} says which accounts it can be matched to`);
  }
});
