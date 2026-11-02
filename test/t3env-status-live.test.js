// `switchboard t3 status` asking each machine about its Codex and Antigravity sign-ins
// (core/t3env-run.js liveT3Status, runT3SignIn; core/t3env.js rememberSignIns).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
