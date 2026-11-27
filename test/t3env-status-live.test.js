// `switchboard t3 status` asking each machine about its Codex and Antigravity sign-ins
// (core/t3env-run.js liveT3Status, runT3SignIn; core/t3env.js rememberSignIns).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../test-support/tempdir.js';

// Settings are written through dataDir(), so this suite never touches the real ones, even when
// run on its own with a bare `node --test`.
process.env.APPDATA = tempDir('sb-t3env-');

const { rememberSignIns, missingSignIns } = await import('../core/t3env.js');
const { liveT3Status, runT3SignIn } = await import('../core/t3env-run.js');
const { saveRegistry } = await import('../core/accounts.js');
const { saveSettings, loadSettings, settingsFile } = await import('../core/settings.js');

const B64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const mark = (name, value) => `@@${name}=${B64(value)}`;
const answer = (codex) => ({ stdout: [mark('home', '/home/u'), mark('t3', 'yes'), mark('codexbin', '/usr/bin/codex'), mark('codexstatus', `.codex ${codex}`), mark('settingssha', 'none'), mark('done', '1')].join('\n') });
const env = (id) => ({ id, kind: id.split(':')[0], name: id.split(':')[1], lastOk: true, lastSetupAt: Date.now() - 3600000, accounts: [], codexAccounts: ['codex-default'], antigravity: false, signInsMissing: ['Codex'], signInsCheckedAt: Date.now() - 3600000 });

function reset(envIds = ['wsl:U']) {
  saveRegistry({ accounts: [{ id: 'codex-default', provider: 'codex', label: 'Default', home: '/u/.codex' }] });
  saveSettings({ ...loadSettings(), t3Environments: Object.fromEntries(envIds.map((id) => [id, env(id)])) });
}

test('a settings file that cannot be read while the machines are asked is never replaced by defaults', async () => {
  reset();
  const run = async () => {
    fs.writeFileSync(settingsFile(), '{ not json');
    return answer('signed-in');
  };
  await liveT3Status({ run, antigravity: false });
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), '{ not json');
});

test('a machine that does not answer keeps its reading and gets the reason recorded', async () => {
  reset(['ssh:w']);
  const [w] = await liveT3Status({ run: async () => ({ stdout: '', stderr: 'Host key verification failed.' }), antigravity: false });
  assert.equal(w.reached, false);
  assert.match(w.detail, /still to sign in: Codex \(checked 1 h ago\).*could not reach it just now \(Host key verification failed\.\)/);
  assert.equal(loadSettings().t3Environments['ssh:w'].lastAttemptError, 'Host key verification failed.');
});

test('a machine whose T3 settings cannot be read gives no reading, so Antigravity is not dropped from the list', async () => {
  reset();
  const run = async () => ({ stdout: [mark('home', '/home/u'), mark('t3', 'yes'), mark('settings', '{x'), mark('settingssha', 'abc'), mark('done', '1')].join('\n') });
  const [u] = await liveT3Status({ run, antigravity: true });
  assert.equal(u.reached, false);
  assert.deepEqual(loadSettings().t3Environments['wsl:U'].signInsMissing, ['Codex']);
});

test('with nothing to ask (no Codex account, Antigravity not in use) no machine is contacted', async () => {
  reset();
  saveRegistry({ accounts: [] });
  let calls = 0;
  const [u] = await liveT3Status({ run: async () => { calls += 1; return answer('signed-in'); }, antigravity: false });
  assert.equal(calls, 0);
  assert.equal(u.reached, true);
  assert.deepEqual(loadSettings().t3Environments['wsl:U'].signInsMissing, []);
});

test('a Codex state that could not be read keeps what was known about it before', () => {
  const unknown = [{ what: 'Codex', state: 'unknown' }, { what: 'Antigravity', state: 'needs-sign-in' }];
  assert.deepEqual(missingSignIns(unknown, ['Codex']), ['Codex', 'Antigravity']);
  assert.deepEqual(missingSignIns(unknown, []), ['Antigravity']);
});

test('a reading older than the one saved does not replace it', () => {
  const s = { t3Environments: { 'wsl:U': { id: 'wsl:U', signInsMissing: [], signInsCheckedAt: 2000 } } };
  assert.equal(rememberSignIns(s, 'wsl:U', [{ what: 'Codex', state: 'needs-sign-in' }], { now: 1000 }), s);
  assert.deepEqual(rememberSignIns(s, 'wsl:U', [{ what: 'Codex', state: 'needs-sign-in' }], { now: 3000 }).t3Environments['wsl:U'].signInsMissing, ['Codex']);
});

test('t3 sign-in saves what it finds even when there is nothing to sign in', async () => {
  reset(['ssh:w']);
  const before = loadSettings().t3Environments['ssh:w'].signInsCheckedAt;
  const res = await runT3SignIn('ssh:w', {
    run: async () => answer('signed-in'), spawnImpl: () => { throw new Error('nothing to run'); }, antigravity: false,
    resolve: async () => [{ id: 'ssh:w', kind: 'ssh', name: 'w' }],
  });
  assert.deepEqual(res.codex.map((x) => x.state), ['signed-in']);
  const after = loadSettings().t3Environments['ssh:w'];
  assert.deepEqual(after.signInsMissing, [], 'the stale note about Codex is cleared');
  assert.ok(after.signInsCheckedAt > before, 'with the time of this reading');
});

test('the start-up refresh acts on this machine when its wrapper folders hold what Switchboard does not write', async () => {
  const { currentT3Status, environmentsToRefresh, currentLocalWrapperFolders } = await import('../core/t3env-run.js');
  const local = { id: 'local', kind: 'local', name: 'this computer', lastOk: true, lastSetupAt: Date.now(), accounts: [], codexAccounts: ['codex-default'], antigravity: false };
  const other = { ...env('wsl:U'), signInsMissing: [] };
  const settings = { ...loadSettings(), t3Environments: { local, 'wsl:U': other } };
  const status = (localFolders) => currentT3Status({ settings, antigravity: false, localFolders });

  // Its lease client is this version's, so the folders are the only reason to touch it.
  assert.deepEqual(environmentsToRefresh(status({ takenOver: [], extras: [] })), []);
  assert.deepEqual(environmentsToRefresh(status({ takenOver: [], extras: ['switchboard-lease'] })).map((e) => e.id), ['local']);
  const taken = environmentsToRefresh(status({ takenOver: ['switchboard-lease'], extras: ['switchboard-lease'] }));
  assert.deepEqual(taken.map((e) => [e.id, e.state]), [['local', 'failed']], 'the case that matters most: T3 is running a real Claude there');
  assert.deepEqual(environmentsToRefresh(status(null)), [], 'folders that were not looked at start nothing');

  assert.equal(currentLocalWrapperFolders({ t3Environments: { 'wsl:U': other } }), null, 'nothing is read where this machine\'s own T3 was never set up');
});

test('the status list, Health and the start-up refresh each look in this machine\'s wrapper folders for themselves', async () => {
  const { currentT3Status, t3HealthInputs, refreshStaleT3Environments } = await import('../core/t3env-run.js');
  const { localPaths, localWrapperFiles, localCmdText } = await import('../core/t3local.js');
  const home = tempDir('sb-t3env-');
  const w = localWrapperFiles(localPaths(home).root, 'switchboard-lease');
  const bin = path.join(path.dirname(w.cli), 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(w.cmd, localCmdText());
  fs.writeFileSync(w.cli, 'the wrapper');
  fs.writeFileSync(path.join(bin, 'claude.exe'), 'a real claude');
  const local = { id: 'local', kind: 'local', name: 'this computer', lastOk: true, lastSetupAt: Date.now(), accounts: [], codexAccounts: ['codex-default'], antigravity: false };
  const settings = { ...loadSettings(), t3Environments: { local } };
  const status = () => currentT3Status({ settings, antigravity: false, home });

  // Nothing is handed in about the folders: each of these reads them, which is the point. T3
  // shows such an entry as healthy, so if one of these stopped looking nobody would be told.
  const [row] = status();
  assert.equal(row.state, 'failed');
  assert.match(row.detail, /^T3 Code starts a copy of Claude found in switchboard-lease/);
  assert.deepEqual(t3HealthInputs({ settings, home }).t3LocalFolders, { takenOver: ['switchboard-lease'], extras: ['switchboard-lease'] });

  const ran = [];
  const reports = await refreshStaleT3Environments({
    status,
    resolve: async (ids) => ids.map((id) => ({ id })),
    setup: async (targets, opts) => { ran.push([targets.map((t) => t.id), opts]); return ['its report']; },
  });
  assert.deepEqual(ran, [[['local'], { refreshOnly: true }]], 'a refresh, never a full setup');
  assert.deepEqual(reports, ['its report']);

  fs.rmSync(bin, { recursive: true });
  assert.equal(status()[0].state, 'ok');
  assert.deepEqual(await refreshStaleT3Environments({ status, setup: async () => { throw new Error('there is nothing to refresh'); } }), []);
});

test('setup --all finds every remembered environment again, this computer included', async () => {
  const { resolveTargets } = await import('../core/t3env-run.js');
  const { rememberT3Environment, parseT3Target } = await import('../core/t3env.js');
  const report = { ok: true, reached: true, accounts: [], proof: [] };
  let settings = {};
  for (const target of [parseT3Target('local'), parseT3Target('wsl:Ubuntu', ['Ubuntu']), parseT3Target('ssh:box')]) {
    settings = rememberT3Environment(settings, target, report, { leaseSha: 'v1' });
  }
  // This machine is remembered as the bare word `local`; rebuilt from its kind and name it was
  // "local:this computer", which names nothing and stopped --all for every environment.
  const targets = await resolveTargets([], { all: true, settings, wslDistros: ['Ubuntu'] });
  assert.deepEqual(targets.map((t) => [t.id, t.kind]), [['local', 'local'], ['wsl:Ubuntu', 'wsl'], ['ssh:box', 'ssh']]);
});

test('the how-to for each sign-in still to do is saved per account and shown by status', async () => {
  const { signInsTodo, t3EnvironmentStatus } = await import('../core/t3env.js');
  const rows = [
    { provider: 'codex', account: 'codex-work', what: 'Codex (Work)', state: 'signed-in', how: 'a' },
    { provider: 'codex', account: 'codex-work-2', what: 'Codex (Work)', state: 'needs-sign-in', how: 'CODEX_HOME=~/.codex-t3/work_2 codex login --device-auth' },
    { provider: 'antigravity', account: 'antigravity', what: 'Antigravity', state: 'not-installed', how: 'install Node.js on that machine first (x), then in T3' },
  ];
  const todo = signInsTodo(rows);
  assert.deepEqual(todo.map((x) => x.key), ['codex:codex-work-2', 'antigravity:antigravity'], 'two accounts with one label keep their own advice');
  assert.match(todo[0].how, /work_2/);
  const unknown = signInsTodo([{ provider: 'codex', account: 'codex-default', what: 'Codex', state: 'unknown', how: 'Codex there could not say' }], { signInsMissing: ['Codex'] });
  assert.deepEqual(unknown.map((x) => x.how), ['Codex there could not say'], 'an unreadable state keeps the item, with this reading\'s own honest advice, also for a record saved before');
  const s = rememberSignIns({ t3Environments: { 'wsl:U': { id: 'wsl:U', lastOk: true } } }, 'wsl:U', rows, { now: 5 });
  const [e] = t3EnvironmentStatus(s, { now: 5 });
  assert.deepEqual(e.signInsTodo.map((x) => x.what), ['Codex (Work)', 'Antigravity']);
  assert.deepEqual(e.signInsMissing, ['Codex (Work)', 'Antigravity']);
});
