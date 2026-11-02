// Pointing a T3 Code environment at the broker's Claude accounts (core/t3env.js).
//
// The scripts that run on the target are checked two ways: here, by what they contain and by
// feeding the planner the output they would print; and in t3env-scripts.test.js, by running
// them under bash against a throwaway home (POSIX only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseT3Target, lendableClaudeAccounts, accountWrapperName, accountWrapperScript, wrapperAccountId,
  t3HubSourceId, t3HubSecretFileName, mergeT3EnvironmentSettings, inspectScript, applyScript, proveScript,
  parseInspect, parseProve, parseMarkedOutput, targetCommand, setupT3Environment, rememberT3Environment,
  t3EnvironmentStatus, keyForEnvironment, ANY_ACCOUNT_INSTANCE_ID, sha256,
  forgetT3Environment, T3_KEY_PURPOSE,
} from '../core/t3env.js';
import { laneTokenState } from '../core/lane-tokens.js';
import { chooseProvisionKey } from '../core/gateway-keys.js';

const B64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const mark = (name, value) => `@@${name}=${B64(value)}`;

const registry = {
  accounts: [
    { id: 'claude-default', provider: 'claude', label: 'first', color: '#2563eb', home: '/x/.claude' },
    { id: 'claude-account-2', provider: 'claude', label: 'second', color: '#e7eb25', home: '/x/.claude-account-2' },
    { id: 'claude-third', provider: 'claude', label: 'third', color: null, home: '/x/.claude-third' },
    { id: 'codex-default', provider: 'codex', label: 'Default', home: '/x/.codex' },
  ],
};
const settingsWithTokens = {
  gateway: { enabled: true, port: 8318, scope: 'lan' },
  lanes: [
    { id: 'lane-a', accountId: 'claude-default', harness: 'claude' },
    { id: 'lane-b', accountId: 'claude-account-2', harness: 'claude' },
    { id: 'lane-c', accountId: 'claude-third', harness: 'claude' },
    { id: 'lane-x', accountId: 'codex-default', harness: 'codex' },
  ],
  laneTokens: {
    'lane-a': { token: 'tok-a' },
    'lane-b': { token: 'tok-b' },
    'lane-c': { token: 'tok-c' },
  },
  gatewayKeys: {},
};
// The broker's own rule needs real sign-in folders; these tests stand in a live-token check.
const liveIn = (getSettings) => (lane) => laneTokenState(getSettings(), lane.id) === 'live';
const lendable = lendableClaudeAccounts(registry, settingsWithTokens, { canLend: liveIn(() => settingsWithTokens) }).lendable;

test('a target is read as wsl or ssh, and a bare name is a WSL distro only when one exists', () => {
  assert.deepEqual(parseT3Target('wsl:Ubuntu'), { id: 'wsl:Ubuntu', kind: 'wsl', name: 'Ubuntu' });
  assert.deepEqual(parseT3Target('ssh:worker01'), { id: 'ssh:worker01', kind: 'ssh', name: 'worker01' });
  assert.equal(parseT3Target('ubuntu', ['Ubuntu']).id, 'wsl:Ubuntu');
  assert.equal(parseT3Target('worker01', ['Ubuntu']).id, 'ssh:worker01');
  assert.equal(parseT3Target('me@10.0.0.5').id, 'ssh:me@10.0.0.5');
});

test('a target name that could change the ssh or wsl command is refused', () => {
  for (const bad of ['ssh:-oProxyCommand=x', 'ssh:a b', 'wsl:x;rm', 'ssh:', '']) {
    assert.throws(() => parseT3Target(bad), /not a usable environment name/, bad);
  }
});

test('only Claude accounts with a lane holding a live token can be lent, and the rest say why', () => {
  const s = structuredClone(settingsWithTokens);
  s.laneTokens['lane-b'] = { token: 'tok-b', dead: true };
  s.lanes = s.lanes.filter((l) => l.id !== 'lane-c');
  const { lendable: ok, skipped } = lendableClaudeAccounts(registry, s, { canLend: liveIn(() => s) });
  assert.deepEqual(ok.map((a) => a.id), ['claude-default']);
  assert.match(skipped.find((x) => x.id === 'claude-account-2').reason, /dead/);
  assert.match(skipped.find((x) => x.id === 'claude-third').reason, /no lane/);
  assert.ok(!skipped.some((x) => x.id === 'codex-default'), 'other providers are not Claude accounts at all');
});

test('wrapper names drop the claude- prefix, and the wrapper sets the account and runs the lease wrapper', () => {
  assert.equal(accountWrapperName('claude-default'), 't3-claude-default');
  assert.equal(accountWrapperName('work'), 't3-claude-work');
  assert.throws(() => accountWrapperName('a b'));
  const text = accountWrapperScript({ id: 'claude-default', label: 'first' });
  assert.match(text, /^#!\/usr\/bin\/env bash\n/);
  assert.match(text, /^export SWITCHBOARD_ACCOUNT=claude-default$/m);
  assert.match(text, /^exec "\$HOME\/\.local\/bin\/switchboard-lease" "\$@"$/m);
  assert.equal(wrapperAccountId(text), 'claude-default');
});

test('the account a hand-written wrapper names is read whatever its quoting', () => {
  assert.equal(wrapperAccountId('#!/bin/bash\nexport SWITCHBOARD_ACCOUNT=claude-account-2\nexec x'), 'claude-account-2');
  assert.equal(wrapperAccountId('SWITCHBOARD_ACCOUNT="claude-x"'), 'claude-x');
  assert.equal(wrapperAccountId("  export SWITCHBOARD_ACCOUNT='a.b'"), 'a.b');
  assert.equal(wrapperAccountId('exec switchboard-lease'), null);
});

test('the quota hub id and key file name are the ones T3 Code itself would use', () => {
  assert.equal(t3HubSourceId('http://192.0.2.10:8318', {}), 'cliproxy-192.0.2.10-8318');
  assert.equal(t3HubSourceId('http://192.0.2.10:8318', { 'cliproxy-192.0.2.10-8318': { url: 'http://other' } }), 'cliproxy-192.0.2.10-8318-2');
  assert.equal(t3HubSourceId('http://192.0.2.10:8318', { mine: { url: 'http://192.0.2.10:8318' } }), 'mine');
  assert.equal(t3HubSecretFileName('cliproxy-192.0.2.10-8318'), `usage-limit-source-${Buffer.from('cliproxy-192.0.2.10-8318').toString('base64url')}.bin`);
});

test('a fresh T3 settings file gets one provider per account, an any-account provider and the hub', () => {
  const r = mergeT3EnvironmentSettings({ favorites: [1] }, { home: '/home/u', accounts: lendable, hubUrl: 'http://192.0.2.10:8318' });
  const inst = r.settings.providerInstances;
  assert.deepEqual(r.settings.favorites, [1], 'other settings are kept');
  assert.equal(inst.claudeAgent_sb_default.config.binaryPath, '/home/u/.local/bin/t3-claude-default');
  assert.equal(inst.claudeAgent_sb_default.config.homePath, '', 'claude there uses its own config, as the plain command does');
  assert.equal(inst.claudeAgent_sb_default.accentColor, '#2563eb');
  assert.equal(inst.claudeAgent_sb_default.displayName, 'Claude - first (Switchboard)');
  assert.equal(inst.claudeAgent_sb_third.accentColor, undefined, 'no color is invented');
  assert.equal(inst[ANY_ACCOUNT_INSTANCE_ID].config.binaryPath, '/home/u/.local/bin/switchboard-lease');
  assert.deepEqual(r.settings.usageLimitSources['cliproxy-192.0.2.10-8318'], {
    kind: 'cliproxy', label: 'Switchboard', url: 'http://192.0.2.10:8318', managementKey: '\u2022'.repeat(6), enabled: true,
  });
  assert.equal(r.hubId, 'cliproxy-192.0.2.10-8318');
  assert.deepEqual(r.leftovers, []);
});

test('entries made by hand are adopted with their ids, names and colors, so conversations on them keep working', () => {
  const current = {
    providerInstances: {
      claudeAgent_sb_first: {
        driver: 'claudeAgent', displayName: 'My first', accentColor: '#111111', enabled: false,
        config: { binaryPath: '/home/u/.local/bin/t3-claude-handmade', homePath: '/home/u/.claude', customModels: [], launchArgs: '' },
      },
      claudeAgent: { driver: 'claudeAgent', config: { binaryPath: '/home/u/.local/bin/switchboard-lease' } },
      codex: { driver: 'codex', config: { binaryPath: 'codex' } },
    },
  };
  const r = mergeT3EnvironmentSettings(current, { home: '/home/u', accounts: lendable, wrappers: { 't3-claude-handmade': 'claude-default' } });
  const inst = r.settings.providerInstances;
  assert.equal(inst.claudeAgent_sb_first.displayName, 'My first');
  assert.equal(inst.claudeAgent_sb_first.accentColor, '#111111');
  assert.equal(inst.claudeAgent_sb_first.enabled, false, 'a person who turned it off keeps it off');
  assert.equal(r.wrapperFiles['claude-default'], 't3-claude-handmade', 'the hand-made wrapper file is rewritten in place');
  assert.ok(!Object.keys(inst).some((k) => k.startsWith('claudeAgent_sb_default')), 'no duplicate for the adopted account');
  assert.ok(!(ANY_ACCOUNT_INSTANCE_ID in inst), 'the existing switchboard-lease entry already is the any-account entry');
  assert.deepEqual(inst.codex, current.providerInstances.codex);
  assert.equal(current.providerInstances.claudeAgent_sb_first.config.binaryPath, '/home/u/.local/bin/t3-claude-handmade', 'the input is not mutated');
});

test('running the merge again on its own result changes nothing', () => {
  const first = mergeT3EnvironmentSettings({}, { home: '/home/u', accounts: lendable, hubUrl: 'http://192.0.2.10:8318' });
  const wrappers = Object.fromEntries(Object.entries(first.wrapperFiles).map(([id, f]) => [f, id]));
  const again = mergeT3EnvironmentSettings(first.settings, { home: '/home/u', accounts: lendable, wrappers, hubUrl: 'http://192.0.2.10:8318' });
  assert.deepEqual(again.changes, []);
  assert.deepEqual(again.settings, first.settings);
});

test('a Claude entry on the machine\'s own sign-in is reported and left exactly as it was', () => {
  const own = { driver: 'claudeAgent', displayName: 'Claude', enabled: true, config: { binaryPath: 'claude' } };
  const r = mergeT3EnvironmentSettings({ providerInstances: { claudeAgent: own } }, { home: '/home/u', accounts: lendable });
  assert.deepEqual(r.settings.providerInstances.claudeAgent, own);
  assert.equal(r.leftovers.length, 1);
  assert.match(r.leftovers[0].note, /own Claude sign-in/);
});

test('a target home that is not an absolute Linux path is refused', () => {
  assert.throws(() => mergeT3EnvironmentSettings({}, { home: 'C:\\x', accounts: lendable }), /home folder/);
});

test('the client key never appears in the command line used to reach a target', () => {
  const key = 'sb-key-0123456789abcdef0123456789abcdef01234567';
  assert.deepEqual(targetCommand({ kind: 'wsl', name: 'Ubuntu' }), { file: 'wsl.exe', args: ['-d', 'Ubuntu', '--exec', 'bash', '-s'] });
  const ssh = targetCommand({ kind: 'ssh', name: 'worker01' });
  assert.ok(ssh.args.includes('BatchMode=yes'), 'never a password prompt on a pipe');
  assert.ok(ssh.args.indexOf('--') < ssh.args.indexOf('worker01'), 'the host cannot be read as an option');
  const script = applyScript({ key });
  assert.ok(!script.includes(key), 'the key travels base64-encoded inside the script on stdin');
  assert.ok(script.includes(B64(`${key}\n`)));
});

test('only the WSL inspection tries the default-route host, so a LAN machine never sends its key to its router', () => {
  assert.match(inspectScript({ brokerUrls: ['http://127.0.0.1:8318'], defaultRoutePort: 8318 }), /\$\{gw:\+"http:\/\/\$gw:8318"\}/);
  assert.doesNotMatch(inspectScript({ brokerUrls: ['http://192.0.2.10:8318'] }), /\$gw:/);
});

test('every borrowed proof run reads /dev/null, so it cannot swallow the rest of the script from stdin', () => {
  const s = proveScript(['t3-claude-default', 't3-claude-account-2']);
  assert.equal(s.match(/<\/dev\/null/g).length, 2);
  assert.throws(() => proveScript(['../evil']));
  assert.throws(() => applyScript({ wrappers: [{ file: 'x; rm', text: '' }] }));
});

test('the settings file is written last and only if T3 has not saved it since it was read', () => {
  const s = applyScript({ key: 'k', wrappers: [{ file: 't3-claude-default', text: 'x' }], settingsText: '{}', expectSha: 'abc' });
  assert.ok(s.indexOf('settings.json') > s.indexOf('t3-claude-default'));
  assert.match(s, /if \[ "\$now" != 'abc' \]; then emit conflict 1; exit 3; fi/);
  assert.match(s, /cp -p "\$s" "\$b"/, 'the old settings are kept');
});

test('marked output ignores banner lines and decodes each value', () => {
  const out = parseMarkedOutput(['Welcome to Ubuntu', mark('home', '/home/u'), 'noise @@x=1 here', mark('w', 'a'), mark('w', 'b')].join('\n'), ['w']);
  assert.deepEqual(out, { w: ['a', 'b'], home: '/home/u' });
});

test('a proof run counts only when it exited 0 and the model said ok', () => {
  const text = [
    mark('prove.t3-claude-default', '0 claude-leased: lane x\nok'),
    mark('prove.t3-claude-account-2', '0 something else'),
    mark('prove.t3-claude-third', '78 claude-leased: the broker rejected the key'),
  ].join('\n');
  const r = parseProve(text, ['t3-claude-default', 't3-claude-account-2', 't3-claude-third', 't3-claude-missing']);
  assert.deepEqual(r.map((x) => x.ok), [true, false, false, false]);
  assert.equal(r[2].code, 78);
  assert.match(r[3].detail, /no answer/);
});

// A stand-in target: answers inspect, apply and prove scripts from a small state object.
function fakeTarget(state) {
  const calls = [];
  const run = async (_target, script) => {
    calls.push(script);
    if (script.includes('emit claude')) {
      if (state.unreachable) return { code: 255, stdout: '', stderr: 'ssh: connect to host worker01 port 22: Connection refused' };
      const lines = [
        mark('home', '/home/u'), mark('claude', state.claude ?? '/home/u/.local/bin/claude'), mark('json', state.json ?? 'python3'),
        mark('curl', 'yes'), mark('lease', state.lease ?? 'missing'), mark('key', state.key ?? 'missing'),
        mark('probe', `http://192.0.2.10:8318 ${state.probe ?? 401}`), mark('brokerfile', ''), mark('t3', state.t3 === false ? 'no' : 'yes'),
      ];
      if (state.settings) lines.push(mark('settings', JSON.stringify(state.settings)), mark('settingssha', state.sha ?? 'sha1'));
      else lines.push(mark('settingssha', 'none'));
      for (const [file, body] of Object.entries(state.wrappers ?? {})) lines.push(mark('wrapper', `${file}\n${body}`));
      lines.push(mark('missing', state.missing ?? ''), mark('codex', state.codex ?? 'not-installed'), mark('done', '1'));
      return { code: 0, stdout: lines.join('\n'), stderr: '' };
    }
    if (script.includes('put()')) {
      if (state.conflicts > 0) { state.conflicts -= 1; return { code: 3, stdout: mark('conflict', '1'), stderr: '' }; }
      const out = [];
      if (/client-key" 600/.test(script)) out.push(mark('key', 'written'));
      if (/broker-url" 644/.test(script)) out.push(mark('brokerurl', 'written'));
      if (/switchboard-lease" 755/.test(script)) out.push(mark('lease', 'written'));
      for (const m of script.matchAll(/emit wrapper '([^']+)'/g)) out.push(mark('wrapper', m[1]));
      if (script.includes('settings.json"') && script.includes('emit settings written')) {
        out.push(mark('backup', '/home/u/.t3/userdata/settings.json.before-switchboard-x'), mark('settings', 'written'));
        state.written = script;
      }
      out.push(mark('done', '1'));
      return { code: 0, stdout: out.join('\n'), stderr: '' };
    }
    if (script.includes('prove.')) {
      const out = [...script.matchAll(/emit 'prove\.([^']+)'/g)].map((m) => mark(`prove.${m[1]}`, state.proveFails?.includes(m[1]) ? '1 Invalid API key' : '0 ok'));
      out.push(mark('done', '1'));
      return { code: 0, stdout: out.join('\n'), stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected script' };
  };
  return { run, calls };
}

function deps(state, extra = {}) {
  let settings = structuredClone(settingsWithTokens);
  const fake = fakeTarget(state);
  const this_ = {
    fake,
    get settings() { return settings; },
    deps: {
      registry, loadSettings: () => structuredClone(settings), saveSettings: (s) => { settings = structuredClone(s); },
      leaseScript: '#!/usr/bin/env bash\necho lease\n', port: 8318, brokerUrl: 'http://192.0.2.10:8318', hubUrl: 'http://192.0.2.10:8318',
      createKey: (s, label) => keyForEnvironment(s, label), run: fake.run, sleep: async () => {},
      canLend: (lane) => laneTokenState(this_.deps.loadSettings(), lane.id) === 'live', ...extra,
    },
  };
  return this_;
}

test('a full setup on a new machine gives it its own key, every wrapper, the T3 entries and a passing proof', async () => {
  const state = { settings: { providerInstances: {} } };
  const d = deps(state);
  const r = await setupT3Environment({ id: 'ssh:worker01', kind: 'ssh', name: 'worker01' }, d.deps, { now: 0 });
  assert.equal(r.ok, true, r.error ?? r.steps.join('\n'));
  assert.equal(r.keyCreated, true);
  assert.equal(Object.values(d.settings.gatewayKeys)[0].label, 'T3 worker01');
  assert.equal(Object.values(d.settings.gatewayKeys)[0].scope, 'lan', 'the key carries the gateway scope');
  assert.deepEqual(r.proof.map((p) => [p.account, p.ok]), [['claude-default', true], ['claude-account-2', true], ['claude-third', true]]);
  const written = JSON.parse(Buffer.from(/put "\$s" 600 '([^']+)'/.exec(state.written)[1], 'base64').toString('utf8'));
  assert.deepEqual(Object.keys(written.providerInstances).sort(), ['claudeAgent_sb_account_2', 'claudeAgent_sb_any', 'claudeAgent_sb_default', 'claudeAgent_sb_third']);
  assert.ok(written.usageLimitSources['cliproxy-192.0.2.10-8318']);
  assert.ok(r.steps.some((s) => /Saved the broker address/.test(s)), 'a LAN machine is told where the broker is');
  assert.deepEqual(r.signIns, [], 'no Codex account and no Antigravity in this setup, so nothing to sign in');
  assert.ok(r.notes.some((n) => /Grok and Junie/.test(n)), 'the Grok and Junie note comes from core, for the CLI and the tray alike');
});

test('a key the broker already accepts on the target is kept, and a second setup reuses the key it made', async () => {
  const kept = deps({ key: 'present', probe: 200, settings: {} });
  const r1 = await setupT3Environment({ id: 'wsl:Ubuntu', kind: 'wsl', name: 'Ubuntu' }, kept.deps);
  assert.equal(r1.keyCreated, false);
  assert.deepEqual(kept.settings.gatewayKeys, {});
  assert.ok(!kept.fake.calls.some((c) => /client-key" 600/.test(c)), 'the key file on the target is not rewritten');

  const again = deps({ key: 'present', probe: 401, settings: {} });
  await setupT3Environment({ id: 'ssh:w', kind: 'ssh', name: 'w' }, again.deps);
  await setupT3Environment({ id: 'ssh:w', kind: 'ssh', name: 'w' }, again.deps);
  assert.equal(Object.keys(again.settings.gatewayKeys).length, 1, 'no pile of keys after reruns');
});

test('a wrapper or lease file that already says exactly this is not rewritten', async () => {
  const lease = '#!/usr/bin/env bash\necho lease\n';
  const current = Object.fromEntries(lendable.map((a) => [accountWrapperName(a.id), accountWrapperScript(a).trimEnd()]));
  const d = deps({ settings: {}, lease: `file:${sha256(lease)}`, wrappers: current });
  const r = await setupT3Environment({ id: 'wsl:U', kind: 'wsl', name: 'U' }, d.deps);
  assert.equal(r.ok, true, r.error);
  const apply = d.fake.calls.find((c) => c.includes('emit done 1') && c.includes('put()'));
  assert.ok(!/switchboard-lease" 755/.test(apply), 'the lease wrapper is left as it is');
  assert.ok(!/t3-claude-[a-z0-9-]+" 755/.test(apply), 'no account wrapper is rewritten');
  assert.ok(r.steps.includes('The account wrappers there are already up to date.'));
});

test('when T3 saves its settings mid-setup the plan is made again instead of overwriting T3', async () => {
  const state = { settings: {}, conflicts: 1 };
  const d = deps(state);
  const r = await setupT3Environment({ id: 'wsl:Ubuntu', kind: 'wsl', name: 'Ubuntu' }, d.deps);
  assert.equal(r.ok, true, r.error);
  assert.ok(r.steps.some((s) => /planning again/.test(s)));
  assert.equal(d.fake.calls.filter((c) => c.includes('emit claude')).length, 2, 'inspected again before the second try');
});

test('each thing a target lacks stops the setup with what to do about it', async () => {
  const t = { id: 'ssh:w', kind: 'ssh', name: 'w' };
  const cases = [
    [{ unreachable: true }, /could not reach ssh:w: ssh: connect to host/],
    [{ t3: false }, /T3 Code has never run/],
    [{ json: 'none' }, /neither node nor python3/],
    [{ claude: '' }, /Claude Code is not installed/],
    [{ probe: 0 }, /cannot reach Switchboard's broker/],
  ];
  for (const [state, rx] of cases) {
    const d = deps(state);
    const r = await setupT3Environment(t, d.deps);
    assert.equal(r.ok, false);
    assert.match(r.error, rx);
    assert.deepEqual(d.settings.gatewayKeys, {}, 'no key is made for a target that cannot be set up');
  }
});

test('an unreadable T3 settings file on the target is refused, not overwritten', async () => {
  const d = deps({});
  d.deps.run = async (target, script, o) => {
    const r = await fakeTarget({}).run(target, script, o);
    if (script.includes('emit claude')) r.stdout = r.stdout.replace(mark('settingssha', 'none'), `${mark('settings', '{nope')}\n${mark('settingssha', 'abc')}`);
    return r;
  };
  const r = await setupT3Environment({ id: 'wsl:U', kind: 'wsl', name: 'U' }, d.deps);
  assert.match(r.error, /cannot be read safely/);
});

test('an account that fails its proof run makes the environment not ready and is named', async () => {
  const d = deps({ settings: {}, proveFails: ['t3-claude-account-2'] });
  const r = await setupT3Environment({ id: 'wsl:U', kind: 'wsl', name: 'U' }, d.deps);
  assert.equal(r.ok, false);
  assert.deepEqual(r.proof.filter((p) => !p.ok).map((p) => p.label), ['second']);
});

test('with no lendable account nothing is touched on the target', async () => {
  const d = deps({});
  d.deps.loadSettings = () => ({ ...structuredClone(settingsWithTokens), laneTokens: {} });
  const r = await setupT3Environment({ id: 'wsl:U', kind: 'wsl', name: 'U' }, d.deps);
  assert.match(r.error, /no Claude account it can lend/);
  assert.equal(d.fake.calls.length, 0);
});

const U = { id: 'wsl:U', kind: 'wsl', name: 'U' };
const W = { id: 'ssh:w', kind: 'ssh', name: 'w' };
const good = { ok: true, reached: true, accounts: [{ id: 'claude-default' }], proof: [], port: 8318 };

test('a remembered environment reads as stale when the wrapper changed or an account was added, and failed when it failed', () => {
  let s = rememberT3Environment({}, U, good, { leaseSha: 'v1', now: 5 });
  s = rememberT3Environment(s, W, good, { leaseSha: 'v1' });
  s = rememberT3Environment(s, W, { ok: false, reached: true, error: 'boom', accounts: [], proof: [] }, { leaseSha: 'v1' });
  const st = t3EnvironmentStatus(s, { leaseSha: 'v2', lendableIds: ['claude-default', 'claude-account-2'] });
  const u = st.find((e) => e.id === 'wsl:U');
  assert.equal(u.state, 'stale');
  assert.equal(u.wrapperOld, true, 'the start-up refresh acts on this flag, not on the wording');
  assert.match(u.detail, /out of date.*claude-account-2.*set up/);
  assert.equal(st.find((e) => e.id === 'ssh:w').state, 'failed');
  assert.match(st.find((e) => e.id === 'ssh:w').detail, /^boom; set up/);
  assert.equal(t3EnvironmentStatus(s, { leaseSha: 'v1', lendableIds: ['claude-default'] })[0].state, 'ok');
});

test('a machine that does not answer keeps its last record, and one never set up is not remembered at all', () => {
  const s = rememberT3Environment({}, U, good, { leaseSha: 'v1', now: 5 });
  const asleep = rememberT3Environment(s, U, { ok: false, reached: false, error: 'could not reach wsl:U' }, { now: 10 });
  assert.equal(asleep.t3Environments['wsl:U'].lastOk, true);
  assert.match(t3EnvironmentStatus(asleep, { now: 10 })[0].detail, /could not reach it/);
  assert.deepEqual(rememberT3Environment({}, W, { ok: false, reached: false, error: 'typo' }), {}, 'a mistyped host leaves no trace');
  assert.deepEqual(rememberT3Environment({}, W, { ok: false, reached: true, error: 'no T3 there' }), {}, 'nor does a machine refused before anything was written');
});

test('an environment whose key was revoked reads as failed, and one whose broker moved reads as stale', () => {
  const s = rememberT3Environment({ gatewayKeys: {} }, W, { ...good, keyId: 't3-w', brokerUrl: 'http://192.0.2.10:8318' }, { leaseSha: 'v1' });
  assert.match(t3EnvironmentStatus(s, { leaseSha: 'v1' })[0].detail, /revoked/);
  const kept = { ...s, gatewayKeys: { 't3-w': { id: 't3-w' } } };
  const moved = t3EnvironmentStatus(kept, { leaseSha: 'v1', port: 9000, brokerUrl: 'http://192.0.2.20:9000' })[0];
  assert.equal(moved.state, 'stale');
  assert.match(moved.detail, /port changed to 9000.*address changed/);
});

test('an environment can be forgotten, and forgetting one that is not there says so', () => {
  const s = rememberT3Environment({}, U, good, { leaseSha: 'v1' });
  assert.deepEqual(forgetT3Environment(s, 'wsl:U').t3Environments, {});
  assert.throws(() => forgetT3Environment(s, 'wsl:X'), /no T3 environment/);
});

test('the start-up refresh never issues a key, never writes T3 settings and never proves', async () => {
  const d = deps({ key: 'present', probe: 401, settings: {} });
  const r = await setupT3Environment(W, d.deps, { refreshOnly: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /refuses .* client key \(revoked\?\)/);
  assert.deepEqual(d.settings.gatewayKeys, {}, 'a revoked key stays revoked');

  const d2 = deps({ key: 'present', probe: 200, settings: {}, wrappers: { 't3-claude-default': 'old text\nexport SWITCHBOARD_ACCOUNT=claude-default' } });
  const r2 = await setupT3Environment(W, d2.deps, { refreshOnly: true });
  assert.equal(r2.ok, true, r2.error);
  const apply = d2.fake.calls.find((c) => c.includes('put()'));
  assert.ok(!apply.includes('emit settings written'), 'T3 settings untouched, so a removed provider stays removed');
  assert.ok(/t3-claude-default" 755/.test(apply), 'a wrapper T3 already uses is refreshed');
  assert.ok(!/t3-claude-account-2" 755/.test(apply), 'no new wrapper appears');
  assert.ok(!d2.fake.calls.some((c) => c.includes('prove.')));
});

test('an account that is out of allowance during the proof is reported as such, not as a broken setup', async () => {
  const d = deps({ settings: {} });
  const run = d.deps.run;
  d.deps.run = async (t, script, o) => {
    const r = await run(t, script, o);
    if (script.includes('prove.')) r.stdout = r.stdout.replace(mark('prove.t3-claude-account-2', '0 ok'), mark('prove.t3-claude-account-2', '75 claude-leased: no lane leased (HTTP 503, no-healthy-lane)'));
    return r;
  };
  const r = await setupT3Environment(U, d.deps);
  assert.equal(r.ok, true);
  assert.equal(r.proof.find((p) => p.account === 'claude-account-2').cooling, true);
  assert.ok(r.steps.some((s) => /out of allowance right now/.test(s)));
});

test('a second conflict in a row gives up with a clear reason instead of "no answer"', async () => {
  const d = deps({ settings: {}, conflicts: 2 });
  const r = await setupT3Environment(U, d.deps);
  assert.match(r.error, /kept changing its settings/);
});

test('a hand-written wrapper that differs is copied aside before it is replaced, and the copy is named', async () => {
  const d = deps({ settings: { providerInstances: { mine: { driver: 'claudeAgent', config: { binaryPath: '/home/u/.local/bin/t3-claude-handmade' } } } }, wrappers: { 't3-claude-handmade': '#!/bin/bash\nexport SWITCHBOARD_ACCOUNT=claude-default\nexport CLAUDE_BIN=/opt/claude\nexec x' } });
  const run = d.deps.run;
  d.deps.run = async (t, script, o) => {
    const r = await run(t, script, o);
    const m = /emit wrapperbackup '([^']+)'/.exec(script);
    if (m) r.stdout += `\n${mark('wrapperbackup', m[1])}`;
    return r;
  };
  const r = await setupT3Environment(U, d.deps);
  assert.ok(r.steps.some((s) => /Kept a copy of the hand-written wrapper it replaced: ~\/\.local\/bin\/t3-claude-handmade\.before-switchboard-/.test(s)), r.steps.join('\n'));
});

test('a provider id never passes the 64 characters T3 accepts', () => {
  const long = [{ id: `claude-${'x'.repeat(80)}`, label: 'long', color: null }];
  const r = mergeT3EnvironmentSettings({}, { home: '/home/u', accounts: long });
  for (const id of Object.keys(r.settings.providerInstances)) assert.ok(id.length <= 64, id);
});

test('when the broker moves, the Switchboard hub entry follows it instead of a second one being added', () => {
  const current = { usageLimitSources: { 'cliproxy-192.0.2.10-8318': { kind: 'cliproxy', label: 'Switchboard', url: 'http://192.0.2.10:8318', enabled: true } } };
  const r = mergeT3EnvironmentSettings(current, { home: '/home/u', accounts: lendable, hubUrl: 'http://192.0.2.20:8318' });
  assert.deepEqual(Object.keys(r.settings.usageLimitSources), ['cliproxy-192.0.2.10-8318']);
  assert.equal(r.settings.usageLimitSources['cliproxy-192.0.2.10-8318'].url, 'http://192.0.2.20:8318');
  assert.equal(r.hubId, 'cliproxy-192.0.2.10-8318', 'the key file keeps its name, so it is kept too');
});

test('a settings file that turned unreadable between two attempts is still refused', async () => {
  let n = 0;
  const d = deps({ settings: {}, conflicts: 1 });
  const run = d.deps.run;
  d.deps.run = async (t, script, o) => {
    const r = await run(t, script, o);
    if (script.includes('emit claude') && (n += 1) === 2) r.stdout = r.stdout.replace(/@@settingssha=[^\n]*/, `${mark('settingssha', 'x')}\n${mark('settings', '{broken')}`);
    return r;
  };
  const r = await setupT3Environment(U, d.deps);
  assert.match(r.error, /cannot be read safely/);
});

test('a machine missing the GNU tools the setup relies on is refused before anything is written', async () => {
  const d = deps({ settings: {}, missing: ' sha256sum timeout' });
  const r = await setupT3Environment(W, d.deps);
  assert.match(r.error, /lacks sha256sum, timeout/);
  assert.equal(d.fake.calls.length, 1, 'only the inspection ran');
});

test('a key made for a T3 environment is never picked as this machine\'s own key by provision-client', () => {
  const made = keyForEnvironment({ gateway: { scope: 'lan' }, gatewayKeys: {} }, 'T3 w');
  assert.equal(Object.values(made.settings.gatewayKeys)[0].purpose, T3_KEY_PURPOSE);
  const chosen = chooseProvisionKey(made.settings, { scope: 'lan' });
  assert.equal(chosen.created, true, 'a fresh local key is made rather than reusing the environment\'s');
});

test('marks are found even when a login script printed something with no newline before them', () => {
  assert.deepEqual(parseMarkedOutput(`\u001b]0;title\u0007${mark('home', '/home/u')}`), { home: '/home/u' });
});

test('inspection output is parsed into the facts the plan needs', () => {
  const text = [
    mark('home', '/home/u'), mark('claude', '/home/u/.local/bin/claude'), mark('json', 'node'), mark('curl', 'yes'),
    mark('lease', 'symlink:/mnt/c/x/switchboard-lease'), mark('key', 'present'),
    mark('probe', 'http://127.0.0.1:8318 000'), mark('probe', 'http://172.20.0.1:8318 200'), mark('brokerfile', ''),
    mark('t3', 'yes'), mark('settings', '{"a":1}'), mark('settingssha', 'f00'),
    mark('wrapper', 't3-claude-old\nexport SWITCHBOARD_ACCOUNT=claude-default\n'), mark('hubsecret', 'usage-limit-source-x.bin'),
    mark('codex', 'signed-in'), mark('done', '1'),
  ].join('\n');
  const r = parseInspect(text);
  assert.deepEqual(r.broker, { url: 'http://172.20.0.1:8318', code: 200 });
  assert.deepEqual(r.wrappers, { 't3-claude-old': 'claude-default' });
  assert.deepEqual(r.settings, { a: 1 });
  assert.deepEqual(r.hubSecrets, ['usage-limit-source-x.bin']);
  assert.equal(parseInspect('nothing marked'), null, 'output without the done mark is no answer');
});
