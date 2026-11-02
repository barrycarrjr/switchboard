// Codex and Antigravity in a T3 Code environment (core/t3env.js, core/t3env-run.js).
//
// Neither can be lent: OpenAI and Google offer no long-lived subscription token, and copies of
// a sign-in log each other out. So `switchboard t3 setup` gives each machine the same Codex and
// Antigravity entries the main machine has, and reports which accounts still need their
// one-time sign-in there; `switchboard t3 sign-in` runs Codex's device-code sign-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../test-support/tempdir.js';

// This suite saves Switchboard settings through runT3SignIn, so it never touches the real ones,
// even when run on its own with a bare `node --test`.
process.env.APPDATA = tempDir('sb-t3env-');

const {
  codexAccountsFor, mergeT3EnvironmentSettings, inspectScript, parseInspect, signInsFor, codexSignInCommand,
  rememberT3Environment, t3EnvironmentStatus, antigravityProfileName, enabledAntigravityIds,
} = await import('../core/t3env.js');
const { runT3SignIn, usesAntigravity } = await import('../core/t3env-run.js');
const { saveRegistry } = await import('../core/accounts.js');

const B64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const mark = (name, value) => `@@${name}=${B64(value)}`;
const registry = { accounts: [
  { id: 'codex-work', provider: 'codex', label: 'Work', home: 'X:\\u\\.codex-work' },
  { id: 'claude-default', provider: 'claude', label: 'x', home: 'X:\\u\\.claude' },
  { id: 'codex-default', provider: 'codex', label: 'Default', home: 'X:\\u\\.codex' },
] };
const two = codexAccountsFor(registry);

test('the Codex account whose folder is the default .codex uses ~/.codex, whatever its place in the list', () => {
  assert.deepEqual(two, [
    { id: 'codex-work', label: 'Work', relHome: '.codex-t3/work', shadow: true },
    { id: 'codex-default', label: 'Default', relHome: '.codex', shadow: false },
  ]);
  assert.deepEqual(codexAccountsFor({ accounts: [] }), [], 'no Codex account registered: no Codex entry is invented');
});

test('a machine gets one Codex entry per account and an enabled Antigravity entry, as the main machine has', () => {
  const r = mergeT3EnvironmentSettings({}, { home: '/home/u', accounts: [], codexAccounts: two, antigravity: true });
  const inst = r.settings.providerInstances;
  assert.deepEqual(inst.codex, { driver: 'codex', enabled: true, config: { binaryPath: 'codex', homePath: '', shadowHomePath: '', launchArgs: '', customModels: [] } });
  assert.equal(inst.codex_sb_work.config.shadowHomePath, '/home/u/.codex-t3/work');
  assert.equal(inst.codex_sb_work.displayName, 'Codex - Work (Switchboard)');
  assert.deepEqual(inst.antigravity_1, { driver: 'antigravity', enabled: true });
});

test('Codex and Antigravity entries already there are kept as they are, and a rerun changes nothing', () => {
  const current = { providerInstances: {
    mycodex: { driver: 'codex', enabled: false, config: { binaryPath: '/opt/codex', shadowHomePath: '' } },
    ag: { driver: 'antigravity', enabled: true, displayName: 'Mine' },
  } };
  const plainOnly = two.filter((a) => !a.shadow);
  const r = mergeT3EnvironmentSettings(current, { home: '/home/u', accounts: [], codexAccounts: plainOnly, antigravity: true });
  assert.deepEqual(r.settings.providerInstances, { ...current.providerInstances, claudeAgent_sb_any: r.settings.providerInstances.claudeAgent_sb_any });
  const again = mergeT3EnvironmentSettings(r.settings, { home: '/home/u', accounts: [], codexAccounts: two, antigravity: true });
  const third = mergeT3EnvironmentSettings(again.settings, { home: '/home/u', accounts: [], codexAccounts: two, antigravity: true });
  assert.deepEqual(third.changes, []);
});

test('a turned-off Antigravity entry stays off and no second one is added on each run', () => {
  const current = { providerInstances: { antigravity_1: { driver: 'antigravity', enabled: false } } };
  const r = mergeT3EnvironmentSettings(current, { home: '/home/u', accounts: [], antigravity: true });
  assert.deepEqual(Object.keys(r.settings.providerInstances).filter((k) => k.startsWith('antigravity')), ['antigravity_1']);
  assert.equal(r.settings.providerInstances.antigravity_1.enabled, false);
});

test('a hand-made Codex entry on its own folder is reported, not treated as the ~/.codex one', () => {
  const current = { providerInstances: { codex: { driver: 'codex', config: { homePath: '/home/u/.codex-other', shadowHomePath: '' } } } };
  const r = mergeT3EnvironmentSettings(current, { home: '/home/u', accounts: [], codexAccounts: two.filter((a) => !a.shadow) });
  assert.ok(r.settings.providerInstances.codex_sb_default, 'the account on ~/.codex gets its own entry');
  assert.match(r.leftovers.find((l) => l.id === 'codex').note, /own folder \(\/home\/u\/\.codex-other\); its sign-in is not checked/);
});

test('without the new options the merge adds no Codex or Antigravity entry', () => {
  const r = mergeT3EnvironmentSettings({}, { home: '/home/u', accounts: [] });
  assert.deepEqual(Object.keys(r.settings.providerInstances), ['claudeAgent_sb_any']);
});

test('inspection asks Codex about each account in that account\'s folder, and refuses an unexpected folder', () => {
  const s = inspectScript({ codexHomes: ['.codex', '.codex-t3/work'] });
  assert.match(s, /CODEX_HOME="\$HOME\/\.codex" timeout 15 "\$cx" login status <\/dev\/null 2>&1/);
  assert.match(s, /CODEX_HOME="\$HOME\/\.codex-t3\/work"/);
  assert.match(s, /\$HOME\/\.local\/bin\/codex/, 'the usual install place is tried, as T3 finds it');
  assert.throws(() => inspectScript({ codexHomes: ['../../etc'] }), /unexpected Codex folder/);
});

test('inspection output gives each Codex account\'s state and which Antigravity profiles are signed in', () => {
  const r = parseInspect([mark('home', '/home/u'), mark('codexbin', '/usr/local/bin/codex'), mark('codexstatus', '.codex signed-in'),
    mark('codexstatus', '.codex-t3/work unknown'), mark('agtoken', 'abc'), mark('settingssha', 'none'), mark('done', '1')].join('\n'));
  assert.equal(r.codexBin, '/usr/local/bin/codex');
  assert.deepEqual(r.codexStatus, { '.codex': 'signed-in', '.codex-t3/work': 'unknown' });
  assert.deepEqual(r.antigravityTokenProfiles, ['abc']);
});

test('the sign-in list says, per account, whether it is done, missing, unknown, or Codex is not installed', () => {
  const t = { id: 'ssh:w', kind: 'ssh', name: 'w' };
  const insp = { codexBin: '/c', codexStatus: { '.codex': 'signed-in', '.codex-t3/work': 'not-signed-in' }, antigravityTokenProfiles: [] };
  const list = signInsFor(t, insp, two, { antigravityIds: ['antigravity_1'] });
  assert.deepEqual(list.map((x) => [x.what, x.state]), [['Codex (Work)', 'needs-sign-in'], ['Codex', 'signed-in'], ['Antigravity', 'needs-sign-in']]);
  assert.match(list[0].how, /switchboard t3 sign-in ssh:w.*mkdir -p ~\/\.codex-t3\/work && CODEX_HOME=~\/\.codex-t3\/work codex login --device-auth.*Security/);
  const unknown = signInsFor(t, { ...insp, codexStatus: { '.codex': 'unknown' } }, two.filter((a) => !a.shadow));
  assert.equal(unknown[0].state, 'unknown', 'a state Codex could not give is not guessed as signed out');
  const none = signInsFor(t, { codexBin: null, codexStatus: {}, antigravityTokenProfiles: [] }, two.slice(0, 1));
  assert.deepEqual(none.map((x) => x.state), ['not-installed'], 'no Antigravity row when it is not in use');
});

test('Antigravity counts as signed in only when an enabled entry\'s own profile holds the token', () => {
  const t = { id: 'ssh:w', kind: 'ssh', name: 'w' };
  assert.equal(antigravityProfileName('antigravity_1').slice(0, 8), 'b6f03d61', 'T3 names the profile by a hash of the entry id');
  const settings = { providerInstances: { antigravity_1: { driver: 'antigravity', enabled: false }, antigravity_1_2: { driver: 'antigravity', enabled: true } } };
  const ids = enabledAntigravityIds(settings);
  assert.deepEqual(ids, ['antigravity_1_2']);
  const [onOther] = signInsFor(t, { codexStatus: {}, antigravityTokenProfiles: [antigravityProfileName('antigravity_1')] }, [], { antigravityIds: ids });
  assert.equal(onOther.state, 'needs-sign-in', 'a token on the turned-off entry does not count');
  const [ok] = signInsFor(t, { codexStatus: {}, antigravityTokenProfiles: [antigravityProfileName('antigravity_1_2')] }, [], { antigravityIds: ids });
  assert.equal(ok.state, 'signed-in');
});

test('where T3 has not installed its Antigravity program yet, the step says to install it first', () => {
  const [ag] = signInsFor({ id: 'ssh:w', kind: 'ssh', name: 'w' }, { codexStatus: {}, antigravityTokenProfiles: [], antigravityRuntime: false }, [], { antigravityIds: ['antigravity_1'] });
  assert.equal(ag.state, 'not-installed');
  assert.match(ag.how, /Install first, then Sign in/);
});

test('the Codex sign-in command runs on the target attached to this terminal, with the account\'s folder', () => {
  assert.deepEqual(codexSignInCommand({ kind: 'wsl', name: 'Ubuntu' }, { codexBin: '/usr/bin/codex', home: '/home/u', relHome: '.codex' }),
    { file: 'wsl.exe', args: ['-d', 'Ubuntu', '--exec', 'env', 'CODEX_HOME=/home/u/.codex', '/usr/bin/codex', 'login', '--device-auth'] });
  const ssh = codexSignInCommand({ kind: 'ssh', name: 'w' }, { codexBin: '/usr/local/bin/codex', home: '/home/u', relHome: '.codex-t3/work' });
  assert.equal(ssh.file, 'ssh');
  assert.ok(ssh.args.includes('-t'), 'a terminal, so Codex can show its code');
  assert.equal(ssh.args.at(-1), "CODEX_HOME='/home/u/.codex-t3/work' '/usr/local/bin/codex' login --device-auth");
  assert.throws(() => codexSignInCommand({ kind: 'ssh', name: 'w' }, { codexBin: '/x; rm -rf ~', home: '/home/u', relHome: '.codex' }), /not usable/);
});

test('an environment with sign-ins still to do says which, without counting as broken; a run that did not ask keeps the list', () => {
  const U = { id: 'wsl:U', kind: 'wsl', name: 'U' };
  let s = rememberT3Environment({}, U, {
    ok: true, reached: true, accounts: [], proof: [], signInsChecked: true, codexAccountIds: ['codex-default'], antigravity: true,
    signIns: [{ what: 'Codex', state: 'needs-sign-in' }, { what: 'Antigravity', state: 'signed-in' }],
  }, { leaseSha: 'v1' });
  const [e] = t3EnvironmentStatus(s, { leaseSha: 'v1', codexIds: ['codex-default'], antigravity: true });
  assert.equal(e.state, 'ok');
  assert.deepEqual(e.signInsMissing, ['Codex']);
  assert.match(e.detail, /still to sign in: Codex/);
  s = rememberT3Environment(s, U, { ok: false, reached: true, error: 'broker gone', accounts: [], proof: [], signIns: [] }, { leaseSha: 'v1' });
  assert.deepEqual(s.t3Environments['wsl:U'].signInsMissing, ['Codex'], 'a run stopped early does not wipe the list');
});

test('an environment set up before Codex and Antigravity were added, or missing a new Codex account, reads as out of date', () => {
  const U = { id: 'wsl:U', kind: 'wsl', name: 'U' };
  const old = rememberT3Environment({}, U, { ok: true, reached: true, accounts: [], proof: [] }, { leaseSha: 'v1' });
  const [e] = t3EnvironmentStatus(old, { leaseSha: 'v1', codexIds: ['codex-default'], antigravity: true });
  assert.equal(e.state, 'stale');
  assert.match(e.detail, /no Codex entry yet for codex-default; no Antigravity entry yet/);
});

test('Antigravity is set up elsewhere only when it is in use on this machine', () => {
  const dir = tempDir('sb-t3env-');
  const t3File = path.join(dir, 'settings.json');
  fs.writeFileSync(t3File, JSON.stringify({ providerInstances: { antigravity_1: { driver: 'antigravity', enabled: true } } }));
  assert.equal(usesAntigravity({ t3File, settings: { lanes: [] } }), true);
  fs.writeFileSync(t3File, JSON.stringify({ providerInstances: { antigravity: { driver: 'antigravity', enabled: false } } }));
  assert.equal(usesAntigravity({ t3File, settings: { lanes: [] } }), false);
  assert.equal(usesAntigravity({ t3File, settings: { lanes: [{ harness: 'antigravity' }] } }), true);
});

test('t3 sign-in makes the folder, runs Codex\'s sign-in only for the accounts that need it, then asks the machine again', async () => {
  saveRegistry({ accounts: [{ id: 'codex-default', provider: 'codex', label: 'Default', home: 'X:\\u\\.codex' }] });
  let asked = 0;
  const scripts = [];
  const run = async (_t, script) => {
    scripts.push(script);
    if (!script.includes('emit codexbin')) return { stdout: '' };
    asked += 1;
    const status = asked === 1 ? 'not-signed-in' : 'signed-in';
    const t3 = JSON.stringify({ providerInstances: { antigravity_1: { driver: 'antigravity', enabled: true } } });
    return { stdout: [mark('home', '/home/u'), mark('codexbin', '/usr/bin/codex'), mark('codexstatus', `.codex ${status}`), mark('t3', 'yes'), mark('settings', t3), mark('settingssha', 'x'), mark('done', '1')].join('\n') };
  };
  const spawned = [];
  const spawnImpl = (file, args) => {
    spawned.push([file, ...args]);
    return { on(ev, cb) { if (ev === 'close') setImmediate(() => cb(0)); } };
  };
  const lines = [];
  const res = await runT3SignIn('ssh:w', { run, spawnImpl, antigravity: true, onProgress: (l) => lines.push(l), resolve: async () => [{ id: 'ssh:w', kind: 'ssh', name: 'w' }] });
  assert.ok(scripts.some((sc) => sc.includes('mkdir -p "$HOME/.codex"')), 'the folder is made before Codex is pointed at it');
  assert.equal(spawned.length, 1);
  assert.equal(asked, 2, 'asked again after signing in');
  assert.deepEqual(res.codex.map((x) => x.state), ['signed-in']);
  assert.equal(res.antigravity.state, 'needs-sign-in', 'Antigravity is reported, not counted against this command');
});

test('t3 sign-in does not ask the machine twice when there was nothing to sign in', async () => {
  saveRegistry({ accounts: [{ id: 'codex-default', provider: 'codex', label: 'Default', home: 'X:\\u\\.codex' }] });
  let asked = 0;
  const run = async () => { asked += 1; return { stdout: [mark('home', '/home/u'), mark('codexbin', '/usr/bin/codex'), mark('codexstatus', '.codex signed-in'), mark('settingssha', 'none'), mark('done', '1')].join('\n') }; };
  const res = await runT3SignIn('ssh:w', { run, spawnImpl: () => { throw new Error('nothing to run'); }, antigravity: false, resolve: async () => [{ id: 'ssh:w', kind: 'ssh', name: 'w' }] });
  assert.equal(asked, 1);
  assert.equal(res.antigravity, null);
});

test('a saved list of missing sign-ins says how old it is', () => {
  const U = { id: 'wsl:U', kind: 'wsl', name: 'U' };
  const s = rememberT3Environment({}, U, { ok: true, reached: true, accounts: [], proof: [], signInsChecked: true, codexAccountIds: [], antigravity: true, signIns: [{ what: 'Antigravity', state: 'needs-sign-in' }] }, { leaseSha: 'v1', now: 1_000_000_000 });
  const [e] = t3EnvironmentStatus(s, { leaseSha: 'v1', antigravity: true, now: 1_000_000_000 + 51 * 60000 });
  assert.match(e.detail, /still to sign in: Antigravity \(checked 51 min ago\)/);
});

test('t3 status asks every machine now, saves what it hears, and marks one that did not answer', async () => {
  const { saveSettings, loadSettings } = await import('../core/settings.js');
  const { rememberSignIns } = await import('../core/t3env.js');
  const { liveT3Status } = await import('../core/t3env-run.js');
  saveRegistry({ accounts: [{ id: 'codex-default', provider: 'codex', label: 'Default', home: '/u/.codex' }] });
  const env = (id, kind, name) => ({ id, kind, name, lastOk: true, lastSetupAt: Date.now() - 3600000, accounts: [], codexAccounts: ['codex-default'], antigravity: false, signInsMissing: ['Codex'], signInsCheckedAt: Date.now() - 3600000 });
  saveSettings({ ...loadSettings(), t3Environments: { 'wsl:U': env('wsl:U', 'wsl', 'U'), 'ssh:w': env('ssh:w', 'ssh', 'w') } });
  const run = async (t) => (t.kind === 'ssh'
    ? { stdout: '', stderr: 'ssh: connect to host w port 22: Connection refused' }
    : { stdout: [mark('home', '/home/u'), mark('codexbin', '/usr/bin/codex'), mark('codexstatus', '.codex signed-in'), mark('settingssha', 'none'), mark('done', '1')].join('\n') });
  const list = await liveT3Status({ run, antigravity: false, resolve: async (ids) => ids.map((id) => ({ id, kind: id.split(':')[0], name: id.split(':')[1] })) });
  const u = list.find((e) => e.id === 'wsl:U');
  const w = list.find((e) => e.id === 'ssh:w');
  assert.equal(u.reached, true);
  assert.doesNotMatch(u.detail, /still to sign in/, 'the fresh reading replaced the old note');
  assert.deepEqual(loadSettings().t3Environments['wsl:U'].signInsMissing, [], 'and was saved, for the Gateway tab and Health');
  assert.equal(w.reached, false);
  assert.match(w.detail, /still to sign in: Codex \(checked .* ago\); .*could not reach it just now/);
  assert.equal(rememberSignIns({}, 'nope', []).t3Environments, undefined, 'an environment not remembered is not created');
});

test('a machine without Node.js is told to install it before Antigravity, with the command for its system', async () => {
  const { nodeInstallCommand } = await import('../core/t3env.js');
  const t = { id: 'ssh:w', kind: 'ssh', name: 'w' };
  const base = { codexStatus: {}, antigravityTokenProfiles: [], antigravityRuntime: false, osFamily: 'ubuntu debian' };
  const [noNode] = signInsFor(t, { ...base, nodeState: 'missing' }, [], { antigravityIds: ['antigravity_1'] });
  assert.equal(noNode.state, 'not-installed');
  assert.match(noNode.how, /^install Node\.js on that machine first \(curl -fsSL https:\/\/deb\.nodesource\.com\/setup_22\.x -o \/tmp\/nodesource_setup\.sh && sudo -E bash \/tmp\/nodesource_setup\.sh && sudo apt-get install -y nodejs\), then in T3, .*Install first, then Sign in/);
  for (const nodeState of ['found', 'unknown', null]) {
    const [row] = signInsFor(t, { ...base, nodeState }, [], { antigravityIds: ['antigravity_1'] });
    assert.doesNotMatch(row.how, /Node\.js/, `no Node.js advice when node is ${nodeState}: a check that could not tell is not a "no"`);
  }
  const [installed] = signInsFor(t, { ...base, nodeState: 'missing', antigravityRuntime: true }, [], { antigravityIds: ['antigravity_1'] });
  assert.equal(installed.state, 'needs-sign-in', 'T3 installed Antigravity, so it found Node.js, whatever the probe says');
  assert.doesNotMatch(installed.how, /Node\.js/);
  const [done] = signInsFor(t, { ...base, nodeState: 'missing', antigravityTokenProfiles: [antigravityProfileName('antigravity_1')] }, [], { antigravityIds: ['antigravity_1'] });
  assert.equal(done.state, 'signed-in');
  const [codex] = signInsFor(t, { ...base, codexBin: null, nodeState: 'missing' }, two.filter((a) => !a.shadow));
  assert.match(codex.how, /^install Node\.js first \(.*\), then install Codex/, 'npm needs Node.js, so the Codex step says so first');
  assert.match(nodeInstallCommand('fedora'), /rpm\.nodesource\.com.*-o \/tmp\/nodesource_setup\.sh && .*dnf install -y nodejs/);
  assert.equal(nodeInstallCommand('arch'), 'Node.js 22 from https://nodejs.org');
});
